// Scalar summaries and self-consistency checks computed from a Recording.
import { col, type Recording } from './simulate.ts';

export interface JointSummary {
  joint: string;
  /** Largest |applied torque| (qfrc_actuator), N*m. */
  peakTorque: number;
  /** True if the commanded torque ever exceeded the actuator capacity (gear). */
  saturated: boolean;
  maxPower: number;
  minPower: number;
  /** Actuator work up to the peak-head-speed instant and up to the end, J. */
  workAtPeak: number;
  workEnd: number;
  /** Work done on this dof by its joint-limit constraint up to the peak instant, J (<= 0 in practice). */
  limitWorkAtPeak: number;
  /** First time the joint-limit constraint was active, s (null = never). */
  firstLimitTime: number | null;
  angleAtPeakDeg: number;
  velocityAtPeak: number;
  /** This joint's share of |v_head| at the peak instant, m/s: qvel_i * (J_i . v_hat). Shares sum to the peak speed. */
  headSpeedFromAtPeak: number;
}

/** Work-energy balance from t = 0 to some instant: W_act + W_damper + W_limit = dKE + dPE. */
export interface EnergyBudget {
  actuatorWork: number;
  damperWork: number;
  limitWork: number;
  deltaKinetic: number;
  /** Gravity + spring potential (MuJoCo energy[0]). Gravity contributes 0 here: all axes are vertical. */
  deltaPotential: number;
  residual: number;
}

export interface Summary {
  id: string;
  label: string;
  duration: number;
  dt: number;
  peakHeadSpeed: number;
  tPeak: number;
  headPosAtPeak: [number, number, number];
  headVelAtPeak: [number, number, number];
  /** Racket butt (grip end) speed at the same instant, for contrast with the head. */
  buttSpeedAtPeak: number;
  peakHeadAcc: number;
  /** Whole-chain angular momentum about the pelvis axis at the peak instant, kg*m^2/s. */
  angMomentumAtPeak: number;
  joints: JointSummary[];
  energyAtPeak: EnergyBudget;
  energyEnd: EnergyBudget;
  validation: {
    /** max |v_fd - J*qvel| over the run, divided by the peak head speed. */
    velocityFdRelErr: number;
    /** RMS |a_fd - (J*qacc + Jdot*qvel)| over the run, divided by RMS |a|. */
    accelFdRelErr: number;
    /** |energy residual at end| / total positive actuator work. */
    energyResidualRel: number;
    /** |dL_z - angular impulse about the pelvis axis| / max |L_z|. */
    momentumResidualRel: number;
  };
}

/** Tolerances for the built-in self-consistency checks (measured values are 3-10x smaller). */
export const VALIDATION_LIMITS: Readonly<Summary['validation']> = {
  velocityFdRelErr: 0.01,
  accelFdRelErr: 0.1,
  energyResidualRel: 0.01,
  momentumResidualRel: 0.01,
};

/** Names of the checks a run fails (empty = all pass). */
export function validationFailures(s: Summary): string[] {
  return (Object.keys(VALIDATION_LIMITS) as (keyof Summary['validation'])[]).filter(
    (k) => !(s.validation[k] <= VALIDATION_LIMITS[k]),
  );
}

/** err / ref, or the absolute error when the reference is zero (nothing moved). */
const rel = (err: number, ref: number): number => (ref > 0 ? err / ref : err);

/** Trapezoid integral of y (uniform step dt) from sample 0 to sample `upTo`. */
export function trapz(y: ArrayLike<number>, dt: number, upTo = y.length - 1): number {
  let s = 0;
  for (let k = 0; k < upTo; k++) s += 0.5 * (y[k] + y[k + 1]) * dt;
  return s;
}

export function argmax(y: ArrayLike<number>): number {
  let k = 0;
  for (let i = 1; i < y.length; i++) if (y[i] > y[k]) k = i;
  return k;
}

const absMax = (y: ArrayLike<number>): number => {
  let m = 0;
  for (let i = 0; i < y.length; i++) m = Math.max(m, Math.abs(y[i]));
  return m;
};

/** Power of a generalized-force column on its own joint: tau * qvel. */
function jointPower(rec: Recording, prefix: string, joint: string): Float64Array {
  const tau = col(rec, `${prefix}_${joint}`), dq = col(rec, `dq_${joint}`);
  return tau.map((v, k) => v * dq[k]);
}

function energyBudget(rec: Recording, k: number): EnergyBudget {
  // Actuator torque is held over each step, so the recorded work is exact; damper and
  // limit forces vary within a step, so their work uses the trapezoid rule.
  let actuatorWork = 0, damperWork = 0, limitWork = 0;
  for (const j of rec.joints) {
    actuatorWork += col(rec, `work_${j}`)[k];
    damperWork += trapz(jointPower(rec, 'tau_damper', j), rec.dt, k);
    limitWork += trapz(jointPower(rec, 'tau_limit', j), rec.dt, k);
  }
  const ke = col(rec, 'kinetic_energy'), pe = col(rec, 'potential_energy');
  const deltaKinetic = ke[k] - ke[0];
  const deltaPotential = pe[k] - pe[0];
  return {
    actuatorWork, damperWork, limitWork, deltaKinetic, deltaPotential,
    residual: actuatorWork + damperWork + limitWork - deltaKinetic - deltaPotential,
  };
}

/** Central differences of recorded head position / velocity vs the Jacobian-based values. */
function finiteDifferenceCheck(rec: Recording) {
  const h = 2 * rec.dt;
  const pos = ['x', 'y', 'z'].map((a) => col(rec, `racket_head_${a}`));
  const vel = ['vx', 'vy', 'vz'].map((a) => col(rec, `head_${a}`));
  const acc = ['ax', 'ay', 'az'].map((a) => col(rec, `head_${a}`));
  let vErrMax = 0, aErr2 = 0, aRef2 = 0;
  for (let k = 1; k < rec.n - 1; k++) {
    let ev = 0, ea = 0, ar = 0;
    for (let r = 0; r < 3; r++) {
      ev += ((pos[r][k + 1] - pos[r][k - 1]) / h - vel[r][k]) ** 2;
      ea += ((vel[r][k + 1] - vel[r][k - 1]) / h - acc[r][k]) ** 2;
      ar += acc[r][k] ** 2;
    }
    vErrMax = Math.max(vErrMax, Math.sqrt(ev));
    aErr2 += ea;
    aRef2 += ar;
  }
  return { velocityFdRelErr: rel(vErrMax, absMax(col(rec, 'head_speed'))), accelFdRelErr: rel(Math.sqrt(aErr2), Math.sqrt(aRef2)) };
}

/**
 * Only joint forces at the root hinge (pelvis_rot) exchange angular momentum about the
 * vertical axis with the ground; every other joint torque is internal to the chain.
 */
function momentumResidual(rec: Recording): number {
  const L = col(rec, 'ang_momentum_z');
  const act = col(rec, 'tau_act_pelvis_rot');
  let impulse = 0;
  for (let k = 0; k < rec.n - 1; k++) impulse += act[k] * rec.dt; // held over the step
  for (const prefix of ['tau_spring', 'tau_damper', 'tau_limit']) impulse += trapz(col(rec, `${prefix}_pelvis_rot`), rec.dt);
  return rel(Math.abs(L[rec.n - 1] - L[0] - impulse), absMax(L));
}

export function summarize(rec: Recording, meta: { id: string; label: string; gears: Record<string, number> }): Summary {
  const t = col(rec, 'time');
  const speed = col(rec, 'head_speed');
  const k = argmax(speed);
  const end = rec.n - 1;
  const at = (name: string) => col(rec, name)[k];

  const joints = rec.joints.map((j): JointSummary => {
    const cmd = col(rec, `tau_cmd_${j}`), power = col(rec, `power_${j}`), work = col(rec, `work_${j}`);
    const lim = col(rec, `tau_limit_${j}`);
    const firstLim = lim.findIndex((v) => v !== 0);
    return {
      joint: j,
      peakTorque: absMax(col(rec, `tau_act_${j}`)),
      saturated: cmd.some((v) => Math.abs(v) > meta.gears[j] * (1 + 1e-12)),
      maxPower: Math.max(...power),
      minPower: Math.min(...power),
      workAtPeak: work[k],
      workEnd: work[end],
      limitWorkAtPeak: trapz(jointPower(rec, 'tau_limit', j), rec.dt, k),
      firstLimitTime: firstLim < 0 ? null : t[firstLim],
      angleAtPeakDeg: (at(`q_${j}`) * 180) / Math.PI,
      velocityAtPeak: at(`dq_${j}`),
      headSpeedFromAtPeak: at(`vhead_from_${j}`),
    };
  });

  const energyEnd = energyBudget(rec, end);
  let positiveWork = 0;
  for (const j of rec.joints) {
    const w = col(rec, `work_${j}`);
    for (let i = 0; i < end; i++) positiveWork += Math.max(0, w[i + 1] - w[i]);
  }
  return {
    id: meta.id,
    label: meta.label,
    duration: t[end],
    dt: rec.dt,
    peakHeadSpeed: speed[k],
    tPeak: t[k],
    headPosAtPeak: [at('racket_head_x'), at('racket_head_y'), at('racket_head_z')],
    headVelAtPeak: [at('head_vx'), at('head_vy'), at('head_vz')],
    buttSpeedAtPeak: at('butt_speed'),
    peakHeadAcc: absMax(col(rec, 'head_acc')),
    angMomentumAtPeak: at('ang_momentum_z'),
    joints,
    energyAtPeak: energyBudget(rec, k),
    energyEnd,
    validation: {
      ...finiteDifferenceCheck(rec),
      energyResidualRel: rel(Math.abs(energyEnd.residual), positiveWork),
      momentumResidualRel: momentumResidual(rec),
    },
  };
}
