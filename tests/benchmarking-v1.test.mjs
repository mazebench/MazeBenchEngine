import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CAPABILITY_POLICY_VERSION, CAPABILITY_POLICY_NAME, createRunIntegrity, signCheckpoint } from "../benchmarking/v1/integrity.mjs";

import {
  BenchmarkGameRuntime,
  expandBenchmarkSequence,
  normalizeBenchmarkAction
} from "../benchmarking/v1/runtime.mjs";
import {
  normalizePythonScriptPath,
  preflightPythonSandbox,
  runSandboxedPython
} from "../benchmarking/v1/python-sandbox.mjs";
import {
  assertHardenedCodexArguments,
  BenchmarkSupervisor,
  buildBenchmarkPrompt,
  buildCodexArguments,
  buildInterviewArguments,
  buildInterviewForkArguments,
  buildInterviewPrompt,
  parseCodexFeatureInventory,
  isTransientInterviewError,
  verifyDirectToolModelCatalog,
  writeDirectToolModelCatalog
} from "../benchmarking/v1/supervisor.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function temporaryRun(actionLimit = 100) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mazebench-benchmark-test-"));
  const runtime = await BenchmarkGameRuntime.create(projectRoot, directory, {
    startRoom: "HxI",
    actionLimit
  });
  return { directory, runtime };
}

async function startMcp(directory, toolsEnabled) {
  const configuration = { model: "test-model", effort: "low", tools_enabled: toolsEnabled, action_limit: 4, start_room: "HxI", effective_prompt_sha256: "test-prompt" };
  const integrity = await createRunIntegrity(projectRoot, directory, configuration);
  await writeFile(path.join(directory, "run.json"), JSON.stringify({ ...configuration, integrity }));
  await signCheckpoint(directory);
  const child = spawn(process.execPath, [path.join(projectRoot, "benchmarking", "v1", "mcp-server.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MAZEBENCH_PROJECT_ROOT: projectRoot,
      MAZEBENCH_RUN_DIRECTORY: directory,
      MAZEBENCH_PYTHON_ENABLED: toolsEnabled ? "1" : "0",
      MAZEBENCH_CAPABILITY_POLICY: CAPABILITY_POLICY_NAME
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    pending.get(value.id)?.(value);
    pending.delete(value.id);
  });
  let nextId = 1;
  const request = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return { child, request };
}

test("benchmark action and sequence syntax matches the evaluation prompt", () => {
  assert.equal(normalizeBenchmarkAction("U"), "up");
  assert.equal(normalizeBenchmarkAction("action room HxI".replace("action ", "")), "room HxI");
  assert.deepEqual(expandBenchmarkSequence("UDRL"), ["up", "down", "right", "left"]);
  assert.deepEqual(expandBenchmarkSequence(["camera left", "up"]), ["camera left", "up"]);
  assert.throws(() => normalizeBenchmarkAction("quit"), /Unknown action/);
});

test("every accepted action counts and records remain read-only by allowlist", async () => {
  const { directory, runtime } = await temporaryRun(3);
  try {
    await runtime.apply("camera left");
    await runtime.apply("camera up");
    await runtime.apply("left");
    const observation = await runtime.renderObservation();
    assert.equal(observation.action_count, 3);
    assert.equal(observation.game_status, "action-limit");
    assert.equal(runtime.summary().camera_actions, 2);
    assert.equal((await runtime.readRecord("moves.txt")).content, "camera left\ncamera up\nleft\n");
    assert.match((await runtime.readRecord("move_history/move_3.txt")).content, /# move 3/);
    const display = JSON.parse(await readFile(path.join(directory, "display.json"), "utf8"));
    assert.equal(display.observation_revision, 3);
    assert.equal(display.colored_level.length, display.level.split("\n").length);
    assert.deepEqual(
      display.colored_level.map((row) => row.map((segment) => segment.text).join("")),
      display.level.split("\n")
    );
    assert(display.colored_level.flat().every((segment) => /^#[0-9a-f]{6}$/i.test(segment.color)));
    const historicalDisplay = JSON.parse(await readFile(
      path.join(directory, "display-history", "move_3.json"),
      "utf8"
    ));
    assert.equal(historicalDisplay.observation_revision, 3);
    assert.deepEqual(historicalDisplay.colored_level, display.colored_level);
    const agentState = JSON.parse((await runtime.readRecord("current_state.json")).content);
    assert.equal("colored_level" in agentState, false);
    assert.equal("level" in agentState, false);
    await assert.rejects(() => runtime.readRecord("../game-state.json"), /Unknown benchmark record/);
    await assert.rejects(() => runtime.apply("up"), /action limit/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maze_observe is the records reader and Python is advertised only when enabled", async () => {
  for (const toolsEnabled of [false, true]) {
    const { directory } = await temporaryRun(4);
    const { child, request } = await startMcp(directory, toolsEnabled);
    try {
      const initialized = await request("initialize", { protocolVersion: "2024-11-05" });
      assert.equal(initialized.result.serverInfo.name, "mazebench-benchmark");
      assert.deepEqual((await request("resources/list")).result, { resources: [] });
      assert.deepEqual((await request("resources/templates/list")).result, { resourceTemplates: [] });
      assert((await request("resources/read", { uri: "file:///private/hidden-world.json" })).error);
      if (!toolsEnabled) {
        const blocked = await request("tools/call", { name: "python_exec", arguments: { code: "print(1)", script_path: "forbidden.py" } });
        assert.equal(blocked.result.isError, true);
        await assert.rejects(() => access(path.join(directory, "workspace", "forbidden.py")));
      }
      const listed = await request("tools/list");
      assert.deepEqual(
        listed.result.tools.map((tool) => tool.name),
        ["maze_observe", "maze_action", "maze_sequence", ...(toolsEnabled ? ["python_exec"] : [])]
      );
      const action = await request("tools/call", { name: "maze_action", arguments: { action: "camera left" } });
      assert.equal(action.result.structuredContent.observation.action_count, 1);
      const animation = action.result.structuredContent.action.animation;
      assert.equal(animation.frame_count, 2);
      const animationIndex = await request("tools/call", { name: "maze_observe", arguments: { record: animation.index_record } });
      const framePath = JSON.parse(animationIndex.result.structuredContent.content).frames[1].record;
      const animationFrame = await request("tools/call", { name: "maze_observe", arguments: { record: framePath } });
      assert.match(animationFrame.result.structuredContent.content, /# move 1 .*frame 1\/1/);
      assert.equal(animationFrame.result.structuredContent.observation_revision, 1);
      for (const record of ["move_history/move_2/index.json", "move_history/move_1/frame_9999.txt", "move_history/move_1/../../game-state.json"]) {
        const forbidden = await request("tools/call", { name: "maze_observe", arguments: { record } });
        assert.equal(forbidden.result.isError, true);
      }
      const record = await request("tools/call", {
        name: "maze_observe",
        arguments: { record: "moves.txt" }
      });
      assert.equal(record.result.structuredContent.read_only, true);
      assert.equal(record.result.structuredContent.content, "camera left\n");
      const denied = await request("tools/call", {
        name: "maze_observe",
        arguments: { record: "../game-state.json" }
      });
      assert.equal(denied.result.isError, true);
      const sequence = await request("tools/call", { name: "maze_sequence", arguments: { actions: ["camera right", "camera up"] } });
      assert(sequence.result.structuredContent.steps.every(step => step.action.animation.frame_count === 2));
    } finally {
      child.kill("SIGTERM");
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("the MazeBench MCP fails closed without the Python-only launcher policy", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mazebench-policy-test-"));
  try {
    const child = spawn(process.execPath, [path.join(projectRoot, "benchmarking", "v1", "mcp-server.mjs")], {
      cwd: projectRoot,
      env: {
        ...process.env,
        MAZEBENCH_PROJECT_ROOT: projectRoot,
        MAZEBENCH_RUN_DIRECTORY: directory,
        MAZEBENCH_PYTHON_ENABLED: "0"
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.notEqual(code, 0);
    assert.match(stderr, /Python-only capability policy/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex arguments expose the exact benchmark tool catalog and disable native tools", () => {
  const common = {
    projectRoot,
    runDirectory: "/tmp/maze-run",
    agentDirectory: "/tmp/maze-run/agent-cwd",
    modelCatalogPath: "/tmp/maze-run/sandbox-state/direct-model-catalog.json",
    model: "gpt-5.6-terra",
    effort: "medium",
    prompt: "play"
  };
  const off = buildCodexArguments({ ...common, toolsEnabled: false });
  const on = buildCodexArguments({ ...common, toolsEnabled: true });
  assert(off.includes("shell_tool"));
  assert(off.includes("multi_agent"));
  assert(off.includes("code_mode_host"));
  assert(off.includes("code_mode_only"));
  assert(off.some((value) => value === 'features.code_mode.direct_only_tool_namespaces=["mcp__mazebench"]'));
  assert(off.some((value) => value === 'features.code_mode.excluded_tool_namespaces=["mcp__mazebench"]'));
  assert(off.includes("features.code_mode_host.enabled=false"));
  assert(off.includes("features.code_mode_host.disable_in_process_fallback=true"));
  assert(off.includes('sandbox_mode="read-only"'));
  assert(off.includes("mcp_servers.mazebench.required=true"));
  assert(off.some((value) => value.includes('["maze_observe","maze_action","maze_sequence"]')));
  assert(on.some((value) => value.includes('["maze_observe","maze_action","maze_sequence","python_exec"]')));
  assert.equal(off.includes("python_exec"), false);
  assert(off.includes('model_catalog_json="/tmp/maze-run/sandbox-state/direct-model-catalog.json"'));
  assert.equal(assertHardenedCodexArguments(off, { modelCatalogPath: common.modelCatalogPath }), true);
  assert.equal(assertHardenedCodexArguments(on, { modelCatalogPath: common.modelCatalogPath }), true);
});

test("every discovered Codex feature is denied before the direct MazeBench namespace is configured", () => {
  const inventory = `
shell_tool                             stable             true
code_mode                             under development  false
code_mode_host                        stable             true
future_executor                       experimental       true
old_executor                          deprecated         false
removed_executor                      removed            false
`;
  const features = parseCodexFeatureInventory(inventory);
  assert.deepEqual(features, ["code_mode", "code_mode_host", "future_executor", "shell_tool"]);
  const args = buildCodexArguments({
    projectRoot,
    runDirectory: "/tmp/maze-run",
    agentDirectory: "/tmp/maze-run/agent-cwd",
    modelCatalogPath: "/tmp/maze-run/sandbox-state/direct-model-catalog.json",
    model: "gpt-5.6-terra",
    effort: "medium",
    prompt: "play",
    toolsEnabled: false,
    disabledFeatures: features
  });
  assert(args.some((entry, index) => entry === "--disable" && args[index + 1] === "future_executor"));
  assert.equal(args.includes("removed_executor"), false);
  assert.equal(args.includes("old_executor"), false);
  assert.equal(assertHardenedCodexArguments(args, {
    disabledFeatures: features,
    modelCatalogPath: "/tmp/maze-run/sandbox-state/direct-model-catalog.json"
  }), true);
});

test("the run-scoped model catalog forces direct tools and is hash-verified", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mazebench-model-catalog-test-"));
  const sourcePath = path.join(directory, "source-models.json");
  await writeFile(sourcePath, JSON.stringify({
    fetched_at: "test",
    models: [{ slug: "gpt-test", tool_mode: "code_mode_only", node_repl_disabled: false }]
  }), "utf8");
  try {
    const policy = await writeDirectToolModelCatalog(directory, "gpt-test", { sourcePath });
    assert.equal(policy.tool_mode, "direct");
    assert.equal(policy.node_repl_disabled, false);
    assert.equal(policy.javascript_host, "disabled");
    const verified = await verifyDirectToolModelCatalog(directory, "gpt-test", policy);
    assert.equal(verified.sha256, policy.sha256);
    const savedPath = path.join(directory, policy.file);
    const saved = JSON.parse(await readFile(savedPath, "utf8"));
    assert.equal(saved.models.length, 1);
    assert.equal(saved.models[0].tool_mode, "direct");
    assert.equal(saved.models[0].node_repl_disabled, false);
    saved.models[0].tool_mode = "code_mode_only";
    await writeFile(savedPath, JSON.stringify(saved), "utf8");
    await assert.rejects(
      () => verifyDirectToolModelCatalog(directory, "gpt-test", policy),
      /does not enforce the verified direct-tool metadata/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the effective prompt keeps records access in maze_observe and separates Python", () => {
  const off = buildBenchmarkPrompt("BASE", {
    toolsEnabled: false,
    startRoom: "HxI",
    actionLimit: 100
  });
  const on = buildBenchmarkPrompt("BASE", {
    toolsEnabled: true,
    startRoom: "HxI",
    actionLimit: 100
  });
  assert.match(off, /maze_observe is the only read interface/);
  assert.match(off, /TOOLS-OFF CONDITION/);
  assert.match(off, /JavaScript, functions\.exec/);
  assert.match(on, /persistent isolated \/workspace/);
  assert.match(on, /cannot read the read-only MazeBench records/);
  assert.match(on, /only code executor/);
  assert.match(on, /Every agent-authored program.*\.py file/);
});

test("interview chats snapshot immediately, then send questions only to the isolated fork", () => {
  const common = {
    projectRoot,
    runDirectory: "/tmp/maze-run",
    modelCatalogPath: "/tmp/maze-run/sandbox-state/direct-model-catalog.json",
    parentThreadId: "parent-thread",
    model: "gpt-5.6-terra",
    effort: "medium",
    outputFile: "/tmp/interview-answer.txt",
    question: "Why did you not use a solver?"
  };
  const snapshot = buildInterviewForkArguments(common);
  const first = buildInterviewArguments(common);
  const followup = buildInterviewArguments({ ...common, forkThreadId: "fork-thread" });
  assert.deepEqual(snapshot.slice(0, 3), ["exec", "fork", "parent-thread"]);
  assert.equal(snapshot.includes(common.question), false);
  assert.deepEqual(first.slice(0, 3), ["exec", "fork", "parent-thread"]);
  assert.deepEqual(followup.slice(0, 3), ["exec", "resume", "fork-thread"]);
  assert(first.includes("mcp_servers.mazebench.enabled=false"));
  assert(first.some((value) => value.includes("mcp_servers.mazebench.command")));
  assert.equal(first.some((value) => value.includes("enabled_tools")), false);
  assert.match(buildInterviewPrompt(common.question), /original benchmark thread.*remain untouched/i);
  assert.match(buildInterviewPrompt(common.question), /Question: Why did you not use a solver\?/);
});

test("transient Codex service failures queue interview questions for automatic retry", async () => {
  assert.equal(isTransientInterviewError(
    "unexpected status 404 Not Found, url: https://chatgpt.com/backend-api/codex/responses"
  ), true);
  assert.equal(isTransientInterviewError("The model returned an empty interview response."), false);

  const recordsRoot = await mkdtemp(path.join(os.tmpdir(), "mazebench-interview-test-"));
  const id = "run-2026-09-03T12-34-44-317Z-abc123";
  const directory = path.join(recordsRoot, id);
  const chat = "chat-2026-09-03T12-34-44-317Z-def456";
  const interviewDirectory = path.join(directory, "interviews", chat);
  await mkdir(interviewDirectory, { recursive: true });
  await writeFile(path.join(directory, "run.json"), JSON.stringify({
    id,
    status: "completed",
    model: "gpt-5.6-terra",
    effort: "medium",
    codex_thread_id: "parent-thread"
  }), "utf8");
  await writeFile(path.join(interviewDirectory, "chat.json"), JSON.stringify({
    schema_version: 2,
    id: chat,
    run_id: id,
    title: "Chat 1",
    parent_thread_id: "parent-thread",
    fork_thread_id: "fork-thread",
    branched_at_action: 37,
    run_status_at_branch: "running",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ended_at: null,
    status: "ready",
    error: null,
    messages: []
  }), "utf8");
  const supervisor = new BenchmarkSupervisor(projectRoot, { recordsRoot });
  supervisor.runInterviewTurn = async () => ({
    code: 1,
    forkThreadId: "fork-thread",
    answer: "",
    reportedError: "unexpected status 404 Not Found, url: https://chatgpt.com/backend-api/codex/responses",
    stderrTail: ""
  });
  try {
    const interview = await supervisor.askInterview(id, chat, "Why no solver?");
    assert.equal(interview.status, "queued");
    assert.equal(interview.fork_thread_id, "fork-thread");
    assert.equal(interview.error, null);
    assert.match(interview.notice, /retry automatically/i);
    assert.equal(interview.messages.length, 1);
    assert.equal(supervisor.interviewRetryTimers.has(`${id}:${chat}`), true);
  } finally {
    for (const timer of supervisor.interviewRetryTimers.values()) clearTimeout(timer);
    await rm(recordsRoot, { recursive: true, force: true });
  }
});

test("multiple interview chats retain independent snapshot moments and can be ended", async () => {
  const recordsRoot = await mkdtemp(path.join(os.tmpdir(), "mazebench-chat-list-test-"));
  const id = "run-2026-09-03T12-34-44-317Z-fed321";
  const directory = path.join(recordsRoot, id);
  await mkdir(path.join(directory, "agent-cwd"), { recursive: true });
  await writeFile(path.join(directory, "run.json"), JSON.stringify({
    id,
    status: "running",
    model: "gpt-5.6-terra",
    effort: "medium",
    codex_thread_id: "parent-thread"
  }), "utf8");
  await writeFile(path.join(directory, "summary.json"), JSON.stringify({
    action_count: 42,
    game_status: "playing"
  }), "utf8");
  const supervisor = new BenchmarkSupervisor(projectRoot, { recordsRoot });
  let fork = 0;
  supervisor.runInterviewFork = async () => ({
    code: 0,
    forkThreadId: `fork-${++fork}`,
    stderrTail: ""
  });
  try {
    const first = await supervisor.createInterview(id);
    const second = await supervisor.createInterview(id);
    assert.notEqual(first.id, second.id);
    assert.equal(first.branched_at_action, 42);
    assert.equal(second.branched_at_action, 42);
    assert.equal(first.fork_thread_id, "fork-1");
    assert.equal(second.fork_thread_id, "fork-2");
    const library = await supervisor.listInterviews(id);
    assert.equal(library.chats.length, 2);
    assert.deepEqual(new Set(library.chats.map((chat) => chat.title)), new Set(["Chat 1", "Chat 2"]));
    const ended = await supervisor.endInterview(id, first.id);
    assert.equal(ended.status, "ended");
    assert(ended.ended_at);
  } finally {
    await rm(recordsRoot, { recursive: true, force: true });
  }
});

test("nonterminal paused, stopped and compaction-failed runs resume their existing Codex thread", async () => {
  for (const status of ["paused", "stopped", "failed"]) {
    const recordsRoot = await mkdtemp(path.join(os.tmpdir(), `mazebench-resume-${status}-`));
    const id = `run-2026-09-03T12-34-44-317Z-${status === "paused" ? "a11ced" : "57a9ed"}`;
    const directory = path.join(recordsRoot, id);
    await mkdir(path.join(directory, "agent-cwd"), { recursive: true });
    await BenchmarkGameRuntime.create(projectRoot, directory, {
      startRoom: "HxI",
      actionLimit: 100
    });
    await writeFile(path.join(directory, "run.json"), JSON.stringify({
      schema_version: 1,
      id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status,
      error: status === "failed" ? 'Error running remote compact task: unexpected status 404 Not Found, url: https://chatgpt.com/backend-api/codex/responses/compact, request id: fixture' : null,
      model: "gpt-5.6-terra",
      effort: "medium",
      tools_enabled: false,
      action_limit: 100,
      start_room: "HxI",
      codex_thread_id: "existing-thread",
      continuation_count: 0,
      capability_policy: { version: CAPABILITY_POLICY_VERSION }
    }), "utf8");

    const supervisor = new BenchmarkSupervisor(projectRoot, { recordsRoot });
    supervisor.verifyRunCapabilityBoundary = async () => ({
      capabilityPolicy: { disabled_features: [] },
      modelCatalog: { path: path.join(directory, "sandbox-state", "direct-model-catalog.json") }
    });
    let captured;
    let release;
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    supervisor.runLoop = async (...args) => {
      captured = args;
      await new Promise((resolve) => { release = resolve; });
      supervisor.active.delete(id);
      finish();
    };
    try {
      const resumed = await supervisor.resume(id);
      assert.equal(resumed.status, "queued");
      assert.equal(resumed.runner_active, true);
      assert.equal(captured[0], id);
      assert.equal(captured[4].threadId, "existing-thread");
      assert.match(captured[3], /Call maze_observe to re-anchor/);
      const metadata = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8"));
      assert.equal(metadata.status, "queued");
      assert.equal(metadata.stopped_at, null);
      assert.equal(metadata.paused_at, null);
      assert.equal(metadata.error, null);
      if (status === "failed") {
        assert.equal(metadata.recoveries.length, 1);
        assert.match(metadata.recoveries[0].previous_error, /404 Not Found/);
        assert.equal(metadata.recoveries[0].codex_thread_id, "existing-thread");
      }
    } finally {
      if (release) {
        release();
        await finished;
      } else {
        finish();
      }
      await rm(recordsRoot, { recursive: true, force: true });
    }
  }
});

test("legacy runs created with the JavaScript-capable boundary cannot resume", async () => {
  const recordsRoot = await mkdtemp(path.join(os.tmpdir(), "mazebench-legacy-resume-"));
  const id = "run-2026-09-03T15-23-20-021Z-7ad197";
  const directory = path.join(recordsRoot, id);
  await mkdir(path.join(directory, "agent-cwd"), { recursive: true });
  await BenchmarkGameRuntime.create(projectRoot, directory, {
    startRoom: "HxI",
    actionLimit: null
  });
  await writeFile(path.join(directory, "run.json"), JSON.stringify({
    schema_version: 1,
    id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "stopped",
    model: "gpt-5.6-terra",
    effort: "max",
    tools_enabled: true,
    action_limit: null,
    start_room: "HxI",
    codex_thread_id: "unsafe-thread",
    continuation_count: 0
  }), "utf8");
  const supervisor = new BenchmarkSupervisor(projectRoot, { recordsRoot });
  try {
    await assert.rejects(() => supervisor.resume(id), /unsafe Codex tool boundary/);
  } finally {
    await rm(recordsRoot, { recursive: true, force: true });
  }
});

test("inactive benchmark runs can be permanently deleted but active runs fail closed", async () => {
  const recordsRoot = await mkdtemp(path.join(os.tmpdir(), "mazebench-delete-run-"));
  const id = "run-2026-09-03T15-23-20-021Z-de1e7e";
  const directory = path.join(recordsRoot, id);
  await mkdir(path.join(directory, "records"), { recursive: true });
  await writeFile(path.join(directory, "run.json"), JSON.stringify({ id, status: "stopped" }), "utf8");
  await writeFile(path.join(directory, "records", "moves.txt"), "left\n", "utf8");
  const supervisor = new BenchmarkSupervisor(projectRoot, { recordsRoot });
  supervisor.active.set(id, { child: null });
  try {
    await assert.rejects(() => supervisor.delete(id), /Stop or pause/);
    await access(path.join(directory, "records", "moves.txt"));
    supervisor.active.delete(id);
    const retryKey = `${id}:chat-2026-09-03T15-23-20-021Z-abc123`;
    const retryTimer = setTimeout(() => {}, 60_000);
    retryTimer.unref?.();
    supervisor.interviewRetryTimers.set(retryKey, retryTimer);
    const result = await supervisor.delete(id);
    assert.deepEqual(result, { id, deleted: true });
    assert.equal(supervisor.interviewRetryTimers.has(retryKey), false);
    await assert.rejects(() => access(directory), { code: "ENOENT" });
  } finally {
    supervisor.active.delete(id);
    for (const timer of supervisor.interviewRetryTimers.values()) clearTimeout(timer);
    await rm(recordsRoot, { recursive: true, force: true });
  }
});

test("stopped records recover a missing Codex thread id from their event log", async () => {
  const recordsRoot = await mkdtemp(path.join(os.tmpdir(), "mazebench-thread-recovery-"));
  const id = "run-2026-09-03T15-23-20-021Z-7ad197";
  const directory = path.join(recordsRoot, id);
  await mkdir(path.join(directory, "agent-cwd"), { recursive: true });
  await BenchmarkGameRuntime.create(projectRoot, directory, {
    startRoom: "HxI",
    actionLimit: null
  });
  await writeFile(path.join(directory, "run.json"), JSON.stringify({
    schema_version: 1,
    id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "stopped",
    model: "gpt-5.6-terra",
    effort: "max",
    tools_enabled: true,
    action_limit: null,
    start_room: "HxI",
    codex_thread_id: null,
    continuation_count: 0
  }), "utf8");
  await writeFile(path.join(directory, "agent-events.jsonl"), [
    JSON.stringify({ type: "thread.started", thread_id: "recovered-thread" }),
    JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "continue" } }),
    ""
  ].join("\n"), "utf8");
  const supervisor = new BenchmarkSupervisor(projectRoot, { recordsRoot });
  try {
    const library = await supervisor.listInterviews(id);
    assert.equal(library.available, true);
    assert.equal(library.parent_thread_id, "recovered-thread");
    const metadata = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8"));
    assert.equal(metadata.codex_thread_id, "recovered-thread");
    assert(metadata.thread_id_recovered_at);
  } finally {
    await rm(recordsRoot, { recursive: true, force: true });
  }
});

test("Python script paths cannot leave the isolated workspace", () => {
  assert.equal(normalizePythonScriptPath("models/world.py"), "models/world.py");
  assert.throws(() => normalizePythonScriptPath("../records/current_state.py"), /relative \.py/);
  assert.throws(() => normalizePythonScriptPath("/tmp/escape.py"), /relative \.py/);
  assert.throws(() => normalizePythonScriptPath("world.txt"), /relative \.py/);
});

test("Python isolation preflight blocks host, records, network, subprocess, and symlink escape", {
  skip: spawnSync("which", ["codex"]).status !== 0
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mazebench-python-test-"));
  const workspace = path.join(directory, "workspace");
  const stateDirectory = path.join(directory, "sandbox-state");
  await Promise.all([mkdir(workspace), mkdir(stateDirectory)]);
  try {
    await writeFileForTest(path.join(directory, "records", "current_state.json"), "private");
    const result = preflightPythonSandbox({
      workspace,
      stateDirectory,
      projectRoot,
      runDirectory: directory
    });
    assert.equal(result.verified, true);
    assert.deepEqual(result.checks, {
      host: true,
      network: true,
      private: true,
      subprocess: true,
      symlink: true,
      write: true
    });
    const execution = runSandboxedPython(
      'from pathlib import Path\nPath("artifact.txt").write_text("workspace-only")\nprint(__file__)\n',
      {
        workspace,
        stateDirectory,
        projectRoot,
        runDirectory: directory,
        scriptPath: "models/world_model.py",
        timeoutSeconds: 5
      }
    );
    assert.equal(execution.exit_code, 0);
    assert.match(execution.stdout, /world_model\.py/);
    assert.equal(await readFile(path.join(workspace, "models", "world_model.py"), "utf8"),
      'from pathlib import Path\nPath("artifact.txt").write_text("workspace-only")\nprint(__file__)\n');
    assert.equal(await readFile(path.join(workspace, "artifact.txt"), "utf8"), "workspace-only");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeFileForTest(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

test("the versioned evaluation prompt retains the supplied prompt bytes", async () => {
  const versioned = await readFile(path.join(projectRoot, "benchmarking", "v1", "EVAL-PROMPT.md"), "utf8");
  assert.equal(
    createHash("sha256").update(versioned).digest("hex"),
    "b923e018eb5a65d9576d6ccf5352a095e925c2b8fd322a5f5a12cecb04e9244d"
  );
});

test("the benchmark library links to dedicated model records with colored ASCII rendering", async () => {
  const [index, main, runPage, runScript, styles, server] = await Promise.all([
    readFile(path.join(projectRoot, "benchmarking", "v1", "index.html"), "utf8"),
    readFile(path.join(projectRoot, "benchmarking", "v1", "main.mjs"), "utf8"),
    readFile(path.join(projectRoot, "benchmarking", "v1", "run.html"), "utf8"),
    readFile(path.join(projectRoot, "benchmarking", "v1", "run.mjs"), "utf8"),
    readFile(path.join(projectRoot, "benchmarking", "v1", "styles.css"), "utf8"),
    readFile(path.join(projectRoot, "server.mjs"), "utf8")
  ]);
  assert.match(index, /<h2 id="runs-title">Runs<\/h2>/);
  assert.doesNotMatch(index, /id="board"/);
  assert.match(main, /\.\/run\.html\?id=/);
  assert.match(runPage, /id="model-hero"/);
  assert.match(runPage, /id="board"/);
  assert.match(runPage, /id="frame-scrubber"/);
  assert.match(runPage, /id="frame-play"/);
  assert.match(runPage, /id="replay-speed"/);
  assert.match(runPage, /id="interview-form"/);
  assert.match(runPage, /id="interview-messages"/);
  assert.match(runPage, /id="interview-list"/);
  assert.match(runPage, /id="new-interview"/);
  assert.match(runPage, /id="pause-run"/);
  assert.match(runPage, /id="resume-run"/);
  assert.match(runPage, /id="delete-run"/);
  assert.match(runPage, /<label for="interview-question">Your question<\/label>/);
  assert.doesNotMatch(runPage, /id="interview-question"[^>]*disabled/);
  assert.match(runScript, /colored_level/);
  assert.match(runScript, /span\.style\.color = segment\.color/);
  assert.match(runScript, /\/display\/\$\{selected\}/);
  assert.match(runScript, /point\.y - minY/);
  assert.match(runScript, /current\.worldY - minY/);
  assert.doesNotMatch(runScript, /maxY - (?:point\.y|current\.worldY)/);
  assert.match(runScript, /Waiting for Codex/);
  assert.match(runScript, /retry automatically/);
  assert.match(runScript, /refreshAfterMutation/);
  assert.match(runScript, /addEventListener\("input", syncInterviewSendButton\)/);
  assert.match(runScript, /Branch & ask/);
  assert.match(runScript, /method: "DELETE"/);
  assert.match(main, /dataset\.deleteRun = run\.id/);
  assert.match(main, /This cannot be undone/);
  assert.match(server, /request\.method === "DELETE"/);
  assert.match(styles, /button\.danger/);
  assert.match(styles, /font-size: clamp\(6px, 1\.05vmin, 12px\)/);
  assert.doesNotMatch(styles, /saturate\(/);
});
