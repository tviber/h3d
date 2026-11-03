// Structured outputs of a batch: per-run CSV time series and JSON summaries,
// comparison.json (all runs + differences vs the first run) and report.md.
// Nothing here depends on wall-clock time, so identical inputs give identical files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type Summary, VALIDATION_LIMITS, validationFailures } from './analysis.ts';
import { type Batch, type RunResult, sharedInputs } from './runner.ts';
import type { Recording } from './simulate.ts';

/** CSV with one row per sample; values keep 10 significant digits. */
export function toCsv(rec: Recording): string {
  const names = [...rec.columns.keys()];
  const cols = names.map((n) => rec.columns.get(n)!);
  const fmt = (v: number): string => String(Number(v.toPrecision(10)));
  const lines = [names.join(',')];
  for (let k = 0; k < rec.n; k++) lines.push(cols.map((c) => fmt(c[k])).join(','));
  return lines.join('\n') + '\n';
}

export interface Comparison {
  id: string;
  vs: string;
  peakHeadSpeedDiff: number;
  peakHeadSpeedRatio: number;
  tPeakDiff: number;
  totalWorkAtPeakDiff: number;
}

const totalWorkAtPeak = (s: Summary): number => s.joints.reduce((a, j) => a + j.workAtPeak, 0);

export function compareRuns(results: readonly RunResult[]): Comparison[] {
  const base = results[0].summary;
  return results.slice(1).map(({ summary: s }) => ({
    id: s.id,
    vs: base.id,
    peakHeadSpeedDiff: s.peakHeadSpeed - base.peakHeadSpeed,
    peakHeadSpeedRatio: s.peakHeadSpeed / base.peakHeadSpeed,
    tPeakDiff: s.tPeak - base.tPeak,
    totalWorkAtPeakDiff: totalWorkAtPeak(s) - totalWorkAtPeak(base),
  }));
}

/** Everything a reader needs to reproduce and compare the batch, without the time series. */
export function comparisonJson(batch: Batch, configPath: string) {
  return {
    h3dVersion: batch.h3dVersion,
    config: relPath(configPath),
    model: { ...batch.model, path: relPath(batch.model.path) },
    sharedCommandedTorques: sharedInputs(batch.results),
    validationLimits: VALIDATION_LIMITS,
    runs: batch.results.map((r) => ({
      id: r.experiment.id,
      label: r.experiment.label,
      pulseSets: r.experiment.use,
      initialPoseDeg: r.experiment.initialPoseDeg,
      pulses: r.experiment.pulses,
      validationFailures: validationFailures(r.summary),
      summary: r.summary,
    })),
    comparisons: compareRuns(batch.results),
  };
}

const relPath = (p: string): string => relative(process.cwd(), p) || '.';
const f = (v: number, d = 2): string => (Math.abs(v) < 0.5 * 10 ** -d ? (0).toFixed(d) : v.toFixed(d));
const pct = (ratio: number): string => `${ratio >= 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(1)}%`;

function table(head: string[], rows: (string | number)[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export function reportMarkdown(batch: Batch, configPath: string, charts: string[]): string {
  const runs = batch.results.map((r) => r.summary);
  const ids = runs.map((s) => s.id);
  const joints = batch.results[0].recording.joints;
  const base = runs[0];
  const shared = sharedInputs(batch.results);
  const jointRow = (name: string, pick: (s: Summary, j: number) => string) =>
    [name, ...runs.map((s) => pick(s, s.joints.findIndex((x) => x.joint === name)))];
  const m = batch.model;

  const out = [
    `# h3d ${batch.h3dVersion} comparison report`,
    '',
    `Config \`${relPath(configPath)}\`, model \`${relPath(m.path)}\` (${m.totalMass.toFixed(3)} kg of moving segments, legs fixed), ` +
      `MuJoCo ${m.mujocoVersion}, ${m.integrator}, dt = ${m.timestep * 1000} ms, duration ${base.duration} s.`,
    '',
    `Commanded torques bitwise identical in ${ids.join(', ')}: ${shared.length ? shared.map((j) => `\`${j}\``).join(', ') : '(none)'}.`,
    '',
    '## Peak racket-head speed',
    '',
    table(
      ['run', 'description', 'peak \\|v_head\\| (m/s)', `vs ${base.id}`, 't_peak (s)', 'butt speed at t_peak (m/s)', 'peak \\|a_head\\| (m/s^2)', 'L_z at t_peak (kg m^2/s)'],
      runs.map((s) => [
        s.id, s.label, f(s.peakHeadSpeed), s === base ? 'baseline' : pct(s.peakHeadSpeed / base.peakHeadSpeed),
        f(s.tPeak, 4), f(s.buttSpeedAtPeak), f(s.peakHeadAcc, 0), f(s.angMomentumAtPeak),
      ]),
    ),
    '',
    '## Actuator work from t = 0 to t_peak (J)',
    '',
    table(['joint', ...ids], [
      ...joints.map((j) => jointRow(j, (s, i) => f(s.joints[i].workAtPeak, 1))),
      ['**total**', ...runs.map((s) => `**${f(totalWorkAtPeak(s), 1)}**`)],
    ]),
    '',
    '## Peak actuator power (W)',
    '',
    table(['joint', ...ids], joints.map((j) => jointRow(j, (s, i) => f(s.joints[i].maxPower, 0)))),
    '',
    '## Share of the head speed at t_peak (m/s)',
    '',
    'Each joint contributes qvel_i * (J_i . v_hat) to |v_head|; the column sums to the peak speed.',
    '',
    table(['joint', ...ids], [
      ...joints.map((j) => jointRow(j, (s, i) => f(s.joints[i].headSpeedFromAtPeak))),
      ['**sum**', ...runs.map((s) => `**${f(s.joints.reduce((a, j) => a + j.headSpeedFromAtPeak, 0))}**`)],
    ]),
    '',
    '## Joint angle (deg) and velocity (rad/s) at t_peak',
    '',
    table(['joint', ...ids], joints.map((j) => jointRow(j, (s, i) => `${f(s.joints[i].angleAtPeakDeg, 1)} / ${f(s.joints[i].velocityAtPeak, 1)}`))),
    '',
    '## Energy balance from t = 0 to t_peak (J)',
    '',
    'W_actuator + W_damper + W_limit = dKE + dPE (dPE is the spine spring; gravity does no work in this planar chain).',
    '',
    table(
      ['run', 'W_actuator', 'W_damper', 'W_limit', 'dKE', 'dPE', 'residual'],
      runs.map((s) => {
        const e = s.energyAtPeak;
        return [s.id, f(e.actuatorWork), f(e.damperWork), f(e.limitWork), f(e.deltaKinetic), f(e.deltaPotential), f(e.residual, 3)];
      }),
    ),
    '',
    '## Joint-limit contact',
    '',
    'Joint limits are soft constraints; their work before t_peak is energy taken out of the swing.',
    '',
    table(['joint', ...ids], joints.map((j) => jointRow(j, (s, i) => {
      const x = s.joints[i];
      return x.firstLimitTime === null ? 'none' : `from ${f(x.firstLimitTime, 3)} s, ${f(x.limitWorkAtPeak, 1)} J`;
    }))),
    '',
    '## Self-checks',
    '',
    table(
      ['run', `velocity: Jacobian vs FD (<= ${VALIDATION_LIMITS.velocityFdRelErr})`, `acceleration: vs FD, RMS (<= ${VALIDATION_LIMITS.accelFdRelErr})`,
        `energy residual (<= ${VALIDATION_LIMITS.energyResidualRel})`, `L_z vs root impulse (<= ${VALIDATION_LIMITS.momentumResidualRel})`, 'result'],
      runs.map((s) => {
        const v = s.validation, fails = validationFailures(s);
        return [s.id, v.velocityFdRelErr.toExponential(2), v.accelFdRelErr.toExponential(2), v.energyResidualRel.toExponential(2),
          v.momentumResidualRel.toExponential(2), fails.length ? `FAIL: ${fails.join(', ')}` : 'pass'];
      }),
    ),
  ];
  if (charts.length) out.push('', '## Charts', '', ...charts.map((c) => `![${c}](${c})`));
  return out.join('\n') + '\n';
}

/** Per-run CSV + JSON. Returns the written file paths. */
export function writeRuns(batch: Batch, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  return batch.results.flatMap((r) => {
    const csv = join(outDir, `${r.experiment.id}.timeseries.csv`);
    const json = join(outDir, `${r.experiment.id}.summary.json`);
    writeFileSync(csv, toCsv(r.recording));
    writeFileSync(json, JSON.stringify({ h3dVersion: batch.h3dVersion, experiment: { ...r.experiment, modelPath: relPath(r.experiment.modelPath) }, summary: r.summary }, null, 2) + '\n');
    return [csv, json];
  });
}

export function writeComparison(batch: Batch, configPath: string, outDir: string, charts: string[]): string[] {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, 'comparison.json');
  const md = join(outDir, 'report.md');
  writeFileSync(json, JSON.stringify(comparisonJson(batch, configPath), null, 2) + '\n');
  writeFileSync(md, reportMarkdown(batch, configPath, charts));
  return [json, md];
}
