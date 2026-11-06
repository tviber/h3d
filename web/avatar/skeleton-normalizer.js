/**
 * Skeleton normalization: map an arbitrary glTF bone hierarchy onto the canonical
 * h3d humanoid roles and compute the explicit Source -> Canonical frame transform.
 *
 * Frames (see docs/avatar-pipeline.md):
 * - Source Model frame: whatever the GLB scene graph produces (any up/forward/units).
 * - Canonical Humanoid frame: metres, +Y up, +Z forward (character faces +Z), +X = character's left,
 *   feet on y = 0, hips centred on x = z = 0. This is the Three.js viewer frame.
 * - h3d / MuJoCo motion frame: +X forward, +Y left, +Z up (see mjVecToThree in avatar-adapter.js).
 *
 * This module never mutates bones; it only reads hierarchy and positions.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';

export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];

/** Roles the AvatarAdapter can drive. VRM 1.0 humanoid names are used where they exist. */
export const CANONICAL_BONES = {
  required: [
    'hips', 'spine', 'head',
    'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  ],
  optional: [
    'chest', 'upperChest', 'neck', 'leftShoulder', 'rightShoulder', 'leftToes', 'rightToes',
    'leftUpperArmTwist', 'rightUpperArmTwist', 'leftLowerArmTwist', 'rightLowerArmTwist',
    ...['left', 'right'].flatMap((side) => FINGERS.map((finger) => `${side}${finger}`)),
  ],
};
const ALL_ROLES = new Set([...CANONICAL_BONES.required, ...CANONICAL_BONES.optional]);

/** Minimal role set per motion kind: missing these makes playback meaningless, so we refuse. */
export const MOTION_REQUIREMENTS = {
  elbow: ['hips', 'rightUpperArm', 'rightLowerArm', 'rightHand'],
  'shoulder-elbow': ['hips', 'rightUpperArm', 'rightLowerArm', 'rightHand'],
  'lower-body': [
    'hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  ],
};
/** Roles the default standing pose touches for every motion. */
const STAND_REQUIREMENTS = [
  'hips', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
];

/** @type {Record<string, string>} */
const VRM0_TO_VRM1 = { leftThumbProximal: 'leftThumb', rightThumbProximal: 'rightThumb' };
const PREFIXES = /^(?:mixamorig\d*[:_]?|bip0?1[ _]?|cc_base_|def[-_]|org[-_]|mch[-_]|armature[|:_]|character\d*[:_])/i;

/** Split a bone name into its side and a lowercase role core (digits kept separately). */
export function parseBoneName(name) {
  let value = String(name ?? '').trim().replace(PREFIXES, '');
  let side = null;
  const take = (s) => { if (!side) side = s; return ' '; };
  value = value
    .replace(/[._ -]([lr])$/i, (_, s) => take(s.toLowerCase() === 'l' ? 'left' : 'right'))
    .replace(/^([lr])[._ -]/i, (_, s) => take(s.toLowerCase() === 'l' ? 'left' : 'right'))
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/(left|right)/gi, (s) => take(s.toLowerCase()));
  // A standalone side letter in the middle, e.g. "Bip01 L UpperArm" after prefix removal.
  value = value.replace(/(?:^|[\s_.-])([LR])(?=[\s_.-]|$)/g, (m, s) => take(s === 'L' ? 'left' : 'right'));
  const core = value.toLowerCase().replace(/[^a-z]/g, '');
  const digits = value.replace(/[^0-9]/g, '');
  return { side, core, digits };
}

/** @type {Record<string, RegExp>} */
const ROLE_PATTERNS = {
  hips: /^(?:hips?|pelvis)$/,
  spine: /^(?:spine|torso|back|abdomen|chest|upperchest)$/,
  neck: /^neck$/,
  head: /^head$/,
  shoulder: /^(?:clavicle|collar|collarbone|shoulder)$/,
  upperArm: /^(?:upperarm|arm|uparm|humerus)$/,
  lowerArm: /^(?:lowerarm|forearm|elbow|radius|lowarm)$/,
  hand: /^(?:hand|wrist)$/,
  upperLeg: /^(?:upperleg|upleg|thigh|femur)$/,
  lowerLeg: /^(?:lowerleg|leg|calf|shin|knee|tibia|lowleg)$/,
  foot: /^(?:foot|ankle)$/,
  toes: /^(?:toes?|toebase|ball)$/,
  thumb: /thumb/,
  index: /index|pointer/,
  middle: /middle/,
  ring: /ring/,
  little: /pinky|little/,
};

/** Build a lightweight tree view (name, parent, children, depth, head) from AvatarRigInfo bones. */
export function buildBoneTree(bones) {
  const nodes = new Map(bones.map((bone) => [bone.name, { ...bone, children: [], depth: 0 }]));
  for (const node of nodes.values()) {
    const parent = node.parent ? nodes.get(node.parent) : null;
    if (parent) parent.children.push(node);
  }
  const roots = [...nodes.values()].filter((node) => !node.parent || !nodes.has(node.parent));
  const order = [];
  const visit = (node, depth) => { node.depth = depth; order.push(node); node.children.forEach((child) => visit(child, depth + 1)); };
  roots.forEach((root) => visit(root, 0));
  return { nodes, roots, order };
}

function isAncestor(tree, ancestor, name) {
  let node = tree.nodes.get(name);
  while (node?.parent) {
    if (node.parent === ancestor) return true;
    node = tree.nodes.get(node.parent);
  }
  return false;
}

function pathFromAncestor(tree, ancestor, name) {
  const path = [];
  let node = tree.nodes.get(name);
  while (node && node.name !== ancestor) { path.unshift(node.name); node = tree.nodes.get(node.parent); }
  return node ? path : [];
}

function lowestCommonAncestor(tree, a, b) {
  const seen = new Set();
  for (let node = tree.nodes.get(a); node; node = tree.nodes.get(node.parent)) seen.add(node.name);
  for (let node = tree.nodes.get(b); node; node = tree.nodes.get(node.parent)) if (seen.has(node.name)) return node.name;
  return null;
}

function subtreeNames(node, out = []) {
  out.push(node.name);
  for (const child of node.children) subtreeNames(child, out);
  return out;
}

/** Map VRMC_vrm (1.0) or VRM (0.x) humanoid node references to actual Three.js bone names. */
export function readVrmHumanoidMap(gltf) {
  const json = gltf?.parser?.json;
  const humanBones = json?.extensions?.VRMC_vrm?.humanoid?.humanBones;
  const legacy = json?.extensions?.VRM?.humanoid?.humanBones;
  const entries = humanBones
    ? Object.entries(humanBones).map(([bone, ref]) => [bone, ref?.node])
    : Array.isArray(legacy) ? legacy.map((item) => [item.bone, item.node]) : [];
  if (!entries.length) return {};
  const nameByNode = new Map();
  gltf.scene?.traverse((object) => {
    const nodeIndex = gltf.parser?.associations?.get(object)?.nodes;
    if (Number.isInteger(nodeIndex) && object.isBone) nameByNode.set(nodeIndex, object.name);
  });
  const result = {};
  for (const [vrmName, node] of entries) {
    const role = VRM0_TO_VRM1[vrmName] ?? vrmName;
    const boneName = nameByNode.get(node);
    if (ALL_ROLES.has(role) && boneName) result[role] = boneName;
  }
  return result;
}

/** Name-based candidates for a role (optionally side-restricted), sorted from root toward leaves. */
function nameCandidates(tree, role, side) {
  return tree.order.filter((node) => {
    const parsed = parseBoneName(node.name);
    if (side !== undefined && parsed.side !== side) return false;
    return ROLE_PATTERNS[role].test(parsed.core);
  });
}

/** @param {ReturnType<typeof buildBoneTree>} tree */
function inferByName(tree) {
  /** @type {Record<string, any>} */
  const map = {};
  const first = (list, predicate = () => true) => list.find(predicate)?.name;
  map.hips = first(nameCandidates(tree, 'hips', null));
  map.head = first(nameCandidates(tree, 'head', null));
  map.neck = first(nameCandidates(tree, 'neck', null));
  for (const side of ['left', 'right']) {
    const upperArm = first(nameCandidates(tree, 'upperArm', side));
    const lowerArm = first(nameCandidates(tree, 'lowerArm', side), (n) => !upperArm || isAncestor(tree, upperArm, n.name));
    const hand = first(nameCandidates(tree, 'hand', side), (n) => !lowerArm || isAncestor(tree, lowerArm, n.name));
    const shoulder = first(nameCandidates(tree, 'shoulder', side), (n) => upperArm && isAncestor(tree, n.name, upperArm));
    const upperLeg = first(nameCandidates(tree, 'upperLeg', side));
    const lowerLeg = first(nameCandidates(tree, 'lowerLeg', side), (n) => upperLeg && isAncestor(tree, upperLeg, n.name));
    const foot = first(nameCandidates(tree, 'foot', side), (n) => lowerLeg && isAncestor(tree, lowerLeg, n.name));
    const toes = first(nameCandidates(tree, 'toes', side), (n) => foot && isAncestor(tree, foot, n.name));
    Object.assign(map, {
      [`${side}Shoulder`]: shoulder,
      [`${side}UpperArm`]: upperArm,
      [`${side}LowerArm`]: lowerArm,
      [`${side}Hand`]: hand,
      [`${side}UpperLeg`]: upperLeg,
      [`${side}LowerLeg`]: lowerLeg,
      [`${side}Foot`]: foot,
      [`${side}Toes`]: toes,
    });
    // Twist bones: a second same-role bone on the chain between upper/lower arm or lower arm/hand.
    const upperTwist = nameCandidates(tree, 'upperArm', side).find((n) => n.name !== upperArm && upperArm && lowerArm
      && isAncestor(tree, upperArm, n.name) && isAncestor(tree, n.name, lowerArm));
    const lowerTwist = nameCandidates(tree, 'lowerArm', side).find((n) => n.name !== lowerArm && lowerArm && hand
      && isAncestor(tree, lowerArm, n.name) && isAncestor(tree, n.name, hand));
    map[`${side}UpperArmTwist`] = upperTwist?.name;
    map[`${side}LowerArmTwist`] = lowerTwist?.name;
  }
  return map;
}

/**
 * Structural fallback for rigs whose names carry no semantics (e.g. "bone_17" from AI riggers).
 * Assumes the glTF convention (+Y up, character faces +Z so its left is +X); the caller reports this
 * assumption and the frame detector re-checks it afterwards.
 */
/** @param {ReturnType<typeof buildBoneTree>} tree @param {Record<string, any>} map */
function inferByStructure(tree, map) {
  const nodes = [...tree.nodes.values()];
  if (!nodes.length) return;
  const ys = nodes.map((node) => node.head[1]);
  const floor = Math.min(...ys), top = Math.max(...ys);
  const h = Math.max(1e-6, top - floor);
  const ext = new Map();
  for (const node of [...tree.order].reverse()) {
    const own = { minY: node.head[1], maxY: node.head[1], minX: node.head[0], maxX: node.head[0] };
    for (const child of node.children) {
      const c = ext.get(child.name);
      own.minY = Math.min(own.minY, c.minY); own.maxY = Math.max(own.maxY, c.maxY);
      own.minX = Math.min(own.minX, c.minX); own.maxX = Math.max(own.maxX, c.maxX);
    }
    ext.set(node.name, own);
  }
  const reachesFloor = (n) => ext.get(n.name).minY < floor + 0.15 * h;
  const reachesTop = (n) => ext.get(n.name).maxY > floor + 0.8 * h;

  if (!map.hips) {
    map.hips = tree.order.find((node) => node.head[1] > floor + 0.3 * h && node.head[1] < floor + 0.75 * h
      && node.children.filter(reachesFloor).length >= 2 && node.children.some(reachesTop))?.name;
  }
  const hips = tree.nodes.get(map.hips);
  if (!hips) return;
  const hipsX = hips.head[0];
  const follow = (start, score) => {
    const chain = [start];
    let node = start;
    while (node.children.length) {
      node = node.children.reduce((best, child) => (score(child) > score(best) ? child : best));
      chain.push(node);
    }
    return chain;
  };

  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? 1 : -1;
    if (!map[`${side}UpperLeg`] || !map[`${side}Foot`]) {
      const branch = hips.children.filter(reachesFloor)
        .sort((a, b) => sign * (ext.get(b.name).maxX + ext.get(b.name).minX - ext.get(a.name).maxX - ext.get(a.name).minX))[0];
      if (branch) {
        const chain = follow(branch, (n) => -ext.get(n.name).minY);
        // Hip joints sit lateral to the pelvis root; pelvis helper bones (MakeHuman pelvis_L) do not.
        const upperIndex = chain.findIndex((n) => sign * (n.head[0] - hipsX) > 0.03 * h);
        const ankleY = floor + 0.045 * h;
        const footIndex = chain.reduce((best, n, i) => (i > upperIndex && n.head[1] > floor + 0.012 * h
          && Math.abs(n.head[1] - ankleY) < Math.abs(chain[best]?.head[1] - ankleY) ? i : best), chain.length - 1);
        const upper = chain[upperIndex], foot = chain[footIndex];
        if (upper && foot && footIndex - upperIndex >= 2) {
          const midY = (upper.head[1] + foot.head[1]) / 2;
          const knee = chain.slice(upperIndex + 1, footIndex)
            .reduce((best, n) => (Math.abs(n.head[1] - midY) < Math.abs(best.head[1] - midY) ? n : best));
          map[`${side}UpperLeg`] ??= upper.name;
          map[`${side}LowerLeg`] ??= knee.name;
          map[`${side}Foot`] ??= foot.name;
          if (chain[footIndex + 1]) map[`${side}Toes`] ??= chain[footIndex + 1].name;
        }
      }
    }
  }

  // Upper body: walk upward to the bone where both arm branches split off.
  const up = hips.children.filter((child) => reachesTop(child) && !reachesFloor(child))[0];
  if (!up) return;
  const lateral = (n, sign) => (sign > 0 ? ext.get(n.name).maxX - hipsX : hipsX - ext.get(n.name).minX);
  let chestTop = null;
  for (let node = up; node; node = node.children.find(reachesTop)) {
    // Both arms must leave through *different* children; a single spine child carrying both
    // arms means we have not reached the shoulder girdle yet.
    const left = node.children.find((c) => lateral(c, 1) > 0.18 * h);
    const right = node.children.find((c) => c !== left && lateral(c, -1) > 0.18 * h);
    if (left && right) { chestTop = node; break; }
    if (!node.children.length) break;
  }
  if (!chestTop) return;
  if (!map.spine) map.spine = [up.name];
  if (!map.head) {
    const neckBranch = chestTop.children.filter(reachesTop).sort((a, b) => ext.get(b.name).maxY - ext.get(a.name).maxY)[0];
    if (neckBranch) {
      const chain = follow(neckBranch, (n) => ext.get(n.name).maxY);
      const target = floor + 0.91 * h;
      const head = chain.reduce((best, n) => (Math.abs(n.head[1] - target) < Math.abs(best.head[1] - target) ? n : best));
      map.head = head.name;
      if (!map.neck && head !== neckBranch) map.neck = neckBranch.name;
    }
  }
  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? 1 : -1;
    if (map[`${side}UpperArm`] && map[`${side}Hand`]) continue;
    const branch = chestTop.children.filter((c) => lateral(c, sign) > 0.18 * h)
      .sort((a, b) => lateral(b, sign) - lateral(a, sign))[0];
    if (!branch) continue;
    const chain = follow(branch, (n) => lateral(n, sign));
    // Clavicle heads sit next to the spine (< ~3 % of height laterally in Mixamo, MakeHuman, VRoid);
    // the first chain bone clearly lateral to that is taken as the glenohumeral (upper arm) joint.
    const upperIndex = chain.findIndex((n) => sign * (n.head[0] - hipsX) > 0.045 * h);
    if (upperIndex < 0) continue;
    let handIndex = chain.findIndex((n, i) => i > upperIndex + 1 && n.children.length >= 3);
    if (handIndex < 0) handIndex = Math.min(chain.length - 1, upperIndex + 2);
    if (handIndex - upperIndex < 2) continue;
    // Elbow = chain joint closest to ~47 % of the shoulder->wrist arc length (upper arm vs forearm
    // ratio 0.186 : 0.146 H is too variable to trust, but the elbow is always near the middle).
    const arc = [0];
    for (let i = upperIndex + 1; i <= handIndex; i++) {
      const a = chain[i - 1].head, b = chain[i].head;
      arc.push(arc.at(-1) + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    const total = Math.max(1e-9, arc.at(-1));
    let elbow = chain[upperIndex + 1], best = Infinity;
    for (let i = upperIndex + 1; i < handIndex; i++) {
      const score = Math.abs(arc[i - upperIndex] / total - 0.47);
      if (score < best) { best = score; elbow = chain[i]; }
    }
    map[`${side}UpperArm`] ??= chain[upperIndex].name;
    map[`${side}LowerArm`] ??= elbow.name;
    map[`${side}Hand`] ??= chain[handIndex].name;
    if (upperIndex > 0) map[`${side}Shoulder`] ??= chain[upperIndex - 1].name;
  }
}

/** Finger chains: up to three bones starting at the root nearest to the hand. */
/** @param {ReturnType<typeof buildBoneTree>} tree @param {Record<string, any>} map */
function inferFingers(tree, map) {
  for (const side of ['left', 'right']) {
    const hand = tree.nodes.get(map[`${side}Hand`]);
    if (!hand) continue;
    const descendants = subtreeNames(hand).slice(1).map((name) => tree.nodes.get(name));
    for (const [finger, role] of [['Thumb', 'thumb'], ['Index', 'index'], ['Middle', 'middle'], ['Ring', 'ring'], ['Little', 'little']]) {
      if (map[`${side}${finger}`]) continue;
      const root = descendants.find((n) => ROLE_PATTERNS[role].test(parseBoneName(n.name).core)
        || (parseBoneName(n.name).core.startsWith('finger') && fingerNumber(n.name) === FINGERS.indexOf(finger) + 1));
      if (root) map[`${side}${finger}`] = root.name;
    }
  }
}

/** MakeHuman-style "finger3-1_L" -> 3. */
function fingerNumber(name) {
  const match = /finger(\d)/i.exec(name);
  return match ? Number(match[1]) : -1;
}

/** Fill hips/spine/chest/neck from hierarchy once limbs are known (works for any naming). */
/** @param {ReturnType<typeof buildBoneTree>} tree @param {Record<string, any>} map */
function inferTrunk(tree, map) {
  if (map.leftUpperLeg && map.rightUpperLeg) {
    const lca = lowestCommonAncestor(tree, map.leftUpperLeg, map.rightUpperLeg);
    if (!map.hips || (lca && isAncestor(tree, map.hips, lca))) map.hips = lca ?? map.hips;
  }
  const armRoot = map.leftUpperArm && map.rightUpperArm ? lowestCommonAncestor(tree, map.leftUpperArm, map.rightUpperArm) : null;
  if (map.hips && armRoot && (armRoot === map.hips || isAncestor(tree, map.hips, armRoot))) {
    const path = pathFromAncestor(tree, map.hips, armRoot);
    if (path.length && (!Array.isArray(map.spine) || !map.spine.length || map.spine.length === 1)) map.spine = path;
    if (path.length >= 2) map.chest ??= path[path.length - 1];
    if (map.head && isAncestor(tree, armRoot, map.head)) {
      const neckPath = pathFromAncestor(tree, armRoot, map.head).slice(0, -1);
      if (neckPath.length) map.neck = neckPath;
    }
  }
  if (typeof map.spine === 'string') map.spine = [map.spine];
  if (typeof map.neck === 'string') map.neck = [map.neck];
}

function fingerChain(tree, rootName, maxLength = 3) {
  const chain = [];
  for (let node = tree.nodes.get(rootName); node && chain.length < maxLength; node = node.children[0]) chain.push(node.name);
  return chain;
}

/**
 * Infer the canonical humanoid map. Precedence (highest first): manual overrides, VRM humanoid,
 * name + hierarchy matching, structural (geometry + hierarchy) fallback.
 * Returns { map, sources } where sources[role] is 'manual' | 'vrm' | 'name' | 'structure'.
 */
export function inferHumanoidBoneMap(bones, { vrm = {}, overrides = {} } = {}) {
  const tree = buildBoneTree(bones);
  const exists = (name) => typeof name === 'string' && tree.nodes.has(name);
  /** @type {Record<string, any>} */
  const map = {};
  const sources = {};
  const assign = (values, source) => {
    for (const [role, name] of Object.entries(values)) {
      if (!ALL_ROLES.has(role) || map[role] !== undefined) continue;
      if (Array.isArray(name) ? name.every(exists) && name.length : exists(name)) { map[role] = name; sources[role] = source; }
    }
  };
  assign(overrides, 'manual');
  assign(vrm, 'vrm');
  assign(inferByName(tree), 'name');
  const before = new Set(Object.keys(map));
  inferByStructure(tree, map);
  for (const role of Object.keys(map)) if (!before.has(role)) sources[role] = 'structure';
  inferFingers(tree, map);
  if (!overrides.hips && !vrm.hips) inferTrunk(tree, map);
  else {
    const hips = map.hips;
    inferTrunk(tree, map);
    map.hips = hips;
  }
  for (const role of ['spine', 'chest', 'neck', 'hips']) if (map[role] && !sources[role]) sources[role] = 'structure';
  for (const role of Object.keys(map)) if (map[role] === undefined) delete map[role];
  const fingers = {};
  for (const side of ['left', 'right']) for (const finger of FINGERS) {
    const root = map[`${side}${finger}`];
    if (root) fingers[`${side}${finger}`] = fingerChain(tree, root);
  }
  return { map, sources, fingers };
}

/** Check that the map is usable for the requested motion (or for every motion when kind is null). */
export function diagnoseHumanoidMap(map, motionKind = null) {
  const required = motionKind ? [...MOTION_REQUIREMENTS[motionKind] ?? STAND_REQUIREMENTS] : STAND_REQUIREMENTS;
  const missing = required.filter((role) => !map[role] || (Array.isArray(map[role]) && !map[role].length));
  const optionalMissing = CANONICAL_BONES.optional.filter((role) => !map[role]);
  if (!map.head) optionalMissing.unshift('head');
  if (!map.spine?.length) optionalMissing.unshift('spine');
  return { valid: missing.length === 0, missing, optionalMissing };
}

function nearestSignedAxis(vector) {
  const abs = [Math.abs(vector.x), Math.abs(vector.y), Math.abs(vector.z)];
  const index = abs.indexOf(Math.max(...abs));
  const out = new Vector3();
  out.setComponent(index, Math.sign(vector.getComponent(index)) || 1);
  return out;
}

/**
 * Compute the explicit Source -> Canonical transform from mapped bone positions (source frame).
 * up = head - hips, left = leftUpperArm - rightUpperArm (or the legs), both snapped to the nearest
 * signed source axis so that a slightly leaning character is not tilted. forward = left x up.
 */
export function computeCanonicalFrame(bones, map, options = {}) {
  const byName = new Map(bones.map((bone) => [bone.name, new Vector3().fromArray(bone.head)]));
  const at = (role) => byName.get(map[role]);
  const notes = [];
  let up = options.upAxis ? axisVector(options.upAxis) : null;
  if (!up) {
    const top = at('head') ?? at('neck') ?? (map.spine?.length ? byName.get(map.spine.at(-1)) : null);
    up = top && at('hips') ? nearestSignedAxis(top.clone().sub(at('hips'))) : new Vector3(0, 1, 0);
    if (!top) notes.push('缺少头部/脊柱骨骼，按 glTF 约定假设 +Y 向上');
  }
  let left = null;
  const pairs = [['leftUpperArm', 'rightUpperArm'], ['leftUpperLeg', 'rightUpperLeg'], ['leftHand', 'rightHand']];
  for (const [l, r] of pairs) {
    if (at(l) && at(r)) {
      const v = at(l).clone().sub(at(r));
      v.addScaledVector(up, -v.dot(up));
      if (v.lengthSq() > 1e-10) { left = nearestSignedAxis(v); break; }
    }
  }
  if (!left || Math.abs(left.dot(up)) > 0.5) {
    left = Math.abs(up.x) > 0.5 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
    notes.push('无法从左右骨骼判定侧向，按 glTF 约定假设角色面向 +Z');
  }
  if (options.flipFacing) left.negate();
  const forward = new Vector3().crossVectors(left, up).normalize();
  // Rotation R with R*left = +X, R*up = +Y, R*forward = +Z.
  const sourceBasis = new Matrix4().makeBasis(left, up, forward);
  const quaternion = new Quaternion().setFromRotationMatrix(sourceBasis).invert().normalize();

  const points = [...byName.values()].map((p) => p.clone().applyQuaternion(quaternion));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const boneHeight = maxY - minY;
  let unitScale = options.unitScale;
  if (!unitScale) {
    // Bones span ankle..head (~0.9 of stature). Pick the metric unit that makes stature plausible.
    const stature = boneHeight / 0.9;
    unitScale = stature > 30 && stature < 300 ? 0.01 : stature >= 300 && stature < 3000 ? 0.001 : 1;
    if (unitScale !== 1) notes.push(`骨架高度 ${stature.toFixed(1)} 单位，按 ${unitScale === 0.01 ? '厘米' : '毫米'} 换算为米`);
  }
  const hips = at('hips')?.clone().applyQuaternion(quaternion) ?? new Vector3();
  const groundY = options.groundY ?? minY;
  const pelvisHeight = Math.max(0.05, (hips.y - groundY) * unitScale);
  const statureScale = options.normalizeStature === false ? 1 : (options.targetPelvisHeight ?? 0.915) / pelvisHeight;
  const scale = unitScale * statureScale;
  if (Math.abs(statureScale - 1) > 0.05) {
    notes.push(`按 ${options.targetPelvisHeight ?? 0.915} m 的 MuJoCo 静止骨盆高度统一模型比例 (${statureScale.toFixed(3)}×)`);
  }
  const offset = new Vector3(-hips.x * scale, -groundY * scale, -hips.z * scale);
  return {
    quaternion: quaternion.toArray(),
    scale,
    offset: offset.toArray(),
    height: boneHeight * scale,
    sourceAxes: { up: axisName(up), left: axisName(left), forward: axisName(forward) },
    notes,
  };
}

function axisVector(axis) {
  const match = /^([+-]?)([xyz])$/i.exec(axis);
  if (!match) throw new Error(`无效坐标轴 “${axis}”`);
  const v = new Vector3();
  v.setComponent('xyz'.indexOf(match[2].toLowerCase()), match[1] === '-' ? -1 : 1);
  return v;
}

function axisName(v) {
  const index = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)].indexOf(Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)));
  return `${v.getComponent(index) < 0 ? '-' : '+'}${'xyz'[index]}`;
}

/** Matrix (column-major array) for a Source -> Canonical transform. */
export function canonicalFrameMatrix(frame) {
  return new Matrix4().compose(
    new Vector3().fromArray(frame.offset),
    new Quaternion().fromArray(frame.quaternion),
    new Vector3().setScalar(frame.scale),
  );
}
