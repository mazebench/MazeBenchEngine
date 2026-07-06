#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_RESULTS_ROOT = path.join(
  ROOT_DIR,
  "environments",
  "mazebench",
  "outputs",
  "evals"
);
const DEFAULT_BROWSER_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
];
const DIRECTIONS = new Set(["up", "down", "left", "right"]);
const VIEW_NAMES = ["top", "top-diagonal", "diagonal", "side-diagonal", "side"];

function usage() {
  return `Usage: npm run maze:replay -- [results-dir | results.jsonl | session.json | session-dir] [options]

Creates maze_scorecard.json, maze_actions.txt, and maze_replay.mp4 from a mazebench
eval (results.jsonl) or from a local agent run (session.json written by codex-play.js).

Options:
  --index <n>          Rollout row to export from results.jsonl. Default: 0.
  --out-dir <path>     Directory for exported artifacts. Default: eval results dir.
  --video              Render maze_replay.mp4. Enabled by default.
  --no-video           Only write maze_scorecard.json and maze_actions.txt.
  --width <px>         Output video width. Default: 400.
  --height <px>        Output video height. Default: 400.
  --fps <n>            Video frames per second. Default: 20.
  --fast               Capture only settled states, not animation tweens.
  --draft              Lower replay DPR and disable effects for faster capture.
  --move-speed <n>     Movement animation speed multiplier. Default: 5.
  --camera-speed <n>   Camera animation speed multiplier. Default: 2.
  --speed <n>          Uniform speed multiplier for movement and camera.
  --crf <n>            x264 CRF; lower is larger/higher quality. Default: 21.
  --preset <name>      x264 preset. Default: veryslow.
  --camera-tilt <deg>  Perspective camera tilt from top-down. Default: 58.
  --camera-step <deg>  Tilt delta for rotate camera up/down. Default: 18.
  --camera-zoom <n>    Perspective camera zoom multiplier. Default: 1.
  --motion-scale <n>   Replay-only animation slowdown multiplier. Default: 4.
  --tail-seconds <n>   Final hold after the last action. Default: 0.45.
  --format <ext>       mp4 or mov. Default: mp4.
  --browser <name>     chrome, brave, chromium, edge, or executable path.
  --keep-frames        Keep the intermediate PNG frames beside the output.
  --help               Show this help.
`;
}

function parseCli(argv) {
  const options = defaultReplayOptions();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} requires a value`);
      }
      return argv[index];
    };

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg === "--index") {
      options.index = Number(next());
    } else if (arg === "--out-dir") {
      options.outDir = path.resolve(next());
    } else if (arg === "--video") {
      options.video = true;
    } else if (arg === "--no-video") {
      options.video = false;
    } else if (arg === "--width") {
      options.width = Number(next());
    } else if (arg === "--height") {
      options.height = Number(next());
    } else if (arg === "--fps") {
      options.fps = Number(next());
    } else if (arg === "--fast" || arg === "--fast-render") {
      options.fast = true;
    } else if (arg === "--no-fast") {
      options.fast = false;
    } else if (arg === "--draft" || arg === "--draft-render") {
      options.draft = true;
    } else if (arg === "--no-draft") {
      options.draft = false;
    } else if (arg === "--speed") {
      const speed = Number(next());
      options.cameraSpeed = speed;
      options.moveSpeed = speed;
    } else if (arg === "--move-speed") {
      options.moveSpeed = Number(next());
    } else if (arg === "--camera-speed") {
      options.cameraSpeed = Number(next());
    } else if (arg === "--crf") {
      options.crf = Number(next());
    } else if (arg === "--preset") {
      options.preset = next();
    } else if (arg === "--camera-tilt") {
      options.cameraTiltDegrees = Number(next());
    } else if (arg === "--camera-step") {
      options.cameraStepDegrees = Number(next());
    } else if (arg === "--camera-zoom") {
      options.cameraZoom = Number(next());
    } else if (arg === "--motion-scale") {
      options.motionScale = Number(next());
    } else if (arg === "--tail-seconds") {
      options.tailSeconds = Number(next());
    } else if (arg === "--format") {
      options.format = next().replace(/^\./, "").toLowerCase();
    } else if (arg === "--browser") {
      options.browser = next();
    } else if (arg === "--keep-frames") {
      options.keepFrames = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.resultsInput) {
      options.resultsInput = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return validateReplayOptions(options);
}

function defaultReplayOptions() {
  return {
    browser: "",
    cameraStepDegrees: 18,
    cameraTiltDegrees: 58,
    cameraZoom: 1,
    cameraSpeed: 2,
    crf: 21,
    draft: false,
    fps: 20,
    fast: false,
    format: "mp4",
    height: 400,
    index: 0,
    keepFrames: false,
    moveSpeed: 5,
    outDir: "",
    preset: "veryslow",
    resultsInput: "",
    video: true,
    videoBitrate: 24000000,
    motionScale: 4,
    tailSeconds: 0.45,
    width: 400
  };
}

function validateReplayOptions(options) {
  if (!Number.isInteger(options.index) || options.index < 0) {
    throw new Error("--index must be a non-negative integer");
  }

  for (const key of [
    "width",
    "height",
    "fps",
    "crf",
    "cameraTiltDegrees",
    "cameraStepDegrees",
    "cameraZoom",
    "cameraSpeed",
    "motionScale",
    "moveSpeed"
  ]) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) {
      throw new Error(`--${key} must be a positive number`);
    }
  }

  if (!Number.isFinite(options.tailSeconds) || options.tailSeconds < 0) {
    throw new Error("--tail-seconds must be zero or a positive number");
  }

  options.cameraTiltDegrees = Math.max(1, Math.min(89, options.cameraTiltDegrees));
  options.cameraStepDegrees = Math.max(1, Math.min(45, options.cameraStepDegrees));
  options.cameraZoom = Math.max(0.2, Math.min(4, options.cameraZoom));
  options.cameraSpeed = Math.max(0.1, Math.min(12, options.cameraSpeed));
  options.motionScale = Math.max(0.25, Math.min(12, options.motionScale));
  options.moveSpeed = Math.max(0.1, Math.min(12, options.moveSpeed));
  options.tailSeconds = Math.max(0, Math.min(4, options.tailSeconds));

  if (!["mp4", "mov"].includes(options.format)) {
    throw new Error("--format must be mp4 or mov");
  }

  return options;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function findResultsFiles(dir, depth = 0, found = []) {
  if (depth > 5 || !fs.existsSync(dir)) {
    return found;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isFile() && entry.name === "results.jsonl") {
      found.push(entryPath);
    } else if (entry.isDirectory()) {
      findResultsFiles(entryPath, depth + 1, found);
    }
  }

  return found;
}

function latestResultsPath() {
  const candidates = findResultsFiles(DEFAULT_RESULTS_ROOT);

  if (candidates.length === 0) {
    throw new Error(`No results.jsonl files found under ${DEFAULT_RESULTS_ROOT}`);
  }

  candidates.sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a));
  return candidates[0];
}

function resolveInput(input) {
  const resolvedInput = input ? path.resolve(input) : latestResultsPath();
  const stats = fs.statSync(resolvedInput);

  if (stats.isDirectory()) {
    const resultsPath = path.join(resolvedInput, "results.jsonl");
    const sessionPath = path.join(resolvedInput, "session.json");

    if (fs.existsSync(resultsPath)) {
      return { mode: "results", resultsDir: resolvedInput, resultsPath };
    }

    if (fs.existsSync(sessionPath)) {
      return { mode: "session", sessionDir: resolvedInput, sessionPath };
    }

    throw new Error(`No results.jsonl or session.json found in ${resolvedInput}`);
  }

  if (path.basename(resolvedInput) === "session.json") {
    return {
      mode: "session",
      sessionDir: path.dirname(resolvedInput),
      sessionPath: resolvedInput
    };
  }

  return {
    mode: "results",
    resultsDir: path.dirname(resolvedInput),
    resultsPath: resolvedInput
  };
}

function canonicalFromBridgeMessage(message) {
  if (!message || typeof message !== "object") {
    return "";
  }

  if (message.command === "move") {
    return String(message.direction || "");
  }

  if (message.command === "rotate_camera") {
    return `rotate camera ${message.direction}`;
  }

  if (message.command === "goto_level") {
    return `go to level ${message.x} ${message.y}`;
  }

  if (message.command === "reset_level") {
    return "reset";
  }

  return String(message.command || "");
}

// Adapt a local codex-play.js session.json into the same row shape the eval
// path produces, so extractActions/extractMazeOptions/existingScorecard work.
function rowFromSession(session) {
  const actions = (session.actions || [])
    .map((action) => ({
      command: canonicalFromBridgeMessage(action.message) || String(action.command_text || "").trim(),
      valid: true
    }))
    .filter((action) => action.command);
  const scorecard = session.scorecard && Object.keys(session.scorecard).length > 0
    ? session.scorecard
    : {};

  return {
    maze_actions: actions,
    maze_scorecard: scorecard,
    maze_replay: {
      game_id: session.gameId || "maze",
      game_won_gem_count: Number(session.gameWonGemCount) || 100,
      start_level_id: session.levelId || "level_HxI",
      target_gems: 0,
      initial: {
        view: session.view || "top-diagonal",
        yaw: Number(session.yaw) || 0
      },
      scorecard
    }
  };
}

function readJsonl(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Could not parse ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function readMetadata(resultsDir) {
  const metadataPath = path.join(resultsDir, "metadata.json");

  if (!fs.existsSync(metadataPath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
}

function messageContentToText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object") {
          return part.text || part.content || "";
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return content == null ? "" : String(content);
}

function normalizeDirection(value) {
  const direction = String(value || "").trim().toLowerCase();
  return DIRECTIONS.has(direction) ? direction : "";
}

function normalizeLevelToken(value) {
  return String(value || "").trim().replace(/^level_/i, "").toUpperCase();
}

function canonicalCommand(parsed) {
  if (!parsed) {
    return "";
  }

  if (parsed.command === "move") {
    return parsed.direction;
  }

  if (parsed.command === "rotate_camera") {
    return `rotate camera ${parsed.direction}`;
  }

  if (parsed.command === "goto_level") {
    return `go to level ${parsed.x} ${parsed.y}`;
  }

  if (parsed.command === "reset_level") {
    return "reset";
  }

  return parsed.command;
}

function parseCommandLine(line) {
  const cleaned = String(line || "")
    .trim()
    .replace(/^```(?:text|json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  if (!cleaned) {
    return null;
  }

  if (cleaned.startsWith("{")) {
    try {
      const payload = JSON.parse(cleaned);
      const command = String(payload.command || payload.action || "").trim().toLowerCase();
      const direction = normalizeDirection(payload.direction);

      if (command === "move" && direction) {
        return { command: "move", direction };
      }

      if ((command === "rotate_camera" || command === "rotate") && direction) {
        return { command: "rotate_camera", direction };
      }

      if (command === "goto_level" || command === "go_to_level" || command === "goto") {
        const level = normalizeLevelToken(payload.level);
        const x = String(payload.x || level[0] || "").toUpperCase();
        const y = String(payload.y || level[2] || "").toUpperCase();

        if (/^[A-Z]$/.test(x) && /^[A-Z]$/.test(y)) {
          return { command: "goto_level", x, y };
        }
      }

      if (command === "undo" || command === "quit") {
        return { command };
      }

      if (command === "reset" || command === "reset_level") {
        return { command: "reset_level" };
      }
    } catch {
      return null;
    }
  }

  const lower = cleaned.toLowerCase();

  if (DIRECTIONS.has(lower)) {
    return { command: "move", direction: lower };
  }

  if (lower === "undo" || lower === "quit") {
    return { command: lower };
  }

  if (lower === "reset" || lower === "reset level" || lower === "reset_level") {
    return { command: "reset_level" };
  }

  let match = lower.match(/^rotate\s+camera\s+(up|down|left|right)$/);
  if (match) {
    return { command: "rotate_camera", direction: match[1] };
  }

  match = cleaned.match(/^go\s+to\s+level\s+([A-Za-z])\s+([A-Za-z])$/i);
  if (match) {
    return { command: "goto_level", x: match[1].toUpperCase(), y: match[2].toUpperCase() };
  }

  match = cleaned.match(/^go\s+to\s+level\s+level_([A-Za-z])x([A-Za-z])$/i);
  if (match) {
    return { command: "goto_level", x: match[1].toUpperCase(), y: match[2].toUpperCase() };
  }

  return null;
}

function extractCommandFromAssistantText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseCommandLine(lines[index]);

    if (parsed) {
      return canonicalCommand(parsed);
    }
  }

  return "";
}

function extractActionsFromState(row) {
  const info = row.info || {};
  const replay = row.maze_replay || info.maze_replay || {};
  const actionRecords = Array.isArray(row.maze_actions)
    ? row.maze_actions
    : Array.isArray(info.maze_actions)
      ? info.maze_actions
      : Array.isArray(replay.actions)
      ? replay.actions
      : null;

  if (!actionRecords) {
    return [];
  }

  return actionRecords
    .filter((record) => record && record.valid !== false)
    .map((record) => String(record.command || "").trim())
    .filter(Boolean);
}

function extractActionsFromCompletion(row) {
  const completion = Array.isArray(row.completion) ? row.completion : [];
  const actions = [];

  for (const message of completion) {
    if (!message || message.role !== "assistant") {
      continue;
    }

    const command = extractCommandFromAssistantText(messageContentToText(message.content));

    if (command) {
      actions.push(command);
    }
  }

  return actions;
}

function extractActionsFromNodes(row) {
  const nodes = Array.isArray(row.nodes) ? row.nodes : [];
  const actions = [];

  for (const node of nodes) {
    if (!node || node.message?.role !== "assistant") {
      continue;
    }

    const command = extractCommandFromAssistantText(messageContentToText(node.message.content));

    if (command) {
      actions.push(command);
    }
  }

  return actions;
}

function extractActions(row) {
  const stateActions = extractActionsFromState(row);
  if (stateActions.length > 0) {
    return stateActions;
  }

  const completionActions = extractActionsFromCompletion(row);
  return completionActions.length > 0 ? completionActions : extractActionsFromNodes(row);
}

function extractMazeOptions(row, metadata) {
  const info = row.info?.mazebench || row.info || {};
  const task = row.task || {};
  const replay = row.maze_replay || row.info?.maze_replay || {};
  const gameWonGemCount =
    Number(replay.game_won_gem_count || info.game_won_gem_count || task.game_won_gem_count || 100) || 100;
  const view = String(info.view || task.view || replay.initial?.view || "top-diagonal");
  const yaw = Number(info.yaw ?? task.yaw ?? replay.initial?.yaw ?? 0);

  return {
    gameId: String(replay.game_id || info.game_id || task.game_id || "maze"),
    gameWonGemCount,
    levelId: String(replay.start_level_id || info.level_id || task.level_id || "level_HxI"),
    metadata,
    view: VIEW_NAMES.includes(view) ? view : "top-diagonal",
    yaw: Number.isInteger(yaw) ? yaw : 0
  };
}

function commandToBridgeMessage(commandText) {
  const parsed = parseCommandLine(commandText);

  if (!parsed) {
    throw new Error(`Cannot replay unsupported action: ${commandText}`);
  }

  if (parsed.command === "move") {
    return { command: "move", direction: parsed.direction };
  }

  if (parsed.command === "rotate_camera") {
    return { command: "rotate_camera", direction: parsed.direction };
  }

  if (parsed.command === "goto_level") {
    return { command: "goto_level", x: parsed.x, y: parsed.y };
  }

  if (parsed.command === "reset_level") {
    return { command: "reset_level" };
  }

  return { command: parsed.command };
}

function replayScorecard(actions, mazeOptions) {
  const args = [
    path.join(ROOT_DIR, "scripts", "maze-bridge.js"),
    "--level",
    mazeOptions.levelId,
    "--view",
    mazeOptions.view,
    "--yaw",
    String(mazeOptions.yaw),
    "--game-won-gem-count",
    String(mazeOptions.gameWonGemCount)
  ];
  const messages = [
    ...actions.map(commandToBridgeMessage),
    { command: "scorecard" },
    { command: "close" }
  ];
  const input = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    input,
    maxBuffer: 1024 * 1024 * 20
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || `maze-bridge exited with status ${result.status}`);
  }

  const responses = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const scorecardResponse = [...responses].reverse().find((response) => response.scorecard);

  if (!scorecardResponse?.scorecard) {
    throw new Error("maze-bridge did not return a scorecard");
  }

  return scorecardResponse.scorecard;
}

function existingScorecard(row) {
  if (row.maze_scorecard && Object.keys(row.maze_scorecard).length > 0) {
    return row.maze_scorecard;
  }

  if (row.info?.maze_scorecard && Object.keys(row.info.maze_scorecard).length > 0) {
    return row.info.maze_scorecard;
  }

  if (row.maze_replay?.scorecard && Object.keys(row.maze_replay.scorecard).length > 0) {
    return row.maze_replay.scorecard;
  }

  if (row.info?.maze_replay?.scorecard && Object.keys(row.info.maze_replay.scorecard).length > 0) {
    return row.info.maze_replay.scorecard;
  }

  return null;
}

function writeSidecarFiles(outDir, actions, scorecard) {
  ensureDir(outDir);
  const scorecardPath = path.join(outDir, "maze_scorecard.json");
  const actionsPath = path.join(outDir, "maze_actions.txt");

  fs.writeFileSync(scorecardPath, `${JSON.stringify(scorecard, null, 2)}\n`);
  fs.writeFileSync(actionsPath, `${actions.join("\n")}${actions.length > 0 ? "\n" : ""}`);

  return { actionsPath, scorecardPath };
}

function browserExecutablePath(browserOption) {
  if (!browserOption) {
    return "";
  }

  if (browserOption.includes("/") && fs.existsSync(browserOption)) {
    return browserOption;
  }

  const normalized = browserOption.toLowerCase();
  const namedPaths = {
    brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    chromium: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  };

  return namedPaths[normalized] || "";
}

function launchAttempts(browserOption) {
  const attempts = [];
  const executable = browserExecutablePath(browserOption);

  if (browserOption === "chrome") {
    attempts.push({ channel: "chrome" });
  } else if (browserOption === "edge") {
    attempts.push({ channel: "msedge" });
  }

  if (executable && fs.existsSync(executable)) {
    attempts.push({ executablePath: executable });
  }

  if (!browserOption) {
    attempts.push({ channel: "chrome" });
    for (const executablePath of DEFAULT_BROWSER_PATHS) {
      if (fs.existsSync(executablePath)) {
        attempts.push({ executablePath });
      }
    }
  }

  attempts.push({});
  return attempts;
}

async function launchBrowser(chromium, browserOption) {
  let lastError = null;

  for (const attempt of launchAttempts(browserOption)) {
    try {
      return await chromium.launch({
        ...attempt,
        args: [
          "--disable-dev-shm-usage",
          "--hide-scrollbars",
          "--mute-audio",
          "--use-angle=swiftshader"
        ],
        headless: true
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Could not launch a Chromium browser");
}

async function startServer() {
  const { createRequestHandler } = require(path.join(ROOT_DIR, "server", "app"));
  const server = http.createServer(createRequestHandler());

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Could not start local replay server");
  }

  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    port: address.port
  };
}

function frameName(index) {
  return `frame-${String(index).padStart(6, "0")}.png`;
}

function progressBar(percent, width = 24) {
  const safePercent = Math.max(0, Math.min(1, Number(percent) || 0));
  const filled = Math.round(safePercent * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "--";
  }

  const seconds = Math.ceil(milliseconds / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function humanBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let size = Math.max(0, Number(bytes) || 0);
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function createProgressReporter({ estimateBytes = 0, label, total, unit = "frames" }) {
  const startedAtMs = Date.now();
  const tty = Boolean(process.stdout.isTTY);
  const safeTotal = Math.max(1, Number(total) || 1);
  let current = 0;
  let lastLineLength = 0;
  let lastWriteMs = 0;

  function progressText(value) {
    if (unit === "seconds") {
      return `${value.toFixed(1)}s/${safeTotal.toFixed(1)}s`;
    }

    return `${Math.round(value)}/${Math.round(safeTotal)} ${unit}`;
  }

  function render(value = current, { force = false, nextEstimateBytes = estimateBytes } = {}) {
    current = Math.max(0, Number(value) || 0);
    estimateBytes = nextEstimateBytes;
    const now = Date.now();
    const percent = Math.max(0, Math.min(1, current / safeTotal));

    if (!force && !tty && now - lastWriteMs < 5000) {
      return;
    }

    const elapsedMs = now - startedAtMs;
    const etaMs = percent > 0 ? (elapsedMs / percent) * (1 - percent) : Infinity;
    const line = `${label} ${progressBar(percent)} ${Math.round(
      percent * 100
    )}% | ${progressText(current)} | ETA ${formatDuration(
      etaMs
    )} | expected MP4 ~${humanBytes(estimateBytes)}`;

    if (tty) {
      process.stdout.write(`\r${line}${" ".repeat(Math.max(0, lastLineLength - line.length))}`);
      lastLineLength = line.length;
    } else {
      console.log(line);
    }

    lastWriteMs = now;
  }

  function finish(message = "") {
    render(safeTotal, { force: true });

    if (tty) {
      process.stdout.write("\n");
    }

    if (message) {
      console.log(message);
    }
  }

  return { finish, render };
}

function estimatedActionSeconds(parsed, options) {
  if (!parsed) {
    return 0;
  }

  if (parsed.command === "move") {
    return Math.max(0.2, (0.65 * options.motionScale) / options.moveSpeed);
  }

  if (parsed.command === "rotate_camera") {
    const baseMs = parsed.direction === "left" || parsed.direction === "right" ? 780 : 620;
    return Math.max(0.15, baseMs / 1000 / options.cameraSpeed);
  }

  if (parsed.command === "undo" || parsed.command === "reset_level" || parsed.command === "goto_level") {
    return Math.max(0.2, (0.5 * options.motionScale) / options.moveSpeed);
  }

  if (parsed.command === "quit") {
    return 1 / options.fps;
  }

  return 0.1;
}

function estimateCaptureFrameCount(actions, options) {
  const parsedActions = actions.map(parseCommandLine).filter(Boolean);
  const tailFrames = Math.round(options.tailSeconds * options.fps);

  if (options.fast) {
    return Math.max(1, 1 + parsedActions.length + tailFrames);
  }

  const actionFrames = parsedActions.reduce(
    (total, parsed) => total + Math.max(1, Math.ceil(estimatedActionSeconds(parsed, options) * options.fps)),
    0
  );
  return Math.max(1, 1 + actionFrames + tailFrames);
}

function estimatedVideoBytes(frameCount, options) {
  const evenWidth = Math.max(2, Math.floor(options.width / 2) * 2);
  const evenHeight = Math.max(2, Math.floor(options.height / 2) * 2);
  const durationSeconds = Math.max(0.1, frameCount / options.fps);
  const pixels = evenWidth * evenHeight;
  const crfFactor = Math.pow(2, (23 - options.crf) / 6);
  const motionFactor = options.fast ? 0.75 : 1.25;
  const containerOverheadBytes = 10 * 1024;
  const estimatedBits = durationSeconds * pixels * motionFactor * crfFactor;

  return Math.max(containerOverheadBytes, containerOverheadBytes + estimatedBits / 8);
}

function parseFfmpegProgressSeconds(line) {
  const [key, rawValue] = String(line || "").split("=");
  const value = String(rawValue || "").trim();

  if (key === "out_time_us" || key === "out_time_ms") {
    const microseconds = Number(value);
    return Number.isFinite(microseconds) ? microseconds / 1000000 : null;
  }

  if (key === "out_time") {
    const match = value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);

    if (match) {
      return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    }
  }

  return null;
}

async function encodeVideo(ffmpegArgs, { durationSeconds, estimateBytes }) {
  const progress = createProgressReporter({
    estimateBytes,
    label: "Encoding video",
    total: Math.max(0.1, durationSeconds),
    unit: "seconds"
  });

  progress.render(0, { force: true });

  await new Promise((resolve, reject) => {
    const encode = spawn("ffmpeg", ffmpegArgs, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let stdoutBuffer = "";

    encode.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const seconds = parseFfmpegProgressSeconds(line);

        if (seconds !== null) {
          progress.render(Math.min(seconds, durationSeconds), { nextEstimateBytes: estimateBytes });
        } else if (line === "progress=end") {
          progress.render(durationSeconds, { force: true, nextEstimateBytes: estimateBytes });
        }
      }
    });

    encode.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    encode.on("error", reject);
    encode.on("close", (status) => {
      if (status === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `ffmpeg exited with status ${status}`));
      }
    });
  });

  progress.finish(`Encoded video; expected MP4 ~${humanBytes(estimateBytes)}.`);
}

async function renderReplayVideo(actions, mazeOptions, outDir, options) {
  const ffmpegCheck = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });

  if (ffmpegCheck.error || ffmpegCheck.status !== 0) {
    throw new Error("ffmpeg is required to render maze_replay video");
  }

  const { chromium } = await import("playwright-core");
  const server = await startServer();
  const browser = await launchBrowser(chromium, options.browser);
  const framesDir = path.join(outDir, ".maze_replay_frames");
  const videoPath = path.join(outDir, `maze_replay.${options.format}`);
  const estimatedFrames = estimateCaptureFrameCount(actions, options);
  let estimatedBytes = estimatedVideoBytes(estimatedFrames, options);
  let captureProgress = null;
  let frameIndex = 0;
  let lastFrameBuffer = null;

  fs.rmSync(framesDir, { force: true, recursive: true });
  ensureDir(framesDir);

  try {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { width: options.width, height: options.height }
    });
    const levelUrl = `http://127.0.0.1:${server.port}/play/${encodeURIComponent(
      mazeOptions.gameId
    )}/${encodeURIComponent(mazeOptions.levelId)}`;

    await page.addInitScript(() => {
      window.__PIXEL_GAME_DEBUG__ = true;
      window.__PIXEL_GAME_REPLAY_CAPTURE__ = true;
    });
    await page.goto(levelUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => {
      const app = window.__PIXEL_GAME_APP__;
      return Boolean(app?.movement && app?.threeRenderer && app?.render);
    });
    await page.addStyleTag({
      content: `
        html, body {
          background: #050608 !important;
          height: 100% !important;
          margin: 0 !important;
          overflow: hidden !important;
          width: 100% !important;
        }
        .play-shell {
          display: block !important;
          height: 100vh !important;
          min-height: 100vh !important;
          width: 100vw !important;
        }
        .play-header {
          display: none !important;
        }
        .play-stage,
        .maze-frame {
          border: 0 !important;
          border-radius: 0 !important;
          box-shadow: none !important;
          height: 100vh !important;
          margin: 0 !important;
          max-height: none !important;
          max-width: none !important;
          padding: 0 !important;
          width: 100vw !important;
        }
        #maze-canvas {
          display: block !important;
          height: 100vh !important;
          width: 100vw !important;
        }
      `
    });
    await page.evaluate(async ({ draft, fast, fps, height, motionScale, moveSpeed, width }) => {
      const app = window.__PIXEL_GAME_APP__;

      if (draft) {
        const replayScale = Math.max(
          0.1,
          Math.min(1, width / app.viewportRect.width, height / app.viewportRect.height)
        );
        Object.defineProperty(window, "devicePixelRatio", {
          configurable: true,
          get: () => replayScale
        });
      }

      window.dispatchEvent(new Event("resize"));
      app.syncPlayLayout?.();
      app.setupCanvas?.();
      app.replayAnimationFrameStepMs = 1000 / fps;
      app.state.effects.fuzzyEnabled = !draft;
      app.state.effects.edgeOutlinesEnabled = !draft;
      app.state.effects.noisePhase = 0;

      if (app.noiseFrameId !== null) {
        window.cancelAnimationFrame(app.noiseFrameId);
        app.noiseFrameId = null;
      }

      app.syncFuzzyToggle?.();
      app.syncEdgeToggle?.();

      [
        "MOVE_DURATION_MS",
        "GATE_RISE_DURATION_MS",
        "GATE_FALL_DURATION_MS",
        "ORANGE_WALL_RISE_DURATION_MS",
        "ORANGE_WALL_FALL_DURATION_MS",
        "PLAYER_LIFT_RISE_DURATION_MS",
        "PLAYER_LIFT_FALL_DURATION_MS",
        "HOLE_FALL_DURATION_MS",
        "LEVEL_TRANSITION_DURATION_MS"
      ].forEach((key) => {
        if (Number.isFinite(app[key])) {
          app[key] = fast ? 1 : app[key] * motionScale / moveSpeed;
        }
      });

      app.replayMoveDurationMs = Number.isFinite(app.MOVE_DURATION_MS)
        ? app.MOVE_DURATION_MS
        : null;
      await app.preloadImages?.();
      await app.threeRendererReady;
      app.syncCameraTarget?.(true);
      app.render?.();
    }, {
      draft: Boolean(options.draft),
      fast: Boolean(options.fast),
      fps: options.fps,
      height: options.height,
      motionScale: options.motionScale,
      moveSpeed: options.moveSpeed,
      width: options.width
    });

    function writeFrameDataUrl(dataUrl) {
      const base64 = String(dataUrl || "").split(",")[1];

      if (!base64) {
        throw new Error("Could not capture replay frame");
      }

      lastFrameBuffer = Buffer.from(base64, "base64");
      fs.writeFileSync(path.join(framesDir, frameName(frameIndex)), lastFrameBuffer);
      frameIndex += 1;
      estimatedBytes = estimatedVideoBytes(Math.max(frameIndex, estimatedFrames), options);
      captureProgress?.render(frameIndex, { nextEstimateBytes: estimatedBytes });
    }

    async function captureFrame() {
      const dataUrl = await page.evaluate(async () => {
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
        const app = window.__PIXEL_GAME_APP__;
        const canvas =
          app?.canvas ||
          app?.viewCanvas ||
          app?.sceneCanvas ||
          document.getElementById("maze-canvas");

        if (!canvas) {
          throw new Error("Could not find a replay canvas");
        }

        return canvas.toDataURL("image/png");
      });
      writeFrameDataUrl(dataUrl);
    }

    function duplicateLastFrame(count) {
      if (!lastFrameBuffer) {
        return;
      }

      for (let index = 0; index < count; index += 1) {
        fs.writeFileSync(path.join(framesDir, frameName(frameIndex)), lastFrameBuffer);
        frameIndex += 1;
        estimatedBytes = estimatedVideoBytes(Math.max(frameIndex, estimatedFrames), options);
        captureProgress?.render(frameIndex, { nextEstimateBytes: estimatedBytes });
      }
    }

    async function waitUntilSettled(maxSeconds, { capture = true } = {}) {
      const maxFrames = Math.max(1, Math.ceil(maxSeconds * options.fps));
      const dataUrls = await page.evaluate(async ({ captureFrames, frameLimit }) => {
        function captureReplayFrame() {
          const app = window.__PIXEL_GAME_APP__;
          const canvas =
            app?.canvas ||
            app?.viewCanvas ||
            app?.sceneCanvas ||
            document.getElementById("maze-canvas");

          if (!canvas) {
            throw new Error("Could not find a replay canvas");
          }

          return canvas.toDataURL("image/png");
        }

        function replayIsBusy() {
          const app = window.__PIXEL_GAME_APP__;

          return Boolean(
            app?.isAnimating ||
              app?.isTransitioningLevel ||
              app?.threeRenderer?.isDebugCameraAnimating?.()
          );
        }

        const frames = [];

        for (let index = 0; index < frameLimit; index += 1) {
          await new Promise((resolve) => window.requestAnimationFrame(resolve));
          if (captureFrames) {
            frames.push(captureReplayFrame());
          }

          if (!replayIsBusy()) {
            break;
          }
        }

        return frames;
      }, { captureFrames: capture, frameLimit: maxFrames });

      dataUrls.forEach(writeFrameDataUrl);
    }

    async function settleAndCapture(maxSeconds) {
      if (options.fast) {
        await waitUntilSettled(maxSeconds, { capture: false });
        await captureFrame();
      } else {
        await waitUntilSettled(maxSeconds);
      }
    }

    let cameraTiltDegrees = options.cameraTiltDegrees;
    let cameraYawTurns = ((mazeOptions.yaw % 4) + 4) % 4;
    const cameraTiltDurationMs = 620 / options.cameraSpeed;
    const cameraYawDurationMs = 780 / options.cameraSpeed;

    async function setCameraView({ animate = false, durationMs = 760 } = {}) {
      await page.evaluate(
        ({ animate: shouldAnimate, duration, tiltDegrees, yawTurns, zoom }) => {
          const tilt = (tiltDegrees * Math.PI) / 180;
          window.__PIXEL_GAME_APP__?.threeRenderer?.setDebugCameraView?.({
            animate: shouldAnimate,
            durationMs: duration,
            mode: "perspective",
            tilt,
            yaw: yawTurns * (Math.PI / 2),
            zoom
          });
        },
        {
          animate,
          duration: durationMs,
          tiltDegrees: cameraTiltDegrees,
          yawTurns: cameraYawTurns,
          zoom: options.cameraZoom
        }
      );
    }

    captureProgress = createProgressReporter({
      estimateBytes: estimatedBytes,
      label: "Capturing replay frames",
      total: estimatedFrames
    });
    captureProgress.render(0, { force: true });

    await setCameraView({ animate: false });
    await settleAndCapture(1);

    for (const commandText of actions) {
      const parsed = parseCommandLine(commandText);

      if (!parsed) {
        continue;
      }

      if (parsed.command === "move") {
        const key = {
          down: "ArrowDown",
          left: "ArrowLeft",
          right: "ArrowRight",
          up: "ArrowUp"
        }[parsed.direction];
        await page.keyboard.press(key);
        await settleAndCapture(3.0);
      } else if (parsed.command === "rotate_camera") {
        if (parsed.direction === "left") {
          cameraYawTurns -= 1;
          await setCameraView({ animate: !options.fast, durationMs: cameraYawDurationMs });
          await settleAndCapture(1.8);
        } else if (parsed.direction === "right") {
          cameraYawTurns += 1;
          await setCameraView({ animate: !options.fast, durationMs: cameraYawDurationMs });
          await settleAndCapture(1.8);
        } else if (parsed.direction === "up") {
          cameraTiltDegrees = Math.max(20, cameraTiltDegrees - options.cameraStepDegrees);
          await setCameraView({ animate: !options.fast, durationMs: cameraTiltDurationMs });
          await settleAndCapture(1.5);
        } else if (parsed.direction === "down") {
          cameraTiltDegrees = Math.min(82, cameraTiltDegrees + options.cameraStepDegrees);
          await setCameraView({ animate: !options.fast, durationMs: cameraTiltDurationMs });
          await settleAndCapture(1.5);
        }
      } else if (parsed.command === "undo") {
        await page.keyboard.press("z");
        await settleAndCapture(2.0);
      } else if (parsed.command === "reset_level") {
        await page.keyboard.press("r");
        await settleAndCapture(2.0);
      } else if (parsed.command === "goto_level") {
        const levelId = `level_${parsed.x}x${parsed.y}`;
        await page.evaluate(async (nextLevelId) => {
          const app = window.__PIXEL_GAME_APP__;
          const response = await fetch(
            `/api/play/${encodeURIComponent(app.currentGameId)}/${encodeURIComponent(nextLevelId)}`
          );

          if (!response.ok) {
            throw new Error(`Could not load ${nextLevelId}`);
          }

          const levelState = await response.json();
          app.applyLevelState(levelState, {
            deferRender: true,
            immediateCamera: true,
            resetHistory: false,
            resetLevelEntry: true
          });
          await app.preloadImagesForLevelState?.(levelState);
          app.render?.();
        }, levelId);
        await settleAndCapture(2.0);
      } else if (parsed.command === "quit") {
        await captureFrame();
      }
    }

    duplicateLastFrame(Math.round(options.tailSeconds * options.fps));
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }

  if (frameIndex === 0) {
    throw new Error("Replay renderer did not capture any frames");
  }

  estimatedBytes = estimatedVideoBytes(frameIndex, options);
  captureProgress?.finish(
    `Captured ${frameIndex} replay frame${frameIndex === 1 ? "" : "s"}; expected MP4 ~${humanBytes(
      estimatedBytes
    )}.`
  );

  const ffmpegArgs = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-framerate",
    String(options.fps),
    "-i",
    path.join(framesDir, "frame-%06d.png"),
    "-vf",
    videoFilter(options),
    "-r",
    String(options.fps),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    options.preset,
    "-crf",
    String(options.crf),
    "-movflags",
    "+faststart",
    videoPath
  ];
  await encodeVideo(ffmpegArgs, {
    durationSeconds: frameIndex / options.fps,
    estimateBytes: estimatedBytes
  });

  if (!options.keepFrames) {
    fs.rmSync(framesDir, { force: true, recursive: true });
  }

  return { videoPath };
}

function videoFilter(options) {
  const width = Math.max(2, Math.floor(options.width / 2) * 2);
  const height = Math.max(2, Math.floor(options.height / 2) * 2);

  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    "format=yuv420p"
  ].join(",");
}

function humanSize(filePath) {
  const bytes = fs.statSync(filePath).size;
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const input = resolveInput(options.resultsInput);
  let rows;
  let metadata;
  let sourceDir;
  let sourceLabel;

  if (input.mode === "session") {
    const session = JSON.parse(fs.readFileSync(input.sessionPath, "utf8"));
    rows = [rowFromSession(session)];
    metadata = {};
    sourceDir = input.sessionDir;
    sourceLabel = input.sessionPath;
  } else {
    rows = readJsonl(input.resultsPath);
    metadata = readMetadata(input.resultsDir);
    sourceDir = input.resultsDir;
    sourceLabel = input.resultsPath;
  }

  const row = rows[options.index];

  if (!row) {
    throw new Error(
      `No rollout row at index ${options.index}; ${sourceLabel} has ${rows.length}`
    );
  }

  const outDir = options.outDir || sourceDir;
  const mazeOptions = extractMazeOptions(row, metadata);
  const actions = extractActions(row);

  if (actions.length === 0) {
    throw new Error(
      "Could not find replay actions. Check trace info, state columns, or completion output."
    );
  }

  const scorecard = existingScorecard(row) || replayScorecard(actions, mazeOptions);
  const written = writeSidecarFiles(outDir, actions, scorecard);

  console.log(`Source: ${sourceLabel}`);
  console.log(`Wrote ${written.scorecardPath}`);
  console.log(`Wrote ${written.actionsPath}`);

  if (options.video) {
    console.log("Rendering maze replay video...");
    const rendered = await renderReplayVideo(actions, mazeOptions, outDir, options);
    console.log(`Wrote ${rendered.videoPath} (${humanSize(rendered.videoPath)})`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  defaultReplayOptions,
  humanSize,
  renderReplayVideo,
  validateReplayOptions,
  writeSidecarFiles
};
