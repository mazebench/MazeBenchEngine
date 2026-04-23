const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

global.performance = performance;
global.window = {
  PlayModules: {},
  requestAnimationFrame(callback) {
    callback(performance.now() + 1000);
    return 1;
  },
  cancelAnimationFrame: () => {}
};
loadBrowserScript("public/play-gameplay.js");

const { registerGameplayFunctions } = window.PlayModules;
const asyncTests = [];

function posKey(x, y) {
  return `${x},${y}`;
}

function createGameplayApp(actors, options = {}) {
  const defaultTerrain = Array.from({ length: options.height || 8 }, () =>
    Array.from({ length: options.width || 8 }, () => ({ type: "floor" }))
  );
  const app = {
    currentGameId: "maze",
    currentLevelId: options.currentLevelId || "level_AxA",
    currentLevelLabel: options.currentLevelLabel || "level_AxA",
    worldColumns: options.worldColumns || Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    worldRows: options.worldRows || Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    state: {
      width: options.width || 8,
      height: options.height || 8,
      terrain: options.terrain || defaultTerrain,
      actors
    },
    moveHistory: [],
    MOVE_DURATION_MS: 0,
    PLAYER_LIFT_RISE_DURATION_MS: 0,
    PLAYER_LIFT_FALL_DURATION_MS: 0,
    HOLE_FALL_DURATION_MS: 0,
    PLAYER_REVIVE_BLINK_DURATION_MS: 0,
    HOLE_SINK_DISTANCE: 0,
    cameraX: 0,
    cameraY: 0,
    TILE_SIZE: 64,
    viewportRect: { width: 512, height: 512 },
    isAnimating: false,
    isTransitioningLevel: false,
    queuedAction: null,
    animationFrameId: null,
    liveRaisedPlayerGates: new Set(),
    posKey,
    cloneActorPositions() {
      return app.state.actors.map((actor) => ({
        x: actor.x,
        y: actor.y,
        removed: Boolean(actor.removed),
        elevation: actor.elevation ?? 0
      }));
    },
    cloneTerrainState(terrain = app.state.terrain) {
      return terrain.map((row) => row.map((cell) => ({ ...cell })));
    },
    restoreTerrainState(terrain) {
      app.state.terrain = app.cloneTerrainState(terrain);
    },
    restoreActorPositions(positions) {
      app.state.actors.forEach((actor, index) => {
        const position = positions[index];

        if (!position) {
          return;
        }

        actor.x = position.x;
        actor.y = position.y;
        actor.removed = Boolean(position.removed);
        actor.elevation = position.elevation ?? 0;
      });
    },
    buildOccupiedSet(excludedActor = null) {
      const occupied = new Set(
        app.state.actors
          .filter((actor) => actor !== excludedActor && !actor.removed && !app.isCollectibleActor(actor))
          .map((actor) => posKey(actor.x, actor.y))
      );

      return occupied;
    },
    actorsAt(x, y, predicate = null) {
      return app.state.actors.filter(
        (actor) =>
          !actor.removed &&
          actor.x === x &&
          actor.y === y &&
          (typeof predicate !== "function" || predicate(actor))
      );
    },
    actorAt(x, y, predicate = null) {
      return (
        app.state.actors.find(
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
        ? app.state.actors.filter(
            (member) => member.type === "weightless_box" && member.groupId === actor.groupId && !member.removed
          )
        : [actor];
    },
    weightlessGroupMembers(groupId) {
      return app.state.actors.filter(
        (actor) => actor.type === "weightless_box" && actor.groupId === groupId && !actor.removed
      );
    },
    isInsideBoard(x, y) {
      return x >= 0 && x < app.state.width && y >= 0 && y < app.state.height;
    },
    terrainAt(x, y) {
      return app.state.terrain[y]?.[x] || { type: "empty" };
    },
    isWall: () => false,
    terrainSurfaceHeightAt: () => 0,
    playerSurfaceHeightAt: () => 0,
    isPlayerLift: () => false,
    isRaisedPlayerLift: () => false,
    setPlayerLiftRaised: () => {},
    computeRaisedPlayerGateSet: () => new Set(),
    isIce: options.isIce || (() => false),
    isHole: options.isHole || (() => false),
    isIceOrHole: () => false,
    easeOutBack: (value) => value,
    easeInOutQuad: (value) => value,
    syncFloatingFloorTicker: () => {},
    cloneLevelSnapshot() {
      return {
        gameId: app.currentGameId,
        levelId: app.currentLevelId,
        levelLabel: app.currentLevelLabel,
        width: app.state.width,
        height: app.state.height,
        terrain: app.cloneTerrainState(),
        actors: app.state.actors.map((actor) => ({ ...actor }))
      };
    },
    applyLevelState(levelState, applyOptions = {}) {
      app.currentLevelId = levelState.levelId || app.currentLevelId;
      app.currentLevelLabel = levelState.levelLabel || app.currentLevelId;
      app.state.width = levelState.width;
      app.state.height = levelState.height;
      app.state.terrain = app.cloneTerrainState(levelState.terrain || []);
      app.state.actors = (levelState.actors || []).map((actor) => ({
        ...actor,
        renderX: actor.x,
        renderY: actor.y,
        renderElevation: actor.elevation ?? 0,
        renderScale: actor.removed ? 0 : 1,
        renderAlpha: actor.removed ? 0 : 1,
        renderSink: actor.removed ? app.HOLE_SINK_DISTANCE : 0,
        renderInHole: false
      }));

      if (applyOptions.resetLevelEntry) {
        app.initialPositions = app.cloneActorPositions();
        app.initialTerrain = app.cloneTerrainState();
        app.levelEntrySnapshot = app.cloneLevelSnapshot();
      }
    },
    loadLevelState: options.loadLevelState || (async () => ({})),
    captureSceneSnapshot: () => null,
    captureForegroundOccluderSnapshot: () => null,
    captureViewportSnapshot: () => null,
    viewportPositionForActor: (actor) => ({ left: actor.x * 64, top: actor.y * 64 }),
    startLevelTransition(...args) {
      const transitionOptions = args[7] || {};
      app.isTransitioningLevel = false;
      if (typeof transitionOptions.onComplete === "function") {
        transitionOptions.onComplete();
      }
    },
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
  const landingGem = { type: "gem", x: 1, y: 0, removed: false };
  const actors = [
    { type: "player", x: 0, y: 0, elevation: 0, removed: false },
    landingGem
  ];
  const app = createGameplayApp(actors);
  const result = app.tryMovePlayersInstant(1, 0);

  assert.equal(result.moved, true);
  assert.equal(app.moveHistory.length, 0);
  assert.deepEqual([actors[0].x, actors[0].y], [1, 0]);
  assert.equal(landingGem.removed, true);
}

{
  const gem = { type: "gem", x: 1, y: 0, removed: false };
  const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
  const app = createGameplayApp([player, gem], {
    isHole: (x, y) => x === 1 && y === 0
  });

  app.movePlayers(1, 0);

  assert.deepEqual([player.x, player.y], [1, 0]);
  assert.equal(player.removed, true);
  assert.equal(gem.removed, false);
}

{
  const player = { type: "player", x: 0, y: 0, elevation: 0, removed: false };
  const app = createGameplayApp([player], {
    isIce: (x, y) => y === 0 && (x === 1 || x === 2),
    isHole: (x, y) => x === 3 && y === 0
  });

  app.movePlayers(1, 0);

  assert.deepEqual([player.x, player.y], [3, 0]);
  assert.equal(player.removed, true);
}

asyncTests.push(
  (async () => {
    const entryPlayer = { type: "player", x: 7, y: 2, elevation: 0, removed: false };
    const nextTerrain = Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ type: "floor" }))
    );
    nextTerrain[2][0] = { type: "hole" };

    const app = createGameplayApp([entryPlayer], {
      currentLevelId: "level_AxA",
      loadLevelState: async (levelId) => ({
        levelId,
        levelLabel: levelId,
        width: 8,
        height: 8,
        terrain: nextTerrain,
        actors: [{ type: "player", x: 4, y: 4, elevation: 0, removed: false }]
      })
    });

    const didTransition = await app.transitionToAdjacentLevel({
      player: entryPlayer,
      nextLevelId: "level_BxA",
      dx: 1,
      dy: 0,
      targetX: 0,
      targetY: 2
    });

    const revivedPlayer = app.state.actors.find((actor) => app.isPlayerActor(actor));

    assert.equal(didTransition, true);
    assert.deepEqual([revivedPlayer.x, revivedPlayer.y], [4, 4]);
    assert.equal(revivedPlayer.removed, false);
    assert.equal(revivedPlayer.renderAlpha, 1);
    assert.deepEqual(
      app.initialPositions.map(({ x, y, removed }) => ({ x, y, removed })),
      [{ x: 4, y: 4, removed: false }]
    );
  })()
);

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

Promise.all(asyncTests)
  .then(() => {
    console.log("weightless push regression tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
