// Output layer: CSV/JSON/report structure, PNG validity, chart rendering and the CLI.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { crc32, inflateSync } from 'node:zlib';
import { CHARTS } from '../src/charts.ts';
import { encodePng } from '../src/plot/png.ts';
import { comparisonJson, reportMarkdown, toCsv } from '../src/report.ts';
import { ABC_CONFIG, abcBatch, ROOT } from './helpers.ts';

/** Minimal PNG decoder for RGB8 / filter-0 images: returns [width, height, pixels]. */
function decodePng(buf: Buffer): [number, number, Buffer] {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let off = 8, w = 0, h = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 4, off + 8 + len);
    assert.equal(buf.readUInt32BE(off + 8 + len), crc32(body), `${type} CRC`);
    if (type === 'IHDR') {
      w = body.readUInt32BE(4);
      h = body.readUInt32BE(8);
      assert.deepEqual([body[12], body[13]], [8, 2], 'RGB8');
    } else if (type === 'IDAT') idat.push(body.subarray(4));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (3 * w + 1) * h);
  const px = Buffer.alloc(3 * w * h);
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * (3 * w + 1)], 0, 'filter type 0');
    raw.copy(px, 3 * w * y, y * (3 * w + 1) + 1, (y + 1) * (3 * w + 1));
  }
  return [w, h, px];
}

describe('PNG encoder', () => {
  it('round-trips pixels through a valid PNG stream', () => {
    const w = 7, h = 3, rgb = new Uint8Array(w * h * 3).map((_, i) => (i * 37) % 256);
    const [dw, dh, px] = decodePng(encodePng(w, h, rgb));
    assert.deepEqual([dw, dh], [w, h]);
    assert.deepEqual([...px], [...rgb]);
  });

  it('rejects a buffer of the wrong size', () => {
    assert.throws(() => encodePng(2, 2, new Uint8Array(5)));
  });
});

describe('report outputs', async () => {
  const batch = await abcBatch();

  it('CSV has a header and one row per sample with a value in every column', () => {
    const rec = batch.results[0].recording;
    const lines = toCsv(rec).trimEnd().split('\n');
    const header = lines[0].split(',');
    assert.equal(lines.length, rec.n + 1);
    for (const c of ['time', 'head_speed', 'power_pelvis_rot', 'work_wrist_flex', 'racket_head_x', 'kinetic_energy']) assert.ok(header.includes(c), c);
    assert.ok(lines.slice(1).every((l) => l.split(',').length === header.length && !l.includes('NaN')));
  });

  it('comparison.json reports differences vs the first run and the shared inputs', () => {
    const cmp = comparisonJson(batch, ABC_CONFIG);
    assert.deepEqual(cmp.sharedCommandedTorques, ['shoulder_hadd', 'elbow_flex', 'wrist_flex']);
    assert.deepEqual(cmp.comparisons.map((c) => `${c.id}-${c.vs}`), ['B-A', 'C-A']);
    const [a, b] = batch.results.map((r) => r.summary.peakHeadSpeed);
    assert.ok(Math.abs(cmp.comparisons[0].peakHeadSpeedDiff - (b - a)) < 1e-12);
    assert.ok(cmp.runs.every((r) => r.validationFailures.length === 0));
    assert.doesNotThrow(() => JSON.stringify(cmp));
  });

  it('report.md carries the headline numbers', () => {
    const md = reportMarkdown(batch, ABC_CONFIG, []);
    for (const r of batch.results) assert.ok(md.includes(`| ${r.summary.id} | ${r.summary.label} | ${r.summary.peakHeadSpeed.toFixed(2)} |`));
    assert.ok(!md.includes('FAIL'));
  });

  it('every chart renders to a valid, non-blank PNG', () => {
    for (const [name, render] of Object.entries(CHARTS)) {
      const [w, h, px] = decodePng(render(batch.results).toPng());
      assert.ok(w >= 600 && h >= 200, name);
      const colours = new Set<number>();
      for (let i = 0; i < px.length; i += 3) colours.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
      assert.ok(colours.size > 10, `${name} looks blank`);
    }
  });
});

describe('CLI', () => {
  const cli = join(ROOT, 'src', 'cli.ts');

  it('compare writes structured results and exits 0', () => {
    const out = mkdtempSync(join(tmpdir(), 'h3d-cli-'));
    try {
      const stdout = execFileSync(process.execPath, [cli, 'compare', '--out', out, '--no-png'], { encoding: 'utf8' });
      assert.match(stdout, /B\s+29\.48 m\/s/);
      for (const f of ['A.timeseries.csv', 'B.summary.json', 'C.summary.json', 'comparison.json', 'report.md']) assert.ok(existsSync(join(out, f)), f);
      assert.ok(!existsSync(join(out, 'head_speed.png')));
      const cmp = JSON.parse(readFileSync(join(out, 'comparison.json'), 'utf8'));
      assert.equal(cmp.runs.length, 3);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('usage errors exit with status 2', () => {
    for (const args of [['frobnicate'], ['run'], ['run', 'Z', '--out', join(tmpdir(), 'h3d-never')], ['compare', '--duration', 'abc']]) {
      const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    }
  });
});
