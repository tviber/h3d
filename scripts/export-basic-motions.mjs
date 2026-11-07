import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createBasicMotionClips } from '../web/avatar/basic-motions.js';
const target=resolve(process.argv[2] ?? 'out/basic-motions.json');
await mkdir(dirname(target),{recursive:true});
await writeFile(target,JSON.stringify({schemaVersion:'h3d.motion-set.v1',clips:createBasicMotionClips()},null,2)+'\n');
console.log(`Saved 5 authored kinematic clips: ${target}`);
