import assert from 'node:assert/strict';
import {copyFile, mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {buildRuntimeRelease} from '../benchmarking/runtime-release-store.mjs';
import {CurrentVersions} from '../benchmarking/current-version.mjs';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';
import {ConnectedWorldSessionV1} from '../play/v1/connected-world-session.mjs';
import {SolutionsModel, worldFingerprint} from '../solutions/v1/model.mjs';
import {compileFullSolution} from '../solutions/v1/full-solution.mjs';
import {planRoute} from '../solutions/v1/route-search.mjs';
import {searchRoute} from '../solutions/v1/search.mjs';
import {BenchmarkGameRuntime} from '../benchmarking/v1/runtime.mjs';
import {VisionRuntime} from '../benchmarking/vision/runtime.mjs';
import {createRunIntegrity} from '../benchmarking/v1/integrity.mjs';
import {runRandomAgentV1} from '../world-solver/v1/random-agent.mjs';

const root = path.resolve(import.meta.dirname, '..');
const blocks = [
  {id:'floor', roleId:'floor', visual:{kind:'floor'}},
  {id:'ice', roleId:'ice', visual:{kind:'floor'}},
  {id:'wall', roleId:'solid', visual:{kind:'cube'}},
  {id:'puncher', roleId:'puncher', visual:{kind:'puncher'}},
  {id:'player', roleId:'player', visual:{kind:'cube'}},
  {id:'gem', roleId:'goal', visual:{kind:'model'}}
];
const names = ['a.json', 'b.json', 'c.json', 'd.json'];
const load = async (binary='engine/v1/voxel_physics.wasm') =>
  instantiateMazeBenchEngineV1(await readFile(path.join(root, binary)));

function corridor(kind='ice') {
  const rooms = names.map((fileName, i) => {
    const objects = [{blockId:'player', x:1, y:1, z:0}];
    for (let y=0; y<3; y++) for (let x=0; x<4; x++) {
      const stop = (i===0 && x===1) || (i===3 && x===2);
      objects.push({blockId:kind==='ice' && y===1 && !stop ? 'ice' : 'floor', x, y, z:0});
      if (y!==1 || (i===3 && x===3)) objects.push({blockId:'wall', x, y, z:0});
    }
    if (i===0 && kind==='punch') objects.push({blockId:'puncher', x:2, y:1, z:0, orientation:'right', stateId:0});
    return {fileName, position:[['H','I','J','K'][i],'I'], columnIndex:i, rowIndex:0, width:4, height:3, objects};
  });
  return {blocks, rooms, columns:['H','I','J','K'], rows:['I'], roomWidth:4, roomHeight:3};
}

async function model(world=corridor()) {
  return new SolutionsModel(await load(), world, await worldFingerprint(world));
}

function onlyEndsVisited(m) {
  assert.deepEqual(m.snapshot().visitedRooms, ['a.json','d.json']);
  assert.deepEqual([...m.verifiedRooms], ['a.json','d.json']);
  assert.deepEqual([...m.roomProofs.keys()], ['a.json','d.json']);
  assert.deepEqual(m.snapshot().roomProgress.map(r=>r.visited), [true,false,false,true]);
  for (const file of ['b.json','c.json']) {
    assert.equal(m.snapshot().spots.find(s=>s.id===`start:${file}`).accessible, false);
    assert.throws(()=>m.resume(`start:${file}`), /visited room/);
    assert(!m.export().spawnSetups.some(s=>s.room===file));
  }
  assert.deepEqual(m.routes.flatMap(r=>r.crossings.map(c=>c.room)), ['d.json']);
  const entrances = m.snapshot().spots.filter(s=>s.kind==='entrance');
  assert.equal(entrances.length, 1);
  assert.equal(entrances[0].room, 'd.json');
  assert.equal(entrances[0].accessible, true);
}

for (const kind of ['ice','punch']) {
  test(`Solutions: a four-room ${kind} visits only its settled destination, preserving playback and undo`, async () => {
    const m = await model(corridor(kind)), before = m.save(), frames = [];
    await m.move('right', frame=>frames.push(frame));
    assert.equal(m.current.room, 'd.json');
    assert.deepEqual(m.position(m.current.state), {x:2,y:1,z:0});
    assert.deepEqual([...new Set(frames.map(f=>f.room))], names);
    onlyEndsVisited(m);
    const entrance = m.source;
    assert.deepEqual(m.spots.get(entrance).entry, {x:0,y:1,z:0});
    assert.deepEqual((await compileFullSolution(m)).rooms, ['a.json','d.json']);

    const restored = await model(corridor(kind));
    await restored.restore(m.save());
    onlyEndsVisited(restored);
    await restored.undo();
    assert.deepEqual(restored.save(), before);
    assert.deepEqual(restored.snapshot().visitedRooms, ['a.json']);

    m.resume('start:d.json');
    assert.deepEqual(m.position(m.current.state), {x:1,y:1,z:0});
    m.resume(entrance);
    assert.deepEqual(m.position(m.current.state), {x:2,y:1,z:0});
  });
}

test('Solutions import rebuilds visitation instead of trusting legacy transit-room unlocks', async () => {
  const m = await model();
  await m.move('right');
  const saved = m.export();
  saved.roomProofs['b.json'] = ['right'];
  saved.roomProofs['c.json'] = ['right'];
  const imported = await model();
  await imported.importJSON(JSON.stringify(saved));
  onlyEndsVisited(imported);

  // An older file could contain a branch from an incorrectly unlocked start.
  // Repair skips that spawn and continues at the actual settled destination.
  saved.routes.push({from:'start:b.json', actions:['right'], label:'Old transit branch', start:{reset:true}});
  const repaired = await model();
  const result = await repaired.importJSON(JSON.stringify(saved));
  assert(result.warnings.count>=1);
  assert.match(result.warnings.examples.join(' '), /invalid saved spawn/);
  assert.equal(repaired.current.room, 'd.json');
  onlyEndsVisited(repaired);
});

test('a previously visited intermediate room stays unlocked, while a never-settled one stays locked', async () => {
  const world = corridor();
  world.rooms[1].objects.find(o=>o.blockId==='ice' && o.x===2 && o.y===1).blockId = 'floor';
  const m = await model(world);
  await m.move('right');
  assert.equal(m.current.room, 'b.json');
  await m.move('right');
  assert.equal(m.current.room, 'd.json');
  assert.deepEqual(m.snapshot().visitedRooms, ['a.json','b.json','d.json']);
  assert.equal(m.canResume('start:b.json'), true);
  assert.equal(m.canResume('start:c.json'), false);
});

test('both new-room searches require a settled room, not a room passed through on the way to a visited endpoint', async () => {
  const m = await model();
  await m.move('right');
  m.resume('start:a.json');
  const before = m.save();
  for (const search of [()=>searchRoute(m,{kind:'room'}), async()=>planRoute(m,await load('solutions/v1/solutions-solver.wasm'),{kind:'room'})]) {
    const result = await search();
    assert.equal(result.status, 'exhausted');
    assert.deepEqual(result.actions, []);
    assert.deepEqual(m.save(), before);
  }
});

test('full solution cannot use an intermediate room start until a command actually finishes there', async () => {
  const m = await model();
  await m.move('right');
  // Keep a legacy inaccessible branch for reporting, without making it legal.
  m.restoreSpot('start:b.json');
  await m.applyRoute(['right']);
  const full = await compileFullSolution(m);
  assert.equal(full.complete, false);
  assert.deepEqual(full.commands, ['right']);
  assert.deepEqual(full.rooms, ['a.json','d.json']);
  assert.equal(full.blockedRuns.length, 1);
  assert.match(full.blockedRuns[0].reason, /Visit I×I/);
});

async function runtime(t, Runtime, world, projectRoot = root) {
  const directory = await mkdtemp(path.join(os.tmpdir(),'maze-settled-visits-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await createRunIntegrity(projectRoot,directory,{model:'fixture',tools_enabled:false});
  const r = await Runtime.create(projectRoot,directory,{actionLimit:30});
  const definitions = new Map(blocks.map(b=>[b.id,b]));
  r.assets = {...r.assets, blocks, definitions, rooms:world.rooms,
    roomsByFile:new Map(world.rooms.map(room=>[room.fileName,room])),
    roomsByLabel:new Map(world.rooms.map(room=>[room.position.join('X'),room])),
    roomWidth:4, roomHeight:3, connectedWorld:new ConnectedWorldSessionV1(r.assets.engine,definitions,world.rooms)};
  const state = r.assets.engine.createState(world.rooms[0]);
  Object.assign(r.internal,{roomFile:'a.json',state,roomEntryState:structuredClone(state),visitedRooms:['a.json'],
    roomEntryStates:{'a.json':structuredClone(state)},gemsCollected:[]});
  return r;
}

for (const Runtime of [BenchmarkGameRuntime,VisionRuntime]) for (const kind of ['ice','punch']) {
  test(`${Runtime.name}: ${kind} playback and heatmaps retain intermediate rooms without unlocking their starts`, async t => {
    const r = await runtime(t,Runtime,corridor(kind));
    const result = await r.apply('right');
    assert.equal(result.action.roomAfter, 'KxI');
    assert.deepEqual(r.internal.visitedRooms, ['a.json','d.json']);
    assert.deepEqual(Object.keys(r.internal.roomEntryStates), ['a.json','d.json']);
    assert.equal(result.observation.rooms_visited, 2);
    assert.deepEqual(result.observation.visited_rooms, ['HxI','KxI']);
    const index = JSON.parse((await r.readRecord(result.action.animation.index_record)).content);
    assert.deepEqual([...new Set(index.frames.map(f=>f.room))], ['HxI','IxI','JxI','KxI']);
    assert(r.internal.actions[0].traversedPositions.some(p=>p.worldX>=4 && p.worldX<12));
    for (const label of ['IxI','JxI']) await assert.rejects(r.apply(`room ${label}`), /has not been visited/);
    await r.apply('undo');
    assert.equal(r.internal.roomFile, 'a.json');
    assert.deepEqual(r.internal.visitedRooms, ['a.json','d.json']);
    await r.apply('room KxI');
    assert.deepEqual(r.internal.state.objects.filter(o=>o.blockId==='player').map(o=>[o.x,o.y,o.z]), [[1,1,0]]);
  });
}

for (const kind of ['ice','punch']) {
  test(`Random Agent: a continuous ${kind} paints its path but reaches only the destination room`, async () => {
    const progress = [];
    const result = await runRandomAgentV1(await load('world-solver/v1/random-agent.wasm'),corridor(kind),
      {maximumActions:1,seed:1,onProgress:message=>progress.push(message)});
    assert.equal(result.currentRoom, 'K×I');
    assert.equal(result.rooms, 2);
    assert.deepEqual(progress.flatMap(p=>p.reachedRooms).map(r=>r.fileName), ['a.json','d.json']);
    assert(progress.flatMap(p=>p.visitedCells).some(index=>index%16>=4 && index%16<12));
  });
}

test('Main World release keeps a fatal first arrival locked in ASCII and vision', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-visitation-release-'));
  t.after(() => rm(temp, {recursive:true, force:true}));
  const registryPath = path.join(temp, 'registry.mjs');
  await copyFile(path.join(root, 'benchmarking/version-registry.mjs'), registryPath);
  const release = await buildRuntimeRelease(root, {installRoot:temp, registryPath});
  assert.equal(new CurrentVersions(root, {file:registryPath}).read().benchmark.version, release.version);
  for (const [entry, name] of [['v1/runtime.mjs', 'BenchmarkGameRuntime'], ['vision/runtime.mjs', 'VisionRuntime']]) {
    await t.test(name, async t => {
      const { [name]: Runtime } = await import(pathToFileURL(path.join(release.root, 'benchmarking', entry)));
      const world = corridor('floor');
      world.rooms[0].objects.find(o => o.blockId === 'player').x = 3;
      // The right edge leads into a pit. The row above provides a safe crossing.
      for (const room of world.rooms) {
        room.objects = room.objects.filter(o => !(o.blockId === 'wall' && o.y === 0));
      }
      world.rooms[1].objects = world.rooms[1].objects.filter(o => !(o.x === 0 && o.y === 1));
      const r = await runtime(t, Runtime, world, release.root);
      const fatal = await r.apply('right');
      assert.equal(fatal.action.roomAfter, 'IxI');
      assert.equal(fatal.action.died, true);
      assert.deepEqual(fatal.observation.visited_rooms, ['HxI']);
      assert.equal(r.internal.roomEntryStates['b.json'], undefined);
      await assert.rejects(r.apply('room IxI'), /has not been visited/);
      assert.equal((await r.apply('reset')).observation.game_status, 'dead');
      await assert.rejects(r.apply('room IxI'), /has not been visited/);
      assert.equal((await r.apply('undo')).observation.room, 'HxI');
      await r.apply('up');
      const safe = await r.apply('right');
      assert.deepEqual(safe.observation.visited_rooms, ['HxI', 'IxI']);
      const entryState = structuredClone(r.internal.roomEntryStates['b.json']);
      await r.apply('room HxI');
      assert.equal((await r.apply('right')).action.died, true);
      assert.deepEqual(r.internal.roomEntryStates['b.json'], entryState);
      assert.equal((await r.apply('room IxI')).observation.game_status, 'playing');
    });
  }
});
