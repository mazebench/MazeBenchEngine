const assert = require("node:assert/strict");
const fs = require("node:fs");

function createStubContext() {
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
    scale: noop,
    closePath: noop,
    viewport: noop,
    imageSmoothingEnabled: false,
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: ""
  };
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

  eval(fs.readFileSync("public/play-core.js", "utf8"));
  eval(fs.readFileSync("public/play-render.js", "utf8"));

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

  assert.equal(app.sideSilhouetteEndY(1, 0, 1, 100, 74), 74);
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

  assert.equal(app.sideSilhouetteEndY(1, 0, 1, 100, 74), 74);
  assert.equal(app.sideSilhouetteEndY(1, 0, -1, 100, 74), 100);
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

console.log("render silhouette regression tests passed");
