// Operator-only recovery admission. Never changes/reseals frozen assets or
// checkpoints, and never launches an agent. Resume separately through HTTP.
import "../benchmarking/codex-releases.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { BenchmarkSupervisor, eventBoundaryViolation } from "../benchmarking/v1/supervisor.mjs";
import { readCheckpointJson } from "../benchmarking/v1/checkpoint-json.mjs";
import { safeReadFile } from "../benchmarking/v1/safe-files.mjs";

export const CAPACITY_ERROR = "Error running remote compact task: Selected model is at capacity. Please try a different model.";
const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;

export function assertCapacityRecovery(metadata, report, summary, events) {
  assert.equal(metadata.provider || "codex", "codex");
  assert.equal(metadata.status, "failed", "Only an inactive failed run can be admitted.");
  assert.equal(metadata.error, CAPACITY_ERROR, "Not the exact provider-capacity failure; do not retry quota or unrelated failures.");
  assert.equal(report.id, metadata.id);
  assert.equal(report.status, "failed");
  assert.equal(report.runner_active, false, "An agent is still active.");
  assert.equal(report.error, CAPACITY_ERROR);
  assert.equal(report.codex_thread_id, metadata.codex_thread_id);
  assert(metadata.codex_thread_id, "The original conversation is required.");
  assert.equal(report.action_count, summary.action_count);
  assert(!["won", "action-limit"].includes(summary.game_status), "The game is already finished.");
  assert.equal(events.at(-1)?.type, "turn.failed");
  assert.equal(events.at(-1)?.error?.message, CAPACITY_ERROR);
  for (const event of events) {
    assert.equal(eventBoundaryViolation(event, { toolsEnabled: metadata.tools_enabled }), null, "Forbidden capability in provider history.");
    if (event.type === "thread.started") assert.equal(event.thread_id, metadata.codex_thread_id);
  }
}

export async function admitCapacityRecovery(projectRoot, directory, { apply = false, baseUrl = "http://localhost:8080" } = {}) {
  const original = safeReadFile(directory, "run.json");
  const metadata = JSON.parse(original);
  assert.equal(path.basename(directory), metadata.id);
  const getReport = async () => {
    const response = await fetch(`${baseUrl}/api/benchmark/v1/runs/${encodeURIComponent(metadata.id)}`, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, "The owning supervisor must be available.");
    return response.json();
  };
  const preserved = Object.fromEntries(["integrity.json", "checkpoint.json", "game-state.json", "summary.json", "display.json", "prompt.md", "agent-events.jsonl"]
    .map(file => [file, digest(safeReadFile(directory, file, null))]));
  const events = safeReadFile(directory, "agent-events.jsonl").trim().split(/\r?\n/).map(JSON.parse);
  const summary = await readCheckpointJson(directory, "summary.json");
  assertCapacityRecovery(metadata, await getReport(), summary, events);
  const supervisor = new BenchmarkSupervisor(projectRoot, { recordsRoot: path.dirname(directory) });
  // Same complete binary, model catalog, asset, configuration, prompt, journal,
  // and Python isolation checks the normal supervisor will repeat on resume.
  await supervisor.verifyRunCapabilityBoundary(metadata, directory);
  const assertUnchanged = async () => {
    assert.equal(safeReadFile(directory, "run.json"), original, "Run metadata changed during verification.");
    for (const [file, hash] of Object.entries(preserved)) assert.equal(digest(safeReadFile(directory, file, null)), hash, `${file} changed during verification.`);
    const processes = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
    assert(!processes.split("\n").some(line => line.includes(path.join(directory, "agent-cwd"))), "A runner is still alive.");
    assertCapacityRecovery(metadata, await getReport(), summary, events);
  };
  await assertUnchanged();
  if (!apply) return { id: metadata.id, verified: true, action_count: summary.action_count, applied: false };
  const audit = {
    at: new Date().toISOString(), reason: "provider-capacity-compaction",
    previous_status: metadata.status, previous_error: metadata.error,
    action_count: summary.action_count, codex_thread_id: metadata.codex_thread_id,
    preserved_sha256: preserved, run_before_sha256: digest(original)
  };
  // The event hash makes a second admission of this same failure impossible.
  const backup = path.join(directory, "repairs", `capacity-${preserved["agent-events.jsonl"].slice(0,16)}`);
  await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
  await mkdir(backup, { mode: 0o700 });
  await writeFile(path.join(backup, "run.before.json"), original, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(backup, "recovery.json"), encode(audit), { flag: "wx", mode: 0o600 });
  await assertUnchanged();
  const next = { ...metadata, status: "paused", paused_at: audit.at, updated_at: audit.at,
    recoveries: [...(metadata.recoveries || []), audit] };
  const temporary = path.join(backup, "run.ready.json");
  await writeFile(temporary, encode(next), { flag: "wx", mode: 0o600 });
  await rename(temporary, path.join(directory, "run.json"));
  for (const [file, hash] of Object.entries(preserved)) assert.equal(digest(safeReadFile(directory, file, null)), hash);
  return { id: metadata.id, status: next.status, action_count: summary.action_count, applied: true, backup };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [id, flag] = process.argv.slice(2);
  assert(/^run-[0-9TZ-]+-[a-f0-9]{6}$/.test(id || ""), "Expected exact run ID.");
  assert(flag === undefined || flag === "--apply", "Only --apply is supported; default is read-only.");
  const root = path.resolve(import.meta.dirname, "..");
  const records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records", "mazebench-benchmark");
  console.log(JSON.stringify(await admitCapacityRecovery(root, path.join(records, id), { apply: flag === "--apply" }), null, 2));
}
