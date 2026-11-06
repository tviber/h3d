import { readFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
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

const boxOf = () => {
  const out = {};
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((mesh) => {
    if (!mesh.isSkinnedMesh) return;
    const box = new Box3().setFromObject(mesh, true);
    out[mesh.name] = box.getCenter(new Vector3()).toArray().map((value) => Number(value.toFixed(3)));
  });
  return out;
};
const bind = boxOf();
adapter.applyDefaultStandPose();
const stand = boxOf();
const motions = JSON.parse(readFileSync('web/demo-motion.json', 'utf8'));
const clip = motions.clips.find((item) => item.id === 'single-elbow');
const frame = clip.samples.reduce((best, item) => Math.abs(item.time - 0.4) < Math.abs(best.time - 0.4) ? item : best);
adapter.applyFrame(clip, frame);
const posed = boxOf();
const moved = Object.fromEntries(Object.keys(bind).map((name) => [name, {
  bindToStand: bind[name].map((value, index) => Number((stand[name][index] - value).toFixed(3))),
  standToCurl: stand[name].map((value, index) => Number((posed[name][index] - value).toFixed(3))),
}]));
console.log(JSON.stringify(moved, null, 2));
