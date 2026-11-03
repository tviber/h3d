import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createMuscleSystem, evaluateMuscles, forceVelocityCurve } from '../src/muscle-model.ts';
import { loadMuscleExperiments } from '../src/muscle-experiment.ts';
import { advanceActivations, desiredActivations, sampleTrajectory, solveMuscleActivations, type MuscleController } from '../src/motor-control.ts';
import { simulateMuscleExperiment, stanceBiasTorques, summarizeMuscleRun } from '../src/muscle-simulate.ts';
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
  it('keeps the force-velocity curve continuous, monotone, and bounded through eccentric speeds', () => {
    const velocities = [-10, -1, -0.5, -1e-6, 0, 1e-6, 1.49, 1.5, 1.51, 5, 100];
    const factors = velocities.map(forceVelocityCurve);
    assert.equal(forceVelocityCurve(-1), 0);
    assert.equal(forceVelocityCurve(0), 1);
    assert.ok(forceVelocityCurve(1.5) > 1.6 && forceVelocityCurve(1.5) < 1.8);
    assert.ok(factors.every((factor) => factor >= 0 && factor <= 1.8));
    for (let i = 1; i < factors.length; i++) assert.ok(factors[i] >= factors[i - 1], 'force must not decrease as lengthening speed rises');
    const h = 1e-7;
    const slopeLeft = (forceVelocityCurve(0) - forceVelocityCurve(-h)) / h;
    const slopeRight = (forceVelocityCurve(h) - forceVelocityCurve(0)) / h;
    assert.ok(Math.abs(slopeLeft - slopeRight) < 1e-5, 'the branches should have matching derivatives at zero velocity');
    assert.throws(() => forceVelocityCurve(Number.NaN), /must be finite/);
  });

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

describe('Single-elbow analytical benchmark', async () => {
  const mj = await getMujoco();

  it('matches finite-difference moment arms across elbow and wrap ranges', () => {
    for (const id of ['single-elbow', 'shoulder-elbow']) {
      const experiment = loadMuscleExperiments(CONFIG, [id])[0];
      const model = loadModel(mj, experiment.modelPath), data = new mj.MjData(model);
      try {
        const system = createMuscleSystem(mj, model, experiment.muscles);
        const elbowId = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, 'elbow_flex');
        const qadr = model.jnt_qposadr[elbowId], dof = model.jnt_dofadr[elbowId], epsilon = 1e-6;
        for (const [name, value] of Object.entries(experiment.initialPoseRad)) {
          const jointId = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, name);
          data.qpos[model.jnt_qposadr[jointId]] = value;
        }
        let maximumError = 0;
        let previousBrachialisLength = 0;
        for (let angle = 0.05; angle <= 2.5; angle += 0.05) {
          data.qpos[qadr] = angle;
          mj.mj_forward(model, data);
          const states = evaluateMuscles(system, data, new Float64Array(experiment.muscles.length).fill(0.5)).states;
          const plus = new Float64Array(system.tendonIds.length), minus = new Float64Array(system.tendonIds.length);
          data.qpos[qadr] = angle + epsilon;
          mj.mj_forward(model, data);
          system.tendonIds.forEach((id, i) => { plus[i] = data.ten_length[id]; });
          data.qpos[qadr] = angle - epsilon;
          mj.mj_forward(model, data);
          system.tendonIds.forEach((id, i) => { minus[i] = data.ten_length[id]; });
          data.qpos[qadr] = angle;
          mj.mj_forward(model, data);
          for (let i = 0; i < states.length; i++) {
            const finiteDifference = -(plus[i] - minus[i]) / (2 * epsilon);
            maximumError = Math.max(maximumError, Math.abs(finiteDifference - states[i].momentArms[dof]));
          }
          if (id === 'shoulder-elbow') {
            const brachialis = experiment.muscles.findIndex((muscle) => muscle.name === 'brachialis');
            const length = data.ten_length[system.tendonIds[brachialis]];
            if (angle > 2.45) assert.ok(Math.abs(length - previousBrachialisLength) < 0.002, 'brachialis path must stay continuous near full elbow flexion');
            previousBrachialisLength = length;
          }
        }
        assert.ok(maximumError < 1e-6, `${id} maximum moment-arm FD error: ${maximumError}`);
      } finally { data.delete(); model.delete(); }
    }
  });

  it('matches an independent rigid-body elbow acceleration calculation', () => {
    const experiment = loadMuscleExperiments(CONFIG, ['single-elbow'])[0];
    const model = loadModel(mj, experiment.modelPath), data = new mj.MjData(model);
    try {
      const system = createMuscleSystem(mj, model, experiment.muscles);
      const jointId = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, 'elbow_flex');
      const dof = model.jnt_dofadr[jointId], qadr = model.jnt_qposadr[jointId];
      const forearmId = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, 'forearm');
      data.qpos[qadr] = 0.82;
      data.qvel[dof] = 1.1;
      mj.mj_forward(model, data);
      const evaluated = evaluateMuscles(system, data, [0.65, 0.12]);
      const requestedTorque = evaluated.jointTorques[dof];
      const gear = model.actuator_gear[0];
      assert.ok(Math.abs(requestedTorque) < gear);
      data.ctrl[0] = requestedTorque / gear;
      mj.mj_forward(model, data);
      const com = model.body_ipos.slice(forearmId * 3, forearmId * 3 + 3);
      const effectiveInertia = model.body_inertia[forearmId * 3 + 2]
        + model.body_mass[forearmId] * (com[0] ** 2 + com[1] ** 2)
        + model.dof_armature[dof];
      const analyticalAcceleration = (
        data.qfrc_actuator[dof] + data.qfrc_passive[dof] + data.qfrc_constraint[dof] - data.qfrc_bias[dof]
      ) / effectiveInertia;
      assert.ok(Math.abs(data.qacc[dof] - analyticalAcceleration) < 1e-9);
    } finally { data.delete(); model.delete(); }
  });

  it('checks muscle work, actuator work, damping, limits, and energy over the full elbow trajectory', async () => {
    const { experiment, recording } = await runExperiment('single-elbow');
    const summary = summarizeMuscleRun(experiment, recording);
    const joint = 'elbow_flex';
    const trapPower = (prefix: string) => {
      const torque = recording.jointColumns.get(`${prefix}_${joint}`)!;
      const velocity = recording.jointColumns.get(`velocity_${joint}`)!;
      let sum = 0;
      for (let k = 0; k < recording.n - 1; k++) {
        const a = torque[k] * velocity[k], b = torque[k + 1] * velocity[k + 1];
        sum += 0.5 * (a + b) * (recording.times[k + 1] - recording.times[k]);
      }
      return sum;
    };
    const muscleWork = recording.muscles.reduce((sum, name) => sum + recording.muscleColumns.get(`work_${name}`)!.at(-1)!, 0);
    const actuatorWork = recording.jointColumns.get(`work_${joint}`)!.at(-1)!;
    const passiveWork = trapPower('passive_torque');
    const limitWork = trapPower('constraint_torque');
    const deltaEnergy = recording.kineticEnergy.at(-1)! - recording.kineticEnergy[0]
      + recording.potentialEnergy.at(-1)! - recording.potentialEnergy[0];
    const energyResidual = Math.abs(actuatorWork + passiveWork + limitWork - deltaEnergy);
    assert.ok(Math.abs(muscleWork - actuatorWork) / Math.max(1, Math.abs(actuatorWork)) < 0.002);
    assert.ok(energyResidual / Math.max(1, Math.abs(actuatorWork)) < 0.02);
    assert.ok(summary.validation.momentArmFdMaxAbsErr < 1e-6);
    assert.ok(summary.validation.torqueMatchMaxAbsErr < 1e-9);
    assert.ok(summary.validation.workConsistencyRelErr < 1e-10);
    assert.equal(summary.validation.trajectoryFinite, true);
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
  const mj = await getMujoco();
  it('projects model bias through ideal support and scales with model mass', () => {
    const experiment = loadMuscleExperiments(CONFIG, ['squat-to-stand'])[0];
    const makeModel = () => loadModel(mj, experiment.modelPath);
    const pose = { ...experiment.initialPoseRad, trunk_ext: 0 };
    const model = makeModel(), data = new mj.MjData(model);
    try {
      const joints = new Map(Array.from({ length: model.njnt }, (_, i) => [mj.mj_id2name(model, mj.mjtObj.mjOBJ_JOINT.value, i), i]));
      for (const [name, value] of Object.entries(pose)) data.qpos[model.jnt_qposadr[joints.get(name)!]] = value;
      mj.mj_forward(model, data);
      const actuatedDofs = new Set<number>();
      for (let actuator = 0; actuator < model.nu; actuator++) actuatedDofs.add(model.jnt_dofadr[model.actuator_trnid[actuator * 2]]);
      const unactuated = Array.from({ length: model.nv }, (_, dof) => dof).filter((dof) => !actuatedDofs.has(dof));
      const foot = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, 'foot');
      const biasMinusPassive = Float64Array.from({ length: model.nv }, (_, dof) => data.qfrc_bias[dof] - data.qfrc_passive[dof]);
      const torques = stanceBiasTorques(mj, model, data, foot, unactuated);
      for (const name of ['hip_ext', 'knee_ext', 'ankle_pf']) assert.ok(torques[model.jnt_dofadr[joints.get(name)!]] > 0, `${name} must oppose gravity in the squat pose`);

      const reaction = Float64Array.from(biasMinusPassive, (value, dof) => value - torques[dof]);
      const floor = mj.mj_name2id(model, mj.mjtObj.mjOBJ_GEOM.value, 'floor');
      model.geom_contype[floor] = 0;
      model.geom_conaffinity[floor] = 0;
      data.qfrc_applied.set(reaction);
      for (let actuator = 0; actuator < model.nu; actuator++) {
        const dof = model.jnt_dofadr[model.actuator_trnid[actuator * 2]], gear = model.actuator_gear[actuator * 6];
        data.ctrl[actuator] = torques[dof] / gear;
      }
      mj.mj_forward(model, data);
      assert.ok(Array.from(data.qacc as ArrayLike<number>).every((acceleration: number) => Math.abs(acceleration) < 1e-8), 'projected support reaction should balance the static pose');
      const unsupported = stanceBiasTorques(mj, model, data, -1, []);
      for (let dof = 0; dof < model.nv; dof++) assert.ok(Math.abs(unsupported[dof] - (data.qfrc_bias[dof] - data.qfrc_passive[dof])) < 1e-10);
    } finally { data.delete(); model.delete(); }

    const scaledModel = makeModel(), scaledData = new mj.MjData(scaledModel);
    try {
      const joints = new Map(Array.from({ length: scaledModel.njnt }, (_, i) => [mj.mj_id2name(scaledModel, mj.mjtObj.mjOBJ_JOINT.value, i), i]));
      const initialize = () => {
        mj.mj_resetData(scaledModel, scaledData);
        for (const [name, value] of Object.entries(pose)) scaledData.qpos[scaledModel.jnt_qposadr[joints.get(name)!]] = value;
        mj.mj_forward(scaledModel, scaledData);
      };
      initialize();
      const foot = mj.mj_name2id(scaledModel, mj.mjtObj.mjOBJ_BODY.value, 'foot');
      const actuatedDofs = new Set<number>();
      for (let actuator = 0; actuator < scaledModel.nu; actuator++) actuatedDofs.add(scaledModel.jnt_dofadr[scaledModel.actuator_trnid[actuator * 2]]);
      const unactuated = Array.from({ length: scaledModel.nv }, (_, dof) => dof).filter((dof) => !actuatedDofs.has(dof));
      const base = stanceBiasTorques(mj, scaledModel, scaledData, foot, unactuated);
      mj.mj_setTotalmass(scaledModel, mj.mj_getTotalmass(scaledModel) * 1.25);
      mj.mj_setConst(scaledModel, scaledData);
      initialize();
      const scaled = stanceBiasTorques(mj, scaledModel, scaledData, foot, unactuated);
      for (let dof = 0; dof < scaledModel.nv; dof++) {
        if (Math.abs(base[dof]) > 1e-9) assert.ok(Math.abs(scaled[dof] - 1.25 * base[dof]) < 1e-8);
      }
    } finally { scaledData.delete(); scaledModel.delete(); }
  });

  it('records saturation and the requested-to-applied torque error', () => {
    const experiment = loadMuscleExperiments(CONFIG, ['single-elbow'])[0];
    const model = loadModel(mj, experiment.modelPath);
    model.actuator_gear[0] = 1;
    try {
      const recording = simulateMuscleExperiment(mj, model, experiment);
      const summary = summarizeMuscleRun(experiment, recording);
      const joint = summary.joints.find((item) => item.name === 'elbow_flex')!;
      const requested = recording.jointColumns.get('requested_torque_elbow_flex')!;
      const applied = recording.jointColumns.get('torque_elbow_flex')!;
      const ratio = recording.jointColumns.get('saturation_ratio_elbow_flex')!;
      assert.equal(joint.saturated, true);
      assert.ok(joint.peakSaturationRatio > 1);
      assert.ok(joint.peakRequestedTorque > joint.peakAppliedTorque);
      assert.ok(joint.maxTorqueTrackingError > 0);
      for (let k = 0; k < recording.n; k++) {
        assert.ok(Math.abs(applied[k]) <= 1 + 1e-9);
        if (ratio[k] <= 1 + 1e-9) assert.ok(Math.abs(applied[k] - requested[k]) < 1e-9);
      }
      assert.ok(summary.validation.torqueMatchMaxAbsErr > 1);
    } finally { model.delete(); }
  });

  it('keeps lower-body control finite under mass and initial-pose perturbations', () => {
    const base = loadMuscleExperiments(CONFIG, ['squat-to-stand'])[0];
    for (const variant of ['mass', 'pose'] as const) {
      const experiment = structuredClone(base);
      if (variant === 'pose') {
        experiment.initialPoseRad.hip_ext += 0.05;
        experiment.initialPoseRad.knee_ext += 0.05;
        experiment.initialPoseRad.ankle_pf += 0.04;
      }
      const model = loadModel(mj, experiment.modelPath);
      if (variant === 'mass') {
        const data = new mj.MjData(model);
        try {
          mj.mj_setTotalmass(model, mj.mj_getTotalmass(model) * 1.25);
          mj.mj_setConst(model, data);
        } finally { data.delete(); }
      }
      try {
        const recording = simulateMuscleExperiment(mj, model, experiment);
        const summary = summarizeMuscleRun(experiment, recording);
        assert.equal(summary.validation.trajectoryFinite, true, `${variant} perturbation must remain physically finite`);
        assert.ok(recording.positions.get('pelvis')![2].at(-1)! > 0.88, `${variant} perturbation should recover upright support`);
        assert.ok(summary.joints.every((joint) => !joint.saturated), `${variant} perturbation should remain within actuator capacity`);
      } finally { model.delete(); }
    }
  });

  it('reports unsaturated torque transfer and finite physics checks for all baseline experiments', async () => {
    for (const configured of loadMuscleExperiments(CONFIG)) {
      const result = configured.id === 'squat-to-stand' ? await lowerRun() : await runExperiment(configured.id);
      const summary = summarizeMuscleRun(result.experiment, result.recording);
      assert.ok(summary.joints.every((joint) => !joint.saturated), `${configured.id} should stay within motor capacity`);
      assert.ok(summary.joints.every((joint) => joint.maxTorqueTrackingError < 1e-9), `${configured.id} requested and applied torque should match`);
      assert.ok(summary.validation.momentArmFdMaxAbsErr < 1e-6, `${configured.id} moment arms should match finite differences`);
      assert.ok(summary.validation.torqueMatchMaxAbsErr < 1e-9, `${configured.id} should not clip motor torque`);
      assert.ok(summary.validation.workConsistencyRelErr < 1e-10, `${configured.id} muscle and joint power integrals should match`);
      assert.equal(summary.validation.trajectoryFinite, true, `${configured.id} should remain finite and in range`);
    }
  });

  it('integrates muscle forces with unactuated floating-base DOFs and physical ground reaction forces', async () => {
    const { experiment, recording } = await lowerRun();
    const summary = summarizeMuscleRun(experiment, recording);
    assert.equal(recording.n, Math.round(recording.duration / recording.dt) + 1);
    assert.equal(recording.times.at(-1), recording.duration);
    assertFiniteContactRecording(recording);
    assert.ok(summary.validation.momentArmFdMaxAbsErr < 1e-6);
    assert.ok(summary.validation.torqueMatchMaxAbsErr < 1e-9);
    assert.ok(summary.validation.workConsistencyRelErr < 1e-10);
    assert.equal(summary.validation.trajectoryFinite, true);
    assert.ok(summary.joints.every((joint) => !joint.saturated));
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
    const coreModules = ['mujoco.ts', 'muscle-model.ts', 'motor-control.ts', 'muscle-experiment.ts', 'muscle-simulate.ts'];
    const peripheralImport = /(^|\/)(control|experiment|simulate|analysis|report|charts|motion-clip|web-server|plot)(\.ts|\/|$)/;
    for (const moduleName of coreModules) {
      const file = `${ROOT}/src/${moduleName}`, source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(imports)) assert.doesNotMatch(match[1], peripheralImport, `${moduleName} imports an A/B/C or viewer module`);
      assert.doesNotMatch(source, /from\s*['"][^'"]*web\//, `${moduleName} imports viewer code`);
    }
    const viewer = readFileSync(`${ROOT}/web/app.js`, 'utf8');
    assert.doesNotMatch(viewer, /from\s*['"][^'"]*src\//);
    assert.match(viewer, /demo-motion\.json/);
  });
});
