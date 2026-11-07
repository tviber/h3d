// Lossless container decompression for Blender's importer; no geometry/weight modification.
import { readFile, writeFile } from 'node:fs/promises';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
const [src,dst]=process.argv.slice(2);
if(!src||!dst||src===dst)throw new Error('Use distinct source and output GLB paths');
const raw=await readFile(src);let doc,bin;
for(let o=12;o<raw.length;){const size=raw.readUInt32LE(o),type=raw.readUInt32LE(o+4);if(type===0x4e4f534a)doc=JSON.parse(raw.subarray(o+8,o+8+size));if(type===0x004e4942)bin=raw.subarray(o+8,o+8+size);o+=8+size;}
await MeshoptDecoder.ready;
const pieces=[bin];let length=bin.length,decoded=0;
for(const view of doc.bufferViews){
  const e=view.extensions?.EXT_meshopt_compression;
  if(!e)continue;
  if(e.buffer!==0)throw new Error('Only embedded source buffer supported');
  const bytes=new Uint8Array(e.count*e.byteStride);
  MeshoptDecoder.decodeGltfBuffer(bytes,e.count,e.byteStride,bin.subarray(e.byteOffset??0,(e.byteOffset??0)+e.byteLength),e.mode,e.filter);
  const pad=(4-length%4)%4;if(pad){pieces.push(Buffer.alloc(pad));length+=pad;}
  view.buffer=0;view.byteOffset=length;view.byteLength=bytes.byteLength;
  pieces.push(Buffer.from(bytes));length+=bytes.byteLength;delete view.extensions.EXT_meshopt_compression;
  if(!Object.keys(view.extensions).length)delete view.extensions;
  decoded++;
}
doc.buffers=[{byteLength:length}];
for(const key of ['extensionsRequired','extensionsUsed'])if(doc[key])doc[key]=doc[key].filter(name=>name!=='EXT_meshopt_compression');
let json=Buffer.from(JSON.stringify(doc));const jsonPad=(4-json.length%4)%4;json=Buffer.concat([json,Buffer.alloc(jsonPad,32)]);
let data=Buffer.concat(pieces);data=Buffer.concat([data,Buffer.alloc((4-data.length%4)%4)]);
const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+data.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(data.length,0);binHeader.writeUInt32LE(0x004e4942,4);
await writeFile(dst,Buffer.concat([header,json,binHeader,data]));console.log(`Decoded ${decoded} views without changing accessor values`);
