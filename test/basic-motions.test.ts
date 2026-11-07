import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createBasicMotionClips, basicPoseAt, smoother } from '../web/avatar/basic-motions.js';
import { createHumanoidProfile, loadAvatarProfile } from '../web/avatar/avatar-loader.js';

test('five authored studies return to their own start pose with finite smooth channels and explicit provenance', () => {
  const clips=createBasicMotionClips();
  assert.equal(clips.length,5);
  for(const c of clips){
    assert.equal(c.provenance.kind,'authored-kinematic');
    assert.deepEqual(basicPoseAt(c.id,0),basicPoseAt(c.id,c.duration));
    assert.equal(c.samples.at(-1).time,c.duration);
    assert.ok(c.samples.every((s:any)=>Object.values(s.pose).every(Number.isFinite)));
    assert.ok(c.samples.every((s:any)=>!s.contacts.length&&!Object.keys(s.muscles).length));
    for(let i=1;i<c.samples.length;i++)for(const key of Object.keys(c.samples[i].pose)){
      assert.ok(Math.abs(c.samples[i].pose[key]-c.samples[i-1].pose[key])<10,`${c.id}:${key} discontinuity`);
    }
  }
  const h=1e-5;
  assert.ok((smoother(h)-smoother(0))/h<1e-6);
  assert.ok((smoother(1)-smoother(1-h))/h<1e-6);
});

test('authored studies preserve real GLB bone lengths, skins, and deterministic seeking',async()=>{
  const bytes=readFileSync(new URL('../web/models/human.glb',import.meta.url));
  const a=await loadAvatarProfile(createHumanoidProfile('test','Human'),{buffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
  const lengths=a.measureBoneLengths();
  for(const c of createBasicMotionClips()){
    const middle=c.samples[Math.floor(c.samples.length*.3)];a.applyFrame(c,middle);
    const snapshot=[...a.rest.keys()].map(b=>b.quaternion.toArray());
    for(let i=0;i<c.samples.length;i+=8){a.applyFrame(c,c.samples[i]);for(const[k,v]of Object.entries(a.measureBoneLengths()))assert.ok(Math.abs(v-lengths[k])<1e-7);}
    a.applyFrame(c,middle);assert.deepEqual([...a.rest.keys()].map(b=>b.quaternion.toArray()),snapshot);
  }
});
