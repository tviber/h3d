import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { applyAvatarRootTransform, buildImportedProfile } from '../web/avatar/avatar-import.js';

globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });

const bytes = readFileSync('out/炭治郎-avatar.noindex/tanjiro-tripo-h3.1-rigged-operator.glb');
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, '');
const { profile, map } = buildImportedProfile(gltf, { allowIncomplete: true });
applyAvatarRootTransform(gltf.scene, profile);

const point = new Vector3();
const mesh = gltf.scene.getObjectByName(process.argv[2] ?? 'tripo_part_7');
const positions = mesh.geometry.getAttribute('position');
const indices = mesh.geometry.getAttribute('skinIndex');
const weights = mesh.geometry.getAttribute('skinWeight');
const bones = mesh.skeleton.bones;
const groups = new Map();
const weightedGroups = new Map();
for (let index = 0; index < positions.count; index++) {
  point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
  const bone = bones[indices.getX(index)].name;
  const group = groups.get(bone) ?? { count: 0, x: 0, y: 0, z: 0 };
  group.count += 1; group.x += point.x; group.y += point.y; group.z += point.z;
  groups.set(bone, group);
  for (let slot = 0; slot < 4; slot++) {
    const weight = weights.getComponent(index, slot);
    if (weight <= 1e-6) continue;
    const influenceBone = bones[indices.getComponent(index, slot)].name;
    const influence = weightedGroups.get(influenceBone) ?? { weight: 0, x: 0, y: 0, z: 0 };
    influence.weight += weight;
    influence.x += point.x * weight;
    influence.y += point.y * weight;
    influence.z += point.z * weight;
    weightedGroups.set(influenceBone, influence);
  }
}
const summary = [...groups].map(([bone, group]) => ({
  bone, count: group.count,
  center: [group.x, group.y, group.z].map((value) => Number((value / group.count).toFixed(3))),
}));
summary.sort((a, b) => b.count - a.count);
const weightedSummary = [...weightedGroups].map(([bone, group]) => ({
  bone,
  weightSum: Number(group.weight.toFixed(2)),
  center: [group.x, group.y, group.z].map((value) => Number((value / group.weight).toFixed(3))),
}));
weightedSummary.sort((a, b) => b.weightSum - a.weightSum);
const bonePoint = (role) => {
  const bone = gltf.scene.getObjectByName(map[role]);
  return bone.getWorldPosition(new Vector3()).toArray().map((value) => Number(value.toFixed(3)));
};
console.log(JSON.stringify({
  bones: { rightUpper: bonePoint('rightUpperArm'), rightLower: bonePoint('rightLowerArm'), rightHand: bonePoint('rightHand'), leftHand: bonePoint('leftHand') },
  mesh: process.argv[2], groups: summary, weightedGroups: weightedSummary,
}, null, 2));
