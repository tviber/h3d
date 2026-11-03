import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createMuscleSystem, evaluateMuscles } from '../src/muscle-model.ts';
import { loadMuscleExperiments } from '../src/muscle-experiment.ts';
import { advanceActivations, desiredActivations, sampleTrajectory, solveMuscleActivations, type MuscleController } from '../src/motor-control.ts';
import { simulateMuscleExperiment } from '../src/muscle-simulate.ts';
import { toMotionClip } from '../src/motion-clip.ts';
import { getMujoco, loadModel } from '../src/mujoco.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = fileURLToPath(new URL('../experiments/muscle-demo.json', import.meta.url));
async function runExperiment(id: string) {
  const mj = await getMujoco();
  const experiment = loadMuscleExperiments(CONFIG, [id])[0];
  const model = loadModel(mj, experiment.modelPath);
  try { return { experiment, recording: simulateMuscleExperiment(mj, model, experiment) }; }
  finally { model.delete(); }
}
let lowerRunPromise: ReturnType<typeof runExperiment> | undefined;
function lowerRun() { lowerRunPromise ??= runExperiment('squat-to-stand'); return lowerRunPromise; }
function assertFiniteContactRecording(recording: Awaited<ReturnType<typeof runExperiment>>['recording']) {
  for (const axis of recording.grf) assert.ok(Array.from(axis).every(Number.isFinite), 'GRF samples must be finite');
  for (const axis of recording.centerOfPressure) assert.ok(Array.from(axis).every(Number.isFinite), 'COP samples must be finite');
  for (const foot of recording.feet.values()) {
    for (const axis of foot) assert.ok(Array.from(axis).every(Number.isFinite), 'foot force samples must be finite');
  }
  for (const frame of recording.contacts) {
    for (const contact of frame) {
      assert.ok(contact.position.every(Number.isFinite), 'contact positions must be finite');
      assert.ok(contact.force.every(Number.isFinite), 'contact forces must be finite');
    }
  }
}

describe('Musculoskeletal Model', async () => {
  const mj = await getMujoco();
  it('computes opposing elbow moment arms and activation-dependent muscle force', () => {
    const model = loadModel(mj, fileURLToPath(new URL('../models/muscle_elbow.xml', import.meta.url)));
    const data = new mj.MjData(model);
    try {
      mj.mj_forward(model, data);
      const definitions = loadMuscleExperiments(CONFIG, ['single-elbow'])[0].muscles;
      const system = createMuscleSystem(mj, model, definitions);
      const relaxed = evaluateMuscles(system, data, [0, 0]);
      const active = evaluateMuscles(system, data, [0.8, 0]);
      assert.equal(system.dofCount, model.nv);
      assert.ok(relaxed.states.every((state) => state.force >= 0 && Number.isFinite(state.force)));
      assert.ok(active.states[0].force > relaxed.states[0].force);
      assert.ok(active.states[0].momentArms[0] * active.states[1].momentArms[0] < 0, 'biceps and triceps should oppose each other');
      assert.ok(active.jointTorques[0] > relaxed.jointTorques[0]);
    } finally { data.delete(); model.delete(); }
  });

  it('supports the seven-DOF lower-body tendon model with sparse moment arms', () => {
    const experiment = loadMuscleExperiments(CONFIG, ['squat-to-stand'])[0];
    const model = loadModel(mj, experiment.modelPath), data = new mj.MjData(model);
    try {
      for (const [name, value] of Object.entries(experiment.initialPoseRad)) {
        const id = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, name);
        data.qpos[model.jnt_qposadr[id]] = value;
      }
      mj.mj_forward(model, data);
      const system = createMuscleSystem(mj, model, experiment.muscles);
      const result = evaluateMuscles(system, data, new Float64Array(experiment.muscles.length).fill(0.5));
      assert.equal(model.njnt, 7);
      assert.equal(model.nu, 4);
      assert.equal(result.jointTorques.length, 7);
      assert.equal(result.states.length, 10);
      assert.ok(result.states.some((state) => state.momentArms.some((arm) => Math.abs(arm) > 1e-5)));
      assert.ok(result.states.every((state) => Number.isFinite(state.tendonLength) && state.force >= 0));
    } finally { data.delete(); model.delete(); }
  });
});

describe('Motor Control', () => {
  it('combines baseline activation with bounded smooth open-loop pulses', () => {
    const controllers: MuscleController[] = [{ muscle: 'm', baseline: 0.1, pulses: [{ muscle: 'm', level: 0.5, start: 0.1, duration: 0.4, riseTime: 0.1 }] }];
    assert.equal(desiredActivations(controllers, ['m'], 0.1)[0], 0.1);
    assert.equal(desiredActivations(controllers, ['m'], 0.2)[0], 0.6);
    assert.equal(desiredActivations(controllers, ['m'], 0.5)[0], 0.1);
  });

  it('samples a smooth joint trajectory with zero endpoint velocity', () => {
    const controller = {
      type: 'trajectory' as const,
      keyframes: [{ time: 0, joints: { knee: -1 } }, { time: 1, joints: { knee: 0 } }],
      gains: { knee: { kp: 100, kd: 10 } },
    };
    const start = sampleTrajectory(controller, 0), middle = sampleTrajectory(controller, 0.5), end = sampleTrajectory(controller, 1);
    assert.equal(start.positions.knee, -1);
    assert.equal(start.velocities.knee, 0);
    assert.ok(Math.abs(middle.positions.knee + 0.5) < 1e-12);
    assert.ok(middle.velocities.knee > 0);
    assert.equal(end.positions.knee, 0);
    assert.equal(end.velocities.knee, 0);
  });

  it('allocates bounded activations to a requested torque and advances activation dynamics', () => {
    const allocation = solveMuscleActivations({
      targetTorques: [5], passiveTorques: [0], dofs: [0], baseline: [0, 0],
      muscleBasis: [{ momentArms: [1], activeForce: 10 }, { momentArms: [-1], activeForce: 10 }],
      regularization: 0, iterations: 8,
    });
    assert.ok(Math.abs(allocation[0] - 0.5) < 1e-8);
    assert.equal(allocation[1], 0);
    const controllers: MuscleController[] = [{ muscle: 'm', baseline: 0, pulses: [] }];
    const next = advanceActivations([0], [1], controllers, [{ name: 'm', activationTimeConstant: 0.01, deactivationTimeConstant: 0.05 }], 0.005);
    assert.equal(next[0], 0.5);
  });
});

describe('Physics Simulation', async () => {
  it('integrates muscle forces with unactuated floating-base DOFs and physical ground reaction forces', async () => {
    const { recording } = await lowerRun();
    assert.equal(recording.n, Math.round(recording.duration / recording.dt) + 1);
    assert.equal(recording.times.at(-1), recording.duration);
    assertFiniteContactRecording(recording);
    assert.ok(recording.grf[2].some((value) => value > 0));
    assert.ok(recording.contactCount.some((count) => count === 4));
    assert.ok(recording.hasCenterOfPressure.some((has) => has === 1));
    assert.ok(recording.grf[2].at(-1)! > 550 && recording.grf[2].at(-1)! < 850, 'final support should be close to body weight');
    assert.ok(recording.com[2].at(-1)! > recording.com[2][0]);
    assert.ok(recording.positions.get('pelvis')![2].at(-1)! > 0.88);
    assert.ok(recording.wrapPaths.get('vasti')!.some((path) => path.length >= 2));
    assert.ok(recording.regionalPower.get('lower-body')!.some((power) => power !== 0));
  });

  it('records a countermovement and returns to supported upright height', async () => {
    const { recording } = await runExperiment('countermovement-drive');
    const pelvisZ = recording.positions.get('pelvis')![2];
    assert.ok(Math.min(...pelvisZ) < pelvisZ[0] - 0.05, 'the countermovement should lower the pelvis');
    assert.ok(pelvisZ.at(-1)! > pelvisZ[0] - 0.03, 'the drive should recover most of the pelvis height');
    assertFiniteContactRecording(recording);
    assert.ok(recording.grf[2].at(-1)! > 550 && recording.grf[2].at(-1)! < 850);
    assert.ok(recording.contactCount.at(-1)! >= 2);
    assert.equal(recording.times.at(-1), recording.duration);
  });
});

describe('MotionClip and frontend decoupling', async () => {
  it('exports the exact experiment endpoint and all independent viewer channels', async () => {
    const { experiment, recording } = await lowerRun();
    const clip = toMotionClip(experiment, recording);
    assert.equal(clip.schemaVersion, 'h3d.motion.v1');
    assert.equal(clip.rig.kind, 'lower-body');
    assert.equal(clip.samples.at(-1)?.time, clip.duration);
    assert.ok(clip.samples.some((sample) => sample.grf.force[2] > 0));
    assert.ok(clip.samples.some((sample) => sample.tendonPaths.vasti.length > 1));
    assert.ok(clip.samples.some((sample) => sample.contacts.length > 0));
    assert.ok(clip.samples.every((sample) => sample.com.length === 3));
    assert.deepEqual(clip.phases.map((phase) => phase.label), ['下蹲准备', '伸展起立', '站立稳定']);
  });

  it('keeps backend and viewer modules free of cross-imports', () => {
    const sourceFiles = readdirSync(`${ROOT}/src`, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
      ? readdirSync(`${ROOT}/src/${entry.name}`).filter((name) => name.endsWith('.ts')).map((name) => `${ROOT}/src/${entry.name}/${name}`)
      : entry.name.endsWith('.ts') ? [`${ROOT}/src/${entry.name}`] : []);
    const imports = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g;
    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(imports)) assert.doesNotMatch(match[1], /(^|\/)web(\/|$)/, `${file} imports frontend code`);
    }
    const viewer = readFileSync(`${ROOT}/web/app.js`, 'utf8');
    assert.doesNotMatch(viewer, /from\s*['"][^'"]*src\//);
    assert.match(viewer, /demo-motion\.json/);
  });
});
