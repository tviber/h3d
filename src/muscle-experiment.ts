import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type MuscleController, type TrajectoryController, validateController, validateTrajectoryController } from './motor-control.ts';
import type { MuscleDefinition } from './muscle-model.ts';

export interface MotionPhase {
  label: string;
  start: number;
  end: number;
}

export interface MuscleExperiment {
  id: string;
  label: string;
  modelPath: string;
  duration: number;
  initialPoseRad: Record<string, number>;
  muscles: MuscleDefinition[];
  controllers: MuscleController[];
  feedback?: TrajectoryController;
  phases?: MotionPhase[];
  rig: { kind: 'elbow' | 'shoulder-elbow' | 'lower-body' };
}

export function loadMuscleExperiments(configPath: string, requestedIds?: readonly string[]): MuscleExperiment[] {
  const file = JSON.parse(readFileSync(configPath, 'utf8')) as {
    experiments: (Omit<MuscleExperiment, 'modelPath'> & { model: string })[];
  };
  if (!Array.isArray(file.experiments) || file.experiments.length === 0) throw new Error('muscle experiment config must contain experiments');
  const ids = new Set<string>();
  const experiments = file.experiments.map((entry): MuscleExperiment => {
    if (!entry.id || ids.has(entry.id)) throw new Error(`missing or duplicate experiment id "${entry.id}"`);
    ids.add(entry.id);
    if (!(entry.duration > 0) || !Number.isFinite(entry.duration)) throw new Error(`${entry.id}: duration must be positive`);
    if (!['elbow', 'shoulder-elbow', 'lower-body'].includes(entry.rig?.kind)) throw new Error(`${entry.id}: unsupported rig kind`);
    if (entry.muscles.length === 0 || entry.muscles.length !== entry.controllers.length) throw new Error(`${entry.id}: every muscle needs one controller`);
    const muscleNames = entry.muscles.map((muscle) => muscle.name);
    if (new Set(muscleNames).size !== muscleNames.length) throw new Error(`${entry.id}: muscle names must be unique`);
    entry.controllers.forEach((controller, i) => {
      validateController(controller);
      if (controller.muscle !== muscleNames[i]) throw new Error(`${entry.id}: controller order must match muscle order`);
    });
    if (entry.feedback) {
      validateTrajectoryController(entry.feedback);
      if (entry.feedback.keyframes.at(-1)!.time > entry.duration) throw new Error(`${entry.id}: trajectory extends beyond experiment duration`);
    }
    if (entry.phases) {
      let previousEnd = 0;
      for (const phase of entry.phases) {
        if (!phase.label || !Number.isFinite(phase.start) || !Number.isFinite(phase.end) || phase.start < previousEnd || phase.end <= phase.start || phase.end > entry.duration) {
          throw new Error(`${entry.id}: motion phases must be ordered, non-overlapping intervals within the duration`);
        }
        previousEnd = phase.end;
      }
    }
    return { ...entry, modelPath: resolve(dirname(configPath), entry.model) };
  });
  if (!requestedIds) return experiments;
  const byName = new Map(experiments.map((experiment) => [experiment.id, experiment]));
  return requestedIds.map((id) => {
    const experiment = byName.get(id);
    if (!experiment) throw new Error(`unknown muscle experiment "${id}" (have: ${experiments.map((e) => e.id).join(', ')})`);
    return experiment;
  });
}

export const DEFAULT_MUSCLE_CONFIG = new URL('../experiments/muscle-demo.json', import.meta.url);
