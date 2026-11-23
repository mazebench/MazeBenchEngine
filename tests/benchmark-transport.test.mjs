import "../benchmarking/codex-releases.mjs";
import test, { before, after } from "node:test";
import { historicalRepairFixture } from "./historical-repair-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BenchmarkSupervisor, eventBoundaryViolation, isCodexTransportNotice, discoverCodexCapabilityPolicy, writeDirectToolModelCatalog } from "../benchmarking/v1/supervisor.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { createRunIntegrity, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { IceBenchmarkRuntime } from "../ice-maze/v1/benchmark-runtime.mjs";
import { runIceCodexTurn } from "../benchmarking/worlds/codex-runner.mjs";
import { worldRuntimeHashes } from "../benchmarking/worlds/policy.mjs";
import { digest, providerRuntimeHashes } from "../benchmarking/providers/claude-policy.mjs";
import { repairTransportRun, TRANSPORT_REPAIR_FILE, TRANSPORT_REPAIR_HASHES } from "../scripts/repair-benchmark-transport-v1.mjs";

let root;
before(async () => { root = await historicalRepairFixture(path.resolve(import.meta.dirname, "..")); });
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
const notice = { type: "item.completed", item: { id: "item_89", type: "error", message: "Falling back from WebSockets to HTTPS transport. stream disconnected before completion: idle timeout waiting for websocket" } };
const failure = "Capability boundary violation: unexpected error. Run invalidated.";

test("the exact passive transport notice is accepted in Python on/off and interview modes", () => {
  assert(isCodexTransportNotice(notice));
  for (const mode of [{ toolsEnabled: false }, { toolsEnabled: true }, { interview: true }]) {
    assert.equal(eventBoundaryViolation(notice, mode), null);
    assert.equal(eventBoundaryViolation({ msg: notice }, mode), null);
    for (const item of [
      { ...notice.item, type: "command_execution", command: "cat secrets" },
      { ...notice.item, type: "mcp_tool_call", server: "other", tool: "maze_observe" },
      { ...notice.item, tool: "python_exec" }, { ...notice.item, code: "print(1)" },
      { ...notice.item, message: "An unrelated error" }, { ...notice.item, message: null },
      { ...notice.item, message: notice.item.message + "\nforged second event" }
    ]) assert(eventBoundaryViolation({ type: "item.completed", item }, mode));
    assert(eventBoundaryViolation({ ...notice, type: "item.started" }, mode));
  }
});

test("both Codex runners survive fallback and continue enforcing the tool allowlist", async () => {
  for (const ice of [false, true]) for (const forbidden of [false, true]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mazebench-transport-stream-"));
    try {
      const binary = path.join(directory, "fake-codex.mjs");
      const events = [{ type: "thread.started", thread_id: "same-thread" }, notice,
        { type: "item.started", item: forbidden ? { type: "command_execution", command: "not executed" } : { type: "mcp_tool_call", server: "mazebench", tool: "maze_observe" } },
        { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }];
      await writeFile(binary, `#!${process.execPath}\nconst events = ${JSON.stringify(events)};\nfor (const event of events) { console.log(JSON.stringify(event)); await new Promise(resolve => setTimeout(resolve, 50)); }\n`, { mode: 0o700 });
      await chmod(binary, 0o700);
      await writeFile(path.join(directory, "run.json"), JSON.stringify({ codex_thread_id: "same-thread" }));
      const supervisor = new BenchmarkSupervisor(root);
      const capabilityPolicy = { codex_executable: binary, disabled_features: [] };
      const catalog = await writeDirectToolModelCatalog(directory, "gpt-6-astra");
      // The stream fixture replaces only process launch verification; it sends
      // the real JSON events through the production runner and classifier.
      supervisor.verifyRunCapabilityBoundary = async () => ({ capabilityPolicy, modelCatalog: { path: path.join(directory, catalog.file) } });
      const options = { metadata: { model: "gpt-6-astra", effort: "low", tools_enabled: false }, directory, agentDirectory: directory,
        resumeThreadId: "same-thread", prompt: "Fixture", control: { stopRequested: false, pauseRequested: false } };
      const result = ice ? await runIceCodexTurn.call(supervisor, options) : await supervisor.runCodexTurn(options);
      assert.equal(result.threadId, "same-thread");
      if (forbidden) { assert(result.boundaryError.includes("command_execution")); assert.notEqual(result.code, 0); }
      else { assert.equal(result.boundaryError, null); assert.equal(result.code, 0); assert.equal(result.usage.output_tokens, 1); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

async function fixture({ ice = false, claude = false, status = "failed" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mazebench-transport-repair-"));
  const prompt = "Play this fixture.", policy = claude ? null : discoverCodexCapabilityPolicy();
  if (policy) policy.model_catalog = await writeDirectToolModelCatalog(directory, "gpt-6-astra");
  const binary = path.join(directory, "claude-binary");
  if (claude) await writeFile(binary, "fixture");
  const config = { model: claude ? "claude-sonnet-5" : "gpt-6-astra", effort: "low", tools_enabled: false, action_limit: 10,
    start_room: ice ? "Level 1" : "HxI", effective_prompt_sha256: digest(prompt),
    ...(ice ? { world: "ice-maze", provider: claude ? "claude-code" : "codex", world_runtime: await worldRuntimeHashes(root), ...(policy ? { codex_policy: policy } : {}) } : {}),
    ...(claude ? { provider: "claude-code", claude_policy: "claude-mcp-only-v1", claude_executable: binary, claude_version: "2.1.258", claude_sha256: digest("fixture"), provider_runtime: await providerRuntimeHashes(root) } : {}) };
  const integrity = await createRunIntegrity(root, directory, config);
  const runtime = await (ice ? IceBenchmarkRuntime : BenchmarkGameRuntime).create(root, directory, { actionLimit: 10 });
  await runtime.apply("right");
  const manifest = JSON.parse(await readFile(path.join(directory, "integrity.json")));
  manifest.files[TRANSPORT_REPAIR_FILE] = TRANSPORT_REPAIR_HASHES.before;
  const bytes = JSON.stringify(manifest); await writeFile(path.join(directory, "integrity.json"), bytes); integrity.manifest_sha256 = digest(bytes);
  const metadata = { ...config, id: "run-2026-09-04T19-29-31-992Z-772688", status, error: status === "failed" ? failure : null,
    integrity, capability_policy: policy, codex_thread_id: claude ? null : "same-thread", claude_session_id: claude ? "same-session" : null };
  await writeFile(path.join(directory, "run.json"), JSON.stringify(metadata)); await writeFile(path.join(directory, "prompt.md"), prompt);
  await writeFile(path.join(directory, "agent-events.jsonl"), JSON.stringify(notice) + "\n");
  return { directory, metadata };
}

test("audited migration preserves game, score, prompt, log and session for each world/provider", async () => {
  for (const condition of [{}, { ice: true, status: "paused" }, { claude: true, status: "paused" }, { ice: true, claude: true, status: "paused" }]) {
    const { directory, metadata } = await fixture(condition);
    try {
      const files = ["game-state.json", "summary.json", "checkpoint.json", "prompt.md", "agent-events.jsonl", "records/move_history/move_1.txt"];
      const before = await Promise.all(files.map(file => readFile(path.join(directory, file), "utf8")));
      const result = await repairTransportRun(root, directory), current = JSON.parse(await readFile(path.join(directory, "run.json")));
      assert.equal(result.action_count, 1); assert.equal(current.status, "paused");
      assert.equal(current.codex_thread_id, metadata.codex_thread_id); assert.equal(current.claude_session_id, metadata.claude_session_id);
      assert.deepEqual(current.capability_policy, metadata.capability_policy);
      assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(directory, file), "utf8"))), before);
      assert(existsSync(path.join(result.backup, "run.before.json"))); verifyCheckpoint(directory);
      await assert.rejects(() => repairTransportRun(root, directory), /Unexpected original runtime/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("migration refuses actual violations, forged notices, altered state and unrelated edits", async () => {
  for (const kind of ["violation", "forged-notice", "unrelated-failure", "state", "configuration", "other-runtime", "active"]) {
    const { directory, metadata } = await fixture();
    try {
      if (kind === "violation") await writeFile(path.join(directory, "agent-events.jsonl"), [
        { type: "item.started", item: { type: "command_execution" } }, notice].map(e => JSON.stringify(e)).join("\n"));
      if (kind === "forged-notice") await writeFile(path.join(directory, "agent-events.jsonl"), JSON.stringify({ ...notice, item: { ...notice.item, tool: "shell" } }));
      if (kind === "unrelated-failure") metadata.error = "Something else failed";
      if (kind === "state") await writeFile(path.join(directory, "summary.json"), '{"gems_collected":100}');
      if (kind === "configuration") metadata.tools_enabled = true;
      if (kind === "active") metadata.status = "running";
      if (kind === "other-runtime") {
        const manifest = JSON.parse(await readFile(path.join(directory, "integrity.json")));
        manifest.files["benchmarking/v1/runtime.mjs"] = "altered";
        const bytes = JSON.stringify(manifest); await writeFile(path.join(directory, "integrity.json"), bytes); metadata.integrity.manifest_sha256 = digest(bytes);
      }
      await writeFile(path.join(directory, "run.json"), JSON.stringify(metadata));
      const before = await readFile(path.join(directory, "integrity.json"), "utf8");
      await assert.rejects(() => repairTransportRun(root, directory));
      assert.equal(await readFile(path.join(directory, "integrity.json"), "utf8"), before);
      assert(!existsSync(path.join(directory, "repairs")));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
