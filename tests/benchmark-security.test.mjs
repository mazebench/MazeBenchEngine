import "../benchmarking/codex-releases.mjs";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, symlink, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSandboxedPython, preflightPythonSandbox, workspaceInventory } from "../benchmarking/v1/python-sandbox.mjs";
import { createRunIntegrity, verifyRunIntegrity, verifyCheckpoint, signCheckpoint, assertRunConfiguration, CAPABILITY_POLICY_VERSION } from "../benchmarking/v1/integrity.mjs";
import { buildCodexArguments, buildInterviewArguments, assertHardenedCodexArguments, eventBoundaryViolation, publicRunError, BenchmarkSupervisor, isRecoverableCompactionError } from "../benchmarking/v1/supervisor.mjs";
import { checkLatestCodex, codexInstallationStatus, inspectCodex } from "../benchmarking/v1/codex-installation.mjs";
import { isTrustedLocalRequest } from "../benchmarking/v1/http-security.mjs";
import { BenchmarkGameRuntime, loadBenchmarkAssets } from "../benchmarking/v1/runtime.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function fixture() {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), "mazebench-security-"));
  const options = { projectRoot, runDirectory, workspace: path.join(runDirectory, "workspace"), stateDirectory: path.join(runDirectory, "sandbox-state"), scriptPath: "probe.py", timeoutSeconds: 5 };
  await mkdir(options.workspace);
  await mkdir(options.stateDirectory);
  return options;
}

test("OS confinement survives removal of the Python audit hook, including native calls", { skip: process.platform !== "darwin" }, async () => {
  const options = await fixture();
  const privatePath = path.join(options.runDirectory, "private-canary.txt");
  await writeFile(privatePath, "private");
  try {
    const result = runSandboxedPython(`
import __main__, ctypes, os, socket, subprocess, sys, json
__main__._deny_escape.__code__ = (lambda event, args: None).__code__
r = {}
for name, action in [
    ("read", lambda: open(${JSON.stringify(privatePath)}).read()),
    ("write", lambda: open(${JSON.stringify(privatePath)}, "w").write("changed")),
    ("process", lambda: subprocess.run(["/usr/bin/true"])),
    ("python_reexec", lambda: subprocess.run([sys.executable, "-c", "print('escape')"])),
    ("fork", os.fork),
    ("network", lambda: socket.create_connection(("127.0.0.1", 8080), timeout=.2)),
]:
    try: action(); r[name] = False
    except PermissionError: r[name] = True
libc = ctypes.CDLL(None, use_errno=True)
r["native_open"] = libc.open(${JSON.stringify(privatePath)}.encode(), 0) == -1 and ctypes.get_errno() in (1, 13)
libc.fork.restype = ctypes.c_int
r["native_fork"] = libc.fork() == -1 and ctypes.get_errno() in (1, 13)
print(json.dumps(r))
`, options);
    assert.equal(result.exit_code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { read: true, write: true, process: true, python_reexec: true, fork: true, network: true, native_open: true, native_fork: true });
    assert.equal(await readFile(privatePath, "utf8"), "private");
    const preflight = preflightPythonSandbox(options);
    assert.equal(preflight.audit_hook_bypass_tested, true);
    assert.equal(preflight.backend, "macos-seatbelt");
  } finally { await rm(options.runDirectory, { recursive: true, force: true }); }
});

test("agent-created symlinks cannot make the trusted script writer overwrite private state", { skip: process.platform !== "darwin" }, async () => {
  const options = await fixture();
  const target = path.join(options.runDirectory, "private-canary.json");
  await writeFile(target, "unchanged");
  try {
    const result = runSandboxedPython(`import __main__, os
__main__._deny_escape.__code__ = (lambda event, args: None).__code__
os.symlink(${JSON.stringify(target)}, "linked.py")
`, options);
    assert.equal(result.exit_code, 0, result.stderr);
    assert.throws(() => runSandboxedPython("print('overwritten')", { ...options, scriptPath: "linked.py" }), /links/);
    assert.equal(await readFile(target, "utf8"), "unchanged");
  } finally { await rm(options.runDirectory, { recursive: true, force: true }); }
});

test("script writer rejects parent links, hardlinks, workspace substitution and inventories never follow links", async () => {
  const options = await fixture();
  const external = path.join(options.runDirectory, "private");
  await mkdir(external);
  const target = path.join(external, "canary.py");
  await writeFile(target, "unchanged");
  try {
    await symlink(external, path.join(options.workspace, "parent"));
    await link(target, path.join(options.workspace, "hard.py"));
    await symlink(options.workspace, path.join(options.workspace, "loop"));
    assert.throws(() => runSandboxedPython("print(1)", { ...options, scriptPath: "parent/canary.py" }), /symbolic links/);
    assert.throws(() => runSandboxedPython("print(1)", { ...options, scriptPath: "hard.py" }), /hard links/);
    assert.deepEqual(workspaceInventory(options.workspace), []);
    assert.equal(await readFile(target, "utf8"), "unchanged");
    await rm(options.workspace, { recursive: true });
    await symlink(external, options.workspace);
    assert.throws(() => runSandboxedPython("print(1)", options), /symbolic links/);
    assert.throws(() => workspaceInventory(options.workspace), /symbolic links/);
  } finally { await rm(options.runDirectory, { recursive: true, force: true }); }
});

test("all modes reject altered state, score, configuration and runtime manifests", async () => {
  for (const toolsEnabled of [false, true]) {
    const options = await fixture();
    const configuration = { model: "gpt-6-astra", effort: "low", tools_enabled: toolsEnabled, action_limit: 3, start_room: "HxI", effective_prompt_sha256: "test" };
    try {
      const integrity = await createRunIntegrity(projectRoot, options.runDirectory, configuration);
      const runtime = await BenchmarkGameRuntime.create(projectRoot, options.runDirectory, { actionLimit: 3 });
      const manifest = await verifyRunIntegrity(projectRoot, options.runDirectory, integrity);
      assertRunConfiguration(configuration, manifest);
      for (const key of Object.keys(configuration)) {
        assert.throws(() => assertRunConfiguration({ ...configuration, [key]: "changed" }, manifest), /configuration changed/);
      }
      verifyCheckpoint(options.runDirectory);
      await runtime.apply("camera left");
      verifyCheckpoint(options.runDirectory);
      const stateFile = path.join(options.runDirectory, "game-state.json");
      const original = await readFile(stateFile);
      const state = JSON.parse(original);
      state.actionCount = 0;
      await writeFile(stateFile, JSON.stringify(state));
      assert.throws(() => verifyCheckpoint(options.runDirectory), /modified outside the engine/);
      await writeFile(stateFile, original);
      await writeFile(path.join(options.runDirectory, "summary.json"), '{"gems_collected":100}');
      assert.throws(() => verifyCheckpoint(options.runDirectory), /modified outside the engine/);
      const manifestFile = path.join(options.runDirectory, "integrity.json");
      manifest.files["benchmarking/v1/runtime.mjs"] = "bad hash";
      await writeFile(manifestFile, JSON.stringify(manifest));
      await assert.rejects(() => verifyRunIntegrity(projectRoot, options.runDirectory, integrity), /manifest changed/);
      await assert.rejects(() => verifyRunIntegrity(projectRoot, options.runDirectory), /runtime changed/);
    } finally { await rm(options.runDirectory, { recursive: true, force: true }); }
  }
});

test("a new run loads edited world assets while an existing run retains its authored snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mazebench-authored-world-"));
  try {
    await mkdir(path.join(root, "engine", "v1"), { recursive: true });
    await cp(path.join(projectRoot, "engine", "v1", "voxel_physics.wasm"), path.join(root, "engine", "v1", "voxel_physics.wasm"));
    await cp(path.join(projectRoot, "level-data", "v2"), path.join(root, "level-data", "v2"), { recursive: true });
    const before = await loadBenchmarkAssets(root);
    const manifestFile = path.join(root, "level-data", "v2", "main-world", "world.json");
    const authored = JSON.parse(await readFile(manifestFile, "utf8"));
    authored.blocks[0].name = "edited-fixture";
    await writeFile(manifestFile, JSON.stringify(authored));
    const after = await loadBenchmarkAssets(root);
    assert.equal(after.blocks[0].name, "edited-fixture");
    assert.notEqual(before.blocks[0].name, "edited-fixture");
    assert.notEqual(before.engine, after.engine);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const argsOptions = { projectRoot, runDirectory: "/tmp/maze-security", agentDirectory: "/tmp/maze-security/agent-cwd", modelCatalogPath: "/tmp/maze-security/sandbox-state/direct-model-catalog.json", model: "gpt-6-astra", effort: "low", prompt: "test" };

test("new, resumed and interview launch arguments reject capability overrides", () => {
  for (const args of [
    buildCodexArguments({ ...argsOptions, toolsEnabled: false }),
    buildCodexArguments({ ...argsOptions, toolsEnabled: true, resumeThreadId: "same-thread" }),
    buildInterviewArguments({ ...argsOptions, forkThreadId: "fork", outputFile: "/tmp/interview.txt", question: "test" })
  ]) {
    assertHardenedCodexArguments(args, argsOptions);
    assert(!args.includes("features.remote_compaction_v2=true"));
    for (const override of ['mcp_servers.evil.enabled=true', 'sandbox_mode="danger-full-access"', 'model_provider="untrusted"', 'features.code_mode.enabled=true']) {
      assert.throws(() => assertHardenedCodexArguments([...args, "-c", override], argsOptions));
    }
    assert.throws(() => assertHardenedCodexArguments([...args, "--enable", "shell_tool"], argsOptions));
    assert.throws(() => assertHardenedCodexArguments(args.filter(x => x !== "--ignore-user-config"), argsOptions));
  }
});

test("legacy compaction inventory is upgraded without enabling agent capabilities", () => {
  const legacy = { ...argsOptions, disabledFeatures: ["remote_compaction_v2", "future_executor"], enabledFeatures: ["remote_compaction_v2"] };
  const args = buildCodexArguments(legacy);
  assert(args.includes("features.remote_compaction_v2=true"));
  assert(!args.some((value, index) => value === "--disable" && args[index + 1] === "remote_compaction_v2"));
  assert.throws(() => assertHardenedCodexArguments([...args, "--disable", "remote_compaction_v2"], legacy));
  assert(args.some((value, index) => value === "--disable" && args[index + 1] === "future_executor"));
  assert.equal(isRecoverableCompactionError('Error running remote compact task: unexpected status 404 Not Found, url: https://chatgpt.com/backend-api/codex/responses/compact, request id: fixture'), true);
  for (const error of ["Capability boundary violation", "Benchmark state or score was modified", "404 Not Found", "Error running remote compact task: status 403 Forbidden"]) {
    assert.equal(isRecoverableCompactionError(error), false);
  }
});

test("Fast mode preserves the tool boundary on new and resumed runs and requires a signed selection", () => {
  const disabledFeatures = ["fast_mode", "shell_tool", "code_mode", "code_mode_host", "future_executor"];
  for (const toolsEnabled of [false, true]) {
    for (const resumeThreadId of [undefined, "same-thread"]) for (const enabledFeatures of [[], ["fast_mode", "remote_compaction_v2"]]) {
      const options = { ...argsOptions, toolsEnabled, resumeThreadId, disabledFeatures, enabledFeatures, serviceTier: "fast" };
      const args = buildCodexArguments(options);
      assertHardenedCodexArguments(args, options);
      assert(args.includes('service_tier="fast"'));
      assert.equal(args.filter(value => value === "features.fast_mode=true").length, 1);
      assert(args.includes('model_reasoning_effort="low"'));
      for (const feature of disabledFeatures.filter(feature => feature !== "fast_mode")) {
        assert(args.some((value, i) => value === "--disable" && args[i + 1] === feature));
      }
      assert.throws(() => assertHardenedCodexArguments(args, { ...options, serviceTier: undefined }), /service tier/);
      assert.throws(() => assertHardenedCodexArguments([...args, "--disable", "fast_mode"], options), /Fast service tier/);
      assert.throws(() => assertHardenedCodexArguments([...args, "-c", "features.code_mode.enabled=true"], options));
      assert.throws(() => assertHardenedCodexArguments([...args, "--enable", "shell_tool"], options));
    }
  }
  assert.throws(() => buildCodexArguments({ ...argsOptions, serviceTier: "unreviewed" }), /Unsupported benchmark service tier/);
  const config = { model: "gpt-6-astra", effort: "max", tools_enabled: false, action_limit: null, start_room: "HxI", effective_prompt_sha256: "test" };
  assertRunConfiguration(config, { configuration: config });
  assertRunConfiguration({ ...config, service_tier: "fast" }, { configuration: { ...config, service_tier: "fast" } });
  assert.throws(() => assertRunConfiguration({ ...config, service_tier: "fast" }, { configuration: config }), /configuration changed/);
  assert.throws(() => assertRunConfiguration(config, { configuration: { ...config, service_tier: "fast" } }), /configuration changed/);
});

test("unexpected tools invalidate benchmark turns and all interview tool calls", () => {
  const event = tool => ({ type: "item.started", item: { type: "mcp_tool_call", server: "mazebench", tool } });
  assert.equal(eventBoundaryViolation(event("maze_action")), null);
  assert.equal(eventBoundaryViolation(event("python_exec"), { toolsEnabled: true }), null);
  assert.match(eventBoundaryViolation(event("python_exec")), /violation/);
  assert.match(eventBoundaryViolation(event("maze_observe"), { interview: true }), /violation/);
  assert.match(eventBoundaryViolation({ type: "item.started", item: { type: "command_execution" } }), /violation/);
  assert.match(eventBoundaryViolation({ type: "item.started", item: { type: "future_tool" } }), /violation/);
  assert.equal(eventBoundaryViolation({ type: "item.completed", item: { type: "agent_message" } }, { interview: true }), null);
});

test("version checker distinguishes current, outdated, unsupported and offline results", async () => {
  const fetchRelease = version => async () => ({ ok: true, json: async () => ({ tag_name: `rust-v${version}` }) });
  const installed = inspectCodex("codex");
  const current = await codexInstallationStatus("codex", { force: true, fetchRelease: fetchRelease(installed.version.replace("codex-cli ", "")) });
  assert.equal(current.version, installed.version);
  assert.equal(current.update_status, "up-to-date");
  assert.equal(current.tested, true);
  const outdated = await codexInstallationStatus("codex", { force: true, fetchRelease: fetchRelease("99.0.0") });
  assert.equal(outdated.update_status, "update-available");
  const offline = await codexInstallationStatus("codex", { force: true, fetchRelease: async () => { throw new Error("offline"); } });
  assert.equal(offline.update_status, "unknown");
  assert.equal(offline.latest_version, null);
  const invalid = await checkLatestCodex({ force: true, fetchRelease: fetchRelease("not-a-version") });
  assert.match(invalid.error, /invalid stable version/);
  assert.equal((await codexInstallationStatus("/does/not/exist")).available, false);
});

test("localhost API rejects DNS rebinding and foreign origins", () => {
  const request = headers => ({ headers });
  assert.equal(isTrustedLocalRequest(request({ host: "localhost:8080", origin: "http://localhost:8080" }), 8080), true);
  assert.equal(isTrustedLocalRequest(request({ host: "127.0.0.1:8080" }), 8080), true);
  assert.equal(isTrustedLocalRequest(request({ host: "evil.test:8080" }), 8080), false);
  assert.equal(isTrustedLocalRequest(request({ host: "localhost:8080", origin: "https://evil.test" }), 8080), false);
  assert.equal(isTrustedLocalRequest(request({ host: "localhost:8080", "sec-fetch-site": "cross-site" }), 8080), false);
});

test("run failure details extract service errors instead of just displaying failed", () => {
  const message = "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade.";
  assert.equal(publicRunError(JSON.stringify({ type: "error", error: { message } })), message);
  assert.equal(publicRunError(`Warning: prewarm failed: ${JSON.stringify({ error: { message } })}`), message);
});
