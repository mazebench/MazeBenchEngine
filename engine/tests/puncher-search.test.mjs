import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function loadEngine() {
  const { instance } = await WebAssembly.instantiate(await readFile(
    new URL('../../apps/web/public/physics/voxel_physics.wasm', import.meta.url)), {});
  return instance.exports;
}

function writeScene(engine, voxels) {
  const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), voxels.length * 5);
  for (const [i, [x, y, z, role, id]] of voxels.entries()) {
    const bytes = new TextEncoder().encode(role);
    new Uint8Array(engine.memory.buffer, engine.role_buffer(), bytes.length).set(bytes);
    buffer.set([x, y, z, engine.role_code(bytes.length), id], i * 5);
  }
  return buffer;
}

for (const sprung of [0, 1]) {
  test(`search solves and replays a puncher-assisted gem route (sprung=${sprung})`, async () => {
    const engine = await loadEngine();
    const voxels = [
      [1, 3, 1, 'player', -1], [1, 2, 1, 'puncher', 2 + sprung],
      [0, 2, 1, 'solid', -1], [4, 2, 1, 'solid', -1],
      [1, 3, 0, 'floor', -1], [1, 2, 0, 'floor', -1],
      [2, 2, 0, 'floor', -1], [3, 2, 0, 'floor', -1],
      [4, 2, 0, 'floor', -1], [3, 2, 1, 'goal', -1],
    ];
    writeScene(engine, voxels);
    assert.equal(engine.search_solve(voxels.length, 5, 5, 1000), 1);
    const route = Array.from({ length: engine.search_solution_length() },
      (_, i) => engine.search_solution_step(i));
    // A sprung frame may be the end of a previous blocked punch. The next
    // command rearms it and can use the same one-command route.
    assert.deepEqual(route, [0]);
    const buffer = writeScene(engine, voxels);
    for (const direction of route) assert.equal(engine.simulate_turn(voxels.length, 5, 5, direction), 0);
    assert.deepEqual(Array.from(buffer.slice(0, 3)), [3, 2, 1]);
    assert.equal(buffer[9 * 5], -1, 'the replay must actually collect the gem');
    assert.equal(buffer[1 * 5 + 4], 2, 'the replay must finish with the fixture rearmed');
  });
}

test('DxL search accepts its authored puncher and simulates commands', async () => {
  const engine = await loadEngine();
  const { voxels, width, height } = JSON.parse(await readFile(
    new URL('./fixtures/dxl-search.json', import.meta.url), 'utf8'));
  writeScene(engine, voxels);
  const result = engine.search_solve(voxels.length, width, height, 500);
  assert.notEqual(result, -1, 'the puncher must not invalidate the prepared scene');
  assert.ok(engine.search_command_transitions() > 0);
});
