// Operator-only recovery of the observed 512-MB save failure. Never exposed by
// HTTP or MCP. Authenticate the old board, reproduce the already-requested move,
// and require its result to match the interrupted save before installing it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkGameRuntime, expandBenchmarkSequence } from "../benchmarking/v1/runtime.mjs";
import { BenchmarkSupervisor } from "../benchmarking/v1/supervisor.mjs";
import { assertRunConfiguration, verifyCheckpoint, verifyRunIntegrity } from "../benchmarking/v1/integrity.mjs";
import { safeReadFile } from "../benchmarking/v1/safe-files.mjs";

const ID = "run-2026-09-04T19-29-31-992Z-772688";
const ERROR = "Benchmark state or score was modified outside the engine; refusing execution.";
const files = {
  "benchmarking/v1/runtime.mjs": {
    before: "f2b2847493a162fec2568fea95c64237c81dcafc7ce6d72d2f928fd8b4d3a230",
    after: "d6f2c063e4369791c99e653ce0c461a1539f0c0e9f454aeaff20cfe2c321cf3c"
  },
  "benchmarking/v1/integrity.mjs": {
    before: "d0a03ae286d00a3536a9bd704d6522bea7ab76cec3aad41b199992a2b864a96e",
    after: "d300589d84f0e39d2367f2032b391cd99b8a3252886d992879f4357b878e03db"
  },
  "benchmarking/v1/safe-files.mjs": {
    before: "14aaaa232f98b84f34a0f423de998347fcb8ae622d748191b0a9f0c9c07dfd95",
    after: "454078f601f498aac6fe96070f76e105df5546d7c8061372e1a9be87f41a22d5"
  },
  "benchmarking/v1/supervisor.mjs": {
    before: "057e7bb2fd3762cd4473b712dcb22b00a5c4ead5dd06d8127818eca6e1bdbb32",
    after: "35da9bf2cec8c71b7682e139d6869f6a7183ed66631a053328527999261ca4b3"
  },
  "benchmarking/v1/checkpoint-json.mjs": {
    before: null,
    after: "7d8dce1b7cbc6f5e246240c159960ab8cab474fc6caabf86c7b54aeb6298e166"
  }
};
export { files as CHECKPOINT_SIZE_FILES };
const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const json = (directory, relative) => JSON.parse(safeReadFile(directory, relative));
async function atomicCopy(source, destination) {
  const temporary = `${destination}.${process.pid}.repair-tmp`;
  await copyFile(source, temporary);
  await rename(temporary, destination);
}

export async function repairCheckpointSize(root, directory) {
  const originalRun = safeReadFile(directory, "run.json"), originalManifest = safeReadFile(directory, "integrity.json");
  const metadata = JSON.parse(originalRun), manifest = JSON.parse(originalManifest);
  assert.equal(metadata.id, ID); assert.equal(metadata.status, "failed");
  assert.equal(metadata.error, `Run invalidated: ${ERROR}`);
  assert.deepEqual(json(directory, "integrity-violation.json"), { error: ERROR });
  assert.equal(metadata.model, "gpt-6-astra"); assert.equal(metadata.tools_enabled, false);
  assert.equal(metadata.codex_thread_id, "01a06de5-cf11-7883-9f85-b1197dd668f5");
  assert.equal(digest(originalManifest), metadata.integrity.manifest_sha256);
  assertRunConfiguration(metadata, manifest);
  for (const [file, hashes] of Object.entries(files)) {
    assert.equal(manifest.files[file] ?? null, hashes.before, `Unexpected old asset ${file}.`);
    assert.equal(digest(safeReadFile(root, file, null)), hashes.after, `Unexpected replacement asset ${file}.`);
    manifest.files[file] = hashes.after;
  }
  manifest.files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const encodedManifest = encode(manifest), integrity = { ...metadata.integrity, manifest_sha256: digest(encodedManifest) };
  const assertInactive = async () => {
    const response = await fetch(`http://localhost:8080/api/benchmark/v1/runs/${ID}`);
    assert(response.ok); const live = await response.json();
    assert.equal(live.runner_active, false); assert.equal(live.status, "failed"); assert.equal(live.action_count, 8183);
  };
  await assertInactive();
  const activity = safeReadFile(directory, "tool-activity.jsonl").trim().split(/\r?\n/).map(JSON.parse);
  const failed = activity.at(-3);
  assert.equal(failed.id, "7585cf5d-db5b-4970-9ac2-70afd04535a7");
  assert.equal(failed.tool, "maze_sequence"); assert.equal(failed.status, "failed");
  assert.equal(failed.sequence, "DDDDRRRDDDDDRDDDLUUU"); assert.equal(failed.error, "Invalid string length");
  assert.equal(failed.action_count_before, 8171); assert.equal(failed.action_count_after, 8183);
  assert.equal(activity.at(-1).tool, "maze_observe"); assert.equal(activity.at(-1).error, ERROR);
  const events = safeReadFile(directory, "agent-events.jsonl").trim().split(/\r?\n/).map(JSON.parse);
  const requested = events.at(-4);
  assert.equal(requested.type, "item.started"); assert.equal(requested.item.type, "mcp_tool_call");
  assert.equal(requested.item.id, "item_616"); assert.equal(requested.item.tool, "maze_sequence");
  assert.deepEqual(requested.item.arguments, { sequence: failed.sequence });
  const incompleteSummary = json(directory, "summary.json");
  const expectedAction = incompleteSummary.actions.at(-1);
  assert.equal(expectedAction.index, 8183); assert.equal(expectedAction.action, "down");
  assert.equal(expectedAction.stateHash, "cb7c891dd5a726244cb2ccf6805f204deb4451b0e6a8c213cff4777b21a5943c");

  const artifacts = ["game-state.json", "summary.json", "checkpoint.json", "display.json", "integrity.json",
    "records/current_board.txt", "records/current_state.json", "records/moves.txt", "records/history.jsonl"];
  const generated = ["records/move_history/move_8183.txt", "display-history/move_8183.json"];
  const protectedFiles = ["run.json", "integrity-violation.json", "prompt.md", "agent-events.jsonl", "tool-activity.jsonl", ...artifacts];
  const originals = Object.fromEntries(protectedFiles.map(file => [file, digest(safeReadFile(directory, file, null))]));
  for (const file of generated) await assert.rejects(() => stat(path.join(directory, file)), { code: "ENOENT" });
  const staging = await mkdtemp(path.join(os.tmpdir(), "maze-checkpoint-size-repair-"));
  const backup = path.join(directory, "repairs", "checkpoint-size-8183-v1");
  try {
    for (const folder of ["sandbox-state", "records/move_history", "display-history"])
      await mkdir(path.join(staging, folder), { recursive: true, mode: 0o700 });
    for (const file of ["game-state.json", "checkpoint.json", "prompt.md", "sandbox-state/integrity-key", "sandbox-state/direct-model-catalog.json"])
      await copyFile(path.join(directory, file), path.join(staging, file));
    const runtime = await BenchmarkGameRuntime.open(root, staging);
    assert.equal(runtime.internal.actionCount, 8182); assert.equal(runtime.internal.history.length, 7288);
    assert.equal(runtime.internal.gemsCollected.length, 8);
    assert.equal(runtime.internal.stateHashes.at(-1), "214104365c98f7b75ff1f713ae10ee473bb751efa9f05284923e79cf2ed60f36");
    assert.deepEqual(runtime.summary().actions, incompleteSummary.actions.slice(0, 8182));
    const sequence = expandBenchmarkSequence(failed.sequence);
    assert.deepEqual(runtime.internal.actions.slice(8171).map(action => action.action), sequence.slice(0, 11));
    assert.equal(sequence[11], expectedAction.action);
    // This MUST match the pre-failure signature. We are not re-signing an
    // unverified board: only the overwritten summary is reconstructed here.
    await writeFile(path.join(staging, "summary.json"), encode(runtime.summary()));
    verifyCheckpoint(staging);
    await writeFile(path.join(staging, "integrity.json"), encodedManifest, { mode: 0o600 });
    await verifyRunIntegrity(root, staging, integrity);
    const supervisor = new BenchmarkSupervisor(root);
    await supervisor.verifyRunCapabilityBoundary({ ...metadata, integrity }, staging);
    await runtime.apply(expectedAction.action);
    // Replay timestamps differ; preserve the recorded time of the original move.
    runtime.internal.updatedAt = expectedAction.at;
    runtime.internal.actions.at(-1).at = expectedAction.at;
    assert.deepEqual(runtime.summary(), incompleteSummary);
    await runtime.persist({ writeSnapshot: true });
    assert.deepEqual(json(staging, "display.json"), json(directory, "display.json"));
    assert.deepEqual(json(staging, "records/current_state.json"), json(directory, "records/current_state.json"));
    for (const file of ["records/current_board.txt", "records/moves.txt", "records/history.jsonl"])
      assert.equal(safeReadFile(staging, file), safeReadFile(directory, file));
    const reopened = await BenchmarkGameRuntime.open(root, staging);
    assert.deepEqual(reopened.internal, runtime.internal);
    verifyCheckpoint(staging);
    const repair = {
      at: new Date().toISOString(), kind: "operator-checkpoint-recovery", action_count: 8183,
      last_authenticated_action: 8182, reason: "User requested resume. Streaming checkpoint storage fixes V8's 512-MB JSON string limit. Recovered the one interrupted, agent-requested down move by exact engine replay from the previously authenticated board.",
      previous_error: metadata.error, files, old_checkpoint_authenticated: true,
      old_state_hash: runtime.internal.stateHashes[8182], recovered_state_hash: expectedAction.stateHash,
      interrupted_tool_id: failed.id, interrupted_sequence: failed.sequence, recovered_sequence_prefix_length: 12,
      pending_sequence_suffix: sequence.slice(12), gems_preserved: 8,
      original_manifest_sha256: metadata.integrity.manifest_sha256, repaired_manifest_sha256: integrity.manifest_sha256,
      preserved_artifacts: originals, backup,
      before_state_bytes: (await stat(path.join(directory, "game-state.json"))).size,
      after_state_bytes: (await stat(path.join(staging, "game-state.json"))).size,
      conversation_retained: true, token_usage_retained: true, model_and_tools_retained: true
    };
    metadata.integrity = integrity; metadata.runtime_repairs = [...(metadata.runtime_repairs || []), repair];
    metadata.status = "paused"; metadata.error = null; metadata.completed_at = null;
    metadata.paused_at = repair.at; metadata.updated_at = repair.at;
    await writeFile(path.join(staging, "run.json"), encode(metadata), { mode: 0o600 });
    await supervisor.verifyRunCapabilityBoundary(metadata, staging);
    await assertInactive();
    for (const [file, hash] of Object.entries(originals)) assert.equal(digest(safeReadFile(directory, file, null)), hash);
    await mkdir(backup, { mode: 0o700 });
    for (const file of protectedFiles) {
      await mkdir(path.dirname(path.join(backup, file)), { recursive: true, mode: 0o700 });
      await copyFile(path.join(directory, file), path.join(backup, file));
    }
    await writeFile(path.join(backup, "repair.json"), encode(repair), { flag: "wx", mode: 0o600 });
    try {
      for (const file of [...artifacts, ...generated, "run.json"])
        await atomicCopy(path.join(staging, file), path.join(directory, file));
      await verifyRunIntegrity(root, directory, integrity); verifyCheckpoint(directory);
      await rm(path.join(directory, "integrity-violation.json"));
      await supervisor.verifyRunCapabilityBoundary(metadata, directory);
    } catch (error) {
      for (const file of ["integrity-violation.json", ...artifacts, "run.json"])
        await atomicCopy(path.join(backup, file), path.join(directory, file));
      for (const file of generated) await rm(path.join(directory, file), { force: true });
      throw error;
    }
    return { id: ID, status: metadata.status, action_count: 8183, room: "MxO", gems: 8, backup, state_bytes: repair.after_state_bytes };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], ID);
  const root = path.resolve(import.meta.dirname, ".."), records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records/mazebench-benchmark");
  console.log(JSON.stringify(await repairCheckpointSize(root, path.join(records, ID)), null, 2));
}
