import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';
import {ConnectedWorldSessionV1} from '../play/v1/connected-world-session.mjs';
import {PlaySessionV1} from '../play/v1/play-session.mjs';

const blocks = [
  {id: 'floor', roleId: 'floor', visual: {kind: 'floor'}},
  {id: 'ice', roleId: 'ice', visual: {kind: 'floor'}},
  {id: 'wall', roleId: 'solid', visual: {kind: 'cube'}},
  {id: 'puncher', roleId: 'puncher', visual: {kind: 'cube'}},
  {id: 'player', roleId: 'player', visual: {kind: 'cube'}},
  {id: 'clone', roleId: 'clone', visual: {kind: 'cube'}},
  {id: 'clone-slope', roleId: 'clone', visual: {kind: 'slope'}}
];
const directions = ['up', 'right', 'down', 'left'];
const binaries = ['engine/v1/voxel_physics.wasm', 'world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm', 'solutions/v1/solutions-solver.wasm'];
const load = async binary => instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
const player = state => state.objects.find(o => o.blockId === 'player');
const clones = state => state.objects.filter(o => o.blockId.startsWith('clone'));
const position = o => [o.x, o.y, o.z];
const floor = () => Array.from({length: 36}, (_, i) => ({x: i % 6, y: Math.floor(i / 6), z: 0, blockId: 'floor'}));
const clone = (id, x, y, blockId = 'clone') => ({x, y, z: 0, blockId, genericId: 0, groupId: 0,
  instanceId: id, ...(blockId === 'clone-slope' ? {orientation: 'up'} : {})});
const room = (fileName, columnIndex, objects) => ({fileName, columnIndex, rowIndex: 1,
  width: 6, height: 6, objects: [...floor(), ...objects]});

function fixture(blockId = 'clone') {
  const source = room('source.json', 1, [{x: 5, y: 2, z: 0, blockId: 'player'},
    clone('source-a', 1, 4, blockId), clone('source-b', 1, 5, blockId)]);
  const destination = room('destination.json', 2, [{x: 3, y: 0, z: 0, blockId: 'player'},
    clone('destination-a', 1, 4, blockId), clone('destination-b', 1, 5, blockId)]);
  return {source, destination};
}

function rotate(room) {
  [room.columnIndex, room.rowIndex] = [2 - room.rowIndex, room.columnIndex];
  for (const o of room.objects) {
    [o.x, o.y] = [5 - o.y, o.x];
    if (o.orientation) o.orientation = directions[(directions.indexOf(o.orientation) + 1) % 4];
  }
}

function assertClean(state) {
  assert.ok(state.objects.every(o => !Object.keys(o).some(key => key.startsWith('connectedWorld'))),
    'command ownership and temporary body IDs must not enter room state');
  assert.ok(clones(state).every(o => o.genericId === 0 && o.groupId === 0), 'retain authored clone IDs');
}

// Observe the actual unprojected canonical trace too: originating clones must
// receive the command even when the player leaves their room on its first tick.
function captureEngine(engine) {
  const traces = [];
  return {traces, createState: room => engine.createState(room),
    simulateCommand: async (...args) => {
      const result = await engine.simulateCommand(...args);
      traces.push({start: args[0], ...result});
      return result;
    }};
}

for (const binary of binaries) {
  test(`${binary}: only the starting room's clones receive a crossing command`, async () => {
    const native = await load(binary);
    for (const blockId of ['clone', 'clone-slope']) for (let turns = 0; turns < 4; ++turns) {
      const {source, destination} = fixture(blockId);
      for (let i = 0; i < turns; ++i) {rotate(source); rotate(destination);}
      const engine = captureEngine(native);
      const world = new ConnectedWorldSessionV1(engine, blocks, [source, destination]);
      const direction = directions[(turns + 1) % 4];
      const result = await world.simulateCommand(native.createState(source), source, direction);
      assert.equal(result.room, destination);
      assert.equal(result.cycle, null);
      assert.deepEqual(clones(result.final), clones(destination));
      result.frames.forEach(assertClean);
      const trace = engine.traces.at(-1);
      const [dx, dy] = [[1, 0], [0, 1], [-1, 0], [0, -1]][turns];
      for (const start of clones(trace.start)) {
        const final = trace.final.objects.find(o => o.instanceId === start.instanceId);
        const origin = start.instanceId.startsWith('source');
        assert.deepEqual(position(final), [start.x + (origin ? dx : 0), start.y + (origin ? dy : 0), start.z]);
      }
    }
  });
}

test('an arriving player is blocked by a destination clone that must not walk out of the way', async () => {
  const engine = await load(binaries[0]), {source, destination} = fixture();
  destination.objects = destination.objects.filter(o => !o.blockId.startsWith('clone'));
  destination.objects.push(clone('blocking-clone', 0, 2));
  const world = new ConnectedWorldSessionV1(engine, blocks, [source, destination]);
  const result = await world.simulateCommand(engine.createState(source), source, 'right');
  assert.equal(result.room, source);
  assert.deepEqual(position(player(result.final)), [5, 2, 0]);
  assert.deepEqual(clones(result.final), clones(source).map(o => ({...o, x: o.x + 1})));
  assertClean(result.final);
});

test('destination clones activate on the next command and undo restores exact crossing snapshots', async () => {
  const engine = await load(binaries[0]), {source, destination} = fixture();
  const world = new ConnectedWorldSessionV1(engine, blocks, [source, destination]);
  const session = new PlaySessionV1(engine, blocks, {frameDelay: 0,
    resolveCommand: (...args) => world.simulateCommand(...args)});
  session.open(source);
  const before = structuredClone(session.state);
  await session.move('right');
  const entered = structuredClone(session.state);
  assert.deepEqual(clones(entered), clones(destination));
  await session.move('right');
  assert.deepEqual(clones(session.state), clones(destination).map(o => ({...o, x: o.x + 1})));
  assertClean(session.state);
  assert.equal(session.undo(), true);
  assert.equal(session.room, destination);
  assert.deepEqual(session.state, entered);
  assert.equal(session.undo(), true);
  assert.equal(session.room, source);
  assert.deepEqual(session.state, before);
  await session.move('right');
  await session.move('left');
  assert.equal(session.room, source);
  assert.deepEqual(clones(session.state), clones(source), 're-entry resets the old room without replaying input on its clones');
  assertClean(session.state);
});

test('one slide through three rooms keeps all newly entered clones still on every tick', async () => {
  const native = await load(binaries[0]), engine = captureEngine(native);
  const rooms = [0, 1, 2].map(i => room(`${i}.json`, i, [
    {x: 0, y: 2, z: 0, blockId: 'player'}, clone(`room-${i}`, 1, 4)]));
  rooms.forEach((r, i) => r.objects.forEach(o => {
    if (o.blockId === 'floor' && o.y === 2 && !(i === 0 && o.x === 0) && !(i === 2 && o.x === 5)) o.blockId = 'ice';
  }));
  const world = new ConnectedWorldSessionV1(engine, blocks, rooms);
  const result = await world.simulateCommand(native.createState(rooms[0]), rooms[0], 'right');
  assert.equal(result.room, rooms[2]);
  assert.deepEqual(result.connectedRooms, rooms.map(r => r.fileName));
  const trace = engine.traces.at(-1);
  for (const frame of trace.frames) for (const start of clones(trace.start)) {
    const current = frame.objects.find(o => o.instanceId === start.instanceId);
    assert.deepEqual(position(current), [start.x + (start.instanceId === 'room-0' ? 1 : 0), start.y, start.z]);
  }
  for (const frame of result.animationFrames) {
    assertClean(frame.state);
    if (frame.room !== rooms[0]) assert.deepEqual(clones(frame.state), clones(frame.room));
  }
});

test('a redirected punch across three rooms keeps clone input in the original room', async () => {
  const native = await load(binaries[0]), engine = captureEngine(native);
  const source = {...room('punch-source.json', 0, [
    {x: 1, y: 2, z: 0, blockId: 'player'}, clone('source', 4, 4),
    {x: 1, y: 1, z: 0, blockId: 'puncher', orientation: 'right', stateId: 0}
  ]), rowIndex: 0};
  const middle = {...room('punch-middle.json', 1, [
    clone('middle', 4, 4),
    {x: 2, y: 1, z: 0, blockId: 'puncher', orientation: 'down', stateId: 0}
  ]), rowIndex: 0};
  const last = room('punch-last.json', 1, [clone('last', 4, 4),
    {x: 2, y: 5, z: 0, blockId: 'wall'}]);
  const world = new ConnectedWorldSessionV1(engine, blocks, [source, middle, last]);
  const result = await world.simulateCommand(native.createState(source), source, 'up');
  assert.equal(result.room, last);
  assert.deepEqual(position(player(result.final)), [2, 4, 0]);
  assert.deepEqual(result.connectedRooms, [source, middle, last].map(r => r.fileName));
  const trace = engine.traces.at(-1);
  for (const frame of trace.frames) for (const start of clones(trace.start)) {
    const current = frame.objects.find(o => o.instanceId === start.instanceId);
    assert.deepEqual(position(current), [start.x, start.y - (start.instanceId === 'source' ? 1 : 0), start.z]);
  }
  result.frames.forEach(assertClean);
});
