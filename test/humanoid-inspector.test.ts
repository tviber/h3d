import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Bone, BufferGeometry, Float32BufferAttribute, Group, Matrix4, MeshBasicMaterial, SkinnedMesh, Skeleton, Uint16BufferAttribute, Vector3 } from 'three';
import { HumanoidInspectionError, inspectHumanoid, roleBonePath } from '../web/avatar/humanoid-inspector.js';

const glbPath = fileURLToPath(new URL('../web/models/human.glb', import.meta.url));
const rigPath = fileURLToPath(new URL('../web/models/rig.json', import.meta.url));
const legacy = JSON.parse(readFileSync(rigPath, 'utf8'));
const profile = {
  schemaVersion: 'h3d.avatar-profile.v2',
  rig: { preset: 'makehuman' },
  boneMap: {
    pelvis: 'root', head: 'head', spine: legacy.bones.filter((b: any) => /^spine/.test(b.name)).map((b: any) => b.name), neck: legacy.bones.filter((b: any) => /^neck/.test(b.name)).map((b: any) => b.name),
    leftArm: { upperArm: 'upperarm01_L', forearm: 'lowerarm01_L', wrist: 'wrist_L' }, rightArm: { upperArm: 'upperarm01_R', forearm: 'lowerarm01_R', wrist: 'wrist_R' },
    leftLeg: { upperLeg: 'upperleg01_L', lowerLeg: 'lowerleg01_L', foot: 'foot_L' }, rightLeg: { upperLeg: 'upperleg01_R', lowerLeg: 'lowerleg01_R', foot: 'foot_R' },
  },
  calibration: { forward: '+Z', up: '+Y' },
};

async function loadHuman() {
  const bytes = readFileSync(glbPath);
  return (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '/models/')).scene;
}

test('inspector preserves GLB skins, reports capabilities, and normalizes ground', async () => {
  const model = await loadHuman();
  const before = [] as any[];
  model.traverse((object: any) => { if (object.isSkinnedMesh) before.push({ mesh: object, bind: object.bindMatrix.clone(), inverse: object.bindMatrixInverse.clone(), bones: object.skeleton.boneInverses.map((m: any) => m.clone()) }); });
  const result = inspectHumanoid(model, profile);
  assert.equal(result.diagnostics.ok, true);
  assert.equal(result.diagnostics.capabilities.arms, true);
  assert.equal(result.diagnostics.capabilities.legs, true);
  assert.ok(result.height > 1.5);
  assert.ok(Math.abs(result.groundY) < 1e-6);
  assert.ok(result.soleOffsets.left instanceof Vector3);
  for (const saved of before) {
    assert.ok(saved.mesh.bindMatrix.equals(saved.bind));
    // Three.js updates this runtime world inverse when an ancestor moves.
    assert.ok(saved.mesh.bindMatrixInverse.equals(saved.mesh.matrixWorld.clone().invert()));
    assert.ok(saved.mesh.skeleton.boneInverses.every((m: any, i: number) => m.equals(saved.bones[i])));
  }
});

test('inspector rejects ambiguous required role mappings with diagnostics', () => {
  const model = new Group();
  const root = new Bone(); root.name = 'Hips';
  const a = new Bone(); a.name = 'LeftArm'; const b = new Bone(); b.name = 'LeftArm';
  root.add(a, b); model.add(root); model.updateMatrixWorld(true);
  assert.throws(() => inspectHumanoid(model, { schemaVersion: 'h3d.avatar-profile.v2', rig: { preset: 'mixamo' } }), (error: any) => {
    assert.ok(error instanceof HumanoidInspectionError);
    assert.ok(error.diagnostics.errors.some((item: string) => item.includes('Ambiguous')));
    return true;
  });
});

test('inspector rejects non-uniform and negative bone scale', () => {
  const model = new Group(); const bone = new Bone(); bone.name = 'Hips'; bone.scale.set(-1, 1, 1); model.add(bone);
  assert.throws(() => inspectHumanoid(model, { schemaVersion: 'h3d.avatar-profile.v2', rig: { preset: 'mixamo' } }), /Non-uniform|Negative or zero scale/);
});

function syntheticRig() {
  const model = new Group(); model.name = 'Fixture';
  const root = new Bone(); root.name = 'Hips'; root.position.y = 1; model.add(root);
  const names = ['Spine', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];
  const by = new Map<string, Bone>(); for (const name of names) { const bone = new Bone(); bone.name = name; by.set(name, bone); }
  root.add(by.get('Spine')!); by.get('Spine')!.position.y = 0.3; by.get('Spine')!.add(by.get('Head')!); by.get('Head')!.position.y = 0.3;
  for (const side of ['Left', 'Right']) { const arm = by.get(`${side}Arm`)!; const fore = by.get(`${side}ForeArm`)!; const hand = by.get(`${side}Hand`)!; arm.position.x = side === 'Left' ? 0.2 : -0.2; fore.position.y = -0.3; hand.position.y = -0.3; by.get('Spine')!.add(arm); arm.add(fore); fore.add(hand); const thigh = by.get(`${side}UpLeg`)!; const shin = by.get(`${side}Leg`)!; const foot = by.get(`${side}Foot`)!; thigh.position.x = side === 'Left' ? 0.15 : -0.15; shin.position.y = -0.45; foot.position.y = -0.45; root.add(thigh); thigh.add(shin); shin.add(foot); }
  // These are generated test triangles, not an additional real validation asset.
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([-.2,0,0,.2,0,0,0,1.8,0], 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute([0,0,0,0,0,0,0,0,0,0,0,0], 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute([1,0,0,0,1,0,0,0,1,0,0,0], 4));
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  model.add(mesh); model.updateMatrixWorld(true);
  const skeleton = new Skeleton([root, ...by.values()]); mesh.bind(skeleton);
  return { model, root, by, mesh, skeleton };
}

test('inspector keeps non-identity bind rotations and uniform parent transforms', () => {
  const { model, root, by, mesh, skeleton } = syntheticRig();
  const forearm = by.get('LeftForeArm')!;
  forearm.rotation.y = .5;
  model.updateMatrixWorld(true); skeleton.calculateInverses();
  model.rotation.y = Math.PI / 2; model.scale.setScalar(.8);
  const local = forearm.quaternion.clone();
  const inverse = skeleton.boneInverses.map(matrix => matrix.clone());
  const result = inspectHumanoid(model, { schemaVersion: 'h3d.avatar-profile.v2', rig: { preset: 'mixamo' } });
  assert.ok(forearm.quaternion.equals(local));
  assert.ok(Math.abs(result.chains.leftArm.lowerLength - .24) < 1e-9);
  assert.ok(result.rest.get(root)!.worldQuaternion.angleTo(root.getWorldQuaternion(local.clone())) < 1e-8);
  assert.ok(skeleton.boneInverses.every((matrix, index) => matrix.equals(inverse[index])));
  const foot = result.chains.leftLeg.end;
  assert.ok(Math.abs(foot.localToWorld(result.soleOffsets.left.clone()).y) < 1e-8);
  assert.equal(result.diagnostics.capabilities.fingers, false);
  assert.ok(mesh.material instanceof MeshBasicMaterial);
});

test('inspector rejects a non-bind pose and never silently resets the source', () => {
  const { model, by } = syntheticRig();
  const arm = by.get('LeftArm')!; arm.rotation.z = .4;
  const rotation = arm.quaternion.clone();
  assert.throws(() => inspectHumanoid(model, profile), /Bind pose mismatch/);
  assert.ok(arm.quaternion.equals(rotation));
  assert.equal(model.parent, null);
});

test('inspector accepts multiple skins sharing one rig and preserves each material', () => {
  const { model, mesh, skeleton } = syntheticRig();
  const second = new SkinnedMesh(mesh.geometry.clone(), new MeshBasicMaterial({ color: 0x123456 }));
  model.add(second); model.updateMatrixWorld(true); second.bind(skeleton);
  const material = second.material;
  const result = inspectHumanoid(model, { schemaVersion: 'h3d.avatar-profile.v2', rig: { preset: 'mixamo' } });
  assert.equal(result.diagnostics.skinCount, 2);
  assert.equal(second.material, material);
});

test('node path overrides resolve duplicate bone names, invalid hierarchy is rejected', () => {
  const { model, by } = syntheticRig();
  const extra = new Bone(); extra.name = 'LeftArm'; model.add(extra);
  const arm = by.get('LeftArm')!;
  assert.throws(() => inspectHumanoid(model, { schemaVersion: 'h3d.avatar-profile.v2' }), /Ambiguous/);
  const result = inspectHumanoid(model, { schemaVersion: 'h3d.avatar-profile.v2', rig: { boneOverrides: { 'leftArm.upperArm': roleBonePath(arm) } } });
  assert.equal(result.roles.get('leftArm.upperArm'), arm);
  const broken = syntheticRig();
  broken.root.attach(broken.by.get('LeftHand')!); broken.model.updateMatrixWorld(true); broken.skeleton.calculateInverses();
  assert.throws(() => inspectHumanoid(broken.model, { schemaVersion: 'h3d.avatar-profile.v2' }), /valid parent chain/);
});

test('unit conversion scales calibration lengths, unsupported and ambiguous axes are explicit', () => {
  const { model } = syntheticRig(); model.scale.setScalar(100);
  const result = inspectHumanoid(model, { schemaVersion: 'h3d.avatar-profile.v2', calibration: { unitScale: .01 } });
  assert.ok(Math.abs(result.chains.leftLeg.upperLength - .45) < 1e-8);
  assert.throws(() => inspectHumanoid(syntheticRig().model, { schemaVersion: 'h3d.avatar-profile.v2', calibration: { up: '+Z' } }), /Unsupported avatar up axis/);
  assert.throws(() => inspectHumanoid(syntheticRig().model, { schemaVersion: 'h3d.avatar-profile.v2', calibration: { forward: '-Z' } }), /conflict/);
});
