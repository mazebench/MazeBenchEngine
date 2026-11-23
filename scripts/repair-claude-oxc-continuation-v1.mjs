// Operator-only recovery of the known user-authored OxC floor edit and the
// audited continuation-prompt change. No state, score, prompt or transcript is
// rewritten, and unrelated integrity violations remain non-recoverable.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCheckpoint, assertRunConfiguration } from "../benchmarking/v1/integrity.mjs";
import { safeReadFile } from "../benchmarking/v1/safe-files.mjs";
import { claudeBoundaryViolation, verifyClaudeIntegrity } from "../benchmarking/providers/claude-policy.mjs";

export const CLAUDE_RECOVERY = Object.freeze({
  id: "run-2026-09-04T20-45-49-194Z-ff5fb0",
  asset: "level-data/v2/main-world/neyecnf3gf.json",
  assetBefore: "135184d0e7fc85eeb38fe7db26b222647f24bfa9e20f45eca661bba5b048b4cc",
  assetAfter: "7ee38c4858aa9c9a3ca31bb6a1e717420ddedfa2a39d8275fc04a69af9e5b566",
  provider: "benchmarking/providers/supervisor.mjs",
  providerBefore: "44c9e83816fd86f6cecff61b513842e5619260b060bf5f3aa6d42f74ce57bffd",
  providerAfter: "ca4443dfd2439be54252637138617016e5e7306cf3df7369821635af063fadfa"
});
const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
async function atomic(file, value) {
  const temporary = `${file}.${process.pid}.repair-tmp`;
  await writeFile(temporary, value, { flag: "wx", mode: 0o600 }); await rename(temporary, file);
}

export async function repairClaudeOxcRun(root, directory) {
  const originalRun = safeReadFile(directory, "run.json"), originalManifest = safeReadFile(directory, "integrity.json"), originalViolation = safeReadFile(directory, "integrity-violation.json");
  const metadata = JSON.parse(originalRun), manifest = JSON.parse(originalManifest);
  assert.equal(metadata.id, CLAUDE_RECOVERY.id);
  assert.equal(metadata.provider, "claude-code"); assert.equal(metadata.model, "claude-fable-5-1");
  assert.equal(metadata.tools_enabled, false); assert.equal(metadata.status, "failed");
  assert.equal(metadata.error, "Run invalidated by an integrity violation.");
  assert.deepEqual(JSON.parse(originalViolation), { error: `Benchmark runtime changed (${CLAUDE_RECOVERY.asset}); start a new run.` }, "Only the known authored-level violation may be cleared.");
  assert.equal(digest(originalManifest), metadata.integrity.manifest_sha256);
  assertRunConfiguration(metadata, manifest); verifyCheckpoint(directory);
  const state = JSON.parse(safeReadFile(directory, "game-state.json"));
  assert.equal(state.actionCount, 1191); assert.equal(state.gemsCollected.length, 2);
  assert.equal(state.stateHashes.at(-1), "71671bc1eba5389a10985b8abfd81fbe47cb558b7de1666c827dfd9a526463cf");
  assert(!state.visitedRooms.includes(path.basename(CLAUDE_RECOVERY.asset)), "Visited corrected rooms require a separate checkpoint repair.");
  const events = safeReadFile(directory, "claude-events.jsonl").trim().split(/\r?\n/).map(JSON.parse);
  for (const event of events) assert.equal(claudeBoundaryViolation(event, { model: metadata.model, toolsEnabled: metadata.tools_enabled }), null, "An actual capability violation cannot be cleared.");
  assert.equal(manifest.files[CLAUDE_RECOVERY.asset], CLAUDE_RECOVERY.assetBefore);
  assert.equal(digest(safeReadFile(root, CLAUDE_RECOVERY.asset, null)), CLAUDE_RECOVERY.assetAfter);
  assert.equal(manifest.configuration.provider_runtime[CLAUDE_RECOVERY.provider], CLAUDE_RECOVERY.providerBefore);
  assert.equal(digest(safeReadFile(root, CLAUDE_RECOVERY.provider, null)), CLAUDE_RECOVERY.providerAfter);
  manifest.files[CLAUDE_RECOVERY.asset] = CLAUDE_RECOVERY.assetAfter;
  manifest.configuration.provider_runtime[CLAUDE_RECOVERY.provider] = CLAUDE_RECOVERY.providerAfter;
  const encoded = encode(manifest), integrity = { ...metadata.integrity, manifest_sha256: digest(encoded) };
  const preservedFiles = ["game-state.json", "summary.json", "checkpoint.json", "prompt.md", "claude-events.jsonl", "agent-events.jsonl", "records/moves.txt", "records/history.jsonl"];
  const preserved = Object.fromEntries(preservedFiles.map(file => [file, digest(safeReadFile(directory, file, null))]));
  const staging = await mkdtemp(path.join(os.tmpdir(), "claude-oxc-recovery-"));
  try {
    await mkdir(path.join(staging, "sandbox-state"), { mode: 0o700 });
    for (const file of ["game-state.json", "summary.json", "checkpoint.json", "prompt.md", "sandbox-state/integrity-key"]) await copyFile(path.join(directory, file), path.join(staging, file));
    await writeFile(path.join(staging, "integrity.json"), encoded, { mode: 0o600 });
    await verifyClaudeIntegrity(root, staging, { ...metadata, integrity });
  } finally { await rm(staging, { recursive: true, force: true }); }
  const live = await (await fetch(`http://localhost:8080/api/benchmark/v1/runs/${metadata.id}`)).json();
  assert.equal(live.runner_active, false); assert.equal(live.status, "failed"); assert.equal(live.action_count, 1191);
  assert.equal(safeReadFile(directory, "run.json"), originalRun);
  assert.equal(safeReadFile(directory, "integrity.json"), originalManifest);
  assert.equal(safeReadFile(directory, "integrity-violation.json"), originalViolation);
  for (const [file, hash] of Object.entries(preserved)) assert.equal(digest(safeReadFile(directory, file, null)), hash);
  const repair = {
    at: new Date().toISOString(), kind: "operator-authorized-recovery", action_count: 1191,
    reason: "User requested recovery after the OxC floor edit and required continued gameplay even if Claude believes the world is impossible.",
    files: { [CLAUDE_RECOVERY.asset]: { before: CLAUDE_RECOVERY.assetBefore, after: CLAUDE_RECOVERY.assetAfter },
      [CLAUDE_RECOVERY.provider]: { before: CLAUDE_RECOVERY.providerBefore, after: CLAUDE_RECOVERY.providerAfter } },
    previous_error: metadata.error, archived_violation: JSON.parse(originalViolation), claude_session_id: metadata.claude_session_id,
    original_manifest_sha256: metadata.integrity.manifest_sha256, repaired_manifest_sha256: integrity.manifest_sha256,
    events_audited: events.length, preserved_artifacts: preserved,
    level_note: "The run spans two authored world revisions. OxC has not been visited, so no accepted moves or board states were replaced."
  };
  const backup = path.join(directory, "repairs", "oxc-continue-v1");
  await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 }); await mkdir(backup, { mode: 0o700 });
  for (const [file, bytes] of [["run.before.json", originalRun], ["integrity.before.json", originalManifest], ["integrity-violation.before.json", originalViolation], ["repair.json", encode(repair)]]) await writeFile(path.join(backup, file), bytes, { flag: "wx", mode: 0o600 });
  metadata.integrity = integrity; metadata.runtime_repairs = [...(metadata.runtime_repairs || []), repair];
  metadata.status = "paused"; metadata.error = null; metadata.completed_at = null; metadata.updated_at = repair.at; metadata.paused_at = repair.at;
  try {
    await atomic(path.join(directory, "integrity.json"), encoded);
    await atomic(path.join(directory, "run.json"), encode(metadata));
    await verifyClaudeIntegrity(root, directory, metadata);
    for (const [file, hash] of Object.entries(preserved)) assert.equal(digest(safeReadFile(directory, file, null)), hash);
    // Keep the invalidation marker in place until the entire corrected boundary
    // has passed. The original marker remains in the private audit directory.
    await rm(path.join(directory, "integrity-violation.json"));
  } catch (error) {
    await atomic(path.join(directory, "integrity-violation.json"), originalViolation);
    await atomic(path.join(directory, "integrity.json"), originalManifest);
    await atomic(path.join(directory, "run.json"), originalRun);
    throw error;
  }
  return { id: metadata.id, status: metadata.status, action_count: 1191, backup, claude_session_id: metadata.claude_session_id };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], CLAUDE_RECOVERY.id);
  const root = path.resolve(import.meta.dirname, ".."), records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records/mazebench-benchmark");
  console.log(JSON.stringify(await repairClaudeOxcRun(root, path.join(records, CLAUDE_RECOVERY.id)), null, 2));
}
