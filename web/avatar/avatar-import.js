/**
 * Phase A import pipeline: turn an arbitrary rigged glTF scene into an AvatarProfile
 * that the existing AvatarAdapter can drive.
 *
 * Three coordinate frames are kept strictly apart (see docs/avatar-pipeline.md):
 * - Source Model frame: whatever the GLB scene graph produces (any up axis, units, yaw).
 * - Canonical Humanoid frame: metres, +Y up, +Z forward (the character faces +Z),
 *   +X = character's left, feet on y = 0, hips centred on x = z = 0.
 * - h3d / MuJoCo motion frame: +X forward, +Y left, +Z up. Conversion to the viewer
 *   frame stays inside AvatarAdapter (mjVecToThree); this module never sees it.
 *
 * The scene graph is NOT modified: bones keep their local transforms and the mesh keeps
 * its skin and materials. Instead the profile carries a root transform (place the model
 * into the canonical frame) and per-joint default poses derived from canonical metrics.
 * The adapter composes rotations relative to each bone's captured bind pose, so models
 * whose rest pose is not "all identity quaternions" still retarget correctly.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  CANONICAL_BONES,
  buildBoneTree,
  computeCanonicalFrame,
  diagnoseHumanoidMap,
  inferHumanoidBoneMap,
  readVrmHumanoidMap,
} from './skeleton-normalizer.js';

/** Collect model-space bone heads/hierarchy and skin diagnostics without mutating the scene. */
export function inspectAvatarScene(model) {
  model.updateMatrixWorld(true);
  const bones = [];
  let skinnedMeshes = 0;
  const diagnostics = [];
  model.traverse((object) => {
    if (object.isBone) {
      let parent = object.parent;
      while (parent && !parent.isBone) parent = parent.parent;
      const head = object.getWorldPosition(new Vector3());
      const children = object.children.filter((child) => child.isBone);
      let tail;
      if (children.length) {
        const child = children.reduce((best, item) => {
          const bestDistance = best.getWorldPosition(new Vector3()).distanceToSquared(head);
          const itemDistance = item.getWorldPosition(new Vector3()).distanceToSquared(head);
          return itemDistance > bestDistance ? item : best;
        });
        tail = child.getWorldPosition(new Vector3());
      } else {
        tail = head.clone().add(new Vector3(0, 0.025, 0));
      }
      bones.push({
        name: object.name,
        parent: parent?.name ?? null,
        head: head.toArray(),
        tail: tail.toArray(),
      });
    }
    if (object.isSkinnedMesh) {
      skinnedMeshes += 1;
      if (!object.geometry.getAttribute('skinIndex') || !object.geometry.getAttribute('skinWeight')) {
        diagnostics.push(`网格“${object.name || '(未命名)'}”缺少 JOINTS_0 / WEIGHTS_0 蒙皮属性`);
      }
      if (!object.skeleton?.bones?.length) diagnostics.push(`网格“${object.name || '(未命名)'}”的 skeleton 为空`);
    }
  });
  if (!bones.length) diagnostics.push('模型没有任何骨骼（未绑骨）');
  if (!skinnedMeshes) diagnostics.push('模型没有 SkinnedMesh 蒙皮网格');
  return { bones, skinnedMeshes, diagnostics };
}

/** Rebind every vertex in a mesh to one bone. */
export function bindSkinnedMeshToBone(model, meshName, boneName) {
  const mesh = model.getObjectByName(meshName);
  if (!mesh?.isSkinnedMesh) return false;
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  const boneIndex = mesh.skeleton.bones.findIndex((bone) => bone.name === boneName);
  if (!skinIndex || !skinWeight || boneIndex < 0) return false;
  for (let vertex = 0; vertex < skinIndex.count; vertex++) {
    skinIndex.setXYZW(vertex, boneIndex, 0, 0, 0);
    skinWeight.setXYZW(vertex, 1, 0, 0, 0);
  }
  skinIndex.needsUpdate = true;
  skinWeight.needsUpdate = true;
  return true;
}

/**
 * Correct a displaced rigged garment fragment so its long axis follows the source
 * upper-arm segment. This is for assets whose weight map is valid but whose fragment
 * was exported away from its influencing bone. The geometry is corrected once in bind
 * space, then rigidly attached to the upper arm so its sleeve follows the arm pose.
 */
export function alignSkinnedMeshPartToArm(model, meshName, upperBoneName, elbowBoneName) {
  const mesh = model.getObjectByName(meshName);
  const positions = mesh?.geometry?.getAttribute('position');
  const upper = model.getObjectByName(upperBoneName);
  const elbow = model.getObjectByName(elbowBoneName);
  if (!mesh?.isSkinnedMesh || !positions || !upper?.isBone || !elbow?.isBone) return false;
  if (mesh.userData.h3dArmAlignment === `${upperBoneName}:${elbowBoneName}`) return true;
  if (!mesh.skeleton?.bones?.some((bone) => bone.name === upperBoneName)) return false;

  model.updateMatrixWorld(true);
  const vertices = [];
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const point = new Vector3();
  for (let index = 0; index < positions.count; index++) {
    point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
    vertices.push(point.clone());
    min.min(point);
    max.max(point);
  }

  const extent = max.sub(min);
  const axis = extent.x >= extent.y && extent.x >= extent.z
    ? new Vector3(1, 0, 0)
    : extent.y >= extent.z ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  const projections = vertices.map((vertex) => vertex.dot(axis)).sort((a, b) => a - b);
  const low = projections[Math.floor(projections.length * 0.1)];
  const high = projections[Math.floor(projections.length * 0.9)];
  const lowEnd = new Vector3();
  const highEnd = new Vector3();
  let lowCount = 0;
  let highCount = 0;
  for (const vertex of vertices) {
    const projection = vertex.dot(axis);
    if (projection <= low) { lowEnd.add(vertex); lowCount += 1; }
    if (projection >= high) { highEnd.add(vertex); highCount += 1; }
  }
  if (!lowCount || !highCount) return false;
  lowEnd.divideScalar(lowCount);
  highEnd.divideScalar(highCount);

  const shoulder = upper.getWorldPosition(new Vector3());
  const proximal = lowEnd.distanceTo(shoulder) < highEnd.distanceTo(shoulder) ? lowEnd : highEnd;
  const distal = proximal === lowEnd ? highEnd : lowEnd;
  const target = elbow.getWorldPosition(new Vector3()).sub(shoulder);
  const source = distal.clone().sub(proximal);
  if (source.lengthSq() < 1e-8 || target.lengthSq() < 1e-8) return false;

  const rotation = new Quaternion().setFromUnitVectors(source.normalize(), target.normalize());
  const worldCorrection = new Matrix4()
    .makeTranslation(shoulder.x, shoulder.y, shoulder.z)
    .multiply(new Matrix4().makeRotationFromQuaternion(rotation))
    .multiply(new Matrix4().makeTranslation(-proximal.x, -proximal.y, -proximal.z));
  const localCorrection = mesh.matrixWorld.clone().invert()
    .multiply(worldCorrection)
    .multiply(mesh.matrixWorld);
  mesh.geometry.applyMatrix4(localCorrection);
  mesh.geometry.computeBoundingBox();
  mesh.geometry.computeBoundingSphere();
  if (!bindSkinnedMeshToBone(model, meshName, upperBoneName)) return false;
  mesh.userData.h3dArmAlignment = `${upperBoneName}:${elbowBoneName}`;
  return true;
}

/** Swap mirrored bone influences without changing geometry or materials. */
export function swapMirroredSkinBones(model, meshName, leftPrefix, rightPrefix) {
  const mesh = model.getObjectByName(meshName);
  if (!mesh?.isSkinnedMesh) return false;
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  if (!skinIndex || !skinWeight) return false;
  const bones = mesh.skeleton.bones;
  const left = new Map();
  const right = new Map();
  bones.forEach((bone, index) => {
    if (bone.name.startsWith(`${leftPrefix}_`)) left.set(bone.name.slice(leftPrefix.length + 1), index);
    if (bone.name.startsWith(`${rightPrefix}_`)) right.set(bone.name.slice(rightPrefix.length + 1), index);
  });
  const swap = new Map();
  for (const [suffix, index] of left) {
    const other = right.get(suffix);
    if (other !== undefined) {
      swap.set(index, other);
      swap.set(other, index);
    }
  }
  if (!swap.size) return false;
  for (let vertex = 0; vertex < skinIndex.count; vertex++) {
    for (let slot = 0; slot < 4; slot++) {
      const index = skinIndex.getComponent(vertex, slot);
      if (swap.has(index)) skinIndex.setComponent(vertex, slot, swap.get(index));
    }
  }
  skinIndex.needsUpdate = true;
  return true;
}

/** Reweight a sleeve mesh by the position of each vertex relative to its source arm bones. */
export function redistributeArmSleeveWeights(model, meshName, sidePrefix) {
  const mesh = model.getObjectByName(meshName);
  if (!mesh?.isSkinnedMesh) return false;
  const positions = mesh.geometry.getAttribute('position');
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  const bones = mesh.skeleton.bones;
  const upperIndex = bones.findIndex((bone) => bone.name === `${sidePrefix}_Upperarm`);
  const forearmIndex = bones.findIndex((bone) => bone.name === `${sidePrefix}_Forearm`);
  const handIndex = bones.findIndex((bone) => bone.name === `${sidePrefix}_Hand`);
  if (!positions || !skinIndex || !skinWeight || upperIndex < 0 || forearmIndex < 0 || handIndex < 0) return false;

  model.updateMatrixWorld(true);
  const point = new Vector3();
  const world = new Vector3();
  const upper = bones[upperIndex].getWorldPosition(new Vector3());
  const elbow = bones[forearmIndex].getWorldPosition(new Vector3());
  const hand = bones[handIndex].getWorldPosition(new Vector3());

  for (let vertex = 0; vertex < positions.count; vertex++) {
    point.fromBufferAttribute(positions, vertex);
    world.copy(point).applyMatrix4(mesh.matrixWorld);
    const upperDistance = world.distanceToSquared(upper);
    const elbowDistance = world.distanceToSquared(elbow);
    const handDistance = world.distanceToSquared(hand);
    const boneIndex = handDistance < elbowDistance && handDistance < upperDistance
      ? handIndex
      : elbowDistance < upperDistance ? forearmIndex : upperIndex;
    skinIndex.setXYZW(vertex, boneIndex, 0, 0, 0);
    skinWeight.setXYZW(vertex, 1, 0, 0, 0);
  }
  skinIndex.needsUpdate = true;
  skinWeight.needsUpdate = true;
  return true;
}

/** Rebind a known detached mesh only when every positive skin influence matches the expected source bone. */
export function rebindSkinnedMeshToBone(model, meshName, expectedBoneName, targetBoneName) {
  const mesh = model.getObjectByName(meshName);
  if (!mesh?.isSkinnedMesh) return false;
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  const sourceIndex = mesh.skeleton.bones.findIndex((bone) => bone.name === expectedBoneName);
  const targetIndex = mesh.skeleton.bones.findIndex((bone) => bone.name === targetBoneName);
  if (!skinIndex || !skinWeight || sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return false;

  for (let vertex = 0; vertex < skinIndex.count; vertex++) {
    for (let slot = 0; slot < 4; slot++) {
      if (skinWeight.getComponent(vertex, slot) > 1e-6 && skinIndex.getComponent(vertex, slot) !== sourceIndex) return false;
    }
  }
  for (let vertex = 0; vertex < skinIndex.count; vertex++) {
    skinIndex.setXYZW(vertex, targetIndex, 0, 0, 0);
    skinWeight.setXYZW(vertex, 1, 0, 0, 0);
  }
  skinIndex.needsUpdate = true;
  skinWeight.needsUpdate = true;
  return true;
}

/** @type {Record<string, string>} */
const SIDE_OF = { left: 'L', right: 'R' };
const FINGER_ORDER = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const FINGER_CHAIN_LENGTH = 3;

/** @param {Record<string, any>} fingers @param {string} side */
function fingersForSide(fingers, side) {
  const out = {};
  for (const [role, chain] of Object.entries(fingers)) {
    if (role.startsWith(SIDE_OF[side]) || role.startsWith(side)) out[role] = chain;
  }
  return out;
}

/** @param {Record<string, any>} map @param {Record<string, any>} fingers */
function buildAdapterBoneMap(map, fingers) {
  const arm = (side) => {
    const s = SIDE_OF[side];
    const sideFingers = fingersForSide(fingers, side);
    const chainOf = (finger) => sideFingers[`${s}${finger}`] ?? sideFingers[`${side}${finger}`] ?? [];
    return {
      clavicle: map[`${side}Shoulder`],
      shoulder: map[`${side}Shoulder`],
      upperArm: map[`${side}UpperArm`],
      upperArmTwist: map[`${side}UpperArmTwist`],
      forearm: map[`${side}LowerArm`],
      forearmTwist: map[`${side}LowerArmTwist`],
      wrist: map[`${side}Hand`],
      thumb: chainOf('Thumb'),
      index: chainOf('Index'),
      middle: chainOf('Middle'),
      ring: chainOf('Ring'),
      pinky: chainOf('Little'),
    };
  };
  const leg = (side) => ({
    pelvis: map.hips,
    upperLeg: map[`${side}UpperLeg`],
    upperLegTwist: map[`${side}UpperLegTwist`],
    lowerLeg: map[`${side}LowerLeg`],
    lowerLegTwist: map[`${side}LowerLegTwist`],
    foot: map[`${side}Foot`],
    toes: map[`${side}Toes`] ? [map[`${side}Toes`]] : [],
  });
  return {
    pelvis: map.hips,
    spine: Array.isArray(map.spine) ? map.spine : [],
    neck: Array.isArray(map.neck) ? map.neck : [],
    head: map.head,
    leftArm: arm('left'),
    rightArm: arm('right'),
    leftLeg: leg('left'),
    rightLeg: leg('right'),
  };
}

/** @param {Record<string, any>} map @param {any} frame @param {Map<string, any>} byName */
function buildDefaultPose(map, frame, byName, frameMatrix) {
  const point = (role) => {
    const bone = byName.get(map[role]);
    return bone
      ? new Vector3().fromArray(bone.head).applyMatrix4(frameMatrix)
      : new Vector3(0, 0, 0);
  };
  const height = Math.max(0.5, frame.height);
  /** @type {Record<string, any>} */
  const pose = { pelvisRestMuJoCoZ: point('hips').y, fingerRelaxedFlexDeg: [12, 16, 8] };
  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? 1 : -1;
    const upper = point(`${side}UpperArm`);
    const lower = point(`${side}LowerArm`);
    const hand = point(`${side}Hand`);
    const reach = Math.max(height * 0.2, upper.distanceTo(lower) + lower.distanceTo(hand));
    const foot = point(`${side}Foot`);
    const hipX = point(`${side}UpperLeg`).x;
    pose[`${side}ArmStand`] = {
      targetOffsetFromShoulder: [sign * reach * 0.14, -reach * 0.985, reach * 0.04],
      poleOffsetFromShoulder: [sign * reach * 0.35, -reach * 0.52, -reach * 0.18],
      handForward: [0, -1, 0],
      // At rest the palms face the body: -X for the left hand, +X for the right.
      palmNormal: [-sign, 0, 0],
    };
    pose[`${side}LegStand`] = {
      target: [foot.x, foot.y, foot.z],
      pole: [hipX * 1.4, height * 0.28, height * 0.55],
      yawDeg: 0,
      pitchDeg: 0,
    };
  }
  return pose;
}

/**
 * Build an AvatarProfile from a parsed glTF (GLTFLoader result).
 * Throws when roles required for playback are missing; fingers, twist bones, neck and
 * spine details degrade gracefully. `options.overrides` forces specific roles,
 * e.g. { hips: 'bone_3', leftHand: 'wrist.l' }.
 */
/** @param {any} gltf @param {any} [options] */
export function buildImportedProfile(gltf, options = {}) {
  if (!gltf?.scene) throw new Error('GLB 解析结果为空');
  const { bones, skinnedMeshes, diagnostics: skinDiagnostics } = inspectAvatarScene(gltf.scene);
  if (!bones.length) {
    if (!options.allowIncomplete) {
      throw new Error(`模型没有骨骼，无法驱动动作。请先用 Blender 预处理工具绑定骨骼（见 scripts/rig-glb.py）。诊断：${skinDiagnostics.join('；')}`);
    }
    return {
      profile: null,
      map: {},
      sources: {},
      fingers: {},
      frame: null,
      diagnosis: { valid: false, missing: ['hips', 'spine', 'head', ...CANONICAL_BONES.required], optionalMissing: [...CANONICAL_BONES.optional] },
      diagnostics: skinDiagnostics,
    };
  }

  const vrm = readVrmHumanoidMap(gltf);
  const { map, sources, fingers } = inferHumanoidBoneMap(bones, { vrm, overrides: options.overrides });
  const frame = computeCanonicalFrame(bones, map, {
    upAxis: options.upAxis,
    flipFacing: options.flipFacing,
    unitScale: options.unitScale,
  });

  const diagnosis = diagnoseHumanoidMap(map);
  if (!skinnedMeshes) {
    diagnosis.valid = false;
    diagnosis.missing.push('SkinnedMesh 蒙皮');
  }
  if (!diagnosis.valid && !options.allowIncomplete) {
    throw new Error(
      `骨骼映射不完整，缺少必需关节：${diagnosis.missing.join('、')}。`
      + ` 已识别 ${Object.keys(map).length} 个角色（${Object.entries(sources).map(([role, source]) => `${role}:${source}`).join(', ') || '无'}）。`
      + ' 可在 Options 面板手工映射，或通过 --override 角色名=骨骼名 指定。',
    );
  }

  const byName = new Map(bones.map((bone) => [bone.name, bone]));
  const frameMatrix = new Matrix4().compose(
    new Vector3().fromArray(frame.offset),
    new Quaternion().fromArray(frame.quaternion),
    new Vector3().setScalar(frame.scale),
  );
  const canonicalBones = bones.map((bone) => ({
    ...bone,
    head: new Vector3().fromArray(bone.head).applyMatrix4(frameMatrix).toArray(),
    tail: new Vector3().fromArray(bone.tail).applyMatrix4(frameMatrix).toArray(),
  }));
  const boneMap = buildAdapterBoneMap(map, fingers);
  const defaultPose = buildDefaultPose(map, frame, byName, frameMatrix);
  const optionalMissing = [...diagnosis.optionalMissing];
  if (frame.notes.length) optionalMissing.push(...frame.notes);

  const profile = {
    id: options.id ?? 'imported-avatar',
    label: options.label ?? '导入的人模',
    source: 'glb-import',
    scale: frame.scale,
    heroicShape: false,
    overrideMaterials: false,
    rootTransform: {
      position: frame.offset,
      quaternion: frame.quaternion,
      scale: frame.scale,
    },
    boneMap,
    defaultPose,
    rigInfo: { height: frame.height, bones: canonicalBones },
    canonicalFrame: {
      sourceAxes: frame.sourceAxes,
      scale: frame.scale,
      offset: frame.offset,
      notes: frame.notes,
    },
    importDiagnostics: {
      skinnedMeshes,
      sources,
      optionalMissing,
      diagnostics: skinDiagnostics,
    },
  };
  return { profile, map, sources, fingers, frame, diagnosis, diagnostics: [...skinDiagnostics, ...frame.notes] };
}

export function applyAvatarRootTransform(model, profile) {
  const transform = profile?.rootTransform;
  if (!transform) return model;
  model.position.fromArray(transform.position);
  model.quaternion.fromArray(transform.quaternion).normalize();
  model.scale.setScalar(transform.scale);
  model.updateMatrixWorld(true);
  return model;
}

/** Human-readable mapping table for CLI diagnostics. */
/** @param {Record<string, any>} map @param {Record<string, any>} sources @param {Record<string, any>} fingers */
export function formatMappingReport(map, sources, fingers) {
  const lines = [];
  const row = (role) => `${role.padEnd(18)} ${(map[role] ?? '—').toString().padEnd(28)} ${sources[role] ?? ''}`;
  for (const role of CANONICAL_BONES.required) if (map[role]) lines.push(row(role));
  for (const role of ['chest', 'neck', 'leftShoulder', 'rightShoulder']) if (map[role]) lines.push(row(role));
  for (const role of CANONICAL_BONES.optional.filter((item) => /Twist|Toes/.test(item))) if (map[role]) lines.push(row(role));
  for (const side of ['left', 'right']) {
    for (const finger of FINGER_ORDER) {
      const chain = fingers[`${side}${finger}`];
      if (chain?.length) lines.push(`${`${side}${finger}`.padEnd(18)} ${chain.join(' → ')}`);
    }
  }
  return lines.join('\n');
}

export { buildBoneTree, computeCanonicalFrame, diagnoseHumanoidMap, inferHumanoidBoneMap, readVrmHumanoidMap };
