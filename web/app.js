import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mjVecToThree } from './avatar/avatar-adapter.js';
import { AVATAR_PROFILES, MAKEHUMAN_DEFAULT_PROFILE } from './avatar/avatar-profile.js';
import { createHumanoidProfile, loadAvatarProfile, disposeAvatar, PROFILE_SCHEMA } from './avatar/avatar-loader.js';
import { createBasicMotionClips } from './avatar/basic-motions.js';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const scrubber = document.querySelector('#scrubber');
const playButton = document.querySelector('#play');
const timeReadout = document.querySelector('#time-readout');
const muscleList = document.querySelector('#muscle-list');
const jointList = document.querySelector('#joint-list');
const avatarSelect = document.querySelector('#avatar-select');
const avatarRegistry = new Map(Object.entries(AVATAR_PROFILES));
const layerState = { surface: true, skeleton: false, axes: false, grf: true, tendons: true, volumes: false };
const segmentColors = { torso: 0x5e6b91, arm: 0x858fac, leg: 0x6e80a3 };
const activationLow = new THREE.Color(0x337acc);
const activationHigh = new THREE.Color(0xd4452e);
const boneColor = 0xb89456;
const yAxis = new THREE.Vector3(0, 1, 0);

let scene, renderer, camera, controls, avatarAdapter, skeletonHelper;
let clips = [], clip = null, time = 0, playing = false, loop = true;
let lastFrame = 0, lastPanelUpdate = 0, cameraDistance = 3.15;
let avatarSelection = MAKEHUMAN_DEFAULT_PROFILE.id;
let avatarFallbackReason = null;
const avatarCache = new Map();
let lastFrameErrorAt = -Infinity;
let lastAvatarPose = null;
const simplifiedGroup = new THREE.Group();
const physicalSkeletonGroup = new THREE.Group();
const axesGroup = new THREE.Group();
const tendonGroup = new THREE.Group();
const tendonLines = new Map();
const axisHelpers = new Map();
const forceArrows = [];
let simplifiedParts = [];
let skeletonParts = [];

function fail(message) {
  loading.querySelector('strong').textContent = message;
  loading.querySelector('p').textContent = '请检查动作文件，或重新运行 npm run muscles。';
  loading.classList.remove('hidden');
  document.querySelector('#data-status').textContent = '载入失败';
}

function clearGroup(group) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.geometry?.dispose();
    if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
    else child.material?.dispose();
  }
}

function createRenderer() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0xf7f7f9, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf7f7f9);
  camera = new THREE.PerspectiveCamera(38, 1, 0.03, 40);
  camera.up.set(0, 1, 0);
  camera.position.set(cameraDistance * 0.72, 1.12, cameraDistance * 0.68);
  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.9, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.1;
  controls.maxDistance = 8;
  controls.addEventListener('change', () => { cameraDistance = camera.position.distanceTo(controls.target); });
  controls.update();

  scene.add(new THREE.HemisphereLight(0xffffff, 0xc8c3bd, 2.0));
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
  keyLight.position.set(-3.2, 5.5, 4.5);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.left = -2.2;
  keyLight.shadow.camera.right = 2.2;
  keyLight.shadow.camera.top = 2.6;
  keyLight.shadow.camera.bottom = -0.3;
  keyLight.shadow.camera.near = 0.1;
  keyLight.shadow.camera.far = 12;
  keyLight.shadow.bias = -0.00015;
  keyLight.shadow.radius = 4;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xe6eaff, 1.0);
  fillLight.position.set(3, 2.8, -3.5);
  scene.add(fillLight);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 16),
    new THREE.MeshStandardMaterial({ color: 0xf4f4f6, roughness: 0.92, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.004;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(2.4, 16, 0xd2d3da, 0xe5e5ea);
  grid.position.y = 0.001;
  grid.material.transparent = true;
  grid.material.opacity = 0.7;
  scene.add(grid);

  const groundShadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.43, 48),
    new THREE.MeshBasicMaterial({ color: 0x222232, transparent: true, opacity: 0.055, depthWrite: false }),
  );
  groundShadow.rotation.x = -Math.PI / 2;
  groundShadow.position.set(0, 0.002, 0);
  scene.add(groundShadow);

  scene.add(simplifiedGroup, physicalSkeletonGroup, axesGroup, tendonGroup);
  resizeRenderer();
  window.addEventListener('resize', resizeRenderer);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resizeRenderer).observe(canvas.parentElement);
}

function resizeRenderer() {
  if (!renderer || !camera) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function vec3(values) {
  return mjVecToThree(values, new THREE.Vector3());
}

function makePart(geometry, material, name) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildClipVisuals(activeClip) {
  clearGroup(simplifiedGroup);
  clearGroup(physicalSkeletonGroup);
  simplifiedParts = [];
  skeletonParts = [];
  const pointNames = new Set(Object.keys(activeClip.rig.staticPositions));
  for (const sample of activeClip.samples) for (const name of Object.keys(sample.positions)) pointNames.add(name);

  for (const [index, segment] of activeClip.rig.segments.entries()) {
    const material = new THREE.MeshStandardMaterial({ color: segmentColors[segment.group], roughness: 0.72 });
    const rod = makePart(new THREE.CylinderGeometry(1, 1, 1, 14), material, `segment-${index}`);
    simplifiedGroup.add(rod);
    simplifiedParts.push({ mesh: rod, from: segment.from, to: segment.to, radius: segment.radius });

    const bone = makePart(
      new THREE.CylinderGeometry(1, 1, 1, 8),
      new THREE.MeshStandardMaterial({ color: boneColor, roughness: 0.7 }),
      `bone-${index}`,
    );
    physicalSkeletonGroup.add(bone);
    skeletonParts.push({ mesh: bone, from: segment.from, to: segment.to, radius: 0.009 });
  }

  for (const name of pointNames) {
    const lower = name.toLowerCase();
    const isLeg = /hip|knee|ankle|heel|toe/.test(lower);
    const isArm = /shoulder|elbow|wrist|hand/.test(lower);
    const material = new THREE.MeshStandardMaterial({ color: segmentColors[isLeg ? 'leg' : isArm ? 'arm' : 'torso'], roughness: 0.7 });
    const radius = /pelvis|waist/.test(lower) ? 0.095 : /head/.test(lower) ? 0.075 : isLeg ? 0.032 : isArm ? 0.028 : 0.035;
    const joint = makePart(new THREE.SphereGeometry(1, 14, 10), material, `joint-${name}`);
    joint.scale.setScalar(radius);
    simplifiedGroup.add(joint);
    simplifiedParts.push({ mesh: joint, point: name });

    const boneJoint = makePart(
      new THREE.SphereGeometry(1, 10, 8),
      new THREE.MeshStandardMaterial({ color: boneColor, roughness: 0.7 }),
      `bone-joint-${name}`,
    );
    boneJoint.scale.setScalar(0.014);
    physicalSkeletonGroup.add(boneJoint);
    skeletonParts.push({ mesh: boneJoint, point: name });
  }
  syncVisibility();
}

function updateRod(mesh, from, to, radius) {
  const delta = to.clone().sub(from);
  const length = delta.length();
  if (length < 1e-6) {
    mesh.visible = false;
    return;
  }
  mesh.visible = true;
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(yAxis, delta.multiplyScalar(1 / length));
  mesh.scale.set(radius, length, radius);
}

function updateParts(parts, positions) {
  for (const part of parts) {
    if (part.point) {
      const point = positions[part.point];
      part.mesh.visible = Boolean(point);
      if (point) part.mesh.position.copy(vec3(point));
    } else {
      const from = positions[part.from], to = positions[part.to];
      if (!from || !to) {
        part.mesh.visible = false;
        continue;
      }
      updateRod(part.mesh, vec3(from), vec3(to), part.radius);
    }
  }
}

function updateTendons(frame) {
  const activeNames = new Set();
  for (const [name, path] of Object.entries(frame.tendonPaths ?? {})) {
    if (path.length < 2) continue;
    let line = tendonLines.get(name);
    if (!line) {
      line = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, depthTest: true }),
      );
      line.frustumCulled = false;
      tendonLines.set(name, line);
      tendonGroup.add(line);
    }
    if (line.geometry.getAttribute('position')?.count !== path.length) {
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry();
    }
    line.geometry.setFromPoints(path.map(vec3));
    line.material.color.copy(activationLow).lerp(activationHigh, THREE.MathUtils.clamp(frame.muscles[name]?.activation ?? 0, 0, 1));
    line.visible = layerState.tendons;
    activeNames.add(name);
  }
  for (const [name, line] of tendonLines) line.visible = layerState.tendons && activeNames.has(name);
}

function updateAxes(positions) {
  const names = ['pelvis', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle', 'rightShoulder', 'rightElbow', 'rightWrist'];
  for (const name of names) {
    let axes = axisHelpers.get(name);
    if (!axes) {
      axes = new THREE.AxesHelper(0.095);
      axisHelpers.set(name, axes);
      axesGroup.add(axes);
    }
    const point = positions[name];
    axes.visible = layerState.axes && Boolean(point);
    if (point) axes.position.copy(vec3(point));
  }
}

function updateGroundForces(frame) {
  const contacts = layerState.grf ? frame.contacts ?? [] : [];
  contacts.forEach((contact, index) => {
    let arrow = forceArrows[index];
    if (!arrow) {
      arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0, 0xd97706, 0.06, 0.035);
      forceArrows[index] = arrow;
      scene.add(arrow);
    }
    const origin = vec3(contact.position);
    const direction = vec3(contact.force);
    const magnitude = direction.length();
    arrow.visible = magnitude > 1;
    if (arrow.visible) {
      direction.normalize();
      const length = Math.min(0.52, magnitude * 0.00045);
      arrow.position.copy(origin);
      arrow.setDirection(direction);
      arrow.setLength(length, Math.min(0.08, length * 0.28), Math.min(0.055, length * 0.2));
    }
  });
  for (let i = contacts.length; i < forceArrows.length; i++) forceArrows[i].visible = false;
}

function syncVisibility() {
  for (const [id, entry] of avatarCache) {
    if (entry.adapter) entry.adapter.model.visible = id === avatarSelection && layerState.surface;
    if (entry.helper) entry.helper.visible = id === avatarSelection && layerState.skeleton;
    entry.adapter?.collision?.setDebugVisible(id === avatarSelection && layerState.volumes);
  }
  simplifiedGroup.visible = !avatarAdapter && layerState.surface;
  physicalSkeletonGroup.visible = !avatarAdapter && layerState.skeleton;
  axesGroup.visible = layerState.axes;
  // Source-space muscle paths have no attachment calibration on retargeted
  // avatars. Bone motion mapping alone cannot place these anatomical paths.
  const tendonsSupported = avatarRegistry.get(avatarSelection)?.schemaVersion !== PROFILE_SCHEMA;
  tendonGroup.visible = layerState.tendons && tendonsSupported;
  const tendonButton = document.querySelector('[data-layer="tendons"]');
  tendonButton.disabled = !tendonsSupported;
  tendonButton.classList.toggle('on', tendonGroup.visible);
  tendonButton.setAttribute('aria-checked', String(tendonGroup.visible));
  document.querySelector('#tendon-hint').hidden = tendonsSupported;
  const collision = avatarAdapter?.collision;
  const bodyButton = document.querySelector('#collision-enabled');
  const clothButton = document.querySelector('#cloth-enabled');
  const volumeButton = document.querySelector('[data-layer="volumes"]');
  bodyButton.disabled = !collision;
  bodyButton.classList.toggle('on', Boolean(collision?.enabled));
  bodyButton.setAttribute('aria-checked', String(Boolean(collision?.enabled)));
  const hasGarments = Boolean(collision?.garments.garments.length);
  clothButton.disabled = !collision?.enabled || !hasGarments;
  clothButton.classList.toggle('on', Boolean(collision?.enabled && hasGarments && collision.clothEnabled));
  clothButton.setAttribute('aria-checked', String(Boolean(collision?.enabled && hasGarments && collision.clothEnabled)));
  volumeButton.disabled = !collision;
  volumeButton.classList.toggle('on', Boolean(collision && layerState.volumes));
  volumeButton.setAttribute('aria-checked', String(Boolean(collision && layerState.volumes)));
  setText('#cloth-hint', hasGarments ? '衣物可弯曲，固定缝口跟随骨架' : '此模型尚未配置独立衣物网格');
  avatarSelect.value = avatarSelection;
  avatarSelect.setAttribute('aria-busy', String(Boolean(avatarCache.get(avatarSelection)?.loading)));
}

function activationColor(value) {
  return activationLow.clone().lerp(activationHigh, THREE.MathUtils.clamp(value, 0, 1));
}

function lerp(a, b, t) { return a + (b - a) * t; }
function mixVector(a, b, t) { return a.map((value, i) => lerp(value, b?.[i] ?? value, t)); }

function mixBodies(a = {}, b = {}, alpha) {
  const bodies = {};
  for (const [name, pose] of Object.entries(a)) {
    const next = b[name] ?? pose;
    const qa = pose.quaternion;
    const qb = next.quaternion;
    const quaternion = new THREE.Quaternion(qa[1], qa[2], qa[3], qa[0])
      .slerp(new THREE.Quaternion(qb[1], qb[2], qb[3], qb[0]), alpha);
    bodies[name] = {
      position: mixVector(pose.position, next.position, alpha),
      quaternion: [quaternion.w, quaternion.x, quaternion.y, quaternion.z],
    };
  }
  return bodies;
}

function sampleAt(activeClip, seconds) {
  const samples = activeClip.samples;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (samples[mid].time <= seconds) lo = mid;
    else hi = mid - 1;
  }
  const next = Math.min(samples.length - 1, lo + 1);
  const a = samples[lo], b = samples[next];
  const span = b.time - a.time;
  const alpha = span > 0 ? THREE.MathUtils.clamp((seconds - a.time) / span, 0, 1) : 0;
  const positions = {};
  for (const [name, point] of Object.entries(a.positions)) positions[name] = mixVector(point, b.positions[name], alpha);
  const joints = {};
  for (const [name, joint] of Object.entries(a.joints)) {
    const other = b.joints[name] ?? joint;
    joints[name] = { angle: lerp(joint.angle, other.angle, alpha), velocity: lerp(joint.velocity, other.velocity, alpha) };
  }
  const muscles = {};
  for (const [name, muscle] of Object.entries(a.muscles)) {
    const other = b.muscles[name] ?? muscle;
    muscles[name] = {
      activation: lerp(muscle.activation, other.activation, alpha),
      force: lerp(muscle.force, other.force, alpha),
      length: lerp(muscle.length, other.length, alpha),
    };
  }
  const contacts = (a.contacts ?? []).map((contact) => {
    const other = (b.contacts ?? []).find((item) => item.name === contact.name);
    return {
      name: contact.name,
      position: mixVector(contact.position, other?.position, alpha),
      force: mixVector(contact.force, other?.force, alpha),
    };
  });
  const tendonPaths = {};
  for (const [name, path] of Object.entries(a.tendonPaths ?? {})) {
    const otherPath = b.tendonPaths?.[name] ?? path;
    tendonPaths[name] = path.map((point, i) => mixVector(point, otherPath[i], alpha));
  }
  const regionalPower = {};
  for (const name of ['lower-body', 'trunk', 'upper-body']) {
    regionalPower[name] = lerp(a.regionalPower?.[name] ?? 0, b.regionalPower?.[name] ?? 0, alpha);
  }
  const force = mixVector(a.grf?.force ?? [0, 0, 0], b.grf?.force, alpha);
  const copA = a.grf?.centerOfPressure, copB = b.grf?.centerOfPressure;
  const centerOfPressure = copA && copB ? mixVector(copA, copB, alpha) : copA ?? copB ?? null;
  const feet = {
    left: mixVector(a.grf?.feet?.left ?? [0, 0, 0], b.grf?.feet?.left, alpha),
    right: mixVector(a.grf?.feet?.right ?? [0, 0, 0], b.grf?.feet?.right, alpha),
  };
  return {
    time: seconds,
    pose: a.pose ? Object.fromEntries(Object.keys(a.pose).map(key => [key,lerp(a.pose[key],b.pose?.[key] ?? a.pose[key],alpha)])) : undefined,
    com: mixVector(a.com ?? [0, 0, 0], b.com, alpha),
    positions,
    bodies: mixBodies(a.bodies, b.bodies, alpha),
    joints,
    muscles,
    contacts,
    tendonPaths,
    regionalPower,
    grf: { force, centerOfPressure, contactCount: alpha < 0.5 ? a.grf?.contactCount ?? 0 : b.grf?.contactCount ?? 0, feet },
  };
}

function prettyName(name) { return name.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function setText(selector, value) { document.querySelector(selector).textContent = value; }
function formatJoint(name, state, kind) {
  return kind === 'slide'
    ? `${state.angle.toFixed(3)} m · ${state.velocity.toFixed(2)} m/s`
    : `${(state.angle * 180 / Math.PI).toFixed(1)}° · ${state.velocity.toFixed(2)} rad/s`;
}

function updatePanel(activeClip, frame, now) {
  if (now - lastPanelUpdate < 75) return;
  lastPanelUpdate = now;
  setText('#time-readout', `${frame.time.toFixed(3)} / ${activeClip.duration.toFixed(3)} s`);
  scrubber.value = String(frame.time / activeClip.duration);
  const phase = activeClip.phases.find((item) => frame.time >= item.start && frame.time <= item.end);
  setText('#phase-readout', phase?.label ?? '动作结束');
  if (activeClip.rig.kind === 'authored-humanoid') {
    for (const id of ['grf-z','grf-total','contact-count','com-height']) setText(`#${id}`,'—');
    for (const id of ['power-list','muscle-list','joint-list']) document.querySelector(`#${id}`).replaceChildren();
    return;
  }
  const force = frame.grf.force;
  setText('#grf-z', force[2].toFixed(0));
  setText('#grf-total', Math.hypot(...force).toFixed(0));
  setText('#contact-count', String(frame.grf.contactCount));
  setText('#com-height', frame.com ? frame.com[2].toFixed(3) : '—');

  const powerList = document.querySelector('#power-list');
  powerList.replaceChildren();
  const powerLabels = [['lower-body', '下肢'], ['trunk', '躯干'], ['upper-body', '上肢']];
  const maxPower = Math.max(150, ...powerLabels.map(([key]) => Math.abs(frame.regionalPower[key] ?? 0)));
  for (const [key, label] of powerLabels) {
    const value = frame.regionalPower[key] ?? 0;
    const row = document.createElement('div'); row.className = 'power-row';
    const name = document.createElement('span'); name.textContent = label;
    const track = document.createElement('div'); track.className = 'power-track';
    const fill = document.createElement('i'); fill.className = value < 0 ? 'negative' : '';
    fill.style.width = `${Math.min(100, Math.abs(value) / maxPower * 100)}%`;
    track.append(fill);
    const output = document.createElement('output'); output.textContent = `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
    row.append(name, track, output); powerList.append(row);
  }

  muscleList.replaceChildren();
  activeClip.rig.muscles.forEach((muscle) => {
    const state = frame.muscles[muscle.name] ?? { activation: 0, force: 0 };
    const row = document.createElement('div'); row.className = 'muscle-row';
    const head = document.createElement('div'); head.className = 'muscle-row-head';
    const name = document.createElement('span'); name.className = 'muscle-name';
    const dot = document.createElement('i'); dot.className = 'muscle-color';
    const color = activationColor(state.activation);
    dot.style.background = `rgb(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)})`;
    const text = document.createElement('span'); text.textContent = prettyName(muscle.name);
    name.append(dot, text); head.append(name);
    const values = document.createElement('div'); values.className = 'muscle-row-data';
    const activation = document.createElement('span'); activation.textContent = `激活 ${(state.activation * 100).toFixed(0)}%`;
    const strength = document.createElement('strong'); strength.textContent = `${state.force.toFixed(0)} N`;
    values.append(activation, strength); row.append(head, values); muscleList.append(row);
  });

  jointList.replaceChildren();
  for (const [name, state] of Object.entries(frame.joints)) {
    const row = document.createElement('div'); row.className = 'joint-row';
    const label = document.createElement('span'); label.textContent = prettyName(name);
    const value = document.createElement('strong'); value.textContent = formatJoint(name, state, activeClip.rig.jointTypes?.[name]);
    row.append(label, value); jointList.append(row);
  }
}

function describeClip(activeClip) {
  if (activeClip.provenance?.kind === 'authored-kinematic') return {description:`参考 Shisei ${activeClip.provenance.poseId} 的动态设计稿：缓入、停留、返回；按角色自身骨长求解。未计算肌力、接触力或动态平衡。`,focus:['动作设计预览','关键帧过渡','足底约束']};
  if (activeClip.id === 'squat-to-stand') return { description: '从深蹲位开始，依靠髋、膝、踝肌群伸展起立。足底接触反力由 MuJoCo 接触求解得到。', focus: ['髋膝伸展', '重心控制', '足底支撑'] };
  if (activeClip.id === 'countermovement-drive') return { description: '先快速下沉，再通过髋膝踝伸展完成蹬伸，回到双足支撑。', focus: ['反向动作', '肌肉协同', '地面反力'] };
  if (activeClip.id === 'shoulder-elbow') return { description: '右上臂先从自然下垂位置抬至接近水平，再保持肩位完成高位绳索弯举式屈肘。前束三角肌维持肩位，肱二头肌与肱肌屈肘，肱三头肌拮抗。', focus: ['水平抬臂', '高位屈肘', '肩肘协同'] };
  if (activeClip.rig.kind === 'elbow') return { description: '肱二头肌屈肘，肱三头肌拮抗制动；肌腱路径实时决定力臂。', focus: ['单关节', '拮抗肌', '力臂'] };
  return { description: '双关节肌和单关节肌共同产生关节力矩，肌腱路径实时决定力臂。', focus: ['双关节肌', '肩肘协同', '肌腱路径'] };
}

function updateAvatarLoading() {
  if (clip) loading.classList.add('hidden');
}

function setClip(index) {
  clip = clips[index];
  time = 0; playing = false; lastFrame = 0;
  playButton.textContent = '▶';
  playButton.setAttribute('aria-label', '播放动作');
  scrubber.value = '0';
  setText('#clip-title', clip.label);
  const authored = clip.rig.kind === 'authored-humanoid';
  setText('#clip-subtitle', authored ? '动作设计预览 · 人工关键帧 · 非物理仿真' : clip.rig.kind === 'lower-body' ? '骨盆 · 躯干 · 下肢 · 地面接触' : '肌肉驱动 · MuJoCo 正向动力学');
  const copy = describeClip(clip);
  setText('#motion-description', copy.description);
  const focus = document.querySelector('#focus-list'); focus.replaceChildren();
  copy.focus.forEach((tag) => { const item = document.createElement('span'); item.textContent = tag; focus.append(item); });

  const list = document.querySelector('#motion-list'); list.replaceChildren();
  clips.forEach((item, i) => {
    const button = document.createElement('button'); button.className = `motion-row${i === index ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(i === index));
    const number = document.createElement('span'); number.className = 'motion-number'; number.textContent = String(i + 1).padStart(2, '0');
    const label = document.createElement('span'); label.className = 'motion-label'; label.textContent = item.label;
    const detail = document.createElement('small'); detail.textContent = item.rig.kind === 'authored-humanoid' ? 'POSE STUDY · KINEMATIC' : item.rig.kind === 'lower-body' ? 'FLOATING BASE · CONTACT' : item.rig.kind === 'elbow' ? '1 DOF · 2 MUSCLES' : '2 DOF · 4 MUSCLES';
    label.append(detail); button.append(number, label); button.addEventListener('click', () => setClip(i)); list.append(button);
  });
  setText('#clip-count', String(clips.length).padStart(2, '0'));
  setText('#motion-source-label', authored ? '人工动作设计' : 'MuJoCo 肌骨仿真');
  setText('#model-label', authored ? '关键帧设计 · 未计算动力学' : `${clip.rig.jointNames.length} 个自由度 · ${clip.rig.muscles.length} 块肌肉`);
  setText('#data-status', `${clip.samples.length} 帧 · dt ${(clip.timestep ?? 0).toFixed(3)} s`);
  setText('#playback-label', authored ? 'h3d · 动作设计预览' : 'h3d · 肌肉机制实验');
  if (authored && (!avatarAdapter || !avatarAdapter.authoredPose)) setAvatar('makehuman-generic');

  const markers = document.querySelector('#phase-markers'); markers.replaceChildren();
  clip.phases.forEach((phase) => {
    const button = document.createElement('button'); button.textContent = phase.label;
    button.style.left = `${phase.start / clip.duration * 100}%`; button.title = `跳至 ${phase.label}`;
    button.addEventListener('click', () => { setPlaying(false); time = phase.start; renderFrame(sampleAt(clip, time)); updatePanel(clip, sampleAt(clip, time), performance.now() + 100); });
    markers.append(button);
  });
  buildClipVisuals(clip);
  controls.target.set(0, clip.rig.kind === 'lower-body' ? 0.86 : 1.0, 0);
  cameraDistance = clip.rig.kind === 'lower-body' ? 2.65 : 3.1;
  setCamera('threeQuarter');
  updateAvatarLoading();
  const frame = sampleAt(clip, time);
  renderFrame(frame);
  updatePanel(clip, frame, performance.now() + 100);
}

function acceptMotionSet(value) {
  if (value.schemaVersion === 'h3d.motion-set.v1' && Array.isArray(value.clips)) clips = value.clips;
  else if (value.schemaVersion === 'h3d.motion.v1') clips = [value];
  else throw new Error('不支持的动作 JSON 格式');
  if (!clips.length || clips.some((item) => item.schemaVersion !== 'h3d.motion.v1' || !Array.isArray(item.samples) || !item.samples.length)) {
    throw new Error('动作文件没有可播放的样本');
  }
  setClip(0);
}

function setPlaying(value) {
  if (!clip) return;
  if (value && time >= clip.duration) time = 0;
  playing = value;
  playButton.textContent = playing ? 'Ⅱ' : '▶';
  playButton.setAttribute('aria-label', playing ? '暂停动作' : '播放动作');
}

function renderFrame(frame) {
  if (!clip) return;
  if (avatarAdapter) {
    const collision = avatarAdapter.collision;
    const key = [avatarAdapter, clip, frame.time, collision?.enabled, collision?.clothEnabled];
    if (!lastAvatarPose || key.some((value, i) => value !== lastAvatarPose[i])) {
      avatarAdapter.applyFrame(clip, frame);
      lastAvatarPose = key;
      updateCollisionStatus();
    }
    skeletonHelper?.updateMatrixWorld(true);
  }
  const positions = { ...clip.rig.staticPositions, ...frame.positions };
  if (positions.shoulder && !positions.rightShoulder) positions.rightShoulder = positions.shoulder;
  if (positions.elbow && !positions.rightElbow) positions.rightElbow = positions.elbow;
  if (positions.wrist && !positions.rightWrist) positions.rightWrist = positions.wrist;
  if (positions.hand && !positions.rightHand) positions.rightHand = positions.hand;
  updateParts(simplifiedParts, positions);
  updateParts(skeletonParts, positions);
  updateAxes(positions);
  updateGroundForces(frame);
  updateTendons(frame);
}

function updateCollisionStatus() {
  const collision = avatarAdapter?.collision;
  if (!collision) { setText('#collision-status', '通用 Humanoid 模型支持体积约束'); return; }
  if (!collision.enabled) { setText('#collision-status', '已关闭 · 显示原始重定向姿态'); return; }
  const d = collision.diagnostics, cloth = d.cloth;
  const residual = Math.max(d.maxPenetration, cloth?.maxPenetration ?? 0);
  const rigid = `肢体重叠 ${d.contactsBefore} → ${d.contactsAfter} 处`;
  const garment = cloth ? ` · 衣物 ${cloth.particles} 个节点` : '';
  const limited = cloth?.limitedGarments ? ` · ${cloth.limitedGarments} 片衣物达到形变上限` : '';
  setText('#collision-status', `${rigid}${garment} · 估计残留 ${(residual * 1000).toFixed(1)} mm${limited}`);
  document.querySelector('#collision-status').title = cloth
    ? `衣物最大局部伸长 ${((cloth.maxStretchRatio - 1) * 100).toFixed(0)}%；固定缝口残留 ${(cloth.pinnedPenetration * 1000).toFixed(1)} mm。胶囊体是近似体积，接触值不是力。`
    : '胶囊体是近似体积，接触值不是力。';
  document.querySelector('#collision-status').classList.toggle('has-residual', residual > .002);
}

function reportFrameError(error) {
  setText('#data-status', '渲染错误');
  const now = performance.now();
  if (now - lastFrameErrorAt >= 1000) {
    lastFrameErrorAt = now;
    console.error('Viewer frame update failed:', error);
  }
}

function tick(now) {
  requestAnimationFrame(tick);
  if (clip) {
    let frame;
    try {
      if (playing && lastFrame) {
        time += ((now - lastFrame) / 1000) * Number(document.querySelector('#speed').value);
        if (time >= clip.duration) {
          if (loop) time %= clip.duration;
          else { time = clip.duration; setPlaying(false); }
        }
      }
      frame = sampleAt(clip, time);
    } catch (error) {
      reportFrameError(error);
    }
    if (frame) {
      try { renderFrame(frame); }
      catch (error) { reportFrameError(error); }
      try { updatePanel(clip, frame, now); }
      catch (error) { reportFrameError(error); }
    }
  }
  try {
    controls.update();
    renderer.render(scene, camera);
  } catch (error) {
    reportFrameError(error);
  }
  lastFrame = now;
}

function setCamera(name) {
  const target = controls.target;
  const directions = {
    front: new THREE.Vector3(0, 0.035, 1),
    side: new THREE.Vector3(1, 0.035, 0),
    top: new THREE.Vector3(0, 1, 0),
    back: new THREE.Vector3(0, 0.035, -1),
    threeQuarter: new THREE.Vector3(0.72, 0.12, 0.68),
  };
  const direction = (directions[name] ?? directions.threeQuarter).normalize();
  camera.up.copy(name === 'top' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0));
  camera.position.copy(target).addScaledVector(direction, cameraDistance);
  document.querySelectorAll('[data-camera]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.camera === name)));
  try {
    controls.update();
    renderer.render(scene, camera);
  } catch (error) {
    reportFrameError(error);
  }
}

function fitView() {
  if (!clip) return;
  const subject = avatarAdapter ? avatarAdapter.model : simplifiedGroup;
  subject.updateMatrixWorld(true);
  // Skinned bounds are cached in Three.js; recompute for the currently posed limbs.
  subject.traverse(object => { if (object.isSkinnedMesh) object.computeBoundingBox(); });
  const bounds = new THREE.Box3().setFromObject(subject);
  if (bounds.isEmpty()) return;
  const size = bounds.getSize(new THREE.Vector3());
  controls.target.copy(bounds.getCenter(new THREE.Vector3()));
  const aspect = Math.max(0.5, camera.aspect);
  const fitSize = Math.max(size.y, size.x / aspect, size.z / aspect);
  cameraDistance = Math.max(1.35, fitSize / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.16);
  setCamera('threeQuarter');
}

function setAvatar(id, fallbackReason = null) {
  if (clip?.rig.kind === 'authored-humanoid' && (id === 'makehuman-default' || id === 'simplified') && !fallbackReason) id = 'makehuman-generic';
  if (id !== 'simplified' && !avatarRegistry.has(id)) return;
  avatarSelection = id;
  avatarFallbackReason = fallbackReason;
  const profile = avatarRegistry.get(id);
  const entry = avatarCache.get(id);
  avatarAdapter = entry?.adapter;
  skeletonHelper = entry?.helper;
  if (profile && !avatarAdapter && !entry?.loading) void loadAvatar(profile);
  syncVisibility();
  updateCollisionStatus();
  const status = profile
    ? (avatarAdapter ? profile.statusLabel ?? profile.label : '正在载入… · 暂显简化连杆')
    : (avatarFallbackReason ?? '简化连杆');
  setText('#avatar-status', status);
  document.querySelector('#avatar-export').disabled = !avatarAdapter?.report;
  if (avatarAdapter?.report) showAvatarReport({ ...avatarAdapter.report, motion: avatarAdapter.diagnostics });
  else if (!fallbackReason) document.querySelector('#avatar-diagnostics').hidden = true;
  updateAvatarLoading();
  if (clip) renderFrame(sampleAt(clip, time));
}

function setLayer(button) {
  const key = button.dataset.layer;
  layerState[key] = !layerState[key];
  button.classList.toggle('on', layerState[key]);
  button.setAttribute('aria-checked', String(layerState[key]));
  syncVisibility();
  if (clip) renderFrame(sampleAt(clip, time));
}

const dialogContent = {
  guide: ['使用指南', '<p>拖动画布旋转视角，滚轮缩放；正面、侧面、俯视、背面和 45° 按钮切换相机。右侧通过“选择模型”切换角色，也可导入 GLB 与对应的配置 JSON，并控制骨架、坐标轴、地面反力和肌腱路径。</p><p>时间轴可拖动到任意采样帧，也可点击阶段标记。播放速度只影响回放，不会改变物理仿真。</p><p><strong>Space</strong> 播放 / 暂停，<strong>R</strong> 回到动作开头。</p>'],
  model: ['动力链与模型边界', '<p>MuJoCo 肌肉模型包含相应的关节、肌腱路径与接触约束。动作 JSON 同时导出身体位置、姿态和身体测点，查看器将这些数据映射到显示人模。</p><p>MakeHuman 通过独立 AvatarAdapter 适配器驱动。显示骨架只读取动作数据，不会修改 MuJoCo 的关节角、质量、肌肉力或积分状态。切换 Avatar 也不会修改动作文件。</p><p>下肢是共享节段运动的矢状面降阶模型；模型不表示左右腿独立控制、肩胛运动或完整三维肌肉控制。</p>'],
  sources: ['资料与许可', '<p>查看器使用 Three.js，仿真使用 <a href="https://mujoco.org/" target="_blank" rel="noreferrer">MuJoCo</a>。肌肉参数和几何属于研究原型假设。</p><p>人体模型来自 MakeHuman，采用 CC0 许可。<a href="/models/MAKEHUMAN-LICENSE.md" target="_blank" rel="noreferrer">查看许可</a> · <a href="/models/ASSET-PROVENANCE.md" target="_blank" rel="noreferrer">查看资产来源</a>。</p><p>验证模型：CesiumMan © Cesium，CC BY 4.0；KayKit Knight © Kay Lousberg，CC0。<a href="/models/validation/README.md" target="_blank" rel="noreferrer">模型来源与许可</a>。</p><p>静态查看器只读取版本化的 <code>h3d.motion.v1</code> 文件，不导入模拟器代码。项目采用 Apache-2.0 许可。</p>'],
};

async function loadAvatar(profile) {
  const entry = { loading: true, adapter: null, helper: null };
  avatarCache.set(profile.id, entry);
  try {
    const adapter = await loadAvatarProfile(profile);
    entry.adapter = adapter;
    adapter.model.visible = false;
    scene.add(adapter.model);
    if (adapter.collision) scene.add(adapter.collision.debug);
    adapter.model.traverse((object) => {
      if (object.isMesh) object.castShadow = true;
      if (object.isSkinnedMesh) object.receiveShadow = true;
    });
    const helper = new THREE.SkeletonHelper(adapter.model);
    entry.helper = helper;
    helper.visible = false;
    helper.material.depthTest = true;
    helper.material.transparent = true;
    helper.material.opacity = 0.85;
    scene.add(helper);
    entry.loading = false;
    // A slow download must not undo a later selection.
    if (avatarSelection === profile.id) { setAvatar(profile.id); fitView(); }
  } catch (error) {
    if (entry.adapter) { scene.remove(entry.adapter.model); disposeAvatar(entry.adapter.model); }
    if (entry.helper) { scene.remove(entry.helper); entry.helper.dispose(); }
    avatarCache.delete(profile.id);
    console.error(`Avatar "${profile.id}" could not be loaded:`, error);
    if (avatarSelection === profile.id) {
      showAvatarReport(error.diagnostics ?? { errors: [error.message] });
      setAvatar('simplified', `${profile.label}载入失败 · 已用简化连杆`);
    }
  }
}

function showAvatarReport(report) {
  document.querySelector('#avatar-diagnostics').hidden = false;
  setText('#avatar-diagnostics-text', JSON.stringify(report, null, 2));
}

function registerAvatar(profile) {
  if (profile.id === 'simplified' || avatarRegistry.has(profile.id)) throw new Error(`模型 id 已存在：${profile.id}`);
  avatarRegistry.set(profile.id, profile);
  avatarSelect.add(new Option(profile.label, profile.id));
}

async function importAvatar(files) {
  const glbs = [...files].filter(file => /\.glb$/i.test(file.name));
  const configs = [...files].filter(file => /\.json$/i.test(file.name));
  if (glbs.length !== 1 || configs.length > 1 || files.length !== glbs.length + configs.length) {
    throw new Error('请选择一个 GLB，可同时选择一个模型配置 JSON');
  }
  const file = glbs[0];
  const id = `local-${crypto.randomUUID()}`;
  const profile = configs.length ? JSON.parse(await configs[0].text()) : createHumanoidProfile(id, file.name.replace(/\.glb$/i, ''), file.name);
  if (profile.schemaVersion !== PROFILE_SCHEMA) throw new Error('导入配置需要 h3d.avatar-profile.v2 格式');
  const adapter = await loadAvatarProfile(profile, { buffer: await file.arrayBuffer() });
  try {
    // Exercise the active motion before making a new asset selectable.
    if (clip) adapter.applyFrame(clip, sampleAt(clip, time));
    else adapter.stand();
    const registered = { ...adapter.profile, id };
    adapter.profile = registered;
    registerAvatar(registered);
    adapter.model.traverse(object => {
      if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; }
    });
    const helper = new THREE.SkeletonHelper(adapter.model);
    helper.material.transparent = true;
    helper.material.opacity = .85;
    scene.add(adapter.model, helper);
    if (adapter.collision) scene.add(adapter.collision.debug);
    avatarCache.set(id, { loading: false, adapter, helper });
    setAvatar(id);
    fitView();
  } catch (error) { disposeAvatar(adapter.model); throw error; }
}

function saveJSON(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

try {
  createRenderer();
  for (const profile of Object.values(AVATAR_PROFILES)) avatarSelect.add(new Option(profile.label, profile.id));
  avatarSelect.add(new Option('简化连杆', 'simplified'));
  for (const url of ['/models/validation/cesium-man.profile.json', '/models/validation/kaykit-knight.profile.json', '/models/local/tanjiro-v3.profile.json']) {
    fetch(url).then(response => { if (!response.ok) throw new Error(`配置请求失败 (${response.status})`); return response.json(); })
      .then(registerAvatar).catch(error => console.warn('示例模型配置无法加载:', error));
  }
  document.querySelector('#avatar-files').addEventListener('change', async event => {
    const input = event.target;
    if (!input.files.length) return;
    input.disabled = true;
    setText('#avatar-status', '正在检查模型…');
    try { await importAvatar(input.files); }
    catch (error) {
      setText('#avatar-status', `导入未通过：${error.message}`);
      showAvatarReport(error.diagnostics ?? { errors: [error.message] });
    } finally { input.disabled = false; input.value = ''; }
  });
  document.querySelector('label[for="avatar-files"]').addEventListener('keydown', event => {
    if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); event.stopPropagation(); document.querySelector('#avatar-files').click(); }
  });
  document.querySelector('#avatar-export').addEventListener('click', () => {
    if (!avatarAdapter?.report) return;
    const collision = avatarAdapter.collision;
    const profile = { ...avatarAdapter.profile, calibrationReport: avatarAdapter.report };
    if (collision) profile.collision = { ...profile.collision, enabled: collision.enabled, clothEnabled: collision.clothEnabled };
    saveJSON(profile, `${avatarAdapter.profile.label}.profile.json`);
  });
  document.querySelectorAll('[data-layer]').forEach((button) => button.addEventListener('click', () => setLayer(button)));
  avatarSelect.addEventListener('change', (event) => setAvatar(event.target.value));
  for (const [selector, property] of [['#collision-enabled', 'enabled'], ['#cloth-enabled', 'clothEnabled']]) {
    document.querySelector(selector).addEventListener('click', () => {
      const collision = avatarAdapter?.collision;
      if (!collision) return;
      collision[property] = !collision[property];
      syncVisibility();
      if (clip) renderFrame(sampleAt(clip, time));
      updateCollisionStatus();
    });
  }
  document.querySelectorAll('[data-camera]').forEach((button) => button.addEventListener('click', () => setCamera(button.dataset.camera)));
  document.querySelector('#fit-view').addEventListener('click', fitView);
  playButton.addEventListener('click', () => setPlaying(!playing));
  document.querySelector('#restart').addEventListener('click', () => { time = 0; setPlaying(false); });
  scrubber.addEventListener('input', () => {
    if (!clip) return;
    setPlaying(false);
    time = Number(scrubber.value) * clip.duration;
    const frame = sampleAt(clip, time);
    renderFrame(frame);
    updatePanel(clip, frame, performance.now() + 100);
  });
  document.querySelector('#speed').addEventListener('input', (event) => setText('#speed-value', `${Number(event.target.value).toFixed(2).replace(/0$/, '')}×`));
  document.querySelector('#loop').addEventListener('click', (event) => {
    loop = !loop;
    event.currentTarget.classList.toggle('on', loop);
    event.currentTarget.setAttribute('aria-checked', String(loop));
  });
  document.querySelector('#motion-file').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    try { acceptMotionSet(JSON.parse(await file.text())); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  });

  const dialog = document.querySelector('#info-dialog');
  document.querySelectorAll('[data-dialog]').forEach((button) => button.addEventListener('click', () => {
    const [title, html] = dialogContent[button.dataset.dialog];
    setText('#dialog-title', title);
    document.querySelector('#dialog-content').innerHTML = html;
    dialog.showModal();
  }));
  document.querySelector('#dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof Element && event.target.closest('input, select, textarea, button, [contenteditable]')) return;
    if (event.code === 'Space') { event.preventDefault(); setPlaying(!playing); }
    if (event.key.toLowerCase() === 'r') { time = 0; setPlaying(false); }
  });

  requestAnimationFrame(tick);
  setAvatar(avatarSelection);
  fetch('/demo-motion.json')
    .then((response) => { if (!response.ok) throw new Error(`动作数据请求失败 (${response.status})`); return response.json(); })
    .then(value => acceptMotionSet({ schemaVersion:'h3d.motion-set.v1', clips:[...(value.clips ?? [value]),...createBasicMotionClips()] }))
    .catch((error) => fail(`${error.message}。先运行 npm run muscles 生成演示数据。`));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
