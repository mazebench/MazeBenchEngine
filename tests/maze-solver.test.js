const assert = require("node:assert/strict");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

global.window = {};
loadBrowserScript("public/maze-engine.js");
loadBrowserScript("public/maze-solver.js");

const { createEngine } = window.MazeEngine;
const { findHardestGemPlacement, solveWithAStar } = window.MazeSolver;

function floorTerrain(width, height) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ type: "floor" }))
  );
}

(async () => {
  {
    const progressEvents = [];
    const engine = createEngine({
      width: 3,
      height: 1,
      terrain: floorTerrain(3, 1),
      actors: [
        { type: "player", x: 0, y: 0, removed: false },
        { type: "gem", x: 2, y: 0, removed: false }
      ]
    });

    const result = await solveWithAStar(engine, {
      maxExpandedStates: 100,
      onProgress: (progress) => {
        progressEvents.push(progress);
      },
      progressYieldStateInterval: 1
    });

    assert.equal(result.status, "solved");
    assert.equal(result.moves, 2);
    assert.equal(result.path, "RR");
    assert.equal(progressEvents.length > 0, true);
  }

  {
    const engine = createEngine({
      width: 3,
      height: 1,
      terrain: floorTerrain(3, 1),
      actors: [{ type: "player", x: 0, y: 0, removed: false }]
    });

    const result = await findHardestGemPlacement(engine, {
      canPlaceGemAt: (x, y) => x === 2 && y === 0,
      maxExpandedStates: 100,
      progressYieldStateInterval: 1
    });

    assert.equal(result.status, "found");
    assert.deepEqual(
      {
        x: result.candidate.x,
        y: result.candidate.y,
        moves: result.candidate.moves,
        path: result.candidate.path
      },
      {
        x: 2,
        y: 0,
        moves: 2,
        path: "RR"
      }
    );
  }

  {
    const wallSurface = { type: "wall", layers: [{ type: "wall", elevation: 0 }] };
    const engine = createEngine({
      width: 2,
      height: 1,
      terrain: [[wallSurface, wallSurface]],
      actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
    });

    const result = await findHardestGemPlacement(engine, {
      canPlaceGemAt: (x, y, elevation) => x === 1 && y === 0 && elevation === 1,
      maxExpandedStates: 100,
      progressYieldStateInterval: 1
    });

    assert.equal(result.status, "found");
    assert.deepEqual(
      {
        elevation: result.candidate.elevation,
        x: result.candidate.x,
        y: result.candidate.y,
        moves: result.candidate.moves,
        path: result.candidate.path
      },
      {
        elevation: 1,
        x: 1,
        y: 0,
        moves: 1,
        path: "R"
      }
    );
  }

  console.log("maze solver tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
