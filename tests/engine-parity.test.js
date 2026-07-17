// Drift guard between the two implementations of the maze rules:
//
//   1. The object-based browser runtime (play-core.js + play-movement.js +
//      play-gameplay.js). Each player move goes through
//      movement.performPlayerMove, which builds a FRESH maze-engine from the
//      current runtime state, resolves one move, and copies the result back
//      into the runtime actors/terrain (animate:false path).
//   2. The typed-array engine (maze-engine.js) driven as the solver drives
//      it: one persistent engine per level (createEngine), with engine.move
//      mutating a single persistent state for the whole move sequence.
//
// For a deterministic pseudo-random move sequence on real levels, both paths
// must agree on every actor's (type, x, y, elevation, removed) after every
// move. Actors are matched by initial index — both the runtime and the
// engine preserve the actor order of the input playData.
//
// Lift-toggle subtlety: engine.move applies its pendingLiftToggles to its
// own state internally (see maze-engine.js move(), just before
// applyMoveFinalState), so the persistent engine tracks lift state in
// state.liftRaised on its own. On the runtime side performPlayerMove applies
// the returned liftToggles via app.setPlayerLiftRaised, which writes
// cell.raised into the runtime terrain, and the next per-move engine picks
// that up through createEngine's baseLiftRaised. No extra handling is needed
// here — asymmetric handling would itself be drift and this test would
// catch it.

const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { loadBrowserScript } = require("./helpers/browser-module-loader");
const { getGame, getLevelState } = require("../server/app");

const LEVEL_COUNT = 10;
const MOVES_PER_LEVEL = 40;
const DIRECTIONS = [
  { dx: 0, dy: -1, name: "U" },
  { dx: 0, dy: 1, name: "D" },
  { dx: -1, dy: 0, name: "L" },
  { dx: 1, dy: 0, name: "R" }
];

// --- Headless browser environment (same pattern as render-silhouette.test.js) ---

function createStubCanvasContext() {
  const noop = () => {};
  return {
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fill: noop,
    save: noop,
    restore: noop,
    clip: noop,
    quadraticCurveTo: noop,
    arc: noop,
    ellipse: noop,
    drawImage: noop,
    setTransform: noop,
    rect: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    closePath: noop,
    imageSmoothingEnabled: false,
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: ""
  };
}

function createStubCanvas() {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext(type) {
      return type === "webgl" ? null : createStubCanvasContext();
    }
  };
}

global.performance = performance;
global.document = {
  title: "",
  createElement(tag) {
    return tag === "canvas" ? createStubCanvas() : {};
  }
};
global.window = {
  location: { pathname: "/play/maze/level_AxA", search: "" },
  history: { replaceState: () => {} },
  devicePixelRatio: 1,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  setTimeout(fn) {
    // window.fetch is intentionally undefined, so neighbor-level queue
    // callbacks all bail out immediately; running them inline is safe.
    fn();
    return 0;
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {}
  },
  PlayModules: {}
};

loadBrowserScript("public/play-rules.js");
loadBrowserScript("public/maze-engine.js");
loadBrowserScript("public/play-core.js");
loadBrowserScript("public/play-movement.js");
loadBrowserScript("public/play-world-transitions.js");
loadBrowserScript("public/play-gameplay.js");

// --- Deterministic pseudo-random moves (LCG; no Math.random) ---

function createLcg(seed) {
  let state = seed >>> 0;

  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function seedForLevel(fileName) {
  let seed = 0x5eedbeef;

  for (let index = 0; index < fileName.length; index += 1) {
    seed = (Math.imul(seed, 31) + fileName.charCodeAt(index)) >>> 0;
  }

  return seed;
}

// --- Level selection: first LEVEL_COUNT sorted level files that parse and
// contain a main player actor ---

function isMainPlayerType(type) {
  return type === "player" || type === "circle_player";
}

function pickLevels() {
  const game = getGame("maze");

  assert.ok(game, "maze game must load");

  const sortedLevels = game.levels
    .slice()
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
  const seenFileNames = new Set();
  const picked = [];

  for (const level of sortedLevels) {
    if (seenFileNames.has(level.fileName)) {
      continue;
    }

    seenFileNames.add(level.fileName);

    let playData = null;

    try {
      playData = getLevelState(game, level);
    } catch (_error) {
      continue;
    }

    if (!playData || !Array.isArray(playData.actors)) {
      continue;
    }

    if (!playData.actors.some((actor) => isMainPlayerType(actor.type))) {
      continue;
    }

    picked.push({ level, playData });

    if (picked.length >= LEVEL_COUNT) {
      break;
    }
  }

  return picked;
}

// --- Runtime app (real play-core + play-movement + play-gameplay) ---

function createRuntimeApp(playData) {
  const app = window.PlayModules.createPlayCore({
    playData,
    canvas: createStubCanvas(),
    playShell: null,
    playHeader: null,
    playStage: null,
    mazeFrame: null,
    fuzzyToggle: null
  });

  window.PlayModules.registerGameplayFunctions(app);
  return app;
}

function attachedLiftPlayData(initialRaised = false) {
  const playerElevation = initialRaised ? 2 : 1;
  const wallLayers = [
    { type: "floor", elevation: 0 },
    { type: "wall", elevation: 0 }
  ];

  if (initialRaised) {
    wallLayers.push({ type: "wall", elevation: 1 });
  }

  return {
    gameId: "maze",
    levelId: "__attached_lift_history__",
    levelLabel: "Attached Lift History",
    width: 3,
    height: 1,
    terrain: [[
      { type: "wall", layers: wallLayers },
      { type: "floor", layers: [{ type: "floor", elevation: 0 }] },
      { type: "floor", layers: [{ type: "floor", elevation: 0 }] }
    ]],
    actors: [
      { type: "player", x: 0, y: 0, elevation: playerElevation, removed: false },
      { type: "weightless_box", groupId: "M0", x: 1, y: 0, elevation: 0, removed: false },
      {
        type: "attached_lift",
        x: 1,
        y: 0,
        elevation: 1,
        raised: initialRaised,
        removed: false
      }
    ]
  };
}

function moveOntoAttachedLift(app) {
  const result = app.movement.performPlayerMove(1, 0, {
    animate: false,
    recordHistory: true
  });

  assert.equal(result.moved, true, "player should step onto the attached lift");
}

function assertAttachedLiftHistoryRoundTrips() {
  const undoApp = createRuntimeApp(attachedLiftPlayData(false));
  undoApp.render = () => {};
  moveOntoAttachedLift(undoApp);
  assert.equal(undoApp.state.actors[2].raised, true, "step raises the attached lift");
  assert.equal(
    undoApp.moveHistory.at(-1)?.actors?.[2]?.raised,
    false,
    "undo snapshot stores the previous attached-lift phase"
  );
  undoApp.undoMove({ instantRestore: true });
  assert.equal(undoApp.state.actors[2].raised, false, "undo restores the lowered phase");

  const resetApp = createRuntimeApp(attachedLiftPlayData(false));
  resetApp.render = () => {};
  moveOntoAttachedLift(resetApp);
  resetApp.resetPositions();
  assert.equal(resetApp.state.actors[2].raised, false, "reset restores the lowered phase");

  const initiallyRaisedApp = createRuntimeApp(attachedLiftPlayData(true));
  initiallyRaisedApp.render = () => {};
  moveOntoAttachedLift(initiallyRaisedApp);
  assert.equal(initiallyRaisedApp.state.actors[2].raised, false, "step lowers an authored raised lift");
  initiallyRaisedApp.resetPositions();
  assert.equal(
    initiallyRaisedApp.state.actors[2].raised,
    true,
    "reset restores an authored raised phase"
  );
}

// --- Comparison ---

function runtimeActorSnapshot(actor) {
  return {
    type: actor.type,
    x: actor.x,
    y: actor.y,
    elevation: actor.elevation ?? 0,
    removed: Boolean(actor.removed)
  };
}

function engineActorSnapshot(engine, engineState, index) {
  return {
    type: engine.actorTypes[index],
    x: engineState.actorX[index],
    y: engineState.actorY[index],
    elevation: engineState.actorElevation[index],
    removed: Boolean(engineState.actorRemoved[index])
  };
}

function formatSnapshot(snapshot) {
  return (
    `{type:${snapshot.type}, x:${snapshot.x}, y:${snapshot.y}, ` +
    `elevation:${snapshot.elevation}, removed:${snapshot.removed}}`
  );
}

let comparisonCount = 0;

function assertParity(context, app, engine, engineState) {
  const mismatches = [];

  assert.equal(
    app.state.actors.length,
    engine.actorCount,
    `actor count drifted on ${context.fileName} at move ${context.moveNumber}`
  );

  for (let index = 0; index < engine.actorCount; index += 1) {
    const runtimeSnapshot = runtimeActorSnapshot(app.state.actors[index]);
    const engineSnapshot = engineActorSnapshot(engine, engineState, index);

    comparisonCount += 1;

    if (
      runtimeSnapshot.type !== engineSnapshot.type ||
      runtimeSnapshot.x !== engineSnapshot.x ||
      runtimeSnapshot.y !== engineSnapshot.y ||
      runtimeSnapshot.elevation !== engineSnapshot.elevation ||
      runtimeSnapshot.removed !== engineSnapshot.removed
    ) {
      mismatches.push(
        `    actor ${index}:\n` +
          `      runtime ${formatSnapshot(runtimeSnapshot)}\n` +
          `      engine  ${formatSnapshot(engineSnapshot)}`
      );
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      "engine/runtime parity mismatch\n" +
        `  level: games/maze/levels/${context.fileName} (${context.levelId})\n` +
        `  move ${context.moveNumber} of ${MOVES_PER_LEVEL} ` +
        `(direction ${context.direction}, history ${context.history.join("")})\n` +
        `  ${mismatches.length} drifted actor(s):\n` +
        mismatches.join("\n")
    );
  }
}

// --- Main ---

const startedAtMs = performance.now();
assertAttachedLiftHistoryRoundTrips();
const pickedLevels = pickLevels();

assert.equal(
  pickedLevels.length,
  LEVEL_COUNT,
  `expected ${LEVEL_COUNT} playable levels in games/maze/levels`
);

let movesVerified = 0;

pickedLevels.forEach(({ level, playData }) => {
  // Both sides get independent deep copies of the level state so neither can
  // leak mutations into the other.
  const runtimePlayData = JSON.parse(JSON.stringify(playData));
  const enginePlayData = JSON.parse(JSON.stringify(playData));
  const app = createRuntimeApp(runtimePlayData);
  const engine = window.MazeEngine.createEngine(enginePlayData);
  const engineState = engine.cloneState(engine.initialState);
  const nextRandom = createLcg(seedForLevel(level.fileName));
  const history = [];
  const context = {
    fileName: level.fileName,
    levelId: level.id,
    moveNumber: 0,
    direction: "-",
    history
  };

  // Move 0: the runtime's level initialization must agree with the engine's
  // createInitialState before any move is made.
  assertParity(context, app, engine, engineState);

  for (let moveNumber = 1; moveNumber <= MOVES_PER_LEVEL; moveNumber += 1) {
    const direction = DIRECTIONS[(nextRandom() >>> 16) % DIRECTIONS.length];

    history.push(direction.name);
    context.moveNumber = moveNumber;
    context.direction = direction.name;

    const runtimeResult = app.movement.performPlayerMove(direction.dx, direction.dy, {
      animate: false,
      recordHistory: false
    });
    const engineResult = engine.move(engineState, direction.dx, direction.dy);

    assert.equal(
      Boolean(runtimeResult.moved),
      Boolean(engineResult.moved),
      `moved flag drifted on ${level.fileName} at move ${moveNumber} ` +
        `(direction ${direction.name}, history ${history.join("")}): ` +
        `runtime=${Boolean(runtimeResult.moved)} engine=${Boolean(engineResult.moved)}`
    );

    assertParity(context, app, engine, engineState);
    movesVerified += 1;
  }
});

const elapsedMs = Math.round(performance.now() - startedAtMs);

console.log(
  `engine parity tests passed: ${pickedLevels.length} levels x ${MOVES_PER_LEVEL} moves ` +
    `(${movesVerified} level-move combinations, ${comparisonCount} actor comparisons, ${elapsedMs}ms)`
);
