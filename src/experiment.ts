// Experiment configuration (JSON). Experiments are composed from named pulse
// sets, so A/B/C can share the *same* arm pulse objects by construction.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type Pulse, validatePulse } from './control.ts';

export interface ExperimentConfig {
  /** MJCF path, relative to the config file. */
  model: string;
  /** Simulated time, s. */
  duration: number;
  /** Initial joint angles, degrees (missing joints start at 0). Initial velocities are zero. */
  initialPoseDeg: Record<string, number>;
  pulseSets: Record<string, Pulse[]>;
  experiments: { id: string; label: string; use: string[] }[];
}

export interface Experiment {
  id: string;
  label: string;
  modelPath: string;
  duration: number;
  initialPoseDeg: Record<string, number>;
  /** Names of the pulse sets this experiment is made of. */
  use: string[];
  pulses: Pulse[];
}

export function loadExperiments(configPath: string, overrides: { duration?: number } = {}): Experiment[] {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as ExperimentConfig;
  const duration = overrides.duration ?? cfg.duration;
  if (!(duration > 0)) throw new Error('duration must be > 0');
  for (const pulses of Object.values(cfg.pulseSets)) pulses.forEach(validatePulse);
  const ids = new Set<string>();
  return cfg.experiments.map((e) => {
    if (ids.has(e.id)) throw new Error(`duplicate experiment id "${e.id}"`);
    ids.add(e.id);
    const pulses = e.use.flatMap((name) => {
      const set = cfg.pulseSets[name];
      if (!set) throw new Error(`experiment ${e.id}: unknown pulse set "${name}"`);
      return set;
    });
    return {
      id: e.id,
      label: e.label,
      modelPath: resolve(dirname(configPath), cfg.model),
      duration,
      initialPoseDeg: cfg.initialPoseDeg,
      use: e.use,
      pulses,
    };
  });
}
