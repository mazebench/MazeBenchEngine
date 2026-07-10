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

  service.deleteRun(runs[0].id);
  assert.equal(service.summarizeRun(runs[1].id).status, "running");
  assert.equal(service.summarizeRun(runs[2].id).status, "waiting");

  service.deleteRun(runs[1].id);
  assert.equal(service.summarizeRun(runs[2].id).status, "running");

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
