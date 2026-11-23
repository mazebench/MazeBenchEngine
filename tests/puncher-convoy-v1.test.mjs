import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { instantiateMazeBenchEngineV1 } from '../engine/v1/engine.mjs';

const blocks = [
  { id: 'floor', roleId: 'floor', visual: { kind: 'floor' } },
  { id: 'wall', roleId: 'solid', visual: { kind: 'cube' } },
  { id: 'player', roleId: 'player', visual: { kind: 'cube' } },
  { id: 'box', roleId: 'weightless-pushable', visual: { kind: 'cube' } },
  { id: 'puncher', roleId: 'puncher', visual: { kind: 'puncher' } }
];

for (const path of [
  '../engine/v1/voxel_physics.wasm',
  '../world-solver/v1/editor-solver.wasm',
  '../world-solver/v1/random-agent.wasm',
  '../solutions/v1/solutions-solver.wasm'
]) {
  test(`${path} transmits a body punch to the player in the same tick`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(path, import.meta.url)));
    const room = {
      width: 10, height: 10,
      objects: [
        { x: 3, y: 5, z: 0, blockId: 'player' },
        ...[3, 4, 5].map(x => ({ x, y: 4, z: 0, blockId: 'box', groupId: 17 })),
        { x: 5, y: 3, z: 0, blockId: 'puncher', orientation: 'down' },
        { x: 5, y: 2, z: 0, blockId: 'wall' },
        { x: 3, y: 9, z: 0, blockId: 'wall' },
        ...Array.from({ length: 100 }, (_, i) =>
          ({ x: i % 10, y: Math.floor(i / 10), z: 0, blockId: 'floor' }))
      ]
    };
    const result = await engine.simulateCommand(room, 'up', blocks);
    assert.equal(result.cycle, null);
    assert.deepEqual(result.frames.map(frame => frame.objects[0].y), [4, 5, 6, 7, 8]);
    for (const frame of result.frames) {
      assert(frame.objects.slice(1, 4).every(box => box.y === frame.objects[0].y - 1));
    }
    assert.deepEqual(result.frames.map(frame => frame.objects[4].stateId), [0, 1, 0, 0, 0]);
  });

  test(`${path} keeps an elevated puncher mounted when the punched body departs`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(path, import.meta.url)));
    const room = {
      width: 6, height: 6,
      objects: [
        { x: 3, y: 3, z: 0, blockId: 'player' },
        { x: 3, y: 1, z: 1, blockId: 'puncher', orientation: 'down' },
        ...[0, 1].map(z => ({ x: 3, y: 2, z, blockId: 'box', groupId: 17 })),
        ...[0, 1].map(z => ({ x: 3, y: 0, z, blockId: 'wall' })),
        { x: 3, y: 5, z: 0, blockId: 'wall' },
        ...Array.from({ length: 36 }, (_, i) =>
          ({ x: i % 6, y: Math.floor(i / 6), z: 0, blockId: 'floor' }))
      ]
    };
    const result = await engine.simulateCommand(room, 'up', blocks);
    assert.equal(result.cycle, null);
    assert.deepEqual(result.frames.map(frame => frame.objects[0].y), [2, 3, 4]);
    assert.deepEqual(result.frames.map(frame => frame.objects[1].stateId), [0, 1, 0]);
    for (const frame of result.frames) {
      const { x, y, z } = frame.objects[1];
      assert.deepEqual({ x, y, z }, { x: 3, y: 1, z: 1 });
      assert(frame.objects.slice(2, 4).every(box => box.y === frame.objects[0].y - 1));
    }
  });
}
