import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const wasm = await readFile(new URL('../../apps/web/public/physics/voxel_physics.wasm', import.meta.url));
const { instance: { exports: engine } } = await WebAssembly.instantiate(wasm, {});
const role = name => {
  const bytes = new TextEncoder().encode(name);
  new Uint8Array(engine.memory.buffer, engine.role_buffer(), bytes.length).set(bytes);
  return engine.role_code(bytes.length);
};
const codes = Object.fromEntries(['player', 'floor', 'solid', 'goal', 'pushable', 'weightless-pushable', 'clone', 'player-gate', 'player-lift', 'floating-floor', 'puncher', 'ice', 'ice-slope-up'].map(name => [name, role(name)]));
const write = scene => {
  const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), scene.length * 5);
  scene.forEach((voxel, i) => buffer.set(voxel, i * 5));
  return buffer;
};
const command = (scene, direction) => {
  const buffer = write(scene);
  assert.equal(engine.simulate_turn(scene.length, 4, 4, direction), 0);
  return scene.map((_, i) => Array.from(buffer.slice(i * 5, i * 5 + 5)));
};
const alive = scene => scene.some(v => v[3] === codes.player && v[0] >= 0);
const won = scene => !scene.some(v => v[3] === codes.goal && v[0] >= 0);

// Deliberately unoptimized BFS: no prepared scene, player-region collapse,
// heuristic, or compact entity encoding shared with the search implementation.
function shortestByFullPhysics(start) {
  const queue = [{ scene: start, depth: 0 }];
  const seen = new Set([JSON.stringify(start)]);
  for (let head = 0; head < queue.length; ++head) {
    assert.ok(queue.length < 20000, 'keep exhaustive oracle scenes bounded');
    const { scene, depth } = queue[head];
    for (let direction = 0; direction < 4; ++direction) {
      const next = command(scene, direction);
      if (!alive(next)) continue;
      if (won(next)) return depth + 1;
      const signature = JSON.stringify(next);
      if (!seen.has(signature)) { seen.add(signature); queue.push({ scene: next, depth: depth + 1 }); }
    }
  }
  return null;
}
function sceneFor(kind) {
  const scene = [[1, 3, 1, codes.player, -1], [1, 0, 1, codes.goal, -1]];
  for (let x = 0; x < 4; ++x) for (let y = 0; y < 4; ++y) scene.push([x, y, 0,
    kind === 'ice' && x === 1 && y > 0 && y < 3 ? codes.ice : codes.floor, -1]);
  if (kind === 'raised-gate') scene.push([1, 2, 1, codes['player-gate'], 1]);
  else if (kind === 'far-gate') scene.push([1, 1, 1, codes['player-gate'], 0]);
  else if (kind === 'two-gates') scene.push([1, 2, 1, codes['player-gate'], 0], [2, 1, 1, codes['player-gate'], 1]);
  else if (kind === 'gate-box' || kind === 'gate-floating-floor') scene.push([1, 2, 1, codes['player-gate'], 0], [1, 2, 1, codes[kind === 'gate-box' ? 'pushable' : 'floating-floor'], -1]);
  else if (kind === 'blocked') scene.push([1, 0, 1, codes.solid, -1]);
  else if (kind === 'polycube') scene.push([1, 2, 1, codes['weightless-pushable'], 37], [1, 2, 2, codes['weightless-pushable'], 37]);
  else if (codes[kind] && kind !== 'ice') scene.push([1, 2, 1, codes[kind], ['player-gate', 'player-lift', 'puncher', 'clone'].includes(kind) ? 0 : -1]);
  return scene;
}
function rotated(scene, turns) {
  return scene.map(original => {
    const v = original.slice();
    for (let i = 0; i < turns; ++i) [v[0], v[1]] = [3 - v[1], v[0]];
    // Top-mounted mechanisms stay top-mounted; Up punch direction rotates.
    if (v[3] === codes.puncher) v[4] = turns * 2;
    return v;
  });
}
for (const kind of ['walk', 'blocked', 'ice', 'pushable', 'polycube', 'clone', 'player-gate', 'player-lift', 'floating-floor', 'puncher', 'raised-gate', 'far-gate', 'two-gates', 'gate-box', 'gate-floating-floor']) {
  test(`exact search matches exhaustive full-physics BFS: ${kind}`, () => {
    const start = sceneFor(kind);
    const expected = shortestByFullPhysics(start);
    for (let rotation = 0; rotation < 4; ++rotation) for (const reverse of [false, true]) {
      let input = rotated(start, rotation);
      if (reverse) input.reverse();
      write(input);
      const status = engine.search_solve(input.length, 4, 4, 20000);
      const context = `${kind}, ${rotation * 90}°, reverse=${reverse}`;
      assert.equal(status, expected === null ? 0 : 1, context);
      if (expected === null) continue;
      const route = Array.from({ length: engine.search_solution_length() }, (_, i) => engine.search_solution_step(i));
      assert.equal(route.length, expected, `${context}: shortest command count`);
      for (const direction of route) input = command(input, direction);
      assert.ok(alive(input) && won(input), `${context}: returned route actually collects every gem`);
    }
  });
}
