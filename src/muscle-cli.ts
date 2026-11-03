import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_MUSCLE_CONFIG, loadMuscleExperiments } from './muscle-experiment.ts';
import { type MuscleRun, simulateMuscleExperiment, summarizeMuscleRun } from './muscle-simulate.ts';
import { toMotionClip } from './motion-clip.ts';
import { fileURLToPath } from 'node:url';
import { getMujoco, loadModel } from './mujoco.ts';

const usage = `h3d muscles: run the muscle-driven dynamics experiments\n\nUsage:\n  node src/muscle-cli.ts [--config experiments/muscle-demo.json] [--out web/demo-motion.json] [--only <id> ...]`;

async function main(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      out: { type: 'string' },
      only: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (parsed.values.help) {
    console.log(usage);
    return 0;
  }
  if (parsed.positionals.length) throw new Error(`unexpected arguments: ${parsed.positionals.join(' ')}`);
  const configPath = resolve(parsed.values.config ?? fileURLToPath(DEFAULT_MUSCLE_CONFIG));
  const outPath = resolve(parsed.values.out ?? fileURLToPath(new URL('../web/demo-motion.json', import.meta.url)));
  const experiments = loadMuscleExperiments(configPath, parsed.values.only);
  const mj = await getMujoco();
  const runs: MuscleRun[] = [];
  for (const experiment of experiments) {
    const model = loadModel(mj, experiment.modelPath);
    try {
      const recording = simulateMuscleExperiment(mj, model, experiment);
      runs.push({ experiment, recording, summary: summarizeMuscleRun(experiment, recording) });
    } finally {
      model.delete();
    }
  }
  const invalidRun = runs.find((run) => !run.summary.validation.trajectoryFinite);
  if (invalidRun) throw new Error(`${invalidRun.experiment.id}: trajectory contains non-finite or out-of-range values; motion export aborted`);
  mkdirSync(dirname(outPath), { recursive: true });
  const output = {
    schemaVersion: 'h3d.motion-set.v1',
    source: 'MuJoCo muscle-force experiments; rendered independently by the web viewer.',
    clips: runs.map((run) => toMotionClip(run.experiment, run.recording)),
  };
  writeFileSync(outPath, JSON.stringify(output) + '\n');
  for (const run of runs) {
    const saturated = run.summary.joints.filter((joint) => joint.saturated).map((joint) =>
      `${joint.name} ${joint.peakSaturationRatio.toFixed(2)}x (requested ${joint.peakRequestedTorque.toFixed(1)}, applied ${joint.peakAppliedTorque.toFixed(1)} N·m)`,
    ).join(', ') || 'none';
    const validation = run.summary.validation;
    console.log(`${run.experiment.id}: ${run.summary.joints.map((joint) => {
      const unit = run.recording.jointTypes[joint.name] === 'slide' ? 'm/s' : 'rad/s';
      return `${joint.name} ${joint.peakSpeed.toFixed(2)} ${unit}`;
    }).join(', ')}; ` +
      `${run.summary.muscles.map((muscle) => `${muscle.name} ${muscle.peakForce.toFixed(0)} N`).join(', ')}` +
      (run.experiment.rig.kind === 'lower-body' ? `; peak GRF ${run.summary.peakVerticalGroundReactionForce.toFixed(0)} N` : '') +
      `; saturated ${saturated}; checks armFD ${validation.momentArmFdMaxAbsErr.toExponential(1)} m, torque ${validation.torqueMatchMaxAbsErr.toExponential(1)} N·m, work ${validation.workConsistencyRelErr.toExponential(1)}; finite ${validation.trajectoryFinite}`);
  }
  console.log(`wrote ${runs.length} motion clip(s) to ${outPath}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`h3d muscles: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  },
);
