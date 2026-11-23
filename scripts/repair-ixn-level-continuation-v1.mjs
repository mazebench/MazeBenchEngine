// Operator-only adoption of the user's latest IxN edit. The room is unvisited;
// preserve the signed gameplay checkpoint byte-for-byte and pin just this asset.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkSupervisor } from "../benchmarking/v1/supervisor.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { assertRunConfiguration, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { safeReadFile } from "../benchmarking/v1/safe-files.mjs";

const ID = "run-2026-09-04T19-29-31-992Z-772688";
const FILE = "level-data/v2/main-world/8ur7bs1t06.json";
const BEFORE = "b4e1261cf8de9d86cf82fb1a28de35e818b2991d667dc76a6f0e8a598b7485e2";
const AFTER = "1fbecc4bbf727bbc05943a4f5abc57a36f5acea9c90390a152a08804dd897777";
const MANIFEST = "997d264ccbe8b93c06bdea5d1d5a7048e33855ea01438969ac3b1e779f210b02";
const ERROR = `Benchmark runtime changed (${FILE}); start a new run.`;
const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const json = (root, file) => JSON.parse(safeReadFile(root, file));
async function cloneFile(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
}
async function atomicCopy(source, destination) {
  const temporary = `${destination}.${process.pid}.ixn-tmp`;
  try { await cloneFile(source, temporary); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
}

export async function repairIxnContinuation(root, directory) {
  const metadata = json(directory, "run.json"), manifest = json(directory, "integrity.json");
  assert.equal(metadata.id, ID); assert.equal(metadata.status, "failed");
  assert.equal(metadata.model, "gpt-6-astra"); assert.equal(metadata.tools_enabled, false);
  assert.equal(metadata.codex_thread_id, "01a06de5-cf11-7883-9f85-b1197dd668f5");
  assert.equal(metadata.error, `Run invalidated: ${ERROR}`);
  assert.deepEqual(json(directory, "integrity-violation.json"), { error: ERROR });
  assert.equal(metadata.integrity.manifest_sha256, MANIFEST);
  assert.equal(digest(safeReadFile(directory, "integrity.json")), MANIFEST);
  assertRunConfiguration(metadata, manifest); verifyCheckpoint(directory);
  assert.equal(manifest.files[FILE], BEFORE);
  const authored = safeReadFile(root, FILE, null);
  assert.equal(digest(authored), AFTER);
  const oldAuthored = execFileSync("git", ["show", `7a69708:${FILE}`], { cwd: root });
  assert.equal(digest(oldAuthored), BEFORE);
  const assertInactive = async () => {
    const response = await fetch(`http://localhost:8080/api/benchmark/v1/runs/${ID}`); assert(response.ok);
    const run = await response.json(); assert.equal(run.runner_active, false); assert.equal(run.status, "failed");
    assert.equal(run.action_count, 10913); assert.equal(run.gems_collected, 10);
  };
  await assertInactive();
  const protectedFiles = ["run.json", "integrity.json", "integrity-violation.json", "checkpoint.json", "summary.json", "prompt.md"];
  const originals = Object.fromEntries(protectedFiles.map(file => [file, digest(safeReadFile(directory, file, null))]));
  const staging = await mkdtemp(path.join(directory, ".ixn-update-"));
  const backup = path.join(directory, "repairs", "ixn-level-update-10913-v1");
  try {
    for (const file of ["game-state.json", "summary.json", "checkpoint.json", "prompt.md", "sandbox-state/integrity-key", "sandbox-state/direct-model-catalog.json"])
      await cloneFile(path.join(directory, file), path.join(staging, file));
    manifest.files[FILE] = AFTER;
    const encoded = encode(manifest), integrity = { ...metadata.integrity, manifest_sha256: digest(encoded) };
    await writeFile(path.join(staging, "integrity.json"), encoded, { mode: 0o600 });
    const supervisor = new BenchmarkSupervisor(root);
    await supervisor.verifyRunCapabilityBoundary({ ...metadata, integrity }, staging);
    const runtime = await BenchmarkGameRuntime.open(root, staging), state = runtime.internal;
    assert.equal(state.actionCount, 10913); assert.equal(state.roomFile, "9ryrneexsm.json");
    assert.equal(state.stateHashes.at(-1), "930ed0c297536c722e2fac7333693cda217cdb4bbc5a1af97da5ed7b51cdad9b");
    assert(!state.visitedRooms.includes(path.basename(FILE)));
    assert(!state.roomEntryStates[path.basename(FILE)]);
    assert(state.history.every(snapshot => snapshot.roomFile !== path.basename(FILE)));
    assert(state.actions.every(action => action.roomBefore !== "IxN" && action.roomAfter !== "IxN"));
    const repair = {
      at: new Date().toISOString(), kind: "operator-level-update", action_count: 10913,
      reason: "User acknowledged editing a level during the run and requested resume. Adopted the latest IxN authored asset; IxN has not been visited in the current retained run history.",
      files: { [FILE]: { before: BEFORE, after: AFTER } }, previous_error: metadata.error,
      original_manifest_sha256: MANIFEST, repaired_manifest_sha256: integrity.manifest_sha256,
      checkpoint_unchanged: true, state_hash: state.stateHashes.at(-1), gems_preserved: 10,
      conversation_retained: true, token_usage_retained: true, model_and_tools_retained: true,
      preserved_artifacts: originals, backup
    };
    metadata.integrity = integrity; metadata.runtime_repairs = [...(metadata.runtime_repairs || []), repair];
    metadata.status = "paused"; metadata.error = null; metadata.completed_at = null;
    metadata.paused_at = repair.at; metadata.updated_at = repair.at;
    await writeFile(path.join(staging, "run.json"), encode(metadata), { mode: 0o600 });
    await supervisor.verifyRunCapabilityBoundary(metadata, staging);
    await assertInactive(); verifyCheckpoint(directory);
    for (const [file, hash] of Object.entries(originals)) assert.equal(digest(safeReadFile(directory, file, null)), hash);
    await mkdir(backup, { mode: 0o700 });
    for (const file of protectedFiles) await cloneFile(path.join(directory, file), path.join(backup, file));
    await writeFile(path.join(backup, "authored.before.json"), oldAuthored, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(backup, "authored.after.json"), authored, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(backup, "repair.json"), encode(repair), { flag: "wx", mode: 0o600 });
    try {
      for (const file of ["integrity.json", "run.json"]) await atomicCopy(path.join(staging, file), path.join(directory, file));
      verifyCheckpoint(directory);
      assert.equal(digest(safeReadFile(directory, "checkpoint.json")), originals["checkpoint.json"]);
      await rm(path.join(directory, "integrity-violation.json"));
      await supervisor.verifyRunCapabilityBoundary(metadata, directory);
    } catch (error) {
      for (const file of ["integrity-violation.json", "integrity.json", "run.json"]) await atomicCopy(path.join(backup, file), path.join(directory, file));
      throw error;
    }
    return { id: ID, status: "paused", action_count: 10913, room: "IxM", gems: 10, updated_room: "IxN", checkpoint_unchanged: true, backup };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], ID);
  const root = path.resolve(import.meta.dirname, ".."), records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records/mazebench-benchmark");
  console.log(JSON.stringify(await repairIxnContinuation(root, path.join(records, ID)), null, 2));
}
