import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { instantiateMazeBenchEngineV1 } from '../engine/v1/engine.mjs';
import { SolutionsModel, worldFingerprint } from '../solutions/v1/model.mjs';
import { searchRoute } from '../solutions/v1/search.mjs';
import { planRoute } from '../solutions/v1/route-search.mjs';
import { createNativeRoomSearch } from '../solutions/v1/native-search.mjs';
import { compileFullSolution, setupCommands } from '../solutions/v1/full-solution.mjs';
import { playSolutionFrames } from '../solutions/v1/animation.mjs';
import { DEFAULT_PLAY_FRAME_DELAY_MS } from '../play/v1/play-session.mjs';
const blocks=[{id:'floor',roleId:'floor',visual:{kind:'floor'}},{id:'wall',roleId:'solid',visual:{kind:'cube'}},{id:'player',roleId:'player',visual:{kind:'cube'}},{id:'gem',roleId:'goal',visual:{kind:'model'}},{id:'block',roleId:'movable',visual:{kind:'cube'}},{id:'ice',roleId:'ice',visual:{kind:'floor'}}];
function room(fileName,position,columnIndex,objects=[]){return {fileName,position,columnIndex,rowIndex:0,width:4,height:3,objects:[...Array.from({length:12},(_,i)=>({blockId:'floor',x:i%4,y:Math.floor(i/4),z:0})),{blockId:'player',x:1,y:1,z:0},...objects]};}
function world(){return {rooms:[room('a.json',['H','I'],0,[{blockId:'gem',x:2,y:1,z:0}]),room('b.json',['I','I'],1,[{blockId:'gem',x:2,y:1,z:0}])],blocks,columns:['H','I'],rows:['I'],roomWidth:4,roomHeight:3};}
async function create(w=world(),startRoom=null){const engine=await instantiateMazeBenchEngineV1(await readFile(new URL('../engine/v1/voxel_physics.wasm',import.meta.url)));return new SolutionsModel(engine,w,await worldFingerprint(w),startRoom);}
async function nativeEngine(){return instantiateMazeBenchEngineV1(await readFile(new URL('../solutions/v1/solutions-solver.wasm',import.meta.url)));}

test('a different authored starting room stays the root through save, import, clear, and full solution',async()=>{
 const m=await create(world(),'b.json');
 assert.equal(m.snapshot().startRoom,'b.json');assert.deepEqual(m.snapshot().visitedRooms,['b.json']);
 assert.equal(m.snapshot().room,'b.json');assert.equal(m.snapshot().spots.find(s=>s.id==='start:b.json').accessible,true);
 await m.move('right');assert.equal(m.snapshot().collectedGems.length,1);
 const saved=m.save(),restored=await create(world(),'b.json');await restored.restore(saved);
 assert.deepEqual(restored.save(),saved);
 assert.equal((await compileFullSolution(restored)).start,'IxI');
 const imported=await create(world(),'b.json');await imported.importJSON(JSON.stringify(m.export()));
 assert.deepEqual(imported.snapshot().visitedRooms,['b.json']);
 assert.equal(imported.snapshot().collectedGems.length,1);
 assert.match(imported.clearRuns().message,/I×I/);assert.equal(imported.snapshot().startRoom,'b.json');
 assert.deepEqual(imported.snapshot().visitedRooms,['b.json']);
 const usual=await create();await assert.rejects(usual.restore(saved),/another room/);
 await assert.rejects(usual.importJSON(JSON.stringify(m.export())),/another room/);
 const legacy=usual.save();delete legacy.startRoom;await usual.restore(legacy);
});

test('Solutions animates every Ice tick across rooms without retaining traces in saved history',async()=>{
 const w=world();w.rooms.push(room('c.json',['J','I'],2));
 for(const r of w.rooms){r.objects=r.objects.filter(o=>o.blockId!=='gem');for(const o of r.objects)if(o.blockId==='floor'&&o.y===1)o.blockId='ice';}
 w.rooms[2].objects.push({blockId:'wall',x:3,y:1,z:0});
 for(const route of [false,true]){
  const m=await create(w),before=m.save(),frames=[];
  m.physics.collected=new Set();
  const simulation=await m.physics.simulateCommand(m.current.state,m.root,'right');
  if(route)await m.applyRoute(['right'],'A* route',frame=>frames.push(frame));
  else await m.move('right',frame=>frames.push(frame));
  assert(frames.length>3,'one direction must show intermediate sliding ticks');
  assert.deepEqual(frames.map(({room,state})=>({room,state})),simulation.animationFrames.map(({room,state})=>({room:room.fileName,state})));
  assert.deepEqual([...new Set(frames.map(f=>f.room))],['a.json','b.json','c.json']);
  assert.deepEqual(frames.at(-1).state,m.current.state);
  assert(m.routeTrace.steps.every(step=>!('frames' in step)&&!('animationFrames' in step)));
  assert(!JSON.stringify(m.save()).includes('animationFrames'));
  await m.undo();assert.deepEqual(m.save(),before);
 }
});

test('route animation labels ticks by command and blocked moves produce no playback',async()=>{
 const m=await create(),frames=[];
 await m.applyRoute(['right','right','right'],'Location route',frame=>frames.push(frame));
 assert.deepEqual([...new Set(frames.map(f=>f.command))],[1,2,3]);
 assert.equal(frames.at(-1).room,'b.json');
 m.resume('start:a.json');await m.move('up');const before=m.save(),blocked=[];
 await m.move('up',frame=>blocked.push(frame));assert.deepEqual(blocked,[]);assert.deepEqual(m.save(),before);
});

test('Solutions playback uses Play’s 20 ms per tick and can skip the remaining animation',async()=>{
 const frames=[{tick:1},{tick:2},{tick:3}],events=[];
 assert.equal(DEFAULT_PLAY_FRAME_DELAY_MS,20);
 assert.equal(await playSolutionFrames(frames,frame=>events.push(frame.tick),{delay:async ms=>events.push(`wait ${ms}`)}),true);
 assert.deepEqual(events,[1,'wait 20',2,'wait 20',3,'wait 20']);
 let stopped=false;const shown=[];
 assert.equal(await playSolutionFrames(frames,frame=>shown.push(frame.tick),{cancelled:()=>stopped,delay:async()=>{stopped=true;}}),false);
 assert.deepEqual(shown,[1]);
});

test('legacy local branches do not unlock rooms before a physical visit',async()=>{
 const m=await create();assert.equal(m.snapshot().room,'a.json');assert.equal(m.spots.size,2);assert.deepEqual(m.snapshot().verifiedRooms,['a.json']);
 m.restoreSpot('start:b.json');await m.applyRoute(['right'],'Local gem');assert.equal(m.snapshot().verifiedGems.length,0);assert.equal(m.routes[0].proven,false);assert.equal(m.snapshot().verifiedRooms.length,1);
});
test('gem and room routes are replayable; distinct entrance states are preserved',async()=>{
 const m=await create();await m.move('right');assert.equal(m.routes.length,1);assert.equal(m.snapshot().verifiedGems.length,1);
 await m.move('right');assert.equal(m.pending.length,1);await m.move('right');assert.equal(m.snapshot().room,'b.json');assert.equal(m.snapshot().verifiedRooms.length,2);
 const entrance=[...m.spots.values()].find(s=>s.kind==='entrance');assert.deepEqual(m.position(entrance.state),{x:0,y:1,z:0});assert.deepEqual(entrance.entry,{x:0,y:1,z:0});
 assert.deepEqual(entrance.path,['right','right','right']);m.restoreSpot('start:a.json');await m.applyRoute(['up','right','right','right']);
 const spots=[...m.spots.values()].filter(s=>s.kind==='entrance'&&s.room==='b.json');assert.equal(spots.length,2);assert.notEqual(m.position(spots[0].state).y,m.position(spots[1].state).y);
 const saved=m.save(),restored=await create();await restored.restore(saved);assert.deepEqual(restored.save(),saved);assert.deepEqual(restored.export().roomProofs,m.export().roomProofs);assert.deepEqual(restored.snapshot().verifiedGems,m.snapshot().verifiedGems);
});
test('collected gems stay absent on re-entry; resumes restore the precise earlier ledger',async()=>{
 const m=await create();await m.applyRoute(['right','right','right']);const entrance=m.source;
 await m.applyRoute(['left','left']);assert.equal(m.snapshot().verifiedGems.length,1);assert.equal(m.current.state.objects.filter(o=>m.role(o)==='goal'&&o.x>=0).length,0);
 m.restoreSpot(entrance);assert.equal(m.snapshot().room,'b.json');assert.equal(m.current.collected.length,1);
 m.restoreSpot('start:a.json');assert.equal(m.current.collected.length,0);assert.equal(m.snapshot().verifiedGems.length,1);
});
test('A* finds a gem, a new room, and an exact coordinate using actual physics',async()=>{
 const m=await create();for(const goal of [{kind:'gem'},{kind:'room'},{kind:'location',room:'b.json',x:3,y:2,z:0}]){
  const result=await searchRoute(m,goal);assert.equal(result.status,'found');assert(result.actions.length);await m.applyRoute(result.actions);
 }
 assert.deepEqual(m.position(m.current.state),{x:3,y:2,z:0});assert.equal(m.snapshot().verifiedRooms.length,2);assert.equal(m.snapshot().verifiedGems.length,2);
});
test('bounded/cancelled searches and failed replays cannot mutate the project or claim unreachable targets',async()=>{
 const m=await create(),before=m.save();assert.equal((await searchRoute(m,{kind:'location',room:'b.json',x:3,y:2},{maximumNodes:1})).status,'limit');assert.deepEqual(m.save(),before);
 assert.equal((await searchRoute(m,{kind:'gem'},{cancelled:()=>true})).status,'cancelled');assert.deepEqual(m.save(),before);
 await assert.rejects(m.applyRoute(['up','up']),/falls|blocked/);assert.deepEqual(m.save(),before);
 await assert.rejects(m.restore({...before,fingerprint:'other'}),/different world/);
 await assert.rejects(searchRoute(m,{kind:'location',room:'a.json',x:99,y:0}),/valid target/);
});
test('resume identity keeps mechanism state and the gem ledger separate',async()=>{
 const m=await create();const a=structuredClone(m.current),b=structuredClone(a);b.state.objects[0].blockId='ice';assert.notEqual(m.key(a),m.key(b));
 const c=structuredClone(a);c.collected=['some-gem'];assert.notEqual(m.key(a),m.key(c));
 const modified=world();modified.rooms[0].objects[0].blockId='wall';assert.notEqual(await worldFingerprint(modified),m.fingerprint);
});

test('native gem planning crosses from H×I and verifies its proposed moves with connected physics',async()=>{
 const {planGemRoute}=await import('../solutions/v1/gem-search.mjs');
 const w=world();w.rooms[0].objects=w.rooms[0].objects.filter(o=>o.blockId!=='gem');const m=await create(w);
 const native=await instantiateMazeBenchEngineV1(await readFile(new URL('../solutions/v1/solutions-solver.wasm',import.meta.url)));
 const before=m.save(),result=await planGemRoute(m,native);assert.equal(result.status,'found');assert.deepEqual(m.save(),before);
 await m.applyRoute(result.actions);assert.equal(m.verifiedGems.size,1);assert.equal(m.verifiedRooms.size,2);
});

test('ice crossings preserve entrances and count only gems collected by the engine after settling',async()=>{
 const w=world();w.rooms.push(room('c.json',['J','I'],2));w.columns.push('J');
 for(const r of w.rooms){r.objects=r.objects.filter(o=>o.blockId!=='gem');for(const o of r.objects)if(o.blockId==='floor'&&o.y===1)o.blockId='ice';}
 w.rooms[0].objects.push({blockId:'gem',x:3,y:1,z:0});w.rooms[1].objects.push({blockId:'gem',x:1,y:1,z:0});w.rooms[2].objects.push({blockId:'wall',x:3,y:1,z:0},{blockId:'gem',x:2,y:1,z:0});
 const m=await create(w);await m.move('right');assert.equal(m.current.room,'c.json');assert.equal(m.verifiedRooms.size,2);assert.equal(m.verifiedGems.size,1,'passing over a gem during an ice slide is not a collection');
 const entrance=m.spots.get(m.source);assert.deepEqual(entrance.entry,{x:0,y:1,z:0});assert.deepEqual(m.position(entrance.state),{x:2,y:1,z:0});assert.deepEqual(entrance.path,['right']);
 const restored=await create(w);await restored.restore(m.save());assert.deepEqual(restored.snapshot().verifiedGems,m.snapshot().verifiedGems);
});

test('native location search expands compact states and verifies only its proposed route',async()=>{
 const w=world();w.rooms=w.rooms.slice(0,1);w.rooms[0].objects=w.rooms[0].objects.filter(o=>o.blockId!=='gem');
 const m=await create(w),native=await nativeEngine(),before=m.save();
 const goal={kind:'location',room:'a.json',x:3,y:2,z:0},result=await planRoute(m,native,goal);
 assert.equal(result.status,'found');assert.equal(result.fallback,undefined);assert(result.verifiedCommands<result.transitions);assert.deepEqual(m.save(),before);
 await m.applyRoute(result.actions);assert.deepEqual(m.position(m.current.state),{x:3,y:2,z:0});
 const wrongHeight=await planRoute(m,native,{...goal,z:5});assert.equal(wrongHeight.status,'exhausted');
 const anyHeight=await planRoute(m,native,{...goal,z:null});assert.equal(anyHeight.status,'found');assert.equal(anyHeight.actions.length,0);
});

test('native frontier resumes after each boundary candidate, including both exits at corners',async()=>{
 const m=await create(),native=await nativeEngine();const session=createNativeRoomSearch(m,native,m.current,null,{boundaryMask:15});
 const exits=new Set();let result;
 for(let i=0;i<300;i++) {
  result=session.run(32);if(result.status==='exhausted')break;
  if(result.status!=='candidate')continue;
  let state=m.current.state;
  for(const action of result.actions)state=(await m.engine.simulateCommand(state,action,m.blocks)).final;
  const p=m.player(state);exits.add(`${p.x},${p.y}:${result.direction}`);session.continue();
 }
 assert.equal(result.status,'exhausted');assert(exits.has('0,0:up'));assert(exits.has('0,0:left'));assert(exits.has('3,2:right'));assert(exits.has('3,2:down'));
});

test('native routes test blocked entrances against the actual neighbor and find another entrance',async()=>{
 const w=world();w.rooms[1].objects.push({blockId:'wall',x:0,y:1,z:0});
 const m=await create(w),native=await nativeEngine(),before=m.save();
 const result=await planRoute(m,native,{kind:'room'});assert.equal(result.status,'found');assert.equal(result.fallback,undefined);assert.deepEqual(m.save(),before);
 await m.applyRoute(result.actions);assert.equal(m.current.room,'b.json');assert.notEqual(m.position(m.current.state).y,1);
});

test('native gem search respects excluded gems without removing them from its board',async()=>{
 const w=world();w.rooms=w.rooms.slice(0,1);w.rooms[0].objects.push({blockId:'gem',x:3,y:2,z:0});
 const m=await create(w),native=await nativeEngine();const known=m.current.state.objects.find(o=>o.blockId==='gem').solutionObjectId;m.verifiedGems.add(known);
 const result=await planRoute(m,native,{kind:'gem',excludedGems:[known]});assert.equal(result.status,'found');assert.equal(result.fallback,undefined);
 await m.applyRoute(result.actions);assert.equal(m.verifiedGems.size,2);
});

test('native search respects cancellation, time limits and validation without changing saved routes',async()=>{
 const m=await create(),native=await nativeEngine(),before=m.save();
 assert.equal((await planRoute(m,native,{kind:'gem'},{cancelled:()=>true})).status,'cancelled');
 assert.equal((await planRoute(m,native,{kind:'room'},{maximumMs:0})).status,'limit');
 await assert.rejects(planRoute(m,native,{kind:'location',room:'a.json',x:-1,y:0}),/valid target/);
 assert.deepEqual(m.save(),before);
});

test('hard room searches keep their native frontier beyond two seconds and 500,000 states',async t=>{
 const m=await create(),engine=await nativeEngine(),before=m.save();let clock=0,chunks=0;
 // Model a slow native frontier without making the regression test wait. Its
 // eventual candidate is still produced and verified by the actual engine.
 const native={writeState:engine.writeState.bind(engine),exports:{...engine.exports,
  editor_solver_run(count){clock+=1000;return ++chunks<4?0:engine.exports.editor_solver_run(count);},
  editor_solver_node_count(){return 500001+engine.exports.editor_solver_node_count();}
 }};
 t.mock.method(performance,'now',()=>clock);
 const result=await planRoute(m,native,{kind:'gem'},{maximumMs:10000});
 assert.equal(result.status,'found');assert.equal(result.fallback,undefined);assert.equal(chunks,4);assert(result.elapsedMs>2000);
 assert.deepEqual(m.save(),before);await m.applyRoute(result.actions);assert.equal(m.collectedGems.size,1);
});

test('long native searches still honor the selected duration and cancellation',async t=>{
 const m=await create(),engine=await nativeEngine(),before=m.save();let clock=0,chunks=0,cancelled=false;
 const native={writeState:engine.writeState.bind(engine),exports:{...engine.exports,editor_solver_run(){clock+=1000;chunks++;return 0;}}};
 t.mock.method(performance,'now',()=>clock);
 const timed=await planRoute(m,native,{kind:'gem'},{maximumMs:4000});
 assert.equal(timed.status,'limit');assert.equal(timed.limitReason,'time');assert.equal(chunks,4);
 clock=0;chunks=0;
 const stopped=await planRoute(m,native,{kind:'gem'},{maximumMs:Infinity,cancelled:()=>cancelled,onProgress:()=>{cancelled=true;}});
 assert.equal(stopped.status,'cancelled');assert.equal(chunks,1);assert.deepEqual(m.save(),before);
});

test('blocked entrances do not discard the native frontier after 32 boundary candidates',async()=>{
 const w=world();
 for(const r of w.rooms){r.height=40;r.objects=[...Array.from({length:160},(_,i)=>({blockId:'floor',x:i%4,y:Math.floor(i/4),z:0})),{blockId:'player',x:1,y:1,z:0}];}
 w.roomHeight=40;
 w.rooms[1].objects.push(...Array.from({length:39},(_,y)=>({blockId:'wall',x:0,y,z:0})));
 const m=await create(w),native=await nativeEngine(),before=m.save();
 const result=await planRoute(m,native,{kind:'room'});
 assert.equal(result.status,'found');assert.equal(result.fallback,undefined);assert.deepEqual(m.save(),before);
 await m.applyRoute(result.actions);assert.equal(m.current.room,'b.json');assert.equal(m.position(m.current.state).y,39);
});

test('native proposals use the real settled state when Ice carries the player through two seams',async()=>{
 const w=world();w.rooms.push(room('c.json',['J','I'],2));
 for(const r of w.rooms){r.objects=r.objects.filter(o=>o.blockId!=='gem');for(const o of r.objects)if(o.blockId==='floor'&&o.y===1)o.blockId='ice';}
 w.rooms[2].objects.push({blockId:'wall',x:3,y:1,z:0},{blockId:'gem',x:2,y:1,z:0});
 const m=await create(w),native=await nativeEngine(),result=await planRoute(m,native,{kind:'gem'});
 assert.equal(result.status,'found');await m.applyRoute(result.actions);assert.equal(m.verifiedRooms.size,2);assert.equal(m.verifiedGems.size,1);
 assert.deepEqual(m.position(m.current.state),{x:2,y:1,z:0});
});

test('undo deletes draft moves; blocked commands do not consume undo history',async()=>{
 const m=await create(),before=m.save();assert.equal(m.snapshot().canUndo,false);
 await m.move('up');const recorded=m.save();assert.equal(m.snapshot().canUndo,true);
 await m.move('up');assert.deepEqual(m.save(),recorded);
 await m.undo();assert.deepEqual(m.save(),before);assert.deepEqual(m.position(m.current.state),{x:1,y:1,z:0});assert.equal(m.snapshot().canUndo,false);
 await m.undo();assert.deepEqual(m.save(),before);assert.deepEqual(recorded.draft.actions,['up']);
});

test('undo removes a gem move, its saved route, proof and checkpoint',async()=>{
 const m=await create(),before=m.save(),initial=m.snapshot();
 await m.move('right');assert.equal(m.routes.length,1);assert.equal(m.verifiedGems.size,1);
 await m.undo();assert.deepEqual(m.save(),before);assert.deepEqual(m.snapshot(),initial);assert.equal(m.current.collected.length,0);assert.equal(m.spots.size,2);
 assert.deepEqual(m.export().currentPath,[]);assert.deepEqual(m.export().gemProofs,{});
});

test('undo shortens generated routes one command at a time without saving inverse moves',async()=>{
 const m=await create(),before=m.save();await m.applyRoute(['right','right','right','right'],'Generated route');
 for(const count of [3,2,1,0]) {
  await m.undo();assert.deepEqual(m.export().currentPath,Array(count).fill('right'));
  assert.equal(m.routes.length,count?1:0);if(count)assert.deepEqual(m.routes[0].actions,Array(count).fill('right'));
  assert.equal(m.verifiedRooms.size,count>=3?2:1);assert.equal(m.verifiedGems.size,count>=1?1:0);
  const restored=await create();await restored.restore(m.save());assert.deepEqual(restored.save(),m.save());assert.deepEqual(restored.snapshot(),m.snapshot());
 }
 assert.deepEqual(m.save(),before);
});

test('undo after reload crosses room boundaries and continues through earlier recorded moves',async()=>{
 let m=await create();const before=m.save();for(const action of ['right','right','right'])await m.move(action);
 const saved=m.save();m=await create();await m.restore(saved);assert.equal(m.current.room,'b.json');assert.equal(m.snapshot().canUndo,true);
 await m.undo();assert.equal(m.current.room,'a.json');assert.deepEqual(m.position(m.current.state),{x:3,y:1,z:0});assert.equal(m.verifiedRooms.size,1);assert.equal([...m.spots.values()].filter(s=>s.kind==='entrance').length,0);
 await m.undo();assert.deepEqual(m.position(m.current.state),{x:2,y:1,z:0});assert.equal(m.routes.length,1);
 await m.undo();assert.deepEqual(m.save(),before);
});

test('undo deletes only the new branch and keeps earlier independent proofs replayable',async()=>{
 const m=await create();await m.applyRoute(['right','right','right']);m.restoreSpot('start:a.json');
 const before=m.save(),proofs=m.export().roomProofs;await m.applyRoute(['up','right','right','right']);
 for(let i=0;i<4;i++)await m.undo();
 assert.deepEqual(m.save(),before);assert.deepEqual(m.export().roomProofs,proofs);assert.equal(m.verifiedRooms.size,2);assert.equal(m.verifiedGems.size,1);
 assert.equal(m.snapshot().canUndo,false);await m.move('up');await m.undo();assert.deepEqual(m.save(),before);
 const restored=await create();await restored.restore(m.save());assert.deepEqual(restored.snapshot(),m.snapshot());
});

test('undo handles a saved route that ends at an already existing resume spot',async()=>{
 const m=await create(),before=m.save();await m.applyRoute(['up','down']);assert.equal(m.source,'start:a.json');
 assert.equal(m.snapshot().canUndo,true);await m.undo();assert.deepEqual(m.position(m.current.state),{x:1,y:0,z:0});assert.deepEqual(m.routes[0].actions,['up']);
 await m.undo();assert.deepEqual(m.save(),before);assert.equal(m.spots.size,2);
});

test('undo restores full moving-object state, not just the player coordinate',async()=>{
 const w=world();w.blocks=[...blocks,{id:'crate',roleId:'pushable',visual:{kind:'cube'}}];w.rooms[0].objects=w.rooms[0].objects.filter(o=>o.blockId!=='gem');w.rooms[0].objects.push({blockId:'crate',x:2,y:1,z:0});
 const m=await create(w),initial=structuredClone(m.current);await m.move('right');assert.equal(m.current.state.objects.find(o=>o.blockId==='crate').x,3);await m.undo();
 assert.equal(m.key(m.current),m.key(initial));assert.deepEqual(m.current.state,initial.state);
});

test('undo deletes the settled room proof from a continuous Ice move without proving intermediate rooms',async()=>{
 const w=world();w.rooms.push(room('c.json',['J','I'],2));
 for(const r of w.rooms){r.objects=r.objects.filter(o=>o.blockId!=='gem');for(const o of r.objects)if(o.blockId==='floor'&&o.y===1)o.blockId='ice';}
 w.rooms[2].objects.push({blockId:'wall',x:3,y:1,z:0},{blockId:'gem',x:2,y:1,z:0});
 const m=await create(w),before=m.save();await m.move('right');assert.equal(m.verifiedRooms.size,2);assert.equal(m.verifiedGems.size,1);
 assert.deepEqual([...m.roomProofs.keys()],['a.json','c.json']);
 await m.undo();assert.deepEqual(m.save(),before);assert.equal(m.current.room,'a.json');assert.equal(m.verifiedRooms.size,1);assert.equal(m.verifiedGems.size,0);
});

test('spawn setup stacks exact move prefixes back to the game or authored room start',async()=>{
 const m=await create();await m.applyRoute(['right','right','right']);const entrance=m.source;
 await m.applyRoute(['up']);const saved=m.source;
 assert.deepEqual(m.spawnRecipe(entrance),{base:'game',room:'a.json',actions:['right','right','right']});
 assert.deepEqual(m.spawnRecipe(saved).actions,['right','right','right','up']);
 m.restoreSpot('start:b.json');await m.applyRoute(['up','right']);
 assert.deepEqual(setupCommands(m,m.spawnRecipe(m.source)),['room IxI','up','right']);
 const restored=await create();await restored.restore(m.save());assert.deepEqual(restored.spawnRecipe(restored.source),m.spawnRecipe(m.source));
});

test('full solution joins room-start runs with go-to-room and a permanent gem ledger',async()=>{
 const m=await create();await m.applyRoute(['right','right','right']);m.restoreSpot('start:b.json');await m.applyRoute(['right']);
 const before=m.save(),full=await compileFullSolution(m);
 assert.equal(full.complete,true);assert.deepEqual(full.commands,['right','right','right','room IxI','right']);
 assert.equal(full.gems.length,2);assert.equal(full.rooms.length,2);assert.equal(full.roomCommands,1);assert.deepEqual(m.save(),before);
});

test('full solution expands saved room-spawn setup when stacking a later run',async()=>{
 const m=await create();await m.applyRoute(['right','right','right']);
 m.restoreSpot('start:b.json');await m.applyRoute(['up','right']);const spawn=m.source;
 m.restoreSpot('start:a.json');await m.applyRoute(['up']);
 m.restoreSpot(spawn);await m.applyRoute(['down']);
 const full=await compileFullSolution(m);assert.equal(full.complete,true);
 assert.deepEqual(full.commands,['right','right','right','room IxI','up','right','room HxI','up','room IxI','up','right','down']);
 assert.equal(full.gems.length,2);assert.equal(full.runs.at(-1).setupCommands,3);
 assert(full.commands.every(command=>['up','right','down','left'].includes(command)||command.startsWith('room ')));
});

test('room-start runs wait for physical discovery; unreachable plans are reported separately',async()=>{
 const m=await create();m.restoreSpot('start:b.json');await m.applyRoute(['right']);
 const partial=await compileFullSolution(m);assert.equal(partial.complete,false);assert.equal(partial.blockedRuns.length,1);assert.deepEqual(partial.commands,[]);assert.equal(partial.gems.length,0);
 m.restoreSpot('start:a.json');await m.applyRoute(['right','right','right']);
 const full=await compileFullSolution(m);assert.equal(full.complete,true);assert.deepEqual(full.runs.map(r=>r.id),['route:2','route:1']);assert.equal(full.gems.length,2);
});

test('saved spawns in rooms without authored starts expand through their entering moves',async()=>{
 const w=world();w.rooms[1].objects=w.rooms[1].objects.filter(o=>o.blockId!=='player');const m=await create(w);
 await m.applyRoute(['right','right','right']);const spawn=m.source;
 m.restoreSpot('start:a.json');await m.applyRoute(['up']);m.restoreSpot(spawn);await m.applyRoute(['right','right']);
 const full=await compileFullSolution(m);assert.equal(full.complete,true);assert.equal(full.gems.length,2);
 assert(!full.commands.includes('room IxI'));assert(full.commands.includes('room HxI'));
});

test('clear all runs removes every branch, discovered spawn, proof and draft and persists the empty collection',async()=>{
 const m=await create(),initial=m.save(),initialSnapshot=m.snapshot();
 await m.applyRoute(['right','right','right'],'Entrance');await m.applyRoute(['right'],'Continuation');
 m.restoreSpot('start:a.json');await m.applyRoute(['up'],'Independent');await m.move('right');
 assert.equal(m.routes.length,3);assert.equal(m.pending.length,1);assert.equal(m.verifiedRooms.size,2);assert.equal(m.verifiedGems.size,1);
 const result=m.clearRuns();assert.equal(result.deleted,3);assert.deepEqual(result.snapshot,initialSnapshot);assert.deepEqual(m.save(),initial);
 assert.equal(m.snapshot().canUndo,false);assert.equal(m.routeChanges.length,0);assert.equal(m.routeTrace,null);
 assert([...m.spots.values()].every(spot=>spot.kind==='start'));
 const full=await compileFullSolution(m);assert.deepEqual(full.commands,[]);assert.equal(full.gems.length,0);assert.equal(full.rooms.length,1);
 const restored=await create();await restored.restore(m.save());assert.deepEqual(restored.snapshot(),initialSnapshot);
 await restored.undo();assert.deepEqual(restored.save(),initial);
 await restored.applyRoute(['right']);assert.equal(restored.routes.length,1);assert.equal(restored.verifiedGems.size,1);
 await restored.undo();assert.deepEqual(restored.save(),initial);
});

test('clear all runs also clears a draft without saved runs and safely handles an empty collection',async()=>{
 const m=await create(),initial=m.save();await m.move('up');assert.equal(m.routes.length,0);assert.equal(m.pending.length,1);
 assert.equal(m.clearRuns().deleted,0);assert.deepEqual(m.save(),initial);
 assert.equal(m.clearRuns().deleted,0);assert.deepEqual(m.save(),initial);
});

test('full compilation fails closed on a non-replayable run and never mutates the working solution',async()=>{
 const m=await create();await m.applyRoute(['up']);m.routes[0].actions=['right'];const before=m.save();
 const full=await compileFullSolution(m);assert.equal(full.complete,false);assert.equal(full.blockedRuns.length,1);assert.deepEqual(full.commands,[]);assert.deepEqual(m.save(),before);
 await assert.rejects(compileFullSolution(m,{cancelled:()=>true}),/cancelled/);assert.deepEqual(m.save(),before);
});

test('only visited room starts and automatic entrances can be selected',async()=>{
 const m=await create(),before=m.save();
 assert.throws(()=>m.resume('start:b.json'),/visited room/);assert.deepEqual(m.save(),before);
 await m.applyRoute(['up'],'Location route');const endpoint=m.source;
 assert.equal(m.spots.get(endpoint).kind,'endpoint');assert.throws(()=>m.resume(endpoint),/start or entrance/);
 assert.deepEqual(m.snapshot().spots.filter(s=>s.accessible).map(s=>s.id),['start:a.json']);
 m.resume('start:a.json');await m.applyRoute(['right','right','right']);
 const entrance=m.source;assert.equal(m.spots.get(entrance).kind,'entrance');assert.equal(m.canResume(entrance),true);
 assert.deepEqual(m.snapshot().visitedRooms,['a.json','b.json']);m.resume('start:b.json');
 assert.deepEqual(m.position(m.current.state),{x:1,y:1,z:0});assert.equal(m.current.collected.length,1);
 assert(m.snapshot().spots.find(s=>s.id==='start:b.json').accessible);
 assert(!m.export().spawnSetups.some(s=>s.id===endpoint));
});

test('visited progress includes gems and further rooms reached from an unlocked room start',async()=>{
 const w=world();w.rooms.push(room('c.json',['J','I'],2));w.columns.push('J');const m=await create(w);
 await m.applyRoute(['right','right','right']);m.resume('start:b.json');await m.applyRoute(['right','right','right']);
 assert.deepEqual(m.snapshot().visitedRooms,['a.json','b.json','c.json']);
 assert.deepEqual(m.snapshot().roomProgress.map(p=>[p.total,p.collected,p.remaining]),[[1,1,0],[1,1,0],[0,0,0]]);
 assert.equal(m.collectedGems.size,2);assert.equal(m.snapshot().spots.find(s=>s.id==='start:c.json').accessible,true);
 const full=await compileFullSolution(m);assert.equal(full.complete,true);assert.equal(full.gems.length,2);assert.equal(full.rooms.length,3);
 const restored=await create(w);await restored.restore(m.save());assert.deepEqual(restored.snapshot(),m.snapshot());
});

test('entrance selection resets moved blocks, preserves collected gems, and remains exact after reload and undo',async()=>{
 const w=world();w.blocks=[...blocks,{id:'crate',roleId:'pushable',visual:{kind:'cube'}}];w.rooms[1].objects.push({blockId:'crate',x:2,y:2,z:0});
 const m=await create(w);await m.applyRoute(['right','right','right']);const entrance=m.source;
 await m.applyRoute(['right','right']);await m.applyRoute(['left','down','right']);
 assert.equal(m.current.state.objects.find(o=>o.blockId==='crate').x,3);assert.equal(m.collectedGems.size,2);
 m.resume(entrance);assert.equal(m.current.state.objects.find(o=>o.blockId==='crate').x,2);
 assert.deepEqual(m.position(m.current.state),{x:0,y:1,z:0});assert.equal(m.current.state.objects.some(o=>m.role(o)==='goal'),false);
 assert.equal(m.current.collected.length,2);const before=m.save(),state=structuredClone(m.current.state);
 await m.move('right');await m.undo();assert.deepEqual(m.save(),before);assert.deepEqual(m.current.state,state);
 await m.applyRoute(['right']);const restored=await create(w);await restored.restore(m.save());assert.deepEqual(restored.snapshot(),m.snapshot());
 await restored.undo();assert.deepEqual(restored.save(),before);
 const full=await compileFullSolution(m);assert.equal(full.complete,true,JSON.stringify(full.blockedRuns));assert.equal(full.gems.length,2);
 m.resume(entrance);assert.deepEqual((await compileFullSolution(m)).commands,full.commands,'selecting a spawn must not change how older runs replay');
});

test('map gem progress distinguishes untouched, partially collected, completed and gem-free rooms',async()=>{
 const w=world();w.rooms[0].objects.push({blockId:'gem',x:3,y:1,z:0});w.rooms.push(room('c.json',['J','I'],2));const m=await create(w);
 assert.deepEqual(m.snapshot().roomProgress.map(p=>[p.total,p.collected,p.remaining]),[[2,0,2],[1,0,1],[0,0,0]]);
 await m.move('right');assert.deepEqual(m.snapshot().roomProgress[0],{room:'a.json',visited:true,total:2,collected:1,remaining:1});
 m.resume('start:a.json');assert.equal(m.current.state.objects.filter(o=>m.role(o)==='goal').length,1);
 await m.applyRoute(['right','right']);assert.equal(m.snapshot().roomProgress[0].remaining,0);
 await m.undo();assert.equal(m.snapshot().roomProgress[0].collected,1);assert.equal(m.snapshot().roomProgress[0].remaining,1);
 m.clearRuns();assert.deepEqual(m.snapshot().visitedRooms,['a.json']);assert.equal(m.snapshot().roomProgress[0].collected,0);
 assert.throws(()=>m.resume('start:b.json'),/visited room/);
});

test('legacy collections keep their runs while hiding old checkpoints and keeping globally collected gems removed',async()=>{
 const m=await create();await m.applyRoute(['right','right','right']);m.restoreSpot('start:a.json');await m.applyRoute(['up']);
 const saved=m.save(),restored=await create();await restored.restore(saved);await restored.refreshCurrentGems();
 assert.deepEqual(restored.routes.map(r=>r.actions),m.routes.map(r=>r.actions));assert.equal(restored.current.collected.length,1);
 assert.equal(restored.current.state.objects.some(o=>restored.role(o)==='goal'),false);
 assert(restored.snapshot().spots.filter(s=>s.accessible).every(s=>['start','entrance'].includes(s.kind)));
 const again=await create();await again.restore(restored.save());assert.deepEqual(again.snapshot(),restored.snapshot());
});

test('import restores an exported solution with resets and draft moves, ignoring exported progress claims',async()=>{
 const source=await create();await source.applyRoute(['right','right','right']);source.resume('start:b.json');await source.applyRoute(['right']);await source.move('up');
 const exported={...source.export(),fullSolution:await compileFullSolution(source),roomProofs:{fake:['up']},gemProofs:{fake:['right']}};
 const target=await create(),progress=[];const result=await target.importJSON(JSON.stringify(exported),(done,total)=>progress.push([done,total]));
 assert.equal(result.message,'Imported 2 runs.');assert.deepEqual(target.snapshot(),source.snapshot());assert.deepEqual(target.save(),source.save());
 assert.deepEqual(progress,[[1,2],[2,2]]);assert(!target.visitedRooms.has('fake'));assert(!target.collectedGems.has('fake'));
 const reloaded=await create();await reloaded.restore(target.save());assert.deepEqual(reloaded.snapshot(),target.snapshot());
 await target.undo();assert.deepEqual(target.pending,[]);assert.equal(target.routes.length,2);
});

test('import is allowed only when saved runs and unfinished moves are both empty',async()=>{
 const source=await create();await source.applyRoute(['right']);const json=JSON.stringify(source.export());
 const target=await create();await target.move('up');let before=target.save();
 await assert.rejects(target.importJSON(json),/Clear all runs/);assert.deepEqual(target.save(),before);
 target.commit();before=target.save();await assert.rejects(target.importJSON(json),/Clear all runs/);assert.deepEqual(target.save(),before);
 target.clearRuns();await target.importJSON(json);assert.equal(target.routes.length,1);assert.equal(target.collectedGems.size,1);
});

test('bad JSON, mismatched files and oversized runs never leave a partial import',async()=>{
 const source=await create();await source.applyRoute(['right']);const exported=source.export();
 const target=await create(),before=target.save();
 for(const [json,reason]of [
  ['{broken',/valid JSON/],['null',/Solutions JSON/],['{}',/Solutions JSON/],
  [JSON.stringify({...exported,fingerprint:'other'}),{code:'WORLD_MISMATCH'}],
  [JSON.stringify({...exported,engine:'other'}),{code:'ENGINE_MISMATCH'}],
  [JSON.stringify({...exported,routes:[...exported.routes,{from:'start:a.json',actions:Array(100001).fill('up')}]}),/100,000-move limit/]
 ]){await assert.rejects(target.importJSON(json),reason);assert.deepEqual(target.save(),before);assert.equal(target.collectedGems.size,0);}
 await target.importJSON(JSON.stringify(exported));assert.equal(target.routes.length,1);
});

test('world override replays untouched routes and rebuilds gem IDs after an unrelated room edit',async()=>{
 const source=await create();await source.applyRoute(['right','right','right']);source.resume('start:b.json');await source.applyRoute(['right']);
 const json=JSON.stringify(source.export()),edited=world();edited.rooms[0].objects.unshift({blockId:'wall',x:0,y:0,z:1});
 const target=await create(edited),before=target.save();await assert.rejects(target.importJSON(json),{code:'WORLD_MISMATCH'});assert.deepEqual(target.save(),before);
 const result=await target.importJSON(json,()=>{},{allowWorldChange:true});assert.match(result.message,/edited world/);
 assert.equal(target.routes.length,2);assert.equal(target.visitedRooms.size,2);assert.equal(target.collectedGems.size,2);
 const newGem=target.goalIds.get('a.json')[0],oldGem=source.goalIds.get('a.json')[0];assert.notEqual(newGem,oldGem);
 assert(target.routes[1].start.collected.includes(newGem));assert(!target.routes[1].start.collected.includes(oldGem));
 const restored=await create(edited);await restored.restore(target.save());assert.deepEqual(restored.snapshot(),target.snapshot());
 assert.equal((await compileFullSolution(target)).complete,true);
});

test('world override removes blocked moves and continues later runs without bypassing engine compatibility',async()=>{
 const source=await create();await source.applyRoute(['up']);source.resume('start:a.json');await source.applyRoute(['right']);
 const exported=source.export(),edited=world();edited.rooms[0].objects.push({blockId:'wall',x:2,y:1,z:0});const target=await create(edited),before=target.save();
 await assert.rejects(target.importJSON(JSON.stringify({...exported,engine:'other'}),()=>{},{allowWorldChange:true}),{code:'ENGINE_MISMATCH'});assert.deepEqual(target.save(),before);
 exported.routes.push({from:'start:a.json',actions:['down'],label:'After blocked move'});delete exported.draft;
 const result=await target.importJSON(JSON.stringify(exported),()=>{},{allowWorldChange:true});
 assert(result.warnings.count>=1);assert.deepEqual(target.routes.map(r=>r.actions),[['up'],['down']]);
 assert.deepEqual(target.position(target.current.state),{x:1,y:2,z:0});assert.equal(target.collectedGems.size,0);
 const restored=await create(edited);await restored.restore(target.save());assert.deepEqual(restored.snapshot(),target.snapshot());
});

test('older engine exports import by replay, save with current provenance, and survive reload and undo',async()=>{
 const source=await create();await source.applyRoute(['right','right','right']);source.resume('start:b.json');await source.applyRoute(['right']);await source.move('up');
 const original=source.export(),exported={...original,engine:'older-engine',fingerprint:'older-world-and-engine',roomProofs:{fake:[]},gemProofs:{fake:[]}};
 const target=await create(),before=target.save(),progress=[],json=JSON.stringify(exported);
 await assert.rejects(target.importJSON(json),{code:'ENGINE_MISMATCH'});assert.deepEqual(target.save(),before);
 const result=await target.importJSON(json,(done,total)=>progress.push([done,total]),{allowWorldChange:true,allowEngineChange:true});
 assert.match(result.message,/current engine and rooms/);assert.deepEqual(progress,[[1,2],[2,2]]);
 assert.deepEqual(target.snapshot(),source.snapshot());assert.deepEqual(target.save(),source.save());
 assert.equal(target.export().engine,original.engine);assert.equal(target.export().fingerprint,original.fingerprint);
 const restored=await create();await restored.restore(target.save());assert.deepEqual(restored.snapshot(),target.snapshot());
 await restored.undo();await source.undo();assert.deepEqual(restored.save(),source.save());
 assert.equal((await compileFullSolution(target)).complete,true);
 assert.equal(JSON.parse(json).engine,'older-engine','the original export is never rewritten');
});

test('engine override also rebases gem IDs when rooms changed',async()=>{
 const source=await create();await source.applyRoute(['right','right','right']);source.resume('start:b.json');await source.applyRoute(['right']);
 const edited=world();edited.rooms[0].objects.unshift({blockId:'wall',x:0,y:0,z:1});
 const target=await create(edited);
 await target.importJSON(JSON.stringify({...source.export(),engine:'older-engine'}),()=>{},{allowWorldChange:true,allowEngineChange:true});
 assert.equal(target.collectedGems.size,2);assert.equal(target.visitedRooms.size,2);
 assert(target.routes[1].start.collected.includes(target.goalIds.get('a.json')[0]));
 assert(!target.routes[1].start.collected.includes(source.goalIds.get('a.json')[0]));
});

test('engine override repairs failed moves and outdated spawns while preserving valid progress',async()=>{
 const source=await create();await source.applyRoute(['right','right','right']);const exported={...source.export(),engine:'older-engine'};
 const target=await create(),options={allowWorldChange:true,allowEngineChange:true};
 const broken={...exported,routes:[...exported.routes,{from:source.source,actions:['up','up']}]};
 const result=await target.importJSON(JSON.stringify(broken),()=>{},options);
 assert.equal(result.warnings.count,1);assert.deepEqual(target.routes.map(r=>r.actions),[['right','right','right'],['up']]);
 const shifted=structuredClone(exported);shifted.spawnSetups.find(s=>s.id===source.source).position.y++;
 const repaired=await create(),original=JSON.stringify(shifted);
 const shiftedResult=await repaired.importJSON(original,()=>{},options);
 assert(shiftedResult.warnings.count>=1);assert.equal(repaired.collectedGems.size,1);assert.equal(repaired.visitedRooms.size,2);
 assert.deepEqual(repaired.export().spawnSetups.find(s=>s.id===repaired.source).position,{x:0,y:1,z:0});
 assert.equal(JSON.stringify(shifted),original,'the input file is not rewritten');
 const restored=await create();await restored.restore(repaired.save());assert.deepEqual(restored.snapshot(),repaired.snapshot());
 await restored.undo();assert.equal(restored.current.room,'a.json');assert.equal(restored.visitedRooms.size,1);
 assert.equal((await compileFullSolution(repaired)).complete,true);
});

test('invalid spawns and individual actions are removed from runs and drafts without granting fake visits',async()=>{
 const target=await create(),saved={...target.export(),routes:[
  {from:'start:b.json',actions:['teleport','right','up','up','down'],label:'Repaired run'},
  {from:'missing',actions:['right','right'],label:'Continue after bad spawn'},
 ],draft:{from:'missing',actions:['up','up','down']}};
 const result=await target.importJSON(JSON.stringify(saved));
 assert.equal(result.warnings.count,6);assert.equal(result.warnings.examples.length,5);
 assert.deepEqual(target.routes.map(r=>r.actions),[['right','up','down'],['right','right']]);
 assert.equal(target.routes[0].from,'start:a.json');assert.equal(target.routes[1].from,target.routes[0].to);
 assert.deepEqual(target.pending,['up','down']);assert.equal(target.current.room,'b.json');
 assert.equal(target.collectedGems.size,1,'the unvisited room spawn cannot collect its gem');
 const restored=await create();await restored.restore(target.save());assert.deepEqual(restored.snapshot(),target.snapshot());
 const again=await create();assert.equal((await again.importJSON(JSON.stringify(target.export()))).warnings.count,0);
 assert.equal((await compileFullSolution(target)).complete,true);
 await target.undo();assert.deepEqual(target.pending,['up']);
});

for(const legacy of [false,true])test(`deleted runs do not confuse later spawn IDs (${legacy?'legacy':'explicit'} references)`,async()=>{
 const source=await create();await source.applyRoute(['up']);source.resume('start:a.json');
 await source.applyRoute(['right']);await source.applyRoute(['right','right']);
 source.resume(source.source);await source.applyRoute(['right']);
 const saved=source.export();if(legacy)for(const route of saved.routes){delete route.to;delete route.spawns;}
 const edited=world();edited.rooms[0].objects.push({blockId:'wall',x:1,y:0,z:0});
 const target=await create(edited),result=await target.importJSON(JSON.stringify(saved),()=>{},{allowWorldChange:true});
 assert(result.warnings.count>=1);assert.deepEqual(target.routes.map(r=>r.actions),[['right'],['right','right'],['right']]);
 assert.equal(target.current.room,'b.json');assert.deepEqual(target.position(target.current.state),{x:1,y:1,z:0});
 assert.equal(target.collectedGems.size,1);assert.equal(target.visitedRooms.size,2);
 const restored=await create(edited);await restored.restore(target.save());assert.deepEqual(restored.snapshot(),target.snapshot());
 assert.equal((await compileFullSolution(target)).complete,true);
});

test('large repairs keep diagnostics bounded and never save invalid actions',async()=>{
 const target=await create(),saved={...target.export(),routes:[
  {from:'start:a.json',actions:[...Array(5000).fill('invalid'),'right'],label:'Large damaged run'},
 ],draft:{from:'missing',actions:['right','right']}};
 const progress=[],result=await target.importJSON(JSON.stringify(saved),(done,total)=>progress.push([done,total]));
 assert.equal(result.warnings.count,5001);assert.equal(result.warnings.examples.length,5);
 assert.deepEqual(progress,[[1,1]]);assert.deepEqual(target.routes[0].actions,['right']);
 assert.deepEqual(target.pending,['right','right']);assert.equal(target.current.room,'b.json');
 const restored=await create();await restored.restore(target.save());assert.deepEqual(restored.snapshot(),target.snapshot());
});
