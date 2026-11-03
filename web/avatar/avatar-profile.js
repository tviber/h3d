/**
 * Avatar Profile definitions.
 *
 * Maps canonical biomechanical skeleton roles to concrete avatar bone names,
 * rest-pose calibration, and coordinate-frame conventions. Physical models
 * (MuJoCo) never import or know about specific avatar bone names.
 */

export const MAKEHUMAN_DEFAULT_PROFILE = {
  id: 'makehuman-default',
  label: 'MakeHuman 默认人模',
  glbUrl: '/models/human.glb',
  rigUrl: '/models/rig.json',
  scale: 1.0,
  heroicShape: true,
  skinColor: 0xd8d1c7,
  skinRoughness: 0.76,
  skinMetalness: 0.0,
  eyeColor: 0xbdcbd2,
  eyeRadius: 0.0105,
  /**
   * Canonical skeleton mapping:
   * Maps abstract biomechanical roles to the avatar's actual bone names.
   * Replacing with another GLB/GLTF/VRM avatar only requires providing a
   * profile with its own bone names.
   */
  boneMap: {
    pelvis: 'root',
    spine: ['spine05', 'spine04', 'spine03', 'spine02', 'spine01'],
    neck: ['neck01', 'neck02', 'neck03'],
    head: 'head',
    eyeL: 'eye_L',
    eyeR: 'eye_R',
    leftArm: {
      clavicle: 'clavicle_L',
      shoulder: 'shoulder01_L',
      upperArm: 'upperarm01_L',
      upperArmTwist: 'upperarm02_L',
      forearm: 'lowerarm01_L',
      forearmTwist: 'lowerarm02_L',
      wrist: 'wrist_L',
      thumb: ['finger1-1_L', 'finger1-2_L', 'finger1-3_L'],
      index: ['finger2-1_L', 'finger2-2_L', 'finger2-3_L'],
      middle: ['finger3-1_L', 'finger3-2_L', 'finger3-3_L'],
      ring: ['finger4-1_L', 'finger4-2_L', 'finger4-3_L'],
      pinky: ['finger5-1_L', 'finger5-2_L', 'finger5-3_L'],
    },
    rightArm: {
      clavicle: 'clavicle_R',
      shoulder: 'shoulder01_R',
      upperArm: 'upperarm01_R',
      upperArmTwist: 'upperarm02_R',
      forearm: 'lowerarm01_R',
      forearmTwist: 'lowerarm02_R',
      wrist: 'wrist_R',
      thumb: ['finger1-1_R', 'finger1-2_R', 'finger1-3_R'],
      index: ['finger2-1_R', 'finger2-2_R', 'finger2-3_R'],
      middle: ['finger3-1_R', 'finger3-2_R', 'finger3-3_R'],
      ring: ['finger4-1_R', 'finger4-2_R', 'finger4-3_R'],
      pinky: ['finger5-1_R', 'finger5-2_R', 'finger5-3_R'],
    },
    leftLeg: {
      pelvis: 'pelvis_L',
      upperLeg: 'upperleg01_L',
      upperLegTwist: 'upperleg02_L',
      lowerLeg: 'lowerleg01_L',
      lowerLegTwist: 'lowerleg02_L',
      foot: 'foot_L',
      toes: [
        'toe1-1_L', 'toe1-2_L',
        'toe2-1_L', 'toe2-2_L', 'toe2-3_L',
        'toe3-1_L', 'toe3-2_L', 'toe3-3_L',
        'toe4-1_L', 'toe4-2_L', 'toe4-3_L',
        'toe5-1_L', 'toe5-2_L', 'toe5-3_L',
      ],
    },
    rightLeg: {
      pelvis: 'pelvis_R',
      upperLeg: 'upperleg01_R',
      upperLegTwist: 'upperleg02_R',
      lowerLeg: 'lowerleg01_R',
      lowerLegTwist: 'lowerleg02_R',
      foot: 'foot_R',
      toes: [
        'toe1-1_R', 'toe1-2_R',
        'toe2-1_R', 'toe2-2_R', 'toe2-3_R',
        'toe3-1_R', 'toe3-2_R', 'toe3-3_R',
        'toe4-1_R', 'toe4-2_R', 'toe4-3_R',
        'toe5-1_R', 'toe5-2_R', 'toe5-3_R',
      ],
    },
  },
  /**
   * Default natural posture for joints not driven by reduced-order physics models.
   * Coordinates in Three.js viewer space (X = left, Y = up, Z = forward).
   */
  defaultPose: {
    pelvisRestMuJoCoZ: 0.915,
    footToeOutDeg: 7,
    fingerRelaxedFlexDeg: [12, 16, 8],
    leftArmStand: {
      targetOffsetFromShoulder: [0.055, -0.505, 0.015],
      poleOffsetFromShoulder: [0.30, -0.27, -0.14],
      handForward: [0, -1, 0],
      palmNormal: [-1, 0, 0],
    },
    rightArmStand: {
      targetOffsetFromShoulder: [-0.055, -0.505, 0.015],
      poleOffsetFromShoulder: [-0.30, -0.27, -0.14],
      handForward: [0, -1, 0],
      palmNormal: [1, 0, 0],
    },
    leftLegStand: {
      target: [0.135, 0.073646, 0.018],
      pole: [0.22, 0.50, 1.0],
      yawDeg: 7,
      pitchDeg: 0,
    },
    rightLegStand: {
      target: [-0.135, 0.073646, 0.018],
      pole: [-0.22, 0.50, 1.0],
      yawDeg: -7,
      pitchDeg: 0,
    },
  },
};

export const AVATAR_PROFILES = {
  [MAKEHUMAN_DEFAULT_PROFILE.id]: MAKEHUMAN_DEFAULT_PROFILE,
};
