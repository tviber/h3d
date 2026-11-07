import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Bone, BufferGeometry, Float32BufferAttribute, Group, MeshBasicMaterial, Quaternion, Skeleton, SkinnedMesh, Triangle, Uint16BufferAttribute, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { closestSegments, capsuleContact, projectOutsideCapsule, segmentTriangleContact } from '../web/avatar/collision-math.js';
import { validateCollisionConfig } from '../web/avatar/avatar-collision.js';
import { GarmentSolver, solveDistance } from '../web/avatar/cloth-solver.js';
import { HumanoidRetargeter, type RetargetCalibration } from '../web/avatar/humanoid-retargeter.js';
import { inspectHumanoid } from '../web/avatar/humanoid-inspector.js';
import { createBasicMotionClips } from '../web/avatar/basic-motions.js';

const v = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
const point = (b: Bone) => b.getWorldPosition(v());

function fixture() {
  const model = new Group(), roles = new Map<string, Bone>(), rest = new Map();
  function bone(name: string, parent: Group | Bone, p: Vector3) {
    const b = new Bone(); b.name = name; parent.add(b);
    model.updateMatrixWorld(true); b.position.copy(parent.worldToLocal(p.clone()));
    model.updateMatrixWorld(true); return b;
  }
  const pelvis = bone('Hips', model, v(0, .9)), spine = bone('Spine', pelvis, v(0, 1.1)), head = bone('Head', spine, v(0, 1.6));
  roles.set('pelvis', pelvis); roles.set('head', head);
  const chains: any = {};
  for (const side of ['left', 'right']) {
    const s = side === 'left' ? 1 : -1;
    const upper = bone(`${side}Arm`, spine, v(s * .18, 1.4));
    const lower = bone(`${side}Forearm`, upper, v(s * .48, 1.4));
    const end = bone(`${side}Hand`, lower, v(s * .75, 1.4));
    const hip = bone(`${side}Thigh`, pelvis, v(s * .12, .9));
    const knee = bone(`${side}Shin`, hip, v(s * .12, .5));
    const foot = bone(`${side}Foot`, knee, v(s * .12, .08));
    for (const [role, b] of Object.entries({ upperArm: upper, forearm: lower, wrist: end })) roles.set(`${side}Arm.${role}`, b);
    for (const [role, b] of Object.entries({ upperLeg: hip, lowerLeg: knee, foot })) roles.set(`${side}Leg.${role}`, b);
    chains[`${side}Arm`] = { upper, lower, end, upperLength: .30, lowerLength: .27 };
    chains[`${side}Leg`] = { upper: hip, lower: knee, end: foot, upperLength: .40, lowerLength: .42 };
  }
  model.updateMatrixWorld(true);
  model.traverse(b => { if (b instanceof Bone) rest.set(b, { position: b.position.clone(), quaternion: b.quaternion.clone(), scale: b.scale.clone(), worldPosition: point(b), worldQuaternion: b.getWorldQuaternion(new Quaternion()) }); });
  const calibration: RetargetCalibration = { model, roles, rest, chains, pelvis, spine: [spine], neck: [], head, height: 1.8, groundY: 0, profile: { collision: { enabled: true } } };
  return new HumanoidRetargeter(calibration);
}

test('finite capsule contact handles crossing, parallel, tangent and point segments without NaNs', () => {
  const cross = closestSegments(v(-1), v(1), v(0, -1), v(0, 1));
  assert.ok(cross.a.length() < 1e-12 && cross.b.length() < 1e-12);
  const a = { a: v(), b: v(0, 1), radius: .1 };
  assert.equal(capsuleContact(a, { a: v(.2), b: v(.2, 1), radius: .1 }), null);
  assert.ok(Math.abs(capsuleContact(a, { a: v(.1), b: v(.1, 1), radius: .1 })!.depth - .1) < 1e-12);
  const p = v();
  assert.equal(projectOutsideCapsule(p, { a: v(), b: v(), radius: .2 }), .2);
  assert.ok(Math.abs(p.length() - .2) < 1e-12);
  const degenerate = capsuleContact({ a: v(), b: v(), radius: .1 }, { a: v(), b: v(), radius: .1 })!;
  assert.ok([...degenerate.normal].every(Number.isFinite));
  assert.ok(Math.abs(degenerate.normal.length() - 1) < 1e-12);
});

test('a capsule piercing a triangle is detected even when every triangle vertex and segment endpoint is outside', () => {
  const shape = new Triangle(v(-2, -2), v(2, -2), v(0, 2));
  const capsule = { a: v(0, 0, -1), b: v(0, 0, 1), radius: .1 };
  assert.ok([shape.a, shape.b, shape.c].every(p => projectOutsideCapsule(p.clone(), capsule) === 0));
  const contact = segmentTriangleContact(capsule, shape)!;
  assert.ok(Math.abs(contact.depth - .1) < 1e-12);
  assert.ok(Math.abs(contact.barycentric.x + contact.barycentric.y + contact.barycentric.z - 1) < 1e-12);
  assert.equal(segmentTriangleContact({ ...capsule, a: v(5, 0, -1), b: v(5, 0, 1) }, shape), null);
});

test('rigid joint projection removes a deliberate forearm/torso intersection without changing lengths, scales, or support feet', () => {
  const adapter = fixture();
  adapter.collision.enabled = false;
  adapter.stand();
  const arm = adapter.chains.rightArm;
  // Deliberately swing the forearm through the abdomen, independently of the solver.
  (adapter as any).aim(arm.upper, arm.lower, v(0, -1));
  (adapter as any).aim(arm.lower, arm.end, v(1, -.1));
  const lengths = adapter.measureBoneLengths();
  const feet = [point(adapter.chains.leftLeg.end), point(adapter.chains.rightLeg.end)];
  const local = [...adapter.rest].map(([b]) => [b, b.position.clone(), b.scale.clone()] as const);
  adapter.collision.enabled = true;
  adapter.collision.resolveRigid();
  const d = adapter.collision.diagnostics;
  assert.ok(d.contactsBefore > 0 && d.maxPenetrationBefore > .01);
  assert.ok(d.maxPenetration < d.maxPenetrationBefore * .15, JSON.stringify(d));
  assert.ok(d.maxCorrectionDegrees <= 35 + 1e-6);
  for (const [name, length] of Object.entries(lengths)) assert.ok(Math.abs(adapter.measureBoneLengths()[name] - length) < 1e-10);
  for (const [b, p, s] of local) { assert.ok(b.position.distanceTo(p) < 1e-12); assert.ok(b.scale.distanceTo(s) < 1e-12); }
  assert.ok(point(adapter.chains.leftLeg.end).distanceTo(feet[0]) < 1e-8);
  assert.ok(point(adapter.chains.rightLeg.end).distanceTo(feet[1]) < 1e-8);
});

test('infeasible contacts are reported under a bounded correction budget', () => {
  const adapter = fixture();
  adapter.collision.maxCorrection = Math.PI / 180;
  adapter.collision.enabled = false; adapter.stand();
  const arm = adapter.chains.rightArm;
  (adapter as any).aim(arm.upper, arm.lower, v(0, -1));
  (adapter as any).aim(arm.lower, arm.end, v(1, -.1));
  adapter.collision.enabled = true; adapter.collision.resolveRigid();
  assert.ok(adapter.collision.diagnostics.maxPenetration > .005);
  assert.ok(adapter.collision.diagnostics.unresolvedPairs!.length > 0);
  assert.ok(adapter.collision.diagnostics.maxCorrectionDegrees <= 1 + 1e-6);
});

test('XPBD compliance controls stretch while fixed attachments remain fixed', () => {
  const anchor = { position: v(), invMass: 0 }, rigid = { position: v(2), invMass: 1 }, soft = { position: v(2), invMass: 1 };
  solveDistance(anchor, rigid, 1, 0);
  solveDistance(anchor, soft, 1, .001);
  assert.deepEqual(anchor.position.toArray(), [0, 0, 0]);
  assert.ok(Math.abs(rigid.position.x - 1) < 1e-12);
  assert.ok(soft.position.x > rigid.position.x && soft.position.x < 2);
});

test('flexible cloth bends around a volume, preserves fixed stitches and source geometry, restores visibility, and disposes its proxy', () => {
  const adapter = fixture(), geometry = new BufferGeometry();
  const vertices: number[] = [], indices: number[] = [], skin: number[] = [], weights: number[] = [];
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) {
    vertices.push((x - 2) * .1, .8 + y * .1, 0);
    skin.push(0, 0, 0, 0); weights.push(1, 0, 0, 0);
    if (x && y) { const k = y * 5 + x; indices.push(k - 6, k - 5, k, k - 6, k, k - 1); }
  }
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skin, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4)); geometry.setIndex(indices);
  const source = new SkinnedMesh(geometry, new MeshBasicMaterial()); source.name = 'test-coat';
  adapter.model.add(source); adapter.model.updateMatrixWorld(true); source.bind(new Skeleton([adapter.calibration.pelvis]));
  const solver = new GarmentSolver(adapter.calibration, [{ mesh: source.name, pin: { top: .1 } }]);
  const capsule = { a: v(0, .87, -.035), b: v(0, .97, -.035), radius: .08 };
  solver.setEnabled(true);
  const d = solver.solve([capsule]);
  assert.ok(d.bodyContacts > 0);
  assert.ok(d.maxDisplacement > .015 && d.maxDisplacement < .2);
  assert.ok(d.maxVertexPenetration < .003, JSON.stringify(d));
  for (const p of solver.particles.filter(p => !p.invMass)) assert.ok(p.position.distanceTo(p.target) < 1e-12);
  assert.deepEqual(Array.from(geometry.getAttribute('position').array), Array.from(new Float32Array(vertices)));
  const first = solver.particles.map(p => p.position.toArray()); solver.solve([capsule]);
  assert.deepEqual(solver.particles.map(p => p.position.toArray()), first);
  assert.equal(source.visible, false); assert.equal(solver.garments[0].proxy.visible, true);
  solver.setEnabled(false); assert.equal(source.visible, true); assert.equal(solver.garments[0].proxy.visible, false);
  const proxy = solver.garments[0].proxy; solver.dispose(); assert.equal(proxy.parent, null);
});

test('collision profiles reject unsupported or invalid radii, material compliance, and ambiguous garment configuration', () => {
  for (const invalid of [null, { enabled: 'yes' }, { radii: { torso: NaN } }, { radii: { finger: .02 } }, { maxCorrectionDegrees: 100 },
    { garments: [{ mesh: 'coat', pin: { top: .2, nearRole: 'head', radius: .1 } }] },
    { garments: [{ mesh: 'coat', pin: { top: .2 }, stretchCompliance: -1 }] },
    { garments: [{ mesh: 'coat', pin: { alongChain: 'spine', fraction: .1 } }] }]) {
    assert.throws(() => validateCollisionConfig(invalid as any));
  }
  const adapter = fixture();
  assert.throws(() => new GarmentSolver(adapter.calibration, [{ mesh: 'missing', pin: { top: .1 } }]), /exactly one/);
});

const localModel = new URL('../web/models/local/tanjiro-v3.glb', import.meta.url);
test('actual Tanjiro exercises all nine clips with deterministic seeks, immutable asset/skin/source motion and optional cloth', { skip: !existsSync(localModel) }, async () => {
  const bytes = readFileSync(localModel), digest = createHash('sha256').update(bytes).digest('hex');
  const profile = JSON.parse(readFileSync(new URL('../web/models/local/tanjiro-v3.profile.json', import.meta.url), 'utf8'));
  assert.equal(profile.asset.sha256, digest);
  // Skip texture decoding in Node only; geometry/skin/normal GLTF parsing is real.
  const loader = new GLTFLoader().register(() => ({ name: 'headless-textures', loadTexture: () => Promise.resolve(null) } as any));
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const inspection = inspectHumanoid(gltf.scene, profile);
  const original: any[] = [];
  inspection.model.traverse((mesh: any) => {
    if (mesh.isSkinnedMesh) original.push({ mesh, geometry: mesh.geometry, material: mesh.material, positions: Array.from(mesh.geometry.attributes.position.array),
      skin: Array.from(mesh.geometry.attributes.skinIndex.array), weights: Array.from(mesh.geometry.attributes.skinWeight.array), inverses: mesh.skeleton.boneInverses.map((m: any) => m.toArray()) });
  });
  const adapter = new HumanoidRetargeter(inspection), lengths = adapter.measureBoneLengths();
  const clips = [...JSON.parse(readFileSync(new URL('../web/demo-motion.json', import.meta.url), 'utf8')).clips, ...createBasicMotionClips()];
  const motionSnapshot = JSON.stringify(clips);
  for (const clip of clips) {
    const frame = clip.samples[Math.floor(clip.samples.length * .5)];
    adapter.applyFrame(clip, frame);
    const first = adapter.collision.garments.particles.map(p => p.position.toArray());
    assert.ok(adapter.collision.diagnostics.maxPenetration < .002, `${clip.id}: rigid residual`);
    const d = adapter.collision.diagnostics.cloth!;
    assert.equal(d.particles, 993); assert.ok(d.bodyContacts > 0);
    assert.ok(Object.values(d).filter(v => typeof v === 'number').every(Number.isFinite));
    assert.ok(d.maxPenetration >= d.maxVertexPenetration && d.maxPenetration >= d.maxSurfacePenetration && d.maxPenetration >= d.pinnedPenetration);
    for (const p of adapter.collision.garments.particles) assert.ok([...p.position].every(Number.isFinite));
    for (const [name, length] of Object.entries(lengths)) assert.ok(Math.abs(adapter.measureBoneLengths()[name] - length) < 5e-7);
    for (const [b, bind] of adapter.rest) assert.ok(b.scale.distanceTo(bind.scale) < 1e-12);
    const feet = [point(adapter.chains.leftLeg.end), point(adapter.chains.rightLeg.end)];
    adapter.collision.enabled = false; adapter.applyFrame(clip, frame);
    assert.ok(point(adapter.chains.leftLeg.end).distanceTo(feet[0]) < 1e-5);
    assert.ok(point(adapter.chains.rightLeg.end).distanceTo(feet[1]) < 1e-5);
    adapter.collision.enabled = true; adapter.applyFrame(clip, clip.samples.at(-1));
    adapter.applyFrame(clip, frame);
    assert.deepEqual(adapter.collision.garments.particles.map(p => p.position.toArray()), first, `${clip.id}: seek must be history independent`);
    adapter.collision.clothEnabled = false; adapter.applyFrame(clip, frame);
    assert.equal(adapter.collision.diagnostics.cloth, null);
    assert.ok(adapter.collision.garments.garments.every(g => g.source.visible && !g.proxy.visible));
    adapter.collision.clothEnabled = true;
  }
  // Off-centre torso turns exposed a contact-direction failure in the first
  // implementation. Infeasible cloth must report residual, never stretch 12x.
  const turn = clips.find((c: any) => c.id === 'standing-turn');
  adapter.applyFrame(turn, turn.samples[Math.round((turn.samples.length - 1) * .25)]);
  assert.ok(adapter.collision.diagnostics.cloth!.maxStretchRatio <= 1.5 + 1e-6);
  assert.ok(adapter.collision.diagnostics.cloth!.maxDisplacement <= inspection.height * .06 + 1e-8);
  assert.ok(adapter.collision.diagnostics.cloth!.limitedGarments > 0);
  for (const saved of original) {
    assert.equal(saved.mesh.geometry, saved.geometry); assert.equal(saved.mesh.material, saved.material);
    assert.deepEqual(Array.from(saved.geometry.attributes.position.array), saved.positions);
    assert.deepEqual(Array.from(saved.geometry.attributes.skinIndex.array), saved.skin);
    assert.deepEqual(Array.from(saved.geometry.attributes.skinWeight.array), saved.weights);
    assert.deepEqual(saved.mesh.skeleton.boneInverses.map((m: any) => m.toArray()), saved.inverses);
  }
  assert.equal(JSON.stringify(clips), motionSnapshot);
  assert.equal(createHash('sha256').update(readFileSync(localModel)).digest('hex'), digest);
  adapter.collision.dispose();
});
