// Operator-only migration for the explicitly requested Fable resume. This
// admits only the reviewed orange-engine update and never rewrites gameplay.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRunConfiguration, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { safeReadFile } from "../benchmarking/v1/safe-files.mjs";
import { claudeBoundaryViolation, digest, verifyClaudeIntegrity } from "../benchmarking/providers/claude-policy.mjs";

export const FABLE_ORANGE_RUN = "run-2026-09-04T20-45-49-194Z-ff5fb0";
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
async function atomic(file, bytes) {
  const temporary = `${file}.${process.pid}.repair-tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

export async function repairFableOrangeRuntime(root, directory) {
  const originalRun = safeReadFile(directory, "run.json");
  const originalManifest = safeReadFile(directory, "integrity.json");
  const metadata = JSON.parse(originalRun), manifest = JSON.parse(originalManifest);
  assert.equal(metadata.id, FABLE_ORANGE_RUN);
  assert.equal(metadata.status, "failed");
  assert.equal(metadata.error, "You've hit your session limit · resets 7pm (America/Boise)");
  assert.equal(metadata.provider, "claude-code");
  assert.equal(metadata.model, "claude-fable-5-1");
  assert.equal(metadata.tools_enabled, false);
  assert.equal(metadata.claude_session_id, "9e0d401c-3460-4544-893f-ce79921e0476");
  assert(!existsSync(path.join(directory, "integrity-violation.json")));
  assert.equal(digest(originalManifest), metadata.integrity.manifest_sha256);
  assertRunConfiguration(metadata, manifest);
  verifyCheckpoint(directory);
  const state = JSON.parse(safeReadFile(directory, "game-state.json"));
  assert.equal(state.actionCount, 1211);
  assert.equal(state.gemsCollected.length, 2);
  assert.equal(state.stateHashes.at(-1), "b10e53fe55893045f4285c80f4a3c2f7f2cda1a1631097a6e14da643c37b5b1e");
  assert(!state.state.objects.some(object => ["orange-wall", "orange-button"].includes(object.blockId)));
  const events = safeReadFile(directory, "claude-events.jsonl").trim().split(/\r?\n/).map(JSON.parse);
  for (const event of events) assert.equal(claudeBoundaryViolation(event, { model: metadata.model, toolsEnabled: false }), null);
  const changes = JSON.parse(await readFile(new URL("./orange-wall-repair-assets-v1.json", import.meta.url)));
  assert.equal(JSON.parse(safeReadFile(root, "engine/v1/upstream.json")).sourceCommit, changes.source_commit);
  for (const [file, hashes] of Object.entries(changes.files)) {
    assert.equal(manifest.files[file], hashes.before, `Unexpected original asset ${file}.`);
    assert.equal(digest(safeReadFile(root, file, null)), hashes.after, `Unexpected replacement asset ${file}.`);
    manifest.files[file] = hashes.after;
  }
  const preservedFiles = ["game-state.json", "summary.json", "checkpoint.json", "prompt.md", "claude-events.jsonl", "agent-events.jsonl", "records/moves.txt", "records/history.jsonl"];
  const preserved = Object.fromEntries(preservedFiles.map(file => [file, digest(safeReadFile(directory, file, null))]));
  const encodedManifest = encode(manifest);
  const integrity = { ...metadata.integrity, manifest_sha256: digest(encodedManifest) };
  const staging = await mkdtemp(path.join(os.tmpdir(), "fable-orange-runtime-"));
  try {
    await mkdir(path.join(staging, "sandbox-state"), { mode: 0o700 });
    for (const file of ["game-state.json", "summary.json", "checkpoint.json", "prompt.md", "sandbox-state/integrity-key"])
      await copyFile(path.join(directory, file), path.join(staging, file));
    await writeFile(path.join(staging, "integrity.json"), encodedManifest, { mode: 0o600 });
    // Includes every frozen asset plus the unchanged Claude executable,
    // provider runtime, model/tool configuration, prompt, and signed state.
    await verifyClaudeIntegrity(root, staging, { ...metadata, integrity });
  } finally { await rm(staging, { recursive: true, force: true }); }
  const response = await fetch(`http://localhost:8080/api/benchmark/v1/runs/${metadata.id}`);
  assert(response.ok);
  const live = await response.json();
  assert.equal(live.runner_active, false); assert.equal(live.status, "failed"); assert.equal(live.action_count, 1211);
  assert.equal(safeReadFile(directory, "run.json"), originalRun);
  assert.equal(safeReadFile(directory, "integrity.json"), originalManifest);
  for (const [file, hash] of Object.entries(preserved)) assert.equal(digest(safeReadFile(directory, file, null)), hash);
  const repair = {
    at: new Date().toISOString(), kind: "operator-engine-migration", action_count: 1211,
    reason: "User requested resuming Fable after its Claude session limit. Admit the reviewed orange-wall anchor and room-control fix for subsequent commands; existing gameplay is preserved byte-for-byte.",
    files: changes.files, source_commit: changes.source_commit, previous_error: metadata.error,
    original_manifest_sha256: metadata.integrity.manifest_sha256, repaired_manifest_sha256: integrity.manifest_sha256,
    claude_session_id: metadata.claude_session_id, events_audited: events.length, preserved_artifacts: preserved,
    state_note: "The current room has no orange mechanisms. Earlier moves retain their original physics version; no rollback or board edit was performed."
  };
  const backup = path.join(directory, "repairs", "orange-engine-resume-v1");
  await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
  await mkdir(backup, { mode: 0o700 });
  for (const [file, bytes] of [["run.before.json", originalRun], ["integrity.before.json", originalManifest], ["repair.json", encode(repair)]])
    await writeFile(path.join(backup, file), bytes, { flag: "wx", mode: 0o600 });
  metadata.integrity = integrity;
  metadata.runtime_repairs = [...(metadata.runtime_repairs || []), repair];
  // Resume remains a separate normal API action, which clears the quota error.
  try {
    await atomic(path.join(directory, "integrity.json"), encodedManifest);
    await atomic(path.join(directory, "run.json"), encode(metadata));
    await verifyClaudeIntegrity(root, directory, metadata);
    for (const [file, hash] of Object.entries(preserved)) assert.equal(digest(safeReadFile(directory, file, null)), hash);
  } catch (error) {
    await atomic(path.join(directory, "integrity.json"), originalManifest);
    await atomic(path.join(directory, "run.json"), originalRun);
    throw error;
  }
  return { id: metadata.id, action_count: 1211, gems: 2, backup, events_audited: events.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], FABLE_ORANGE_RUN);
  const root = path.resolve(import.meta.dirname, "..");
  const records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records/mazebench-benchmark");
  console.log(JSON.stringify(await repairFableOrangeRuntime(root, path.join(records, FABLE_ORANGE_RUN)), null, 2));
}
