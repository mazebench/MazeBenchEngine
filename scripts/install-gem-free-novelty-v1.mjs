// Operator-only migration for the two audited MazeBench runs. Never exposed by
// HTTP or MCP. Preserve the authenticated gameplay checkpoint and change only
// novelty analytics plus the two explicitly pinned runtime assets.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, closeSync, readSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCheckpointJson } from "../benchmarking/v1/checkpoint-json.mjs";
import { assertRunConfiguration, verifyCheckpoint, verifyRunIntegrity } from "../benchmarking/v1/integrity.mjs";
import { safeOpenFile, safeReadFile } from "../benchmarking/v1/safe-files.mjs";
import { BenchmarkGameRuntime, loadBenchmarkAssets } from "../benchmarking/v1/runtime.mjs";
import { BenchmarkSupervisor } from "../benchmarking/v1/supervisor.mjs";
import { verifyClaudeIntegrity } from "../benchmarking/providers/claude-policy.mjs";
import { reconstructNovelty } from "./recalculate-gem-free-novelty-v1.mjs";

const RUNS = {
  "run-2026-09-04T19-29-31-992Z-772688": {
    actions: 10617, gems: 10, model: "gpt-6-astra", session: "01a06de5-cf11-7883-9f85-b1197dd668f5",
    manifest: "2b6f5ca8a9aaf5c9cd85326534be37edf36fc7ef3a385d23a2bb5e2228393965"
  },
  "run-2026-09-04T20-45-49-194Z-ff5fb0": {
    actions: 24219, gems: 2, model: "claude-fable-5-1", session: "9e0d401c-3460-4544-893f-ce79921e0476",
    manifest: "c2e0b815c358dc2a2f4cf9044ddb141f8352a81ee1e0136c1656852b710f8e34"
  }
};
const FILES = {
  "benchmarking/v1/runtime.mjs": {
    before: "d6f2c063e4369791c99e653ce0c461a1539f0c0e9f454aeaff20cfe2c321cf3c",
    after: "6675e5c39a3716893eeae9ce4bbcc05027897728a101abf7e894bd8fab795781"
  },
  "benchmarking/v1/novelty.mjs": {
    before: null, after: "0b3abc126bf4055f094ab3a9e9114b3ad19366595dd4f6f20bbb389676b1e08c"
  }
};
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const digest = value => createHash("sha256").update(value).digest("hex");
const json = (directory, file) => JSON.parse(safeReadFile(directory, file));
function fileHash(directory, file) {
  const fd = safeOpenFile(directory, file), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let count; while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { closeSync(fd); }
  return hash.digest("hex");
}
function withoutNovel({ novel, ...action }) { return action; }
function gameplayHash(state) {
  const hash = createHash("sha256");
  for (const key of Object.keys(state).sort()) {
    if (["noveltyVersion", "noveltyHashes"].includes(key)) continue;
    hash.update(`${key}\n`);
    if (Array.isArray(state[key])) {
      for (const value of state[key]) hash.update(`${JSON.stringify(key === "actions" ? withoutNovel(value) : value)}\n`);
    } else hash.update(`${JSON.stringify(state[key])}\n`);
  }
  return hash.digest("hex");
}
function summaryGameplay({ novelty, novelty_rate, novelty_version, actions, ...summary }) {
  return { ...summary, actions: actions.map(withoutNovel) };
}
function observationGameplay({ novel_state, recent_actions, ...observation }) {
  return { ...observation, recent_actions: recent_actions.map(withoutNovel) };
}
async function cloneFile(source, destination) {
  // APFS clones are independent regular files, not hardlinks, and avoid making
  // several physical copies of the large historical checkpoint.
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
}
async function atomicCopy(source, destination) {
  const temporary = `${destination}.${process.pid}.novelty-tmp`;
  try { await cloneFile(source, temporary); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
}

export async function installGemFreeNovelty(root, directory) {
  const metadata = json(directory, "run.json"), expected = RUNS[metadata.id];
  assert(expected, "This installer accepts only the two explicitly audited runs.");
  assert.equal(metadata.status, "paused");
  assert.equal(metadata.model, expected.model);
  assert.equal(metadata.tools_enabled, false);
  assert.equal(metadata.claude_session_id || metadata.codex_thread_id, expected.session);
  assert.equal(metadata.integrity.manifest_sha256, expected.manifest);
  assert.equal(fileHash(directory, "integrity.json"), expected.manifest);
  await assert.rejects(() => stat(path.join(directory, "integrity-violation.json")), { code: "ENOENT" });
  verifyCheckpoint(directory);
  const manifest = json(directory, "integrity.json");
  assertRunConfiguration(metadata, manifest);
  for (const [file, hashes] of Object.entries(FILES)) {
    assert.equal(manifest.files[file] ?? null, hashes.before, `Unexpected original asset: ${file}`);
    assert.equal(fileHash(root, file), hashes.after, `Unexpected replacement asset: ${file}`);
    manifest.files[file] = hashes.after;
  }
  manifest.files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const encodedManifest = encode(manifest);
  const integrity = { ...metadata.integrity, manifest_sha256: digest(encodedManifest), asset_count: Object.keys(manifest.files).length };
  const assertInactive = async () => {
    const response = await fetch(`http://localhost:8080/api/benchmark/v1/runs/${metadata.id}`);
    assert(response.ok); const live = await response.json();
    assert.equal(live.runner_active, false); assert.equal(live.status, "paused");
    assert.equal(live.action_count, expected.actions); assert.equal(live.gems_collected, expected.gems);
  };
  const verifyBoundary = async (where, run) => {
    if (run.provider === "claude-code") await verifyClaudeIntegrity(root, where, run);
    else await new BenchmarkSupervisor(root).verifyRunCapabilityBoundary(run, where);
  };
  await assertInactive();
  const artifacts = ["game-state.json", "summary.json", "display.json", "integrity.json", "records/current_board.txt",
    "records/current_state.json", "records/moves.txt", "records/history.jsonl", "run.json", "checkpoint.json"];
  const protectedFiles = [...artifacts, "prompt.md", "agent-events.jsonl", "tool-activity.jsonl",
    ...(metadata.provider === "claude-code" ? ["claude-events.jsonl"] : [metadata.capability_policy.model_catalog.file])];
  const originals = Object.fromEntries(protectedFiles.map(file => [file, fileHash(directory, file)]));
  const staging = await mkdtemp(path.join(directory, ".novelty-migration-"));
  const backup = path.join(directory, "repairs", "gem-free-novelty-v1");
  try {
    await mkdir(path.join(staging, "records"), { mode: 0o700 });
    for (const file of ["game-state.json", "summary.json", "checkpoint.json", "prompt.md", "sandbox-state/integrity-key",
      ...(metadata.provider === "claude-code" ? [] : [metadata.capability_policy.model_catalog.file])])
      await cloneFile(path.join(directory, file), path.join(staging, file));
    await writeFile(path.join(staging, "integrity.json"), encodedManifest, { mode: 0o600 });
    // The original signed checkpoint and every unmodified capability asset must
    // pass the existing production verifier before any analytics are rewritten.
    await verifyBoundary(staging, { ...metadata, integrity });
    const assets = await loadBenchmarkAssets(root), state = await readCheckpointJson(staging);
    assert.equal(state.actionCount, expected.actions); assert.equal(state.gemsCollected.length, expected.gems);
    assert.equal(state.noveltyVersion, undefined);
    const preservedGameplay = gameplayHash(state);
    const recalculated = await reconstructNovelty(state, assets);
    state.noveltyVersion = recalculated.noveltyVersion;
    state.noveltyHashes = recalculated.noveltyHashes;
    state.actions.forEach((action, index) => { action.novel = recalculated.flags[index]; });
    assert.equal(gameplayHash(state), preservedGameplay);
    const runtime = new BenchmarkGameRuntime(root, staging, assets, state);
    assert.deepEqual(summaryGameplay(runtime.summary()), summaryGameplay(json(directory, "summary.json")));
    await runtime.persist();
    const reopened = await BenchmarkGameRuntime.open(root, staging);
    assert.equal(gameplayHash(reopened.internal), preservedGameplay);
    assert.deepEqual(reopened.internal.noveltyHashes, recalculated.noveltyHashes);
    assert.deepEqual(reopened.internal.actions.map(a => a.novel), recalculated.flags);
    assert.deepEqual(json(staging, "display.json"), json(directory, "display.json"));
    assert.deepEqual(observationGameplay(json(staging, "records/current_state.json")), observationGameplay(json(directory, "records/current_state.json")));
    for (const file of ["records/current_board.txt", "records/moves.txt"])
      assert.equal(fileHash(staging, file), originals[file]);
    const history = where => safeReadFile(where, "records/history.jsonl").trim().split("\n").map(line => withoutNovel(JSON.parse(line)));
    assert.deepEqual(history(staging), history(directory));
    const repair = {
      at: new Date().toISOString(), kind: "operator-novelty-recalculation", novelty_version: recalculated.noveltyVersion,
      reason: "User requested excluding gem objects and global gem progress from novelty, including all historical actions.",
      ...recalculated.report, old_checkpoint_authenticated: true, preserved_gameplay_sha256: preservedGameplay,
      original_manifest_sha256: expected.manifest, repaired_manifest_sha256: integrity.manifest_sha256,
      files: FILES, preserved_artifacts: originals, backup,
      original_full_state_hashes_retained: true, conversation_retained: true, token_usage_retained: true,
      model_and_tools_retained: true, status_retained: true
    };
    metadata.integrity = integrity;
    metadata.runtime_repairs = [...(metadata.runtime_repairs || []), repair];
    await writeFile(path.join(staging, "run.json"), encode(metadata), { mode: 0o600 });
    await verifyBoundary(staging, metadata);
    await assertInactive();
    for (const [file, hash] of Object.entries(originals)) assert.equal(fileHash(directory, file), hash);
    await mkdir(backup, { mode: 0o700 });
    for (const file of protectedFiles) await cloneFile(path.join(directory, file), path.join(backup, file));
    await writeFile(path.join(backup, "repair.json"), encode(repair), { flag: "wx", mode: 0o600 });
    try {
      // Publish the new signature last, retaining normal fail-closed behavior.
      for (const file of artifacts) await atomicCopy(path.join(staging, file), path.join(directory, file));
      await verifyRunIntegrity(root, directory, integrity);
      await verifyBoundary(directory, metadata);
    } catch (error) {
      for (const file of artifacts) await atomicCopy(path.join(backup, file), path.join(directory, file));
      verifyCheckpoint(directory);
      throw error;
    }
    return { id: metadata.id, ...recalculated.report, changed_actions: recalculated.report.changed_actions.length, backup };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.argv[2]; assert(RUNS[id], "Pass an explicitly audited run ID.");
  const root = path.resolve(import.meta.dirname, ".."), records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records/mazebench-benchmark");
  console.log(JSON.stringify(await installGemFreeNovelty(root, path.join(records, id)), null, 2));
}
