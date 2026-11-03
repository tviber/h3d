// Open-loop joint torque profiles: torque = f(joint, time).
//
// Every joint's commanded torque is the sum of its pulses. Each pulse is a
// smooth (C1) bump scaled by `direction * peak`, so sums of pulses give
// piecewise-smooth profiles. Units: N*m and seconds.

export type PulseShape = 'sin2' | 'plateau';

export interface Pulse {
  joint: string;
  /** Peak magnitude, N*m (>= 0). */
  peak: number;
  /** Onset time, s. */
  start: number;
  /** Total length, s (> 0). */
  duration: number;
  /** +1 = forward-swing direction, -1 = opposite. */
  direction: 1 | -1;
  /** 'sin2' (default): sin^2 bump. 'plateau': smoothstep rise, flat top, smoothstep fall. */
  shape?: PulseShape;
  /** Plateau only: rise time = fall time, s (default duration / 4, at most duration / 2). */
  rise?: number;
}

export function validatePulse(p: Pulse): void {
  const where = `pulse on "${p.joint}"`;
  if (!(p.peak >= 0) || !Number.isFinite(p.peak)) throw new Error(`${where}: peak must be a finite number >= 0`);
  if (!Number.isFinite(p.start)) throw new Error(`${where}: start must be finite`);
  if (!(p.duration > 0) || !Number.isFinite(p.duration)) throw new Error(`${where}: duration must be > 0`);
  if (p.direction !== 1 && p.direction !== -1) throw new Error(`${where}: direction must be 1 or -1`);
  if (p.shape !== undefined && p.shape !== 'sin2' && p.shape !== 'plateau') throw new Error(`${where}: unknown shape "${p.shape}"`);
  if (p.rise !== undefined && !(p.rise > 0 && p.rise <= p.duration / 2)) throw new Error(`${where}: rise must be in (0, duration/2]`);
}

const smoothstep = (x: number): number => x * x * (3 - 2 * x);

/** Normalised pulse envelope in [0, 1]; zero outside (start, start + duration). */
export function envelope(p: Pulse, t: number): number {
  const u = t - p.start;
  if (u <= 0 || u >= p.duration) return 0;
  if ((p.shape ?? 'sin2') === 'sin2') return Math.sin((Math.PI * u) / p.duration) ** 2;
  const rise = p.rise ?? p.duration / 4;
  if (u < rise) return smoothstep(u / rise);
  if (u > p.duration - rise) return smoothstep((p.duration - u) / rise);
  return 1;
}

/** Commanded torque for one joint at time t, N*m. */
export function commandedTorque(pulses: readonly Pulse[], joint: string, t: number): number {
  let tau = 0;
  for (const p of pulses) if (p.joint === joint) tau += p.direction * p.peak * envelope(p, t);
  return tau;
}

/**
 * MuJoCo `motor` actuator with joint transmission (gainprm = 1, no bias, no dynamics):
 *   ctrl            = tau_cmd / gear                 (what h3d writes to mjData.ctrl)
 *   actuator_force  = clamp(ctrl, ctrlrange)          (MuJoCo clamps because ctrllimited)
 *   qfrc_actuator   = gear * actuator_force           (generalized torque on the joint dof)
 * The returned value is what MuJoCo applies; it differs from tau_cmd only when saturated.
 */
export function appliedTorque(tauCmd: number, gear: number, ctrlRange: readonly [number, number] = [-1, 1]): number {
  const ctrl = tauCmd / gear;
  return gear * Math.min(ctrlRange[1], Math.max(ctrlRange[0], ctrl));
}
