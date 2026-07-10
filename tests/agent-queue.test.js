const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRunService } = require("../server/agent-runs");

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-agent-queue-"));
const scriptsDir = path.join(rootDir, "scripts");
fs.mkdirSync(scriptsDir, { recursive: true });
fs.writeFileSync(
  path.join(scriptsDir, "maze-agent-local.js"),
  'setInterval(() => {}, 1000);\nprocess.on("SIGTERM", () => process.exit(0));\n',
  "utf8"
);

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

const game = {
  id: "maze",
  name: "Maze Bench Environment",
  worldMap: { levels: [{ id: "level_HxI" }] }
};
const service = createAgentRunService({
  agentEnvironment: () => ({ docker: false, docker_installed: false }),
  ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  getGame: (id) => (id === "maze" ? game : null),
  buildWorlds: { countWorldGems: () => 1 },
  loadJson,
  rootDir,
  worldMaps: {
    defaultLevelIdForGame: () => "level_HxI",
    isMazeWorldLevelId: () => true
  }
});

const launchedIds = [];

try {
  const [hostReadOnlySwarm] = service.launchRuns({
    kind: "local",
    model: "codex",
    model_name: "gpt-test",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 1,
    mode: "text",
    container: false,
    tools: false,
    tool_use: "read-only",
    swarm: true,
    video: false
  });
  launchedIds.push(hostReadOnlySwarm.id);
  const hostSwarmMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", hostReadOnlySwarm.id, "run.json")
  );
  assert.equal(hostSwarmMeta.tool_use, "read-only");
  assert.equal(hostSwarmMeta.tools, false);
  assert.equal(hostSwarmMeta.swarm, true);
  assert.equal(hostSwarmMeta.container, false);
  assert.match(hostSwarmMeta.command, /tool_use=read-only/);
  assert.match(hostSwarmMeta.command, /swarm=true/);
  const retargeted = service.setRunMoveTarget(hostReadOnlySwarm.id, 100_000);
  assert.equal(retargeted.moves, 100_000);
  const retargetedMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", hostReadOnlySwarm.id, "run.json")
  );
  assert.equal(retargetedMeta.auto_continue_target, 100_000);
  assert.equal(retargetedMeta.segment_move_budget, 1);
  assert.equal(retargetedMeta.launch_params.moves, 100_000);

  const swarmWorkerDir = path.join(
    rootDir,
    "outputs",
    "maze-local",
    "site",
    hostReadOnlySwarm.id,
    "swarm",
    "scout_one"
  );
  fs.mkdirSync(path.join(swarmWorkerDir, "frames"), { recursive: true });
  fs.writeFileSync(path.join(swarmWorkerDir, "worker.json"), JSON.stringify({ id: "scout_one" }));
  fs.writeFileSync(
    path.join(swarmWorkerDir, "actions.jsonl"),
    `${JSON.stringify({
      turn: 7,
      status: {
        current_room: "level_GxH",
        current_view: "top-diagonal",
        gem_count: 2,
        level: "AAAP",
        player: { elevation: 0, x: 3, y: 0 },
        yaw: 1
      }
    })}\n`
  );
  fs.writeFileSync(path.join(swarmWorkerDir, "frames", "frame-007.png"), "png");
  const swarmProgress = service.getRunProgress(hostReadOnlySwarm.id);
  assert.equal(swarmProgress.swarm_views.length, 1);
  assert.equal(swarmProgress.swarm_views[0].id, "scout_one");
  assert.equal(swarmProgress.swarm_views[0].room, "level_GxH");
  assert.equal(swarmProgress.swarm_views[0].turn, 7);
  assert.deepEqual(swarmProgress.swarm_views[0].player, { elevation: 0, x: 3, y: 0 });
  assert.match(swarmProgress.swarm_views[0].frame_url, /swarm\/scout_one\/frames\/frame-007\.png$/);
  assert.equal(
    service.resolveRunFilePath(hostReadOnlySwarm.id, "swarm/scout_one/frames/frame-007.png"),
    path.join(swarmWorkerDir, "frames", "frame-007.png")
  );
  assert.equal(service.resolveRunFilePath(hostReadOnlySwarm.id, "swarm/../run.json"), null);

  const hostRunDir = path.join(rootDir, "outputs", "maze-local", "site", hostReadOnlySwarm.id);
  fs.writeFileSync(
    path.join(hostRunDir, "tool-activity.jsonl"),
    `${JSON.stringify({
      id: "maze-1",
      tool: "maze_action",
      actor: "worker",
      clone_id: "scout_one",
      action: "up",
      started_at: "2026-07-10T00:00:01.000Z",
      completed_at: "2026-07-10T00:00:01.200Z",
      duration_ms: 200,
      status: "completed",
      move_calls: 1
    })}\n`
  );
  fs.writeFileSync(
    path.join(hostRunDir, "agent-events.jsonl"),
    [
      {
        type: "item.started",
        item: { id: "algo-1", type: "command_execution", command: "node explore.js", status: "in_progress" },
        _mazebench_received_at: "2026-07-10T00:00:00.000Z"
      },
      {
        type: "item.completed",
        item: { id: "algo-1", type: "command_execution", command: "node explore.js", status: "completed" },
        _mazebench_received_at: "2026-07-10T00:00:02.000Z"
      }
    ].map(JSON.stringify).join("\n") + "\n"
  );
  const activityProgress = service.getRunProgress(hostReadOnlySwarm.id);
  assert(activityProgress.tool_activity.recent.some((row) => row.label === "Algorithm · explore.js"));
  assert(activityProgress.tool_activity.recent.some((row) => row.label === "Maze · action"));
  assert.equal(
    activityProgress.tool_activity.recent.find((row) => row.label === "Algorithm · explore.js").moves_tried,
    1
  );

  const pausedHostRun = service.pauseRun(hostReadOnlySwarm.id);
  assert.equal(pausedHostRun.status, "paused");
  assert.equal(pausedHostRun.pause_reason, "manual");
  const resumedHostRun = service.resumeRun(hostReadOnlySwarm.id);
  assert.equal(resumedHostRun.status, "running");
  service.stopRun(hostReadOnlySwarm.id);
  const stopDeadline = Date.now() + 3000;
  let stoppedHostRun = service.summarizeRun(hostReadOnlySwarm.id);
  while (stoppedHostRun.status === "stopping" && Date.now() < stopDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    stoppedHostRun = service.summarizeRun(hostReadOnlySwarm.id);
  }
  assert.equal(stoppedHostRun.status, "stopped");
  service.deleteRun(hostReadOnlySwarm.id);

  const [unlimitedRun] = service.launchRuns({
    kind: "local",
    model: "codex",
    model_name: "gpt-test",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 5,
    unlimited: true,
    mode: "text",
    container: false,
    tools: false,
    tool_use: "read-only",
    swarm: false,
    video: false
  });
  launchedIds.push(unlimitedRun.id);
  const unlimitedMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", unlimitedRun.id, "run.json")
  );
  assert.equal(unlimitedMeta.unlimited, true);
  assert.equal(unlimitedMeta.moves, 500);
  assert.equal(unlimitedMeta.segment_move_budget, 500);
  assert.equal(unlimitedMeta.launch_params.unlimited, true);
  assert.match(unlimitedMeta.command, /unlimited=true/);
  const unlimitedSummary = service.summarizeRun(unlimitedRun.id);
  assert.equal(unlimitedSummary.progress.unlimited, true);
  assert.equal(unlimitedSummary.progress.total, null);
  assert.equal(unlimitedSummary.progress.eta_ms, null);
  service.stopRun(unlimitedRun.id);
  service.deleteRun(unlimitedRun.id);

  const runs = service.launchRuns({
    kind: "local",
    model: "claude",
    model_name: "test/model",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 5,
    mode: "text",
    container: false,
    tools: true,
    video: false,
    count: 3
  });
  launchedIds.push(...runs.map((run) => run.id));

  assert.deepEqual(runs.map((run) => run.status), ["running", "waiting", "waiting"]);
  assert.ok(runs[0].pid, "the first Claude run should own the provider slot");
  assert.equal(runs[1].pid, null);
  assert.equal(runs[2].pid, null);

  const secondMeta = loadJson(path.join(rootDir, "outputs", "maze-local", "site", runs[1].id, "run.json"));
  const thirdMeta = loadJson(path.join(rootDir, "outputs", "maze-local", "site", runs[2].id, "run.json"));
  assert.ok(secondMeta.queue_order < thirdMeta.queue_order, "waiting runs should have stable FIFO order");

  const metricFixtures = [
    { run: runs[0], actions: 1, rooms: 2, gems: 3 },
    { run: runs[1], actions: 3, rooms: 1, gems: 2 },
    { run: runs[2], actions: 2, rooms: 3, gems: 5 }
  ];
  metricFixtures.forEach(({ run, actions, rooms, gems }) => {
    const runDir = path.join(rootDir, "outputs", "maze-local", "site", run.id);
    const actionRows = Array.from({ length: actions }, (_, index) => ({
      turn: index + 1,
      command_text: "up",
      status: { current_room: `level_${String.fromCharCode(65 + index)}xA`, gem_count: gems }
    }));
    fs.writeFileSync(path.join(runDir, "actions.jsonl"), `${actionRows.map(JSON.stringify).join("\n")}\n`);
    fs.writeFileSync(
      path.join(runDir, "maze_scorecard.json"),
      `${JSON.stringify({ rooms: { visited: rooms, total: 256 }, gems: { total: 69 } })}\n`
    );
  });

  assert.deepEqual(
    service.listRuns({ sort: "actions", pageSize: 10 }).runs.map((run) => run.id),
    [runs[1].id, runs[2].id, runs[0].id]
  );
  assert.deepEqual(
    service.listRuns({ sort: "rooms", pageSize: 10 }).runs.map((run) => run.id),
    [runs[2].id, runs[0].id, runs[1].id]
  );
  assert.deepEqual(
    service.listRuns({ sort: "gems", pageSize: 10 }).runs.map((run) => run.id),
    [runs[2].id, runs[0].id, runs[1].id]
  );

  service.deleteRun(runs[0].id);
  assert.equal(service.summarizeRun(runs[1].id).status, "running");
  assert.equal(service.summarizeRun(runs[2].id).status, "waiting");

  service.deleteRun(runs[1].id);
  assert.equal(service.summarizeRun(runs[2].id).status, "running");

  const originalHome = process.env.HOME;
  const codexHome = path.join(rootDir, "codex-home");
  const codexCachePath = path.join(codexHome, ".codex", "models_cache.json");
  fs.mkdirSync(path.dirname(codexCachePath), { recursive: true });
  const writeCodexCache = (slugs, fetchedAt) => {
    fs.writeFileSync(
      codexCachePath,
      JSON.stringify({
        fetched_at: fetchedAt,
        models: slugs.map((slug, priority) => ({
          slug,
          display_name: slug.toUpperCase(),
          priority,
          supported_reasoning_levels: [{ effort: "high" }]
        }))
      })
    );
  };

  try {
    process.env.HOME = codexHome;
    writeCodexCache(["gpt-new", "gpt-current"], "2026-07-10T01:00:00Z");
    assert.deepEqual(
      service.listProviderModels("codex").models.map((model) => model.id),
      ["gpt-new", "gpt-current"]
    );

    // A newer disk write containing an older subset must not make a model
    // disappear, and Codex requests must bypass the provider TTL cache.
    writeCodexCache(["gpt-current"], "2026-07-10T02:00:00Z");
    assert.deepEqual(
      service.listProviderModels("codex").models.map((model) => model.id),
      ["gpt-new", "gpt-current"]
    );

    writeCodexCache(["gpt-next", "gpt-new", "gpt-current"], "2026-07-10T03:00:00Z");
    assert.deepEqual(
      service.listProviderModels("codex").models.map((model) => model.id),
      ["gpt-next", "gpt-new", "gpt-current"]
    );

    // The last-known-good catalog survives a local server restart.
    writeCodexCache(["gpt-current"], "2026-07-10T04:00:00Z");
    const restartedService = createAgentRunService({
      agentEnvironment: () => ({ docker: false, docker_installed: false }),
      ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
      getGame: (id) => (id === "maze" ? game : null),
      buildWorlds: { countWorldGems: () => 1 },
      loadJson,
      rootDir,
      worldMaps: {
        defaultLevelIdForGame: () => "level_HxI",
        isMazeWorldLevelId: () => true
      }
    });
    assert.deepEqual(
      restartedService.listProviderModels("codex").models.map((model) => model.id),
      ["gpt-next", "gpt-new", "gpt-current"]
    );
  } finally {
    process.env.HOME = originalHome;
  }

  console.log("agent queue tests passed");
} finally {
  launchedIds.forEach((runId) => {
    try {
      if (service.summarizeRun(runId)) service.deleteRun(runId);
    } catch (_error) {
      /* already deleted */
    }
  });
  fs.rmSync(rootDir, { recursive: true, force: true });
}
