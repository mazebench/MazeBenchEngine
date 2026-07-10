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
const PRIMARY_MOVE_BUDGET = positiveInt(process.env.MAZEBENCH_MOVE_BUDGET, 20);
const WORKER_ONLY = process.env.MAZEBENCH_WORKER_ONLY === "1";
const SWARM_REQUIRED = process.env.MAZEBENCH_SWARM === "1";
const HTTP_TOKEN = String(process.env.MAZEBENCH_MCP_HTTP_TOKEN || "");

function sessionActionCount(file) {
  try {
    const session = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(session.actions) ? session.actions.length : 0;
  } catch (_error) {
    return 0;
  }
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
    return JSON.parse(text);
  } catch (_error) {
    return { output: text };
  }
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
    "--game-won-gem-count", String(positiveInt(process.env.MAZEBENCH_GEMS, 100))
  ];
  if (process.env.MAZEBENCH_MODE === "vision") {
    args.push(
      "--vision",
      "--vision-width", String(positiveInt(process.env.MAZEBENCH_VISION_WIDTH, 512)),
      "--vision-height", String(positiveInt(process.env.MAZEBENCH_VISION_HEIGHT, 512))
    );
    const visionView = String(process.env.MAZEBENCH_VISION_VIEW || "").trim();
    if (visionView) args.push("--vision-view", visionView);
  }
  return runHelper(args);
}

function createWorker(requestedId) {
  if (!fs.existsSync(PRIMARY_SESSION)) {
    throw new Error("The lead must start or resume the primary maze before a worker can clone it.");
  }

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
  fs.copyFileSync(PRIMARY_SESSION, session);
  fs.mkdirSync(workspace, { recursive: true });
  const agentUid = Number(process.env.MAZEBENCH_AGENT_UID);
  const agentGid = Number(process.env.MAZEBENCH_AGENT_GID);
  if (Number.isInteger(agentUid) && Number.isInteger(agentGid)) {
    fs.chownSync(workspace, agentUid, agentGid);
  }

  const primaryActions = path.join(path.dirname(PRIMARY_SESSION), "actions.jsonl");
  if (fs.existsSync(primaryActions)) {
    fs.copyFileSync(primaryActions, path.join(directory, "actions.jsonl"));
  }

  const metadata = {
    id,
    created_at: new Date().toISOString(),
    source_session: PRIMARY_SESSION,
    session,
    workspace,
    agent_workspace: agentWorkspace
  };
  fs.writeFileSync(path.join(directory, "worker.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return {
    ...metadata,
    instruction:
      `Use clone_id \"${id}\" for every MazeBench MCP observe/action/scorecard call. ` +
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
          description: "up, down, left, right, rotate camera up/down/left/right, undo, reset, quit, or go to level X Y"
        },
        clone_id: { type: "string", description: "Worker clone id. Omit only for the lead's primary maze." }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "maze_scorecard",
    description: "Read the scorecard for the primary maze or a private worker clone.",
    inputSchema: {
      type: "object",
      properties: { clone_id: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "maze_clone",
    description: "Clone the lead's current maze into an independent worker session with a persistent private coding workspace.",
    inputSchema: {
      type: "object",
      properties: { worker_id: { type: "string", description: "A short unique worker name." } },
      additionalProperties: false
    }
  },
  {
    name: "maze_workers",
    description: "List the private maze clones created during this run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

function callTool(name, input = {}, { workerOnly = WORKER_ONLY } = {}) {
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
    if (workerOnly && !input.clone_id) throw new Error("Workers must supply their clone_id and cannot act on the primary maze.");
    if (!input.clone_id && SWARM_REQUIRED && listWorkers().length === 0) {
      throw new Error("Spawn a provider subagent first. Only a worker can call maze_clone and unlock primary moves.");
    }
    if (!input.clone_id && sessionActionCount(PRIMARY_SESSION) - PRIMARY_INITIAL_ACTION_COUNT >= PRIMARY_MOVE_BUDGET) {
      throw new Error(`The primary move budget of ${PRIMARY_MOVE_BUDGET} action(s) is exhausted. Call maze_scorecard and finish.`);
    }
    return runHelper(["action", "--state", sessionFor(input.clone_id), String(input.action)]);
  }
  if (name === "maze_scorecard") {
    if (workerOnly && !input.clone_id) throw new Error("Workers must supply their clone_id.");
    return runHelper(["scorecard", "--state", sessionFor(input.clone_id)]);
  }
  if (name === "maze_clone") return createWorker(input.worker_id);
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
  return workerOnly
    ? TOOLS.filter((tool) => tool.name !== "maze_start")
    : TOOLS.filter((tool) => tool.name !== "maze_clone");
}

function publicToolValue(value) {
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

function appendToolActivity(entry) {
  try {
    fs.mkdirSync(path.dirname(ACTIVITY_LOG), { recursive: true });
    fs.appendFileSync(ACTIVITY_LOG, `${JSON.stringify(entry)}\n`);
  } catch (_error) {
    /* telemetry must never break gameplay */
  }
}

async function handle(request, send = stdioSend, { workerOnly = WORKER_ONLY } = {}) {
  if (!request || request.jsonrpc !== "2.0") return;
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return;
  if (request.method === "initialize") {
    success(send, request.id, {
      protocolVersion: request.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "mazebench", version: "1.0.0" }
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
    const name = String(request.params?.name || "");
    const input = request.params?.arguments || {};
    const startedAt = new Date();
    const movesBefore = actionCountForInput(input);
    try {
      const value = callTool(name, input, { workerOnly });
      success(send, request.id, toolContent(value));
      const completedAt = new Date();
      appendToolActivity({
        id: crypto.randomUUID(),
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
        moves_after: actionCountForInput(input)
      });
    } catch (error) {
      success(send, request.id, {
        content: [{ type: "text", text: safeErrorMessage(error) }],
        isError: true
      });
      const completedAt = new Date();
      appendToolActivity({
        id: crypto.randomUUID(),
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
        moves_after: actionCountForInput(input),
        error: safeErrorMessage(error)
      });
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
