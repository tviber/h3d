// A/B/C batch: controlled inputs, determinism, physical self-consistency and the headline result.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { trapz, validationFailures } from '../src/analysis.ts';
import { loadExperiments } from '../src/experiment.ts';
import { runBatch, sharedInputs } from '../src/runner.ts';
import { col } from '../src/simulate.ts';
import { ABC_CONFIG, abcBatch, maxAbsDiff, MODEL_PATH } from './helpers.ts';

const ARM = ['shoulder_hadd', 'elbow_flex', 'wrist_flex'];

describe('A/B/C configuration', () => {
  it('A, B and C reference the very same arm pulse objects', () => {
    const [a, b, c] = loadExperiments(ABC_CONFIG);
    const arm = (e: typeof a) => e.pulses.filter((p) => ARM.includes(p.joint));
    assert.equal(arm(a).length, 3);
    arm(a).forEach((p, i) => {
      assert.equal(arm(b)[i], p);
      assert.equal(arm(c)[i], p);
    });
    assert.ok(a.pulses.every((p) => ARM.includes(p.joint)), 'A drives the arm only');
  });

  it('rejects unknown pulse sets, duplicate ids and bad durations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h3d-test-'));
    try {
      const write = (cfg: object) => {
        const p = join(dir, 'cfg.json');
        writeFileSync(p, JSON.stringify({ model: MODEL_PATH, duration: 0.1, initialPoseDeg: {}, pulseSets: { s: [] }, ...cfg }));
        return p;
      };
      assert.throws(() => loadExperiments(write({ experiments: [{ id: 'X', label: '', use: ['missing'] }] })), /unknown pulse set/);
      assert.throws(() => loadExperiments(write({ experiments: [{ id: 'X', label: '', use: ['s'] }, { id: 'X', label: '', use: ['s'] }] })), /duplicate/);
      assert.throws(() => loadExperiments(write({ experiments: [] }), { duration: -1 }), /duration/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('A/B/C simulation', async () => {
  const batch = await abcBatch();
  const [A, B, C] = batch.results;

  it('applied arm torques are bitwise identical across A, B and C', () => {
    assert.deepEqual(sharedInputs(batch.results), ARM);
    for (const j of ARM) {
      assert.equal(maxAbsDiff(col(A.recording, `tau_act_${j}`), col(B.recording, `tau_act_${j}`)), 0);
      assert.equal(maxAbsDiff(col(A.recording, `tau_act_${j}`), col(C.recording, `tau_act_${j}`)), 0);
    }
  });

  it('in A the pelvis and trunk receive no actuator torque at all', () => {
    for (const j of ['pelvis_rot', 'trunk_rot']) assert.ok(col(A.recording, `tau_act_${j}`).every((v) => v === 0));
  });

  it('no actuator is saturated, so applied torque equals commanded torque', () => {
    for (const r of batch.results) {
      for (const j of r.summary.joints) assert.equal(j.saturated, false, `${r.summary.id} ${j.joint}`);
      for (const j of r.recording.joints) assert.ok(maxAbsDiff(col(r.recording, `tau_act_${j}`), col(r.recording, `tau_cmd_${j}`)) < 1e-9);
    }
  });

  it('is deterministic: a second run is bitwise identical', async () => {
    const again = await runBatch(ABC_CONFIG);
    for (const [i, r] of batch.results.entries()) {
      for (const [name, c] of r.recording.columns) assert.equal(maxAbsDiff(c, again.results[i].recording.columns.get(name)!), 0, `${r.summary.id} ${name}`);
      assert.deepEqual(again.results[i].summary, r.summary);
    }
  });

  it('passes every self-check (Jacobian vs FD, energy balance, angular momentum)', () => {
    for (const r of batch.results) assert.deepEqual(validationFailures(r.summary), [], `${r.summary.id}: ${JSON.stringify(r.summary.validation)}`);
  });

  it('per-joint head-speed shares add up to |v_head| at every sample', () => {
    for (const r of batch.results) {
      const speed = col(r.recording, 'head_speed');
      const sum = new Float64Array(r.recording.n);
      for (const j of r.recording.joints) col(r.recording, `vhead_from_${j}`).forEach((v, k) => (sum[k] += v));
      assert.ok(maxAbsDiff(sum, speed) < 1e-9);
    }
  });

  it('joint work matches the integral of joint power', () => {
    for (const r of batch.results) {
      for (const j of r.recording.joints) {
        const w = col(r.recording, `work_${j}`), p = col(r.recording, `power_${j}`);
        // Relative to the absolute work: positive and negative phases can cancel in the net value.
        const scale = Math.max(1, trapz(p.map(Math.abs), r.recording.dt));
        assert.ok(Math.abs(w[r.recording.n - 1] - trapz(p, r.recording.dt)) / scale < 0.01, `${r.summary.id} ${j}`);
      }
    }
  });

  it('measures the head site, not the racket root', () => {
    const rec = B.recording, k = Math.round(B.summary.tPeak / rec.dt);
    const d = Math.hypot(...['x', 'y', 'z'].map((a) => col(rec, `racket_head_${a}`)[k] - col(rec, `racket_butt_${a}`)[k]));
    assert.ok(Math.abs(d - 0.52) < 1e-9);
    assert.ok(B.summary.peakHeadSpeed > 2 * B.summary.buttSpeedAtPeak);
  });

  it('with identical arm torques, proximal-first rotation (B) gives a faster head than arm only (A) and simultaneous rotation (C)', () => {
    assert.ok(B.summary.peakHeadSpeed > 1.3 * A.summary.peakHeadSpeed, `A ${A.summary.peakHeadSpeed}, B ${B.summary.peakHeadSpeed}`);
    assert.ok(B.summary.peakHeadSpeed > C.summary.peakHeadSpeed);
  });

  it('reproduces the documented peak head speeds', () => {
    // Values in README / docs; update them together if the model or config changes.
    const expected = { A: 17.62, B: 29.48, C: 14.1 };
    for (const r of batch.results) assert.ok(Math.abs(r.summary.peakHeadSpeed - expected[r.summary.id as 'A']) < 0.005, `${r.summary.id} ${r.summary.peakHeadSpeed}`);
  });
});
