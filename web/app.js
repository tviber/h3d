import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AvatarAdapter, mjVecToThree } from './avatar/avatar-adapter.js';

const canvas = document.querySelector('#scene');
const loading = document.querySelector('#loading');
const scrubber = document.querySelector('#scrubber');
const playButton = document.querySelector('#play');
const timeReadout = document.querySelector('#time-readout');
const muscleList = document.querySelector('#muscle-list');
const jointList = document.querySelector('#joint-list');
const layerState = { surface: true, skeleton: false, axes: false, grf: true, tendons: true };
const segmentColors = { torso: 0x5e6b91, arm: 0x858fac, leg: 0x6e80a3 };
const activationLow = new THREE.Color(0x337acc);
const activationHigh = new THREE.Color(0xd4452e);
const boneColor = 0xb89456;
const yAxis = new THREE.Vector3(0, 1, 0);

let scene, renderer, camera, controls, avatarAdapter, skeletonHelper;
let clips = [], clip = null, time = 0, playing = false, loop = true;
let lastFrame = 0, lastPanelUpdate = 0, cameraDistance = 3.15;
let avatarSelection = 'makehuman';
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
  const makeHuman = avatarSelection === 'makehuman';
  if (avatarAdapter) avatarAdapter.model.visible = makeHuman && layerState.surface;
  simplifiedGroup.visible = !makeHuman && layerState.surface;
  physicalSkeletonGroup.visible = !makeHuman && layerState.skeleton;
  if (skeletonHelper) skeletonHelper.visible = makeHuman && layerState.skeleton;
  axesGroup.visible = layerState.axes;
  tendonGroup.visible = layerState.tendons;
  document.querySelectorAll('[data-avatar]').forEach((button) => {
    const selected = button.dataset.avatar === avatarSelection;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
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
  if (activeClip.id === 'squat-to-stand') return { description: '从深蹲位开始，依靠髋、膝、踝肌群伸展起立。足底接触反力由 MuJoCo 接触求解得到。', focus: ['髋膝伸展', '重心控制', '足底支撑'] };
  if (activeClip.id === 'countermovement-drive') return { description: '先快速下沉，再通过髋膝踝伸展完成蹬伸，回到双足支撑。', focus: ['反向动作', '肌肉协同', '地面反力'] };
  if (activeClip.id === 'shoulder-elbow') return { description: '右上臂先从自然下垂位置抬至接近水平，再保持肩位完成高位绳索弯举式屈肘。前束三角肌维持肩位，肱二头肌与肱肌屈肘，肱三头肌拮抗。', focus: ['水平抬臂', '高位屈肘', '肩肘协同'] };
  if (activeClip.rig.kind === 'elbow') return { description: '肱二头肌屈肘，肱三头肌拮抗制动；肌腱路径实时决定力臂。', focus: ['单关节', '拮抗肌', '力臂'] };
  return { description: '双关节肌和单关节肌共同产生关节力矩，肌腱路径实时决定力臂。', focus: ['双关节肌', '肩肘协同', '肌腱路径'] };
}

function setClip(index) {
  clip = clips[index];
  time = 0; playing = false; lastFrame = 0;
  playButton.textContent = '▶';
  playButton.setAttribute('aria-label', '播放动作');
  scrubber.value = '0';
  setText('#clip-title', clip.label);
  setText('#clip-subtitle', clip.rig.kind === 'lower-body' ? '骨盆 · 躯干 · 下肢 · 地面接触' : '肌肉驱动 · MuJoCo 正向动力学');
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
    const detail = document.createElement('small'); detail.textContent = item.rig.kind === 'lower-body' ? 'FLOATING BASE · CONTACT' : item.rig.kind === 'elbow' ? '1 DOF · 2 MUSCLES' : '2 DOF · 4 MUSCLES';
    label.append(detail); button.append(number, label); button.addEventListener('click', () => setClip(i)); list.append(button);
  });
  setText('#clip-count', String(clips.length).padStart(2, '0'));
  setText('#model-label', `${clip.rig.jointNames.length} 个自由度 · ${clip.rig.muscles.length} 块肌肉`);
  setText('#data-status', `${clip.samples.length} 帧 · dt ${(clip.timestep ?? 0).toFixed(3)} s`);
  setText('#playback-label', 'h3d · 肌肉机制实验');

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
  loading.classList.add('hidden');
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
    avatarAdapter.applyFrame(clip, frame);
    skeletonHelper?.update();
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

function tick(now) {
  if (clip) {
    if (playing && lastFrame) {
      time += ((now - lastFrame) / 1000) * Number(document.querySelector('#speed').value);
      if (time >= clip.duration) {
        if (loop) time %= clip.duration;
        else { time = clip.duration; setPlaying(false); }
      }
    }
    const frame = sampleAt(clip, time);
    renderFrame(frame);
    updatePanel(clip, frame, now);
    controls.update();
    renderer.render(scene, camera);
  }
  lastFrame = now;
  requestAnimationFrame(tick);
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
  controls.update();
  document.querySelectorAll('[data-camera]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.camera === name)));
}

function fitView() {
  if (!clip) return;
  const subject = avatarSelection === 'makehuman' && avatarAdapter ? avatarAdapter.model : simplifiedGroup;
  subject.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(subject);
  if (bounds.isEmpty()) return;
  const size = bounds.getSize(new THREE.Vector3());
  controls.target.copy(bounds.getCenter(new THREE.Vector3()));
  const aspect = Math.max(0.5, camera.aspect);
  const fitSize = Math.max(size.y, size.x / aspect, size.z / aspect);
  cameraDistance = Math.max(1.35, fitSize / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.16);
  setCamera('threeQuarter');
}

function setAvatar(name) {
  avatarSelection = name;
  syncVisibility();
  setText('#avatar-status', name === 'makehuman' ? (avatarAdapter ? 'MakeHuman CC0' : '正在载入…') : '简化连杆');
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
  guide: ['使用指南', '<p>拖动画布旋转视角，滚轮缩放；正面、侧面、俯视、背面和 45° 按钮切换相机。右侧可切换 MakeHuman 人体或简化连杆，并控制骨架、坐标轴、地面反力和肌腱路径。</p><p>时间轴可拖动到任意采样帧，也可点击阶段标记。播放速度只影响回放，不会改变物理仿真。</p><p><strong>Space</strong> 播放 / 暂停，<strong>R</strong> 回到动作开头。</p>'],
  model: ['动力链与模型边界', '<p>MuJoCo 肌肉模型包含相应的关节、肌腱路径与接触约束。动作 JSON 同时导出身体位置、姿态和身体测点，查看器将这些数据映射到显示人模。</p><p>MakeHuman 通过独立 AvatarAdapter 适配器驱动。显示骨架只读取动作数据，不会修改 MuJoCo 的关节角、质量、肌肉力或积分状态。切换 Avatar 也不会修改动作文件。</p><p>下肢是共享节段运动的矢状面降阶模型；模型不表示左右腿独立控制、肩胛运动或完整三维肌肉控制。</p>'],
  sources: ['资料与许可', '<p>查看器使用 Three.js，仿真使用 <a href="https://mujoco.org/" target="_blank" rel="noreferrer">MuJoCo</a>。肌肉参数和几何属于研究原型假设。</p><p>人体模型来自 MakeHuman，采用 CC0 许可。<a href="/models/MAKEHUMAN-LICENSE.md" target="_blank" rel="noreferrer">查看许可</a> · <a href="/models/ASSET-PROVENANCE.md" target="_blank" rel="noreferrer">查看资产来源</a>。</p><p>静态查看器只读取版本化的 <code>h3d.motion.v1</code> 文件，不导入模拟器代码。项目采用 Apache-2.0 许可。</p>'],
};

async function loadAvatar() {
  try {
    avatarAdapter = await AvatarAdapter.load();
    scene.add(avatarAdapter.model);
    avatarAdapter.model.traverse((object) => {
      if (object.isMesh) object.castShadow = true;
      if (object.isSkinnedMesh) object.receiveShadow = true;
    });
    skeletonHelper = new THREE.SkeletonHelper(avatarAdapter.model);
    skeletonHelper.material.depthTest = true;
    skeletonHelper.material.transparent = true;
    skeletonHelper.material.opacity = 0.85;
    scene.add(skeletonHelper);
    setText('#avatar-status', 'MakeHuman CC0');
    syncVisibility();
    if (clip) renderFrame(sampleAt(clip, time));
  } catch (error) {
    setText('#avatar-status', '模型载入失败');
    console.error('MakeHuman avatar could not be loaded:', error);
    if (avatarSelection === 'makehuman') setAvatar('simplified');
  }
}

try {
  createRenderer();
  document.querySelectorAll('[data-layer]').forEach((button) => button.addEventListener('click', () => setLayer(button)));
  document.querySelectorAll('[data-avatar]').forEach((button) => button.addEventListener('click', () => setAvatar(button.dataset.avatar)));
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
    if (event.code === 'Space' && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); setPlaying(!playing); }
    if (event.key.toLowerCase() === 'r') { time = 0; setPlaying(false); }
  });

  requestAnimationFrame(tick);
  loadAvatar();
  fetch('/demo-motion.json')
    .then((response) => { if (!response.ok) throw new Error(`动作数据请求失败 (${response.status})`); return response.json(); })
    .then(acceptMotionSet)
    .catch((error) => fail(`${error.message}。先运行 npm run muscles 生成演示数据。`));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
