const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const context = vm.createContext({ window: {}, WebAssembly, Uint8Array, Int32Array, Int16Array, Set, Map, fetch, setTimeout, clearTimeout, performance, console });
for (const file of ['maze-engine.js', 'maze-engine-versions.js', 'maze-solver.js']) vm.runInContext(fs.readFileSync(path.join(root, 'public', file), 'utf8'), context);
const versions = context.window.MazeEngineVersions;
const cell = (type = 'floor', elevation = 0) => ({ type, layers: [{ type, elevation }] });
function room(actors, terrain = Array.from({ length: 3 }, () => Array.from({ length: 5 }, () => cell()))) {
  return { engineVersion: 'v1.1', width: terrain[0].length, height: terrain.length, terrain, actors };
}
function actor(type, x, y, extra = {}) { return { type, x, y, elevation: 0, ...extra }; }
function execute(data, dx = 1, dy = 0) {
  const engine = versions.createEngine(data), state = engine.cloneState(engine.initialState);
  const result = engine.move(state, dx, dy);
  return { engine, state, result };
}
async function main() {
  const legacyData = room([actor('player', 1, 1)]); delete legacyData.engineVersion;
  assert.equal(versions.versionFor(legacyData), 'v1');
  assert.equal(versions.createEngine(legacyData).initialState.actorX[0], 1);
  assert.throws(() => versions.createEngine({ ...legacyData, engineVersion: 'v2' }), /Unsupported/);
  assert.throws(() => versions.createEngine(room([actor('player', 1, 1)])), /not loaded/);
  await versions.load('v1.1', { bytes: fs.readFileSync(path.join(root, 'public', 'physics', 'v1.1.wasm')) });
  let data = room([actor('player', 1, 1), actor('gem', 2, 1)]);
  let {engine, state, result} = execute(data);
  assert.equal(state.actorX[0], 2); assert.equal(state.actorElevation[0], 0); assert.equal(state.actorRemoved[1], 1);
  assert.equal(result.moves.find((m) => m.actorType === 'gem').toRemoved, true);
  assert.equal(engine.isSolved(state), true);
  const snapshot = engine.cloneState(state); engine.move(state, 1, 0);
  assert.equal(snapshot.actorX[0], 2, 'snapshots must not alias live positions');
  assert.equal(snapshot.actorRemoved[1], 1);
  data = room([actor('player', 1, 1), actor('weightless_box', 2, 1, {groupId:'A'}), actor('weightless_box', 2, 2, {groupId:'A'})]);
  ({state, result} = execute(data)); assert.deepEqual(Array.from(state.actorX), [2,3,3]);
  assert.ok(result.ticks.length > 0);
  data = room([actor('player', 1, 1)]); data.terrain[1][2] = cell('wall');
  ({state,result}=execute(data)); assert.equal(state.actorX[0], 1); assert.equal(result.moved,false);
  data = room([actor('player', 0, 1), actor('gem', 2, 1)]);
  data.terrain[1][1]=cell('ice'); data.terrain[1][2]=cell('ice'); data.terrain[1][3]=cell('ice');
  ({state,result}=execute(data)); assert.equal(state.actorX[0],4); assert.equal(state.actorRemoved[1],0,'crossing gem while sliding does not collect');
  assert.ok(result.ticks.length >= 4);
  data = room([actor('player',1,1),actor('clone',1,2,{groupId:'C0'})]);
  ({state}=execute(data)); assert.deepEqual(Array.from(state.actorX),[2,2]);
  data = room([actor('player',1,1)]); data.terrain[1][2]=cell('player_lift');
  ({state,result}=execute(data)); assert.equal(state.actorX[0],2); assert.equal(state.actorElevation[0],1);
  assert.equal(state.terrainState[1][2].layers[0].raised,true); assert.ok(result.ticks.length>=2);
  data = room([actor('player',1,1)]); data.terrain[1][3]=cell('player_gate');
  ({state,result}=execute(data)); assert.equal(state.terrainState[1][3].layers[0].raised,true);
  const quiet = execute({...room([actor('player',0,1)]),physicsTrace:false});
  assert.equal(quiet.result.ticks.length,0); assert.equal(quiet.state.actorX[0],1);
  const unsupported = room([actor('player',1,1)]); unsupported.terrain[0][0]=cell('orange_ice_slope');
  assert.throws(()=>versions.createEngine(unsupported), /does not support/);
  const rebuilt = versions.createEngine({ ...data, terrain: state.terrainState, actors: data.actors.map((a,i)=>({...a,x:state.actorX[i],y:state.actorY[i],elevation:state.actorElevation[i],v11GenericId:state.actorGenericId[i]})) });
  assert.equal(rebuilt.initialState.terrainState[1][3].layers[0].raised,true,'mechanisms persist across browser engine reconstruction');
  const solveEngine = versions.createEngine({...room([actor('player',0,1), actor('gem',3,1)]),physicsTrace:false});
  const solveResult = await context.window.MazeSolver.solveWithAStar(solveEngine,{maxExpandedStates:1000});
  assert.equal(solveResult.path,'RRR','the author solver must use v1.1 transitions');
  // A hovering actor must settle in the physics command, never the renderer.
  data=room([actor('player',1,1,{elevation:2})]);
  ({state,result}=execute(data)); assert.equal(state.actorElevation[0],0); assert.equal(state.actorX[0],2);
  assert.ok(result.ticks.length>=3);
  // A floor is a supported, passable cell while a raised wall is solid.
  data=room([actor('player',1,1),actor('floating_floor',2,1)]); data.terrain[1][3]={type:'hole',layers:[]};
  ({state,result}=execute(data)); assert.equal(state.actorRemoved[1],1); assert.equal(state.terrainState[1][3].type,'floor');
  data=room([actor('player',1,1),actor('puncher',2,1,{direction:'left'})]);
  ({state,result}=execute(data)); assert.equal(state.actorX[0],0); assert.ok(result.ticks.length>=2);
  data=room([actor('player',1,1)]); data.terrain[1][2]={type:'hole',layers:[]};
  ({state,result}=execute(data)); assert.equal(state.actorRemoved[0],1); assert.ok(result.moves[0].toRemoved);
  data=room([actor('player',1,1),actor('orange_button',2,1)]);
  data.terrain[1][4]=cell('orange_wall');
  ({engine,state,result}=execute(data));
  assert.equal(state.terrainState[1][4].layers[0].v11GenericId,1);
  assert.equal(state.terrainState[1][4].layers[0].raised,false);
  assert.equal(state.terrainState[1][4].layers[0].v11Hidden,false);
  engine.move(state,-1,0); assert.equal(state.terrainState[1][4].layers[0].v11GenericId,0);
  assert.equal(state.terrainState[1][4].layers[0].raised,true);
  data=room([actor('player',1,1),actor('orange_button',2,1),actor('box',3,1),actor('orange_button',3,1)]);
  data.terrain[1][4]=cell('orange_wall');
  ({state}=execute(data)); assert.equal(state.terrainState[1][4].layers[0].v11GenericId,2);
  assert.equal(state.terrainState[1][4].layers[0].v11Hidden,true,'two buttons lower a base orange wall below its support');
  const a = room([actor('player',1,1),actor('orange_button',2,1)]);
  a.levelId='A'; a.terrain[1][4]=cell('orange_wall');
  const b = room([actor('player',0,1),actor('clone',2,1,{groupId:'M0'}),actor('weightless_box',4,2,{groupId:'M0'})]);
  b.levelId='B'; b.terrain[1][4]=cell('orange_wall');
  const composed = await versions.planWorldCommand({ currentLevelId:'A',currentRoom:a,rooms:{B:b},dx:1,dy:0,
    adjacentLevelId:(id,dx,dy)=>dy===0 && (id==='A'&&dx===1||id==='B'&&dx===-1) ? id==='A'?'B':'A':null,
    loadRoom:async id=>id==='B'?b:null,physicsTrace:false });
  assert.equal(composed.rooms.A.terrain[1][4].layers[0].v11GenericId,1);
  assert.equal(composed.rooms.B.terrain[1][4].layers[0].v11GenericId??0,0,'orange button pressure stays scoped to its source room');
  assert.equal(composed.rooms.B.actors[1].x,2,'remote clones do not receive the directional command');
  assert.equal(composed.rooms.B.actors[0].x,0,'inactive authored player positions are preserved');
  assert.equal(composed.ticks.length,0);
  assert.ok(composed.playerPath.length>0,'server receives a lightweight authoritative path');
  assert.throws(()=>versions.validateWorld([a,{...b,width:4}]),/matching dimensions/);
  assert.throws(()=>versions.validateWorld([room([actor("player",0,0),actor("circle_player",1,0)])]),/one main player/);
  assert.equal(versions.validateWorld([room([])]),true,"incomplete drafts may omit the main player");
  const overflow = Array.from({length:260},()=>room([],Array.from({length:16},()=>Array.from({length:16},()=>cell()))));
  assert.equal(versions.validateWorld(overflow),true,"large worlds use bounded per-command scenes");
  const oversizedRoom=room([],Array.from({length:256},()=>Array.from({length:256},()=>cell("tree"))));
  assert.throws(()=>versions.validateWorld([oversizedRoom]),/65,536/);
  const {getGame,getLevelState}=require('../server/app');
  const game=getGame('maze');
  const official=Object.fromEntries(game.worldMap.levels.map(level=>{const data=getLevelState(game,level);return [data.levelId,data];}));
  assert.equal(Object.keys(official).length,256);
  assert.equal(versions.validateWorld(official),true,'the official world uses supported native mechanics');
  const officialStart=Object.values(official).find(r=>r.actors.some(a=>a.type==='player'));
  let fetchCount=0;
  const adjacent=(id,dx,dy)=>{
    const match=/^level_([A-Z])x([A-Z])$/.exec(id); if(!match)return null;
    const next=`level_${String.fromCharCode(match[1].charCodeAt(0)+dx)}x${String.fromCharCode(match[2].charCodeAt(0)+dy)}`;
    return official[next]?next:null;
  };
  const officialMove=await versions.planWorldCommand({currentLevelId:officialStart.levelId,currentRoom:officialStart,dx:1,dy:0,physicsTrace:false,
    adjacentLevelId:adjacent,loadRoom:async id=>{fetchCount++;return official[id]||null;}});
  assert.ok(officialMove.currentRoom);
  assert.ok(fetchCount<20,'a main-world command loads only its reachable frontier, not all256rooms');
  assert.ok(officialMove.placements.length<20);
  const untouched={...b,actors:[actor('box',2,1,{elevation:3})]};
  const local=await versions.planWorldCommand({currentLevelId:'A',currentRoom:a,rooms:{B:untouched},dx:1,dy:0,physicsTrace:false,
    adjacentLevelId:(id,dx,dy)=>dy===0&&id==='A'&&dx===1?'B':null,loadRoom:async()=>{throw new Error('unreachable room should not load');}});
  assert.equal(local.rooms.B.actors[0].elevation,3,'unreached rooms do not advance gravity during another room command');
  console.log('Versioned engine tests passed.');
}
main().catch((error)=>{console.error(error);process.exitCode=1;});
