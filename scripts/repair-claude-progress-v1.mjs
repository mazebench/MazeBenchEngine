// Operator-only recovery of the observed root-tool heartbeat false positive.
// No accepted actions, score, conversation, model, or tools are changed.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRunConfiguration, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { safeReadFile } from "../benchmarking/v1/safe-files.mjs";
import { createClaudeBoundaryValidator, digest, verifyClaudeIntegrity } from "../benchmarking/providers/claude-policy.mjs";

export const FABLE_PROGRESS_RUN = "run-2026-09-04T20-45-49-194Z-ff5fb0";
const files = {
  "level-data/v2/main-world/d1ziy6u45c.json": {
    before: "5691f79fd7f8e1b15c993a16ba075b19e45ec2f44ae5d90de7d90bac9ea605d2",
    after: "b09bb97b673dbfe6f009bc7bad0304b184ec25fa1606f1715c6f8324f4d7182c"
  },
  "render-ascii/v1/ascii-scene.mjs": {
    before: "3020ec09c7f4c02200e2e265fcbc9b253bf6976a5c4d8ce34c23696b2c98acfa",
    after: "76fbd04ef59ea6e4c3ec5aa33fa3777ab2f085709b5a905453c020862dc34a3c"
  }
};
const providerFiles = {
  "benchmarking/providers/claude-policy.mjs": {
    before: "2a3a1dfc1ae05a2eeab6e1f2c37a3d393b5eb093ca8feb36732c273373650a97",
    after: "7e3c4381562ea80dffa9903021a522ea9e2afe4143e0ea92b4e12b218be037c7"
  },
  "benchmarking/providers/claude-runner.mjs": {
    before: "aff64a52ec845db51d1a6003d9eef53325a4c8e691c0b22032dcb2fbe8b95e2c",
    after: "34f0628fde1462f55109f1caf3d88307c33d71cbb417e261e3e33ddbaed12060"
  }
};
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
async function atomic(file, bytes) {
  const temporary = `${file}.${process.pid}.repair-tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

export async function repairClaudeProgress(root, directory) {
  const originalRun = safeReadFile(directory, "run.json"), originalManifest = safeReadFile(directory, "integrity.json");
  const originalViolation = safeReadFile(directory, "integrity-violation.json");
  const metadata = JSON.parse(originalRun), manifest = JSON.parse(originalManifest);
  assert.equal(metadata.id, FABLE_PROGRESS_RUN); assert.equal(metadata.status, "failed");
  assert.equal(metadata.provider, "claude-code"); assert.equal(metadata.model, "claude-fable-5-1");
  assert.equal(metadata.tools_enabled, false);
  assert.equal(metadata.claude_session_id, "9e0d401c-3460-4544-893f-ce79921e0476");
  assert.equal(metadata.error, "Claude attempted a delegated agent response.");
  assert.deepEqual(JSON.parse(originalViolation), { error: metadata.error, at: "2026-09-05T05:11:12.834Z" });
  assert.equal(digest(originalManifest), metadata.integrity.manifest_sha256);
  assertRunConfiguration(metadata, manifest); verifyCheckpoint(directory);
  const state = JSON.parse(safeReadFile(directory, "game-state.json"));
  assert.equal(state.actionCount, 1603); assert.equal(state.gemsCollected.length, 2);
  assert.equal(state.stateHashes.at(-1), "fd7200e77a6c912314dce6ccb64f59ea74e8b3922b8c15882e44ce3b7bbd05f9");
  assert(!state.visitedRooms.includes("d1ziy6u45c.json"));
  const events = safeReadFile(directory, "claude-events.jsonl").trim().split(/\r?\n/).map(JSON.parse);
  const last = events.at(-1);
  assert.equal(events.length, 19646);
  assert.equal(last.type, "tool_progress"); assert.equal(last.heartbeat, true);
  assert.equal(last.tool_name, "mcp__mazebench__maze_sequence");
  assert.equal(last.parent_tool_use_id, "toolu_01DKGGKe1ZGgx8C5Nf1dD3MC");
  assert.equal(last._received_at, JSON.parse(originalViolation).at);
  // Reconstruct validated, still-pending root calls across the complete raw
  // history; a similarly shaped delegated response cannot pass this audit.
  const validate = createClaudeBoundaryValidator({ model: metadata.model, toolsEnabled: false });
  for (const [index, event] of events.entries()) assert.equal(validate(event), null, `Actual capability violation at event ${index}.`);
  const toolActivity = safeReadFile(directory, "tool-activity.jsonl").trim().split(/\r?\n/).map(JSON.parse);
  const completed = toolActivity.at(-1);
  assert.equal(completed.tool, "maze_sequence"); assert.equal(completed.status, "completed");
  assert.equal(completed.action_count_before, 1525); assert.equal(completed.action_count_after, 1603);
  const requested = events.findLast(event => event.type === "assistant" && event.message?.content?.some(block => block.id === last.parent_tool_use_id));
  const call = requested.message.content.find(block => block.id === last.parent_tool_use_id);
  assert.deepEqual(call.input.actions, completed.actions);
  assert.deepEqual(state.actions.slice(1525).map(action => action.action), completed.actions);
  for (const [file, hashes] of Object.entries(files)) {
    assert.equal(manifest.files[file], hashes.before, `Unexpected original asset ${file}.`);
    assert.equal(digest(safeReadFile(root, file, null)), hashes.after, `Unexpected replacement asset ${file}.`);
    manifest.files[file] = hashes.after;
  }
  for (const [file, hashes] of Object.entries(providerFiles)) {
    assert.equal(manifest.configuration.provider_runtime[file], hashes.before, `Unexpected original provider ${file}.`);
    assert.equal(digest(safeReadFile(root, file, null)), hashes.after, `Unexpected replacement provider ${file}.`);
    manifest.configuration.provider_runtime[file] = hashes.after;
  }
  const preservedFiles = ["game-state.json", "summary.json", "checkpoint.json", "prompt.md", "claude-events.jsonl", "agent-events.jsonl", "tool-activity.jsonl", "records/moves.txt", "records/history.jsonl"];
  const preserved = Object.fromEntries(preservedFiles.map(file => [file, digest(safeReadFile(directory, file, null))]));
  const encodedManifest = encode(manifest), integrity = { ...metadata.integrity, manifest_sha256: digest(encodedManifest) };
  const staging = await mkdtemp(path.join(os.tmpdir(), "fable-progress-repair-"));
  try {
    await mkdir(path.join(staging, "sandbox-state"), { mode: 0o700 });
    for (const file of ["game-state.json", "summary.json", "checkpoint.json", "prompt.md", "sandbox-state/integrity-key"])
      await copyFile(path.join(directory, file), path.join(staging, file));
    await writeFile(path.join(staging, "integrity.json"), encodedManifest, { mode: 0o600 });
    await verifyClaudeIntegrity(root, staging, { ...metadata, integrity });
  } finally { await rm(staging, { recursive: true, force: true }); }
  const response = await fetch(`http://localhost:8080/api/benchmark/v1/runs/${metadata.id}`);
  assert(response.ok); const live = await response.json();
  assert.equal(live.runner_active, false); assert.equal(live.status, "failed"); assert.equal(live.action_count, 1603);
  assert.equal(safeReadFile(directory, "run.json"), originalRun);
  assert.equal(safeReadFile(directory, "integrity.json"), originalManifest);
  assert.equal(safeReadFile(directory, "integrity-violation.json"), originalViolation);
  for (const [file, hash] of Object.entries(preserved)) assert.equal(digest(safeReadFile(directory, file, null)), hash);
  const repair = {
    at: new Date().toISOString(), kind: "operator-authorized-recovery", action_count: 1603,
    reason: "User requested Fable resume. Correct the false-positive delegation check for a 30-second heartbeat tied to a previously validated root maze_sequence call, and admit the reviewed gate-ASCII/CxF floor changes.",
    files: { ...files, ...providerFiles }, previous_error: metadata.error, archived_violation: JSON.parse(originalViolation),
    original_manifest_sha256: metadata.integrity.manifest_sha256, repaired_manifest_sha256: integrity.manifest_sha256,
    claude_session_id: metadata.claude_session_id, events_audited: events.length, preserved_artifacts: preserved,
    last_sequence: { requested: completed.actions.length, accepted: 78, from: 1525, to: 1603 },
    level_note: "CxF has not been visited. No accepted moves, board states, scores, or prior observations were rewritten."
  };
  const backup = path.join(directory, "repairs", "tool-heartbeat-v1");
  await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 }); await mkdir(backup, { mode: 0o700 });
  for (const [file, bytes] of [["run.before.json", originalRun], ["integrity.before.json", originalManifest], ["integrity-violation.before.json", originalViolation], ["repair.json", encode(repair)]])
    await writeFile(path.join(backup, file), bytes, { flag: "wx", mode: 0o600 });
  metadata.integrity = integrity; metadata.runtime_repairs = [...(metadata.runtime_repairs || []), repair];
  metadata.status = "paused"; metadata.error = null; metadata.completed_at = null; metadata.paused_at = repair.at; metadata.updated_at = repair.at;
  try {
    await atomic(path.join(directory, "integrity.json"), encodedManifest);
    await atomic(path.join(directory, "run.json"), encode(metadata));
    await verifyClaudeIntegrity(root, directory, metadata);
    for (const [file, hash] of Object.entries(preserved)) assert.equal(digest(safeReadFile(directory, file, null)), hash);
    await rm(path.join(directory, "integrity-violation.json"));
  } catch (error) {
    await atomic(path.join(directory, "integrity-violation.json"), originalViolation);
    await atomic(path.join(directory, "integrity.json"), originalManifest);
    await atomic(path.join(directory, "run.json"), originalRun);
    throw error;
  }
  return { id: metadata.id, status: metadata.status, action_count: 1603, gems: 2, backup, events_audited: events.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], FABLE_PROGRESS_RUN);
  const root = path.resolve(import.meta.dirname, ".."), records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records/mazebench-benchmark");
  console.log(JSON.stringify(await repairClaudeProgress(root, path.join(records, FABLE_PROGRESS_RUN)), null, 2));
}
