// Read-only reproduction of the O×O push. No room, test suite or engine is edited.
// Optional: --output <directory> writes single-command UnitTesting fixtures.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {decodeVoxelRoom} from '../render/v1/voxel-world-v2.mjs';
import {instantiateMazeBenchEngineV1} from '../engine/current/engine.mjs';
import {ConnectedWorldSessionV1} from '../play/current/connected-world-session.mjs';
import {encodeCompactTest,decodeCompactTest} from '../apps/web/app/projectFormat.mjs';
import {simulateFrames,voxelRole,voxelMechanismId} from '../engine/tests/helpers/project-engine.mjs';

const input='U Rx3 D Rx9 Ux4 R U Lx7 D L U Rx4 Dx4 L Ux3 R U Lx4 D Lx2 Ux2 Rx5';
const names={U:'up',R:'right',D:'down',L:'left'};
const actions=input.split(' ').flatMap(token=>Array(Number(token.split('x')[1]??1)).fill(names[token[0]]));
const base=new URL('../level-data/v2/main-world/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('world.json',base)));
const columns=[...new Set(Object.values(manifest.rooms).map(p=>p[0]))].sort();
const rows=[...new Set(Object.values(manifest.rooms).map(p=>p[1]))].sort();
const rooms=await Promise.all(Object.entries(manifest.rooms).map(async([fileName,position])=>({
 ...decodeVoxelRoom(JSON.parse(await readFile(new URL(fileName,base)))),fileName,position,
 columnIndex:columns.indexOf(position[0]),rowIndex:rows.indexOf(position[1])
})));
const room=rooms.find(r=>r.position.join('x')==='OxO');
const definitions=new Map(manifest.blocks.map(b=>[b.id,b]));
const localBytes=await readFile(new URL('../engine/current/voxel_physics.wasm',import.meta.url));
const upstreamBytes=await readFile(new URL('../apps/web/public/physics/voxel_physics.wasm',import.meta.url));
const engine=await instantiateMazeBenchEngineV1(localBytes),upstream=await instantiateMazeBenchEngineV1(upstreamBytes);
const connected=new ConnectedWorldSessionV1(engine,definitions,rooms);
let state=engine.createState(room),other=upstream.createState(room),last;
for(const [i,action]of actions.entries()){
 const result=await connected.simulateCommand(state,room,action);
 const isolated=await upstream.simulateCommand(other,action,definitions);
 assert.deepEqual(result.frames,isolated.frames,`Connected/local vs isolated/upstream mismatch at move ${i+1}`);
 assert.deepEqual(result.final,isolated.final);
 last={before:state,...result};state=result.final;other=isolated.final;
}
const withoutRamps={...last.before,objects:last.before.objects.map(o=>o.blockId==='ice-slope'?{...o,blockId:'wall'}:o)};
const control=await engine.simulateCommand(withoutRamps,'right',definitions);
const addedSupport={...last.before,objects:[...last.before.objects,{blockId:'wall',x:10,y:5,z:0}]};
const supported=await engine.simulateCommand(addedSupport,'right',definitions);
const sample=state=>state.objects.find(o=>o.blockId==='weightless-box'&&o.groupId===0);
const position=o=>[o.x,o.y,o.z];
const before=sample(last.before);
const displacement=state=>position(sample(state)).map((n,i)=>n-position(before)[i]);
// The rule is an ordinary one-cell push, not a frame copied from the engine.
// Both interlocked bodies and the player translate; all other state is fixed.
const expectedState={...last.before,objects:last.before.objects.map(o=>
 o.blockId==='player'||(o.blockId==='weightless-box'&&[0,1].includes(o.groupId))
  ? {...o,x:o.x+1}:o)};
assert.equal(last.frames.length,1,'The fifth Right must finish after one push tick');
assert.deepEqual(last.final,expectedState,'Only the player and two bodies should move one tile right');

// UnitTesting stores the engine's voxel Z directly, unlike Benchmarking's
// surface-relative actor Z. Verify every serialized role/coordinate/ID matches.
function unitFrame(state){
 const {buffer}=engine.writeState(state,definitions);
 const frame={voxels:state.objects.map((o,i)=>({
  ...o,blockId:o.blockId==='weightless-box'?'weightless-pushbox-1826':o.blockId,
  z:buffer[i*5+2],...(o.blockId==='orange-wall'?{stateId:1,mechanismDepth:buffer[i*5+4]}:{}),
  ...(o.blockId==='orange-button'?{stateId:0}:{})
 }))};
 for(const [i,o]of frame.voxels.entries())assert.deepEqual(
  [o.x,o.y,o.z,voxelRole(o)|0,voxelMechanismId(o)],Array.from(buffer.slice(i*5,i*5+5)),`UnitTesting adapter mismatch at voxel ${i}`);
 return frame;
}
const start=unitFrame(last.before),expected=unitFrame(expectedState);
const fixture={id:'oxo-interlocked-push-remote-slopes',name:'O×O — fifth Right must stop after one tile',
 description:`Exact room ${room.fileName} immediately before move ${actions.length}. Setup: ${input}. The player and both blue bodies move exactly one tile right without falling; all other objects stay unchanged. Distant ramps must not create momentum.`,
 folderId:'3d-boxes',tagIds:['3d-boxes-default'],locked:false,input:'right',world:{width:room.width,height:room.height,floorLayer:0},start,intermediate:[],expected};
const compact=encodeCompactTest(fixture),decoded=decodeCompactTest(compact);
const sort=voxels=>voxels.map(o=>[o.x,o.y,o.z,voxelRole(o)|0,voxelMechanismId(o)].join(',')).sort();
const unitFrames=simulateFrames(decoded.start.voxels,1,fixture.world);
assert.equal(unitFrames.length,last.frames.length);
for(const [i,frame]of unitFrames.entries())assert.deepEqual(sort(frame),sort(unitFrame(last.frames[i]).voxels),`UnitTesting fixture tick ${i+1}`);
const controlFixture={...fixture,id:'oxo-interlocked-push-no-slopes',name:'O×O control — distant slopes replaced by walls',description:'Same pre-push state, changing only the three distant ramps into solid walls. One Right correctly stops after one tile.',start:unitFrame(withoutRamps),expected:unitFrame(control.final)};
assert.equal(control.frames.length,1);assert.deepEqual(displacement(control.final),[1,0,0]);
assert.equal(supported.frames.length,1);assert.deepEqual(displacement(supported.final),[1,0,0]);
const report={room:'OxO',file:room.fileName,input,move:actions.length,wasmMatches:localBytes.equals(upstreamBytes),wasmSha256:createHash('sha256').update(localBytes).digest('hex'),
 allCommandsMatchIsolatedUpstream:true,unitTestingAdapterAndFixtureMatch:true,independentOneTileExpectationMatches:true,
 ramps:room.objects.filter(o=>o.blockId==='ice-slope').map(position),
 observed:{ticks:last.frames.length,bodyDisplacement:displacement(last.final),frames:last.frames.map((frame,i)=>({tick:i+1,body:position(sample(frame)),player:position(frame.objects.find(o=>o.blockId==='player'))}))},
 control:{ticks:control.frames.length,bodyDisplacement:displacement(control.final)},
 addedSupportControl:{support:[10,5,0],ticks:supported.frames.length,bodyDisplacement:displacement(supported.final)}};
const flag=process.argv.indexOf('--output');
if(flag>=0){
 if(!process.argv[flag+1])throw new Error('--output requires a directory');
 const dir=resolve(process.argv[flag+1]);await mkdir(dir,{recursive:true});
 for(const [name,value]of [['before-fifth-right.unit-test.json',compact],['no-ramps-control.unit-test.json',encodeCompactTest(controlFixture)],['report.json',report]])await writeFile(join(dir,name),JSON.stringify(value,null,2)+'\n');
 console.log(`Fixtures saved to ${dir}`);
}
console.log(JSON.stringify(report,null,2));
