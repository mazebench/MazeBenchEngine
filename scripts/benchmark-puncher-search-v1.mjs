#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Supply a saved editor-solver.wasm to measure the same workload before a sync.
const path = process.argv[2] ?? new URL('../world-solver/v1/editor-solver.wasm', import.meta.url);
const { instance: { exports: engine } } = await WebAssembly.instantiate(await readFile(path), {});
const scene = JSON.parse(await readFile(new URL('../engine/v1/core/tests/fixtures/dxl-search.json', import.meta.url), 'utf8'));
const roles = new Map();
const initial = Int32Array.from(scene.voxels.flatMap(([x, y, z, role, id]) => {
  if (!roles.has(role)) {
    const bytes = new TextEncoder().encode(role);
    new Uint8Array(engine.memory.buffer, engine.role_buffer(), bytes.length).set(bytes);
    roles.set(role, engine.role_code(bytes.length));
  }
  return [x, y, z, roles.get(role), id];
}));

function run() {
  new Int32Array(engine.memory.buffer, engine.voxel_buffer(), initial.length).set(initial);
  const started = performance.now();
  assert.equal(engine.editor_solver_begin(scene.voxels.length, scene.width, scene.height, 3, 0, 1, 0), 1);
  const status = engine.editor_solver_run(10000);
  const ms = performance.now() - started;
  return {
    ms, status,
    expanded: engine.editor_solver_expanded(),
    nodes: engine.editor_solver_node_count(),
    commands: engine.editor_solver_command_transitions(),
    fullPhysicsCommands: engine.editor_solver_full_physics_transitions(),
  };
}

const expected = run();
assert.deepEqual([expected.status, expected.expanded, expected.nodes, expected.commands], [0, 10000, 12260, 40000]);
const samples = [];
for (let sample = 0; sample < 5; sample++) {
  let ms = 0, runs = 0;
  do {
    const result = run();
    assert.deepEqual({ ...result, ms: 0 }, { ...expected, ms: 0 });
    ms += result.ms;
    runs++;
  } while (ms < 250);
  samples.push(ms / runs);
}
const medianMs = samples.sort((a, b) => a - b)[2];
const { ms, ...counts } = expected;
console.log(JSON.stringify({
  workload: 'DxL weighted A* (10,000 expansions; unfinished search)',
  ...counts,
  medianMs: Number(medianMs.toFixed(3)),
  commandsPerSecond: Math.round(expected.commands * 1000 / medianMs),
}, null, 2));
