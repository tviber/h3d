import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { AvatarAdapter } from '../web/avatar/avatar-adapter.js';
import { applyAvatarRootTransform, buildImportedProfile, rebindSkinnedMeshToBone, redistributeArmSleeveWeights } from '../web/avatar/avatar-import.js';

globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });

const bytes = readFileSync('out/炭治郎-avatar.noindex/tanjiro-tripo-h3.1-rigged-operator.glb');
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, '');
rebindSkinnedMeshToBone(gltf.scene, 'tripo_part_11', 'R_Upperarm', 'Spine01');
const { profile, map } = buildImportedProfile(gltf, { allowIncomplete: true });
applyAvatarRootTransform(gltf.scene, profile);
const adapter = new AvatarAdapter(gltf.scene, profile.rigInfo, profile);
adapter.applyDefaultStandPose();

const point = new Vector3();
const report = {};
for (const name of ['tripo_part_2', 'tripo_part_6', 'tripo_part_7', 'tripo_part_9', 'tripo_part_10']) {
  const mesh = gltf.scene.getObjectByName(name);
  const positions = mesh.geometry.getAttribute('position');
  const indices = mesh.geometry.getAttribute('skinIndex');
  const weights = mesh.geometry.getAttribute('skinWeight');
  const counts = new Map();
  let minX = Infinity, maxX = -Infinity;
  for (let index = 0; index < positions.count; index++) {
    point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    for (let slot = 0; slot < 4; slot++) {
      if (weights.getComponent(index, slot) > 1e-4) {
        const bone = mesh.skeleton.bones[indices.getComponent(index, slot)]?.name;
        counts.set(bone, (counts.get(bone) ?? 0) + 1);
      }
    }
  }
  report[name] = {
    xRange: [Number(minX.toFixed(3)), Number(maxX.toFixed(3))],
    bones: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4),
  };
}
console.log(JSON.stringify({
  leftHandX: Number(adapter.point(map.leftHand).x.toFixed(3)),
  rightHandX: Number(adapter.point(map.rightHand).x.toFixed(3)),
  report,
}, null, 2));
