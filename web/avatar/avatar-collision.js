import { CapsuleGeometry, Group, MathUtils, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { capsuleContact } from './collision-math.js';
import { GarmentSolver } from './cloth-solver.js';

const point = bone => bone.getWorldPosition(new Vector3());
const rotation = bone => bone.getWorldQuaternion(new Quaternion());
const DEFAULT_RADII = { torso: .060, pelvis: .065, head: .060, upperArm: .025, forearm: .022, hand: .025, thigh: .038, shin: .030, foot: .030 };

export function validateCollisionConfig(config) {
  if (config === undefined) return;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('collision must be an object');
  if (config.radii !== undefined && (!config.radii || typeof config.radii !== 'object' || Array.isArray(config.radii))) throw new Error('collision.radii must be an object');
  for (const key of ['enabled', 'clothEnabled']) if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`collision.${key} must be boolean`);
  for (const [key, value] of Object.entries(config.radii ?? {})) {
    if (!Object.hasOwn(DEFAULT_RADII, key) || !Number.isFinite(value) || value < .005 || value > .15) throw new Error(`Invalid collision radius: ${key} (fractions of avatar height, .005–.15)`);
  }
  if (config.maxCorrectionDegrees !== undefined && (!Number.isFinite(config.maxCorrectionDegrees) || config.maxCorrectionDegrees < 1 || config.maxCorrectionDegrees > 60)) {
    throw new Error('collision.maxCorrectionDegrees must be between 1 and 60');
  }
  if (config.garments !== undefined && (!Array.isArray(config.garments) || config.garments.length > 8)) throw new Error('collision.garments must contain at most eight meshes');
  for (const garment of config.garments ?? []) {
    if (!garment || typeof garment.mesh !== 'string' || !garment.mesh.trim()) throw new Error('Cloth requires an explicit mesh name');
    for (const key of ['stretchCompliance', 'bendCompliance', 'attachmentCompliance']) {
      if (garment[key] !== undefined && (!Number.isFinite(garment[key]) || garment[key] < 0 || garment[key] > .01)) throw new Error(`Invalid cloth ${key}`);
    }
    const pin = garment.pin;
    if (!pin || ['top', 'nearRole', 'alongChain'].filter(key => pin[key] !== undefined).length !== 1) throw new Error('Cloth pin requires one of top, nearRole/radius or alongChain/fraction');
    if (pin.top !== undefined && (!Number.isFinite(pin.top) || pin.top <= 0 || pin.top >= 1)) throw new Error('Cloth pin.top must be between 0 and 1');
    if (pin.nearRole !== undefined && (typeof pin.nearRole !== 'string' || !Number.isFinite(pin.radius) || pin.radius <= 0 || pin.radius > .3)) throw new Error('Cloth pin requires a role and positive radius fraction');
    if (pin.alongChain !== undefined && (!['leftArm', 'rightArm', 'leftLeg', 'rightLeg'].includes(pin.alongChain) || !Number.isFinite(pin.fraction) || pin.fraction <= 0 || pin.fraction >= 1)) throw new Error('Cloth pin requires an anatomical chain and fraction between 0 and 1');
  }
}

/** Display-space contact constraints; never applies forces to the source simulation. */
export class AvatarCollision {
  constructor(adapter, config = {}) {
    validateCollisionConfig(config);
    this.adapter = adapter;
    this.calibration = adapter.calibration;
    this.enabled = config.enabled ?? false;
    this.clothEnabled = config.clothEnabled ?? true;
    this.maxCorrection = (config.maxCorrectionDegrees ?? 35) * Math.PI / 180;
    this.capsules = [];
    this.pairs = [];
    this.debug = new Group();
    this.debug.name = 'Avatar_collision_volumes';
    this.debug.visible = false;
    this.debugMeshes = [];
    this.diagnostics = { enabled: this.enabled, contactsBefore: 0, contactsAfter: 0, maxPenetrationBefore: 0, maxPenetration: 0, maxCorrectionDegrees: 0, cloth: null };
    this.buildCapsules({ ...DEFAULT_RADII, ...config.radii });
    this.garments = new GarmentSolver(this.calibration, config.garments);
    this.garments.configureSeams(this.capsules);
    this.garments.setEnabled(this.enabled && this.clothEnabled);
  }

  binding(bone, world) {
    return { bone, local: bone.worldToLocal(world.clone()) };
  }

  addCapsule(id, type, aBone, a, bBone, b, radius, chain = null, segment = null) {
    this.capsules.push({ id, type, aBinding: this.binding(aBone, a), bBinding: this.binding(bBone, b),
      a: a.clone(), b: b.clone(), radius: radius * this.calibration.height, chain, segment });
  }

  buildCapsules(radii) {
    const c = this.calibration, rest = bone => c.rest.get(bone).worldPosition.clone();
    const pelvis = rest(c.pelvis), neck = c.neck[0] ?? c.head, chest = rest(neck);
    const up = chest.clone().sub(pelvis).normalize();
    this.addCapsule('torso', 'torso', c.pelvis, pelvis.clone().lerp(chest, .22), neck, pelvis.clone().lerp(chest, .77), radii.torso);
    const leftHip = c.chains.leftLeg.upper, rightHip = c.chains.rightLeg.upper;
    this.addCapsule('pelvis', 'pelvis', leftHip, rest(leftHip).lerp(pelvis, .65), rightHip, rest(rightHip).lerp(pelvis, .65), radii.pelvis);
    this.addCapsule('head', 'head', c.head, rest(c.head).addScaledVector(up, c.height * .025), c.head, rest(c.head).addScaledVector(up, c.height * .065), radii.head);
    for (const side of ['left', 'right']) {
      for (const kind of ['Arm', 'Leg']) {
        const name = `${side}${kind}`, chain = c.chains[name];
        const a = rest(chain.upper), b = rest(chain.lower), d = rest(chain.end);
        const upperType = kind === 'Arm' ? 'upperArm' : 'thigh', lowerType = kind === 'Arm' ? 'forearm' : 'shin';
        this.addCapsule(`${name}.upper`, upperType, chain.upper, a.clone().lerp(b, .23), chain.lower, b, radii[upperType], name, 'upper');
        this.addCapsule(`${name}.lower`, lowerType, chain.lower, b, chain.end, d, radii[lowerType], name, 'lower');
        const distal = c.roles.get(`${name}.${kind === 'Arm' ? 'middle' : 'toes'}`);
        const end = distal ? rest(distal) : d.clone().addScaledVector(d.clone().sub(b).normalize(), c.height * .045);
        this.addCapsule(`${name}.end`, kind === 'Arm' ? 'hand' : 'foot', chain.end, d, chain.end, end, radii[kind === 'Arm' ? 'hand' : 'foot'], name, 'end');
      }
    }
    for (let i = 0; i < this.capsules.length; i++) for (let j = i + 1; j < this.capsules.length; j++) {
      const a = this.capsules[i], b = this.capsules[j];
      if (a.chain && a.chain === b.chain) continue; // Anatomical joint neighbours overlap by design.
      if (!a.chain && !b.chain) continue;
      // Hip/thigh contact belongs to the hip joint, not a self-collision constraint.
      if ((a.type === 'pelvis' || a.type === 'torso') && b.type === 'thigh') continue;
      if ((a.type === 'pelvis') && b.type === 'shin') continue;
      this.pairs.push([a, b]);
    }
  }

  updateCapsules() {
    this.adapter.model.updateMatrixWorld(true);
    for (const capsule of this.capsules) {
      capsule.a.copy(capsule.aBinding.local).applyMatrix4(capsule.aBinding.bone.matrixWorld);
      capsule.b.copy(capsule.bBinding.local).applyMatrix4(capsule.bBinding.bone.matrixWorld);
    }
  }

  contacts() {
    const result = [];
    for (const [a, b] of this.pairs) {
      const contact = capsuleContact(a, b);
      if (contact && contact.depth > 1e-5) result.push({ a, b, ...contact });
    }
    return result;
  }

  moveArm(capsule, contactPoint, normal, depth, originals) {
    const chain = this.adapter.chains[capsule.chain];
    const joints = capsule.segment === 'upper' ? [chain.upper] : [chain.lower, chain.upper];
    const candidates = joints.map(bone => {
      const lever = contactPoint.clone().sub(point(bone));
      const gradient = lever.cross(normal);
      return { bone, gradient, magnitude: gradient.length() };
    }).sort((a, b) => b.magnitude - a.magnitude);
    for (const { bone, gradient, magnitude } of candidates) {
      if (magnitude < 1e-7) continue;
      const before = bone.quaternion.clone();
      const angle = Math.min(.16, depth / magnitude * .8);
      const desired = new Quaternion().setFromAxisAngle(gradient.divideScalar(magnitude), angle).multiply(rotation(bone));
      this.adapter.setWorldRotation(bone, desired);
      const base = originals.get(bone), deviation = base.angleTo(bone.quaternion);
      if (deviation > this.maxCorrection) bone.quaternion.copy(base).slerp(bone.quaternion, this.maxCorrection / deviation);
      this.adapter.model.updateMatrixWorld(true);
      const flex = point(chain.lower).sub(point(chain.upper)).angleTo(point(chain.end).sub(point(chain.lower)));
      if (flex > 155 * Math.PI / 180 + 1e-6 || before.angleTo(bone.quaternion) < 1e-8) {
        bone.quaternion.copy(before); this.adapter.model.updateMatrixWorld(true); continue;
      }
      return true;
    }
    return false;
  }

  moveLeg(capsule, contactPoint, normal, depth, originals) {
    // Swivel only the knee around the hip->ankle axis, retaining support position
    // and foot orientation. If that DOF cannot resolve contact, report residual.
    if (capsule.segment === 'end') return false;
    const chain = this.adapter.chains[capsule.chain];
    const hip = point(chain.upper), knee = point(chain.lower), ankle = point(chain.end);
    const axis = ankle.clone().sub(hip).normalize(), lever = contactPoint.clone().sub(hip);
    const derivative = axis.clone().cross(lever).dot(normal);
    if (Math.abs(derivative) < 1e-6) return false;
    const angle = MathUtils.clamp(depth / derivative * .6, -.12, .12);
    const pole = knee.clone().sub(hip).applyAxisAngle(axis, angle).add(hip);
    const footQ = rotation(chain.end), before = [chain.upper.quaternion.clone(), chain.lower.quaternion.clone()];
    this.adapter.solveChain(capsule.chain, ankle, pole, 155);
    if ([chain.upper, chain.lower].some(bone => originals.get(bone).angleTo(bone.quaternion) > this.maxCorrection)) {
      chain.upper.quaternion.copy(before[0]); chain.lower.quaternion.copy(before[1]);
      this.adapter.model.updateMatrixWorld(true);
    }
    this.adapter.setWorldRotation(chain.end, footQ);
    return true;
  }

  resolveRigid() {
    this.updateCapsules();
    const before = this.contacts();
    const originals = new Map([...this.adapter.rest].map(([bone]) => [bone, bone.quaternion.clone()]));
    for (let iteration = 0; iteration < 18; iteration++) {
      let changed = false;
      for (const [a, b] of this.pairs) {
        const contact = capsuleContact(a, b, this.calibration.height * .0005);
        if (!contact || contact.depth < 1e-5) continue;
        const move = (capsule, p, n, depth) => !capsule.chain ? false
          : capsule.chain.endsWith('Arm') ? this.moveArm(capsule, p, n, depth, originals)
            : this.moveLeg(capsule, p, n, depth, originals);
        const aArm = a.chain?.endsWith('Arm'), bArm = b.chain?.endsWith('Arm');
        // Supporting legs/body win over arms. Two arms share the correction.
        if (aArm || !bArm) changed = move(a, contact.point, contact.normal, contact.depth * (aArm && bArm ? .5 : 1)) || changed;
        this.updateCapsules();
        const remaining = capsuleContact(a, b, this.calibration.height * .0005);
        if (remaining && (bArm || !aArm)) changed = move(b, remaining.otherPoint, remaining.normal.clone().negate(), remaining.depth) || changed;
        this.updateCapsules();
      }
      if (!changed) break;
    }
    const after = this.contacts();
    Object.assign(this.diagnostics, {
      enabled: true, contactsBefore: before.length, contactsAfter: after.length,
      maxPenetrationBefore: Math.max(0, ...before.map(c => c.depth)), maxPenetration: Math.max(0, ...after.map(c => c.depth)),
      maxCorrectionDegrees: Math.max(0, ...[...originals].map(([bone, q]) => q.angleTo(bone.quaternion) * 180 / Math.PI)),
      unresolvedPairs: after.map(c => ({ a: c.a.id, b: c.b.id, depth: c.depth })),
    });
  }

  solve() {
    this.garments.setEnabled(this.enabled && this.clothEnabled);
    if (this.enabled) {
      this.resolveRigid();
      this.diagnostics.cloth = this.clothEnabled && this.garments.garments.length ? this.garments.solve(this.capsules) : null;
    } else {
      this.updateCapsules();
      Object.assign(this.diagnostics, { enabled: false, contactsBefore: 0, contactsAfter: 0, maxPenetrationBefore: 0, maxPenetration: 0, maxCorrectionDegrees: 0, unresolvedPairs: [], cloth: null });
    }
    this.updateDebug();
    return this.diagnostics;
  }

  setDebugVisible(visible) {
    this.debug.visible = visible;
    if (visible && !this.debugMeshes.length) {
      for (const capsule of this.capsules) {
        const mesh = new Mesh(new CapsuleGeometry(1, 1, 4, 10), new MeshBasicMaterial({ color: 0x149eab, wireframe: true, transparent: true, opacity: .55, depthTest: false }));
        mesh.name = capsule.id; mesh.renderOrder = 5;
        this.debug.add(mesh); this.debugMeshes.push(mesh);
      }
    }
    this.updateCapsules(); this.updateDebug();
  }

  updateDebug() {
    if (!this.debug.visible) return;
    const colliding = new Set(this.contacts().flatMap(c => [c.a.id, c.b.id]));
    this.capsules.forEach((c, i) => {
      const mesh = this.debugMeshes[i];
      if (!mesh) return;
      // Unit capsule has central segment length 1. Rebuild only on dimension
      // change; orientation/translation remain cheap during playback.
      const length = c.a.distanceTo(c.b);
      if (Math.abs((mesh.userData.length ?? -1) - length) > 1e-5) {
        mesh.geometry.dispose(); mesh.geometry = new CapsuleGeometry(c.radius, length, 4, 10); mesh.userData.length = length;
      }
      mesh.position.copy(c.a).add(c.b).multiplyScalar(.5);
      mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), c.b.clone().sub(c.a).normalize().lengthSq() > 0 ? c.b.clone().sub(c.a).normalize() : new Vector3(0, 1, 0));
      mesh.material.color.setHex(colliding.has(c.id) ? 0xe35b42 : 0x149eab);
    });
  }

  dispose() {
    this.garments.dispose();
    for (const mesh of this.debugMeshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
    this.debug.clear(); this.debug.removeFromParent(); this.debugMeshes = [];
  }
}
