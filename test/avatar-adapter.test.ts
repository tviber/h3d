import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  MeshBasicMaterial,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AvatarAdapter, mjVecToThree, type AvatarRigInfo } from '../web/avatar/avatar-adapter.js';
import type { MotionClip } from '../src/motion-clip.ts';
import { applyHeroicShape } from '../web/avatar/shape-preset.js';

const rigPath = fileURLToPath(new URL('../web/models/rig.json', import.meta.url));
const glbPath = fileURLToPath(new URL('../web/models/human.glb', import.meta.url));
const motionPath = fileURLToPath(new URL('../web/demo-motion.json', import.meta.url));
const rigInfo = JSON.parse(readFileSync(rigPath, 'utf8')) as AvatarRigInfo;
const motionSet = JSON.parse(readFileSync(motionPath, 'utf8')) as { schemaVersion: string; clips: MotionClip[] };

function createAdapter() {
  const model = new Group();
  const bones = new Map<string, Bone>(rigInfo.bones.map((info) => [info.name, new Bone()]));
  const boneInfo = new Map<string, AvatarRigInfo['bones'][number]>(rigInfo.bones.map((info) => [info.name, info]));
  for (const info of rigInfo.bones) {
    const bone = bones.get(info.name)!;
    bone.name = info.name;
    const head = new Vector3().fromArray(info.head);
    if (info.parent) {
      const parentInfo = boneInfo.get(info.parent)!;
      bone.position.copy(head).sub(new Vector3().fromArray(parentInfo.head));
      bones.get(info.parent)!.add(bone);
    } else {
      bone.position.copy(head);
      model.add(bone);
    }
  }
  return new AvatarAdapter(model, rigInfo);
}

function maxLengthError(expected: Record<string, number>, actual: Record<string, number>): number {
  let max = 0;
  for (const [name, length] of Object.entries(expected)) {
    assert.ok(name in actual, `missing measured bone ${name}`);
    max = Math.max(max, Math.abs(length - actual[name]));
  }
  return max;
}

test('MuJoCo basis conversion preserves forward, left, and up axes', () => {
  assert.deepEqual(mjVecToThree([1, 0, 0]).toArray(), [0, 0, 1]);
  assert.deepEqual(mjVecToThree([0, 1, 0]).toArray(), [1, 0, 0]);
  assert.deepEqual(mjVecToThree([0, 0, 1]).toArray(), [0, 1, 0]);
});

test('all four motion clips retarget with fixed bone lengths and connected hands', () => {
  assert.equal(motionSet.schemaVersion, 'h3d.motion-set.v1');
  assert.deepEqual(motionSet.clips.map((clip) => clip.id), [
    'single-elbow', 'shoulder-elbow', 'squat-to-stand', 'countermovement-drive',
  ]);
  const untouchedMotion = structuredClone(motionSet);
  const adapter = createAdapter();
  adapter.applyDefaultStandPose();
  const restLengths = adapter.measureBoneLengths();
  let maximumLengthError = 0;
  const wristTravel = new Map<string, number>();
  const footHeights: { clip: string; side: string; time: number; height: number }[] = [];

  for (const clip of motionSet.clips) {
      let wristStart: Vector3 | null = null;
    let maxWristTravel = 0;
    for (const frame of clip.samples) {
      adapter.applyFrame(clip, frame);
      maximumLengthError = Math.max(maximumLengthError, maxLengthError(restLengths, adapter.measureBoneLengths()));
      for (const [name, bone] of adapter.bones) {
        assert.ok(bone.scale.distanceTo(new Vector3(1, 1, 1)) < 1e-12, `${clip.id}: ${name} scale changed`);
        if (name !== 'root') {
          assert.ok(bone.position.distanceTo(adapter.restLocal.get(name)!) < 1e-12, `${clip.id}: ${name} local bind position changed`);
        }
      }

      const wrist = adapter.point('wrist_R');
      const middleFinger = adapter.point('finger3-1_R');
      assert.ok(Math.abs(wrist.distanceTo(middleFinger) - adapter.rest.get('finger3-1_R')!.distanceTo(adapter.rest.get('wrist_R')!)) < 1e-9,
        `${clip.id}: hand detached from wrist`);
      if (!wristStart) wristStart = wrist.clone();
      maxWristTravel = Math.max(maxWristTravel, wristStart.distanceTo(wrist));

      if (clip.rig.kind === 'lower-body') {
        for (const side of ['L', 'R']) {
          const toeNames: string[] = adapter.profile.boneMap[side === 'L' ? 'leftLeg' : 'rightLeg'].toes;
          const lowestToe = Math.min(...toeNames.map((name) => adapter.point(name).y));
          footHeights.push({ clip: clip.id, side, time: frame.time, height: lowestToe });
        }
      }
    }
    wristTravel.set(clip.id, maxWristTravel);
  }

  assert.ok(maximumLengthError < 1e-9, `bone lengths changed by ${maximumLengthError} m`);
  assert.ok((wristTravel.get('single-elbow') ?? 0) > 0.04, 'single-elbow wrist did not move with its physical trajectory');
  assert.ok((wristTravel.get('shoulder-elbow') ?? 0) > 0.10, 'shoulder-elbow wrist did not follow shoulder motion');
  assert.ok(footHeights.every(({ height }) => height > -0.03 && height < 0.11), 'a foot landmark left the support plane');
  assert.deepEqual(motionSet, untouchedMotion, 'retargeting mutated exported physical motion data');

  adapter.reset();
  for (const [name, bone] of adapter.bones) {
    assert.ok(bone.position.distanceTo(adapter.restLocal.get(name)!) < 1e-12, `${name} bind position did not reset`);
    assert.ok(1 - Math.abs(bone.quaternion.dot(adapter.restLocalQuat.get(name)!)) < 1e-12, `${name} bind rotation did not reset`);
  }
});

test('legacy motion clips without body poses remain usable', () => {
  const adapter = createAdapter();
  const clip = structuredClone(motionSet.clips[0]);
  delete clip.rig.coordinateFrame;
  delete clip.rig.bodies;
  for (const frame of clip.samples) delete frame.bodies;
  assert.doesNotThrow(() => adapter.applyFrame(clip, clip.samples[Math.floor(clip.samples.length / 2)]));
});

test('heroic shaping preserves skin weights and the skeleton bind pose', () => {
  const root = new Group();
  const bone = new Bone();
  bone.name = 'fixture-bone';
  bone.position.set(0, 1, 0);
  root.add(bone);
  root.updateMatrixWorld(true);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([
    -0.22, 1.31, 0.12,
    0.22, 1.31, 0.12,
    0.0, 1.8, 0.05,
  ], 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  const skeletonBone = new Bone();
  skeletonBone.name = 'skin-bone';
  mesh.add(skeletonBone);
  mesh.bind(new Skeleton([skeletonBone]));
  root.add(mesh);
  root.updateMatrixWorld(true);

  const skinIndices = Array.from(geometry.getAttribute('skinIndex').array);
  const skinWeights = Array.from(geometry.getAttribute('skinWeight').array);
  const bindMatrix = mesh.bindMatrix.clone();
  const bindMatrixInverse = mesh.bindMatrixInverse.clone();
  const bonePosition = skeletonBone.position.clone();
  const boneQuaternion = skeletonBone.quaternion.clone();
  const before = geometry.getAttribute('position').getX(0);

  applyHeroicShape(root);

  const normals = geometry.getAttribute('normal');
  assert.ok(normals, 'shape preset did not rebuild surface normals');
  assert.ok(Array.from(normals.array).every(Number.isFinite), 'shape preset produced non-finite normals');
  assert.notEqual(geometry.getAttribute('position').getX(0), before, 'shape preset did not deform the fixture surface');
  assert.deepEqual(Array.from(geometry.getAttribute('skinIndex').array), skinIndices);
  assert.deepEqual(Array.from(geometry.getAttribute('skinWeight').array), skinWeights);
  assert.ok(mesh.bindMatrix.equals(bindMatrix));
  assert.ok(mesh.bindMatrixInverse.equals(bindMatrixInverse));
  assert.ok(skeletonBone.position.equals(bonePosition));
  assert.ok(skeletonBone.quaternion.equals(boneQuaternion));
  assert.ok(skeletonBone.scale.equals(new Vector3(1, 1, 1)));
});

test('heroic shaping blends torso and arm boundaries without elbow-region seams', () => {
  const probes = [
    [0.2999, 1.23, 0.12], [0.3001, 1.23, 0.12],
    [0.3499, 1.23, 0.12], [0.3501, 1.23, 0.12],
    [0.4, 1.1599, 0.12], [0.4, 1.1601, 0.12],
    [0.4, 1.4599, 0.12], [0.4, 1.4601, 0.12],
    [0, 1.8, 0],
  ];
  const root = new Group();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(probes.flat(), 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(probes.length * 4).fill(0), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(
    Array.from({ length: probes.length }, () => [1, 0, 0, 0]).flat(), 4,
  ));
  root.add(new SkinnedMesh(geometry, new MeshBasicMaterial()));

  const original = probes.map(([, , z]) => z);
  applyHeroicShape(root);
  const shaped = geometry.getAttribute('position');
  const pairs = [[0, 1], [2, 3], [4, 5], [6, 7]];
  for (const [a, b] of pairs) {
    const displacementA = shaped.getZ(a) - original[a];
    const displacementB = shaped.getZ(b) - original[b];
    assert.ok(Math.abs(displacementA - displacementB) < 1e-4,
      `shape displacement jumps across boundary between probes ${a} and ${b}`);
  }
});

test('MakeHuman GLB keeps its original skinning and bind matrices through retargeting', async () => {
  const bytes = readFileSync(glbPath);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new GLTFLoader().parseAsync(buffer, '/models/');
  const skinnedMeshes: SkinnedMesh[] = [];
  let boneCount = 0;
  gltf.scene.traverse((object) => {
    if (object instanceof Bone) boneCount++;
    if (object instanceof SkinnedMesh) skinnedMeshes.push(object);
  });
  assert.equal(boneCount, 163);
  assert.ok(skinnedMeshes.length > 0);

  const savedSkinData = skinnedMeshes.map((mesh) => ({
    mesh,
    indices: Array.from(mesh.geometry.getAttribute('skinIndex').array),
    weights: Array.from(mesh.geometry.getAttribute('skinWeight').array),
    bindMatrix: mesh.bindMatrix.clone(),
    bindMatrixInverse: mesh.bindMatrixInverse.clone(),
    boneInverses: mesh.skeleton.boneInverses.map((matrix) => matrix.clone()),
    normals: Array.from(mesh.geometry.getAttribute('normal').array),
  }));
  applyHeroicShape(gltf.scene);
  assert.ok(savedSkinData.some((saved) => {
    const normals = saved.mesh.geometry.getAttribute('normal').array;
    return normals.some((value, index) => Math.abs(value - saved.normals[index]) > 1e-5);
  }), 'heroic shape did not rebuild the MakeHuman surface normals');
  const adapter = new AvatarAdapter(gltf.scene, rigInfo);
  adapter.applyVisualMaterials();
  const bindPose = [...adapter.bones].map(([name, bone]) => ({
    name,
    position: bone.position.clone(),
    quaternion: bone.quaternion.clone(),
    scale: bone.scale.clone(),
  }));
  const restLengths = adapter.measureBoneLengths();
  const armMotion = new Map<string, number>();

  for (const clip of motionSet.clips) {
    let wristStart: Vector3 | null = null;
    let maxWristTravel = 0;
    for (const frame of clip.samples) {
      adapter.applyFrame(clip, frame);
      assert.ok(maxLengthError(restLengths, adapter.measureBoneLengths()) < 1e-9, `${clip.id}: GLB bone length changed`);
      const wrist = adapter.point('wrist_R');
      if (!wristStart) wristStart = wrist.clone();
      maxWristTravel = Math.max(maxWristTravel, wristStart.distanceTo(wrist));
    }
    armMotion.set(clip.id, maxWristTravel);
  }
  assert.ok((armMotion.get('single-elbow') ?? 0) > 0.1, 'actual GLB wrist did not follow single-elbow playback');
  assert.ok((armMotion.get('shoulder-elbow') ?? 0) > 0.3, 'actual GLB wrist did not follow shoulder-elbow playback');
  adapter.reset();

  for (const { name, position, quaternion, scale } of bindPose) {
    const bone = adapter.bone(name);
    assert.ok(bone.position.distanceTo(position) < 1e-12, `${name} GLB bind position changed`);
    assert.ok(1 - Math.abs(bone.quaternion.dot(quaternion)) < 1e-12, `${name} GLB bind rotation changed`);
    assert.ok(bone.scale.distanceTo(scale) < 1e-12, `${name} GLB bone scale changed`);
  }
  for (const saved of savedSkinData) {
    assert.deepEqual(Array.from(saved.mesh.geometry.getAttribute('skinIndex').array), saved.indices);
    assert.deepEqual(Array.from(saved.mesh.geometry.getAttribute('skinWeight').array), saved.weights);
    assert.ok(saved.mesh.bindMatrix.equals(saved.bindMatrix));
    assert.ok(saved.mesh.bindMatrixInverse.equals(saved.bindMatrixInverse));
    assert.ok(saved.mesh.skeleton.boneInverses.every((matrix, index) => matrix.equals(saved.boneInverses[index])));
  }
});

test('web viewer and avatar adapter stay independent from the simulator modules', () => {
  const appSource = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
  const adapterSource = readFileSync(fileURLToPath(new URL('../web/avatar/avatar-adapter.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(appSource, /from\s+['"].*(?:src\/|@mujoco)/);
  assert.doesNotMatch(adapterSource, /from\s+['"].*(?:src\/|@mujoco)/);
});
