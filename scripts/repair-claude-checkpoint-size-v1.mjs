// Operator-only recovery of the observed 512-MB save failure. Never exposed by
// HTTP or MCP. Authenticate the old board, reproduce the already-requested move,
// and require its result to match the interrupted save before installing it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { verifyClaudeIntegrity, createClaudeBoundaryValidator } from "../benchmarking/providers/claude-policy.mjs";
import { CHECKPOINT_SIZE_FILES as files } from "./repair-checkpoint-size-v1.mjs";
import { assertRunConfiguration, verifyCheckpoint, verifyRunIntegrity } from "../benchmarking/v1/integrity.mjs";
import { safeReadFile } from "../benchmarking/v1/safe-files.mjs";

const ID = "run-2026-09-04T20-45-49-194Z-ff5fb0";
const ERROR = "Benchmark state or score was modified outside the engine; refusing execution.";
const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const json = (directory, relative) => JSON.parse(safeReadFile(directory, relative));
async function atomicCopy(source, destination) {
  const temporary = `${destination}.${process.pid}.repair-tmp`;
  await copyFile(source, temporary);
  await rename(temporary, destination);
}

export async function repairClaudeCheckpointSize(root, directory) {
  const originalRun = safeReadFile(directory, "run.json"), originalManifest = safeReadFile(directory, "integrity.json");
  const metadata = JSON.parse(originalRun), manifest = JSON.parse(originalManifest);
  assert.equal(metadata.id, ID); assert.equal(metadata.status, "failed");
  assert.equal(metadata.error, "Run invalidated by an integrity violation.");
  assert.equal(metadata.provider, "claude-code");
  assert.deepEqual(json(directory, "integrity-violation.json"), { error: ERROR });
  assert.equal(metadata.model, "claude-fable-5-1"); assert.equal(metadata.tools_enabled, false);
  assert.equal(metadata.claude_session_id, "9e0d401c-3460-4544-893f-ce79921e0476");
  assert.equal(digest(originalManifest), metadata.integrity.manifest_sha256);
  assertRunConfiguration(metadata, manifest);
  for (const [file, hashes] of Object.entries(files)) {
    assert.equal(manifest.files[file] ?? null, hashes.before, `Unexpected old asset ${file}.`);
    assert.equal(digest(safeReadFile(root, file, null)), hashes.after, `Unexpected replacement asset ${file}.`);
    manifest.files[file] = hashes.after;
  }
  manifest.files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const encodedManifest = encode(manifest), integrity = { ...metadata.integrity, manifest_sha256: digest(encodedManifest), asset_count: Object.keys(manifest.files).length };
  const assertInactive = async () => {
    const response = await fetch(`http://localhost:8080/api/benchmark/v1/runs/${ID}`);
    assert(response.ok); const live = await response.json();
    assert.equal(live.runner_active, false); assert.equal(live.status, "failed"); assert.equal(live.action_count, 8441);
  };
  await assertInactive();
  const activity = safeReadFile(directory, "tool-activity.jsonl").trim().split(/\r?\n/).map(JSON.parse);
  const failed = activity.at(-1);
  assert.equal(failed.id, "20550cb0-f998-45b0-a5c0-c827726e5238");
  assert.equal(failed.tool, "maze_sequence"); assert.equal(failed.status, "failed");
  assert.equal(failed.actions.length, 215); assert.equal(failed.error, "Invalid string length");
  assert.equal(failed.action_count_before, 8254); assert.equal(failed.action_count_after, 8441);
  const events = safeReadFile(directory, "claude-events.jsonl").trim().split(/\r?\n/).map(JSON.parse);
  const validate = createClaudeBoundaryValidator({ model: metadata.model, toolsEnabled: false });
  for (const [index, event] of events.entries()) assert.equal(validate(event), null, `Capability violation at event ${index}.`);
  const requested = events.findLast(event => event.type === "assistant" && event.message?.content?.some(block => block.type === "tool_use" && block.name === "mcp__mazebench__maze_sequence"));
  assert.equal(requested.session_id, metadata.claude_session_id);
  const call = requested.message.content.find(block => block.type === "tool_use");
  assert.equal(call.id, "toolu_01CGPW3njaZ5gVNWibT5aLnh");
  assert.deepEqual(call.input, { actions: failed.actions });
  const observedError = events.findLast(event => event.type === "user" && event.message?.content?.some(block => block.type === "tool_result" && block.tool_use_id === call.id));
  assert(observedError.message.content.some(block => block.is_error && /Invalid string length/.test(JSON.stringify(block.content))));
  const incompleteSummary = json(directory, "summary.json");
  const expectedAction = incompleteSummary.actions.at(-1);
  assert.equal(expectedAction.index, 8441); assert.equal(expectedAction.action, "left");
  assert.equal(expectedAction.stateHash, "9e6eec5a407872486f5a49b58ccc4196de3cc12c06b00e337db0387a608491f6");

  const artifacts = ["game-state.json", "summary.json", "checkpoint.json", "display.json", "integrity.json",
    "records/current_board.txt", "records/current_state.json", "records/moves.txt", "records/history.jsonl"];
  const generated = ["records/move_history/move_8441.txt", "display-history/move_8441.json"];
  const protectedFiles = ["run.json", "integrity-violation.json", "prompt.md", "agent-events.jsonl", "claude-events.jsonl", "tool-activity.jsonl", ...artifacts];
  const originals = Object.fromEntries(protectedFiles.map(file => [file, digest(safeReadFile(directory, file, null))]));
  for (const file of generated) await assert.rejects(() => stat(path.join(directory, file)), { code: "ENOENT" });
  const staging = await mkdtemp(path.join(os.tmpdir(), "maze-checkpoint-size-repair-"));
  const backup = path.join(directory, "repairs", "checkpoint-size-8441-v1");
  try {
    for (const folder of ["sandbox-state", "records/move_history", "display-history"])
      await mkdir(path.join(staging, folder), { recursive: true, mode: 0o700 });
    for (const file of ["game-state.json", "checkpoint.json", "prompt.md", "sandbox-state/integrity-key"])
      await copyFile(path.join(directory, file), path.join(staging, file));
    const runtime = await BenchmarkGameRuntime.open(root, staging);
    assert.equal(runtime.internal.actionCount, 8440); assert.equal(runtime.internal.history.length, 6935);
    assert.equal(runtime.internal.gemsCollected.length, 2);
    assert.equal(runtime.internal.stateHashes.at(-1), "db59af726cf3ed9093a02a4f34bfef4abdc63dba1565806e3474743094f84164");
    assert.deepEqual(runtime.summary().actions, incompleteSummary.actions.slice(0, 8440));
    const sequence = failed.actions;
    assert.deepEqual(runtime.internal.actions.slice(8254).map(action => action.action), sequence.slice(0, 186));
    assert.equal(sequence[186], expectedAction.action);
    // This MUST match the pre-failure signature. We are not re-signing an
    // unverified board: only the overwritten summary is reconstructed here.
    await writeFile(path.join(staging, "summary.json"), encode(runtime.summary()));
    verifyCheckpoint(staging);
    await writeFile(path.join(staging, "integrity.json"), encodedManifest, { mode: 0o600 });
    await verifyRunIntegrity(root, staging, integrity);
    await verifyClaudeIntegrity(root, staging, { ...metadata, integrity });
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
      at: new Date().toISOString(), kind: "operator-checkpoint-recovery", action_count: 8441,
      last_authenticated_action: 8440, reason: "User requested resume. Streaming checkpoint storage fixes V8's 512-MB JSON string limit. Recovered the one interrupted, agent-requested left move by exact engine replay from the previously authenticated board.",
      previous_error: metadata.error, files, old_checkpoint_authenticated: true,
      old_state_hash: runtime.internal.stateHashes[8440], recovered_state_hash: expectedAction.stateHash,
      interrupted_tool_id: failed.id, interrupted_sequence: failed.actions, recovered_sequence_prefix_length: 187,
      pending_sequence_suffix: sequence.slice(187), gems_preserved: 2,
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
    await verifyClaudeIntegrity(root, staging, metadata);
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
      await verifyClaudeIntegrity(root, directory, metadata);
    } catch (error) {
      for (const file of ["integrity-violation.json", ...artifacts, "run.json"])
        await atomicCopy(path.join(backup, file), path.join(directory, file));
      for (const file of generated) await rm(path.join(directory, file), { force: true });
      throw error;
    }
    return { id: ID, status: metadata.status, action_count: 8441, room: "HxH", gems: 2, backup, state_bytes: repair.after_state_bytes };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], ID);
  const root = path.resolve(import.meta.dirname, ".."), records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records/mazebench-benchmark");
  console.log(JSON.stringify(await repairClaudeCheckpointSize(root, path.join(records, ID)), null, 2));
}
