import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';
import {ConnectedWorldSessionV1} from '../play/v1/connected-world-session.mjs';

const blocks = [
  {id: 'floor', roleId: 'floor', visual: {kind: 'floor'}},
  {id: 'ice', roleId: 'ice', visual: {kind: 'floor'}},
  {id: 'wall', roleId: 'solid', visual: {kind: 'cube'}},
  {id: 'player', roleId: 'player', visual: {kind: 'cube'}},
  {id: 'clone', roleId: 'clone', visual: {kind: 'cube'}},
  {id: 'box', roleId: 'pushable', visual: {kind: 'cube'}},
  {id: 'blue', roleId: 'weightless-pushable', visual: {kind: 'cube'}},
  {id: 'blue-slope', roleId: 'weightless-pushable', visual: {kind: 'slope'}},
  {id: 'puncher', roleId: 'puncher', visual: {kind: 'cube'}}
];
const directions = ['up', 'right', 'down', 'left'];
const binaries = ['engine/v1/voxel_physics.wasm', 'world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm', 'solutions/v1/solutions-solver.wasm'];
const object = (id, blockId, x, y, z = 0) => ({instanceId: id, blockId, x, y, z,
  ...(['clone', 'blue', 'blue-slope'].includes(blockId) ? {genericId: 0, groupId: 0} : {}),
  ...(blockId === 'blue-slope' ? {orientation: 'up'} : {})});
const room = (fileName, columnIndex, objects) => ({fileName, columnIndex, rowIndex: 0,
  width: 6, height: 6, objects: [...Array.from({length: 36}, (_, i) =>
    ({blockId: 'floor', x: i % 6, y: Math.floor(i / 6), z: 0})), ...objects]});
const find = (state, id) => state.objects.find(o => o.instanceId === id);
const position = o => [o.x, o.y, o.z];
const clean = state => assert.ok(state.objects.every(o =>
  !Object.keys(o).some(key => key.startsWith('connectedWorld'))));

function rotate(room) {
  [room.columnIndex, room.rowIndex] = [1 - room.rowIndex, room.columnIndex];
  for (const o of room.objects) {
    [o.x, o.y] = [5 - o.y, o.x];
    if (o.orientation) o.orientation = directions[(directions.indexOf(o.orientation) + 1) % 4];
  }
}

async function run(native, source, destination, direction = 'right') {
  const traces = [];
  const engine = {createState: r => native.createState(r), simulateCommand: async (...args) => {
    const result = await native.simulateCommand(...args);
    traces.push({start: args[0], ...result});
    return result;
  }};
  const world = new ConnectedWorldSessionV1(engine, blocks, [source, destination]);
  const result = await world.simulateCommand(native.createState(source), source, direction);
  assert.equal(result.room, destination);
  assert.equal(result.cycle, null);
  result.frames.forEach(clean);
  const trace = traces.at(-1);
  for (const frame of [...trace.frames, trace.final]) {
    trace.start.objects.forEach((start, i) => {
      const current = frame.objects[i];
      if (start.blockId === 'player' || current.x < 0 || current.y < 0) return;
      assert.deepEqual([Math.floor(current.x / 6), Math.floor(current.y / 6)],
        [Math.floor(start.x / 6), Math.floor(start.y / 6)],
        `${start.instanceId || start.blockId} must remain in its room on every tick`);
    });
  }
  return {result, trace};
}

for (const binary of binaries) {
  test(`${binary}: clones cannot push any box across a room seam`, async () => {
    const native = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
    for (const blockId of ['box', 'blue', 'blue-slope']) for (let turns = 0; turns < 4; ++turns) {
      const source = room('source', 0, [object('player', 'player', 5, 2),
        object('pusher', 'clone', 4, 4), object('pushed', blockId, 5, 4)]);
      const destination = room('destination', 1, [object('other-box', blockId, 3, 4)]);
      for (let i = 0; i < turns; ++i) {rotate(source); rotate(destination);}
      const {result, trace} = await run(native, source, destination, directions[(turns + 1) % 4]);
      for (const id of ['pusher', 'pushed']) {
        assert.deepEqual(position(find(trace.final, id)), position(find(trace.start, id)));
        assert.equal(find(result.final, id), undefined);
      }
      assert.deepEqual(find(result.final, 'other-box'), find(destination, 'other-box'));
    }
  });
}

test('clones themselves stop at the seam while the player crosses', async () => {
  const native = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binaries[0]}`, import.meta.url)));
  const source = room('source', 0, [object('player', 'player', 5, 2), object('clone', 'clone', 5, 4)]);
  const {result, trace} = await run(native, source, room('destination', 1, []));
  assert.deepEqual(position(find(trace.final, 'clone')), [5, 4, 0]);
  assert.equal(find(result.final, 'clone'), undefined);
  assert.deepEqual(position(find(result.final, 'player')), [0, 2, 0]);
});

test('a polycube touching a seam is blocked as a whole, without moving its other parts', async () => {
  const native = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binaries[0]}`, import.meta.url)));
  const source = room('source', 0, [object('player', 'player', 5, 2),
    object('clone', 'clone', 4, 4), object('front', 'blue', 5, 4), object('rear', 'blue', 4, 5)]);
  const {trace} = await run(native, source, room('destination', 1, []));
  for (const id of ['clone', 'front', 'rear']) {
    assert.deepEqual(position(find(trace.final, id)), position(find(trace.start, id)));
  }
});

test('a clone may push inside its own room without moving an equal-ID body in another room', async () => {
  const native = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binaries[0]}`, import.meta.url)));
  const source = room('source', 0, [object('player', 'player', 5, 2),
    object('clone', 'clone', 2, 4), object('pushed', 'blue', 3, 4)]);
  const destination = room('destination', 1, [object('other-box', 'blue', 3, 4)]);
  const {result, trace} = await run(native, source, destination);
  assert.deepEqual(position(find(trace.final, 'pushed')), [4, 4, 0]);
  assert.deepEqual(find(result.final, 'other-box'), find(destination, 'other-box'));
});

for (const blockId of ['box', 'blue', 'blue-slope', 'clone']) {
  test(`a sliding ${blockId} stays in its room even when the passage is open for the player`, async () => {
    const native = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binaries[0]}`, import.meta.url)));
    const source = room('source', 0, [object('player', 'player', 5, 2),
      ...(blockId === 'clone' ? [] : [object('pusher', 'clone', 2, 4)]),
      object('slider', blockId, blockId === 'clone' ? 2 : 3, 4)]);
    for (const o of source.objects) if (o.blockId === 'floor' && o.y === 4 && o.x >= 3) o.blockId = 'ice';
    const {result, trace} = await run(native, source, room('destination', 1, []));
    assert.equal(find(trace.final, 'slider').x, 5);
    assert.equal(find(result.final, 'slider'), undefined);
    assert.ok(trace.frames.length > 1, 'exercise continued momentum, not only the initial step');
  });
}

for (const blockId of ['box', 'blue', 'clone']) {
  test(`a player crossing cannot carry a ${blockId} into the next room`, async () => {
    const native = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binaries[0]}`, import.meta.url)));
    const source = room('source', 0, [object('player', 'player', 5, 2), object('passenger', blockId, 5, 2, 1)]);
    const {result, trace} = await run(native, source, room('destination', 1, []));
    assert.deepEqual([find(trace.final, 'passenger').x, find(trace.final, 'passenger').y], [5, 2]);
    assert.equal(find(result.final, 'passenger'), undefined);
  });
}

test('a player may enter by pushing a destination box further inside that same room', async () => {
  const native = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binaries[0]}`, import.meta.url)));
  const source = room('source', 0, [object('player', 'player', 5, 2)]);
  const destination = room('destination', 1, [object('box', 'box', 0, 2)]);
  const {result} = await run(native, source, destination);
  assert.deepEqual(position(find(result.final, 'player')), [0, 2, 0]);
  assert.deepEqual(position(find(result.final, 'box')), [1, 2, 0]);
});

test('a punched box cannot leave its room while the player enters a neighbor', async () => {
  const native = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binaries[0]}`, import.meta.url)));
  const source = room('source', 0, [object('player', 'player', 5, 2),
    object('box', 'box', 5, 4),
    {...object('puncher', 'puncher', 5, 4), orientation: 'right', stateId: 0}]);
  const {result, trace} = await run(native, source, room('destination', 1, []));
  assert.deepEqual(position(find(trace.final, 'box')), [5, 4, 0]);
  assert.ok(trace.frames.some(f => find(f, 'puncher').stateId === 1), 'punch must actually activate');
  assert.equal(find(result.final, 'box'), undefined);
});
