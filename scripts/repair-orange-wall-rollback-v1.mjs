// Operator-only, single-run repair. Not reachable through HTTP or agent MCP.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { BenchmarkSupervisor } from "../benchmarking/v1/supervisor.mjs";
import { assertRunConfiguration, verifyCheckpoint, verifyRunIntegrity } from "../benchmarking/v1/integrity.mjs";
import { safeReadFile } from "../benchmarking/v1/safe-files.mjs";

export const ORANGE_ROLLBACK = Object.freeze({
  id: "run-2026-09-04T19-29-31-992Z-772688", move: 3877, previousMove: 4007,
  previousHash: "bae2c10c27ebfcae69b8ec958f651ecc2436354f177d761220992e108722faf8",
  preEntryHash: "fce2a71a9da064e7dff13fd6245181da1b820066f5353add4cdc0c117342c9ce",
  entryHash: "775d8fb05cda19bb8a577d316e1a6378c542541404dd9da101bc2f8e1c5ef676",
  roomFile: "4l13j61k51.json", nextRoomFile: "m44mzriroe.json"
});
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;

// Same canonical fields as the runtime; used to identify the historical undo
// snapshots before trusting them, not to generate the repaired checkpoint.
function snapshotHash(snapshot, gemsCollected) {
  return digest(JSON.stringify({
    roomFile: snapshot.roomFile,
    objects: snapshot.state.objects.map(object => ({
      blockId: object.blockId, x: object.x, y: object.y, z: object.z,
      genericId: object.genericId ?? object.engineGenericId ?? null,
      groupId: object.groupId ?? null, stateId: object.stateId ?? null,
      mechanismDepth: object.mechanismDepth ?? null, orientation: object.orientation ?? null
    })),
    gemsCollected: [...gemsCollected].sort()
  }));
}

export async function replayOrangeEntry(runtime) {
  const old = runtime.internal, spec = ORANGE_ROLLBACK;
  assert.equal(old.actionCount, spec.previousMove);
  assert.equal(old.stateHashes.at(-1), spec.previousHash);
  assert.equal(old.gemsCollected.length, 6);
  assert.equal(old.actions[spec.move - 2].stateHash, spec.preEntryHash);
  assert.equal(old.actions[spec.move - 1].stateHash, spec.entryHash);
  const tail = old.actions.slice(spec.move);
  assert(tail.every(a => ["LxM", "LxN"].includes(a.roomBefore) && ["LxM", "LxN"].includes(a.roomAfter)));
  assert(tail.every(a => a.gemsCollected === 0 && ["up", "right", "down", "left", "undo"].includes(a.action)));
  assert(!old.actions.slice(0, spec.move - 1).some(a => [a.roomBefore, a.roomAfter].includes("LxM")));
  const entryIndex = old.history.findIndex(h => snapshotHash(h, old.gemsCollected) === spec.entryHash);
  assert(entryIndex > 0, "The recorded entry must still exist in the undo history.");
  const prior = old.history[entryIndex - 1];
  assert.equal(snapshotHash(prior, old.gemsCollected), spec.preEntryHash);
  assert(old.history.slice(entryIndex).every(h => [spec.roomFile, spec.nextRoomFile].includes(h.roomFile)));
  const prefix = old.actions.slice(0, spec.move - 1);
  const visitedRooms = old.visitedRooms.slice(0, prefix.at(-1).roomsVisited);
  assert.equal(visitedRooms.length, 50);
  assert(!visitedRooms.includes(spec.roomFile) && !visitedRooms.includes(spec.nextRoomFile));
  // No later command revisited any prefix room, so their entry/reset snapshots
  // are still exact. Never carry the newly discovered future room across rewind.
  const roomEntryStates = Object.fromEntries(visitedRooms.map(file => [file, old.roomEntryStates[file]]));
  const previous = {
    ...old, roomFile: prior.roomFile, state: structuredClone(prior.state), roomEntryState: structuredClone(prior.roomEntryState),
    actionCount: spec.move - 1, actions: prefix.slice(), history: old.history.slice(0, entryIndex - 1),
    stateHashes: old.stateHashes.slice(0, spec.move), positions: old.positions.slice(0, spec.move),
    visitedRooms, roomEntryStates, gemsCollected: [...old.gemsCollected],
    blockedActions: old.blockedActions - tail.filter(a => a.blocked).length,
    deaths: old.deaths - tail.filter(a => a.died && old.positions[a.index - 1]).length,
    undos: old.undos - tail.filter(a => a.action === "undo").length
  };
  assert.equal(snapshotHash(previous, previous.gemsCollected), spec.preEntryHash);
  const repaired = new BenchmarkGameRuntime(runtime.projectRoot, runtime.runDirectory, runtime.assets, previous);
  repaired.persist = async () => {}; // The caller writes only a private staging directory.
  const originalAction = old.actions[spec.move - 1];
  assert.equal(originalAction.action, "down");
  await repaired.apply(originalAction.action);
  const result = repaired.internal;
  result.updatedAt = originalAction.at;
  result.actions.at(-1).at = originalAction.at;
  assert.equal(result.actionCount, spec.move);
  assert.equal(result.roomFile, spec.roomFile);
  assert.deepEqual(result.positions.at(-1), old.positions[spec.move]);
  assert.deepEqual(result.gemsCollected, old.gemsCollected);
  assert.deepEqual(result.actions.slice(0, -1), prefix);
  assert.deepEqual({ ...result.actions.at(-1), stateHash: originalAction.stateHash }, originalAction);
  assert.deepEqual(result.history, old.history.slice(0, entryIndex));
  assert.deepEqual(result.stateHashes.slice(0, -1), old.stateHashes.slice(0, spec.move));
  const nonWalls = state => state.objects.filter(o => o.blockId !== "orange-wall");
  assert.deepEqual(nonWalls(result.state), nonWalls(old.history[entryIndex].state));
  const walls = result.state.objects.filter(o => o.blockId === "orange-wall");
  assert.equal(walls.length, 13);
  assert(walls.every(o => o.z === 0 && o.mechanismDepth === 0));
  assert.deepEqual(result.state, result.roomEntryState);
  assert.deepEqual(result.state, result.roomEntryStates[spec.roomFile]);
  assert(!result.roomEntryStates[spec.nextRoomFile]);
  assert.equal(snapshotHash(result, result.gemsCollected), result.stateHashes.at(-1));
  return result;
}

async function atomicCopy(source, destination) {
  const temporary = `${destination}.${process.pid}.repair-tmp`;
  await copyFile(source, temporary); await rename(temporary, destination);
}

export async function repairOrangeRun(root, directory) {
  const spec = ORANGE_ROLLBACK;
  const originalRun = safeReadFile(directory, "run.json"), originalManifest = safeReadFile(directory, "integrity.json");
  const metadata = JSON.parse(originalRun), manifest = JSON.parse(originalManifest);
  assert.equal(metadata.id, spec.id); assert.equal(metadata.status, "paused");
  assert.equal(metadata.error, null); assert.equal(metadata.model, "gpt-6-astra"); assert.equal(metadata.tools_enabled, false);
  assert(!existsSync(path.join(directory, "integrity-violation.json")));
  assert.equal(digest(originalManifest), metadata.integrity.manifest_sha256);
  assertRunConfiguration(metadata, manifest); verifyCheckpoint(directory);
  const changes = JSON.parse(await readFile(new URL("./orange-wall-repair-assets-v1.json", import.meta.url)));
  // This reviewed allowlist is generated only after the canonical source sync.
  // No changed file outside it can be accepted, even during operator recovery.
  for (const [file, change] of Object.entries(changes.files)) {
    assert.equal(manifest.files[file], change.before, `Unexpected original asset ${file}.`);
    assert.equal(digest(safeReadFile(root, file, null)), change.after, `Unexpected replacement asset ${file}.`);
    manifest.files[file] = change.after;
  }
  const upstream = JSON.parse(safeReadFile(root, "engine/v1/upstream.json"));
  assert.equal(upstream.sourceCommit, changes.source_commit);
  const assertPaused = async () => {
    const response = await fetch(`http://localhost:8080/api/benchmark/v1/runs/${metadata.id}`);
    assert(response.ok);
    const live = await response.json();
    assert.equal(live.runner_active, false); assert.equal(live.status, "paused"); assert.equal(live.action_count, spec.previousMove);
  };
  await assertPaused();
  const beforeCheckpoint = safeReadFile(directory, "checkpoint.json");
  const staging = await mkdtemp(path.join(os.tmpdir(), "mazebench-orange-repair-"));
  const backup = path.join(directory, "repairs", "orange-wall-rollback-3877-v1");
  const files = ["integrity.json", "game-state.json", "summary.json", "checkpoint.json", "display.json",
    "records/current_board.txt", "records/current_state.json", "records/moves.txt", "records/history.jsonl",
    `records/move_history/move_${spec.move}.txt`, `display-history/move_${spec.move}.json`];
  try {
    for (const folder of ["sandbox-state", "records/move_history", "display-history"]) await mkdir(path.join(staging, folder), { recursive: true, mode: 0o700 });
    for (const file of ["prompt.md", "game-state.json", "summary.json", "checkpoint.json", "sandbox-state/integrity-key", "sandbox-state/direct-model-catalog.json"]) await copyFile(path.join(directory, file), path.join(staging, file));
    const encodedManifest = encode(manifest);
    const integrity = { ...metadata.integrity, manifest_sha256: digest(encodedManifest) };
    await writeFile(path.join(staging, "integrity.json"), encodedManifest, { mode: 0o600 });
    const supervisor = new BenchmarkSupervisor(root);
    await supervisor.verifyRunCapabilityBoundary({ ...metadata, integrity }, staging);
    const runtime = await BenchmarkGameRuntime.open(root, staging);
    runtime.internal = await replayOrangeEntry(runtime);
    await runtime.persist({ writeSnapshot: true });
    const future = [];
    for (const folder of ["display-history", "records/move_history"]) {
      for (const name of await readdir(path.join(directory, folder))) {
        const match = /^move_(\d+)\.(json|txt)$/.exec(name);
        assert(match, `Unexpected history artifact ${name}.`);
        if (Number(match[1]) > spec.move) future.push(`${folder}/${name}`);
      }
    }
    assert.equal(future.length, (spec.previousMove - spec.move) * 2);
    const repair = {
      at: new Date().toISOString(), kind: "operator-engine-rollback", action_count: spec.move, previous_action_count: spec.previousMove,
      reason: "User-authorized repair of orange-wall anchor corruption and cross-room orange-control leakage; replayed move 3877 from its exact pre-entry state. Later gameplay was archived. Earlier actions retain their original physics version.",
      source_commit: changes.source_commit, files: changes.files,
      original_manifest_sha256: metadata.integrity.manifest_sha256, repaired_manifest_sha256: integrity.manifest_sha256,
      original_state_hash: spec.previousHash, original_entry_hash: spec.entryHash, repaired_state_hash: runtime.internal.stateHashes.at(-1),
      codex_thread_id: metadata.codex_thread_id, conversation_retained: true, token_usage_retained: true,
      preserved: ["moves 0–3876", "6 gems", "move-3877 player coordinate", "prefix undo/reset history", "model and tool policy", "prompt", "paused status"],
      artifacts: {}, archived_future: {}
    };
    for (const file of files) repair.artifacts[file] = { before: digest(safeReadFile(directory, file, null)), after: digest(await readFile(path.join(staging, file))) };
    for (const file of future) repair.archived_future[file] = digest(safeReadFile(directory, file, null));
    metadata.integrity = integrity;
    metadata.runtime_repairs = [...(metadata.runtime_repairs || []), repair];
    await writeFile(path.join(staging, "run.json"), encode(metadata), { mode: 0o600 });
    await supervisor.verifyRunCapabilityBoundary(metadata, staging);
    await assertPaused();
    assert.equal(safeReadFile(directory, "run.json"), originalRun);
    assert.equal(safeReadFile(directory, "integrity.json"), originalManifest);
    assert.equal(safeReadFile(directory, "checkpoint.json"), beforeCheckpoint); verifyCheckpoint(directory);
    await mkdir(backup, { mode: 0o700 }); // refuses to overwrite any previous attempt
    for (const file of [...files, "run.json", "agent-events.jsonl", "tool-activity.jsonl", "agent-stderr.log", ...future]) {
      await mkdir(path.dirname(path.join(backup, file)), { recursive: true, mode: 0o700 });
      await copyFile(path.join(directory, file), path.join(backup, file));
    }
    await writeFile(path.join(backup, "repair.json"), encode(repair), { flag: "wx", mode: 0o600 });
    try {
      // Manifest first and metadata last keep any concurrent resume fail-closed.
      for (const file of files) await atomicCopy(path.join(staging, file), path.join(directory, file));
      for (const file of future) await rm(path.join(directory, file));
      await atomicCopy(path.join(staging, "run.json"), path.join(directory, "run.json"));
      await verifyRunIntegrity(root, directory, integrity); verifyCheckpoint(directory);
      await supervisor.verifyRunCapabilityBoundary(metadata, directory);
    } catch (error) {
      for (const file of [...files, "run.json", ...future]) await atomicCopy(path.join(backup, file), path.join(directory, file));
      throw error;
    }
    return { id: metadata.id, status: metadata.status, action_count: spec.move, room: "LxM", gems: 6, backup, state_hash: repair.repaired_state_hash };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], ORANGE_ROLLBACK.id, `Usage: node scripts/repair-orange-wall-rollback-v1.mjs ${ORANGE_ROLLBACK.id}`);
  const root = path.resolve(import.meta.dirname, ".."), records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records/mazebench-benchmark");
  console.log(JSON.stringify(await repairOrangeRun(root, path.join(records, ORANGE_ROLLBACK.id)), null, 2));
}
