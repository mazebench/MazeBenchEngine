import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLAUDE_MODELS, CLAUDE_POLICY, CLAUDE_PROVIDER, claudeEnvironment, buildClaudeArguments, claudeTools, claudeBoundaryViolation, digest, providerRuntimeHashes, verifyClaudeIntegrity, inspectClaude } from "../benchmarking/providers/claude-policy.mjs";
import { BenchmarkSupervisor } from "../benchmarking/providers/supervisor.mjs";
import { createRunIntegrity } from "../benchmarking/v1/integrity.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { createClaudeTimeline, consumeClaudeEvent, claudeTelemetry } from "../benchmarking/claude-telemetry.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const model = "claude-sonnet-5";
const options = { projectRoot, runDirectory: "/tmp/claude-test", model, effort: "low", prompt: "Play" };
const init = toolsEnabled => ({ type: "system", subtype: "init", model, permissionMode: "dontAsk", tools: claudeTools(toolsEnabled), mcp_servers: [{ name: "mazebench", status: "connected" }], plugins: [], skills: [], slash_commands: [] });

test("Claude agent selection cannot cross providers or accept unknown models", async () => {
  const supervisor = new BenchmarkSupervisor(projectRoot);
  const spec = await supervisor.validateSpec({ provider: CLAUDE_PROVIDER, model, tools_enabled: true });
  assert.equal(spec.provider, CLAUDE_PROVIDER);
  assert.equal(spec.toolsEnabled, true);
  assert(CLAUDE_MODELS.some(entry => entry.id === "claude-opus-5-5"));
  assert(CLAUDE_MODELS.some(entry => entry.id === "claude-sonnet-5-5"));
  assert(CLAUDE_MODELS.some(entry => entry.id === "claude-haiku-5-5"));
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const haiku = await supervisor.validateSpec({ provider: CLAUDE_PROVIDER, model: "claude-haiku-5-5", effort });
    assert.equal(haiku.model, "claude-haiku-5-5");
    assert.equal(haiku.effort, effort);
  }
  assert.equal((await supervisor.validateSpec({ provider: CLAUDE_PROVIDER, model: "claude-opus-5-5" })).model, "claude-opus-5-5");
  for (const spec of [{ provider: "unknown" }, { provider: "codex", model }, { provider: CLAUDE_PROVIDER, model: "gpt-6-astra" }, { provider: CLAUDE_PROVIDER, model, effort: "ultra" }]) await assert.rejects(() => supervisor.validateSpec(spec));
});

test("Claude launch, resume and interview only permit explicitly configured tools", () => {
  for (const extra of [{ toolsEnabled: false }, { toolsEnabled: true }, { toolsEnabled: true, resumeSessionId: "same-session" }, { interview: true, fork: true, resumeSessionId: "parent" }]) {
    const args = buildClaudeArguments({ ...options, ...extra });
    const value = flag => args[args.indexOf(flag) + 1];
    for (const flag of ["--restricted", "--strict-mcp-config", "--disable-slash-commands", "--no-chrome"]) assert(args.includes(flag));
    assert.equal(value("--tools"), ""); assert.equal(value("--setting-sources"), "");
    assert.equal(value("--permission-mode"), "dontAsk");
    assert.equal(value("--model"), model);
    const mcp = JSON.parse(value("--mcp-config"));
    assert.deepEqual(Object.keys(mcp.mcpServers), extra.interview ? [] : ["mazebench"]);
    const settings = JSON.parse(value("--settings"));
    assert.equal(settings.disableAllHooks, true); assert.equal(settings.autoMemoryEnabled, false);
    assert.equal(settings.enabledPlugins['agents-md@builtin'], false);
    assert.equal(settings.enabledPlugins['cc-plugin-plugin-authoring@builtin'], false);
    assert.equal(settings.disableBundledSkills, true);
    assert.deepEqual(settings.fallbackModel, []);
    assert.deepEqual(settings.permissions.allow, extra.interview ? [] : claudeTools(extra.toolsEnabled));
    assert(!args.includes("--dangerously-skip-permissions"));
  }
});

test("Claude environment excludes inherited credentials, provider overrides and executors", () => {
  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "NODE_OPTIONS", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_DEFAULT_SONNET_MODEL"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "malicious";
    const env = claudeEnvironment();
    for (const key of keys) assert.equal(env[key], undefined);
    assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
    assert.equal(env.USER, os.userInfo().username); // Required for native keychain authentication.
  } finally { for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

test("Claude unexpected tools, personal integrations, fallbacks and delegation invalidate the run", () => {
  for (const toolsEnabled of [false, true]) {
    const settings = { model, toolsEnabled };
    assert.equal(claudeBoundaryViolation(init(toolsEnabled), settings), null);
    for (const bad of [
      { ...init(toolsEnabled), model: "claude-opus-5" },
      { ...init(toolsEnabled), tools: [...claudeTools(toolsEnabled), "Read"] },
      { ...init(toolsEnabled), plugins: ["personal"] },
      { ...init(toolsEnabled), skills: ["cheat"] },
      { ...init(toolsEnabled), mcp_servers: [{ name: "other", status: "connected" }] },
      { ...init(toolsEnabled), permissionMode: "bypassPermissions" },
      { type: "assistant", parent_tool_use_id: "agent", message: {} },
      { type: "result", modelUsage: { "other-model": {} } },
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "server_tool_use", name: "web_search" } } }
    ]) assert(claudeBoundaryViolation(bad, settings));
    for (const name of ["Bash", "Read", "Agent", "WebFetch", "mcp__other__solver", ...(!toolsEnabled ? ["mcp__mazebench__python_exec"] : [])]) {
      assert(claudeBoundaryViolation({ type: "assistant", message: { content: [{ type: "tool_use", name }] } }, settings));
      assert(claudeBoundaryViolation({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name } } }, settings));
    }
  }
});

test("Claude freezes its provider, executable, code, prompt and Python condition", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maze-claude-integrity-"));
  try {
    // A harmless file stands in for the pinned binary; this test does not execute it.
    const binary = path.join(directory, "binary"); await writeFile(binary, "binary");
    const prompt = "play";
    const config = { provider: CLAUDE_PROVIDER, claude_policy: CLAUDE_POLICY, claude_version: "2.1.258", claude_executable: binary,
      claude_sha256: digest("binary"), provider_runtime: await providerRuntimeHashes(projectRoot),
      model, effort: "low", tools_enabled: false, action_limit: 2, start_room: "HxI", effective_prompt_sha256: digest(prompt) };
    const metadata = { ...config, integrity: await createRunIntegrity(projectRoot, directory, config) };
    await writeFile(path.join(directory, "prompt.md"), prompt);
    await BenchmarkGameRuntime.create(projectRoot, directory, { actionLimit: 2 });
    await verifyClaudeIntegrity(projectRoot, directory, metadata);
    await assert.rejects(() => verifyClaudeIntegrity(projectRoot, directory, { ...metadata, provider: "codex" }), /provider/);
    await assert.rejects(() => verifyClaudeIntegrity(projectRoot, directory, { ...metadata, tools_enabled: true }), /configuration/);
    await writeFile(binary, "changed");
    await assert.rejects(() => verifyClaudeIntegrity(projectRoot, directory, metadata), /executable/);
    await writeFile(binary, "binary");
    await writeFile(path.join(directory, "prompt.md"), "cheat");
    await assert.rejects(() => verifyClaudeIntegrity(projectRoot, directory, metadata), /prompt/);
    await writeFile(path.join(directory, "prompt.md"), prompt);
    const file = path.join(directory, "integrity.json"), manifest = JSON.parse(await readFile(file));
    manifest.configuration.provider_runtime["benchmarking/providers/claude-policy.mjs"] = "wrong";
    const encoded = JSON.stringify(manifest); await writeFile(file, encoded);
    await assert.rejects(() => verifyClaudeIntegrity(projectRoot, directory, { ...metadata, integrity: { ...metadata.integrity, manifest_sha256: digest(encoded) } }), /provider runtime/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Claude telemetry counts cache input once and replaces provisional usage with turn totals", () => {
  const timeline = createClaudeTimeline(); let clock = Date.now();
  const consume = event => consumeClaudeEvent(timeline, { _turn_id: "a", _received_at: new Date(clock++).toISOString(), ...event });
  consume({ type: "stream_event", event: { type: "message_start", message: { id: "one", usage: { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 20 } } } });
  consume({ type: "assistant", message: { id: "one", usage: { input_tokens: 10 } } });
  consume({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 15 } } });
  consume({ type: "stream_event", event: { type: "message_stop" } });
  let telemetry = claudeTelemetry(timeline, model);
  assert.equal(telemetry.totals.input_tokens, 60); assert.equal(telemetry.totals.output_tokens, 15);
  assert.equal(telemetry.samples.length, 1); assert.equal(telemetry.current_tokens, 75);
  consume({ type: "result", total_cost_usd: .12, usage: { input_tokens: 12, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 18 }, modelUsage: { [model]: { contextWindow: 1000000 } } });
  consume({ type: "result", total_cost_usd: .12, usage: { input_tokens: 12, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 18 } });
  consume({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 75 } });
  consume({ _turn_id: "b", type: "stream_event", event: { type: "message_start", message: { id: "two", usage: { input_tokens: 5, output_tokens: 1 } } } });
  consume({ _turn_id: "b", type: "stream_event", event: { type: "message_stop" } });
  telemetry = claudeTelemetry(timeline, model);
  assert.equal(telemetry.totals.input_tokens, 67); assert.equal(telemetry.totals.output_tokens, 19);
  assert.equal(telemetry.api_estimate.usd, .12002); assert.equal(telemetry.samples.length, 2);
  assert.equal(telemetry.compactions[0].after_tokens, 6); assert.equal(telemetry.compaction_threshold, null);
});
