// Chart building blocks on top of the rasteriser: axes, gridlines, legend, labels.
// Colours: the dataviz reference palette (light mode). Categorical slots 1-3 were
// validated together with --pairs all (CVD dE 9.2, normal-vision dE 24.0); slot 3
// (aqua) is below 3:1 contrast, so every chart is direct-labelled and the report
// carries the same numbers as tables.
import { Canvas, type Color, type Rect } from './raster.ts';

export const INK = {
  surface: '#fcfcfb',
  primary: '#0b0b0b',
  secondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
} as const;

/** Categorical colours in fixed slot order; experiment i always gets slot i. */
export const SERIES_COLORS: readonly Color[] = ['#2a78d6', '#eb6834', '#1baf7a'];

/** Bitmap font scale used for all chart text (10 x 16 px glyph cells). */
export const FONT = 2;
export const LINE_H = Canvas.textHeight(FONT);

export interface Domain {
  lo: number;
  hi: number;
  step: number;
}

export function niceDomain(min: number, max: number, target = 5, includeZero = true): Domain {
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (!(max > min)) max = min + 1;
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.999) ?? 10 * mag;
  return { lo: Math.floor(min / step + 1e-9) * step, hi: Math.ceil(max / step - 1e-9) * step, step };
}

export function ticks(d: Domain): number[] {
  const out: number[] = [];
  const n = Math.round((d.hi - d.lo) / d.step);
  for (let i = 0; i <= n; i++) out.push(d.lo + i * d.step);
  return out;
}

/** Formats a tick value with just enough decimals for the step; never prints "-0". */
export function formatTick(v: number, step: number): string {
  let dec = 0;
  while (dec < 6 && Math.abs(Math.round(step * 10 ** dec) - step * 10 ** dec) > 1e-6) dec++;
  const s = v.toFixed(dec);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

export class Plot {
  readonly canvas: Canvas;
  readonly rect: Rect;
  readonly x: Domain;
  readonly y: Domain;

  constructor(canvas: Canvas, rect: Rect, x: Domain, y: Domain) {
    this.canvas = canvas;
    this.rect = rect;
    this.x = x;
    this.y = y;
  }

  sx(v: number): number {
    return this.rect.x + ((v - this.x.lo) / (this.x.hi - this.x.lo)) * this.rect.w;
  }

  sy(v: number): number {
    return this.rect.y + this.rect.h - ((v - this.y.lo) / (this.y.hi - this.y.lo)) * this.rect.h;
  }

  /** Recessive hairline grid, the zero baseline, tick labels, and unit labels. */
  frame(opts: { yUnit: string; xUnit?: string; xTickLabels?: boolean }): void {
    const c = this.canvas, r = this.rect;
    for (const v of ticks(this.y)) {
      const yy = this.sy(v);
      c.hline(r.x, r.x + r.w, yy, Math.abs(v) < 1e-12 ? INK.axis : INK.grid);
      c.text(formatTick(v, this.y.step), r.x - 10, yy - LINE_H / 2, INK.muted, FONT, 'right');
    }
    c.text(opts.yUnit, r.x - 10, r.y - LINE_H - 12, INK.muted, FONT, 'left');
    if (opts.xTickLabels ?? true) {
      for (const v of ticks(this.x)) c.text(formatTick(v, this.x.step), this.sx(v), r.y + r.h + 10, INK.muted, FONT, 'center');
      if (opts.xUnit) c.text(opts.xUnit, r.x + r.w, r.y + r.h + 14 + LINE_H, INK.muted, FONT, 'right');
    }
  }

  /** 2 px series line clipped to the plot area; returns its pixel coordinates. */
  line(xs: ArrayLike<number>, ys: ArrayLike<number>, color: Color): { xs: number[]; ys: number[] } {
    const px = Array.from(xs, (v) => this.sx(v));
    const py = Array.from(ys, (v) => this.sy(v));
    const r = this.rect;
    this.canvas.polyline(px, py, color, 2, { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 });
    return { xs: px, ys: py };
  }
}

/** Text on a surface-coloured plate so it stays legible where it crosses a line. */
export function label(c: Canvas, text: string, x: number, y: number, color: Color = INK.primary, align: 'left' | 'center' | 'right' = 'left'): void {
  const w = Canvas.textWidth(text, FONT);
  const left = align === 'left' ? x : align === 'center' ? x - w / 2 : x - w;
  c.rect({ x: left - 4, y: y - 3, w: w + 8, h: LINE_H + 6 }, INK.surface);
  c.text(text, x, y, color, FONT, align);
}

export interface LegendItem {
  label: string;
  color: Color;
}

/** Legend: a coloured key beside each label (label text stays in text ink). Returns its height. */
export function legend(
  c: Canvas, x: number, y: number, items: readonly LegendItem[],
  opts: { key?: 'line' | 'swatch'; layout?: 'row' | 'column' } = {},
): number {
  const key = opts.key ?? 'line', column = opts.layout === 'column';
  const rowH = LINE_H + 10;
  let cx = x, cy = y;
  for (const it of items) {
    const mid = cy + LINE_H / 2;
    let tx = cx;
    if (key === 'line') {
      c.line(cx, mid, cx + 22, mid, it.color, 2);
      c.disc(cx + 11, mid, 4, it.color);
      tx += 30;
    } else {
      c.bar({ x: cx, y: mid - 6, w: 12, h: 12 }, it.color, 'right', 2);
      tx += 20;
    }
    c.text(it.label, tx, cy, INK.secondary, FONT);
    if (column) cy += rowH;
    else cx = tx + Canvas.textWidth(it.label, FONT) + 28;
  }
  return column ? items.length * rowH - 10 : LINE_H;
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** What a direct label must not cover: plotted lines (pixel coordinates) and earlier labels. */
export interface Obstacles {
  lines: { xs: readonly number[]; ys: readonly number[] }[];
  boxes: Rect[];
}

/**
 * Direct label next to an anchor point (e.g. a peak marker). Tries above-right, above-left,
 * below-right, below-left and right, and takes the first spot that stays inside `bounds`
 * and clears every obstacle; falls back to the first candidate. The chosen plate is added
 * to `obstacles.boxes` so later labels avoid it.
 */
export function placeLabel(c: Canvas, text: string, ax: number, ay: number, bounds: Rect, obstacles: Obstacles, gap = 10): Rect {
  const w = Canvas.textWidth(text, FONT) + 8, h = LINE_H + 6;
  const candidates: Rect[] = [
    { x: ax + gap, y: ay - gap - h, w, h },
    { x: ax - gap - w, y: ay - gap - h, w, h },
    { x: ax + gap, y: ay + gap, w, h },
    { x: ax - gap - w, y: ay + gap, w, h },
    { x: ax + gap + 4, y: ay - h / 2, w, h },
  ];
  const clear = (r: Rect): boolean => {
    if (r.x < bounds.x || r.y < bounds.y || r.x + r.w > bounds.x + bounds.w || r.y + r.h > bounds.y + bounds.h) return false;
    const pad = { x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 };
    if (obstacles.boxes.some((b) => overlaps(pad, b))) return false;
    return obstacles.lines.every((l) => {
      for (let i = 0; i < l.xs.length; i++) {
        if (l.xs[i] >= pad.x && l.xs[i] <= pad.x + pad.w && l.ys[i] >= pad.y && l.ys[i] <= pad.y + pad.h) return false;
      }
      return true;
    });
  };
  const box = candidates.find(clear) ?? candidates[0];
  c.rect(box, INK.surface);
  c.text(text, box.x + 4, box.y + 3, INK.primary, FONT);
  obstacles.boxes.push(box);
  return box;
}

export function title(c: Canvas, text: string, subtitle: string | undefined, x = 32, y = 24): void {
  c.text(text, x, y, INK.primary, FONT);
  if (subtitle) c.text(subtitle, x, y + LINE_H + 8, INK.secondary, FONT);
}
