import type { MjModel, Mujoco } from './mujoco.ts';

/** Contract between muscle geometry, force generation, and joint dynamics. SI units. */
export interface MuscleDefinition {
  name: string;
  tendon: string;
  region?: 'lower-body' | 'trunk' | 'upper-body';
  maxIsometricForce: number;
  optimalFiberLength: number;
  tendonSlackLength: number;
  maxContractionVelocity: number;
  activationTimeConstant: number;
  deactivationTimeConstant: number;
}

export interface MuscleState {
  name: string;
  activation: number;
  fiberLength: number;
  tendonLength: number;
  tendonVelocity: number;
  forceLengthFactor: number;
  forceVelocityFactor: number;
  passiveForce: number;
  activeForce: number;
  force: number;
  momentArms: Float64Array;
}

export interface MuscleSystem {
  definitions: readonly MuscleDefinition[];
  dofCount: number;
  tendonIds: number[];
  tendonJacobianRows: { columns: number[]; valuesOffset: number }[];
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

/** Resolves named MuJoCo tendons and prepares their sparse Jacobian row layout. */
export function createMuscleSystem(
  mj: Mujoco,
  model: MjModel,
  definitions: readonly MuscleDefinition[],
): MuscleSystem {
  const names = new Set<string>();
  const tendonIds = definitions.map((muscle) => {
    if (names.has(muscle.name)) throw new Error(`duplicate muscle "${muscle.name}"`);
    names.add(muscle.name);
    for (const [field, value] of Object.entries(muscle)) {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${muscle.name}: ${field} must be finite`);
    }
    if (!(muscle.maxIsometricForce > 0 && muscle.optimalFiberLength > 0 && muscle.tendonSlackLength >= 0 && muscle.maxContractionVelocity > 0)) {
      throw new Error(`${muscle.name}: force and length parameters must be positive`);
    }
    if (!(muscle.activationTimeConstant > 0 && muscle.deactivationTimeConstant > 0)) throw new Error(`${muscle.name}: activation time constants must be positive`);
    const id = mj.mj_name2id(model, mj.mjtObj.mjOBJ_TENDON.value, muscle.tendon);
    if (id < 0) throw new Error(`MJCF model has no tendon named "${muscle.tendon}"`);
    return id;
  });
  const tendonJacobianRows = tendonIds.map((id) => {
    const adr = model.ten_J_rowadr[id];
    const count = model.ten_J_rownnz[id];
    return { columns: Array.from(model.ten_J_colind.slice(adr, adr + count)) as number[], valuesOffset: adr };
  });
  return { definitions, dofCount: model.nv, tendonIds, tendonJacobianRows };
}

/** Tendon force and generalized joint torque from activation, path length, and dL/dq. */
export function evaluateMuscles(
  system: MuscleSystem,
  data: { ten_length: ArrayLike<number>; ten_velocity: ArrayLike<number>; ten_J: ArrayLike<number> },
  activations: ArrayLike<number>,
): { states: MuscleState[]; jointTorques: Float64Array } {
  if (activations.length !== system.definitions.length) throw new Error('activation count must match muscle count');
  const jointTorques = new Float64Array(system.dofCount);
  const states = system.definitions.map((muscle, i): MuscleState => {
    const tendonId = system.tendonIds[i];
    const tendonLength = data.ten_length[tendonId];
    const tendonVelocity = data.ten_velocity[tendonId];
    const fiberLength = Math.max(0.01 * muscle.optimalFiberLength, tendonLength - muscle.tendonSlackLength);
    const normalizedLength = fiberLength / muscle.optimalFiberLength;
    const forceLengthFactor = Math.exp(-(((normalizedLength - 1) / 0.45) ** 2));
    const normalizedVelocity = tendonVelocity / (muscle.maxContractionVelocity * muscle.optimalFiberLength);
    const forceVelocityFactor = clamp((1 + normalizedVelocity) / (1 - normalizedVelocity / 1.5), 0, 1.8);
    const passiveForce = muscle.maxIsometricForce * 0.015 * Math.max(0, Math.exp(4 * Math.max(0, normalizedLength - 1)) - 1);
    const activation = clamp(activations[i], 0, 1);
    const activeForce = activation * muscle.maxIsometricForce * forceLengthFactor * forceVelocityFactor;
    const force = activeForce + passiveForce;
    const momentArms = new Float64Array(system.dofCount);
    const row = system.tendonJacobianRows[i];
    for (let j = 0; j < row.columns.length; j++) {
      const dof = row.columns[j];
      const momentArm = -data.ten_J[row.valuesOffset + j];
      momentArms[dof] = momentArm;
      jointTorques[dof] += momentArm * force;
    }
    return { name: muscle.name, activation, fiberLength, tendonLength, tendonVelocity, forceLengthFactor, forceVelocityFactor, passiveForce, activeForce, force, momentArms };
  });
  return { states, jointTorques };
}
