const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const terminalScript = path.join(ROOT_DIR, "scripts", "maze-terminal.js");
const bridgeScript = path.join(ROOT_DIR, "scripts", "maze-bridge.js");
const modelReplScript = path.join(ROOT_DIR, "scripts", "maze-model-repl.js");
const {
  applyMove,
  buildScorecard,
  createTerminalContext,
  GAME_WON_GEM_COUNT,
  isGameWon,
  loadMazeEngine,
  replayActionCommands,
  renderScreen,
  resetLevel,
  rotateCamera,
  screenMoveVector,
  undoMove
} = require(terminalScript);
const mazeEngine = loadMazeEngine();

{
  const source = fs.readFileSync(
    path.join(ROOT_DIR, "environments", "mazebench", "mazebench", "mazebench.py"),
    "utf8"
  );
  const match = source.match(/^GAME_WON_GEM_COUNT\s*=\s*(\d+)\s*$/m);
  assert.equal(GAME_WON_GEM_COUNT, Number(match?.[1]));
}

function runTerminal(args) {
  return execFileSync(process.execPath, [terminalScript, ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8"
  });
}

function runBridge(commands, args = []) {
  const input = `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`;
  const output = execFileSync(process.execPath, [bridgeScript, ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    input,
    maxBuffer: 10 * 1024 * 1024
  });

  return output.trim().split("\n").map((line) => JSON.parse(line));
}

function runModelRepl(input, args = []) {
  return execFileSync(process.execPath, [modelReplScript, ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    input,
    maxBuffer: 20 * 1024 * 1024
  });
}

function body(output) {
  return output.split("\n").slice(1).join("\n");
}

function bodyRows(output) {
  return body(output).split("\n").filter(Boolean);
}

function countMatches(value, pattern) {
  return (value.match(pattern) || []).length;
}

function assertMove(move, yaw, expected) {
  assert.deepEqual(screenMoveVector(move, yaw), expected);
}

function createContext(overrides = {}) {
  return createTerminalContext(mazeEngine, {
    gameId: "maze",
    levelId: "level_AxA",
    moves: "",
    pitch: 0,
    yaw: 0,
    once: true,
    ...overrides
  });
}

function playerPosition(context) {
  for (let index = 0; index < context.engine.actorCount; index += 1) {
    if (
      !context.state.actorRemoved[index] &&
      (context.engine.actorTypes[index] === "player" ||
        context.engine.actorTypes[index] === "circle_player")
    ) {
      return {
        elevation: context.state.actorElevation[index],
        x: context.state.actorX[index],
        y: context.state.actorY[index]
      };
    }
  }

  return null;
}

function renderSynthetic(playData, overrides = {}) {
  const engine = mazeEngine.createEngine(playData);
  return renderScreen({
    engine,
    level: { id: playData.levelId },
    options: {
      pitch: 2,
      yaw: 0,
      ...overrides
    },
    playData,
    state: engine.cloneState(engine.initialState)
  });
}

function syntheticFloor(width, height) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({
      type: "floor",
      label: "Floor",
      imageUrl: null,
      underlay: null,
      raised: false
    }))
  );
}

{
  assertMove("U", 0, { dx: 0, dy: -1 });
  assertMove("D", 0, { dx: 0, dy: 1 });
  assertMove("L", 0, { dx: -1, dy: 0 });
  assertMove("R", 0, { dx: 1, dy: 0 });

  assertMove("U", 1, { dx: -1, dy: 0 });
  assertMove("D", 1, { dx: 1, dy: 0 });
  assertMove("L", 1, { dx: 0, dy: 1 });
  assertMove("R", 1, { dx: 0, dy: -1 });

  assertMove("U", 2, { dx: 0, dy: 1 });
  assertMove("D", 2, { dx: 0, dy: -1 });
  assertMove("L", 2, { dx: 1, dy: 0 });
  assertMove("R", 2, { dx: -1, dy: 0 });

  assertMove("U", 3, { dx: 1, dy: 0 });
  assertMove("D", 3, { dx: -1, dy: 0 });
  assertMove("L", 3, { dx: 0, dy: -1 });
  assertMove("R", 3, { dx: 0, dy: 1 });
}

{
  const context = createContext();

  applyMove(context, "U");
  assert.deepEqual(playerPosition(context), { elevation: 0, x: 8, y: 3 });
  assert.equal(undoMove(context), true);
  assert.deepEqual(playerPosition(context), { elevation: 0, x: 8, y: 4 });
}

{
  const context = createContext();

  "UUUUU".split("").forEach((move) => applyMove(context, move));
  assert.equal(context.level.id, "level_AxP");
  assert.deepEqual(playerPosition(context), { elevation: 0, x: 8, y: 15 });
  assert.equal(undoMove(context), true);
  assert.equal(context.level.id, "level_AxA");
  assert.deepEqual(playerPosition(context), { elevation: 0, x: 8, y: 0 });
}

{
  const context = createContext();

  applyMove(context, "U");
  applyMove(context, "U");
  assert.deepEqual(playerPosition(context), { elevation: 0, x: 8, y: 2 });
  assert.equal(resetLevel(context), true);
  assert.deepEqual(playerPosition(context), { elevation: 0, x: 8, y: 4 });
  assert.equal(undoMove(context), false);
}

{
  const context = createContext();

  applyMove(context, "U");
  rotateCamera(context, "left");
  undoMove(context);
  resetLevel(context);
  assert.deepEqual(replayActionCommands(context), [
    "up",
    "rotate camera left",
    "undo",
    "reset"
  ]);
}

{
  const context = createContext();

  context.stats.startedAtMs = 1000;
  "UUUUU".split("").forEach((move) => applyMove(context, move));
  const scorecard = JSON.parse(buildScorecard(context, 61000)).scorecard;

  assert.deepEqual(scorecard.result, {
    percent: 0,
    won: false
  });
  assert.equal(scorecard.gems.collected, 0);
  assert.equal(scorecard.gems.total > 0, true);
  assert.equal(scorecard.rooms.visited, 2);
  assert.equal(scorecard.rooms.total > 0, true);
  assert.deepEqual(scorecard.rooms.ids, ["level_AxA", "level_AxP"]);
  assert.equal(typeof scorecard.tiles.visited, "number");
  assert.equal(Object.prototype.hasOwnProperty.call(scorecard.tiles, "visited_with_elevation"), false);
  assert.equal(scorecard.duration.milliseconds, 60000);
  assert.equal(scorecard.duration.seconds, 60);
  assert.deepEqual(scorecard.current_position, {
    elevation: 0,
    level_id: "level_AxP",
    x: 8,
    y: 15
  });
  assert.equal(scorecard.actions.moves.attempted, 5);
  assert.equal(scorecard.actions.moves.successful, 5);
  assert.equal(scorecard.actions.moves.blocked, 0);
  assert.equal(scorecard.actions.moves.room_transitions, 1);
  assert.equal(scorecard.actions.moves.by_direction.up.attempted, 5);
  assert.equal(scorecard.actions.moves.by_direction.up.successful, 5);

  context.options.gameWonGemCount = 1;
  assert.equal(isGameWon(context), false);
  context.stats.collectedGemIds.add("fake-gem-id");
  assert.equal(isGameWon(context), true);
  const wonScorecard = JSON.parse(buildScorecard(context, 61000)).scorecard;
  assert.deepEqual(wonScorecard.result, {
    percent: 100,
    won: true
  });
}

{
  const playData = {
    actors: [
      { type: "gem", x: 0, y: 0, removed: false, elevation: 0, imageUrl: null },
      { type: "player", x: 1, y: 0, removed: false, elevation: 0, imageUrl: null }
    ],
    gameId: "maze",
    height: 1,
    levelId: "gem_suppress",
    levelLabel: "Gem Suppress",
    terrain: syntheticFloor(2, 1),
    width: 2
  };
  const engine = mazeEngine.createEngine(playData);
  const baseContext = {
    engine,
    level: { id: playData.levelId },
    options: { pitch: 0, yaw: 0 },
    playData,
    state: engine.cloneState(engine.initialState)
  };

  assert.match(body(renderScreen(baseContext)), /G/);

  const collectedContext = {
    ...baseContext,
    state: engine.cloneState(engine.initialState),
    stats: {
      collectedGemIds: new Set(["gem_suppress:gem:0:0,0,0"])
    }
  };

  assert.doesNotMatch(body(renderScreen(collectedContext)), /G/);
}

{
  const output = renderSynthetic({
    actors: [],
    gameId: "maze",
    height: 1,
    levelId: "stack_test",
    levelLabel: "Stack Test",
    terrain: [
      [
        {
          type: "ice_block",
          layers: [
            { type: "floor", elevation: 0 },
            { type: "wall", elevation: 0 },
            { type: "ice_block", elevation: 1 }
          ]
        }
      ]
    ],
    width: 1
  });

  assert.match(body(output), /I/);
  assert.match(body(output), /i/);
  assert.match(body(output), /w/);
}

{
  const output = runTerminal(["--level", "level_AxA", "--once"]);

  assert.match(output, /maze level_AxA \| view=top-diagonal yaw=0/);
}

{
  const output = runTerminal(["--level", "level_AxA", "--view", "top", "--once"]);

  assert.match(output, /maze level_AxA \| view=top yaw=0/);
  assert.match(output, /P/);
  assert.doesNotMatch(body(output), /[a-z]/);
}

{
  const output = runTerminal(["--level", "level_AxA", "--view", "diagonal", "--once"]);

  assert.match(output, /maze level_AxA \| view=diagonal yaw=0/);
  assert.match(output, /p/);
  assert.match(body(output), /[A-Z]/);
  assert.match(body(output), /[A-Za-z] +[A-Za-z]/);
  assert.equal(bodyRows(output)[0].startsWith(" "), false);
  assert.equal(/pAp|appA/.test(body(output)), false);
  assert.equal(countMatches(body(output), /a/g) < 80, true);
}

{
  const output = runTerminal(["--level", "level_AxA", "--view", "top", "--moves", "UUUUU", "--once"]);

  assert.match(output, /maze level_AxP \| view=top yaw=0/);
  assert.match(body(output), /P/);
  assert.doesNotMatch(body(output), /[a-z]/);
}

{
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-terminal-replay-"));

  try {
    const output = runTerminal([
      "--level",
      "level_AxA",
      "--view",
      "top",
      "--moves",
      "U",
      "--once",
      "--record-replay",
      "--replay-out-dir",
      outDir
    ]);
    const scorecardPath = path.join(outDir, "maze_scorecard.json");
    const actionsPath = path.join(outDir, "maze_actions.txt");
    const videoPath = path.join(outDir, "maze_replay.mp4");
    const replayPath = path.join(outDir, "maze_replay.json");
    const resultsPath = path.join(outDir, "results.jsonl");

    assert.match(output, /Replay artifacts:/);
    assert.match(output, /maze_scorecard\.json/);
    assert.equal(fs.existsSync(scorecardPath), true);
    assert.equal(fs.existsSync(actionsPath), true);
    assert.equal(fs.existsSync(replayPath), true);
    assert.equal(fs.existsSync(resultsPath), true);
    assert.equal(fs.existsSync(videoPath), false);
    assert.equal(fs.readFileSync(actionsPath, "utf8"), "up\n");

    const replay = JSON.parse(fs.readFileSync(replayPath, "utf8"));
    assert.equal(replay.start_level_id, "level_AxA");
    assert.deepEqual(replay.initial, { view: "top", yaw: 0 });
    assert.equal(replay.actions[0].command, "up");

    const row = JSON.parse(fs.readFileSync(resultsPath, "utf8").trim());
    assert.equal(row.maze_actions[0].command, "up");
    assert.equal(row.maze_scorecard.rooms.starting, "level_AxA");
  } finally {
    fs.rmSync(outDir, { force: true, recursive: true });
  }
}

{
  const output = runTerminal([
    "--level",
    "level_AxA",
    "--view",
    "side",
    "--once"
  ]);
  const rows = bodyRows(output);

  assert.match(output, /maze level_AxA \| view=side yaw=0/);
  assert.match(body(output), /[a-z]/);
  assert.doesNotMatch(body(output), /[A-Z]/);
  assert.match(body(output), /[a-z] +[a-z]/);
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((row) => row.includes("p")).length, 4);
  assert.equal(rows.some((row) => row.includes("p") && row.includes("a")), false);
}

{
  const output = runTerminal(["--level", "level_AxA", "--view", "side", "--yaw", "1", "--once"]);

  assert.match(output, /maze level_AxA \| view=side yaw=1/);
  assert.doesNotMatch(body(output), /p/);
}

{
  const payload = JSON.parse(runTerminal([
    "--level",
    "level_HxI",
    "--view",
    "diagonal",
    "--json",
    "--solve"
  ]));

  assert.equal(payload.levelId, "level_HxI");
  assert.equal(payload.view, "diagonal");
  assert.equal(typeof payload.solved, "boolean");
  assert.equal(typeof payload.solution.status, "string");
  assert.equal(typeof payload.solution.path, "string");
  assert.match(payload.screen, /maze level_HxI \| view=diagonal yaw=0/);
}

{
  const payload = JSON.parse(runTerminal([
    "--level",
    "level_HxI",
    "--view",
    "diagonal",
    "--moves",
    "U",
    "--json"
  ]));

  assert.equal(payload.levelId, "level_HxI");
  assert.equal(payload.inputMoves, "U");
  assert.equal(typeof payload.solved, "boolean");
}

{
  const [initial, moved, rotated, undone, reset, jumped, closed] = runBridge(
    [
      { command: "observe" },
      { command: "move", direction: "up" },
      { command: "rotate_camera", direction: "left" },
      { command: "undo" },
      { command: "reset_level" },
      { command: "goto_level", x: "H", y: "I" },
      { command: "close" }
    ],
    ["--level", "level_HxI", "--view", "diagonal"]
  );

  assert.equal(initial.action, "observe");
  assert.equal(initial.action_count, 0);
  assert.equal(initial.current_room, "level_HxI");
  assert.equal(initial.current_view, "diagonal");
  assert.equal(initial.gem_count, 0);
  assert.deepEqual(initial.visited_levels, ["level_HxI"]);
  assert.match(initial.level, /P|p/);
  assert.equal(Object.prototype.hasOwnProperty.call(initial, "observation"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(initial, "current_level"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(initial, "view"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(initial, "header"), false);

  assert.equal(moved.action, "move");
  assert.equal(moved.action_count, 1);
  assert.equal(moved.direction, "up");
  assert.equal(moved.moved, true);
  assert.equal(moved.player.y, initial.player.y - 1);

  assert.equal(rotated.action, "rotate_camera");
  assert.equal(rotated.action_count, 2);
  assert.equal(rotated.yaw, 3);

  assert.equal(undone.action, "undo");
  assert.equal(undone.action_count, 3);
  assert.equal(undone.undone, true);
  assert.equal(undone.player.y, initial.player.y);

  assert.equal(reset.action, "reset_level");
  assert.equal(reset.action_count, 4);
  assert.equal(reset.reset, true);
  assert.equal(reset.player.y, initial.player.y);

  assert.equal(jumped.action, "goto_level");
  assert.equal(jumped.action_count, 5);
  assert.equal(jumped.current_room, "level_HxI");
  assert.equal(jumped.destination_room, "level_HxI");
  assert.equal(jumped.x, "H");
  assert.equal(jumped.y, "I");

  assert.equal(closed.action, "close");
  assert.equal(closed.ok, true);
}

{
  const [firstMove, won] = runBridge(
    [
      { command: "move", direction: "down" },
      { command: "move", direction: "down" }
    ],
    ["--level", "level_GxL", "--view", "top", "--game-won-gem-count", "1"]
  );

  assert.equal(firstMove.game_won, undefined);
  assert.equal(won.gem_count, 1);
  assert.equal(won.game_won, true);
  assert.equal(won.current_room, "level_GxM");
  assert.deepEqual(won.scorecard.result, {
    percent: 100,
    won: true
  });
}

{
  const [
    initial,
    step1,
    step2,
    step3,
    step4,
    changedRoom,
    jumpedBack,
    rejectedJump,
    closed
  ] = runBridge(
    [
      { command: "observe" },
      { command: "move", direction: "up" },
      { command: "move", direction: "up" },
      { command: "move", direction: "up" },
      { command: "move", direction: "up" },
      { command: "move", direction: "up" },
      { command: "goto_level", x: "A", y: "A" },
      { command: "goto_level", x: "B", y: "B" },
      { command: "close" }
    ],
    ["--level", "level_AxA", "--view", "top"]
  );

  assert.equal(initial.current_room, "level_AxA");
  assert.deepEqual(initial.visited_levels, ["level_AxA"]);

  [step1, step2, step3, step4].forEach((payload) => {
    assert.equal(payload.action, "move");
    assert.equal(payload.current_room, "level_AxA");
    assert.equal(payload.room_changed, false);
  });

  assert.equal(changedRoom.action, "move");
  assert.equal(changedRoom.current_room, "level_AxP");
  assert.equal(changedRoom.room_changed, true);
  assert.deepEqual(changedRoom.visited_levels, ["level_AxA", "level_AxP"]);

  assert.equal(jumpedBack.action, "goto_level");
  assert.equal(jumpedBack.current_room, "level_AxA");
  assert.equal(jumpedBack.destination_room, "level_AxA");
  assert.deepEqual(jumpedBack.visited_levels, ["level_AxA", "level_AxP"]);

  assert.equal(rejectedJump.ok, false);
  assert.match(rejectedJump.error, /cannot goto unvisited level: level_BxB/);

  assert.equal(closed.action, "close");
  assert.equal(closed.ok, true);
}

{
  const output = runModelRepl("", [
    "--level",
    "level_HxI",
    "--view",
    "top-diagonal",
    "--target-gems",
    "1",
    "--prompt-only"
  ]);

  assert.match(output, /=== MODEL-FACING MESSAGES ===/);
  assert.match(output, /--- SYSTEM ---/);
  assert.match(output, /--- USER ---/);
  assert.match(output, /Start of run\./);
  assert.match(output, /Objective: Collect at least 1 unique gem\./);
  assert.match(output, /Current room: `level_HxI`/);
  assert.match(output, /maze level_HxI \| view=top-diagonal yaw=0/);
  assert.match(output, /- up/);
  assert.match(output, /- rotate camera left/);
  assert.match(output, /- reset/);
  assert.match(output, /- go to level X Y/);
  assert.match(output, /- quit/);
  assert.match(output, /Typing quit ends the run as a loss\./);
  assert.match(output, /=== LOCAL ACTION CHEAT SHEET ===/);
  assert.match(output, /up \/ down \/ left \/ right\n  description:/);
  assert.match(output, /go to level X Y\n  description:/);
  assert.doesNotMatch(output, /observe\n  description:/);
}

{
  const output = runModelRepl(
    [
      "up",
      "rotate camera left",
      "undo",
      "reset",
      "go to level A A",
      "quit"
    ].join("\n"),
    ["--level", "level_AxA", "--view", "top"]
  );

  assert.match(output, /=== ASSISTANT RESPONSE ===\nup/);
  assert.match(output, /=== ASSISTANT RESPONSE ===\nrotate camera left/);
  assert.match(output, /=== ASSISTANT RESPONSE ===\nundo/);
  assert.match(output, /=== ASSISTANT RESPONSE ===\nreset/);
  assert.match(output, /=== ASSISTANT RESPONSE ===\ngo to level A A/);
  assert.match(output, /=== ASSISTANT RESPONSE ===\nquit/);
  assert.match(output, /=== ENV RESPONSE \(USER\) ===/);
  assert.match(output, /Previous action: move\./);
  assert.match(output, /Final scorecard:/);
  assert.match(output, /"result":/);
  assert.match(output, /"percent": 0/);
  assert.doesNotMatch(output, /"outcome":/);
  assert.doesNotMatch(output, /"lost":/);
  assert.doesNotMatch(output, /"game_won_gem_count":/);
  assert.match(output, /"gems":/);
  assert.match(output, /"go_to_level": 1/);
  assert.doesNotMatch(output, /"goto_level":/);
  assert.doesNotMatch(output, /=== NEXT MODEL TURN ===/);
  assert.match(output, /Current room: `level_AxA`/);
  assert.match(output, /Current view: top/);
  assert.doesNotMatch(output, /"observation":/);
  assert.doesNotMatch(output, /"current_level":/);
  assert.doesNotMatch(output, /"view":/);
  assert.doesNotMatch(output, /"header":/);
}

console.log("maze terminal tests passed");
