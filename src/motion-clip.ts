import type { MuscleExperiment, MotionPhase } from './muscle-experiment.ts';
import type { MuscleRecording, Vec3 } from './muscle-simulate.ts';

export interface MotionClip {
  schemaVersion: 'h3d.motion.v1';
  id: string;
  label: string;
  duration: number;
  timestep: number;
  phases: MotionPhase[];
  rig: {
    kind: 'elbow' | 'shoulder-elbow' | 'lower-body';
    staticPositions: Record<string, Vec3>;
    segments: { from: string; to: string; radius: number; group: 'torso' | 'arm' | 'leg' }[];
    jointNames: string[];
    jointTypes: Record<string, 'hinge' | 'slide'>;
    muscles: { name: string; maxIsometricForce: number; region: 'lower-body' | 'trunk' | 'upper-body' }[];
  };
  samples: {
    time: number;
    com: Vec3;
    positions: Record<string, Vec3>;
    joints: Record<string, { angle: number; velocity: number }>;
    muscles: Record<string, { activation: number; force: number; length: number }>;
    grf: { force: Vec3; centerOfPressure: Vec3 | null; contactCount: number; feet: Record<'left' | 'right', Vec3> };
    contacts: { name: string; position: Vec3; force: Vec3 }[];
    tendonPaths: Record<string, Vec3[]>;
    regionalPower: Record<'lower-body' | 'trunk' | 'upper-body', number>;
  }[];
}

const STATIC_POSITIONS: Record<string, Vec3> = {
  pelvis: [0, 0, 0.93], waist: [0, 0, 1.05], neck: [0, 0, 1.37], head: [0, 0, 1.56],
  leftShoulder: [0, 0.18, 1.35], rightShoulder: [0, -0.18, 1.35],
  leftElbow: [0, 0.18, 1.068], rightElbow: [0, -0.18, 1.068],
  leftWrist: [0, 0.18, 0.799], rightWrist: [0, -0.18, 0.799],
  leftHand: [0.02, 0.18, 0.748], rightHand: [0.02, -0.18, 0.748],
  leftHip: [0, 0.095, 0.9], rightHip: [0, -0.095, 0.9],
  leftKnee: [0, 0.1, 0.48], rightKnee: [0, -0.1, 0.48],
  leftAnkle: [0, 0.1, 0.07], rightAnkle: [0, -0.1, 0.07],
  leftHeel: [-0.05, 0.095, 0.02], rightHeel: [-0.05, -0.095, 0.02],
  leftToe: [0.15, 0.095, 0.02], rightToe: [0.15, -0.095, 0.02],
};
const BASE_SEGMENTS: MotionClip['rig']['segments'] = [
  { from: 'pelvis', to: 'neck', radius: 0.14, group: 'torso' },
  { from: 'neck', to: 'head', radius: 0.105, group: 'torso' },
  { from: 'leftShoulder', to: 'leftElbow', radius: 0.048, group: 'arm' },
  { from: 'leftElbow', to: 'leftWrist', radius: 0.036, group: 'arm' },
  { from: 'leftWrist', to: 'leftHand', radius: 0.03, group: 'arm' },
  { from: 'rightShoulder', to: 'rightElbow', radius: 0.05, group: 'arm' },
  { from: 'rightElbow', to: 'rightWrist', radius: 0.038, group: 'arm' },
  { from: 'rightWrist', to: 'rightHand', radius: 0.03, group: 'arm' },
  { from: 'leftHip', to: 'leftKnee', radius: 0.075, group: 'leg' },
  { from: 'leftKnee', to: 'leftAnkle', radius: 0.055, group: 'leg' },
  { from: 'rightHip', to: 'rightKnee', radius: 0.075, group: 'leg' },
  { from: 'rightKnee', to: 'rightAnkle', radius: 0.055, group: 'leg' },
  { from: 'leftAnkle', to: 'leftToe', radius: 0.035, group: 'leg' },
  { from: 'rightAnkle', to: 'rightToe', radius: 0.035, group: 'leg' },
];
const LOWER_BODY_SEGMENTS: MotionClip['rig']['segments'] = [
  { from: 'pelvis', to: 'waist', radius: 0.15, group: 'torso' },
  { from: 'waist', to: 'neck', radius: 0.16, group: 'torso' },
  { from: 'neck', to: 'head', radius: 0.105, group: 'torso' },
  ...BASE_SEGMENTS.filter((segment) => segment.group !== 'torso'),
];

function vec3(values: [Float64Array, Float64Array, Float64Array], index: number): Vec3 {
  return [values[0][index], values[1][index], values[2][index]];
}

export function toMotionClip(experiment: MuscleExperiment, recording: MuscleRecording): MotionClip {
  const sampleStep = 10;
  const sampleIndices: number[] = [];
  for (let k = 0; k < recording.n; k += sampleStep) sampleIndices.push(k);
  if (sampleIndices.at(-1) !== recording.n - 1) sampleIndices.push(recording.n - 1);
  const samples: MotionClip['samples'] = [];
  for (const k of sampleIndices) {
    const positions: Record<string, Vec3> = {};
    for (const [name, values] of recording.positions) positions[name] = vec3(values, k);
    if (positions.shoulder && !positions.rightShoulder) positions.rightShoulder = positions.shoulder;
    if (positions.elbow && !positions.rightElbow) positions.rightElbow = positions.elbow;
    if (positions.wrist && !positions.rightWrist) positions.rightWrist = positions.wrist;
    if (positions.hand && !positions.rightHand) positions.rightHand = positions.hand;
    const joints = Object.fromEntries(recording.joints.map((name) => [name, {
      angle: recording.jointColumns.get(`angle_${name}`)![k],
      velocity: recording.jointColumns.get(`velocity_${name}`)![k],
    }]));
    const muscles = Object.fromEntries(recording.muscles.map((name) => [name, {
      activation: recording.muscleColumns.get(`activation_${name}`)![k],
      force: recording.muscleColumns.get(`force_${name}`)![k],
      length: recording.muscleColumns.get(`length_${name}`)![k],
    }]));
    const feet = Object.fromEntries((['left', 'right'] as const).map((side) => [side, [
      recording.feet.get(side)![0][k], recording.feet.get(side)![1][k], recording.feet.get(side)![2][k],
    ]])) as Record<'left' | 'right', Vec3>;
    const centerOfPressure = recording.hasCenterOfPressure[k]
      ? [recording.centerOfPressure[0][k], recording.centerOfPressure[1][k], recording.centerOfPressure[2][k]] as Vec3
      : null;
    const tendonPaths = Object.fromEntries([...recording.wrapPaths].map(([name, paths]) => [name, paths[k]]));
    const regionalPower = Object.fromEntries([...recording.regionalPower].map(([name, values]) => [name, values[k]])) as MotionClip['samples'][number]['regionalPower'];
    samples.push({
      time: recording.times[k],
      com: [recording.com[0][k], recording.com[1][k], recording.com[2][k]],
      positions, joints, muscles,
      grf: { force: [recording.grf[0][k], recording.grf[1][k], recording.grf[2][k]], centerOfPressure, contactCount: recording.contactCount[k], feet },
      contacts: recording.contacts[k], tendonPaths, regionalPower,
    });
  }
  if (samples.length) samples[samples.length - 1].time = experiment.duration;
  return {
    schemaVersion: 'h3d.motion.v1', id: experiment.id, label: experiment.label,
    duration: experiment.duration, timestep: recording.dt * sampleStep, phases: experiment.phases ?? [],
    rig: {
      kind: experiment.rig.kind,
      staticPositions: STATIC_POSITIONS,
      segments: experiment.rig.kind === 'lower-body' ? LOWER_BODY_SEGMENTS : BASE_SEGMENTS,
      jointNames: recording.joints,
      jointTypes: recording.jointTypes,
      muscles: experiment.muscles.map(({ name, maxIsometricForce, region }) => ({
        name, maxIsometricForce, region: region ?? (experiment.rig.kind === 'lower-body' ? 'lower-body' : 'upper-body'),
      })),
    },
    samples,
  };
}
