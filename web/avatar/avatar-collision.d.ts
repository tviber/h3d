import type { Group, Vector3 } from 'three';
import type { HumanoidRetargeter } from './humanoid-retargeter.js';
import type { GarmentSolver } from './cloth-solver.js';

export interface CollisionConfig {
  enabled?: boolean;
  clothEnabled?: boolean;
  maxCorrectionDegrees?: number;
  radii?: Partial<Record<'torso' | 'pelvis' | 'head' | 'upperArm' | 'forearm' | 'hand' | 'thigh' | 'shin' | 'foot', number>>;
  garments?: Array<{ mesh: string; pin: { top: number } | { nearRole: string; radius: number } | { alongChain: 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg'; fraction: number }; stretchCompliance?: number; bendCompliance?: number; attachmentCompliance?: number }>;
}
export interface CollisionCapsule {
  id: string;
  type: string;
  a: Vector3;
  b: Vector3;
  radius: number;
  chain: string | null;
  segment: string | null;
}
export interface CollisionDiagnostics {
  enabled: boolean;
  contactsBefore: number;
  contactsAfter: number;
  maxPenetrationBefore: number;
  maxPenetration: number;
  maxCorrectionDegrees: number;
  unresolvedPairs?: Array<{ a: string; b: string; depth: number }>;
  cloth: null | { mode: string; particles: number; pinned: number; bodyContacts: number; fabricContacts: number; maxPenetration: number; maxVertexPenetration: number; maxSurfacePenetration: number; pinnedPenetration: number; maxDisplacement: number; maxStretchRatio: number; remainingFabricContacts: number; maxFabricPenetration: number; seamExclusions: number; limitedGarments: number; deformationScales: Array<{ mesh: string; scale: number }> };
}
export function validateCollisionConfig(config?: CollisionConfig): void;
export class AvatarCollision {
  constructor(adapter: HumanoidRetargeter, config?: CollisionConfig);
  enabled: boolean;
  clothEnabled: boolean;
  maxCorrection: number;
  capsules: CollisionCapsule[];
  pairs: Array<[CollisionCapsule, CollisionCapsule]>;
  garments: GarmentSolver;
  debug: Group;
  diagnostics: CollisionDiagnostics;
  updateCapsules(): void;
  contacts(): Array<{ a: CollisionCapsule; b: CollisionCapsule; normal: Vector3; point: Vector3; otherPoint: Vector3; depth: number; s: number; t: number }>;
  resolveRigid(): void;
  solve(): CollisionDiagnostics;
  setDebugVisible(visible: boolean): void;
  dispose(): void;
}
