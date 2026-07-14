const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pages = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");
const runScript = fs.readFileSync(path.join(root, "public", "agent-run.js"), "utf8");
const siteTheme = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");

assert.match(pages, /id="run-rooms-map-button"[^>]+aria-haspopup="dialog"/);
assert.match(pages, /id="run-rooms-map-dialog"[^>]+role="dialog"[^>]+aria-modal="true"/);
assert.match(pages, /id="run-rooms-map-tooltip" class="run-world-map__tooltip" role="tooltip" hidden/);
assert.match(pages, /window\.__AGENT_RUN_WORLD__ = \$\{serializeForScript\(runWorld\)\}/);
assert.match(runScript, /function visitedRoomIds\(\)/);
assert.match(runScript, /function firstRoomEntryTurns\(\)/);
assert.match(runScript, /function renderRunWorldMap\(\{ force = false \} = \{\}\)/);
assert.match(runScript, /cell\.classList\.toggle\("is-visited", isVisited\)/);
assert.match(runScript, /cell\.classList\.toggle\("is-current", isCurrent\)/);
assert.match(runScript, /document\.createElement\(isVisited \? "button" : "div"\)/);
assert.match(runScript, /cell\.dataset\.jumpTurn = String\(firstEntryTurn\)/);
assert.match(runScript, /function showRunWorldMapTooltip\(cell\)/);
assert.match(runScript, /First entered at Action \$\{turn\}/);
assert.doesNotMatch(runScript, /label\.textContent = levelLabel\(level\.id\)/);
assert.match(runScript, /void jumpToPrimaryFrame\(firstEntryTurn\)/);
assert.match(runScript, /event\.key === "Escape" && roomsMapDialog\?\.hidden === false/);
assert.match(siteTheme, /\.run-rooms-map-button \{/);
assert.match(siteTheme, /\.run-world-map__cell\.is-visited \{/);
assert.match(siteTheme, /\.run-world-map__cell\.is-current \{/);
assert.match(siteTheme, /\.run-world-map__cell:is\(button\) \{/);
assert.match(siteTheme, /\.run-world-map__cell \{[\s\S]*?border-radius: 0/);
assert.match(siteTheme, /\.run-world-map__tooltip \{/);

console.log("agent-run-world-map-source: OK — visited rooms jump to their first-entry replay frames.");
