import { readFileSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { encodePng } from '../src/plot/png.ts';
import { AvatarAdapter } from '../web/avatar/avatar-adapter.js';
import { applyAvatarRootTransform, buildImportedProfile, rebindSkinnedMeshToBone } from '../web/avatar/avatar-import.js';

globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });

const [clipId, timeSeconds, outPath, view = 'side', meshFilter = '', mode = 'rebind', excludedMesh = ''] = process.argv.slice(2);
const bytes = readFileSync('out/炭治郎-avatar.noindex/tanjiro-tripo-h3.1-rigged-operator.glb');
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, '');
const excludedMeshes = new Set(excludedMesh.split(',').filter(Boolean));
const skipPart11Rebind = mode === 'no-rebind';
if (!skipPart11Rebind) rebindSkinnedMeshToBone(gltf.scene, 'tripo_part_11', 'R_Upperarm', 'Spine01');
const { profile, map } = buildImportedProfile(gltf, { allowIncomplete: true });
applyAvatarRootTransform(gltf.scene, profile);
const adapter = new AvatarAdapter(gltf.scene, profile.rigInfo, profile);

const motions = JSON.parse(readFileSync('web/demo-motion.json', 'utf8'));
if (clipId === 'stand') {
  adapter.applyDefaultStandPose();
} else if (clipId !== 'bind') {
  const clip = motions.clips.find((item) => item.id === clipId);
  if (!clip) throw new Error(`Unknown clip: ${clipId}`);
  const frame = clip.samples.reduce((best, item) => Math.abs(item.time - Number(timeSeconds)) < Math.abs(best.time - Number(timeSeconds)) ? item : best);
  adapter.applyFrame(clip, frame);
}

const WIDTH = 700, HEIGHT = 900;
const pixels = new Uint8Array(WIDTH * HEIGHT * 3).fill(255);
const project = view === 'front'
  ? (point) => [point.x, point.y]
  : view === 'back' ? (point) => [-point.x, point.y] : (point) => [-point.z, point.y];
const samples = [];
const point = new Vector3();
gltf.scene.updateMatrixWorld(true);
gltf.scene.traverse((mesh) => {
  if (!mesh.isSkinnedMesh || (meshFilter && mesh.name !== meshFilter) || excludedMeshes.has(mesh.name)) return;
  const positions = mesh.geometry.getAttribute('position');
  const step = Math.max(1, Math.floor(positions.count / 4000));
  mesh.skeleton.update();
  for (let index = 0; index < positions.count; index += step) {
    point.fromBufferAttribute(positions, index);
    mesh.applyBoneTransform(index, point);
    mesh.localToWorld(point);
    samples.push(project(point));
  }
});
const xs = samples.map(([x]) => x), ys = samples.map(([, y]) => y);
const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
const scale = Math.min((WIDTH - 40) / (maxX - minX), (HEIGHT - 40) / (maxY - minY));
for (const [x, y] of samples) {
  const px = Math.round(20 + (x - minX) * scale);
  const py = Math.round(HEIGHT - 20 - (y - minY) * scale);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const ix = px + dx, iy = py + dy;
    if (ix < 0 || iy < 0 || ix >= WIDTH || iy >= HEIGHT) continue;
    const offset = (iy * WIDTH + ix) * 3;
    pixels[offset] = 40; pixels[offset + 1] = 60; pixels[offset + 2] = 90;
  }
}
writeFileSync(outPath, encodePng(WIDTH, HEIGHT, pixels));
console.log(JSON.stringify({ clip: clipId, time: timeSeconds, view, mesh: meshFilter || 'all', excludedMesh: excludedMesh || null, out: outPath }));
