// Tiny software rasteriser: anti-aliased lines, discs, rounded bars and bitmap text
// on an RGB canvas. Shapes are signed-distance coverage functions.
import { ADVANCE, GLYPH_H, glyph } from './font.ts';
import { encodePng } from './png.ts';

export type Color = string; // '#rrggbb'

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Shape = (px: number, py: number) => number;

const parse = (c: Color): [number, number, number] => [
  parseInt(c.slice(1, 3), 16),
  parseInt(c.slice(3, 5), 16),
  parseInt(c.slice(5, 7), 16),
];
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Coverage of a box with per-corner radii [top-left, top-right, bottom-right, bottom-left]. */
function roundedBox(b: Rect, radii: [number, number, number, number]): Shape {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return (px, py) => {
    const r = px < cx ? (py < cy ? radii[0] : radii[3]) : py < cy ? radii[1] : radii[2];
    const qx = Math.abs(px - cx) - (b.w / 2 - r), qy = Math.abs(py - cy) - (b.h / 2 - r);
    const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    return clamp01(0.5 - d);
  };
}

export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
  /** Per-pixel coverage scratch: shapes accumulate by max, then composite once. */
  private readonly cov: Float32Array;

  constructor(width: number, height: number, background: Color) {
    this.width = width;
    this.height = height;
    this.rgb = new Uint8Array(width * height * 3);
    this.cov = new Float32Array(width * height);
    const [r, g, b] = parse(background);
    for (let i = 0; i < width * height; i++) this.rgb.set([r, g, b], 3 * i);
  }

  private span(box: Rect) {
    return {
      x0: Math.max(0, Math.floor(box.x) - 1),
      y0: Math.max(0, Math.floor(box.y) - 1),
      x1: Math.min(this.width - 1, Math.ceil(box.x + box.w) + 1),
      y1: Math.min(this.height - 1, Math.ceil(box.y + box.h) + 1),
    };
  }

  private accumulate(box: Rect, shape: Shape): void {
    const { x0, y0, x1, y1 } = this.span(box);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const c = shape(x + 0.5, y + 0.5);
      const i = y * this.width + x;
      if (c > this.cov[i]) this.cov[i] = c;
    }
  }

  private composite(box: Rect, color: Color, alpha: number, clip?: Rect): void {
    const { x0, y0, x1, y1 } = this.span(box);
    const rgb = parse(color);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * this.width + x;
      const a = this.cov[i] * alpha;
      this.cov[i] = 0;
      if (a <= 0) continue;
      if (clip && (x < clip.x || x >= clip.x + clip.w || y < clip.y || y >= clip.y + clip.h)) continue;
      const o = 3 * i;
      for (let k = 0; k < 3; k++) this.rgb[o + k] = Math.round(this.rgb[o + k] + (rgb[k] - this.rgb[o + k]) * a);
    }
  }

  private draw(box: Rect, shape: Shape, color: Color, alpha = 1): void {
    this.accumulate(box, shape);
    this.composite(box, color, alpha);
  }

  rect(r: Rect, color: Color): void {
    this.draw(r, roundedBox(r, [0, 0, 0, 0]), color);
  }

  /** Bar with a rounded data end (radius `r`) and square corners at the baseline. */
  bar(b: Rect, color: Color, dataEnd: 'right' | 'left' | 'top', r = 4): void {
    const k = Math.min(r, b.w / 2, b.h / 2);
    const radii: [number, number, number, number] =
      dataEnd === 'right' ? [0, k, k, 0] : dataEnd === 'left' ? [k, 0, 0, k] : [k, k, 0, 0];
    this.draw(b, roundedBox(b, radii), color);
  }

  /** Polyline of constant width with round joins and caps, composited once (no double-blending at joints). */
  polyline(xs: ArrayLike<number>, ys: ArrayLike<number>, color: Color, width = 2, clip?: Rect, alpha = 1): void {
    const hw = width / 2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let s = 0; s < xs.length - 1; s++) {
      const ax = xs[s], ay = ys[s], bx = xs[s + 1], by = ys[s + 1];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const box = { x: Math.min(ax, bx) - hw, y: Math.min(ay, by) - hw, w: Math.abs(dx) + width, h: Math.abs(dy) + width };
      minX = Math.min(minX, box.x); minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.w); maxY = Math.max(maxY, box.y + box.h);
      this.accumulate(box, (px, py) => {
        const t = len2 > 0 ? clamp01(((px - ax) * dx + (py - ay) * dy) / len2) : 0;
        return clamp01(hw + 0.5 - Math.hypot(px - ax - t * dx, py - ay - t * dy));
      });
    }
    if (minX <= maxX) this.composite({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, color, alpha, clip);
  }

  line(x0: number, y0: number, x1: number, y1: number, color: Color, width = 1, alpha = 1): void {
    this.polyline([x0, x1], [y0, y1], color, width, undefined, alpha);
  }

  /** Crisp 1-px hairlines. */
  hline(x0: number, x1: number, y: number, color: Color): void {
    this.rect({ x: Math.min(x0, x1), y: Math.round(y) - 0.5, w: Math.abs(x1 - x0), h: 1 }, color);
  }

  vline(x: number, y0: number, y1: number, color: Color): void {
    this.rect({ x: Math.round(x) - 0.5, y: Math.min(y0, y1), w: 1, h: Math.abs(y1 - y0) }, color);
  }

  disc(cx: number, cy: number, radius: number, color: Color, alpha = 1): void {
    const box = { x: cx - radius, y: cy - radius, w: 2 * radius, h: 2 * radius };
    this.draw(box, (px, py) => clamp01(radius - Math.hypot(px - cx, py - cy) + 0.5), color, alpha);
  }

  /** Marker: filled disc (diameter >= 8 px) with a 2 px ring in the surface colour. */
  marker(cx: number, cy: number, color: Color, surface: Color, radius = 5): void {
    this.disc(cx, cy, radius + 2, surface);
    this.disc(cx, cy, radius, color);
  }

  static textWidth(text: string, scale: number): number {
    return text.length * ADVANCE * scale - scale;
  }

  static textHeight(scale: number): number {
    return GLYPH_H * scale;
  }

  /** Bitmap text; (x, y) is the top of the glyph box at the given horizontal alignment. */
  text(text: string, x: number, y: number, color: Color, scale = 2, align: 'left' | 'center' | 'right' = 'left'): void {
    const w = Canvas.textWidth(text, scale);
    let ox = Math.round(align === 'left' ? x : align === 'center' ? x - w / 2 : x - w);
    const oy = Math.round(y);
    const rgb = parse(color);
    for (const ch of text) {
      const cols = glyph(ch);
      for (let c = 0; c < cols.length; c++) for (let r = 0; r < GLYPH_H; r++) {
        if (!((cols[c] >> r) & 1)) continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
          const px = ox + c * scale + dx, py = oy + r * scale + dy;
          if (px >= 0 && py >= 0 && px < this.width && py < this.height) this.rgb.set(rgb, 3 * (py * this.width + px));
        }
      }
      ox += ADVANCE * scale;
    }
  }

  toPng(): Buffer {
    return encodePng(this.width, this.height, this.rgb);
  }
}
