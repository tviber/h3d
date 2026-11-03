// Loads a config, runs every experiment on one shared MjModel, and summarizes the runs.
import { readFileSync } from 'node:fs';
import { type Experiment, loadExperiments } from './experiment.ts';
import { type MjModel, type Mujoco, getMujoco, loadModel } from './mujoco.ts';
import { summarize, type Summary } from './analysis.ts';
import { actuatedJoints, col, type Recording, simulate } from './simulate.ts';

export const H3D_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export interface JointInfo {
  name: string;
  /** Torque capacity, N*m (applied torque = gear * clamp(ctrl, -1, 1)). */
  gear: number;
  rangeDeg: [number, number];
  damping: number;
  stiffness: number;
}

export interface ModelInfo {
  path: string;
  mujocoVersion: string;
  timestep: number;
  integrator: string;
  totalMass: number;
  bodies: { name: string; mass: number }[];
  joints: JointInfo[];
}

export interface RunResult {
  experiment: Experiment;
  recording: Recording;
  summary: Summary;
}

export interface Batch {
  h3dVersion: string;
  model: ModelInfo;
  results: RunResult[];
}

export function describeModel(mj: Mujoco, model: MjModel, path: string): ModelInfo {
  const integrators = ['Euler', 'RK4', 'implicit', 'implicitfast', 'discrete'];
  const bodies = [];
  for (let b = 1; b < model.nbody; b++) bodies.push({ name: mj.mj_id2name(model, mj.mjtObj.mjOBJ_BODY.value, b), mass: model.body_mass[b] });
  return {
    path,
    mujocoVersion: mj.mj_versionString(),
    timestep: model.opt.timestep,
    integrator: integrators[model.opt.integrator] ?? String(model.opt.integrator),
    totalMass: mj.mj_getTotalmass(model),
    bodies,
    joints: actuatedJoints(mj, model).map((j) => {
      const jntId = model.dof_jntid[j.dofAdr];
      return { name: j.name, gear: j.gear, rangeDeg: j.rangeDeg, damping: model.dof_damping[j.dofAdr], stiffness: model.jnt_stiffness[jntId] };
    }),
  };
}

/** Experiment ids to run: all of them, or the requested subset (unknown ids are an error). */
function select(experiments: Experiment[], only?: string[]): Experiment[] {
  if (!only) return experiments;
  return only.map((id) => {
    const e = experiments.find((x) => x.id === id);
    if (!e) throw new Error(`unknown experiment "${id}" (have: ${experiments.map((x) => x.id).join(', ')})`);
    return e;
  });
}

export async function runBatch(configPath: string, opts: { duration?: number; only?: string[] } = {}): Promise<Batch> {
  const experiments = select(loadExperiments(configPath, { duration: opts.duration }), opts.only);
  const modelPaths = new Set(experiments.map((e) => e.modelPath));
  if (modelPaths.size !== 1) throw new Error('all experiments in a config must use the same model');
  const [modelPath] = modelPaths;

  const mj = await getMujoco();
  const model = loadModel(mj, modelPath);
  try {
    const info = describeModel(mj, model, modelPath);
    const gears = Object.fromEntries(info.joints.map((j) => [j.name, j.gear]));
    const results = experiments.map((experiment) => {
      const recording = simulate(mj, model, experiment);
      return { experiment, recording, summary: summarize(recording, { id: experiment.id, label: experiment.label, gears }) };
    });
    return { h3dVersion: H3D_VERSION, model: info, results };
  } finally {
    model.delete();
  }
}

/**
 * Joints whose commanded torque series is bitwise identical in every run of the batch,
 * and which are actually driven (non-zero somewhere). For the A/B/C config these are
 * the arm joints: the controlled variable of the experiment.
 */
export function sharedInputs(results: readonly RunResult[]): string[] {
  if (results.length < 2) return [];
  const joints = results[0].recording.joints;
  return joints.filter((j) => {
    const ref = col(results[0].recording, `tau_cmd_${j}`);
    if (!ref.some((v) => v !== 0)) return false;
    return results.every((r) => {
      const c = col(r.recording, `tau_cmd_${j}`);
      return c.length === ref.length && c.every((v, k) => v === ref[k]);
    });
  });
}
