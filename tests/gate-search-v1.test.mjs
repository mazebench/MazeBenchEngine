import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { instantiateMazeBenchEngineV1 } from '../engine/v1/engine.mjs';
import { createEditorSolverSessionV1 } from '../editor/v1/native-solver-runtime.mjs';
import { readEngineStateV1 } from '../engine/v1/adapter.mjs';
import { runRoomBfsV1 } from '../world-solver/v1/room-bfs.mjs';

const directions = ['up', 'right', 'down', 'left'];
const blocks = [
  { id: 'floor', roleId: 'floor', visual: { kind: 'floor' } },
  { id: 'player', roleId: 'player', visual: { kind: 'cube' } },
  { id: 'gem', roleId: 'goal', visual: { kind: 'model' } },
  { id: 'gate', roleId: 'player-gate', visual: { kind: 'gate' } },
];
const floors = Array.from({length: 16}, (_, i) => ({x: i % 4, y: Math.floor(i / 4), z: 0, blockId: 'floor'}));
const room = (raised) => ({width: 4, height: 4, objects: [
  {x: 1, y: 3, z: 0, blockId: 'player'},
  {x: 1, y: 0, z: 0, blockId: 'gem'},
  {x: 1, y: 2, z: 0, blockId: 'gate', stateId: raised},
  ...floors,
]});
const native = async path => instantiateMazeBenchEngineV1(await readFile(new URL(path, import.meta.url)));
async function replay(engine, start, route) {
  let state = engine.createState(start);
  for (const action of route) state = (await engine.simulateCommand(state, action, blocks)).final;
  assert.ok(state.objects.some(o => o.blockId === 'player' && o.x >= 0));
  assert.ok(state.objects.every(o => o.blockId !== 'gem' || o.x < 0));
}

for (const wrapper of ['editor', 'solutions']) {
  test(`${wrapper} compact states preserve authored gates, settled gates, and reused-search isolation`, async () => {
    const engine = await native(wrapper === 'editor'
      ? '../world-solver/v1/editor-solver.wasm' : '../solutions/v1/solutions-solver.wasm');
    // Reuse one WASM workspace, including a return to the initial gate setup.
    for (const raised of [0, 1, 0]) for (const weight of [0, 3]) {
      const start = room(raised);
      let route;
      if (wrapper === 'editor') {
        const session = createEditorSolverSessionV1(engine, start, blocks, {heuristicWeight: weight});
        let result = session.snapshot();
        let chunks = 0;
        while (result.statusCode === 0 && chunks++ < 1000) result = session.runChunk(1);
        assert.ok([1, 3].includes(result.statusCode));
        route = result.solution;
      } else {
        engine.writeState(start, blocks);
        assert.equal(engine.exports.solutions_solver_begin(start.objects.length, 4, 4, 1, 1, 0, 1, 0, 0, 0, 0, weight), 1);
        let status = 0, chunks = 0;
        while (status === 0 && chunks++ < 1000) status = engine.exports.editor_solver_run(1);
        assert.ok([1, 3].includes(status));
        route = Array.from({length: engine.exports.editor_solver_solution_length()}, (_, i) => directions[engine.exports.editor_solver_solution_step(i)]);
      }
      if (weight === 0) assert.equal(route.length, raised ? 5 : 3);
      await replay(engine, start, route);
    }
  });
}

test('DFS gate-state snapshots resume the same reachable world as uninterrupted room BFS', async () => {
  const engine = await native('../world-solver/v1/random-agent.wasm');
  const world = {
    columns: ['H'], rows: ['H', 'I'], roomWidth: 4, roomHeight: 4, blocks,
    blockDefinitions: new Map(blocks.map(b => [b.id, b])),
    rooms: [
      {...room(0), fileName: 'start.json', position: ['H', 'I'], columnIndex: 0, rowIndex: 1},
      {width: 4, height: 4, objects: floors, fileName: 'north.json', position: ['H', 'H'], columnIndex: 0, rowIndex: 0},
    ],
  };
  const outcomes = [];
  for (const strategy of ['breadth', 'depth']) {
    const progress = [];
    const stats = await runRoomBfsV1(engine, world, {metaStrategy: strategy, chunkSize: 1, progressDelayMs: 0, onProgress: p => progress.push(p)});
    assert.equal(stats.rooms, 2);
    assert.equal(stats.gems, 1);
    if (strategy === 'depth') {
      assert.ok(progress.some(p => p.type === 'room-suspend'));
      assert.ok(progress.some(p => p.type === 'room-resume'));
    }
    outcomes.push({states: stats.states, gems: stats.gems, visited: [...new Set(progress.flatMap(p => p.visitedCells || []))].sort((a,b) => a-b)});
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
});

test('Row A* exports the exact authored gate state for its starting boundary entrance', async () => {
  const engine = await native('../world-solver/v1/random-agent.wasm');
  const start = engine.createState(room(0));
  const expected = Array.from(engine.writeState(start, blocks).buffer);
  assert.equal(engine.exports.row_astar_begin(start.objects.length, 4, 4, 4, 3), 1);
  assert.equal(engine.exports.row_astar_run(1), 3);
  assert.equal(engine.exports.row_astar_edge_load_state(0), start.objects.length);
  const actual = readEngineStateV1(start, blocks, new Int32Array(engine.exports.memory.buffer, engine.exports.voxel_buffer(), start.objects.length * 5), 5);
  assert.equal(actual.objects.find(o => o.blockId === 'gate').stateId, 0);
  assert.deepEqual(Array.from(new Int32Array(engine.exports.memory.buffer,
    engine.exports.voxel_buffer(), start.objects.length * 5)), expected);
});
