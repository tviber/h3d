import type { Bone, Group, Object3D, Quaternion, Vector3 } from 'three';

export interface HumanoidRestTransform {
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
  worldPosition: Vector3;
  worldQuaternion: Quaternion;
  worldScale: Vector3;
}

export interface HumanoidChain {
  upper: Bone;
  lower: Bone;
  end: Bone;
  upperLength: number;
  lowerLength: number;
}

export interface HumanoidDiagnostics {
  ok: boolean;
  schemaVersion: string;
  errors: string[];
  warnings: string[];
  skinCount: number;
  ambiguousRoles: { role: string; candidates: string[] }[];
  missingOptionalRoles: string[];
  capabilities: Record<string, boolean>;
  height?: number;
  groundY?: number;
}

export interface HumanoidInspection {
  model: Group;
  roles: Map<string, Bone>;
  rest: Map<Bone, HumanoidRestTransform>;
  chains: Record<'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg', HumanoidChain>;
  spine: Bone[];
  neck: Bone[];
  pelvis: Bone;
  head: Bone;
  height: number;
  groundY: number;
  soleOffsets: { left: Vector3; right: Vector3 };
  soleWorldOffsets: { left: Vector3; right: Vector3 };
  nodeSelectors: Map<Bone, string>;
  diagnostics: HumanoidDiagnostics;
  profile: Record<string, unknown>;
}

export class HumanoidInspectionError extends Error {
  diagnostics: HumanoidDiagnostics;
}

export function inspectHumanoid(model: Object3D, profile?: Record<string, any>): HumanoidInspection;
export function roleBonePath(bone: Bone): string;
