#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const directions = new Set(["up", "down", "left", "right"]);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeLevelId(value) {
  const raw = String(value || "level_HxI").trim();
  const match = raw.match(/^(?:level_)?([A-Z])x([A-Z])$/i);
  return match ? `level_${match[1].toUpperCase()}x${match[2].toUpperCase()}` : raw;
}

function normalizeYaw(value) {
  const number = Number(value);
  const integer = Number.isInteger(number) ? number : 0;
  return ((integer % 4) + 4) % 4;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function parseArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || "";
    if (arg === "--repo-root") options.repoRoot = path.resolve(next());
    else if (arg === "--state") options.state = path.resolve(next());
    else if (arg === "--level") options.level = next();
    else if (arg === "--view") options.view = next();
    else if (arg === "--yaw") options.yaw = next();
    else if (arg === "--game-won-gem-count") options.gameWonGemCount = next();
    else if (arg === "--node-bin") options.nodeBin = next();
    else if (arg === "--vision") options.vision = true;
    else if (arg === "--vision-width") options.visionWidth = next();
    else if (arg === "--vision-height") options.visionHeight = next();
    else options.positional.push(arg);
  }
  return options;
}

function usage() {
  console.log(`Usage:
  node codex-play.js start --repo-root <path> --state <session.json> [options]
  node codex-play.js observe --state <session.json>
  node codex-play.js action --state <session.json> <command words...>
  node codex-play.js scorecard --state <session.json>

start options:
  --level <id>              maze world level id (default level_HxI)
  --view <name>             top | top-diagonal | diagonal | side-diagonal | side
  --yaw <0-3>               camera yaw
  --game-won-gem-count <n>  unique gems for game_won (default 100)
  --vision                  render a PNG each turn; output includes frame_image
                            (path) and drops the ASCII board
  --vision-width <px>       vision frame width (default 512)
  --vision-height <px>      vision frame height (default 512)`);
}

function bridgeArgs(session) {
  return [
    path.join(session.repoRoot, "scripts", "maze-bridge.js"),
    "--game", session.gameId || "maze",
    "--level", normalizeLevelId(session.levelId),
    "--view", session.view || "top-diagonal",
    "--yaw", String(normalizeYaw(session.yaw)),
    "--game-won-gem-count", String(positiveInt(session.gameWonGemCount, 100))
  ];
}

function runBridge(session, message) {
  const replay = (session.actions || [])
    .filter((action) => action && action.message && action.replay !== false)
    .map((action) => action.message);
  const messages = [...replay, message, { command: "close" }];
  const result = spawnSync(session.nodeBin || process.execPath, bridgeArgs(session), {
    cwd: session.repoRoot,
    encoding: "utf8",
    input: `${messages.map((item) => JSON.stringify(item)).join("\n")}\n`,
    maxBuffer: 80 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "").trim() || `maze bridge exited ${result.status}`);
  }
  const responses = String(result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const previousFailure = responses.slice(0, replay.length).find((response) => !response.ok);
  if (previousFailure) {
    throw new Error(`Replay failed before requested command: ${previousFailure.error || "unknown error"}`);
  }
  const response = responses[replay.length];
  if (!response) throw new Error("maze bridge returned no response");
  if (!response.ok) throw new Error(response.error || "maze bridge command failed");
  return response;
}

function normalizeAction(words) {
  const text = words.join(" ").trim().toLowerCase();
  if (directions.has(text)) return { command: "move", direction: text };
  const move = text.match(/^move\s+(up|down|left|right)$/);
  if (move) return { command: "move", direction: move[1] };
  const rotate = text.match(/^rotate(?:\s+camera)?\s+(up|down|left|right)$/);
  if (rotate) return { command: "rotate_camera", direction: rotate[1] };
  if (text === "undo") return { command: "undo" };
  if (text === "reset" || text === "reset level") return { command: "reset_level" };
  if (text === "quit") return { command: "quit" };
  const goto = text.match(/^(?:go\s+to\s+level|goto)\s+([a-z])\s+([a-z])$/i);
  if (goto) return { command: "goto_level", x: goto[1].toUpperCase(), y: goto[2].toUpperCase() };
  throw new Error(`Unknown action: ${text}`);
}

function printStatus(response) {
  const value = response.status || response;
  console.log(JSON.stringify(value, null, 2));
}

function canonicalActionText(message) {
  if (!message || typeof message !== "object") return "";
  if (message.command === "move") return String(message.direction || "");
  if (message.command === "rotate_camera") return `rotate camera ${message.direction}`;
  if (message.command === "goto_level") return `go to level ${message.x} ${message.y}`;
  if (message.command === "reset_level") return "reset";
  return String(message.command || "");
}

// Render the current maze view to a PNG by replaying every applied action in a
// headless browser via maze-render-frame.js (the same renderer the vision
// taskset uses). Stateless like the rest of this helper: the whole action list
// is replayed each turn. Returns the absolute path to the written frame.
function renderVisionFrame(session, turnIndex, stateFile) {
  const actions = (session.actions || [])
    .map((action) => canonicalActionText(action.message))
    .filter(Boolean);
  const payload = {
    actions,
    draft: true,
    fast: true,
    gameId: session.gameId || "maze",
    height: positiveInt(session.visionHeight, 512),
    levelId: normalizeLevelId(session.levelId),
    width: positiveInt(session.visionWidth, 512),
    yaw: normalizeYaw(session.yaw)
  };
  const renderer = path.join(session.repoRoot, "scripts", "maze-render-frame.js");
  const result = spawnSync(session.nodeBin || process.execPath, [renderer], {
    cwd: session.repoRoot,
    encoding: "utf8",
    input: JSON.stringify(payload),
    maxBuffer: 128 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "maze-render-frame.js failed").trim());
  }
  const parsed = JSON.parse(result.stdout);
  const dataUrl = String(parsed.data_url || "");
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) {
    throw new Error("maze-render-frame.js did not return a PNG data URL");
  }
  const framesDir = path.join(path.dirname(stateFile), "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  const framePath = path.join(framesDir, `frame-${String(turnIndex).padStart(3, "0")}.png`);
  fs.writeFileSync(framePath, Buffer.from(dataUrl.slice(prefix.length), "base64"));
  return framePath;
}

// Print the status the agent sees. In vision mode, render a perspective image,
// attach its path as frame_image, and drop the ASCII board so the agent must
// look at the picture. A render failure degrades gracefully to ASCII.
function emitStatus(session, response, turnIndex, stateFile) {
  const status = response.status || response;

  if (!session.vision) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const printable = { ...status, observation_mode: "vision" };
  try {
    printable.frame_image = renderVisionFrame(session, turnIndex, stateFile);
    delete printable.level;
  } catch (error) {
    printable.observation_mode = "vision (render failed — showing ASCII board)";
    printable.frame_error = error instanceof Error ? error.message : String(error);
  }
  console.log(JSON.stringify(printable, null, 2));
}

function main() {
  const command = process.argv[2] || "help";
  const options = parseArgs(process.argv.slice(3));
  if (command === "help" || !options.state) {
    usage();
    process.exit(command === "help" ? 0 : 2);
  }

  if (command === "start") {
    const session = {
      actions: [],
      createdAt: new Date().toISOString(),
      gameId: "maze",
      gameWonGemCount: positiveInt(options.gameWonGemCount, 100),
      levelId: normalizeLevelId(options.level),
      nodeBin: options.nodeBin || process.execPath,
      repoRoot: options.repoRoot,
      view: options.view || "top-diagonal",
      vision: Boolean(options.vision),
      visionHeight: positiveInt(options.visionHeight, 512),
      visionWidth: positiveInt(options.visionWidth, 512),
      yaw: normalizeYaw(Number(options.yaw))
    };
    const response = runBridge(session, { command: "observe" });
    session.initial = response.status || response;
    session.lastStatus = session.initial;
    writeJson(options.state, session);
    emitStatus(session, response, 0, options.state);
    return;
  }

  const session = readJson(options.state, null);
  if (!session) throw new Error(`No session found at ${options.state}`);

  if (command === "observe") {
    emitStatus(session, runBridge(session, { command: "observe" }), session.actions.length, options.state);
    return;
  }

  if (command === "scorecard") {
    const response = runBridge(session, { command: "scorecard" });
    session.scorecard = (response.status || response).scorecard || response.scorecard || response.status || response;
    session.lastStatus = response.status || response;
    writeJson(options.state, session);
    writeJson(path.join(path.dirname(options.state), "scorecard.json"), session.scorecard);
    emitStatus(session, response, session.actions.length, options.state);
    return;
  }

  if (command === "action") {
    const message = normalizeAction(options.positional);
    const response = runBridge(session, message);
    const status = response.status || response;
    const record = {
      turn: session.actions.length + 1,
      command_text: options.positional.join(" ").trim(),
      message,
      status
    };
    session.actions.push(record);
    session.lastStatus = status;
    writeJson(options.state, session);
    fs.appendFileSync(path.join(path.dirname(options.state), "actions.jsonl"), `${JSON.stringify(record)}\n`);
    emitStatus(session, response, session.actions.length, options.state);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
