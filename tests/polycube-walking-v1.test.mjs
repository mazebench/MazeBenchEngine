import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';
import {V2_BLOCK_CATALOG, decodeVoxelRoom} from '../render/v1/voxel-world-v2.mjs';
import {ConnectedWorldSessionV1} from '../play/v1/connected-world-session.mjs';

const room = decodeVoxelRoom(JSON.parse(await readFile(
  new URL('./fixtures/axp-polycube-walking.json', import.meta.url), 'utf8')));
const body = state => state.objects.filter(o => o.groupId === 3);
const player = state => {
  const {x, y, z} = state.objects.find(o => o.blockId === 'player');
  return [x, y, z];
};

for (const binary of ['engine/v1/voxel_physics.wasm', 'world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm', 'solutions/v1/solutions-solver.wasm']) {
  test(`${binary}: AxP Right pushes group 3, then Up walks on it without moving it`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
    const right = await engine.simulateCommand(room, 'right', V2_BLOCK_CATALOG);
    assert.equal(right.frames.length, 1);
    assert.deepEqual(player(right.final), [9, 12, 7]);
    assert.deepEqual(body(right.final), body(room).map(o => ({...o, x: o.x + 1})));
    const up = await engine.simulateCommand(right.final, 'up', V2_BLOCK_CATALOG);
    assert.equal(up.frames.length, 1);
    assert.equal(up.cycle, null);
    assert.deepEqual(player(up.final), [9, 11, 7]);
    assert.deepEqual(up.final.objects, right.final.objects.map(o =>
      o.blockId === 'player' ? {...o, y: o.y - 1} : o));
    assert.deepEqual(body(up.final), body(right.final));
  });
}

test('connected-world AxP playback leaves the supporting group 3 still on Up', async () => {
  const engine = await instantiateMazeBenchEngineV1(await readFile(
    new URL('../engine/v1/voxel_physics.wasm', import.meta.url)));
  const active = {...room, fileName: 'axp.json', position: ['A', 'P'], columnIndex: 0, rowIndex: 0};
  const session = new ConnectedWorldSessionV1(engine, V2_BLOCK_CATALOG, [active]);
  const right = await session.simulateCommand(engine.createState(active), active, 'right');
  const up = await session.simulateCommand(right.final, active, 'up');
  assert.equal(up.frames.length, 1);
  assert.deepEqual(player(up.final), [9, 11, 7]);
  assert.deepEqual(body(up.final), body(right.final));
});
