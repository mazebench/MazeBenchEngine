import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';

const blocks = [
  {id: 'floor', roleId: 'floor', visual: {kind: 'floor'}},
  {id: 'wall', roleId: 'solid', visual: {kind: 'cube'}},
  {id: 'player', roleId: 'player', visual: {kind: 'cube'}},
  {id: 'clone', roleId: 'clone', visual: {kind: 'cube'}},
  {id: 'clone-slope', roleId: 'clone', visual: {kind: 'slope'}},
  {id: 'gem', roleId: 'goal', visual: {kind: 'model'}}
];
const directions = ['up', 'right', 'down', 'left'];
const binaries = ['engine/v1/voxel_physics.wasm', 'world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm', 'solutions/v1/solutions-solver.wasm'];

for (const binary of binaries) {
  test(`${binary}: only players collect gems, including when clones touch another gem`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
    for (const orientation of [null, ...directions]) {
      for (let rotation = 0; rotation < 4; rotation++) for (const reversed of [false, true]) {
        const objects = [
          {x: 0, y: 2, z: 0, blockId: 'player'},
          {x: 2, y: 2, z: 0, blockId: orientation ? 'clone-slope' : 'clone',
            genericId: 71, groupId: 71, ...(orientation ? {orientation} : {})},
          {x: 0, y: 1, z: 0, blockId: 'gem'},
          {x: 2, y: 1, z: 0, blockId: 'gem'}
        ];
        for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) objects.push({x, y, z: 0, blockId: 'floor'});
        for (const object of objects) for (let turn = 0; turn < rotation; turn++) {
          [object.x, object.y] = [2 - object.y, object.x];
        }
        if (reversed) objects.reverse();
        const room = {width: 3, height: 3, objects};
        const result = await engine.simulateCommand(room, directions[rotation], blocks);
        const dx = [0, 1, 0, -1][rotation], dy = [-1, 0, 1, 0][rotation];
        const player = objects.find(o => o.blockId === 'player');
        const expected = objects.map(object => {
          if (object.blockId === 'gem') {
            return object.x === player.x + dx && object.y === player.y + dy ? {...object, x: -1} : object;
          }
          return ['player', 'clone', 'clone-slope'].includes(object.blockId)
            ? {...object, x: object.x + dx, y: object.y + dy} : object;
        });
        const context = `${orientation || 'cube'}, ${directions[rotation]}, reversed=${reversed}`;
        assert.equal(result.cycle, null, context);
        assert.equal(result.frames.length, 1, context);
        assert.deepEqual(result.frames[0].objects, expected, context);
        assert.deepEqual(result.final.objects, expected, context);
      }
    }
  });

  test(`${binary}: exact search rejects a gem reachable only by a clone`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
    const room = {width: 3, height: 3, objects: [
      {x: 0, y: 2, z: 0, blockId: 'player'},
      {x: 2, y: 2, z: 0, blockId: 'clone', genericId: 0},
      {x: 0, y: 1, z: 0, blockId: 'wall'},
      {x: 2, y: 1, z: 0, blockId: 'gem'},
      {x: 0, y: 2, z: 0, blockId: 'floor'},
      {x: 2, y: 2, z: 0, blockId: 'floor'},
      {x: 2, y: 1, z: 0, blockId: 'floor'}
    ]};
    if (engine.exports.search_solve) {
      const result = engine.solve(room, blocks, {maximumNodes: 1000});
      assert.equal(result.status, 'unsolved');
      assert.deepEqual(result.solution, []);
    } else {
      const {count} = engine.writeState(engine.createState(room), blocks);
      const native = engine.exports;
      const started = native.solutions_solver_begin
        ? native.solutions_solver_begin(count, 3, 3, 2, 0, 0, 0, 1, 1, 0, 0, 0)
        : native.editor_solver_begin(count, 3, 3, 0, 0, 1, 0);
      assert.equal(started, 1);
      assert.equal(native.editor_solver_run(1000), 4, 'the exact frontier must exhaust without collecting the clone gem');
      assert.equal(native.editor_solver_solution_length(), 0);
    }
  });
}
