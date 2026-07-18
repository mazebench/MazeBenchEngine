#!/usr/bin/env node

// A tiny stdio MCP server that keeps MazeBench state outside the coding
// agent's shell sandbox. This lets Codex/Claude have genuinely read-only or
// offline shell policies while the maze itself can still save state and render
// vision frames. Swarm workers clone the lead session into independent run
// directories and explore those copies without racing the primary game.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");
const { redactAgentStatus } = require("./codex-play");

const REPO_ROOT = path.resolve(process.env.MAZEBENCH_REPO_ROOT || path.join(__dirname, ".."));
const HELPER = path.join(REPO_ROOT, "scripts", "codex-play.js");
const RUN_DIR = path.resolve(process.env.MAZEBENCH_RUN_DIR || process.cwd());
const PRIMARY_SESSION = path.resolve(
  process.env.MAZEBENCH_SESSION_FILE || path.join(RUN_DIR, "session.json")
);
const SWARM_DIR = path.resolve(process.env.MAZEBENCH_SWARM_DIR || path.join(RUN_DIR, "swarm"));
const SWARM_WORKSPACES_DIR = path.resolve(
  process.env.MAZEBENCH_SWARM_WORKSPACES_DIR || path.join(RUN_DIR, "swarm-workspaces")
);
const AGENT_SWARM_WORKSPACES_DIR = String(
  process.env.MAZEBENCH_AGENT_SWARM_WORKSPACES_DIR || SWARM_WORKSPACES_DIR
);
const ACTIVITY_LOG = path.resolve(
  process.env.MAZEBENCH_TOOL_ACTIVITY_FILE || path.join(RUN_DIR, "tool-activity.jsonl")
);
const INSTANCE_EVENTS_LOG = path.resolve(
  process.env.MAZEBENCH_INSTANCE_EVENTS_FILE || path.join(RUN_DIR, "maze-instance-events.jsonl")
);
const PAUSE_REQUEST_FILE = path.join(RUN_DIR, "pause-request.json");
const PAUSE_BOUNDARY_FILE = path.join(RUN_DIR, "pause-boundary.json");
const PAUSE_CAPABILITY_FILE = path.join(RUN_DIR, "cold-pause-capability.json");
const RAW_PRIMARY_MOVE_BUDGET = String(process.env.MAZEBENCH_MOVE_BUDGET || "20").trim().toLowerCase();
const PRIMARY_MOVE_BUDGET = ["unlimited", "infinite", "infinity", "none"].includes(RAW_PRIMARY_MOVE_BUDGET)
  ? null
  : positiveInt(RAW_PRIMARY_MOVE_BUDGET, 20);
const ALLOW_QUIT = process.env.MAZEBENCH_ALLOW_QUIT !== "0";
const WORKER_ONLY = process.env.MAZEBENCH_WORKER_ONLY === "1";
const SWARM_REQUIRED = process.env.MAZEBENCH_SWARM === "1";
const LEAD_CLONES_ALLOWED = process.env.MAZEBENCH_ALLOW_LEAD_CLONES === "1";
const RESTRICTED_MODE = process.env.MAZEBENCH_RESTRICTED_MODE === "1";
const HTTP_TOKEN = String(process.env.MAZEBENCH_MCP_HTTP_TOKEN || "");

function sessionActionCount(file) {
  try {
    const session = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(session.actions) ? session.actions.length : 0;
  } catch (_error) {
    return 0;
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

function primaryPauseRequest() {
  return readJson(PAUSE_REQUEST_FILE, null);
}

function primaryPauseBoundary() {
  return readJson(PAUSE_BOUNDARY_FILE, null);
}

// On Continue, the session already contains prior actions. The budget applies
// only to this invocation's additional primary actions, not the full history.
const PRIMARY_INITIAL_ACTION_COUNT = sessionActionCount(PRIMARY_SESSION);

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function safeWorkerId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || `worker-${crypto.randomBytes(3).toString("hex")}`;
}

function workerDirectory(workerId) {
  const id = safeWorkerId(workerId);
  const directory = path.resolve(SWARM_DIR, id);
  const prefix = `${SWARM_DIR}${path.sep}`;
  if (!directory.startsWith(prefix)) throw new Error("Invalid worker id.");
  return directory;
}

function sessionFor(workerId) {
  if (!workerId) return PRIMARY_SESSION;
  const session = path.join(workerDirectory(workerId), "session.json");
  if (!fs.existsSync(session)) throw new Error(`Unknown maze worker \"${workerId}\".`);
  return session;
}

function runHelper(args) {
  const result = spawnSync(process.execPath, [HELPER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, MAZEBENCH_MCP_CHILD: "1" },
    maxBuffer: 128 * 1024 * 1024,
    timeout: 240000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `Maze helper exited ${result.status}`).trim());
  }
  const text = String(result.stdout || "").trim();
  try {
    return applyQuitPolicy(JSON.parse(text));
  } catch (_error) {
    return { output: text };
  }
}

function applyQuitPolicy(value) {
  if (ALLOW_QUIT || !value || typeof value !== "object") return value;
  const status = value.status && typeof value.status === "object" ? value.status : value;
  if (Array.isArray(status.allowed_commands)) {
    status.allowed_commands = status.allowed_commands.filter(
      (command) => String(command).trim().toLowerCase() !== "quit"
    );
  }
  return value;
}

function startMaze() {
  const args = [
    "start",
    "--repo-root", REPO_ROOT,
    "--state", PRIMARY_SESSION,
    "--game", process.env.MAZEBENCH_GAME_ID || "maze",
    "--level", process.env.MAZEBENCH_LEVEL_ID || "level_HxI",
    "--view", process.env.MAZEBENCH_VIEW || "top-diagonal",
    "--yaw", String(Number(process.env.MAZEBENCH_YAW) || 0),
    "--game-won-gem-count", String(positiveInt(process.env.MAZEBENCH_GEMS, 100)),
    "--max-actions", PRIMARY_MOVE_BUDGET == null ? "unlimited" : String(PRIMARY_MOVE_BUDGET)
  ];
  if (process.env.MAZEBENCH_MODE === "vision") {
    args.push(
      "--vision",
      "--vision-width", String(positiveInt(process.env.MAZEBENCH_VISION_WIDTH, 512)),
      "--vision-height", String(positiveInt(process.env.MAZEBENCH_VISION_HEIGHT, 512))
    );
    const visionView = String(process.env.MAZEBENCH_VISION_VIEW || "").trim();
    if (visionView) args.push("--vision-view", visionView);
  } else if (process.env.MAZEBENCH_MODE === "json") {
    args.push("--json-observation");
    if (process.env.MAZEBENCH_OMNISCIENT === "1") args.push("--omniscient");
  }
  if (process.env.MAZEBENCH_HIDE_NAMES === "1") {
    args.push("--hide-names");
    const hideNamesSeed = String(process.env.MAZEBENCH_HIDE_NAMES_SEED || "").trim().slice(0, 128);
    if (hideNamesSeed) args.push("--hide-names-seed", hideNamesSeed);
  }
  if (!ALLOW_QUIT) args.push("--no-quit");
  return runHelper(args);
}

function synchronizePrimarySessionBudget() {
  const session = readJson(PRIMARY_SESSION, null);
  if (!session || typeof session !== "object" || Array.isArray(session)) return;
  const maxActions = PRIMARY_MOVE_BUDGET == null
    ? null
    : PRIMARY_INITIAL_ACTION_COUNT + PRIMARY_MOVE_BUDGET;
  if (session.maxActions === maxActions) return;
  writeJson(PRIMARY_SESSION, { ...session, maxActions });
}

function appendJsonLine(filePath, entry) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
  } catch (_error) {
    /* telemetry must never break gameplay */
  }
}

function writeJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

writeJson(PAUSE_CAPABILITY_FILE, {
  version: 1,
  pid: process.pid,
  started_at: new Date().toISOString(),
  boundary: "next-completed-primary-action"
});

function compactStatus(value) {
  const status = value?.status || value || {};
  return {
    action_count: Math.max(0, Number(status.action_count) || 0),
    current_room: String(status.current_room || ""),
    current_view: String(status.current_view || ""),
    game_lost: Boolean(status.game_lost || status.player_dead),
    game_won: Boolean(status.game_won || status.solved),
    gem_count: Math.max(0, Number(status.gem_count) || 0),
    ...(process.env.MAZEBENCH_MODE === "json" ? { player: status.player || null } : {}),
    quit: Boolean(status.quit),
    yaw: Number(status.yaw) || 0
  };
}

function updateInstanceTelemetry(input, entry) {
  if (!input?.clone_id) return;
  const metadata = readWorkerMetadata(input.clone_id);
  if (!metadata) return;
  const filePath = path.join(workerDirectory(input.clone_id), "telemetry.json");
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    current = {};
  }
  writeJson(filePath, {
    instance_id: String(input.clone_id),
    parent_instance_id: metadata.parent_instance_id || "primary",
    fork_action_count: Math.max(0, Number(metadata.fork_action_count) || 0),
    actions_attempted: Math.max(0, Number(current.actions_attempted) || 0) + 1,
    actions_applied: Math.max(0, Number(current.actions_applied) || 0) + (entry.applied ? 1 : 0),
    last_action: String(entry.action || ""),
    last_action_at: entry.at,
    last_error: String(entry.error || ""),
    action_count: Math.max(0, Number(entry.action_count_after) || 0),
    own_action_count: Math.max(0, Number(entry.own_action_count) || 0),
    status: entry.status || current.status || null
  });
}

function readWorkerMetadata(workerId) {
  if (!workerId) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(workerDirectory(workerId), "worker.json"), "utf8"));
  } catch (_error) {
    return null;
  }
}

function createWorker(requestedId, options = {}) {
  if (!fs.existsSync(PRIMARY_SESSION)) {
    throw new Error("The lead must start or resume the primary maze before a worker can clone it.");
  }

  const sourceCloneId = String(options.sourceCloneId || "").trim();
  const sourceSession = sessionFor(sourceCloneId);
  const sourceDirectory = path.dirname(sourceSession);
  const forkActionCount = sessionActionCount(sourceSession);
  const ownerKind = options.workerOnly ? "subagent" : "tool";

  fs.mkdirSync(SWARM_DIR, { recursive: true });
  const base = safeWorkerId(requestedId);
  let id = base;
  let directory;
  let allocated = false;
  for (let index = 1; index < 1000; index += 1) {
    directory = workerDirectory(id);
    try {
      fs.mkdirSync(directory);
      allocated = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      id = `${base}-${index + 1}`;
    }
  }
  if (!allocated || !directory) throw new Error("Could not allocate a worker directory.");

  const session = path.join(directory, "session.json");
  const workspace = path.join(SWARM_WORKSPACES_DIR, id);
  const agentWorkspace = path.posix.join(AGENT_SWARM_WORKSPACES_DIR, id);
  fs.copyFileSync(sourceSession, session);
  const clonedSession = readJson(session, null);
  if (clonedSession && typeof clonedSession === "object" && !Array.isArray(clonedSession)) {
    writeJson(session, { ...clonedSession, maxActions: null });
  }
  fs.mkdirSync(workspace, { recursive: true });
  const agentUid = Number(process.env.MAZEBENCH_AGENT_UID);
  const agentGid = Number(process.env.MAZEBENCH_AGENT_GID);
  if (Number.isInteger(agentUid) && Number.isInteger(agentGid)) {
    fs.chownSync(workspace, agentUid, agentGid);
  }

  const sourceActions = path.join(sourceDirectory, "actions.jsonl");
  if (fs.existsSync(sourceActions)) {
    fs.copyFileSync(sourceActions, path.join(directory, "actions.jsonl"));
  }
  const sourceInitialStatus = path.join(sourceDirectory, "initial-status.json");
  if (fs.existsSync(sourceInitialStatus)) {
    fs.copyFileSync(sourceInitialStatus, path.join(directory, "initial-status.json"));
  }
  const sourceFrames = path.join(sourceDirectory, "frames");
  if (fs.existsSync(sourceFrames)) {
    const latestFrame = fs.readdirSync(sourceFrames)
      .map((name) => ({ name, match: name.match(/^frame-(\d+)\.png$/) }))
      .filter((entry) => entry.match && Number(entry.match[1]) <= forkActionCount)
      .sort((left, right) => Number(right.match[1]) - Number(left.match[1]))[0];
    if (latestFrame) {
      const targetFrames = path.join(directory, "frames");
      fs.mkdirSync(targetFrames, { recursive: true });
      fs.copyFileSync(path.join(sourceFrames, latestFrame.name), path.join(targetFrames, latestFrame.name));
    }
  }

  const metadata = {
    id,
    created_at: new Date().toISOString(),
    source_session: sourceSession,
    session,
    workspace,
    agent_workspace: agentWorkspace,
    parent_instance_id: sourceCloneId || "primary",
    fork_action_count: forkActionCount,
    primary_action_count_at_fork: sessionActionCount(PRIMARY_SESSION),
    owner_kind: ownerKind,
    owner_agent_id: String(options.ownerAgentId || requestedId || id).slice(0, 80),
    label: String(options.label || requestedId || id).slice(0, 120),
    observation_mode: ["json", "vision"].includes(process.env.MAZEBENCH_MODE)
      ? process.env.MAZEBENCH_MODE
      : "text"
  };
  fs.writeFileSync(path.join(directory, "worker.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  writeJson(path.join(directory, "telemetry.json"), {
    instance_id: id,
    parent_instance_id: metadata.parent_instance_id,
    fork_action_count: metadata.fork_action_count,
    actions_attempted: 0,
    actions_applied: 0,
    last_action: "",
    last_action_at: null,
    last_error: "",
    action_count: metadata.fork_action_count,
    own_action_count: 0,
    status: null
  });
  appendJsonLine(INSTANCE_EVENTS_LOG, {
    type: "instance.created",
    at: metadata.created_at,
    instance_id: id,
    parent_instance_id: metadata.parent_instance_id,
    fork_action_count: metadata.fork_action_count,
    primary_action_count_at_fork: metadata.primary_action_count_at_fork,
    owner_kind: metadata.owner_kind,
    owner_agent_id: metadata.owner_agent_id,
    label: metadata.label,
    observation_mode: metadata.observation_mode
  });
  return {
    ...metadata,
    own_action_count: 0,
    instruction:
      `Use clone_id \"${id}\" for every MazeBench MCP observe/action call. ` +
      `Put code and notes in ${agentWorkspace}. Never act on the primary maze; report findings to the lead.`
  };
}

function listWorkers() {
  if (!fs.existsSync(SWARM_DIR)) return [];
  return fs.readdirSync(SWARM_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = path.join(SWARM_DIR, entry.name);
      try {
        return JSON.parse(fs.readFileSync(path.join(directory, "worker.json"), "utf8"));
      } catch (_error) {
        return {
          id: entry.name,
          session: path.join(directory, "session.json"),
          workspace: path.join(SWARM_WORKSPACES_DIR, entry.name),
          agent_workspace: path.posix.join(AGENT_SWARM_WORKSPACES_DIR, entry.name)
        };
      }
    });
}

const TOOLS = [
  {
    name: "maze_start",
    description: "Start the primary MazeBench session. The lead agent calls this exactly once on a fresh run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "maze_observe",
    description: "Observe the primary maze, or a worker's private clone when clone_id is supplied.",
    inputSchema: {
      type: "object",
      properties: { clone_id: { type: "string", description: "Worker clone id. Omit only for the lead's primary maze." } },
      additionalProperties: false
    }
  },
  {
    name: "maze_action",
    description: "Apply one MazeBench action to the primary maze or a private worker clone.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: ALLOW_QUIT
            ? "up, down, left, right, rotate camera up/down/left/right, undo, reset, quit, or go to level X Y"
            : "up, down, left, right, rotate camera up/down/left/right, undo, reset, or go to level X Y"
        },
        clone_id: { type: "string", description: "Worker clone id. Omit only for the lead's primary maze." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "maze_clone",
    description: "Fork the current primary maze, or another private clone, into an independently tracked exploration instance.",
    inputSchema: {
      type: "object",
      properties: {
        worker_id: { type: "string", description: "A short unique instance name." },
        source_clone_id: { type: "string", description: "Optional existing clone to branch from. Omit to fork the primary maze." },
        owner_agent_id: { type: "string", description: "Optional provider worker or tool invocation label." },
        label: { type: "string", description: "Optional human-readable purpose for this exploration." }
      },
      additionalProperties: false
    }
  },
  {
    name: "maze_workers",
    description: "List the private maze clones created during this run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

const RESTRICTED_TOOLS = [
  {
    name: "game_start",
    description: "Start the current game once and return its first observation.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "game_observe",
    description: "Return the current game observation without changing state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "game_action",
    description: "Apply one allowed action to the current game.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: ALLOW_QUIT
            ? "up, down, left, right, rotate camera up/down/left/right, undo, reset, quit, or go to level X Y"
            : "up, down, left, right, rotate camera up/down/left/right, undo, reset, or go to level X Y"
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  }
];

function normalizedToolCall(name, input = {}) {
  if (!RESTRICTED_MODE) return { name, input };
  if (!/^game_(start|observe|action)$/.test(name)) {
    throw new Error(`Unknown game control "${name}".`);
  }
  const allowedKeys = name === "game_action" ? new Set(["action"]) : new Set();
  const extraKey = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (extraKey) throw new Error(`Unsupported argument "${extraKey}" for ${name}.`);
  return {
    name: name.replace(/^game_/, "maze_"),
    input: name === "game_action" ? { action: input.action } : {}
  };
}

function callTool(name, input = {}, { workerOnly = WORKER_ONLY } = {}) {
  if (!workerOnly && name !== "maze_start") synchronizePrimarySessionBudget();
  if (name === "maze_start") {
    if (workerOnly) throw new Error("Workers cannot start or reset the primary maze. Call maze_clone instead.");
    return startMaze();
  }
  if (name === "maze_observe") {
    if (workerOnly && !input.clone_id) throw new Error("Workers must supply their clone_id.");
    return runHelper(["observe", "--state", sessionFor(input.clone_id)]);
  }
  if (name === "maze_action") {
    if (!String(input.action || "").trim()) throw new Error("action is required.");
    if (!input.clone_id && primaryPauseBoundary()) {
      throw new Error("The user paused this run after the previous completed action. End your response now; the same thread will resume later.");
    }
    if (!ALLOW_QUIT && String(input.action).trim().toLowerCase() === "quit") {
      throw new Error(
        PRIMARY_MOVE_BUDGET == null
          ? "Quit is disabled by the user for this unlimited run. Continue playing until the maze is won or the user stops the run."
          : "Quit is disabled by the user for this run. Continue playing until the budget is exhausted or the user stops the run."
      );
    }
    if (workerOnly && !input.clone_id) throw new Error("Workers must supply their clone_id and cannot act on the primary maze.");
    if (
      !input.clone_id &&
      SWARM_REQUIRED &&
      !listWorkers().some((worker) => !worker.owner_kind || worker.owner_kind === "subagent")
    ) {
      throw new Error("Spawn a provider subagent first. Only a worker can call maze_clone and unlock primary moves.");
    }
    if (
      PRIMARY_MOVE_BUDGET != null &&
      !input.clone_id &&
      sessionActionCount(PRIMARY_SESSION) - PRIMARY_INITIAL_ACTION_COUNT >= PRIMARY_MOVE_BUDGET
    ) {
      throw new Error(`The primary move budget of ${PRIMARY_MOVE_BUDGET} action(s) is exhausted. Finish the run.`);
    }
    const result = runHelper(["action", "--state", sessionFor(input.clone_id), String(input.action)]);
    if (!input.clone_id) {
      const pauseRequest = primaryPauseRequest();
      const actionCount = sessionActionCount(PRIMARY_SESSION);
      const requestedAfter = Math.max(0, Number(pauseRequest?.requested_after_turn) || 0);
      if (pauseRequest && actionCount > requestedAfter) {
        const at = new Date().toISOString();
        writeJson(PAUSE_BOUNDARY_FILE, {
          requested_at: pauseRequest.requested_at || null,
          completed_at: at,
          completed_turn: actionCount,
          provider_thread_can_exit: true
        });
        const status = result?.status && typeof result.status === "object" ? result.status : result;
        if (status && typeof status === "object") {
          status.user_pause_requested = true;
          status.pause_message =
            "The user requested a pause. This action is fully saved. Do not take another maze action; end your response now so this exact thread can resume later.";
          status.allowed_commands = [];
        }
      }
    }
    return result;
  }
  if (name === "maze_clone") {
    if (!workerOnly && !LEAD_CLONES_ALLOWED) {
      throw new Error("Private maze branches are available to swarm workers and offline tool runs only.");
    }
    return createWorker(input.worker_id, {
      sourceCloneId: input.source_clone_id,
      ownerAgentId: input.owner_agent_id,
      label: input.label,
      workerOnly
    });
  }
  if (name === "maze_workers") return listWorkers();
  throw new Error(`Unknown tool \"${name}\".`);
}

function stdioSend(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function success(send, id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .split(/\r?\n/, 1)[0]
    .replaceAll(REPO_ROOT, "[maze runtime]")
    .replaceAll(RUN_DIR, "[run]");
}

function failure(send, id, error) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message: safeErrorMessage(error) }
  });
}

function toolsFor(workerOnly) {
  if (RESTRICTED_MODE) return RESTRICTED_TOOLS;
  if (workerOnly) return TOOLS.filter((tool) => tool.name !== "maze_start");
  return LEAD_CLONES_ALLOWED ? TOOLS : TOOLS.filter((tool) => tool.name !== "maze_clone");
}

function publicToolValue(value) {
  value = redactAgentStatus(value, {
    mode: ["json", "vision"].includes(process.env.MAZEBENCH_MODE)
      ? process.env.MAZEBENCH_MODE
      : "text"
  });
  if (process.env.MAZEBENCH_MODE !== "json" && process.env.MAZEBENCH_MODE !== "vision") {
    const status = value?.status && typeof value.status === "object" ? value.status : value;
    const level = status && typeof status === "object"
      ? status.level || status.observation
      : "";
    if (typeof level === "string" && level.length > 0) return { level };
  }
  if (Array.isArray(value)) return value.map(publicToolValue);
  if (!value || typeof value !== "object") return value;
  const printable = {};
  for (const [key, item] of Object.entries(value)) {
    // These are trusted-runner paths. They are not useful to the provider and
    // exposing them makes the isolation boundary needlessly discoverable.
    if (["session", "source_session", "workspace"].includes(key)) continue;
    printable[key] = key === "frame_image" ? "attached:image/png" : publicToolValue(item);
  }
  return printable;
}

function toolContent(value) {
  const printable = publicToolValue(value);
  const content = [{ type: "text", text: JSON.stringify(printable, null, 2) }];
  const framePath = value && typeof value === "object" ? String(value.frame_image || "") : "";
  if (framePath) {
    const resolved = path.resolve(framePath);
    if (resolved.startsWith(`${RUN_DIR}${path.sep}`) && fs.existsSync(resolved)) {
      content.push({
        type: "image",
        data: fs.readFileSync(resolved).toString("base64"),
        mimeType: "image/png"
      });
    }
  }
  return { content, structuredContent: printable, isError: false };
}

function actionCountForInput(input) {
  try {
    return sessionActionCount(sessionFor(input?.clone_id));
  } catch (_error) {
    return 0;
  }
}

function lastStatusForInput(input) {
  try {
    const session = JSON.parse(fs.readFileSync(sessionFor(input?.clone_id), "utf8"));
    return compactStatus(session.lastStatus || session.initial || {});
  } catch (_error) {
    return null;
  }
}

function appendToolActivity(entry) {
  appendJsonLine(ACTIVITY_LOG, entry);
}

async function handle(request, send = stdioSend, { workerOnly = WORKER_ONLY } = {}) {
  if (!request || request.jsonrpc !== "2.0") return;
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return;
  if (request.method === "initialize") {
    success(send, request.id, {
      protocolVersion: request.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: RESTRICTED_MODE ? "game" : "mazebench", version: "1.0.0" }
    });
    return;
  }
  if (request.method === "ping") {
    success(send, request.id, {});
    return;
  }
  if (request.method === "tools/list") {
    success(send, request.id, { tools: toolsFor(workerOnly) });
    return;
  }
  if (request.method === "tools/call") {
    const requestedName = String(request.params?.name || "");
    let name;
    let input;
    try {
      ({ name, input } = normalizedToolCall(requestedName, request.params?.arguments || {}));
    } catch (error) {
      failure(send, request.id, error);
      return;
    }
    const startedAt = new Date();
    const movesBefore = actionCountForInput(input);
    const activityId = crypto.randomUUID();
    const instanceId = String(input.clone_id || "primary");
    const instanceMetadata = readWorkerMetadata(input.clone_id);
    appendToolActivity({
      id: activityId,
      tool: name,
      actor: workerOnly ? "worker" : input.clone_id ? "tool" : "lead",
      clone_id: String(input.clone_id || ""),
      action: String(input.action || ""),
      started_at: startedAt.toISOString(),
      status: "running",
      move_calls: 0,
      moves_before: movesBefore,
      moves_after: movesBefore
    });
    try {
      const value = callTool(name, input, { workerOnly });
      success(send, request.id, toolContent(value));
      const completedAt = new Date();
      const movesAfter = actionCountForInput(input);
      appendToolActivity({
        id: activityId,
        tool: name,
        actor: workerOnly ? "worker" : "lead",
        clone_id: String(input.clone_id || value?.id || ""),
        action: String(input.action || ""),
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        duration_ms: completedAt.getTime() - startedAt.getTime(),
        status: "completed",
        move_calls: name === "maze_action" ? 1 : 0,
        moves_before: movesBefore,
        moves_after: movesAfter
      });
      if (name === "maze_action" && (!input.clone_id || instanceMetadata)) {
        const instanceEvent = {
          type: "instance.action",
          id: activityId,
          at: completedAt.toISOString(),
          instance_id: instanceId,
          parent_instance_id: instanceMetadata?.parent_instance_id || null,
          owner_kind: instanceMetadata?.owner_kind || (workerOnly ? "subagent" : input.clone_id ? "tool" : "lead"),
          owner_agent_id: instanceMetadata?.owner_agent_id || "",
          action: String(input.action || ""),
          attempted: true,
          applied: movesAfter > movesBefore,
          action_count_before: movesBefore,
          action_count_after: movesAfter,
          own_action_count: input.clone_id
            ? Math.max(0, movesAfter - Number(instanceMetadata?.fork_action_count || 0))
            : movesAfter,
          status: compactStatus(value)
        };
        appendJsonLine(INSTANCE_EVENTS_LOG, instanceEvent);
        updateInstanceTelemetry(input, instanceEvent);
      }
    } catch (error) {
      success(send, request.id, {
        content: [{ type: "text", text: safeErrorMessage(error) }],
        isError: true
      });
      const completedAt = new Date();
      const movesAfter = actionCountForInput(input);
      appendToolActivity({
        id: activityId,
        tool: name,
        actor: workerOnly ? "worker" : "lead",
        clone_id: String(input.clone_id || ""),
        action: String(input.action || ""),
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        duration_ms: completedAt.getTime() - startedAt.getTime(),
        status: "failed",
        move_calls: name === "maze_action" ? 1 : 0,
        moves_before: movesBefore,
        moves_after: movesAfter,
        error: safeErrorMessage(error)
      });
      if (name === "maze_action" && (!input.clone_id || instanceMetadata)) {
        const instanceEvent = {
          type: "instance.action",
          id: activityId,
          at: completedAt.toISOString(),
          instance_id: instanceId,
          parent_instance_id: instanceMetadata?.parent_instance_id || null,
          owner_kind: instanceMetadata?.owner_kind || (workerOnly ? "subagent" : input.clone_id ? "tool" : "lead"),
          owner_agent_id: instanceMetadata?.owner_agent_id || "",
          action: String(input.action || ""),
          attempted: true,
          applied: movesAfter > movesBefore,
          action_count_before: movesBefore,
          action_count_after: movesAfter,
          own_action_count: input.clone_id
            ? Math.max(0, movesAfter - Number(instanceMetadata?.fork_action_count || 0))
            : movesAfter,
          error: safeErrorMessage(error),
          status: movesAfter > movesBefore ? lastStatusForInput(input) : null
        };
        appendJsonLine(INSTANCE_EVENTS_LOG, instanceEvent);
        updateInstanceTelemetry(input, instanceEvent);
      }
    }
    return;
  }
  if (request.id !== undefined) failure(send, request.id, new Error(`Unsupported method \"${request.method}\".`));
}

function parseHttpMode(argv) {
  if (!argv.includes("--http")) return null;
  const portIndex = argv.indexOf("--port-file");
  return {
    portFile: portIndex >= 0
      ? path.resolve(argv[portIndex + 1] || "")
      : path.join(RUN_DIR, "mcp-http.json")
  };
}

function startHttpServer({ portFile }) {
  if (!HTTP_TOKEN) throw new Error("MAZEBENCH_MCP_HTTP_TOKEN is required in HTTP mode.");
  const server = http.createServer((request, response) => {
    const match = String(request.url || "").match(/^\/([^/]+)\/(lead|worker)$/);
    if (!match || match[1] !== HTTP_TOKEN) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) request.destroy();
    });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "null");
        const requests = Array.isArray(payload) ? payload : [payload];
        const replies = [];
        for (const message of requests) {
          await handle(message, (reply) => replies.push(reply), { workerOnly: match[2] === "worker" });
        }
        if (!replies.length) {
          response.writeHead(202).end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Mcp-Session-Id": HTTP_TOKEN
        });
        response.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: safeErrorMessage(error) }));
      }
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    fs.writeFileSync(
      portFile,
      `${JSON.stringify({ port: address.port, token: HTTP_TOKEN, pid: process.pid })}\n`,
      "utf8"
    );
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (require.main === module) {
  const httpMode = parseHttpMode(process.argv.slice(2));
  if (httpMode) {
    startHttpServer(httpMode);
  } else {
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", (line) => {
      if (!line.trim()) return;
      try {
        handle(JSON.parse(line));
      } catch (error) {
        failure(stdioSend, null, error);
      }
    });
  }
}

module.exports = {
  callTool,
  createWorker,
  listWorkers,
  safeWorkerId,
  sessionFor,
  toolContent
};
