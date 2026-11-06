import { readFileSync } from 'node:fs';
import { Matrix4, Vector3 } from 'three';
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
mesh.skeleton.update();
const bone = gltf.scene.getObjectByName(map.rightLowerArm);
const index = mesh.skeleton.bones.indexOf(bone);
const composed = new Matrix4().multiplyMatrices(bone.matrixWorld, mesh.skeleton.boneInverses[index]);
const expected = mesh.skeleton.boneMatrices.slice(index * 16, index * 16 + 16);
const delta = composed.elements.map((value, element) => Math.abs(value - expected[element]));
console.log(JSON.stringify({
  maxDelta: Math.max(...delta),
  bindMatrixIsIdentity: mesh.bindMatrix.elements.every((value, element) => Math.abs(value - (element % 5 === 0 ? 1 : 0)) < 1e-6),
  boneCount: mesh.skeleton.bones.length,
}, null, 2));
