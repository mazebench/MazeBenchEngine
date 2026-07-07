const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { loadCodexModels } = require("../scripts/maze-agent-local");

// GUI-launched servers (editors, preview harnesses) often get a minimal PATH
// that misses the dirs where codex/claude/docker/prime live. Enrich the PATH
// for child processes with the running Node's own bin dir (which is where
// npm-global CLIs like claude land) plus the usual install locations.
function enrichedPathEnv() {
  const extra = [
    path.dirname(fs.realpathSync(process.execPath)),
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
  const current = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const merged = [...current];

  extra.forEach((dir) => {
    if (!merged.includes(dir) && fs.existsSync(dir)) {
      merged.push(dir);
    }
  });

  return { ...process.env, PATH: merged.join(path.delimiter) };
}

// Agent Mode backend: launches scripts/maze-agent-local.js (Codex CLI / Claude
// Code) or `prime eval run` as detached child processes, one directory per run
// under outputs/maze-local/site/. The runner writes actions.jsonl + session.json
// into that directory as the agent plays, so progress endpoints just read files
// — no state beyond run.json survives a server restart, and none is needed.

const VIEW_NAMES = ["top", "top-diagonal", "diagonal", "side-diagonal", "side"];
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{4,80}$/i;
const SERVABLE_RUN_FILES = new Set([
  "run.json",
  "launcher.log",
  "session.json",
  "actions.jsonl",
  "reasoning.json",
  "agent.log",
  "agent-events.jsonl",
  "scorecard.json",
  "maze_scorecard.json",
  "maze_actions.txt",
  "maze_replay.mp4"
]);

function createAgentRunService({
  agentEnvironment,
  ensureDirectory,
  getGame,
  buildWorlds,
  loadJson,
  rootDir,
  worldMaps
}) {
  const runsDir = path.join(rootDir, "outputs", "maze-local", "site");
  const runnerScript = path.join(rootDir, "scripts", "maze-agent-local.js");
  const liveChildren = new Map();

  // Container mode needs Docker installed AND its daemon running. Prefer the
  // shared (cached) environment probe; fall back to a direct check otherwise.
  function dockerAvailable() {
    if (typeof agentEnvironment === "function") {
      return Boolean(agentEnvironment().docker);
    }

    if (spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8", env: enrichedPathEnv() }).status !== 0) {
      return false;
    }

    const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 8000
    });
    const version = String(info.stdout || "").trim();
    return info.status === 0 && version.length > 0 && version !== "<no value>";
  }

  function dockerInstalled() {
    if (typeof agentEnvironment === "function") {
      return Boolean(agentEnvironment().docker_installed);
    }

    return spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8", env: enrichedPathEnv() }).status === 0;
  }

  function timestampSlug() {
    return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  }

  function generateRunId() {
    return `${timestampSlug()}-${crypto.randomBytes(3).toString("hex")}`;
  }

  function runDirFor(runId) {
    if (!RUN_ID_PATTERN.test(String(runId || ""))) {
      throw new Error(`Invalid run id "${runId}".`);
    }

    return path.join(runsDir, runId);
  }

  function runMetaPath(runId) {
    return path.join(runDirFor(runId), "run.json");
  }

  function readRunMeta(runId) {
    return loadJson(runMetaPath(runId), null);
  }

  function writeRunMeta(runId, meta) {
    fs.writeFileSync(runMetaPath(runId), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }

  function pidAlive(pid) {
    if (!pid) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  function finalizeStatus(runId, meta) {
    if (!meta || meta.status !== "running" || pidAlive(meta.pid) || liveChildren.has(runId)) {
      return meta;
    }

    // The process is gone but no exit handler fired (server restarted).
    const succeeded =
      fs.existsSync(path.join(runDirFor(runId), "maze_scorecard.json")) ||
      fs.existsSync(path.join(runDirFor(runId), "scorecard.json"));
    const updated = {
      ...meta,
      status: succeeded ? "finished" : "failed",
      finished_at: meta.finished_at || new Date().toISOString()
    };
    writeRunMeta(runId, updated);
    return updated;
  }

  function readActions(runId, afterTurn = 0) {
    const actionsPath = path.join(runDirFor(runId), "actions.jsonl");

    if (!fs.existsSync(actionsPath)) {
      return [];
    }

    return fs
      .readFileSync(actionsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          return null;
        }
      })
      .filter((record) => record && Number(record.turn) > afterTurn)
      .map((record) => ({
        turn: record.turn,
        command_text: record.command_text,
        moved: record.status?.moved,
        gem_count: record.status?.gem_count,
        current_room: record.status?.current_room,
        player: record.status?.player || null,
        player_dead: Boolean(record.status?.player_dead),
        solved: Boolean(record.status?.solved),
        level: record.status?.level || null
      }));
  }

  function readLogChunk(runId, offset = 0) {
    const logPath = path.join(runDirFor(runId), "launcher.log");

    if (!fs.existsSync(logPath)) {
      return { chunk: "", offset: 0 };
    }

    const size = fs.statSync(logPath).size;
    const start = Math.max(0, Math.min(Number(offset) || 0, size));

    if (start >= size) {
      return { chunk: "", offset: size };
    }

    const fd = fs.openSync(logPath, "r");

    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return { chunk: buffer.toString("utf8"), offset: size };
    } finally {
      fs.closeSync(fd);
    }
  }

  function summarizeRun(runId) {
    const meta = finalizeStatus(runId, readRunMeta(runId));

    if (!meta) {
      return null;
    }

    const actions = readActions(runId);
    const last = actions[actions.length - 1] || null;
    const runDir = runDirFor(runId);

    return {
      ...meta,
      turns: actions.length,
      gem_count: last ? last.gem_count : 0,
      current_room: last ? last.current_room : meta.level_id,
      solved: Boolean(last && last.solved),
      has_video: fs.existsSync(path.join(runDir, "maze_replay.mp4")),
      has_reasoning: fs.existsSync(path.join(runDir, "reasoning.json")),
      url: `/agent/runs/${encodeURIComponent(runId)}`
    };
  }

  function listRuns() {
    if (!fs.existsSync(runsDir)) {
      return [];
    }

    return fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .map((entry) => summarizeRun(entry.name))
      .filter(Boolean)
      .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
  }

  function getRunProgress(runId, { afterTurn = 0, logOffset = 0 } = {}) {
    const summary = summarizeRun(runId);

    if (!summary) {
      return null;
    }

    const log = readLogChunk(runId, logOffset);
    const runDir = runDirFor(runId);
    const reasoning =
      summary.status !== "running" && fs.existsSync(path.join(runDir, "reasoning.json"))
        ? loadJson(path.join(runDir, "reasoning.json"), [])
        : null;

    return {
      run: summary,
      actions: readActions(runId, Number(afterTurn) || 0),
      log_chunk: log.chunk,
      log_offset: log.offset,
      reasoning
    };
  }

  // ---- provider model catalogs ------------------------------------------
  // codex: the Codex app caches its model catalog on disk (rich metadata:
  //        display names, reasoning levels, fast tier availability).
  // claude: no local catalog exists; the CLI accepts the alias set.
  // prime: `prime inference models --output json` (needs `prime login`);
  //        results are cached and errors surface as a hint instead of a 500.
  const providerModelCache = new Map();
  const PROVIDER_MODEL_TTL_MS = 10 * 60 * 1000;
  const PROVIDER_MODEL_ERROR_TTL_MS = 60 * 1000;

  function codexModelCatalog() {
    const models = loadCodexModels().map((model) => ({
      id: model.slug,
      label: model.displayName,
      description: model.description,
      reasoning_levels: model.reasoningLevels.map((level) => level.effort),
      default_reasoning: model.defaultReasoning,
      fast: Boolean(model.fast)
    }));

    return {
      models,
      // The Codex app orders its catalog strongest-first.
      default_model_id: models[0]?.id || "",
      note: models.length
        ? ""
        : "No Codex model cache found (~/.codex/models_cache.json) — run the Codex app once, or type a model id."
    };
  }

  function claudeModelCatalog() {
    return {
      models: [
        { id: "opus", label: "Opus", description: "Most capable" },
        { id: "sonnet", label: "Sonnet", description: "Balanced speed and smarts" },
        { id: "haiku", label: "Haiku", description: "Fastest" }
      ],
      default_model_id: "opus",
      note: ""
    };
  }

  function primeModelCatalog() {
    const result = spawnSync("prime", ["--plain", "inference", "models", "--output", "json"], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024
    });

    if (result.error && result.error.code === "ENOENT") {
      return {
        models: [],
        note: "The `prime` CLI is not installed — type a model id (e.g. openai/gpt-5-nano), or install it from docs.primeintellect.ai."
      };
    }

    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim().split("\n")[0];
      const authProblem = /401|token|login|unauthorized/i.test(detail);

      return {
        models: [],
        note: authProblem
          ? "Prime is not logged in — run `prime login` in a terminal, then reopen this page. You can still type a model id (e.g. openai/gpt-5-nano)."
          : `Could not load the Prime model catalog (${detail || "unknown error"}). Type a model id instead.`
      };
    }

    try {
      const payload = JSON.parse(String(result.stdout || "{}"));
      const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
      const models = rows
        .map((row) => {
          const id = String(row.id || "");
          const slash = id.indexOf("/");

          return {
            id,
            label: slash === -1 ? id : id.slice(slash + 1),
            description: "",
            group: slash === -1 ? "other" : id.slice(0, slash)
          };
        })
        .filter((model) => model.id);

      return {
        models,
        default_model_id: models[0]?.id || "",
        note: models.length ? "" : "The Prime catalog came back empty — type a model id instead."
      };
    } catch (error) {
      return { models: [], note: "Could not parse the Prime model catalog — type a model id instead." };
    }
  }

  function listProviderModels(provider) {
    const normalized = String(provider || "").toLowerCase();

    if (!["codex", "claude", "prime"].includes(normalized)) {
      throw new Error(`Unknown provider "${provider}".`);
    }

    const cached = providerModelCache.get(normalized);

    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }

    const value =
      normalized === "codex"
        ? codexModelCatalog()
        : normalized === "claude"
          ? claudeModelCatalog()
          : primeModelCatalog();
    const ttl = value.models.length ? PROVIDER_MODEL_TTL_MS : PROVIDER_MODEL_ERROR_TTL_MS;

    providerModelCache.set(normalized, { value, expiresAt: Date.now() + ttl });
    return value;
  }

  function normalizedGameForRun(gameId) {
    const game = getGame(String(gameId || "maze"));

    if (!game || !game.worldMap) {
      throw new Error(`"${gameId}" is not a runnable world.`);
    }

    return game;
  }

  function buildLocalRunArgs(runId, params, game) {
    const model = String(params.model || "").toLowerCase();

    if (!["codex", "claude"].includes(model)) {
      throw new Error('model must be "codex" or "claude".');
    }

    const levelId = String(params.level_id || worldMaps.defaultLevelIdForGame(game));

    if (!worldMaps.isMazeWorldLevelId(game.id, levelId)) {
      throw new Error(`"${levelId}" is not a level of ${game.name}.`);
    }

    const moves = Math.max(1, Math.min(500, Number(params.moves) || 20));
    const gems =
      game.id === "maze"
        ? Math.max(1, Math.min(1000, Number(params.gems) || 100))
        : Math.max(1, buildWorlds.countWorldGems(game) || 1);
    const view = VIEW_NAMES.includes(String(params.view)) ? String(params.view) : "top-diagonal";
    const wantContainer = !(params.container === false || params.container === "false");

    // Safety net for the UI toggle: container mode needs Docker installed AND
    // its daemon running.
    if (wantContainer && !dockerAvailable()) {
      throw new Error(
        dockerInstalled()
          ? "Container mode needs the Docker daemon running. Start Docker, or turn off the Container toggle to run on the host sandbox."
          : "Container mode needs Docker, which is not installed. Turn off the Container toggle to run on the host sandbox, or install Docker."
      );
    }
    const args = [
      `model=${model}`,
      `game=${game.id}`,
      `level=${levelId}`,
      `moves=${moves}`,
      `gems=${gems}`,
      `view=${view}`,
      `mode=${String(params.mode) === "vision" ? "vision" : "text"}`,
      `tools=${params.tools === true || params.tools === "true" ? "true" : "false"}`,
      `container=${params.container === false || params.container === "false" ? "false" : "true"}`,
      `video=${params.video === false || params.video === "false" ? "off" : "on"}`,
      `out=${runDirFor(runId)}`
    ];

    if (params.model_name) {
      args.push(`model_name=${String(params.model_name)}`);
    }

    if (params.reasoning) {
      args.push(`reasoning=${String(params.reasoning)}`);
    }

    if (params.codex_fast === true || params.codex_fast === "true") {
      args.push("codex_fast=true");
    }

    if (params.fast === true || params.fast === "true") {
      args.push("fast=true");
    }

    if (params.draft === true || params.draft === "true") {
      args.push("draft=true");
    }

    return { args, model, levelId, moves, gems, view };
  }

  function buildPrimeCommand(params) {
    const model = String(params.model_name || params.model || "").trim();
    const n = Math.max(1, Math.min(50, Number(params.n) || 1));
    const r = Math.max(1, Math.min(10, Number(params.r) || 1));
    const maxTurns = Math.max(1, Math.min(200, Number(params.max_turns) || 8));
    const argv = ["eval", "run", "mazebench"];

    if (model) {
      argv.push("-m", model);
    }

    argv.push("-n", String(n), "-r", String(r), "-s", "--max-turns", String(maxTurns), "-d");
    return { bin: "prime", argv, model, n, r, maxTurns };
  }

  function launchRun(params = {}) {
    const kind = String(params.kind || "local");
    const runId = generateRunId();
    const runDir = runDirFor(runId);

    ensureDirectory(runDir);

    const logPath = path.join(runDir, "launcher.log");
    const logFd = fs.openSync(logPath, "a");
    let child = null;
    let meta = null;

    try {
      if (kind === "prime") {
        const command = buildPrimeCommand(params);

        child = spawn(command.bin, command.argv, {
          cwd: rootDir,
          detached: true,
          env: enrichedPathEnv(),
          stdio: ["ignore", logFd, logFd]
        });
        meta = {
          id: runId,
          kind,
          created_at: new Date().toISOString(),
          status: "running",
          pid: child.pid,
          command: [command.bin, ...command.argv].join(" "),
          model: "prime",
          model_name: command.model || "(prime default)",
          game_id: "maze",
          game_title: "Maze (master)",
          level_id: "level_HxI",
          moves: command.maxTurns,
          mode: "text",
          note: "Prime Verifiers run — artifacts land under environments/mazebench/outputs/evals/."
        };
      } else {
        const game = normalizedGameForRun(params.game_id);
        const { args, model, levelId, moves, gems, view } = buildLocalRunArgs(runId, params, game);

        child = spawn(process.execPath, [runnerScript, ...args], {
          cwd: rootDir,
          detached: true,
          env: enrichedPathEnv(),
          stdio: ["ignore", logFd, logFd]
        });
        meta = {
          id: runId,
          kind: "local",
          created_at: new Date().toISOString(),
          status: "running",
          pid: child.pid,
          command: ["node", "scripts/maze-agent-local.js", ...args].join(" "),
          model,
          model_name: params.model_name || "",
          reasoning: params.reasoning || "",
          game_id: game.id,
          game_title: game.name,
          level_id: levelId,
          moves,
          gems,
          view,
          mode: String(params.mode) === "vision" ? "vision" : "text",
          tools: params.tools === true || params.tools === "true",
          container: !(params.container === false || params.container === "false"),
          video: !(params.video === false || params.video === "false")
        };
      }
    } catch (error) {
      fs.closeSync(logFd);
      fs.rmSync(runDir, { recursive: true, force: true });
      throw error;
    }

    child.unref();
    fs.closeSync(logFd);
    liveChildren.set(runId, child);
    child.on("exit", (code) => {
      liveChildren.delete(runId);
      const current = readRunMeta(runId);

      if (current) {
        writeRunMeta(runId, {
          ...current,
          status: code === 0 ? "finished" : current.status === "stopping" ? "stopped" : "failed",
          exit_code: code,
          finished_at: new Date().toISOString()
        });
      }
    });
    child.on("error", () => {
      liveChildren.delete(runId);
    });

    writeRunMeta(runId, meta);
    return summarizeRun(runId);
  }

  function stopRun(runId) {
    const meta = readRunMeta(runId);

    if (!meta) {
      throw new Error(`Unknown run "${runId}".`);
    }

    if (meta.status !== "running") {
      return summarizeRun(runId);
    }

    writeRunMeta(runId, { ...meta, status: "stopping" });

    try {
      // The runner was spawned detached (its own process group), so a negative
      // pid signals the whole group — including docker/agent children.
      process.kill(-meta.pid, "SIGTERM");
    } catch (error) {
      try {
        process.kill(meta.pid, "SIGTERM");
      } catch (innerError) {
        /* already gone */
      }
    }

    return summarizeRun(runId);
  }

  function resolveRunFilePath(runId, fileName) {
    const runDir = runDirFor(runId);
    const isFrame = /^frames\/frame-\d+\.png$/.test(fileName);

    if (!SERVABLE_RUN_FILES.has(fileName) && !isFrame) {
      return null;
    }

    const filePath = path.join(runDir, ...fileName.split("/"));
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : null;
  }

  return {
    getRunProgress,
    launchRun,
    listProviderModels,
    listRuns,
    resolveRunFilePath,
    stopRun,
    summarizeRun
  };
}

module.exports = {
  createAgentRunService,
  enrichedPathEnv
};
