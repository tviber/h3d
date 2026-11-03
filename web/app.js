const canvas = document.querySelector('#scene');
const gl = canvas.getContext('webgl', { antialias: true, alpha: false, depth: true });
const loading = document.querySelector('#loading');
const scrubber = document.querySelector('#scrubber');
const playButton = document.querySelector('#play');
const timeReadout = document.querySelector('#time-readout');
const muscleList = document.querySelector('#muscle-list');
const jointList = document.querySelector('#joint-list');
const layerState = { surface: true, skeleton: true, axes: false, grf: true, tendons: true };
const segmentColors = { torso: [0.37, 0.42, 0.57], arm: [0.52, 0.57, 0.68], leg: [0.43, 0.50, 0.64] };
const boneColor = [0.72, 0.58, 0.34];
let clips = [], clip = null, time = 0, playing = false, loop = true;
let lastFrame = 0, lastPanelUpdate = 0, yaw = 0.72, pitch = 0.08, cameraDistance = 3.15, cameraCenter = [0, 0, 0.86];
let pointer = null, renderer = null;

function fail(message) {
  loading.querySelector('strong').textContent = message;
  loading.querySelector('p').textContent = '请检查动作文件，或重新运行 npm run muscles。';
  loading.classList.remove('hidden');
  document.querySelector('#data-status').textContent = '载入失败';
}
function rgb(hex) { const n = Number.parseInt(hex.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}
function makeMesh(positions, normals, indices) {
  const positionBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  const normalBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
  const indexBuffer = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
  return { positionBuffer, normalBuffer, indexBuffer, count: indices.length };
}
function makeSphere() {
  const positions = [], normals = [], indices = [], rows = 16, columns = 24;
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    const theta = row * Math.PI / rows, phi = col * Math.PI * 2 / columns;
    const p = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
    positions.push(...p); normals.push(...p);
  }
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const a = row * (columns + 1) + col, b = a + columns + 1;
    indices.push(a, a + 1, b, b, a + 1, b + 1);
  }
  return makeMesh(positions, normals, indices);
}
function makeCylinder() {
  const positions = [], normals = [], indices = [], sides = 16;
  for (let i = 0; i <= sides; i++) {
    const angle = i * Math.PI * 2 / sides, x = Math.cos(angle), z = Math.sin(angle);
    positions.push(x, -0.5, z, x, 0.5, z); normals.push(x, 0, z, x, 0, z);
  }
  for (let i = 0; i < sides; i++) { const a = i * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  return makeMesh(positions, normals, indices);
}
function createRenderer() {
  if (!gl) throw new Error('当前环境不支持 WebGL');
  const vertex = compileShader(gl.VERTEX_SHADER, `
    attribute vec3 aPosition; attribute vec3 aNormal;
    uniform mat4 uViewProjection; uniform mat4 uModel; uniform mat3 uNormal;
    varying vec3 vNormal;
    void main(){vNormal=normalize(uNormal*aNormal);gl_Position=uViewProjection*uModel*vec4(aPosition,1.0);}
  `);
  const fragment = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float; uniform vec3 uColor; varying vec3 vNormal;
    void main(){vec3 n=normalize(vNormal);vec3 l1=normalize(vec3(-0.4,-0.6,0.9));vec3 l2=normalize(vec3(0.7,0.25,0.4));
      float d=max(dot(n,l1),0.0)*0.48+max(dot(n,l2),0.0)*0.12;float rim=pow(1.0-abs(n.z),2.0)*0.06;
      gl_FragColor=vec4(uColor*(0.58+d+rim),1.0);}
  `);
  const program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const locations = {
    position: gl.getAttribLocation(program, 'aPosition'), normal: gl.getAttribLocation(program, 'aNormal'),
    viewProjection: gl.getUniformLocation(program, 'uViewProjection'), model: gl.getUniformLocation(program, 'uModel'),
    normalMatrix: gl.getUniformLocation(program, 'uNormal'), color: gl.getUniformLocation(program, 'uColor'),
  };
  gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.clearColor(0.969, 0.969, 0.976, 1);
  return { locations, sphere: makeSphere(), cylinder: makeCylinder() };
}
function normalize(v) { const length = Math.hypot(...v) || 1; return v.map((x) => x / length); }
function cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
function multiply(a,b){const o=new Float32Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++)o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];return o;}
function perspective(fov,aspect,near,far){const f=1/Math.tan(fov/2),o=new Float32Array(16);o[0]=f/aspect;o[5]=f;o[10]=(far+near)/(near-far);o[11]=-1;o[14]=2*far*near/(near-far);return o;}
function lookAt(eye,target,up){const z=normalize([eye[0]-target[0],eye[1]-target[1],eye[2]-target[2]]),x=normalize(cross(up,z)),y=cross(z,x);return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);}
function modelMatrix(position,axes,scale){return new Float32Array([
  axes[0][0]*scale[0],axes[0][1]*scale[0],axes[0][2]*scale[0],0,
  axes[1][0]*scale[1],axes[1][1]*scale[1],axes[1][2]*scale[1],0,
  axes[2][0]*scale[2],axes[2][1]*scale[2],axes[2][2]*scale[2],0,position[0],position[1],position[2],1,
]);}
function identityAxes(){return [[1,0,0],[0,1,0],[0,0,1]];}
function bindMesh(mesh){gl.bindBuffer(gl.ARRAY_BUFFER,mesh.positionBuffer);gl.enableVertexAttribArray(renderer.locations.position);gl.vertexAttribPointer(renderer.locations.position,3,gl.FLOAT,false,0,0);gl.bindBuffer(gl.ARRAY_BUFFER,mesh.normalBuffer);gl.enableVertexAttribArray(renderer.locations.normal);gl.vertexAttribPointer(renderer.locations.normal,3,gl.FLOAT,false,0,0);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,mesh.indexBuffer);}
function drawMesh(mesh,transform,axes,color){gl.uniformMatrix4fv(renderer.locations.model,false,transform);gl.uniformMatrix3fv(renderer.locations.normalMatrix,false,new Float32Array([axes[0][0],axes[0][1],axes[0][2],axes[1][0],axes[1][1],axes[1][2],axes[2][0],axes[2][1],axes[2][2]]));gl.uniform3fv(renderer.locations.color,color);bindMesh(mesh);gl.drawElements(gl.TRIANGLES,mesh.count,gl.UNSIGNED_SHORT,0);}
function drawRod(from,to,radius,color){const delta=to.map((v,i)=>v-from[i]),length=Math.hypot(...delta);if(length<1e-5)return;const y=delta.map(v=>v/length),x=normalize(cross(y,Math.abs(y[2])>.92?[1,0,0]:[0,0,1])),z=cross(x,y),axes=[x,y,z],center=from.map((v,i)=>(v+to[i])/2);drawMesh(renderer.cylinder,modelMatrix(center,axes,[radius,length,radius]),axes,color);}
function drawVector(origin,vector,color,radius=0.008,scale=1){const mag=Math.hypot(...vector);if(mag<1e-7)return;const end=origin.map((v,i)=>v+vector[i]/mag*Math.min(0.5,mag*scale));drawRod(origin,end,radius,color);const axes=identityAxes();drawMesh(renderer.sphere,modelMatrix(end,axes,[radius*2.1,radius*2.1,radius*2.1]),axes,color);}
function resizeCanvas(){const rect=canvas.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2),w=Math.max(1,Math.round(rect.width*dpr)),h=Math.max(1,Math.round(rect.height*dpr));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h);}}
function activationColor(value){const low=[0.20,0.48,0.80],high=[0.83,0.27,0.18],t=Math.max(0,Math.min(1,value));return low.map((v,i)=>v+(high[i]-v)*t);}
function drawGround(){
  const diskAxes=[[1,0,0],[0,0,1],[0,-1,0]],shadowColor=[0.88,0.885,0.90];
  drawMesh(renderer.sphere,modelMatrix([cameraCenter[0],0,0.005],diskAxes,[0.43,0.008,0.30]),diskAxes,shadowColor);
  const grid=rgb('#e5e5ea');
  for(let i=-8;i<=8;i++){
    const offset=i*0.15;drawRod([-1.2,offset,0.001],[1.2,offset,0.001],0.0014,grid);drawRod([offset,-1.2,0.001],[offset,1.2,0.001],0.0014,grid);
  }
  drawRod([-1.2,0,0.002],[1.2,0,0.002],0.002,rgb('#d7d8df'));
}
function renderScene(activeClip,frame){
  resizeCanvas();gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  const horizontal=cameraDistance*Math.cos(pitch),eye=[cameraCenter[0]+horizontal*Math.sin(yaw),cameraCenter[1]+horizontal*Math.cos(yaw),cameraCenter[2]+cameraDistance*Math.sin(pitch)];
  const vp=multiply(perspective(Math.PI/4.1,canvas.width/canvas.height,0.04,30),lookAt(eye,cameraCenter,[0,0,1]));gl.uniformMatrix4fv(renderer.locations.viewProjection,false,vp);
  drawGround();
  const positions={...activeClip.rig.staticPositions,...frame.positions};
  if(positions.shoulder&&!positions.rightShoulder)positions.rightShoulder=positions.shoulder;
  if(positions.elbow&&!positions.rightElbow)positions.rightElbow=positions.elbow;
  if(positions.wrist&&!positions.rightWrist)positions.rightWrist=positions.wrist;
  if(positions.hand&&!positions.rightHand)positions.rightHand=positions.hand;
  const identity=identityAxes();
  if(layerState.surface){
    for(const segment of activeClip.rig.segments){const a=positions[segment.from],b=positions[segment.to];if(a&&b)drawRod(a,b,segment.radius,segmentColors[segment.group]);}
    const radii={pelvis:.135,waist:.125,neck:.065,head:.105,leftShoulder:.053,rightShoulder:.053,leftElbow:.043,rightElbow:.043,leftWrist:.032,rightWrist:.032,leftHip:.068,rightHip:.068,leftKnee:.052,rightKnee:.052,leftAnkle:.04,rightAnkle:.04,leftHand:.034,rightHand:.034};
    for(const [name,r] of Object.entries(radii)){const p=positions[name];if(p)drawMesh(renderer.sphere,modelMatrix(p,identity,[r,r,r]),identity,segmentColors[name.toLowerCase().includes('hip')||name.toLowerCase().includes('knee')||name.toLowerCase().includes('ankle')?'leg':name.toLowerCase().includes('shoulder')||name.toLowerCase().includes('elbow')||name.toLowerCase().includes('wrist')||name.toLowerCase().includes('hand')?'arm':'torso']);}
  }
  if(layerState.skeleton){
    for(const segment of activeClip.rig.segments){const a=positions[segment.from],b=positions[segment.to];if(a&&b)drawRod(a,b,.012,boneColor);}
    const names=['pelvis','leftShoulder','rightShoulder','leftElbow','rightElbow','leftWrist','rightWrist','leftHip','rightHip','leftKnee','rightKnee','leftAnkle','rightAnkle'];
    for(const name of names){const p=positions[name];if(p)drawMesh(renderer.sphere,modelMatrix(p,identity,[.018,.018,.018]),identity,boneColor);}
  }
  if(layerState.axes){
    const joints=['pelvis','leftHip','rightHip','leftKnee','rightKnee','leftAnkle','rightAnkle'];
    for(const name of joints){const p=positions[name];if(!p)continue;drawVector(p,[.1,0,0],rgb('#d64545'),.003,1);drawVector(p,[0,.1,0],rgb('#189a58'),.003,1);drawVector(p,[0,0,.1],rgb('#4169c1'),.003,1);}
  }
  if(layerState.grf){
    for(const contact of frame.contacts??[]){const mag=Math.hypot(...contact.force);if(mag>1)drawVector(contact.position,contact.force,rgb('#d97706'),.006,.00045);}
  }
  if(layerState.tendons){
    for(const [name,path] of Object.entries(frame.tendonPaths??{})){if(path.length<2)continue;const color=activationColor(frame.muscles[name]?.activation??0);for(let i=0;i<path.length-1;i++)drawRod(path[i],path[i+1],.0045,color);}
  }
}
function lerp(a,b,t){return a+(b-a)*t;}
function mixVector(a,b,t){return a.map((value,i)=>lerp(value,b?.[i]??value,t));}
function sampleAt(activeClip,seconds){
  const samples=activeClip.samples;let lo=0,hi=samples.length-1;
  while(lo<hi){const mid=Math.floor((lo+hi+1)/2);if(samples[mid].time<=seconds)lo=mid;else hi=mid-1;}
  const next=Math.min(samples.length-1,lo+1),a=samples[lo],b=samples[next],span=b.time-a.time,alpha=span>0?Math.max(0,Math.min(1,(seconds-a.time)/span)):0;
  const positions={};for(const [name,p]of Object.entries(a.positions))positions[name]=mixVector(p,b.positions[name],alpha);
  const com=mixVector(a.com??[0,0,0],b.com,alpha);
  const joints={};for(const [name,j]of Object.entries(a.joints)){const q=b.joints[name]??j;joints[name]={angle:lerp(j.angle,q.angle,alpha),velocity:lerp(j.velocity,q.velocity,alpha)};}
  const muscles={};for(const [name,m]of Object.entries(a.muscles)){const q=b.muscles[name]??m;muscles[name]={activation:lerp(m.activation,q.activation,alpha),force:lerp(m.force,q.force,alpha),length:lerp(m.length,q.length,alpha)};}
  const contacts=(a.contacts??[]).map((c)=>{const nextContact=(b.contacts??[]).find((x)=>x.name===c.name);return{name:c.name,position:mixVector(c.position,nextContact?.position,alpha),force:mixVector(c.force,nextContact?.force,alpha)};});
  const tendonPaths={};for(const[name,path]of Object.entries(a.tendonPaths??{})){const nextPath=b.tendonPaths?.[name]??path;tendonPaths[name]=path.map((p,i)=>mixVector(p,nextPath[i]??p,alpha));}
  const regionalPower={};for(const name of ['lower-body','trunk','upper-body'])regionalPower[name]=lerp(a.regionalPower?.[name]??0,b.regionalPower?.[name]??0,alpha);
  const grfForce=mixVector(a.grf?.force??[0,0,0],b.grf?.force,alpha),copA=a.grf?.centerOfPressure,copB=b.grf?.centerOfPressure;
  const centerOfPressure=copA&&copB?mixVector(copA,copB,alpha):copA??copB??null;
  const feet={left:mixVector(a.grf?.feet?.left??[0,0,0],b.grf?.feet?.left,alpha),right:mixVector(a.grf?.feet?.right??[0,0,0],b.grf?.feet?.right,alpha)};
  return{time:seconds,com,positions,joints,muscles,contacts,tendonPaths,regionalPower,grf:{force:grfForce,centerOfPressure,contactCount:alpha<.5?a.grf?.contactCount??0:b.grf?.contactCount??0,feet}};
}
function prettyName(name){return name.replaceAll('_',' ').replace(/\b\w/g,(c)=>c.toUpperCase());}
function setText(selector,value){document.querySelector(selector).textContent=value;}
function formatJoint(name,state,kind){const isSlide=kind==='slide';return isSlide?`${state.angle.toFixed(3)} m · ${state.velocity.toFixed(2)} m/s`:`${(state.angle*180/Math.PI).toFixed(1)}° · ${state.velocity.toFixed(2)} rad/s`;}
function updatePanel(activeClip,frame,now){
  if(now-lastPanelUpdate<75)return;lastPanelUpdate=now;
  setText('#time-readout',`${frame.time.toFixed(3)} / ${activeClip.duration.toFixed(3)} s`);scrubber.value=String(frame.time/activeClip.duration);
  const phase=activeClip.phases.find((p)=>frame.time>=p.start&&frame.time<=p.end);setText('#phase-readout',phase?.label??'动作结束');
  const force=frame.grf.force,total=Math.hypot(...force);setText('#grf-z',force[2].toFixed(0));setText('#grf-total',total.toFixed(0));setText('#contact-count',String(frame.grf.contactCount));
  const rootZ=frame.com?.[2];setText('#com-height',rootZ===undefined?'—':rootZ.toFixed(3));
  const powerList=document.querySelector('#power-list');powerList.replaceChildren();
  const powerLabels=[['lower-body','下肢'],['trunk','躯干'],['upper-body','上肢']],maxPower=Math.max(150,...powerLabels.map(([key])=>Math.abs(frame.regionalPower[key]??0)));
  for(const[key,label]of powerLabels){const value=frame.regionalPower[key]??0,row=document.createElement('div');row.className='power-row';const name=document.createElement('span');name.textContent=label;const track=document.createElement('div');track.className='power-track';const fill=document.createElement('i');fill.className=value<0?'negative':'';fill.style.width=`${Math.min(100,Math.abs(value)/maxPower*100)}%`;track.append(fill);const output=document.createElement('output');output.textContent=`${value>0?'+':''}${value.toFixed(0)}`;row.append(name,track,output);powerList.append(row);}
  muscleList.replaceChildren();
  activeClip.rig.muscles.forEach((muscle)=>{const state=frame.muscles[muscle.name]??{activation:0,force:0};const row=document.createElement('div');row.className='muscle-row';const head=document.createElement('div');head.className='muscle-row-head';const name=document.createElement('span');name.className='muscle-name';const dot=document.createElement('i');dot.className='muscle-color';const c=activationColor(state.activation);dot.style.background=`rgb(${c.map((x)=>Math.round(x*255)).join(',')})`;const text=document.createElement('span');text.textContent=prettyName(muscle.name);name.append(dot,text);head.append(name);const values=document.createElement('div');values.className='muscle-row-data';const activation=document.createElement('span');activation.textContent=`激活 ${(state.activation*100).toFixed(0)}%`;const strength=document.createElement('strong');strength.textContent=`${state.force.toFixed(0)} N`;values.append(activation,strength);row.append(head,values);muscleList.append(row);});
  jointList.replaceChildren();
  for(const[name,state]of Object.entries(frame.joints)){const row=document.createElement('div');row.className='joint-row';const label=document.createElement('span');label.textContent=prettyName(name);const value=document.createElement('strong');value.textContent=formatJoint(name,state,activeClip.rig.jointTypes?.[name]);row.append(label,value);jointList.append(row);}
}
function describeClip(activeClip){
  if(activeClip.id==='squat-to-stand')return{description:'从深蹲位开始，依靠髋、膝、踝肌群伸展起立。足底接触反力由 MuJoCo 接触求解得到。',focus:['髋膝伸展','重心控制','足底支撑']};
  if(activeClip.id==='countermovement-drive')return{description:'先快速下沉，再通过髋膝踝伸展完成蹬伸，回到双足支撑。',focus:['反向动作','肌肉协同','地面反力']};
  if(activeClip.id==='shoulder-elbow')return{description:'右上臂先从自然下垂位置抬至接近水平，再保持肩位完成高位绳索弯举式屈肘。前束三角肌维持肩位，肱二头肌与肱肌屈肘，肱三头肌拮抗。',focus:['水平抬臂','高位屈肘','肩肘协同']};
  if(activeClip.rig.kind==='elbow')return{description:'肱二头肌屈肘，肱三头肌拮抗制动；肌腱路径实时决定力臂。',focus:['单关节','拮抗肌','力臂']};
  return{description:'双关节肌和单关节肌共同产生关节力矩，肌腱路径实时决定力臂。',focus:['双关节肌','肩肘协同','肌腱路径']};
}
function setClip(index){
  clip=clips[index];time=0;playing=false;lastFrame=0;playButton.textContent='▶';playButton.setAttribute('aria-label','播放动作');scrubber.value='0';
  setText('#clip-title',clip.label);setText('#clip-subtitle',clip.rig.kind==='lower-body'?'骨盆 · 躯干 · 下肢 · 地面接触':'肌肉驱动 · MuJoCo 正向动力学');
  const copy=describeClip(clip);setText('#motion-description',copy.description);const focus=document.querySelector('#focus-list');focus.replaceChildren();copy.focus.forEach((tag)=>{const el=document.createElement('span');el.textContent=tag;focus.append(el);});
  const list=document.querySelector('#motion-list');list.replaceChildren();clips.forEach((item,i)=>{const button=document.createElement('button');button.className=`motion-row${i===index?' selected':''}`;button.setAttribute('aria-pressed',String(i===index));const number=document.createElement('span');number.className='motion-number';number.textContent=String(i+1).padStart(2,'0');const label=document.createElement('span');label.className='motion-label';label.textContent=item.label;const detail=document.createElement('small');detail.textContent=item.rig.kind==='lower-body'?'FLOATING BASE · CONTACT':item.rig.kind==='elbow'?'1 DOF · 2 MUSCLES':'2 DOF · 4 MUSCLES';label.append(detail);button.append(number,label);button.addEventListener('click',()=>setClip(i));list.append(button);});
  setText('#clip-count',String(clips.length).padStart(2,'0'));setText('#model-label',`${clip.rig.jointNames.length} 个自由度 · ${clip.rig.muscles.length} 块肌肉`);setText('#data-status',`${clip.samples.length} 帧 · dt ${(clip.timestep??0).toFixed(3)} s`);setText('#playback-label','h3d · 肌肉机制实验');
  const markers=document.querySelector('#phase-markers');markers.replaceChildren();clip.phases.forEach((phase)=>{const button=document.createElement('button');button.textContent=phase.label;button.style.left=`${phase.start/clip.duration*100}%`;button.title=`跳至 ${phase.label}`;button.addEventListener('click',()=>{playing=false;time=phase.start;playButton.textContent='▶';updatePanel(clip,sampleAt(clip,time),performance.now()+100);});markers.append(button);});
  loading.classList.add('hidden');cameraCenter=[0,0,clip.rig.kind==='lower-body'?.86:1.0];cameraDistance=clip.rig.kind==='lower-body'?2.65:3.1;updatePanel(clip,sampleAt(clip,time),performance.now()+100);
}
function acceptMotionSet(value){
  if(value.schemaVersion==='h3d.motion-set.v1'&&Array.isArray(value.clips))clips=value.clips;else if(value.schemaVersion==='h3d.motion.v1')clips=[value];else throw new Error('不支持的动作 JSON 格式');
  if(!clips.length||clips.some((item)=>item.schemaVersion!=='h3d.motion.v1'||!Array.isArray(item.samples)||!item.samples.length))throw new Error('动作文件没有可播放的样本');
  setClip(0);
}
function setPlaying(value){if(!clip)return;if(value&&time>=clip.duration)time=0;playing=value;playButton.textContent=playing?'Ⅱ':'▶';playButton.setAttribute('aria-label',playing?'暂停动作':'播放动作');}
function tick(now){if(clip){if(playing&&lastFrame){time+=((now-lastFrame)/1000)*Number(document.querySelector('#speed').value);if(time>=clip.duration){if(loop)time%=clip.duration;else{time=clip.duration;setPlaying(false);}}}const frame=sampleAt(clip,time);renderScene(clip,frame);updatePanel(clip,frame,now);}lastFrame=now;requestAnimationFrame(tick);}
function setCamera(name){const presets={front:Math.PI/2,side:0,back:-Math.PI/2,threeQuarter:.72};yaw=presets[name]??yaw;pitch=.08;document.querySelectorAll('[data-camera]').forEach((button)=>button.setAttribute('aria-pressed',String(button.dataset.camera===name)));}
function fitView(){if(!clip)return;const all=[...Object.values(clip.rig.staticPositions),...Object.values(clip.samples[0].positions)];const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(const p of all)for(let i=0;i<3;i++){min[i]=Math.min(min[i],p[i]);max[i]=Math.max(max[i],p[i]);}cameraCenter=min.map((v,i)=>(v+max[i])/2);cameraCenter[2]=Math.max(.65,cameraCenter[2]);cameraDistance=Math.max(2.1,(max[2]-min[2])*2.1);}
const dialogContent={
  guide:['使用指南','<p>拖动画布旋转视角，滚轮缩放；正面、侧面、背面和 45° 按钮切换相机。右侧开关控制骨架、坐标轴、地面反力和肌腱路径。</p><p>时间轴可拖动到任意采样帧，也可点击阶段标记。播放速度只影响回放，不会改变物理仿真。</p><p><strong>Space</strong> 播放 / 暂停，<strong>R</strong> 回到动作开头。</p>'],
  model:['动力链与模型边界','<p>下肢模型包含浮动根部、骨盆、躯干、髋膝踝自由度、10 条肌腱路径和双足四点接触。肌肉输出经过力臂映射成关节力矩，MuJoCo 负责正向积分与地面接触。</p><p>当前躯干与下肢采用矢状面降阶刚体，双侧支撑点共享节段运动；肌肉参数和几何属于演示假设，未按个体标定。查看器人体表面为简化展示几何。</p><p>GRF 是接触约束求出的地面反力；人体不会通过查看器脚本反向驱动物理模型。</p>'],
  sources:['资料与许可','<p>MuJoCo WASM 官方绑定：<a href="https://mujoco.org/" target="_blank" rel="noreferrer">MuJoCo</a>。人体节段质量、肌腱路径和 Hill 型力学参数是本项目的研究原型假设。</p><p>前端使用原生 WebGL，只读取 <code>h3d.motion.v1</code> JSON；后端不导入任何 <code>web/</code> 代码。项目采用 Apache-2.0 许可。</p><p>完整参数、坐标系和限制见 <code>docs/physics-model.md</code>。</p>'],
};
try{
  renderer=createRenderer();
  document.querySelectorAll('[data-layer]').forEach((button)=>button.addEventListener('click',()=>{const key=button.dataset.layer;layerState[key]=!layerState[key];button.classList.toggle('on',layerState[key]);button.setAttribute('aria-checked',String(layerState[key]));}));
  document.querySelectorAll('[data-camera]').forEach((button)=>button.addEventListener('click',()=>setCamera(button.dataset.camera)));
  document.querySelector('#fit-view').addEventListener('click',fitView);
  document.querySelector('#play').addEventListener('click',()=>setPlaying(!playing));
  document.querySelector('#restart').addEventListener('click',()=>{time=0;setPlaying(false);});
  scrubber.addEventListener('input',()=>{if(!clip)return;setPlaying(false);time=Number(scrubber.value)*clip.duration;updatePanel(clip,sampleAt(clip,time),performance.now()+100);});
  document.querySelector('#speed').addEventListener('input',(event)=>setText('#speed-value',`${Number(event.target.value).toFixed(2).replace(/0$/,'')}×`));
  document.querySelector('#loop').addEventListener('click',(event)=>{loop=!loop;event.currentTarget.classList.toggle('on',loop);event.currentTarget.setAttribute('aria-checked',String(loop));});
  canvas.addEventListener('pointerdown',(event)=>{pointer={id:event.pointerId,x:event.clientX,y:event.clientY};canvas.setPointerCapture(event.pointerId);});
  canvas.addEventListener('pointermove',(event)=>{if(!pointer||pointer.id!==event.pointerId)return;yaw+=(event.clientX-pointer.x)*.008;pitch=Math.max(-.35,Math.min(.9,pitch+(event.clientY-pointer.y)*.006));pointer.x=event.clientX;pointer.y=event.clientY;});
  canvas.addEventListener('pointerup',()=>{pointer=null;});canvas.addEventListener('pointercancel',()=>{pointer=null;});
  canvas.addEventListener('wheel',(event)=>{event.preventDefault();cameraDistance=Math.max(1.6,Math.min(7,cameraDistance+event.deltaY*.003));},{passive:false});
  document.querySelector('#motion-file').addEventListener('change',async(event)=>{const[file]=event.target.files;if(!file)return;try{acceptMotionSet(JSON.parse(await file.text()));}catch(error){fail(error instanceof Error?error.message:String(error));}});
  const dialog=document.querySelector('#info-dialog');document.querySelectorAll('[data-dialog]').forEach((button)=>button.addEventListener('click',()=>{const[key]=[button.dataset.dialog];const[title,html]=dialogContent[key];setText('#dialog-title',title);document.querySelector('#dialog-content').innerHTML=html;dialog.showModal();}));
  document.querySelector('#dialog-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',(event)=>{if(event.target===dialog)dialog.close();});
  window.addEventListener('keydown',(event)=>{if(event.code==='Space'&&!(event.target instanceof HTMLInputElement)){event.preventDefault();setPlaying(!playing);}if(event.key.toLowerCase()==='r'){time=0;setPlaying(false);}});
  window.addEventListener('resize',resizeCanvas);requestAnimationFrame(tick);
  fetch('/demo-motion.json').then((response)=>{if(!response.ok)throw new Error(`动作数据请求失败 (${response.status})`);return response.json();}).then(acceptMotionSet).catch((error)=>fail(`${error.message}。先运行 npm run muscles 生成演示数据。`));
}catch(error){fail(error instanceof Error?error.message:String(error));}
