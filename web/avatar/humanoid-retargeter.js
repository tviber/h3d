import { MathUtils, Quaternion, Vector3 } from 'three';
import { mjQuatToThree, mjVecToThree, solveTwoBone } from './avatar-adapter.js';
import { AvatarCollision } from './avatar-collision.js';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
const DEG = Math.PI / 180;
const finiteVector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const position = (bone) => bone.getWorldPosition(new Vector3());
const worldRotation = (bone) => bone.getWorldQuaternion(new Quaternion());
const lengthOf = chain => chain.upperLength + chain.lowerLength;
const contactSide = name => /(?:left|(?:^|_)l(?:_|$))/i.test(name) ? 'left'
  : /(?:right|(?:^|_)r(?:_|$))/i.test(name) ? 'right' : null;

function landmarks(clip, frame) {
  // Static display landmarks are useful for display, but never source-rest calibration.
  const points = { ...(clip.rig?.staticPositions ?? {}), ...(frame.positions ?? {}) };
  for (const name of ['Shoulder', 'Elbow', 'Wrist', 'Hand']) {
    const key = name.toLowerCase();
    if (finiteVector(frame.positions?.[key]) && !finiteVector(frame.positions?.[`right${name}`])) {
      points[`right${name}`] = frame.positions[key];
    }
  }
  return points;
}

function sourceCalibration(clip) {
  const explicit = clip.rig?.sourceRest?.positions ?? clip.rig?.sourceRest;
  const bodies = new Map((clip.rig?.bodies ?? []).map(body => [body.name, body]));
  const read = (...names) => {
    for (const name of names) {
      const point = explicit?.[name] ?? bodies.get(name)?.restPosition;
      if (finiteVector(point)) return mjVecToThree(point);
    }
    return null;
  };
  const pelvis = read('pelvis');
  const legs = {};
  for (const side of ['left', 'right']) {
    const hip = read(`${side}Hip`, `${side}_thigh`, 'thigh');
    const knee = read(`${side}Knee`, `${side}_shank`, 'shank');
    const ankle = read(`${side}Ankle`, `${side}_foot`, 'foot');
    if (hip && knee && ankle && hip.distanceTo(knee) > 1e-6 && knee.distanceTo(ankle) > 1e-6) {
      legs[side] = { hip, knee, ankle, length: hip.distanceTo(knee) + knee.distanceTo(ankle) };
    }
  }
  if (!pelvis || !legs.left || !legs.right) {
    throw new Error('Humanoid lower-body motion requires sourceRest landmarks or exact pelvis/thigh/shank/foot rest bodies; shared staticPositions are not a source calibration.');
  }
  return { pelvis, legs, origin: explicit ? 'sourceRest' : 'rig.bodies', pelvisQuaternion: bodies.get('pelvis')?.restQuaternion };
}

function forceForSide(frame, side) {
  let sum = 0, identified = false;
  for (const contact of frame.contacts ?? []) {
    if (contactSide(contact.name ?? '') !== side) continue;
    identified = true;
    sum += Math.max(0, contact.force?.[2] ?? 0);
  }
  if (!identified) sum = Math.max(0, frame.grf?.feet?.[side]?.[2] ?? 0);
  return sum;
}

/** Precompute contact epochs, making seeks and reverse scrubbing independent of playback history. */
function contactEpochs(clip) {
  const samples = clip.samples ?? [];
  const epochs = { left: [], right: [] };
  for (const side of ['left', 'right']) {
    let active = false, epoch = null;
    for (const frame of samples) {
      const force = forceForSide(frame, side);
      const next = force >= (active ? 2 : 5);
      if (next && !active) {
        epoch = { start: frame.time, end: Infinity, frame };
        epochs[side].push(epoch);
      }
      if (!next && active) epoch.end = frame.time;
      active = next;
    }
  }
  return epochs;
}

/**
 * Bind-aware retargeter for an inspected, normalized humanoid.
 * Only joint rotations and pelvis translation change; all mesh data and bone scales stay intact.
 * The current motion source is a reduced-order humanoid, not a full-body motion synthesizer.
 */
export class HumanoidRetargeter {
  constructor(calibration) {
    this.calibration = calibration;
    this.model = calibration.model;
    this.profile = calibration.profile;
    const config = this.profile.retarget ?? {};
    if (config.limbStretch === true) throw new Error('Humanoid retargeting does not support bone stretching');
    if (config.contactPolicy && !['source-contact', 'none'].includes(config.contactPolicy)) throw new Error(`Unsupported contact policy: ${config.contactPolicy}`);
    if (config.rootMotion && config.rootMotion !== 'leg-length-relative') throw new Error(`Unsupported root motion policy: ${config.rootMotion}`);
    if (config.missingFingers && config.missingFingers !== 'preserve-bind') throw new Error(`Unsupported missing-finger policy: ${config.missingFingers}`);
    if (config.jointLimitsPreset && config.jointLimitsPreset !== 'humanoid') throw new Error(`Unsupported joint limits: ${config.jointLimitsPreset}`);
    this.roles = calibration.roles;
    this.rest = calibration.rest;
    this.chains = calibration.chains;
    this.cache = new WeakMap();
    this.diagnostics = { warnings: [], sourceCalibration: null, contacts: {}, limbResiduals: {}, pelvisCorrection: 0 };
    this.initialLengths = this.measureBoneLengths();
    this.standFeet = {};
    this.soleOffsets = {};
    for (const side of ['left', 'right']) {
      const foot = this.chains[`${side}Leg`].end;
      const state = this.rest.get(foot);
      this.standFeet[side] = state.worldPosition.clone();
      if (calibration.soleOffsets?.[side]) {
        this.soleOffsets[side] = calibration.soleOffsets[side].clone();
      } else {
        const sole = state.worldPosition.clone();
        sole.y = calibration.groundY ?? 0;
        this.soleOffsets[side] = foot.worldToLocal(sole);
      }
    }
    this.collision = new AvatarCollision(this, this.profile.collision);
    this.diagnostics.collision = this.collision.diagnostics;
  }

  warn(message) {
    if (!this.diagnostics.warnings.includes(message)) this.diagnostics.warnings.push(message);
  }

  reset() {
    for (const [bone, state] of this.rest) {
      bone.position.copy(state.position);
      bone.quaternion.copy(state.quaternion);
      bone.scale.copy(state.scale);
    }
    this.model.updateMatrixWorld(true);
  }

  setWorldRotation(bone, quaternion) {
    const parent = bone.parent ? worldRotation(bone.parent) : new Quaternion();
    bone.quaternion.copy(parent.invert().multiply(quaternion)).normalize();
    this.model.updateMatrixWorld(true);
  }

  setWorldPosition(bone, point) {
    bone.position.copy(bone.parent ? bone.parent.worldToLocal(point.clone()) : point);
    this.model.updateMatrixWorld(true);
  }

  /** Swing is composed with the current world bind frame, preserving arbitrary bone roll. */
  aim(bone, child, direction) {
    if (direction.lengthSq() < 1e-14) return;
    const current = position(child).sub(position(bone)).normalize();
    const delta = new Quaternion().setFromUnitVectors(current, direction.clone().normalize());
    this.setWorldRotation(bone, delta.multiply(worldRotation(bone)));
  }

  solveChain(name, target, pole, maxFlex = 155) {
    const chain = this.chains[name];
    const root = position(chain.upper);
    const solved = solveTwoBone(root, target, pole, chain.upperLength, chain.lowerLength, maxFlex);
    this.aim(chain.upper, chain.lower, solved.mid.clone().sub(root));
    this.aim(chain.lower, chain.end, solved.end.clone().sub(solved.mid));
    this.diagnostics.limbResiduals[name] = position(chain.end).distanceTo(target);
    return solved;
  }

  stand(applyCollision = true) {
    this.reset();
    for (const side of ['left', 'right']) {
      const chain = this.chains[`${side}Leg`];
      const root = position(chain.upper);
      const pole = root.clone().addScaledVector(Z, lengthOf(chain));
      this.solveChain(`${side}Leg`, this.standFeet[side], pole, 165);
      this.setWorldRotation(chain.end, this.rest.get(chain.end).worldQuaternion);
      const arm = this.chains[`${side}Arm`];
      const sign = side === 'left' ? 1 : -1;
      const upper = new Vector3(sign * .07, -1, .025).normalize();
      const lower = new Vector3(sign * .05, -1, .10).normalize();
      this.aim(arm.upper, arm.lower, upper);
      this.aim(arm.lower, arm.end, lower);
    }
    if (applyCollision) this.collision?.solve();
  }

  retargetArm(side, points, frame) {
    const shoulder = points[`${side}Shoulder`], elbow = points[`${side}Elbow`], wrist = points[`${side}Wrist`];
    if (![shoulder, elbow, wrist].every(finiteVector)) return;
    const upper = mjVecToThree(elbow).sub(mjVecToThree(shoulder));
    const forearm = mjVecToThree(wrist).sub(mjVecToThree(elbow));
    if (upper.lengthSq() < 1e-12 || forearm.lengthSq() < 1e-12) return;
    upper.normalize(); forearm.normalize();
    const override = side === 'right' ? frame.joints?.elbow_flex?.angle : frame.joints?.left_elbow_flex?.angle;
    const flex = MathUtils.clamp(Number.isFinite(override) ? override : upper.angleTo(forearm), 0, 155 * DEG);
    const bend = forearm.clone().addScaledVector(upper, -forearm.dot(upper));
    if (bend.lengthSq() < 1e-10) bend.copy(Z).addScaledVector(upper, -upper.z);
    if (bend.lengthSq() < 1e-10) bend.copy(Y).addScaledVector(upper, -upper.y);
    bend.normalize();
    const desiredForearm = upper.clone().multiplyScalar(Math.cos(flex)).addScaledVector(bend, Math.sin(flex));
    const chain = this.chains[`${side}Arm`];
    this.aim(chain.upper, chain.lower, upper);
    this.aim(chain.lower, chain.end, desiredForearm);
    // Fingers and wrist roll retain their imported bind pose if no validated channel exists.
  }

  clipData(clip) {
    let data = this.cache.get(clip);
    if (!data) {
      data = { source: sourceCalibration(clip), epochs: contactEpochs(clip) };
      this.cache.set(clip, data);
    }
    return data;
  }

  footOrientation(side, points) {
    const chain = this.chains[`${side}Leg`];
    const rest = this.rest.get(chain.end).worldQuaternion;
    const heel = points[`${side}Heel`], toe = points[`${side}Toe`];
    if (!finiteVector(heel) || !finiteVector(toe)) return rest.clone();
    const direction = mjVecToThree(toe).sub(mjVecToThree(heel));
    const pitch = -Math.atan2(direction.y, Math.max(1e-8, Math.hypot(direction.x, direction.z)));
    return new Quaternion().setFromAxisAngle(X, MathUtils.clamp(pitch, -65 * DEG, 65 * DEG)).multiply(rest);
  }

  soleWorldOffset(side, quaternion) {
    const foot = this.chains[`${side}Leg`].end;
    return this.soleOffsets[side].clone().multiply(foot.getWorldScale(new Vector3())).applyQuaternion(quaternion);
  }

  footTarget(side, points, frame, data, scale, footQuaternion) {
    const ankle = points[`${side}Ankle`];
    if (!finiteVector(ankle)) throw new Error(`Motion is missing ${side}Ankle`);
    const reference = data.source.legs[side].ankle;
    const bind = this.standFeet[side];
    const free = mjVecToThree(ankle).sub(reference).multiplyScalar(scale).add(bind);
    // Target stance width belongs to this avatar, not the source skeleton.
    free.x = bind.x;
    const epochs = data.epochs[side];
    const time = frame.time ?? 0;
    const epoch = epochs.find(item => time >= item.start && time < item.end);
    const previous = [...epochs].reverse().find(item => time >= item.end && time < item.end + .06);
    const lock = epoch ?? previous;
    if (!lock || this.profile.retarget?.contactPolicy === 'none') {
      this.diagnostics.contacts[side] = 'free';
      return free;
    }
    const entry = lock.frame.positions?.[`${side}Ankle`];
    if (!finiteVector(entry)) return free;
    const anchor = this.rest.get(this.chains[`${side}Leg`].end).worldPosition.clone();
    anchor.add(this.soleWorldOffset(side, this.rest.get(this.chains[`${side}Leg`].end).worldQuaternion));
    anchor.z += (mjVecToThree(entry).z - reference.z) * scale;
    anchor.y = this.calibration.groundY ?? 0;
    const locked = anchor.sub(this.soleWorldOffset(side, footQuaternion));
    this.diagnostics.contacts[side] = epoch ? 'sole-locked' : 'releasing';
    return epoch ? locked : locked.lerp(free, MathUtils.smoothstep(time, lock.end, lock.end + .06));
  }

  lowerBody(clip, frame, points) {
    const data = this.clipData(clip);
    this.diagnostics.sourceCalibration = data.source.origin;
    const meanTargetLength = (lengthOf(this.chains.leftLeg) + lengthOf(this.chains.rightLeg)) / 2;
    const meanSourceLength = (data.source.legs.left.length + data.source.legs.right.length) / 2;
    const scale = meanTargetLength / meanSourceLength;
    const sourcePelvis = points.pelvis;
    if (!finiteVector(sourcePelvis)) throw new Error('Lower-body motion is missing pelvis');
    const pelvisRest = this.rest.get(this.calibration.pelvis);
    const pelvisTarget = mjVecToThree(sourcePelvis).sub(data.source.pelvis).multiplyScalar(scale).add(pelvisRest.worldPosition);
    const tilt = frame.joints?.pelvis_tilt?.angle ?? 0;
    const pelvisQ = frame.bodies?.pelvis?.quaternion
      ? mjQuatToThree(frame.bodies.pelvis.quaternion).multiply(data.source.pelvisQuaternion ? mjQuatToThree(data.source.pelvisQuaternion).invert() : new Quaternion())
      : new Quaternion().setFromAxisAngle(X, tilt);
    this.setWorldPosition(this.calibration.pelvis, pelvisTarget);
    this.setWorldRotation(this.calibration.pelvis, pelvisQ.multiply(pelvisRest.worldQuaternion));
    const spine = this.calibration.spine;
    const trunk = frame.joints?.trunk_ext?.angle ?? 0;
    for (const bone of spine) {
      this.setWorldRotation(bone, new Quaternion().setFromAxisAngle(X, -trunk / Math.max(1, spine.length)).multiply(worldRotation(bone)));
    }
    const targets = {}, rotations = {};
    for (const side of ['left', 'right']) {
      rotations[side] = this.footOrientation(side, points);
      targets[side] = this.footTarget(side, points, frame, data, scale, rotations[side]);
    }
    // Alternating projection onto the two leg reach balls; never changes a bone length.
    const initialPelvis = position(this.calibration.pelvis);
    for (let iteration = 0; iteration < 14; iteration++) {
      let maximum = 0;
      for (const side of ['left', 'right']) {
        const chain = this.chains[`${side}Leg`];
        const hip = position(chain.upper);
        const delta = hip.clone().sub(targets[side]);
        const d = delta.length();
        const max = lengthOf(chain) * .9995;
        const min = Math.sqrt(chain.upperLength ** 2 + chain.lowerLength ** 2 + 2 * chain.upperLength * chain.lowerLength * Math.cos(155 * DEG));
        const desired = MathUtils.clamp(d, min, max);
        maximum = Math.max(maximum, Math.abs(d - desired));
        if (Math.abs(d - desired) > 1e-8 && d > 1e-10) {
          const correction = delta.multiplyScalar((desired - d) / d);
          this.setWorldPosition(this.calibration.pelvis, position(this.calibration.pelvis).add(correction));
        }
      }
      if (maximum < meanTargetLength * 1e-5) break;
    }
    this.diagnostics.pelvisCorrection = position(this.calibration.pelvis).distanceTo(initialPelvis);
    for (const side of ['left', 'right']) {
      const chain = this.chains[`${side}Leg`];
      const knee = points[`${side}Knee`], hip = points[`${side}Hip`];
      const pole = position(chain.upper).addScaledVector(Z, lengthOf(chain));
      if (finiteVector(knee) && finiteVector(hip)) {
        const upperDirection = mjVecToThree(knee).sub(mjVecToThree(hip)).normalize();
        // A forward bias remains defined for a completely straight source knee.
        pole.copy(position(chain.upper)).addScaledVector(upperDirection, chain.upperLength).addScaledVector(Z, lengthOf(chain) * .15);
      }
      this.solveChain(`${side}Leg`, targets[side], pole, 155);
      this.setWorldRotation(chain.end, rotations[side]);
      this.retargetArm(side, points, frame);
    }
    const residual = Math.max(...Object.values(this.diagnostics.limbResiduals));
    if (residual > meanTargetLength * .02) this.warn('IK reach residual exceeds 2% of leg length; inspect proportions and source motion.');
    this.warn('First-stage foot contact uses one calibrated sole anchor per foot; independent heel/toe pivots are not implemented.');
  }

  applyFrame(clip, frame) {
    if (!clip || !frame) throw new Error('A motion clip and sample are required');
    const coordinateFrame = clip.rig?.coordinateFrame;
    const expected = { forward: '+x', left: '+y', up: '+z', units: 'm', quaternionOrder: 'wxyz' };
    if (coordinateFrame && Object.entries(expected).some(([key, value]) => coordinateFrame[key] !== value)) {
      throw new Error('Unsupported motion coordinateFrame: expected MuJoCo +X forward, +Y left, +Z up, metres, wxyz quaternions');
    }
    this.diagnostics.limbResiduals = {};
    this.diagnostics.contacts = {};
    this.diagnostics.pelvisCorrection = 0;
    this.stand(false);
    const points = landmarks(clip, frame);
    if (clip.rig?.kind === 'authored-humanoid') this.authoredPose(frame.pose);
    else if (clip.rig?.kind === 'lower-body') this.lowerBody(clip, frame, points);
    else if (clip.rig?.kind === 'elbow' || clip.rig?.kind === 'shoulder-elbow') this.retargetArm('right', points, frame);
    else throw new Error(`Unsupported humanoid motion kind: ${clip.rig?.kind}`);
    this.model.updateMatrixWorld(true);
    this.collision.solve();
    for (const [bone] of this.rest) {
      if (![...bone.position, ...bone.quaternion, ...bone.scale].every(Number.isFinite)) throw new Error(`Non-finite pose at ${bone.name}`);
    }
  }

  measureBoneLengths() {
    this.model.updateMatrixWorld(true);
    const result = {};
    let index = 0;
    for (const [bone] of this.rest) {
      // Pelvis translation is root motion, even when an exporter adds a control bone above it.
      if (bone !== this.calibration.pelvis && bone.parent?.isBone) result[`${index}:${bone.name}`] = position(bone).distanceTo(position(bone.parent));
      index++;
    }
    return result;
  }

  authoredPose(pose) {
    const keys = ['sway','depth','lean','hipBack','yaw','armRaise','armSpread','elbowFlex'];
    if (!pose || keys.some(key => !Number.isFinite(pose[key]))) throw new Error('Invalid authored pose channels');
    const legLength = (lengthOf(this.chains.leftLeg)+lengthOf(this.chains.rightLeg))/2;
    const pelvis = this.calibration.pelvis;
    const bind = this.rest.get(pelvis);
    const sway = MathUtils.clamp(pose.sway,-.1,.1)*legLength;
    const target = bind.worldPosition.clone().add(new Vector3(sway,-MathUtils.clamp(pose.depth,0,.4)*legLength,-MathUtils.clamp(pose.hipBack,0,.2)*legLength));
    this.setWorldPosition(pelvis,target);
    this.setWorldRotation(pelvis,new Quaternion().setFromAxisAngle(X,pose.lean*DEG*.4).multiply(bind.worldQuaternion));
    const spine = this.calibration.spine;
    for (const bone of spine) {
      const delta = new Quaternion().setFromAxisAngle(Y,pose.yaw*DEG/Math.max(1,spine.length))
        .multiply(new Quaternion().setFromAxisAngle(X,pose.lean*DEG*.6/Math.max(1,spine.length)));
      this.setWorldRotation(bone,delta.multiply(worldRotation(bone)));
    }
    // Reach projection for both support feet, proportional to this avatar's actual legs.
    for (let i=0;i<16;i++) for (const side of ['left','right']) {
      const chain=this.chains[`${side}Leg`], foot=this.standFeet[side];
      const delta=position(chain.upper).sub(foot), distance=delta.length();
      const max=lengthOf(chain)*.9995;
      if(distance>max) this.setWorldPosition(pelvis,position(pelvis).add(delta.multiplyScalar((max-distance)/distance)));
    }
    for (const side of ['left','right']) {
      const leg=this.chains[`${side}Leg`], arm=this.chains[`${side}Arm`], sign=side==='left'?1:-1;
      this.solveChain(`${side}Leg`,this.standFeet[side],position(leg.upper).addScaledVector(Z,legLength),155);
      this.setWorldRotation(leg.end,this.rest.get(leg.end).worldQuaternion);
      this.diagnostics.contacts[side]='sole-locked';
      const raise=MathUtils.clamp(pose.armRaise,0,170)*DEG, spread=MathUtils.clamp(pose.armSpread,0,90)*DEG;
      const upper=new Vector3(sign*Math.sin(spread),-Math.cos(raise)*Math.cos(spread),Math.sin(raise)*Math.cos(spread)).normalize();
      const bend = new Vector3(0,0,1).addScaledVector(upper,-upper.z);
      if(bend.lengthSq()<1e-8) bend.set(0,1,0).addScaledVector(upper,-upper.y);
      bend.normalize();
      const flex=MathUtils.clamp(pose.elbowFlex,0,145)*DEG;
      const lower=upper.clone().multiplyScalar(Math.cos(flex)).addScaledVector(bend,Math.sin(flex));
      // Directions follow the authored anatomical torso yaw, independent of imported bone axes.
      const torsoQ=new Quaternion().setFromAxisAngle(Y,pose.yaw*DEG);
      upper.applyQuaternion(torsoQ); lower.applyQuaternion(torsoQ);
      this.aim(arm.upper,arm.lower,upper);this.aim(arm.lower,arm.end,lower);
    }
    this.warn('Authored kinematic preview: support IK and optional display contact constraints; no dynamic balance or simulated contact forces.');
  }
}
