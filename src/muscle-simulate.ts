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
  kineticEnergy: Float64Array;
  potentialEnergy: Float64Array;
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
  validation: { momentArmFdMaxAbsErr: number; torqueMatchMaxAbsErr: number };
}
export interface MuscleRunSummary {
  duration: number;
  dt: number;
  peakGroundReactionForce: number;
  peakVerticalGroundReactionForce: number;
  joints: {
    name: string;
    peakAngleRad: number;
    peakSpeed: number;
    peakTorque: number;
    peakRequestedTorque: number;
    peakAppliedTorque: number;
    peakSaturationRatio: number;
    saturated: boolean;
    maxTorqueTrackingError: number;
  }[];
  muscles: { name: string; peakActivation: number; peakForce: number }[];
  validation: {
    momentArmFdMaxAbsErr: number;
    torqueMatchMaxAbsErr: number;
    workConsistencyRelErr: number;
    trajectoryFinite: boolean;
  };
}
export interface MuscleRun { experiment: MuscleExperiment; recording: MuscleRecording; summary: MuscleRunSummary }

const SITE_NAMES = [
  'shoulder', 'elbow', 'wrist', 'hand', 'pelvis', 'waist', 'neck', 'head',
  'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'leftHand', 'rightHand',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle', 'leftHeel', 'rightHeel', 'leftToe', 'rightToe',
] as const;
const MUSCLE_FIELDS = ['activation', 'excitation', 'force', 'active_force', 'passive_force', 'length', 'velocity', 'power', 'work'] as const;
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

function solveDense(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    if (Math.abs(a[pivot][column]) < 1e-12) throw new Error('support Jacobian is singular for the selected unactuated DOFs');
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const scale = a[column][column];
    for (let j = column; j <= n; j++) a[column][j] /= scale;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = a[row][column];
      for (let j = column; j <= n; j++) a[row][j] -= factor * a[column][j];
    }
  }
  return a.map((row) => row[n]);
}

export interface SupportJacobianBuffers {
  position: { GetView(): Float64Array; delete(): void };
  rotation: { GetView(): Float64Array; delete(): void };
}

/** Projects model bias through a rigid planar support; without a support, returns bias minus passive force. */
export function stanceBiasTorques(
  mj: Mujoco,
  model: MjModel,
  data: Parameters<Mujoco['mj_forward']>[1],
  supportBodyId: number,
  unactuatedDofs: readonly number[],
  buffers?: SupportJacobianBuffers,
): Float64Array {
  const bias = Float64Array.from({ length: model.nv }, (_, dof) => data.qfrc_bias[dof] - data.qfrc_passive[dof]);
  if (supportBodyId < 0 || unactuatedDofs.length === 0) return bias;
  if (unactuatedDofs.length !== 3 || new Set(unactuatedDofs).size !== 3 || unactuatedDofs.some((dof) => dof < 0 || dof >= model.nv)) {
    throw new Error('planar support projection requires three unique unactuated DOFs');
  }
  const owned = buffers ?? {
    position: new mj.DoubleBuffer(3 * model.nv),
    rotation: new mj.DoubleBuffer(3 * model.nv),
  };
  try {
    mj.mj_jacBody(model, data, owned.position, owned.rotation, supportBodyId);
    const position = owned.position.GetView(), rotation = owned.rotation.GetView(), nv = model.nv;
    const rows: number[][] = [
      Array.from(position.slice(0, nv)) as number[],
      Array.from(position.slice(2 * nv, 3 * nv)) as number[],
      Array.from(rotation.slice(nv, 2 * nv)) as number[],
    ];
    const lambda = solveDense(
      unactuatedDofs.map((dof) => rows.map((row) => row[dof])),
      unactuatedDofs.map((dof) => bias[dof]),
    );
    for (let dof = 0; dof < nv; dof++) {
      for (let component = 0; component < 3; component++) bias[dof] -= rows[component][dof] * lambda[component];
    }
    return bias;
  } finally {
    if (!buffers) {
      owned.position.delete();
      owned.rotation.delete();
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
  time: number,
  baseline: Float64Array,
  system: ReturnType<typeof createMuscleSystem>,
  biasTorques: ArrayLike<number>,
): Float64Array {
  const controller = experiment.feedback!;
  const reference = sampleTrajectory(controller, time);
  const targets = new Float64Array(system.dofCount);
  for (const joint of joints) {
    const actuator = actuators.get(joint), gains = controller.gains[joint], jointId = jointIds.get(joint);
    if (!actuator || !gains || jointId === undefined) continue;
    const q = data.qpos[model.jnt_qposadr[jointId]], dq = data.qvel[actuator.dof];
    const qTarget = reference.positions[joint] ?? q, dqTarget = reference.velocities[joint] ?? 0;
    targets[actuator.dof] = biasTorques[actuator.dof] + gains.kp * (qTarget - q) + gains.kd * (dqTarget - dq);
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

function momentArmFiniteDifferenceMaxError(
  mj: Mujoco,
  model: MjModel,
  data: Parameters<Mujoco['mj_forward']>[1],
  system: ReturnType<typeof createMuscleSystem>,
  states: readonly MuscleState[],
): number {
  const epsilon = 1e-6, savedQpos = Float64Array.from(data.qpos);
  let maximum = 0;
  try {
    for (let joint = 0; joint < model.njnt; joint++) {
      const qadr = model.jnt_qposadr[joint], dof = model.jnt_dofadr[joint], q = data.qpos[qadr];
      data.qpos[qadr] = q + epsilon;
      mj.mj_forward(model, data);
      const plus = Float64Array.from(system.tendonIds, (id) => data.ten_length[id]);
      data.qpos[qadr] = q - epsilon;
      mj.mj_forward(model, data);
      const minus = Float64Array.from(system.tendonIds, (id) => data.ten_length[id]);
      data.qpos[qadr] = q;
      for (let muscle = 0; muscle < system.tendonIds.length; muscle++) {
        const finiteDifference = -(plus[muscle] - minus[muscle]) / (2 * epsilon);
        maximum = Math.max(maximum, Math.abs(finiteDifference - states[muscle].momentArms[dof]));
      }
    }
  } finally {
    data.qpos.set(savedQpos);
    mj.mj_forward(model, data);
    mj.mj_rnePostConstraint(model, data);
  }
  return maximum;
}

export function simulateMuscleExperiment(mj: Mujoco, model: MjModel, experiment: MuscleExperiment): MuscleRecording {
  validateJointTypes(mj, model);
  const joints = Array.from({ length: model.njnt }, (_, id) => mj.mj_id2name(model, mj.mjtObj.mjOBJ_JOINT.value, id));
  const jointIds = new Map(joints.map((name, id) => [name, id]));
  const actuators = actuatorsByJoint(mj, model, joints);
  if (actuators.size === 0) throw new Error('muscle model has no torque actuators');
  for (const joint of Object.keys(experiment.feedback?.gains ?? {})) if (!actuators.has(joint)) throw new Error(`feedback controller targets unactuated joint "${joint}"`);
  const drivenDofs = new Set([...actuators.values()].map(({ dof }) => dof));
  const unactuatedDofs = Array.from({ length: model.nv }, (_, dof) => dof).filter((dof) => !drivenDofs.has(dof));
  const supportBodyId = experiment.rig.kind === 'lower-body' ? mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, 'foot') : -1;
  if (experiment.rig.kind === 'lower-body' && supportBodyId < 0) throw new Error('lower-body model must define a foot support body');
  const supportJacobianBuffers: SupportJacobianBuffers | undefined = supportBodyId >= 0
    ? { position: new mj.DoubleBuffer(3 * model.nv), rotation: new mj.DoubleBuffer(3 * model.nv) }
    : undefined;
  const jointTypes = Object.fromEntries(joints.map((name, id) => [name, model.jnt_type[id] === mj.mjtJoint.mjJNT_SLIDE.value ? 'slide' : 'hinge'])) as Record<string, 'hinge' | 'slide'>;
  const system = createMuscleSystem(mj, model, experiment.muscles);
  const dt = model.opt.timestep, duration = experiment.duration, steps = Math.ceil(duration / dt), n = steps + 1;
  const times = Float64Array.from({ length: n }, (_, k) => Math.min(k * dt, duration));
  times[n - 1] = duration;
  const positions = new Map<string, [Float64Array, Float64Array, Float64Array]>();
  const siteIds = SITE_NAMES.map((name) => [name, mj.mj_name2id(model, mj.mjtObj.mjOBJ_SITE.value, name)] as const).filter(([, id]) => id >= 0);
  const com: MuscleRecording['com'] = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const kineticEnergy = new Float64Array(n), potentialEnergy = new Float64Array(n);
  for (const [name] of siteIds) positions.set(name, [new Float64Array(n), new Float64Array(n), new Float64Array(n)]);
  const jointColumns = new Map<string, Float64Array>();
  for (const prefix of ['angle', 'velocity', 'acceleration', 'torque', 'requested_torque', 'saturation_ratio', 'torque_error', 'power', 'passive_torque', 'constraint_torque', 'work']) {
    for (const name of joints) jointColumns.set(`${prefix}_${name}`, new Float64Array(n));
  }
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
  const muscleNames = experiment.muscles.map((muscle) => muscle.name);
  const work = new Float64Array(joints.length), previousQ = new Float64Array(joints.length), previousAppliedTorque = new Float64Array(joints.length);
  const muscleWork = new Float64Array(experiment.muscles.length);
  let momentArmFdMaxAbsErr = 0, torqueMatchMaxAbsErr = 0;
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
      const biasTorques = experiment.feedback
        ? stanceBiasTorques(mj, model, data, supportBodyId, unactuatedDofs, supportJacobianBuffers)
        : undefined;
      const targets = experiment.feedback
        ? feedbackTargets(mj, model, data, experiment, joints, actuators, jointIds, time, openLoopTargets, system, biasTorques!)
        : openLoopTargets;
      const evaluated = evaluateMuscles(system, data, activation);
      data.ctrl.fill(0);
      for (const [joint, control] of actuators) data.ctrl[control.actuator] = evaluated.jointTorques[control.dof] / control.gear;
      mj.mj_forward(model, data);
      mj.mj_rnePostConstraint(model, data);

      for (let i = 0; i < joints.length; i++) {
        const joint = joints[i], id = jointIds.get(joint)!, dof = model.jnt_dofadr[id];
        const control = actuators.get(joint);
        const requestedTorque = evaluated.jointTorques[dof], appliedTorque = data.qfrc_actuator[dof];
        const saturationRatio = control ? Math.abs(requestedTorque) / Math.abs(control.gear) : 0;
        const trackingError = appliedTorque - requestedTorque;
        if (control) torqueMatchMaxAbsErr = Math.max(torqueMatchMaxAbsErr, Math.abs(trackingError));
        jointColumns.get(`angle_${joint}`)![k] = data.qpos[model.jnt_qposadr[id]];
        jointColumns.get(`velocity_${joint}`)![k] = data.qvel[dof];
        jointColumns.get(`acceleration_${joint}`)![k] = data.qacc[dof];
        jointColumns.get(`torque_${joint}`)![k] = appliedTorque;
        jointColumns.get(`requested_torque_${joint}`)![k] = requestedTorque;
        jointColumns.get(`saturation_ratio_${joint}`)![k] = saturationRatio;
        jointColumns.get(`torque_error_${joint}`)![k] = trackingError;
        jointColumns.get(`power_${joint}`)![k] = appliedTorque * data.qvel[dof];
        jointColumns.get(`passive_torque_${joint}`)![k] = data.qfrc_passive[dof];
        jointColumns.get(`constraint_torque_${joint}`)![k] = data.qfrc_constraint[dof];
        jointColumns.get(`work_${joint}`)![k] = work[i];
      }
      kineticEnergy[k] = data.energy[1];
      potentialEnergy[k] = data.energy[0];
      for (let axis = 0; axis < 3; axis++) com[axis][k] = data.subtree_com[axis];
      for (const [name, id] of siteIds) {
        const destination = positions.get(name)!;
        for (let axis = 0; axis < 3; axis++) destination[axis][k] = data.site_xpos[id * 3 + axis];
      }
      evaluated.states.forEach((state: MuscleState, i) => {
        const power = -state.force * state.tendonVelocity;
        if (k > 0) {
          const previousPower = muscleColumns.get(`power_${state.name}`)![k - 1];
          muscleWork[i] += 0.5 * (previousPower + power) * (times[k] - times[k - 1]);
        }
        const values = {
          activation: activation[i], excitation: targets[i], force: state.force, active_force: state.activeForce,
          passive_force: state.passiveForce, length: state.tendonLength, velocity: state.tendonVelocity,
          power, work: muscleWork[i],
        };
        for (const [key, value] of Object.entries(values)) muscleColumns.get(`${key}_${state.name}`)![k] = value;
        const region = experiment.muscles[i].region ?? (experiment.rig.kind === 'lower-body' ? 'lower-body' : 'upper-body');
        regionalPower.get(region)![k] += power;
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
      if (k % 10 === 0 || k === n - 1) {
        momentArmFdMaxAbsErr = Math.max(momentArmFdMaxAbsErr, momentArmFiniteDifferenceMaxError(mj, model, data, system, evaluated.states));
      }
      if (k === n - 1) break;
      for (let i = 0; i < joints.length; i++) {
        const joint = joints[i], id = jointIds.get(joint)!, dof = model.jnt_dofadr[id];
        previousQ[i] = data.qpos[model.jnt_qposadr[id]];
        previousAppliedTorque[i] = data.qfrc_actuator[dof];
      }
      const stepDt = times[k + 1] - times[k];
      model.opt.timestep = stepDt;
      mj.mj_step(model, data);
      model.opt.timestep = nominalTimestep;
      for (let i = 0; i < joints.length; i++) {
        const id = jointIds.get(joints[i])!;
        work[i] += previousAppliedTorque[i] * (data.qpos[model.jnt_qposadr[id]] - previousQ[i]);
      }
      activation.set(advanceActivations(activation, targets, experiment.controllers, experiment.muscles, stepDt));
    }
  } finally {
    model.opt.timestep = nominalTimestep;
    forceBuffer.delete();
    supportJacobianBuffers?.position.delete();
    supportJacobianBuffers?.rotation.delete();
    data.delete();
  }
  return {
    dt, duration, n, times, joints, jointTypes, muscles: muscleNames, positions, com, kineticEnergy, potentialEnergy, jointColumns, muscleColumns,
    regionalPower, grf, centerOfPressure, hasCenterOfPressure, contactCount, feet, contacts, wrapPaths,
    validation: { momentArmFdMaxAbsErr, torqueMatchMaxAbsErr },
  };
}

function maxAbs(values: Float64Array): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}
function withinFiniteRange(values: ArrayLike<number>, maxAbs: number): boolean {
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i]) || Math.abs(values[i]) > maxAbs) return false;
  return true;
}

function trajectoryFinite(recording: MuscleRecording): boolean {
  if (!withinFiniteRange(recording.times, 1e6) || !withinFiniteRange(recording.kineticEnergy, 1e9) || !withinFiniteRange(recording.potentialEnergy, 1e9)) return false;
  for (const axis of recording.com) if (!withinFiniteRange(axis, 10)) return false;
  for (const values of recording.positions.values()) for (const axis of values) if (!withinFiniteRange(axis, 10)) return false;
  for (const [name, values] of recording.jointColumns) {
    const limit = name.startsWith('angle_') ? (recording.jointTypes[name.slice('angle_'.length)] === 'slide' ? 10 : 4 * Math.PI)
      : name.startsWith('velocity_') ? 100
        : name.startsWith('acceleration_') ? 1e4
          : name.startsWith('saturation_ratio_') ? 100
            : 1e7;
    if (!withinFiniteRange(values, limit)) return false;
  }
  for (const [name, values] of recording.muscleColumns) {
    const limit = name.startsWith('activation_') || name.startsWith('excitation_') ? 1
      : name.startsWith('length_') ? 10
        : name.startsWith('velocity_') ? 100
          : 1e7;
    if (!withinFiniteRange(values, limit)) return false;
    if ((name.startsWith('activation_') || name.startsWith('excitation_')) && Array.from(values).some((value) => value < 0)) return false;
  }
  for (const values of [...recording.grf, ...recording.centerOfPressure]) if (!withinFiniteRange(values, 1e7)) return false;
  for (const foot of recording.feet.values()) for (const axis of foot) if (!withinFiniteRange(axis, 1e7)) return false;
  for (const values of recording.regionalPower.values()) if (!withinFiniteRange(values, 1e8)) return false;
  for (const frame of recording.contacts) for (const contact of frame) {
    if (!contact.position.every((value) => Number.isFinite(value) && Math.abs(value) <= 10)) return false;
    if (!contact.force.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e7)) return false;
  }
  for (const paths of recording.wrapPaths.values()) for (const frame of paths) for (const point of frame) {
    if (!point.every((value) => Number.isFinite(value) && Math.abs(value) <= 10)) return false;
  }
  return true;
}

export function summarizeMuscleRun(experiment: MuscleExperiment, recording: MuscleRecording): MuscleRunSummary {
  const joints = recording.joints.map((name) => {
    const peakAppliedTorque = maxAbs(recording.jointColumns.get(`torque_${name}`)!);
    const peakRequestedTorque = maxAbs(recording.jointColumns.get(`requested_torque_${name}`)!);
    const peakSaturationRatio = maxAbs(recording.jointColumns.get(`saturation_ratio_${name}`)!);
    return {
      name,
      peakAngleRad: maxAbs(recording.jointColumns.get(`angle_${name}`)!),
      peakSpeed: maxAbs(recording.jointColumns.get(`velocity_${name}`)!),
      peakTorque: peakAppliedTorque,
      peakRequestedTorque,
      peakAppliedTorque,
      peakSaturationRatio,
      saturated: peakSaturationRatio > 1 + 1e-9,
      maxTorqueTrackingError: maxAbs(recording.jointColumns.get(`torque_error_${name}`)!),
    };
  });
  const muscles = recording.muscles.map((name) => ({
    name,
    peakActivation: Math.max(...recording.muscleColumns.get(`activation_${name}`)!),
    peakForce: Math.max(...recording.muscleColumns.get(`force_${name}`)!),
  }));
  let peakGroundReactionForce = 0, peakVerticalGroundReactionForce = 0, integratedJointPower = 0, totalMuscleWork = 0;
  for (let k = 0; k < recording.n; k++) {
    const fx = recording.grf[0][k], fy = recording.grf[1][k], fz = recording.grf[2][k];
    peakGroundReactionForce = Math.max(peakGroundReactionForce, Math.hypot(fx, fy, fz));
    peakVerticalGroundReactionForce = Math.max(peakVerticalGroundReactionForce, fz);
    if (k === recording.n - 1) continue;
    const step = recording.times[k + 1] - recording.times[k];
    for (const joint of recording.joints) {
      const power = recording.jointColumns.get(`power_${joint}`)!;
      integratedJointPower += 0.5 * (power[k] + power[k + 1]) * step;
    }
  }
  for (const muscle of recording.muscles) totalMuscleWork += recording.muscleColumns.get(`work_${muscle}`)!.at(-1)!;
  const workConsistencyRelErr = Math.abs(totalMuscleWork - integratedJointPower) / Math.max(1e-9, Math.abs(totalMuscleWork), Math.abs(integratedJointPower));
  return {
    duration: recording.duration, dt: recording.dt, peakGroundReactionForce, peakVerticalGroundReactionForce, joints, muscles,
    validation: {
      momentArmFdMaxAbsErr: recording.validation.momentArmFdMaxAbsErr,
      torqueMatchMaxAbsErr: recording.validation.torqueMatchMaxAbsErr,
      workConsistencyRelErr,
      trajectoryFinite: trajectoryFinite(recording),
    },
  };
}
