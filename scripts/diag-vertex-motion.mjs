import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { AvatarAdapter } from '../web/avatar/avatar-adapter.js';
import { applyAvatarRootTransform, buildImportedProfile, rebindSkinnedMeshToBone } from '../web/avatar/avatar-import.js';

globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });

const bytes = readFileSync('out/炭治郎-avatar.noindex/tanjiro-tripo-h3.1-rigged-operator.glb');
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, '');
rebindSkinnedMeshToBone(gltf.scene, 'tripo_part_11', 'R_Upperarm', 'Spine01');
const { profile, map } = buildImportedProfile(gltf, { allowIncomplete: true });
applyAvatarRootTransform(gltf.scene, profile);
const adapter = new AvatarAdapter(gltf.scene, profile.rigInfo, profile);

const mesh = gltf.scene.getObjectByName('tripo_part_7');
const positions = mesh.geometry.getAttribute('position');
const indices = mesh.geometry.getAttribute('skinIndex');
const weights = mesh.geometry.getAttribute('skinWeight');
const skinVertex = (vertex) => {
  gltf.scene.updateMatrixWorld(true);
  mesh.skeleton.update();
  const transformed = new Vector3().fromBufferAttribute(positions, vertex);
  mesh.applyBoneTransform(vertex, transformed);
  return mesh.localToWorld(transformed).toArray().map((value) => Number(value.toFixed(3)));
};
const landmarkNames = {
  rightUpper: map.rightUpperArm,
  rightLower: map.rightLowerArm,
  rightHand: map.rightHand,
  leftUpper: map.leftUpperArm,
  leftLower: map.leftLowerArm,
  leftHand: map.leftHand,
};
const landmarks = () => Object.fromEntries(Object.entries(landmarkNames).map(([label, bone]) => [
  label,
  adapter.point(bone).toArray().map((value) => Number(value.toFixed(3))),
]));
const bindBones = landmarks();
const vertex = 100;
const bind = skinVertex(vertex);
const motions = JSON.parse(readFileSync('web/demo-motion.json', 'utf8'));
const clip = motions.clips.find((item) => item.id === 'single-elbow');
adapter.applyFrame(clip, clip.samples[80]);
const posed = skinVertex(vertex);
const posedBones = landmarks();
const partBounds = {};
for (const part of gltf.scene.children.flatMap(function walk(object) { return [object, ...object.children.flatMap(walk)]; }).filter((object) => object.isSkinnedMesh)) {
  const name = part.name;
  const position = part.geometry.getAttribute('position');
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const sample = new Vector3();
  for (let index = 0; index < position.count; index++) {
    sample.fromBufferAttribute(position, index);
    part.applyBoneTransform(index, sample);
    part.localToWorld(sample);
    min.min(sample);
    max.max(sample);
  }
  partBounds[name] = {
    vertices: position.count,
    materials: (Array.isArray(part.material) ? part.material : [part.material]).map((material) => material?.name),
    min: min.toArray().map((value) => Number(value.toFixed(3))),
    max: max.toArray().map((value) => Number(value.toFixed(3))),
  };
}
const skeletonReferences = {};
for (const partName of ['tripo_part_2', 'tripo_part_6', 'tripo_part_7', 'tripo_part_9', 'tripo_part_10', 'tripo_part_11']) {
  const part = gltf.scene.getObjectByName(partName);
  skeletonReferences[partName] = Object.fromEntries(Object.entries(landmarkNames).map(([label, boneName]) => {
    const index = part.skeleton.bones.indexOf(adapter.bone(boneName));
    return [label, { index, isAdapterBone: part.skeleton.bones[index] === adapter.bone(boneName) }];
  }));
}
console.log(JSON.stringify({
  bone: mesh.skeleton.bones[indices.getX(vertex)].name,
  bind,
  posed,
  bindBones,
  posedBones,
  partBounds,
  skeletonReferences,
}, null, 2));
