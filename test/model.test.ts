// The MJCF model and the MuJoCo actuator semantics h3d relies on.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appliedTorque } from '../src/control.ts';
import { actuatedJoints, col, simulate } from '../src/simulate.ts';
import { model } from './helpers.ts';

describe('model', async () => {
  const { mj, model: m } = await model();
  const joints = actuatedJoints(mj, m);

  it('has at least 5 actuated hinge dofs, one torque motor each', () => {
    assert.ok(joints.length >= 5);
    assert.equal(m.nu, joints.length);
    assert.equal(m.nq, m.nv);
    assert.deepEqual(joints.map((j) => j.name), ['pelvis_rot', 'trunk_rot', 'shoulder_hadd', 'elbow_flex', 'wrist_flex']);
    assert.equal(new Set(joints.map((j) => j.dofAdr)).size, joints.length);
  });

  it('every hinge axis is vertical at the reference pose', () => {
    for (let j = 0; j < m.njnt; j++) assert.deepEqual(Array.from(m.jnt_axis.slice(3 * j, 3 * j + 3)), [0, 0, 1]);
  });

  it('qfrc_actuator = gear * clamp(ctrl, -1, 1), also when saturated', () => {
    const data = new mj.MjData(m);
    try {
      for (const ctrl of [0.3, -0.7, 1, 2.5, -4]) {
        for (const j of joints) data.ctrl[j.actuator] = ctrl;
        mj.mj_forward(m, data);
        const clamped = Math.max(-1, Math.min(1, ctrl));
        for (const j of joints) {
          assert.equal(data.actuator_force[j.actuator], clamped, `${j.name} actuator_force at ctrl ${ctrl}`);
          assert.ok(Math.abs(data.qfrc_actuator[j.dofAdr] - j.gear * clamped) < 1e-12, `${j.name} qfrc at ctrl ${ctrl}`);
          assert.equal(appliedTorque(ctrl * j.gear, j.gear), j.gear * clamped);
        }
      }
    } finally {
      data.delete();
    }
  });

  it('a commanded torque above capacity is applied at capacity and flagged', () => {
    const rec = simulate(mj, m, {
      duration: 0.05,
      initialPoseDeg: {},
      pulses: [{ joint: 'wrist_flex', peak: 40, start: 0, duration: 0.05, direction: 1 }],
    });
    const tau = col(rec, 'tau_act_wrist_flex'), cmd = col(rec, 'tau_cmd_wrist_flex');
    assert.equal(Math.max(...tau), 15);
    assert.ok(Math.max(...cmd) > 39);
  });

  it('zero torque from a pose with trunk_rot = 0 is a static equilibrium', () => {
    const pose = { pelvis_rot: 30, trunk_rot: 0, shoulder_hadd: 20, elbow_flex: 40, wrist_flex: -10 };
    const rec = simulate(mj, m, { duration: 0.5, initialPoseDeg: pose, pulses: [] });
    for (const j of rec.joints) {
      const q = col(rec, `q_${j}`), q0 = ((pose as Record<string, number>)[j] * Math.PI) / 180;
      for (const v of q) assert.ok(Math.abs(v - q0) < 1e-10, `${j} drifted to ${v}`);
      for (const v of col(rec, `ddq_${j}`)) assert.ok(Math.abs(v) < 1e-9);
    }
    assert.ok(Math.max(...col(rec, 'head_speed')) < 1e-9);
  });

  it('pulses on joints without an actuator are rejected', () => {
    assert.throws(() => simulate(mj, m, { duration: 0.01, initialPoseDeg: {}, pulses: [{ joint: 'neck', peak: 1, start: 0, duration: 1, direction: 1 }] }));
  });
});
