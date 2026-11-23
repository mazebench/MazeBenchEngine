import "../benchmarking/codex-releases.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { historicalRepairFixture } from "./historical-repair-fixture.mjs";
import { repairCompactionRun, COMPACTION_REPAIR_FILES } from "../scripts/repair-benchmark-compaction-v1.mjs";
import { createRunIntegrity, verifyRunIntegrity, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { discoverCodexCapabilityPolicy, writeDirectToolModelCatalog } from "../benchmarking/v1/supervisor.mjs";

let projectRoot;
before(async () => { projectRoot = await historicalRepairFixture(path.resolve(import.meta.dirname, "..")); });
after(async () => { if (projectRoot) await rm(projectRoot, { recursive: true, force: true }); });
const sha256 = value => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mazebench-compaction-repair-test-"));
  const prompt = "Test compaction recovery.";
  const configuration = { model: "gpt-6-astra", effort: "low", tools_enabled: false, action_limit: 10, start_room: "HxI", effective_prompt_sha256: sha256(prompt) };
  const integrity = await createRunIntegrity(projectRoot, directory, configuration);
  const runtime = await BenchmarkGameRuntime.create(projectRoot, directory, { actionLimit: 10 });
  await runtime.apply("right");
  const manifest = JSON.parse(await readFile(path.join(directory, "integrity.json"), "utf8"));
  for (const [file, hashes] of Object.entries(COMPACTION_REPAIR_FILES)) manifest.files[file] = hashes.before;
  const encoded = JSON.stringify(manifest);
  await writeFile(path.join(directory, "integrity.json"), encoded);
  integrity.manifest_sha256 = sha256(encoded);
  const policy = discoverCodexCapabilityPolicy();
  policy.model_catalog = await writeDirectToolModelCatalog(directory, configuration.model);
  const metadata = {
    id: "run-2026-09-04T19-29-31-992Z-772688", ...configuration, integrity, capability_policy: policy,
    status: "failed", codex_thread_id: "existing-thread",
    error: 'Error running remote compact task: unexpected status 404 Not Found, url: https://chatgpt.com/backend-api/codex/responses/compact, request id: fixture'
  };
  await writeFile(path.join(directory, "run.json"), JSON.stringify(metadata));
  await writeFile(path.join(directory, "prompt.md"), prompt);
  await writeFile(path.join(directory, "agent-events.jsonl"), "original conversation\n");
  return { directory, metadata };
}

test("audited compaction repair preserves state, scores, prompt and conversation", async () => {
  const { directory } = await fixture();
  try {
    const preserved = ["game-state.json", "summary.json", "checkpoint.json", "prompt.md", "agent-events.jsonl", "records/move_history/move_1.txt"];
    const before = await Promise.all(preserved.map(file => readFile(path.join(directory, file), "utf8")));
    const result = await repairCompactionRun(projectRoot, directory);
    assert.equal(result.action_count, 1);
    assert.equal(result.codex_thread_id, "existing-thread");
    assert.deepEqual(await Promise.all(preserved.map(file => readFile(path.join(directory, file), "utf8"))), before);
    const metadata = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8"));
    assert.equal(metadata.status, "failed"); // Separate explicit resume performs execution.
    assert.equal(metadata.runtime_repairs.length, 1);
    const currentPolicy = discoverCodexCapabilityPolicy();
    assert.deepEqual(metadata.capability_policy.enabled_features, currentPolicy.enabled_features);
    assert.deepEqual(metadata.capability_policy.disabled_features, currentPolicy.disabled_features);
    assert(existsSync(path.join(result.backup, "integrity.before.json")));
    await verifyRunIntegrity(projectRoot, directory, metadata.integrity);
    verifyCheckpoint(directory);
    await assert.rejects(() => repairCompactionRun(projectRoot, directory), /Unexpected original runtime/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("compaction repair refuses tampered state, configuration and unrelated failures", async () => {
  for (const kind of ["state", "configuration", "failure"]) {
    const { directory, metadata } = await fixture();
    try {
      if (kind === "state") await writeFile(path.join(directory, "summary.json"), '{"gems_collected":100}');
      if (kind === "configuration") metadata.tools_enabled = true;
      if (kind === "failure") metadata.error = "Capability boundary violation: shell";
      await writeFile(path.join(directory, "run.json"), JSON.stringify(metadata));
      const original = await readFile(path.join(directory, "integrity.json"), "utf8");
      await assert.rejects(() => repairCompactionRun(projectRoot, directory), /modified outside|configuration changed|not the known compaction/);
      assert.equal(await readFile(path.join(directory, "integrity.json"), "utf8"), original);
      assert(!existsSync(path.join(directory, "repairs")));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
