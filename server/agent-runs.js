const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const {
  distillClaudeEvents,
  distillCodexEvents,
  loadCodexModels
} = require("../scripts/maze-agent-local");

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
  const primeRunnerScript = path.join(rootDir, "scripts", "maze-prime-run.js");
  const renderFrameScript = path.join(rootDir, "scripts", "maze-render-frame.js");
  const liveChildren = new Map();
  const liveFrameLocks = new Map();

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

  function getEnvironment(options = {}) {
    return typeof agentEnvironment === "function" ? agentEnvironment(options) : {};
  }

  // Launch the Docker daemon when it is installed but stopped. The daemon takes
  // ~30-60s to become reachable, so this only kicks off the launch; the client
  // polls the environment until docker_running flips true.
  function startDocker() {
    if (dockerAvailable()) {
      return { started: true, running: true, message: "Docker is already running." };
    }

    if (!dockerInstalled()) {
      throw new Error("Docker is not installed.");
    }

    const spawnDetached = (bin, args) => {
      const child = spawn(bin, args, { detached: true, stdio: "ignore", env: enrichedPathEnv() });
      child.on("error", () => {});
      child.unref();
    };

    if (process.platform === "darwin") {
      const app = process.env.MAZEBENCH_DOCKER_APP || "Docker";
      spawnDetached("open", ["-a", app]);
      return { started: true, running: false, message: `Starting ${app}… this can take up to a minute.` };
    }

    if (process.platform === "win32") {
      spawnDetached("cmd", ["/c", "start", "", "Docker Desktop"]);
      return { started: true, running: false, message: "Starting Docker Desktop… this can take up to a minute." };
    }

    // Linux: the daemon is usually a privileged system service we should not
    // guess at (systemctl needs sudo; Docker Desktop is a user service).
    return {
      started: false,
      running: false,
      message: "Start Docker manually (e.g. `systemctl start docker` or launch Docker Desktop), then reload."
    };
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

  // Per-move reasoning, live. reasoning.json exists only once the run finishes;
  // while it runs we distill the streamed agent-events.jsonl on the fly so the
  // web UI shows each move's thoughts as they arrive.
  function readReasoning(runId, model) {
    const runDir = runDirFor(runId);
    const finalPath = path.join(runDir, "reasoning.json");

    if (fs.existsSync(finalPath)) {
      return loadJson(finalPath, []);
    }

    const eventsPath = path.join(runDir, "agent-events.jsonl");

    if (!fs.existsSync(eventsPath)) {
      return [];
    }

    try {
      const raw = fs.readFileSync(eventsPath, "utf8");
      const distilled = model === "claude" ? distillClaudeEvents(raw) : distillCodexEvents(raw);
      return distilled.entries || [];
    } catch (error) {
      return [];
    }
  }

  // The rendered image the human watches: in vision mode the agent's own frames
  // (frames/frame-NNN.png) already exist; in text mode the run page asks the
  // frame endpoint to render one on demand.
  function latestVisionFrame(runId) {
    const framesDir = path.join(runDirFor(runId), "frames");

    if (!fs.existsSync(framesDir)) {
      return null;
    }

    const frames = fs
      .readdirSync(framesDir)
      .filter((name) => /^frame-\d+\.png$/.test(name))
      .sort();
    const latest = frames[frames.length - 1];
    return latest ? `/agent-runs/${encodeURIComponent(runId)}/files/frames/${latest}` : null;
  }

  function readReplayProgress(runId) {
    return loadJson(path.join(runDirFor(runId), "replay-progress.json"), null);
  }

  function canonicalActionText(message) {
    if (!message || typeof message !== "object") {
      return "";
    }

    if (message.command === "move") return String(message.direction || "");
    if (message.command === "rotate_camera") return `rotate camera ${message.direction}`;
    if (message.command === "goto_level") return `go to level ${message.x} ${message.y}`;
    if (message.command === "reset_level") return "reset";
    return String(message.command || "");
  }

  // Render a maze image for the human watching a text-mode run (vision runs
  // already have real frames). Replays the first `turn` actions through the same
  // headless renderer the vision taskset uses, caches the PNG, and returns its
  // url. One render per run at a time — booting a browser is heavy.
  async function renderLiveFrame(runId, turn) {
    const runDir = runDirFor(runId);
    const framesDir = path.join(runDir, "frames");
    const fileName = `live-${String(turn).padStart(3, "0")}.png`;
    const target = path.join(framesDir, fileName);
    const url = `/agent-runs/${encodeURIComponent(runId)}/files/frames/${fileName}`;

    if (fs.existsSync(target)) {
      return { url, cached: true };
    }

    if (liveFrameLocks.has(runId)) {
      return { url: null, pending: true };
    }

    const session = loadJson(path.join(runDir, "session.json"), null);

    if (!session) {
      return { url: null, error: "The run has not started playing yet." };
    }

    const actions = (session.actions || [])
      .slice(0, Number(turn) || 0)
      .map((action) => canonicalActionText(action.message))
      .filter(Boolean);
    const payload = {
      actions,
      draft: true,
      fast: true,
      gameId: session.gameId || "maze",
      levelId: session.levelId || "level_HxI",
      width: 640,
      height: 640,
      yaw: session.yaw || 0
    };

    const lock = new Promise((resolve) => {
      const child = spawn(process.execPath, [renderFrameScript], {
        cwd: rootDir,
        env: enrichedPathEnv()
      });
      let out = "";
      let err = "";

      child.stdout.on("data", (chunk) => {
        out += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        err += chunk.toString();
      });
      child.on("error", () => resolve({ url: null, error: "Could not start the frame renderer." }));
      child.on("close", (code) => {
        if (code !== 0) {
          resolve({ url: null, error: err.trim().split("\n")[0] || "The frame renderer failed." });
          return;
        }

        try {
          const parsed = JSON.parse(out);
          const dataUrl = String(parsed.data_url || "");
          const prefix = "data:image/png;base64,";

          if (!dataUrl.startsWith(prefix)) {
            resolve({ url: null, error: "The renderer returned no image." });
            return;
          }

          fs.mkdirSync(framesDir, { recursive: true });
          fs.writeFileSync(target, Buffer.from(dataUrl.slice(prefix.length), "base64"));
          resolve({ url });
        } catch (error) {
          resolve({ url: null, error: "The renderer returned an unreadable frame." });
        }
      });
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });

    liveFrameLocks.set(runId, lock);

    try {
      return await lock;
    } finally {
      liveFrameLocks.delete(runId);
    }
  }

  function getRunProgress(runId, { afterTurn = 0, logOffset = 0 } = {}) {
    const summary = summarizeRun(runId);

    if (!summary) {
      return null;
    }

    const log = readLogChunk(runId, logOffset);

    return {
      run: summary,
      actions: readActions(runId, Number(afterTurn) || 0),
      log_chunk: log.chunk,
      log_offset: log.offset,
      reasoning: readReasoning(runId, summary.model),
      vision_frame_url: summary.mode === "vision" ? latestVisionFrame(runId) : null,
      replay_progress: summary.has_video ? { phase: "done", percent: 100 } : readReplayProgress(runId)
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
    // Claude Code publishes no machine-readable catalog (unlike Codex's
    // ~/.codex/models_cache.json), so these are the tier aliases its `--model`
    // flag accepts — each resolves to the latest model in that tier. Any full
    // model id also works via the Custom… box. Ordered strongest-first.
    return {
      models: [
        { id: "fable", label: "Fable", description: "Most capable — Claude 5 / Mythos tier" },
        { id: "opus", label: "Opus", description: "High capability" },
        { id: "sonnet", label: "Sonnet", description: "Balanced speed and smarts" },
        { id: "haiku", label: "Haiku", description: "Fastest" }
      ],
      default_model_id: "fable",
      // Claude Code's `claude --effort <level>` accepts these (verified from the
      // CLI); it's provider-wide, not per model.
      reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
      reasoning_default: "",
      note: "Aliases — each maps to the latest model in its tier. Use Custom… for a full model id."
    };
  }

  // Prime's model list (OpenAI-style /models) exposes no modality field, so we
  // infer image-input support from the model id: an allowlist of known
  // multimodal families, with text-only variants (…-mini reasoning models,
  // audio-only endpoints) carved back out. Unknown ids default to text-only so
  // the UI never offers vision to a model that can't read images.
  function primeModelVision(id) {
    const slug = String(id || "").toLowerCase();

    // Text-only variants that would otherwise match a multimodal family below.
    if (/(^|\/)(o1|o3|o4)-mini/.test(slug)) return false;
    if (/gpt-4o-mini-(tts|audio|transcribe|realtime|search)/.test(slug)) return false;
    if (/gpt-4o-(audio|realtime|transcribe|tts)/.test(slug)) return false;

    const visionFamilies = [
      /gpt-4o/,
      /gpt-4\.1/,
      /gpt-4-turbo/,
      /gpt-4-vision/,
      /chatgpt-4o/,
      /gpt-5/,
      /(^|\/)o1(\b|-)/,
      /(^|\/)o3(\b|-)/,
      /(^|\/)o4(\b|-)/,
      /claude-3/,
      /claude-(opus|sonnet|haiku|fable)-\d/,
      /gemini/,
      /-vl(\b|-)/,
      /qwen.*-vl/,
      /qwen2\.5-omni/,
      /llava/,
      /pixtral/,
      /llama-3\.2-(11|90)b/,
      /llama-4/,
      /internvl/,
      /deepseek-vl/,
      /molmo/,
      /phi-3-vision/,
      /phi-4-multimodal/,
      /mistral-small-3/,
      /grok-4/,
      /grok-2-vision/,
      /grok-vision/
    ];

    return visionFamilies.some((pattern) => pattern.test(slug));
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
            group: slash === -1 ? "other" : id.slice(0, slash),
            vision: primeModelVision(id)
          };
        })
        .filter((model) => model.id);

      return {
        models,
        default_model_id: models[0]?.id || "",
        note: models.length
          ? "Image-input support is inferred from the model id; text-only models can't be run in Vision mode."
          : "The Prime catalog came back empty — type a model id instead."
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

  // Prime runs go through scripts/maze-prime-run.js, which runs the v1 taskset
  // via `uv run eval` and then renders a replay video + move feed from the eval
  // results (see that script). We fix examples/rollouts at 1 — a Prime run here
  // is "one maze, make N moves, stop" — so the only knob is the turn budget
  // (plus an optional vision/image-input mode for models that accept images).
  function buildPrimeCommand(params, runDir) {
    const model = String(params.model_name || params.model || "").trim();
    const maxTurns = Math.max(1, Math.min(500, Number(params.max_turns) || 20));
    const vision = params.vision === true || params.vision === "true";
    const wantVideo = !(params.video === false || params.video === "false");
    // Reasoning effort → --sampling.reasoning-effort. OpenAI reasoning models and
    // Claude (extended thinking) honor it; others ignore it. "" = don't send one.
    const reasoning = ["low", "medium", "high"].includes(String(params.reasoning))
      ? String(params.reasoning)
      : "";
    const envDir = path.join(rootDir, "environments", "mazebench");

    const argv = [primeRunnerScript, "--env-dir", envDir, "--out", runDir, "--max-turns", String(maxTurns)];

    if (model) {
      argv.push("--model", model);
    }

    if (vision) {
      argv.push("--vision");
    }

    if (reasoning) {
      argv.push("--reasoning", reasoning);
    }

    if (!wantVideo) {
      argv.push("--no-video");
    }

    // A readable command string for the run page / logs (not the resolved path).
    const display = ["node", "scripts/maze-prime-run.js", "--out", "<run>", "--max-turns", String(maxTurns)]
      .concat(model ? ["--model", model] : [])
      .concat(vision ? ["--vision"] : [])
      .concat(reasoning ? ["--reasoning", reasoning] : [])
      .join(" ");

    return { bin: process.execPath, argv, display, model, maxTurns, vision, reasoning, video: wantVideo };
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
        const command = buildPrimeCommand(params, runDir);

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
          command: command.display,
          model: "prime",
          model_name: command.model || "(prime default)",
          game_id: "maze",
          game_title: "Maze Bench Environment",
          level_id: "level_HxI",
          moves: command.maxTurns,
          mode: command.vision ? "vision" : "text",
          vision: command.vision,
          reasoning: command.reasoning,
          video: command.video,
          note: "Prime Verifiers v1 eval (uv run eval). Progress, scores, and errors stream in the runner log; a replay video renders after the eval finishes."
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
    const isFrame = /^frames\/(frame|live)-\d+\.png$/.test(fileName);

    if (!SERVABLE_RUN_FILES.has(fileName) && !isFrame) {
      return null;
    }

    const filePath = path.join(runDir, ...fileName.split("/"));
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : null;
  }

  return {
    getEnvironment,
    getRunProgress,
    launchRun,
    listProviderModels,
    listRuns,
    renderLiveFrame,
    resolveRunFilePath,
    startDocker,
    stopRun,
    summarizeRun
  };
}

module.exports = {
  createAgentRunService,
  enrichedPathEnv
};
