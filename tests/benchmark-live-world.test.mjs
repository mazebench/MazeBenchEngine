import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {BenchmarkGameRuntime} from '../benchmarking/v1/runtime.mjs';
import {VisionRuntime} from '../benchmarking/vision/runtime.mjs';
import {createRunIntegrity,verifyRunIntegrity,verifyCheckpoint} from '../benchmarking/v1/integrity.mjs';
import {readCheckpointJson} from '../benchmarking/v1/checkpoint-json.mjs';
import {LIVE_WORLD_POLICY,publishEditorRoom,publishRoomRevision,readLiveWorld} from '../benchmarking/storage/live-world.mjs';
import {V2_BLOCK_CATALOG,V2_WORLD_FORMAT,encodeVoxelRoom} from '../render/v1/voxel-world-v2.mjs';
import {digest,providerRuntimeHashes} from '../benchmarking/providers/claude-policy.mjs';
import {enablePersistentGems,persistentGemHashes} from '../scripts/enable-persistent-gems-v1.mjs';
const original=path.resolve(import.meta.dirname,'..');
const floor=()=>Array.from({length:256},(_,i)=>({x:i%16,y:Math.floor(i/16),z:0,blockId:'floor'}));
const room=(extras=[])=>({width:16,height:16,objects:[...floor(),...extras]});
const source=value=>JSON.stringify(encodeVoxelRoom(value))+'\n';
const player=r=>r.internal.state.objects.find(o=>o.blockId==='player');
const hasWall=(r,x,y)=>r.internal.state.objects.some(o=>o.blockId==='wall'&&o.x===x&&o.y===y);
async function fixture(Runtime=BenchmarkGameRuntime,live=true,runtimeFixture=null){
 const root=await mkdtemp('/tmp/maze-live-world-test-');
 for(const name of ['benchmarking','engine/v1','play/v1','render','render-ascii/v1'])await cp(path.join(original,name),path.join(root,name),{recursive:true});
 if(runtimeFixture)await cp(runtimeFixture,path.join(root,'benchmarking/v1/runtime.mjs'));
 const level=path.join(root,'level-data/v2/main-world');await mkdir(level,{recursive:true});
 const a=room([{x:1,y:15,z:0,blockId:'player'}]),b=room([{x:1,y:15,z:0,blockId:'player'},{x:1,y:1,z:0,blockId:'gem'}]);
 await writeFile(path.join(level,'world.json'),JSON.stringify({storageFormat:V2_WORLD_FORMAT,rooms:{'a.json':['H','I'],'b.json':['H','J']},blocks:V2_BLOCK_CATALOG}));
 for(const[file,value]of [['a.json',a],['b.json',b]])await writeFile(path.join(level,file),source(value));
 const records=path.join(root,'runs'),directory=path.join(records,'run-live-test');await mkdir(directory,{recursive:true});
 const configuration={...(live?{world_updates:LIVE_WORLD_POLICY}:{}),storage_format:'incremental-v1'};
 const integrity=await createRunIntegrity(root,directory,configuration);
 const runtime=await Runtime.create(root,directory,{incremental:true,actionLimit:null});
 const edit=async(file,value)=>{await writeFile(path.join(level,file),source(value));return publishEditorRoom(root,[records],file,source(value));};
 return{root,level,directory,runtime,integrity,a,b,edit};
}

test('editor changes reach unvisited rooms and preserve the active board, history, reset and undo',async()=>{
 const f=await fixture();try{
  const before=structuredClone(f.runtime.internal),edited=room([...f.a.objects.filter(o=>o.blockId==='player'),{x:3,y:3,z:0,blockId:'wall'}]);
  await f.edit('a.json',edited);assert.deepEqual(f.runtime.internal,before);await verifyRunIntegrity(f.root,f.directory,f.integrity);
  await f.runtime.apply('right');assert(!hasWall(f.runtime,3,3));await f.runtime.apply('undo');assert.deepEqual(player(f.runtime),player({internal:before}));
  await f.runtime.apply('reset');assert(!hasWall(f.runtime,3,3));
  const changedB=room([{x:1,y:15,z:0,blockId:'player'},{x:5,y:5,z:0,blockId:'wall'}]);await f.edit('b.json',changedB);
  await f.runtime.apply('down');assert.equal(f.runtime.internal.roomFile,'b.json');assert(hasWall(f.runtime,5,5));assert.equal(f.runtime.internal.gemsCollected.length,0,'deleting an unvisited gem does not award it');
  const oldSnapshot=await f.runtime.readRecord('move_history/move_4.txt');
  await f.runtime.apply('up');assert.equal(f.runtime.internal.roomFile,'a.json');assert(hasWall(f.runtime,3,3));
  await f.runtime.apply('undo');assert.equal(f.runtime.internal.roomFile,'b.json');assert(hasWall(f.runtime,5,5));
  await f.runtime.apply('undo');assert.equal(f.runtime.internal.roomFile,'a.json');assert(!hasWall(f.runtime,3,3),'undo restores the old authored version');
  await f.runtime.apply('room HxJ');assert.equal(f.runtime.internal.roomFile,'b.json');assert(hasWall(f.runtime,5,5),'room jumps use the authored board');
  assert.deepEqual(await f.runtime.readRecord('move_history/move_4.txt'),oldSnapshot);
  const reopened=await BenchmarkGameRuntime.open(f.root,f.directory);assert.deepEqual(reopened.internal,f.runtime.internal);assert.deepEqual(reopened.summary(),await readCheckpointJson(f.directory,'summary.json'));verifyCheckpoint(f.directory);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

for (const Runtime of [BenchmarkGameRuntime, VisionRuntime]) for (const live of [false, true]) {
 test(`${Runtime.name}: collected gems stay absent on re-entry, room jumps, undo, reset and reopen (live=${live})`,async()=>{
  const f=await fixture(Runtime,live);try{
   await f.runtime.apply('down');
   const historical=await f.runtime.readRecord('move_history/move_1/index.json');
   assert(f.runtime.internal.state.objects.some(o=>o.blockId==='gem'));
   await f.runtime.apply('down');
   const assertCollected=runtime=>{
    assert.equal(runtime.internal.gemsCollected.length,1);
    assert(!runtime.internal.state.objects.some(o=>o.blockId==='gem'),'credited gem must not return to the board');
   };
   assertCollected(f.runtime);
   await f.runtime.apply('undo');assertCollected(f.runtime);
   await f.runtime.apply('reset');assertCollected(f.runtime);
   await f.runtime.apply('up');assert.equal(f.runtime.internal.roomFile,'a.json');
   // Capture all crossing frames: a display-only fix after physics is insufficient.
   const persist=f.runtime.persist.bind(f.runtime);let crossingFrames;
   f.runtime.persist=options=>{crossingFrames=structuredClone(options.animationFrames);return persist(options);};
   await f.runtime.apply('down');assert.equal(f.runtime.internal.roomFile,'b.json');assertCollected(f.runtime);
   assert(crossingFrames.filter(frame=>frame.room.fileName==='b.json').every(frame=>!frame.state.objects.some(o=>o.blockId==='gem')));
   await f.runtime.apply('room HxI');await f.runtime.apply('room HxJ');assertCollected(f.runtime);
   await f.runtime.apply('room HxJ');assertCollected(f.runtime);
   const reopened=await Runtime.open(f.root,f.directory);assertCollected(reopened);
   await reopened.apply('reset');assertCollected(reopened);
   assert.deepEqual(await reopened.readRecord('move_history/move_1/index.json'),historical,'past observations remain immutable');
   assert.deepEqual(await readCheckpointJson(f.directory),reopened.internal);verifyCheckpoint(f.directory);
  }finally{await rm(f.root,{recursive:true,force:true});}
 });
}

for(const drift of [false,true]) test(`persistent-gem operator upgrade ${drift?'rejects unrelated drift':'preserves the authenticated checkpoint and session'}`,async()=>{
 // This historical migration admits one audited runtime pair. Later behavior
 // changes must not silently expand its allowlist or reseal existing runs.
 const f=await fixture(BenchmarkGameRuntime,true,new URL('./fixtures/persistent-gems-runtime.mjs.txt',import.meta.url));try{
  await f.runtime.applySequence(['down','down']);
  const executable=path.join(f.root,'fixture-claude'),prompt='Fixture prompt';
  await writeFile(executable,'fixture executable');await writeFile(path.join(f.directory,'prompt.md'),prompt);
  const manifest=JSON.parse(await readFile(path.join(f.directory,'integrity.json'),'utf8'));
  const metadata={id:'run-live-test',status:'paused',provider:'claude-code',model:'claude-opus-5-5',effort:'max',tools_enabled:false,action_limit:null,start_room:'HxI',effective_prompt_sha256:digest(prompt),storage_format:'incremental-v1',world_updates:LIVE_WORLD_POLICY,claude_session_id:'preserved-session'};
  Object.assign(manifest.configuration,metadata,{claude_policy:'claude-mcp-only-v1',claude_version:'2.1.280',claude_executable:executable,claude_sha256:digest('fixture executable'),provider_runtime:await providerRuntimeHashes(f.root)});
  manifest.files['benchmarking/v1/runtime.mjs']=persistentGemHashes.before;
  if(drift)manifest.files['engine/v1/adapter.mjs']='0'.repeat(64);
  const originalManifest=JSON.stringify(manifest)+'\n';metadata.integrity={...f.integrity,manifest_sha256:digest(originalManifest)};
  const originalRun=JSON.stringify(metadata)+'\n';
  await writeFile(path.join(f.directory,'integrity.json'),originalManifest);await writeFile(path.join(f.directory,'run.json'),originalRun);
  const checkpoint=await readFile(path.join(f.directory,'checkpoint.json')),state=await readCheckpointJson(f.directory);
  let checks=0;
  const upgrade=()=>enablePersistentGems(f.root,f.directory,{backupDirectory:path.join(f.root,'operator-backup'),assertInactive:async()=>{checks++;}});
  if(drift){
   await assert.rejects(upgrade,/Benchmark runtime changed/);
   assert.equal(await readFile(path.join(f.directory,'integrity.json'),'utf8'),originalManifest);
   assert.equal(await readFile(path.join(f.directory,'run.json'),'utf8'),originalRun);
  }else{
   const result=await upgrade();assert.equal(result.game_unchanged,true);assert.equal(checks,2);
   const updated=JSON.parse(await readFile(path.join(f.directory,'run.json'),'utf8'));
   const {integrity,runtime_repairs,...settings}=updated;const {integrity:oldIntegrity,...oldSettings}=metadata;
   assert.deepEqual(settings,oldSettings);assert.equal(runtime_repairs.length,1);
   assert.equal(await readFile(path.join(f.root,'operator-backup/integrity.json'),'utf8'),originalManifest);
   await verifyRunIntegrity(f.root,f.directory,integrity);
  }
  assert.deepEqual(await readFile(path.join(f.directory,'checkpoint.json')),checkpoint);
  assert.deepEqual(await readCheckpointJson(f.directory),state);verifyCheckpoint(f.directory);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('moving or removing a collected gem never awards a duplicate or changes the current board',async()=>{
 const f=await fixture();try{
  await f.runtime.applySequence(['down','down']);assert.equal(f.runtime.internal.gemsCollected.length,1);
  const b=room([{x:2,y:0,z:0,blockId:'gem'}]);await f.edit('b.json',b);
  await f.runtime.apply('up');assert.equal(f.runtime.internal.gemsCollected.length,1);await f.runtime.apply('up');
  await f.runtime.apply('down');assert.equal(f.runtime.internal.roomFile,'b.json');assert.equal(f.runtime.internal.gemsCollected.length,1);assert(!f.runtime.internal.state.objects.some(o=>o.blockId==='gem'),'moved collected gem stays gone');await f.runtime.apply('right');assert.equal(f.runtime.internal.gemsCollected.length,1,'moved gem has the original identity');
  await f.edit('b.json',room());await f.edit('b.json',b);
  await f.runtime.applySequence(['up','down','left','right']);assert.equal(f.runtime.internal.gemsCollected.length,1,'remove/re-add cannot mint the same gem again');assert(!f.runtime.internal.state.objects.some(o=>o.blockId==='gem'));
  await f.edit('b.json',room([{x:1,y:15,z:0,blockId:'player'},{x:2,y:0,z:0,blockId:'gem'},{x:7,y:7,z:0,blockId:'gem'}]));
  await f.runtime.apply('room HxJ');assert.deepEqual(f.runtime.internal.state.objects.filter(o=>o.blockId==='gem').map(o=>[o.x,o.y]),[[7,7]],'new uncollected gems remain present');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('an edit between moves of a batch is adopted at the next crossing without interrupting the batch',async()=>{
 const f=await fixture();try{
  const apply=f.runtime.apply.bind(f.runtime);let n=0;
  f.runtime.apply=async action=>{const result=await apply(action);if(++n===1)await f.edit('b.json',room([{x:4,y:4,z:0,blockId:'wall'}]));return result;};
  const result=await f.runtime.applySequence(['right','down']);assert.equal(result.completed_count,2);assert.equal(f.runtime.internal.roomFile,'b.json');assert(hasWall(f.runtime,4,4));await verifyRunIntegrity(f.root,f.directory,f.integrity);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('vision observations and historical animation sources survive live room edits',async()=>{
 const f=await fixture(VisionRuntime);try{
  await f.runtime.apply('down');const action=f.runtime.internal.actions.at(-1),framePath=action.visionFrames.at(-1).record;
  const oldFrame=await f.runtime.readRecord(framePath),oldIndex=await f.runtime.readRecord(action.animation.index_record);
  await f.edit('b.json',room([{x:4,y:4,z:0,blockId:'wall'}]));await f.runtime.applySequence(['up','down']);
  assert(hasWall(f.runtime,4,4));assert.match((await f.runtime.renderObservation()).operator_notice,/updated this room/);
  assert.deepEqual(await f.runtime.readRecord(framePath),oldFrame);assert.deepEqual(await f.runtime.readRecord(action.animation.index_record),oldIndex);
  const reopened=await VisionRuntime.open(f.root,f.directory);assert.deepEqual(await reopened.readRecord(framePath),oldFrame);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('room approvals reject tampering, other assets stay frozen, and raw file edits cannot reach the agent',async()=>{
 const f=await fixture();try{
  await writeFile(path.join(f.level,'b.json'),source(room([{x:8,y:8,z:0,blockId:'wall'}])));
  await verifyRunIntegrity(f.root,f.directory,f.integrity);await f.runtime.apply('down');assert(!hasWall(f.runtime,8,8),'unpublished disk edit is not an operator approval');
  const manifest=JSON.parse(await readFile(path.join(f.directory,'integrity.json'))),world=readLiveWorld(f.directory,manifest.configuration.world_base_sha256);
  const head=path.join(f.directory,'world-updates/head.json'),headBytes=await readFile(head);await writeFile(head,JSON.stringify({...world.head,revision:100}));await assert.rejects(()=>verifyRunIntegrity(f.root,f.directory,f.integrity),/signature/);await writeFile(head,headBytes);
  const blob=path.join(f.directory,'world-updates/rooms',world.head.rooms['a.json'].sha256+'.json'),blobBytes=await readFile(blob);await writeFile(blob,source(room()));await assert.rejects(()=>BenchmarkGameRuntime.open(f.root,f.directory),/snapshot changed/);await writeFile(blob,blobBytes);
  const asset=path.join(f.root,'benchmarking/v1/mcp-server.mjs');await writeFile(asset,(await readFile(asset,'utf8'))+'\n// changed');await assert.rejects(()=>verifyRunIntegrity(f.root,f.directory,f.integrity),/runtime changed/);
  await assert.rejects(()=>publishRoomRevision(f.directory,'../engine.json',source(room()),V2_BLOCK_CATALOG),/filename/);
  await assert.rejects(()=>f.runtime.readRecord('world-updates/head.json'),/Unknown benchmark record/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('the running MCP accepts editor changes without an integrity failure or extra capabilities',async()=>{
 const f=await fixture();let child;
 try{
  const{spawn}=await import('node:child_process'),{createInterface}=await import('node:readline');
  await writeFile(path.join(f.directory,'run.json'),JSON.stringify({world_updates:LIVE_WORLD_POLICY,storage_format:'incremental-v1',integrity:f.integrity}));
  // This fixture's tool condition is frozen before starting its MCP process.
  const manifestFile=path.join(f.directory,'integrity.json');const manifest=JSON.parse(await readFile(manifestFile));manifest.configuration.tools_enabled=false;
  const bytes=JSON.stringify(manifest)+'\n',{createHash}=await import('node:crypto');const integrity={...f.integrity,manifest_sha256:createHash('sha256').update(bytes).digest('hex')};
  await writeFile(manifestFile,bytes);await writeFile(path.join(f.directory,'run.json'),JSON.stringify({world_updates:LIVE_WORLD_POLICY,storage_format:'incremental-v1',tools_enabled:false,integrity}));
  child=spawn(process.execPath,[path.join(f.root,'benchmarking/v1/mcp-server.mjs')],{env:{...process.env,MAZEBENCH_PROJECT_ROOT:f.root,MAZEBENCH_RUN_DIRECTORY:f.directory,MAZEBENCH_PYTHON_ENABLED:'0',MAZEBENCH_CAPABILITY_POLICY:'os-isolated-v4'},stdio:['pipe','pipe','pipe']});
  const pending=new Map();let id=0,stderr='';child.stderr.on('data',b=>stderr+=b);const lines=createInterface({input:child.stdout});lines.on('line',line=>{const value=JSON.parse(line);pending.get(value.id)?.(value);pending.delete(value.id);});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>reject(Error(stderr||'MCP timed out')),10000);pending.set(key,value=>{clearTimeout(timer);resolve(value);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');});
  const tools=(await call('tools/list')).result.tools.map(t=>t.name);assert.deepEqual(tools,['maze_observe','maze_action','maze_sequence']);
  await f.edit('b.json',room([{x:5,y:5,z:0,blockId:'wall'}]));
  const moved=await call('tools/call',{name:'maze_action',arguments:{action:'down'}});assert.equal(moved.result.isError,false);assert.equal(moved.result.structuredContent.observation.room,'HxJ');assert.match(moved.result.structuredContent.observation.operator_notice,/updated/);
  const state=await readCheckpointJson(f.directory);assert(state.state.objects.some(o=>o.blockId==='wall'&&o.x===5&&o.y===5));
  const observed=await call('tools/call',{name:'maze_observe',arguments:{record:'move_history/move_1/index.json'}});assert.equal(observed.result.isError,false);
 }finally{if(child){child.kill('SIGTERM');await new Promise(resolve=>child.once('close',resolve));}await rm(f.root,{recursive:true,force:true});}
});

test('migration preserves a paused checkpoint byte-for-byte and the next move saves new summary fields',async()=>{
 const f=await fixture(BenchmarkGameRuntime,false);try{
  const{enableLiveWorldUpdates}=await import('../scripts/enable-live-world-updates.mjs');
  await f.runtime.apply('right');const before=structuredClone(f.runtime.internal),checkpoint=await readFile(path.join(f.directory,'checkpoint.json'));
  await writeFile(path.join(f.directory,'run.json'),JSON.stringify({id:'run-live-test',status:'paused',storage_format:'incremental-v1',integrity:f.integrity}));
  const result=await enableLiveWorldUpdates(f.root,f.directory,{plan:{files:{}},backupDirectory:path.join(f.directory,'repair-backup')});assert.equal(result.game_unchanged,true);assert((await readFile(path.join(f.directory,'checkpoint.json'))).equals(checkpoint));assert.deepEqual(await readCheckpointJson(f.directory),before);
  const reopened=await BenchmarkGameRuntime.open(f.root,f.directory);await reopened.apply('left');assert.deepEqual(await readCheckpointJson(f.directory,'summary.json'),reopened.summary());
  await f.edit('b.json',room([{x:7,y:7,z:0,blockId:'wall'}]));await reopened.apply('down');assert(hasWall(reopened,7,7));
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('simultaneous publications serialize and an uncommitted future revision can be replaced',async()=>{
 const f=await fixture();try{
  await writeFile(path.join(f.directory,'world-updates/revisions/1.json'),'orphaned publication');
  await Promise.all([1,2,3].map(x=>publishRoomRevision(f.directory,'b.json',source(room([{x,y:7,z:0,blockId:'wall'}])),V2_BLOCK_CATALOG)));
  const manifest=JSON.parse(await readFile(path.join(f.directory,'integrity.json')));const {head}=readLiveWorld(f.directory,manifest.configuration.world_base_sha256);assert.equal(head.revision,3);
  await verifyRunIntegrity(f.root,f.directory,f.integrity);await f.runtime.apply('down');assert(f.runtime.internal.state.objects.some(o=>o.blockId==='wall'&&o.y===7));
 }finally{await rm(f.root,{recursive:true,force:true});}
});

for (const Runtime of [BenchmarkGameRuntime, VisionRuntime]) {
 test(`${Runtime.name}: room commands use the authored start after boundary entry, including the current room`,async()=>{
  const f=await fixture(Runtime);try{
   await f.runtime.apply('down');assert.deepEqual([player(f.runtime).x,player(f.runtime).y],[1,0]);
   await f.runtime.apply('room HxI');
   await f.runtime.apply('room HxJ');assert.deepEqual([player(f.runtime).x,player(f.runtime).y],[1,15]);
   await f.runtime.apply('left');assert.deepEqual([player(f.runtime).x,player(f.runtime).y],[0,15]);
   await f.runtime.apply('room HxJ');assert.deepEqual([player(f.runtime).x,player(f.runtime).y],[1,15]);
   await f.runtime.apply('undo');assert.deepEqual([player(f.runtime).x,player(f.runtime).y],[0,15]);
   await f.runtime.apply('reset');assert.deepEqual([player(f.runtime).x,player(f.runtime).y],[1,15]);
   const reopened=await Runtime.open(f.root,f.directory);assert.deepEqual(reopened.internal,f.runtime.internal);verifyCheckpoint(f.directory);
  }finally{await rm(f.root,{recursive:true,force:true});}
 });
}

test('room commands adopt published authored starts while undo preserves the earlier visit and replay',async()=>{
 const f=await fixture();try{
  await f.runtime.applySequence(['down','up']);
  const historical=await f.runtime.readRecord('move_history/move_1.txt');
  await f.edit('b.json',room([{x:8,y:2,z:0,blockId:'player'},{x:5,y:5,z:0,blockId:'wall'},{x:1,y:1,z:0,blockId:'gem'}]));
  await f.runtime.apply('room HxJ');assert.deepEqual([player(f.runtime).x,player(f.runtime).y],[8,2]);assert(hasWall(f.runtime,5,5));
  assert.equal(f.runtime.internal.gemsCollected.length,0);assert.match((await f.runtime.renderObservation()).operator_notice,/updated this room/);
  const earlier=structuredClone(f.runtime.internal.state),revision=f.runtime.internal.roomRevision;
  await f.edit('b.json',room([{x:9,y:3,z:0,blockId:'player'}]));assert.deepEqual(f.runtime.internal.state,earlier);
  await f.runtime.apply('room HxJ');assert.deepEqual([player(f.runtime).x,player(f.runtime).y],[9,3]);
  await f.runtime.apply('undo');assert.deepEqual(f.runtime.internal.state,earlier);assert.equal(f.runtime.internal.roomRevision,revision);
  await f.runtime.apply('left');await f.runtime.apply('reset');assert.deepEqual(f.runtime.internal.state,earlier);
  assert.deepEqual(await f.runtime.readRecord('move_history/move_1.txt'),historical);verifyCheckpoint(f.directory);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('room commands reject unvisited rooms and missing authored starts without inventing a spawn',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.runtime.apply('room HxJ'),/has not been visited/);
  await f.runtime.applySequence(['down','up']);
  await f.edit('b.json',room());const before=structuredClone(f.runtime.internal);
  await assert.rejects(f.runtime.apply('room HxJ'),/no authored player start/);
  assert.deepEqual(f.runtime.internal,before);verifyCheckpoint(f.directory);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
