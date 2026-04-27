const assert = require("node:assert/strict");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

global.window = {};
loadBrowserScript("public/maze-engine.js");

const { createEngine, terrainTypes } = window.MazeEngine;

function floorTerrain(width, height) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ type: "floor" }))
  );
}

function createState(playData) {
  const engine = createEngine(playData);
  return {
    engine,
    state: engine.cloneState(engine.initialState)
  };
}

{
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: floorTerrain(2, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "gem", x: 1, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.equal(engine.isSolved(state), true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorRemoved[1], 1);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 1, y: 0, removed: false },
      { type: "gem", x: 2, y: 0, removed: false }
    ]
  });

  engine.move(state, 1, 0);

  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(state.actorRemoved[2], 0);

  engine.move(state, 1, 0);

  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorRemoved[2], 1);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][0] = { type: "wall" };
  terrain[0][1] = { type: "hole" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.equal(state.actorRemoved[0], 0);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [1, 0]);
  assert.equal(state.actorRemoved[1], 0);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][2] = { type: "hole" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "floating_floor", x: 1, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(state.terrain[engine.cellIndex(2, 0)], terrainTypes.floor);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][1] = { type: "ice" };
  terrain[0][2] = { type: "ice" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "gem", x: 1, y: 0, removed: false },
      { type: "gem", x: 3, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(state.actorRemoved[1], 0);
  assert.equal(state.actorRemoved[2], 1);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 2,
    terrain: floorTerrain(3, 2),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 1]);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 1, y: 0, removed: false },
      { type: "gem", x: 3, y: 0, removed: false }
    ]
  });
  const beforeKey = engine.stateKey(state);
  const result = engine.moveForSearch(state, 1, 0);

  assert.equal(result.moved, true);
  assert.equal(result.nonPlayerMoveCount, 1);
  assert.notEqual(engine.stateKey(state), beforeKey);

  engine.undoMove(state, result);

  assert.equal(engine.stateKey(state), beforeKey);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [1, 0]);
  assert.equal(state.actorRemoved[2], 0);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][2] = { type: "hole" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "floating_floor", x: 1, y: 0, removed: false }
    ]
  });
  const beforeKey = engine.stateKey(state);
  const result = engine.moveForSearch(state, 1, 0);

  assert.equal(result.moved, true);
  assert.equal(result.nonPlayerMoveCount, 1);
  assert.equal(state.terrain[engine.cellIndex(2, 0)], terrainTypes.floor);

  engine.undoMove(state, result);

  assert.equal(engine.stateKey(state), beforeKey);
  assert.equal(state.terrain[engine.cellIndex(2, 0)], terrainTypes.hole);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [1, 0]);
  assert.equal(state.actorRemoved[1], 0);
}

{
  const terrain = floorTerrain(2, 1);
  terrain[0][1] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [{ type: "player", x: 0, y: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][1] = { type: "orange_wall" };
  terrain[0][2] = { type: "orange_button" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 0);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][1] = { type: "orange_wall" };
  terrain[0][2] = { type: "orange_button" };
  terrain[0][3] = { type: "orange_button" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
}

console.log("maze-engine tests passed");
