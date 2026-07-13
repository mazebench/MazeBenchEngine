const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pages = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");
const runService = fs.readFileSync(path.join(root, "server", "agent-runs.js"), "utf8");
const runScript = fs.readFileSync(path.join(root, "public", "agent-run.js"), "utf8");
const siteTheme = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");

assert.match(pages, /id="run-heatmap-canvas"[^>]+aria-label="Player visit heatmap across the explored world"/);
assert.match(pages, /Less visited[\s\S]*Most visited/);
assert.equal((pages.match(/\$\{heatmapSection\}/g) || []).length, 2);
assert.match(pages, /\$\{explorationSection\}[\s\S]*?\$\{heatmapSection\}[\s\S]*?\$\{movesSection\}/);
assert.match(runService, /initial_player: readInitialPlayer\(runId\)/);
assert.match(runScript, /if \(!roomVisits\.has\(room\)\) roomVisits\.set\(room, new Map\(\)\)/);
assert.match(runScript, /state\.moves\.forEach\(\(move\) => add\(move\.player, move\.roomId \|\| move\.room\)\)/);
assert.match(runScript, /const roomSize = 16/);
assert.match(runScript, /room\.columnIndex \* roomSize \+ x/);
assert.match(runScript, /room\.rowIndex \* roomSize \+ y/);
assert.match(runScript, /columns: \(maxRoomColumn - minRoomColumn \+ 1\) \* roomSize/);
assert.match(runScript, /rows: \(maxRoomRow - minRoomRow \+ 1\) \* roomSize/);
assert.match(runScript, /each room is 16 by 16 cells and positioned on the world map/);
assert.match(runScript, /column - data\.minRoomColumn\) \* data\.roomSize \* cellWidth/);
assert.match(runScript, /row - data\.minRoomRow\) \* data\.roomSize \* cellHeight/);
assert.match(runScript, /Math\.log1p\(count\)/);
assert.match(runScript, /\[0, \[255, 216, 77\]\]/);
assert.match(runScript, /\[1, \[139, 76, 220\]\]/);
assert.match(runScript, /elevation combined/);
assert.match(siteTheme, /linear-gradient\(90deg, #ffd84d 0%, #ff972d 34%, #ef3e54 67%, #8b4cdc 100%\)/);

console.log("agent-run-heatmap-source: OK — 16×16 rooms share one world-positioned heatmap and elevation is ignored.");
