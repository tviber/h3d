#!/usr/bin/env node
// h3d command line: run experiments, write results, render comparison charts.
import { basename, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validationFailures } from './analysis.ts';
import { writeCharts } from './charts.ts';
import { getMujoco, loadModel } from './mujoco.ts';
import { writeComparison, writeRuns } from './report.ts';
import { type Batch, describeModel, H3D_VERSION, runBatch } from './runner.ts';

const DEFAULT_CONFIG = fileURLToPath(new URL('../experiments/abc.json', import.meta.url));
const DEFAULT_MODEL = fileURLToPath(new URL('../models/upper_body.xml', import.meta.url));

const USAGE = `h3d ${H3D_VERSION}: torque-driven human kinetic-chain simulator (MuJoCo)

Usage:
  h3d compare [--config <json>] [--out <dir>] [--duration <s>] [--no-png]
      Run every experiment in the config on the same model, write per-run CSV/JSON,
      comparison.json, report.md and PNG charts.
  h3d run <id>... [--config <json>] [--out <dir>] [--duration <s>]
      Run selected experiments only and write their CSV/JSON.
  h3d info [--model <xml>]
      Print bodies, masses, joints and actuator capacities of a model.

Defaults: --config experiments/abc.json, --out out/<config name>.
Exit status: 0 = ok, 1 = a self-check failed, 2 = usage or input error.`;

const rel = (p: string): string => relative(process.cwd(), p) || '.';

function printSummary(batch: Batch): boolean {
  const base = batch.results[0].summary;
  let ok = true;
  console.log('run  peak |v_head|   t_peak    vs first   checks');
  for (const { summary: s } of batch.results) {
    const fails = validationFailures(s);
    ok &&= fails.length === 0;
    const vs = s === base ? 'baseline' : `${s.peakHeadSpeed >= base.peakHeadSpeed ? '+' : ''}${((s.peakHeadSpeed / base.peakHeadSpeed - 1) * 100).toFixed(1)}%`;
    console.log(
      `${s.id.padEnd(4)} ${`${s.peakHeadSpeed.toFixed(2)} m/s`.padStart(11)}   ${`${s.tPeak.toFixed(4)} s`.padStart(8)}  ${vs.padStart(9)}   ${fails.length ? `FAIL ${fails.join(',')}` : 'pass'}   ${s.label}`,
    );
  }
  return ok;
}

async function info(modelPath: string): Promise<void> {
  const mj = await getMujoco();
  const model = loadModel(mj, modelPath);
  try {
    const m = describeModel(mj, model, modelPath);
    console.log(`model ${rel(m.path)}  MuJoCo ${m.mujocoVersion}  ${m.integrator}  dt=${m.timestep} s  moving mass ${m.totalMass.toFixed(3)} kg`);
    console.log('\nbody            mass (kg)');
    for (const b of m.bodies) console.log(`${b.name.padEnd(15)} ${b.mass.toFixed(3).padStart(9)}`);
    console.log('\njoint           gear = max torque (N*m)   range (deg)      damping (N*m*s/rad)   stiffness (N*m/rad)');
    for (const j of m.joints) {
      console.log(`${j.name.padEnd(15)} ${String(j.gear).padStart(22)}   ${`${j.rangeDeg[0].toFixed(0)}..${j.rangeDeg[1].toFixed(0)}`.padEnd(15)}  ${String(j.damping).padStart(19)}   ${String(j.stiffness).padStart(19)}`);
    }
  } finally {
    model.delete();
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      out: { type: 'string' },
      duration: { type: 'string' },
      model: { type: 'string' },
      'no-png': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  if (command === 'info') {
    await info(resolve(values.model ?? DEFAULT_MODEL));
    return 0;
  }
  if (command !== 'compare' && command !== 'run') throw new UsageError(`unknown command "${command}"`);
  if (command === 'run' && rest.length === 0) throw new UsageError('run needs at least one experiment id');

  const config = resolve(values.config ?? DEFAULT_CONFIG);
  const out = resolve(values.out ?? `out/${basename(config, extname(config))}`);
  let duration: number | undefined;
  if (values.duration !== undefined) {
    duration = Number(values.duration);
    if (!(duration > 0)) throw new UsageError(`--duration must be a positive number of seconds, got "${values.duration}"`);
  }

  const t0 = performance.now();
  const batch = await runBatch(config, { duration, only: command === 'run' ? rest : undefined });
  const simMs = performance.now() - t0;
  const files = writeRuns(batch, out);
  if (command === 'compare') {
    const charts = values['no-png'] ? [] : writeCharts(batch.results, out);
    files.push(...writeComparison(batch, config, out, charts.map((c) => basename(c))), ...charts);
  }

  console.log(`h3d ${H3D_VERSION}  config ${rel(config)}  MuJoCo ${batch.model.mujocoVersion}  dt=${batch.model.timestep} s  ${batch.results.length} run(s) in ${simMs.toFixed(0)} ms\n`);
  const ok = printSummary(batch);
  console.log(`\nwrote ${files.length} files to ${rel(out)}/`);
  for (const f of files) console.log(`  ${basename(f)}`);
  if (!ok) console.error('\nself-check failed: see the validation fields in the summary JSON');
  return ok ? 0 : 1;
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const usage = err instanceof UsageError || (err instanceof TypeError && 'code' in err && String(err.code).startsWith('ERR_PARSE_ARGS'));
    console.error(`h3d: ${err instanceof Error ? err.message : String(err)}`);
    if (usage) console.error('run "h3d --help" for usage');
    process.exit(2);
  },
);
