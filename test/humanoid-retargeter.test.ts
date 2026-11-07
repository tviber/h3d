import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Bone, Group, Quaternion, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HumanoidRetargeter, type RetargetCalibration } from '../web/avatar/humanoid-retargeter.js';
import { inspectHumanoid } from '../web/avatar/humanoid-inspector.js';

const motion = JSON.parse(readFileSync(new URL('../web/demo-motion.json', import.meta.url), 'utf8'));

/** World anatomy is known independently; local axes and scene transforms deliberately differ. */
function fixture({ height = 1, thigh = .44, shin = .40, width = .13, arm = .3, forearm = .26, rotated = false } = {}) {
  const model = new Group();
  model.position.set(.03, .01, -.05);
  model.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), rotated ? .67 : 0);
  model.scale.setScalar(rotated ? 1.7 : 1);
  const roles = new Map<string, Bone>();
  const bind = new Map<Bone, any>();
  function bone(name: string, parent: Group | Bone, world: number[]) {
    const b = new Bone(); b.name = name; parent.add(b);
    model.updateMatrixWorld(true);
    b.position.copy(parent.worldToLocal(new Vector3(...world).multiplyScalar(height)));
    if (rotated) b.quaternion.setFromAxisAngle(new Vector3(.4, .8, .2).normalize(), .27 + bind.size * .015);
    model.updateMatrixWorld(true);
    bind.set(b, null);
    return b;
  }
  const pelvisY = thigh + shin + .08;
  const pelvis = bone('Hips', model, [0, pelvisY, 0]); roles.set('pelvis', pelvis);
  const spine = bone('Spine', pelvis, [0, pelvisY + .16, 0]);
  const head = bone('Head', spine, [0, pelvisY + .64, 0]); roles.set('head', head);
  const chains: any = {};
  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? 1 : -1;
    const upperArm = bone(`${side}UpperArm`, spine, [sign * .20, pelvisY + .43, 0]);
    const lowerArm = bone(`${side}Forearm`, upperArm, [sign * (.20 + arm), pelvisY + .43, 0]);
    const hand = bone(`${side}Hand`, lowerArm, [sign * (.20 + arm + forearm), pelvisY + .43, 0]);
    const upperLeg = bone(`${side}Thigh`, pelvis, [sign * width, pelvisY, 0]);
    const lowerLeg = bone(`${side}Shin`, upperLeg, [sign * width, shin + .08, 0]);
    const foot = bone(`${side}Foot`, lowerLeg, [sign * width, .08, 0]);
    for (const [key, value] of Object.entries({ upperArm, forearm: lowerArm, wrist: hand })) roles.set(`${side}Arm.${key}`, value);
    for (const [key, value] of Object.entries({ upperLeg, lowerLeg, foot })) roles.set(`${side}Leg.${key}`, value);
    chains[`${side}Arm`] = { upper: upperArm, lower: lowerArm, end: hand, upperLength: arm * height, lowerLength: forearm * height };
    chains[`${side}Leg`] = { upper: upperLeg, lower: lowerLeg, end: foot, upperLength: thigh * height, lowerLength: shin * height };
  }
  model.updateMatrixWorld(true);
  for (const [b] of bind) bind.set(b, { position: b.position.clone(), quaternion: b.quaternion.clone(), scale: b.scale.clone(), worldPosition: b.getWorldPosition(new Vector3()), worldQuaternion: b.getWorldQuaternion(new Quaternion()) });
  const calibration: RetargetCalibration = { model, profile: { id: 'fixture', retarget: { contactPolicy: 'source-contact' } }, roles, rest: bind, chains, spine: [spine], neck: [], pelvis, head, height: height * (pelvisY + .8), groundY: 0 };
  return new HumanoidRetargeter(calibration);
}

function state(adapter: HumanoidRetargeter) {
  return [...adapter.rest].map(([bone]) => [bone.position.toArray(), bone.quaternion.toArray(), bone.scale.toArray()]);
}
function point(bone: Bone) { return bone.getWorldPosition(new Vector3()); }
function unchangedLengths(adapter: HumanoidRetargeter, before: Record<string, number>) {
  const current = adapter.measureBoneLengths();
  for (const [name, length] of Object.entries(before)) assert.ok(Math.abs(current[name] - length) < 1e-9, `changed length ${name}`);
}

test('generic retargeting preserves non-identity bind transforms, uniform parent scale, and every bone length', () => {
  const adapter = fixture({ rotated: true, height: .75, thigh: .32, shin: .43, width: .18 });
  const modelState = [adapter.model.position.toArray(), adapter.model.quaternion.toArray(), adapter.model.scale.toArray()];
  const lengths = adapter.measureBoneLengths();
  const input = structuredClone(motion);
  for (const clip of motion.clips) {
    for (let i = 0; i < clip.samples.length; i += 17) {
      adapter.applyFrame(clip, clip.samples[i]);
      unchangedLengths(adapter, lengths);
      for (const [bone, rest] of adapter.rest) {
        assert.ok(Math.abs(bone.quaternion.length() - 1) < 1e-12);
        assert.ok(bone.scale.distanceTo(rest.scale) < 1e-12);
        if (bone !== adapter.calibration.pelvis) assert.ok(bone.position.distanceTo(rest.position) < 1e-12);
      }
    }
  }
  assert.deepEqual([adapter.model.position.toArray(), adapter.model.quaternion.toArray(), adapter.model.scale.toArray()], modelState);
  assert.deepEqual(motion, input);
  adapter.reset();
  for (const [bone, rest] of adapter.rest) assert.deepEqual(bone.quaternion.toArray(), rest.quaternion.toArray());
});

test('landmark elbow fallback uses zero flexion for a straight arm and ninety degrees for a bent arm', () => {
  const adapter = fixture({ rotated: true, arm: .38, forearm: .19 });
  const clip = { rig: { kind: 'elbow' } };
  const frame: any = { positions: { rightShoulder: [0, 0, 1], rightElbow: [0, 0, .6], rightWrist: [0, 0, .2] }, joints: {} };
  const chain = adapter.chains.rightArm;
  adapter.applyFrame(clip, frame);
  const angle = () => point(chain.lower).sub(point(chain.upper)).angleTo(point(chain.end).sub(point(chain.lower)));
  assert.ok(angle() < 1e-6);
  frame.positions.rightWrist = [.4, 0, .6];
  adapter.applyFrame(clip, frame);
  assert.ok(Math.abs(angle() - Math.PI / 2) < 1e-7);
  assert.ok(point(chain.lower).sub(point(chain.upper)).normalize().distanceTo(new Vector3(0, -1, 0)) < 1e-7);
  assert.ok(point(chain.end).sub(point(chain.lower)).normalize().distanceTo(new Vector3(0, 0, 1)) < 1e-7);
});

test('different leg ratios retain their own stance and floor support during squat; direct seeks are deterministic', () => {
  const clip = motion.clips.find((clip: any) => clip.id === 'squat-to-stand');
  for (const shape of [{ height: .72, thigh: .30, shin: .42, width: .19 }, { height: 1.22, thigh: .52, shin: .34, width: .105 }]) {
    const adapter = fixture({ ...shape, rotated: true });
    const footX = point(adapter.chains.leftLeg.end).x;
    const lengths = adapter.measureBoneLengths();
    const target = clip.samples[35];
    adapter.applyFrame(clip, target);
    const direct = state(adapter);
    for (let i = clip.samples.length - 1; i >= 0; i -= 13) adapter.applyFrame(clip, clip.samples[i]);
    adapter.applyFrame(clip, target);
    assert.deepEqual(state(adapter), direct);
    for (const side of ['left', 'right'] as const) {
      const foot = adapter.chains[`${side}Leg`].end;
      const sole = foot.localToWorld(adapter.soleOffsets[side].clone());
      assert.ok(Math.abs(sole.y) < 1e-5, `sole height ${sole.y}`);
      assert.ok(Math.abs(point(foot).x - (side === 'left' ? footX : -footX)) < 1e-5);
      assert.equal(adapter.diagnostics.contacts[side], 'sole-locked');
      assert.ok(adapter.diagnostics.limbResiduals[`${side}Leg`] < 1e-5);
    }
    unchangedLengths(adapter, lengths);
  }
});

test('calibration refuses fixed display landmarks as a substitute for exact source rest metadata', () => {
  const adapter = fixture();
  const clip = structuredClone(motion.clips.find((clip: any) => clip.rig.kind === 'lower-body'));
  delete clip.rig.bodies;
  assert.throws(() => adapter.applyFrame(clip, clip.samples[0]), /sourceRest/);
  clip.rig.sourceRest = { positions: { pelvis: [0, 0, .915], leftHip: [0, .095, .915], leftKnee: [0, .095, .495], leftAnkle: [0, .095, .075], rightHip: [0, -.095, .915], rightKnee: [0, -.095, .495], rightAnkle: [0, -.095, .075] } };
  adapter.applyFrame(clip, clip.samples[0]);
  assert.equal(adapter.diagnostics.sourceCalibration, 'sourceRest');
});

test('an airborne interval releases the foot lock instead of pinning every motion to the floor', () => {
  const adapter = fixture();
  const clip = structuredClone(motion.clips.find((clip: any) => clip.id === 'squat-to-stand'));
  const frame = structuredClone(clip.samples.at(-1));
  frame.time = 1.5; frame.contacts = []; frame.grf.feet.left = [0, 0, 0]; frame.grf.feet.right = [0, 0, 0];
  for (const key of Object.keys(frame.positions)) frame.positions[key][2] += .3;
  clip.samples.push(frame);
  const later = structuredClone(frame); later.time = 1.7; clip.samples.push(later);
  adapter.applyFrame(clip, later);
  assert.equal(adapter.diagnostics.contacts.left, 'free');
  assert.ok(point(adapter.chains.leftLeg.end).y > .3);
});

test('real MakeHuman GLB uses the generic path without rig.json, changing weights, inverse binds, or materials', async () => {
  const raw = readFileSync(new URL('../web/models/human.glb', import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), '');
  const surfaces: { mesh: SkinnedMesh; material: unknown; inverses: number[][]; weights: number[]; skin: number[] }[] = [];
  gltf.scene.traverse(object => {
    if (object instanceof SkinnedMesh) surfaces.push({ mesh: object, material: object.material, inverses: object.skeleton.boneInverses.map(m => m.toArray()), weights: Array.from(object.geometry.getAttribute('skinWeight').array), skin: Array.from(object.geometry.getAttribute('skinIndex').array) });
  });
  const inspection = inspectHumanoid(gltf.scene, { schemaVersion: 'h3d.avatar-profile.v2', id: 'test-real', rig: { preset: 'makehuman' } });
  const adapter = new HumanoidRetargeter(inspection);
  const lengths = adapter.measureBoneLengths();
  for (const clip of motion.clips) for (let i = 0; i < clip.samples.length; i += 25) {
    adapter.applyFrame(clip, clip.samples[i]);
    unchangedLengths(adapter, lengths);
  }
  for (const { mesh, material, inverses, weights, skin } of surfaces) {
    assert.equal(mesh.material, material);
    assert.deepEqual(mesh.skeleton.boneInverses.map(m => m.toArray()), inverses);
    assert.deepEqual(Array.from(mesh.geometry.getAttribute('skinWeight').array), weights);
    assert.deepEqual(Array.from(mesh.geometry.getAttribute('skinIndex').array), skin);
  }
});

test('source coordinate conventions and unsupported stretching are rejected instead of silently misinterpreted', () => {
  const adapter = fixture();
  const clip = structuredClone(motion.clips[0]);
  clip.rig.coordinateFrame.up = '+y';
  assert.throws(() => adapter.applyFrame(clip, clip.samples[0]), /coordinateFrame/);
  adapter.calibration.profile.retarget.limbStretch = true;
  assert.throws(() => new HumanoidRetargeter(adapter.calibration), /stretching/);
});
