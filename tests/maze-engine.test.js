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

function iceBlockLayer(elevation = 0) {
  return {
    type: "ice_block",
    layers: [{ type: "ice_block", elevation }]
  };
}

function iceFloorLayer(elevation = 0) {
  return {
    type: "ice",
    layers: [{ type: "ice", elevation }]
  };
}

function iceBlockStack(...elevations) {
  return {
    type: "ice_block",
    layers: elevations.map((elevation) => ({ type: "ice_block", elevation }))
  };
}

function iceSlopeLayer(direction = "right", elevation = 0) {
  return {
    type: "ice_slope",
    layers: [{ type: "ice_slope", direction, elevation }]
  };
}

function iceSlopeOnIceBlockLayer(direction = "right", elevation = 1) {
  return {
    type: "ice_slope",
    layers: [
      { type: "ice_block", elevation: 0 },
      { type: "ice_slope", direction, elevation }
    ]
  };
}

function playerLiftLayer(elevation = 0, raised = false) {
  return {
    type: "player_lift",
    layers: [{ type: "player_lift", elevation, raised }],
    raised
  };
}

function playerGateLayer(elevation = 0) {
  return {
    type: "player_gate",
    layers: [{ type: "player_gate", elevation }]
  };
}

function wallStack(count, startElevation = 0) {
  return {
    type: "wall",
    layers: Array.from({ length: count }, (_, index) => ({
      type: "wall",
      elevation: startElevation + index
    }))
  };
}

function orangeWallStack(count, startElevation = 0, underlayLayers = []) {
  return {
    type: "orange_wall",
    layers: underlayLayers.concat(
      Array.from({ length: count }, (_, index) => ({
        type: "orange_wall",
        elevation: startElevation + index
      }))
    )
  };
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
    width: 2,
    height: 1,
    terrain: [[{ type: "floor" }, playerLiftLayer(0, false)]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves[0];

  assert.equal(result.moved, true);
  assert.deepEqual(result.liftToggles, [{ x: 1, y: 0, raised: true }]);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.equal(playerMove.fromElevation, 0);
  assert.equal(playerMove.toElevation, 1);
  assert.equal(playerMove.pathControlsElevation, undefined);
  assert.equal(playerMove.path, undefined);
}

{
  const oneHighWall = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: [[oneHighWall, playerLiftLayer(0, true)]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves[0];

  assert.equal(result.moved, true);
  assert.deepEqual(result.liftToggles, [{ x: 1, y: 0, raised: false }]);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(state.actorRemoved[0], 0);
  assert.equal(playerMove.fromElevation, 1);
  assert.equal(playerMove.toElevation, 0);
  assert.equal(playerMove.iceSlipOff, undefined);
  assert.equal(playerMove.toRemoved, false);
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
  const terrain = floorTerrain(3, 1);
  terrain[0][2] = { type: "empty", layers: [] };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "floating_floor", x: 1, y: 0, removed: false }
    ]
  });
  const result = engine.moveForSearch(state, 1, 0);

  assert.equal(result.moved, true);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(state.terrain[engine.cellIndex(2, 0)], terrainTypes.floor);

  engine.undoMove(state, result);

  assert.equal(state.terrain[engine.cellIndex(2, 0)], terrainTypes.empty);
  assert.equal(state.actorRemoved[1], 0);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [1, 0]);
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
  const iceBlock = {
    type: "ice_block",
    layers: [{ type: "ice_block", elevation: 0 }]
  };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[iceBlock, iceBlock, { type: "empty" }]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.equal(state.actorRemoved[0], 1);
  assert.equal(result.moves[0].iceSlipOff, true);
  assert.equal(result.moves[0].toRemoved, true);
}

{
  const iceBlock = {
    type: "ice_block",
    layers: [{ type: "ice_block", elevation: 0 }]
  };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[iceBlock, iceBlock, { type: "floor" }]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(state.actorRemoved[0], 0);
  assert.equal(result.moves[0].iceSlipOff, true);
  assert.equal(result.moves[0].toElevation, 0);
  assert.equal(result.moves[0].toRemoved, false);
}

{
  const oneHighWall = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: [[oneHighWall, { type: "empty" }]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorRemoved[0], 0);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0)]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.equal(result.moves[0].iceSlide, true);
  assert.deepEqual(result.moves[0].path, [
    { x: 0, y: 0, elevation: 0 },
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 1 }
  ]);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0)]],
    actors: [{ type: "player", x: 2, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, -1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(result.moves[0].iceSlide, true);
  assert.deepEqual(result.moves[0].path, [
    { x: 2, y: 0, elevation: 1 },
    { x: 1, y: 0, elevation: 1 },
    { x: 0, y: 0, elevation: 0 }
  ]);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), { type: "floor" }]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(state.actorRemoved[0], 0);
  assert.equal(result.moves[0].iceSlipOff, true);
  assert.deepEqual(result.moves[0].path, [
    { x: 0, y: 0, elevation: 0 },
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 0 }
  ]);
}

{
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), { type: "empty" }]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.equal(state.actorRemoved[0], 1);
  assert.equal(result.moves[0].iceSlipOff, true);
}

{
  const tallWall = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 }
    ]
  };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), tallWall]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(result.moves[0].visualOnly, true);
  assert.deepEqual(result.moves[0].path, [
    { x: 0, y: 0, elevation: 0 },
    { x: 1, y: 0, elevation: 1 },
    { x: 0, y: 0, elevation: 0 }
  ]);
}

{
  const threeHighWall = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 },
      { type: "wall", elevation: 2 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[iceBlockLayer(0), iceBlockLayer(0), iceSlopeLayer("right", 1), threeHighWall]],
    actors: [{ type: "player", x: 1, y: 0, elevation: 1, removed: false }]
  });

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves.find((move) => move.actorIndex === 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.equal(playerMove.visualOnly, undefined);
  assert.equal(playerMove.iceSlide, true);
  assert.deepEqual(playerMove.path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 1, y: 0, elevation: 1 },
    { x: 0, y: 0, elevation: 1 }
  ]);
}

{
  const threeHighWall = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 },
      { type: "wall", elevation: 2 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[iceBlockLayer(0), iceBlockLayer(0), iceSlopeLayer("right", 1), threeHighWall]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [0, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(boxMove.iceSlide, true);
  assert.deepEqual(boxMove.path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 1, y: 0, elevation: 1 },
    { x: 0, y: 0, elevation: 1 }
  ]);
}

{
  const threeHighWall = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 },
      { type: "wall", elevation: 2 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[iceBlockLayer(0), iceBlockLayer(0), iceSlopeLayer("right", 1), threeHighWall]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [0, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(boxMove.iceSlide, true);
  assert.deepEqual(boxMove.path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 1, y: 0, elevation: 1 },
    { x: 0, y: 0, elevation: 1 }
  ]);
}

{
  const terrain = [[
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceSlopeLayer("right", 1),
    iceSlopeLayer("left", 0),
    { type: "floor" },
    { type: "floor" }
  ]];
  const { engine, state } = createState({
    width: 6,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.equal(boxMoves.length, 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [5, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.deepEqual(boxMoves[0].path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 1 },
    { x: 4, y: 0, elevation: 0 },
    { x: 5, y: 0, elevation: 0 }
  ]);
}

{
  const terrain = [[
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceSlopeLayer("right", 1),
    iceSlopeLayer("left", 0),
    { type: "floor" },
    { type: "floor" }
  ]];
  const { engine, state } = createState({
    width: 6,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.equal(boxMoves.length, 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [5, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.deepEqual(boxMoves[0].path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 1 },
    { x: 4, y: 0, elevation: 0 },
    { x: 5, y: 0, elevation: 0 }
  ]);
}

{
  const terrain = [[
    wallStack(1),
    wallStack(1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceSlopeOnIceBlockLayer("right", 1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0)
  ]];
  const { engine, state } = createState({
    width: 9,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(boxMoves.map((move) => [move.toX, move.toElevation]), [
    [5, 1],
    [6, 1],
    [7, 1]
  ]);
  assert.deepEqual(boxMoves[0].path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 4, y: 0, elevation: 2 },
    { x: 5, y: 0, elevation: 2 },
    { x: 5, y: 0, elevation: 1 }
  ]);
  assert.equal(boxMoves[0].pathEndElevation, 1);
}

{
  const terrain = [[
    wallStack(1),
    wallStack(1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceSlopeOnIceBlockLayer("right", 1),
    iceBlockStack(0, 1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0)
  ]];
  const { engine, state } = createState({
    width: 10,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(boxMoves.map((move) => [move.toX, move.toElevation]), [
    [6, 1],
    [7, 1],
    [8, 1]
  ]);
  assert.deepEqual(boxMoves[0].path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 4, y: 0, elevation: 2 },
    { x: 5, y: 0, elevation: 2 },
    { x: 6, y: 0, elevation: 2 },
    { x: 6, y: 0, elevation: 1 }
  ]);
  assert.equal(boxMoves[0].pathEndElevation, 1);
}

{
  const terrain = [[
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceSlopeOnIceBlockLayer("right", 1),
    iceBlockStack(0, 1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0)
  ]];
  const { engine, state } = createState({
    width: 9,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 3, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(boxMoves.map((move) => [move.toX, move.toElevation]), [
    [4, 1],
    [4, 2],
    [4, 3]
  ]);
  assert.deepEqual(boxMoves[0].path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 4, y: 0, elevation: 2 },
    { x: 4, y: 0, elevation: 1 }
  ]);
  assert.equal(boxMoves[0].pathEndElevation, 1);
}

{
  const terrain = [[
    wallStack(2),
    wallStack(2),
    iceBlockLayer(1),
    iceBlockLayer(1),
    iceSlopeOnIceBlockLayer("left", 1),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0)
  ]];
  const { engine, state } = createState({
    width: 9,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(boxMoves.map((move) => [move.toX, move.toElevation]), [
    [5, 1],
    [6, 1],
    [7, 1]
  ]);
  assert.deepEqual(boxMoves[0].path, [
    { x: 1, y: 0, elevation: 2 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 4, y: 0, elevation: 2 },
    { x: 5, y: 0, elevation: 2 },
    { x: 5, y: 0, elevation: 1 }
  ]);
  assert.equal(boxMoves[0].pathEndElevation, 1);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0), iceBlockLayer(0)]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(result.moves.some((move) => move.visualOnly), false);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0), iceBlockLayer(0)]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(result.moves.some((move) => move.visualOnly), false);
}

{
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain: [[{ type: "floor" }, { type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0), iceBlockLayer(0)]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 1, y: 0, elevation: 0, removed: false },
      { type: "box", x: 3, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [4, 0]);
  assert.equal(state.actorElevation[2], 1);
  assert.deepEqual(result.moves.find((move) => move.actorIndex === 1).path, [
    { x: 1, y: 0, elevation: 0 },
    { x: 2, y: 0, elevation: 1 },
    { x: 3, y: 0, elevation: 1 }
  ]);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0), iceBlockLayer(0)]],
    actors: [
      { type: "player", x: 3, y: 0, elevation: 1, removed: false },
      { type: "box", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, -1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(state.actorElevation[0], 1);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [0, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.deepEqual(result.moves.find((move) => move.actorIndex === 1).path, [
    { x: 2, y: 0, elevation: 1 },
    { x: 1, y: 0, elevation: 1 },
    { x: 0, y: 0, elevation: 0 }
  ]);
  assert.deepEqual(result.moves.find((move) => move.actorIndex === 0).path, [
    { x: 3, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 1 },
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 1 },
    { x: 3, y: 0, elevation: 1 }
  ]);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][1] = { type: "ice" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[{ type: "floor" }, iceSlopeLayer("right", 0), iceSlopeLayer("right", 1), iceBlockLayer(1)]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(state.actorElevation[0], 2);
  assert.equal(result.moves[0].iceSlide, true);
  assert.deepEqual(result.moves[0].path, [
    { x: 0, y: 0, elevation: 0 },
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 }
  ]);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[{ type: "floor" }, { type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0)]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorElevation[1], 1);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);
  assert.equal(boxMove.iceSlide, true);
  assert.deepEqual(boxMove.path, [
    { x: 1, y: 0, elevation: 0 },
    { x: 2, y: 0, elevation: 1 },
    { x: 3, y: 0, elevation: 1 }
  ]);
}

{
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain: [[{ type: "floor" }, { type: "floor" }, iceSlopeLayer("right", 0), iceBlockLayer(0), iceBlockLayer(0)]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "box", x: 3, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorElevation[1], 1);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [4, 0]);
  assert.equal(state.actorElevation[2], 1);
  assert.deepEqual(result.moves.find((move) => move.actorIndex === 1).path, [
    { x: 1, y: 0, elevation: 0 },
    { x: 2, y: 0, elevation: 1 },
    { x: 3, y: 0, elevation: 1 }
  ]);
}

{
  const highIce = {
    type: "ice_block",
    layers: [
      { type: "floor", elevation: 0 },
      { type: "ice_block", elevation: 1 }
    ]
  };
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain: [[highIce, iceSlopeLayer("right", 0)]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 2, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(result.moves[0].iceSlipOff, true);
}

{
  const tower = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 }
    ]
  };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain: [[tower, iceSlopeLayer("left", 0), { type: "floor" }]],
    actors: [{ type: "player", x: 0, y: 0, elevation: 2, removed: false }]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 2);
  assert.equal(state.actorRemoved[0], 0);
}

{
  const lowWall = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  const terrain = floorTerrain(3, 3);
  terrain[0][1] = lowWall;
  terrain[1][1] = lowWall;
  terrain[2][1] = iceSlopeLayer("right", 0);
  const { engine, state } = createState({
    width: 3,
    height: 3,
    terrain,
    actors: [
      { type: "player", x: 1, y: 0, elevation: 1, removed: false },
      { type: "box", x: 1, y: 1, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 0, 1);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [0, 2]);
  assert.equal(state.actorElevation[1], 0);
  assert.equal(boxMove.iceSlide, true);
  assert.deepEqual(boxMove.path, [
    { x: 1, y: 1, elevation: 1 },
    { x: 1, y: 2, elevation: 1 },
    { x: 0, y: 2, elevation: 0 }
  ]);
}

{
  const tower = {
    type: "wall",
    layers: [{ type: "wall", elevation: 0 }]
  };
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain: [[tower, tower, iceSlopeLayer("right", 1), iceSlopeLayer("left", 0), { type: "floor" }]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [4, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.equal(boxMove.iceSlide, true);
  assert.deepEqual(boxMove.path, [
    { x: 1, y: 0, elevation: 1 },
    { x: 2, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 2 },
    { x: 3, y: 0, elevation: 1 },
    { x: 4, y: 0, elevation: 0 }
  ]);
}

{
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain: [[iceBlockLayer(0), iceSlopeLayer("right", 1), iceSlopeLayer("left", 0), { type: "floor" }, { type: "floor" }]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 3, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);
  const playerMove = result.moves.find((move) => move.actorIndex === 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [4, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.deepEqual([boxMove.fromX, boxMove.toX], [3, 4]);
  assert.deepEqual(playerMove.path, [
    { x: 0, y: 0, elevation: 1 },
    { x: 1, y: 0, elevation: 2 },
    { x: 2, y: 0, elevation: 2 },
    { x: 2, y: 0, elevation: 1 },
    { x: 3, y: 0, elevation: 0 }
  ]);
}

{
  const tower = {
    type: "wall",
    layers: [
      { type: "wall", elevation: 0 },
      { type: "wall", elevation: 1 }
    ]
  };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: [[tower, tower, iceSlopeLayer("left", 0), { type: "floor" }]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: 2, removed: false },
      { type: "box", x: 1, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [3, 0]);
  assert.equal(state.actorElevation[1], 0);
  assert.equal(boxMove.iceSlide, true);
  assert.deepEqual(boxMove.path, [
    { x: 1, y: 0, elevation: 2 },
    { x: 2, y: 0, elevation: 2 },
    { x: 2, y: 0, elevation: 1 },
    { x: 3, y: 0, elevation: 0 }
  ]);
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
  terrain[0][1] = { type: "block_asset" };
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
  const terrain = floorTerrain(3, 1);
  terrain[0][1] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 2, y: 0, removed: false },
      { type: "orange_button", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 0);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][1] = orangeWallStack(2);
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

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][0] = { type: "wall", layers: [{ type: "wall", elevation: 0 }] };
  terrain[0][1] = orangeWallStack(2);
  terrain[0][2] = { type: "orange_button" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 1);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][0] = { type: "wall", layers: [{ type: "wall", elevation: 0 }] };
  terrain[0][1] = orangeWallStack(1, 1, [{ type: "wall", elevation: 0 }]);
  terrain[0][2] = { type: "orange_button" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [1, 0]);
  assert.equal(state.actorElevation[0], 1);
}

{
  const terrain = floorTerrain(3, 1);
  terrain[0][0] = { type: "wall", layers: [{ type: "wall", elevation: 0 }] };
  terrain[0][1] = orangeWallStack(1, 2);
  terrain[0][2] = { type: "orange_button" };
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 2, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 1);
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
      { type: "orange_button", x: 1, y: 0, elevation: 0, removed: false },
      { type: "gem", x: 3, y: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(state.actorRemoved[2], 1);
}

{
  const terrain = floorTerrain(3, 1);
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "orange_button", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const buttonMove = result.moves.find((move) => move.actorIndex === 2);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 0]);
  assert.equal(state.actorElevation[2], 1);
  assert.equal(buttonMove.actorType, "orange_button");
  assert.equal(buttonMove.fromX, 1);
  assert.equal(buttonMove.toX, 2);
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
  const terrain = floorTerrain(2, 2);
  terrain[0][0] = { type: "orange_button" };
  terrain[0][1] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 2,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
      { type: "player", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 0, 1);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);
  const riderMove = result.moves.find((move) => move.actorIndex === 2);

  assert.equal(result.moved, true);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(state.actorElevation[2], 2);
  assert.equal(boxMove.fromElevation, 0);
  assert.equal(boxMove.toElevation, 1);
  assert.equal(riderMove.fromElevation, 1);
  assert.equal(riderMove.toElevation, 2);
}

{
  const terrain = floorTerrain(2, 2);
  terrain[0][1] = { type: "orange_wall" };
  const { engine, state } = createState({
    width: 2,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "orange_button", x: 0, y: 1, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "player", x: 1, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 0, 1);
  const boxMove = result.moves.find((move) => move.actorIndex === 2);
  const riderMove = result.moves.find((move) => move.actorIndex === 3);

  assert.equal(result.moved, true);
  assert.equal(state.actorElevation[2], 0);
  assert.equal(state.actorElevation[3], 1);
  assert.equal(boxMove.fromElevation, 1);
  assert.equal(boxMove.toElevation, 0);
  assert.equal(riderMove.fromElevation, 2);
  assert.equal(riderMove.toElevation, 1);
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
  const terrain = [[wallStack(2), playerGateLayer(0), wallStack(1)]];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 2, removed: false },
      { type: "circle_player", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, -1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [1, 0, 1]);
}

{
  const terrain = [[wallStack(1), playerGateLayer(0)]];
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "box", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 1]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [1, 0, 0]);
}

{
  const terrain = [[{ type: "floor" }, playerGateLayer(0), { type: "floor" }]];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [2, 0, 0]);
}

{
  const terrain = [[playerGateLayer(0)]];
  const { engine, state } = createState({
    width: 1,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false }
    ]
  });

  assert.equal(engine.computeRaisedPlayerGateSet(state).has(engine.cellIndex(0, 0)), false);
}

{
  const terrain = [[wallStack(1), wallStack(1), playerGateLayer(0)]];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "box", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const lowerMove = result.moves.find((move) => move.actorIndex === 1);
  const riderMove = result.moves.find((move) => move.actorIndex === 2);

  assert.equal(result.moved, true);
  assert.equal(engine.computeRaisedPlayerGateSet(state).has(engine.cellIndex(2, 0)), true);
  assert.equal(state.actorElevation[1], 1);
  assert.equal(state.actorElevation[2], 2);
  assert.equal(lowerMove.fromElevation, 0);
  assert.equal(lowerMove.toElevation, 1);
  assert.equal(riderMove.fromElevation, 1);
  assert.equal(riderMove.toElevation, 2);
}

{
  const terrain = [[wallStack(1), wallStack(1), playerGateLayer(0)]];
  const { engine, state } = createState({
    width: 3,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 1, removed: false },
      { type: "box", x: 2, y: 0, elevation: 2, removed: false }
    ]
  });

  assert.equal(engine.computeRaisedPlayerGateSet(state).has(engine.cellIndex(2, 0)), true);

  const result = engine.move(state, -1, 0);
  const lowerMove = result.moves.find((move) => move.actorIndex === 1);
  const riderMove = result.moves.find((move) => move.actorIndex === 2);

  assert.equal(result.moved, true);
  assert.equal(engine.computeRaisedPlayerGateSet(state).has(engine.cellIndex(2, 0)), false);
  assert.equal(state.actorElevation[1], 0);
  assert.equal(state.actorElevation[2], 1);
  assert.equal(lowerMove.fromElevation, 1);
  assert.equal(lowerMove.toElevation, 0);
  assert.equal(riderMove.fromElevation, 2);
  assert.equal(riderMove.toElevation, 1);
}

{
  const terrain = [[
    wallStack(1),
    {
      type: "player_gate",
      layers: [
        { type: "player_gate", elevation: 0 },
        { type: "wall", elevation: 2 }
      ]
    }
  ]];
  const { engine, state } = createState({
    width: 2,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 1, y: 0, elevation: 3, removed: false },
      { type: "circle_player", x: 0, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [1, 0, 1]);
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
  const puncherVisualMove = result.moves.find((move) => move.actorIndex === 1 && move.visualOnly);

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
      punchSegments: [
        {
          fromElevation: 0,
          fromX: 1,
          fromY: 0,
          punchSlide: true,
          sequence: 0,
          startIceSlide: false,
          toElevation: 0,
          toX: 3,
          toY: 0
        }
      ],
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
  assert.deepEqual(
    {
      fromX: puncherVisualMove.fromX,
      fromY: puncherVisualMove.fromY,
      toX: puncherVisualMove.toX,
      toY: puncherVisualMove.toY,
      targetX: puncherVisualMove.targetX,
      targetY: puncherVisualMove.targetY,
      finalX: puncherVisualMove.finalX,
      finalY: puncherVisualMove.finalY
    },
    { fromX: 1, fromY: 0, toX: 2, toY: 0, targetX: 3, targetY: 0, finalX: 1, finalY: 0 }
  );
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [{ type: "player", x: 0, y: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0, { continuePunchSlide: true });
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(playerMove.punchSlide, true);
  assert.equal(playerMove.levelExit, true);
  assert.equal(playerMove.levelExitDx, 1);
  assert.equal(playerMove.levelExitDy, 0);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][3] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [{ type: "player", x: 0, y: 0, removed: false }]
  });

  const result = engine.move(state, 1, 0, { continuePunchSlide: true });
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(playerMove.punchSlide, true);
  assert.equal(playerMove.levelExit, undefined);
}

{
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain: floorTerrain(4, 1),
    actors: [{ type: "player", x: 0, y: 0, elevation: 2, removed: false }]
  });

  const result = engine.move(state, 1, 0, { continuePunchSlide: true });
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.equal(state.actorElevation[0], 2);
  assert.equal(playerMove.punchSlide, true);
  assert.equal(playerMove.levelExit, true);
  assert.equal(playerMove.levelExitElevation, 2);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][3] = wallStack(3);
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [{ type: "player", x: 0, y: 0, elevation: 2, removed: false }]
  });

  const result = engine.move(state, 1, 0, { continuePunchSlide: true });
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [2, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(playerMove.punchSlide, true);
  assert.equal(playerMove.pathControlsElevation, true);
  assert.deepEqual(playerMove.path.at(-1), { x: 2, y: 0, elevation: 0 });
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][3] = wallStack(3);
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 2, removed: false },
      { type: "puncher", direction: "left", x: 2, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0, { continuePunchSlide: true });
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);
  const puncherMove = result.moves.find((move) => move.actorIndex === 1 && move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [0, 0]);
  assert.equal(state.actorElevation[0], 0);
  assert.equal(playerMove.punchSlide, true);
  assert.deepEqual(
    playerMove.punchSegments.map(({ fromX, fromY, fromElevation, toX, toY, toElevation }) => ({
      fromX,
      fromY,
      fromElevation,
      toX,
      toY,
      toElevation
    })),
    [{ fromX: 2, fromY: 0, fromElevation: 0, toX: 0, toY: 0, toElevation: 0 }]
  );
  assert.equal(puncherMove?.punchSequence, 0);
}

{
  const terrain = floorTerrain(5, 4);
  terrain[0][4] = { type: "wall" };
  terrain[3][3] = { type: "wall" };
  const { engine, state } = createState({
    width: 5,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 3, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves.find((move) => move.actorIndex === 0 && !move.visualOnly);
  const puncherMoves = result.moves.filter((move) => move.actorType === "puncher" && move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 2]);
  assert.deepEqual(
    playerMove.punchSegments.map(
      ({ sequence, fromX, fromY, fromElevation, toX, toY, toElevation, startIceSlide }) => ({
        sequence,
        fromX,
        fromY,
        fromElevation,
        toX,
        toY,
        toElevation,
        startIceSlide
      })
    ),
    [
      {
        sequence: 0,
        fromX: 1,
        fromY: 0,
        fromElevation: 0,
        toX: 3,
        toY: 0,
        toElevation: 0,
        startIceSlide: false
      },
      {
        sequence: 1,
        fromX: 3,
        fromY: 0,
        fromElevation: 0,
        toX: 3,
        toY: 2,
        toElevation: 0,
        startIceSlide: true
      }
    ]
  );
  assert.deepEqual(
    puncherMoves.map((move) => move.punchSequence).sort(),
    [0, 1]
  );
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

{
  const terrain = floorTerrain(6, 5);
  const { engine, state } = createState({
    width: 6,
    height: 5,
    terrain,
    actors: [
      { type: "player", x: 4, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 1, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, -1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[1], state.actorY[1], state.actorX[2], state.actorY[2], state.actorX[3], state.actorY[3]],
    [1, 0, 2, 0, 2, 1]
  );
  assert.deepEqual([state.actorX[4], state.actorY[4]], [1, 1]);
  assert.equal(boxMoves.some((move) => move.punchSlide), false);
}

{
  const terrain = floorTerrain(7, 5);
  const { engine, state } = createState({
    width: 7,
    height: 5,
    terrain,
    actors: [
      { type: "player", x: 1, y: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 1, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[1], state.actorY[1], state.actorX[2], state.actorY[2], state.actorX[3], state.actorY[3]],
    [3, 0, 4, 0, 4, 1]
  );
  assert.deepEqual([state.actorX[4], state.actorY[4]], [3, 1]);
  assert.equal(boxMoves.some((move) => move.punchSlide), false);
}

{
  const terrain = floorTerrain(4, 6);
  terrain[5][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 6,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, removed: false },
      { type: "box", x: 1, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "up", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 1, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);
  const attachedPuncherMove = result.moves.find((move) => move.actorIndex === 2 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 4]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 3]);
  assert.equal(boxMove.punchStartX, 2);
  assert.equal(boxMove.punchStartY, 1);
  assert.deepEqual(
    attachedPuncherMove.punchSegments.map(
      ({ sequence, fromX, fromY, fromElevation, toX, toY, toElevation }) => ({
        sequence,
        fromX,
        fromY,
        fromElevation,
        toX,
        toY,
        toElevation
      })
    ),
    [
      {
        sequence: 0,
        fromX: 2,
        fromY: 0,
        fromElevation: 0,
        toX: 2,
        toY: 3,
        toElevation: 0
      }
    ]
  );
}

{
  const terrain = floorTerrain(6, 1);
  terrain[0][5] = { type: "wall" };
  const { engine, state } = createState({
    width: 6,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "box", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "right", x: 2, y: 0, elevation: 0, removed: false },
      { type: "box", x: 3, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const carriedPuncherMove = result.moves.find((move) => move.actorIndex === 2 && !move.visualOnly);
  const puncherVisualMove = result.moves.find((move) => move.actorIndex === 2 && move.visualOnly);
  const punchedBoxMove = result.moves.find((move) => move.actorIndex === 3 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [3, 0]);
  assert.deepEqual([state.actorX[3], state.actorY[3]], [4, 0]);
  assert.deepEqual(
    {
      fromX: carriedPuncherMove.fromX,
      fromY: carriedPuncherMove.fromY,
      toX: carriedPuncherMove.toX,
      toY: carriedPuncherMove.toY
    },
    { fromX: 2, fromY: 0, toX: 3, toY: 0 }
  );
  assert.deepEqual(
    {
      fromX: puncherVisualMove.fromX,
      fromY: puncherVisualMove.fromY,
      toX: puncherVisualMove.toX,
      toY: puncherVisualMove.toY,
      finalX: puncherVisualMove.finalX,
      finalY: puncherVisualMove.finalY,
      punchSequence: puncherVisualMove.punchSequence
    },
    { fromX: 2, fromY: 0, toX: 4, toY: 0, finalX: 3, finalY: 0, punchSequence: 0 }
  );
  assert.equal(punchedBoxMove.punchStartX, 3);
  assert.equal(punchedBoxMove.punchStartY, 0);
  assert.deepEqual(
    punchedBoxMove.punchSegments.map(({ sequence, fromX, fromY, toX, toY }) => ({
      sequence,
      fromX,
      fromY,
      toX,
      toY
    })),
    [{ sequence: 0, fromX: 3, fromY: 0, toX: 4, toY: 0 }]
  );
}

{
  const terrain = floorTerrain(7, 3);
  terrain[1][6] = { type: "wall" };
  const { engine, state } = createState({
    width: 7,
    height: 3,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, removed: false },
      { type: "box", x: 1, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "right", x: 2, y: 1, elevation: 0, removed: false },
      { type: "box", x: 3, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "up", x: 3, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const targetBoxMove = result.moves.find((move) => move.actorIndex === 3 && !move.visualOnly);
  const targetPuncherMove = result.moves.find((move) => move.actorIndex === 4 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 1]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [3, 1]);
  assert.deepEqual([state.actorX[3], state.actorY[3]], [5, 1]);
  assert.deepEqual([state.actorX[4], state.actorY[4]], [5, 0]);
  assert.equal(targetBoxMove.punchStartX, 3);
  assert.equal(targetBoxMove.punchStartY, 1);
  assert.deepEqual(
    targetPuncherMove.punchSegments.map(({ sequence, fromX, fromY, toX, toY }) => ({
      sequence,
      fromX,
      fromY,
      toX,
      toY
    })),
    [{ sequence: 0, fromX: 3, fromY: 0, toX: 5, toY: 0 }]
  );
}

{
  const terrain = floorTerrain(4, 4);
  terrain[1][2] = { type: "hole", layers: [{ type: "hole", elevation: 0 }] };
  terrain[3][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "up", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 1, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);
  const attachedPuncherMove = result.moves.find((move) => move.actorIndex === 2 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 2]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 1]);
  assert.equal(state.actorRemoved[1], 0);
  assert.equal(state.actorRemoved[2], 0);
  assert.equal(boxMove.toRemoved, false);
  assert.equal(attachedPuncherMove.toRemoved, false);
  assert.equal(attachedPuncherMove.stickyCarrierEntityKey, "weightless:M0");
}

{
  const terrain = floorTerrain(4, 4);
  terrain[1][2] = { type: "hole", layers: [{ type: "hole", elevation: 0 }] };
  terrain[2][2] = { type: "hole", layers: [{ type: "hole", elevation: 0 }] };
  terrain[3][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 4,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "up", x: 1, y: 0, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 1, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);
  const attachedPuncherMove = result.moves.find((move) => move.actorIndex === 2 && !move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 2]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 1]);
  assert.equal(state.actorRemoved[1], 1);
  assert.equal(state.actorRemoved[2], 1);
  assert.equal(boxMove.toRemoved, true);
  assert.equal(attachedPuncherMove.toRemoved, true);
  assert.equal(attachedPuncherMove.stickyCarrierEntityKey, "weightless:M0");
}

{
  const terrain = floorTerrain(4, 5);
  terrain[4][2] = { type: "wall" };
  const { engine, state } = createState({
    width: 4,
    height: 5,
    terrain,
    actors: [
      { type: "player", x: 0, y: 2, removed: false },
      { type: "box", x: 2, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 2, elevation: 0, removed: false },
      { type: "box", x: 1, y: 2, elevation: 0, removed: false },
      { type: "puncher", direction: "up", x: 1, y: 1, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const upperBoxMove = result.moves.find((move) => move.actorIndex === 1 && !move.visualOnly);
  const lowerBoxMove = result.moves.find((move) => move.actorIndex === 3 && !move.visualOnly);
  const downPuncherMove = result.moves.find((move) => move.actorIndex === 2 && !move.visualOnly);
  const upPuncherMove = result.moves.find((move) => move.actorIndex === 4 && !move.visualOnly);
  const downPuncherVisualMove = result.moves.find((move) => move.actorIndex === 2 && move.visualOnly);
  const upPuncherVisualMove = result.moves.find((move) => move.actorIndex === 4 && move.visualOnly);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[1], state.actorY[1]], [2, 0]);
  assert.deepEqual([state.actorX[3], state.actorY[3]], [2, 3]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [2, 1]);
  assert.deepEqual([state.actorX[4], state.actorY[4]], [2, 2]);
  assert.equal(upperBoxMove.punchSlide, true);
  assert.equal(lowerBoxMove.punchSlide, true);
  assert.equal(downPuncherMove.stickyCarrierEntityKey, "actor:1");
  assert.equal(upPuncherMove.stickyCarrierEntityKey, "actor:3");
  assert.deepEqual(
    {
      toX: downPuncherVisualMove.toX,
      toY: downPuncherVisualMove.toY,
      finalX: downPuncherVisualMove.finalX,
      finalY: downPuncherVisualMove.finalY,
      punchSequence: downPuncherVisualMove.punchSequence
    },
    { toX: 2, toY: 2, finalX: 2, finalY: 1, punchSequence: 0 }
  );
  assert.deepEqual(
    {
      toX: upPuncherVisualMove.toX,
      toY: upPuncherVisualMove.toY,
      finalX: upPuncherVisualMove.finalX,
      finalY: upPuncherVisualMove.finalY,
      punchSequence: upPuncherVisualMove.punchSequence
    },
    { toX: 2, toY: 1, finalX: 2, finalY: 2, punchSequence: 0 }
  );
}

{
  const terrain = floorTerrain(7, 6);
  terrain[5][2] = { type: "wall" };
  terrain[5][3] = { type: "wall" };
  terrain[5][4] = { type: "wall" };
  const { engine, state } = createState({
    width: 7,
    height: 6,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 4, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 4, y: 1, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 4, y: 2, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 2, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 1, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 1, y: 1, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 2, y: 1, elevation: 0, removed: false },
      { type: "puncher", direction: "down", x: 2, y: 2, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const m0Moves = result.moves.filter(
    (move) => move.actorType === "weightless_box" && [1, 2, 3, 4, 5, 6].includes(move.actorIndex)
  );
  const m1Moves = result.moves.filter(
    (move) => move.actorType === "weightless_box" && [8, 9].includes(move.actorIndex)
  );

  assert.equal(result.moved, true);
  assert.deepEqual(
    [state.actorX[1], state.actorY[1], state.actorX[6], state.actorY[6]],
    [2, 2, 3, 4]
  );
  assert.deepEqual(
    [state.actorX[8], state.actorY[8], state.actorX[9], state.actorY[9]],
    [2, 3, 3, 3]
  );
  assert.deepEqual([state.actorX[7], state.actorY[7]], [2, 3]);
  assert.deepEqual([state.actorX[10], state.actorY[10]], [3, 4]);
  assert.equal(m0Moves.every((move) => move.punchSlide === true), true);
  assert.equal(m1Moves.every((move) => move.punchSlide === true), true);
}

{
  const terrain = floorTerrain(7, 1);
  terrain[0][6] = { type: "wall" };
  const { engine, state } = createState({
    width: 7,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false },
      { type: "box", x: 2, y: 0, elevation: 0, removed: false },
      { type: "box", x: 3, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [4, 0]);
  assert.deepEqual([state.actorX[3], state.actorY[3]], [5, 0]);
  assert.equal(
    [0, 2, 3].every((actorIndex) =>
      result.moves.some((move) => move.actorIndex === actorIndex && move.punchSlide === true)
    ),
    true
  );
}

{
  const terrain = floorTerrain(7, 2);
  terrain[0][6] = { type: "wall" };
  terrain[1][6] = { type: "wall" };
  const { engine, state } = createState({
    width: 7,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, removed: false },
      { type: "puncher", direction: "right", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 1, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 3, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0]], [3, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2]], [4, 0]);
  assert.deepEqual([state.actorX[3], state.actorY[3]], [4, 1]);
  assert.deepEqual([state.actorX[4], state.actorY[4]], [5, 0]);
  assert.equal(
    [0, 2, 3, 4].every((actorIndex) =>
      result.moves.some((move) => move.actorIndex === actorIndex && move.punchSlide === true)
    ),
    true
  );
}

{
  const terrain = floorTerrain(5, 1);
  terrain[0][0] = wallStack(1);
  terrain[0][1] = wallStack(1);
  terrain[0][2] = wallStack(1);
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 2, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 3, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [2, 0, 1]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [3, 0, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2], state.actorElevation[2]], [3, 0, 1]);
}

{
  const terrain = floorTerrain(4, 2);
  terrain[0][0] = iceBlockLayer(0);
  terrain[1][0] = iceBlockLayer(0);
  const { engine, state } = createState({
    width: 4,
    height: 2,
    terrain,
    actors: [
      { type: "player", x: 0, y: 1, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 1, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [1, 0, 0]);
  assert.deepEqual([state.actorX[2], state.actorY[2], state.actorElevation[2]], [2, 0, 0]);
  assert.deepEqual([state.actorX[3], state.actorY[3], state.actorElevation[3]], [2, 1, 0]);
  assert.equal(result.moves.some((move) => move.actorIndex === 0 && move.iceSlipOff), true);
}

{
  const terrain = [[
    iceFloorLayer(0),
    iceFloorLayer(0),
    iceFloorLayer(0),
    iceSlopeLayer("left", 0),
    { type: "floor" }
  ]];
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [1, 0]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [2, 0]);
  assert.deepEqual([state.actorX[2], state.actorElevation[2]], [2, 1]);
  assert.equal(
    result.moves.some((move) => Array.isArray(move.path) && move.path.some((point) => point.elevation < 0)),
    false
  );
}

{
  const terrain = [[
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceBlockLayer(0),
    iceSlopeLayer("left", 1),
    { type: "floor" }
  ]];
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorElevation[0]], [1, 1]);
  assert.deepEqual([state.actorX[1], state.actorElevation[1]], [2, 1]);
  assert.deepEqual([state.actorX[2], state.actorElevation[2]], [2, 2]);
}

{
  const terrain = Array.from({ length: 10 }, (_, y) =>
    Array.from({ length: 2 }, () => (y === 9 ? wallStack(1) : iceFloorLayer(0)))
  );
  const actors = [
    { type: "weightless_box", groupId: "M0", x: 0, y: 1, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 1, y: 1, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 0, y: 2, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 0, y: 3, elevation: 0, removed: false },
    { type: "player", x: 1, y: 3, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 0, y: 4, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 1, y: 4, elevation: 0, removed: false }
  ];
  const { engine, state } = createState({
    width: 2,
    height: 10,
    terrain,
    actors
  });

  const result = engine.move(state, 0, 1);
  const playerMove = result.moves.find((move) => move.actorIndex === 4);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[4], state.actorY[4], state.actorElevation[4]], [1, 7, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [1, 5, 0]);
  assert.deepEqual([state.actorX[6], state.actorY[6], state.actorElevation[6]], [1, 8, 0]);
  assert.equal(playerMove.iceSlide, true);
  assert.deepEqual(playerMove.path, [
    { x: 1, y: 3, elevation: 0 },
    { x: 1, y: 4, elevation: 0 },
    { x: 1, y: 5, elevation: 0 },
    { x: 1, y: 6, elevation: 0 },
    { x: 1, y: 7, elevation: 0 }
  ]);
  assert.ok(
    result.moves.some(
      (move) =>
        move.actorType === "weightless_box" &&
        Array.isArray(move.path) &&
        move.path.slice(1).some((point) => point.x === 1 && point.y === 4 && point.elevation === 0)
    )
  );
}

{
  const terrain = [[
    { type: "floor" },
    { type: "floor" },
    iceFloorLayer(0),
    iceFloorLayer(0),
    wallStack(1)
  ]];
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "box", x: 1, y: 0, elevation: 0, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const playerMove = result.moves.find((move) => move.actorIndex === 0);
  const boxMove = result.moves.find((move) => move.actorIndex === 1);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 0]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [3, 0, 0]);
  assert.equal(playerMove.iceSlide, false);
  assert.equal(boxMove.iceSlide, true);
}

{
  const terrain = [[wallStack(1), wallStack(1), wallStack(1), wallStack(1), wallStack(1)]];
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 2]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [1, 0, 1]);
  assert.deepEqual([state.actorX[4], state.actorY[4], state.actorElevation[4]], [2, 0, 2]);
}

{
  const terrain = [[wallStack(1), wallStack(1), wallStack(1), wallStack(1)]];
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 0, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [0, 0, 2]);
  assert.deepEqual([state.actorX[1], state.actorY[1], state.actorElevation[1]], [0, 0, 1]);
}

{
  const terrain = floorTerrain(5, 1);
  terrain[0][2] = { type: "hole" };
  terrain[0][3] = { type: "hole" };
  terrain[0][4] = { type: "hole" };
  const { engine, state } = createState({
    width: 5,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M2", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M2", x: 2, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M1", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(Array.from(state.actorRemoved).slice(1), [1, 1, 1, 1]);
  assert.deepEqual(Array.from(state.actorElevation).slice(1), [-1, 0, -1, 0]);
  assert.equal(boxMoves.length, 4);
  assert.equal(boxMoves.every((move) => move.toRemoved === true), true);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][2] = { type: "hole" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 0]);
  assert.deepEqual(Array.from(state.actorRemoved), [0, 1, 1, 1]);
  assert.deepEqual(
    Array.from(state.actorX).slice(1).map((x, index) => [x, state.actorElevation[index + 1]]),
    [
      [2, -2],
      [2, -1],
      [2, 0]
    ]
  );
  assert.deepEqual(
    boxMoves.map((move) => [move.fromElevation, move.toElevation, move.toRemoved]),
    [
      [0, -2, true],
      [1, -1, true],
      [2, 0, true]
    ]
  );
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][2] = { type: "hole" };
  terrain[0][3] = wallStack(1);
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 0, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 2, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(Array.from(state.actorRemoved), [0, 0, 0, 0, 0]);
  assert.deepEqual(
    Array.from(state.actorX).slice(1).map((x, index) => [x, state.actorElevation[index + 1]]),
    [
      [2, -1],
      [2, 0],
      [2, 1],
      [3, 1]
    ]
  );
  assert.equal(boxMoves.every((move) => move.toRemoved === false), true);
}

{
  const terrain = floorTerrain(4, 1);
  terrain[0][2] = { type: "hole" };
  const { engine, state } = createState({
    width: 4,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 1, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: -1, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 0, removed: false },
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, elevation: 1, removed: false }
    ]
  });

  const result = engine.move(state, 1, 0);

  assert.equal(result.moved, false);
  assert.deepEqual([state.actorX[0], state.actorY[0], state.actorElevation[0]], [1, 0, 0]);
  assert.deepEqual(
    Array.from(state.actorX).slice(1).map((x, index) => [x, state.actorElevation[index + 1]]),
    [
      [2, -1],
      [2, 0],
      [2, 1]
    ]
  );
}

{
  const terrain = [Array.from({ length: 9 }, (_, x) => (x <= 4 ? wallStack(1) : { type: "floor" }))];
  const { engine, state } = createState({
    width: 9,
    height: 1,
    terrain,
    actors: [
      { type: "player", x: 2, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M1", x: 3, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M1", x: 4, y: 0, elevation: 1, removed: false },
      { type: "weightless_box", groupId: "M1", x: 3, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M2", x: 4, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M2", x: 5, y: 0, elevation: 2, removed: false },
      { type: "weightless_box", groupId: "M1", x: 3, y: 0, elevation: 3, removed: false },
      { type: "weightless_box", groupId: "M1", x: 4, y: 0, elevation: 3, removed: false },
      { type: "weightless_box", groupId: "M2", x: 5, y: 0, elevation: 3, removed: false }
    ]
  });

  assert.equal(engine.move(state, 1, 0).moved, true);
  const result = engine.move(state, 1, 0);
  const boxMoves = result.moves.filter((move) => move.actorType === "weightless_box");

  assert.equal(result.moved, true);
  assert.deepEqual(Array.from(state.actorRemoved).slice(1), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    Array.from(state.actorElevation).slice(1),
    [0, 0, 1, 1, 1, 2, 2, 2]
  );
  assert.equal(boxMoves.every((move) => move.toRemoved === false), true);
  assert.equal(boxMoves.every((move) => move.toElevation === move.fromElevation - 1), true);
}

console.log("maze-engine tests passed");
