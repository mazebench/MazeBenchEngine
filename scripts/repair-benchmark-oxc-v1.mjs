// Operator-only correction authorized for this paused run at move 3334.
// Never exposed through HTTP or agent MCP. Pins the exact authored asset change,
// replays the last entry with the engine, and archives every replaced artifact.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { BenchmarkSupervisor } from "../benchmarking/v1/supervisor.mjs";
import { assertRunConfiguration, verifyCheckpoint, verifyRunIntegrity } from "../benchmarking/v1/integrity.mjs";
import { safeReadFile } from "../benchmarking/v1/safe-files.mjs";
import { ConnectedWorldSessionV1 } from "../play/v1/connected-world-session.mjs";
import { decodeVoxelRoom } from "../render/v1/voxel-world-v2.mjs";

export const OXC_REPAIR = Object.freeze({
  id: "run-2026-09-04T19-29-31-992Z-772688",
  move: 3334,
  file: "level-data/v2/main-world/neyecnf3gf.json",
  before: "135184d0e7fc85eeb38fe7db26b222647f24bfa9e20f45eca661bba5b048b4cc",
  after: "7ee38c4858aa9c9a3ca31bb6a1e717420ddedfa2a39d8275fc04a69af9e5b566",
  sourceCommit: "66d1956a8df4b17a8dce793485e38d5be50364ce"
});
const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const roomFile = path.basename(OXC_REPAIR.file);

// Reconstruct the exact pre-entry checkpoint, then let the normal runtime apply
// the already-recorded action. No new agent action or timestamp is introduced.
export async function replayCorrectedOxcEntry(runtime, originalRoomBytes) {
  assert.equal(digest(originalRoomBytes), OXC_REPAIR.before, "Unexpected original room.");
  const original = runtime.internal, last = original.actions.at(-1), prior = original.history.at(-1);
  assert.equal(original.roomFile, roomFile);
  assert(last && last.index === original.actionCount && last.action === "down" && last.roomBefore === "OxB" && last.roomAfter === "OxC", "Expected the latest move to enter OxC from OxB.");
  assert(last.stateChanged && !last.blocked && !last.died && last.gemsCollected === 0);
  assert(prior && prior.roomFile !== roomFile);
  assert(!original.actions.slice(0, -1).some(a => a.roomBefore === "OxC" || a.roomAfter === "OxC"), "OxC must be a first visit.");
  assert(!original.history.some(h => h.roomFile === roomFile), "Earlier OxC history cannot be rewritten.");
  assert.deepEqual(original.state, original.roomEntryState);
  assert.deepEqual(original.state, original.roomEntryStates[roomFile]);
  const assets = runtime.assets, oldRoom = { ...runtime.room, ...decodeVoxelRoom(JSON.parse(originalRoomBytes)) };
  const oldWorld = new ConnectedWorldSessionV1(assets.engine, assets.blocks, assets.rooms.map(r => r.fileName === roomFile ? oldRoom : r));
  const replay = await oldWorld.simulateCommand(prior.state, assets.roomsByFile.get(prior.roomFile), "down");
  assert.equal(replay.room.fileName, roomFile);
  assert.deepEqual(replay.final, original.state, "Original move must reproduce exactly before correcting it.");
  const previous = {
    ...original, roomFile: prior.roomFile, state: structuredClone(prior.state), roomEntryState: structuredClone(prior.roomEntryState),
    actionCount: original.actionCount - 1, actions: original.actions.slice(0, -1), history: original.history.slice(0, -1),
    stateHashes: original.stateHashes.slice(0, -1), positions: original.positions.slice(0, -1),
    visitedRooms: original.visitedRooms.filter(file => file !== roomFile), roomEntryStates: { ...original.roomEntryStates },
    gemsCollected: [...original.gemsCollected]
  };
  delete previous.roomEntryStates[roomFile];
  const corrected = new BenchmarkGameRuntime(runtime.projectRoot, runtime.runDirectory, assets, previous);
  corrected.persist = async () => {}; // Only the caller's private staging checkpoint is written later.
  await corrected.apply(last.action);
  const state = corrected.internal;
  state.updatedAt = original.updatedAt;
  state.actions.at(-1).at = last.at;
  // Verify the correction consists only of the missing floor and the lift that
  // used to fall away on entry. In particular, the player's position is fixed.
  const objectKey = object => JSON.stringify(object);
  const oldObjects = new Set(original.state.objects.map(objectKey));
  const newObjects = new Set(state.state.objects.map(objectKey));
  assert(original.state.objects.every(o => newObjects.has(objectKey(o))), "The repair removed an existing object.");
  assert.deepEqual(state.state.objects.filter(o => !oldObjects.has(objectKey(o))), [
    { x: 4, y: 3, z: 0, blockId: "floor" },
    { x: 4, y: 3, z: 0, blockId: "lift", orientation: "top", stateId: 1, variantId: 0, engineGenericId: 1, genericId: 1, groupId: 1 }
  ]);
  for (const key of Object.keys(original)) {
    if (!["state", "roomEntryState", "roomEntryStates", "actions", "stateHashes"].includes(key)) assert.deepEqual(state[key], original[key], `Unexpected change to ${key}.`);
  }
  assert.deepEqual(state.roomEntryState, state.state);
  assert.deepEqual(state.roomEntryStates[roomFile], state.state);
  for (const file of Object.keys(original.roomEntryStates)) if (file !== roomFile) assert.deepEqual(state.roomEntryStates[file], original.roomEntryStates[file]);
  assert.deepEqual(state.actions.slice(0, -1), original.actions.slice(0, -1));
  // Corrected geometry invalidates the original animation. This historical
  // repair writes final snapshots only, so never advertise the stale frames.
  const { animation: discardedAnimation, ...originalAction } = last;
  assert.deepEqual({ ...state.actions.at(-1), stateHash: last.stateHash }, originalAction);
  assert.deepEqual(state.stateHashes.slice(0, -1), original.stateHashes.slice(0, -1));
  assert.equal(state.actions.at(-1).stateHash, state.stateHashes.at(-1));
  assert.notEqual(state.stateHashes.at(-1), original.stateHashes.at(-1));
  return state;
}

async function atomicCopy(source, destination) {
  const temporary = `${destination}.${process.pid}.repair-tmp`;
  await copyFile(source, temporary); await rename(temporary, destination);
}

export async function repairOxcRun(root, directory) {
  const originalRun = safeReadFile(directory, "run.json"), originalManifest = safeReadFile(directory, "integrity.json");
  const metadata = JSON.parse(originalRun), manifest = JSON.parse(originalManifest);
  assert.equal(metadata.id, OXC_REPAIR.id, "This correction is authorized only for the specified run.");
  assert.equal(metadata.status, "paused", "Keep the agent paused during correction.");
  assert.equal(metadata.error, null);
  assert.equal(metadata.tools_enabled, false);
  assert.equal(metadata.model, "gpt-6-astra");
  assert(!existsSync(path.join(directory, "integrity-violation.json")), "Integrity-invalidated runs cannot be repaired.");
  assert.equal(digest(originalManifest), metadata.integrity.manifest_sha256);
  assertRunConfiguration(metadata, manifest); verifyCheckpoint(directory);
  assert.equal(manifest.files[OXC_REPAIR.file], OXC_REPAIR.before);
  const authored = safeReadFile(root, OXC_REPAIR.file, null);
  assert.equal(digest(authored), OXC_REPAIR.after, "Only the exact user-authored floor correction is permitted.");
  const oldAuthored = execFileSync("git", ["show", `${OXC_REPAIR.sourceCommit}^:${OXC_REPAIR.file}`], { cwd: root });
  assert.equal(digest(oldAuthored), OXC_REPAIR.before);
  const live = await (await fetch(`http://localhost:8080/api/benchmark/v1/runs/${metadata.id}`)).json();
  assert.equal(live.runner_active, false); assert.equal(live.status, "paused"); assert.equal(live.action_count, OXC_REPAIR.move);
  const checkpointBefore = safeReadFile(directory, "checkpoint.json");
  const staging = await mkdtemp(path.join(os.tmpdir(), "mazebench-oxc-correction-"));
  const backup = path.join(directory, "repairs", "oxc-floor-move-3334-v1");
  try {
    for (const folder of ["sandbox-state", "records/move_history", "display-history"]) await mkdir(path.join(staging, folder), { recursive: true, mode: 0o700 });
    for (const file of ["prompt.md", "game-state.json", "summary.json", "checkpoint.json", "sandbox-state/integrity-key", "sandbox-state/direct-model-catalog.json"]) await copyFile(path.join(directory, file), path.join(staging, file));
    manifest.files[OXC_REPAIR.file] = OXC_REPAIR.after;
    const encodedManifest = encode(manifest);
    const integrity = { ...metadata.integrity, manifest_sha256: digest(encodedManifest) };
    await writeFile(path.join(staging, "integrity.json"), encodedManifest, { mode: 0o600 });
    const supervisor = new BenchmarkSupervisor(root);
    await supervisor.verifyRunCapabilityBoundary({ ...metadata, integrity }, staging);
    const runtime = await BenchmarkGameRuntime.open(root, staging);
    assert.equal(runtime.internal.actionCount, OXC_REPAIR.move);
    assert.equal(runtime.internal.gemsCollected.length, 6);
    assert.equal(runtime.internal.stateHashes.at(-1), "8e1042b5f8a7a977811202e583d5199e3a55b8a69a1ef2a77518959974b2138e", "Unexpected move-3334 checkpoint.");
    const originalStateHash = runtime.internal.stateHashes.at(-1);
    runtime.internal = await replayCorrectedOxcEntry(runtime, oldAuthored);
    await runtime.persist({ writeSnapshot: true });
    const repair = {
      at: new Date().toISOString(), kind: "operator-level-correction", action_count: OXC_REPAIR.move, room: "OxC",
      reason: "User-authorized floor correction at (4,3,0) beneath the lift; replayed only move 3334. Earlier moves remain original. This run spans two authored level versions.",
      files: { [OXC_REPAIR.file]: { before: OXC_REPAIR.before, after: OXC_REPAIR.after } }, source_commit: OXC_REPAIR.sourceCommit,
      original_manifest_sha256: metadata.integrity.manifest_sha256, repaired_manifest_sha256: integrity.manifest_sha256,
      original_state_hash: originalStateHash, repaired_state_hash: runtime.internal.stateHashes.at(-1),
      codex_thread_id: metadata.codex_thread_id, preserved: ["actions 0–3333", "player position", "6 collected gems", "camera", "undo history", "prompt", "agent transcript", "capability policy", "paused status"],
      artifacts: {}
    };
    const files = ["game-state.json", "summary.json", "checkpoint.json", "display.json", "records/current_board.txt", "records/current_state.json", "records/history.jsonl", `records/move_history/move_${OXC_REPAIR.move}.txt`, `display-history/move_${OXC_REPAIR.move}.json`, "integrity.json"];
    for (const file of files) repair.artifacts[file] = { before: digest(safeReadFile(directory, file, null)), after: digest(await readFile(path.join(staging, file))) };
    metadata.integrity = integrity;
    metadata.runtime_repairs = [...(metadata.runtime_repairs || []), repair];
    await writeFile(path.join(staging, "run.json"), encode(metadata), { mode: 0o600 });
    await supervisor.verifyRunCapabilityBoundary(metadata, staging);
    // Recheck the live checkpoint immediately before installation. Writing the
    // new manifest first keeps resume fail-closed until run.json is installed last.
    const current = await (await fetch(`http://localhost:8080/api/benchmark/v1/runs/${metadata.id}`)).json();
    assert.equal(current.runner_active, false); assert.equal(current.status, "paused");
    assert.equal(safeReadFile(directory, "run.json"), originalRun);
    assert.equal(safeReadFile(directory, "integrity.json"), originalManifest);
    assert.equal(safeReadFile(directory, "checkpoint.json"), checkpointBefore); verifyCheckpoint(directory);
    await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 }); await mkdir(backup, { mode: 0o700 });
    for (const file of [...files, "run.json"]) {
      await mkdir(path.dirname(path.join(backup, file)), { recursive: true, mode: 0o700 });
      await copyFile(path.join(directory, file), path.join(backup, file));
    }
    await writeFile(path.join(backup, "authored.before.json"), oldAuthored, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(backup, "authored.after.json"), authored, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(backup, "repair.json"), encode(repair), { flag: "wx", mode: 0o600 });
    try {
      for (const file of ["integrity.json", ...files.filter(f => f !== "integrity.json"), "run.json"]) await atomicCopy(path.join(staging, file), path.join(directory, file));
      await verifyRunIntegrity(root, directory, integrity); verifyCheckpoint(directory);
      await supervisor.verifyRunCapabilityBoundary(metadata, directory);
    } catch (error) {
      for (const file of [...files, "run.json"]) await atomicCopy(path.join(backup, file), path.join(directory, file));
      throw error;
    }
    return { id: metadata.id, status: metadata.status, action_count: OXC_REPAIR.move, room: "OxC", backup, state_hash: repair.repaired_state_hash };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], OXC_REPAIR.id, `Usage: node scripts/repair-benchmark-oxc-v1.mjs ${OXC_REPAIR.id}`);
  const root = path.resolve(import.meta.dirname, ".."), records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records/mazebench-benchmark");
  console.log(JSON.stringify(await repairOxcRun(root, path.join(records, OXC_REPAIR.id)), null, 2));
}
