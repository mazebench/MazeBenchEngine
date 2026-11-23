import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';

const blocks = [
  {id: 'floor', roleId: 'floor', visual: {kind: 'floor'}},
  {id: 'wall', roleId: 'solid', visual: {kind: 'cube'}},
  {id: 'ramp', roleId: 'ice', visual: {kind: 'slope'}},
  {id: 'player', roleId: 'player', visual: {kind: 'cube'}},
  {id: 'clone', roleId: 'clone', visual: {kind: 'cube'}}
];
const directions = ['up', 'right', 'down', 'left'];
const dx = [0, 1, 0, -1];
const dy = [-1, 0, 1, 0];

function scene(clone, blocked, layers, rotation, reversed) {
  const objects = clone ? [{x: 0, y: 5, z: 0, blockId: 'player'}] : [];
  for (let z = 0; z < layers; z++) for (const x of [2, 3]) objects.push({
    x, y: 3, z, blockId: clone ? 'clone' : 'player',
    ...(clone ? {genericId: 29, groupId: 29} : {})
  });
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) objects.push({x, y, z: 0, blockId: 'floor'});
  objects.push(
    {x: 2, y: 2, z: 0, blockId: blocked ? 'wall' : 'ramp',
      ...(blocked ? {} : {orientation: directions[rotation]})},
    {x: 3, y: 2, z: 0, blockId: 'ramp', orientation: directions[rotation]},
    {x: 2, y: 1, z: 0, blockId: 'wall'},
    {x: 3, y: 1, z: 0, blockId: 'wall'}
  );
  for (const object of objects) for (let turn = 0; turn < rotation; turn++) {
    [object.x, object.y] = [5 - object.y, object.x];
  }
  return {width: 6, height: 6, objects: reversed ? objects.reverse() : objects};
}

for (const binary of ['engine/v1/voxel_physics.wasm', 'world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm', 'solutions/v1/solutions-solver.wasm']) {
  test(`${binary}: wide actors cannot climb a wall beside a ramp`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
    for (const clone of [false, true]) for (const blocked of [false, true]) {
      for (const layers of [1, 2]) for (let rotation = 0; rotation < 4; rotation++) {
        for (const reversed of [false, true]) {
          const room = scene(clone, blocked, layers, rotation, reversed);
          const result = await engine.simulateCommand(room, directions[rotation], blocks);
          const context = `${clone ? 'clone' : 'player'}, blocked=${blocked}, layers=${layers}, ${directions[rotation]}, reversed=${reversed}`;
          const expected = tick => room.objects.map(object => {
            if (!['player', 'clone'].includes(object.blockId)) return object;
            const independentPlayer = clone && object.blockId === 'player';
            const distance = independentPlayer ? 1 : blocked ? 0 : tick;
            return {...object, x: object.x + dx[rotation] * distance,
              y: object.y + dy[rotation] * distance,
              z: object.z + Number(!independentPlayer && !blocked)};
          });
          assert.equal(result.cycle, null, context);
          const ticks = blocked ? 1 : 2;
          assert.equal(result.frames.length, ticks, context);
          result.frames.forEach((frame, index) => assert.deepEqual(frame.objects, expected(index + 1), `${context}, tick=${index + 1}`));
          assert.deepEqual(result.final.objects, expected(ticks), context);
        }
      }
    }
  });
}
