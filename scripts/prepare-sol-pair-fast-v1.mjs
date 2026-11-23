// Operator-only, exact-hash migration for the user-approved Sol pair.
// Changes speed and the reviewed duplicate-Fast-flag fix, never game history.
// Does not launch agents: resume each original conversation through HTTP.
import "../benchmarking/codex-releases.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkSupervisor, buildCodexArguments, eventBoundaryViolation } from "../benchmarking/v1/supervisor.mjs";
import { assertRunConfiguration, currentRuntimeHashes, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { readCheckpointJson } from "../benchmarking/v1/checkpoint-json.mjs";
import { safeReadFile } from "../benchmarking/v1/safe-files.mjs";

export const SUPERVISOR_FIX = Object.freeze({
  file: "benchmarking/v1/supervisor.mjs",
  before: "4923d9662fefa513d6b65033dbbb4fffcf17ad6620b35138c23c99993eb02774",
  after: "47322948625dfefcc638e7d4b8b3776226f4f650a3ff7c26045d1381acfadf37"
});
export const PAIR_PLAN = Object.freeze([
  { id: "run-2026-09-30T03-52-50-969Z-62c889", tools: false, actions: 8485,
    thread: "01a0f071-9c4f-7a11-9420-10a36e213a3e",
    manifest: "a175a57e08371e57844ecda028c448635c7d348bee2d866a451c202129e0c121",
    checkpoint: "d5809242192e89640501d5d2700c58d4a2e0dbaa0a4213ea024f88b53b79b59b" },
  { id: "run-2026-09-30T03-52-52-514Z-10a6a2", tools: true, actions: 10347,
    thread: "01a0f071-a1c7-7883-b368-6eea780f7c37",
    manifest: "788fc3d11bfb0c39c65e4dda34dafc5c31920de54baa91a7e294494e62495828",
    checkpoint: "cd85ce70cbf345a0b435d4fac8c9247a51276dfb986c598b54b8e8b3f6024bc7" }
]);
const sha = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const protectedFiles = ["checkpoint.json", "game-state.json", "summary.json", "display.json", "prompt.md", "agent-events.jsonl", "tool-activity.jsonl"];

export function planFastSelection(metadata, manifest, current, expected, at) {
  assert.equal(metadata.id, expected.id);
  assert.equal(metadata.provider || "codex", "codex");
  assert.equal(metadata.status, "paused");
  assert.equal(metadata.error, null);
  assert.equal(metadata.model, "gpt-6.1-sol");
  assert.equal(metadata.effort, "max");
  assert.equal(metadata.action_limit, null);
  assert.equal(metadata.tools_enabled, expected.tools);
  assert.equal(metadata.codex_thread_id, expected.thread);
  assert.equal(metadata.service_tier, null);
  assert.equal(metadata.integrity.manifest_sha256, expected.manifest);
  assertRunConfiguration(metadata, manifest);
  assert.deepEqual(Object.keys(current).sort(), Object.keys(manifest.files).sort(), "Runtime inventory drift.");
  for (const [file, before] of Object.entries(manifest.files)) {
    if (file === SUPERVISOR_FIX.file) {
      assert.equal(before, SUPERVISOR_FIX.before);
      assert.equal(current[file], SUPERVISOR_FIX.after);
    } else assert.equal(current[file], before, `Unapproved runtime change: ${file}`);
  }
  const nextManifest = structuredClone(manifest);
  nextManifest.files[SUPERVISOR_FIX.file] = SUPERVISOR_FIX.after;
  nextManifest.configuration.service_tier = "fast";
  const next = structuredClone(metadata);
  next.service_tier = "fast";
  next.integrity.manifest_sha256 = sha(encode(nextManifest));
  assert(next.capability_policy.disabled_features.includes("fast_mode"));
  assert(!next.capability_policy.enabled_features.includes("fast_mode"));
  next.capability_policy.disabled_features = next.capability_policy.disabled_features.filter(f => f !== "fast_mode");
  next.capability_policy.enabled_features.push("fast_mode");
  next.service_tier_history = [...(next.service_tier_history || [{ at: next.created_at, service_tier: "standard", source: "Original configuration" }]),
    { at, service_tier: "fast", action_count: expected.actions, source: "User-requested Fast-mode resume" }];
  next.updated_at = at;
  next.operator_changes = [...(next.operator_changes || []), {
    at, kind: "fast-service-tier", action_count: expected.actions, conversation: expected.thread,
    reason: "User requested Fast mode for both paused GPT-6.1 Sol runs; retain Max reasoning, tools, prompt, and complete history.",
    manifest_before_sha256: expected.manifest, manifest_after_sha256: next.integrity.manifest_sha256,
    reviewed_runtime_change: SUPERVISOR_FIX, checkpoint_sha256: expected.checkpoint
  }];
  assertRunConfiguration(next, nextManifest);
  return { metadata: next, manifest: nextManifest };
}

async function atomic(directory, file, bytes) {
  const temporary = path.join(directory, `${file}.fast-${process.pid}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, path.join(directory, file));
}

export async function preparePair(root, records, { apply = false, baseUrl = "http://localhost:8080" } = {}) {
  const current = await currentRuntimeHashes(root), at = new Date().toISOString();
  const supervisor = new BenchmarkSupervisor(root, { recordsRoot: records });
  const plans = [];
  for (const expected of PAIR_PLAN) {
    const directory = path.join(records, expected.id);
    const originalRun = safeReadFile(directory, "run.json");
    const originalManifest = safeReadFile(directory, "integrity.json");
    const metadata = JSON.parse(originalRun);
    assert.equal(sha(originalManifest), expected.manifest);
    assert.equal(sha(safeReadFile(directory, "checkpoint.json")), expected.checkpoint);
    verifyCheckpoint(directory);
    const summary = await readCheckpointJson(directory, "summary.json");
    assert.equal(summary.action_count, expected.actions);
    assert(!["won", "action-limit"].includes(summary.game_status));
    const next = planFastSelection(metadata, JSON.parse(originalManifest), current, expected, at);
    const preserved = Object.fromEntries(protectedFiles.map(file => [file, sha(safeReadFile(directory, file, null))]));
    for (const line of safeReadFile(directory, "agent-events.jsonl").trim().split(/\r?\n/)) {
      const event = JSON.parse(line);
      assert.equal(eventBoundaryViolation(event, { toolsEnabled: expected.tools }), null);
      if (event.type === "thread.started") assert.equal(event.thread_id, expected.thread);
    }
    const assertInactive = async () => {
      const response = await fetch(`${baseUrl}/api/benchmark/v1/runs/${expected.id}`, { signal: AbortSignal.timeout(20000) });
      assert.equal(response.status, 200);
      const report = await response.json();
      assert.equal(report.status, "paused"); assert.equal(report.runner_active, false);
      assert.equal(report.action_count, expected.actions); assert.equal(report.codex_thread_id, expected.thread);
      const ps = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
      assert(!ps.split("\n").some(line => line.includes(path.join(directory, "agent-cwd")) || line.includes(`exec resume ${expected.thread}`)), "A runner is still alive.");
    };
    const assertPreserved = () => {
      for (const [file, hash] of Object.entries(preserved)) assert.equal(sha(safeReadFile(directory, file, null)), hash, `${file} changed.`);
      verifyCheckpoint(directory);
    };
    await assertInactive();
    plans.push({ expected, directory, originalRun, originalManifest, next, preserved, assertInactive, assertPreserved });
  }
  if (!apply) return plans.map(p => ({ id: p.expected.id, verified: true, actions: p.expected.actions, service_tier: "fast", applied: false }));
  // Back up both exact originals before publishing either selection.
  for (const p of plans) {
    p.backup = path.join(p.directory, "repairs", `fast-${at.replaceAll(":", "-")}`);
    await mkdir(p.backup, { recursive: true, mode: 0o700 });
    await writeFile(path.join(p.backup, "run.before.json"), p.originalRun, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(p.backup, "integrity.before.json"), p.originalManifest, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(p.backup, "audit.json"), encode({ expected: p.expected, preserved: p.preserved, change: p.next.metadata.operator_changes.at(-1) }), { flag: "wx", mode: 0o600 });
  }
  const published = [];
  try {
    for (const p of plans) {
      await p.assertInactive(); p.assertPreserved();
      assert.equal(safeReadFile(p.directory, "run.json"), p.originalRun);
      assert.equal(safeReadFile(p.directory, "integrity.json"), p.originalManifest);
      published.push(p);
      // Intermediate mismatch fails closed; no state or journal is re-signed.
      await atomic(p.directory, "integrity.json", encode(p.next.manifest));
      await atomic(p.directory, "run.json", encode(p.next.metadata));
      const { capabilityPolicy, modelCatalog } = await supervisor.verifyRunCapabilityBoundary(p.next.metadata, p.directory);
      const args = buildCodexArguments({ projectRoot: root, runDirectory: p.directory, agentDirectory: path.join(p.directory, "agent-cwd"),
        model: p.next.metadata.model, effort: "max", serviceTier: "fast", toolsEnabled: p.expected.tools,
        disabledFeatures: capabilityPolicy.disabled_features, enabledFeatures: capabilityPolicy.enabled_features,
        modelCatalogPath: modelCatalog.path, resumeThreadId: p.expected.thread, prompt: "Preflight only; never launched." });
      assert.equal(args.filter(value => value === "features.fast_mode=true").length, 1);
      p.assertPreserved();
      await writeFile(path.join(p.backup, "verified.json"), encode({ at: new Date().toISOString(), checkpoint_unchanged: true, boundary_verified: true, same_conversation: true }), { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    for (const p of published.reverse()) {
      await p.assertInactive();
      await atomic(p.directory, "integrity.json", p.originalManifest);
      await atomic(p.directory, "run.json", p.originalRun);
    }
    throw error;
  }
  return plans.map(p => ({ id: p.expected.id, actions: p.expected.actions, service_tier: "fast", applied: true, backup: p.backup }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv[2];
  assert(flag === undefined || flag === "--apply");
  console.log(encode(await preparePair(path.resolve(import.meta.dirname, ".."), "/Users/jpappas/records/mazebench-benchmark", { apply: flag === "--apply" })));
}
