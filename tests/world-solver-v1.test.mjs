import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { instantiateMazeBenchEngineV1 } from "../engine/v1/engine.mjs";
import {
  readEngineStateV1
} from "../engine/v1/adapter.mjs";
import { createEditorSolverSessionV1 } from "../editor/v1/native-solver-runtime.mjs";
import { ConnectedWorldSessionV1 } from "../play/v1/connected-world-session.mjs";
import { decodeVoxelRoom } from "../render/v1/voxel-world-v2.mjs";
import {
  RANDOM_AGENT_DIRECTIONS_V1,
  RANDOM_AGENT_START_POSITION_V1,
  randomAgentPixelV1,
  runRandomAgentV1,
  tagRandomAgentWorldV1
} from "../world-solver/v1/random-agent.mjs";
import {
  ROOM_BFS_DIRECTIONS_V1,
  ROOM_BFS_META_STRATEGIES_V1,
  ROOM_BFS_START_POSITION_V1,
  runRoomBfsV1
} from "../world-solver/v1/room-bfs.mjs";

const blocks = [
  { id: "floor", roleId: "floor", visual: { kind: "floor" } },
  { id: "wall", roleId: "solid", visual: { kind: "cube" } },
  { id: "ice-slope", roleId: "ice", visual: { kind: "slope" } },
  { id: "floating-floor", roleId: "floating-floor", visual: { kind: "platform" } },
  { id: "player", roleId: "player", visual: { kind: "cube" } },
  { id: "gem", roleId: "goal", visual: { kind: "model" } }
];

function oneRoomWorld(objects, size = 3) {
  const room = {
    fileName: "start.json",
    position: ["H", "I"],
    columnIndex: 0,
    rowIndex: 0,
    width: size,
    height: size,
    objects
  };
  return {
    columns: ["H"],
    rows: ["I"],
    roomWidth: size,
    roomHeight: size,
    rooms: [room],
    blocks,
    blockDefinitions: new Map(blocks.map((block) => [block.id, block]))
  };
}

async function engine() {
  const bytes = await readFile(new URL("../world-solver/v1/random-agent.wasm", import.meta.url));
  return instantiateMazeBenchEngineV1(bytes);
}

async function editorEngine() {
  const bytes = await readFile(new URL("../world-solver/v1/editor-solver.wasm", import.meta.url));
  return instantiateMazeBenchEngineV1(bytes);
}

function finishEditorSearch(session, chunkSize = 16) {
  let result = session.snapshot();
  while (result.statusCode === 0) result = session.runChunk(chunkSize);
  return result;
}

test("random agent uses only four directions and starts at H×I", () => {
  assert.deepEqual(RANDOM_AGENT_START_POSITION_V1, ["H", "I"]);
  assert.deepEqual(RANDOM_AGENT_DIRECTIONS_V1, ["up", "right", "down", "left"]);
});

test("room BFS uses the same four commands and starts at H×I", () => {
  assert.deepEqual(ROOM_BFS_START_POSITION_V1, ["H", "I"]);
  assert.deepEqual(ROOM_BFS_DIRECTIONS_V1, ["up", "right", "down", "left"]);
  assert.deepEqual(ROOM_BFS_META_STRATEGIES_V1, [
    "breadth",
    "depth",
    "super-astar",
    "row-astar"
  ]);
});

test("editor wrapper offers exact shortest and interaction-biased fast A*", async () => {
  const native = await editorEngine();
  const room = {
    width: 3,
    height: 1,
    objects: [
      { x: 0, y: 0, z: 0, blockId: "player" },
      { x: 2, y: 0, z: 0, blockId: "gem" },
      ...Array.from({ length: 3 }, (_, x) => ({ x, y: 0, z: 0, blockId: "floor" }))
    ]
  };
  const canonical = (await engine()).solve(room, blocks, { maximumNodes: 1_000 });
  const exact = finishEditorSearch(createEditorSolverSessionV1(native, room, blocks));
  const fast = finishEditorSearch(createEditorSolverSessionV1(native, room, blocks, {
    heuristicWeight: 3,
    interactionWeight: 2
  }));

  assert.equal(exact.status, "solved");
  assert.equal(exact.proven, true);
  assert.equal(exact.moves, canonical.moves);
  assert.deepEqual(exact.solution, canonical.solution);
  assert.equal(fast.status, "solved-unproven");
  assert.equal(fast.proven, false);
  assert.equal(fast.interactionWeight, 2);
  assert.deepEqual(fast.solution, ["right", "right"]);
  assert.ok(exact.actionsPerSecond > 0);
  assert.ok(exact.statesPerSecond > 0);
});

test("editor A* and exact search preserve puncher state and replay valid routes", async () => {
  const definitions = [...blocks, { id: "puncher", roleId: "puncher", visual: { kind: "puncher" } }];
  for (const heuristicWeight of [0, 3]) {
    for (const stateId of [0, 1]) {
      const native = await editorEngine();
      const room = {
        width: 5, height: 5,
        objects: [
          { x: 1, y: 3, z: 0, blockId: "player" },
          { x: 1, y: 2, z: 0, blockId: "puncher", orientation: "right", stateId },
          { x: 0, y: 2, z: 0, blockId: "wall" },
          { x: 4, y: 2, z: 0, blockId: "wall" },
          { x: 3, y: 2, z: 0, blockId: "gem" },
          ...[[1, 3], [1, 2], [2, 2], [3, 2], [4, 2]].map(([x, y]) =>
            ({ x, y, z: 0, blockId: "floor" }))
        ]
      };
      const session = createEditorSolverSessionV1(native, room, definitions, { heuristicWeight });
      let result = session.snapshot();
      for (let chunk = 0; chunk < 16 && result.statusCode === 0; chunk++) result = session.runChunk(16);
      assert.equal(result.status, heuristicWeight ? "solved-unproven" : "solved");
      assert.deepEqual(result.solution, ["up"], 'a new command rearms a previously sprung puncher');
      let state = room;
      for (const direction of result.solution) state = (await native.simulateCommand(state, direction, definitions)).final;
      assert.equal(state.objects.find(o => o.blockId === "gem").x, -1);
      const player = state.objects.find(o => o.blockId === "player");
      assert.deepEqual([player.x, player.y, player.z], [3, 2, 0]);
      assert.equal(state.objects.find(o => o.blockId === "puncher").stateId, 0);
    }
  }
});

test("editor UI exposes both solver modes, physics bias, and live throughput", async () => {
  const [html, main, worker] = await Promise.all([
    readFile(new URL("../editor/v1/index.html", import.meta.url), "utf8"),
    readFile(new URL("../editor/v1/main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../editor/v1/solver-worker.mjs", import.meta.url), "utf8")
  ]);
  assert.match(html, /Fast A\*/);
  assert.match(html, /id="exact-solve"[^>]*>BFS</);
  assert.match(html, /id="physics-interaction-weight"[^>]*value="0"/);
  assert.match(main, /board states\/s/);
  assert.match(main, /command sims\/s/);
  assert.match(worker, /type: "progress"/);
});

test("room BFS exhausts exact states, paints cells, records exits, and locks", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const native = await engine();
  const progress = [];
  const stats = await runRoomBfsV1(native, oneRoomWorld([
    { x: 1, y: 1, z: 0, blockId: "player" },
    ...floors
  ]), {
    chunkSize: 512,
    progressDelayMs: 0,
    onProgress: (message) => progress.push(message)
  });

  assert.equal(stats.states, 9);
  assert.equal(stats.expanded, 1);
  assert.equal(stats.transitions, 36);
  assert.equal(stats.edgeStates, 12);
  assert.equal(stats.exitCells, 8);
  assert.deepEqual(
    [...new Set(progress.flatMap((message) => message.visitedCells))].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8]
  );
  assert.equal(native.exports.room_bfs_run(1), 1);
  assert.equal(native.exports.room_bfs_states(), 9);
  assert.equal(native.exports.room_bfs_expanded(), 1);
});

test("room BFS keeps collected and uncollected board states distinct", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const stats = await runRoomBfsV1(await engine(), oneRoomWorld([
    { x: 1, y: 1, z: 0, blockId: "player" },
    ...floors,
    { x: 2, y: 1, z: 0, blockId: "gem" }
  ]), { chunkSize: 32, progressDelayMs: 0 });

  // Eight reachable positions before collection plus all nine after collection.
  assert.equal(stats.states, 17);
  assert.equal(stats.expanded, 2);
  assert.equal(stats.gems, 1);
});

test("World BFS resets each newly reached room and searches it only once", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const north = {
    fileName: "north.json",
    position: ["H", "H"],
    columnIndex: 0,
    rowIndex: 0,
    width: 3,
    height: 3,
    objects: floors
  };
  const start = {
    fileName: "start.json",
    position: ["H", "I"],
    columnIndex: 0,
    rowIndex: 1,
    width: 3,
    height: 3,
    objects: [{ x: 1, y: 1, z: 0, blockId: "player" }, ...floors]
  };
  const progress = [];
  const stats = await runRoomBfsV1(await engine(), {
    columns: ["H"],
    rows: ["H", "I"],
    roomWidth: 3,
    roomHeight: 3,
    rooms: [north, start],
    blocks,
    blockDefinitions: new Map(blocks.map((block) => [block.id, block]))
  }, {
    chunkSize: 32,
    progressDelayMs: 0,
    onProgress: (message) => progress.push(message)
  });

  assert.equal(stats.rooms, 2);
  assert.equal(stats.processedRooms, 2);
  assert.equal(stats.states, 18);
  assert.equal(stats.gems, 0);
  assert.ok(progress.some((message) => message.stats.currentRoom === "H×H"));

  const roomStatuses = new Map();
  const roomForCell = (cell) => {
    const x = cell % 3;
    const y = Math.floor(cell / 3);
    return y < 3 ? "north.json" : "start.json";
  };
  for (const message of progress) {
    for (const update of message.roomUpdates || []) {
      roomStatuses.set(update.fileName, update.searchStatus);
    }
    for (const cell of message.trail || []) {
      assert.notEqual(roomStatuses.get(roomForCell(cell)), "searched");
    }
  }
  assert.deepEqual([...roomStatuses.entries()].sort(), [
    ["north.json", "searched"],
    ["start.json", "searched"]
  ]);
  for (const roomName of roomStatuses.keys()) {
    const updates = progress.flatMap((message) => message.roomUpdates || [])
      .filter((update) => update.fileName === roomName)
      .map((update) => update.searchStatus);
    assert.deepEqual(updates, ["open", "searched"]);
  }
});

test("DFS Meta immediately explores a new room and then resumes the exact parent BFS", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const room = (fileName, position, columnIndex, rowIndex, objects = floors) => ({
    fileName,
    position,
    columnIndex,
    rowIndex,
    width: 3,
    height: 3,
    objects
  });
  const progress = [];
  const stats = await runRoomBfsV1(await engine(), {
    columns: ["H", "I"],
    rows: ["H", "I"],
    roomWidth: 3,
    roomHeight: 3,
    rooms: [
      room("north.json", ["H", "H"], 0, 0),
      room("start.json", ["H", "I"], 0, 1, [
        { x: 1, y: 1, z: 0, blockId: "player" },
        ...floors,
        { x: 2, y: 1, z: 0, blockId: "gem" }
      ]),
      room("east.json", ["I", "I"], 1, 1)
    ],
    blocks,
    blockDefinitions: new Map(blocks.map((block) => [block.id, block]))
  }, {
    metaStrategy: "depth",
    chunkSize: 512,
    progressDelayMs: 0,
    onProgress: (message) => progress.push(message)
  });

  const events = progress.map((message) =>
    `${message.type}:${message.stats.currentRoom}`);
  const firstChild = events.findIndex((event) => event === "room-start:H×H");
  const startComplete = events.findIndex((event) => event === "room-complete:H×I");
  assert.ok(firstChild >= 0 && firstChild < startComplete);
  assert.ok(events.includes("room-suspend:H×I"));
  assert.ok(events.includes("room-resume:H×I"));
  assert.ok(events.includes("room-start:I×I"));
  assert.equal(stats.rooms, 3);
  assert.equal(stats.processedRooms, 3);
  assert.equal(stats.states, 35);
  assert.equal(stats.gems, 1);
});

test("Super A* time-slices a global room portfolio toward gems and outlets", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const room = (fileName, position, columnIndex, rowIndex, objects = floors) => ({
    fileName,
    position,
    columnIndex,
    rowIndex,
    width: 3,
    height: 3,
    objects
  });
  const progress = [];
  const stats = await runRoomBfsV1(await engine(), {
    columns: ["H", "I"],
    rows: ["H", "I"],
    roomWidth: 3,
    roomHeight: 3,
    rooms: [
      room("north.json", ["H", "H"], 0, 0),
      room("start.json", ["H", "I"], 0, 1, [
        { x: 1, y: 1, z: 0, blockId: "player" },
        ...floors,
        { x: 2, y: 1, z: 0, blockId: "gem" }
      ]),
      room("east.json", ["I", "I"], 1, 1)
    ],
    blocks,
    blockDefinitions: new Map(blocks.map((block) => [block.id, block]))
  }, {
    metaStrategy: "super-astar",
    heuristicWeight: 3,
    chunkSize: 1,
    progressDelayMs: 0,
    onProgress: (message) => progress.push(message)
  });

  assert.ok(progress.some((message) => message.type === "search-yield"));
  assert.ok(progress.some((message) => message.stats.currentRoom === "H×H"));
  assert.ok(progress.some((message) => message.stats.currentRoom === "I×I"));
  assert.equal(stats.rooms, 3);
  assert.equal(stats.processedRooms, 3);
  assert.equal(stats.states, 35);
  assert.equal(stats.gems, 1);
  assert.equal(stats.activeSearches, 0);
  assert.equal(stats.heuristicWeight, 3);
  assert.ok(stats.searchSlices >= 3);
});

test("Row A* covers reached rows while treating gems and exits as incidental", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const room = (fileName, position, columnIndex, rowIndex, objects = floors) => ({
    fileName,
    position,
    columnIndex,
    rowIndex,
    width: 3,
    height: 3,
    objects
  });
  const progress = [];
  const stats = await runRoomBfsV1(await engine(), {
    columns: ["H", "I"],
    rows: ["H", "I"],
    roomWidth: 3,
    roomHeight: 3,
    rooms: [
      room("north.json", ["H", "H"], 0, 0),
      room("start.json", ["H", "I"], 0, 1, [
        { x: 1, y: 1, z: 0, blockId: "player" },
        ...floors,
        { x: 2, y: 1, z: 0, blockId: "gem" }
      ]),
      room("east.json", ["I", "I"], 1, 1)
    ],
    blocks,
    blockDefinitions: new Map(blocks.map((block) => [block.id, block]))
  }, {
    metaStrategy: "row-astar",
    heuristicWeight: 3,
    chunkSize: 512,
    progressDelayMs: 0,
    onProgress: (message) => progress.push(message)
  });

  assert.equal(stats.rooms, 3);
  assert.equal(stats.processedRooms, 3);
  // The gem tile is reached only after the collection transition, so the
  // starter room expands both its pre- and post-collection board states.
  assert.ok(stats.states > 35);
  assert.equal(stats.gems, 1);
  assert.equal(stats.rowTargets, 9);
  assert.equal(stats.rowVisited, 9);
  assert.equal(stats.rowsDiscovered, 1);
  assert.equal(stats.rowCoverageComplete, 1);
  assert.ok(progress.some((message) => message.gemRooms?.some((room) =>
    room.fileName === "start.json" && room.count === 1)));
  const startStatuses = progress.flatMap((message) => message.roomUpdates || [])
    .filter((update) => update.fileName === "start.json")
    .map((update) => update.searchStatus);
  assert.deepEqual(startStatuses, ["open", "searched", "open", "searched"]);
});

test("Row A* accepts only edge states that really enter the neighboring room", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const room = (fileName, position, columnIndex, objects) => ({
    fileName,
    position,
    columnIndex,
    rowIndex: 0,
    width: 3,
    height: 3,
    objects
  });
  const stats = await runRoomBfsV1(await engine(), {
    columns: ["H", "I"],
    rows: ["I"],
    roomWidth: 3,
    roomHeight: 3,
    rooms: [
      room("start.json", ["H", "I"], 0, [
        { x: 1, y: 1, z: 0, blockId: "player" },
        ...floors
      ]),
      room("blocked.json", ["I", "I"], 1, [
        ...floors,
        ...Array.from({ length: 3 }, (_, y) => ({ x: 0, y, z: 0, blockId: "wall" }))
      ])
    ],
    blocks,
    blockDefinitions: new Map(blocks.map((block) => [block.id, block]))
  }, {
    metaStrategy: "row-astar",
    chunkSize: 32,
    progressDelayMs: 0
  });

  assert.equal(stats.rooms, 1);
  assert.equal(stats.processedRooms, 1);
});

test("connected edge tests restore Row A* physics before G×F resumes", async () => {
  const [manifestSource, roomSource] = await Promise.all([
    readFile(new URL("../level-data/v2/main-world/world.json", import.meta.url), "utf8"),
    readFile(new URL("../level-data/v2/main-world/0lzre7ixaq.json", import.meta.url), "utf8")
  ]);
  const definitions = new Map(JSON.parse(manifestSource).blocks.map((block) => [block.id, block]));
  const decoded = decodeVoxelRoom(JSON.parse(roomSource));
  const state = {
    ...decoded,
    objects: decoded.objects.map((object) =>
      object.blockId === "player" ? { ...object, x: 15, y: 1 } : object)
  };
  const native = await engine();
  native.writeState(state, definitions);
  assert.equal(native.exports.row_astar_begin(
    state.objects.length,
    state.width,
    state.height,
    12,
    3
  ), 1);
  assert.equal(native.exports.row_astar_run(512), 3);
  assert.equal(native.exports.row_astar_edge_load_state(0), state.objects.length);
  const stride = native.exports.voxel_stride();
  const edgeState = readEngineStateV1(
    state,
    definitions,
    new Int32Array(
      native.exports.memory.buffer,
      native.exports.voxel_buffer(),
      state.objects.length * stride
    ),
    stride
  );
  const east = {
    fileName: "east.json",
    position: ["I", "I"],
    columnIndex: 1,
    rowIndex: 0,
    width: 16,
    height: 16,
    objects: Array.from({ length: 256 }, (_, cell) => ({
      x: cell % 16,
      y: Math.floor(cell / 16),
      z: 0,
      blockId: "floor"
    }))
  };
  const source = {
    ...state,
    fileName: "gxf.json",
    position: ["H", "I"],
    columnIndex: 0,
    rowIndex: 0
  };
  const connected = new ConnectedWorldSessionV1(native, definitions, [source, east]);
  const crossing = await connected.simulateCommand(edgeState, source, "right");
  assert.equal(crossing.room.fileName, "east.json");
  assert.equal(native.exports.row_astar_restore_physics_workspace(), 1);

  let status = 0;
  while (status === 0 || status === 3) status = native.exports.row_astar_run(512);
  assert.equal(status, 4);
  assert.equal(native.exports.row_astar_active_targets(), 135);
  assert.equal(native.exports.row_astar_visited_targets(), 135);
  assert.equal(native.exports.room_bfs_collected_goals(), 1);
});

test("Row A* keeps ice slopes and floating floors in its landscape without falling back", async () => {
  const native = await engine();
  const stats = await runRoomBfsV1(native, oneRoomWorld([
    { x: 1, y: 1, z: 1, blockId: "player" },
    { x: 1, y: 1, z: 0, blockId: "floating-floor" },
    { x: 0, y: 0, z: 0, blockId: "ice-slope" },
    { x: 1, y: 1, z: 0, blockId: "floor" }
  ]), {
    metaStrategy: "row-astar",
    chunkSize: 32,
    progressDelayMs: 0
  });

  const targets = Array.from(
    { length: native.exports.row_astar_target_count() },
    (_, index) => [
      native.exports.row_astar_target_x(index),
      native.exports.row_astar_target_y(index),
      native.exports.row_astar_target_z(index)
    ]
  );
  assert.ok(targets.some(([x, y, z]) => x === 0 && y === 0 && z === 1));
  assert.ok(targets.some(([x, y, z]) => x === 1 && y === 1 && z === 1));
  assert.equal(stats.rowsDiscovered, 1);
  assert.equal(stats.rowTargets, 2);
  assert.equal(stats.rowVisited, 1);
  assert.equal(stats.rowCoverageComplete, 0);
  assert.equal(stats.processedRooms, 1);
});

test("world pixels span the 256×256 map and ignore z", () => {
  const world = { columns: Array(16), rows: Array(16), roomWidth: 16, roomHeight: 16 };
  const room = { columnIndex: 15, rowIndex: 15 };
  assert.deepEqual(randomAgentPixelV1(world, room, { x: 15, y: 15, z: 999 }), {
    x: 255,
    y: 255,
    index: 65_535
  });
});

test("random-agent object IDs remain stable per authored room", () => {
  const tagged = tagRandomAgentWorldV1(oneRoomWorld([
    { x: 1, y: 1, z: 0, blockId: "player" },
    { x: 1, y: 1, z: 0, blockId: "floor" }
  ]));
  assert.deepEqual(tagged.rooms[0].objects.map((object) => object.randomAgentObjectId), [
    "start.json:0",
    "start.json:1"
  ]);
});

test("random agent keeps safe actions and reports live visits", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const progress = [];
  const result = await runRandomAgentV1(await engine(), oneRoomWorld([
    { x: 1, y: 1, z: 0, blockId: "player" },
    ...floors
  ]), {
    maximumActions: 8,
    seed: 1,
    reportEveryMs: 1,
    yieldEvery: 2,
    onProgress: (message) => progress.push(message)
  });
  assert.equal(result.actions, 8);
  assert.equal(result.rooms, 1);
  assert.equal(result.undos, 0);
  assert.ok(progress.flatMap((message) => message.visitedCells).length >= 2);
});

test("only a player death triggers the one-action undo", async () => {
  const result = await runRandomAgentV1(await engine(), oneRoomWorld([
    { x: 1, y: 1, z: 0, blockId: "player" },
    { x: 1, y: 1, z: 0, blockId: "floor" }
  ]), {
    maximumActions: 1,
    seed: 1
  });
  assert.equal(result.actions, 1);
  assert.equal(result.undos, 1);
  assert.equal(result.currentRoom, "H×I");
});

test("the random agent teleports to a reached room after each 10,000 moves", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  let lastProgress;
  await runRandomAgentV1(await engine(), oneRoomWorld([
    { x: 1, y: 1, z: 0, blockId: "player" },
    ...floors
  ]), {
    maximumActions: 10_001,
    seed: 1,
    onProgress: (message) => { lastProgress = message; }
  });
  assert.equal(lastProgress.stats.teleports, 1);
});
