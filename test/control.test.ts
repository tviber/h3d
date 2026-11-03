import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appliedTorque, commandedTorque, envelope, type Pulse, validatePulse } from '../src/control.ts';

const sin2: Pulse = { joint: 'j', peak: 10, start: 0.1, duration: 0.2, direction: 1 };
const plateau: Pulse = { ...sin2, shape: 'plateau', rise: 0.05 };

describe('pulse envelope', () => {
  for (const p of [sin2, plateau]) {
    const name = p.shape ?? 'sin2';

    it(`${name}: zero outside the pulse window, peak 1 inside`, () => {
      for (const t of [-1, 0, 0.1, 0.31, 2]) assert.equal(envelope(p, t), 0);
      assert.ok(envelope(p, 0.3) < 1e-12); // t = start + duration, up to rounding of t - start
      assert.ok(Math.abs(envelope(p, 0.2) - 1) < 1e-12);
      for (let t = 0; t < 0.4; t += 0.001) {
        const e = envelope(p, t);
        assert.ok(e >= 0 && e <= 1 + 1e-12, `envelope(${t}) = ${e}`);
      }
    });

    it(`${name}: continuous with continuous slope (C1)`, () => {
      const h = 1e-6;
      let maxJump = 0, maxSlopeJump = 0;
      for (let t = 0.05; t < 0.35; t += 1e-4) {
        maxJump = Math.max(maxJump, Math.abs(envelope(p, t + h) - envelope(p, t)));
        const s1 = (envelope(p, t) - envelope(p, t - h)) / h;
        const s2 = (envelope(p, t + h) - envelope(p, t)) / h;
        maxSlopeJump = Math.max(maxSlopeJump, Math.abs(s2 - s1));
      }
      assert.ok(maxJump < 1e-3, `value jump ${maxJump}`);
      assert.ok(maxSlopeJump < 1e-2, `slope jump ${maxSlopeJump}`);
    });
  }

  it('plateau is flat between rise and fall', () => {
    for (let t = 0.15; t <= 0.25; t += 0.01) assert.equal(envelope(plateau, t), 1);
  });
});

describe('commanded torque', () => {
  it('sums pulses of the same joint with their direction and ignores other joints', () => {
    const pulses: Pulse[] = [
      sin2,
      { ...sin2, peak: 4, direction: -1 },
      { ...sin2, joint: 'other', peak: 100 },
    ];
    assert.ok(Math.abs(commandedTorque(pulses, 'j', 0.2) - 6) < 1e-12);
    assert.ok(Math.abs(commandedTorque(pulses, 'other', 0.2) - 100) < 1e-12);
    assert.equal(commandedTorque(pulses, 'none', 0.2), 0);
  });
});

describe('applied torque (motor actuator mapping)', () => {
  it('passes through inside capacity and clamps at gear * ctrlrange', () => {
    assert.equal(appliedTorque(30, 100), 30);
    assert.equal(appliedTorque(-30, 100), -30);
    assert.equal(appliedTorque(250, 100), 100);
    assert.equal(appliedTorque(-250, 100), -100);
    assert.equal(appliedTorque(10, 100, [-0.05, 0.05]), 5);
  });
});

describe('pulse validation', () => {
  const bad: [string, Partial<Pulse>][] = [
    ['negative peak', { peak: -1 }],
    ['zero duration', { duration: 0 }],
    ['bad direction', { direction: 0 as 1 }],
    ['unknown shape', { shape: 'square' as 'sin2' }],
    ['rise too long', { shape: 'plateau', rise: 0.15 }],
    ['non-finite start', { start: Number.NaN }],
  ];
  for (const [name, patch] of bad) {
    it(`rejects ${name}`, () => assert.throws(() => validatePulse({ ...sin2, ...patch })));
  }
  it('accepts valid pulses', () => {
    validatePulse(sin2);
    validatePulse(plateau);
  });
});
