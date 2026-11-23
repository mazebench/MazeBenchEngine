// Explicit operator recovery for the user's gate-ASCII fix and action-5845
// rollback. Never exposed to HTTP/MCP; unrelated edits cannot be resealed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { BenchmarkSupervisor } from "../benchmarking/v1/supervisor.mjs";
import { assertRunConfiguration, verifyCheckpoint, verifyRunIntegrity } from "../benchmarking/v1/integrity.mjs";
import { safeReadFile } from "../benchmarking/v1/safe-files.mjs";

export const GATE_ROLLBACK = Object.freeze({
  id: "run-2026-09-04T19-29-31-992Z-772688", from: 5866, to: 5845,
  fromHash: "0ac3e9e10280fbea9402ca8aae483108ced6a37afdd3a8144da19367abfcb7c9",
  toHash: "c644231d5039de788fda81bc371d124962de7f45dc3faa2ae446cdd38a026543",
  room: "ceb2sm9wq1.json", laterRoom: "neapcptnui.json",
  level: "level-data/v2/main-world/d1ziy6u45c.json",
  files: {
    "level-data/v2/main-world/d1ziy6u45c.json": {
      before: "5691f79fd7f8e1b15c993a16ba075b19e45ec2f44ae5d90de7d90bac9ea605d2",
      after: "b09bb97b673dbfe6f009bc7bad0304b184ec25fa1606f1715c6f8324f4d7182c"
    },
    "render-ascii/v1/ascii-scene.mjs": {
      before: "3020ec09c7f4c02200e2e265fcbc9b253bf6976a5c4d8ce34c23696b2c98acfa",
      after: "76fbd04ef59ea6e4c3ec5aa33fa3777ab2f085709b5a905453c020862dc34a3c"
    }
  }
});
const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
function snapshotHash(snapshot, gems) {
  return digest(JSON.stringify({
    roomFile: snapshot.roomFile,
    objects: snapshot.state.objects.map(object => ({
      blockId: object.blockId, x: object.x, y: object.y, z: object.z,
      genericId: object.genericId ?? object.engineGenericId ?? null,
      groupId: object.groupId ?? null, stateId: object.stateId ?? null,
      mechanismDepth: object.mechanismDepth ?? null, orientation: object.orientation ?? null
    })), gemsCollected: [...gems].sort()
  }));
}

export function restoreGateCheckpoint(old) {
  const spec = GATE_ROLLBACK;
  assert.equal(old.actionCount, spec.from);
  assert.equal(old.stateHashes.at(-1), spec.fromHash);
  assert.equal(old.stateHashes[spec.to], spec.toHash);
  assert.equal(old.gemsCollected.length, 7);
  assert(!old.visitedRooms.includes(path.basename(spec.level)), "A visited level edit needs a separate state repair.");
  const tail = old.actions.slice(spec.to);
  assert.equal(tail.length, 21);
  assert(tail.every(action => ["up", "right", "down", "left"].includes(action.action) && !action.died && action.gemsCollected === 0));
  assert(tail.every(action => action.roomBefore === "CxE"));
  assert(tail.slice(0, -1).every(action => action.roomAfter === "CxE"));
  assert.equal(tail.at(-1).roomAfter, "CxD");
  assert.equal(tail.filter(action => action.blocked).length, 1);
  const index = old.history.findIndex(snapshot => snapshotHash(snapshot, old.gemsCollected) === spec.toHash);
  assert.equal(index, 5235);
  assert.equal(old.history.length, 5255);
  assert(old.history.slice(index).every(snapshot => snapshot.roomFile === spec.room));
  const checkpoint = old.history[index];
  assert.equal(checkpoint.roomFile, spec.room);
  assert.deepEqual(checkpoint.state, checkpoint.roomEntryState);
  assert.deepEqual(checkpoint.roomEntryState, old.roomEntryStates[spec.room]);
  const actions = old.actions.slice(0, spec.to);
  assert.equal(actions.at(-1).stateHash, spec.toHash);
  assert.equal(actions.at(-1).roomsVisited, 65);
  const visitedRooms = old.visitedRooms.slice(0, 65);
  assert.equal(old.visitedRooms.length, 66);
  assert.equal(visitedRooms.at(-1), spec.room);
  assert.equal(old.visitedRooms.at(-1), spec.laterRoom);
  const restored = {
    ...old, ...structuredClone(checkpoint), actionCount: spec.to, actions,
    updatedAt: actions.at(-1).at, history: old.history.slice(0, index),
    stateHashes: old.stateHashes.slice(0, spec.to + 1), positions: old.positions.slice(0, spec.to + 1),
    visitedRooms, roomEntryStates: Object.fromEntries(visitedRooms.map(file => [file, old.roomEntryStates[file]])),
    blockedActions: old.blockedActions - 1
  };
  assert.equal(snapshotHash(restored, restored.gemsCollected), spec.toHash);
  assert.deepEqual(restored.state.objects.find(object => object.blockId === "player"), { x: 15, y: 3, z: 0, blockId: "player" });
  return restored;
}

async function atomicCopy(source, destination) {
  const temporary = `${destination}.${process.pid}.repair-tmp`;
  await copyFile(source, temporary);
  await rename(temporary, destination);
}

export async function repairGateRun(root, directory) {
  const spec = GATE_ROLLBACK;
  const originalRun = safeReadFile(directory, "run.json"), originalManifest = safeReadFile(directory, "integrity.json");
  const originalViolation = safeReadFile(directory, "integrity-violation.json");
  const metadata = JSON.parse(originalRun), manifest = JSON.parse(originalManifest);
  const expectedError = `Benchmark runtime changed (${spec.level}); start a new run.`;
  assert.equal(metadata.id, spec.id); assert.equal(metadata.status, "failed");
  assert.equal(metadata.error, `Run invalidated: ${expectedError}`);
  assert.deepEqual(JSON.parse(originalViolation), { error: expectedError });
  assert.equal(metadata.model, "gpt-6-astra"); assert.equal(metadata.tools_enabled, false);
  assert.equal(metadata.codex_thread_id, "01a06de5-cf11-7883-9f85-b1197dd668f5");
  assert.equal(digest(originalManifest), metadata.integrity.manifest_sha256);
  assertRunConfiguration(metadata, manifest); verifyCheckpoint(directory);
  for (const [file, hashes] of Object.entries(spec.files)) {
    assert.equal(manifest.files[file], hashes.before, `Unexpected original asset ${file}.`);
    assert.equal(digest(safeReadFile(root, file, null)), hashes.after, `Unexpected replacement asset ${file}.`);
    manifest.files[file] = hashes.after;
  }
  const assertInactive = async () => {
    const response = await fetch(`http://localhost:8080/api/benchmark/v1/runs/${metadata.id}`);
    assert(response.ok);
    const live = await response.json();
    assert.equal(live.runner_active, false); assert.equal(live.status, "failed"); assert.equal(live.action_count, spec.from);
  };
  await assertInactive();
  const beforeCheckpoint = safeReadFile(directory, "checkpoint.json");
  const staging = await mkdtemp(path.join(os.tmpdir(), "mazebench-gate-rollback-"));
  const backup = path.join(directory, "repairs", "gate-ascii-rollback-5845-v1");
  const files = ["integrity.json", "game-state.json", "summary.json", "checkpoint.json", "display.json",
    "records/current_board.txt", "records/current_state.json", "records/moves.txt", "records/history.jsonl",
    `records/move_history/move_${spec.to}.txt`, `display-history/move_${spec.to}.json`];
  try {
    for (const folder of ["sandbox-state", "records/move_history", "display-history"])
      await mkdir(path.join(staging, folder), { recursive: true, mode: 0o700 });
    for (const file of ["prompt.md", "game-state.json", "summary.json", "checkpoint.json", "sandbox-state/integrity-key", "sandbox-state/direct-model-catalog.json"])
      await copyFile(path.join(directory, file), path.join(staging, file));
    const encodedManifest = encode(manifest);
    const integrity = { ...metadata.integrity, manifest_sha256: digest(encodedManifest) };
    await writeFile(path.join(staging, "integrity.json"), encodedManifest, { mode: 0o600 });
    const supervisor = new BenchmarkSupervisor(root);
    await supervisor.verifyRunCapabilityBoundary({ ...metadata, integrity }, staging);
    const runtime = await BenchmarkGameRuntime.open(root, staging);
    runtime.internal = restoreGateCheckpoint(runtime.internal);
    await runtime.persist({ writeSnapshot: true });
    assert.equal(runtime.summary().action_count, spec.to);
    assert.equal(runtime.summary().gems_collected, 7);
    const future = [];
    for (const folder of ["display-history", "records/move_history"]) {
      for (const name of await readdir(path.join(directory, folder))) {
        const match = /^move_(\d+)\.(json|txt)$/.exec(name);
        assert(match, `Unexpected history artifact ${name}.`);
        if (Number(match[1]) > spec.to) future.push(`${folder}/${name}`);
      }
    }
    assert.equal(future.length, 42);
    const repair = {
      at: new Date().toISOString(), kind: "operator-engine-rollback", action_count: spec.to, previous_action_count: spec.from,
      reason: "User requested distinct gate states in ASCII, accepted their mid-run CxF floor edit, and requested rollback to action 5845 for manual testing before any resume.",
      files: spec.files, previous_error: metadata.error, archived_violation: JSON.parse(originalViolation),
      original_manifest_sha256: metadata.integrity.manifest_sha256, repaired_manifest_sha256: integrity.manifest_sha256,
      original_state_hash: spec.fromHash, repaired_state_hash: spec.toHash,
      codex_thread_id: metadata.codex_thread_id, conversation_retained: true, token_usage_retained: true,
      preserved: ["actions 0–5845", "exact action-5845 board state", "7 gems", "prefix undo/reset history", "camera", "model/tool policy", "prompt"],
      level_note: "CxF was not visited. The edit adds the authored floor under its lift at (8,5,0); no past physical state changes. Earlier observations retain their original renderer.",
      artifacts: {}, archived_future: {}
    };
    for (const file of files) repair.artifacts[file] = { before: digest(safeReadFile(directory, file, null)), after: digest(await readFile(path.join(staging, file))) };
    for (const file of future) repair.archived_future[file] = digest(safeReadFile(directory, file, null));
    metadata.integrity = integrity; metadata.runtime_repairs = [...(metadata.runtime_repairs || []), repair];
    metadata.status = "paused"; metadata.error = null; metadata.completed_at = null; metadata.paused_at = repair.at; metadata.updated_at = repair.at;
    await writeFile(path.join(staging, "run.json"), encode(metadata), { mode: 0o600 });
    await supervisor.verifyRunCapabilityBoundary(metadata, staging);
    await assertInactive();
    assert.equal(safeReadFile(directory, "run.json"), originalRun);
    assert.equal(safeReadFile(directory, "integrity.json"), originalManifest);
    assert.equal(safeReadFile(directory, "integrity-violation.json"), originalViolation);
    assert.equal(safeReadFile(directory, "checkpoint.json"), beforeCheckpoint); verifyCheckpoint(directory);
    await mkdir(backup, { mode: 0o700 });
    for (const file of [...files, "run.json", "integrity-violation.json", "agent-events.jsonl", "tool-activity.jsonl", "agent-stderr.log", ...future]) {
      await mkdir(path.dirname(path.join(backup, file)), { recursive: true, mode: 0o700 });
      await copyFile(path.join(directory, file), path.join(backup, file));
    }
    await writeFile(path.join(backup, "repair.json"), encode(repair), { flag: "wx", mode: 0o600 });
    try {
      for (const file of files) await atomicCopy(path.join(staging, file), path.join(directory, file));
      for (const file of future) await rm(path.join(directory, file));
      await atomicCopy(path.join(staging, "run.json"), path.join(directory, "run.json"));
      await verifyRunIntegrity(root, directory, integrity); verifyCheckpoint(directory);
      // Keep the known invalidation in place until the restored state and the
      // complete replacement inventory verify, then recheck the actual run.
      await rm(path.join(directory, "integrity-violation.json"));
      await supervisor.verifyRunCapabilityBoundary(metadata, directory);
    } catch (error) {
      await atomicCopy(path.join(backup, "integrity-violation.json"), path.join(directory, "integrity-violation.json"));
      for (const file of [...files, "run.json", ...future]) await atomicCopy(path.join(backup, file), path.join(directory, file));
      throw error;
    }
    return { id: metadata.id, status: "paused", action_count: spec.to, room: "CxE", gems: 7, backup, state_hash: spec.toHash };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], GATE_ROLLBACK.id);
  const root = path.resolve(import.meta.dirname, ".."), records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records/mazebench-benchmark");
  console.log(JSON.stringify(await repairGateRun(root, path.join(records, GATE_ROLLBACK.id)), null, 2));
}
