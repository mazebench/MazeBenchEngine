const assert = require("node:assert/strict");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

function createStubContext() {
  const noop = () => {};
  const operations = [];
  const context = {
    __operations: operations,
    clearRect: noop,
    fillRect(...args) {
      operations.push({ type: "fillRect", fillStyle: context.fillStyle, args });
    },
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
    scale: noop,
    closePath: noop,
    viewport: noop,
    imageSmoothingEnabled: false,
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: ""
  };
  return context;
}

function buildTerrain(width, height, wallPositions = []) {
  const walls = new Set(wallPositions.map(([x, y]) => `${x},${y}`));

  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) =>
      walls.has(`${x},${y}`)
        ? {
            type: "wall",
            label: "Wall",
            imageUrl: null,
            underlay: {
              type: "floor",
              label: "Floor",
              imageUrl: null,
              underlay: null,
              raised: false
            },
            raised: false
          }
        : {
            type: "floor",
            label: "Floor",
            imageUrl: null,
            underlay: null,
            raised: false
          }
    )
  );
}

function createRenderApp({ terrain, actors, playData = {} }) {
  const context = createStubContext();
  global.performance = { now: () => 0 };
  global.document = {
    title: "",
    createElement(tag) {
      if (tag !== "canvas") {
        return {};
      }

      return {
        width: 0,
        height: 0,
        style: {},
        getContext(type) {
          return type === "webgl" ? null : context;
        }
      };
    }
  };
  global.window = {
    location: { pathname: "/play/maze/level_AxA" },
    history: { replaceState: () => {} },
    devicePixelRatio: 1,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    PlayModules: {}
  };

  loadBrowserScript("public/play-rules.js");
  loadBrowserScript("public/play-core.js");
  loadBrowserScript("public/play-render-effects.js");
  loadBrowserScript("public/play-render-terrain.js");
  loadBrowserScript("public/play-render-actors.js");
  loadBrowserScript("public/play-render-compositor.js");
  loadBrowserScript("public/play-render.js");

  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext(type) {
      return type === "webgl" ? null : context;
    }
  };

  const app = window.PlayModules.createPlayCore({
    playData: {
      gameId: "maze",
      levelId: "level_AxA",
      levelLabel: "level_AxA",
      width: terrain[0].length,
      height: terrain.length,
      terrain,
      actors,
      ...playData
    },
    canvas,
    playShell: null,
    playHeader: null,
    playStage: null,
    mazeFrame: null,
    fuzzyToggle: null
  });

  window.PlayModules.registerRenderFunctions(app);
  return app;
}

{
  const app = createRenderApp({
    terrain: buildTerrain(4, 4, [
      [2, 0],
      [1, 1],
      [2, 1]
    ]),
    actors: []
  });

  assert.equal(app.elevatedSideBleedCoverFamily(1, 0, 1), "terrain:wall");
  assert.equal(app.elevatedBleedCoverColor(app.elevatedSideBleedCoverFamily(1, 0, 1)), "#23262c");

  app.paintElevatedSideBleedCover(app.sceneCtx, 1, 0, 1, 64, 74, 100);
  assert.deepEqual(app.sceneCtx.__operations.at(-1), {
    type: "fillRect",
    fillStyle: "#23262c",
    args: [61.5, 77, 5, 28]
  });

  app.sceneCtx.__operations.length = 0;
  app.paintDepthSortedScene(0);
  assert.ok(
    app.sceneCtx.__operations.some(
      (operation) =>
        operation.fillStyle === "#23262c" &&
        operation.args[0] === 125.5 &&
        operation.args[1] === 50 &&
        operation.args[2] === 5 &&
        operation.args[3] === 19
    )
  );
}

{
  const app = createRenderApp({
    terrain: buildTerrain(4, 4),
    actors: [
      { type: "floating_floor", x: 2, y: 0, removed: false, elevation: 0, imageUrl: null },
      { type: "floating_floor", x: 1, y: 1, removed: false, elevation: 0, imageUrl: null },
      { type: "floating_floor", x: 2, y: 1, removed: false, elevation: 0, imageUrl: null }
    ]
  });

  assert.equal(app.elevatedSideBleedCoverFamily(1, 0, 1), "actor:floating_floor");
  assert.equal(app.elevatedSideBleedCoverFamily(1, 0, -1), null);
}

{
  const app = createRenderApp({
    terrain: buildTerrain(4, 4),
    actors: [
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, removed: false, elevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 1, y: 1, removed: false, elevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M0", x: 2, y: 1, removed: false, elevation: 0, imageUrl: null }
    ]
  });

  assert.equal(app.elevatedSideBleedCoverFamily(1, 0, 1), "actor:weightless_box:M0");

  app.state.actors.forEach((actor) => {
    actor.renderX = actor.x - 0.5;
    actor.renderY = actor.y + 0.25;
  });
  app.sceneCtx.__operations.length = 0;
  app.paintDepthSortedScene(0);
  assert.ok(
    app.sceneCtx.__operations.some(
      (operation) =>
        operation.fillStyle === "#315991" &&
        operation.args[0] === 93.5 &&
        operation.args[1] === 66 &&
        operation.args[2] === 5 &&
        operation.args[3] === 19
    )
  );

  app.state.actors.forEach((actor) => {
    actor.renderScale = 0.5;
    actor.renderSink = 8;
  });
  app.sceneCtx.__operations.length = 0;
  app.paintDepthSortedScene(0);
  assert.equal(
    app.sceneCtx.__operations.some(
      (operation) =>
        operation.fillStyle === "#315991" &&
        operation.args[2] === 5 &&
        operation.args[3] === 19
    ),
    false
  );
}

{
  const app = createRenderApp({
    terrain: buildTerrain(4, 4),
    actors: [
      { type: "weightless_box", groupId: "M0", x: 2, y: 0, removed: false, elevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M1", x: 1, y: 1, removed: false, elevation: 0, imageUrl: null },
      { type: "weightless_box", groupId: "M1", x: 2, y: 1, removed: false, elevation: 0, imageUrl: null }
    ]
  });

  assert.equal(app.elevatedSideBleedCoverFamily(1, 0, 1), null);
}

{
  const app = createRenderApp({
    terrain: buildTerrain(20, 20),
    actors: [],
    playData: {
      cameraView: { width: 16, height: 16 },
      worldColumns: Array.from("ABCDEFGHIJKLMNOP"),
      worldRows: Array.from("ABCDEFGHIJKLMNOP")
    }
  });

  assert.equal(app.VIEWPORT_TILE_WIDTH, 16);
  assert.equal(app.VIEWPORT_TILE_HEIGHT, 16);
  assert.equal(app.viewportRect.width, 16 * app.TILE_SIZE);
  assert.equal(app.viewportRect.height, 16 * app.TILE_SIZE);
}

{
  const app = createRenderApp({
    terrain: buildTerrain(4, 4, [
      [3, 0],
      [3, 1]
    ]),
    actors: [],
    playData: {
      worldColumns: ["A", "B"],
      worldRows: ["A"],
      width: 4,
      height: 4
    }
  });

  assert.equal(app.isTerrainWallAcrossHorizontalWorldEdge(4, 0), false);
  assert.equal(app.elevatedSideBleedCoverFamily(3, 0, 1), null);

  app.rememberHorizontalNeighborLevelState({
    levelId: "level_BxA",
    width: 4,
    height: 4,
    terrain: buildTerrain(4, 4, [
      [0, 0],
      [0, 1]
    ]),
    actors: []
  });

  assert.equal(app.isTerrainWallAcrossHorizontalWorldEdge(4, 0), true);
  assert.equal(app.elevatedSideBleedCoverFamily(3, 0, 1), "terrain:wall");
}

console.log("render silhouette regression tests passed");
