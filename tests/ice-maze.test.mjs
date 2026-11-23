import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseIceLevel, slideIce, iceSolved, IceSession } from "../ice-maze/v1/engine.mjs";
import { IceBenchmarkRuntime, expandIceSequence } from "../ice-maze/v1/benchmark-runtime.mjs";
import { BenchmarkSupervisor } from "../benchmarking/worlds/supervisor.mjs";
import { createRunIntegrity, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { digest, providerRuntimeHashes, buildClaudeArguments } from "../benchmarking/providers/claude-policy.mjs";
import { buildCodexArguments, writeDirectToolModelCatalog } from "../benchmarking/v1/supervisor.mjs";
import { worldRuntimeHashes, verifyIceIntegrity, buildIceCodexArguments, buildIceClaudeArguments } from "../benchmarking/worlds/policy.mjs";

const root = path.resolve(import.meta.dirname, ".."), world = JSON.parse(await readFile(path.join(root, "level-data/ice-maze/v1/world.json")));
// Independent, test-only simultaneous one-cell stepping reference. It does not
// use the engine's leading-player ordering or any imported solution.
function referenceSlide(level, players, action) {
  const [dx, dy] = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] }[action];
  let positions = structuredClone(players);
  while (true) {
    const moving = positions.map(p => level.terrain[p.y + dy]?.[p.x + dx] === ".");
    let changed;
    do {
      changed = false;
      positions.forEach((p, i) => { const other = positions.findIndex(q => q.x === p.x + dx && q.y === p.y + dy); if (moving[i] && other >= 0 && !moving[other]) { moving[i] = false; changed = true; } });
    } while (changed);
    if (!moving.some(Boolean)) return positions;
    positions = positions.map((p, i) => moving[i] ? { x: p.x + dx, y: p.y + dy } : p);
  }
}
const stateKey = players => players.map(p => `${p.x},${p.y}`).sort().join(";");
function solve(level) {
  const queue = [{ players: level.players, path: [] }], seen = new Set([stateKey(level.players)]);
  for (let i = 0; i < queue.length; i++) {
    const state = queue[i]; if (iceSolved(level, state.players)) return state.path;
    for (const action of ["up", "right", "down", "left"]) {
      const players = referenceSlide(level, state.players, action), key = stateKey(players);
      if (!seen.has(key)) { seen.add(key); queue.push({ players, path: [...state.path, action] }); }
    }
  }
  throw new Error(`Unsolvable level ${level.id}`);
}
const solutions = world.levels.map(data => solve(parseIceLevel(data)));

test("all 30 boards are ordered, answer-free, solvable, and match independent simultaneous sliding", () => {
  assert.equal(world.levels.length, 30); assert.equal(world.topology, "sequential");
  for (const [index, data] of world.levels.entries()) {
    assert.deepEqual(Object.keys(data).sort(), ["board", "id"]); assert.equal(data.id, index + 1);
    const level = parseIceLevel(data); let players = level.players;
    for (const direction of solutions[index]) {
      const result = slideIce(level, players, direction);
      assert.deepEqual(result.players, referenceSlide(level, players, direction)); players = result.players;
    }
    assert(iceSolved(level, players));
  }
});
test("goals remain slippery; arbitrary player counts, collisions and open edges are correct", () => {
  const level = parseIceLevel({ id: 1, board: [".a.e.a.a."] .concat(["........."]) });
  const result = slideIce(level, level.players, "right");
  assert.deepEqual(result.players, [{ x: 6, y: 0 }, { x: 7, y: 0 }, { x: 8, y: 0 }]);
  assert.equal(result.solved, false); // Player crossed the goal without stopping.
  const occupied = parseIceLevel({ id: 2, board: [".b..", "...."] });
  assert.equal(iceSolved(occupied, occupied.players), true);
  assert.equal(slideIce(occupied, occupied.players, "right").solved, false);
  assert.throws(() => slideIce(level, [level.players[0], level.players[0], level.players[2]], "right"), /state/);
});
test("human undo/reset restore players and ineffective moves do not increment moves", () => {
  const session = new IceSession(world.levels[0]); const initial = structuredClone(session.players);
  session.move("up"); assert.equal(session.moves, 1); session.move("up"); assert.equal(session.moves, 1);
  session.undo(); assert.deepEqual(session.players, initial); assert.equal(session.moves, 0);
  for (const action of solutions[0]) session.move(action);
  assert(session.solved); session.undo(); assert(!session.solved); session.reset(); assert.deepEqual(session.players, initial);
});
test("benchmark solves levels sequentially, records frames, and ends exactly on level 30", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ice-runtime-"));
  try {
    const runtime = await IceBenchmarkRuntime.create(root, directory, { actionLimit: null });
    await assert.rejects(() => runtime.apply("next"), /Cover every goal/);
    await assert.rejects(() => runtime.apply("level 30"), /Unknown/);
    for (const [index, solution] of solutions.entries()) {
      const start = runtime.internal.actionCount;
      const result = await runtime.applySequence([...solution, "next", "up"]);
      assert.equal(result.completed_count, solution.length); assert.equal(result.stopped_early, true);
      assert.equal(runtime.internal.actionCount, start + solution.length);
      assert.equal(runtime.summary().levels_solved, index + 1);
      assert.equal(runtime.internal.levelIndex, index);
      if (index < 29) {
        assert.equal(runtime.status(), "level-complete");
        await assert.rejects(() => runtime.apply("reset"), /Level complete/);
        await runtime.apply("next");
        assert.deepEqual(runtime.internal.players, parseIceLevel(world.levels[index + 1]).players);
        assert.equal(runtime.internal.history.length, 0);
      }
    }
    assert.equal(runtime.status(), "won");
    await assert.rejects(() => runtime.apply("up"), /terminal/);
    const record = await runtime.readRecord("move_history/move_0.txt"); assert(record.content.includes("initial · Level 1"));
    const final = await runtime.readRecord(`move_history/move_${runtime.internal.actionCount}.txt`); assert(final.content.includes("Level 30"));
    for (const name of ["../game-state.json", "world.json", "move_history/move_99999.txt", "file:///etc/passwd"]) await assert.rejects(() => runtime.readRecord(name), /Unknown/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("blocked moves, undo and reset spend budget; a sequence cannot overrun it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ice-budget-"));
  try {
    const runtime = await IceBenchmarkRuntime.create(root, directory, { actionLimit: 5 });
    const result = await runtime.applySequence(["up", "up", "undo", "reset", "up", "left"]);
    assert.equal(result.completed_count, 5); assert.equal(runtime.status(), "action-limit");
    assert.equal(runtime.summary().blocked_actions, 1); assert.equal(runtime.summary().undos, 1);
    assert.equal(runtime.summary().resets, 1); assert.equal(runtime.summary().levels_solved, 0);
    assert.deepEqual(expandIceSequence("U,R D L"), ["up", "right", "down", "left"]);
    assert.throws(() => expandIceSequence(["up", "camera right"]), /Unknown/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function fixture(directory, toolsEnabled = false) {
  const binary = path.join(directory, "binary"); await writeFile(binary, "fixture");
  const configuration = { world: "ice-maze", provider: "claude-code", model: "claude-sonnet-5", effort: "low", tools_enabled: toolsEnabled,
    action_limit: 10, start_room: "Level 1", effective_prompt_sha256: digest("play"), claude_policy: "claude-mcp-only-v1",
    claude_executable: binary, claude_version: "2.1.258", claude_sha256: digest("fixture"), provider_runtime: await providerRuntimeHashes(root), world_runtime: await worldRuntimeHashes(root) };
  const metadata = { ...configuration, integrity: await createRunIntegrity(root, directory, configuration) };
  await writeFile(path.join(directory, "run.json"), JSON.stringify(metadata)); await writeFile(path.join(directory, "prompt.md"), "play");
  await IceBenchmarkRuntime.create(root, directory, { actionLimit: 10 }); return metadata;
}
test("Ice integrity binds world, provider, scores, assets and Python condition", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ice-integrity-"));
  try {
    const metadata = await fixture(directory); await verifyIceIntegrity(root, directory, metadata);
    for (const changes of [{ world: "main-world" }, { provider: "codex" }, { tools_enabled: true }]) await assert.rejects(() => verifyIceIntegrity(root, directory, { ...metadata, ...changes }));
    const file = path.join(directory, "summary.json"), original = await readFile(file, "utf8");
    await writeFile(file, original.replace('"levels_solved":0', '"levels_solved":30'));
    assert.throws(() => verifyCheckpoint(directory), /modified/); await writeFile(file, original);
    const manifestFile = path.join(directory, "integrity.json"), manifest = JSON.parse(await readFile(manifestFile));
    manifest.configuration.world_runtime["level-data/ice-maze/v1/world.json"] = "changed";
    const bytes = JSON.stringify(manifest); await writeFile(manifestFile, bytes);
    await assert.rejects(() => verifyIceIntegrity(root, directory, { ...metadata, integrity: { ...metadata.integrity, manifest_sha256: digest(bytes) } }), /runtime or levels changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("world adapters change only the MCP entrypoint in hardened CLI arguments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ice-cli-"));
  try {
    await writeDirectToolModelCatalog(directory, "gpt-5.6-terra");
    for (const toolsEnabled of [false, true]) for (const resume of [false, true]) {
      const options = { projectRoot: root, runDirectory: directory, agentDirectory: path.join(directory, "agent-cwd"), model: "gpt-5.6-terra", effort: "low", toolsEnabled, prompt: "play",
        modelCatalogPath: path.join(directory, "sandbox-state/direct-model-catalog.json"), ...(resume ? { resumeThreadId: "same-thread", resumeSessionId: "same-session" } : {}) };
      // Use the catalog path returned by the existing boundary helper.
      const catalog = await writeDirectToolModelCatalog(directory, options.model); options.modelCatalogPath = path.join(directory, catalog.file);
      const original = buildCodexArguments(options), args = buildIceCodexArguments(options);
      assert.equal(args.length, original.length); assert.equal(args.filter((value, i) => value !== original[i]).length, 1);
      assert(args.some(value => value.includes("benchmarking/worlds/mcp-server.mjs")));
      const baseClaude = buildClaudeArguments(options), iceClaude = buildIceClaudeArguments(options);
      assert.equal(iceClaude.length, baseClaude.length); assert.equal(iceClaude.filter((value, i) => value !== baseClaude[i]).length, 1);
    }
    const supervisor = new BenchmarkSupervisor(root);
    assert.equal((await supervisor.validateSpec({ world: "ice-maze", model: "gpt-5.6-terra" })).startRoom, "Level 1");
    await assert.rejects(() => supervisor.validateSpec({ world: "secret" }), /Unknown/);
    await assert.rejects(() => supervisor.validateSpec({ world: "ice-maze", start_level: 30 }), /level 1/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("real Ice MCP exposes only selected tools and rejects cheating paths and skipped levels", { timeout: 60000 }, async () => {
  for (const toolsEnabled of [false, true]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ice-mcp-")); let child;
    try {
      await fixture(directory, toolsEnabled);
      child = spawn(process.execPath, [path.join(root, "benchmarking/worlds/mcp-server.mjs")], { env: { PATH: process.env.PATH, MAZEBENCH_PROJECT_ROOT: root,
        MAZEBENCH_RUN_DIRECTORY: directory, MAZEBENCH_PYTHON_ENABLED: toolsEnabled ? "1" : "0", MAZEBENCH_CAPABILITY_POLICY: "os-isolated-v4" }, stdio: ["pipe", "pipe", "pipe"] });
      const pending = new Map(); let id = 0, stderr = "";
      child.stderr.on("data", chunk => stderr += chunk);
      readline.createInterface({ input: child.stdout }).on("line", line => { const response = JSON.parse(line); pending.get(response.id)?.resolve(response); pending.delete(response.id); });
      child.on("exit", () => { for (const wait of pending.values()) wait.reject(new Error(stderr || "MCP exited")); });
      const request = (method, params) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n"); });
      const list = await request("tools/list"); assert.deepEqual(list.result.tools.map(t => t.name), ["maze_observe", "maze_action", "maze_sequence", ...(toolsEnabled ? ["python_exec"] : [])]);
      assert.deepEqual((await request("resources/list")).result.resources, []);
      const call = (name, args = {}) => request("tools/call", { name, arguments: args });
      const observe = await call("maze_observe"); assert.equal(observe.result.structuredContent.level_number, 1); assert(observe.result.structuredContent.records.files.includes("move_history/move_0.txt"));
      for (const [name, args] of [["maze_action", { action: "next" }], ["maze_action", { action: "room AxA" }], ["maze_observe", { record: "../../level-data/ice-maze/v1/world.json" }], ["maze_observe", { level: 30 }], ["shell", {}], ["maze_sequence", { sequence: "U", actions: ["up"] }]]) assert.equal((await call(name, args)).result.isError, true);
      if (!toolsEnabled) assert.equal((await call("python_exec", { code: "print(1)", script_path: "a.py" })).result.isError, true);
      else {
        const code = `from pathlib import Path\nprint(2 + 2)\ntry:\n    Path(${JSON.stringify(path.join(root, "level-data/ice-maze/v1/world.json"))}).read_text()\n    print("LEAK")\nexcept (PermissionError, FileNotFoundError):\n    print("unseen-levels-blocked")\n`;
        const python = await call("python_exec", { code, script_path: "check.py" });
        assert.equal(python.result.isError, false);
        assert.equal(python.result.structuredContent.exit_code, 0);
        assert.equal(python.result.structuredContent.stdout.trim(), "4\nunseen-levels-blocked");
      }
      const action = await call("maze_action", { action: "up" }); assert.equal(action.result.structuredContent.observation.action_count, 1);
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
      verifyCheckpoint(directory);
    } finally { child?.kill("SIGTERM"); if (child && child.exitCode === null) await new Promise(resolve => child.once("exit", resolve)); await rm(directory, { recursive: true, force: true }); }
  }
});
