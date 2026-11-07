import {
  Box3,
  Bone,
  Group,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';

const EPS = 1e-5;

/** Error raised when a GLB cannot be safely used by the generic retargeter. */
export class HumanoidInspectionError extends Error {
  constructor(message, diagnostics) {
    super(message);
    this.name = 'HumanoidInspectionError';
    this.diagnostics = diagnostics;
  }
}

const ROLE_ALIASES = {
  pelvis: ['hips', 'pelvis', 'pelvis01', 'hip', 'root'],
  head: ['head', 'head01', 'j_bip_c_head'],
  leftArm: {
    clavicle: ['clavicle_l', 'leftshoulder', 'leftclavicle', 'j_bip_l_shoulder'],
    upperArm: ['upperarm_l', 'leftarm', 'leftupperarm', 'upperarm01_l', 'j_bip_l_upperarm'],
    forearm: ['lowerarm_l', 'leftforearm', 'leftlowerarm', 'forearm_l', 'lowerarm01_l', 'j_bip_l_lowerarm'],
    wrist: ['hand_l', 'lefthand', 'leftwrist', 'wrist_l', 'wrist_l', 'j_bip_l_hand'],
    thumb: ['leftthumb', 'thumb_l', 'finger1_l', 'j_bip_l_thumb1'],
    index: ['leftindex', 'index_l', 'finger2_l', 'j_bip_l_index1'],
    middle: ['leftmiddle', 'middle_l', 'finger3_l', 'j_bip_l_middle1'],
    ring: ['leftring', 'ring_l', 'finger4_l', 'j_bip_l_ring1'],
    pinky: ['leftpinky', 'pinky_l', 'little_l', 'finger5_l', 'j_bip_l_little1'],
  },
  rightArm: {
    clavicle: ['clavicle_r', 'rightshoulder', 'rightclavicle', 'j_bip_r_shoulder'],
    upperArm: ['upperarm_r', 'rightarm', 'rightupperarm', 'upperarm01_r', 'j_bip_r_upperarm'],
    forearm: ['lowerarm_r', 'rightforearm', 'rightlowerarm', 'forearm_r', 'lowerarm01_r', 'j_bip_r_lowerarm'],
    wrist: ['hand_r', 'righthand', 'rightwrist', 'wrist_r', 'j_bip_r_hand'],
    thumb: ['rightthumb', 'thumb_r', 'finger1_r', 'j_bip_r_thumb1'],
    index: ['rightindex', 'index_r', 'finger2_r', 'j_bip_r_index1'],
    middle: ['rightmiddle', 'middle_r', 'finger3_r', 'j_bip_r_middle1'],
    ring: ['rightring', 'ring_r', 'finger4_r', 'j_bip_r_ring1'],
    pinky: ['rightpinky', 'pinky_r', 'little_r', 'finger5_r', 'j_bip_r_little1'],
  },
  leftLeg: {
    pelvis: ['pelvis_l', 'leftupleg', 'leftthigh', 'thigh_l', 'j_bip_l_upperleg'],
    upperLeg: ['upperleg_l', 'leftupleg', 'leftthigh', 'thigh_l', 'upperleg01_l', 'j_bip_l_upperleg'],
    lowerLeg: ['lowerleg_l', 'leftleg', 'leftshin', 'calf_l', 'lowerleg01_l', 'j_bip_l_lowerleg'],
    foot: ['foot_l', 'leftfoot', 'ankle_l', 'leftankle', 'j_bip_l_foot'],
    toes: ['toebase_l', 'lefttoebase', 'toe_l', 'j_bip_l_toebase'],
  },
  rightLeg: {
    pelvis: ['pelvis_r', 'rightupleg', 'rightthigh', 'thigh_r', 'j_bip_r_upperleg'],
    upperLeg: ['upperleg_r', 'rightupleg', 'rightthigh', 'thigh_r', 'upperleg01_r', 'j_bip_r_upperleg'],
    lowerLeg: ['lowerleg_r', 'rightleg', 'rightshin', 'calf_r', 'lowerleg01_r', 'j_bip_r_lowerleg'],
    foot: ['foot_r', 'rightfoot', 'ankle_r', 'rightankle', 'j_bip_r_foot'],
    toes: ['toebase_r', 'righttoebase', 'toe_r', 'j_bip_r_toebase'],
  },
};

function normalizeName(value) {
  return String(value ?? '').toLowerCase().replace(/^.*:/, '').replace(/^mixamorig/, '').replace(/[^a-z0-9]/g, '');
}

function pathOf(node) {
  const parts = [];
  let current = node;
  while (current) {
    const parent = current.parent;
    const same = parent ? parent.children.filter((child) => child.name === current.name) : [];
    const suffix = same.length > 1 ? `[${parent.children.indexOf(current)}]` : '';
    parts.unshift(`${current.name || current.type}${suffix}`);
    current = parent;
  }
  return parts.join('/');
}

function flattenBoneMap(value) {
  const result = new Map();
  const visit = (object, prefix = '') => {
    if (!object || typeof object !== 'object') return;
    for (const [key, item] of Object.entries(object)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof item === 'string') result.set(path, item);
      else visit(item, path);
    }
  };
  visit(value);
  return result;
}

function requiredRole(role) {
  return role === 'pelvis' || role === 'head' || /^(left|right)(Arm|Leg)\.(upperArm|forearm|wrist|upperLeg|lowerLeg|foot)$/.test(role);
}

function roleAliases(role) {
  const [group, key] = role.split('.');
  if (group && key && ROLE_ALIASES[group]?.[key]) return ROLE_ALIASES[group][key];
  if (ROLE_ALIASES[role]) return ROLE_ALIASES[role];
  if (key === 'upperArm' || key === 'forearm' || key === 'wrist') return ROLE_ALIASES.rightArm[key];
  return [];
}

function isFiniteMatrix(matrix) {
  return matrix.elements.every(Number.isFinite);
}

function matrixResidual(matrix) {
  const identity = new Matrix4();
  let max = 0;
  matrix.elements.forEach((value, index) => { max = Math.max(max, Math.abs(value - identity.elements[index])); });
  return max;
}

function isAncestor(parent, child) {
  let current = child.parent;
  while (current) {
    if (current === parent) return true;
    current = current.parent;
  }
  return false;
}

function pickBone(role, bones, byName, overrides, legacy) {
  const override = overrides.get(role) ?? legacy.get(role);
  const candidates = override ? [override] : roleAliases(role);
  for (const candidate of candidates) {
    const wantedPath = String(candidate).startsWith('path:') ? String(candidate).slice(5) : null;
    if (wantedPath) {
      const matches = bones.filter((bone) => pathOf(bone) === wantedPath);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return { ambiguous: matches };
      continue;
    }
    const exact = byName.get(normalizeName(candidate)) ?? [];
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return { ambiguous: exact };
  }
  return null;
}

function addDiagnosticError(diagnostics, message) {
  diagnostics.errors.push(message);
}

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new TypeError('Avatar profile is required');
  const schema = profile.schemaVersion ?? 'h3d.avatar-profile.v1-legacy';
  if (profile.schemaVersion && profile.schemaVersion !== 'h3d.avatar-profile.v2') {
    throw new TypeError(`Unsupported avatar profile schema: ${profile.schemaVersion}`);
  }
  const preset = profile.rig?.preset;
  if (preset && !['auto', 'mixamo', 'makehuman', 'vrm'].includes(preset)) {
    throw new TypeError(`Unsupported humanoid rig preset: ${preset}`);
  }
  return schema;
}

function checkScales(model, diagnostics) {
  model.traverse((node) => {
    const scale = node.scale;
    if (!isFiniteMatrix(node.matrixWorld) || ![...node.position, ...node.quaternion, ...scale].every(Number.isFinite)) {
      addDiagnosticError(diagnostics, `Non-finite transform at ${pathOf(node)}`);
    }
    if (scale.x <= 0 || scale.y <= 0 || scale.z <= 0) {
      addDiagnosticError(diagnostics, `Negative or zero scale is unsupported at ${pathOf(node)}`);
    }
    const max = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
    const min = Math.min(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
    if (max - min > EPS * max) addDiagnosticError(diagnostics, `Non-uniform scale is unsupported at ${pathOf(node)}`);
  });
}

function verifySkins(model, diagnostics, members) {
  let skinCount = 0;
  model.traverse((object) => {
    if (!object.isSkinnedMesh) return;
    skinCount++;
    const skeleton = object.skeleton;
    if (!skeleton || !skeleton.bones.length || skeleton.boneInverses.length !== skeleton.bones.length) {
      addDiagnosticError(diagnostics, `Skinned mesh ${object.name || '<unnamed>'} has an incomplete skeleton`);
      return;
    }
    // J_bind * inverseBind must describe the same bind shape for every joint.
    // It need not equal identity: a legitimate imported parent transform is common
    // to all joints. Comparing against that common matrix preserves such transforms.
    const reference = new Matrix4().multiplyMatrices(skeleton.bones[0].matrixWorld, skeleton.boneInverses[0]);
    if (!isFiniteMatrix(reference) || Math.abs(reference.determinant()) < 1e-12) {
      addDiagnosticError(diagnostics, `Invalid bind shape at ${object.name}`);
      return;
    }
    const inverseReference = reference.clone().invert();
    skeleton.boneInverses.forEach((inverse, index) => {
      const bone = skeleton.bones[index];
      if (!members.has(bone)) addDiagnosticError(diagnostics, `Skin joint ${bone?.name} is outside the imported scene`);
      if (!isFiniteMatrix(inverse) || Math.abs(inverse.determinant()) < 1e-12) {
        addDiagnosticError(diagnostics, `Invalid inverse bind matrix at ${object.name}:${index}`);
        return;
      }
      const relative = inverseReference.clone().multiply(bone.matrixWorld).multiply(inverse);
      const residual = matrixResidual(relative);
      if (residual > 2e-3) addDiagnosticError(diagnostics, `Bind pose mismatch at ${object.name}:${bone.name} (residual ${residual.toExponential(2)})`);
    });
    const weights = object.geometry?.getAttribute('skinWeight');
    const indices = object.geometry?.getAttribute('skinIndex');
    const positions = object.geometry?.getAttribute('position');
    if (!weights || !indices || !positions || weights.count !== positions.count || indices.count !== positions.count || weights.itemSize !== 4 || indices.itemSize !== 4) {
      addDiagnosticError(diagnostics, `Invalid skin attributes at ${object.name}`);
      return;
    }
    for (let i = 0; i < weights.count; i++) {
      let sum = 0;
      for (let j = 0; j < 4; j++) {
        const weight = weights.getComponent(i, j), index = indices.getComponent(i, j);
        if (!Number.isFinite(weight) || weight < 0 || !Number.isInteger(index) || index < 0 || index >= skeleton.bones.length) {
          addDiagnosticError(diagnostics, `Invalid skin influence at ${object.name}:vertex ${i}`);
          return;
        }
        sum += weight;
      }
      if (Math.abs(sum - 1) > 0.02) {
        addDiagnosticError(diagnostics, `Unnormalized skin weights at ${object.name}:vertex ${i}`);
        return;
      }
    }
  });
  if (!skinCount) diagnostics.warnings.push('Model contains no SkinnedMesh; only skeleton motion can be validated');
  diagnostics.skinCount = skinCount;
}

function captureRest(bones) {
  const rest = new Map();
  for (const bone of bones) {
    rest.set(bone, {
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
      scale: bone.scale.clone(),
      worldPosition: bone.getWorldPosition(new Vector3()),
      worldQuaternion: bone.getWorldQuaternion(new Quaternion()),
      worldScale: bone.getWorldScale(new Vector3()),
    });
  }
  return rest;
}

function makeChain(roles, side, kind) {
  const upper = roles.get(`${side}${kind}.upper${kind === 'Arm' ? 'Arm' : 'Leg'}`);
  const lower = roles.get(`${side}${kind}.${kind === 'Arm' ? 'forearm' : 'lowerLeg'}`);
  const end = roles.get(`${side}${kind}.${kind === 'Arm' ? 'wrist' : 'foot'}`);
  if (!upper || !lower || !end) return null;
  const upperLength = upper.getWorldPosition(new Vector3()).distanceTo(lower.getWorldPosition(new Vector3()));
  const lowerLength = lower.getWorldPosition(new Vector3()).distanceTo(end.getWorldPosition(new Vector3()));
  return { upper, lower, end, upperLength, lowerLength };
}

/**
 * Inspect a loaded GLTF scene and create a bind-aware, normalized Humanoid description.
 * The original meshes, materials, skin weights and inverse bind matrices remain untouched.
 */
export function inspectHumanoid(model, profile = {}) {
  const schemaVersion = validateProfile(profile);
  if (!model || typeof model.traverse !== 'function') throw new TypeError('A Three.js Object3D model is required');
  if (model.parent) throw new TypeError('Inspect an unattached imported scene, before adding it to the viewer');
  model.updateMatrixWorld(true);
  const diagnostics = { ok: true, schemaVersion, errors: [], warnings: [], skinCount: 0, ambiguousRoles: [], missingOptionalRoles: [], capabilities: {} };
  const members = new Set();
  model.traverse(node => members.add(node));
  checkScales(model, diagnostics);
  verifySkins(model, diagnostics, members);
  const bones = [...members].filter(node => node.isBone);
  const byName = new Map();
  for (const node of bones) {
    const key = normalizeName(node.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(node);
  }
  if (!bones.length) addDiagnosticError(diagnostics, 'Model contains no bones');
  const overrides = flattenBoneMap(profile.rig?.boneOverrides);
  const legacy = flattenBoneMap(profile.boneMap);
  const roles = new Map();
  const allRoleNames = [
    'pelvis', 'head',
    ...['leftArm', 'rightArm'].flatMap(side => ['clavicle', 'upperArm', 'forearm', 'wrist', 'thumb', 'index', 'middle', 'ring', 'pinky'].map(key => `${side}.${key}`)),
    ...['leftLeg', 'rightLeg'].flatMap(side => ['upperLeg', 'lowerLeg', 'foot', 'toes'].map(key => `${side}.${key}`)),
  ];
  for (const role of allRoleNames) {
    const picked = pickBone(role, bones, byName, overrides, legacy);
    if (picked?.ambiguous) {
      diagnostics.ambiguousRoles.push({ role, candidates: picked.ambiguous.map(bone => `path:${pathOf(bone)}`) });
      addDiagnosticError(diagnostics, `Ambiguous bone mapping for ${role}`);
    } else if (picked) roles.set(role, picked);
    else if (requiredRole(role) || overrides.has(role)) addDiagnosticError(diagnostics, `Missing required humanoid role ${role}`);
    else diagnostics.missingOptionalRoles.push(role);
  }
  const pelvis = roles.get('pelvis'), head = roles.get('head');
  const requiredBones = new Set();
  for (const [role, bone] of roles) if (requiredRole(role)) {
    if (requiredBones.has(bone)) addDiagnosticError(diagnostics, `Bone ${bone.name} is mapped to multiple required roles`);
    requiredBones.add(bone);
  }
  const torsoPath = [];
  if (pelvis && head) {
    let current = head.parent;
    while (current && current !== pelvis) { if (current.isBone) torsoPath.unshift(current); current = current.parent; }
    if (current !== pelvis) addDiagnosticError(diagnostics, 'Head is not descended from pelvis');
  }
  function torsoChain(name) {
    const custom = [...overrides, ...legacy].filter(([role]) => role.startsWith(`${name}.`)).sort(([a], [b]) => Number(a.split('.')[1]) - Number(b.split('.')[1]));
    if (custom.length) return custom.map(([role, selector]) => {
      const bone = pickBone(role, bones, byName, new Map([[role, selector]]), new Map());
      if (!bone || bone.ambiguous || !torsoPath.includes(bone)) { addDiagnosticError(diagnostics, `Invalid ${role} mapping`); return null; }
      return bone;
    }).filter(Boolean);
    return torsoPath.filter(bone => name === 'neck' ? /neck/i.test(bone.name) : !/neck|root|hips|pelvis/i.test(bone.name));
  }
  const spine = torsoChain('spine'), neck = torsoChain('neck');
  if (!spine.length) addDiagnosticError(diagnostics, 'Missing required humanoid spine chain');
  for (let i = 1; i < spine.length; i++) if (!isAncestor(spine[i - 1], spine[i])) addDiagnosticError(diagnostics, 'Spine mapping is not ordered from pelvis to head');
  spine.forEach((bone, i) => roles.set(`spine.${i}`, bone));
  neck.forEach((bone, i) => roles.set(`neck.${i}`, bone));
  const buildChains = () => ({
    leftArm: makeChain(roles, 'left', 'Arm'), rightArm: makeChain(roles, 'right', 'Arm'),
    leftLeg: makeChain(roles, 'left', 'Leg'), rightLeg: makeChain(roles, 'right', 'Leg'),
  });
  for (const [name, chain] of Object.entries(buildChains())) if (chain) {
    if (!isAncestor(chain.upper, chain.lower) || !isAncestor(chain.lower, chain.end) || !isAncestor(pelvis, chain.upper)) addDiagnosticError(diagnostics, `${name} bones are not a valid parent chain`);
    if (chain.upperLength < EPS || chain.lowerLength < EPS) addDiagnosticError(diagnostics, `${name} contains a zero-length segment`);
  }
  if (diagnostics.errors.length) {
    diagnostics.ok = false;
    throw new HumanoidInspectionError(`Humanoid inspection failed: ${diagnostics.errors.join('; ')}`, diagnostics);
  }

  const calibration = profile.calibration ?? {};
  const unitScale = calibration.unitScale ?? 1;
  if (!Number.isFinite(unitScale) || unitScale <= 0) throw new TypeError('Avatar calibration.unitScale must be positive');
  if (calibration.units && !['asset', 'm'].includes(calibration.units)) throw new TypeError('Use calibration.unitScale for a known unit conversion; units auto-detection is not supported');
  if (calibration.up && !['+Y', 'asset'].includes(calibration.up)) throw new TypeError(`Unsupported avatar up axis: ${calibration.up}; export glTF Y-up first`);
  if (calibration.bindPose && calibration.bindPose !== 'asset') throw new TypeError('Only calibration.bindPose="asset" is supported');
  if (calibration.overrides && Object.keys(calibration.overrides).length) throw new TypeError('calibration.overrides is not implemented; use rig.boneOverrides for node mappings');
  let forward = calibration.forward ?? 'auto';
  const left = roles.get('leftLeg.upperLeg').getWorldPosition(new Vector3());
  const right = roles.get('rightLeg.upperLeg').getWorldPosition(new Vector3());
  const lateral = left.sub(right);
  if (Math.hypot(lateral.x, lateral.z) < EPS) throw new HumanoidInspectionError('Cannot determine left/right anatomical axis', { ...diagnostics, ok: false, errors: ['Ambiguous anatomical lateral axis'] });
  let forwardYaw;
  if (forward === 'auto' || forward === 'asset') {
    forwardYaw = Math.atan2(lateral.z, lateral.x);
    diagnostics.warnings.push('Forward was inferred from left/right hip roles; verify the front-view calibration');
  } else {
    forwardYaw = { '+Z': 0, '-Z': Math.PI, '+X': -Math.PI / 2, '-X': Math.PI / 2 }[forward];
    if (forwardYaw === undefined) throw new TypeError(`Unsupported avatar forward axis: ${forward}`);
  }
  const wrapper = new Group();
  wrapper.name = `${model.name || 'Humanoid'}_normalized`;
  wrapper.scale.setScalar(unitScale);
  wrapper.rotation.y = forwardYaw;
  wrapper.add(model);
  wrapper.updateMatrixWorld(true);
  function failNormalized(message) {
    wrapper.remove(model);
    model.updateMatrixWorld(true);
    throw new HumanoidInspectionError(message, { ...diagnostics, ok: false, errors: [message] });
  }
  let bounds = new Box3().setFromObject(model, true);
  if (bounds.isEmpty()) for (const bone of bones) bounds.expandByPoint(bone.getWorldPosition(new Vector3()));
  const height = bounds.max.y - bounds.min.y;
  if (!Number.isFinite(height) || height < 0.25 || height > 5) failNormalized('Humanoid height is outside the supported 0.25–5 metre range; check calibration.unitScale');
  wrapper.position.y -= bounds.min.y;
  wrapper.updateMatrixWorld(true);
  const rest = captureRest(bones);
  const lHip = rest.get(roles.get('leftLeg.upperLeg')).worldPosition;
  const rHip = rest.get(roles.get('rightLeg.upperLeg')).worldPosition;
  if (lHip.x <= rHip.x + EPS) failNormalized('Left/right hip roles conflict with the declared forward axis');
  for (const side of ['left', 'right']) {
    const arm = rest.get(roles.get(`${side}Arm.upperArm`)).worldPosition;
    const hip = rest.get(roles.get(`${side}Leg.upperLeg`)).worldPosition;
    const knee = rest.get(roles.get(`${side}Leg.lowerLeg`)).worldPosition;
    const ankle = rest.get(roles.get(`${side}Leg.foot`)).worldPosition;
    if (arm.y <= hip.y || hip.y <= knee.y || knee.y <= ankle.y || rest.get(head).worldPosition.y <= arm.y) failNormalized('Bind pose is not an upright humanoid A/T pose; check up-axis and bone mapping');
  }
  const chains = buildChains();
  const soleOffsets = { left: new Vector3(), right: new Vector3() };
  const soleWorldOffsets = { left: new Vector3(), right: new Vector3() };
  for (const side of ['left', 'right']) {
    const foot = roles.get(`${side}Leg.foot`), footRest = rest.get(foot);
    const soleWorld = new Vector3(footRest.worldPosition.x, 0, footRest.worldPosition.z);
    soleOffsets[side] = foot.worldToLocal(soleWorld.clone());
    soleWorldOffsets[side] = soleWorld.sub(footRest.worldPosition);
  }
  for (const kind of ['Arm', 'Leg']) {
    const l = chains[`left${kind}`], r = chains[`right${kind}`];
    const ratio = (l.upperLength + l.lowerLength) / (r.upperLength + r.lowerLength);
    if (ratio < 0.7 || ratio > 1.43) diagnostics.warnings.push(`${kind} lengths are asymmetric; verify mapped joints and expected proportions`);
  }
  diagnostics.height = height;
  diagnostics.groundY = 0;
  diagnostics.capabilities = {
    torso: true, arms: true, legs: true,
    fingers: diagnostics.missingOptionalRoles.every(role => !/thumb|index|middle|ring|pinky/.test(role)),
    toes: Boolean(roles.get('leftLeg.toes') && roles.get('rightLeg.toes')),
    twist: false,
  };
  const nodeSelectors = new Map(bones.map(bone => [bone, `path:${pathOf(bone).split('/').slice(1).join('/')}`]));
  return { model: wrapper, roles, rest, chains, spine, neck, pelvis, head, height, groundY: 0, soleOffsets, soleWorldOffsets, nodeSelectors, diagnostics, profile };
}

/** A selector usable in rig.boneOverrides before normalization. */
export function roleBonePath(bone) { return `path:${pathOf(bone)}`; }
