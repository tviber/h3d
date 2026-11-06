import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { AvatarAdapter } from '../web/avatar/avatar-adapter.js';
import { applyAvatarRootTransform, buildImportedProfile } from '../web/avatar/avatar-import.js';

const [avatarPath, motionPath] = process.argv.slice(2);
if (!avatarPath || !motionPath) {
  throw new Error('usage: node scripts/check-rigged-avatar.mjs avatar.glb motion-set.json');
}
// GLTFLoader only needs an image-like object for this CPU check; no browser or WebGL context is used.
globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });
const bytes = readFileSync(avatarPath);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, '');
const skins = [];
gltf.scene.traverse((object) => { if (object.isSkinnedMesh) skins.push(object); });
assert.ok(skins.length > 0, 'GLB must contain a SkinnedMesh');
const skinSnapshot = skins.map((mesh) => ({
  mesh,
  indices: mesh.geometry.getAttribute('skinIndex').array,
  weights: mesh.geometry.getAttribute('skinWeight').array,
  bindMatrix: mesh.bindMatrix.clone(),
  inverses: mesh.skeleton.boneInverses.map((matrix) => matrix.clone()),
}));
const { profile, diagnosis, map } = buildImportedProfile(gltf, { id: 'tanjiro-test', label: '炭治郎', allowIncomplete: true });
assert.ok(profile, 'import must build an AvatarProfile');
assert.equal(diagnosis.valid, true, `required roles missing: ${diagnosis.missing.join(', ')}`);
assert.ok(map.hips && map.rightUpperArm && map.leftUpperLeg, 'major bones must map');
assert.equal(profile.overrideMaterials, false);
applyAvatarRootTransform(gltf.scene, profile);
const adapter = new AvatarAdapter(gltf.scene, profile.rigInfo, profile);
adapter.applyVisualMaterials();
adapter.applyDefaultStandPose();
const restLengths = adapter.measureBoneLengths();
const motions = JSON.parse(readFileSync(motionPath, 'utf8'));
const clips = motions.clips ?? [motions];
let frames = 0;
let maximumLengthError = 0;
for (const clip of clips) {
  for (const frame of clip.samples) {
    adapter.applyFrame(clip, frame);
    frames += 1;
    const lengths = adapter.measureBoneLengths();
    for (const [name, value] of Object.entries(lengths)) {
      assert.ok(Number.isFinite(value), `${clip.id}/${frame.time}: ${name} length is non-finite`);
      maximumLengthError = Math.max(maximumLengthError, Math.abs(value - restLengths[name]));
    }
    for (const bone of adapter.bones.values()) {
      assert.ok([bone.position.x, bone.position.y, bone.position.z,
        bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w].every(Number.isFinite),
      `${clip.id}/${frame.time}: bone transform is non-finite`);
    }
  }
}
adapter.reset();
for (const saved of skinSnapshot) {
  assert.equal(saved.mesh.geometry.getAttribute('skinIndex').array, saved.indices);
  assert.equal(saved.mesh.geometry.getAttribute('skinWeight').array, saved.weights);
  assert.ok(saved.mesh.bindMatrix.equals(saved.bindMatrix));
  assert.ok(saved.mesh.skeleton.boneInverses.every((matrix, i) => matrix.equals(saved.inverses[i])));
}
console.log(JSON.stringify({
  avatar: avatarPath,
  bytes: bytes.length,
  bones: adapter.bones.size,
  skinnedMeshes: skins.length,
  materials: skins.map((mesh) => Array.isArray(mesh.material) ? mesh.material.length : 1),
  clips: clips.map((clip) => clip.id),
  frames,
  maximumLengthError,
  skinAndBindDataPreserved: true,
}, null, 2));
