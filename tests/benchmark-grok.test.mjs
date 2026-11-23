import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GROK_POLICY,
  GROK_PROVIDER,
  buildGrokArguments,
  createGrokBoundaryValidator,
  digest,
  grokEnvironment,
  grokModelsPolicyDigest,
  grokRuntimeHashes,
  grokSettingsPolicyDigest,
  setGrokConfigImmutable,
  verifyGrokIntegrity,
  verifyStoredGrokToolCatalog
} from "../benchmarking/grok/policy.mjs";
import { BenchmarkSupervisor, grokConfig } from "../benchmarking/grok/supervisor.mjs";
import { createRunIntegrity } from "../benchmarking/v1/integrity.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { LIVE_WORLD_POLICY } from "../benchmarking/storage/live-world.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const model = "grok-4.7";
const cwd = "/tmp/grok-test-agent";
const init = (overrides = {}) => ({
  type: "system", subtype: "init", session_id: randomUUID(), apiKeySource: "oauth", model,
  cwd, permissionMode: "dontAsk", tools: ["search_tool", "use_tool"],
  slash_commands: ["compact", "always-approve", "context", "session-info", "goal"],
  mcp_servers: [{ name: "mazebench", status: "pending" }], skills: [], ...overrides
});
const assistant = (session, content) => ({ type: "assistant", parent_tool_use_id: null, session_id: session,
  message: { id: randomUUID(), role: "assistant", model, content } });

test("Grok Build selection is limited to Grok 4.7, Main World, and ASCII", async () => {
  const supervisor = new BenchmarkSupervisor(projectRoot);
  const spec = await supervisor.validateSpec({ provider: GROK_PROVIDER, model, effort: "xhigh", tools_enabled: true, action_limit: 100 });
  assert.equal(spec.provider, GROK_PROVIDER);
  assert.equal(spec.toolsEnabled, true);
  assert.equal(spec.world, "main-world");
  for (const bad of [
    { provider: GROK_PROVIDER, model: "grok-4.6" },
    { provider: GROK_PROVIDER, model, effort: "max" },
    { provider: GROK_PROVIDER, model, world: "ice-maze" },
    { provider: GROK_PROVIDER, model, observation_mode: "vision" },
    { provider: GROK_PROVIDER, model, service_tier: "fast" }
  ]) await assert.rejects(() => supervisor.validateSpec(bad));
});

test("Grok launch has only the MCP gateways and excludes inherited overrides", () => {
  for (const resume of [false, true]) {
    const identity = randomUUID();
    const childIdentity = randomUUID();
    const args = buildGrokArguments({ model, effort: "high", toolsEnabled: true, prompt: "Play", sessionId: resume ? childIdentity : identity, ...(resume ? { resumeSessionId: identity } : {}) });
    const value = flag => args[args.indexOf(flag) + 1];
    assert.equal(value("--tools"), "search_tool,use_tool");
    assert.equal(value("--permission-mode"), "dontAsk");
    assert.equal(value("--sandbox"), "off");
    assert.equal(value("--allow"), "MCPTool(mazebench__*)");
    if (resume) {
      assert(!args.includes("-m"));
      assert(!args.includes("--reasoning-effort"));
    } else {
      assert.equal(value("-m"), model);
      assert.equal(value("--reasoning-effort"), "high");
    }
    for (const flag of ["--no-subagents", "--disable-web-search", "--no-plan", "--verbatim", "--no-auto-update"]) assert(args.includes(flag));
    for (const dangerous of ["run_terminal_command", "read_file", "write_file", "web_search", "Agent"]) assert(value("--disallowed-tools").split(",").includes(dangerous));
    assert.equal(value(resume ? "--resume" : "--session-id"), identity);
    if (resume) {
      assert(args.includes("--fork-session"));
      assert.equal(value("--session-id"), childIdentity);
    }
  }
  const keys = ["XAI_API_KEY", "GROK_CONFIG", "GROK_CONFIG_PATH", "GROK_WS_URL", "NODE_OPTIONS", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "malicious";
    const env = grokEnvironment("/tmp/isolated-grok-home");
    for (const key of keys) assert.equal(env[key], undefined);
    assert.equal(env.GROK_HOME, "/tmp/isolated-grok-home");
    assert.equal(env.GROK_AGENT_DASHBOARD, "0");
  } finally {
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

test("Grok isolated configuration disables personal capabilities and allowlists one MCP", () => {
  const config = grokConfig({ projectRoot, runDirectory: "/tmp/run", grokHome: "/tmp/grok-home" });
  for (const text of ["backend_tools = false", "write_file = false", "enabled = false", "official_marketplace_auto_installed = false", "[mcp_servers.mazebench]"]) assert(config.includes(text));
  assert(!config.includes("xai_api_key"));
  assert.match(config, /remote_fetch = true/);
  assert.match(config, /ignore = \["\/tmp\/grok-home\/bundled\/skills"\]/);
  assert.match(config, /allow_managed_mcp_servers_only = true/);
  assert.match(config, /server_name = "mazebench"/);
  assert.match(config, /\[subagents\]\nenabled = false/);
});

test("Grok signed-cache policy digests ignore refresh clocks but not capability changes", () => {
  const models = { fetched_at: "a", renewed_at: "b", identity: "account", models: [{ id: model }] };
  assert.equal(
    grokModelsPolicyDigest(JSON.stringify(models)),
    grokModelsPolicyDigest(JSON.stringify({ ...models, fetched_at: "c", renewed_at: "d" }))
  );
  assert.notEqual(
    grokModelsPolicyDigest(JSON.stringify(models)),
    grokModelsPolicyDigest(JSON.stringify({ ...models, models: [{ id: "grok-4.6" }] }))
  );
  const settings = overrides => JSON.stringify({ payload: JSON.stringify({ fetched_at: overrides.fetched_at, identity: "account", settings: { default_model: overrides.default_model } }), signature: overrides.signature });
  assert.equal(
    grokSettingsPolicyDigest(settings({ fetched_at: "a", default_model: model, signature: "one" })),
    grokSettingsPolicyDigest(settings({ fetched_at: "b", default_model: model, signature: "two" }))
  );
  assert.notEqual(
    grokSettingsPolicyDigest(settings({ fetched_at: "a", default_model: model, signature: "one" })),
    grokSettingsPolicyDigest(settings({ fetched_at: "a", default_model: "grok-4.6", signature: "one" }))
  );
});

test("Grok event boundary admits only validated MazeBench discovery and calls", () => {
  const validate = createGrokBoundaryValidator({ model, toolsEnabled: false, cwd });
  const start = init();
  assert.equal(validate(start), null);
  const search = assistant(start.session_id, [{ type: "thinking", thinking: "observe" }, { type: "tool_use", id: "search-1", name: "search_tool", input: { query: "maze observe", limit: 5 } }]);
  assert.equal(validate(search), null);
  const discovery = { type: "user", parent_tool_use_id: null, session_id: start.session_id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "search-1", is_error: false,
    content: JSON.stringify({ type: "SearchTool", content: JSON.stringify({ results: [{ server: "mazebench", tools: [{ tool_name: "mazebench__maze_observe" }] }] }) }) }] } };
  assert.equal(validate(discovery), null);
  assert.equal(validate(assistant(start.session_id, [{ type: "tool_use", id: "use-1", name: "use_tool", input: { tool_name: "mazebench__maze_observe", tool_input: {} } }])), null);
  assert.equal(validate({ type: "user", parent_tool_use_id: null, session_id: start.session_id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "use-1", is_error: false,
    content: JSON.stringify({ type: "MCP", server_name: "mazebench", tool_name: "maze_observe", output: {} }) }] } }), null);
  assert.equal(validate({ type: "system", subtype: "compact_boundary", session_id: start.session_id, uuid: randomUUID(), compact_metadata: { trigger: "auto", pre_tokens: 406176 } }), null);
  assert.equal(validate({ type: "result", session_id: start.session_id, is_error: false, usage: { server_tool_use: { web_search_requests: 0 } }, modelUsage: { "grok-4.7-build": {} } }), null);
});

test("Grok resume accepts the CLI's empty init advertisement only after validating its stored gateway catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-catalog-"));
  const session = randomUUID();
  const directory = path.join(root, "sessions", encodeURIComponent(cwd), session);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "tool_definitions.json"), JSON.stringify([
    { type: "function", function: { name: "search_tool" } },
    { type: "function", function: { name: "use_tool" } }
  ]));
  try {
    assert.equal(verifyStoredGrokToolCatalog(root, cwd, session), true);
    const resumed = createGrokBoundaryValidator({ model, cwd, resuming: true });
    assert.equal(resumed(init({ session_id: randomUUID(), tools: [], slash_commands: [] })), null);
    const fresh = createGrokBoundaryValidator({ model, cwd });
    assert.equal(fresh(init({ session_id: randomUUID(), tools: [], slash_commands: [] })), null);
    const expanded = createGrokBoundaryValidator({ model, cwd });
    assert.match(expanded(init({ session_id: randomUUID(), tools: ["search_tool", "use_tool", "run_terminal_command"] })), /Unexpected Grok tool catalog/);
    await writeFile(path.join(directory, "tool_definitions.json"), JSON.stringify([
      { type: "function", function: { name: "search_tool" } },
      { type: "function", function: { name: "run_terminal_command" } }
    ]));
    assert.throws(() => verifyStoredGrokToolCatalog(root, cwd, session), /Unsafe stored Grok tool catalog/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Grok event boundary rejects fallback, built-ins, delegation, files, web, and extra MCP tools", () => {
  const afterInit = (toolsEnabled = false) => {
    const validate = createGrokBoundaryValidator({ model, toolsEnabled, cwd });
    const start = init();
    assert.equal(validate(start), null);
    return { validate, start };
  };
  for (const bad of [
    init({ model: "grok-4.6" }),
    init({ apiKeySource: "api_key" }),
    init({ tools: ["search_tool", "use_tool", "run_terminal_command"] }),
    init({ mcp_servers: [{ name: "personal", status: "connected" }] }),
    init({ skills: ["solver"] }),
    init({ slash_commands: ["compact", "dangerous-plugin-command"] })
  ]) assert(createGrokBoundaryValidator({ model, cwd })(bad));
  for (const block of [
    { type: "tool_use", id: "x", name: "run_terminal_command", input: {} },
    { type: "tool_use", id: "x", name: "use_tool", input: { tool_name: "mazebench__python_exec", tool_input: {} } },
    { type: "tool_use", id: "x", name: "use_tool", input: { tool_name: "other__solver", tool_input: {} } },
    { type: "tool_use", id: "x", name: "use_tool", input: { tool_name: "mazebench__maze_observe", tool_input_file: "/tmp/call.json" } }
  ]) {
    const { validate, start } = afterInit(false);
    assert(validate(assistant(start.session_id, [block])));
  }
  {
    const { validate, start } = afterInit();
    assert(validate({ ...assistant(start.session_id, []), parent_tool_use_id: "agent" }));
  }
  {
    const { validate, start } = afterInit();
    assert(validate({ type: "system", subtype: "compact_boundary", session_id: start.session_id, uuid: randomUUID(), compact_metadata: { trigger: "manual", pre_tokens: 10 } }));
  }
  {
    const { validate, start } = afterInit();
    assert(validate({ type: "result", session_id: start.session_id, usage: {}, modelUsage: { "grok-4.6": {} } }));
  }
  {
    const { validate, start } = afterInit();
    assert(validate({ type: "result", session_id: start.session_id, usage: { server_tool_use: { web_search_requests: 1 } }, modelUsage: { "grok-4.7-build": {} } }));
  }
  {
    const { validate, start } = afterInit();
    assert.equal(validate(assistant(start.session_id, [{ type: "tool_use", id: "search", name: "search_tool", input: { query: "maze" } }])), null);
    assert(validate({ type: "user", session_id: start.session_id, message: { content: [{ type: "tool_result", tool_use_id: "search",
      content: JSON.stringify({ type: "SearchTool", content: JSON.stringify({ results: [{ server: "mazebench", tools: [{ tool_name: "mazebench__evil_tool" }] }] }) }) }] } }));
  }
});

test("Grok runs freeze the CLI, provider source, prompt, config, and condition", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "maze-grok-integrity-"));
  const directory = path.join(temporary, "run");
  const home = path.join(temporary, "grok-home");
  await Promise.all([mkdir(directory), mkdir(home)]);
  try {
    const binary = path.join(temporary, "grok");
    const prompt = "play";
    const configText = grokConfig({ projectRoot, runDirectory: directory });
    const modelsText = JSON.stringify({ models: [{ id: model }] });
    const settingsText = JSON.stringify({
      payload: JSON.stringify({ fetched_at: "2026-09-21T00:00:00Z", grok_version: "1.0.40", identity: "test", origin: "test", client: "grok-shell", settings: { default_model: model } }),
      signature: "test"
    });
    await Promise.all([
      writeFile(binary, "binary"),
      writeFile(path.join(home, "config.toml"), configText),
      writeFile(path.join(home, "models_cache.json"), modelsText),
      writeFile(path.join(home, "settings_cache.json"), settingsText),
      writeFile(path.join(directory, "prompt.md"), prompt)
    ]);
    const configuration = {
      storage_format: "incremental-v1", world_updates: LIVE_WORLD_POLICY,
      world: "main-world", observation_mode: "ascii", provider: GROK_PROVIDER, grok_policy: GROK_POLICY,
      grok_executable: binary, grok_version: "1.0.40", grok_sha256: digest("binary"), grok_home: home,
      grok_config: path.join(home, "config.toml"), grok_config_sha256: digest(configText), grok_models_sha256: digest(modelsText),
      grok_models_policy_sha256: grokModelsPolicyDigest(modelsText),
      grok_settings_sha256: digest(settingsText),
      grok_settings_policy_sha256: grokSettingsPolicyDigest(settingsText),
      grok_runtime: await grokRuntimeHashes(projectRoot), model, effort: "low", tools_enabled: false,
      service_tier: null, action_limit: 2, start_room: "HxI", effective_prompt_sha256: digest(prompt)
    };
    const metadata = { ...configuration, integrity: await createRunIntegrity(projectRoot, directory, configuration) };
    await BenchmarkGameRuntime.create(projectRoot, directory, { actionLimit: 2, incremental: true });
    await chmod(path.join(home, "config.toml"), 0o400);
    setGrokConfigImmutable(path.join(home, "config.toml"));
    await verifyGrokIntegrity(projectRoot, directory, metadata);
    await assert.rejects(() => verifyGrokIntegrity(projectRoot, directory, { ...metadata, tools_enabled: true }), /configuration/);
    setGrokConfigImmutable(path.join(home, "config.toml"), false);
    await chmod(path.join(home, "config.toml"), 0o600);
    await writeFile(path.join(home, "config.toml"), `${configText}\n# changed\n`);
    await chmod(path.join(home, "config.toml"), 0o400);
    setGrokConfigImmutable(path.join(home, "config.toml"));
    await assert.rejects(() => verifyGrokIntegrity(projectRoot, directory, metadata), /configuration changed/);
    setGrokConfigImmutable(path.join(home, "config.toml"), false);
    await chmod(path.join(home, "config.toml"), 0o600);
    await writeFile(path.join(home, "config.toml"), configText);
    await chmod(path.join(home, "config.toml"), 0o400);
    setGrokConfigImmutable(path.join(home, "config.toml"));
    await writeFile(binary, "changed");
    await assert.rejects(() => verifyGrokIntegrity(projectRoot, directory, metadata), /executable changed/);
    await writeFile(binary, "binary");
    await writeFile(path.join(directory, "prompt.md"), "changed");
    await assert.rejects(() => verifyGrokIntegrity(projectRoot, directory, metadata), /prompt changed/);
    const manifestFile = path.join(directory, "integrity.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.configuration.grok_runtime["benchmarking/grok/policy.mjs"] = "wrong";
    const encoded = JSON.stringify(manifest);
    await writeFile(manifestFile, encoded);
    await assert.rejects(() => verifyGrokIntegrity(projectRoot, directory, { ...metadata, integrity: { ...metadata.integrity, manifest_sha256: digest(encoded) } }), /provider runtime/);
  } finally {
    const config = path.join(home, "config.toml");
    if (process.platform === "darwin") {
      try { setGrokConfigImmutable(config, false); } catch {}
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
