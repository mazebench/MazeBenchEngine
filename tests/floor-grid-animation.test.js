const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../public/play-render-three.js"), "utf8");
function section(start, end) {
  const from = source.indexOf(`\n${start}`) + 1;
  const to = source.indexOf(`\n${end}`, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

function renderer(engineVersion) {
  const app = { engineVersion, isEditorRenderApp: true, state: { width: 4, height: 4 }, TILE_SIZE: 64 };
  const grids = [];
  const THREE = {
    BufferGeometry: class { setAttribute(name, value) { this[name] = value; } },
    Float32BufferAttribute: class { constructor(array) { this.array = array; } },
    LineBasicMaterial: class { constructor(options) { Object.assign(this, options); } },
    LineSegments: class { constructor(geometry, material) { Object.assign(this, { geometry, material }); } }
  };
  const runtime = new Function("app", "grids", "THREE", `
    let activeRenderContext = null;
    const unit = 64, neighboringRoomBrightness = 0.62, lineMaterialCache = new Map();
    const clamp01 = (n) => Math.max(0, Math.min(1, n));
    const localProgress = (p, start, duration) => clamp01((p - start) / duration);
    const lerp = (a, b, p) => a + (b - a) * p;
    const stableCameraWorldHeight = () => 64;
    const renderState = () => activeRenderContext?.state || app.state;
    const renderOffsetX = () => activeRenderContext?.offsetX || 0;
    const renderOffsetZ = () => activeRenderContext?.offsetZ || 0;
    const transitionSet = (value) => new Set(value || []);
    const renderContextColor = (value) => value;
    const renderActorsForCurrentContext = () => {}, addActor = () => {}, fitCameraToScene = () => {};
    const scene = { add(line) { grids.push({ levelId: renderState().levelId, line }); } };
    function withRenderContext(context, callback) {
      const previous = activeRenderContext;
      activeRenderContext = context;
      try { callback(); } finally { activeRenderContext = previous; }
    }
    ${section("    function transitionSceneVisibility()", "    function isEditorRenderMode()")}
    ${section("    function floorGridMaterial(", "    function roundedRectShape(")}
    ${section("    function isGridFloorDescriptor(", "    function shouldRenderTileTopDetails()")}
    ${section("    function addSegment(", "    function addTerrainRegions(")}
    function addTerrainRegions() {
      if (!shouldRenderFloorGridLines()) return;
      const descriptors = Array.from({ length: renderState().height }, () =>
        Array.from({ length: renderState().width }, () => ({ terrainHeight: 0, type: 'floor', topY: 0 })));
      addFloorGridLines(descriptors);
    }
    ${section("    function renderLevelStateAt(", "    function transitionPlayerCenter(")}
    return { render: renderWorldActionAnimation, renderLevelStateAt };
  `)(app, grids, THREE);
  return { app, grids, ...runtime };
}

for (const engineVersion of ["v1", "v1.1"]) {
  test(`${engineVersion}: editor floor grid survives each movement tween frame and transfers across rooms`, () => {
    const runtime = renderer(engineVersion);
    const rooms = [-1, 0, 1].map((x) => ({
      levelId: `room${x}`, offset: { x: x * 4, y: 0 },
      levelState: { levelId: `room${x}`, width: 4, height: 4, actors: [] }
    }));
    for (const x of [0, 0.25, 0.5, 0.75, 1, 3.49, 3.5, 4, -0.49, -0.51]) {
      runtime.grids.length = 0;
      runtime.app.worldActionAnimation = {
        rooms, currentPoint: { x, y: 1, elevation: 0 }, player: { type: "player" },
        cameraPoint: { x: x + 0.5, y: 2 }, progress: 0.5, stableWidth: 4, stableHeight: 4
      };
      runtime.render(50);
      assert.equal(runtime.grids.length, 1, `exactly the active room keeps its grid at x=${x}`);
      assert.equal(runtime.grids[0].levelId, `room${Math.floor((x + 0.5) / 4)}`);
      assert.equal(runtime.grids[0].line.material.opacity, 0.34);
      assert.ok(runtime.grids[0].line.geometry.position.array.length > 0, "actual grid lines were emitted");
    }
  });

  test(`${engineVersion}: neighboring rooms and camera flights still omit the play grid`, () => {
    const runtime = renderer(engineVersion);
    const room = { levelId: "room", width: 4, height: 4 };
    for (const role of ["neighbor", "camera-flight"]) {
      runtime.renderLevelStateAt(room, { x: 0, z: 0 }, { role }, 0);
    }
    assert.equal(runtime.grids.length, 0);
    runtime.renderLevelStateAt(room, { x: 0, z: 0 }, {}, 0);
    assert.equal(runtime.grids.length, 1, "resting play room still has its grid");
  });
}
