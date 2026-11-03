import {
  Bone,
  Euler,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SkinnedMesh,
  SphereGeometry,
  Vector3,
  MathUtils,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { applyHeroicShape } from './shape-preset.js';
import { MAKEHUMAN_DEFAULT_PROFILE } from './avatar-profile.js';

export const DEG = Math.PI / 180;
export const WRIST_BEND_LIMIT_DEG = 59.8;

/**
 * Coordinate system conversion:
 * MuJoCo world: X = forward (+Z in Three.js), Y = left (+X in Three.js), Z = up (+Y in Three.js)
 * Orthonormal basis matrix M:
 *   v_three = [ v_mj.y, v_mj.z, v_mj.x ]
 *   det(M) = +1 (proper rotation, quaternion q_basis = (-0.5, -0.5, -0.5, 0.5))
 */
const BASIS_MJ_TO_THREE = new Matrix4().set(
  0, 1, 0, 0,
  0, 0, 1, 0,
  1, 0, 0, 0,
  0, 0, 0, 1,
);
const QUAT_MJ_TO_THREE = new Quaternion().setFromRotationMatrix(BASIS_MJ_TO_THREE);
const QUAT_THREE_TO_MJ = QUAT_MJ_TO_THREE.clone().invert();

export function mjVecToThree(mjVec, out = new Vector3()) {
  if (!mjVec) return out.set(0, 0, 0);
  return out.set(mjVec[1], mjVec[2], mjVec[0]);
}

export function mjQuatToThree(mjQuatWxyz, out = new Quaternion()) {
  if (!mjQuatWxyz) return out.identity();
  // MuJoCo quaternion is [w, x, y, z]; Three.js Quaternion constructor is (x, y, z, w)
  const qMj = new Quaternion(mjQuatWxyz[1], mjQuatWxyz[2], mjQuatWxyz[3], mjQuatWxyz[0]).normalize();
  return out.copy(QUAT_MJ_TO_THREE).multiply(qMj).multiply(QUAT_THREE_TO_MJ).normalize();
}

export function forearmTwist(roll) {
  const limit = 80 * DEG, share = 0.65, cap = share * limit, a = Math.min(Math.abs(roll), Math.PI);
  const g = a <= limit ? share * a : cap * Math.cos((Math.PI / 2) * (a - limit) / (Math.PI - limit));
  return Math.sign(roll) * g;
}

/**
 * Constant-length two-bone analytical IK solver (ported from human3d kinematics.ts).
 * Preserves the avatar's exact segment lengths `a` and `b` without stretching bones.
 */
export function solveTwoBone(root, target, pole, a, b, maxFlex = 145) {
  const direction = target.clone().sub(root);
  const minReach = Math.max(1e-6, Math.sqrt(a * a + b * b + 2 * a * b * Math.cos(maxFlex * DEG)));
  const d = MathUtils.clamp(direction.length(), minReach, a + b - 1e-6);
  if (direction.lengthSq() < 1e-12) direction.set(0, -1, 0);
  direction.normalize();
  const end = root.clone().addScaledVector(direction, d);
  const poleRel = pole.clone().sub(root);
  const bend = poleRel.clone().addScaledVector(direction, -poleRel.dot(direction));
  if (bend.lengthSq() < 1e-10) bend.set(0, 0, 1).addScaledVector(direction, -direction.z);
  if (bend.lengthSq() < 1e-10) bend.set(1, 0, 0);
  bend.normalize();
  const x = (a * a - b * b + d * d) / (2 * d);
  const mid = root.clone().addScaledVector(direction, x).addScaledVector(bend, Math.sqrt(Math.max(0, a * a - x * x)));
  const flexion = Math.acos(MathUtils.clamp((d * d - a * a - b * b) / (2 * a * b), -1, 1)) / DEG;
  return { mid, end, flexion, residual: end.distanceTo(target) };
}

export function frameRotation(restDirection, restNormal, direction, normal) {
  const basis = (d, n) => {
    const y = d.clone().normalize();
    const z = n.clone().addScaledVector(y, -n.dot(y)).normalize();
    const x = new Vector3().crossVectors(y, z).normalize();
    return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
  };
  return basis(direction, normal).multiply(basis(restDirection, restNormal).invert()).normalize();
}

export function handFrame(rest, armMap, side) {
  const wrist = rest.get(armMap.wrist);
  const index = rest.get(armMap.index[0]);
  const middle = rest.get(armMap.middle[0]);
  const pinky = rest.get(armMap.pinky[0]);
  const forward = middle.clone().sub(wrist).normalize();
  const normal = new Vector3().crossVectors(index.clone().sub(pinky), forward).normalize();
  if (side === 'L') normal.negate();
  const flexionAxis = new Vector3().crossVectors(forward, normal).normalize();
  return { forward, normal, flexionAxis };
}

export function skeletonSegments(info) {
  const major = info.bones.filter((b) =>
    /^(root|pelvis_|spine|neck|head$|clavicle_|shoulder|upperarm|lowerarm|wrist_|metacarpal|finger|upperleg|lowerleg|foot_|toe)/.test(b.name),
  );
  const out = [];
  for (const b of major) if (b.parent) out.push({ name: b.name, parent: b.parent });
  return out;
}

/**
 * AvatarAdapter:
 * Decouples the display avatar (GLB/GLTF/VRM) from the MuJoCo physics simulator.
 *
 * Responsibilities:
 * 1. Load avatar asset and rig metadata (or construct from loaded Three.js scene + rig info).
 * 2. Identify & configure key anatomical bones via an AvatarProfile.
 * 3. Convert MuJoCo coordinates, units, and bind poses into Three.js viewer space.
 * 4. Retarget physical joint states and rigid-body poses into local bone rotations.
 * 5. Preserve original bone lengths and skin weights (no physical point stretching).
 * 6. Apply natural default posture for unmodeled DOFs.
 * 7. Keep the motion clip immutable when switching avatars.
 */
export class AvatarAdapter {
  bones = new Map();
  rest = new Map();
  restLocal = new Map();
  restLocalQuat = new Map();
  bindWorldQuat = new Map();
  segmentLengths = new Map();

  constructor(model, rigInfo, profile = MAKEHUMAN_DEFAULT_PROFILE) {
    this.model = model;
    this.info = rigInfo;
    this.profile = profile;

    model.traverse((o) => {
      if (o.isBone) this.bones.set(o.name, o);
    });

    for (const b of rigInfo.bones) {
      this.rest.set(b.name, new Vector3().fromArray(b.head));
      const bone = this.bones.get(b.name);
      if (!bone) throw new Error(`Avatar missing bone "${b.name}" declared in rig metadata`);
      this.restLocal.set(b.name, bone.position.clone());
      this.restLocalQuat.set(b.name, bone.quaternion.clone());
    }

    this.model.updateMatrixWorld(true);
    for (const [name, bone] of this.bones) {
      this.bindWorldQuat.set(name, bone.getWorldQuaternion(new Quaternion()));
      if (bone.parent && bone.parent.isBone) {
        const pPos = bone.parent.getWorldPosition(new Vector3());
        const cPos = bone.getWorldPosition(new Vector3());
        this.segmentLengths.set(name, pPos.distanceTo(cPos));
      }
    }
  }

  static async load(profile = MAKEHUMAN_DEFAULT_PROFILE, loader = new GLTFLoader(), fetchFn = fetch) {
    const [gltf, rigResponse] = await Promise.all([
      loader.loadAsync(profile.glbUrl),
      fetchFn(profile.rigUrl),
    ]);
    if (!rigResponse.ok) throw new Error(`人体骨架加载失败 (${rigResponse.status})`);
    const rigInfo = await rigResponse.json();
    const model = gltf.scene;
    if (profile.heroicShape) applyHeroicShape(model);

    const adapter = new AvatarAdapter(model, rigInfo, profile);
    adapter.applyVisualMaterials();
    return adapter;
  }

  applyVisualMaterials() {
    const skinMat = new MeshStandardMaterial({
      color: this.profile.skinColor ?? 0xd8d1c7,
      roughness: this.profile.skinRoughness ?? 0.76,
      metalness: this.profile.skinMetalness ?? 0.0,
    });
    this.model.traverse((o) => {
      if (o instanceof SkinnedMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
        o.material = skinMat;
      }
    });
    const { eyeL, eyeR } = this.profile.boneMap;
    for (const boneName of [eyeL, eyeR]) {
      if (boneName && this.bones.has(boneName)) {
        const eyeBone = this.bone(boneName);
        if (!eyeBone.children.some((c) => c.name === 'human-eye')) {
          const sclera = new Mesh(
            new SphereGeometry(this.profile.eyeRadius ?? 0.0105, 20, 12),
            new MeshStandardMaterial({ color: this.profile.eyeColor ?? 0xbdcbd2, roughness: 0.5 }),
          );
          sclera.name = 'human-eye';
          eyeBone.add(sclera);
        }
      }
    }
  }

  bone(name) {
    const b = this.bones.get(name);
    if (!b) throw new Error(`Unknown avatar bone "${name}"`);
    return b;
  }

  point(name, out = new Vector3()) {
    return this.bone(name).getWorldPosition(out);
  }

  reset() {
    for (const [name, bone] of this.bones) {
      bone.quaternion.copy(this.restLocalQuat.get(name));
      bone.position.copy(this.restLocal.get(name));
      bone.scale.set(1, 1, 1);
    }
    this.model.position.set(0, 0, 0);
    this.model.quaternion.identity();
    this.model.scale.setScalar(this.profile.scale ?? 1);
    this.model.updateMatrixWorld(true);
  }

  rotateLocalEulerDeg(name, x = 0, y = 0, z = 0) {
    if (!this.bones.has(name)) return;
    this.bone(name).quaternion.setFromEuler(new Euler(x * DEG, y * DEG, z * DEG, 'YXZ'));
    this.model.updateMatrixWorld(true);
  }

  setWorldRotation(name, worldQuat) {
    if (!this.bones.has(name)) return;
    const b = this.bone(name);
    const parentQuat = b.parent ? b.parent.getWorldQuaternion(new Quaternion()) : new Quaternion();
    b.quaternion.copy(parentQuat.invert().multiply(worldQuat));
    this.model.updateMatrixWorld(true);
  }

  /**
   * Two-bone IK using the avatar's rest frame basis (used for legs and natural rest arms).
   */
  solveLimb(side, kind, target, pole, maxFlex = kind === 'arm' ? 145 : 135) {
    const map = kind === 'arm'
      ? (side === 'L' ? this.profile.boneMap.leftArm : this.profile.boneMap.rightArm)
      : (side === 'L' ? this.profile.boneMap.leftLeg : this.profile.boneMap.rightLeg);
    const u = kind === 'arm' ? map.upperArm : map.upperLeg;
    const l = kind === 'arm' ? map.forearm : map.lowerLeg;
    const e = kind === 'arm' ? map.wrist : map.foot;

    const r0 = this.rest.get(u), r1 = this.rest.get(l), r2 = this.rest.get(e);
    const a = r1.clone().sub(r0), b = r2.clone().sub(r1);
    const normal = new Vector3().crossVectors(a, b).normalize();
    const pu = this.point(u);
    const solved = solveTwoBone(pu, target, pole, a.length(), b.length(), maxFlex);
    const d0 = solved.mid.clone().sub(pu), d1 = solved.end.clone().sub(solved.mid);
    const n = new Vector3().crossVectors(d0, d1).normalize();
    if (n.lengthSq() < 0.1) {
      n.crossVectors(pole.clone().sub(pu), solved.end.clone().sub(pu)).normalize();
      if (n.lengthSq() < 0.1) n.copy(normal);
    }
    this.setWorldRotation(u, frameRotation(a, normal, d0, n));
    this.setWorldRotation(l, frameRotation(b, normal, d1, n));
    return solved;
  }

  /**
   * Two-bone retargeting for external world-space landmarks (from HumanRig.limbToWorldTargets).
   * Preserves the avatar's own upper-arm and forearm bone lengths while matching the
   * physical shoulder->elbow->wrist direction and elbow flexion angle.
   */
  solveLimbToWorldTargets(side, kind, target, pole, maxFlex = kind === 'arm' ? 155 : 140) {
    const map = kind === 'arm'
      ? (side === 'L' ? this.profile.boneMap.leftArm : this.profile.boneMap.rightArm)
      : (side === 'L' ? this.profile.boneMap.leftLeg : this.profile.boneMap.rightLeg);
    const u = kind === 'arm' ? map.upperArm : map.upperLeg;
    const l = kind === 'arm' ? map.forearm : map.lowerLeg;
    const e = kind === 'arm' ? map.wrist : map.foot;

    const r0 = this.rest.get(u), r1 = this.rest.get(l), r2 = this.rest.get(e);
    const a = r1.distanceTo(r0), b = r2.distanceTo(r1);
    const root = this.point(u);
    const solved = solveTwoBone(root, target, pole, a, b, maxFlex);

    const align = (bone, from, to, desired) => {
      this.model.updateMatrixWorld(true);
      const current = this.point(to).sub(this.point(from)).normalize();
      const world = this.bone(bone).getWorldQuaternion(new Quaternion());
      world.premultiply(new Quaternion().setFromUnitVectors(current, desired.clone().normalize()));
      this.setWorldRotation(bone, world);
    };
    align(u, u, l, solved.mid.clone().sub(root));
    align(l, l, e, solved.end.clone().sub(solved.mid));
    return solved;
  }

  /**
   * Align hand orientation continuously with forearm and share pronation twist
   * across `lowerarm02` and `wrist` so the palm never detaches or stays at the waist.
   */
  solveHand(side, forward, palmNormal, bendLimit = WRIST_BEND_LIMIT_DEG) {
    const armMap = side === 'L' ? this.profile.boneMap.leftArm : this.profile.boneMap.rightArm;
    const { forward: f, normal } = handFrame(this.rest, armMap, side);
    const forearm = this.point(armMap.wrist).sub(this.point(armMap.forearm)).normalize();
    let desired = forward.clone().normalize();
    const bend = forearm.angleTo(desired);
    if (bend > bendLimit * DEG && bend > 1e-6) {
      const aim = new Quaternion().setFromUnitVectors(forearm, desired);
      aim.slerp(new Quaternion(), 1 - (bendLimit * DEG) / bend);
      desired = forearm.clone().applyQuaternion(aim);
    }
    const targetQ = frameRotation(f, normal, desired, palmNormal);
    if (armMap.forearmTwist && this.bones.has(armMap.forearmTwist)) {
      const restAxis = this.rest.get(armMap.wrist).clone().sub(this.rest.get(armMap.forearm)).normalize();
      const forearmQ = this.bone(armMap.forearm).getWorldQuaternion(new Quaternion());
      const rel = forearmQ.clone().invert().multiply(targetQ);
      const relV = new Vector3(rel.x, rel.y, rel.z);
      const halfAngle = 2 * Math.atan2(restAxis.dot(relV), rel.w);
      const roll = Math.atan2(Math.sin(halfAngle), Math.cos(halfAngle));
      this.bone(armMap.forearmTwist).quaternion.setFromAxisAngle(restAxis, forearmTwist(roll));
      this.model.updateMatrixWorld(true);
    }
    this.setWorldRotation(armMap.wrist, targetQ);
  }

  relaxHand(side) {
    const armMap = side === 'L' ? this.profile.boneMap.leftArm : this.profile.boneMap.rightArm;
    const { flexionAxis } = handFrame(this.rest, armMap, side);
    const flexAngles = this.profile.defaultPose.fingerRelaxedFlexDeg ?? [12, 16, 8];
    for (const chain of [armMap.index, armMap.middle, armMap.ring, armMap.pinky]) {
      if (!chain) continue;
      chain.forEach((boneName, idx) => {
        if (this.bones.has(boneName)) {
          this.bone(boneName).quaternion.setFromAxisAngle(flexionAxis, (flexAngles[idx] ?? 10) * DEG);
        }
      });
    }
    if (armMap.thumb) {
      for (const boneName of armMap.thumb) {
        if (this.bones.has(boneName)) this.bone(boneName).quaternion.identity();
      }
    }
    this.model.updateMatrixWorld(true);
  }

  /**
   * Apply default natural standing posture for all limbs before overlaying physical motion.
   * Ensures unmodeled joints (e.g. left arm and legs in upper-body experiments, or hands/fingers)
   * have a natural anatomical posture instead of stiff T/A bind pose.
   */
  applyDefaultStandPose() {
    this.reset();
    const dp = this.profile.defaultPose;
    const bm = this.profile.boneMap;

    // Legs in natural standing support
    for (const side of ['L', 'R']) {
      const legCfg = side === 'L' ? dp.leftLegStand : dp.rightLegStand;
      const legMap = side === 'L' ? bm.leftLeg : bm.rightLeg;
      const target = new Vector3().fromArray(legCfg.target);
      const pole = new Vector3().fromArray(legCfg.pole);
      this.solveLimb(side, 'leg', target, pole);
      const footQ = new Quaternion().setFromEuler(new Euler(legCfg.pitchDeg * DEG, legCfg.yawDeg * DEG, 0, 'YXZ'));
      this.setWorldRotation(legMap.foot, footQ);
    }

    // Both arms in natural relaxed side posture
    for (const side of ['L', 'R']) {
      const armCfg = side === 'L' ? dp.leftArmStand : dp.rightArmStand;
      const armMap = side === 'L' ? bm.leftArm : bm.rightArm;
      const shoulderPos = this.point(armMap.upperArm);
      const target = shoulderPos.clone().add(new Vector3().fromArray(armCfg.targetOffsetFromShoulder));
      const pole = shoulderPos.clone().add(new Vector3().fromArray(armCfg.poleOffsetFromShoulder));
      this.solveLimb(side, 'arm', target, pole);
      this.solveHand(
        side,
        new Vector3().fromArray(armCfg.handForward),
        new Vector3().fromArray(armCfg.palmNormal),
      );
      this.relaxHand(side);
    }
  }

  /**
   * Retarget a single physical arm (shoulder -> elbow -> wrist -> hand) onto the avatar's arm.
   * Uses the law of cosines on the avatar's own upper-arm and forearm lengths (`a`, `b`)
   * so that the simulated elbow flexion angle and arm direction are reproduced while
   * keeping avatar bone lengths 100% invariant and the wrist/palm attached to the forearm.
   */
  retargetPhysicalArm(side, mjShoulder, mjElbow, mjWrist, mjHand, elbowFlexRadOverride) {
    const armMap = side === 'L' ? this.profile.boneMap.leftArm : this.profile.boneMap.rightArm;
    const pShoulder = mjVecToThree(mjShoulder);
    const pElbow = mjVecToThree(mjElbow);
    const pWrist = mjVecToThree(mjWrist);
    const pHand = mjHand ? mjVecToThree(mjHand) : null;

    const skinShoulder = this.point(armMap.upperArm);
    const a = this.rest.get(armMap.upperArm).distanceTo(this.rest.get(armMap.forearm));
    const b = this.rest.get(armMap.forearm).distanceTo(this.rest.get(armMap.wrist));

    const vUpper = pElbow.clone().sub(pShoulder);
    const vFore = pWrist.clone().sub(pElbow);
    const measuredFlex = Math.PI - vUpper.angleTo(vFore);
    const elbowFlex = MathUtils.clamp(
      elbowFlexRadOverride !== undefined ? elbowFlexRadOverride : measuredFlex,
      0,
      152 * DEG,
    );

    const targetDistance = Math.sqrt(Math.max(1e-6, a * a + b * b + 2 * a * b * Math.cos(elbowFlex)));
    const armDir = pWrist.clone().sub(pShoulder);
    if (armDir.lengthSq() < 1e-10) armDir.set(0, -1, 0);
    else armDir.normalize();

    const scaledTarget = skinShoulder.clone().addScaledVector(armDir, targetDistance);

    // Compute pole vector in avatar shoulder space from physical upper-arm direction
    const upperDir = vUpper.lengthSq() > 1e-10 ? vUpper.clone().normalize() : new Vector3(0, -1, 0);
    let pole = skinShoulder.clone().addScaledVector(upperDir, a);
    // If the arm is nearly straight, bias the pole slightly backward/outward so the elbow hinge plane stays well-conditioned
    const bendSin = Math.sin(elbowFlex);
    if (bendSin < 0.12) {
      const lateral = side === 'L' ? 0.08 : -0.08;
      pole.add(new Vector3(lateral, 0, -0.18));
    }

    this.solveLimbToWorldTargets(side, 'arm', scaledTarget, pole, 155);

    // Orient wrist and palm to follow the solved forearm continuously
    const solvedElbow = this.point(armMap.forearm);
    const solvedWrist = this.point(armMap.wrist);
    const forearmDir = solvedWrist.clone().sub(solvedElbow).normalize();

    let handDir = forearmDir.clone();
    if (pHand && vFore.lengthSq() > 1e-8) {
      const physForearmDir = vFore.clone().normalize();
      const physHandDir = pHand.clone().sub(pWrist).normalize();
      const wristDeltaQ = new Quaternion().setFromUnitVectors(physForearmDir, physHandDir);
      // Slight natural alignment with physical hand segment while keeping continuity with forearm
      handDir.applyQuaternion(new Quaternion().slerp(wristDeltaQ, 0.35)).normalize();
    }

    // Natural neutral-supinated palm normal: thumb/radial side up/outward, palm facing medially/upward during curl
    const medial = new Vector3(side === 'L' ? -1 : 1, 0.25, 0).normalize();
    const palmNormal = medial.clone().addScaledVector(forearmDir, -medial.dot(forearmDir));
    if (palmNormal.lengthSq() < 1e-6) palmNormal.set(side === 'L' ? -1 : 1, 0, 0);
    palmNormal.normalize();

    this.solveHand(side, handDir, palmNormal);
    this.relaxHand(side);
  }

  /**
   * Apply a sampled frame from an `h3d.motion.v1` clip onto the avatar.
   * Never mutates the input `clip` or `frame`.
   */
  applyFrame(clip, frame) {
    this.applyDefaultStandPose();

    const kind = clip?.rig?.kind;
    const positions = { ...(clip?.rig?.staticPositions ?? {}), ...(frame?.positions ?? {}) };
    if (positions.shoulder && !positions.rightShoulder) positions.rightShoulder = positions.shoulder;
    if (positions.elbow && !positions.rightElbow) positions.rightElbow = positions.elbow;
    if (positions.wrist && !positions.rightWrist) positions.rightWrist = positions.wrist;
    if (positions.hand && !positions.rightHand) positions.rightHand = positions.hand;

    const joints = frame?.joints ?? {};

    if (kind === 'elbow' || kind === 'shoulder-elbow') {
      const elbowFlex = joints.elbow_flex?.angle;
      this.retargetPhysicalArm(
        'R',
        positions.rightShoulder,
        positions.rightElbow,
        positions.rightWrist,
        positions.rightHand,
        elbowFlex,
      );
      this.model.updateMatrixWorld(true);
      return;
    }

    if (kind === 'lower-body') {
      this.retargetLowerBodyFrame(clip, frame, positions, joints);
      this.model.updateMatrixWorld(true);
      return;
    }
  }

  retargetLowerBodyFrame(clip, frame, positions, joints) {
    const bm = this.profile.boneMap;
    const dp = this.profile.defaultPose;

    // 1. Pelvis translation & sagittal tilt
    const rootBone = this.bone(bm.pelvis);
    const restRootPos = this.restLocal.get(bm.pelvis);
    const pPelvis = positions.pelvis ? mjVecToThree(positions.pelvis) : new Vector3(0, dp.pelvisRestMuJoCoZ, 0);
    const restPelvisY = dp.pelvisRestMuJoCoZ ?? 0.915;

    // Preserve lateral symmetry (X=0), apply vertical (Y) and anterior-posterior (Z) pelvis motion
    rootBone.position.set(
      restRootPos.x + pPelvis.x,
      restRootPos.y + (pPelvis.y - restPelvisY),
      restRootPos.z + pPelvis.z,
    );

    // Sagittal pitch: in MuJoCo, positive pelvis_tilt is anterior tilt (+Y axis rotation).
    // In Three.js (X=left, Y=up, Z=forward), rotation around +X by +angle tilts the upper body forward (+Z).
    let pelvisTilt = joints.pelvis_tilt?.angle ?? 0;
    if (frame?.bodies?.pelvis?.quaternion) {
      const qPelvis = mjQuatToThree(frame.bodies.pelvis.quaternion);
      this.setWorldRotation(bm.pelvis, qPelvis.multiply(this.bindWorldQuat.get(bm.pelvis)));
    } else {
      const qTilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pelvisTilt);
      this.setWorldRotation(bm.pelvis, qTilt.multiply(this.bindWorldQuat.get(bm.pelvis)));
    }

    // 2. Spine & neck distribution:
    // In MuJoCo, trunk_ext has axis="0 -1 0" (positive = extension / leaning back, negative = forward lean).
    // If waist & neck landmarks exist, compute trunk pitch directly or use trunk_ext joint.
    const trunkExt = joints.trunk_ext?.angle ?? 0;
    const spineForwardLeanDeg = (-trunkExt / DEG);
    const perSpineDeg = spineForwardLeanDeg / Math.max(1, bm.spine.length);
    for (const spineBone of bm.spine) {
      this.rotateLocalEulerDeg(spineBone, perSpineDeg, 0, 0);
    }
    // Slight gaze stabilization so the head doesn't pitch excessively into the floor during deep squat
    const headCompDeg = - (pelvisTilt / DEG) * 0.35 - spineForwardLeanDeg * 0.25;
    if (bm.neck[0]) this.rotateLocalEulerDeg(bm.neck[0], headCompDeg * 0.5, 0, 0);
    if (bm.neck[1]) this.rotateLocalEulerDeg(bm.neck[1], headCompDeg * 0.3, 0, 0);
    if (bm.head) this.rotateLocalEulerDeg(bm.head, headCompDeg * 0.2, 0, 0);

    // 3. Bilateral lower limbs (Hip -> Knee -> Ankle -> Foot)
    // Align foot sole with ground support plane while keeping avatar thigh & shank lengths invariant.
    for (const side of ['L', 'R']) {
      const isLeft = side === 'L';
      const legMap = isLeft ? bm.leftLeg : bm.rightLeg;
      const standCfg = isLeft ? dp.leftLegStand : dp.rightLegStand;
      const ankleKey = isLeft ? 'leftAnkle' : 'rightAnkle';
      const kneeKey = isLeft ? 'leftKnee' : 'rightKnee';
      const heelKey = isLeft ? 'leftHeel' : 'rightHeel';
      const toeKey = isLeft ? 'leftToe' : 'rightToe';

      const pAnkle = positions[ankleKey] ? mjVecToThree(positions[ankleKey]) : new Vector3().fromArray(standCfg.target);
      const pKnee = positions[kneeKey] ? mjVecToThree(positions[kneeKey]) : new Vector3().fromArray(standCfg.pole);
      const pHeel = positions[heelKey] ? mjVecToThree(positions[heelKey]) : null;
      const pToe = positions[toeKey] ? mjVecToThree(positions[toeKey]) : null;

      // Keep the avatar's natural stance width X while following the physical sagittal ankle trajectory (Y, Z)
      const restFootHead = this.rest.get(legMap.foot);
      const ankleTarget = new Vector3(
        standCfg.target[0],
        Math.max(restFootHead.y, pAnkle.y),
        pAnkle.z,
      );

      // Knee pole target in front of the knee along the physical knee projection
      const kneePole = new Vector3(
        standCfg.pole[0],
        pKnee.y,
        Math.max(pKnee.z + 0.35, ankleTarget.z + 0.25),
      );

      this.solveLimb(side, 'leg', ankleTarget, kneePole, 142);

      // Foot pitch from physical heel->toe vector (in stance, heel and toe stay flat on the floor -> pitch ≈ 0)
      let footPitchRad = 0;
      if (pHeel && pToe) {
        const footVec = pToe.clone().sub(pHeel);
        footPitchRad = -Math.atan2(footVec.y, Math.max(1e-4, footVec.z));
      }
      const yawRad = (standCfg.yawDeg ?? (isLeft ? 7 : -7)) * DEG;
      const footQ = new Quaternion().setFromEuler(new Euler(footPitchRad, yawRad, 0, 'YXZ'));
      this.setWorldRotation(legMap.foot, footQ);
    }

    // 4. Bilateral upper limbs attached to the moving torso
    // Use natural relaxed arm pose relative to the tilted torsoshoulder, or physical arm sites when elbow is in front
    for (const side of ['L', 'R']) {
      const isLeft = side === 'L';
      const armCfg = isLeft ? dp.leftArmStand : dp.rightArmStand;
      const armMap = isLeft ? bm.leftArm : bm.rightArm;
      const shoulderPos = this.point(armMap.upperArm);
      const target = shoulderPos.clone().add(new Vector3().fromArray(armCfg.targetOffsetFromShoulder));
      const pole = shoulderPos.clone().add(new Vector3().fromArray(armCfg.poleOffsetFromShoulder));
      // Add slight natural counter-balance forward reach during squat
      const squatDepth = Math.max(0, restPelvisY - pPelvis.y);
      target.z += squatDepth * 0.45;
      target.y += squatDepth * 0.20;
      pole.z -= 0.15;
      this.solveLimb(side, 'arm', target, pole);
      this.solveHand(
        side,
        new Vector3(0, -0.85, 0.5).normalize(),
        new Vector3(isLeft ? -1 : 1, 0, 0),
      );
      this.relaxHand(side);
    }
  }

  /**
   * Measure current bone lengths (distance between parent and child bone world positions)
   * for verification and diagnostics.
   */
  measureBoneLengths() {
    this.model.updateMatrixWorld(true);
    const out = {};
    for (const [name, bone] of this.bones) {
      if (bone.parent && bone.parent.isBone) {
        const pPos = bone.parent.getWorldPosition(new Vector3());
        const cPos = bone.getWorldPosition(new Vector3());
        out[name] = pPos.distanceTo(cPos);
      }
    }
    return out;
  }
}
