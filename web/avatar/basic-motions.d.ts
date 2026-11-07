export const BASIC_MOTION_DEFINITIONS: {id:string;label:string;poseId:string;duration:number}[];
export function smoother(t:number):number;
export function basicPoseAt(id:string, seconds:number):Record<string,number>;
export function createBasicMotionClips():any[];
