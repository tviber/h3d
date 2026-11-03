import { fileURLToPath } from 'node:url';
import { getMujoco, loadModel } from '../src/mujoco.ts';
import { type Batch, runBatch } from '../src/runner.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const MODEL_PATH = fileURLToPath(new URL('../models/upper_body.xml', import.meta.url));
export const ABC_CONFIG = fileURLToPath(new URL('../experiments/abc.json', import.meta.url));

export async function model() {
  const mj = await getMujoco();
  return { mj, model: loadModel(mj, MODEL_PATH) };
}

let abc: Promise<Batch> | undefined;
/** The A/B/C batch, simulated once per test file. */
export function abcBatch(): Promise<Batch> {
  abc ??= runBatch(ABC_CONFIG);
  return abc;
}

export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
