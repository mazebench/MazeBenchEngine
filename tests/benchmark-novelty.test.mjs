import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { noveltyStateHash } from "../benchmarking/v1/novelty.mjs";
import { reconstructNovelty } from "../scripts/recalculate-gem-free-novelty-v1.mjs";

const root = path.resolve(import.meta.dirname, "..");
const definitions = new Map([
  ["player", { id: "player", roleId: "player" }],
  ["gem", { id: "gem", roleId: "goal" }],
  ["crate", { id: "crate", roleId: "push-block" }],
  ["wall", { id: "wall", roleId: "orange-wall" }],
  ["fixed-wall", { id: "fixed-wall", roleId: "solid" }],
  ["floor", { id: "floor", roleId: "floor" }],
  ["ice", { id: "ice", roleId: "ice" }],
  ["slope", { id: "slope", roleId: "ice", visual: { kind: "slope" } }],
  ["orange-slope", { id: "orange-slope", roleId: "orange-wall", visual: { kind: "slope" } }],
  ["floating-floor", { id: "floating-floor", roleId: "floating-floor" }]
]);
const board = { width: 5, height: 5, objects: [{ blockId: "player", x: 1, y: 1, z: 0 }, { blockId: "gem", x: 2, y: 1, z: 0 }, { blockId: "crate", x: 3, y: 1, z: 0 }] };

test("novelty ignores gem presence, gem position, object order and equivalent encoding", () => {
  const fingerprint = state => noveltyStateHash("room-a", state, definitions);
  const original = fingerprint(board);
  assert.equal(fingerprint({ ...board, objects: board.objects.filter(o => o.blockId !== "gem") }), original);
  assert.equal(fingerprint({ ...board, objects: board.objects.map(o => o.blockId === "gem" ? { ...o, x: -1, y: -1 } : o) }), original);
  assert.equal(fingerprint({ ...board, objects: [...board.objects].reverse() }), original);
  assert.equal(fingerprint({ ...board, objects: board.objects.map(o => o.blockId === "player" ? { ...o, genericId: -1 } : o) }), original);
});

test("room, player, crate and mechanism changes still earn distinct board identities", () => {
  const original = noveltyStateHash("room-a", board, definitions);
  assert.notEqual(noveltyStateHash("room-b", board, definitions), original);
  for (const blockId of ["player", "crate"]) {
    const changed = { ...board, objects: board.objects.map(o => o.blockId === blockId ? { ...o, x: o.x + 1 } : o) };
    assert.notEqual(noveltyStateHash("room-a", changed, definitions), original);
  }
  const mechanism = { ...board, objects: [...board.objects, { blockId: "wall", x: 4, y: 4, z: 0, mechanismDepth: 0 }] };
  const changed = structuredClone(mechanism); changed.objects.at(-1).mechanismDepth = 1;
  assert.notEqual(noveltyStateHash("room-a", mechanism, definitions), noveltyStateHash("room-a", changed, definitions));
});

test("fixed terrain edits do not earn novelty, while moving floors and orange mechanisms do", () => {
  const fingerprint = state => noveltyStateHash("room-a", state, definitions);
  const original = fingerprint(board);
  for (const blockId of ["fixed-wall", "floor", "ice", "slope"]) {
    assert.equal(fingerprint({ ...board, width: 20, objects: [...board.objects, { blockId, x: 4, y: 3, z: 1 }] }), original);
  }
  for (const blockId of ["floating-floor", "orange-slope"]) {
    const moving = { ...board, objects: [...board.objects, { blockId, x: 3, y: 3, z: 0 }] };
    const changed = structuredClone(moving); changed.objects.at(-1).z = 1;
    assert.notEqual(fingerprint(moving), fingerprint(changed));
  }
});

test("global gems and cameras cannot earn novelty, and resume retains the independent history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maze-gem-novelty-"));
  try {
    const runtime = await BenchmarkGameRuntime.create(root, directory, { actionLimit: 20 });
    const fullHash = runtime.internal.stateHashes[0];
    const noveltyHash = runtime.internal.noveltyHashes[0];
    await runtime.apply("camera left");
    assert.equal(runtime.internal.actions.at(-1).novel, false);
    runtime.internal.gemsCollected.push("test-room:2:1:0");
    runtime.internal.state.objects = runtime.internal.state.objects.filter(o => runtime.assets.definitions.get(o.blockId)?.roleId !== "goal");
    await runtime.apply("camera right");
    assert.notEqual(runtime.internal.stateHashes.at(-1), fullHash);
    assert.equal(runtime.internal.noveltyHashes.at(-1), noveltyHash);
    assert.equal(runtime.internal.actions.at(-1).novel, false);
    const reopened = await BenchmarkGameRuntime.open(root, directory);
    await reopened.apply("camera up");
    assert.equal(reopened.internal.actions.at(-1).novel, false);
    assert.equal(reopened.internal.noveltyHashes.length, reopened.internal.actionCount + 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("historical reconstruction recovers undone states and refuses a changed state hash", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maze-novelty-reconstruct-"));
  try {
    const runtime = await BenchmarkGameRuntime.create(root, directory, { actionLimit: 20 });
    await runtime.apply("up"); await runtime.apply("undo");
    const old = structuredClone(runtime.internal);
    const expected = [...old.noveltyHashes];
    delete old.noveltyHashes; delete old.noveltyVersion;
    const reconstructed = await reconstructNovelty(old, runtime.assets);
    assert.deepEqual(reconstructed.noveltyHashes, expected);
    assert(reconstructed.report.reconstructed_movements > 0);
    assert.deepEqual(reconstructed.flags, old.actions.map(a => a.novel));
    old.actions[0].stateHash = "0".repeat(64); old.stateHashes[1] = old.actions[0].stateHash;
    await assert.rejects(() => reconstructNovelty(old, runtime.assets), /Cannot reconstruct action 1/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
