import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { ConnectedWorldSessionV1 } from "../play/v1/connected-world-session.mjs";
import { instantiateMazeBenchEngineV1 } from "../engine/v1/engine.mjs";
import { decodeVoxelRoom } from "../render/v1/voxel-world-v2.mjs";
import { createRunIntegrity, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { OXC_REPAIR, replayCorrectedOxcEntry } from "../scripts/repair-benchmark-oxc-v1.mjs";

const root = path.resolve(import.meta.dirname, "..");
const originalRoom = execFileSync("git", ["show", `${OXC_REPAIR.sourceCommit}^:${OXC_REPAIR.file}`], { cwd: root });
const correctedRoom = decodeVoxelRoom(JSON.parse(execFileSync("git", ["show", `${OXC_REPAIR.sourceCommit}:${OXC_REPAIR.file}`], { cwd: root })));
// This one-off repair reproduces a historical falling-lift bug. Keep its
// original engine so fixing that bug does not erase the repair's input state.
const originalEngine = execFileSync("git", ["show", `${OXC_REPAIR.sourceCommit}^:engine/v1/voxel_physics.wasm`], { cwd: root });
const hasLift = state => state.objects.some(o => o.blockId === "lift" && o.x === 4 && o.y === 3 && o.z === 0);

async function fixture(historicalEngine = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mazebench-oxc-test-"));
  await createRunIntegrity(root, directory, {});
  const runtime = await BenchmarkGameRuntime.create(root, directory, { startRoom: "OxB", actionLimit: null });
  // This repair changed one exact historical revision. Later editor changes
  // to OxC must not turn its fixture into an unrelated level migration.
  runtime.assets.rooms = runtime.assets.rooms.map(room => room.fileName === path.basename(OXC_REPAIR.file)
    ? { ...room, ...correctedRoom } : room);
  runtime.assets.roomsByFile = new Map(runtime.assets.rooms.map(room => [room.fileName, room]));
  runtime.assets.roomsByLabel = new Map([...runtime.assets.roomsByLabel].map(([label, room]) =>
    [label, runtime.assets.roomsByFile.get(room.fileName)]));
  if (historicalEngine) {
    runtime.assets.engine = await instantiateMazeBenchEngineV1(originalEngine);
  }
  runtime.assets.connectedWorld = new ConnectedWorldSessionV1(runtime.assets.engine, runtime.assets.blocks, runtime.assets.rooms);
  const player = runtime.internal.state.objects.find(o => o.blockId === "player");
  Object.assign(player, { x: 4, y: 14, z: 1 });
  runtime.internal.gemsCollected = ["already-collected-fixture-gem"];
  runtime.internal.roomEntryState = structuredClone(runtime.internal.state);
  await runtime.apply("down");
  assert.equal(runtime.room.position.join("x"), "OxB");
  const world = runtime.assets.connectedWorld;
  const oldRooms = runtime.assets.rooms.map(room => room.fileName === path.basename(OXC_REPAIR.file)
    ? { ...room, ...decodeVoxelRoom(JSON.parse(originalRoom)) } : room);
  runtime.assets.connectedWorld = new ConnectedWorldSessionV1(runtime.assets.engine, runtime.assets.blocks, oldRooms);
  try { await runtime.apply("down"); } finally { runtime.assets.connectedWorld = world; }
  assert.equal(runtime.room.position.join("x"), "OxC"); assert.equal(hasLift(runtime.internal.state), !historicalEngine);
  return { runtime, directory };
}

test("the current engine keeps the authored OxC lift on entry even without the repaired floor", async () => {
  const { runtime, directory } = await fixture(false);
  try {
    assert.equal(runtime.internal.state.objects.some(o => o.blockId === "floor" && o.x === 4 && o.y === 3 && o.z === 0), false);
    assert(hasLift(runtime.internal.state));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the engine repairs only the last OxC entry, keeps its time and score, and updates signed replay records", async () => {
  const { runtime, directory } = await fixture();
  try {
    const original = structuredClone(runtime.internal);
    const frame = await readFile(path.join(directory, "display-history/move_1.json"), "utf8");
    const board = await readFile(path.join(directory, "records/move_history/move_1.txt"), "utf8");
    const beforeDisplay = await readFile(path.join(directory, "display-history/move_2.json"), "utf8");
    runtime.internal = await replayCorrectedOxcEntry(runtime, originalRoom);
    assert(hasLift(runtime.internal.state));
    assert.equal(runtime.internal.actionCount, 2);
    assert.equal(runtime.internal.updatedAt, original.updatedAt);
    assert.equal(runtime.internal.actions.at(-1).at, original.actions.at(-1).at);
    assert.deepEqual(runtime.internal.gemsCollected, original.gemsCollected);
    assert.deepEqual(runtime.internal.positions, original.positions);
    assert.deepEqual(runtime.internal.history, original.history);
    assert.deepEqual(runtime.internal.actions[0], original.actions[0]);
    await runtime.persist({ writeSnapshot: true }); verifyCheckpoint(directory);
    assert.equal(runtime.internal.actions.at(-1).animation, undefined);
    await assert.rejects(() => runtime.readRecord("move_history/move_2/index.json"), /Unknown/);
    assert.equal(await readFile(path.join(directory, "display-history/move_1.json"), "utf8"), frame);
    assert.equal(await readFile(path.join(directory, "records/move_history/move_1.txt"), "utf8"), board);
    const display = JSON.parse(await readFile(path.join(directory, "display-history/move_2.json"), "utf8"));
    assert.notEqual(display.level, JSON.parse(beforeDisplay).level);
    assert.equal(await readFile(path.join(directory, "records/current_board.txt"), "utf8"), display.level + "\n");
    const history = (await readFile(path.join(directory, "records/history.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(history.at(-1).stateHash, runtime.internal.stateHashes.at(-1));
    await writeFile(path.join(directory, "summary.json"), '{}');
    assert.throws(() => verifyCheckpoint(directory), /modified outside the engine/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reset retains the corrected lift, undo restores OxB exactly, and forward re-entry uses the fixed level", async () => {
  const { runtime, directory } = await fixture();
  try {
    const prior = structuredClone(runtime.internal.history.at(-1));
    runtime.internal = await replayCorrectedOxcEntry(runtime, originalRoom);
    const correctedEntry = structuredClone(runtime.internal.state);
    await runtime.apply("reset");
    assert.deepEqual(runtime.internal.state, correctedEntry); assert(hasLift(runtime.internal.state));
    await runtime.apply("undo");
    assert.equal(runtime.internal.roomFile, prior.roomFile); assert.deepEqual(runtime.internal.state, prior.state);
    assert.deepEqual(runtime.internal.roomEntryState, prior.roomEntryState);
    await runtime.apply("down");
    assert.deepEqual(runtime.internal.state, correctedEntry); verifyCheckpoint(directory);
    await runtime.apply("room OxB"); await runtime.apply("room OxC");
    assert.deepEqual(runtime.internal.state, runtime.assets.engine.createState(runtime.room));
    assert(hasLift(runtime.internal.state));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("correction refuses a different authored revision, non-reproducible state, previous visits, or a repeated repair", async () => {
  const { runtime, directory } = await fixture();
  try {
    const saved = structuredClone(runtime.internal);
    await assert.rejects(() => replayCorrectedOxcEntry(runtime, Buffer.from('{}')), /Unexpected original room/);
    runtime.internal.state.objects[0].x += 1;
    await assert.rejects(() => replayCorrectedOxcEntry(runtime, originalRoom));
    runtime.internal = structuredClone(saved); runtime.internal.actions[0].roomBefore = "OxC";
    await assert.rejects(() => replayCorrectedOxcEntry(runtime, originalRoom), /first visit/);
    runtime.internal = structuredClone(saved);
    runtime.internal = await replayCorrectedOxcEntry(runtime, originalRoom);
    await assert.rejects(() => replayCorrectedOxcEntry(runtime, originalRoom), /Original move must reproduce exactly/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
