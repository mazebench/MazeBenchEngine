import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadEngine() {
  const bytes = await readFile(new URL("../../apps/web/public/physics/voxel_physics.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}

function roleCode(engine, roleId) {
  const bytes = new TextEncoder().encode(roleId);
  assert.ok(bytes.length <= engine.role_buffer_capacity());
  new Uint8Array(engine.memory.buffer, engine.role_buffer(), bytes.length).set(bytes);
  return engine.role_code(bytes.length);
}

function simulate(engine, voxels, direction, width = 5, height = 5) {
  assert.equal(engine.physics_abi_version(), 4);
  const stride = engine.voxel_stride();
  assert.equal(stride, 5);
  const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), voxels.length * stride);
  voxels.forEach((voxel, index) => {
    buffer.set([voxel.x, voxel.y, voxel.z, roleCode(engine, voxel.roleId), voxel.genericId ?? -1], index * stride);
  });
  assert.equal(engine.simulate_turn(voxels.length, width, height, direction), 0);
  return voxels.map((voxel, index) => ({
    ...voxel,
    x: buffer[index * stride],
    y: buffer[index * stride + 1],
    z: buffer[index * stride + 2],
    ...(voxel.genericId === undefined
      ? {}
      : { genericId: buffer[index * stride + 4] }),
  }));
}

for (const boxRole of ['pushable', 'weightless-pushable', 'blue-box-slope-up']) {
  test(`${boxRole}: only the player may cross an optional room grid`, async () => {
    const engine = await loadEngine();
    const start = [
      {x: 5, y: 1, z: 1, roleId: 'player', genericId: (1 << 30) | (4 << 15) | 6},
      {x: 4, y: 3, z: 1, roleId: 'clone', genericId: 7},
      {x: 5, y: 3, z: 1, roleId: boxRole, genericId: 9},
      ...Array.from({length: 96}, (_, i) => ({x: i % 12, y: Math.floor(i / 12), z: 0, roleId: 'floor'}))
    ];
    const bounded = simulate(engine, start, 1, 12, 8);
    assert.deepEqual(bounded.slice(0, 3).map(v => [v.x, v.y, v.z]),
      [[6, 1, 1], [4, 3, 1], [5, 3, 1]]);
    assert.equal(bounded[0].genericId, start[0].genericId);
    const unscoped = start.map((v, i) => i === 0 ? {...v, genericId: -1} : v);
    assert.deepEqual(simulate(engine, unscoped, 1, 12, 8).slice(0, 3).map(v => [v.x, v.y, v.z]),
      [[6, 1, 1], [5, 3, 1], [6, 3, 1]], 'ordinary one-room physics must not retain a prior room grid');
  });
}

test('a player cannot push a box out of its room but may push an entrance box inside its own room', async () => {
  const engine = await loadEngine();
  const start = [
    {x: 4, y: 1, z: 1, roleId: 'player', genericId: (1 << 30) | (4 << 15) | 6},
    {x: 5, y: 1, z: 1, roleId: 'pushable'},
    ...Array.from({length: 48}, (_, i) => ({x: i % 12, y: Math.floor(i / 12), z: 0, roleId: 'floor'}))
  ];
  assert.deepEqual(simulate(engine, start, 1, 12, 4), start);
  const entered = start.map((v, i) => i < 2 ? {...v, x: v.x + 1} : v);
  assert.deepEqual(simulate(engine, entered, 1, 12, 4).slice(0, 2).map(v => [v.x, v.y]), [[6, 1], [7, 1]]);
});

for (const roleId of ['clone', 'yellow-clone-slope-up']) {
  test(`${roleId}: an out-of-room clone ignores input and reactivates on the next local command`, async () => {
    const engine = await loadEngine();
    const noCommand = 1 << 30;
    const start = [
      {x: 0, y: 0, z: 1, roleId: 'player'},
      {x: 1, y: 2, z: 1, roleId, genericId: 7},
      {x: 3, y: 2, z: 1, roleId, genericId: noCommand | 7},
      {x: 3, y: 3, z: 1, roleId, genericId: noCommand | 7},
      ...Array.from({length: 25}, (_, i) => ({x: i % 5, y: Math.floor(i / 5), z: 0, roleId: 'floor'}))
    ];
    const first = simulate(engine, start, 1);
    assert.deepEqual(first.slice(0, 4).map(v => [v.x, v.y, v.z]),
      [[1, 0, 1], [2, 2, 1], [3, 2, 1], [3, 3, 1]]);
    assert.equal(first[2].genericId, noCommand | 7);
    // Change room ownership for the next command without changing clone roles.
    const local = first.map((v, i) => i === 1 ? {...v, genericId: noCommand | 7}
      : i === 2 || i === 3 ? {...v, genericId: 7} : v);
    const second = simulate(engine, local, 0);
    assert.deepEqual(second.slice(0, 4).map(v => [v.x, v.y, v.z]),
      [[1, 0, 1], [2, 2, 1], [3, 1, 1], [3, 2, 1]]);
  });
}

test('an input-suppressed clone blocks the player instead of joining a simultaneous walk', async () => {
  const engine = await loadEngine();
  const start = [
    {x: 1, y: 2, z: 1, roleId: 'player'},
    {x: 2, y: 2, z: 1, roleId: 'clone', genericId: (1 << 30) | 9},
    ...Array.from({length: 25}, (_, i) => ({x: i % 5, y: Math.floor(i / 5), z: 0, roleId: 'floor'}))
  ];
  assert.deepEqual(simulate(engine, start, 1), start);
});

test("held buttons never shift a partially normalized orange column's anchors", async () => {
  const engine = await loadEngine();
  let voxels = [
    ...Array.from({ length: 24 }, (_, i) => ({ x: i % 6, y: Math.floor(i / 6), z: 0, roleId: "floor" })),
    { x: 0, y: 1, z: 1, roleId: "player" },
    { x: 2, y: 1, z: 1, roleId: "orange-button", genericId: 0 },
    { x: 2, y: 2, z: 1, roleId: "orange-button", genericId: 0 },
    { x: 2, y: 1, z: 1, roleId: "weightless-pushable", genericId: 0 },
    { x: 4, y: 2, z: 1, roleId: "orange-wall", genericId: 0 },
    { x: 4, y: 2, z: 2, roleId: "orange-wall", genericId: 0 },
  ];
  for (const [direction, depth] of [[1, 1], [2, 1], [1, 2], [3, 1]]) {
    voxels = simulate(engine, voxels, direction, 6, 4);
    assert.deepEqual(voxels.slice(-2).map(v => [v.z, v.genericId]), [[1, depth], [2, depth]]);
  }
});

test("orange scopes isolate button pressure on every tick, including touching walls", async () => {
  const engine = await loadEngine();
  const scoped = (scope, value) => (1 << 30) | (scope << 17) | value;
  const voxels = [
    ...Array.from({ length: 24 }, (_, i) => ({ x: i % 6, y: Math.floor(i / 6), z: 0, roleId: "floor" })),
    { x: 0, y: 1, z: 1, roleId: "player" },
    { x: 2, y: 1, z: 1, roleId: "orange-button", genericId: scoped(1, 0) },
    { x: 2, y: 2, z: 1, roleId: "orange-button", genericId: scoped(2, 0) },
    { x: 2, y: 1, z: 1, roleId: "weightless-pushable", genericId: 0 },
    { x: 4, y: 2, z: 1, roleId: "orange-wall", genericId: scoped(1, 0) },
    { x: 5, y: 2, z: 1, roleId: "orange-wall", genericId: scoped(2, 0) },
    { x: 4, y: 3, z: 1, roleId: "orange-wall", genericId: 0 },
  ];
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), voxels.length * stride);
  voxels.forEach((v, i) => buffer.set([v.x, v.y, v.z, roleCode(engine, v.roleId), v.genericId ?? -1], i * stride));
  engine.reset_command();
  let complete = false;
  for (let tick = 0; tick < 100; tick++) {
    const status = engine.step_command_tick(voxels.length, 6, 4, 1);
    assert.ok(status >= 0);
    assert.equal(buffer[29 * stride + 4], scoped(2, 0), "another scope must never move even for one frame");
    assert.equal(buffer[30 * stride + 4], 0, "unscoped walls must not listen to scoped buttons");
    if (status === 0) { complete = true; break; }
  }
  assert(complete);
  assert.equal(buffer[28 * stride + 4], scoped(1, 1));
  const after = voxels.map((v, i) => ({ ...v, x:buffer[i*stride], y:buffer[i*stride+1], z:buffer[i*stride+2], genericId:buffer[i*stride+4] }));
  const pressedSecond = simulate(engine, simulate(engine, after, 2, 6, 4), 1, 6, 4);
  assert.deepEqual(pressedSecond.slice(-3).map(v => v.genericId), [scoped(1, 1), scoped(2, 1), 0]);
  const releasedSecond = simulate(engine, pressedSecond, 3, 6, 4);
  assert.deepEqual(releasedSecond.slice(-3).map(v => v.genericId), [scoped(1, 1), scoped(2, 0), 0]);
  assert.equal(engine.search_edges(voxels.length, 6, 4, 100), -1,
    "room-local search must reject transient multi-scope data instead of merging its controls");
});

test("the C++ engine pushes a pushable role and preserves negative Z", async () => {
  const engine = await loadEngine();
  const result = simulate(engine, [
    { x: 2, y: 2, z: -7, roleId: "player" },
    { x: 2, y: 1, z: -7, roleId: "pushable" },
    { x: 2, y: 2, z: -8, roleId: "floor" },
    { x: 2, y: 1, z: -8, roleId: "floor" },
    { x: 2, y: 0, z: -8, roleId: "floor" },
  ], 0);

  assert.deepEqual(result.slice(0, 2), [
    { x: 2, y: 1, z: -7, roleId: "player" },
    { x: 2, y: 0, z: -7, roleId: "pushable" },
  ]);
});

test("custom roles are stable engine keys and block movement until C++ implements them", async () => {
  const engine = await loadEngine();
  assert.equal(roleCode(engine, "ice"), roleCode(engine, "ice"));
  assert.notEqual(roleCode(engine, "ice"), roleCode(engine, "player"));

  const result = simulate(engine, [
    { x: 1, y: 2, z: 1, roleId: "player" },
    { x: 1, y: 1, z: 1, roleId: "ice" },
    { x: 1, y: 2, z: 0, roleId: "floor" },
  ], 0);
  assert.deepEqual(result.slice(0, 2).map(({ x, y, z }) => ({ x, y, z })), [
    { x: 1, y: 2, z: 1 },
    { x: 1, y: 1, z: 1 },
  ]);
});

test("the C++ engine enforces room boundaries in every direction", async () => {
  const engine = await loadEngine();
  const cases = [
    [{ x: 2, y: 0, z: 1, roleId: "player" }, 0],
    [{ x: 4, y: 2, z: 1, roleId: "player" }, 1],
    [{ x: 2, y: 4, z: 1, roleId: "player" }, 2],
    [{ x: 0, y: 2, z: 1, roleId: "player" }, 3],
  ];
  for (const [player, direction] of cases) {
    const result = simulate(engine, [
      player,
      { x: player.x, y: player.y, z: 0, roleId: "floor" },
    ], direction);
    assert.deepEqual(result[0], player);
  }
});

test("the C++ WebAssembly engine executes MazeBench-style Ice slides", async () => {
  const engine = await loadEngine();
  const result = simulate(engine, [
    { x: 2, y: 4, z: 1, roleId: "player" },
    { x: 2, y: 4, z: 0, roleId: "floor" },
    { x: 2, y: 3, z: 0, roleId: "ice" },
    { x: 2, y: 2, z: 0, roleId: "ice" },
    { x: 2, y: 1, z: 0, roleId: "ice" },
    { x: 2, y: 0, z: 0, roleId: "solid" },
  ], 0);
  assert.deepEqual(result[0], { x: 2, y: 0, z: 1, roleId: "player" });
});

test("WebAssembly preserves the player lift state transition", async () => {
  const engine = await loadEngine();
  const result = simulate(engine, [
    { x: 1, y: 2, z: 1, roleId: "player" },
    { x: 1, y: 1, z: 1, roleId: "player-lift", genericId: 0 },
    { x: 1, y: 2, z: 0, roleId: "floor" },
    { x: 1, y: 1, z: 0, roleId: "floor" },
  ], 0, 3, 3);
  assert.deepEqual(result.slice(0, 2), [
    { x: 1, y: 1, z: 2, roleId: "player" },
    { x: 1, y: 1, z: 1, roleId: "player-lift", genericId: 1 },
  ]);
});

test("WebAssembly exposes orange button entry before its linked wall tick", async () => {
  const engine = await loadEngine();
  const voxels = [
    { x: 1, y: 2, z: 1, roleId: "player", genericId: -1 },
    { x: 1, y: 1, z: 1, roleId: "orange-button", genericId: 0 },
    { x: 2, y: 1, z: 1, roleId: "orange-wall", genericId: 0 },
    { x: 1, y: 2, z: 0, roleId: "floor", genericId: -1 },
    { x: 1, y: 1, z: 0, roleId: "floor", genericId: -1 },
    { x: 2, y: 1, z: 0, roleId: "floor", genericId: -1 },
  ];
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(
    engine.memory.buffer,
    engine.voxel_buffer(),
    voxels.length * stride,
  );
  voxels.forEach((voxel, index) => buffer.set([
    voxel.x,
    voxel.y,
    voxel.z,
    roleCode(engine, voxel.roleId),
    voxel.genericId,
  ], index * stride));

  engine.reset_command();
  assert.equal(engine.step_command_tick(voxels.length, 3, 3, 0), 1);
  assert.deepEqual([buffer[1], buffer[stride + 4], buffer[stride * 2 + 4]], [1, 0, 0]);
  assert.equal(engine.step_command_tick(voxels.length, 3, 3, 0), 0);
  assert.deepEqual([buffer[stride + 4], buffer[stride * 2 + 4]], [0, 1]);
});

test("WebAssembly exposes one resumable frame per C++ tick", async () => {
  const engine = await loadEngine();
  const voxels = [
    { x: 2, y: 4, z: 1, roleId: "player" },
    { x: 2, y: 4, z: 0, roleId: "floor" },
    { x: 2, y: 3, z: 0, roleId: "ice" },
    { x: 2, y: 2, z: 0, roleId: "ice" },
    { x: 2, y: 1, z: 0, roleId: "ice" },
    { x: 2, y: 0, z: 0, roleId: "solid" },
  ];
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), voxels.length * stride);
  voxels.forEach((voxel, index) => buffer.set([
    voxel.x, voxel.y, voxel.z, roleCode(engine, voxel.roleId), -1,
  ], index * stride));

  assert.ok(engine.motion_state_size() > 0);
  assert.ok(engine.motion_state_buffer() > 0);
  engine.reset_command();
  const playerRows = [];
  for (;;) {
    const status = engine.step_command_tick(voxels.length, 5, 5, 0);
    if (engine.command_tick() > playerRows.length) playerRows.push(buffer[1]);
    if (status === 0) break;
    assert.equal(status, 1);
  }
  assert.deepEqual(playerRows, [3, 2, 1, 0]);
});

test("WebAssembly settles airborne entities before applying the command", async () => {
  const engine = await loadEngine();
  const voxels = [
    { x: 1, y: 2, z: 3, roleId: "player" },
    { x: 1, y: 2, z: 0, roleId: "floor" },
    { x: 1, y: 1, z: 0, roleId: "floor" },
  ];
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), voxels.length * stride);
  voxels.forEach((voxel, index) => buffer.set([
    voxel.x, voxel.y, voxel.z, roleCode(engine, voxel.roleId), -1,
  ], index * stride));

  engine.reset_command();
  const frames = [];
  for (;;) {
    const status = engine.step_command_tick(voxels.length, 3, 3, 0);
    frames.push({ y: buffer[1], z: buffer[2] });
    if (status === 0) break;
    assert.equal(status, 1);
  }
  assert.deepEqual(frames, [
    { y: 2, z: 2 },
    { y: 2, z: 1 },
    { y: 1, z: 1 },
  ]);
});

test("WebAssembly exact search targets collection of a literal gem", async () => {
  const engine = await loadEngine();
  const voxels = [
    { x: 1, y: 2, z: 1, roleId: "player" },
    { x: 1, y: 2, z: 0, roleId: "floor" },
    { x: 1, y: 1, z: 0, roleId: "floor" },
    { x: 1, y: 0, z: 0, roleId: "floor" },
    { x: 1, y: 0, z: 1, roleId: "goal" },
  ];
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), voxels.length * stride);
  voxels.forEach((voxel, index) => buffer.set([
    voxel.x, voxel.y, voxel.z, roleCode(engine, voxel.roleId), -1,
  ], index * stride));

  assert.ok(engine.search_node_capacity() >= 1000);
  assert.ok(engine.search_voxel_capacity() >= 4096);
  assert.equal(engine.search_solve(voxels.length, 3, 3, 1000), 1);
  assert.equal(engine.search_moves(), 2);
  assert.equal(engine.search_solution_length(), 2);
  assert.deepEqual([engine.search_solution_step(0), engine.search_solution_step(1)], [0, 0]);
});

test("WebAssembly enumerates reachable room edges without requiring gems", async () => {
  const engine = await loadEngine();
  const voxels = [{ x: 1, y: 1, z: 1, roleId: "player" }];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      voxels.push({ x, y, z: 0, roleId: "floor" });
    }
  }
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(
    engine.memory.buffer,
    engine.voxel_buffer(),
    voxels.length * stride,
  );
  voxels.forEach((voxel, index) => buffer.set([
    voxel.x, voxel.y, voxel.z, roleCode(engine, voxel.roleId), -1,
  ], index * stride));

  assert.equal(engine.search_edges(voxels.length, 3, 3, 1000), 1);
  assert.equal(engine.search_edge_count(), 12);
  assert.equal(engine.search_edge_solution(0, voxels.length, 3, 3), 1);
  assert.ok(engine.search_solution_length() >= 2);
  assert.equal(
    engine.search_solution_step(engine.search_solution_length() - 1),
    0,
  );
});

test("WebAssembly distinguishes a capped route from an optimal proof", async () => {
  const engine = await loadEngine();
  const voxels = [];
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      voxels.push({ x, y, z: 0, roleId: "floor" });
    }
  }
  for (let x = 0; x < 5; x += 1) {
    voxels.push({ x, y: 0, z: 1, roleId: "wall" });
    voxels.push({ x, y: 4, z: 1, roleId: "wall" });
  }
  for (let y = 1; y < 4; y += 1) {
    voxels.push({ x: 0, y, z: 1, roleId: "wall" });
    voxels.push({ x: 4, y, z: 1, roleId: "wall" });
  }
  voxels.push(
    { x: 1, y: 2, z: 1, roleId: "weightless-pushable", genericId: 0 },
    { x: 2, y: 2, z: 1, roleId: "weightless-pushable", genericId: 0 },
    { x: 1, y: 3, z: 1, roleId: "player" },
    { x: 1, y: 1, z: 1, roleId: "goal" },
  );
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(
    engine.memory.buffer,
    engine.voxel_buffer(),
    voxels.length * stride,
  );
  const write = () => voxels.forEach((voxel, index) => buffer.set([
    voxel.x,
    voxel.y,
    voxel.z,
    roleCode(engine, voxel.roleId),
    voxel.genericId ?? -1,
  ], index * stride));

  write();
  assert.equal(engine.search_solve(voxels.length, 5, 5, 5), 3);
  assert.equal(engine.search_moves(), 6);
  write();
  assert.equal(engine.search_solve(voxels.length, 5, 5, 10000), 1);
  assert.equal(engine.search_moves(), 6);
});
