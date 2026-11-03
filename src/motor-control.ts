export interface ActivationPulse {
  muscle: string;
  /** Target activation increase (0..1) applied with a smooth rise and fall. */
  level: number;
  start: number;
  duration: number;
  /** Rise and fall duration; defaults to one quarter of pulse duration. */
  riseTime?: number;
}

export interface MuscleController {
  muscle: string;
  baseline: number;
  pulses: readonly ActivationPulse[];
}

export interface TrajectoryKeyframe {
  time: number;
  joints: Readonly<Record<string, number>>;
}

export interface FeedbackGains {
  kp: number;
  kd: number;
}

export interface BalanceFeedback {
  /** Apply COM position/velocity error to an actuated joint (usually ankle_pf). */
  centerOfMassX?: { target: number; joint: string; kp: number; kd: number };
  /** Apply pelvis angle/rate error to an actuated joint (usually hip_ext). */
  pelvisTilt?: { target: number; joint: string; kp: number; kd: number };
}

export interface TrajectoryController {
  type: 'trajectory';
  keyframes: readonly TrajectoryKeyframe[];
  gains: Readonly<Record<string, FeedbackGains>>;
  jointWeights?: Readonly<Record<string, number>>;
  balance?: BalanceFeedback;
  effortRegularization?: number;
}

const smoothstep = (x: number): number => x * x * (3 - 2 * x);

export function validateController(controller: MuscleController): void {
  if (!controller.muscle) throw new Error('controller muscle name must not be empty');
  if (!(controller.baseline >= 0 && controller.baseline <= 1) || !Number.isFinite(controller.baseline)) {
    throw new Error(`${controller.muscle}: baseline must be in [0, 1]`);
  }
  for (const pulse of controller.pulses) {
    if (pulse.muscle !== controller.muscle) throw new Error(`${controller.muscle}: pulse muscle name does not match its controller`);
    if (!(pulse.level >= 0 && pulse.level <= 1) || !Number.isFinite(pulse.level)) throw new Error(`${controller.muscle}: pulse level must be in [0, 1]`);
    if (!Number.isFinite(pulse.start) || !(pulse.duration > 0) || !Number.isFinite(pulse.duration)) throw new Error(`${controller.muscle}: pulse start/duration is invalid`);
    if (pulse.riseTime !== undefined && !(pulse.riseTime > 0 && pulse.riseTime <= pulse.duration / 2)) throw new Error(`${controller.muscle}: riseTime must be in (0, duration/2]`);
  }
}

export function validateTrajectoryController(controller: TrajectoryController): void {
  if (controller.keyframes.length < 2) throw new Error('trajectory controller needs at least two keyframes');
  let previousTime = -Infinity;
  for (const frame of controller.keyframes) {
    if (!Number.isFinite(frame.time) || frame.time <= previousTime) throw new Error('trajectory keyframe times must be finite and strictly increasing');
    previousTime = frame.time;
    for (const [joint, value] of Object.entries(frame.joints)) {
      if (!joint || !Number.isFinite(value)) throw new Error(`trajectory keyframe has an invalid target for "${joint}"`);
    }
  }
  for (const [joint, gains] of Object.entries(controller.gains)) {
    if (!joint || !Number.isFinite(gains.kp) || gains.kp < 0 || !Number.isFinite(gains.kd) || gains.kd < 0) {
      throw new Error(`trajectory gains for "${joint}" must be finite and non-negative`);
    }
  }
  for (const [joint, weight] of Object.entries(controller.jointWeights ?? {})) {
    if (!joint || !(weight > 0) || !Number.isFinite(weight)) throw new Error(`trajectory joint weight for "${joint}" must be finite and positive`);
  }
  const balanceEntries = [controller.balance?.centerOfMassX, controller.balance?.pelvisTilt].filter(Boolean);
  for (const channel of balanceEntries) {
    if (!channel!.joint || !Number.isFinite(channel!.target) || !Number.isFinite(channel!.kp) || channel!.kp < 0 || !Number.isFinite(channel!.kd) || channel!.kd < 0) {
      throw new Error('balance feedback values must be finite and non-negative');
    }
  }
  if (controller.effortRegularization !== undefined && (!(controller.effortRegularization >= 0) || !Number.isFinite(controller.effortRegularization))) {
    throw new Error('effortRegularization must be finite and non-negative');
  }
}

function envelope(pulse: ActivationPulse, time: number): number {
  const elapsed = time - pulse.start;
  if (elapsed <= 0 || elapsed >= pulse.duration) return 0;
  const rise = pulse.riseTime ?? pulse.duration / 4;
  if (elapsed < rise) return smoothstep(elapsed / rise);
  if (elapsed > pulse.duration - rise) return smoothstep((pulse.duration - elapsed) / rise);
  return 1;
}

/** Open-loop motor-control output: desired muscle activations. */
export function desiredActivations(
  controllers: readonly MuscleController[],
  muscleNames: readonly string[],
  time: number,
): Float64Array {
  const byName = new Map(controllers.map((controller) => [controller.muscle, controller]));
  return Float64Array.from(muscleNames, (name) => {
    const controller = byName.get(name);
    if (!controller) throw new Error(`no controller for muscle "${name}"`);
    let activation = controller.baseline;
    for (const pulse of controller.pulses) activation += pulse.level * envelope(pulse, time);
    return Math.min(1, activation);
  });
}

/** First-order activation dynamics; rise and fall time constants differ physiologically. */
export function advanceActivations(
  current: ArrayLike<number>,
  target: ArrayLike<number>,
  controllers: readonly MuscleController[],
  muscles: readonly { name: string; activationTimeConstant: number; deactivationTimeConstant: number }[],
  dt: number,
): Float64Array {
  if (current.length !== muscles.length || target.length !== muscles.length || controllers.length !== muscles.length) {
    throw new Error('activation and muscle counts must match');
  }
  return Float64Array.from(current, (activation, i) => {
    const controller = controllers[i];
    if (controller.muscle !== muscles[i].name) throw new Error(`controller order does not match muscle "${muscles[i].name}"`);
    const tau = target[i] > activation ? muscles[i].activationTimeConstant : muscles[i].deactivationTimeConstant;
    return activation + (target[i] - activation) * Math.min(1, dt / tau);
  });
}

/** Smoothly samples a joint-space trajectory and its analytical velocity. */
export function sampleTrajectory(controller: TrajectoryController, time: number): { positions: Record<string, number>; velocities: Record<string, number> } {
  const frames = controller.keyframes;
  let left = frames[0], right = frames.at(-1)!;
  if (time <= left.time) right = left;
  else if (time >= right.time) left = right;
  else {
    for (let i = 0; i < frames.length - 1; i++) {
      if (time <= frames[i + 1].time) {
        left = frames[i];
        right = frames[i + 1];
        break;
      }
    }
  }
  const span = right.time - left.time;
  const u = span > 0 ? Math.max(0, Math.min(1, (time - left.time) / span)) : 0;
  const blend = smoothstep(u);
  const blendRate = span > 0 && u > 0 && u < 1 ? 6 * u * (1 - u) / span : 0;
  const names = new Set([...Object.keys(left.joints), ...Object.keys(right.joints)]);
  const positions: Record<string, number> = {}, velocities: Record<string, number> = {};
  for (const name of names) {
    const a = left.joints[name] ?? right.joints[name] ?? 0;
    const b = right.joints[name] ?? left.joints[name] ?? 0;
    positions[name] = a + (b - a) * blend;
    velocities[name] = (b - a) * blendRate;
  }
  return { positions, velocities };
}

export interface MuscleTorqueBasis {
  momentArms: ArrayLike<number>;
  activeForce: number;
}

export interface MuscleAllocationOptions {
  targetTorques: ArrayLike<number>;
  passiveTorques: ArrayLike<number>;
  muscleBasis: readonly MuscleTorqueBasis[];
  baseline: ArrayLike<number>;
  dofs: readonly number[];
  weights?: readonly number[];
  regularization?: number;
  iterations?: number;
}

/** Bounded non-negative muscle recruitment for a requested joint torque vector. */
export function solveMuscleActivations(options: MuscleAllocationOptions): Float64Array {
  const { targetTorques, passiveTorques, muscleBasis, baseline, dofs } = options;
  if (muscleBasis.length !== baseline.length) throw new Error('muscle basis and baseline counts must match');
  if (targetTorques.length !== passiveTorques.length) throw new Error('target and passive torque vectors must match');
  const weights = options.weights ?? dofs.map(() => 1);
  if (weights.length !== dofs.length) throw new Error('joint weight and dof counts must match');
  const regularization = options.regularization ?? 12;
  const activations = Float64Array.from(baseline, (value) => Math.max(0, Math.min(1, value)));
  const response = muscleBasis.map((muscle) => Float64Array.from(dofs, (dof) => muscle.momentArms[dof] * muscle.activeForce));
  const residual = Float64Array.from(dofs, (dof) => targetTorques[dof] - passiveTorques[dof]);
  const passes = options.iterations ?? 12;

  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < activations.length; i++) {
      let gradient = regularization * (activations[i] - baseline[i]);
      let curvature = regularization;
      for (let j = 0; j < dofs.length; j++) {
        const weightedResponse = response[i][j] * weights[j];
        let remaining = residual[j];
        for (let muscle = 0; muscle < activations.length; muscle++) remaining -= response[muscle][j] * activations[muscle];
        gradient -= weightedResponse * remaining * weights[j];
        curvature += weightedResponse * weightedResponse;
      }
      activations[i] = Math.max(0, Math.min(1, activations[i] - gradient / curvature));
    }
  }
  return activations;
}
