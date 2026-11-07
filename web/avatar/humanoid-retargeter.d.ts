import type { Bone, Object3D, Quaternion, Vector3 } from 'three';
import type { AvatarCollision, CollisionDiagnostics } from './avatar-collision.js';

export interface HumanoidRestState {
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
  worldPosition: Vector3;
  worldQuaternion: Quaternion;
  worldScale?: Vector3;
}
export interface HumanoidChain {
  upper: Bone;
  lower: Bone;
  end: Bone;
  upperLength: number;
  lowerLength: number;
}
export interface RetargetCalibration {
  model: Object3D;
  profile: any;
  roles: Map<string, Bone>;
  rest: Map<Bone, HumanoidRestState>;
  chains: Record<'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg', HumanoidChain>;
  spine: Bone[];
  neck: Bone[];
  pelvis: Bone;
  head: Bone;
  height: number;
  groundY: number;
  soleOffsets?: { left: Vector3; right: Vector3 };
}
export class HumanoidRetargeter {
  constructor(calibration: RetargetCalibration);
  calibration: RetargetCalibration;
  model: Object3D;
  profile: any;
  roles: Map<string, Bone>;
  rest: Map<Bone, HumanoidRestState>;
  chains: RetargetCalibration['chains'];
  collision: AvatarCollision;
  soleOffsets: { left: Vector3; right: Vector3 };
  diagnostics: {
    warnings: string[];
    sourceCalibration: string | null;
    contacts: Record<string, string>;
    limbResiduals: Record<string, number>;
    pelvisCorrection: number;
    collision: CollisionDiagnostics;
  };
  reset(): void;
  stand(applyCollision?: boolean): void;
  applyFrame(clip: any, frame: any): void;
  measureBoneLengths(): Record<string, number>;
  setWorldRotation(bone: Bone, quaternion: Quaternion): void;
  setWorldPosition(bone: Bone, point: Vector3): void;
  solveChain(name: string, target: Vector3, pole: Vector3, maxFlex?: number): unknown;
}
