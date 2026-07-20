const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "public", "world-solver.js"), "utf8");
const workerSource = fs.readFileSync(path.join(root, "public", "world-solver-worker.js"), "utf8");
const playSource = fs.readFileSync(path.join(root, "public", "play.js"), "utf8");
const authorSource = fs.readFileSync(path.join(root, "public", "author.js"), "utf8");
const pagesSource = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");
const appSource = fs.readFileSync(path.join(root, "server", "app.js"), "utf8");
const context = { self: {}, window: {} };

vm.runInNewContext(source, context, { filename: "world-solver.js" });
const solver = context.window.WorldSolver;

assert.equal(solver.normalizeLevelId("AxB"), "level_AxB");
assert.equal(solver.normalizeLevelId("level_ZxA"), "level_ZxA");
assert.deepEqual({ ...solver.levelCoordinates("level_CxD") }, { column: 2, row: 3 });
assert.equal(solver.countCellGems([["F+G", "G"], ["F", "G+G"]]), 4);

const controller = solver.createController({
  levels: [
    { id: "level_AxA", cells: [["F+G", "F"]] },
    { id: "level_BxA", cells: [["F", "F+G"]] }
  ],
  startLevelId: "level_AxA"
});
assert.equal(controller.rooms.size, 2);
assert.equal(controller.rooms.get("level_AxA").totalGems, 1);
assert.equal(controller.rooms.get("level_BxA").totalGems, 1);

assert.match(workerSource, /importScripts\("maze-engine\.js", "maze-solver\.js"\)/);
assert.match(workerSource, /solveWithAStar/);
assert.match(workerSource, /findReachablePositions/);
assert.match(source, /class="solver-dock__head"/);
assert.match(source, /class="solver-dock__badge">Experimental/);
assert.match(source, /class="solver-dock__track"/);
assert.match(source, />Find Gem<\/button>/);
assert.match(source, />Find Location<\/button>/);
assert.match(source, />Continue Search<\/button>/);
assert.match(source, /continue_analysis/);
assert.match(source, /pickEditorFace/);
assert.match(source, /setEditorHoverTarget/);
assert.match(source, /target \? \{ \.\.\.target\.pick, dx: 0, dy: 0, face: "top" \} : null/);
assert.match(source, /id: "location:" \+ target\.x \+ "," \+ target\.y/);
assert.match(source, /runTargetSearch\([\s\S]*?\[syntheticGem\]/);
assert.match(source, /gemTotal > 0 && collectedCount\(\) >= gemTotal/);
assert.doesNotMatch(source, /if \(options\.autoStart !== false\) resume\(\)/);
assert.doesNotMatch(source, /world-solver-map|world-solver-room/);
assert.match(source, /options\.gotoLevel/);
assert.match(playSource, /worldSolverRequested/);
assert.match(playSource, /moveDirection\(label\)/);
assert.match(authorSource, /startWorldSolver/);
assert.match(authorSource, />Continue Search<\/button>/);
assert.match(authorSource, /additionalExpandedStates/);
assert.match(authorSource, /world_solver=1/);
assert.match(pagesSource, /<script src="\/world-solver\.js" defer><\/script>/);
assert.doesNotMatch(pagesSource, /worldSolver:/);
assert.match(appSource, /"\/world-solver\.js"/);
assert.match(appSource, /"\/world-solver-worker\.js"/);

console.log("world-solver: OK — on-demand gem/location A* controls and editor/play entry points are wired.");
