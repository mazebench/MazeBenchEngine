const assert = require("node:assert/strict");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

global.window = {};
loadBrowserScript("public/maze-engine.js");
loadBrowserScript("public/maze-solver.js");

const { createEngine } = window.MazeEngine;
const { findHardestGemPlacement, findReachablePositions, solveWithAStar } = window.MazeSolver;

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
    // Regression: a gem collected before the engine was created (mid-session
    // state) must not count as an instant solve; the solver has to path to
    // the remaining live gem instead of returning an empty path.
    const engine = createEngine({
      width: 3,
      height: 1,
      terrain: floorTerrain(3, 1),
      actors: [
        { type: "player", x: 0, y: 0, removed: false },
        { type: "gem", x: 0, y: 0, removed: true },
        { type: "gem", x: 2, y: 0, removed: false }
      ]
    });

    const result = await solveWithAStar(engine, {
      maxExpandedStates: 100,
      progressYieldStateInterval: 1
    });

    assert.equal(result.status, "solved");
    assert.equal(result.moves, 2);
    assert.equal(result.path, "RR");
  }

  {
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
      algorithm: "bfs",
      maxExpandedStates: 100,
      progressYieldStateInterval: 1
    });

    assert.equal(result.status, "solved");
    assert.equal(result.moves, 2);
    assert.equal(result.path, "RR");
  }

  {
    const engine = createEngine({
      width: 16,
      height: 16,
      terrain: floorTerrain(16, 16),
      actors: [
        { type: "player", x: 0, y: 0, removed: false },
        { type: "gem", x: 15, y: 0, removed: false }
      ]
    });

    const result = await solveWithAStar(engine, {
      algorithm: "astar",
      maxExpandedStates: 1000,
      progressYieldStateInterval: 1000
    });

    assert.equal(result.status, "solved");
    assert.equal(result.moves, 15);
    assert.equal(result.expanded <= 20, true);
  }

  {
    const engine = createEngine({
      width: 3,
      height: 1,
      terrain: floorTerrain(3, 1),
      actors: [
        { type: "player", x: 0, y: 0, removed: false },
        { type: "gem", x: 2, y: 0, removed: false }
      ]
    });

    await assert.rejects(
      () =>
        solveWithAStar(engine, {
          maxExpandedStates: 100,
          signal: { aborted: true }
        }),
      /Solver cancelled/
    );
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
    const engine = createEngine({
      width: 3,
      height: 2,
      terrain: [
        [{ type: "floor" }, { type: "floor" }, { type: "floor" }],
        [{ type: "wall" }, { type: "wall" }, { type: "wall" }]
      ],
      actors: [{ type: "player", x: 0, y: 0, removed: false }]
    });
    const result = await findReachablePositions(engine, [
      { id: "near", x: 1, y: 0, elevation: 0 },
      { id: "far", x: 2, y: 0, elevation: 0 },
      { id: "blocked", x: 1, y: 1, elevation: 0 }
    ], { progressYieldStateInterval: 1 });

    assert.equal(result.status, "exhausted");
    assert.deepEqual(
      result.reachable.map((target) => ({ id: target.id, path: target.path })),
      [{ id: "near", path: "R" }, { id: "far", path: "RR" }]
    );
    assert.deepEqual(result.unreachable.map((target) => target.id), ["blocked"]);
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
