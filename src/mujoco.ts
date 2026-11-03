// Thin wrapper around the official MuJoCo WASM bindings (@mujoco/mujoco).
import { readFileSync } from 'node:fs';
import loadMujoco from '@mujoco/mujoco';
import type { MainModule, MjData, MjModel } from '@mujoco/mujoco';

export type Mujoco = MainModule;
export type { MjData, MjModel };

let modulePromise: Promise<Mujoco> | undefined;

/** Loads the single-threaded WASM module once per process. */
export function getMujoco(): Promise<Mujoco> {
  modulePromise ??= loadMujoco();
  return modulePromise;
}

export function loadModel(mj: Mujoco, xmlPath: string): MjModel {
  return mj.MjModel.from_xml_string(readFileSync(xmlPath, 'utf8'));
}

export function objectId(mj: Mujoco, model: MjModel, type: 'joint' | 'actuator' | 'site' | 'body', name: string): number {
  const obj = {
    joint: mj.mjtObj.mjOBJ_JOINT,
    actuator: mj.mjtObj.mjOBJ_ACTUATOR,
    site: mj.mjtObj.mjOBJ_SITE,
    body: mj.mjtObj.mjOBJ_BODY,
  }[type];
  const id = mj.mj_name2id(model, obj.value, name);
  if (id < 0) throw new Error(`MJCF model has no ${type} named "${name}"`);
  return id;
}
