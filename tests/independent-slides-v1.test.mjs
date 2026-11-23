import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';

const blocks = [
  {id: 'floor', roleId: 'floor', visual: {kind: 'floor'}},
  {id: 'ice', roleId: 'ice', visual: {kind: 'floor'}},
  {id: 'wall', roleId: 'solid', visual: {kind: 'cube'}},
  {id: 'ramp', roleId: 'ice', visual: {kind: 'slope'}},
  {id: 'player', roleId: 'player', visual: {kind: 'cube'}},
  {id: 'clone', roleId: 'clone', visual: {kind: 'cube'}}
];
const directions = ['up', 'right', 'down', 'left'];

function scene(ramps, swapped, rotation, reversed) {
  const actor = (x, blockId) => ({x, y: 5, z: 0, blockId,
    ...(blockId === 'clone' ? {genericId: 71, groupId: 71} : {})});
  const objects = [actor(0, swapped ? 'clone' : 'player'), actor(3, swapped ? 'player' : 'clone')];
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
    const icy = !ramps && ((x === 0 && [3, 4].includes(y)) || (x === 3 && y === 4));
    objects.push({x, y, z: 0, blockId: icy ? 'ice' : 'floor'});
  }
  objects.push({x: 3, y: 3, z: 0, blockId: 'wall'});
  if (ramps) objects.push(
    {x: 0, y: 4, z: 0, blockId: 'ramp', orientation: directions[rotation]},
    {x: 0, y: 3, z: 0, blockId: 'ramp', orientation: directions[(rotation + 2) % 4]},
    {x: 3, y: 4, z: 0, blockId: 'ramp', orientation: directions[rotation]}
  );
  for (const object of objects) for (let turn = 0; turn < rotation; turn++) {
    [object.x, object.y] = [5 - object.y, object.x];
  }
  return {width: 6, height: 6, objects: reversed ? objects.reverse() : objects};
}

for (const binary of ['engine/v1/voxel_physics.wasm', 'world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm', 'solutions/v1/solutions-solver.wasm']) {
  for (const ramps of [false, true]) {
    test(`${binary}: independent slides continue when another actor ${ramps ? 'lands on ordinary support' : 'hits a wall'}`, async () => {
      const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
      for (const swapped of [false, true]) for (let rotation = 0; rotation < 4; rotation++) {
        for (const reversed of [false, true]) {
          const room = scene(ramps, swapped, rotation, reversed);
          const result = await engine.simulateCommand(room, directions[rotation], blocks);
          const context = `${directions[rotation]}, stopped=${swapped ? 'player' : 'clone'}, reversed=${reversed}`;
          assert.equal(result.cycle, null, context);
          assert.equal(result.frames.length, 3, context);
          const expected = [1, 2, 3].map(tick => room.objects.map(object => {
            if (!['player', 'clone'].includes(object.blockId)) return object;
            const free = object.blockId === (swapped ? 'clone' : 'player');
            const distance = free ? tick : Math.min(tick, ramps ? 2 : 1);
            return {...object,
              x: object.x + [0, 1, 0, -1][rotation] * distance,
              y: object.y + [-1, 0, 1, 0][rotation] * distance,
              z: ramps && (!free || tick < 3) ? 1 : 0};
          }));
          result.frames.forEach((frame, tick) => assert.deepEqual(frame.objects, expected[tick], `${context}, tick ${tick + 1}`));
          assert.deepEqual(result.final.objects, expected.at(-1), context);
        }
      }
    });
  }
}
