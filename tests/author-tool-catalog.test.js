const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const catalog = JSON.parse(
  fs.readFileSync(path.join(root, "games", "maze", "toolbox.json"), "utf8")
);
const mazeLevels = fs.readFileSync(path.join(root, "server", "maze-levels.js"), "utf8");
const pages = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");

assert.equal(catalog.format, 1);
assert.ok(catalog.tools && typeof catalog.tools === "object");

for (const token of [
  "__select_only__",
  "__erase_top__",
  ".",
  "i",
  "#",
  "I",
  "Sr",
  "Sr#",
  "SrO",
  "p",
  "G",
  "g",
  "l",
  "O",
  "o",
  "pr",
  "f",
  "M0",
  "M1"
]) {
  const tool = catalog.tools[token];
  assert.ok(tool, `missing toolbox config for ${token}`);
  assert.equal(typeof tool.name, "string", `missing name for ${token}`);
  assert.equal(typeof tool.description, "string", `missing description for ${token}`);
}

for (const [token, tool] of Object.entries(catalog.tools)) {
  if (!tool.demo) continue;
  assert.ok(Array.isArray(tool.demo.layout), `demo layout must be rows for ${token}`);
  assert.equal(typeof tool.demo.moves, "string", `demo moves must be a string for ${token}`);
  assert.match(tool.demo.moves, /^[UDLR]*$/, `demo moves must only contain UDLR for ${token}`);
}

assert.match(mazeLevels, /gamesDir, "maze", "toolbox\.json"/);
assert.match(mazeLevels, /toolboxTool\.description/);
assert.match(mazeLevels, /toolboxTool\.demo/);
assert.match(mazeLevels, /toolboxCatalog,/);
assert.match(pages, /toolboxCatalog: authorData\.toolboxCatalog/);

console.log("author-tool-catalog: OK");
