const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRunService } = require("../server/agent-runs");

const root = path.join(__dirname, "..");
const agentSource = fs.readFileSync(path.join(root, "public", "agent.js"), "utf8");
const routerSource = fs.readFileSync(path.join(root, "server", "router.js"), "utf8");
const siteTheme = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");

assert.match(agentSource, /data-action="favorite"/);
assert.match(agentSource, /aria-pressed="\$\{run\.favorited \? "true" : "false"\}"/);
assert.match(agentSource, /JSON\.stringify\(\{ favorite \}\)/);
assert.match(routerSource, /segments\[4\] === "favorite"/);
assert.match(siteTheme, /\.run-favorite\[aria-pressed="true"\]/);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-run-favorite-"));
const runId = "favorite-run-123";
const runDir = path.join(tempRoot, "outputs", "maze-local", "site", runId);
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({
  id: runId,
  kind: "local",
  model: "codex",
  model_name: "test-model",
  game_id: "maze",
  game_title: "Maze",
  level_id: "level_HxI",
  moves: 10,
  status: "finished",
  created_at: "2026-07-18T12:00:00.000Z"
}));

const loadJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
};
const service = createAgentRunService({
  agentEnvironment: () => ({ docker: false, docker_installed: false }),
  ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  getGame: () => ({ id: "maze", name: "Maze", worldMap: { levels: [{ id: "level_HxI" }] } }),
  buildWorlds: { countWorldGems: () => 0 },
  loadJson,
  rootDir: tempRoot,
  worldMaps: {
    defaultLevelIdForGame: () => "level_HxI",
    isMazeWorldLevelId: () => true
  }
});

try {
  assert.equal(service.summarizeRun(runId).favorited, false);

  const favorite = service.setRunFavorite(runId, true);
  const markerPath = path.join(runDir, "favorite.json");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.equal(favorite.favorited, true);
  assert.equal(marker.schema_version, 1);
  assert.equal(marker.favorite, true);
  assert.match(marker.favorited_at, /^2026-|^20\d\d-/);
  assert.equal(service.listRuns({ pageSize: 10 }).runs[0].favorited, true);

  const originalFavoritedAt = marker.favorited_at;
  service.setRunFavorite(runId, true);
  assert.equal(JSON.parse(fs.readFileSync(markerPath, "utf8")).favorited_at, originalFavoritedAt);

  const unfavorite = service.setRunFavorite(runId, false);
  assert.equal(unfavorite.favorited, false);
  assert.equal(fs.existsSync(markerPath), false);
  assert.throws(() => service.setRunFavorite(runId, "yes"), /true or false/);
  assert.throws(() => service.setRunFavorite("missing-run-123", true), /Unknown run/);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("agent-run-favorites: OK — stars persist as MazeJam-compatible favorite markers.");
