import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { countActiveRoleV1, engineStatesEqualV1 } from "../engine/v1/adapter.mjs";
import { loadBenchmarkAssets } from "../benchmarking/v1/runtime.mjs";
import {
  ENGINE_SOURCE_COMMIT,
  ENGINE_SOURCE_REPOSITORY,
  ENGINE_SOURCE_TREE,
  ENGINE_WASM_SHA256,
  instantiateMazeBenchEngineV1
} from "../engine/v1/engine.mjs";
import { cameraRelativeMoveDirection } from "../play/v1/camera-relative-input.mjs";
import { decodeVoxelRoom } from "../render/v1/voxel-world-v2.mjs";
import { ConnectedWorldSessionV1 } from "../play/v1/connected-world-session.mjs";
import {
  DEFAULT_PLAY_FRAME_DELAY_MS,
  PlaySessionV1
} from "../play/v1/play-session.mjs";

const blocks = [
  { id: "floor", roleId: "floor", visual: { kind: "floor" } },
  { id: "ice-floor", roleId: "ice", visual: { kind: "floor" } },
  { id: "wall", roleId: "solid", visual: { kind: "cube" } },
  { id: "player", roleId: "player", visual: { kind: "cube" } },
  { id: "gem", roleId: "goal", visual: { kind: "model" } },
  { id: "gate", roleId: "player-gate", visual: { kind: "gate" } },
  { id: "puncher", roleId: "puncher", visual: { kind: "puncher" } },
  { id: "crate", roleId: "pushable", visual: { kind: "cube" } },
  { id: "floating-floor", roleId: "floating-floor", visual: { kind: "platform" } }
];

async function loadEngine() {
  const bytes = await readFile(new URL("../engine/v1/voxel_physics.wasm", import.meta.url));
  return { bytes, engine: await instantiateMazeBenchEngineV1(bytes) };
}

test("play arrows rotate from screen space into world space at every camera heading", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((heading) =>
      ["up", "right", "down", "left"].map((direction) =>
        cameraRelativeMoveDirection(direction, heading))),
    [
      ["up", "right", "down", "left"],
      ["left", "up", "right", "down"],
      ["down", "left", "up", "right"],
      ["right", "down", "left", "up"]
    ]
  );
  assert.equal(cameraRelativeMoveDirection("unknown", 0), null);
  assert.equal(cameraRelativeMoveDirection("up", -1), "right");
});

test("play animation timing defaults to 20 ms and zero skips to the final frame", async () => {
  assert.equal(DEFAULT_PLAY_FRAME_DELAY_MS, 20);
  const room = {
    width: 1,
    height: 3,
    objects: [{ x: 0, y: 2, z: 0, blockId: "player" }]
  };
  const middle = {
    ...room,
    objects: [{ x: 0, y: 1, z: 0, blockId: "player" }]
  };
  const final = {
    ...room,
    objects: [{ x: 0, y: 0, z: 0, blockId: "player" }]
  };
  const seen = [];
  const fakeEngine = {
    createState: (value) => structuredClone(value),
    simulateCommand: async () => ({ frames: [middle, final], final, cycle: null })
  };
  const session = new PlaySessionV1(fakeEngine, blocks, {
    frameDelay: 0,
    onFrame: (state) => seen.push(state.objects[0].y)
  });
  session.open(room);
  seen.length = 0;
  await session.move("up");
  assert.deepEqual(seen, [0]);
  assert.equal(session.state.objects[0].y, 0);
  assert.equal(session.setFrameDelay(105), 105);
  assert.throws(() => session.setFrameDelay(-1), /non-negative number/);
});

test("play v1 leaves ineffective commands out of moves and undo history", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 2,
    height: 1,
    objects: [
      { x: 0, y: 0, z: 0, blockId: "player" },
      { x: 0, y: 0, z: 0, blockId: "floor" },
      { x: 1, y: 0, z: 0, blockId: "floor" }
    ]
  };
  const changes = [];
  const session = new PlaySessionV1(engine, blocks, {
    frameDelay: 0,
    onChange: (summary) => changes.push(summary)
  });
  session.open(room);

  await session.move("left");
  assert.equal(session.moves, 0);
  assert.equal(session.history.length, 0);
  assert.equal(changes.at(-1).canUndo, false);

  await session.move("right");
  await session.move("right");
  assert.equal(session.moves, 1);
  assert.equal(session.history.length, 1);
  assert.equal(session.undo(), true);
  assert.equal(session.state.objects[0].x, 0);
});

test("the shipped Play engine crosses LxL north into LxK and returns without losing input", async () => {
  const assets = await loadBenchmarkAssets(new URL("..", import.meta.url).pathname);
  const original = assets.roomsByLabel.get("LXL");
  const session = new PlaySessionV1(assets.engine, assets.blocks, {
    frameDelay: 0,
    resolveCommand: (state, room, direction) => assets.connectedWorld.simulateCommand(state, room, direction)
  });
  session.open(original);
  const initial = structuredClone(session.state);
  for (let step = 0; step < 4; step += 1) await session.move("up");
  assert.deepEqual(session.room.position, ["L", "K"]);
  assert.deepEqual(session.state.objects.find(o => o.blockId === "player"), { x: 7, y: 14, z: 0, blockId: "player" });
  assert.equal(session.moves, 4);
  for (let step = 0; step < 4; step += 1) await session.move("down");
  assert.equal(session.room, original);
  assert.deepEqual(session.state.objects.find(o => o.blockId === "player"), initial.objects.find(o => o.blockId === "player"));
  assert.equal(session.moves, 8);
});

test("HxM's first left move keeps both tall boxes stacked after the ramp landing", async () => {
  const assets = await loadBenchmarkAssets(new URL("..", import.meta.url).pathname);
  // Freeze the reported room so future authored edits do not erase this case.
  const authored = JSON.parse(await readFile(
    new URL("./fixtures/hxm-ramp-stack.json", import.meta.url), "utf8"));
  const room = {
    ...assets.roomsByLabel.get("HXM"),
    ...decodeVoxelRoom(authored)
  };
  const connected = new ConnectedWorldSessionV1(assets.engine, assets.blocks,
    assets.rooms.map((value) => value.fileName === room.fileName ? room : value));
  const stack = (state) => state.objects.filter((object) =>
    object.blockId === "weightless-box" && object.y === 2 &&
    (object.genericId === 10 || object.genericId === 11));
  const initial = stack(room);
  assert.equal(initial.length, 4);
  for (const throughWorld of [false, true]) {
    const result = throughWorld
      ? await connected.simulateCommand(assets.engine.createState(room), room, "left")
      : await assets.engine.simulateCommand(room, "left", assets.blocks);
    assert.equal(result.cycle, null);
    assert.ok(result.frames.length >= 5);
    result.frames.forEach((frame, index) => {
      const steps = Math.min(index + 1, 5);
      assert.deepEqual(stack(frame.state || frame), initial.map((object) => ({
        ...object, x: object.x - steps, z: object.z + Math.min(steps, 4)
      })), `the stack must remain together in animation frame ${index + 1}`);
    });
    assert.deepEqual(stack(result.final.state || result.final), initial.map((object) => ({
      ...object, x: 7, z: object.z + 4
    })));
  }
});

test("a wide clone's blocked ramp reflection settles without an idle retry loop", async () => {
  const { engine } = await loadEngine();
  const definitions = [...blocks,
    { id: "clone", roleId: "clone", visual: { kind: "cube" } },
    { id: "ice-slope", roleId: "ice", visual: { kind: "slope" } }
  ];
  const room = { width: 16, height: 16, objects: [
    { x: 5, y: 10, z: 0, blockId: "player" }
  ] };
  for (let x = 5; x <= 8; x += 1) {
    for (let y = 6; y <= 9; y += 1) {
      if (x === 5 || x === 8 || y === 6 || y === 9) {
        room.objects.push({ x, y, z: 0, blockId: "clone", genericId: 0, groupId: 0 });
      }
    }
    room.objects.push({ x, y: 4, z: 0, blockId: "wall" },
      { x, y: 4, z: 1, blockId: "wall" },
      { x, y: 5, z: 0, blockId: "ice-slope", orientation: "up" });
  }
  for (let x = 0; x < 16; x += 1) {
    for (let y = 0; y < 16; y += 1) room.objects.push({ x, y, z: 0, blockId: "floor" });
  }
  const result = await engine.simulateCommand(room, "up", definitions);
  assert.equal(result.cycle, null);
  assert.equal(result.frames.length, 1);
  assert.deepEqual(result.final.objects, room.objects.map((object) =>
    object.blockId === "clone" ? { ...object, y: object.y - 1, z: object.z + 1 }
      : object.blockId === "player" ? { ...object, y: object.y - 1 } : object));
});

test("side lifts preserve a stable lowered state or retry a blocked departure on a separate tick", async () => {
  const { engine } = await loadEngine();
  const definitions = [...blocks,
    { id: "side-lift", roleId: "player-lift", visual: { kind: "lift" } },
    { id: "weightless", roleId: "weightless-pushable", visual: { kind: "cube" } }
  ];
  for (const blocked of [false, true]) {
    const room = { width: 7, height: 7, objects: [
      { x: 3, y: 3, z: 0, blockId: "player" },
      { x: 3, y: 3, z: 0, blockId: "side-lift", orientation: "east", genericId: 4 },
      { x: 2, y: 3, z: 0, blockId: "weightless", genericId: 0 },
      { x: 1, y: 3, z: 0, blockId: "wall" }
    ] };
    if (blocked) room.objects.push({ x: 4, y: 3, z: 0, blockId: "wall" });
    for (let x = 0; x < 7; x += 1) {
      for (let y = 0; y < 7; y += 1) room.objects.push({ x, y, z: 0, blockId: "floor" });
    }
    const result = await engine.simulateCommand(room, "up", definitions);
    assert.equal(result.cycle, null);
    assert.equal(result.frames.length, blocked ? 2 : 1);
    result.frames.forEach((frame, index) => {
      assert.equal(frame.objects[1].genericId, blocked && index === 1 ? 5 : 4);
      assert.deepEqual(frame.objects.map(({ x, y, z }) => [x, y, z]),
        room.objects.map((object) =>
          [object.x, object.y - (object.blockId === "player" ? 1 : 0), object.z]));
    });
    assert.equal(result.final.objects[1].genericId, blocked ? 5 : 4);
  }
});

test("MxA's first Up pushes its box and lowered side lifts despite the remote ramp", async () => {
  const assets = await loadBenchmarkAssets(new URL("..", import.meta.url).pathname);
  const authored = JSON.parse(await readFile(
    new URL("./fixtures/mxa-mounted-lift-push.json", import.meta.url), "utf8"));
  const room = { ...assets.roomsByLabel.get("MXA"), ...decodeVoxelRoom(authored) };
  const expected = { ...room, objects: room.objects.map((object) => {
    const moves = object.blockId === "player" ||
      (object.blockId === "weightless-box" && object.groupId === 1) ||
      (object.blockId === "lift" && object.y === 7 && object.stateId === 0);
    return moves ? { ...object, y: object.y - 1 } : object;
  }) };
  const connected = new ConnectedWorldSessionV1(assets.engine, assets.blocks,
    assets.rooms.map((value) => value.fileName === room.fileName ? room : value));
  for (const throughWorld of [false, true]) {
    const result = throughWorld
      ? await connected.simulateCommand(assets.engine.createState(room), room, "up")
      : await assets.engine.simulateCommand(room, "up", assets.blocks);
    assert.equal(result.cycle, null);
    assert.equal(result.frames.length, 1);
    assert.ok(engineStatesEqualV1(result.frames[0].state || result.frames[0],
      expected, assets.blocks));
    assert.ok(engineStatesEqualV1(result.final.state || result.final,
      expected, assets.blocks));
  }
});

test("MxA's second Up pushes both boxes through their raised mounted lifts", async () => {
  const assets = await loadBenchmarkAssets(new URL("..", import.meta.url).pathname);
  const authored = JSON.parse(await readFile(
    new URL("./fixtures/mxa-second-up.json", import.meta.url), "utf8"));
  const room = { ...assets.roomsByLabel.get("MXA"), ...decodeVoxelRoom(authored) };
  const connected = new ConnectedWorldSessionV1(assets.engine, assets.blocks,
    assets.rooms.map(value => value.fileName === room.fileName ? room : value));
  for (const throughWorld of [false, true]) {
    let state = assets.engine.createState(room);
    for (let command = 1; command <= 2; ++command) {
      const expected = { ...room, objects: room.objects.map(object => {
        const distance = object.blockId === "player" ||
          object.blockId === "weightless-box" && object.groupId === 2 ||
          object.blockId === "lift" && object.x === 6 && object.y === 4
          ? command
          : object.blockId === "weightless-box" && object.groupId === 3 ||
            object.blockId === "lift" && object.x === 6 && object.y === 2
            ? command - 1 : 0;
        return { ...object, y: object.y - distance };
      }) };
      const result = throughWorld
        ? await connected.simulateCommand(state, room, "up")
        : await assets.engine.simulateCommand(state, "up", assets.blocks);
      const context = `${throughWorld ? "connected" : "direct"}, Up ${command}`;
      assert.equal(result.cycle, null, context);
      assert.equal(result.frames.length, 1, context);
      assert.ok(engineStatesEqualV1(result.frames[0].state || result.frames[0],
        expected, assets.blocks), `${context}: every animated object`);
      state = result.final.state || result.final;
      assert.ok(engineStatesEqualV1(state, expected, assets.blocks), `${context}: final state`);
    }
  }
});

test("MxA's third Up pushes the small box and its collapsed lifts", async () => {
  const assets = await loadBenchmarkAssets(new URL("..", import.meta.url).pathname);
  const authored = JSON.parse(await readFile(
    new URL("./fixtures/mxa-third-up.json", import.meta.url), "utf8"));
  const room = { ...assets.roomsByLabel.get("MXA"), ...decodeVoxelRoom(authored) };
  const connected = new ConnectedWorldSessionV1(assets.engine, assets.blocks,
    assets.rooms.map(value => value.fileName === room.fileName ? room : value));
  for (const throughWorld of [false, true]) {
    let state = assets.engine.createState(room);
    for (let command = 1; command <= 3; ++command) {
      const expected = { ...room, objects: room.objects.map(object => {
        const largeAssembly = object.blockId === "player" ||
          object.blockId === "weightless-box" && object.groupId === 0 ||
          object.blockId === "lift" && object.stateId === 1 &&
            object.y >= 10 && object.y <= 13 &&
            (object.x === 6 || object.x === 10 || object.y === 13);
        const smallAssembly = object.blockId === "weightless-box" && object.groupId === 2 ||
          object.blockId === "lift" && object.stateId === 0 &&
            object.x >= 7 && object.x <= 9 && object.y >= 6 && object.y <= 8;
        return { ...object, y: object.y - (largeAssembly ? command :
          smallAssembly ? Math.max(0, command - 2) : 0) };
      }) };
      const result = throughWorld
        ? await connected.simulateCommand(state, room, "up")
        : await assets.engine.simulateCommand(state, "up", assets.blocks);
      const context = `${throughWorld ? "connected" : "direct"}, Up ${command}`;
      assert.equal(result.cycle, null, context);
      assert.equal(result.frames.length, 1, context);
      assert.ok(engineStatesEqualV1(result.frames[0].state || result.frames[0],
        expected, assets.blocks), `${context}: every animated object`);
      state = result.final.state || result.final;
      assert.ok(engineStatesEqualV1(state, expected, assets.blocks), `${context}: final state`);
    }
  }
});

test("JxA Down twice moves only the player and its contacted box", async () => {
  const assets = await loadBenchmarkAssets(new URL("..", import.meta.url).pathname);
  const authored = JSON.parse(await readFile(
    new URL("./fixtures/jxa-isolated-push.json", import.meta.url), "utf8"));
  const room = { ...assets.roomsByLabel.get("JXA"), ...decodeVoxelRoom(authored) };
  const connected = new ConnectedWorldSessionV1(assets.engine, assets.blocks,
    assets.rooms.map((value) => value.fileName === room.fileName ? room : value));
  for (const throughWorld of [false, true]) {
    let state = assets.engine.createState(room);
    for (let command = 1; command <= 2; ++command) {
      const expected = { ...room, objects: room.objects.map((object) => {
        const distance = object.blockId === "player" ? command :
          object.blockId === "weightless-box" && object.groupId === 1 ? command - 1 : 0;
        return { ...object, y: object.y + distance };
      }) };
      const result = throughWorld
        ? await connected.simulateCommand(state, room, "down")
        : await assets.engine.simulateCommand(state, "down", assets.blocks);
      const context = `${throughWorld ? "connected" : "direct"}, Down ${command}`;
      assert.equal(result.cycle, null, context);
      assert.equal(result.frames.length, 1, context);
      assert.ok(engineStatesEqualV1(result.frames[0].state || result.frames[0],
        expected, assets.blocks), `${context}: every animated object`);
      state = result.final.state || result.final;
      assert.ok(engineStatesEqualV1(state, expected, assets.blocks), `${context}: final state`);
    }
  }
});

test("connected play reloads rooms normally and undo crosses back with exact state", async () => {
  const { engine } = await loadEngine();
  const roomA = {
    fileName: "a.json",
    position: ["A", "A"],
    columnIndex: 0,
    rowIndex: 0,
    width: 3,
    height: 2,
    objects: [
      { x: 1, y: 0, z: 0, blockId: "player" },
      { x: 1, y: 0, z: 0, blockId: "floor" },
      { x: 2, y: 0, z: 0, blockId: "floor" },
      { x: 0, y: 1, z: 0, blockId: "gem" }
    ]
  };
  const roomB = {
    fileName: "b.json",
    position: ["B", "A"],
    columnIndex: 1,
    rowIndex: 0,
    width: 3,
    height: 2,
    objects: [
      { x: 1, y: 1, z: 0, blockId: "player" },
      { x: 0, y: 0, z: 0, blockId: "floor" }
    ]
  };
  const connectedWorld = new ConnectedWorldSessionV1(engine, blocks, [roomA, roomB]);
  const entered = [];
  const session = new PlaySessionV1(engine, blocks, {
    frameDelay: 0,
    onRoomChange: (room) => entered.push(room.fileName),
    resolveCommand: (state, room, direction) =>
      connectedWorld.simulateCommand(state, room, direction)
  });
  session.open(roomA);
  session.state.objects.find((object) => object.blockId === "gem").x = -1;

  await session.move("right");
  assert.equal(session.room, roomA);
  assert.deepEqual(
    session.state.objects.filter((object) => object.blockId === "player")
      .map(({ x, y }) => ({ x, y })),
    [{ x: 2, y: 0 }]
  );
  const stateBeforeTransition = structuredClone(session.state);

  await session.move("right");
  assert.equal(session.room, roomB);
  assert.deepEqual(
    session.state.objects.filter((object) => object.blockId === "player")
      .map(({ x, y }) => ({ x, y })),
    [{ x: 0, y: 0 }]
  );
  assert.equal(session.history.length, 2);

  assert.equal(session.undo(), true);
  assert.equal(session.room, roomA);
  assert.deepEqual(
    session.state.objects.filter((object) => object.blockId === "player")
      .map(({ x, y }) => ({ x, y })),
    [{ x: 2, y: 0 }]
  );
  assert.deepEqual(session.state, stateBeforeTransition);
  assert.equal(session.moves, 1);
  assert.deepEqual(entered, ["b.json", "a.json"]);

  await session.move("right");
  assert.equal(session.room, roomB);

  await session.move("left");
  assert.equal(session.room, roomA);
  assert.equal(session.state.objects.some((object) =>
    object.blockId === "gem" && object.x === 0 && object.y === 1), true);
  assert.equal(session.moves, 3);
  assert.deepEqual(entered, ["b.json", "a.json", "b.json", "a.json"]);
});

test("one Ice command dynamically combines only the rooms reached by a long slide", async () => {
  const { engine } = await loadEngine();
  const makeRoom = (fileName, columnIndex, objects) => ({
    fileName,
    position: [String.fromCharCode(65 + columnIndex), "A"],
    columnIndex,
    rowIndex: 0,
    width: 3,
    height: 2,
    objects
  });
  const support = (blockId, x) => ({ x, y: 0, z: 0, blockId });
  const roomA = makeRoom("ice-a.json", 0, [
    { x: 0, y: 0, z: 0, blockId: "player" },
    support("floor", 0),
    support("ice-floor", 1),
    support("ice-floor", 2)
  ]);
  const roomB = makeRoom("ice-b.json", 1, [
    { x: 1, y: 1, z: 0, blockId: "player" },
    support("ice-floor", 0),
    support("ice-floor", 1),
    support("ice-floor", 2)
  ]);
  const roomC = makeRoom("ice-c.json", 2, [
    { x: 1, y: 1, z: 0, blockId: "player" },
    support("ice-floor", 0),
    support("ice-floor", 1),
    support("floor", 2)
  ]);
  const connectedWorld = new ConnectedWorldSessionV1(engine, blocks, [roomA, roomB, roomC]);
  const result = await connectedWorld.simulateCommand(engine.createState(roomA), roomA, "right");

  assert.equal(result.room, roomC);
  assert.deepEqual(
    result.final.objects.filter((object) => object.blockId === "player")
      .map(({ x, y }) => ({ x, y })),
    [{ x: 2, y: 0 }]
  );
  assert.deepEqual([...new Set(result.animationFrames.map(({ room }) => room.fileName))], [
    "ice-a.json",
    "ice-b.json",
    "ice-c.json"
  ]);
});

test("a redirected punch grows an L-shaped temporary level without adding the missing room", async () => {
  const { engine } = await loadEngine();
  const makeRoom = (fileName, columnIndex, rowIndex, objects) => ({
    fileName,
    position: [String.fromCharCode(65 + columnIndex), String.fromCharCode(65 + rowIndex)],
    columnIndex,
    rowIndex,
    width: 4,
    height: 4,
    objects
  });
  const floor = (x, y) => ({ x, y, z: 0, blockId: "floor" });
  const roomA = makeRoom("punch-a.json", 0, 0, [
    { x: 1, y: 2, z: 0, blockId: "player" },
    { x: 1, y: 1, z: 0, blockId: "puncher", orientation: "right", stateId: 0 },
    floor(1, 2), floor(1, 1), floor(2, 1), floor(3, 1)
  ]);
  const roomB = makeRoom("punch-b.json", 1, 0, [
    { x: 0, y: 1, z: 0, blockId: "player" },
    { x: 2, y: 1, z: 0, blockId: "puncher", orientation: "down", stateId: 0 },
    floor(0, 1), floor(1, 1), floor(2, 1), floor(2, 2), floor(2, 3)
  ]);
  const roomC = makeRoom("punch-c.json", 1, 1, [
    { x: 0, y: 0, z: 0, blockId: "player" },
    floor(2, 0), floor(2, 1), floor(2, 2), floor(2, 3),
    { x: 2, y: 3, z: 0, blockId: "wall" }
  ]);
  const unvisitedRoom = makeRoom("not-visited.json", 0, 1, [
    { x: 0, y: 0, z: 0, blockId: "player" },
    floor(0, 0)
  ]);
  const connectedWorld = new ConnectedWorldSessionV1(
    engine,
    blocks,
    [roomA, roomB, roomC, unvisitedRoom]
  );
  const result = await connectedWorld.simulateCommand(engine.createState(roomA), roomA, "up");

  assert.equal(result.room, roomC);
  assert.deepEqual(
    result.final.objects.filter((object) => object.blockId === "player")
      .map(({ x, y }) => ({ x, y })),
    [{ x: 2, y: 2 }]
  );
  assert.deepEqual([...new Set(result.animationFrames.map(({ room }) => room.fileName))], [
    "punch-a.json",
    "punch-b.json",
    "punch-c.json"
  ]);
  assert.equal(result.connectedRooms.includes("not-visited.json"), false);
});

test("engine v1 is the byte-identical UnitTest WebAssembly build", async () => {
  const { bytes, engine } = await loadEngine();
  assert.match(ENGINE_SOURCE_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), ENGINE_WASM_SHA256);
  assert.deepEqual(engine.info, {
    version: "v1",
    abi: 4,
    voxelCapacity: 65_536,
    searchVoxelCapacity: 4_096,
    searchNodeCapacity: 180_000
  });
});

test("every vendored engine file matches its recorded upstream hash", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../engine/v1/upstream.json", import.meta.url), "utf8")
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.sourceRepository, ENGINE_SOURCE_REPOSITORY);
  assert.equal(manifest.sourceCommit, ENGINE_SOURCE_COMMIT);
  assert.equal(manifest.sourceTree, ENGINE_SOURCE_TREE);
  assert.equal(manifest.wasm.sha256, ENGINE_WASM_SHA256);

  const wasm = await readFile(new URL("../engine/v1/voxel_physics.wasm", import.meta.url));
  assert.equal(wasm.byteLength, manifest.wasm.bytes);
  assert.equal(createHash("sha256").update(wasm).digest("hex"), manifest.wasm.sha256);

  for (const entry of manifest.files) {
    assert.equal(entry.path.startsWith("/") || entry.path.includes(".."), false);
    const contents = await readFile(new URL(`../engine/v1/core/${entry.path}`, import.meta.url));
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      entry.sha256,
      `vendored engine file differs: ${entry.path}`
    );
  }
});

test("exact solver and play commands share the copied engine", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 3,
    height: 3,
    objects: [
      { x: 1, y: 2, z: 0, blockId: "player" },
      { x: 1, y: 2, z: 0, blockId: "floor" },
      { x: 1, y: 1, z: 0, blockId: "floor" },
      { x: 1, y: 0, z: 0, blockId: "floor" },
      { x: 1, y: 0, z: 0, blockId: "gem" }
    ]
  };
  const result = engine.solve(room, blocks, { maximumNodes: 1_000 });
  assert.equal(result.status, "solved");
  assert.equal(result.proven, true);
  assert.deepEqual(result.solution, ["up", "up"]);

  let state = engine.createState(room);
  for (const direction of result.solution) {
    state = (await engine.simulateCommand(state, direction, blocks)).final;
  }
  assert.equal(countActiveRoleV1(state, blocks, "goal"), 0);
  assert.deepEqual(state.objects[0], { x: 1, y: 0, z: 0, blockId: "player" });
});

test("edge finder enumerates shortest boundary witnesses without gems", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 3,
    height: 3,
    objects: [{ x: 1, y: 1, z: 0, blockId: "player" }]
  };
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      room.objects.push({ x, y, z: 0, blockId: "floor" });
    }
  }
  const result = engine.findEdges(room, blocks, { maximumNodes: 1_000 });
  assert.equal(result.status, "solved");
  assert.equal(result.proven, true);
  assert.equal(result.edgeCount, 12);
  assert.equal(result.edges.length, 12);
  assert.deepEqual(result.edges[0].solution, ["up", "up"]);

  const dynamic = {
    width: 4,
    height: 3,
    objects: [
      { x: 1, y: 2, z: 0, blockId: "player" },
      { x: 1, y: 1, z: 0, blockId: "crate" }
    ]
  };
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      dynamic.objects.push({ x, y, z: 0, blockId: "floor" });
    }
  }
  const variants = engine.findEdges(dynamic, blocks, { maximumNodes: 1_000 });
  assert.ok(variants.edgeCount > 14, "different dynamic board states share edge coordinates");
});

test("storage-v2 surface Ice produces the engine's multi-tick slide", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 3,
    height: 5,
    objects: [
      { x: 1, y: 4, z: 0, blockId: "player" },
      { x: 1, y: 4, z: 0, blockId: "floor" },
      { x: 1, y: 3, z: 0, blockId: "ice-floor" },
      { x: 1, y: 2, z: 0, blockId: "ice-floor" },
      { x: 1, y: 1, z: 0, blockId: "ice-floor" },
      { x: 1, y: 0, z: 0, blockId: "floor" }
    ]
  };
  const result = await engine.simulateCommand(room, "up", blocks);
  assert.deepEqual(result.frames.map((frame) => frame.objects[0].y), [3, 2, 1, 0]);
  assert.equal(result.final.objects[0].y, 0);
});

test("player gates rise one frame after the player approaches", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 6,
    height: 6,
    objects: [
      { x: 0, y: 5, z: 0, blockId: "player" },
      { x: 0, y: 3, z: 0, blockId: "gate", stateId: 0 },
      { x: 0, y: 3, z: 0, blockId: "floor" },
      { x: 0, y: 4, z: 0, blockId: "floor" },
      { x: 0, y: 5, z: 0, blockId: "floor" }
    ]
  };
  const result = await engine.simulateCommand(room, "up", blocks);
  assert.equal(result.frames.length, 2);
  assert.equal(result.frames[0].objects[0].y, 4);
  assert.equal(result.frames[0].objects[1].stateId, 0);
  assert.equal(result.frames[1].objects[1].stateId, 1);
  assert.equal(result.final.objects[1].stateId, 1);
});

test("punchers encode direction, expose their sprung frame, and reset", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 5,
    height: 5,
    objects: [
      { x: 1, y: 3, z: 0, blockId: "player" },
      { x: 1, y: 2, z: 0, blockId: "puncher", orientation: "right", stateId: 0 },
      { x: 0, y: 2, z: 0, blockId: "wall" },
      { x: 4, y: 2, z: 0, blockId: "wall" },
      { x: 1, y: 3, z: 0, blockId: "floor" },
      { x: 1, y: 2, z: 0, blockId: "floor" },
      { x: 2, y: 2, z: 0, blockId: "floor" },
      { x: 3, y: 2, z: 0, blockId: "floor" },
      { x: 4, y: 2, z: 0, blockId: "floor" }
    ]
  };
  const result = await engine.simulateCommand(room, "up", blocks);
  assert.equal(result.frames.some((frame) => frame.objects[1].stateId === 1), true);
  assert.deepEqual(
    { x: result.final.objects[0].x, y: result.final.objects[0].y },
    { x: 3, y: 2 }
  );
  assert.equal(result.final.objects[1].orientation, "right");
  assert.equal(result.final.objects[1].stateId, 0);
});

test("a punched player and blue slope box cross a floor gap without losing their impulse", async () => {
  const { engine } = await loadEngine();
  const slopeBlocks = [...blocks, {
    id: "blue-slope", roleId: "weightless-pushable", visual: { kind: "slope" }
  }];
  const room = {
    width: 16, height: 16,
    objects: [
      { x: 4, y: 6, z: 0, blockId: "player" },
      { x: 5, y: 5, z: 0, blockId: "blue-slope", orientation: "up", groupId: 17 },
      { x: 4, y: 5, z: 0, blockId: "puncher", orientation: "right", stateId: 0 },
      { x: 3, y: 5, z: 0, blockId: "wall" },
      { x: 14, y: 5, z: 0, blockId: "wall" }
    ]
  };
  for (let y = 0; y < 16; ++y) {
    for (let x = 0; x < 16; ++x) {
      if ((x === 9 || x === 10) && y === 5) continue;
      room.objects.push({ x, y, z: 0, blockId: "floor" });
    }
  }
  const result = await engine.simulateCommand(room, "up", slopeBlocks);
  assert.equal(result.cycle, null);
  assert.equal(result.frames.length, 9);
  result.frames.forEach((frame, index) => {
    assert.deepEqual(
      frame.objects.slice(0, 2).map(({ x, y, z }) => ({ x, y, z })),
      [{ x: index === 0 ? 4 : 4 + index, y: 5, z: 0 },
       { x: 5 + index, y: 5, z: 0 }],
      `animation frame ${index + 1}`
    );
    assert.equal(frame.objects[2].stateId, index === 1 ? 1 : 0);
  });
  assert.ok(engineStatesEqualV1(result.final, result.frames.at(-1), slopeBlocks));
});

test("a floating floor fills a Row-0 hole on the following tick", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 6,
    height: 6,
    objects: [
      { x: 0, y: 5, z: 0, blockId: "player" },
      { x: 0, y: 4, z: 0, blockId: "floating-floor" },
      { x: 0, y: 4, z: 0, blockId: "floor" },
      { x: 0, y: 5, z: 0, blockId: "floor" }
    ]
  };
  const result = await engine.simulateCommand(room, "up", blocks);
  assert.equal(result.frames.length, 2);
  assert.deepEqual(
    { y: result.frames[0].objects[1].y, z: result.frames[0].objects[1].z,
      blockId: result.frames[0].objects[1].blockId },
    { y: 3, z: 0, blockId: "floating-floor" }
  );
  assert.deepEqual(
    { y: result.final.objects[1].y, z: result.final.objects[1].z,
      blockId: result.final.objects[1].blockId },
    { y: 3, z: 0, blockId: "floor" }
  );
});

test("play v1 undo restores the prior engine state and reset clears history", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 3,
    height: 3,
    objects: [
      { x: 1, y: 2, z: 0, blockId: "player" },
      { x: 1, y: 2, z: 0, blockId: "floor" },
      { x: 1, y: 1, z: 0, blockId: "floor" },
      { x: 1, y: 0, z: 0, blockId: "floor" }
    ]
  };
  const changes = [];
  const session = new PlaySessionV1(engine, blocks, {
    frameDelay: 0,
    onChange: (summary) => changes.push(summary)
  });
  session.open(room);

  await session.move("up");
  assert.equal(session.moves, 1);
  assert.equal(session.state.objects[0].y, 1);
  assert.equal(changes.at(-1).canUndo, true);

  assert.equal(session.undo(), true);
  assert.equal(session.moves, 0);
  assert.equal(session.state.objects[0].y, 2);
  assert.equal(changes.at(-1).undone, true);
  assert.equal(changes.at(-1).canUndo, false);

  await session.move("up");
  session.reset();
  assert.equal(session.moves, 0);
  assert.equal(session.state.objects[0].y, 2);
  assert.equal(changes.at(-1).reset, true);
  assert.equal(session.undo(), false);
});

test("play v1 continues accepting movement after the final gem is collected", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 3,
    height: 4,
    objects: [
      { x: 1, y: 3, z: 0, blockId: "player" },
      { x: 1, y: 3, z: 0, blockId: "floor" },
      { x: 1, y: 2, z: 0, blockId: "floor" },
      { x: 1, y: 2, z: 0, blockId: "gem" },
      { x: 1, y: 1, z: 0, blockId: "floor" }
    ]
  };
  const changes = [];
  const session = new PlaySessionV1(engine, blocks, {
    frameDelay: 0,
    onChange: (summary) => changes.push(summary)
  });
  session.open(room);

  await session.move("up");
  assert.equal(session.gemCount, 0);
  assert.equal(session.state.objects[0].y, 2);
  await session.move("up");
  assert.equal(session.moves, 2);
  assert.equal(session.state.objects[0].y, 1);
  assert.equal(changes.at(-1).playerActive, true);
  assert.equal("solved" in changes.at(-1), false);
});

test("room scopes isolate orange pressure throughout entry and re-entry", async () => {
  const { engine } = await loadEngine();
  const definitions = [...blocks,
    { id: "orange-button", roleId: "orange-button" },
    { id: "orange-wall", roleId: "orange-wall" },
    { id: "weightless-box", roleId: "weightless-pushable" }
  ];
  const floor = Array.from({ length: 24 }, (_, i) => ({ x: i % 6, y: Math.floor(i / 6), z: 0, blockId: "floor" }));
  const source = {
    fileName: "source.json", position: ["A", "A"], columnIndex: 0, rowIndex: 0, width: 6, height: 4,
    objects: [...floor, { x: 5, y: 1, z: 0, blockId: "player" },
      { x: 2, y: 2, z: 0, blockId: "orange-button", orientation: "top" },
      { x: 1, y: 2, z: 0, blockId: "weightless-box", groupId: 0 }]
  };
  const destination = {
    ...source, fileName: "destination.json", position: ["B", "A"], columnIndex: 1,
    objects: [...floor, { x: 1, y: 3, z: 0, blockId: "player" },
      { x: 0, y: 2, z: 0, blockId: "orange-button", orientation: "top" },
      { x: 4, y: 2, z: 0, blockId: "orange-wall" },
      { x: 4, y: 2, z: 1, blockId: "orange-wall" }]
  };
  const world = new ConnectedWorldSessionV1(engine, definitions, [source, destination]);
  const initial = engine.createState(source);
  initial.objects.find(o => o.blockId === "weightless-box").x = 2;
  const entry = await world.simulateCommand(initial, source, "right");
  const walls = state => state.objects.filter(o => o.blockId === "orange-wall").map(o => [o.z, o.mechanismDepth]);
  assert.equal(entry.room, destination);
  assert.deepEqual(walls(entry.final), [[0, 0], [1, 0]]);
  for (const frame of entry.animationFrames.filter(frame => frame.room === destination)) {
    assert.deepEqual(walls(frame.state), [[0, 0], [1, 0]]);
    assert(frame.state.objects.every(object => object.connectedWorldOrangeScope === undefined));
  }
  assert.deepEqual(entry.animationFrames.at(-1).state, entry.final);
  assert.deepEqual(entry.final.objects.find(o => o.blockId === "player"), { x: 0, y: 1, z: 0, blockId: "player" });
  const held = await world.simulateCommand(entry.final, destination, "down");
  assert.deepEqual(walls(held.final), [[-1, 1], [0, 1]]);
  const released = await world.simulateCommand(held.final, destination, "up");
  assert.deepEqual(walls(released.final), [[0, 0], [1, 0]]);
  const back = await world.simulateCommand(released.final, destination, "left");
  assert.equal(back.final.objects.find(o => o.blockId === "weightless-box").x, 1);
  const reentry = await world.simulateCommand(back.final, source, "right");
  assert.deepEqual(walls(reentry.final), [[0, 0], [1, 0]]);
  assert.deepEqual(destination.objects.filter(o => o.blockId === "orange-wall").map(o => o.z), [0, 1]);
});

test("LxL box-on-button crossing keeps every LxK orange wall raised in every frame", async () => {
  const assets = await loadBenchmarkAssets(new URL("..", import.meta.url).pathname);
  const source = assets.roomsByLabel.get("LXL");
  const destination = assets.roomsByLabel.get("LXK");
  const authored = structuredClone(destination.objects);
  const actions = [...Array(4).fill("left"), "down", ...Array(7).fill("right"), "left", ...Array(4).fill("up")];
  let room = source;
  let state = assets.engine.createState(source);
  let destinationFrames = 0;
  for (const [index, action] of actions.entries()) {
    const command = await assets.connectedWorld.simulateCommand(state, room, action);
    for (const frame of command.animationFrames) {
      assert(frame.state.objects.every(object => object.connectedWorldOrangeScope === undefined));
      if (frame.room !== destination) continue;
      destinationFrames += 1;
      const walls = frame.state.objects.filter(object => object.blockId === "orange-wall");
      assert.equal(walls.length, 24);
      assert(walls.every(wall => wall.z === 0 && wall.mechanismDepth === 0), `step ${index + 1}: neighboring button lowered a wall`);
    }
    state = command.final;
    room = command.room || room;
    if (index === 15) {
      assert.equal(room, source);
      assert(state.objects.some(object => object.blockId === "weightless-box" && object.x === 11 && object.y === 3));
      assert(state.objects.filter(object => object.blockId === "orange-wall").every(wall => wall.mechanismDepth === 1));
    }
  }
  assert.equal(room, destination);
  assert(destinationFrames > 0);
  assert.deepEqual(state.objects.find(object => object.blockId === "player"), { x: 9, y: 15, z: 0, blockId: "player" });
  assert.deepEqual(destination.objects, authored);
});
