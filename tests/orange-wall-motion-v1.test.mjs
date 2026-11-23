import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { instantiateMazeBenchEngineV1 } from '../engine/v1/engine.mjs';

const blocks = [
  { id: 'floor', roleId: 'floor', visual: { kind: 'floor' } },
  { id: 'wall', roleId: 'solid', visual: { kind: 'cube' } },
  { id: 'player', roleId: 'player', visual: { kind: 'cube' } },
  { id: 'box', roleId: 'weightless-pushable', visual: { kind: 'cube' } },
  { id: 'orange-wall', roleId: 'orange-wall', visual: { kind: 'orange-wall' } },
  { id: 'button', roleId: 'orange-button', visual: { kind: 'button' } }
];
const floor = () => Array.from({ length: 35 }, (_, i) =>
  ({ x: i % 7, y: Math.floor(i / 7), z: 0, blockId: 'floor' }));
const matching = (state, blockId) => state.objects.filter(object => object.blockId === blockId);

for (const path of [
  '../engine/v1/voxel_physics.wasm',
  '../world-solver/v1/editor-solver.wasm',
  '../world-solver/v1/random-agent.wasm',
  '../solutions/v1/solutions-solver.wasm'
]) {
  test(`${path} raises and lowers a tall orange wall with a wide rider`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(path, import.meta.url)));
    let room = { width: 7, height: 5, objects: [
      { x: 0, y: 2, z: 0, blockId: 'player' },
      { x: 0, y: 1, z: 0, blockId: 'button', orientation: 'top' },
      ...[2, 3].flatMap(x => [
        ...[0, 1, 2].map(z => ({ x, y: 2, z, blockId: 'orange-wall', mechanismDepth: 0 })),
        { x, y: 2, z: 3, blockId: 'box', groupId: 17 }
      ]), ...floor()
    ] };
    for (const [direction, depth] of [['up', 1], ['down', 0]]) {
      const result = await engine.simulateCommand(room, direction, blocks);
      assert.equal(result.cycle, null);
      assert.equal(result.frames.length, 2);
      for (const frame of result.frames) {
        assert.equal(new Set(matching(frame, 'orange-wall').map(wall => wall.mechanismDepth)).size, 1);
      }
      assert(matching(result.final, 'orange-wall').every(wall => wall.mechanismDepth === depth));
      assert(matching(result.final, 'box').every(box => box.z === 3 - depth));
      room = result.final;
    }
  });

  test(`${path} stops a rising wall before its block carries the player into a ceiling`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(path, import.meta.url)));
    const room = { width: 7, height: 5, objects: [
      { x: 2, y: 2, z: 2, blockId: 'player' },
      { x: 2, y: 2, z: 2, blockId: 'button', orientation: 'top' },
      { x: 3, y: 2, z: 3, blockId: 'wall' },
      ...[2, 3].flatMap(x => [
        ...[-1, 0].map(z => ({ x, y: 2, z, blockId: 'orange-wall', mechanismDepth: 1 })),
        { x, y: 2, z: 1, blockId: 'box', groupId: 17 }
      ]), ...floor()
    ] };
    const result = await engine.simulateCommand(room, 'right', blocks);
    assert.equal(result.cycle, null);
    assert.equal(result.final.objects[0].x, 3);
    for (const frame of [...result.frames, result.final]) {
      assert.equal(frame.objects[0].z, 2);
      assert(matching(frame, 'orange-wall').every(wall => wall.mechanismDepth === 1));
      assert(matching(frame, 'box').every(box => box.z === 1));
    }
  });
}
