import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createHumanoidProfile, loadAvatarProfile, validateHumanoidProfile } from '../web/avatar/avatar-loader.js';

function humanBytes(): ArrayBuffer {
  const bytes = readFileSync(new URL('../web/models/human.glb', import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test('generic loader accepts a complete GLB without rig.json and ties calibration to its hash', async () => {
  const buffer = humanBytes();
  const profile = createHumanoidProfile('human-generic', 'Generic human', 'human.glb');
  const adapter = await loadAvatarProfile(profile, { buffer });
  assert.equal(adapter.report.assetSha256, createHash('sha256').update(new Uint8Array(buffer)).digest('hex'));
  assert.ok(adapter.report.diagnostics.skinCount > 0);
  assert.ok(adapter.report.roles['leftLeg.foot'].startsWith('path:'));
  assert.equal(profile.asset.sha256, undefined, 'loader must not mutate supplied profile');
  adapter.stand();
});

test('loader rejects mismatched assets, invalid headers and unimplemented profile policies', async () => {
  const profile = createHumanoidProfile('bad', 'Bad');
  profile.asset.sha256 = '0'.repeat(64);
  await assert.rejects(loadAvatarProfile(profile, { buffer: humanBytes() }), /摘要/);
  await assert.rejects(loadAvatarProfile(profile, { buffer: new ArrayBuffer(0) }), /GLB/);
  profile.retarget.limbStretch = true;
  assert.throws(() => validateHumanoidProfile(profile), /limbStretch/);
  profile.retarget.limbStretch = false;
  profile.appearance.materials = 'replace';
  assert.throws(() => validateHumanoidProfile(profile), /materials/);
});
