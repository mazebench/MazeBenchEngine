import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';

const blocks = [
  {id: 'floor', roleId: 'floor', visual: {kind: 'floor'}},
  {id: 'wall', roleId: 'solid', visual: {kind: 'cube'}},
  {id: 'ramp', roleId: 'ice', visual: {kind: 'slope'}},
  {id: 'player', roleId: 'player', visual: {kind: 'cube'}},
  {id: 'clone', roleId: 'clone', visual: {kind: 'cube'}},
  {id: 'box', roleId: 'weightless-pushable', visual: {kind: 'cube'}}
];
const directions = ['up', 'right', 'down', 'left'];
const dx = [0, 1, 0, -1];
const dy = [-1, 0, 1, 0];

function roomFrom(objects, rotation, reversed) {
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
    objects.push({x, y, z: 0, blockId: 'floor'});
  }
  for (const object of objects) for (let turn = 0; turn < rotation; turn++) {
    [object.x, object.y] = [5 - object.y, object.x];
  }
  return {width: 6, height: 6, objects: reversed ? objects.reverse() : objects};
}

for (const binary of ['engine/v1/voxel_physics.wasm', 'world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm', 'solutions/v1/solutions-solver.wasm']) {
  test(`${binary}: a clone can refill a carried player's old cell`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
    for (const blocked of [false, true]) for (const cargo of [false, true]) {
      for (const remoteSlope of [false, true]) for (let rotation = 0; rotation < 4; rotation++) {
        for (const reversed of [false, true]) {
          const objects = [
            {x: 0, y: 4, z: 0, blockId: 'clone', genericId: 29, groupId: 29},
            {x: 0, y: 5, z: 0, blockId: 'clone', genericId: 29, groupId: 29},
            {x: 0, y: 5, z: 1, blockId: 'clone', genericId: 29, groupId: 29},
            {x: 0, y: 4, z: 1, blockId: 'player'}
          ];
          if (cargo) objects.push({x: 0, y: 4, z: 2, blockId: 'box', genericId: 71, groupId: 71});
          if (blocked) objects.push({x: 0, y: 3, z: 1, blockId: 'wall'});
          if (remoteSlope) objects.push({x: 5, y: 0, z: 0, blockId: 'ramp', orientation: directions[rotation]});
          const room = roomFrom(objects, rotation, reversed);
          const expected = room.objects.map(object => !blocked && ['player', 'clone', 'box'].includes(object.blockId)
            ? {...object, x: object.x + dx[rotation], y: object.y + dy[rotation]} : object);
          const result = await engine.simulateCommand(room, directions[rotation], blocks);
          const context = `${directions[rotation]}, blocked=${blocked}, cargo=${cargo}, remoteSlope=${remoteSlope}, reversed=${reversed}`;
          assert.equal(result.cycle, null, context);
          assert.equal(result.frames.length, 1, context);
          assert.deepEqual(result.frames[0].objects, expected, context);
          assert.deepEqual(result.final.objects, expected, context);
        }
      }
    }
  });

  test(`${binary}: a clone cannot walk onto cargo departing with the player`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
    for (const height of [1, 2]) for (let rotation = 0; rotation < 4; rotation++) {
      for (const reversed of [false, true]) {
        const objects = [
          {x: 3, y: 3, z: 0, blockId: 'player'},
          {x: 3, y: 3, z: 1, blockId: 'box', genericId: 71, groupId: 71},
          {x: 3, y: 4, z: height, blockId: 'clone', genericId: 29, groupId: 29}
        ];
        for (let z = 0; z < height; z++) objects.push({x: 3, y: 4, z, blockId: 'wall'});
        const room = roomFrom(objects, rotation, reversed);
        const expected = room.objects.map(object => ['player', 'box'].includes(object.blockId)
          ? {...object, x: object.x + dx[rotation], y: object.y + dy[rotation]} : object);
        const result = await engine.simulateCommand(room, directions[rotation], blocks);
        const context = `${directions[rotation]}, height=${height}, reversed=${reversed}`;
        assert.equal(result.cycle, null, context);
        assert.equal(result.frames.length, 1, context);
        assert.deepEqual(result.frames[0].objects, expected, context);
        assert.deepEqual(result.final.objects, expected, context);
      }
    }
  });

  test(`${binary}: a clone carries the player's cargo through flat and ramp steps`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
    for (const ramp of [false, true]) for (const cargo of [1, 2]) {
      for (let rotation = 0; rotation < 4; rotation++) for (const reversed of [false, true]) {
        const objects = [
          {x: 2, y: 3, z: 0, blockId: 'clone', genericId: 29, groupId: 29},
          {x: 2, y: 3, z: 1, blockId: 'player'}
        ];
        for (let i = 0; i < cargo; i++) objects.push({x: 2, y: 3, z: 2 + i,
          blockId: 'box', genericId: 71 + i, groupId: 71 + i});
        if (ramp) objects.push(
          {x: 2, y: 2, z: 0, blockId: 'ramp', orientation: directions[rotation]},
          {x: 2, y: 1, z: 0, blockId: 'wall'}
        );
        const room = roomFrom(objects, rotation, reversed);
        const result = await engine.simulateCommand(room, directions[rotation], blocks);
        const context = `${directions[rotation]}, ramp=${ramp}, cargo=${cargo}, reversed=${reversed}`;
        assert.equal(result.cycle, null, context);
        assert.equal(result.frames.length, ramp ? 2 : 1, context);
        result.frames.forEach((frame, index) => assert.deepEqual(frame.objects,
          room.objects.map(object => ['player', 'clone', 'box'].includes(object.blockId)
            ? {...object, x: object.x + dx[rotation] * (index + 1),
              y: object.y + dy[rotation] * (index + 1), z: object.z + Number(ramp)} : object),
          `${context}, tick=${index + 1}`));
        assert.deepEqual(result.final.objects, result.frames.at(-1).objects, context);
      }
    }
  });
}
