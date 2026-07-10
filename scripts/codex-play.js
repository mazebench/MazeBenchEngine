#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

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

function consumeRenderState(response, stateFile) {
  const status = response?.status || response;
  const snapshot = status?._render_state;

  if (!snapshot) {
    return response;
  }

  writeJson(path.join(path.dirname(stateFile), "current-render-state.json"), {
    snapshot,
    turn: Math.max(0, Number(status.action_count) || 0),
    updated_at: new Date().toISOString()
  });
  delete status._render_state;
  return response;
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

// 1..26 rings of neighbor rooms (1 = the classic 3x3 window) or "world".
function normalizeVisionView(value) {
  const raw = String(value ?? "1").trim().toLowerCase();
  if (raw === "world") return "world";
  const rings = Number(raw);
  return Number.isFinite(rings) ? Math.max(1, Math.min(26, Math.floor(rings))) : 1;
}

function parseArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || "";
    if (arg === "--repo-root") options.repoRoot = path.resolve(next());
    else if (arg === "--state") options.state = path.resolve(next());
    else if (arg === "--game") options.game = next();
    else if (arg === "--level") options.level = next();
    else if (arg === "--view") options.view = next();
    else if (arg === "--yaw") options.yaw = next();
    else if (arg === "--game-won-gem-count") options.gameWonGemCount = next();
    else if (arg === "--node-bin") options.nodeBin = next();
    else if (arg === "--vision") options.vision = true;
    else if (arg === "--vision-width") options.visionWidth = next();
    else if (arg === "--vision-height") options.visionHeight = next();
    else if (arg === "--vision-view") options.visionView = next();
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
  --game <id>               game directory under games/ (default maze; draft
                            and online worlds use their games/<id> dirs)
  --level <id>              maze world level id (default level_HxI)
  --view <name>             top | top-diagonal | diagonal | side-diagonal | side
  --yaw <0-3>               camera yaw
  --game-won-gem-count <n>  unique gems for game_won (default 100)
  --vision                  render a PNG each turn; output includes frame_image
                            (path) and drops the ASCII board
  --vision-width <px>       vision frame width (default 512)
  --vision-height <px>      vision frame height (default 512)
  --vision-view <n|world>   how far the frame sees: 1-26 rings of neighbor
                            rooms (default 1 = classic 3x3) or "world"`);
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

function rendererScript(session) {
  return path.join(session.repoRoot, "scripts", "maze-render-frame.js");
}

function visionRenderPayload(session) {
  return {
    actions: (session.actions || [])
      .map((action) => canonicalActionText(action.message))
      .filter(Boolean),
    draft: true,
    fast: true,
    gameId: session.gameId || "maze",
    height: positiveInt(session.visionHeight, 512),
    levelId: normalizeLevelId(session.levelId),
    view: normalizeVisionView(session.visionView),
    width: positiveInt(session.visionWidth, 512),
    yaw: normalizeYaw(session.yaw)
  };
}

// ---- persistent render daemon ----------------------------------------------
// This helper runs once per agent turn, so it can't keep a browser alive
// itself. Instead the first vision render spawns maze-render-frame.js in
// --listen mode (a 127.0.0.1 socket, port recorded next to the session file)
// and every later turn just sends the daemon a "render" sync — the daemon
// applies only the newly appended actions, instead of booting a browser and
// replaying the whole run for every single frame.

function daemonPortFile(stateFile) {
  return path.join(path.dirname(stateFile), "render-daemon.json");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectDaemon(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.on("error", reject);
  });
}

function daemonRequest(socket, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("render daemon timed out"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(new Error("render daemon returned an unreadable response"));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(`${JSON.stringify(message)}\n`);
  });
}

// Thrown when the renderer can't bind a localhost port at all — e.g. inside a
// no-network sandbox. The one-shot renderer binds the same way, so there is no
// point retrying it; callers surface this as a clean "render unavailable".
class RenderBindBlockedError extends Error {
  constructor(detail) {
    super(
      "cannot render maze frames: binding a local server was blocked " +
        `(${detail}). This host run is sandboxed with no network; use container ` +
        "mode or Full tool access for vision runs."
    );
    this.renderBindBlocked = true;
  }
}

async function openDaemonSocket(session, stateFile) {
  const portFile = daemonPortFile(stateFile);
  const existing = readJson(portFile, null);
  if (existing && existing.port) {
    try {
      return await connectDaemon(existing.port);
    } catch {
      fs.rmSync(portFile, { force: true });
    }
  } else if (existing && existing.error) {
    // A prior spawn already recorded that it could not bind — don't wait.
    fs.rmSync(portFile, { force: true });
    throw new RenderBindBlockedError(existing.error);
  }

  spawn(
    session.nodeBin || process.execPath,
    [rendererScript(session), "--listen", "--port-file", portFile, "--idle-seconds", "600"],
    { cwd: session.repoRoot, detached: true, stdio: "ignore" }
  ).unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(150);
    const info = readJson(portFile, null);
    if (info && info.error) {
      // Sandbox blocked the bind; fail now instead of waiting out the timeout.
      fs.rmSync(portFile, { force: true });
      throw new RenderBindBlockedError(info.error);
    }
    if (info && info.port) {
      try {
        return await connectDaemon(info.port);
      } catch {
        /* not accepting yet — keep waiting */
      }
    }
  }
  throw new Error("render daemon did not start listening");
}

async function renderVisionFrameViaDaemon(session, payload, stateFile) {
  const socket = await openDaemonSocket(session, stateFile);
  // Generous timeout: the first render boots a headless browser and replays
  // any seeded history; later turns apply one action and are fast.
  const response = await daemonRequest(socket, { command: "render", ...payload }, 180000);
  if (!response || response.ok !== true || !response.frame) {
    throw new Error((response && response.error) || "render daemon returned no frame");
  }
  return String(response.frame);
}

// Best-effort: tell the run's render daemon to shut down (used once the game
// is over, so the headless browser doesn't linger until its idle timeout).
async function stopRenderDaemon(stateFile) {
  const info = readJson(daemonPortFile(stateFile), null);
  if (!info || !info.port) return;
  try {
    const socket = await connectDaemon(info.port);
    await daemonRequest(socket, { command: "close" }, 10000);
  } catch {
    /* already gone */
  }
  fs.rmSync(daemonPortFile(stateFile), { force: true });
}

// One-shot fallback when the daemon can't be used: boots a browser, replays
// every applied action, exits. Slow, but has no moving parts.
function renderVisionFrameOneShot(session, payload) {
  const result = spawnSync(session.nodeBin || process.execPath, [rendererScript(session)], {
    cwd: session.repoRoot,
    encoding: "utf8",
    input: JSON.stringify(payload),
    maxBuffer: 128 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "maze-render-frame.js failed").trim());
  }
  return String(JSON.parse(result.stdout).data_url || "");
}

// Render the current maze view to a PNG via maze-render-frame.js (the same
// renderer humans see in the browser). Returns the absolute path to the
// written frame.
async function renderVisionFrame(session, turnIndex, stateFile) {
  const payload = visionRenderPayload(session);
  let dataUrl;
  try {
    dataUrl = await renderVisionFrameViaDaemon(session, payload, stateFile);
  } catch (error) {
    // The one-shot renderer binds a local server too, so if the daemon was
    // blocked from binding, the fallback would fail identically — surface the
    // clear reason instead of wasting another browser boot.
    if (error && error.renderBindBlocked) {
      throw error;
    }
    dataUrl = renderVisionFrameOneShot(session, payload);
  }
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
// look at the picture. A render failure is fatal for this observation: silently
// falling back to ASCII would invalidate a vision benchmark.
async function emitStatus(session, response, turnIndex, stateFile) {
  const status = response.status || response;

  if (!session.vision) {
    console.log(JSON.stringify(status, null, 2));
    return true;
  }

  const printable = { ...status, observation_mode: "vision" };
  delete printable.level;
  try {
    printable.frame_image = await renderVisionFrame(session, turnIndex, stateFile);
  } catch (error) {
    printable.observation_mode = "vision (render unavailable)";
    printable.frame_error = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify(printable, null, 2));
    return false;
  }
  console.log(JSON.stringify(printable, null, 2));
  return true;
}

async function main() {
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
      gameId: String(options.game || "maze").trim() || "maze",
      gameWonGemCount: positiveInt(options.gameWonGemCount, 100),
      levelId: normalizeLevelId(options.level),
      nodeBin: options.nodeBin || process.execPath,
      repoRoot: options.repoRoot,
      view: options.view || "top-diagonal",
      vision: Boolean(options.vision),
      visionHeight: positiveInt(options.visionHeight, 512),
      visionView: normalizeVisionView(options.visionView),
      visionWidth: positiveInt(options.visionWidth, 512),
      yaw: normalizeYaw(Number(options.yaw))
    };
    const response = consumeRenderState(
      runBridge(session, { command: "observe" }),
      options.state
    );
    session.initial = response.status || response;
    session.lastStatus = session.initial;
    writeJson(options.state, session);
    if (!(await emitStatus(session, response, 0, options.state))) process.exitCode = 1;
    return;
  }

  const session = readJson(options.state, null);
  if (!session) throw new Error(`No session found at ${options.state}`);

  if (command === "observe") {
    const response = consumeRenderState(
      runBridge(session, { command: "observe" }),
      options.state
    );
    if (!(await emitStatus(session, response, session.actions.length, options.state))) process.exitCode = 1;
    return;
  }

  if (command === "scorecard") {
    const response = consumeRenderState(
      runBridge(session, { command: "scorecard" }),
      options.state
    );
    session.scorecard = (response.status || response).scorecard || response.scorecard || response.status || response;
    session.lastStatus = response.status || response;
    writeJson(options.state, session);
    writeJson(path.join(path.dirname(options.state), "scorecard.json"), session.scorecard);
    if (!(await emitStatus(session, response, session.actions.length, options.state))) process.exitCode = 1;
    // The scorecard marks the end of the run — release the render daemon's
    // headless browser instead of waiting out its idle timer.
    if (session.vision) await stopRenderDaemon(options.state);
    return;
  }

  if (command === "action") {
    const message = normalizeAction(options.positional);
    const response = consumeRenderState(runBridge(session, message), options.state);
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
    if (!(await emitStatus(session, response, session.actions.length, options.state))) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
