#!/usr/bin/env node

// Drive MazeBench with a LOCAL coding agent (Codex CLI or Claude Code) instead
// of Prime Intellect Verifiers. The agent plays the maze by shelling out to
// scripts/codex-play.js (a stateful CLI over scripts/maze-bridge.js). When the
// agent is done we make sure a scorecard exists and then render a replay video
// via scripts/maze-export-replay.js.
//
// Usage:
//   node scripts/maze-agent-local.js --model codex [options]
//   node scripts/maze-agent-local.js model=claude moves=10 level=HxI
//
// Options accept either "--flag value" or "key=value" form:
//   model        codex | claude                              (required)
//   container    true (run inside docker, host FS isolated)  (default true)
//                | false (run on host with the CLI sandbox)
//   image        container image tag                         (default mazebench-agent)
//   docker_bin   container runtime                           (default docker)
//   codex_auth / claude_auth   host auth dir to mount read-only (subscription logins)
//   tool_use     read-only | offline                         (default read-only)
//   tools        legacy boolean alias (false=read-only, true=offline)
//   swarm        true lets the lead spawn identical-model workers
//   mode         text (ASCII board) | vision (rendered PNGs) (default text)
//   moves        maze action budget shown to the agent       (default 20)
//   game         game directory under games/ (default maze; draft/online
//                worlds created in Build Mode use their games/<id> dirs)
//   level        world level id, e.g. HxI or level_HxI       (default level_HxI)
//   vision_width, vision_height   PNG size in vision mode     (default 512)
//   vision_view  how far vision frames see: 1-26 rings of neighbor rooms
//                or "world"                                   (default 1 = 3x3)
//   view         top | top-diagonal | diagonal | side-diagonal | side
//   yaw          0-3 camera yaw                               (default 0)
//   gems         unique gems required for game_won            (default 100)
//   model_name   underlying LLM id (codex -m / claude --model) (agent default)
//   reasoning    reasoning effort. codex: low|medium|high|xhigh; claude:
//                low|medium|high|xhigh|max (model/agent default when unset)
//   codex_fast   codex Fast mode (priority tier)              (default false)
//   video        on | off                                     (default on)
//   out          output directory for this run's artifacts
//   session      explicit session.json path (overrides out)
//   codex_bin    codex executable                             (default codex)
//   claude_bin   claude executable                            (default claude)
//   fast|draft   forwarded to the video renderer for speed
//   width|height|fps  forwarded to the video renderer
//   dry_run      print the agent command + prompt and exit (no run)

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const HELPER = path.join(ROOT_DIR, "scripts", "codex-play.js");
const MAZE_MCP_SERVER = path.join(ROOT_DIR, "scripts", "maze-mcp-server.js");
const EXPORT_REPLAY = path.join(ROOT_DIR, "scripts", "maze-export-replay.js");
const VIEW_NAMES = ["top", "top-diagonal", "diagonal", "side-diagonal", "side"];

function parseArgs(argv) {
  const raw = {};
  const passthrough = [];
  let sawSeparator = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      sawSeparator = true;
      continue;
    }

    if (sawSeparator) {
      passthrough.push(arg);
      continue;
    }

    const kv = arg.match(/^(?:--)?([A-Za-z_][\w-]*)=(.*)$/);
    if (kv) {
      raw[kv[1].replace(/-/g, "_")] = kv[2];
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-/g, "_");
      const next = argv[index + 1];
      // Boolean-ish flags (video renderer passthrough) take no value.
      if (["fast", "draft", "no_video"].includes(key) || next === undefined || next.startsWith("--")) {
        raw[key] = "true";
      } else {
        raw[key] = next;
        index += 1;
      }
      continue;
    }

    passthrough.push(arg);
  }

  return { raw, passthrough };
}

function normalizeLevelId(value) {
  const match = String(value || "level_HxI").trim().match(/^(?:level_)?([A-Za-z])x([A-Za-z])$/);
  return match ? `level_${match[1].toUpperCase()}x${match[2].toUpperCase()}` : "level_HxI";
}

function normalizeGameId(value) {
  const gameId = String(value || "maze").trim();
  return /^[a-z0-9][a-z0-9_-]*$/i.test(gameId) ? gameId : "maze";
}

function isTruthy(value, fallback = false) {
  if (value === undefined) return fallback;
  return !["off", "false", "0", "no", ""].includes(String(value).toLowerCase());
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

function buildMcpPrompt(config) {
  const observation = config.mode === "vision"
    ? `This is VISION mode. Every maze observation includes the current PNG as
an MCP image attachment. Inspect that image before choosing a move; there is no
ASCII board. The status also includes the room, gems, player position, and
allowed commands.`
    : `This is TEXT mode. Maze observations contain an ASCII board in the level
field plus the current status.`;
  const capability = config.toolUse === "offline"
    ? config.hostAccess
      ? `You have local file, coding, and execution tools on the host. Work in
${ROOT_DIR} and keep run-specific notes in ${config.workspaceDir}. Outbound
network access is disabled. Host access is less isolated than Docker.`
      : `You have full local file, coding, and execution tools inside a persistent
Docker workspace at ${config.agentWorkspaceDir}. Outbound network access is disabled.
If a tool or algorithm needs an experimental MazeBench branch, call maze_clone
with a descriptive worker_id and label, then include its clone_id in every maze
call. Each branch starts from the selected checkpoint and all of its attempted
and applied actions are tracked separately from the primary score.`
    : `This is READ ONLY tool-use. You may inspect and search local files and
explore private maze clones through MCP, but you cannot edit files or execute
general-purpose code.`;
  const firstStep = config.resume || config.seed
    ? `Call maze_observe with no clone_id first. This is the same primary game;
do not call maze_start.`
    : `Call maze_start exactly once as your first MazeBench tool call.`;
  const workerSpawnRule = config.model === "codex"
    ? "Use the Codex collaboration spawn tool to spawn the custom maze-worker agent without a full-history fork. Its model and reasoning effort are pinned to yours."
    : "Use the Task/Agent tool to spawn the configured maze-worker subagent type. The subagent creates its own branch. Its model and effort are pinned to yours.";
  const workerCapability = config.toolUse === "offline"
    ? "may write and execute local code in its private workspace"
    : "is read-only and must not write files or execute general-purpose code";
  const swarm = config.swarm
    ? `
SWARM IS ENABLED. You are the superior lead and retain control of the primary
maze. ${workerSpawnRule} Every worker uses the exact same model and reasoning
effort as you and inherits your tool-use policy.

Each worker must begin by calling maze_clone with a unique worker_id. That tool
creates an independent copy of the maze and returns a private persistent coding
workspace. The worker must include that clone_id in every maze_observe,
maze_action, and maze_scorecard call, may explore freely, ${workerCapability},
then report its findings to you. Workers must never act on
the primary maze. You decide which findings to use and make every primary move
yourself by omitting clone_id. Spawn at least one worker before your first
primary move. ${config.toolUse === "offline" ? "You may also create clearly labelled tool-driven branches with maze_clone; never use those clone ids for the primary score." : "Provider workers create their own branches."}
Beyond that, spawn, steer, stop, or wait for workers at your
discretion. Gather their reports before finishing.`
    : "";
  const budgetInstruction = config.unlimited
    ? `This run has NO MOVE LIMIT. Keep taking primary maze actions until the
maze is won or the user stops the run. Do not call maze_scorecard merely because
an action count or provider turn count has been reached.`
    : `Then play up to ${config.moves} ${config.resume || config.seed ? "MORE " : ""}primary maze actions unless the game reaches a terminal state earlier.`;
  const quitPolicy = config.allowQuit
    ? ""
    : config.unlimited
      ? `QUIT IS DISABLED BY THE USER. The quit action is unavailable and rejected without consuming an action. Continue until the maze is won or the user stops the run.`
      : `QUIT IS DISABLED BY THE USER. The quit action is unavailable and rejected without consuming an action. Do not end your provider response while playable budget remains; continue until the budget is exhausted, the maze is won, or the user stops the run.`;
  const validActions = config.allowQuit
    ? "up, down, left, right, rotate camera left/right/up/down, undo, reset, quit, and go to level H I"
    : "up, down, left, right, rotate camera left/right/up/down, undo, reset, and go to level H I";

  return `You are playing MazeBench, a 3D grid maze. Control maze state only
through the MazeBench MCP tools: maze_start, maze_observe, maze_action, and
maze_scorecard. Offline tool runs and swarm workers also receive maze_clone for
independent, fully tracked branches. Never edit session JSON directly.

${observation}
${capability}
${swarm}
${quitPolicy}

${firstStep}

${budgetInstruction} Do not
stop after the first observation while budget remains. Before every primary
maze_action, write one short sentence explaining the choice. Valid action
strings include ${validActions}.

After every action, inspect the returned ${config.mode === "vision" ? "frame and status" : "board and status"} before choosing the next move. Collect as many
unique gems as possible. If the player dies, recover with undo, reset, or a room
change. Before finishing, always call maze_scorecard on the primary maze and
give a one-line summary of the route and gems collected.`;
}

function buildPrompt(config) {
  if (config.mcpEnabled) return buildMcpPrompt(config);
  const visionFlags = config.mode === "vision"
    ? ` --vision --vision-width ${config.visionWidth} --vision-height ${config.visionHeight}` +
      (config.visionView ? ` --vision-view ${config.visionView}` : "")
    : "";
  const observation = config.mode === "vision"
    ? `This is VISION mode. Every helper command prints JSON containing a
"frame_image" field: an absolute path to a PNG of the current maze view. OPEN
and LOOK AT that image to decide your next move — there is NO ASCII board. The
JSON also carries a short text status (current_room, gem_count, player
x/y/elevation, allowed_commands). The first command boots a headless browser
(a few seconds); later commands render quickly.`
    : `This is TEXT mode. Every helper command prints a JSON observation with an
ASCII board in the "level" field plus a short status. Read the JSON to choose
your next move.`;
  const toolsNote = config.tools
    ? ""
    : `
You are sandboxed: you may ONLY run the maze helper commands shown below${
        config.mode === "vision" ? " and open the frame_image PNG" : ""
      }.
Reading other files, writing files, running other programs, and network access
are blocked. Do not attempt them — just play the maze.
`;
  const quitPolicy = config.allowQuit
    ? ""
    : config.unlimited
      ? `
QUIT IS DISABLED BY THE USER. A quit attempt is rejected without consuming an action. Continue until the maze is won or the user stops the run.
`
      : `
QUIT IS DISABLED BY THE USER. A quit attempt is rejected without consuming an action. Do not end your provider response while playable budget remains; continue until the budget is exhausted, the maze is won, or the user stops the run.
`;

  return `You are playing MazeBench, a 3D grid maze, through a local CLI helper.
Drive the game ONLY through the helper commands below. Do NOT read or modify
source files and do NOT try to parse the board yourself.

${observation}
${toolsNote}
${quitPolicy}
Repo root:    ${ROOT_DIR}
Helper:       ${HELPER}
Session file: ${config.sessionFile}

${config.resume
    ? `You are CONTINUING the SAME MazeBench game you were just playing — you already
have the full history in memory and know the helper. The session file is still
${config.sessionFile}. Do NOT run "start"; that would erase the progress.

Your FIRST shell command must re-read the current observation:

  node "${HELPER}" observe --state "${config.sessionFile}"

Then ${config.unlimited ? "keep taking maze actions from where you left off" : `play up to ${config.moves} MORE maze action(s) from where you left off`},`
    : config.seed
    ? `This maze is ALREADY IN PROGRESS: earlier moves were made and the game state
is saved in the session file. Do NOT run "start" — that would erase the progress.

Your FIRST shell command must read the current observation to see where the maze
stands right now:

  node "${HELPER}" observe --state "${config.sessionFile}"

Then ${config.unlimited ? "keep taking maze actions from that state" : `continue playing up to ${config.moves} MORE maze action(s) from that state`},`
    : `Your FIRST shell command must start the session (run it exactly once):

  node "${HELPER}" start --repo-root "${ROOT_DIR}" --state "${config.sessionFile}" --game "${config.gameId}" --level "${config.levelId}" --view "${config.view}" --yaw "${config.yaw}" --game-won-gem-count "${config.gems}"${visionFlags}

Then ${config.unlimited ? "keep taking maze actions" : `play up to ${config.moves} maze action(s)`},`} ${
  config.unlimited
    ? "This run has NO MOVE LIMIT. Continue until the maze is won or the user stops the run."
    : "unless the game reaches a terminal state earlier."
} Do not stop right after the first command: choose and run at least one action. After each action, read the
observation (${config.mode === "vision" ? "the frame_image PNG plus the JSON status" : "the JSON board"}) and choose the next command.

Before you run each action command, write one short sentence (as normal text,
not a comment) explaining why you are choosing that move.

Action command forms:

  node "${HELPER}" action --state "${config.sessionFile}" up        (also down / left / right)
  node "${HELPER}" action --state "${config.sessionFile}" rotate camera left
  node "${HELPER}" action --state "${config.sessionFile}" undo
  node "${HELPER}" action --state "${config.sessionFile}" reset
  node "${HELPER}" action --state "${config.sessionFile}" go to level H I

Goal: collect as many unique gems as you can within the action budget. If the
player dies, recover with undo / reset / go to level.

Before you finish, ALWAYS write the final scorecard:

  node "${HELPER}" scorecard --state "${config.sessionFile}"

Finish with a one-line summary of the path you took and how many gems you got.`;
}

function mcpEnvironment(config, workerOnly = false) {
  return {
    MAZEBENCH_REPO_ROOT: ROOT_DIR,
    MAZEBENCH_RUN_DIR: config.outDir,
    MAZEBENCH_SESSION_FILE: config.sessionFile,
    MAZEBENCH_SWARM_DIR: config.swarmDir,
    MAZEBENCH_SWARM_WORKSPACES_DIR: config.swarmWorkspaceDir,
    MAZEBENCH_AGENT_SWARM_WORKSPACES_DIR: config.agentSwarmWorkspaceDir,
    MAZEBENCH_TOOL_ACTIVITY_FILE: path.join(config.outDir, "tool-activity.jsonl"),
    MAZEBENCH_INSTANCE_EVENTS_FILE: path.join(config.outDir, "maze-instance-events.jsonl"),
    MAZEBENCH_GAME_ID: config.gameId,
    MAZEBENCH_LEVEL_ID: config.levelId,
    MAZEBENCH_VIEW: config.view,
    MAZEBENCH_YAW: String(config.yaw),
    MAZEBENCH_GEMS: String(config.gems),
    MAZEBENCH_MOVE_BUDGET: config.unlimited ? "unlimited" : String(config.moves),
    MAZEBENCH_ALLOW_QUIT: config.allowQuit ? "1" : "0",
    MAZEBENCH_SWARM: config.swarm ? "1" : "0",
    MAZEBENCH_ALLOW_LEAD_CLONES: config.toolUse === "offline" ? "1" : "0",
    MAZEBENCH_MODE: config.mode,
    MAZEBENCH_VISION_WIDTH: String(config.visionWidth),
    MAZEBENCH_VISION_HEIGHT: String(config.visionHeight),
    MAZEBENCH_VISION_VIEW: config.visionView || "",
    ...(config.inContainer
      ? { MAZEBENCH_AGENT_UID: String(config.agentUid), MAZEBENCH_AGENT_GID: String(config.agentGid) }
      : {}),
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
      ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
      : {}),
    ...(workerOnly ? { MAZEBENCH_WORKER_ONLY: "1" } : {})
  };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function codexWritableRoots(config) {
  return [
    config.agentWorkspaceDir,
    config.agentSwarmWorkspaceDir,
    ...(config.hostAccess && config.toolUse === "offline" ? [ROOT_DIR] : [])
  ];
}

function codexMcpConfigArgs(config) {
  const prefix = "mcp_servers.mazebench";
  if (config.mcpUrl) {
    return [
      "-c", `${prefix}.url=${tomlString(config.mcpUrl)}`,
      "-c", `${prefix}.default_tools_approval_mode="approve"`,
      "-c", `${prefix}.startup_timeout_sec=15`,
      "-c", `${prefix}.tool_timeout_sec=300`
    ];
  }
  const envEntries = Object.entries(mcpEnvironment(config))
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ");
  return [
    "-c", `${prefix}.command=${tomlString(process.execPath)}`,
    "-c", `${prefix}.args=[${tomlString(MAZE_MCP_SERVER)}]`,
    "-c", `${prefix}.default_tools_approval_mode="approve"`,
    "-c", `${prefix}.startup_timeout_sec=15`,
    "-c", `${prefix}.tool_timeout_sec=300`,
    "-c", `${prefix}.env={ ${envEntries} }`
  ];
}

function codexWorkerConfig(config, name) {
  const offline = config.toolUse === "offline";
  const rows = [
    `name = ${tomlString(name)}`,
    `description = ${tomlString(
      offline
        ? "A MazeBench exploration and coding worker controlled by the lead."
        : "A read-only MazeBench exploration worker controlled by the lead."
    )}`
  ];
  if (config.modelName) rows.push(`model = ${tomlString(config.modelName)}`);
  if (config.reasoning) rows.push(`model_reasoning_effort = ${tomlString(config.reasoning)}`);
  rows.push(
    `sandbox_mode = ${tomlString(offline ? "workspace-write" : "read-only")}`,
    `developer_instructions = ${tomlString(
      "You are a MazeBench swarm worker. Use the identical model and reasoning effort inherited from the lead. " +
      "First call maze_clone with a unique worker_id, then use that clone_id for every maze tool call. " +
      (offline
        ? "Explore only your private maze, write and execute any useful local code in the returned workspace, and report findings to the lead. "
        : "Explore only your private maze without writing files or executing general-purpose code, and report findings to the lead. ") +
      "Never act on the primary maze and never change your model or reasoning effort."
    )}`,
    "",
    "[mcp_servers.mazebench]",
    ...(config.mcpWorkerUrl
      ? [`url = ${tomlString(config.mcpWorkerUrl)}`]
      : [
          `command = ${tomlString(process.execPath)}`,
          `args = [${tomlString(MAZE_MCP_SERVER)}]`,
          `env = { ${Object.entries(mcpEnvironment(config, true)).map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ")} }`
        ]),
    'default_tools_approval_mode = "approve"',
    "startup_timeout_sec = 15",
    "tool_timeout_sec = 300"
  );
  return `${rows.join("\n")}\n`;
}

function prepareCodexRuntime(config) {
  if (config.swarm) {
    // Project-scoped agent profiles keep host runs from modifying the user's
    // global ~/.codex configuration. The CLI still uses its normal auth and
    // session store, which is required for true Continue.
    const agentsDir = path.join(config.workspaceDir, ".codex", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const name of ["default", "worker", "explorer", "maze-worker"]) {
      fs.writeFileSync(path.join(agentsDir, `${name}.toml`), codexWorkerConfig(config, name));
    }
  }
}

function codexAgentConfigArgs(config) {
  if (!config.swarm) return [];
  return ["default", "worker", "explorer", "maze-worker"].flatMap((name) => [
    "-c", `agents.${name}.description=${tomlString("An identical-model MazeBench worker controlled by the lead.")}`,
    "-c", `agents.${name}.config_file=${tomlString(path.posix.join(config.agentWorkspaceDir, ".codex", "agents", `${name}.toml`))}`
  ]);
}

function claudeMcpConfig(config) {
  return JSON.stringify({
    mcpServers: {
      mazebench: config.mcpUrl
        ? { type: "http", url: config.mcpUrl }
        : { command: process.execPath, args: [MAZE_MCP_SERVER], env: mcpEnvironment(config) }
    }
  });
}

function claudeSandboxSettings(config) {
  const offline = config.toolUse === "offline";
  const workerAllow = config.swarm
    ? [
        ...(offline ? ["Bash(*)", "Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit", "Skill"] : ["Read", "Glob", "Grep"]),
        "mcp__mazebench_worker__maze_clone",
        "mcp__mazebench_worker__maze_observe",
        "mcp__mazebench_worker__maze_action",
        "mcp__mazebench_worker__maze_scorecard",
        "mcp__mazebench_worker__maze_workers"
      ]
    : [];
  const home = config.inContainer ? "/home/pwuser" : process.env.HOME || "/home/pwuser";
  const denyRead = [
    process.env.CODEX_HOME || path.join(home, ".codex"),
    process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
    ...(config.hostAccess
      ? ["~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.config/gcloud"]
      : [])
  ];
  const allowWrite = offline
    ? [config.agentWorkspaceDir, config.agentSwarmWorkspaceDir, ...(config.hostAccess ? [ROOT_DIR] : [])]
    : [];
  return JSON.stringify({
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: offline,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      enableWeakerNestedSandbox: config.inContainer,
      filesystem: {
        allowWrite,
        denyRead
      },
      network: { allowedDomains: [] },
      credentials: {
        envVars: [
          { name: "OPENAI_API_KEY", mode: "deny" },
          { name: "ANTHROPIC_API_KEY", mode: "deny" },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" }
        ]
      }
    },
    permissions: {
      // Custom-agent `tools` controls what the worker can see. Under dontAsk,
      // these names must also be pre-approved or Claude silently denies them.
      // The provider sandbox still confines writes to the selected access roots.
      allow: workerAllow,
      deny: [
        "WebFetch",
        "WebSearch",
        ...denyRead.map((entry) => `Read(${entry}/**)`)
      ]
    }
  });
}

function claudeAgents(config) {
  if (!config.swarm) return "";
  const offline = config.toolUse === "offline";
  const localTools = offline
    ? ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit", "Skill", "TaskOutput", "TaskStop"]
    : ["Read", "Glob", "Grep"];
  const worker = {
    description: offline
      ? "Explore a private MazeBench clone, use offline coding tools, and report to the lead."
      : "Explore a private MazeBench clone read-only and report to the lead.",
    prompt:
      "You are a MazeBench swarm worker controlled by the superior lead. First call maze_clone with a unique worker_id. " +
      "Use the returned clone_id for all maze calls, work only in its private workspace, and report findings to the lead. " +
      (offline
        ? "You may write and execute local code in that workspace. "
        : "Do not write files or execute general-purpose code. ") +
      "Never act on the primary maze and never switch model or reasoning effort.",
    model: config.modelName || "inherit",
    permissionMode: "dontAsk",
    background: true,
    tools: [
      ...localTools,
      "mcp__mazebench_worker__maze_clone",
      "mcp__mazebench_worker__maze_observe",
      "mcp__mazebench_worker__maze_action",
      "mcp__mazebench_worker__maze_scorecard",
      "mcp__mazebench_worker__maze_workers"
    ],
    mcpServers: [{
      mazebench_worker: config.mcpWorkerUrl
        ? { type: "http", url: config.mcpWorkerUrl }
        : {
            type: "stdio",
            command: process.execPath,
            args: [MAZE_MCP_SERVER],
            env: mcpEnvironment(config, true)
          }
    }]
  };
  if (config.reasoning) worker.effort = config.reasoning;
  return JSON.stringify({ "maze-worker": worker });
}

function prepareAgentRuntime(config) {
  if (!config.mcpEnabled) return;
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  fs.mkdirSync(config.swarmDir, { recursive: true });
  fs.mkdirSync(config.swarmWorkspaceDir, { recursive: true });
  if (config.model === "codex") prepareCodexRuntime(config);
}

async function startPrivateMcpServer(config) {
  const token = crypto.randomBytes(24).toString("hex");
  const portFile = path.join(config.outDir, "mcp-http.json");
  fs.rmSync(portFile, { force: true });
  const child = spawn(
    process.execPath,
    [MAZE_MCP_SERVER, "--http", "--port-file", portFile],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ...mcpEnvironment(config),
        MAZEBENCH_MCP_HTTP_TOKEN: token
      },
      stdio: ["ignore", "ignore", "inherit"]
    }
  );

  let exited = null;
  child.once("exit", (code) => {
    exited = code;
  });
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(portFile) && Date.now() < deadline && exited === null) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!fs.existsSync(portFile)) {
    child.kill("SIGKILL");
    throw new Error(`Private MazeBench MCP service failed to start${exited === null ? "" : ` (exit ${exited})`}.`);
  }
  const info = JSON.parse(fs.readFileSync(portFile, "utf8"));
  const base = `http://127.0.0.1:${Number(info.port)}/${token}`;
  config.mcpUrl = `${base}/lead`;
  config.mcpWorkerUrl = `${base}/worker`;
  return {
    stop() {
      if (child.exitCode == null) child.kill("SIGTERM");
      fs.rmSync(portFile, { force: true });
    }
  };
}

function isolatedDockerAgentCommand(config, command) {
  if (!config.inContainer) return command;
  const chownTree = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) chownTree(child);
      fs.chownSync(child, config.agentUid, config.agentGid);
    }
    fs.chownSync(directory, config.agentUid, config.agentGid);
  };
  chownTree(config.workspaceDir);
  chownTree(config.swarmWorkspaceDir);
  for (const directory of ["/home/pwuser/.codex/sessions", "/home/pwuser/.claude/projects"]) {
    chownTree(directory);
  }
  const credentialOverlays = [];
  const stageCredential = (directory, fileName) => {
    const source = path.join(directory, fileName);
    if (!fs.existsSync(source)) return;
    const staged = path.join(directory, `.${fileName}.mazebench-${process.pid}`);
    fs.copyFileSync(source, staged);
    fs.chmodSync(staged, 0o600);
    fs.chownSync(staged, config.agentUid, config.agentGid);
    credentialOverlays.push([staged, source]);
  };
  stageCredential("/home/pwuser/.codex", "auth.json");
  stageCredential("/home/pwuser/.claude", ".credentials.json");
  // A bwrap tmpfs root is owned by root. Give the demoted provider a private,
  // container-ephemeral /tmp so Claude Code can create its per-UID runtime dir
  // without exposing the trusted runner's /tmp contents.
  const providerTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-provider-"));
  fs.chmodSync(providerTmpDir, 0o700);
  fs.chownSync(providerTmpDir, config.agentUid, config.agentGid);
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--ro-bind", "/", "/",
    // Hide every bundled MazeBench source, level, world-map, prior output, and
    // solver from the provider and all descendants. Only blank run workspaces
    // are rebound below; gameplay stays behind the private HTTP MCP service.
    "--tmpfs", ROOT_DIR,
    "--dir", config.agentWorkspaceDir,
    "--dir", config.agentSwarmWorkspaceDir,
    "--bind", providerTmpDir, "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    "--bind", config.workspaceDir, config.agentWorkspaceDir,
    "--bind", config.swarmWorkspaceDir, config.agentSwarmWorkspaceDir,
    "--chdir", config.agentWorkspaceDir,
    "--setenv", "HOME", "/home/pwuser",
    "--setenv", "USER", "pwuser",
    "--setenv", "LOGNAME", "pwuser"
  ];
  for (const directory of ["/home/pwuser/.codex", "/home/pwuser/.claude"]) {
    if (fs.existsSync(directory)) args.push("--bind", directory, directory);
  }
  for (const [source, destination] of credentialOverlays) {
    args.push("--ro-bind", source, destination);
  }
  args.push(
    "--",
    "setpriv",
    "--reuid", String(config.agentUid),
    "--regid", String(config.agentGid),
    "--clear-groups",
    "--no-new-privs",
    command.bin,
    ...command.argv
  );
  return { bin: "bwrap", argv: args };
}

function agentCommand(config, prompt) {
  const maxTurns = config.unlimited ? "" : String(config.swarm ? config.moves + 30 : config.moves + 10);

  if (config.model === "codex") {
    const sandboxMode = config.toolUse === "offline" ? "workspace-write" : "read-only";
    const commandRoot = config.agentWorkspaceDir;
    // --json streams structured events (agent messages, reasoning, shell calls)
    // on stdout so we can build a per-move reasoning log. `exec resume <id>`
    // continues a prior conversation (the model keeps its full memory).
    const argv = config.resume
      ? ["exec", "resume", config.resume, "--json", "--skip-git-repo-check"]
      : ["exec", "--json", "--skip-git-repo-check", "-C", commandRoot];
    // Ignore global behavioral config while retaining the provider's normal
    // auth/session store. All run policy arrives explicitly or from the
    // project-scoped worker profiles under this run's workspace.
    argv.push(
      "--ignore-user-config",
      "-c", 'approval_policy="never"',
      "-c", `sandbox_mode=${tomlString(sandboxMode)}`,
      "-c", "tools.web_search=false",
      "-c", "agents.max_depth=1",
      "-c", "sandbox_workspace_write.network_access=false",
      "-c", `sandbox_workspace_write.writable_roots=[${codexWritableRoots(config).map(tomlString).join(", ")}]`,
      ...codexAgentConfigArgs(config),
      ...codexMcpConfigArgs(config)
    );
    if (!config.resume) argv.push("--sandbox", sandboxMode);
    if (!config.resume && config.hostAccess && config.toolUse === "offline") {
      argv.push("--add-dir", ROOT_DIR);
    }
    argv.push(config.swarm ? "--enable" : "--disable", "multi_agent");
    // Ask Codex for fuller reasoning summaries (it emits `reasoning` items in
    // the JSON stream). Codex only ever exposes summaries — never raw
    // chain-of-thought — but "detailed" is richer than the terse default.
    argv.push("-c", 'model_reasoning_summary="detailed"');
    if (config.modelName) {
      argv.push("-m", config.modelName);
    }
    if (config.reasoning) {
      argv.push("-c", `model_reasoning_effort="${config.reasoning}"`);
    }
    if (config.codexFast) {
      // The "priority" service tier is Codex's Fast mode (~1.5x speed).
      argv.push("-c", 'service_tier="priority"');
    }
    argv.push(prompt);
    return { bin: config.codexBin, argv };
  }

  if (config.model === "claude") {
    // stream-json (requires --verbose in -p mode) emits the structured event
    // stream we parse into the reasoning log; --include-partial-messages adds the
    // text_delta/thinking_delta chunks that carry the actual reasoning (the
    // aggregated `thinking` blocks are withheld).
    const argv = [
      "-p", prompt,
      "--output-format", "stream-json", "--verbose", "--include-partial-messages"
    ];
    // Resume the prior conversation so the model keeps its full memory.
    if (config.resume) {
      argv.push("--resume", config.resume);
    }
    if (config.mcpEnabled) {
      const mcpTools = [
        "mcp__mazebench__maze_start",
        "mcp__mazebench__maze_observe",
        "mcp__mazebench__maze_action",
        "mcp__mazebench__maze_scorecard",
        "mcp__mazebench__maze_clone",
        "mcp__mazebench__maze_workers"
      ];
      const localTools = config.toolUse === "offline"
        ? ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit", "Skill", "TaskOutput", "TaskStop"]
        : ["Read", "Glob", "Grep"];
      // Claude Code has called this built-in both `Task` and `Agent` across
      // releases. Permit both names so the lead can delegate, while the
      // worker definition itself deliberately omits either tool.
      if (config.swarm) localTools.push("Task", "Agent");
      const enabledTools = config.toolUse === "offline"
        ? "default"
        : ["Read", "Glob", "Grep", "ToolSearch", ...(config.swarm ? ["Task", "Agent"] : [])].join(",");

      argv.push(
        "--mcp-config", claudeMcpConfig(config),
        "--strict-mcp-config",
        "--settings", claudeSandboxSettings(config),
        "--permission-mode", "dontAsk",
        "--tools", enabledTools,
        "--allowedTools", [...localTools, ...mcpTools].join(","),
        "--disallowedTools", [
          "WebFetch", "WebSearch",
          ...(config.toolUse === "read-only" ? ["Bash", "Edit", "Write", "NotebookEdit"] : []),
          ...(config.swarm ? [] : ["Task", "Agent"])
        ].join(","),
        "--add-dir", config.agentSwarmWorkspaceDir
      );
      if (config.hostAccess) argv.push("--add-dir", ROOT_DIR);
      const agents = claudeAgents(config);
      if (agents) argv.push("--agents", agents);
    } else if (config.tools) {
      argv.push("--permission-mode", "bypassPermissions");
    } else {
      // dontAsk auto-denies every tool not on the allowlist (no prompt, run
      // continues). Allow ONLY the maze helper — both the quoted form the
      // prompt uses and the bare form, since Bash patterns match the literal
      // command string. Claude blocks command chaining per-subcommand, so this
      // cannot be widened with `; other-cmd`. Vision also needs to read frames.
      const allow = config.claudeAllowedTools
        ? [config.claudeAllowedTools]
        : [`Bash(node "${HELPER}" *)`, `Bash(node ${HELPER} *)`];
      if (config.mode === "vision") {
        allow.push(`Read(${path.join(config.outDir, "frames")}/**)`);
      }
      argv.push("--permission-mode", "dontAsk", "--allowedTools", allow.join(","));
    }
    if (maxTurns) argv.push("--max-turns", maxTurns);
    if (config.modelName) {
      argv.push("--model", config.modelName);
    }
    // Claude Code's reasoning-effort knob (low|medium|high|xhigh|max).
    if (["low", "medium", "high", "xhigh", "max"].includes(config.reasoning)) {
      argv.push("--effort", config.reasoning);
    }
    return { bin: config.claudeBin, argv };
  }

  throw new Error(`Unknown model: ${config.model} (expected "codex" or "claude")`);
}

function ensureAgentAvailable(bin) {
  const probe = spawnSync("sh", ["-c", `command -v ${JSON.stringify(bin)}`], { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error(
      `Agent CLI not found on PATH: ${bin}\n` +
        `Install it (or pass ${bin === "codex" ? "codex_bin=" : "claude_bin="}<path>) and try again.`
    );
  }
}

function unwrapShellCommand(command) {
  let inner = String(command || "");
  const wrapped = inner.match(/-lc\s+'([\s\S]*)'\s*$/) || inner.match(/-lc\s+"([\s\S]*)"\s*$/);
  if (wrapped) inner = wrapped[1];
  return inner;
}

function splitShellCommands(command) {
  const input = unwrapShellCommand(command);
  const commands = [];
  let current = "";
  let quote = "";
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    const separatorLength = input.startsWith("&&", index) || input.startsWith("||", index) ? 2 : character === ";" ? 1 : 0;
    if (separatorLength) {
      if (current.trim()) commands.push(current.trim());
      current = "";
      index += separatorLength - 1;
      continue;
    }
    current += character;
  }

  if (current.trim()) commands.push(current.trim());
  return commands;
}

function actionsFromShellCommand(command) {
  return splitShellCommands(command).flatMap((inner) => {
    const match = inner.match(/\baction\s+--state\s+(?:"[^"]*"|'[^']*'|\S+)\s+([\s\S]+?)\s*$/);
    return match ? [match[1].trim().replace(/^["']|["']$/g, "")] : [];
  });
}

function actionFromShellCommand(command) {
  return actionsFromShellCommand(command)[0] || null;
}

function parsedToolInput(input) {
  if (input && typeof input === "object") return input;
  try {
    return JSON.parse(String(input || "{}"));
  } catch (_error) {
    return {};
  }
}

function actionsFromToolCall(name, input) {
  if (!/(?:^|__)maze_action$/.test(String(name || ""))) return [];
  const args = parsedToolInput(input);
  // Private worker explorations are intentionally absent from the lead run's
  // move counter, token chart, and reasoning feed.
  if (args.clone_id) return [];
  const action = String(args.action || "").trim();
  return action ? [action] : [];
}

function resultShape(status) {
  return {
    moved: status.moved,
    gems: status.gem_count,
    room: status.current_room,
    room_changed: Boolean(status.room_changed),
    player_dead: Boolean(status.player_dead)
  };
}

function resultsFromOutput(output) {
  const raw = String(output || "").trim();
  if (!raw) return [];
  const values = [];
  let start = -1;
  let depth = 0;
  let quote = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') {
      quote = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          values.push(resultShape(JSON.parse(raw.slice(start, index + 1))));
        } catch (_error) {
          /* skip non-status JSON */
        }
        start = -1;
      }
    }
  }

  return values;
}

function resultFromOutput(output) {
  return resultsFromOutput(output)[0] || {};
}

// Turn codex's --json event stream into a per-move reasoning log plus a
// human-readable transcript.
function distillCodexEvents(raw) {
  const entries = [];
  const transcript = [];
  let commentary = [];
  let move = 0;
  let finalMessage = "";

  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (_error) {
      continue;
    }
    if ((event.type || event.msg?.type) !== "item.completed") continue;
    const item = event.item || event.msg?.item;
    if (!item) continue;
    const kind = item.type || item.item_type;
    const timestamp = event._mazebench_received_at || event.timestamp || item.timestamp || null;

    if (kind === "reasoning" || kind === "agent_message") {
      const text = String(item.text || "").trim();
      if (!text) continue;
      commentary.push(text);
      finalMessage = text;
      transcript.push(`${kind === "reasoning" ? "[reasoning]" : "[agent]"} ${text}`);
    } else if (kind === "command_execution") {
      const command = String(item.command || "");
      const output = String(item.aggregated_output || "");
      transcript.push(`$ ${command}`);
      const actions = actionsFromShellCommand(command);
      if (actions.length) {
        const reasoning = commentary.join("\n\n").trim();
        const results = resultsFromOutput(output);
        const executed = results.length ? actions.slice(0, results.length) : actions;
        executed.forEach((action, index) => {
          move += 1;
          entries.push({ move, action, reasoning, timestamp, ...(results[index] || {}) });
        });
        commentary = [];
      }
    } else if (kind === "mcp_tool_call") {
      const name = item.tool || item.name || item.tool_name;
      const input = item.arguments || item.input || {};
      const actions = actionsFromToolCall(name, input);
      transcript.push(`[tool] ${name || "mcp"} ${JSON.stringify(input)}`);
      if (actions.length && item.status !== "failed" && !item.error) {
        const reasoning = commentary.join("\n\n").trim();
        const results = resultsFromOutput(toolResultText(item.result || item.output || item.content));
        actions.forEach((action, index) => {
          move += 1;
          entries.push({ move, action, reasoning, timestamp, ...(results[index] || {}) });
        });
        commentary = [];
      }
    }
  }

  return { entries, transcript: transcript.join("\n\n"), finalMessage };
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : String(part?.text || ""))).join("\n");
  }
  if (content && typeof content === "object") {
    if (content.content) return toolResultText(content.content);
    if (content.structuredContent) return JSON.stringify(content.structuredContent);
    return JSON.stringify(content);
  }
  return "";
}

// Turn Claude Code's --output-format stream-json events into the same per-move
// reasoning log. Reasoning comes from `text`/`thinking` content blocks; moves
// come from `tool_use` (Bash) blocks; results are matched by tool_use_id from
// the following `tool_result`.
function distillClaudeEvents(raw) {
  const entries = [];
  const transcript = [];
  const pending = new Map();
  let commentary = "";
  let move = 0;
  let finalMessage = "";

  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (_error) {
      continue;
    }

    // Reasoning arrives as streamed text/thinking deltas (--include-partial-messages).
    if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
      const delta = event.event.delta || {};
      if (delta.type === "text_delta" && delta.text) commentary += delta.text;
      else if (delta.type === "thinking_delta" && delta.thinking) commentary += delta.thinking;
      continue;
    }

    // Moves come from the aggregated assistant message's tool_use blocks.
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      const reasoning = commentary.trim();
      let hasActions = false;
      for (const block of event.message.content) {
        if (block.type !== "tool_use") continue;
        const command = block.name === "Bash" ? String(block.input?.command || "") : "";
        transcript.push(`$ ${command || block.name}`);
        const actions = command
          ? actionsFromShellCommand(command)
          : actionsFromToolCall(block.name, block.input);
        if (actions.length) {
          hasActions = true;
          if (reasoning) transcript.push(`[reasoning] ${reasoning}`);
          if (block.id) pending.set(block.id, {
            actions,
            reasoning,
            timestamp: event._mazebench_received_at || event.timestamp || null
          });
        }
      }
      if (hasActions) commentary = "";
    } else if (event.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === "tool_result" && pending.has(block.tool_use_id)) {
          const output = toolResultText(block.content);
          const batch = pending.get(block.tool_use_id);
          if (block.is_error) {
            if (output) transcript.push(`[tool error] ${output}`);
            pending.delete(block.tool_use_id);
            continue;
          }
          const results = resultsFromOutput(output);
          const executed = results.length ? batch.actions.slice(0, results.length) : batch.actions;
          const timestamp = event._mazebench_received_at || event.timestamp || batch.timestamp || null;
          executed.forEach((action, index) => {
            move += 1;
            entries.push({ move, action, reasoning: batch.reasoning, timestamp, ...(results[index] || {}) });
          });
          if (output) transcript.push(output.split("\n").slice(0, 3).join("\n"));
          pending.delete(block.tool_use_id);
        }
      }
    } else if (event.type === "result" && event.result) {
      finalMessage = String(event.result).trim();
    }
  }

  return { entries, transcript: transcript.join("\n\n"), finalMessage };
}

function writeReasoningArtifacts(config, raw, distilled, options = {}) {
  try {
    // When the caller already streamed agent-events.jsonl live, don't rewrite it.
    if (!options.skipEvents) {
      fs.writeFileSync(
        path.join(config.outDir, "agent-events.jsonl"),
        raw.endsWith("\n") ? raw : `${raw}\n`
      );
    }
    const { entries, transcript, finalMessage } = distilled;
    fs.writeFileSync(path.join(config.outDir, "reasoning.json"), `${JSON.stringify(entries, null, 2)}\n`);
    fs.writeFileSync(
      path.join(config.outDir, "agent.log"),
      `${transcript}${finalMessage ? `\n\n=== final summary ===\n${finalMessage}` : ""}\n`
    );

    console.log("\n=== Agent reasoning (per move) ===");
    for (const entry of entries) {
      const gist = String(entry.reasoning || "").replace(/\s+/g, " ").trim().slice(0, 110);
      const flags = [
        entry.moved === false ? "blocked" : null,
        entry.room_changed ? `→ ${entry.room}` : null,
        entry.gems != null ? `gems ${entry.gems}` : null
      ].filter(Boolean).join(", ");
      console.log(`  ${entry.move}. ${entry.action}${flags ? ` [${flags}]` : ""}${gist ? `\n     ↳ ${gist}` : ""}`);
    }
    if (entries.length === 0) {
      console.log("  (no maze actions detected in the event stream)");
    }
    console.log(`  full log: ${path.join(config.outDir, "reasoning.json")}`);
  } catch (error) {
    console.warn(`Could not capture reasoning log: ${error instanceof Error ? error.message : error}`);
  }
}

function providerFailureFromEvents(raw, provider) {
  const events = String(raw || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch (_error) {
        return [];
      }
    });

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (provider === "claude" && event.type === "result") {
      if (!event.is_error && !event.api_error_status) return null;
      return {
        provider,
        status: Number(event.api_error_status) || null,
        message: String(event.result || event.error || "Claude Code request failed.").trim().slice(0, 500)
      };
    }
    if (provider === "codex" && ["error", "turn.failed"].includes(event.type)) {
      return {
        provider,
        status: Number(event.status || event.status_code) || null,
        message: String(event.message || event.error?.message || event.error || "Codex request failed.").trim().slice(0, 500)
      };
    }
    if (provider === "codex" && ["turn.completed", "thread.started"].includes(event.type)) return null;
  }
  return null;
}

function runAgent(config, prompt) {
  const { bin, argv } = isolatedDockerAgentCommand(config, agentCommand(config, prompt));
  ensureAgentAvailable(bin);

  console.log(`\n=== Launching local ${config.model} agent (${bin}) ===`);
  console.log(`Session: ${config.sessionFile}`);
  console.log(
    `${config.hostAccess ? "Host access" : "Docker"} | Tool-use ${config.toolUse.toUpperCase()}${config.swarm ? " + SWARM" : ""} | ` +
      `Mode ${config.mode}${config.mode === "vision" ? ` (${config.visionWidth}x${config.visionHeight})` : ""} | ` +
      `Game ${config.gameId} | Level ${config.levelId} | view ${config.view} | yaw ${config.yaw} | budget ${config.unlimited ? "unlimited" : `${config.moves} moves`}\n`
  );

  // Both agents emit a structured JSONL event stream on stdout (codex --json /
  // claude --output-format stream-json). Append it to agent-events.jsonl AS IT
  // ARRIVES so the web UI can distill live per-move reasoning while the agent is
  // still playing. We use synchronous appends (not a buffered WriteStream) so
  // the on-disk file the web UI tails never lags behind — important for Codex,
  // whose events are sparse (one short message per move) and would otherwise
  // sit unflushed in a stream buffer until the very end.
  const distill = config.model === "codex" ? distillCodexEvents : distillClaudeEvents;
  const eventsPath = path.join(config.outDir, "agent-events.jsonl");
  // On a resume we keep the prior run's events and append the new turns, so the
  // reasoning feed shows the whole journey. A fresh run starts the file empty.
  if (!config.resume) {
    fs.writeFileSync(eventsPath, "");
  }
  fs.rmSync(path.join(config.outDir, "provider-failure.json"), { force: true });

  return new Promise((resolve) => {
    const env = { ...process.env };
    if (config.model === "claude" && config.mcpEnabled) {
      if (config.swarm && config.modelName) env.CLAUDE_CODE_SUBAGENT_MODEL = config.modelName;
    }
    const cwd = config.mcpEnabled ? config.workspaceDir : ROOT_DIR;
    const child = spawn(bin, argv, { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
    let raw = "";
    let eventBuffer = "";

    const appendTimedEvents = (text, flush = false) => {
      eventBuffer += text;
      const lines = eventBuffer.split("\n");
      eventBuffer = flush ? "" : lines.pop() || "";
      if (flush && lines.at(-1) === "") lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let output = line;
        try {
          const event = JSON.parse(line);
          event._mazebench_received_at = new Date().toISOString();
          output = JSON.stringify(event);
        } catch (_error) {
          /* preserve unexpected provider output verbatim */
        }
        fs.appendFileSync(eventsPath, `${output}\n`);
      }
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      raw += text;
      try {
        appendTimedEvents(text);
      } catch (_error) {
        /* best effort — the final write below still captures everything */
      }
    });
    child.on("error", (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      resolve({ code: null, failure: { provider: config.model, status: null, message: error.message } });
    });
    child.on("close", (code) => {
      try {
        appendTimedEvents("", true);
      } catch (_error) {
        /* best effort */
      }
      // On resume, distill the whole file (prior turns + the new ones) so the
      // feed keeps the earlier moves' reasoning too.
      let full = raw;
      if (config.resume) {
        try {
          full = fs.readFileSync(eventsPath, "utf8");
        } catch (_error) {
          full = raw;
        }
      }
      if (full.trim()) writeReasoningArtifacts(config, full, distill(full), { skipEvents: true });
      if (code !== 0) {
        console.warn(`\n(agent exited with status ${code}; continuing to export whatever it played)`);
      }
      resolve({ code, failure: providerFailureFromEvents(raw, config.model) });
    });
  });
}

function ensureScorecard(config) {
  if (!fs.existsSync(config.sessionFile)) {
    return false;
  }
  // Idempotent: writes scorecard.json even if the agent already did.
  const result = spawnSync(process.execPath, [HELPER, "scorecard", "--state", config.sessionFile], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    timeout: 30000,
    killSignal: "SIGKILL"
  });
  if (result.status !== 0) {
    console.warn(`Could not finalize scorecard: ${(result.stderr || "").trim()}`);
    return false;
  }
  return true;
}

function exportReplay(config) {
  const argv = [EXPORT_REPLAY, config.outDir];
  if (config.video) {
    if (config.fast) argv.push("--fast");
    if (config.draft) argv.push("--draft");
    if (config.width) argv.push("--width", String(config.width));
    if (config.height) argv.push("--height", String(config.height));
    if (config.fps) argv.push("--fps", String(config.fps));
  } else {
    argv.push("--no-video");
  }

  console.log(`\n=== Exporting artifacts${config.video ? " + replay video" : ""} ===`);
  const result = spawnSync(process.execPath, argv, { cwd: ROOT_DIR, stdio: "inherit" });
  if (result.status !== 0) {
    console.warn(
      "\nReplay export failed. The session JSON is still saved; you can retry with:\n" +
        `  node scripts/maze-export-replay.js ${config.outDir}`
    );
    return false;
  }
  return true;
}

function expandTilde(value) {
  const text = String(value || "");
  return text.startsWith("~") ? path.join(process.env.HOME || "", text.slice(1)) : text;
}

// Claude Code stores a subscription login in the macOS Keychain (service
// "Claude Code-credentials"), not a file. These read it so we can mount it.
function claudeKeychainAvailable() {
  if (process.platform !== "darwin") return false;
  const probe = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
    encoding: "utf8"
  });
  return probe.status === 0;
}

function extractClaudeKeychainCredential() {
  const result = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
    encoding: "utf8"
  });
  if (result.status !== 0) return null;
  const out = String(result.stdout || "").trim();
  return out.startsWith("{") ? out : null;
}

// Read the Codex model catalog (with per-model reasoning levels + fast-tier
// availability) that the Codex app caches on the host.
function loadCodexModels() {
  try {
    const cache = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME || "", ".codex", "models_cache.json"), "utf8")
    );
    return (Array.isArray(cache.models) ? cache.models : [])
      .filter((m) => m && (m.slug || m.id))
      .map((m) => ({
        slug: String(m.slug || m.id),
        displayName: String(m.display_name || m.slug || m.id),
        description: String(m.description || "").replace(/\s+/g, " ").slice(0, 56),
        defaultReasoning: String(m.default_reasoning_level || ""),
        reasoningLevels: Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels
              .filter((l) => l && l.effort)
              .map((l) => ({ effort: String(l.effort), description: String(l.description || "") }))
          : [],
        fast:
          (Array.isArray(m.additional_speed_tiers) && m.additional_speed_tiers.includes("fast")) ||
          (Array.isArray(m.service_tiers) &&
            m.service_tiers.some((t) => /fast|priority/i.test(String((t && (t.id || t.name)) || ""))))
      }));
  } catch (_error) {
    return [];
  }
}

// Re-exec this runner inside a container so the agent is fully isolated from the
// host filesystem: only the output directory is mounted, and credentials are
// passed by env. Everything else the agent could touch lives in the image.
function runInContainer(config, raw) {
  const hostOutputs = path.join(ROOT_DIR, "outputs", "maze-local");
  const cidFile = path.join(config.outDir, "container.cid");
  const agentStateDir = path.join(config.outDir, "agent-state");

  // Docker writes the exact container id here as soon as it creates the
  // container. The Agent backend uses it for real docker pause/unpause/stop
  // operations instead of merely freezing the attached docker client.
  fs.mkdirSync(config.outDir, { recursive: true });
  fs.rmSync(path.join(config.outDir, "cold-pause-capability.json"), { force: true });
  try {
    fs.unlinkSync(cidFile);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }

  // Forward the meaningful options to the in-container runner. Host-specific
  // path options (out/session) are intentionally dropped; the inner run writes
  // under the mounted /app/outputs/maze-local.
  const forwardKeys = [
    "model", "moves", "unlimited", "allow_quit", "mode", "tools", "tool_use", "swarm", "game", "level", "view", "yaw", "gems",
    "video", "no_video", "fast", "draft", "width", "height", "fps",
    "vision_width", "vision_height", "vision_view", "model_name", "llm",
    "reasoning", "effort", "codex_fast", "resume", "seed",
    "codex_bin", "claude_bin", "claude_allowed_tools"
  ];
  const inner = ["node", "scripts/maze-agent-local.js", "container=false"];
  for (const key of forwardKeys) {
    if (raw[key] !== undefined) inner.push(`${key}=${raw[key]}`);
  }
  // An explicit out dir inside the mounted outputs tree survives the re-exec:
  // rewrite it to the container-side path so callers (e.g. the web UI) can
  // tail a run directory they chose. Out dirs elsewhere are dropped as before.
  if (raw.out) {
    const hostOut = path.resolve(raw.out);
    const relative = path.relative(hostOutputs, hostOut);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      inner.push(`out=${path.posix.join("/app/outputs/maze-local", relative.split(path.sep).join("/"))}`);
    }
  }

  const dockerArgs = [
    "run", "--rm", "-i", "--cidfile", cidFile,
    "--user", "root",
    "--cap-drop", "ALL",
    "--cap-add", "SYS_ADMIN",
    "--cap-add", "SETUID",
    "--cap-add", "SETGID",
    "--cap-add", "CHOWN",
    "--cap-add", "DAC_OVERRIDE",
    "--security-opt", "seccomp=unconfined",
    "--security-opt", "apparmor=unconfined",
    "-e", "MAZEBENCH_IN_CONTAINER=1",
    "-v", `${hostOutputs}:/app/outputs/maze-local`
  ];
  // Keep only this run's CLI conversation transcript across disposable
  // containers. These are the provider-owned stores consumed by `codex exec
  // resume <id>` / `claude --resume <id>`, and persisting them avoids mounting
  // the user's global agent history or colliding with the nested auth mounts.
  if (config.model === "codex") {
    const codexSessions = path.join(agentStateDir, "codex", "sessions");
    fs.mkdirSync(codexSessions, { recursive: true });
    dockerArgs.push("-v", `${codexSessions}:/home/pwuser/.codex/sessions`);
  } else if (config.model === "claude") {
    const claudeProjects = path.join(agentStateDir, "claude", "projects");
    fs.mkdirSync(claudeProjects, { recursive: true });
    dockerArgs.push("-v", `${claudeProjects}:/home/pwuser/.claude/projects`);
  }
  // Draft/online worlds are not baked into the image — mount the game dir
  // read-only. Its images/assets_3d symlinks resolve against the in-image
  // /app/games/maze copy.
  if (config.gameId !== "maze") {
    const gameDir = path.join(ROOT_DIR, "games", config.gameId);
    if (!fs.existsSync(gameDir)) {
      console.error(`Game directory not found: ${gameDir}`);
      return 1;
    }
    dockerArgs.push("-v", `${gameDir}:/app/games/${config.gameId}:ro`);
  }
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    if (process.env[key]) dockerArgs.push("-e", key);
  }
  // Optional: mount ONLY the credential file (read-only) for subscription
  // logins. We deliberately do NOT mount the whole ~/.codex or ~/.claude, which
  // hold history, memories, logs, etc. — that would leak personal data into the
  // container and can be gigabytes.
  let codexAutoMounted = false;
  if (raw.codex_auth) {
    const p = path.resolve(expandTilde(raw.codex_auth));
    const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, "auth.json") : p;
    dockerArgs.push("-v", `${file}:/home/pwuser/.codex/auth.json:ro`);
  } else if (config.model === "codex" && !process.env.OPENAI_API_KEY) {
    // Auto: mount the Codex subscription login (~/.codex/auth.json) read-only when
    // no explicit credential is given, so `model=codex` just works.
    const authFile = path.join(process.env.HOME || "", ".codex", "auth.json");
    if (fs.existsSync(authFile)) {
      dockerArgs.push("-v", `${authFile}:/home/pwuser/.codex/auth.json:ro`);
      codexAutoMounted = true;
    }
  }
  if (raw.claude_auth) {
    const p = path.resolve(expandTilde(raw.claude_auth));
    const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, ".credentials.json") : p;
    dockerArgs.push("-v", `${file}:/home/pwuser/.claude/.credentials.json:ro`);
  }
  // Auto: a Claude Code subscription login lives in the macOS Keychain (no file
  // to mount), so materialize just that credential into a short-lived temp file
  // when no explicit Claude credential was supplied.
  let claudeCredTemp = null;
  if (
    config.model === "claude" &&
    !raw.claude_auth &&
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
    claudeKeychainAvailable()
  ) {
    claudeCredTemp = path.join("/tmp", `mazebench-claude-cred-${process.pid}.json`);
    dockerArgs.push("-v", `${claudeCredTemp}:/home/pwuser/.claude/.credentials.json:ro`);
  }
  dockerArgs.push(config.image, ...inner);

  if (isTruthy(raw.dry_run, false)) {
    console.log(`# would run in container (${config.image}):`);
    console.log([config.dockerBin, ...dockerArgs].join(" "));
    if (claudeCredTemp) {
      console.log("# (mounts your Claude Code subscription credential from the Keychain, read-only)");
    }
    console.log(`\n# host artifacts would appear under: ${hostOutputs}`);
    return 0;
  }

  const dockerProbe = spawnSync("sh", ["-c", `command -v ${JSON.stringify(config.dockerBin)}`], {
    encoding: "utf8"
  });
  if (dockerProbe.status !== 0) {
    console.error(
      `Container runtime not found: ${config.dockerBin}\n` +
        "Install Docker (or pass docker_bin=<path>, e.g. docker_bin=podman), or run on the\n" +
        "host with the CLI sandbox via container=false."
    );
    return 1;
  }
  fs.mkdirSync(hostOutputs, { recursive: true });

  // Stage the Keychain credential just before running, and remove it after.
  if (claudeCredTemp) {
    const cred = extractClaudeKeychainCredential();
    if (!cred) {
      console.error("Could not read your Claude Code credential from the Keychain.");
      return 1;
    }
    fs.writeFileSync(claudeCredTemp, cred, { mode: 0o600 });
  }

  console.log(`\n=== Running in container: ${config.image} ===`);
  console.log(`Host FS is isolated; only ${hostOutputs} is mounted (writable).`);
  const hasCred =
    process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN || raw.codex_auth || raw.claude_auth ||
    claudeCredTemp || codexAutoMounted;
  if (!hasCred) {
    console.warn(
      "Warning: the agent inside the container has no credentials. Set OPENAI_API_KEY " +
        "/ ANTHROPIC_API_KEY, or pass codex_auth=~/.codex (Codex) / claude_auth=<file> (Claude)."
    );
  }

  const result = spawnSync(config.dockerBin, dockerArgs, { cwd: ROOT_DIR, stdio: "inherit" });
  if (claudeCredTemp) {
    try {
      fs.unlinkSync(claudeCredTemp);
    } catch (_error) {
      /* best effort */
    }
  }
  if (result.error) {
    console.error(
      `\nFailed to launch container: ${result.error.message}\n` +
        `Is the image built? Run: docker build -t ${config.image} .  (or: npm run maze:build-image)`
    );
    return 1;
  }
  if (result.status !== 0) {
    console.error(
      `\nContainer exited with status ${result.status}. If the image is missing, build it:\n` +
        `  docker build -t ${config.image} .   (or: npm run maze:build-image)`
    );
  }
  return result.status || 0;
}

// Arrow-key single-select prompt (↑/↓ + Enter). Resolves to the chosen value.
function promptSelect(title, options) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY) {
      reject(new Error("interactive setup needs a terminal (TTY)"));
      return;
    }
    let index = 0;

    function render(first) {
      if (!first) stdout.write(`[${options.length + 1}A`);
      stdout.write("[0J");
      stdout.write(`? [1m${title}[0m\n`);
      options.forEach((option, i) => {
        const selected = i === index;
        const pointer = selected ? "[36m❯[0m" : " ";
        const label = selected ? `[36m${option.label}[0m` : option.label;
        const hint = option.hint ? ` [90m— ${option.hint}[0m` : "";
        stdout.write(`${pointer} ${label}${hint}\n`);
      });
    }

    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    render(true);

    function cleanup() {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    }

    function onData(key) {
      if (key === "") {
        cleanup();
        stdout.write("\n");
        process.exit(130);
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve(options[index].value);
      } else if (key === "[A" || key === "OA" || key === "k") {
        index = (index - 1 + options.length) % options.length;
        render(false);
      } else if (key === "[B" || key === "OB" || key === "j") {
        index = (index + 1) % options.length;
        render(false);
      }
    }

    stdin.on("data", onData);
  });
}

function promptText(title, defaultValue) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    rl.question(`? [1m${title}[0m${suffix}: `, (answer) => {
      rl.close();
      resolve(String(answer || "").trim() || defaultValue || "");
    });
  });
}

async function runWizard(raw) {
  const out = { ...raw };
  console.log("\n=== MazeBench setup ===");
  console.log("↑/↓ to move, Enter to select.\n");

  out.model = await promptSelect("Which agent?", [
    { label: "Codex CLI", value: "codex", hint: "uses your OpenAI/ChatGPT login" },
    { label: "Claude Code", value: "claude", hint: "uses your Claude subscription" }
  ]);

  const topModel = await promptSelect("Which model?", [
    { label: "Default", value: "__default__", hint: out.model === "claude" ? "subscription default" : "codex default" },
    { label: "Custom…", value: "__custom__", hint: "pick from the full list" }
  ]);
  let selectedModelInfo = null;
  delete out.model_name;
  if (topModel === "__custom__") {
    let modelInfos = [];
    let listOptions;
    if (out.model === "codex") {
      modelInfos = loadCodexModels();
      listOptions = modelInfos.map((m) => ({ label: m.displayName, value: m.slug, hint: m.description }));
    } else {
      listOptions = [
        { label: "Opus", value: "opus" },
        { label: "Sonnet", value: "sonnet" },
        { label: "Haiku", value: "haiku" }
      ];
    }
    listOptions.push({ label: "Type an id manually…", value: "__type__" });
    let picked = await promptSelect("Choose a model", listOptions);
    if (picked === "__type__") {
      picked = await promptText("Model id", out.model === "claude" ? "opus" : "gpt-5.5");
    } else if (out.model === "codex") {
      selectedModelInfo = modelInfos.find((m) => m.slug === picked) || null;
    }
    if (picked) out.model_name = picked;
  }

  // Codex-specific: reasoning effort, then Fast mode.
  if (out.model === "codex") {
    const levels = (selectedModelInfo && selectedModelInfo.reasoningLevels.length)
      ? selectedModelInfo.reasoningLevels.map((l) => ({ label: l.effort, value: l.effort, hint: l.description }))
      : [
          { label: "low", value: "low" },
          { label: "medium", value: "medium" },
          { label: "high", value: "high" },
          { label: "xhigh", value: "xhigh" }
        ];
    const effort = await promptSelect("Reasoning effort?", [
      { label: "Default", value: "", hint: selectedModelInfo && selectedModelInfo.defaultReasoning ? `model default (${selectedModelInfo.defaultReasoning})` : "model default" },
      ...levels
    ]);
    if (effort) out.reasoning = effort;
    else delete out.reasoning;

    if (!selectedModelInfo || selectedModelInfo.fast) {
      out.codex_fast = await promptSelect("Fast mode? (priority tier, ~1.5x speed)", [
        { label: "No", value: "false" },
        { label: "Yes", value: "true" }
      ]);
    }
  }

  let moves = await promptSelect("Action budget (moves)?", [
    { label: "5", value: "5" },
    { label: "10", value: "10" },
    { label: "20", value: "20" },
    { label: "50", value: "50" },
    { label: "Unlimited", value: "__unlimited__" },
    { label: "Custom…", value: "__custom__" }
  ]);
  if (moves === "__unlimited__") {
    out.unlimited = "true";
    moves = "500";
  }
  if (moves === "__custom__") moves = await promptText("Number of moves", "10");
  out.moves = moves;

  out.mode = await promptSelect("Observation mode?", [
    { label: "Text", value: "text", hint: "ASCII board" },
    { label: "Vision", value: "vision", hint: "rendered images (slower)" }
  ]);

  out.container = await promptSelect("Access?", [
    { label: "Container", value: "true", hint: "isolated from your files — recommended" },
    { label: "Host", value: "false", hint: "weaker isolation" }
  ]);

  out.tool_use = await promptSelect("Tool-use?", [
    { label: "Read only", value: "read-only", hint: "inspect files and explore maze clones" },
    { label: "Offline tools", value: "offline", hint: "write files and execute code; no network" }
  ]);

  out.swarm = await promptSelect("Orchestration?", [
    { label: "Single", value: "false", hint: "one lead agent" },
    { label: "Swarm", value: "true", hint: "lead controls identical-model workers" }
  ]);

  out.video = await promptSelect("Render replay video?", [
    { label: "Yes", value: "on" },
    { label: "No", value: "off" }
  ]);

  console.log("\n=== Summary ===");
  console.log(
    `  model=${out.model}` +
      `${out.model_name ? ` model_name=${out.model_name}` : ""}` +
      `${out.reasoning ? ` reasoning=${out.reasoning}` : ""}` +
      `${isTruthy(out.codex_fast, false) ? " fast=on" : ""}` +
      ` moves=${out.moves} mode=${out.mode} tool_use=${out.tool_use}` +
      ` swarm=${out.swarm} container=${out.container} video=${out.video}\n`
  );
  const proceed = await promptSelect("Proceed?", [
    { label: "Run it", value: "go" },
    { label: "Cancel", value: "cancel" }
  ]);
  if (proceed !== "go") {
    console.log("Cancelled.");
    process.exit(0);
  }
  console.log("");
  return out;
}

async function main() {
  const { raw: parsedRaw, passthrough } = parseArgs(process.argv.slice(2));
  let raw = parsedRaw;

  const wantWizard =
    isTruthy(raw.wizard, false) ||
    passthrough.includes("wizard") ||
    passthrough.includes("setup") ||
    (Object.keys(raw).length === 0 && passthrough.length === 0);
  if (wantWizard) {
    if (!process.stdin.isTTY) {
      console.error("The interactive setup needs a terminal. Pass parameters directly instead, e.g. model=codex moves=5.");
      process.exit(2);
    }
    raw = await runWizard(raw);
  }

  const model = String(raw.model || "").toLowerCase();

  if (!model || !["codex", "claude"].includes(model)) {
    console.error(
      "Usage: node scripts/maze-agent-local.js --model <codex|claude> [moves=N level=HxI ...]"
    );
    process.exit(2);
  }

  const view = VIEW_NAMES.includes(String(raw.view)) ? String(raw.view) : "top-diagonal";
  const outDir = raw.session
    ? path.dirname(path.resolve(raw.session))
    : path.resolve(raw.out || path.join(ROOT_DIR, "outputs", "maze-local", model, timestampSlug()));
  const sessionFile = raw.session ? path.resolve(raw.session) : path.join(outDir, "session.json");
  const inContainer = process.env.MAZEBENCH_IN_CONTAINER === "1";
  const wantsContainer = isTruthy(raw.container, true);
  const requestedToolUse = String(raw.tool_use || "").trim().toLowerCase();
  const toolUse = ["read-only", "offline"].includes(requestedToolUse)
    ? requestedToolUse
    : isTruthy(raw.tools, false)
      ? "offline"
      : "read-only";
  const swarm = isTruthy(raw.swarm, false);
  const unlimited = isTruthy(raw.unlimited, false);
  const hostAccess = !wantsContainer && !inContainer;
  const agentHomeStat = inContainer ? fs.statSync("/home/pwuser") : null;
  const workspaceDir = path.join(outDir, "workspace");
  const swarmDir = path.join(outDir, "swarm");
  const swarmWorkspaceDir = path.join(outDir, "swarm-workspaces");

  const config = {
    claudeBin: raw.claude_bin || "claude",
    claudeAllowedTools: raw.claude_allowed_tools || "",
    codexBin: raw.codex_bin || "codex",
    container: wantsContainer,
    dockerBin: raw.docker_bin || "docker",
    image: raw.image || "mazebench-agent",
    draft: isTruthy(raw.draft, false),
    fast: isTruthy(raw.fast, false),
    fps: raw.fps ? positiveInt(raw.fps, undefined) : undefined,
    gameId: normalizeGameId(raw.game),
    gems: positiveInt(raw.gems, 100),
    height: raw.height ? positiveInt(raw.height, undefined) : undefined,
    levelId: normalizeLevelId(raw.level),
    mode: String(raw.mode || raw.observation || "text").toLowerCase() === "vision" ? "vision" : "text",
    tools: toolUse !== "read-only",
    toolUse,
    swarm,
    hostAccess,
    inContainer,
    agentUid: agentHomeStat?.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    agentGid: agentHomeStat?.gid ?? (typeof process.getgid === "function" ? process.getgid() : 0),
    model,
    modelName: raw.model_name || raw.llm || "",
    reasoning: String(raw.reasoning || raw.effort || "").toLowerCase(),
    codexFast: isTruthy(raw.codex_fast, false),
    moves: unlimited ? null : positiveInt(raw.moves, 20),
    unlimited,
    allowQuit: isTruthy(raw.allow_quit, true),
    outDir,
    workspaceDir,
    swarmDir,
    swarmWorkspaceDir,
    agentWorkspaceDir: inContainer ? "/app/workspace" : workspaceDir,
    agentSwarmWorkspaceDir: inContainer ? "/app/swarm-workspaces" : swarmWorkspaceDir,
    // The outer Docker launcher re-execs before starting an agent. Actual host
    // and in-container agents both use MCP so maze persistence stays outside
    // their file/tool sandbox.
    mcpEnabled: !wantsContainer || inContainer,
    // Continue a prior run. seed=true means the session.json (action history) is
    // present in outDir so we resume the maze from it instead of starting fresh.
    // resume=<conversation-id> additionally resumes the CLI conversation so the
    // model keeps its full memory (a true continue). resume implies seed.
    resume: String(raw.resume || "").trim(),
    seed: isTruthy(raw.seed, false) || Boolean(String(raw.resume || "").trim()),
    sessionFile,
    video: isTruthy(raw.video, true) && !isTruthy(raw.no_video, false),
    view,
    visionHeight: positiveInt(raw.vision_height, 512),
    // 1-26 rings or "world"; empty = codex-play's default (1 = classic 3x3).
    visionView: String(raw.vision_view || "").trim().toLowerCase(),
    visionWidth: positiveInt(raw.vision_width, 512),
    width: raw.width ? positiveInt(raw.width, undefined) : undefined,
    yaw: ((positiveInt(raw.yaw, 0) % 4) + 4) % 4
  };

  // Default: isolate the whole run inside a container. `container=false` (or the
  // in-container re-exec, flagged by MAZEBENCH_IN_CONTAINER) runs on the host.
  if (config.container && !inContainer) {
    process.exit(runInContainer(config, raw));
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(path.join(outDir, "cold-pause-capability.json"), { force: true });
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  fs.mkdirSync(config.swarmDir, { recursive: true });
  fs.mkdirSync(config.swarmWorkspaceDir, { recursive: true });
  const privateMcp = config.inContainer ? await startPrivateMcpServer(config) : null;
  prepareAgentRuntime(config);

  const prompt = buildPrompt(config);

  if (isTruthy(raw.dry_run, false)) {
    const { bin, argv } = agentCommand(config, prompt);
    const shown = argv.map((arg) => (arg === prompt ? '"<prompt>"' : arg));
    console.log(`# would launch (${config.model}):`);
    console.log([bin, ...shown].join(" "));
    console.log(`# with <prompt>:\n${prompt}`);
    console.log(`\n# artifacts would land in: ${config.outDir}`);
    privateMcp?.stop();
    return;
  }

  try {
    const agentResult = await runAgent(config, prompt);
    if (agentResult?.failure || agentResult?.code !== 0) {
      const failure = agentResult.failure || {
        provider: config.model,
        status: null,
        message: `${config.model} exited with status ${agentResult?.code ?? "unknown"}.`
      };
      fs.writeFileSync(
        path.join(config.outDir, "provider-failure.json"),
        `${JSON.stringify({ ...failure, detected_at: new Date().toISOString() }, null, 2)}\n`
      );
      console.warn(`Provider unavailable; preserving the maze and provider thread for retry: ${failure.message}`);
      process.exitCode = 75;
      return;
    }
  } finally {
    privateMcp?.stop();
  }

  const finalized = ensureScorecard(config);
  if (!finalized) {
    console.error(
      `\nNo session was written at ${config.sessionFile}. The agent likely never ran the ` +
        "start command. Nothing to export."
    );
    process.exit(1);
  }

  // Signal the rendering phase so the web UI can show a replay progress bar
  // (maze-export-replay.js updates replay-progress.json as it works).
  if (config.video) {
    try {
      fs.writeFileSync(
        path.join(config.outDir, "replay-progress.json"),
        `${JSON.stringify({ phase: "starting", percent: 0 })}\n`
      );
    } catch (_error) {
      /* best effort */
    }
  }

  exportReplay(config);

  console.log("\n=== Done ===");
  console.log(`Run directory: ${config.outDir}`);
  console.log(`  session.json      full state + per-action replay`);
  console.log(`  actions.jsonl     per-turn action log`);
  console.log(`  scorecard.json    gems / rooms / actions`);
  console.log(`  maze_scorecard.json + maze_actions.txt`);
  console.log(`  reasoning.json    [{move, action, reasoning, ...}] per move`);
  console.log(`  agent.log         human-readable agent transcript`);
  console.log(`  agent-events.jsonl raw agent event stream`);
  if (config.video) {
    console.log(`  maze_replay.mp4   replay video`);
  }
}

module.exports = {
  actionFromShellCommand,
  actionsFromShellCommand,
  actionsFromToolCall,
  distillClaudeEvents,
  distillCodexEvents,
  loadCodexModels,
  providerFailureFromEvents,
  resultFromOutput,
  resultsFromOutput
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
