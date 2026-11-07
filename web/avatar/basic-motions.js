// Authored animation studies: reference poses are constraints, not motion capture or simulation.
const definitions = [
  ['weight-shift', '站姿：左右重心转移', 'P015', 6, { sway: .07 }, true],
  ['overhead-reach', '伸展：双臂上举与放下', 'P019', 5, { armRaise: 165, elbowFlex: 8 }],
  ['everyday-squat', '下肢：下蹲与起立', 'P058', 5, { depth: .32, lean: 22, armRaise: 45, elbowFlex: 35 }],
  ['hip-hinge', '俯身：髋折叠与直立', 'P064', 5, { depth: .065, lean: 45, hipBack: .16, armRaise: 15, elbowFlex: 12 }],
  ['standing-turn', '转体：左右转身与回正', 'P073', 7, { yaw: 35, armSpread: 65, elbowFlex: 12 }, true],
];
export const BASIC_MOTION_DEFINITIONS = definitions.map(([id, label, poseId, duration]) => ({ id, label, poseId, duration }));
// Quintic easing gives zero endpoint velocity and acceleration.
export const smoother = t => { t = Math.max(0, Math.min(1, t)); return t*t*t*(t*(t*6-15)+10); };
function envelope(u) {
  if (u < .12 || u > .92) return 0;
  if (u < .4) return smoother((u-.12)/.28);
  if (u < .58) return 1;
  return 1-smoother((u-.58)/.34);
}
export function basicPoseAt(id, seconds) {
  const definition = definitions.find(item => item[0] === id);
  if (!definition) throw new Error(`Unknown basic motion ${id}`);
  const [, , , duration, peak, bilateral] = definition;
  const u = Math.max(0, Math.min(1, seconds/duration));
  const value = bilateral ? (u < .5 ? envelope(u*2) : -envelope((u-.5)*2)) : envelope(u);
  const e = value === 0 ? 0 : value;
  const pose = { sway: 0, depth: 0, lean: 0, hipBack: 0, yaw: 0, armRaise: 0, armSpread: 0, elbowFlex: 8 };
  for (const [key, value] of Object.entries(peak)) pose[key] = value * (key === 'armSpread' || key === 'elbowFlex' ? Math.abs(e) : e);
  return pose;
}
export function createBasicMotionClips() {
  return definitions.map(([id,label,poseId,duration,,bilateral]) => {
    const samples = Array.from({length: Math.round(duration*30)+1}, (_,i) => ({
      time: i/30, pose: basicPoseAt(id, i/30), positions: {}, joints: {}, muscles: {},
      // Empty force channels deliberately carry no invented forces or activation estimates.
      contacts: [], grf: {force:[0,0,0],feet:{left:[0,0,0],right:[0,0,0]},contactCount:0,centerOfPressure:null},
      tendonPaths: {}, regionalPower: {}, com:[0,0,0],
    }));
    return {schemaVersion:'h3d.motion.v1',id,label,duration,timestep:1/30,
      provenance:{kind:'authored-kinematic',reference:`https://shisei.indaloop.app/en/pose/${poseId}/`,poseId,
        method:'Hand-authored anatomical keyframes; quintic transitions, support-foot IK, no reconstructed 3D pose or simulated forces'},
      phases:(bilateral
        ? [['左侧进入',0,.2],['左侧保持',.2,.29],['返回中立',.29,.5],['右侧进入',.5,.7],['右侧保持',.7,.79],['返回中立',.79,1]]
        : [['进入',0,.4],['保持',.4,.58],['返回',.58,1]])
        .map(([label,start,end])=>({label,start:start*duration,end:end*duration})),
      rig:{kind:'authored-humanoid',staticPositions:{},segments:[],jointNames:[],jointTypes:{},muscles:[]},samples};
  });
}
