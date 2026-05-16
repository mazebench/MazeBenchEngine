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
  const { state } = createState({
    width: 2,
    height: 1,
    terrain: floorTerrain(2, 1),
    actors: [
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 3, removed: false }
    ]
  });

  assert.equal(state.actorElevation[0], 2);
  assert.equal(state.actorElevation[1], 3);
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
  const terrain = floorTerrain(2, 1);
  terrain[0][1] = { type: "ice_block" };
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
  const iceBlock = {
    type: "ice_block",
    layers: [{ type: "ice_block", elevation: 0 }]
  };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[iceBlock, iceBlock, iceBlock]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "gem", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(engine.isSolved(state), true);
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
  const terrain = floorTerrain(4, 1);
  terrain[0][2] = {
    type: "floor",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "wall", elevation: 1 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
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
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(state.actorElevation[1], 0);
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
  const terrain = floorTerrain(2, 1);
  terrain[0][1] = { type: "tree" };
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
  const terrain = floorTerrain(2, 1);
  terrain[0][1] = { type: "shrub" };
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
  const terrain = floorTerrain(2, 1);
  terrain[0][0] = { type: "wall" };
  terrain[0][1] = { type: "shrub" };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 1);
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

{
  const terrain = floorTerrain(2, 2);
  terrain[0][0] = { type: "orange_button" };
  terrain[0][1] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 2,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false }
    ]
  });

  assert.equal(state.actorElevation[1], 0);

  const result = engine.move(state, 0, 1);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 1]);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(boxMove.fromElevation, 0);
  assert.equal(boxMove.toElevation, 1);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][0] = { type: "orange_wall" };
  terrain[0][1] = { type: "orange_wall" };
  terrain[0][2] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [3, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(state.actorElevation[2], 1);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][0] = { type: "orange_wall" };
  terrain[0][1] = { type: "orange_wall" };
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
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.equal(state.actorRemoved[1], 0);
  assert.equal(boxMove.fromElevation, 1);
  assert.equal(boxMove.toElevation, 0);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][0] = { type: "wall" };
  terrain[0][1] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const upperBoxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 0]);
  assert.equal(state.actorElevation[2], 0);
  assert.equal(upperBoxMove.fromElevation, 1);
  assert.equal(upperBoxMove.toElevation, 1);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [1, 0]);
  assert.equal(state.actorElevation[2], 1);
  assert.equal(result.moves.some((move) => move.actorIndex === 2), false);
}

{
  const { state } = createState({
    width: 3,
    height: 1,
    terrain: floorTerrain(3, 1),
    actors: [
      { type: "weightless_box", groupId: "M2", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M2", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M3", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M2", x: 2, y: 0, removed: false },
      { type: "weightless_box", groupId: "M3", x: 2, y: 0, removed: false }
    ]
  });

  assert.deepEqual(Array.from(state.actorElevation), [0, 0, 1, 0, 1]);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][0] = { type: "orange_wall" };
  terrain[0][1] = { type: "orange_wall" };
  terrain[0][2] = { type: "hole" };
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
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(boxMove.fromElevation, 1);
  assert.equal(boxMove.toElevation, 0);
  assert.equal(boxMove.toRemoved, true);
}

{
  const terrain = floorTerrain(3, 2);
  terrain[0][1] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 3,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false }
    ]
  });

  assert.equal(state.actorElevation[1], 1);
  assert.equal(state.actorElevation[2], 1);

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves.find((move) => move.actorIndex === 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 1]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(playerMove.toElevation, 0);
  assert.equal(state.actorElevation[2], 1);
}

{
  const { state } = createState({
    width: 1,
    height: 2,
    terrain: floorTerrain(1, 2),
    actors: [
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 1, elevation: 0, removed: false }
    ]
  });

  assert.deepEqual(Array.from(state.actorElevation), [0, 1, 0]);
}

{
  const { state } = createState({
    width: 1,
    height: 1,
    terrain: floorTerrain(1, 1),
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 1, removed: false }
    ]
  });

  assert.deepEqual(Array.from(state.actorElevation), [0, 1]);
}

{
  const terrain = [
    [
      {
        type: "wall",
        layers: [
          { type: "wall", elevation: 0 },
          { type: "wall", elevation: 1 }
        ]
      },
      {
        type: "ice",
        layers: [
          { type: "ice", elevation: 0 },
          { type: "ice", elevation: 1 }
        ]
      },
      {
        type: "floor"
      }
    ]
  ];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "gem", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  assert.equal(state.actorElevation[0], 2);
  assert.equal(engine.move(state, 1, 0).moved, false);
}

{
  const elevatedIce = {
    type: "ice",
    layers: [
      { type: "ice", elevation: 0 },
      { type: "ice", elevation: 1 }
    ]
  };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: [[elevatedIce, elevatedIce]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "gem", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.equal(engine.isSolved(state), true);
  assert.equal(state.actorRemoved[1], 1);
}

{
  const elevatedIce = {
    type: "ice",
    layers: [
      { type: "ice", elevation: 0 },
      { type: "ice", elevation: 1 }
    ]
  };
  const oneHighWall = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  const twoHighWall = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 }
    ]
  };

  {
    const { engine, state } = createState({
      width: 2,
      height: 1,
      terrain: [[elevatedIce, oneHighWall]],
      actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
    });

    const result = engine.move(state, 1, 0);

    assert.equal(result.moved, true);
    assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
    assert.equal(state.actorElevation[0], 1);
  }

  {
    const { engine, state } = createState({
      width: 2,
      height: 1,
      terrain: [[elevatedIce, twoHighWall]],
      actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
    });

    const result = engine.move(state, 1, 0);

    assert.equal(result.moved, false);
    assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
    assert.equal(state.actorElevation[0], 1);
  }
}

{
  const terrain = floorTerrain(5, 1);
  terrain[0][4] = { type: "wall" };
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [1, 0]);
  assert.deepEqual(
    result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly),
    {
      actorIndex: 0,
      actorType: "player",
      fromElevation: 0,
      fromRemoved: false,
      fromX: 0,
      fromY: 0,
      iceSlide: true,
      punchSlide: true,
      punchStartElevation: 0,
      punchStartIceSlide: false,
      punchStartX: 1,
      punchStartY: 0,
      toElevation: 0,
      toRemoved: false,
      toX: 3,
      toY: 0
    }
  );
  assert.equal(result.moves.some((move) => move.actorType === "puncher" && move.visualOnly), true);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][2] = { type: "hole", layers: [{ type: "hole", elevation: 0 }] };
  terrain[0][3] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorRemoved[0], 1);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][2] = { type: "empty", layers: [] };
  terrain[0][3] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorRemoved[0], 1);
  assert.equal(playerMove.toRemoved, true);
  assert.equal(playerMove.skipHoleFall, undefined);
}

{
  const terrain = floorTerrain(3, 4);
  terrain[2][2] = { type: "empty", layers: [] };
  terrain[3][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 3,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 1, y: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 2]);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(boxMove.toRemoved, true);
  assert.equal(boxMove.punchStartX, 2);
  assert.equal(boxMove.punchStartY, 0);
}

{
  const terrain = floorTerrain(3, 4);
  terrain[3][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 3,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 1, y: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 2]);
  assert.equal(
    result.moves.some(
      (move) =>
        move.actorIndex === 1 &&
        move.punchSlide &&
        move.punchStartX === 2 &&
        move.punchStartY === 0
    ),
    true
  );
}

{
  const terrain = floorTerrain(3, 4);
  terrain[2][2] = { type: "hole", layers: [{ type: "hole", elevation: 0 }] };
  terrain[3][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 3,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 2]);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(boxMove.toRemoved, true);
  assert.equal(boxMove.punchSlide, true);
  assert.equal(boxMove.punchStartX, 2);
  assert.equal(boxMove.punchStartY, 0);
}

{
  const terrain = floorTerrain(3, 4);
  terrain[2][2] = { type: "empty", layers: [] };
  terrain[3][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 3,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 2]);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(boxMove.toRemoved, true);
  assert.equal(boxMove.punchSlide, true);
  assert.equal(boxMove.punchStartX, 2);
  assert.equal(boxMove.punchStartY, 0);
}

{
  const terrain = floorTerrain(5, 1);
  terrain[0][4] = { type: "wall" };
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "right", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [3, 0]);
  assert.equal(result.moves.some((move) => move.actorIndex === 2 && !move.visualOnly), true);
  assert.equal(result.moves.some((move) => move.actorIndex === 1 && move.punchSlide), false);
}

console.log("maze-engine tests passed");
