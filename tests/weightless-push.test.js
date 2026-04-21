const assert = require("node:assert/strict");
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");

global.performance = performance;
global.window = {
  PlayModules: {},
  requestAnimationFrame(callback) {
    callback(performance.now() + 1000);
    return 1;
  },
  cancelAnimationFrame: () => {}
};
eval(fs.readFileSync("public/play-gameplay.js", "utf8"));

const { registerGameplayFunctions } = window.PlayModules;

function posKey(x, y) {
  return `${x},${y}`;
}

function createGameplayApp(actors, options = {}) {
  const app = {
    worldColumns: options.worldColumns || Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    worldRows: options.worldRows || Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    state: {
      width: 8,
      height: 8,
      actors
    },
    moveHistory: [],
    MOVE_DURATION_MS: 0,
    PLAYER_LIFT_RISE_DURATION_MS: 0,
    PLAYER_LIFT_FALL_DURATION_MS: 0,
    HOLE_FALL_DURATION_MS: 0,
    HOLE_SINK_DISTANCE: 0,
    liveRaisedPlayerGates: new Set(),
    posKey,
    cloneActorPositions: () => [],
    cloneTerrainState: () => [],
    restoreTerrainState: () => {},
    restoreActorPositions: () => {},
    buildOccupiedSet: () => new Set(),
    actorsAt(x, y, predicate = null) {
      return actors.filter(
        (actor) =>
          !actor.removed &&
          actor.x === x &&
          actor.y === y &&
          (typeof predicate !== "function" || predicate(actor))
      );
    },
    actorAt(x, y, predicate = null) {
      return (
        actors.find(
          (actor) =>
            !actor.removed &&
            actor.x === x &&
            actor.y === y &&
            (typeof predicate !== "function" || predicate(actor))
        ) || null
      );
    },
    pushEntityKey(actor) {
      return actor.type === "weightless_box" ? `weightless:${actor.groupId}` : actor;
    },
    isPlayerActor(actor) {
      return actor?.type === "player" || actor?.type === "circle_player";
    },
    actorElevation(actor) {
      return actor?.type === "player" || actor?.type === "circle_player" ? actor?.elevation ?? 0 : 0;
    },
    isCollectibleActor(actor) {
      return actor?.type === "gem";
    },
    pushWeight(actor) {
      return actor.type === "box" || actor.type === "floating_floor" ? 1 : 0;
    },
    isPushableActor(actor) {
      return actor?.type === "box" || actor?.type === "floating_floor" || actor?.type === "weightless_box";
    },
    pushActorMembers(actor) {
      return actor.type === "weightless_box"
        ? actors.filter(
            (member) => member.type === "weightless_box" && member.groupId === actor.groupId && !member.removed
          )
        : [actor];
    },
    weightlessGroupMembers(groupId) {
      return actors.filter(
        (actor) => actor.type === "weightless_box" && actor.groupId === groupId && !actor.removed
      );
    },
    isInsideBoard(x, y) {
      return x >= 0 && x < 8 && y >= 0 && y < 8;
    },
    terrainAt: () => ({ type: "floor" }),
    isWall: () => false,
    terrainSurfaceHeightAt: () => 0,
    playerSurfaceHeightAt: () => 0,
    isPlayerLift: () => false,
    isRaisedPlayerLift: () => false,
    setPlayerLiftRaised: () => {},
    computeRaisedPlayerGateSet: () => new Set(),
    isIce: options.isIce || (() => false),
    isHole: () => false,
    isIceOrHole: () => false,
    easeOutBack: (value) => value,
    easeInOutQuad: (value) => value,
    syncFloatingFloorTicker: () => {},
    cloneLevelSnapshot: () => ({}),
    applyLevelState: () => {},
    loadLevelState: async () => ({}),
    captureSceneSnapshot: () => null,
    captureForegroundOccluderSnapshot: () => null,
    captureViewportSnapshot: () => null,
    viewportPositionForActor: () => ({ x: 0, y: 0 }),
    startLevelTransition: () => {},
    render: () => {}
  };

  registerGameplayFunctions(app);
  return app;
}

function createUShapeActors(extraActors = []) {
  return [
    { type: "player", x: 2, y: 0, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 1, y: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false },
    { type: "weightless_box", groupId: "M0", x: 1, y: 2, removed: false },
    { type: "weightless_box", groupId: "M0", x: 2, y: 2, removed: false },
    { type: "weightless_box", groupId: "M0", x: 3, y: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 3, y: 1, removed: false },
    { type: "weightless_box", groupId: "M0", x: 3, y: 2, removed: false },
    ...extraActors
  ];
}

function runAttempt(app, ignoredActors) {
  const occupied = new Set(
    app.state.actors
      .filter((actor) => actor.type !== "player" && !actor.removed)
      .map((actor) => posKey(actor.x, actor.y))
  );
  const moves = [];
  const leftArm = app.state.actors.find(
    (actor) => actor.type === "weightless_box" && actor.x === 1 && actor.y === 0
  );
  const result = app.attemptPushActor(leftArm, -1, 0, occupied, moves, 1, new Set(), new Set(), ignoredActors);

  return { result, moves };
}

function runAttemptFromActor(app, actor, dx, dy, ignoredActors) {
  const occupied = new Set(
    app.state.actors
      .filter((candidate) => candidate.type !== "player" && !candidate.removed)
      .map((candidate) => posKey(candidate.x, candidate.y))
  );
  const moves = [];
  const result = app.attemptPushActor(actor, dx, dy, occupied, moves, 1, new Set(), new Set(), ignoredActors);

  return { result, moves };
}

{
  const passThroughGem = { type: "gem", x: 2, y: 0, removed: false };
  const landingGem = { type: "gem", x: 3, y: 0, removed: false };
  const actors = [
    { type: "player", x: 0, y: 0, elevation: 0, removed: false },
    passThroughGem,
    landingGem
  ];
  const app = createGameplayApp(actors, {
    isIce: (x, y) => y === 0 && (x === 1 || x === 2)
  });

  app.movePlayers(1, 0);

  assert.deepEqual([actors[0].x, actors[0].y], [3, 0]);
  assert.equal(passThroughGem.removed, false);
  assert.equal(landingGem.removed, true);
}

{
  const app = createGameplayApp(createUShapeActors());
  const player = app.state.actors[0];
  const { result, moves } = runAttempt(app, new Set([player]));

  assert.notEqual(result, null);
  assert.equal(moves.length, 7);
  assert.deepEqual(
    app.state.actors
      .filter((actor) => actor.type === "weightless_box")
      .map((actor) => [actor.x, actor.y])
      .sort((left, right) => left[0] - right[0] || left[1] - right[1]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 2],
      [2, 0],
      [2, 1],
      [2, 2]
    ]
  );
}

{
  const blocker = { type: "circle_player", x: 2, y: 0, elevation: 0, removed: false };
  const app = createGameplayApp(createUShapeActors([blocker]));
  const pusher = app.state.actors[0];
  const { result, moves } = runAttempt(app, new Set([pusher]));

  assert.equal(result, null);
  assert.equal(moves.length, 0);
}

{
  const actors = [
    { type: "player", x: 4, y: 0, elevation: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 3, y: 0, removed: false },
    { type: "weightless_box", groupId: "M0", x: 3, y: 1, removed: false },
    { type: "weightless_box", groupId: "M1", x: 2, y: 0, removed: false },
    { type: "weightless_box", groupId: "M1", x: 4, y: 1, removed: false }
  ];
  const app = createGameplayApp(actors);
  const player = actors[0];
  const leadGroup = actors[1];
  const { result, moves } = runAttemptFromActor(app, leadGroup, -1, 0, new Set([player]));

  assert.notEqual(result, null);
  assert.equal(moves.length, 4);
  assert.deepEqual(
    actors
      .filter((actor) => actor.type === "weightless_box")
      .map((actor) => [actor.groupId, actor.x, actor.y])
      .sort((left, right) => left[0].localeCompare(right[0]) || left[1] - right[1] || left[2] - right[2]),
    [
      ["M0", 2, 0],
      ["M0", 2, 1],
      ["M1", 1, 0],
      ["M1", 3, 1]
    ]
  );
}

{
  const app = createGameplayApp([], {
    worldColumns: Array.from("ABCDEFGHIJKLMNOP"),
    worldRows: Array.from("ABCDEFGHIJKLMNOP")
  });

  assert.equal(app.adjacentWorldLevelId("level_AxA", -1, 0), "level_PxA");
  assert.equal(app.adjacentWorldLevelId("level_AxA", 0, -1), "level_AxP");
  assert.equal(app.adjacentWorldLevelId("level_PxP", 1, 0), "level_AxP");
  assert.equal(app.adjacentWorldLevelId("level_PxP", 0, 1), "level_PxA");
}

console.log("weightless push regression tests passed");
