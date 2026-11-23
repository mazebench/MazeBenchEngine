import assert from "node:assert/strict";
import { link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VisionRuntime } from "../benchmarking/vision/runtime.mjs";
import { readCheckpointJson } from "../benchmarking/v1/checkpoint-json.mjs";
import { heatmapVisits } from "../benchmarking/ui/heatmap.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { BenchmarkSupervisor } from "../benchmarking/v1/supervisor.mjs";
import { createRunIntegrity, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { readMoveRecord } from "../benchmarking/v1/move-animation.mjs";
import { ConnectedWorldSessionV1 } from "../play/v1/connected-world-session.mjs";
import { renderAsciiFrameV1 } from "../render-ascii/v1/ascii-scene.mjs";
import { IceBenchmarkRuntime } from "../ice-maze/v1/benchmark-runtime.mjs";
import { iceAscii, parseIceLevel } from "../ice-maze/v1/engine.mjs";

const root = path.resolve(import.meta.dirname, "..");
const board = content => content.slice(content.indexOf("\n") + 1).trimEnd();
async function indexFor(runtime, action) {
  return JSON.parse((await runtime.readRecord(action.animation.index_record)).content);
}
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maze-animation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function corridor(t, Runtime = BenchmarkGameRuntime) {
  const directory = await temporary(t);
  await createRunIntegrity(root, directory, { model: "fixture", tools_enabled: false });
  const runtime = await Runtime.create(root, directory, { actionLimit: 30 });
  const objects = [{ x: 0, y: 1, z: 0, blockId: "player" }];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) {
    objects.push({ x, y, z: 0, blockId: y === 1 && x > 0 && x < 4 ? "ice-floor" : "floor" });
  }
  const room = { fileName: "corridor.json", position: ["A", "A"], columnIndex: 0, rowIndex: 0, width: 5, height: 3, objects };
  const state = runtime.assets.engine.createState(room);
  runtime.assets = { ...runtime.assets, rooms: [room], roomsByFile: new Map([[room.fileName, room]]),
    roomsByLabel: new Map([["AXA", room]]), roomWidth: 5, roomHeight: 3,
    connectedWorld: new ConnectedWorldSessionV1(runtime.assets.engine, runtime.assets.blocks, [room]) };
  Object.assign(runtime.internal, { roomFile: room.fileName, state, roomEntryState: structuredClone(state),
    visitedRooms: [room.fileName], roomEntryStates: { [room.fileName]: structuredClone(state) },
    positions: [{room: "AxA", worldX: 0, worldY: 1, localX: 0, localY: 1, z: 0}] });
  await runtime.persist({ writeSnapshot: true });
  return { directory, runtime, room };
}

test("one MazeBench slide records every engine frame without changing action or novelty counts", async t => {
  const { directory, runtime, room } = await corridor(t);
  const before = (await runtime.renderObservation()).level;
  const result = await runtime.apply("right");
  const index = await indexFor(runtime, result.action);
  assert.equal(result.action.animation.frame_count, 5); // Before, then x=1,2,3,4.
  assert.equal(index.final_frame, 4);
  assert.deepEqual(index.frames.map(f => f.kind), ["before", "animation", "animation", "animation", "final"]);
  for (let x = 0; x <= 4; x++) {
    const expected = structuredClone(room);
    expected.objects[0].x = x;
    const rendered = await renderAsciiFrameV1(expected, runtime.assets.blocks, { yaw: 0, pitch: 1 });
    const actual = await runtime.readRecord(index.frames[x].record);
    assert.equal(board(actual.content), rendered.text.trimEnd());
    assert.deepEqual(index.frames[x].camera, { yaw: 0, pitch: 1 });
  }
  assert.equal(board((await runtime.readRecord(index.frames[0].record)).content), before.trimEnd());
  const finalText = (await runtime.readRecord("move_history/move_1.txt")).content;
  assert.equal(board((await runtime.readRecord(index.frames[4].record)).content), board(finalText));
  assert.equal(runtime.internal.actionCount, 1);
  assert.equal(runtime.internal.history.length, 1);
  assert.equal(runtime.summary().novelty.length, 2);
  assert(runtime.recordIndex().includes(result.action.animation.index_record));
  assert(!runtime.recordIndex().some(p => p.includes("frame_"))); // No context flood.
  verifyCheckpoint(directory);
  const count = runtime.internal.actionCount;
  await runtime.readRecord(index.frames[2].record);
  assert.equal(runtime.internal.actionCount, count);
  // The HTTP record reader uses the same checked paths and content hashes.
  const supervisor = new BenchmarkSupervisor(root);
  supervisor.runDirectory = () => directory;
  assert.equal(await supervisor.record("run-2026-09-05T00-00-00-000Z-aabbcc", index.frames[2].record),
    (await runtime.readRecord(index.frames[2].record)).content);
});

test("sequence steps, blocked commands, undo, reset and camera changes retain separate immutable frames", async t => {
  const { runtime } = await corridor(t);
  const result = await runtime.applySequence(["right", "right", "undo", "camera left", "reset"]);
  assert.equal(result.completed_count, 5);
  for (const step of result.steps) assert(step.action.animation.index_record);
  assert.equal(result.steps[1].action.blocked, true);
  assert.equal(result.steps[1].action.animation.frame_count, 2);
  const slide = await indexFor(runtime, result.steps[0].action);
  const immutable = (await runtime.readRecord(slide.frames[2].record)).content;
  const undo = await indexFor(runtime, result.steps[2].action);
  assert.equal(board((await runtime.readRecord(undo.frames[1].record)).content),
    board((await runtime.readRecord(slide.frames[0].record)).content));
  const camera = await indexFor(runtime, result.steps[3].action);
  assert.deepEqual(camera.frames.map(f => f.camera.yaw), [0, 3]);
  assert.equal((await runtime.readRecord(slide.frames[2].record)).content, immutable);
  assert.equal(runtime.internal.actionCount, 5);
});

test("room crossing frames use the room active at that point in the command", async t => {
  const directory = await temporary(t);
  const runtime = await BenchmarkGameRuntime.create(root, directory, { startRoom: "LxL", actionLimit: 10 });
  const sequence = await runtime.applySequence(["up", "up", "up", "up"]);
  const crossing = sequence.steps.find(step => step.action.roomBefore !== step.action.roomAfter).action;
  const index = await indexFor(runtime, crossing);
  assert.equal(index.frames[0].room, "LxL");
  assert.equal(index.frames.at(-1).room, "LxK");
  for (const frame of index.frames) assert((await runtime.readRecord(frame.record)).content.split("\n")[0].endsWith(frame.room));
  assert.equal(board((await runtime.readRecord(index.frames.at(-1).record)).content),
    board((await runtime.readRecord(`move_history/move_${crossing.index}.txt`)).content));
});

test("animation reads reject forged files, links, hidden internals and discarded futures", async t => {
  const { directory, runtime } = await corridor(t);
  const { action } = await runtime.apply("right");
  const index = await indexFor(runtime, action), frame = index.frames[1].record;
  const framePath = path.join(directory, "records", frame);
  const original = await readFile(framePath, "utf8");
  await writeFile(framePath, "tampered");
  await assert.rejects(() => runtime.readRecord(frame), /integrity/);
  await writeFile(framePath, original);
  const indexPath = path.join(directory, "records", action.animation.index_record);
  const originalIndex = await readFile(indexPath, "utf8");
  await writeFile(indexPath, originalIndex + " ");
  await assert.rejects(() => runtime.readRecord(action.animation.index_record), /integrity/);
  await writeFile(indexPath, originalIndex);
  for (const file of ["../game-state.json", "move_history/move_1/../../game-state.json", "move_history/move_1/frame_9999.txt", "move_history/move_1/state.json", "move_history/move_01/index.json"]) {
    await assert.rejects(() => runtime.readRecord(file), /Unknown/);
  }
  const copy = path.join(directory, "frame-copy.txt");
  await writeFile(copy, original);
  for (const makeLink of [symlink, link]) {
    await rm(framePath); await makeLink(copy, framePath);
    await assert.rejects(() => runtime.readRecord(frame));
  }
  await rm(framePath); await writeFile(framePath, original);
  // Retained on disk after an operator rollback, but not in the signed prefix.
  for (const file of [frame, action.animation.index_record, "move_history/move_1.txt"]) {
    assert.throws(() => readMoveRecord(directory, [], 0, file), /Unknown/);
  }
  // A legacy/replaced action cannot acquire old frames just by reusing an ID.
  assert.throws(() => readMoveRecord(directory, [{ index: 1 }], 1, frame), /Unknown/);
  const actions = runtime.internal.actions;
  runtime.internal.actions = []; runtime.internal.actionCount = 0;
  await runtime.persist();
  const supervisor = new BenchmarkSupervisor(root); supervisor.runDirectory = () => directory;
  await assert.rejects(() => supervisor.record("run-2026-09-05T00-00-00-000Z-aabbcc", frame), /Unknown/);
  runtime.internal.actions = actions;
});

test("a frame-rendering failure never publishes a partial action", async t => {
  const { directory, runtime } = await corridor(t);
  const files = ["game-state.json", "summary.json", "checkpoint.json", "records/current_board.txt"];
  const before = await Promise.all(files.map(f => readFile(path.join(directory, f))));
  const engine = runtime.assets.engine;
  const roomFromState = engine.roomFromState.bind(engine);
  t.mock.method(engine, "roomFromState", (state, room) => {
    if (state.objects.find(o => o.blockId === "player")?.x === 2) throw new Error("fixture rendering failure");
    return roomFromState(state, room);
  });
  await assert.rejects(() => runtime.apply("right"), /Benchmark save failed/);
  for (const [i, file] of files.entries()) assert.deepEqual(await readFile(path.join(directory, file)), before[i]);
  assert(!(await readdir(path.join(directory, "records/move_history"))).includes("move_1"));
  assert(!(await readdir(directory)).some(name => name.startsWith(".checkpoint-")));
  await assert.rejects(() => runtime.readRecord("current_board.txt"), /Benchmark save failed/);
  verifyCheckpoint(directory);
});

test("cycle rollback keeps its animation even when the final board is unchanged", async t => {
  const { runtime, room } = await corridor(t);
  const initial = structuredClone(runtime.internal.state), middle = structuredClone(initial);
  middle.objects[0].x = 1;
  const cycle = { startTick: 1, repeatTick: 3, onCycle: "rollback-command" };
  t.mock.method(runtime.assets.connectedWorld, "simulateCommand", async () => ({
    room, final: initial, cycle,
    animationFrames: [{ room, state: middle }, { room, state: initial }, { room, state: middle }, { room, state: initial }]
  }));
  const { action } = await runtime.apply("right");
  const index = await indexFor(runtime, action);
  assert.equal(action.stateChanged, false);
  assert.equal(index.frame_count, 5);
  assert.deepEqual(index.cycle, cycle);
  const first = board((await runtime.readRecord(index.frames[0].record)).content);
  assert.equal(board((await runtime.readRecord(index.frames.at(-1).record)).content), first);
  assert.notEqual(board((await runtime.readRecord(index.frames[1].record)).content), first);
});

test("death records the falling animation and final board before recovery", async t => {
  const { runtime, room } = await corridor(t);
  // Replace the first Ice cell with a bottomless hole.
  room.objects = room.objects.filter(o => !(o.x === 1 && o.y === 1));
  runtime.internal.state = runtime.assets.engine.createState(room);
  const { action, observation } = await runtime.apply("right");
  assert.equal(action.died, true);
  const index = await indexFor(runtime, action);
  assert(index.frame_count > 2);
  assert.equal(board((await runtime.readRecord(index.frames.at(-1).record)).content), observation.level.trimEnd());
  const recovered = await runtime.apply("undo");
  assert.equal(recovered.observation.game_status, "playing");
});

test("Ice Maze snapshots move all players together one cell at a time", async t => {
  const directory = await temporary(t);
  const world = { levels: [{ id: 1, board: [".a...a..", ".e......"] }] };
  class FixtureRuntime extends IceBenchmarkRuntime { static async assets() { return world; } }
  const runtime = await FixtureRuntime.create(root, directory, { actionLimit: 10 });
  const { action } = await runtime.apply("right");
  const index = await indexFor(runtime, action);
  const expected = [
    [{ x: 1, y: 0 }, { x: 5, y: 0 }], [{ x: 2, y: 0 }, { x: 6, y: 0 }],
    [{ x: 3, y: 0 }, { x: 7, y: 0 }], [{ x: 4, y: 0 }, { x: 7, y: 0 }],
    [{ x: 5, y: 0 }, { x: 7, y: 0 }], [{ x: 6, y: 0 }, { x: 7, y: 0 }]
  ];
  assert.equal(index.frame_count, expected.length);
  for (const [i, players] of expected.entries()) {
    assert.equal(board((await runtime.readRecord(index.frames[i].record)).content), iceAscii(parseIceLevel(world.levels[0]), players));
  }
  assert.equal(runtime.internal.actionCount, 1);
  assert.equal(runtime.summary().novelty.length, 2);
  const undo = await runtime.apply("undo");
  assert.equal(undo.action.animation.frame_count, 2);
  assert.equal(undo.observation.level, iceAscii(parseIceLevel(world.levels[0]), expected[0]));
});

test("Ice level transitions record before/after and legacy checkpoints acquire only future frames", async t => {
  const directory = await temporary(t);
  const world = { levels: [{ id: 1, board: ["a..e", "...."] }, { id: 2, board: ["ae..", "...."] }] };
  class FixtureRuntime extends IceBenchmarkRuntime { static async assets() { return world; } }
  await createRunIntegrity(root, directory, { model: "fixture" });
  const runtime = await FixtureRuntime.create(root, directory, { actionLimit: 10 });
  await runtime.apply("right");
  delete runtime.internal.actions[0].animation; // Simulate an old final-only checkpoint.
  await runtime.persist(); await rm(path.join(directory, "records/move_history/move_1"), { recursive: true });
  const reopened = await FixtureRuntime.open(root, directory);
  assert(!reopened.recordIndex().some(f => /^move_history\/move_\d+\/index\.json$/.test(f)));
  assert((await reopened.readRecord("move_history/move_1.txt")).content);
  const next = await reopened.apply("next");
  const index = await indexFor(reopened, next.action);
  assert.deepEqual(index.frames.map(f => f.room), ["Level 1", "Level 2"]);
  assert.equal(index.frame_count, 2);
  verifyCheckpoint(directory);
  // The index digest is authenticated by the existing signed action history.
  const state = JSON.parse(await readFile(path.join(directory, "game-state.json")));
  state.actions[1].animation.index_sha256 = "forged";
  await writeFile(path.join(directory, "game-state.json"), JSON.stringify(state));
  assert.throws(() => verifyCheckpoint(directory), /modified/);
});

test("Ice save failure keeps the signed checkpoint and rejects unsaved observations", async t => {
  const directory = await temporary(t);
  await createRunIntegrity(root, directory, { model: "fixture" });
  const runtime = await IceBenchmarkRuntime.create(root, directory, { actionLimit: 10 });
  const files = ["game-state.json", "summary.json", "checkpoint.json", "records/current_board.txt"];
  const before = await Promise.all(files.map(file => readFile(path.join(directory, file))));
  t.mock.method(runtime, "summary", () => { throw new Error("fixture save failure"); });
  await assert.rejects(() => runtime.apply("up"), /Benchmark save failed/);
  for (const [i, file] of files.entries()) assert.deepEqual(await readFile(path.join(directory, file)), before[i]);
  assert(!(await readdir(path.join(directory, "records/move_history"))).includes("move_1"));
  await assert.rejects(() => runtime.apply("up"), /Benchmark save failed/);
  await assert.rejects(() => runtime.readRecord("current_board.txt"), /Benchmark save failed/);
  verifyCheckpoint(directory);
  assert.equal((await IceBenchmarkRuntime.open(root, directory)).internal.actionCount, 0);
});


test("slide heatmaps persist exact intermediate visits through the journal and keep MCP responses unchanged", async t => {
  for (const Runtime of [BenchmarkGameRuntime, VisionRuntime]) {
    const { directory, runtime } = await corridor(t, Runtime);
    await runtime.enableIncremental();
    const initial = structuredClone(runtime.summary());
    const result = await runtime.apply("right");
    const expected = [1, 2, 3].map(worldX => ({ worldX, worldY: 1 }));
    const summary = await readCheckpointJson(directory, "summary.json");
    assert.deepEqual(summary.actions[0].traversedPositions, expected);
    assert.deepEqual((await readCheckpointJson(directory)).actions[0].traversedPositions, expected);
    assert.equal(summary.positions.length, 2);
    assert.equal(summary.novelty.length, 2);
    assert.equal(summary.unique_cells, 5);
    assert.equal(runtime.internal.history.length, 1);
    const heatmap = heatmapVisits(summary);
    assert.deepEqual(heatmap.positions.map(p => p.worldX).sort(), [0, 1, 2, 3, 4]);
    assert.equal(heatmap.current.worldX, 4);
    assert.equal(heatmap.trackedActions, 1);
    assert(!JSON.stringify(result).includes("traversedPositions"));
    assert(!(await runtime.readRecord("history.jsonl")).content.includes("traversedPositions"));
    for (const command of ["right", "undo", "reset", "camera left"]) {
      await runtime.apply(command);
      assert.deepEqual(runtime.internal.actions.at(-1).traversedPositions, []);
    }
    assert.deepEqual(heatmapVisits(initial).positions.map(p => p.worldX), [0]);
    verifyCheckpoint(directory);
  }
});

test("punch heatmaps include the bent path, not a straight line between endpoints", async t => {
  const { runtime, room } = await corridor(t);
  room.width = 5; room.height = 5;
  room.objects = [
    { x: 1, y: 3, z: 0, blockId: "player" },
    { x: 1, y: 2, z: 0, blockId: "puncher", orientation: "right", stateId: 0 },
    { x: 0, y: 2, z: 0, blockId: "wall" },
    { x: 4, y: 2, z: 0, blockId: "wall" },
    ...[[1,3],[1,2],[2,2],[3,2],[4,2]].map(([x,y])=>({x,y,z:0,blockId:"floor"}))
  ];
  runtime.assets.connectedWorld = new ConnectedWorldSessionV1(runtime.assets.engine, runtime.assets.blocks, [room]);
  runtime.internal.state = runtime.assets.engine.createState(room);
  runtime.internal.positions = [{ worldX: 1, worldY: 3 }];
  await runtime.apply("up");
  assert.deepEqual(runtime.internal.actions.at(-1).traversedPositions, [{worldX:1,worldY:2},{worldX:2,worldY:2}]);
  const { positions, current } = heatmapVisits(runtime.summary());
  assert.deepEqual(positions.map(p=>[p.worldX,p.worldY]), [[1,3],[3,2],[1,2],[2,2]]);
  assert.deepEqual([current.worldX,current.worldY], [3,2]);
});

test("one slide across two rooms uses world coordinates for every intermediate cell", async t => {
  const { runtime, room } = await corridor(t);
  room.objects = room.objects.map(o => o.blockId === "floor" && o.y === 1 ? {...o, blockId:"ice-floor"} : o);
  const destination = { ...structuredClone(room), fileName: "next.json", position: ["B","A"], columnIndex: 1 };
  destination.objects = destination.objects.filter(o=>o.blockId!=="player").map(o=>o.x===4&&o.y===1?{...o,blockId:"floor"}:o);
  runtime.assets.roomsByFile.set(destination.fileName,destination);
  runtime.assets.roomsByLabel.set("BXA",destination);
  runtime.assets.connectedWorld = new ConnectedWorldSessionV1(runtime.assets.engine,runtime.assets.blocks,[room,destination]);
  runtime.internal.state=runtime.assets.engine.createState(room);
  const result=await runtime.apply("right");
  assert.equal(result.action.roomAfter,"BxA");
  assert.equal(runtime.internal.positions.at(-1).worldX,9);
  assert.deepEqual(runtime.internal.actions.at(-1).traversedPositions,Array.from({length:8},(_,i)=>({worldX:i+1,worldY:1})));
  assert.equal(runtime.summary().unique_cells,10);
});
