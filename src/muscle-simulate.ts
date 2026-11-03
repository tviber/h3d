import { type MuscleExperiment } from './muscle-experiment.ts';
import { advanceActivations, desiredActivations, sampleTrajectory, solveMuscleActivations } from './motor-control.ts';
import { createMuscleSystem, evaluateMuscles, type MuscleState } from './muscle-model.ts';
import { type MjModel, type Mujoco } from './mujoco.ts';

export type Vec3 = [number, number, number];
export interface GroundContact { name: string; position: Vec3; force: Vec3 }
export interface MuscleRecording {
  dt: number;
  duration: number;
  n: number;
  times: Float64Array;
  joints: string[];
  jointTypes: Record<string, 'hinge' | 'slide'>;
  muscles: string[];
  positions: Map<string, [Float64Array, Float64Array, Float64Array]>;
  com: [Float64Array, Float64Array, Float64Array];
  jointColumns: Map<string, Float64Array>;
  muscleColumns: Map<string, Float64Array>;
  regionalPower: Map<'lower-body' | 'trunk' | 'upper-body', Float64Array>;
  grf: [Float64Array, Float64Array, Float64Array];
  centerOfPressure: [Float64Array, Float64Array, Float64Array];
  hasCenterOfPressure: Uint8Array;
  contactCount: Uint16Array;
  feet: Map<'left' | 'right', [Float64Array, Float64Array, Float64Array]>;
  contacts: GroundContact[][];
  wrapPaths: Map<string, Array<Vec3[]>>;
}
export interface MuscleRunSummary {
  duration: number;
  dt: number;
  peakGroundReactionForce: number;
  peakVerticalGroundReactionForce: number;
  joints: { name: string; peakAngleRad: number; peakSpeed: number; peakTorque: number }[];
  muscles: { name: string; peakActivation: number; peakForce: number }[];
}
export interface MuscleRun { experiment: MuscleExperiment; recording: MuscleRecording; summary: MuscleRunSummary }

const SITE_NAMES = [
  'shoulder', 'elbow', 'wrist', 'pelvis', 'waist', 'neck', 'head',
  'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'leftHand', 'rightHand',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle', 'leftHeel', 'rightHeel', 'leftToe', 'rightToe',
] as const;
const MUSCLE_FIELDS = ['activation', 'excitation', 'force', 'active_force', 'passive_force', 'length', 'velocity'] as const;
const REGIONS = ['lower-body', 'trunk', 'upper-body'] as const;

function actuatorsByJoint(mj: Mujoco, model: MjModel, joints: readonly string[]) {
  const out = new Map<string, { actuator: number; dof: number; gear: number }>();
  for (let actuator = 0; actuator < model.nu; actuator++) {
    if (model.actuator_trntype[actuator] !== mj.mjtTrn.mjTRN_JOINT.value) continue;
    const jointId = model.actuator_trnid[actuator * 2];
    const name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_JOINT.value, jointId);
    if (joints.includes(name)) {
      if (out.has(name)) throw new Error(`more than one torque actuator drives "${name}"`);
      out.set(name, { actuator, dof: model.jnt_dofadr[jointId], gear: model.actuator_gear[actuator * 6] });
    }
  }
  return out;
}
function vector3(values: ArrayLike<number>, offset: number): Vec3 {
  return [values[offset], values[offset + 1], values[offset + 2]];
}
function captureContacts(
  mj: Mujoco,
  model: MjModel,
  data: Parameters<Mujoco['mj_contactForce']>[1],
  floorId: number,
  forceBuffer: { GetView(): Float64Array },
) {
  const total: Vec3 = [0, 0, 0], left: Vec3 = [0, 0, 0], right: Vec3 = [0, 0, 0];
  const contacts: GroundContact[] = [];
  let weightedX = 0, weightedY = 0, normalForceSum = 0;
  for (let i = 0; i < data.ncon; i++) {
    const contact = data.contact.get(i);
    if (!contact) continue;
    try {
      if (contact.geom1 !== floorId && contact.geom2 !== floorId) continue;
      // Contacts inside the solver margin can be listed without an active constraint.
      // mj_contactForce requires a valid constraint address; inactive contacts have -1.
      if (contact.efc_address < 0) continue;
      const sign = contact.geom1 === floorId ? 1 : -1;
      const geomId = contact.geom1 === floorId ? contact.geom2 : contact.geom1;
      const name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_GEOM.value, geomId) || `geom-${geomId}`;
      const frame = Array.from(contact.frame as ArrayLike<number>);
      const position = vector3(contact.pos as ArrayLike<number>, 0);
      mj.mj_contactForce(model, data, i, forceBuffer);
      // WASM memory growth detaches earlier typed-array views; reacquire after each call.
      const forceValues = forceBuffer.GetView();
      const local: Vec3 = [forceValues[0], forceValues[1], forceValues[2]];
      if (!local.every(Number.isFinite)) throw new Error(`non-finite contact force for ${name} at sample contact ${i}`);
      const world: Vec3 = [0, 0, 0];
      for (let axis = 0; axis < 3; axis++) {
        world[axis] = sign * (frame[axis] * local[0] + frame[3 + axis] * local[1] + frame[6 + axis] * local[2]);
        total[axis] += world[axis];
      }
      const foot = name.endsWith('_l') ? left : name.endsWith('_r') ? right : null;
      if (foot) for (let axis = 0; axis < 3; axis++) foot[axis] += world[axis];
      contacts.push({ name, position, force: world });
      if (world[2] > 0) {
        weightedX += position[0] * world[2];
        weightedY += position[1] * world[2];
        normalForceSum += world[2];
      }
    } finally {
      contact.delete();
    }
  }
  const cop: Vec3 | null = normalForceSum > 1e-8 ? [weightedX / normalForceSum, weightedY / normalForceSum, 0] : null;
  return { total, left, right, contacts, cop };
}
function wrapPath(data: Parameters<Mujoco['mj_forward']>[1], tendonId: number): Vec3[] {
  const start = data.ten_wrapadr[tendonId], count = data.ten_wrapnum[tendonId], points: Vec3[] = [];
  for (let i = 0; i < count; i++) points.push(vector3(data.wrap_xpos, (start + i) * 3));
  return points;
}
function validateJointTypes(mj: Mujoco, model: MjModel): void {
  if (model.nq !== model.nv) throw new Error('muscle experiments support hinge and slide joints only');
  for (let joint = 0; joint < model.njnt; joint++) {
    const type = model.jnt_type[joint];
    if (type !== mj.mjtJoint.mjJNT_HINGE.value && type !== mj.mjtJoint.mjJNT_SLIDE.value) {
      throw new Error(`muscle experiments do not support joint type ${type}`);
    }
  }
}

function feedbackTargets(
  mj: Mujoco,
  model: MjModel,
  data: Parameters<Mujoco['mj_forward']>[1],
  experiment: MuscleExperiment,
  joints: readonly string[],
  actuators: ReadonlyMap<string, { actuator: number; dof: number; gear: number }>,
  jointIds: ReadonlyMap<string, number>,
  siteIds: ReadonlyMap<string, number>,
  time: number,
  baseline: Float64Array,
  system: ReturnType<typeof createMuscleSystem>,
): Float64Array {
  const controller = experiment.feedback!;
  const reference = sampleTrajectory(controller, time);
  const targets = new Float64Array(system.dofCount);
  for (const joint of joints) {
    const actuator = actuators.get(joint), gains = controller.gains[joint], jointId = jointIds.get(joint);
    if (!actuator || !gains || jointId === undefined) continue;
    const q = data.qpos[model.jnt_qposadr[jointId]], dq = data.qvel[actuator.dof];
    const qTarget = reference.positions[joint] ?? q, dqTarget = reference.velocities[joint] ?? 0;
    let gravityTorque = data.qfrc_bias[actuator.dof];
    if (experiment.rig.kind === 'lower-body' && joint !== 'trunk_ext') {
      const siteX = (name: string) => data.site_xpos[siteIds.get(name)! * 3];
      const pelvisX = siteX('pelvis'), comX = data.subtree_com[0];
      const upperX = 0.25 * pelvisX + 0.75 * 0.5 * (siteX('waist') + siteX('neck'));
      if (joint === 'hip_ext') gravityTorque = 45.4 * 9.81 * (upperX - siteX('leftHip'));
      else if (joint === 'knee_ext') gravityTorque = 61.3 * 9.81 * Math.max(0, siteX('leftKnee') - pelvisX) * 0.85;
      else if (joint === 'ankle_pf') gravityTorque = 70.3 * 9.81 * (comX - siteX('leftAnkle'));
    }
    targets[actuator.dof] = gravityTorque + gains.kp * (qTarget - q) + gains.kd * (dqTarget - dq);
  }
  const balance = controller.balance;
  if (balance?.centerOfMassX) {
    const channel = balance.centerOfMassX, dof = actuators.get(channel.joint)?.dof;
    if (dof !== undefined) targets[dof] += channel.kp * (data.subtree_com[0] - channel.target) + channel.kd * data.subtree_linvel[0];
  }
  if (balance?.pelvisTilt) {
    const channel = balance.pelvisTilt, dof = actuators.get(channel.joint)?.dof, pelvisId = jointIds.get('pelvis_tilt');
    if (dof !== undefined && pelvisId !== undefined) {
      const pelvisDof = model.jnt_dofadr[pelvisId];
      const target = reference.positions.pelvis_tilt ?? channel.target;
      targets[dof] += channel.kp * (data.qpos[model.jnt_qposadr[pelvisId]] - target) + channel.kd * data.qvel[pelvisDof];
    }
  }
  const allOn = evaluateMuscles(system, data, new Float64Array(experiment.muscles.length).fill(1));
  const noActivation = evaluateMuscles(system, data, new Float64Array(experiment.muscles.length));
  const dofs = [...actuators.values()].map(({ dof }) => dof);
  const jointByDof = new Map([...actuators.entries()].map(([name, control]) => [control.dof, name]));
  return solveMuscleActivations({
    targetTorques: targets,
    passiveTorques: noActivation.jointTorques,
    muscleBasis: allOn.states.map((state) => ({ momentArms: state.momentArms, activeForce: state.activeForce })),
    baseline,
    dofs,
    weights: dofs.map((dof) => controller.jointWeights?.[jointByDof.get(dof)!] ?? 1),
    regularization: controller.effortRegularization,
  });
}

export function simulateMuscleExperiment(mj: Mujoco, model: MjModel, experiment: MuscleExperiment): MuscleRecording {
  validateJointTypes(mj, model);
  const joints = Array.from({ length: model.njnt }, (_, id) => mj.mj_id2name(model, mj.mjtObj.mjOBJ_JOINT.value, id));
  const jointIds = new Map(joints.map((name, id) => [name, id]));
  const actuators = actuatorsByJoint(mj, model, joints);
  if (actuators.size === 0) throw new Error('muscle model has no torque actuators');
  for (const joint of Object.keys(experiment.feedback?.gains ?? {})) if (!actuators.has(joint)) throw new Error(`feedback controller targets unactuated joint "${joint}"`);
  const jointTypes = Object.fromEntries(joints.map((name, id) => [name, model.jnt_type[id] === mj.mjtJoint.mjJNT_SLIDE.value ? 'slide' : 'hinge'])) as Record<string, 'hinge' | 'slide'>;
  const system = createMuscleSystem(mj, model, experiment.muscles);
  const dt = model.opt.timestep, duration = experiment.duration, steps = Math.ceil(duration / dt), n = steps + 1;
  const times = Float64Array.from({ length: n }, (_, k) => Math.min(k * dt, duration));
  times[n - 1] = duration;
  const positions = new Map<string, [Float64Array, Float64Array, Float64Array]>();
  const siteIds = SITE_NAMES.map((name) => [name, mj.mj_name2id(model, mj.mjtObj.mjOBJ_SITE.value, name)] as const).filter(([, id]) => id >= 0);
  const siteIdByName = new Map(siteIds);
  const com: MuscleRecording['com'] = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (const [name] of siteIds) positions.set(name, [new Float64Array(n), new Float64Array(n), new Float64Array(n)]);
  const jointColumns = new Map<string, Float64Array>();
  for (const prefix of ['angle', 'velocity', 'torque', 'work']) for (const name of joints) jointColumns.set(`${prefix}_${name}`, new Float64Array(n));
  const muscleColumns = new Map<string, Float64Array>();
  for (const prefix of MUSCLE_FIELDS) for (const muscle of experiment.muscles) muscleColumns.set(`${prefix}_${muscle.name}`, new Float64Array(n));
  const regionalPower = new Map(REGIONS.map((region) => [region, new Float64Array(n)]));
  const grf: MuscleRecording['grf'] = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const centerOfPressure: MuscleRecording['centerOfPressure'] = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const hasCenterOfPressure = new Uint8Array(n), contactCount = new Uint16Array(n);
  const feet: MuscleRecording['feet'] = new Map([
    ['left', [new Float64Array(n), new Float64Array(n), new Float64Array(n)]],
    ['right', [new Float64Array(n), new Float64Array(n), new Float64Array(n)]],
  ]);
  const contacts: GroundContact[][] = Array.from({ length: n }, () => []);
  const wrapPaths = new Map(experiment.muscles.map((muscle) => [muscle.name, Array.from({ length: n }, () => [] as Vec3[])]));
  const floorId = mj.mj_name2id(model, mj.mjtObj.mjOBJ_GEOM.value, 'floor');
  const data = new mj.MjData(model), forceBuffer = new mj.DoubleBuffer(6);
  const activation = Float64Array.from(experiment.controllers, (c) => c.baseline);
  const muscleNames = experiment.muscles.map((muscle) => muscle.name), work = new Float64Array(joints.length), previousQ = new Float64Array(joints.length);
  const nominalTimestep = model.opt.timestep;
  try {
    mj.mj_resetData(model, data);
    for (const [name, value] of Object.entries(experiment.initialPoseRad)) {
      const id = jointIds.get(name);
      if (id === undefined) throw new Error(`${experiment.id}: model has no joint named "${name}"`);
      data.qpos[model.jnt_qposadr[id]] = value;
    }
    for (let k = 0; k < n; k++) {
      const time = times[k];
      mj.mj_forward(model, data);
      const openLoopTargets = desiredActivations(experiment.controllers, muscleNames, time);
      const targets = experiment.feedback
        ? feedbackTargets(mj, model, data, experiment, joints, actuators, jointIds, siteIdByName, time, openLoopTargets, system)
        : openLoopTargets;
      const evaluated = evaluateMuscles(system, data, activation);
      data.ctrl.fill(0);
      for (const [joint, control] of actuators) data.ctrl[control.actuator] = evaluated.jointTorques[control.dof] / control.gear;
      mj.mj_forward(model, data);
      mj.mj_rnePostConstraint(model, data);

      for (let i = 0; i < joints.length; i++) {
        const joint = joints[i], id = jointIds.get(joint)!, dof = model.jnt_dofadr[id];
        jointColumns.get(`angle_${joint}`)![k] = data.qpos[model.jnt_qposadr[id]];
        jointColumns.get(`velocity_${joint}`)![k] = data.qvel[dof];
        jointColumns.get(`torque_${joint}`)![k] = data.qfrc_actuator[dof];
        jointColumns.get(`work_${joint}`)![k] = work[i];
      }
      for (let axis = 0; axis < 3; axis++) com[axis][k] = data.subtree_com[axis];
      for (const [name, id] of siteIds) {
        const destination = positions.get(name)!;
        for (let axis = 0; axis < 3; axis++) destination[axis][k] = data.site_xpos[id * 3 + axis];
      }
      evaluated.states.forEach((state: MuscleState, i) => {
        const values = {
          activation: activation[i], excitation: targets[i], force: state.force, active_force: state.activeForce,
          passive_force: state.passiveForce, length: state.tendonLength, velocity: state.tendonVelocity,
        };
        for (const [key, value] of Object.entries(values)) muscleColumns.get(`${key}_${state.name}`)![k] = value;
        const region = experiment.muscles[i].region ?? (experiment.rig.kind === 'lower-body' ? 'lower-body' : 'upper-body');
        regionalPower.get(region)![k] += -state.force * state.tendonVelocity;
        wrapPaths.get(state.name)![k] = wrapPath(data, system.tendonIds[i]);
      });
      if (floorId >= 0) {
        const contact = captureContacts(mj, model, data, floorId, forceBuffer);
        contactCount[k] = contact.contacts.length;
        contacts[k] = contact.contacts;
        for (let axis = 0; axis < 3; axis++) {
          grf[axis][k] = contact.total[axis];
          feet.get('left')![axis][k] = contact.left[axis];
          feet.get('right')![axis][k] = contact.right[axis];
          if (contact.cop) centerOfPressure[axis][k] = contact.cop[axis];
        }
        hasCenterOfPressure[k] = contact.cop ? 1 : 0;
      }
      if (k === n - 1) break;
      for (let i = 0; i < joints.length; i++) previousQ[i] = data.qpos[model.jnt_qposadr[jointIds.get(joints[i])!]];
      const stepDt = times[k + 1] - times[k];
      model.opt.timestep = stepDt;
      mj.mj_step(model, data);
      model.opt.timestep = nominalTimestep;
      for (let i = 0; i < joints.length; i++) {
        const joint = joints[i], id = jointIds.get(joint)!, actuator = actuators.get(joint);
        if (actuator) work[i] += data.qfrc_actuator[actuator.dof] * (data.qpos[model.jnt_qposadr[id]] - previousQ[i]);
      }
      activation.set(advanceActivations(activation, targets, experiment.controllers, experiment.muscles, stepDt));
    }
  } finally {
    model.opt.timestep = nominalTimestep;
    forceBuffer.delete();
    data.delete();
  }
  return {
    dt, duration, n, times, joints, jointTypes, muscles: muscleNames, positions, com, jointColumns, muscleColumns,
    regionalPower, grf, centerOfPressure, hasCenterOfPressure, contactCount, feet, contacts, wrapPaths,
  };
}

function maxAbs(values: Float64Array): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}
export function summarizeMuscleRun(experiment: MuscleExperiment, recording: MuscleRecording): MuscleRunSummary {
  const joints = recording.joints.map((name) => ({
    name,
    peakAngleRad: maxAbs(recording.jointColumns.get(`angle_${name}`)!),
    peakSpeed: maxAbs(recording.jointColumns.get(`velocity_${name}`)!),
    peakTorque: maxAbs(recording.jointColumns.get(`torque_${name}`)!),
  }));
  const muscles = recording.muscles.map((name) => ({
    name,
    peakActivation: Math.max(...recording.muscleColumns.get(`activation_${name}`)!),
    peakForce: Math.max(...recording.muscleColumns.get(`force_${name}`)!),
  }));
  let peakGroundReactionForce = 0, peakVerticalGroundReactionForce = 0;
  for (let k = 0; k < recording.n; k++) {
    const fx = recording.grf[0][k], fy = recording.grf[1][k], fz = recording.grf[2][k];
    peakGroundReactionForce = Math.max(peakGroundReactionForce, Math.hypot(fx, fy, fz));
    peakVerticalGroundReactionForce = Math.max(peakVerticalGroundReactionForce, fz);
  }
  return { duration: recording.duration, dt: recording.dt, peakGroundReactionForce, peakVerticalGroundReactionForce, joints, muscles };
}
