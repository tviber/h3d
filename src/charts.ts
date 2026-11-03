// PNG comparison charts, drawn straight from the recorded simulation columns.
// Experiment i always gets categorical slot i, so a run keeps its colour on every chart.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Canvas, type Rect } from './plot/raster.ts';
import {
  type Domain, FONT, formatTick, INK, LINE_H, type LegendItem, legend, niceDomain, type Obstacles, placeLabel, Plot,
  SERIES_COLORS, ticks, title,
} from './plot/chart.ts';
import { type RunResult, sharedInputs } from './runner.ts';
import { col } from './simulate.ts';

const W = 1200;
const LEFT = 104;
const RIGHT = 48;

function color(i: number): string {
  const c = SERIES_COLORS[i];
  if (!c) throw new Error(`charts support at most ${SERIES_COLORS.length} experiments per comparison`);
  return c;
}

const legendItems = (results: readonly RunResult[]): LegendItem[] =>
  results.map((r, i) => ({ label: `${r.summary.id}  ${r.summary.label}`, color: color(i) }));

/** Title, subtitle and an optional one-run-per-row legend. Returns the first free y. */
function header(c: Canvas, text: string, subtitle: string, items?: LegendItem[], key: 'line' | 'swatch' = 'line'): number {
  title(c, text, subtitle);
  let y = 24 + 2 * LINE_H + 8;
  if (items) y += 20 + legend(c, 32, y + 20, items, { key, layout: 'column' });
  return y + 28;
}

/** Sample index of the peak-head-speed instant of a run. */
const peakIndex = (r: RunResult): number => Math.round(r.summary.tPeak / r.recording.dt);

function extent(results: readonly RunResult[], column: (r: RunResult) => Float64Array): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const r of results) for (const v of column(r)) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

const timeDomain = (results: readonly RunResult[]): Domain => niceDomain(0, Math.max(...results.map((r) => r.summary.duration)), 6);

/** Racket-head speed vs time for every run, with a labelled marker at each peak. */
export function headSpeedChart(results: readonly RunResult[]): Canvas {
  const H = 700;
  const c = new Canvas(W, H, INK.surface);
  const y0 = header(c, 'Racket-head speed', 'String-bed centre speed |Jp * qvel|. Same arm torques in every run; dot = peak.', legendItems(results));
  const rect: Rect = { x: LEFT, y: y0 + LINE_H + 12, w: W - LEFT - RIGHT, h: 0 };
  rect.h = H - rect.y - 64;
  const maxPeak = Math.max(...results.map((r) => r.summary.peakHeadSpeed));
  const plot = new Plot(c, rect, timeDomain(results), niceDomain(0, maxPeak * 1.12, 7));
  plot.frame({ yUnit: 'm/s', xUnit: 'time (s)' });

  const obstacles: Obstacles = { lines: [], boxes: [] };
  results.forEach((r, i) => obstacles.lines.push(plot.line(col(r.recording, 'time'), col(r.recording, 'head_speed'), color(i))));
  const peaks = results.map((r) => ({ x: plot.sx(r.summary.tPeak), y: plot.sy(r.summary.peakHeadSpeed) }));
  peaks.forEach((p, i) => {
    c.marker(p.x, p.y, color(i), INK.surface);
    obstacles.boxes.push({ x: p.x - 8, y: p.y - 8, w: 16, h: 16 });
  });
  results.forEach((r, i) => {
    const s = r.summary;
    placeLabel(c, `${s.id} ${s.peakHeadSpeed.toFixed(2)} m/s at ${s.tPeak.toFixed(3)} s`, peaks[i].x, peaks[i].y, rect, obstacles);
  });
  return c;
}

/** Horizontal bars of the peak head speed, each labelled with its value and its change vs the first run. */
export function peakSpeedChart(results: readonly RunResult[]): Canvas {
  const barH = 24, rowH = LINE_H + 8 + barH + 24;
  const H = 120 + results.length * rowH + 48;
  const c = new Canvas(W, H, INK.surface);
  const base = results[0].summary;
  const y0 = header(c, 'Peak racket-head speed', `Maximum of |v_head| over the run. Percentages are relative to run ${base.id}.`);
  const rect: Rect = { x: 48, y: y0 + 8, w: W - 48 - 340, h: results.length * rowH };
  const x = niceDomain(0, Math.max(...results.map((r) => r.summary.peakHeadSpeed)), 6);
  const sx = (v: number): number => rect.x + ((v - x.lo) / (x.hi - x.lo)) * rect.w;

  for (const v of ticks(x)) {
    c.vline(sx(v), rect.y, rect.y + rect.h, v === 0 ? INK.axis : INK.grid);
    c.text(formatTick(v, x.step), sx(v), rect.y + rect.h + 10, INK.muted, FONT, 'center');
  }
  c.text('m/s', rect.x + rect.w, rect.y + rect.h + 24 + LINE_H, INK.muted, FONT, 'right');

  results.forEach((r, i) => {
    const s = r.summary, top = rect.y + i * rowH + 8;
    c.text(`${s.id}  ${s.label}`, rect.x, top, INK.primary, FONT);
    const by = top + LINE_H + 8;
    c.bar({ x: sx(0), y: by, w: sx(s.peakHeadSpeed) - sx(0), h: barH }, color(i), 'right');
    const delta = i === 0 ? 'baseline' : `${s.peakHeadSpeed >= base.peakHeadSpeed ? '+' : ''}${((s.peakHeadSpeed / base.peakHeadSpeed - 1) * 100).toFixed(1)}% vs ${base.id}`;
    c.text(`${s.peakHeadSpeed.toFixed(2)} m/s  ${delta}`, sx(s.peakHeadSpeed) + 10, by + (barH - LINE_H) / 2, INK.primary, FONT);
  });
  return c;
}

interface PanelSpec {
  column: string;
  title: string;
  subtitle: string;
  unit: string;
  /** Short note printed at the top right of a joint's panel. */
  note?: (joint: string) => string | undefined;
}

/** One panel per actuated joint, shared time axis, every run overlaid; dot = value at that run's peak instant. */
function jointPanels(results: readonly RunResult[], spec: PanelSpec): Canvas {
  const joints = results[0].recording.joints;
  const panelH = 112, headH = LINE_H + 14, gap = 26;
  const top = 200;
  const H = top + joints.length * (headH + panelH + gap) + 40;
  const c = new Canvas(W, H, INK.surface);
  const y0 = header(c, spec.title, spec.subtitle, legendItems(results));
  if (y0 > top) throw new Error('chart header taller than reserved space');
  const x = timeDomain(results);

  joints.forEach((j, p) => {
    const rect: Rect = { x: LEFT, y: top + p * (headH + panelH + gap) + headH, w: W - LEFT - RIGHT, h: panelH };
    const [lo, hi] = extent(results, (r) => col(r.recording, `${spec.column}_${j}`));
    const plot = new Plot(c, rect, x, niceDomain(lo, hi, 4));
    plot.frame({ yUnit: '', xUnit: 'time (s)', xTickLabels: p === joints.length - 1 });
    c.text(j, rect.x - 10, rect.y - headH, INK.primary, FONT);
    c.text(`(${spec.unit})`, rect.x - 10 + Canvas.textWidth(j, FONT) + 12, rect.y - headH, INK.muted, FONT);
    const note = spec.note?.(j);
    if (note) c.text(note, rect.x + rect.w, rect.y - headH, INK.secondary, FONT, 'right');
    results.forEach((r, i) => plot.line(col(r.recording, 'time'), col(r.recording, `${spec.column}_${j}`), color(i)));
    results.forEach((r, i) => {
      const k = peakIndex(r);
      c.marker(plot.sx(r.summary.tPeak), plot.sy(col(r.recording, `${spec.column}_${j}`)[k]), color(i), INK.surface, 4);
    });
  });
  return c;
}

export function jointPowerChart(results: readonly RunResult[]): Canvas {
  return jointPanels(results, {
    column: 'power',
    title: 'Joint actuator power',
    subtitle: 'P = qfrc_actuator * qvel per joint. Dot = value at the peak-head-speed instant of that run.',
    unit: 'W',
  });
}

export function jointTorqueChart(results: readonly RunResult[]): Canvas {
  const shared = new Set(sharedInputs(results));
  const ids = results.map((r) => r.summary.id).join(', ');
  return jointPanels(results, {
    column: 'tau_act',
    title: 'Applied joint torque (model input)',
    subtitle: 'qfrc_actuator = gear * clamp(ctrl, -1, 1). Identical curves overlap (last run on top).',
    unit: 'N*m',
    note: (j) => (shared.has(j) ? `identical in ${ids}` : undefined),
  });
}

/** Grouped horizontal bars: actuator work per joint (plus the total) from t = 0 to each run's peak instant. */
export function jointWorkChart(results: readonly RunResult[]): Canvas {
  const joints = results[0].recording.joints;
  const groups = [...joints, 'total'];
  const value = (r: RunResult, g: string): number =>
    g === 'total' ? r.summary.joints.reduce((s, j) => s + j.workAtPeak, 0) : r.summary.joints.find((j) => j.joint === g)!.workAtPeak;

  const barH = 18, barGap = 2, groupGap = 22;
  const groupH = results.length * barH + (results.length - 1) * barGap + groupGap;
  const top = 200;
  const H = top + groups.length * groupH + 60;
  const c = new Canvas(W, H, INK.surface);
  const y0 = header(c, 'Actuator work up to peak head speed', 'W = sum of tau_k * (q_k+1 - q_k) from t = 0 to t_peak of each run.', legendItems(results), 'swatch');
  if (y0 > top) throw new Error('chart header taller than reserved space');

  const labelW = Math.max(...groups.map((g) => Canvas.textWidth(g, FONT))) + 24;
  const rect: Rect = { x: 32 + labelW, y: top, w: W - 32 - labelW - 200, h: groups.length * groupH - groupGap };
  const all = results.flatMap((r) => groups.map((g) => value(r, g)));
  const x = niceDomain(Math.min(...all), Math.max(...all), 6);
  const sx = (v: number): number => rect.x + ((v - x.lo) / (x.hi - x.lo)) * rect.w;

  for (const v of ticks(x)) {
    c.vline(sx(v), rect.y - 8, rect.y + rect.h + 8, Math.abs(v) < 1e-12 ? INK.axis : INK.grid);
    c.text(formatTick(v, x.step), sx(v), rect.y + rect.h + 16, INK.muted, FONT, 'center');
  }
  c.text('J', rect.x + rect.w, rect.y + rect.h + 30 + LINE_H, INK.muted, FONT, 'right');

  groups.forEach((g, gi) => {
    const gy = rect.y + gi * groupH;
    c.text(g, 32, gy + (results.length * (barH + barGap) - barGap - LINE_H) / 2, g === 'total' ? INK.primary : INK.secondary, FONT);
    results.forEach((r, i) => {
      const v = value(r, g), by = gy + i * (barH + barGap);
      const x0 = sx(0), x1 = sx(v);
      if (Math.abs(x1 - x0) >= 0.5) {
        c.bar({ x: Math.min(x0, x1), y: by, w: Math.abs(x1 - x0), h: barH }, color(i), v >= 0 ? 'right' : 'left');
      }
      const text = `${r.summary.id} ${v.toFixed(1)}`;
      const ty = by + (barH - LINE_H) / 2;
      if (v >= 0) c.text(text, Math.max(x0, x1) + 8, ty, INK.primary, FONT);
      else c.text(text, Math.min(x0, x1) - 8, ty, INK.primary, FONT, 'right');
    });
  });
  return c;
}

export const CHARTS = {
  'head_speed.png': headSpeedChart,
  'peak_head_speed.png': peakSpeedChart,
  'joint_power.png': jointPowerChart,
  'joint_work.png': jointWorkChart,
  'joint_torque.png': jointTorqueChart,
} as const;

/** Renders every chart into `outDir`; returns the written file paths. */
export function writeCharts(results: readonly RunResult[], outDir: string): string[] {
  return Object.entries(CHARTS).map(([file, render]) => {
    const path = join(outDir, file);
    writeFileSync(path, render(results).toPng());
    return path;
  });
}
