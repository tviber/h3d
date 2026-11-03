// Forward-dynamics run: open-loop joint torques in, full time series out.
import { commandedTorque, type Pulse } from './control.ts';
import { type MjModel, type Mujoco, objectId } from './mujoco.ts';

/** Sites whose world position is recorded every sample. `racket_head` is the string-bed centre. */
export const SITES = ['l_hip', 'r_hip', 'l_shoulder', 'shoulder', 'elbow', 'wrist', 'racket_butt', 'racket_head'] as const;

export interface ActuatedJoint {
  name: string;
  actuator: number;
  qposAdr: number;
  dofAdr: number;
  gear: number;
  ctrlRange: [number, number];
  rangeDeg: [number, number];
}

/** Maps every actuator to the hinge joint it drives. All h3d actuators are joint motors. */
export function actuatedJoints(mj: Mujoco, model: MjModel): ActuatedJoint[] {
  const deg = 180 / Math.PI;
  const out: ActuatedJoint[] = [];
  for (let a = 0; a < model.nu; a++) {
    if (model.actuator_trntype[a] !== mj.mjtTrn.mjTRN_JOINT.value) throw new Error(`actuator ${a} is not a joint transmission`);
    const j = model.actuator_trnid[2 * a];
    if (model.jnt_type[j] !== mj.mjtJoint.mjJNT_HINGE.value) throw new Error(`actuator ${a} does not drive a hinge`);
    out.push({
      name: mj.mj_id2name(model, mj.mjtObj.mjOBJ_JOINT.value, j),
      actuator: a,
      qposAdr: model.jnt_qposadr[j],
      dofAdr: model.jnt_dofadr[j],
      gear: model.actuator_gear[6 * a],
      ctrlRange: [model.actuator_ctrlrange[2 * a], model.actuator_ctrlrange[2 * a + 1]],
      rangeDeg: [model.jnt_range[2 * j] * deg, model.jnt_range[2 * j + 1] * deg],
    });
  }
  return out;
}

export interface SimSpec {
  duration: number;
  initialPoseDeg: Record<string, number>;
  pulses: readonly Pulse[];
}

export interface Recording {
  joints: string[];
  dt: number;
  /** Number of samples (steps + 1); sample k is the state at t = k * dt. */
  n: number;
  columns: Map<string, Float64Array>;
}

export function col(rec: Recording, name: string): Float64Array {
  const c = rec.columns.get(name);
  if (!c) throw new Error(`no column "${name}"`);
  return c;
}

/**
 * Runs one experiment from rest. Per step k:
 *   1. ctrl = tau_cmd(t_k) / gear, held constant over the step (zero-order hold)
 *   2. mj_forward -> record a self-consistent state at t_k (qacc, forces, Jacobians, energy)
 *   3. mj_step (RK4) -> t_{k+1}
 * Because the actuator torque is constant within a step, its work over the step is
 * exactly tau_k * (q_{k+1} - q_k); `work_*` columns accumulate that.
 */
export function simulate(mj: Mujoco, model: MjModel, spec: SimSpec): Recording {
  const joints = actuatedJoints(mj, model);
  const names = joints.map((j) => j.name);
  if (model.nq !== model.nv) throw new Error('h3d expects hinge-only models (nq == nv)');
  for (const p of spec.pulses) if (!names.includes(p.joint)) throw new Error(`pulse targets non-actuated joint "${p.joint}"`);

  const nv = model.nv;
  const dt = model.opt.timestep;
  const steps = Math.round(spec.duration / dt);
  const n = steps + 1;
  const columns = new Map<string, Float64Array>();
  const add = (name: string): Float64Array => {
    const a = new Float64Array(n);
    columns.set(name, a);
    return a;
  };
  const per = (prefix: string) => joints.map((j) => add(`${prefix}_${j.name}`));

  const time = add('time');
  const q = per('q'), dq = per('dq'), ddq = per('ddq');
  const tauCmd = per('tau_cmd'), ctrl = per('ctrl'), actForce = per('actuator_force');
  const tauAct = per('tau_act'), tauSpring = per('tau_spring'), tauDamper = per('tau_damper'), tauLimit = per('tau_limit');
  const power = per('power'), work = per('work');
  // Head speed contributed by each joint: qvel_i * (J_i . v_hat); the terms sum to |v_head|.
  const vFrom = per('vhead_from');
  const sites = SITES.map((s) => ({ name: s, id: objectId(mj, model, 'site', s), p: [add(`${s}_x`), add(`${s}_y`), add(`${s}_z`)] }));
  const head = sites.find((s) => s.name === 'racket_head')!;
  const butt = sites.find((s) => s.name === 'racket_butt')!;
  const headV = [add('head_vx'), add('head_vy'), add('head_vz')];
  const headA = [add('head_ax'), add('head_ay'), add('head_az')];
  const headSpeed = add('head_speed'), headAcc = add('head_acc'), buttSpeed = add('butt_speed');
  const kinetic = add('kinetic_energy'), potential = add('potential_energy');
  const angMomZ = add('ang_momentum_z');

  const pelvisDof = model.jnt_dofadr[objectId(mj, model, 'joint', 'pelvis_rot')];
  const headBody = model.site_bodyid[head.id];

  const data = new mj.MjData(model);
  const jacp = new mj.DoubleBuffer(3 * nv), jacr = new mj.DoubleBuffer(3 * nv);
  const jdotp = new mj.DoubleBuffer(3 * nv), jdotr = new mj.DoubleBuffer(3 * nv);
  const momentum = new mj.DoubleBuffer(nv);

  /** Rows of J * x for a 3 x nv Jacobian view. */
  const mulJ = (J: Float64Array, x: ArrayLike<number>, r: number): number => {
    let s = 0;
    for (let c = 0; c < nv; c++) s += J[r * nv + c] * x[c];
    return s;
  };

  try {
    mj.mj_resetData(model, data);
    for (const [name, deg] of Object.entries(spec.initialPoseDeg)) {
      data.qpos[model.jnt_qposadr[objectId(mj, model, 'joint', name)]] = (deg * Math.PI) / 180;
    }
    const workAcc = new Float64Array(joints.length);
    const qPrev = new Float64Array(joints.length);

    for (let k = 0; k < n; k++) {
      const t = k * dt;
      joints.forEach((j, i) => {
        tauCmd[i][k] = commandedTorque(spec.pulses, j.name, t);
        data.ctrl[j.actuator] = tauCmd[i][k] / j.gear;
      });
      mj.mj_forward(model, data);

      time[k] = t;
      const qvel = data.qvel as Float64Array, qacc = data.qacc as Float64Array;
      joints.forEach((j, i) => {
        q[i][k] = data.qpos[j.qposAdr];
        dq[i][k] = qvel[j.dofAdr];
        ddq[i][k] = qacc[j.dofAdr];
        ctrl[i][k] = data.ctrl[j.actuator];
        actForce[i][k] = data.actuator_force[j.actuator];
        tauAct[i][k] = data.qfrc_actuator[j.dofAdr];
        tauSpring[i][k] = data.qfrc_spring[j.dofAdr];
        tauDamper[i][k] = data.qfrc_damper[j.dofAdr];
        tauLimit[i][k] = data.qfrc_constraint[j.dofAdr];
        power[i][k] = tauAct[i][k] * dq[i][k];
        work[i][k] = workAcc[i];
      });
      for (const s of sites) for (let r = 0; r < 3; r++) s.p[r][k] = data.site_xpos[3 * s.id + r];

      // Racket head: v = Jp * qvel, a = Jp * qacc + dJp/dt * qvel (world frame).
      mj.mj_jacSite(model, data, jacp, jacr, head.id);
      mj.mj_jacDot(model, data, jdotp, jdotr, [head.p[0][k], head.p[1][k], head.p[2][k]], headBody);
      const Jp = jacp.GetView() as Float64Array, Jd = jdotp.GetView() as Float64Array;
      for (let r = 0; r < 3; r++) {
        headV[r][k] = mulJ(Jp, qvel, r);
        headA[r][k] = mulJ(Jp, qacc, r) + mulJ(Jd, qvel, r);
      }
      headSpeed[k] = Math.hypot(headV[0][k], headV[1][k], headV[2][k]);
      headAcc[k] = Math.hypot(headA[0][k], headA[1][k], headA[2][k]);
      joints.forEach((j, i) => {
        let along = 0;
        if (headSpeed[k] > 0) for (let r = 0; r < 3; r++) along += Jp[r * nv + j.dofAdr] * headV[r][k];
        vFrom[i][k] = headSpeed[k] > 0 ? (qvel[j.dofAdr] * along) / headSpeed[k] : 0;
      });

      mj.mj_jacSite(model, data, jacp, jacr, butt.id);
      const Jb = jacp.GetView() as Float64Array;
      buttSpeed[k] = Math.hypot(mulJ(Jb, qvel, 0), mulJ(Jb, qvel, 1), mulJ(Jb, qvel, 2));

      // energy[0] = gravity + spring potential, energy[1] = kinetic (computed by mj_forward).
      potential[k] = data.energy[0];
      kinetic[k] = data.energy[1];
      // The root hinge's generalized momentum (M * qvel) is the whole chain's angular
      // momentum about the vertical pelvis axis.
      mj.mj_mulM(model, data, momentum, Array.from(qvel));
      angMomZ[k] = (momentum.GetView() as Float64Array)[pelvisDof];

      if (k === steps) break;
      joints.forEach((j, i) => (qPrev[i] = data.qpos[j.qposAdr]));
      mj.mj_step(model, data);
      joints.forEach((j, i) => (workAcc[i] += tauAct[i][k] * (data.qpos[j.qposAdr] - qPrev[i])));
    }
  } finally {
    for (const b of [jacp, jacr, jdotp, jdotr, momentum]) b.delete();
    data.delete();
  }
  return { joints: names, dt, n, columns };
}
