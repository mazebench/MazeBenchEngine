const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRunService } = require("../server/agent-runs");

const root = path.join(__dirname, "..");
const runService = fs.readFileSync(path.join(root, "server", "agent-runs.js"), "utf8");
const runScript = fs.readFileSync(path.join(root, "public", "agent-run.js"), "utf8");
const siteTheme = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");

assert.match(runService, /const actionCache = new Map\(\)/);
assert.match(runService, /const start = cached\?\.size \|\| 0/);
assert.match(runService, /delete previous\.level/);
assert.match(runService, /const LARGE_TELEMETRY_REFRESH_MS = 10_000/);
assert.match(runService, /Date\.now\(\) - cached\.checkedAt < LARGE_TELEMETRY_REFRESH_MS/);
assert.match(runService, /actions: tokenUsage\.actions\.filter/);
assert.match(runService, /reasoning\.filter\(\(entry\)/);
assert.match(runService, /apiPricingForRun\(summary, listProviderModels\("prime"\)\.models\)/);
assert.match(runScript, /const FEED_RENDER_BATCH = 200/);
assert.match(runScript, /const renderedMoveNums = hiddenMoveCount > 0 \? moveNums\.slice\(-state\.feedRenderLimit\) : moveNums/);
assert.match(runScript, /data-feed-load-more/);
assert.match(runScript, /state\.tokenUsagePoints\.set\(action/);
assert.match(runScript, /\$\$\{pricing\.input\}\/M in · \$\$\{pricing\.output\}\/M out/);
assert.match(siteTheme, /\.agent-feed__load-more \{/);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-run-performance-"));
const runId = "perf-run-123";
const runDir = path.join(tempRoot, "outputs", "maze-local", "site", runId);
fs.mkdirSync(runDir, { recursive: true });
const loadJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
};
const game = { id: "maze", name: "Maze", worldMap: { levels: [{ id: "level_HxI" }] } };
const service = createAgentRunService({
  agentEnvironment: () => ({ docker: false, docker_installed: false }),
  ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  getGame: () => game,
  buildWorlds: { countWorldGems: () => 1 },
  loadJson,
  rootDir: tempRoot,
  worldMaps: {
    defaultLevelIdForGame: () => "level_HxI",
    isMazeWorldLevelId: () => true
  }
});
fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({
  id: runId,
  kind: "local",
  model: "codex",
  model_name: "test-model",
  game_id: "maze",
  game_title: "Maze",
  level_id: "level_HxI",
  moves: 500,
  status: "finished",
  finished_at: new Date().toISOString()
}));
fs.writeFileSync(path.join(runDir, "initial-status.json"), JSON.stringify({ player: { x: 0, y: 0 } }));
const actionLine = (turn) => JSON.stringify({
  turn,
  command_text: "right",
  status: {
    current_room: "level_HxI",
    gem_count: 0,
    player: { x: turn % 16, y: 0 },
    level: "W".repeat(4096)
  }
});
fs.writeFileSync(
  path.join(runDir, "actions.jsonl"),
  `${Array.from({ length: 450 }, (_, index) => actionLine(index + 1)).join("\n")}\n`
);
fs.writeFileSync(
  path.join(runDir, "reasoning.json"),
  JSON.stringify(Array.from({ length: 450 }, (_, index) => ({ move: index + 1, reasoning: `Move ${index + 1}` })))
);

const initialProgress = service.getRunProgress(runId);
assert.equal(initialProgress.actions.length, 450);
assert.equal(initialProgress.actions.filter((action) => action.level).length, 1);
assert.ok(Buffer.byteLength(JSON.stringify(initialProgress.actions)) < 150_000);

fs.appendFileSync(path.join(runDir, "actions.jsonl"), `${actionLine(451)}\n`);
const incrementalProgress = service.getRunProgress(runId, { afterTurn: 450, logOffset: 0 });
assert.deepEqual(incrementalProgress.actions.map((action) => action.turn), [451]);
assert.equal(incrementalProgress.actions[0].level.length, 4096);
assert.ok(incrementalProgress.reasoning.length <= 6);

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log("agent-run-performance-source: OK — large runs use incremental server reads and a bounded move-feed DOM.");
