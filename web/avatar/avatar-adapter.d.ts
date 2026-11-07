import type { Bone, Object3D, Quaternion, Vector3 } from 'three';

export type AvatarVec3 = [number, number, number];
export type AvatarQuat = [number, number, number, number];

export interface AvatarBoneInfo {
  name: string;
  parent: string | null;
  head: AvatarVec3;
  tail: AvatarVec3;
}

export interface AvatarRigInfo {
  height: number;
  bones: AvatarBoneInfo[];
}

export interface AvatarProfile {
  id: string;
  label: string;
  glbUrl: string;
  rigUrl: string;
  scale?: number;
  heroicShape?: boolean;
  statusLabel?: string;
  boneMap: Record<string, any>;
  defaultPose: Record<string, any>;
  [key: string]: unknown;
}

export const DEG: number;
export const WRIST_BEND_LIMIT_DEG: number;
export const MAKEHUMAN_DEFAULT_PROFILE: AvatarProfile;
export const AVATAR_PROFILES: Record<string, AvatarProfile>;

export function mjVecToThree(mjVec?: readonly number[], out?: Vector3): Vector3;
export function mjQuatToThree(mjQuatWxyz?: readonly number[], out?: Quaternion): Quaternion;
export function forearmTwist(roll: number): number;
export function solveTwoBone(
  root: Vector3,
  target: Vector3,
  pole: Vector3,
  upperLength: number,
  lowerLength: number,
  maxFlex?: number,
): { mid: Vector3; end: Vector3; flexion: number; residual: number };
export function frameRotation(restDirection: Vector3, restNormal: Vector3, direction: Vector3, normal: Vector3): Quaternion;
export function skeletonSegments(info: AvatarRigInfo): { name: string; parent: string }[];

export class AvatarAdapter {
  model: Object3D;
  info: AvatarRigInfo;
  profile: AvatarProfile;
  bones: Map<string, Bone>;
  rest: Map<string, Vector3>;
  restLocal: Map<string, Vector3>;
  restLocalQuat: Map<string, Quaternion>;
  bindWorldQuat: Map<string, Quaternion>;
  segmentLengths: Map<string, number>;

  constructor(model: Object3D, rigInfo: AvatarRigInfo, profile?: AvatarProfile);
  static load(profile?: AvatarProfile, loader?: unknown, fetchFn?: typeof fetch): Promise<AvatarAdapter>;
  bone(name: string): Bone;
  point(name: string, out?: Vector3): Vector3;
  reset(): void;
  rotateLocalEulerDeg(name: string, x?: number, y?: number, z?: number): void;
  setWorldRotation(name: string, worldQuat: Quaternion): void;
  solveLimb(side: 'L' | 'R', kind: 'arm' | 'leg', target: Vector3, pole: Vector3, maxFlex?: number): unknown;
  solveLimbToWorldTargets(side: 'L' | 'R', kind: 'arm' | 'leg', target: Vector3, pole: Vector3, maxFlex?: number): unknown;
  solveHand(side: 'L' | 'R', forward: Vector3, palmNormal: Vector3, bendLimit?: number): void;
  relaxHand(side: 'L' | 'R'): void;
  applyVisualMaterials(): void;
  applyDefaultStandPose(): void;
  retargetPhysicalArm(side: 'L' | 'R', shoulder: readonly number[], elbow: readonly number[], wrist: readonly number[], hand?: readonly number[], elbowFlexRad?: number): void;
  applyFrame(clip: any, frame: any): void;
  retargetLowerBodyFrame(clip: any, frame: any, positions: Record<string, AvatarVec3>, joints: Record<string, { angle: number; velocity: number }>): void;
  measureBoneLengths(): Record<string, number>;
}
