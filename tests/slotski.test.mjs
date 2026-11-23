import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseSlotskiLevel, validateBlocks, moveSlotski, slotskiSolved, slotskiAscii, expandSlotskiSequence, normalizeSlotskiAction } from "../slotski/v1/engine.mjs";
import { SlotskiBenchmarkRuntime } from "../slotski/v1/benchmark-runtime.mjs";
import { BenchmarkSupervisor } from "../benchmarking/slotski/supervisor.mjs";
import { createRunIntegrity, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { digest, providerRuntimeHashes, buildClaudeArguments } from "../benchmarking/providers/claude-policy.mjs";
import { buildCodexArguments, writeDirectToolModelCatalog } from "../benchmarking/v1/supervisor.mjs";
import { worldRuntimeHashes, verifySlotskiIntegrity, buildSlotskiCodexArguments, buildSlotskiClaudeArguments, assertSlotskiCodexArguments } from "../benchmarking/slotski/policy.mjs";
import { slotskiTools, slotskiCodexBoundaryViolation, slotskiClaudeBoundaryViolation } from "../benchmarking/slotski/action-policy.mjs";


const root = path.resolve(import.meta.dirname, ".."), world = JSON.parse(await readFile(path.join(root, "level-data/slotski/v1/world.json")));
const level = parseSlotskiLevel(world.levels[0]);

test("Slotski accepts the requested action grammar and rejects unbounded or executable input", () => {
  for (const text of ["AU BD CL", "a up, b down c left", "block A move up, block B move down, block C move left"]) assert.deepEqual(expandSlotskiSequence(text), ["AU", "BD", "CL"]);
  for (const text of ["AU3", "a up 3 times", "block A move up 3 times"]) assert.deepEqual(expandSlotskiSequence(text), ["AU", "AU", "AU"]);
  assert.deepEqual(expandSlotskiSequence(["ir2", "J left", "undo", "reset"]), ["IR", "IR", "JL", "undo", "reset"]);
  assert.equal(normalizeSlotskiAction("block Z move right"), "ZR");
  assert.equal(expandSlotskiSequence("AU1000").length, 1000);
  for (const text of ["", "AU0", "AU-1", "AU1.5", "AU1001", "AU Infinity", "AU3e2", "AU then solve", "A teleport", "AU; eval(1)", "AU3 garbage", "AU BD2x", "AB up", 42, {}, [], ["AU1000", "BD"]]) assert.throws(() => expandSlotskiSequence(text));
  assert.throws(() => normalizeSlotskiAction("AU2"), /maze_sequence/);
});

// Independent test-only occupancy stepping and BFS. Equivalent-shaped blocks
// are canonicalized only for this search; the game retains permanent labels.
// Neither the search nor its route is imported by any served game/MCP module.
function referenceMove(blocks, index, direction) {
  const [dx, dy] = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] }[direction];
  const cells = Array(level.width * level.height).fill(-1);
  blocks.forEach((b, i) => { for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) cells[(b.y + y) * level.width + b.x + x] = i; });
  const b = blocks[index];
  for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
    const nx = b.x + x + dx, ny = b.y + y + dy;
    if (nx < 0 || nx >= level.width || ny < 0 || ny >= level.height || (cells[ny * level.width + nx] !== -1 && cells[ny * level.width + nx] !== index)) return null;
  }
  return blocks.map((b, i) => i === index ? { ...b, x: b.x + dx, y: b.y + dy } : b);
}
function solveReference() {
  const key = blocks => blocks.map(b => `${b.id === level.target ? "target" : `${b.width}x${b.height}`}:${b.x + b.y * level.width}`).sort().join(";");
  const queue = [{ blocks: level.blocks, parent: -1 }], seen = new Set([key(level.blocks)]);
  for (let i = 0; i < queue.length; i++) {
    const state = queue[i], target = state.blocks.find(b => b.id === level.target);
    if (target.x === 1 && target.y === 3) {
      const route = [];
      for (let at = i; queue[at].parent !== -1; at = queue[at].parent) route.push(queue[at].action);
      return route.reverse();
    }
    assert(queue.length < 100_000, "Unexpectedly large classic board state space");
    for (let block = 0; block < state.blocks.length; block++) for (const direction of "UDLR") {
      const blocks = referenceMove(state.blocks, block, direction);
      if (!blocks) continue;
      const id = key(blocks);
      if (!seen.has(id)) { seen.add(id); queue.push({ blocks, parent: i, action: blocks[block].id + direction }); }
    }
  }
  throw new Error("Classic Slotski is unsolvable");
}
let solution;
test("single answer-free classic board is independently solvable; engine agrees on every legal and blocked move", () => {
  assert.equal(world.levels.length, 1);
  assert.deepEqual(Object.keys(world.levels[0]).sort(), ["blocks", "exit_x", "height", "number", "target", "title", "width"]);
  assert.equal(slotskiAscii(level, level.blocks), "######\n#BAAC#\n#BAAC#\n#DFFE#\n#DGHE#\n#I..J#\n##vv##");
  solution = solveReference();
  let blocks = level.blocks;
  for (const action of solution) {
    for (let i = 0; i < blocks.length; i++) for (const direction of "UDLR") {
      const expected = referenceMove(blocks, i, direction), actual = moveSlotski(level, blocks, blocks[i].id + direction);
      assert.deepEqual(actual.blocks, expected || blocks);
      assert.equal(actual.changed, Boolean(expected));
    }
    blocks = moveSlotski(level, blocks, action).blocks;
  }
  assert(slotskiSolved(level, blocks));
  assert(!slotskiSolved(level, level.blocks));
  assert.throws(() => parseSlotskiLevel({ ...level, blocks: [...level.blocks, level.blocks[0]] }), /position/);
  assert.throws(() => validateBlocks(level, level.blocks.map(b => b.id === "A" ? { ...b, x: 0 } : b)), /overlap/);
});
test("runtime counts blocked moves/repeats, preserves labels on undo/reset, and treats revisits as duplicates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slotski-runtime-"));
  try {
    await createRunIntegrity(root, directory, {});
    const runtime = await SlotskiBenchmarkRuntime.create(root, directory, { actionLimit: 6 });
    const initial = runtime.stateHash();
    await assert.rejects(() => runtime.applySequence("IR ZU"), /Unknown/);
    await assert.rejects(() => runtime.applySequence("IR AU2.5"));
    assert.equal(runtime.internal.actionCount, 0);
    const result = await runtime.applySequence("IR IL IR undo reset AU3");
    assert.equal(result.completed_count, 6); assert.equal(result.stopped_early, true);
    assert.equal(runtime.status(), "action-limit"); assert.equal(runtime.summary().blocked_actions, 1);
    assert.equal(runtime.stateHash(), initial); assert.deepEqual(runtime.internal.blocks, level.blocks);
    assert.deepEqual(runtime.summary().novelty, [true, true, false, false, false, false, false]);
    assert.equal(runtime.summary().undos, 1); assert.equal(runtime.summary().resets, 1);
    await assert.rejects(() => runtime.apply("IR"), /terminal/);
    const reopened = await SlotskiBenchmarkRuntime.open(root, directory);
    assert.deepEqual(reopened.internal, runtime.internal);
    const animation = JSON.parse((await reopened.readRecord("move_history/move_1/index.json")).content);
    assert.equal(animation.frame_count, 2);
    assert.match((await reopened.readRecord(animation.frames[0].record)).content, /#I\.\.J#/);
    assert.match((await reopened.readRecord(animation.frames[1].record)).content, /#\.I\.J#/);
    assert.equal(reopened.internal.actionCount, 6);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("benchmark stops precisely when target reaches the exit and persists the winning frame", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slotski-win-"));
  try {
    solution ||= solveReference();
    await createRunIntegrity(root, directory, {});
    const runtime = await SlotskiBenchmarkRuntime.create(root, directory, { actionLimit: null });
    const result = await runtime.applySequence([...solution, "reset"]);
    assert.equal(result.completed_count, solution.length); assert.equal(result.stopped_early, true);
    assert.equal(runtime.status(), "won"); assert.equal(runtime.summary().levels_solved, 1);
    assert.equal(result.final_observation.target_row, 3);
    assert.equal((await SlotskiBenchmarkRuntime.open(root, directory)).status(), "won");
    await assert.rejects(() => runtime.apply("reset"), /terminal/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function fixture(directory, toolsEnabled = false, sequenceEnabled) {
  const binary = path.join(directory, "binary"); await writeFile(binary, "fixture");
  const configuration = { world: "slotski", provider: "claude-code", model: "claude-sonnet-5", effort: "low", tools_enabled: toolsEnabled,
    ...(sequenceEnabled === undefined ? {} : { sequence_enabled: sequenceEnabled }),
    action_limit: 10, start_room: "Level 1", effective_prompt_sha256: digest("play"), claude_policy: "claude-mcp-only-v1",
    claude_executable: binary, claude_version: "2.1.258", claude_sha256: digest("fixture"), provider_runtime: await providerRuntimeHashes(root), world_runtime: await worldRuntimeHashes(root) };
  const metadata = { ...configuration, integrity: await createRunIntegrity(root, directory, configuration) };
  await writeFile(path.join(directory, "run.json"), JSON.stringify(metadata)); await writeFile(path.join(directory, "prompt.md"), "play");
  await SlotskiBenchmarkRuntime.create(root, directory, { actionLimit: 10 }); return metadata;
}
test("Slotski integrity binds world, provider, scores, assets and Python condition", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slotski-integrity-"));
  try {
    const metadata = await fixture(directory); await verifySlotskiIntegrity(root, directory, metadata);
    for (const changes of [{ world: "main-world" }, { provider: "codex" }, { tools_enabled: true }, { sequence_enabled: false }, { sequence_enabled: "false" }]) await assert.rejects(() => verifySlotskiIntegrity(root, directory, { ...metadata, ...changes }));
    const file = path.join(directory, "summary.json"), original = await readFile(file, "utf8");
    await writeFile(file, original.replace('"levels_solved":0', '"levels_solved":30'));
    assert.throws(() => verifyCheckpoint(directory), /modified/); await writeFile(file, original);
    const manifestFile = path.join(directory, "integrity.json"), manifest = JSON.parse(await readFile(manifestFile));
    manifest.configuration.world_runtime["level-data/slotski/v1/world.json"] = "changed";
    const bytes = JSON.stringify(manifest); await writeFile(manifestFile, bytes);
    await assert.rejects(() => verifySlotskiIntegrity(root, directory, { ...metadata, integrity: { ...metadata.integrity, manifest_sha256: digest(bytes) } }), /runtime or levels changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("world adapters change only the MCP entrypoint in hardened CLI arguments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slotski-cli-"));
  try {
    await writeDirectToolModelCatalog(directory, "gpt-5.6-terra");
    for (const toolsEnabled of [false, true]) for (const resume of [false, true]) {
      const options = { projectRoot: root, runDirectory: directory, agentDirectory: path.join(directory, "agent-cwd"), model: "gpt-5.6-terra", effort: "low", toolsEnabled, prompt: "play",
        modelCatalogPath: path.join(directory, "sandbox-state/direct-model-catalog.json"), ...(resume ? { resumeThreadId: "same-thread", resumeSessionId: "same-session" } : {}) };
      // Use the catalog path returned by the existing boundary helper.
      const catalog = await writeDirectToolModelCatalog(directory, options.model); options.modelCatalogPath = path.join(directory, catalog.file);
      const original = buildCodexArguments(options), args = buildSlotskiCodexArguments(options);
      assert.equal(args.length, original.length); assert.equal(args.filter((value, i) => value !== original[i]).length, 1);
      assert(args.some(value => value.includes("benchmarking/slotski/mcp-server.mjs")));
      const baseClaude = buildClaudeArguments(options), iceClaude = buildSlotskiClaudeArguments(options);
      assert.equal(iceClaude.length, baseClaude.length); assert.equal(iceClaude.filter((value, i) => value !== baseClaude[i]).length, 1);
    }
    const supervisor = new BenchmarkSupervisor(root);
    assert.equal((await supervisor.validateSpec({ world: "slotski", model: "gpt-5.6-terra" })).startRoom, "Level 1");
    await assert.rejects(() => supervisor.validateSpec({ world: "secret" }), /Unknown/);
    await assert.rejects(() => supervisor.validateSpec({ world: "slotski", start_level: 30 }), /level 1/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("Slotski launch and resume preserve the signed board, prompt, world, session and action condition", async () => {
  const recordsRoot = await mkdtemp(path.join(os.tmpdir(), "slotski-launch-"));
  try {
    const binary = path.join(recordsRoot, "codex-fixture"); await writeFile(binary, "fixture");
    const supervisor = new BenchmarkSupervisor(root, { recordsRoot });
    supervisor.models = async () => ({ default_model: "gpt-6-astra", models: [{ id: "gpt-6-astra", provider: "codex", efforts: ["max"], default_effort: "max" }] });
    supervisor.codexCapabilityPolicy = () => ({ version: 4, name: "os-isolated-v4", codex_executable: binary, codex_sha256: digest("fixture"), disabled_features: [] });
    const dispatches = [];
    // Exercise the production launch/resume orchestration without invoking a
    // paid agent. MCP process tests exercise the actual tool boundary below.
    supervisor.startSlotski = (id, directory, prompt) => dispatches.push({ id, directory, prompt });
    for (const toolsEnabled of [false, true]) for (const sequenceEnabled of [false, true]) {
      const launched = await supervisor.launch({ world: "slotski", model: "gpt-6-astra", effort: "max", tools_enabled: toolsEnabled, sequence_enabled: sequenceEnabled, action_limit: 1000 });
      assert.equal(launched.world, "slotski"); assert.equal(launched.status, "queued");
      assert.equal(launched.action_count, 0); assert.equal(launched.levels_total, 1);
      assert.equal(launched.capability_boundary_verified, true);
      const directory = supervisor.runDirectory(launched.id);
      const saved = JSON.parse(await readFile(path.join(directory, "run.json")));
      await verifySlotskiIntegrity(root, directory, saved);
      assert.equal(saved.sequence_enabled, sequenceEnabled);
      assert.equal(saved.service_tier, null);
      await assert.rejects(() => verifySlotskiIntegrity(root, directory, { ...saved, sequence_enabled: !sequenceEnabled }), /sequence_enabled/);
      if (!sequenceEnabled) {
        await assert.rejects(() => verifySlotskiIntegrity(root, directory, { ...saved, sequence_enabled: undefined }), /sequence_enabled/);
        assert.doesNotMatch(dispatches.at(-1).prompt, /maze_sequence/);
        assert.match(dispatches.at(-1).prompt, /one action per tool call/);
      }
      assert.match(dispatches.at(-1).prompt, /permanent uppercase label A–Z/);
      assert.match(dispatches.at(-1).prompt, toolsEnabled ? /Python is enabled through python_exec only/ : /Python is disabled/);
      await (await SlotskiBenchmarkRuntime.open(root, directory)).apply("IR");
      const state = await readFile(path.join(directory, "game-state.json"), "utf8");
      Object.assign(saved, { status: "paused", codex_thread_id: "same-astra-session" });
      await writeFile(path.join(directory, "run.json"), JSON.stringify(saved));
      const resumed = await supervisor.resume(launched.id);
      assert.equal(resumed.codex_thread_id, "same-astra-session"); assert.equal(resumed.action_count, 1);
      assert.match(dispatches.at(-1).prompt, /Slotski benchmark at accepted action 1/);
      if (!sequenceEnabled) assert.match(dispatches.at(-1).prompt, /submit one action, inspect its result/);
      assert.equal(await readFile(path.join(directory, "game-state.json"), "utf8"), state);
      verifyCheckpoint(directory);
      assert.equal((await supervisor.listInterviews(launched.id)).available, false);
      await assert.rejects(() => supervisor.backfillDisplayHistory(launched.id, directory), /Slotski frame is missing/);
    }
    assert.equal(dispatches.length, 8);
    for (const sequence_enabled of [null, "false", 0, {}]) await assert.rejects(() => supervisor.validateSpec({ world: "slotski", sequence_enabled }), /boolean/);
    await assert.rejects(() => supervisor.validateSpec({ world: "slotski", service_tier: "fast" }), /standard speed/);
    assert.equal((await supervisor.validateSpec({ world: "ice-maze", model: "gpt-6-astra" })).world, "ice-maze");
    assert.equal((await supervisor.validateSpec({ world: "main-world", model: "gpt-6-astra" })).startRoom, "HxI");
  } finally { await rm(recordsRoot, { recursive: true, force: true }); }
});
test("single-action CLI catalogs and event boundaries exclude sequences while preserving isolation and standard speed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "slotski-single-cli-"));
  try {
    const catalog = await writeDirectToolModelCatalog(directory, "gpt-6-astra");
    for (const toolsEnabled of [false, true]) for (const resume of [false, true]) {
      const options = { projectRoot: root, runDirectory: directory, agentDirectory: path.join(directory, "agent-cwd"),
        model: "gpt-6-astra", effort: "max", toolsEnabled, sequenceEnabled: false, serviceTier: null,
        disabledFeatures: ["fast_mode"], modelCatalogPath: path.join(directory, catalog.file), prompt: "play",
        ...(resume ? { resumeThreadId: "same-thread", resumeSessionId: "same-session" } : {}) };
      const args = buildSlotskiCodexArguments(options), expected = slotskiTools(options);
      assert(args.includes(`mcp_servers.mazebench.enabled_tools=${JSON.stringify(expected)}`));
      assert(!args.some(arg => arg.includes("maze_sequence")));
      assert(args.some((arg, i) => arg === "--disable" && args[i + 1] === "fast_mode"));
      assert(!args.some(arg => arg.startsWith("service_tier=")));
      assertSlotskiCodexArguments(args, options);
      assert.throws(() => assertSlotskiCodexArguments(args.filter(arg => arg !== "--ignore-user-config"), options), /ignore-user-config/);
      assert.throws(() => assertSlotskiCodexArguments(args.map(arg => arg.startsWith("mcp_servers.mazebench.enabled_tools=")
        ? `mcp_servers.mazebench.enabled_tools=${JSON.stringify([...expected, "maze_sequence"])}` : arg), options), /catalog/);
      for (const tool of ["maze_action", "maze_observe", "maze_sequence", "python_exec", "shell"]) {
        const violation = slotskiCodexBoundaryViolation({ type: "item.started", item: { type: "mcp_tool_call", server: "mazebench", tool } }, options);
        assert.equal(Boolean(violation), !expected.includes(tool));
      }
      const claude = buildSlotskiClaudeArguments(options), allowed = expected.map(name => `mcp__mazebench__${name}`);
      assert.equal(claude[claude.indexOf("--allowedTools") + 1], allowed.join(","));
      assert.deepEqual(JSON.parse(claude[claude.indexOf("--settings") + 1]).permissions.allow, allowed);
      const init = { type: "system", subtype: "init", model: options.model, permissionMode: "dontAsk", tools: allowed, mcp_servers: [{ name: "mazebench", status: "connected" }] };
      assert.equal(slotskiClaudeBoundaryViolation(init, options), null);
      assert(slotskiClaudeBoundaryViolation({ ...init, tools: [...allowed, "mcp__mazebench__maze_sequence"] }, options));
      assert(slotskiClaudeBoundaryViolation({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__mazebench__maze_sequence" }] } }, options));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("real Slotski MCP exposes only selected tools and rejects cheating paths and state injection", { timeout: 60000 }, async () => {
  for (const toolsEnabled of [false, true]) for (const sequenceEnabled of [false, true]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "slotski-mcp-")); let child;
    try {
      await fixture(directory, toolsEnabled, sequenceEnabled);
      child = spawn(process.execPath, [path.join(root, "benchmarking/slotski/mcp-server.mjs")], { env: { PATH: process.env.PATH, MAZEBENCH_PROJECT_ROOT: root,
        MAZEBENCH_RUN_DIRECTORY: directory, MAZEBENCH_PYTHON_ENABLED: toolsEnabled ? "1" : "0", MAZEBENCH_CAPABILITY_POLICY: "os-isolated-v4" }, stdio: ["pipe", "pipe", "pipe"] });
      const pending = new Map(); let id = 0, stderr = "";
      child.stderr.on("data", chunk => stderr += chunk);
      readline.createInterface({ input: child.stdout }).on("line", line => { const response = JSON.parse(line); pending.get(response.id)?.resolve(response); pending.delete(response.id); });
      child.on("exit", () => { for (const wait of pending.values()) wait.reject(new Error(stderr || "MCP exited")); });
      const request = (method, params) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n"); });
      const list = await request("tools/list"); assert.deepEqual(list.result.tools.map(t => t.name), slotskiTools({ toolsEnabled, sequenceEnabled }));
      if (!sequenceEnabled) assert(!JSON.stringify(list).includes("maze_sequence"));
      assert.deepEqual((await request("resources/list")).result.resources, []);
      const call = (name, args = {}) => request("tools/call", { name, arguments: args });
      const observe = await call("maze_observe"); assert.equal(observe.result.structuredContent.level_number, 1); assert(observe.result.structuredContent.records.files.includes("move_history/move_0.txt"));
      if (!sequenceEnabled) {
        const before = await readFile(path.join(directory, "game-state.json"), "utf8");
        for (const args of [{ sequence: "IR" }, { sequence: "IR2" }, { actions: ["IR", "IL"] }])
          assert.equal((await call("maze_sequence", args)).result.isError, true);
        for (const action of ["IR2", "i right 2 times", "IR IL", ["IR", "IL"], "undo2", "reset reset"])
          assert.equal((await call("maze_action", { action })).result.isError, true);
        assert.equal(await readFile(path.join(directory, "game-state.json"), "utf8"), before);
      }
      for (const [name, args] of [["maze_action", { action: "next" }], ["maze_action", { action: "room AxA" }], ["maze_observe", { record: "../../level-data/slotski/v1/world.json" }], ["maze_observe", { level: 30 }], ["maze_action", { action: "solve" }], ["maze_action", { action: "A down", blocks: [] }], ["maze_sequence", { sequence: "IR ZU" }], ["shell", {}], ["maze_sequence", { sequence: "IR", actions: ["IR"] }]]) assert.equal((await call(name, args)).result.isError, true);
      if (!toolsEnabled) assert.equal((await call("python_exec", { code: "print(1)", script_path: "a.py" })).result.isError, true);
      else {
        const code = `from pathlib import Path\nprint(2 + 2)\ntry:\n    Path(${JSON.stringify(path.join(root, "level-data/slotski/v1/world.json"))}).read_text()\n    print("LEAK")\nexcept (PermissionError, FileNotFoundError):\n    print("unseen-levels-blocked")\n`;
        const python = await call("python_exec", { code, script_path: "check.py" });
        assert.equal(python.result.isError, false);
        assert.equal(python.result.structuredContent.exit_code, 0);
        assert.equal(python.result.structuredContent.stdout.trim(), "4\nunseen-levels-blocked");
      }
      const action = await call("maze_action", { action: "block I move right" }); assert.equal(action.result.structuredContent.observation.action_count, 1);
      const animation = action.result.structuredContent.action.animation;
      const animationIndex = await call("maze_observe", { record: animation.index_record });
      const frames = JSON.parse(animationIndex.result.structuredContent.content).frames;
      assert.equal(frames.length, animation.frame_count);
      const tick = await call("maze_observe", { record: frames[1].record });
      assert.equal(tick.result.isError, false); assert.equal(tick.result.structuredContent.observation_revision, 1);
      assert(tick.result.structuredContent.content.includes("frame 1/"));
      for (const record of ["move_history/move_2/index.json", "move_history/move_1/frame_9999.txt", "move_history/move_1/../../game-state.json"]) {
        assert.equal((await call("maze_observe", { record })).result.isError, true);
      }
      const frame = await call("maze_observe", { record: "move_history/move_1.txt" }); assert(frame.result.structuredContent.content.includes("move 1"));
      const sequence = await call("maze_sequence", { sequence: "i left, i right 2 times" });
      assert.equal(sequence.result.isError, !sequenceEnabled);
      if (sequenceEnabled) {
        assert.equal(sequence.result.structuredContent.completed_count, 3);
        assert.equal(sequence.result.structuredContent.final_observation.action_count, 4);
        assert.deepEqual(sequence.result.structuredContent.steps.map(step => step.action.action), ["IL", "IR", "IR"]);
        assert(sequence.result.structuredContent.steps.every(step => step.action.animation.frame_count === 2));
      } else {
        assert.equal((await call("maze_observe")).result.structuredContent.action_count, 1);
        for (const [action, count] of [["undo", 2], ["reset", 3], ["AU", 4]]) {
          const result = await call("maze_action", { action });
          assert.equal(result.result.isError, false);
          assert.equal(result.result.structuredContent.observation.action_count, count);
        }
      }
      verifyCheckpoint(directory);
    } finally { child?.kill("SIGTERM"); if (child && child.exitCode === null) await new Promise(resolve => child.once("exit", resolve)); await rm(directory, { recursive: true, force: true }); }
  }
});
