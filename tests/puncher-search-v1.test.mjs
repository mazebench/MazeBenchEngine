import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function engineAt(path) {
  const { instance } = await WebAssembly.instantiate(await readFile(new URL(path, import.meta.url)), {});
  return instance.exports;
}

function writeScene(engine, voxels) {
  const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), voxels.length * 5);
  for (const [index, [x, y, z, role, id]] of voxels.entries()) {
    const bytes = new TextEncoder().encode(role);
    new Uint8Array(engine.memory.buffer, engine.role_buffer(), bytes.length).set(bytes);
    buffer.set([x, y, z, engine.role_code(bytes.length), id], index * 5);
  }
}

for (const wrapper of ['editor', 'solutions']) {
  test(`${wrapper} A* excludes deaths handled by passive physics`, async () => {
    const engine = await engineAt(wrapper === 'editor'
      ? '../world-solver/v1/editor-solver.wasm' : '../solutions/v1/solutions-solver.wasm');
    // All four commands walk off this isolated floor and kill the player.
    const scene = [[1, 1, 1, 'player', -1], [1, 1, 0, 'floor', -1], [2, 2, 1, 'goal', -1]];
    writeScene(engine, scene);
    const started = wrapper === 'editor'
      ? engine.editor_solver_begin(scene.length, 3, 3, 3, 0, 1, 0)
      : engine.solutions_solver_begin(scene.length, 3, 3, 1, 2, 2, 1, 0, 0, 0, 0, 3);
    assert.equal(started, 1);
    assert.equal(engine.editor_solver_run(100), 4, 'the target is unreachable');
    assert.equal(engine.editor_solver_node_count(), 1, 'only the living root belongs in the frontier');
    assert.equal(engine.editor_solver_expanded(), 1);
    assert.equal(engine.editor_solver_full_physics_transitions(), 0);
  });
}

test('puncher A* retains the DxL frontier while skipping unrelated physics', async () => {
  const scene = JSON.parse(await readFile(new URL('../engine/v1/core/tests/fixtures/dxl-search.json', import.meta.url), 'utf8'));
  const engine = await engineAt('../world-solver/v1/editor-solver.wasm');
  writeScene(engine, scene.voxels);
  assert.equal(engine.editor_solver_begin(scene.voxels.length, scene.width, scene.height, 3, 0, 1, 0), 1);
  assert.equal(engine.editor_solver_run(10000), 0);
  assert.equal(engine.editor_solver_command_transitions(), 40000);
  assert.equal(engine.editor_solver_node_count(), 12260, 'same fixed-budget frontier as the full-physics baseline');
  assert(engine.editor_solver_full_physics_transitions() < 4000, 'ordinary moves should avoid unrelated mechanisms');
});
