import type { Mesh, SkinnedMesh, Vector3 } from 'three';
import type { RetargetCalibration } from './humanoid-retargeter.js';
import type { CollisionConfig, CollisionDiagnostics } from './avatar-collision.js';
import type { Capsule } from './collision-math.js';
export interface ClothParticle { id: number; vertex: number; rest: Vector3; target: Vector3; position: Vector3; invMass: number; neighbors: Set<number> }
export function solveDistance(a: { position: Vector3; invMass: number }, b: { position: Vector3; invMass: number }, restLength: number, compliance: number, lambda?: number): number;
export class GarmentSolver {
  constructor(calibration: RetargetCalibration, configs?: CollisionConfig['garments']);
  garments: Array<{ source: SkinnedMesh; proxy: Mesh; particles: ClothParticle[]; vertices: ClothParticle[] }>;
  particles: ClothParticle[];
  diagnostics: CollisionDiagnostics['cloth'];
  solve(capsules: Capsule[]): NonNullable<CollisionDiagnostics['cloth']>;
  setEnabled(enabled: boolean): void;
  configureSeams(capsules: Capsule[]): void;
  dispose(): void;
}
