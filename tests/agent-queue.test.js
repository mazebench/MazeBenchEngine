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
  `const fs = require("node:fs");
const path = require("node:path");
const args = Object.fromEntries(process.argv.slice(2).map((part) => {
  const at = part.indexOf("=");
  return at < 0 ? [part, ""] : [part.slice(0, at), part.slice(at + 1)];
}));
setInterval(() => {
  if (args.out && fs.existsSync(path.join(args.out, "pause-request.json"))) process.exit(0);
}, 10);
process.on("SIGTERM", () => process.exit(0));
`,
  "utf8"
);
fs.writeFileSync(
  path.join(scriptsDir, "maze-prime-run.js"),
  "setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0));\n",
  "utf8"
);
fs.writeFileSync(
  path.join(scriptsDir, "maze-export-replay.js"),
  `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out-dir");
const outDir = outIndex >= 0 ? args[outIndex + 1] : process.cwd();
fs.writeFileSync(path.join(outDir, "video-args.json"), JSON.stringify(args));
setInterval(() => {}, 1000);
`,
  "utf8"
);
fs.writeFileSync(
  path.join(scriptsDir, "maze-bridge.js"),
  `const readline = require("node:readline");
const args = process.argv.slice(2);
const omniscient = args.includes("--omniscient");
const hideNames = args.includes("--hide-names");
readline.createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify(message.command === "close"
    ? { ok: true, action: "close" }
    : { ok: true, action: message.command, json_observation: { mode: "json", omniscient, hide_names: hideNames, objects: [] } }) + "\\n");
});
`,
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

(async () => {
try {
  const [hostedPrime] = service.launchRuns({
    kind: "prime",
    model_name: "Qwen/Qwen3.5-0.8B",
    max_turns: 5,
    vision: false,
    reasoning: "low",
    allow_quit: false,
    video: false
  });
  launchedIds.push(hostedPrime.id);
  const hostedPrimeMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", hostedPrime.id, "run.json")
  );
  assert.equal(hostedPrimeMeta.prime_execution, "hosted");
  assert.equal(hostedPrimeMeta.moves, 5);
  assert.equal(hostedPrimeMeta.allow_quit, false);
  assert.match(hostedPrimeMeta.command, /--hosted/);
  assert.match(hostedPrimeMeta.command, /--model Qwen\/Qwen3\.5-0\.8B/);
  assert.equal(service.stopRun(hostedPrime.id).status, "stopped");
  service.deleteRun(hostedPrime.id);

  const [visionPrime] = service.launchRuns({
    kind: "prime",
    model_name: "vision-test",
    max_turns: 1,
    vision: true,
    video: false
  });
  launchedIds.push(visionPrime.id);
  const visionPrimeMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", visionPrime.id, "run.json")
  );
  assert.equal(visionPrimeMeta.prime_execution, "local");
  assert.doesNotMatch(visionPrimeMeta.command, /--hosted/);
  assert.match(visionPrimeMeta.command, /--vision/);
  service.stopRun(visionPrime.id);
  service.deleteRun(visionPrime.id);

  const [jsonPrime] = service.launchRuns({
    kind: "prime",
    model_name: "json-test",
    max_turns: 1,
    mode: "json",
    omniscient: true,
    hide_names: true,
    video: false
  });
  launchedIds.push(jsonPrime.id);
  const jsonPrimeMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", jsonPrime.id, "run.json")
  );
  assert.equal(jsonPrimeMeta.prime_execution, "hosted");
  assert.equal(jsonPrimeMeta.mode, "json");
  assert.equal(jsonPrimeMeta.omniscient, true);
  assert.equal(jsonPrimeMeta.hide_names, true);
  assert.match(jsonPrimeMeta.command, /--observation-mode json/);
  assert.match(jsonPrimeMeta.command, /--omniscient/);
  assert.match(jsonPrimeMeta.command, /--hide-names/);
  service.stopRun(jsonPrime.id);
  service.deleteRun(jsonPrime.id);

  const [jsonLocal] = service.launchRuns({
    kind: "local",
    model: "codex",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 1,
    mode: "json",
    omniscient: true,
    hide_names: true,
    container: false,
    video: false
  });
  launchedIds.push(jsonLocal.id);
  const jsonLocalMeta = loadJson(
    path.join(rootDir, "outputs", "maze-local", "site", jsonLocal.id, "run.json")
  );
  assert.equal(jsonLocalMeta.mode, "json");
  assert.equal(jsonLocalMeta.omniscient, true);
  assert.equal(jsonLocalMeta.hide_names, true);
  assert.match(jsonLocalMeta.command, /mode=json/);
  assert.match(jsonLocalMeta.command, /omniscient=true/);
  assert.match(jsonLocalMeta.command, /hide_names=true/);
  const jsonLocalDir = path.join(rootDir, "outputs", "maze-local", "site", jsonLocal.id);
  fs.writeFileSync(path.join(jsonLocalDir, "session.json"), JSON.stringify({
    actions: [],
    gameId: "maze",
    gameWonGemCount: 100,
    levelId: "level_HxI",
    view: "top-diagonal",
    yaw: 0,
    initial: { level: "ASCII-ONLY" }
  }));
  fs.writeFileSync(path.join(jsonLocalDir, "initial-status.json"), JSON.stringify({ level: "ASCII-ONLY" }));
  const reconstructedJson = service.getRunObservation(jsonLocal.id, { turn: 0 });
  assert.equal(reconstructedJson.board, "ASCII-ONLY");
  assert.deepEqual(reconstructedJson.json_observation, {
    mode: "json",
    omniscient: true,
    hide_names: true,
    objects: []
  });
  service.stopRun(jsonLocal.id);
  service.deleteRun(jsonLocal.id);

  const [hostReadOnlySwarm] = service.launchRuns({
    kind: "local",
    model: "codex",
    model_name: "gpt-test",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 1,
    allow_quit: false,
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
  assert.equal(hostSwarmMeta.allow_quit, false);
  assert.equal(hostSwarmMeta.launch_params.allow_quit, false);
  assert.match(hostSwarmMeta.command, /tool_use=read-only/);
  assert.match(hostSwarmMeta.command, /allow_quit=false/);
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
  fs.writeFileSync(path.join(swarmWorkerDir, "worker.json"), JSON.stringify({
    id: "scout_one",
    fork_action_count: 5,
    label: "north scout",
    observation_mode: "text",
    owner_kind: "subagent",
    parent_instance_id: "primary"
  }));
  fs.writeFileSync(path.join(swarmWorkerDir, "telemetry.json"), JSON.stringify({
    actions_applied: 2,
    actions_attempted: 3,
    last_action: "up"
  }));
  fs.writeFileSync(
    path.join(swarmWorkerDir, "actions.jsonl"),
    Array.from({ length: 7 }, (_, index) => JSON.stringify({
      turn: index + 1,
      command_text: index < 5 ? "inherited" : index === 5 ? "right" : "up",
      status: {
        current_room: "level_GxH",
        current_view: "top-diagonal",
        gem_count: index === 6 ? 2 : 0,
        level: `BOARD-${index + 1}`,
        player: { elevation: 0, x: index + 1, y: 0 },
        yaw: 1
      }
    })).join("\n") + "\n"
  );
  fs.writeFileSync(path.join(swarmWorkerDir, "frames", "frame-007.png"), "png");
  fs.writeFileSync(
    path.join(rootDir, "outputs", "maze-local", "site", hostReadOnlySwarm.id, "initial-status.json"),
    JSON.stringify({ player: { elevation: 3, x: 4, y: 12 } })
  );
  const swarmProgress = service.getRunProgress(hostReadOnlySwarm.id);
  assert.deepEqual(swarmProgress.initial_player, { x: 4, y: 12 });
  assert.equal(swarmProgress.swarm_views.length, 1);
  assert.equal(swarmProgress.swarm_views[0].id, "scout_one");
  assert.equal(swarmProgress.swarm_views[0].room, "level_GxH");
  assert.equal(swarmProgress.swarm_views[0].turn, 7);
  assert.equal(swarmProgress.swarm_views[0].auxiliary_actions, 2);
  assert.equal(swarmProgress.swarm_views[0].auxiliary_action_attempts, 3);
  assert.equal(swarmProgress.swarm_views[0].inherited_action_count, 5);
  assert.equal(swarmProgress.swarm_views[0].observation_mode, "text");
  assert.equal(swarmProgress.swarm_views[0].owner_kind, "subagent");
  assert.equal(swarmProgress.instance_activity.instances, 1);
  assert.equal(swarmProgress.instance_activity.auxiliary_actions, 2);
  assert.equal(swarmProgress.run.explorer_instances, 1);
  assert.equal(swarmProgress.run.auxiliary_actions, 2);
  assert.equal(swarmProgress.run.simulated_actions, swarmProgress.run.turns + 2);
  assert.deepEqual(swarmProgress.swarm_views[0].player, { elevation: 0, x: 7, y: 0 });
  assert.match(swarmProgress.swarm_views[0].frame_url, /swarm\/scout_one\/frames\/frame-007\.png$/);
  const forkObservation = service.getRunObservation(hostReadOnlySwarm.id, {
    instanceId: "scout_one",
    turn: 0
  });
  const latestObservation = service.getRunObservation(hostReadOnlySwarm.id, {
    instanceId: "scout_one",
    turn: 2
  });
  assert.equal(forkObservation.turn, 0);
  assert.equal(forkObservation.absolute_turn, 5);
  assert.equal(forkObservation.total, 2);
  assert.equal(forkObservation.board, "BOARD-5");
  assert.equal(latestObservation.turn, 2);
  assert.equal(latestObservation.absolute_turn, 7);
  assert.equal(latestObservation.command_text, "up");
  assert.match(latestObservation.frame_url, /swarm\/scout_one\/frames\/frame-007\.png$/);
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

  fs.appendFileSync(
    path.join(rootDir, "outputs", "maze-local", "site", hostReadOnlySwarm.id, "agent-events.jsonl"),
    `${JSON.stringify({ type: "thread.started", thread_id: "cold-pause-thread" })}\n`
  );
  const pauseRequested = service.pauseRun(hostReadOnlySwarm.id);
  assert.equal(pauseRequested.status, "pausing");
  assert.equal(pauseRequested.pause_after_turn, 1);
  const pauseDeadline = Date.now() + 3000;
  let pausedHostRun = service.summarizeRun(hostReadOnlySwarm.id);
  while (pausedHostRun.status !== "paused" && Date.now() < pauseDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    pausedHostRun = service.summarizeRun(hostReadOnlySwarm.id);
  }
  assert.equal(pausedHostRun.status, "paused");
  assert.equal(pausedHostRun.pause_reason, "manual");
  assert.equal(pausedHostRun.pause_mode, "cold");
  assert.equal(pausedHostRun.pid, null);
  fs.writeFileSync(path.join(hostRunDir, "session.json"), "{}\n");
  const renderingVideo = service.generateRunVideo(hostReadOnlySwarm.id);
  assert.equal(renderingVideo.video_status, "rendering");
  assert.equal(renderingVideo.has_video, false);
  assert.equal(fs.existsSync(path.join(hostRunDir, "replay-progress.json")), true);
  const videoArgsDeadline = Date.now() + 3000;
  while (!fs.existsSync(path.join(hostRunDir, "video-args.json")) && Date.now() < videoArgsDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const videoArgs = loadJson(path.join(hostRunDir, "video-args.json"), []);
  assert(videoArgs.includes("--intro"));
  assert(videoArgs.includes("--ascii-side-by-side"));
  assert.equal(videoArgs.includes("--draft"), false);
  assert.equal(videoArgs[videoArgs.indexOf("--preset") + 1], "veryfast");
  assert.ok(videoArgs.includes("--accelerated"));
  const canceledVideo = service.cancelRunVideo(hostReadOnlySwarm.id);
  assert.equal(canceledVideo.video_status, "idle");
  assert.equal(fs.existsSync(path.join(hostRunDir, "replay-progress.json")), false);
  fs.writeFileSync(path.join(hostRunDir, "maze_replay.mp4"), "old replay");
  const readyMeta = loadJson(path.join(hostRunDir, "run.json"), {});
  fs.writeFileSync(
    path.join(hostRunDir, "run.json"),
    JSON.stringify({ ...readyMeta, video_status: "ready" })
  );
  assert.equal(service.summarizeRun(hostReadOnlySwarm.id).has_video, true);
  const regeneratedVideo = service.regenerateRunVideo(hostReadOnlySwarm.id);
  assert.equal(regeneratedVideo.video_status, "rendering");
  assert.equal(regeneratedVideo.has_video, false);
  assert.equal(fs.existsSync(path.join(hostRunDir, "maze_replay.mp4")), false);
  const resumedHostRun = service.resumeRun(hostReadOnlySwarm.id);
  assert.equal(resumedHostRun.status, "running");
  assert.match(resumedHostRun.command, /resume=cold-pause-thread/);
  assert.equal(resumedHostRun.video_status, "idle");
  assert.equal(resumedHostRun.has_video, false);
  assert.equal(fs.existsSync(path.join(hostRunDir, "replay-progress.json")), false);
  const resumedHostMeta = loadJson(path.join(hostRunDir, "run.json"), {});
  assert.equal("video_pid" in resumedHostMeta, false);
  assert.equal("video_generation_id" in resumedHostMeta, false);
  const stopAlias = service.stopRun(hostReadOnlySwarm.id);
  assert.equal(stopAlias.status, "pausing", "local Stop aliases the same resumable cold pause");
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
  assert.equal(unlimitedMeta.moves, null);
  assert.equal(unlimitedMeta.segment_move_budget, null);
  assert.equal(unlimitedMeta.launch_params.unlimited, true);
  assert.match(unlimitedMeta.command, /unlimited=true/);
  const unlimitedSummary = service.summarizeRun(unlimitedRun.id);
  assert.equal(unlimitedSummary.progress.unlimited, true);
  assert.equal(unlimitedSummary.progress.total, null);
  assert.equal(unlimitedSummary.progress.eta_ms, null);
  const toolInstanceDir = path.join(
    rootDir,
    "outputs",
    "maze-local",
    "site",
    unlimitedRun.id,
    "swarm",
    "tool_search"
  );
  fs.mkdirSync(toolInstanceDir, { recursive: true });
  fs.writeFileSync(path.join(toolInstanceDir, "worker.json"), JSON.stringify({
    id: "tool_search",
    fork_action_count: 0,
    label: "search algorithm",
    observation_mode: "text",
    owner_kind: "tool",
    parent_instance_id: "primary"
  }));
  fs.writeFileSync(path.join(toolInstanceDir, "telemetry.json"), JSON.stringify({
    actions_applied: 0,
    actions_attempted: 0
  }));
  fs.writeFileSync(path.join(toolInstanceDir, "session.json"), JSON.stringify({
    actions: [],
    vision: false,
    initial: {
      current_room: "level_HxI",
      current_view: "top-diagonal",
      gem_count: 0,
      level: "AP",
      player: { elevation: 0, x: 1, y: 0 },
      yaw: 0
    }
  }));
  const toolInstanceProgress = service.getRunProgress(unlimitedRun.id);
  assert.equal(toolInstanceProgress.run.swarm, false);
  assert.equal(toolInstanceProgress.swarm_views.length, 1, "tool-created instances stay visible outside swarm mode");
  assert.equal(toolInstanceProgress.swarm_views[0].owner_kind, "tool");
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
      `${JSON.stringify({ actions: { total: actions }, rooms: { visited: rooms, total: 256 }, gems: { collected: gems, total: 69 } })}\n`
    );
  });

  const continuedFixtureDir = path.join(rootDir, "outputs", "maze-local", "site", runs[0].id);
  fs.writeFileSync(
    path.join(continuedFixtureDir, "maze_scorecard.json"),
    `${JSON.stringify({
      actions: { total: 0 },
      rooms: { visited: 1, total: 256 },
      gems: { collected: 2, total: 69 }
    })}\n`
  );
  const continuedFixtureSummary = service.summarizeRun(runs[0].id);
  assert.equal(continuedFixtureSummary.turns, 1);
  assert.equal(continuedFixtureSummary.gem_count, 3, "continued runs ignore stale collected-gem scorecards");
  assert.equal(continuedFixtureSummary.room_count, 2, "continued runs ignore stale visited-room scorecards");

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

  service.stopRun(runs[2].id);
  service.deleteRun(runs[2].id);

  fs.writeFileSync(
    path.join(scriptsDir, "maze-agent-local.js"),
    `const fs = require("node:fs");
const path = require("node:path");
const args = Object.fromEntries(process.argv.slice(2).map((part) => {
  const at = part.indexOf("=");
  return at < 0 ? [part, ""] : [part.slice(0, at), part.slice(at + 1)];
}));
fs.mkdirSync(args.out, { recursive: true });
if (!args.resume) {
  fs.writeFileSync(path.join(args.out, "agent-events.jsonl"), JSON.stringify({ type: "thread.started", thread_id: "no-quit-thread" }) + "\\n");
  process.exit(0);
}
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`,
    "utf8"
  );
  const [noQuitRun] = service.launchRuns({
    kind: "local",
    model: "codex",
    model_name: "gpt-test",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 5,
    allow_quit: false,
    mode: "text",
    container: false,
    tools: false,
    tool_use: "read-only",
    swarm: false,
    video: false
  });
  launchedIds.push(noQuitRun.id);
  const noQuitDeadline = Date.now() + 3000;
  let noQuitSummary = service.summarizeRun(noQuitRun.id);
  while ((noQuitSummary.continued || 0) < 1 && Date.now() < noQuitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    noQuitSummary = service.summarizeRun(noQuitRun.id);
  }
  assert.equal(noQuitSummary.status, "running");
  assert.equal(noQuitSummary.allow_quit, false);
  assert.equal(noQuitSummary.continued, 1, "a clean early exit must resume the same provider thread");
  assert.equal(noQuitSummary.moves, 5, "automatic persistence must retain the user's action target");
  assert.match(noQuitSummary.command, /resume=no-quit-thread/);
  service.stopRun(noQuitRun.id);
  service.deleteRun(noQuitRun.id);

  fs.writeFileSync(
    path.join(scriptsDir, "maze-agent-local.js"),
    `const fs = require("node:fs");
const path = require("node:path");
const args = Object.fromEntries(process.argv.slice(2).map((part) => {
  const at = part.indexOf("=");
  return at < 0 ? [part, ""] : [part.slice(0, at), part.slice(at + 1)];
}));
fs.mkdirSync(args.out, { recursive: true });
fs.writeFileSync(path.join(args.out, "agent-events.jsonl"), JSON.stringify({ type: "thread.started", thread_id: "retry-thread" }) + "\\n");
fs.writeFileSync(path.join(args.out, "provider-failure.json"), JSON.stringify({ provider: "codex", status: 502, message: "Bad Gateway", detected_at: new Date().toISOString() }));
process.exit(75);
`,
    "utf8"
  );
  const [providerFailureRun] = service.launchRuns({
    kind: "local",
    model: "codex",
    model_name: "gpt-test",
    game_id: "maze",
    level_id: "level_HxI",
    moves: 5,
    mode: "text",
    container: false,
    tools: false,
    tool_use: "read-only",
    swarm: false,
    video: false
  });
  launchedIds.push(providerFailureRun.id);
  const providerFailureDeadline = Date.now() + 3000;
  let providerFailureSummary = service.summarizeRun(providerFailureRun.id);
  while (providerFailureSummary.status === "running" && Date.now() < providerFailureDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    providerFailureSummary = service.summarizeRun(providerFailureRun.id);
  }
  assert.equal(providerFailureSummary.status, "paused");
  assert.equal(providerFailureSummary.pause_reason, "provider_backoff");
  assert.equal(providerFailureSummary.provider_failure_status, 502);
  assert.equal(providerFailureSummary.provider_retry_attempt, 1);
  assert(Date.parse(providerFailureSummary.retry_at) > Date.now());
  service.deleteRun(providerFailureRun.id);

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
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
