import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { codingMode, codingLabel, supportsAnyLanguage } from "../benchmarking/coding-mode.mjs";
import { normalizeCodePath, validateCodeInput, containerArguments, inspectCodeSandbox, runSandboxedCode, preflightCodeSandbox } from "../benchmarking/code/sandbox.mjs";
import { codeTools, CODE_POLICY, codeRuntimeHashes, verifyCodeIntegrity, buildCodeCodexArguments, assertCodeCodexArguments, buildCodeClaudeArguments, codeCodexBoundaryViolation, createCodeClaudeValidator } from "../benchmarking/code/policy.mjs";
import { codePrompt } from "../benchmarking/code/prompt.mjs";
import { previewBenchmarkPrompt } from "../benchmarking/prompt-preview.mjs";
import { BenchmarkSupervisor } from "../benchmarking/code/supervisor.mjs";
import { createRunIntegrity } from "../benchmarking/v1/integrity.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { IceBenchmarkRuntime } from "../ice-maze/v1/benchmark-runtime.mjs";
import { SlotskiBenchmarkRuntime } from "../slotski/v1/benchmark-runtime.mjs";
import { digest, providerRuntimeHashes, CLAUDE_POLICY } from "../benchmarking/providers/claude-policy.mjs";
import { atomicJson, readJson } from "../benchmarking/providers/claude-runner.mjs";
import { worldRuntimeHashes as iceHashes } from "../benchmarking/worlds/policy.mjs";
import { worldRuntimeHashes as slotskiHashes } from "../benchmarking/slotski/policy.mjs";
import { RunLibrary } from "../benchmarking/run-library.mjs";
import { RunDashboard } from "../benchmarking/run-dashboard.mjs";
import { runCardValues } from "../benchmarking/ui/run-library.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dockerEnabled = process.env.MAZEBENCH_TEST_CODE_SANDBOX === "1";
const image = `sha256:${"a".repeat(64)}`;
async function temp(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mazebench-code-"));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

test("three explicit conditions preserve old boolean records without conflating any-language runs", () => {
  assert.equal(codingMode({ tools_enabled: true }), "python");
  assert.equal(codingMode({ tools_enabled: false }), "off");
  assert.equal(codingMode({ coding_mode: "any", tools_enabled: true }), "any");
  assert.equal(codingLabel({ coding_mode: "any" }), "Any language");
  assert.equal(codingLabel({ provider: "prime-agent" }), "Native Python");
  assert.throws(() => codingMode({ coding_mode: "shell" }));
  assert(supportsAnyLanguage({ provider: "claude-code", world: "slotski" }));
  assert(!supportsAnyLanguage({ provider: "prime-agent" }));
  assert(!supportsAnyLanguage({ observation_mode: "vision" }));
});
test("source validation rejects traversal, shell-option paths, duplicates and unbounded input", () => {
  assert.equal(normalizeCodePath("src/solver.cpp"), "src/solver.cpp");
  for (const value of ["../hidden", "/etc/passwd", "x/../y", "x//y", ".commands/override.sh", "foo\nbar", ""]) assert.throws(() => normalizeCodePath(value));
  for (const input of [{}, { command: "echo ok", timeout_seconds: 61 }, { command: "x".repeat(256001) },
    { command: "echo", files: [{ path: "x", content: "a" }, { path: "x", content: "b" }] }, { command: "echo", host: "/" }]) assert.throws(() => validateCodeInput(input));
});
test("container launch pins the toolchain, limits resources, and mounts only the workspace", () => {
  const args = containerArguments({ workspace: "/safe/run/workspace", name: "test", image, script: ".commands/run.sh", timeout: 5 });
  const value = key => args[args.indexOf(key) + 1];
  assert.equal(value("--network"), "none"); assert(args.includes("--read-only"));
  assert.equal(value("--cap-drop"), "ALL"); assert.equal(value("--security-opt"), "no-new-privileges=true");
  assert.equal(value("--pids-limit"), "64"); assert.equal(value("--memory"), "1073741824");
  assert.equal(args.filter(arg => arg === "--mount").length, 1);
  assert.equal(value("--mount"), "type=bind,source=/safe/run/workspace,target=/workspace");
  assert(args.includes(image)); assert(args.includes("/usr/bin/timeout")); assert(args.includes("5s"));
  assert.throws(() => containerArguments({ workspace: "/safe", image: "latest" }), /immutable/);
});
test("prompts match all three worlds and contain no residual Python-only restriction", async () => {
  for (const world of ["main-world", "ice-maze", "slotski"]) {
    const spec = { provider: "codex", coding_mode: "any", world, sequence_enabled: false, action_limit: 4 };
    const preview = await previewBenchmarkPrompt(root, spec);
    const built = await codePrompt(root, spec, { startRoom: "HxI", actionLimit: 4, sequenceEnabled: false });
    assert.equal(preview.prompt, built.prompt);
    assert.match(preview.prompt, /code_exec/); assert.match(preview.prompt, /compile programs and launch subprocesses/);
    assert.doesNotMatch(preview.prompt, /python_exec|Python is disabled|cannot launch subprocesses/);
  }
  for (const tools_enabled of [true, false]) {
    const legacy = await previewBenchmarkPrompt(root, { tools_enabled });
    const explicit = await previewBenchmarkPrompt(root, { coding_mode: tools_enabled ? "python" : "off" });
    assert.equal(legacy.prompt, explicit.prompt);
  }
});
test("Codex and Claude advertise only the new executor while preserving native tool restrictions", () => {
  for (const sequenceEnabled of [true, false]) {
    const directory = "/tmp/code-policy";
    const options = { projectRoot: root, runDirectory: directory, agentDirectory: directory + "/agent-cwd", model: "gpt-6-sol", effort: "low", prompt: "test", sequenceEnabled,
      modelCatalogPath: directory + "/sandbox-state/direct-model-catalog.json" };
    const args = buildCodeCodexArguments(options);
    assertCodeCodexArguments(args, options);
    assert(args.includes(`mcp_servers.mazebench.enabled_tools=${JSON.stringify(codeTools(options))}`));
    const tampered = args.map(arg => arg.startsWith("mcp_servers.mazebench.enabled_tools=") ? 'mcp_servers.mazebench.enabled_tools=["bash"]' : arg);
    assert.throws(() => assertCodeCodexArguments(tampered, options));
    const claude = buildCodeClaudeArguments({ ...options, model: "claude-sonnet-5-5" });
    assert.equal(claude[claude.indexOf("--tools") + 1], "");
    assert.deepEqual(claude[claude.indexOf("--allowedTools") + 1].split(","), codeTools(options).map(name => "mcp__mazebench__" + name));
    const event = tool => ({ type: "item.completed", item: { type: "mcp_tool_call", server: "mazebench", tool } });
    assert.equal(codeCodexBoundaryViolation(event("code_exec"), options), null);
    for (const tool of ["python_exec", "bash", "functions.exec", ...(!sequenceEnabled ? ["maze_sequence"] : [])]) assert(codeCodexBoundaryViolation(event(tool), options));
    const validate = createCodeClaudeValidator({ model: "claude-sonnet-5-5", sequenceEnabled });
    assert.equal(validate({ type: "system", subtype: "init", model: "claude-sonnet-5-5", permissionMode: "dontAsk", tools: codeTools(options).map(name => "mcp__mazebench__" + name), mcp_servers: [{ name: "mazebench", status: "connected" }] }), null);
    assert.equal(validate({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__mazebench__code_exec" }] } }), null);
    assert(validate({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__mazebench__python_exec" }] } }));
    assert(validate({ type: "assistant", parent_tool_use_id: "delegated", message: {} }));
  }
});

async function fixture(t, world = "main-world", sequence = true) {
  const parent = await temp(t), directory = path.join(parent, "run-2026-10-17T00-00-00-000Z-abcdef");
  await mkdir(directory);
  const binary = path.join(parent, "fixture-binary"); await writeFile(binary, "fixture");
  const prompt = "Fixture benchmark";
  const config = { coding_mode: "any", code_policy: CODE_POLICY, code_runtime: await codeRuntimeHashes(root),
    code_sandbox: dockerEnabled ? await inspectCodeSandbox() : { available: true, image },
    provider: "claude-code", world, observation_mode: "ascii", sequence_enabled: sequence, tools_enabled: true,
    model: "claude-sonnet-5-5", effort: "low", action_limit: 3, start_room: world === "main-world" ? "HxI" : "Level 1", service_tier: null,
    effective_prompt_sha256: digest(prompt), claude_policy: CLAUDE_POLICY, claude_version: "2.1.258", claude_executable: binary,
    claude_sha256: digest("fixture"), provider_runtime: await providerRuntimeHashes(root),
    ...(world === "main-world" ? {} : { world_runtime: await (world === "slotski" ? slotskiHashes : iceHashes)(root) }) };
  const metadata = { ...config, id: path.basename(directory), status: "stopped", created_at: "2026-10-17T00:00:00Z",
    capability_policy: { name: CLAUDE_POLICY, version: 4 }, integrity: await createRunIntegrity(root, directory, config) };
  await writeFile(path.join(directory, "prompt.md"), prompt);
  await atomicJson(path.join(directory, "run.json"), metadata);
  const Runtime = world === "slotski" ? SlotskiBenchmarkRuntime : world === "ice-maze" ? IceBenchmarkRuntime : BenchmarkGameRuntime;
  await Runtime.create(root, directory, { actionLimit: 3 });
  return { directory, metadata, supervisor: new BenchmarkSupervisor(root, { recordsRoot: parent }) };
}
function gateway(t, directory) {
  const child = spawn(process.execPath, [path.join(root, "benchmarking/code/mcp-server.mjs")], { env: { PATH: "/usr/bin:/bin", MAZEBENCH_PROJECT_ROOT: root, MAZEBENCH_RUN_DIRECTORY: directory }, stdio: ["pipe", "pipe", "pipe"] });
  let id = 0, stderr = "";
  child.stderr.on("data", value => { stderr += value; });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", line => { const result = JSON.parse(line); pending.get(result.id)?.resolve(result); pending.delete(result.id); });
  child.on("exit", () => { for (const item of pending.values()) item.reject(new Error(stderr || "MCP exited")); pending.clear(); });
  t.after(() => { child.stdin.end(); child.kill("SIGTERM"); });
  return (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n"); });
}
test("signed third-tier configuration binds mode, world, image and prompt; library labels retain the condition", async t => {
  const { directory, metadata, supervisor } = await fixture(t);
  await verifyCodeIntegrity(root, directory, metadata);
  for (const change of [{ coding_mode: "python" }, { code_sandbox: { image: "other" } }, { sequence_enabled: false }, { observation_mode: "vision" }]) await assert.rejects(verifyCodeIntegrity(root, directory, { ...metadata, ...change }));
  const library = await new RunLibrary().list(supervisor);
  assert.equal(library[0].coding_mode, "any"); assert.match(runCardValues(library[0]).condition, /Any language/);
  assert.equal((await new RunDashboard().overview(supervisor, metadata.id)).coding_mode, "any");
  await writeFile(path.join(directory, "prompt.md"), "tampered");
  await assert.rejects(verifyCodeIntegrity(root, directory, metadata), /prompt/);
});
for (const world of ["main-world", "ice-maze", "slotski"]) test(`${world} gateway publishes code_exec and preserves game accounting`, { timeout: 60000 }, async t => {
  const { directory } = await fixture(t, world, world !== "slotski");
  const call = gateway(t, directory);
  await call("initialize", { protocolVersion: "2024-11-05" });
  const catalog = await call("tools/list");
  assert.deepEqual(catalog.result.tools.map(tool => tool.name), codeTools({ sequenceEnabled: world !== "slotski" }));
  const denied = await call("tools/call", { name: "python_exec", arguments: { code: "print(1)", script_path: "bad.py" } });
  assert.equal(denied.result.isError, true);
  if (world === "slotski") assert.equal((await call("tools/call", { name: "maze_sequence", arguments: { actions: ["reset"] } })).result.isError, true);
  const observed = await call("tools/call", { name: "maze_observe", arguments: {} }); assert(!observed.result.isError);
  const moved = await call("tools/call", { name: "maze_action", arguments: { action: "reset" } }); assert(!moved.result.isError);
  assert.equal((await readJson(path.join(directory, "summary.json"))).action_count, 1);
  assert.deepEqual((await call("resources/list")).result.resources, []);
  if (dockerEnabled) {
    const executed = await call("tools/call", { name: "code_exec", arguments: { command: "node -e 'console.log(42)'" } });
    assert.equal(executed.result.structuredContent.exit_code, 0, JSON.stringify(executed));
    assert.equal(executed.result.structuredContent.stdout.trim(), "42");
    assert.equal((await readJson(path.join(directory, "summary.json"))).action_count, 1);
  }
});
test("unsupported providers and vision never silently fall back from Any language", async () => {
  const supervisor = new BenchmarkSupervisor(root);
  for (const spec of [{ provider: "prime-agent" }, { provider: "grok-build" }, { provider: "codex", observation_mode: "vision" }]) await assert.rejects(supervisor.validateSpec({ ...spec, coding_mode: "any" }), /Any language currently supports/);
});

test("real toolchain executes all advertised languages and preserves workspace files across calls", { skip: !dockerEnabled, timeout: 90000 }, async t => {
  const directory = await temp(t), sandbox = await inspectCodeSandbox();
  assert(sandbox.available, sandbox.error);
  assert((await preflightCodeSandbox({ runDirectory: directory, sandbox })).verified);
  const files = [
    { path: "hello.c", content: '#include <stdio.h>\nint main(){puts("C");}' },
    { path: "hello.cpp", content: '#include <iostream>\nint main(){std::cout << "C++\\n";}' },
    { path: "hello.rs", content: 'fn main(){println!("Rust");}' },
    { path: "hello.go", content: 'package main\nimport "fmt"\nfunc main(){fmt.Println("Go")}' },
    { path: "Hello.java", content: 'class Hello { public static void main(String[] a){ System.out.println("Java"); } }' }
  ];
  const result = await runSandboxedCode({ files, timeout_seconds: 60, command: `set -eu
python3 -c 'print("Python")'
node -e 'console.log("JavaScript")'
gcc hello.c -o hello-c && ./hello-c
g++ hello.cpp -o hello-cpp && ./hello-cpp
rustc hello.rs -o hello-rust && ./hello-rust
go run hello.go
javac -J-XX:ActiveProcessorCount=2 Hello.java && java -XX:ActiveProcessorCount=2 Hello
ruby -e 'puts "Ruby"'
perl -e 'print "Perl\\n"'
lua -e 'print("Lua")'
printf persisted > saved.txt
` }, { runDirectory: directory, sandbox });
  assert.equal(result.exit_code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "Python\nJavaScript\nC\nC++\nRust\nGo\nJava\nRuby\nPerl\nLua");
  const second = await runSandboxedCode({ command: "cat saved.txt" }, { runDirectory: directory, sandbox });
  assert.equal(second.stdout, "persisted");
});
test("sandbox blocks host/symlink access, kills detached processes, and bounds time and output", { skip: !dockerEnabled, timeout: 45000 }, async t => {
  const directory = await temp(t), sandbox = await inspectCodeSandbox();
  await mkdir(path.join(directory, "workspace"));
  await writeFile(path.join(directory, "secret.txt"), "host-secret");
  await symlink(path.join(directory, "secret.txt"), path.join(directory, "workspace/escape"));
  const denied = await runSandboxedCode({ command: "cat escape" }, { runDirectory: directory, sandbox });
  assert.notEqual(denied.exit_code, 0); assert(!denied.stdout.includes("host-secret"));
  await link(path.join(directory, "secret.txt"), path.join(directory, "workspace/hard"));
  await assert.rejects(runSandboxedCode({ command: "true", files: [{ path: "hard", content: "overwrite" }] }, { runDirectory: directory, sandbox }), /links/);
  await assert.rejects(runSandboxedCode({ command: "true", files: [{ path: "escape", content: "overwrite" }] }, { runDirectory: directory, sandbox }), /links/);
  const daemon = await runSandboxedCode({ command: "python3 -c 'import os,time; pid=os.fork(); os._exit(0) if pid else None; os.setsid(); time.sleep(1); open(\"escaped-daemon\",\"w\").write(\"bad\")'" }, { runDirectory: directory, sandbox });
  assert.equal(daemon.exit_code, 0, daemon.stderr);
  const timed = await runSandboxedCode({ command: "sleep 30", timeout_seconds: 1 }, { runDirectory: directory, sandbox });
  assert(timed.timed_out); assert(timed.wall_time_ms < 10000);
  const flood = await runSandboxedCode({ command: "yes flood", timeout_seconds: 3 }, { runDirectory: directory, sandbox });
  assert(flood.output_truncated); assert(Buffer.byteLength(flood.stdout) <= 256000);
  await assert.rejects(readFile(path.join(directory, "workspace/escaped-daemon")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(directory, "secret.txt"), "utf8"), "host-secret");
});

test("third-tier launch, matched pair and resume preserve condition, image and conversation", { skip: !dockerEnabled, timeout: 60000 }, async t => {
  const recordsRoot = await temp(t), dispatches = [];
  class NoAgentSupervisor extends BenchmarkSupervisor {
    startCode(id, directory, prompt) { dispatches.push({ id, directory, prompt }); }
    async runLoop(id) { this.active.delete(id); }
  }
  const supervisor = new NoAgentSupervisor(root, { recordsRoot });
  supervisor.models = async () => ({ default_model: "gpt-6-sol", models: [{ id: "gpt-6-sol", provider: "codex", efforts: ["low"], default_effort: "low" }] });
  const policy = { version: 4, codex_executable: process.execPath, codex_sha256: digest(await readFile(process.execPath)), disabled_features: [], enabled_features: [] };
  supervisor.codexCapabilityPolicy = () => structuredClone(policy);
  const pair = await supervisor.launchPair({ coding_mode: "any", provider: "codex", action_limit: 3 });
  assert.equal(pair.runs.length, 2);
  assert.equal(pair.runs[0].tools_enabled, false);
  const run = pair.runs[1], directory = supervisor.runDirectory(run.id);
  assert.equal(run.coding_mode, "any"); assert.equal(run.pair_id, pair.runs[0].pair_id);
  const metadata = await readJson(path.join(directory, "run.json"));
  assert(metadata.isolation.verified); assert.equal(dispatches.length, 1);
  const oldImage = metadata.code_sandbox.image;
  Object.assign(metadata, { status: "paused", codex_thread_id: "11111111-1111-4111-8111-111111111111" });
  await atomicJson(path.join(directory, "run.json"), metadata);
  await supervisor.resume(run.id);
  const resumed = await readJson(path.join(directory, "run.json"));
  assert.equal(resumed.coding_mode, "any"); assert.equal(resumed.code_sandbox.image, oldImage);
  assert.equal(resumed.codex_thread_id, metadata.codex_thread_id); assert.equal(dispatches.length, 2);
  await atomicJson(path.join(directory, "run.json"), { ...resumed, status: "paused", coding_mode: "python" });
  await assert.rejects(supervisor.resume(run.id), /coding policy changed/);
});
