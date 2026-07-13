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
const {
  findClaudeSessionFile,
  findCodexSessionFile,
  findCodexSessionFiles,
  findPrimeResultsFile,
  parseClaudeEvents,
  parseCodexEvents,
  parseCodexSession,
  parseCodexSwarmSessions,
  parsePrimeLiveUsage,
  parsePrimeResults
} = require("./token-usage");

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
  // Prefer the running Node installation's bin directory. That is where this
  // app installs npm-global agents, and it may be newer than a Homebrew cask
  // that appears earlier in a GUI process's inherited PATH.
  const merged = [];

  [extra[0], ...current, ...extra.slice(1)].forEach((dir) => {
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
const MAX_LOCAL_MOVE_BUDGET = 100_000;
const RUNNER_STARTUP_GRACE_MS = 15_000;
const RUNNER_ACTIVITY_GRACE_MS = 120_000;
const PROVIDER_RETRY_SCAN_MS = 10_000;
const PROVIDER_RETRY_MAX_MS = 15 * 60_000;
const PAUSE_REQUEST_FILE = "pause-request.json";
const PAUSE_BOUNDARY_FILE = "pause-boundary.json";
const PAUSE_CAPABILITY_FILE = "cold-pause-capability.json";
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{4,80}$/i;
const SERVABLE_RUN_FILES = new Set([
  "run.json",
  "launcher.log",
  "session.json",
  "actions.jsonl",
  "reasoning.json",
  "agent.log",
  "agent-events.jsonl",
  "prime-evaluation.json",
  "prime-evaluation-samples.json",
  "scorecard.json",
  "maze_scorecard.json",
  "maze_actions.txt",
  "maze_replay.mp4"
]);

function collectedAllWorldGems(gemCount, gemTotal) {
  if (gemTotal === null || gemTotal === undefined || gemTotal === "") return false;
  const collected = Number(gemCount);
  const total = Number(gemTotal);
  return Number.isFinite(collected) && Number.isFinite(total) && total >= 0 && collected >= total;
}

function createAgentRunService({
  agentEnvironment,
  agentEnvironmentAsync,
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
  const replayScript = path.join(rootDir, "scripts", "maze-export-replay.js");
  const liveChildren = new Map();
  const videoChildren = new Map();
  const liveFrameLocks = new Map();
  const resolvedRunModels = new Map();
  const legacyClaudeSnapshotTimers = new Map();
  const legacyClaudeSnapshotStamps = new Map();
  const codexSessionPaths = new Map();
  const primeResultsPaths = new Map();
  const tokenUsageCache = new Map();
  const jsonLineIndexes = new Map();
  const initialPlayerCache = new Map();
  const stableCodexCatalogPath = path.join(runsDir, ".codex-model-catalog.json");
  let stableCodexCatalog;
  let claudeQueueOrder = Date.now() * 1000;
  let startingClaudeQueue = false;

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

  function getEnvironmentAsync(options = {}) {
    if (typeof agentEnvironmentAsync === "function") return agentEnvironmentAsync(options);
    return Promise.resolve(getEnvironment(options));
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

  function clearColdPauseMarkers(runId) {
    const runDir = runDirFor(runId);
    fs.rmSync(path.join(runDir, PAUSE_REQUEST_FILE), { force: true });
    fs.rmSync(path.join(runDir, PAUSE_BOUNDARY_FILE), { force: true });
  }

  function clearColdPauseCapability(runId) {
    fs.rmSync(path.join(runDirFor(runId), PAUSE_CAPABILITY_FILE), { force: true });
  }

  function runContainerId(runId) {
    try {
      const id = fs.readFileSync(path.join(runDirFor(runId), "container.cid"), "utf8").trim();
      return /^[a-f0-9]{12,64}$/i.test(id) ? id : "";
    } catch (_error) {
      return "";
    }
  }

  function dockerRunControl(runId, args, action, { required = true } = {}) {
    const containerId = runContainerId(runId);

    if (!containerId) {
      if (required) throw new Error(`The Docker container is still starting; try ${action} again in a moment.`);
      return false;
    }

    const result = spawnSync("docker", [...args, containerId], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });

    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim().split(/\r?\n/).pop();
      throw new Error(`Could not ${action} the Docker run${detail ? `: ${detail}` : "."}`);
    }

    return true;
  }

  function dockerRunAlive(runId) {
    const containerId = runContainerId(runId);
    if (!containerId) return false;
    const result = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", containerId], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 3000,
      maxBuffer: 128 * 1024
    });
    return result.status === 0 && String(result.stdout || "").trim() === "true";
  }

  function runRecentlyActive(runId) {
    const directory = runDirFor(runId);
    const files = ["launcher.log", "agent-events.jsonl", "tool-activity.jsonl", "session.json"];
    return files.some((name) => {
      try {
        return Date.now() - fs.statSync(path.join(directory, name)).mtimeMs < RUNNER_ACTIVITY_GRACE_MS;
      } catch (_error) {
        return false;
      }
    });
  }

  // Runs created before per-run Claude mounts were introduced still keep their
  // native transcript inside the live container. Mirror it after each completed
  // maze action so those already-running sessions can also Continue losslessly.
  function snapshotLegacyClaudeConversation(runId, meta, { force = false } = {}) {
    if (!meta?.container || meta.model !== "claude" || meta.conversation_persistence === "run-dir") return false;
    const conversationId = readConversationId(runId);
    const containerId = runContainerId(runId);
    if (!conversationId || !containerId) return false;

    const runDir = runDirFor(runId);
    const actionsStamp = fileStamp(path.join(runDir, "actions.jsonl"));
    if (!force && legacyClaudeSnapshotStamps.get(runId) === actionsStamp) return true;

    const targetDir = path.join(runDir, "agent-state", "claude", "projects", "-app");
    const target = path.join(targetDir, `${conversationId}.jsonl`);
    const temporary = `${target}.snapshot-${process.pid}`;
    fs.mkdirSync(targetDir, { recursive: true });
    fs.rmSync(temporary, { force: true });

    const result = spawnSync(
      "docker",
      ["cp", `${containerId}:/home/pwuser/.claude/projects/-app/${conversationId}.jsonl`, temporary],
      { encoding: "utf8", env: enrichedPathEnv(), timeout: 15000, maxBuffer: 1024 * 1024 }
    );

    if (result.status !== 0 || !fs.existsSync(temporary)) {
      fs.rmSync(temporary, { force: true });
      return false;
    }

    fs.renameSync(temporary, target);
    legacyClaudeSnapshotStamps.set(runId, actionsStamp);
    return true;
  }

  function stopLegacyClaudeSnapshots(runId) {
    const timer = legacyClaudeSnapshotTimers.get(runId);
    if (timer) clearInterval(timer);
    legacyClaudeSnapshotTimers.delete(runId);
    legacyClaudeSnapshotStamps.delete(runId);
  }

  function startLegacyClaudeSnapshots(runId) {
    if (legacyClaudeSnapshotTimers.has(runId)) return;
    const meta = readRunMeta(runId);
    if (!meta?.container || meta.model !== "claude" || meta.conversation_persistence === "run-dir") return;

    snapshotLegacyClaudeConversation(runId, meta, { force: true });
    const timer = setInterval(() => {
      const current = readRunMeta(runId);
      if (!current || !["running", "stopping"].includes(current.status)) {
        stopLegacyClaudeSnapshots(runId);
        return;
      }
      snapshotLegacyClaudeConversation(runId, current);
    }, 1500);
    timer.unref?.();
    legacyClaudeSnapshotTimers.set(runId, timer);
  }

  function signalRunProcess(meta, signal) {
    if (!meta?.pid) return false;

    try {
      process.kill(-meta.pid, signal);
      return true;
    } catch (_error) {
      try {
        process.kill(meta.pid, signal);
        return true;
      } catch (_innerError) {
        return false;
      }
    }
  }

  function processCommand(pid) {
    if (!pid) return "";
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 3000,
      maxBuffer: 256 * 1024
    });
    return result.status === 0 ? String(result.stdout || "").trim() : "";
  }

  function stopDetachedRunRenderers(runId, { force = false } = {}) {
    const runDir = runDirFor(runId);
    const portFiles = [path.join(runDir, "render-daemon.json")];
    const swarmDir = path.join(runDir, "swarm");
    if (fs.existsSync(swarmDir)) {
      fs.readdirSync(swarmDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .forEach((entry) => portFiles.push(path.join(swarmDir, entry.name, "render-daemon.json")));
    }

    portFiles.forEach((portFile) => {
      const info = loadJson(portFile, null);
      const pid = Math.floor(Number(info?.pid) || 0);
      // Container PIDs can overlap unrelated host PIDs. Never signal a PID
      // unless the host command proves it belongs to our renderer.
      if (pid && /maze-render-frame\.js/.test(processCommand(pid))) {
        try {
          process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
        } catch (_error) {
          try {
            process.kill(pid, force ? "SIGKILL" : "SIGTERM");
          } catch (_innerError) {
            /* already exited */
          }
        }
      }
      fs.rmSync(portFile, { force: true });
    });
  }

  function readRunMeta(runId) {
    return loadJson(runMetaPath(runId), null);
  }

  function readPrimeEvaluation(runId) {
    return loadJson(path.join(runDirFor(runId), "prime-evaluation.json"), null);
  }

  function writeRunMeta(runId, meta) {
    const previous = readRunMeta(runId);
    if (
      previous?.status === "running" &&
      ["failed", "finished"].includes(meta?.status) &&
      (
        pidAlive(previous.pid) ||
        (previous.container && dockerRunAlive(runId))
      )
    ) {
      // Never let a stale process/exit observation overwrite visibly active
      // work. The real child exit will retry after its PID/container and output
      // stream are quiet; manual Stop uses its own stopping → stopped path.
      return previous;
    }
    fs.writeFileSync(runMetaPath(runId), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    return meta;
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

  function activeElapsedMs(meta, now = Date.now()) {
    const stored = Number(meta?.active_elapsed_ms);
    const tracked = Number.isFinite(stored) || Boolean(meta?.active_started_at);

    if (tracked) {
      let elapsed = Number.isFinite(stored) ? Math.max(0, stored) : 0;
      const startedAt = Date.parse(meta.active_started_at || "");
      if (Number.isFinite(startedAt) && ["running", "pausing", "stopping"].includes(meta.status)) {
        elapsed += Math.max(0, now - startedAt);
      }
      return Math.round(elapsed);
    }

    // Existing runs predate active-time tracking. Use their terminal/pause time
    // so their progress UI still has a reasonable historical duration.
    const createdAt = Date.parse(meta?.created_at || "");
    const endedAt = Date.parse(
      meta?.finished_at || meta?.paused_at || (["running", "pausing", "stopping"].includes(meta?.status) ? new Date(now).toISOString() : "")
    );
    return Number.isFinite(createdAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - createdAt) : 0;
  }

  function terminalRunMeta(meta, status, extras = {}) {
    const finishedAt = extras.finished_at || new Date().toISOString();
    return {
      ...meta,
      ...extras,
      status,
      finished_at: finishedAt,
      active_elapsed_ms: activeElapsedMs(meta, Date.parse(finishedAt)),
      active_started_at: null
    };
  }

  function coldPausedRunMeta(meta, extras = {}) {
    const pausedAt = extras.paused_at || new Date().toISOString();
    return {
      ...meta,
      ...extras,
      status: "paused",
      pid: null,
      pause_reason: "manual",
      pause_mode: "cold",
      paused_at: pausedAt,
      active_elapsed_ms: activeElapsedMs(meta, Date.parse(pausedAt)),
      active_started_at: null
    };
  }

  function progressForRun(meta, turns) {
    const current = Math.max(0, Math.floor(Number(turns) || 0));
    const elapsedMs = activeElapsedMs(meta);
    const averageTurnMs = current > 0 ? elapsedMs / current : null;
    if (meta.unlimited) {
      return {
        current,
        total: null,
        percent: null,
        unlimited: true,
        elapsed_ms: elapsedMs,
        average_turn_ms: averageTurnMs == null ? null : Math.round(averageTurnMs),
        eta_ms: null
      };
    }

    const total = Math.max(1, Math.floor(Number(meta.moves) || 1));
    const rawPercent = (Math.min(current, total) / total) * 100;
    const percent = Math.max(0, Math.min(100, rawPercent));
    const etaMs = meta.status === "running" && averageTurnMs != null
      ? Math.max(0, Math.round(averageTurnMs * Math.max(0, total - current)))
      : null;

    return {
      current,
      total,
      percent: Math.round(percent * 10) / 10,
      elapsed_ms: elapsedMs,
      average_turn_ms: averageTurnMs == null ? null : Math.round(averageTurnMs),
      eta_ms: etaMs
    };
  }

  function autoContinueBudgetTarget(runId, meta) {
    const unlimited = Boolean(meta?.unlimited);
    const quitBlocked = meta?.allow_quit === false;
    const configuredTarget = Number(meta?.auto_continue_target) || (quitBlocked ? Number(meta?.moves) : 0);
    const target = Math.min(MAX_LOCAL_MOVE_BUDGET, Math.floor(configuredTarget || 0));
    if ((!unlimited && !target) || meta?.kind === "prime") return null;

    const turns = readActions(runId).length;
    const segmentStart = Math.max(0, Math.floor(Number(meta.segment_start_turns) || 0));
    const segmentBudget = unlimited
      ? null
      : Math.max(1, Math.floor(Number(meta.segment_move_budget) || Number(meta.moves) || 1));
    const exhaustedSegment = segmentBudget != null && turns - segmentStart >= segmentBudget;
    if (!unlimited && ((!quitBlocked && !exhaustedSegment) || turns >= target)) return null;

    if (unlimited || quitBlocked) {
      const session = loadJson(path.join(runDirFor(runId), "session.json"), null);
      const status = session?.lastStatus || session?.actions?.at?.(-1)?.status || null;
      if (status?.game_won || status?.game_lost || status?.quit) return null;
    }

    const conversationId = readConversationId(runId);
    if (
      !conversationId ||
      !(meta.container === false || hasPersistedContainerConversation(runId, meta, conversationId))
    ) return null;

    // Treat the moves already played as the old total so continueLocalInPlace
    // writes the requested target, while its MCP segment receives only the
    // remaining actions. The provider thread and maze session stay unchanged.
    try {
      continueLocalInPlace(
        runId,
        { ...meta, moves: turns },
        unlimited ? null : target - turns,
        conversationId
      );
      return readRunMeta(runId);
    } catch (error) {
      console.error(`Could not auto-continue run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  function finalizeStatus(runId, meta) {
    if (!meta) {
      return meta;
    }

    if (
      ["failed", "finished"].includes(meta.status) &&
      (pidAlive(meta.pid) || (meta.container && dockerRunAlive(runId)))
    ) {
      const { finished_at, exit_code, launch_error, queue_error, ...rest } = meta;
      const revived = {
        ...rest,
        status: "running",
        active_started_at: new Date().toISOString(),
        active_elapsed_ms: Math.max(0, Number(meta.active_elapsed_ms) || 0)
      };
      writeRunMeta(runId, revived);
      return revived;
    }

    if (
      meta.status === "pausing" &&
      !pidAlive(meta.pid) &&
      !liveChildren.has(runId) &&
      !(meta.container && dockerRunAlive(runId))
    ) {
      stopLegacyClaudeSnapshots(runId);
      stopLiveRenderer(runId, { force: true });
      stopDetachedRunRenderers(runId, { force: true });
      const updated = coldPausedRunMeta(meta);
      writeRunMeta(runId, updated);
      return updated;
    }

    if (meta.status === "stopping" && !pidAlive(meta.pid) && !liveChildren.has(runId)) {
      const updated = terminalRunMeta(meta, "stopped", {
        exit_code: meta.exit_code ?? null,
        finished_at: meta.finished_at || new Date().toISOString()
      });
      writeRunMeta(runId, updated);
      if (meta.model === "claude") setImmediate(() => startNextWaitingClaudeRun());
      return updated;
    }

    if (
      meta.status !== "running" ||
      pidAlive(meta.pid) ||
      liveChildren.has(runId) ||
      (meta.container && dockerRunAlive(runId)) ||
      runRecentlyActive(runId)
    ) {
      return meta;
    }

    // Detached children can briefly be absent from the process table while
    // launch wrappers settle. The attached exit handler is authoritative in a
    // live server; this recovery path is for genuinely orphaned metadata after
    // a restart, so never fail a brand-new run on a single early probe.
    const createdAt = Date.parse(meta.created_at || "");
    if (Number.isFinite(createdAt) && Date.now() - createdAt < RUNNER_STARTUP_GRACE_MS) {
      return meta;
    }

    // The process is gone but no exit handler fired (server restarted).
    const providerFailure = readProviderFailure(runId);
    if (providerFailure) {
      const updated = providerBackoffMeta(runId, meta, providerFailure, meta.exit_code ?? null);
      writeRunMeta(runId, updated);
      return updated;
    }

    const succeeded =
      fs.existsSync(path.join(runDirFor(runId), "maze_scorecard.json")) ||
      fs.existsSync(path.join(runDirFor(runId), "scorecard.json"));
    if (succeeded || meta.allow_quit === false) {
      const continued = autoContinueBudgetTarget(runId, meta);
      if (continued) return continued;
    }
    const quota = succeeded ? null : detectQuotaPause(runId);
    const now = new Date().toISOString();
    const updated = quota
      ? {
          ...meta,
          status: "paused",
          pause_reason: "quota",
          pause_message: quota.message,
          paused_at: meta.paused_at || now,
          active_elapsed_ms: activeElapsedMs(meta, Date.parse(meta.paused_at || now)),
          active_started_at: null
        }
      : terminalRunMeta(meta, succeeded ? "finished" : "failed", { finished_at: meta.finished_at || now });
    writeRunMeta(runId, updated);
    if (meta.model === "claude") {
      setImmediate(() => startNextWaitingClaudeRun());
    }
    return updated;
  }

  function allocateClaudeQueueOrder() {
    claudeQueueOrder = Math.max(claudeQueueOrder + 1, Date.now() * 1000);
    return claudeQueueOrder;
  }

  function runMetaEntries() {
    if (!fs.existsSync(runsDir)) return [];

    return fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .map((entry) => ({ id: entry.name, meta: readRunMeta(entry.name) }))
      .filter((entry) => entry.meta);
  }

  function claudeSlotOccupied(excludeRunId = "") {
    return runMetaEntries().some((entry) => {
      if (entry.id === excludeRunId || entry.meta.model !== "claude") return false;
      const meta = entry.meta.status === "running" ? finalizeStatus(entry.id, entry.meta) : entry.meta;
      return (
        ["running", "pausing", "stopping"].includes(meta.status) ||
        (meta.status === "paused" && meta.pause_mode !== "cold")
      );
    });
  }

  function waitingClaudeRuns(excludeRunId = "") {
    return runMetaEntries()
      .filter((entry) => entry.id !== excludeRunId && entry.meta.model === "claude" && entry.meta.status === "waiting")
      .sort((left, right) => {
        const orderDifference = Number(left.meta.queue_order || 0) - Number(right.meta.queue_order || 0);
        return orderDifference || String(left.meta.created_at || "").localeCompare(String(right.meta.created_at || ""));
      });
  }

  function queuedLocalRunMeta(meta, args, extras = {}) {
    const now = new Date().toISOString();
    return {
      ...meta,
      ...extras,
      status: "waiting",
      pid: null,
      queued_args: args,
      queued_at: now,
      queue_order: allocateClaudeQueueOrder(),
      active_started_at: null,
      exit_code: undefined,
      finished_at: undefined,
      pause_reason: undefined,
      pause_message: undefined,
      paused_at: undefined
    };
  }

  function startWaitingClaudeRun(runId) {
    const meta = readRunMeta(runId);
    if (!meta || meta.model !== "claude" || meta.status !== "waiting") return null;

    const args = Array.isArray(meta.queued_args) ? meta.queued_args : [];
    if (!args.length) {
      writeRunMeta(runId, terminalRunMeta(meta, "failed", { queue_error: "Queued launch arguments are missing." }));
      setImmediate(() => startNextWaitingClaudeRun());
      return summarizeRun(runId);
    }

    const logFd = fs.openSync(path.join(runDirFor(runId), "launcher.log"), "a");
    let child;
    try {
      child = spawn(process.execPath, [runnerScript, ...args], {
        cwd: rootDir,
        detached: true,
        env: enrichedPathEnv(),
        stdio: ["ignore", logFd, logFd]
      });
    } catch (error) {
      writeRunMeta(
        runId,
        terminalRunMeta(meta, "failed", { queue_error: error instanceof Error ? error.message : String(error) })
      );
      setImmediate(() => startNextWaitingClaudeRun());
      return summarizeRun(runId);
    } finally {
      fs.closeSync(logFd);
    }

    const startedAt = new Date().toISOString();
    writeRunMeta(runId, {
      ...meta,
      status: "running",
      pid: child.pid,
      queue_started_at: startedAt,
      active_started_at: startedAt,
      active_elapsed_ms: activeElapsedMs(meta)
    });
    attachRunChild(runId, child);
    return summarizeRun(runId);
  }

  function startNextWaitingClaudeRun() {
    if (startingClaudeQueue) return null;
    startingClaudeQueue = true;

    try {
      if (claudeSlotOccupied()) return null;
      const next = waitingClaudeRuns()[0];
      return next ? startWaitingClaudeRun(next.id) : null;
    } finally {
      startingClaudeQueue = false;
    }
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
        timestamp: record.timestamp || record.recorded_at || record.created_at || null,
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

  function readInitialPlayer(runId) {
    if (initialPlayerCache.has(runId)) return initialPlayerCache.get(runId);
    const runDir = runDirFor(runId);
    const initialStatus = loadJson(path.join(runDir, "initial-status.json"), null);
    // Older runs predate initial-status.json. Parse their session once so the
    // heatmap still includes move zero without making every poll pay that cost.
    const status = initialStatus || loadJson(path.join(runDir, "session.json"), null)?.initial || null;
    const x = Number(status?.player?.x);
    const y = Number(status?.player?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const player = { x, y };
    initialPlayerCache.set(runId, player);
    return player;
  }

  function readPrimeLiveTurns(runDir) {
    const usagePath = path.join(runDir, "prime-usage.jsonl");
    if (!fs.existsSync(usagePath)) return 0;

    return fs
      .readFileSync(usagePath, "utf8")
      .split(/\r?\n/)
      .reduce((highest, line) => {
        if (!line.trim()) return highest;
        try {
          return Math.max(highest, Number(JSON.parse(line).turn) || 0);
        } catch (_error) {
          return highest;
        }
      }, 0);
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

  function readLogTail(runId, maxBytes = 16 * 1024) {
    const logPath = path.join(runDirFor(runId), "launcher.log");

    if (!fs.existsSync(logPath)) {
      return "";
    }

    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(logPath, "r");

    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  // When a run exits non-zero we peek at the tail of its log for the tell-tale
  // "you're out of money/credits/usage" messages so we can auto-pause it (and
  // let the user resume once they top up) instead of marking it failed. Kept
  // deliberately specific so a normal error isn't mistaken for a funds problem.
  const QUOTA_PATTERNS = [
    /insufficient (funds|credit|credits|balance|quota)/i,
    /out of (funds|credit|credits)/i,
    /(credit|account) balance is too low/i,
    /add (funds|credits|more credits|to your balance)/i,
    /payment required/i,
    /\b402\b/,
    /quota (exceeded|has been reached|exhausted)/i,
    /you have (hit|reached|exceeded) your (usage|plan) limit/i,
    /usage limit reached/i,
    /(monthly|weekly|daily) (usage )?limit/i,
    /billing (hard|soft) limit/i,
    /exceeded your current quota/i
  ];

  function detectQuotaPause(runId) {
    const tail = readLogTail(runId);

    if (!tail) {
      return null;
    }

    const pattern = QUOTA_PATTERNS.find((regex) => regex.test(tail));

    if (!pattern) {
      return null;
    }

    // Surface the actual offending line so the run page can explain the pause.
    const line = tail
      .split(/\r?\n/)
      .reverse()
      .find((entry) => pattern.test(entry));
    return { reason: "quota", message: (line || "Out of funds/credits/usage.").trim().slice(0, 300) };
  }

  function readProviderFailure(runId) {
    const failure = loadJson(path.join(runDirFor(runId), "provider-failure.json"), null);
    if (!failure || !failure.message) return null;
    return {
      provider: String(failure.provider || "provider"),
      status: Number(failure.status) || null,
      message: String(failure.message).trim().slice(0, 500),
      detected_at: String(failure.detected_at || "")
    };
  }

  function providerRetryDelayMs(failure, attempt) {
    const status = Number(failure?.status) || 0;
    // Authentication/socket failures and explicit rate limits often need a
    // usage-window reset. Gateway errors usually recover much sooner.
    const base = [401, 403, 429].includes(status) ? 5 * 60_000 : 60_000;
    return Math.min(PROVIDER_RETRY_MAX_MS, base * (2 ** Math.max(0, attempt - 1)));
  }

  function providerBackoffMeta(runId, meta, failure, exitCode = null) {
    const turns = readActions(runId).length;
    const madeProgress = turns > Math.max(0, Number(meta.provider_failure_turns) || 0);
    const attempt = madeProgress ? 1 : Math.max(1, Number(meta.provider_retry_attempt) + 1 || 1);
    const delayMs = providerRetryDelayMs(failure, attempt);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    return {
      ...meta,
      status: "paused",
      pause_reason: "provider_backoff",
      pause_message: failure.message,
      provider_failure_status: failure.status,
      provider_failure_turns: turns,
      provider_retry_attempt: attempt,
      retry_at: new Date(nowMs + delayMs).toISOString(),
      exit_code: exitCode,
      paused_at: now,
      active_elapsed_ms: activeElapsedMs(meta, nowMs),
      active_started_at: null
    };
  }

  function retryProviderBackoff(runId, meta) {
    if (meta?.status !== "paused" || meta.pause_reason !== "provider_backoff") return null;
    if (Date.parse(meta.retry_at || "") > Date.now()) return null;

    const conversationId = readConversationId(runId);
    if (!conversationId) {
      writeRunMeta(runId, {
        ...meta,
        pause_message: `${meta.pause_message || "Provider unavailable."} Automatic retry is waiting for a saved provider thread.`,
        retry_at: new Date(Date.now() + PROVIDER_RETRY_MAX_MS).toISOString()
      });
      return null;
    }

    const turns = readActions(runId).length;
    const add = meta.unlimited ? null : Math.max(1, (Number(meta.moves) || turns + 1) - turns);
    try {
      return continueLocalInPlace(runId, meta, add, conversationId);
    } catch (error) {
      writeRunMeta(runId, {
        ...meta,
        pause_message: error instanceof Error ? error.message : String(error),
        retry_at: new Date(Date.now() + PROVIDER_RETRY_MAX_MS).toISOString()
      });
      return null;
    }
  }

  function retryDueProviderBackoffs() {
    runMetaEntries().forEach(({ id, meta }) => {
      if (meta.status === "paused" && meta.pause_reason === "provider_backoff") {
        retryProviderBackoff(id, meta);
      }
    });
  }

  function resolveClaudeCatalogModelId(modelName) {
    const requested = String(modelName || "").trim();

    if (!requested || !/^[a-z][a-z0-9-]*$/i.test(requested)) {
      return requested;
    }

    const match = listProviderModels("claude").models.find(
      (model) => String(model.id).toLowerCase() === requested.toLowerCase()
    );
    return String(match?.resolved_model_id || requested);
  }

  // Claude Code is launched with a stable alias, but its final result records
  // the exact model id actually used. Prefer that authoritative id so completed
  // run cards never collapse back to an ambiguous "sonnet" or "opus" label.
  function readClaudeRunModelId(runId, requestedModel) {
    if (resolvedRunModels.has(runId)) {
      return resolvedRunModels.get(runId);
    }

    const eventsPath = path.join(runDirFor(runId), "agent-events.jsonl");

    if (!fs.existsSync(eventsPath)) {
      return "";
    }

    const family = String(requestedModel || "").toLowerCase().match(/(?:^|claude-)(fable|opus|sonnet|haiku)(?:-|$)/)?.[1] || "";
    const lines = fs.readFileSync(eventsPath, "utf8").split(/\r?\n/).reverse();

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);
        const usage = event && event.modelUsage;
        if (!usage || typeof usage !== "object") continue;

        const candidates = Object.entries(usage)
          .filter(([id]) => /^claude-[a-z0-9.-]+$/i.test(id))
          .map(([id, stats]) => ({
            id,
            tokens: Number(stats?.outputTokens || 0) + Number(stats?.inputTokens || 0)
          }));
        const familyMatches = family
          ? candidates.filter((candidate) => candidate.id.toLowerCase().includes(`claude-${family}-`))
          : [];
        const selected = (familyMatches.length ? familyMatches : candidates)
          .sort((left, right) => right.tokens - left.tokens)[0];

        if (selected) {
          resolvedRunModels.set(runId, selected.id);
          return selected.id;
        }
      } catch (_error) {
        /* skip partial/non-JSON stream lines */
      }
    }

    return "";
  }

  function resolvedRunModelName(runId, meta) {
    const modelName = String(meta.model_name || meta.model || "");

    if (meta.model !== "claude") {
      return modelName;
    }

    const requested = meta.model_alias || meta.launch_params?.model_name || modelName;
    return readClaudeRunModelId(runId, requested) || resolveClaudeCatalogModelId(requested) || modelName;
  }

  function summarizeRun(runId) {
    const meta = finalizeStatus(runId, readRunMeta(runId));

    if (!meta) {
      return null;
    }

    if (meta.status === "running") startLegacyClaudeSnapshots(runId);

    const actions = readActions(runId);
    const last = actions[actions.length - 1] || null;
    const runDir = runDirFor(runId);
    const primeEvaluation = meta.kind === "prime" ? readPrimeEvaluation(runId) : null;
    const modelName = resolvedRunModelName(runId, meta);
    const scorecard = loadJson(path.join(runDir, "maze_scorecard.json"), null);
    const observedRooms = new Set(
      [meta.level_id, ...actions.map((action) => action.current_room)].filter(Boolean)
    );
    const scorecardRooms = Number(scorecard?.rooms?.visited);
    const scorecardRoomTotal = Number(scorecard?.rooms?.total);
    const scorecardGemCount = Number(scorecard?.gems?.collected);
    const scorecardGemTotal = Number(scorecard?.gems?.total);
    const turns = meta.kind === "prime" ? Math.max(actions.length, readPrimeLiveTurns(runDir)) : actions.length;
    const game = getGame(meta.game_id);
    const defaultLevelId = game ? worldMaps.defaultLevelIdForGame(game) : "";
    const instanceMetrics = readInstanceMetrics(runId);
    const gemCount = Number.isFinite(scorecardGemCount)
      ? scorecardGemCount
      : Math.max(0, Number(last?.gem_count) || 0);
    const gemTotal = Number.isFinite(scorecardGemTotal)
      ? scorecardGemTotal
      : Number.isFinite(Number(meta.gem_total))
        ? Number(meta.gem_total)
        : null;
    const complete = collectedAllWorldGems(gemCount, gemTotal);

    const hasVideo = fs.existsSync(path.join(runDir, "maze_replay.mp4"));
    const storedVideoStatus =
      meta.video_status === "rendering" && !videoChildren.has(runId) && !pidAlive(meta.video_pid)
        ? "failed"
        : meta.video_status;
    const videoStatus = hasVideo
      ? "ready"
      : videoChildren.has(runId) || (meta.video_status === "rendering" && pidAlive(meta.video_pid))
        ? "rendering"
        : storedVideoStatus || (meta.video && ["finished", "stopped", "failed"].includes(meta.status) ? "failed" : "idle");

    return {
      ...meta,
      model_name: modelName,
      turns,
      auxiliary_actions: instanceMetrics.auxiliary_actions,
      auxiliary_action_attempts: instanceMetrics.auxiliary_action_attempts,
      simulated_actions: turns + instanceMetrics.auxiliary_actions,
      explorer_instances: instanceMetrics.instances,
      gem_count: gemCount,
      gem_total: gemTotal,
      room_count: Number.isFinite(scorecardRooms) ? scorecardRooms : observedRooms.size,
      room_total: Number.isFinite(scorecardRoomTotal) ? scorecardRoomTotal : meta.room_total ?? null,
      progress: progressForRun(meta, turns),
      start_room_is_default: Boolean(defaultLevelId && meta.level_id === defaultLevelId),
      current_room: last ? last.current_room : meta.level_id,
      complete,
      solved: Boolean(last && last.solved),
      has_video: hasVideo,
      video_status: videoStatus,
      has_reasoning: fs.existsSync(path.join(runDir, "reasoning.json")),
      prime_evaluation_id: String(primeEvaluation?.evaluation_id || primeEvaluation?.id || ""),
      prime_evaluation_status: String(primeEvaluation?.status || ""),
      prime_evaluation_url: String(
        primeEvaluation?.viewer_url ||
        (primeEvaluation?.evaluation_id
          ? `https://app.primeintellect.ai/dashboard/evaluations/${primeEvaluation.evaluation_id}`
          : "")
      ),
      prime_evaluation_score:
        Number.isFinite(Number(primeEvaluation?.avg_score)) ? Number(primeEvaluation.avg_score) : null,
      // Grouping key for the runs-list provider filter (codex | claude | prime).
      provider: meta.kind === "prime" ? "prime" : meta.model,
      pausable:
        meta.status === "running" &&
        meta.kind !== "prime" &&
        (meta.container === false || Boolean(runContainerId(runId))),
      resumable: meta.status === "paused",
      continuable: meta.status === "finished" || meta.status === "stopped",
      url: `/agent/runs/${encodeURIComponent(runId)}`
    };
  }

  function allRunSummaries() {
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

  // The runs page usually shows only five recent cards. Reading and parsing every
  // historical actions.jsonl before slicing that page made initial load scale
  // with the lifetime of the installation rather than the number of visible
  // cards. Keep filtering/pagination on tiny run.json records, then deeply
  // summarize only the requested page. Metric sorts still use full summaries
  // because their ordering genuinely depends on replay-derived data.
  function lightweightRunRecords() {
    if (!fs.existsSync(runsDir)) return [];

    return fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .flatMap((entry) => {
        const raw = readRunMeta(entry.name);
        if (!raw) return [];
        const meta = ["running", "pausing", "stopping"].includes(raw.status)
          ? finalizeStatus(entry.name, raw)
          : raw;
        return [{
          id: entry.name,
          created_at: meta.created_at || entry.name,
          game_id: meta.game_id || "",
          game_title: meta.game_title || "",
          model: meta.model || "",
          model_name: meta.model_name || meta.model || "",
          provider: meta.kind === "prime" ? "prime" : meta.model,
          status: meta.status || ""
        }];
      })
      .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
  }

  // Paginated, filterable, sortable runs listing. Returns the requested page plus
  // the totals and the facet lists (providers/models present across ALL runs) so
  // the UI can offer stable filter dropdowns. With no options it behaves like the
  // old full list (page 1), so existing callers keep working.
  function listRuns(options = {}) {
    const provider = String(options.provider || "").trim();
    const model = String(options.model || "").trim();
    const status = String(options.status || "").trim();
    const query = String(options.query || "").trim().toLowerCase();
    const sort = String(options.sort || "newest");
    const metricSort = ["actions", "rooms", "gems"].includes(sort);
    const all = metricSort ? allRunSummaries() : lightweightRunRecords();

    const providers = [...new Set(all.map((run) => run.provider).filter(Boolean))].sort();
    const models = [...new Set(all.map((run) => run.model_name).filter(Boolean))].sort();
    const standardStatuses = ["waiting", "running", "paused", "stopping", "stopped", "finished", "failed"];
    const extraStatuses = [...new Set(all.map((run) => run.status).filter(Boolean))]
      .filter((value) => !standardStatuses.includes(value))
      .sort();
    const statuses = [...standardStatuses, ...extraStatuses];

    let filtered = all;

    if (provider) {
      filtered = filtered.filter((run) => run.provider === provider);
    }

    if (model) {
      filtered = filtered.filter((run) => (run.model_name || "") === model);
    }

    if (status) {
      filtered = filtered.filter((run) => run.status === status);
    }

    if (query) {
      filtered = filtered.filter((run) =>
        [run.id, run.model, run.model_name, run.provider, run.game_title, run.game_id, run.status]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query)
      );
    }

    if (sort === "oldest") {
      filtered = [...filtered].reverse();
    } else if (metricSort) {
      const key = { actions: "turns", rooms: "room_count", gems: "gem_count" }[sort];
      filtered = [...filtered].sort((left, right) => {
        const difference = (Number(right[key]) || 0) - (Number(left[key]) || 0);
        return difference || String(right.created_at || "").localeCompare(String(left.created_at || ""));
      });
    }

    const total = filtered.length;
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(options.pageSize) || 10)));
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.max(1, Math.min(pages, Math.floor(Number(options.page) || 1)));
    const start = (page - 1) * pageSize;

    const pageRows = filtered.slice(start, start + pageSize);
    const runs = metricSort
      ? pageRows
      : pageRows.map((record) => summarizeRun(record.id)).filter(Boolean);

    return {
      runs,
      total,
      page,
      pages,
      page_size: pageSize,
      providers,
      models,
      statuses,
      active: all.some((run) => ["waiting", "running", "pausing", "stopping"].includes(run.status))
    };
  }

  // Per-move reasoning, live. reasoning.json exists only once the run finishes;
  // while it runs we distill the streamed agent-events.jsonl on the fly so the
  // web UI shows each move's thoughts as they arrive.
  function readReasoning(runId, model) {
    const runDir = runDirFor(runId);
    const finalPath = path.join(runDir, "reasoning.json");
    const finalReasoning = fs.existsSync(finalPath) ? loadJson(finalPath, []) : [];
    const executedMoves = model === "prime"
      ? Math.max(readActions(runId).length, readPrimeLiveTurns(runDir))
      : readActions(runId).length;
    const alignToMoves = (entries) => entries.filter(
      (entry) => !Number(entry?.move) || Number(entry.move) <= executedMoves
    );

    if (model === "prime") {
      if (finalReasoning.length) return alignToMoves(finalReasoning);
      const livePath = path.join(runDir, "prime-reasoning.jsonl");
      if (!fs.existsSync(livePath)) return [];
      return alignToMoves(fs
        .readFileSync(livePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch (_error) {
            return [];
          }
        }));
    }

    const eventsPath = path.join(runDir, "agent-events.jsonl");

    if (!fs.existsSync(eventsPath)) {
      return alignToMoves(finalReasoning);
    }

    try {
      const raw = fs.readFileSync(eventsPath, "utf8");
      const distilled = model === "claude" ? distillClaudeEvents(raw) : distillCodexEvents(raw);
      const liveReasoning = distilled.entries || [];
      const liveWithText = liveReasoning.filter((entry) => entry.reasoning).length;
      const finalWithText = finalReasoning.filter((entry) => entry.reasoning).length;
      const selected = liveReasoning.length > finalReasoning.length || liveWithText > finalWithText
        ? liveReasoning
        : finalReasoning;
      // Older reasoning.json files predate action timestamps. Merge the live
      // provider event timestamp by move so historical runs gain timestamps
      // without rewriting their preserved artifacts.
      const liveByMove = new Map(liveReasoning.map((entry) => [Number(entry.move), entry]));
      return alignToMoves(selected.map((entry) => ({
        ...entry,
        timestamp: entry.timestamp || liveByMove.get(Number(entry.move))?.timestamp || null
      })));
    } catch (error) {
      return alignToMoves(finalReasoning);
    }
  }

  function readJsonLineTail(filePath, maxBytes = 8 * 1024 * 1024) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.size) return [];
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, buffer, 0, length, stat.size - length);
      } finally {
        fs.closeSync(fd);
      }
      const lines = buffer.toString("utf8").split(/\r?\n/);
      if (length < stat.size) lines.shift();
      return lines.flatMap((line) => {
        if (!line.trim()) return [];
        try {
          return [JSON.parse(line)];
        } catch (_error) {
          return [];
        }
      });
    } catch (_error) {
      return [];
    }
  }

  function readInstanceEventSummary(runId) {
    const events = readJsonLineTail(
      path.join(runDirFor(runId), "maze-instance-events.jsonl"),
      16 * 1024 * 1024
    );
    const instances = new Map();

    events.forEach((event) => {
      const instanceId = String(event.instance_id || "");
      if (!instanceId || instanceId === "primary") return;
      const current = instances.get(instanceId) || {
        actions_applied: 0,
        actions_attempted: 0,
        created_at: null,
        last_action: "",
        last_action_at: null
      };
      if (event.type === "instance.created") {
        current.created_at = event.at || current.created_at;
      } else if (event.type === "instance.action") {
        current.actions_attempted += event.attempted === false ? 0 : 1;
        current.actions_applied += event.applied ? 1 : 0;
        current.last_action = String(event.action || "");
        current.last_action_at = event.at || current.last_action_at;
      }
      instances.set(instanceId, current);
    });

    return instances;
  }

  function readInstanceMetrics(runId) {
    const byInstance = readInstanceEventSummary(runId);
    const swarmDir = path.join(runDirFor(runId), "swarm");
    const directories = fs.existsSync(swarmDir)
      ? fs.readdirSync(swarmDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      : [];
    const rows = directories.map((entry) => {
      const directory = path.join(swarmDir, entry.name);
      const metadata = loadJson(path.join(directory, "worker.json"), {}) || {};
      const telemetry = loadJson(path.join(directory, "telemetry.json"), null);
      const session = telemetry ? null : loadJson(path.join(directory, "session.json"), null);
      const inherited = Math.max(0, Number(metadata.fork_action_count) || 0);
      const fallbackApplied = Math.max(0, Number(session?.actions?.length) || 0) - inherited;
      const recorded = byInstance.get(entry.name);
      return {
        actions_applied: telemetry
          ? Math.max(0, Number(telemetry.actions_applied) || 0)
          : recorded
            ? recorded.actions_applied
            : fallbackApplied,
        actions_attempted: telemetry
          ? Math.max(0, Number(telemetry.actions_attempted) || 0)
          : recorded
            ? recorded.actions_attempted
            : fallbackApplied
      };
    });
    return {
      instances: Math.max(directories.length, byInstance.size),
      auxiliary_actions: rows.reduce((sum, row) => sum + row.actions_applied, 0),
      auxiliary_action_attempts: rows.reduce((sum, row) => sum + row.actions_attempted, 0)
    };
  }

  function shellActivityLabel(command) {
    const text = String(command || "").replace(/^\S+\s+-[lc]+\s+/, "").replace(/["']/g, "").trim();
    const script = text.match(/(?:^|[;&|]\s*|\s)(?:node|python\d*|ruby|bash|sh)\s+([^\s;&|]+\.(?:js|mjs|cjs|py|rb|sh))\b/i);
    return {
      label: script ? `Algorithm · ${path.basename(script[1])}` : "Shell",
      detail: text.split("\n")[0].slice(0, 140)
    };
  }

  function readToolActivity(runId, summary) {
    if (summary.provider === "prime") return { active: [], recent: [], calls: 0, moves_tried: 0 };
    const runDir = runDirFor(runId);
    const mcpEntries = readJsonLineTail(path.join(runDir, "tool-activity.jsonl"), 4 * 1024 * 1024);
    const events = readJsonLineTail(path.join(runDir, "agent-events.jsonl"));
    const mcpById = new Map();
    mcpEntries.forEach((entry, index) => {
      const id = String(entry.id || `legacy-${index}`);
      mcpById.set(id, { ...(mcpById.get(id) || {}), ...entry, id });
    });
    const mcpRows = [...mcpById.values()].map((entry) => ({
      id: entry.id,
      label: String(entry.tool || "Maze tool").replace(/^maze_/, "Maze · ").replaceAll("_", " "),
      detail: entry.action || entry.clone_id || "",
      actor: entry.clone_id ? `instance · ${entry.clone_id}` : entry.actor || "lead",
      started_at: entry.started_at,
      completed_at: entry.completed_at,
      duration_ms: Math.max(0, Number(entry.duration_ms) || 0),
      status: entry.status || "completed",
      moves_tried: Math.max(0, Number(entry.move_calls) || 0)
    }));
    const activeMcp = mcpRows.filter((entry) => entry.status === "running");
    const completed = mcpRows.filter((entry) => entry.status !== "running");
    const pending = new Map();
    const providerRows = [];
    const timedMoves = completed.filter((entry) => entry.label === "Maze · action" && entry.started_at);
    const movesDuring = (startedAt, completedAt = new Date().toISOString()) => {
      const start = Date.parse(startedAt || "");
      const end = Date.parse(completedAt || "");
      if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
      return timedMoves.filter((entry) => {
        const time = Date.parse(entry.started_at);
        return Number.isFinite(time) && time >= start && time <= end;
      }).length;
    };

    if (summary.provider === "codex") {
      events.forEach((event) => {
        const item = event.item;
        if (!item || !["command_execution", "collab_tool_call"].includes(item.type) || !event._mazebench_received_at) return;
        const id = String(item.id || "");
        if (!id) return;
        if (event.type === "item.started") {
          const shell = item.type === "command_execution" ? shellActivityLabel(item.command) : null;
          pending.set(id, {
            id: `provider-${id}`,
            label: shell?.label || `Subagent · ${String(item.tool || "activity").replaceAll("_", " ")}`,
            detail: shell?.detail || (item.type === "collab_tool_call" ? "Provider worker" : ""),
            actor: "provider",
            started_at: event._mazebench_received_at,
            status: "running"
          });
        } else if (event.type === "item.completed") {
          const row = pending.get(id);
          if (!row) return;
          pending.delete(id);
          const completedAt = event._mazebench_received_at;
          providerRows.push({
            ...row,
            completed_at: completedAt,
            duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(row.started_at)),
            status: item.status === "failed" ? "failed" : "completed",
            moves_tried: movesDuring(row.started_at, completedAt)
          });
        }
      });
    } else if (summary.provider === "claude") {
      events.forEach((event) => {
        const timestamp = event._mazebench_received_at;
        if (!timestamp) return;
        if (event.type === "assistant" && Array.isArray(event.message?.content)) {
          event.message.content.forEach((block) => {
            if (block?.type !== "tool_use" || !block.id || /^mcp__mazebench/.test(block.name)) return;
            const shell = block.name === "Bash" ? shellActivityLabel(block.input?.command) : null;
            pending.set(block.id, {
              id: `provider-${block.id}`,
              label: shell?.label || (["Task", "Agent"].includes(block.name) ? "Subagent" : block.name || "Tool"),
              detail: shell?.detail || (["Task", "Agent"].includes(block.name)
                ? "Provider worker"
                : String(block.input?.description || block.input?.file_path || "").slice(0, 140)),
              actor: "provider",
              started_at: timestamp,
              status: "running"
            });
          });
        } else if (event.type === "user" && Array.isArray(event.message?.content)) {
          event.message.content.forEach((block) => {
            if (block?.type !== "tool_result" || !pending.has(block.tool_use_id)) return;
            const row = pending.get(block.tool_use_id);
            pending.delete(block.tool_use_id);
            providerRows.push({
              ...row,
              completed_at: timestamp,
              duration_ms: Math.max(0, Date.parse(timestamp) - Date.parse(row.started_at)),
              status: block.is_error ? "failed" : "completed",
              moves_tried: movesDuring(row.started_at, timestamp)
            });
          });
        }
      });
    }

    const active = [...activeMcp, ...pending.values()].map((row) => ({
      ...row,
      duration_ms: Math.max(0, Date.now() - Date.parse(row.started_at)),
      moves_tried: movesDuring(row.started_at)
    }));
    const recent = [...completed, ...providerRows]
      .sort((left, right) => Date.parse(right.completed_at || right.started_at) - Date.parse(left.completed_at || left.started_at))
      .slice(0, 40);
    return {
      active,
      recent,
      calls: mcpRows.length + providerRows.length + pending.size,
      moves_tried: completed.reduce((sum, row) => sum + row.moves_tried, 0)
    };
  }

  function fileStamp(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return "-";

    try {
      const stat = fs.statSync(filePath);
      return `${filePath}:${stat.size}:${stat.mtimeMs}`;
    } catch (_error) {
      return "-";
    }
  }

  function readTokenUsage(runId, summary) {
    const runDir = runDirFor(runId);
    const eventsPath = path.join(runDir, "agent-events.jsonl");
    const primeLiveUsagePath = path.join(runDir, "prime-usage.jsonl");
    let codexSessionPath = "";
    let codexSwarmSessionPaths = [];
    let primeResultsPath = "";

    if (summary.provider === "codex") {
      const conversationId = readConversationId(runId);
      const runCodexHome = path.join(runDir, "agent-state", "codex");
      codexSessionPath = codexSessionPaths.get(conversationId) || "";

      if (conversationId && !codexSessionPath) {
        const hostCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
        codexSessionPath =
          findCodexSessionFile(runCodexHome, conversationId) ||
          findCodexSessionFile(hostCodexHome, conversationId);
        if (codexSessionPath) codexSessionPaths.set(conversationId, codexSessionPath);
      }
      if (summary.swarm) {
        codexSwarmSessionPaths = findCodexSessionFiles(runCodexHome);
        if (!codexSwarmSessionPaths.length && codexSessionPath) {
          codexSwarmSessionPaths = [codexSessionPath];
        }
      }
    } else if (summary.provider === "prime") {
      primeResultsPath = primeResultsPaths.get(runId) || "";
      if (!primeResultsPath) {
        primeResultsPath = findPrimeResultsFile(runDir);
        if (primeResultsPath) primeResultsPaths.set(runId, primeResultsPath);
      }
    }

    const signature = [
      fileStamp(eventsPath),
      fileStamp(codexSessionPath),
      codexSwarmSessionPaths.map(fileStamp).join(","),
      fileStamp(primeLiveUsagePath),
      fileStamp(primeResultsPath)
    ].join("|");
    const withSwarmAgentStatus = (usage) => {
      if (!summary.swarm) return usage;
      const agentsRan = Math.max(1, Number(usage?.agents_total) || 0);
      const runIsActive = summary.status === "running" || summary.status === "stopping";
      return {
        ...usage,
        agents_running: runIsActive ? Math.max(1, Number(usage?.agents_current) || 0) : 0,
        agents_ran: agentsRan
      };
    };
    const cached = tokenUsageCache.get(runId);
    if (cached?.signature === signature) return withSwarmAgentStatus(cached.value);

    let value;
    try {
      if (summary.provider === "codex") {
        if (summary.swarm && codexSwarmSessionPaths.length) {
          value = parseCodexSwarmSessions(
            codexSwarmSessionPaths.map((filePath) => fs.readFileSync(filePath, "utf8")),
            readConversationId(runId)
          );
        } else {
          value = codexSessionPath
            ? parseCodexSession(fs.readFileSync(codexSessionPath, "utf8"))
            : parseCodexEvents(fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8") : "");
        }
      } else if (summary.provider === "claude") {
        value = parseClaudeEvents(fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8") : "");
      } else {
        const hasFinalResults = primeResultsPath && fs.statSync(primeResultsPath).size > 0;
        value = hasFinalResults
          ? parsePrimeResults(fs.readFileSync(primeResultsPath, "utf8"))
          : parsePrimeLiveUsage(
              fs.existsSync(primeLiveUsagePath) ? fs.readFileSync(primeLiveUsagePath, "utf8") : ""
            );
      }
    } catch (_error) {
      value = {
        provider: summary.provider,
        available: false,
        exact: false,
        note: "Token telemetry is not available for this run.",
        actions: []
      };
    }

    tokenUsageCache.set(runId, { signature, value });
    return withSwarmAgentStatus(value);
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

  function readLastJsonLine(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.size) return null;
      const length = Math.min(stat.size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, buffer, 0, length, stat.size - length);
      } finally {
        fs.closeSync(fd);
      }
      const lines = buffer.toString("utf8").trim().split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          return JSON.parse(lines[index]);
        } catch (_error) {
          /* The first line may be a partial read; keep walking backward. */
        }
      }
    } catch (_error) {
      /* missing or concurrently-created file */
    }
    return null;
  }

  function jsonLineIndexFor(filePath) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_error) {
      return { size: 0, mtimeMs: 0, offsets: [] };
    }

    const existing = jsonLineIndexes.get(filePath);
    if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) return existing;

    const incremental = Boolean(existing && stat.size > existing.size);
    const offsets = incremental ? [...existing.offsets] : stat.size ? [0] : [];
    const start = incremental ? existing.size : 0;

    if (incremental && start > 0) {
      const previous = Buffer.alloc(1);
      const previousFd = fs.openSync(filePath, "r");
      try {
        fs.readSync(previousFd, previous, 0, 1, start - 1);
      } finally {
        fs.closeSync(previousFd);
      }
      if (previous[0] === 10 && start < stat.size && offsets[offsets.length - 1] !== start) offsets.push(start);
    }

    if (stat.size > start) {
      const buffer = Buffer.alloc(stat.size - start);
      const fd = fs.openSync(filePath, "r");
      try {
        fs.readSync(fd, buffer, 0, buffer.length, start);
      } finally {
        fs.closeSync(fd);
      }
      for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] !== 10) continue;
        const next = start + index + 1;
        if (next < stat.size && offsets[offsets.length - 1] !== next) offsets.push(next);
      }
    }

    const value = { size: stat.size, mtimeMs: stat.mtimeMs, offsets };
    jsonLineIndexes.set(filePath, value);
    return value;
  }

  function readJsonLineAt(filePath, lineIndex) {
    const index = jsonLineIndexFor(filePath);
    const start = index.offsets[lineIndex];
    if (!Number.isFinite(start)) return null;
    const end = index.offsets[lineIndex + 1] ?? index.size;
    const length = Math.max(0, end - start);
    if (!length) return null;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    try {
      return JSON.parse(buffer.toString("utf8").trim());
    } catch (_error) {
      return null;
    }
  }

  function latestSwarmFrame(runId, workerId, workerDir) {
    const framesDir = path.join(workerDir, "frames");
    if (!fs.existsSync(framesDir)) return null;
    const latest = fs.readdirSync(framesDir)
      .map((name) => ({ name, match: name.match(/^(?:frame|live)-(\d+)\.png$/) }))
      .filter((entry) => entry.match)
      .sort((left, right) => Number(right.match[1]) - Number(left.match[1]))[0];
    return latest
      ? `/agent-runs/${encodeURIComponent(runId)}/files/swarm/${encodeURIComponent(workerId)}/frames/${encodeURIComponent(latest.name)}`
      : null;
  }

  function readSwarmViews(runId) {
    const swarmDir = path.join(runDirFor(runId), "swarm");
    if (!fs.existsSync(swarmDir)) return [];
    const eventSummary = readInstanceEventSummary(runId);

    return fs.readdirSync(swarmDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-z0-9_-]{1,48}$/i.test(entry.name))
      .map((entry) => {
        const workerDir = path.join(swarmDir, entry.name);
        const actionsPath = path.join(workerDir, "actions.jsonl");
        const sessionPath = path.join(workerDir, "session.json");
        const metadata = loadJson(path.join(workerDir, "worker.json"), {}) || {};
        const telemetry = loadJson(path.join(workerDir, "telemetry.json"), null);
        const lastAction = readLastJsonLine(actionsPath);
        const session = loadJson(sessionPath, null);
        let status = lastAction?.status || null;

        if (!status) {
          status = session?.lastStatus || session?.initial || null;
        }
        if (!status) return null;

        const checkpoint = loadJson(path.join(workerDir, "current-render-state.json"), null);
        const turn = Math.max(
          0,
          Number(lastAction?.turn) ||
            Number(checkpoint?.turn) ||
            Number(status.action_count) ||
            Number(session?.actions?.length) ||
            0
        );
        let updatedAt = 0;
        try {
          updatedAt = Math.max(
            fs.existsSync(actionsPath) ? fs.statSync(actionsPath).mtimeMs : 0,
            fs.existsSync(sessionPath) ? fs.statSync(sessionPath).mtimeMs : 0,
            fs.existsSync(path.join(workerDir, "current-render-state.json"))
              ? fs.statSync(path.join(workerDir, "current-render-state.json")).mtimeMs
              : 0
          );
        } catch (_error) {
          updatedAt = 0;
        }
        const terminal = Boolean(
          status.game_won || status.game_lost || status.quit || fs.existsSync(path.join(workerDir, "scorecard.json"))
        );
        const activity = terminal
          ? "finished"
          : updatedAt && Date.now() - updatedAt < 15_000
            ? "acting"
            : updatedAt && Date.now() - updatedAt < 120_000
              ? "exploring"
            : "standing by";
        const inheritedActionCount = Math.max(0, Number(metadata.fork_action_count) || 0);
        const recorded = eventSummary.get(entry.name);
        const ownActionCount = Math.max(0, turn - inheritedActionCount);

        return {
          id: entry.name,
          label: String(metadata.label || entry.name),
          activity,
          board: String(status.level || ""),
          frame_url: latestSwarmFrame(runId, entry.name, workerDir),
          gem_count: Math.max(0, Number(status.gem_count) || 0),
          player: status.player
            ? {
                elevation: Number(status.player.elevation) || 0,
                x: Number(status.player.x) || 0,
                y: Number(status.player.y) || 0
              }
            : null,
          room: String(status.current_room || checkpoint?.snapshot?.level_id || ""),
          turn,
          inherited_action_count: inheritedActionCount,
          auxiliary_actions: telemetry
            ? Math.max(0, Number(telemetry.actions_applied) || 0)
            : recorded
              ? recorded.actions_applied
              : ownActionCount,
          auxiliary_action_attempts: telemetry
            ? Math.max(0, Number(telemetry.actions_attempted) || 0)
            : recorded
              ? recorded.actions_attempted
              : ownActionCount,
          last_action: String(telemetry?.last_action || recorded?.last_action || ""),
          owner_kind: String(metadata.owner_kind || "subagent"),
          owner_agent_id: String(metadata.owner_agent_id || entry.name),
          parent_instance_id: String(metadata.parent_instance_id || "primary"),
          observation_mode: String(metadata.observation_mode || (session?.vision ? "vision" : "text")),
          updated_at: updatedAt ? new Date(updatedAt).toISOString() : null,
          view: String(status.current_view || ""),
          yaw: Number(status.yaw) || 0
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        const rank = { acting: 0, exploring: 1, "standing by": 2, finished: 3 };
        return (rank[left.activity] ?? 3) - (rank[right.activity] ?? 3) || left.id.localeCompare(right.id);
      });
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

  // ---- live frame renderers -------------------------------------------------
  // One persistent maze-render-frame.js --serve child per watched run, spawned
  // lazily and reaped after idling. Its "render" command syncs to the run's
  // action list incrementally, so rendering turn N+1 applies one new action
  // instead of booting a browser and replaying the whole run per frame.

  const liveRenderers = new Map();
  const LIVE_RENDERER_IDLE_MS = 3 * 60 * 1000;

  function stopLiveRenderer(runId, { force = false } = {}) {
    const entry = liveRenderers.get(runId);

    if (!entry) {
      return;
    }

    liveRenderers.delete(runId);
    clearTimeout(entry.idleTimer);
    entry.waiters.splice(0).forEach((waiter) => waiter.reject(new Error("The frame renderer stopped.")));

    const child = entry.child;
    if (force) {
      try {
        child.kill("SIGKILL");
      } catch (_error) {
        /* already exited */
      }
      return;
    }

    try {
      entry.child.stdin.write(`${JSON.stringify({ command: "close" })}\n`);
    } catch (error) {
      /* stdin already gone */
    }

    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        /* already exited */
      }
    }, 5000).unref();
  }

  function liveRendererFor(runId) {
    const existing = liveRenderers.get(runId);

    if (existing && existing.child.exitCode === null && !existing.child.killed) {
      return existing;
    }

    if (existing) {
      stopLiveRenderer(runId);
    }

    const child = spawn(process.execPath, [renderFrameScript, "--serve"], {
      cwd: rootDir,
      env: enrichedPathEnv(),
      stdio: ["pipe", "pipe", "ignore"]
    });
    const entry = { child, waiters: [], buffer: "", idleTimer: null };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      entry.buffer += chunk;
      let newline = entry.buffer.indexOf("\n");

      while (newline >= 0) {
        const line = entry.buffer.slice(0, newline).trim();
        entry.buffer = entry.buffer.slice(newline + 1);
        newline = entry.buffer.indexOf("\n");

        if (line) {
          entry.waiters.shift()?.resolve(line);
        }
      }
    });

    const fail = () => {
      if (liveRenderers.get(runId) === entry) {
        liveRenderers.delete(runId);
      }

      clearTimeout(entry.idleTimer);
      entry.waiters.splice(0).forEach((waiter) => waiter.reject(new Error("The frame renderer exited.")));
    };
    child.on("error", fail);
    child.on("close", fail);

    liveRenderers.set(runId, entry);
    return entry;
  }

  function liveRendererRequest(runId, message, timeoutMs = 45000) {
    const entry = liveRendererFor(runId);

    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => stopLiveRenderer(runId), LIVE_RENDERER_IDLE_MS);
    entry.idleTimer.unref?.();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = entry.waiters.indexOf(waiter);

        if (index >= 0) {
          entry.waiters.splice(index, 1);
        }

        // A stuck renderer would stall every later frame too — recycle it.
        stopLiveRenderer(runId);
        reject(new Error("The frame renderer timed out."));
      }, timeoutMs);
      const waiter = {
        resolve: (line) => {
          clearTimeout(timer);

          try {
            resolve(JSON.parse(line));
          } catch (error) {
            reject(new Error("The renderer returned an unreadable response."));
          }
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      };

      entry.waiters.push(waiter);

      try {
        entry.child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        waiter.reject(error);
      }
    });
  }

  // Render a maze image for the human watching a text-mode run (vision runs
  // already have real frames). Syncs the run's persistent renderer to the first
  // `turn` actions, caches the PNG, and returns its url. One render per run at
  // a time so requests never pile up behind a slow frame.
  async function renderLiveFrame(runId, turn) {
    const runDir = runDirFor(runId);
    const framesDir = path.join(runDir, "frames");
    const checkpoint = loadJson(path.join(runDir, "current-render-state.json"), null);
    const checkpointTurn = Math.max(0, Number(checkpoint?.turn) || 0);
    const useCheckpoint = Boolean(
      checkpoint?.snapshot?.level_id && Array.isArray(checkpoint.snapshot.actors) && checkpointTurn <= Number(turn)
    );
    const renderTurn = useCheckpoint ? checkpointTurn : Number(turn);
    const fileName = `live-${String(renderTurn).padStart(3, "0")}.png`;
    const target = path.join(framesDir, fileName);
    const url = `/agent-runs/${encodeURIComponent(runId)}/files/frames/${fileName}`;
    const fallback = fs.existsSync(framesDir)
      ? fs.readdirSync(framesDir)
          .map((name) => ({ name, match: name.match(/^live-(\d+)\.png$/) }))
          .filter((entry) => entry.match && Number(entry.match[1]) <= Number(turn))
          .map((entry) => ({
            turn: Number(entry.match[1]),
            url: `/agent-runs/${encodeURIComponent(runId)}/files/frames/${entry.name}`
          }))
          .sort((left, right) => right.turn - left.turn)[0] || null
      : null;

    if (fs.existsSync(target)) {
      return { url, turn: renderTurn, cached: true };
    }

    const runMeta = readRunMeta(runId);
    if (["paused", "stopping", "stopped"].includes(runMeta?.status)) {
      return fallback
        ? { ...fallback, suspended: true }
        : { url: null, suspended: true };
    }

    if (liveFrameLocks.has(runId)) {
      return fallback ? { ...fallback, pending: true, stale: true } : { url: null, pending: true };
    }

    const session = loadJson(path.join(runDir, "session.json"), null);

    if (!session) {
      // The UI requests move 0 immediately. Keep retrying while the runner is
      // creating its session instead of exhausting the frame failure budget.
      return fallback ? { ...fallback, pending: true, stale: true } : { url: null, pending: true };
    }

    const payload = {
      command: "render",
      actions: useCheckpoint
        ? []
        : (session.actions || [])
            .slice(0, Number(turn) || 0)
            .map((action) => canonicalActionText(action.message))
            .filter(Boolean),
      draft: true,
      fast: true,
      gameId: session.gameId || "maze",
      levelId: useCheckpoint
        ? checkpoint.snapshot.level_id
        : session.levelId || "level_HxI",
      snapshot: useCheckpoint ? checkpoint.snapshot : null,
      width: 640,
      height: 640,
      yaw: session.yaw || 0
    };

    const lock = (async () => {
      try {
        const response = await liveRendererRequest(runId, payload);

        if (!response || response.ok !== true || !response.frame) {
          return { url: null, error: (response && response.error) || "The frame renderer failed." };
        }

        const dataUrl = String(response.frame);
        const prefix = "data:image/png;base64,";

        if (!dataUrl.startsWith(prefix)) {
          return { url: null, error: "The renderer returned no image." };
        }

        fs.mkdirSync(framesDir, { recursive: true });
        fs.writeFileSync(target, Buffer.from(dataUrl.slice(prefix.length), "base64"));
        return { url, turn: renderTurn };
      } catch (error) {
        return { url: null, error: error.message || "The frame renderer failed." };
      }
    })();

    liveFrameLocks.set(runId, lock);

    if (fallback) {
      lock.finally(() => {
        if (liveFrameLocks.get(runId) === lock) liveFrameLocks.delete(runId);
      });
      return { ...fallback, pending: true, stale: true };
    }

    try {
      return await lock;
    } finally {
      if (liveFrameLocks.get(runId) === lock) liveFrameLocks.delete(runId);
    }
  }

  function getRunObservation(runId, { instanceId = "primary", turn = 0 } = {}) {
    const summary = summarizeRun(runId);
    if (!summary) return null;

    const requestedInstance = String(instanceId || "primary");
    const primary = requestedInstance === "primary";
    if (!primary && !/^[a-z0-9_-]{1,48}$/i.test(requestedInstance)) return null;

    const runDir = runDirFor(runId);
    const instanceDir = primary ? runDir : path.join(runDir, "swarm", requestedInstance);
    if (!primary && (!fs.existsSync(instanceDir) || !fs.statSync(instanceDir).isDirectory())) return null;

    const metadata = primary ? {} : loadJson(path.join(instanceDir, "worker.json"), {}) || {};
    const actionsPath = path.join(instanceDir, "actions.jsonl");
    const actionIndex = jsonLineIndexFor(actionsPath);
    const forkActionCount = primary ? 0 : Math.max(0, Number(metadata.fork_action_count) || 0);
    const total = Math.max(0, actionIndex.offsets.length - forkActionCount);
    const relativeTurn = Math.max(0, Math.min(total, Math.floor(Number(turn) || 0)));
    const absoluteTurn = forkActionCount + relativeTurn;
    const record = absoluteTurn > 0 ? readJsonLineAt(actionsPath, absoluteTurn - 1) : null;
    let status = record?.status || null;

    if (!status && absoluteTurn === 0) {
      status = loadJson(path.join(instanceDir, "initial-status.json"), null);
      if (!status) {
        const session = loadJson(path.join(instanceDir, "session.json"), null);
        status = session?.initial || session?.lastStatus || null;
      }
    }

    const mode = String(metadata.observation_mode || summary.mode || "text") === "vision" ? "vision" : "text";
    const frameName = `frame-${String(absoluteTurn).padStart(3, "0")}.png`;
    const exactFrame = path.join(instanceDir, "frames", frameName);
    let frameUrl = null;

    if (fs.existsSync(exactFrame)) {
      frameUrl = primary
        ? `/agent-runs/${encodeURIComponent(runId)}/files/frames/${frameName}`
        : `/agent-runs/${encodeURIComponent(runId)}/files/swarm/${encodeURIComponent(requestedInstance)}/frames/${frameName}`;
    } else if (primary && mode === "text") {
      const liveName = `live-${String(absoluteTurn).padStart(3, "0")}.png`;
      if (fs.existsSync(path.join(instanceDir, "frames", liveName))) {
        frameUrl = `/agent-runs/${encodeURIComponent(runId)}/files/frames/${liveName}`;
      }
    }

    return {
      instance_id: requestedInstance,
      label: primary ? "Primary" : String(metadata.label || requestedInstance),
      mode,
      turn: relativeTurn,
      absolute_turn: absoluteTurn,
      total,
      command_text: String(record?.command_text || ""),
      board: String(status?.level || ""),
      frame_url: frameUrl,
      current_room: String(status?.current_room || ""),
      gem_count: Math.max(0, Number(status?.gem_count) || 0),
      player: status?.player || null,
      yaw: Number(status?.yaw) || 0
    };
  }

  function getRunProgress(runId, { afterTurn = 0, logOffset = 0 } = {}) {
    const summary = summarizeRun(runId);

    if (!summary) {
      return null;
    }

    if (summary.status === "running") startLegacyClaudeSnapshots(runId);

    const log = readLogChunk(runId, logOffset);
    const instanceViews = readSwarmViews(runId);
    const instanceMetrics = readInstanceMetrics(runId);

    return {
      run: summary,
      actions: readActions(runId, Number(afterTurn) || 0),
      initial_player: readInitialPlayer(runId),
      log_chunk: log.chunk,
      log_offset: log.offset,
      token_usage: readTokenUsage(runId, summary),
      tool_activity: readToolActivity(runId, summary),
      reasoning: readReasoning(runId, summary.model),
      instance_activity: {
        active: instanceViews.filter((instance) => ["acting", "exploring"].includes(instance.activity)).length,
        ...instanceMetrics
      },
      swarm_views: instanceViews,
      vision_frame_url: summary.mode === "vision" ? latestVisionFrame(runId) : null,
      replay_progress: summary.has_video ? { phase: "done", percent: 100 } : readReplayProgress(runId)
    };
  }

  // ---- provider model catalogs ------------------------------------------
  // codex: read the Codex app's disk catalog on every request, then merge it
  //        into a last-known-good snapshot. The app can briefly rewrite its
  //        cache with an older/subset catalog; that must not make newly exposed
  //        models disappear from Maze Bench.
  // claude: help aliases plus the installed /model picker's static metadata.
  // prime: `prime inference models --output json` (needs `prime login`);
  //        results are cached and errors surface as a hint instead of a 500.
  const providerModelCache = new Map();
  const PROVIDER_MODEL_TTL_MS = 10 * 60 * 1000;
  const PROVIDER_MODEL_ERROR_TTL_MS = 60 * 1000;

  function modelCatalogCheckedAt() {
    return new Date().toISOString();
  }

  function readStableCodexCatalog() {
    if (stableCodexCatalog !== undefined) return stableCodexCatalog;
    const saved = loadJson(stableCodexCatalogPath, null);
    stableCodexCatalog = saved && Array.isArray(saved.models) ? saved : null;
    return stableCodexCatalog;
  }

  function mergeStableCodexCatalog(candidate) {
    const previous = readStableCodexCatalog();
    if (!candidate.models.length) return previous || candidate;
    const snapshot = { ...candidate };
    delete snapshot.checked_at;
    if (!previous?.models?.length) {
      stableCodexCatalog = snapshot;
    } else {
      const currentById = new Map(snapshot.models.map((model) => [model.id, model]));
      const previousById = new Map(previous.models.map((model) => [model.id, model]));
      const introducedIds = snapshot.models
        .map((model) => model.id)
        .filter((id) => !previousById.has(id));
      const candidateIsRegression = previous.models.some((model) => !currentById.has(model.id));
      const orderedIds = introducedIds.length
        ? [...snapshot.models.map((model) => model.id), ...previous.models.map((model) => model.id)]
        : previous.models.map((model) => model.id);
      const seen = new Set();
      const models = orderedIds
        .filter((id) => id && !seen.has(id) && seen.add(id))
        // If this is a subset regression, preserve the richer metadata too
        // (reasoning levels and fast-tier support), not only the model ids.
        .map((id) => candidateIsRegression
          ? previousById.get(id) || currentById.get(id)
          : currentById.get(id) || previousById.get(id))
        .filter(Boolean);

      stableCodexCatalog = {
        ...snapshot,
        models,
        updated_at: candidateIsRegression
          ? previous.updated_at || snapshot.updated_at
          : snapshot.updated_at || previous.updated_at
      };
    }

    if (JSON.stringify(stableCodexCatalog) !== JSON.stringify(previous)) {
      ensureDirectory(runsDir);
      const temporary = `${stableCodexCatalogPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(stableCodexCatalog, null, 2)}\n`, "utf8");
      fs.renameSync(temporary, stableCodexCatalogPath);
    }

    return stableCodexCatalog;
  }

  function codexModelCatalog() {
    const models = loadCodexModels().map((model) => ({
      id: model.slug,
      label: model.displayName,
      description: model.description,
      reasoning_levels: model.reasoningLevels.map((level) => level.effort),
      default_reasoning: model.defaultReasoning,
      fast: Boolean(model.fast)
    }));
    let updatedAt = "";

    try {
      const cache = JSON.parse(
        fs.readFileSync(path.join(process.env.HOME || "", ".codex", "models_cache.json"), "utf8")
      );
      updatedAt = String(cache.fetched_at || "");
    } catch (_error) {
      /* loadCodexModels reports the missing cache below */
    }

    const candidate = {
      models,
      source: "Codex live catalog",
      updated_at: updatedAt,
      checked_at: modelCatalogCheckedAt(),
      // The Codex app orders its catalog strongest-first.
      default_model_id: models[0]?.id || "",
      note: models.length
        ? "This is the model list available to the installed Codex app."
        : "No Codex model cache found (~/.codex/models_cache.json) — run the Codex app once, or type a model id."
    };
    const stable = mergeStableCodexCatalog(candidate);
    return {
      ...stable,
      checked_at: candidate.checked_at,
      default_model_id: stable.models[0]?.id || "",
      note: stable.models.length ? candidate.note : stable.note
    };
  }

  function claudeReasoningLevels(modelId) {
    const id = String(modelId || "").toLowerCase().replace(/\./g, "-");
    const supportsXhigh = /(?:^|-)claude-(?:fable-5|mythos-5|opus-4-(?:7|8)|sonnet-5)(?:-|$)/.test(`-${id}`);
    const supportsMax = supportsXhigh ||
      /(?:^|-)claude-(?:mythos-preview|opus-4-6|sonnet-4-6)(?:-|$)/.test(`-${id}`);
    const supportsEffort = supportsMax || /(?:^|-)claude-opus-4-5(?:-|$)/.test(`-${id}`);

    if (!supportsEffort) return [];
    return [
      "low",
      "medium",
      "high",
      ...(supportsXhigh ? ["xhigh"] : []),
      ...(supportsMax ? ["max"] : [])
    ];
  }

  function claudeModelCatalog() {
    // Claude Code has no JSON model-catalog command. Its help lists most aliases,
    // while the model picker metadata embedded in the installed CLI is more
    // complete (for example, current builds expose Haiku in /model but omit it
    // from the --model help example). Read both so this catalog follows the
    // installed CLI instead of maintaining a stale model list here.
    const help = spawnSync("claude", ["--help"], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024
    });
    const helpText = String(help.stdout || help.stderr || "");
    const aliasExample = helpText.match(/alias for the latest model[\s\S]{0,180}?\((?:e\.g\.\s*)?([^)]*)\)/i);
    const detectedAliases = aliasExample
      ? [...aliasExample[1].matchAll(/['"]([a-z][a-z0-9-]*)['"]/gi)].map((match) => match[1].toLowerCase())
      : [];

    const pickerLabels = new Map();
    const pickerModelIds = new Map();
    const executable = spawnSync("sh", ["-c", "command -v claude"], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 2000
    });
    const executablePath = String(executable.stdout || "").trim();

    if (executable.status === 0 && executablePath) {
      // `strings` lets us read the same static labels used by /model without
      // opening an interactive session, changing the user's default, or making
      // an API request. The awk filter keeps the 200MB+ executable out of memory.
      const pickerMetadata = spawnSync(
        "sh",
        [
          "-c",
          "LC_ALL=C strings \"$1\" | awk '/^Custom [[:alnum:]-]+ model$/ || /^[[:alnum:]-]+ [0-9]+([.][0-9]+)*([[:space:]]+-|[[:space:]]*$)/'",
          "claude-model-catalog",
          executablePath
        ],
        {
          encoding: "utf8",
          env: enrichedPathEnv(),
          timeout: 5000,
          maxBuffer: 2 * 1024 * 1024
        }
      );
      const metadataLines = String(pickerMetadata.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const pickerFamilies = [...new Set(metadataLines.flatMap((line) => {
        const match = line.match(/^Custom ([a-z][a-z0-9-]*) model$/i);
        return match ? [match[1]] : [];
      }))];

      for (const family of pickerFamilies) {
        const escapedFamily = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const versionPattern = new RegExp(`^${escapedFamily}\\s+(\\d+(?:\\.\\d+)*)\\s*(?:-|$)`, "i");
        const versions = metadataLines.flatMap((line) => {
          const match = line.match(versionPattern);
          return match ? [match[1]] : [];
        });
        versions.sort((left, right) => {
          const leftParts = left.split(".").map(Number);
          const rightParts = right.split(".").map(Number);
          const length = Math.max(leftParts.length, rightParts.length);
          for (let index = 0; index < length; index += 1) {
            const difference = (rightParts[index] || 0) - (leftParts[index] || 0);
            if (difference) return difference;
          }
          return 0;
        });

        const alias = family.toLowerCase();
        const version = versions[0];
        if (version) {
          pickerLabels.set(alias, `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`);
          pickerModelIds.set(alias, `claude-${alias}-${version.replace(/\./g, "-")}`);
        }
      }
    }

    const aliases = [...new Set([...detectedAliases, ...pickerLabels.keys()])]
      .filter((alias) => /^[a-z][a-z0-9-]*$/.test(alias));
    const descriptions = {
      fable: "Latest Fable tier — highest capability",
      opus: "Latest Opus tier — deep reasoning",
      sonnet: "Latest Sonnet tier — balanced speed and capability",
      haiku: "Latest Haiku tier — fastest responses"
    };
    const version = spawnSync("claude", ["--version"], {
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 5000
    });
    const versionText = String(version.stdout || "").trim().replace(/\s*\(Claude Code\)\s*$/i, "");

    return {
      models: aliases.map((alias) => ({
        id: alias,
        label: pickerLabels.get(alias) || `${alias.charAt(0).toUpperCase()}${alias.slice(1)} (latest)`,
        description: descriptions[alias] || `Latest model behind the ${alias} alias`,
        resolved_model_id: pickerModelIds.get(alias) || "",
        reasoning_levels: claudeReasoningLevels(pickerModelIds.get(alias) || "")
      })),
      source: versionText ? `Claude Code ${versionText}` : "Installed Claude Code CLI",
      checked_at: modelCatalogCheckedAt(),
      default_model_id: aliases[0] || "",
      // The CLI accepts this complete syntax set, but each model above carries
      // its own supported subset. For example, Haiku 4.5 has no effort control.
      reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
      reasoning_default: "",
      note: pickerLabels.size
        ? "Models and display versions detected from this installed Claude Code build. Aliases stay dynamic when Claude rolls them forward."
        : detectedAliases.length
          ? "Aliases detected from the installed CLI; this build did not expose exact picker labels."
          : "Claude Code did not expose a model list. Use Custom… for a full model id."
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
        source: "Prime CLI",
        checked_at: modelCatalogCheckedAt(),
        note: "The `prime` CLI is not installed — type a model id (e.g. openai/gpt-5-nano), or install it from docs.primeintellect.ai."
      };
    }

    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim().split("\n")[0];
      const authProblem = /401|token|login|unauthorized/i.test(detail);

      return {
        models: [],
        source: "Prime CLI",
        checked_at: modelCatalogCheckedAt(),
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
            vision: primeModelVision(id),
            created_at: Number(row.created) || 0,
            pricing: row.pricing && typeof row.pricing === "object"
              ? {
                  input: Number(row.pricing.input_usd_per_mtok),
                  output: Number(row.pricing.output_usd_per_mtok)
                }
              : null
          };
        })
        .filter((model) => model.id);

      return {
        models,
        source: "Prime Inference live catalog",
        checked_at: modelCatalogCheckedAt(),
        default_model_id: models[0]?.id || "",
        note: models.length
          ? `${models.length} live models. Prices are USD per million tokens; image support is inferred from the model id.`
          : "The Prime catalog came back empty — type a model id instead."
      };
    } catch (error) {
      return {
        models: [],
        source: "Prime CLI",
        checked_at: modelCatalogCheckedAt(),
        note: "Could not parse the Prime model catalog — type a model id instead."
      };
    }
  }

  function listProviderModels(provider, { fresh = false } = {}) {
    const normalized = String(provider || "").toLowerCase();

    if (!["codex", "claude", "prime"].includes(normalized)) {
      throw new Error(`Unknown provider "${provider}".`);
    }

    // Codex already maintains its own host-side cache. Always inspect it so
    // Maze Bench cannot add another ten minutes of staleness on top.
    if (normalized === "codex") {
      return codexModelCatalog();
    }

    const cached = fresh ? null : providerModelCache.get(normalized);

    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }

    const value = normalized === "claude" ? claudeModelCatalog() : primeModelCatalog();
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

    const unlimited = params.unlimited === true || params.unlimited === "true";
    const moves = unlimited ? null : Math.max(1, Math.min(MAX_LOCAL_MOVE_BUDGET, Number(params.moves) || 20));
    const gems =
      game.id === "maze"
        ? Math.max(1, Math.min(1000, Number(params.gems) || 100))
        : Math.max(1, buildWorlds.countWorldGems(game) || 1);
    const view = VIEW_NAMES.includes(String(params.view)) ? String(params.view) : "top-diagonal";
    const wantContainer = !(params.container === false || params.container === "false");
    const wantTools = params.tools === true || params.tools === "true";
    const requestedToolUse = String(params.tool_use || "").trim().toLowerCase();
    const toolUse = ["read-only", "offline"].includes(requestedToolUse)
      ? requestedToolUse
      : wantTools
        ? "offline"
        : "read-only";
    const swarm = params.swarm === true || params.swarm === "true";
    const allowQuit = !(params.allow_quit === false || params.allow_quit === "false");

    // Safety net for the UI toggle: container mode needs Docker installed AND
    // its daemon running.
    if (wantContainer && !dockerAvailable()) {
      throw new Error(
        dockerInstalled()
          ? "Container mode needs the Docker daemon running. Start Docker, or switch to Host access."
          : "Container mode needs Docker, which is not installed. Switch to Host access, or install Docker."
      );
    }
    const args = [
      `model=${model}`,
      `game=${game.id}`,
      `level=${levelId}`,
      `moves=${unlimited ? "unlimited" : moves}`,
      `unlimited=${unlimited ? "true" : "false"}`,
      `allow_quit=${allowQuit ? "true" : "false"}`,
      `gems=${gems}`,
      `view=${view}`,
      `mode=${String(params.mode) === "vision" ? "vision" : "text"}`,
      `tools=${toolUse === "read-only" ? "false" : "true"}`,
      `tool_use=${toolUse}`,
      `swarm=${swarm ? "true" : "false"}`,
      `container=${params.container === false || params.container === "false" ? "false" : "true"}`,
      `video=${params.video === false || params.video === "false" ? "off" : "on"}`,
      `out=${runDirFor(runId)}`
    ];

    // Vision view distance: 1-26 rings of neighbor rooms or "world". Unset
    // keeps the classic 3x3 window the benchmark defaults to.
    if (params.vision_view !== undefined && String(params.vision_view).trim() !== "") {
      const rawView = String(params.vision_view).trim().toLowerCase();
      const rings = Number(rawView);
      const visionView =
        rawView === "world"
          ? "world"
          : Number.isFinite(rings)
            ? Math.max(1, Math.min(26, Math.floor(rings)))
            : null;

      if (visionView !== null) {
        args.push(`vision_view=${visionView}`);
      }
    }

    if (params.model_name) {
      args.push(`model_name=${String(params.model_name)}`);
    }

    if (params.reasoning) {
      const reasoning = String(params.reasoning).toLowerCase();

      if (model === "claude") {
        const exactModelId = resolveClaudeCatalogModelId(params.model_name);
        const supported = claudeReasoningLevels(exactModelId);

        if (exactModelId.startsWith("claude-") && !supported.includes(reasoning)) {
          throw new Error(
            supported.length
              ? `${exactModelId} supports Claude effort: ${supported.join(", ")}.`
              : `${exactModelId} does not support Claude effort. Choose off.`
          );
        }
      }

      args.push(`reasoning=${reasoning}`);
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

    // Continue: resume the maze from a prior run's exact state. Both the runner
    // and the bridge rebuild state by replaying the action list, so copying the
    // prior session (and its per-move log) is enough — maze-agent-local.js sees
    // seed=true, skips the fresh `start`, and plays `moves` more from there.
    if (params.seed_run) {
      const priorDir = runDirFor(String(params.seed_run));
      const priorSession = path.join(priorDir, "session.json");

      if (fs.existsSync(priorSession)) {
        fs.copyFileSync(priorSession, path.join(runDirFor(runId), "session.json"));

        const priorActions = path.join(priorDir, "actions.jsonl");
        if (fs.existsSync(priorActions)) {
          fs.copyFileSync(priorActions, path.join(runDirFor(runId), "actions.jsonl"));
        }

        args.push("seed=true");
      }
    }

    // In-place continue: the session.json already lives in this run's dir, so
    // just resume the conversation (which also implies skipping the fresh start).
    if (params.resume_id) {
      args.push(`resume=${String(params.resume_id)}`);
    }

    return { args, model, levelId, moves, gems, view, toolUse, swarm, unlimited, allowQuit };
  }

  // Prime text runs are real Hosted Evaluations, visible in Prime Evals from
  // launch through completion. Vision keeps using the local v1 evaluator until
  // the published environment has a self-contained Chromium renderer.
  function buildPrimeCommand(params, runDir, runId, game) {
    const model = String(params.model_name || params.model || "").trim();
    const maxTurns = Math.max(1, Math.min(500, Number(params.max_turns) || 20));
    const vision = params.vision === true || params.vision === "true";
    const hosted = !vision;
    const wantVideo = !(params.video === false || params.video === "false");
    const allowQuit = !(params.allow_quit === false || params.allow_quit === "false");
    // Reasoning effort → --sampling.reasoning-effort. OpenAI reasoning models and
    // Claude (extended thinking) honor it; others ignore it. "" = don't send one.
    const reasoning = ["low", "medium", "high"].includes(String(params.reasoning))
      ? String(params.reasoning)
      : "";
    const envDir = path.join(rootDir, "environments", "mazebench");
    const levelId = String(params.level_id || "level_HxI");
    const gemTotal = buildWorlds.countWorldGems(game);

    const argv = [
      primeRunnerScript,
      "--env-dir",
      envDir,
      "--out",
      runDir,
      "--run-id",
      runId,
      "--level",
      levelId,
      "--game-won-gem-count",
      String(gemTotal),
      "--max-turns",
      String(maxTurns)
    ];

    if (hosted) {
      argv.push("--hosted", "--environment", "mazebench/mazebench");
    }

    if (model) {
      argv.push("--model", model);
    }

    if (vision) {
      argv.push("--vision");
    }

    if (reasoning) {
      argv.push("--reasoning", reasoning);
    }

    if (!allowQuit) {
      argv.push("--no-quit");
    }

    if (!wantVideo) {
      argv.push("--no-video");
    }

    // A readable command string for the run page / logs (not the resolved path).
    const display = ["node", "scripts/maze-prime-run.js"]
      .concat(hosted ? ["--hosted"] : [])
      .concat(["--out", "<run>", "--max-turns", String(maxTurns)])
      .concat(model ? ["--model", model] : [])
      .concat(vision ? ["--vision"] : [])
      .concat(reasoning ? ["--reasoning", reasoning] : [])
      .concat(!allowQuit ? ["--no-quit"] : [])
      .join(" ");

    return {
      bin: process.execPath,
      argv,
      display,
      model,
      maxTurns,
      vision,
      hosted,
      levelId,
      gemTotal,
      reasoning,
      allowQuit,
      video: wantVideo
    };
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
        const game = normalizedGameForRun("maze");
        const command = buildPrimeCommand(params, runDir, runId, game);

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
          level_id: command.levelId,
          gem_total: command.gemTotal,
          room_total: game.worldMap?.levels?.length || 0,
          moves: command.maxTurns,
          mode: command.vision ? "vision" : "text",
          vision: command.vision,
          reasoning: command.reasoning,
          allow_quit: command.allowQuit,
          video: command.video,
          launch_params: launchParamsOf(params),
          continue_of: params.continue_of || null,
          prime_execution: command.hosted ? "hosted" : "local",
          note: command.hosted
            ? "Prime Hosted Evaluation. The evaluation ID and dashboard link appear as soon as Prime accepts the run; scored samples and replay artifacts sync back after completion."
            : "Local Prime Verifiers vision evaluation. Hosted vision will replace this path once the published renderer is self-contained."
        };
      } else {
        const game = normalizedGameForRun(params.game_id);
        const { args, model, levelId, moves, gems, view, toolUse, swarm, unlimited, allowQuit } = buildLocalRunArgs(runId, params, game);
        const requestedModelName = String(params.model_name || "");
        const exactModelName = model === "claude"
          ? resolveClaudeCatalogModelId(requestedModelName)
          : requestedModelName;
        const gemTotal = buildWorlds.countWorldGems(game);
        const roomTotal = game.worldMap?.levels?.length || 0;

        const shouldWait = model === "claude" && (claudeSlotOccupied() || waitingClaudeRuns().length > 0);
        if (!shouldWait) {
          child = spawn(process.execPath, [runnerScript, ...args], {
            cwd: rootDir,
            detached: true,
            env: enrichedPathEnv(),
            stdio: ["ignore", logFd, logFd]
          });
        }
        meta = {
          id: runId,
          kind: "local",
          created_at: new Date().toISOString(),
          status: shouldWait ? "waiting" : "running",
          pid: child?.pid || null,
          command: ["node", "scripts/maze-agent-local.js", ...args].join(" "),
          model,
          model_name: exactModelName,
          model_alias: exactModelName !== requestedModelName ? requestedModelName : "",
          reasoning: params.reasoning || "",
          game_id: game.id,
          game_title: game.name,
          level_id: levelId,
          gem_total: gemTotal,
          room_total: roomTotal,
          moves,
          unlimited,
          allow_quit: allowQuit,
          segment_start_turns: readActions(runId).length,
          segment_move_budget: moves,
          gems,
          view,
          mode: String(params.mode) === "vision" ? "vision" : "text",
          tools: toolUse !== "read-only",
          tool_use: toolUse,
          swarm,
          container: !(params.container === false || params.container === "false"),
          video: !(params.video === false || params.video === "false"),
          launch_params: launchParamsOf(params),
          continue_of: params.continue_of || null,
          seeded: Boolean(params.seed_run),
          conversation_persistence: !(params.container === false || params.container === "false")
            ? "run-dir"
            : "cli"
        };
        if (shouldWait) {
          meta = queuedLocalRunMeta(meta, args);
        }
      }
    } catch (error) {
      fs.closeSync(logFd);
      fs.rmSync(runDir, { recursive: true, force: true });
      throw error;
    }

    fs.closeSync(logFd);
    meta.active_started_at = child ? meta.created_at : null;
    meta.active_elapsed_ms = 0;
    writeRunMeta(runId, meta);
    if (child) attachRunChild(runId, child);
    else startNextWaitingClaudeRun();
    return summarizeRun(runId);
  }

  // Track a spawned run child and resolve its final status on exit. Shared by a
  // fresh launch and an in-place continue (which re-spawns into the same dir).
  function attachRunChild(runId, child) {
    child.unref();
    liveChildren.set(runId, child);
    child.on("exit", (code) => {
      liveChildren.delete(runId);
      const current = readRunMeta(runId);

      if (!current) {
        return;
      }

      if (current.status === "stopped") {
        return;
      }

      // A manual pause SIGSTOPs the process without killing it; ignore any exit
      // that races with that (the resume path drives the status instead).
      if (current.status === "paused") {
        return;
      }

      let updated;
      if (current.status === "pausing") {
        // The provider saw the saved action result and ended its turn itself.
        // Its run-scoped transcript and maze files remain mounted in the run
        // directory; only the disposable process/container is released.
        stopLegacyClaudeSnapshots(runId);
        stopLiveRenderer(runId, { force: true });
        stopDetachedRunRenderers(runId, { force: true });
        updated = coldPausedRunMeta(current, { exit_code: code });
      } else if (current.status === "stopping") {
        // A user stop is terminal even when Docker/provider shutdown is clean
        // and therefore exits 0. Never relabel an explicitly stopped run as
        // naturally finished (or auto-continue it).
        updated = terminalRunMeta(current, "stopped", { exit_code: code });
      } else if (readProviderFailure(runId)) {
        // Claude Code can emit a structured API error while still exiting 0.
        // Treat the event artifact as authoritative, release the provider slot,
        // and retry this same saved thread after a resource-free backoff.
        updated = providerBackoffMeta(runId, current, readProviderFailure(runId), code);
      } else if (code === 0) {
        const continued = autoContinueBudgetTarget(runId, current);
        if (continued) return;
        updated = terminalRunMeta(current, "finished", { exit_code: code });
      } else {
        // Non-zero exit that isn't a user stop: if it's an out-of-funds/credits/
        // usage error, auto-pause (resumable) rather than fail it outright.
        const quota = detectQuotaPause(runId);
        const now = new Date().toISOString();
        updated = quota
          ? {
              ...current,
              status: "paused",
              pause_reason: "quota",
              pause_message: quota.message,
              exit_code: code,
              paused_at: now,
              active_elapsed_ms: activeElapsedMs(current, Date.parse(now)),
              active_started_at: null
            }
          : terminalRunMeta(current, "failed", { exit_code: code, finished_at: now });
      }
      writeRunMeta(runId, updated);
      if (current.model === "claude") startNextWaitingClaudeRun();
    });
    child.on("error", (error) => {
      liveChildren.delete(runId);
      const current = readRunMeta(runId);
      if (!current || current.status === "paused") return;
      if (current.status === "pausing") {
        writeRunMeta(
          runId,
          coldPausedRunMeta(current, { pause_message: error instanceof Error ? error.message : String(error) })
        );
        return;
      }
      writeRunMeta(
        runId,
        terminalRunMeta(current, "failed", { launch_error: error instanceof Error ? error.message : String(error) })
      );
      if (current.model === "claude") startNextWaitingClaudeRun();
    });
  }

  // Strip internal orchestration keys so meta.launch_params holds just the
  // config, ready to relaunch verbatim for a Continue.
  function launchParamsOf(params) {
    const { count, seed_run, continue_of, ...rest } = params || {};
    return rest;
  }

  // Launch N runs of the same config at once. Claude Code runs after the first
  // are persisted as FIFO waiters and started one at a time.
  function launchRuns(params = {}) {
    const count = Math.max(1, Math.min(8, Math.floor(Number(params.count) || 1)));

    const runs = [];
    for (let index = 0; index < count; index += 1) {
      runs.push(launchRun(params));
    }
    return runs;
  }

  function pauseRun(runId) {
    const meta = readRunMeta(runId);

    if (!meta) {
      throw new Error(`Unknown run "${runId}".`);
    }

    if (["paused", "pausing"].includes(meta.status)) {
      return summarizeRun(runId);
    }

    if (meta.status !== "running") return summarizeRun(runId);

    if (meta.kind === "prime") {
      throw new Error("Prime Intellect runs cannot be paused. Cancel the run instead.");
    }

    const coldPauseReady =
      meta.container === false ||
      fs.existsSync(path.join(runDirFor(runId), PAUSE_CAPABILITY_FILE));
    if (!coldPauseReady) {
      // A container launched from an older image cannot see the boundary marker.
      // Preserve it with the legacy hot pause rather than pretending a cold
      // pause is safe; its next relaunch will use the current cold-pause image.
      stopLiveRenderer(runId, { force: true });
      dockerRunControl(runId, ["pause"], "pause");
      snapshotLegacyClaudeConversation(runId, meta, { force: true });
      const pausedAt = new Date().toISOString();
      writeRunMeta(runId, {
        ...meta,
        status: "paused",
        pause_reason: "manual",
        pause_mode: "hot-legacy",
        paused_at: pausedAt,
        active_elapsed_ms: activeElapsedMs(meta, Date.parse(pausedAt)),
        active_started_at: null
      });
      return summarizeRun(runId);
    }

    const turns = readActions(runId).length;
    const requestedAt = new Date().toISOString();
    clearColdPauseMarkers(runId);
    fs.writeFileSync(
      path.join(runDirFor(runId), PAUSE_REQUEST_FILE),
      `${JSON.stringify({ requested_at: requestedAt, requested_after_turn: turns }, null, 2)}\n`
    );
    writeRunMeta(runId, {
      ...meta,
      status: "pausing",
      pause_reason: "manual",
      pause_mode: "cold",
      pause_requested_at: requestedAt,
      pause_after_turn: turns + 1
    });
    return summarizeRun(runId);
  }

  function resumeRun(runId) {
    let meta = readRunMeta(runId);

    if (!meta) {
      throw new Error(`Unknown run "${runId}".`);
    }

    if (meta.status !== "paused") {
      return summarizeRun(runId);
    }

    meta = discardRunVideo(runId, meta);

    const needsRelaunch =
      ["quota", "provider_backoff"].includes(meta.pause_reason) ||
      meta.pause_mode === "cold" ||
      (!pidAlive(meta.pid) && !(meta.container && dockerRunAlive(runId)));

    if (!needsRelaunch && meta.container) {
      dockerRunControl(runId, ["unpause"], "resume");
      const { pause_reason, pause_message, pause_mode, pause_requested_at, pause_after_turn, paused_at, ...rest } = meta;
      writeRunMeta(runId, {
        ...rest,
        status: "running",
        active_started_at: new Date().toISOString(),
        active_elapsed_ms: activeElapsedMs(meta)
      });
      startLegacyClaudeSnapshots(runId);
      return summarizeRun(runId);
    }

    // A manually-paused run still has a live (stopped) process — just continue it.
    if (!needsRelaunch && pidAlive(meta.pid)) {
      signalRunProcess(meta, "SIGCONT");

      if (pidAlive(meta.pid)) {
        const { pause_reason, pause_message, pause_mode, pause_requested_at, pause_after_turn, paused_at, ...rest } = meta;
        writeRunMeta(runId, {
          ...rest,
          status: "running",
          active_started_at: new Date().toISOString(),
          active_elapsed_ms: activeElapsedMs(meta)
        });
        startLegacyClaudeSnapshots(runId);
        return summarizeRun(runId);
      }
    }

    // A quota/provider backoff pause (or a process that died while paused) has no process to
    // resume, so relaunch a continuation from where it left off with whatever
    // move budget remains.
    const summary = summarizeRun(runId);
    const remaining = Math.max(1, (Number(meta.moves) || 20) - (summary.turns || 0));
    return continueRun(runId, remaining);
  }

  // Rebuild launch params from a run's own metadata — the fallback for runs
  // created before launch_params was recorded, so any run can still be continued.
  function reconstructParams(meta) {
    if (meta.kind === "prime") {
      const model = meta.model_name && meta.model_name !== "(prime default)" ? meta.model_name : "";
      return {
        kind: "prime",
        model_name: model,
        vision: meta.mode === "vision",
        reasoning: meta.reasoning || "",
        allow_quit: meta.allow_quit !== false,
        video: meta.video !== false
      };
    }

    return {
      kind: "local",
      model: meta.model,
      model_name: meta.model_name || "",
      game_id: meta.game_id,
      level_id: meta.level_id,
      mode: meta.mode,
      reasoning: meta.reasoning || "",
      unlimited: Boolean(meta.unlimited),
      allow_quit: meta.allow_quit !== false,
      container: meta.container !== false,
      video: meta.video !== false,
      tools: Boolean(meta.tools),
      tool_use: ["read-only", "offline"].includes(meta.tool_use)
        ? meta.tool_use
        : meta.tools
          ? "offline"
          : "read-only",
      swarm: Boolean(meta.swarm),
      gems: meta.gems,
      view: meta.view
    };
  }

  // The CLI conversation id captured in a run's event stream — codex emits
  // `thread.started` with a thread_id, claude tags every event with session_id.
  function readConversationId(runId) {
    const eventsPath = path.join(runDirFor(runId), "agent-events.jsonl");

    if (!fs.existsSync(eventsPath)) {
      return "";
    }

    for (const line of fs.readFileSync(eventsPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        const id = event.thread_id || event.session_id;
        if (id) return String(id);
      } catch (_error) {
        /* skip non-JSON lines */
      }
    }

    return "";
  }

  function hasPersistedContainerConversation(runId, meta, conversationId) {
    if (!meta.container || !conversationId) return false;
    const stateRoot = path.join(runDirFor(runId), "agent-state");

    if (meta.model === "codex") {
      return Boolean(findCodexSessionFile(path.join(stateRoot, "codex"), conversationId));
    }

    if (meta.model === "claude") {
      return Boolean(findClaudeSessionFile(path.join(stateRoot, "claude"), conversationId));
    }

    return false;
  }

  // A true continue: re-spawn the agent into the SAME run dir with the CLI
  // conversation resumed, so the model keeps its full memory and the maze keeps
  // its state (both live here). The run itself is extended in place.
  function continueLocalInPlace(runId, meta, add, conversationId) {
    const runDir = runDirFor(runId);
    clearColdPauseMarkers(runId);
    clearColdPauseCapability(runId);
    const segmentStartTurns = readActions(runId).length;
    const params = meta.launch_params || reconstructParams(meta);
    const game = normalizedGameForRun(params.game_id);
    const { args } = buildLocalRunArgs(runId, { ...params, moves: add, resume_id: conversationId }, game);
    const nextMeta = {
      ...meta,
      moves: meta.unlimited ? null : (Number(meta.moves) || 0) + Number(add || 0),
      continued: (meta.continued || 0) + 1,
      segment_start_turns: segmentStartTurns,
      segment_move_budget: meta.unlimited ? null : add,
      command: ["node", "scripts/maze-agent-local.js", ...args].join(" ")
    };

    if (meta.model === "claude" && (claudeSlotOccupied(runId) || waitingClaudeRuns(runId).length > 0)) {
      writeRunMeta(runId, queuedLocalRunMeta(nextMeta, args));
      startNextWaitingClaudeRun();
      return summarizeRun(runId);
    }

    const logFd = fs.openSync(path.join(runDir, "launcher.log"), "a");
    let child;

    try {
      child = spawn(process.execPath, [runnerScript, ...args], {
        cwd: rootDir,
        detached: true,
        env: enrichedPathEnv(),
        stdio: ["ignore", logFd, logFd]
      });
    } finally {
      fs.closeSync(logFd);
    }

    writeRunMeta(runId, {
      ...nextMeta,
      status: "running",
      pid: child.pid,
      exit_code: undefined,
      finished_at: undefined,
      pause_reason: undefined,
      pause_message: undefined,
      pause_mode: undefined,
      pause_requested_at: undefined,
      pause_after_turn: undefined,
      paused_at: undefined,
      retry_at: undefined,
      active_started_at: new Date().toISOString(),
      active_elapsed_ms: activeElapsedMs(meta)
    });
    attachRunChild(runId, child);
    return summarizeRun(runId);
  }

  function setRunMoveTarget(runId, requestedTarget) {
    const meta = readRunMeta(runId);
    if (!meta) throw new Error(`Unknown run "${runId}".`);
    if (meta.kind === "prime") throw new Error("Prime eval budgets cannot be changed while running.");

    const turns = readActions(runId).length;
    const requested = Math.floor(Number(requestedTarget));
    if (!Number.isFinite(requested) || requested <= turns) {
      throw new Error(`Move target must be greater than the ${turns} actions already played.`);
    }
    const target = Math.min(MAX_LOCAL_MOVE_BUDGET, requested);

    const next = {
      ...meta,
      moves: target,
      unlimited: false,
      auto_continue_target: target,
      segment_start_turns: Math.max(0, Math.floor(Number(meta.segment_start_turns) || 0)),
      segment_move_budget: Math.max(1, Math.floor(Number(meta.segment_move_budget) || Number(meta.moves) || 20)),
      launch_params: {
        ...(meta.launch_params || reconstructParams(meta)),
        moves: target,
        unlimited: false
      }
    };
    writeRunMeta(runId, next);
    return summarizeRun(runId);
  }

  function continueRun(runId, additionalMoves) {
    const meta = readRunMeta(runId);

    if (!meta) {
      throw new Error(`Unknown run "${runId}".`);
    }

    const add = Math.max(1, Math.min(MAX_LOCAL_MOVE_BUDGET, Math.floor(Number(additionalMoves) || 20)));

    if (meta.kind === "prime") {
      // Verifiers plays one fresh rollout per run, so "continue" gives the model
      // a bigger total budget on the same maze rather than resuming mid-state.
      const base = { ...(meta.launch_params || reconstructParams(meta)), continue_of: runId, kind: "prime" };
      base.max_turns = Math.max(1, Math.min(500, (Number(meta.moves) || 0) + add));
      return launchRun(base);
    }

    // Resume the same CLI conversation in the same run directory. Host agents
    // use their normal CLI session store; new Docker runs keep a private,
    // run-scoped session store under agent-state/ and mount it into every
    // replacement container. Older Docker runs without that store fall back to
    // a maze-state-only continuation because their model transcript is gone.
    const conversationId = readConversationId(runId);
    const canResumeConversation =
      Boolean(conversationId) &&
      (meta.container === false || hasPersistedContainerConversation(runId, meta, conversationId));
    if (canResumeConversation) {
      return continueLocalInPlace(runId, discardRunVideo(runId, meta), add, conversationId);
    }

    const base = {
      ...(meta.launch_params || reconstructParams(meta)),
      continue_of: runId,
      kind: "local",
      moves: add,
      seed_run: runId
    };
    return launchRun(base);
  }

  function generateRunVideo(runId) {
    const meta = readRunMeta(runId);

    if (!meta) {
      throw new Error(`Unknown run "${runId}".`);
    }

    if (!["paused", "finished", "stopped"].includes(meta.status)) {
      throw new Error("Pause or finish the run before generating a replay video.");
    }

    const runDir = runDirFor(runId);
    const videoPath = path.join(runDir, "maze_replay.mp4");
    if (fs.existsSync(videoPath)) {
      return summarizeRun(runId);
    }

    const activeVideo = videoChildren.get(runId);
    if (activeVideo || (meta.video_status === "rendering" && pidAlive(meta.video_pid))) {
      return summarizeRun(runId);
    }

    const sessionPath = path.join(runDir, "session.json");
    const resultsPath = findPrimeResultsFile(runDir);
    if (!fs.existsSync(sessionPath) && !resultsPath) {
      throw new Error("This run has no saved session or eval result to render.");
    }

    const snapshotTurns = readActions(runId).length;
    const generationId = crypto.randomUUID();
    fs.writeFileSync(
      path.join(runDir, "replay-progress.json"),
      `${JSON.stringify({ phase: "starting", percent: 0, current: 0, total: snapshotTurns, unit: "actions", eta_ms: null })}\n`
    );

    const logFd = fs.openSync(path.join(runDir, "launcher.log"), "a");
    let child;
    try {
      const videoArgs = [
        replayScript,
        runDir,
        "--out-dir", runDir,
        "--fps", "24",
        "--crf", "19",
        "--preset", "veryfast",
        "--tail-seconds", "1",
        "--accelerated",
        "--intro"
      ];
      if (meta.mode === "text") {
        videoArgs.push("--width", "1280", "--height", "720", "--ascii-side-by-side");
      } else {
        videoArgs.push("--width", "960", "--height", "960");
      }
      child = spawn(
        process.execPath,
        videoArgs,
        {
          cwd: rootDir,
          detached: true,
          env: enrichedPathEnv(),
          stdio: ["ignore", logFd, logFd]
        }
      );
    } finally {
      fs.closeSync(logFd);
    }

    const { video_error: _previousVideoError, ...cleanMeta } = meta;
    writeRunMeta(runId, {
      ...cleanMeta,
      video_generation_id: generationId,
      video_pid: child.pid,
      video_snapshot_turns: snapshotTurns,
      video_status: "rendering"
    });

    child.unref();
    videoChildren.set(runId, child);
    let settled = false;
    const finish = (code, spawnError = null) => {
      if (settled) return;
      settled = true;
      videoChildren.delete(runId);
      const current = readRunMeta(runId);
      if (!current || current.video_generation_id !== generationId) return;

      const rendered = fs.existsSync(videoPath);
      const { video_pid: _videoPid, ...rest } = current;
      writeRunMeta(runId, {
        ...rest,
        video_generation_id: undefined,
        video_status: rendered ? "ready" : "failed",
        ...(rendered
          ? { video_error: undefined }
          : { video_error: spawnError?.message || `Video renderer exited with status ${code ?? "unknown"}.` })
      });
    };
    child.on("exit", (code) => finish(code));
    child.on("error", (error) => finish(null, error));

    return summarizeRun(runId);
  }

  function discardRunVideo(runId, meta = readRunMeta(runId)) {
    if (!meta) return meta;
    const runDir = runDirFor(runId);
    const activeVideo = videoChildren.get(runId);
    const hasArtifacts = Boolean(
      activeVideo ||
      meta.video_status ||
      meta.video_pid ||
      fs.existsSync(path.join(runDir, "maze_replay.mp4")) ||
      fs.existsSync(path.join(runDir, "replay-progress.json"))
    );
    if (!hasArtifacts) return meta;

    const terminateRenderer = (pid) => {
      try {
        process.kill(-pid, "SIGTERM");
      } catch (_error) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (_innerError) {
          /* renderer already exited */
        }
      }
      const forceTimer = setTimeout(() => {
        if (!/maze-export-replay\.js/.test(processCommand(pid))) return;
        try {
          process.kill(-pid, "SIGKILL");
        } catch (_error) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (_innerError) {
            /* renderer already exited */
          }
        }
      }, 3500);
      forceTimer.unref?.();
    };
    if (activeVideo?.pid) {
      terminateRenderer(activeVideo.pid);
    } else if (meta.video_pid && pidAlive(meta.video_pid)) {
      terminateRenderer(meta.video_pid);
    }
    videoChildren.delete(runId);
    fs.rmSync(path.join(runDir, "maze_replay.mp4"), { force: true });
    fs.rmSync(path.join(runDir, "replay-progress.json"), { force: true });
    fs.rmSync(path.join(runDir, ".maze_replay_frames"), { force: true, recursive: true });

    const {
      video_error: _videoError,
      video_generation_id: _videoGenerationId,
      video_pid: _videoPid,
      video_snapshot_turns: _videoSnapshotTurns,
      video_status: _videoStatus,
      ...cleanMeta
    } = meta;
    writeRunMeta(runId, cleanMeta);
    return cleanMeta;
  }

  function cancelRunVideo(runId) {
    const meta = readRunMeta(runId);
    if (!meta) throw new Error(`Unknown run "${runId}".`);
    if (meta.video_status !== "rendering" && !videoChildren.has(runId)) {
      return summarizeRun(runId);
    }
    discardRunVideo(runId, meta);
    return summarizeRun(runId);
  }

  function regenerateRunVideo(runId) {
    const meta = readRunMeta(runId);
    if (!meta) throw new Error(`Unknown run "${runId}".`);
    if (!["paused", "finished", "stopped"].includes(meta.status)) {
      throw new Error("Pause or finish the run before regenerating its replay video.");
    }
    discardRunVideo(runId, meta);
    return generateRunVideo(runId);
  }

  function cancelPrimeEvaluation(runId) {
    const state = readPrimeEvaluation(runId);
    const evaluationId = String(state?.evaluation_id || state?.id || "");
    const status = String(state?.status || "").toUpperCase();
    if (!evaluationId || ["CANCELLED", "COMPLETED", "FAILED", "STOPPED"].includes(status)) return false;

    const result = spawnSync("prime", ["eval", "stop", evaluationId, "--plain"], {
      cwd: rootDir,
      encoding: "utf8",
      env: enrichedPathEnv(),
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024
    });
    const updated = {
      ...state,
      status: result.status === 0 ? "STOPPED" : state.status,
      stopped_at: result.status === 0 ? new Date().toISOString() : state.stopped_at,
      ...(result.status === 0
        ? { stop_error: undefined }
        : { stop_error: String(result.stderr || result.stdout || "Prime evaluation cancellation failed.").trim() })
    };
    fs.writeFileSync(
      path.join(runDirFor(runId), "prime-evaluation.json"),
      `${JSON.stringify(updated, null, 2)}\n`,
      "utf8"
    );
    return result.status === 0;
  }

  function deleteRun(runId) {
    const meta = readRunMeta(runId);
    const runDir = runDirFor(runId);

    if (meta?.kind === "prime" && ["running", "stopping"].includes(meta.status)) {
      cancelPrimeEvaluation(runId);
    }

    // Remove the daemon-owned container first; killing only the attached docker
    // client can otherwise leave the agent running after its card disappears.
    if (meta?.container && meta.status !== "waiting") {
      try {
        dockerRunControl(runId, ["rm", "-f"], "delete", { required: false });
      } catch (_error) {
        /* the container may already have exited and removed itself */
      }
    }

    // Kill any still-live (or paused) host process before removing its directory.
    if (meta && meta.pid && pidAlive(meta.pid)) {
      signalRunProcess(meta, "SIGKILL");
    }

    const videoChild = videoChildren.get(runId);
    if (videoChild?.pid) {
      try {
        process.kill(-videoChild.pid, "SIGKILL");
      } catch (_error) {
        try {
          process.kill(videoChild.pid, "SIGKILL");
        } catch (_innerError) {
          /* renderer already exited */
        }
      }
      videoChildren.delete(runId);
    }

    liveChildren.delete(runId);
    stopLegacyClaudeSnapshots(runId);
    stopLiveRenderer(runId);
    initialPlayerCache.delete(runId);
    for (const filePath of jsonLineIndexes.keys()) {
      if (filePath.startsWith(`${runDir}${path.sep}`)) jsonLineIndexes.delete(filePath);
    }
    fs.rmSync(runDir, { recursive: true, force: true });
    if (meta?.model === "claude") startNextWaitingClaudeRun();
    return { id: runId, deleted: true };
  }

  function stopRun(runId) {
    const meta = readRunMeta(runId);

    if (!meta) {
      throw new Error(`Unknown run "${runId}".`);
    }

    // Local providers have one resumable lifecycle control. "Stop" is kept as
    // an API compatibility alias, but it now requests the same action-boundary
    // cold pause. Prime rollouts remain cancellable because they cannot resume.
    if (meta.kind !== "prime" && ["running", "pausing", "paused"].includes(meta.status)) {
      return pauseRun(runId);
    }

    const terminalButAlive = !["running", "stopping", "paused"].includes(meta.status) &&
      (pidAlive(meta.pid) || (meta.container && dockerRunAlive(runId)));
    if (
      meta.status !== "running" &&
      meta.status !== "stopping" &&
      !(meta.status === "paused" && meta.pause_reason === "manual") &&
      !terminalButAlive
    ) {
      if (meta.status === "stopped") {
        // Stop is idempotent and doubles as a cleanup sweep. This matters when
        // a server restart observed the dead runner and finalized metadata
        // before it could reap detached renderers or their marker files.
        stopLegacyClaudeSnapshots(runId);
        stopLiveRenderer(runId, { force: true });
        stopDetachedRunRenderers(runId, { force: true });
        if (meta.container) {
          try {
            dockerRunControl(runId, ["rm", "-f"], "clean up", { required: false });
          } catch (_error) {
            /* already removed */
          }
        }
        signalRunProcess(meta, "SIGKILL");
      }
      return summarizeRun(runId);
    }

    writeRunMeta(runId, { ...meta, status: "stopping" });
    if (meta.kind === "prime") cancelPrimeEvaluation(runId);
    stopLegacyClaudeSnapshots(runId);
    stopLiveRenderer(runId, { force: true });

    if (meta.container) {
      if (meta.status === "paused") {
        // Docker requires a paused container to be unpaused before graceful stop.
        try {
          dockerRunControl(runId, ["unpause"], "resume before stopping");
        } catch (_error) {
          /* it may already have resumed or exited */
        }
      }

      try {
        dockerRunControl(runId, ["stop", "-t", "2"], "stop", { required: false });
      } catch (_error) {
        // If graceful stop failed, force-remove the whole container so daemon-
        // owned descendants cannot survive their attached docker client.
        try {
          dockerRunControl(runId, ["rm", "-f"], "force stop", { required: false });
        } catch (_innerError) {
          /* already removed or Docker is unavailable */
        }
      }
    } else if (meta.status === "paused") {
      signalRunProcess(meta, "SIGCONT");
    }

    // Docker owns everything inside a container. Host vision daemons are
    // detached by design, so clean their process groups explicitly too.
    stopDetachedRunRenderers(runId, { force: true });

    // Stop is intentionally final, not graceful pausing. Force-reap the outer
    // process group after Docker/provider cleanup so no shell, solver, worker,
    // or fallback renderer can linger. Record the terminal state immediately;
    // a late child exit callback explicitly preserves it.
    signalRunProcess(meta, "SIGKILL");
    liveChildren.delete(runId);
    const stopped = terminalRunMeta(readRunMeta(runId), "stopped", { exit_code: meta.exit_code ?? null });
    writeRunMeta(runId, stopped);
    if (meta.model === "claude") startNextWaitingClaudeRun();

    return summarizeRun(runId);
  }

  function resolveRunFilePath(runId, fileName) {
    const runDir = runDirFor(runId);
    const isFrame = /^frames\/(frame|live)-\d+\.png$/.test(fileName);
    const isSwarmFrame = /^swarm\/[a-z0-9_-]{1,48}\/frames\/(frame|live)-\d+\.png$/i.test(fileName);

    if (!SERVABLE_RUN_FILES.has(fileName) && !isFrame && !isSwarmFrame) {
      return null;
    }

    const filePath = path.join(runDir, ...fileName.split("/"));
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : null;
  }

  setImmediate(() => {
    startNextWaitingClaudeRun();
    retryDueProviderBackoffs();
  });
  const providerRetryTimer = setInterval(retryDueProviderBackoffs, PROVIDER_RETRY_SCAN_MS);
  providerRetryTimer.unref?.();

  return {
    cancelRunVideo,
    continueRun,
    deleteRun,
    generateRunVideo,
    getEnvironment,
    getEnvironmentAsync,
    getRunObservation,
    getRunProgress,
    launchRun,
    launchRuns,
    listProviderModels,
    listRuns,
    pauseRun,
    renderLiveFrame,
    regenerateRunVideo,
    resolveRunFilePath,
    resumeRun,
    setRunMoveTarget,
    startDocker,
    stopRun,
    summarizeRun
  };
}

module.exports = {
  collectedAllWorldGems,
  createAgentRunService,
  enrichedPathEnv
};
