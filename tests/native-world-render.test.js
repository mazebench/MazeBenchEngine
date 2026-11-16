const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../public/play-render-three.js"), "utf8");
function section(start, end) {
  const from = source.indexOf(`\n${start}`);
  const to = source.indexOf(`\n${end}`, from + 1);
  assert.ok(from >= 0 && to > from, `${start} exists`);
  return source.slice(from, to);
}

function worldRenderer() {
  const rooms = Array.from({ length: 7 }, (_, x) => ({
    levelId: `room${x}`, offset: { x: x * 4, y: 0 }, renderDynamic: false,
    levelState: { levelId: `room${x}`, width: 4, height: 4, terrain: [], actors: [] }
  }));
  const app = {
    engineVersion: "v1.1", currentLevelId: "room3", playSurroundingRadius: 6,
    state: rooms[3].levelState,
    adjacentWorldLevelId(id, dx, dy) {
      const x = Number(id.slice(4)) + dx;
      return dy === 0 && x >= 0 && x < rooms.length ? `room${x}` : null;
    },
    cachedHorizontalNeighborLevelState(id) { return rooms.find((room) => room.levelId === id)?.levelState; }
  };
  const rendered = [], built = [], disposed = [];
  return new Function("app", "rooms", "rendered", "built", "disposed", `
    const unit = 64, neighboringRoomBrightness = 0.62, performance = { now: () => 0 };
    const isEditorRenderMode = () => false;
    const worldNeighborCoordsCache = new Map(), worldViewRoomGroups = new Map();
    let worldConsolidation = null, worldViewRoomBuildPending = false;
    const worldViewRoomSignature = (view) => view.levelState.levelId;
    const worldShadowFactor = () => 0.62, worldViewRoomEntryShadowFactor = (_, factor) => factor;
    function buildWorldViewRoomEntry(view, brightness, signature) {
      const entry = { signature, levelId: view.levelId, brightness, position: null };
      built.push(entry);
      return entry;
    }
    function attachWorldViewRoomEntry(entry, view) {
      entry.position = view.offset;
      rendered.push({ kind: 'cached', entry });
    }
    function applyWorldViewRoomShadow(entry, brightness) { entry.brightness = brightness; }
    function disposeWorldViewRoomEntry(entry) { disposed.push(entry); }
    const disposeWorldConsolidation = () => {};
    function renderLevelStateAt(state, offset, context, now) {
      rendered.push({ kind: 'live', state, offset, context, now });
    }
    ${section("    function playSurroundingRadius()", "    function perspectiveCameraFarPlane()")}
    ${section("    function surroundingLevelRadius()", "    function flyoverRoomWorldWidth()")}
    ${section("    function worldNeighborCoords(", "    // Animated shadow")}
    ${section("    function surroundingLevelOffset(", "\t    function surroundingLevelViews()")}
    ${section("    function worldActionRoomContainsPlayer(", "    function worldActionPathRoomView(")}
    ${section("    function renderWorldViewRoomGroups(", "    function renderSurroundingLevelViews(")}
    ${section("    function nativeWorldActionRoomViews(", "    function renderWorldActionAnimation(")}
    return { app, rooms, rendered, built, disposed, playSurroundingRadius,
      frame(action, now) {
        rendered.length = 0;
        app.worldActionAnimation = action;
        renderNativeWorldActionRooms(action, now);
        return rendered;
      },
      views: nativeWorldActionRoomViews
    };
  `)(app, rooms, rendered, built, disposed);
}

test("native movement keeps distant room meshes, lighting and positions across every tween frame", () => {
  const r = worldRenderer();
  const action = { rooms: r.rooms, currentPoint: { x: 13, y: 1 } };
  r.frame(action, 1000);
  const farRoom = r.rendered.find((item) => item.entry?.levelId === "room0").entry;
  const buildCount = r.built.length;
  assert.equal(buildCount, 6, "only the active room uses immediate rendering");
  for (let frame = 0; frame <= 12; frame += 1) {
    action.currentPoint.x = 13 + frame / 12;
    r.frame(action, 1000 + frame * 16);
    assert.equal(r.playSurroundingRadius(), 6, "world coverage does not collapse during movement");
    assert.equal(r.rendered.length, 7);
    assert.equal(r.rendered.find((item) => item.entry?.levelId === "room0").entry, farRoom);
    assert.equal(farRoom.brightness, 0.62, "far room retains settled neighbor brightness instead of fading black");
    assert.deepEqual(farRoom.position, { x: 0, z: 0 });
    assert.equal(r.built.length, buildCount, "unchanged rooms never remesh during the tween");
    const active = r.rendered.find((item) => item.kind === "live");
    assert.equal(active.state.levelId, "room3");
    assert.equal(active.context.animateGems, true);
    assert.equal(active.context.showFloorGrid, true);
    assert.equal(active.context.hidePlayers, true);
  }
  assert.equal(r.disposed.length, 0);
  r.app.engineVersion = "v1";
  assert.equal(r.playSurroundingRadius(), 1, "legacy world actions retain their original path");
});

test("room crossing moves active lighting and animation while dynamic neighbors remain live", () => {
  const r = worldRenderer();
  r.rooms[1].renderDynamic = true;
  for (const [x, expectedRoom] of [[15.49, "room3"], [15.5, "room4"], [16, "room4"]]) {
    const action = { rooms: r.rooms, currentPoint: { x, y: 1 } };
    const frame = r.frame(action, 1500);
    assert.equal(frame.length, 7);
    const live = frame.filter((item) => item.kind === "live");
    assert.equal(live.length, 2);
    assert.equal(live.find((item) => item.context.animateGems).state.levelId, expectedRoom);
    const remote = live.find((item) => item.state.levelId === "room1");
    assert.equal(remote.context.animateGems, false);
    assert.equal(remote.context.showFloorGrid, false);
    assert.equal(remote.context.brightness, 0.62);
  }
});

test("cached rooms outside the native command map retain multi-room offsets", () => {
  const r = worldRenderer();
  const views = r.views({ rooms: [r.rooms[3]], currentPoint: { x: 13, y: 1 } });
  assert.deepEqual(views.find((view) => view.levelId === "room0").offset, { x: 0, z: 0 });
  assert.deepEqual(views.find((view) => view.levelId === "room6").offset, { x: 24 * 64, z: 0 });
});

function gemRenderer() {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
    set(x, y, z) { Object.assign(this, { x, y, z }); return this; }
    setScalar(value) { return this.set(value, value, value); }
    copy(other) { return this.set(other.x, other.y, other.z); }
    clone() { return new Vector3(this.x, this.y, this.z); }
  }
  class Group {
    constructor(geometry, material) {
      Object.assign(this, { geometry, material, position: new Vector3(), scale: new Vector3(), rotation: new Vector3(), userData: {}, children: [] });
    }
    add(child) { this.children.push(child); }
  }
  const THREE = { Vector3, Group, Mesh: Group, LineSegments: Group };
  return new Function("THREE", `
    let activeRenderContext = null;
    const unit = 64, elevationUnit = 64, actorVisualLift = 0, gemModelWorldSize = 40, gemSpinPeriodMs = 7200;
    const app = { floatingFloorHoverOffset: () => 0 };
    const scene = new THREE.Group(), edgeScene = new THREE.Group();
    const material = (color, opacity) => ({ color, opacity }), lineMaterial = material;
    const renderContextOpacity = () => 1, renderContextCastsShadows = () => false;
    const transitionPieceProgressForCell = () => 1, edgeOutlinesEnabled = () => true;
    const edgeGeometryFor = () => ({}), edgeColor = () => '#fff', actorRenderColor = () => '#0f0';
    const gemEditorPick = () => null, addGemEditorPickVolume = () => {};
    const model = { bounds: { min: { y: 0 }, max: { y: 1 },
      getSize(out) { out.set(1, 1, 1); }, getCenter(out) { out.set(0.5, 0.5, 0.5); } }, parts: [{ geometry: {} }] };
    const requestModelAsset = () => model;
    ${section("    function actorVisualScale(", "    function cellCenter(")}
    ${section("    function actorFadeVisibility(", "    function actorRenderColor(")}
    ${section("    function actorSpinAngle(", "    function actorHoverOffset(")}
    ${section("    function gemModelPlacement(", "    function gemEditorPick(")}
    ${section("    function addGemModel(", "    function addGemFallback(")}
    ${section("    function addGem(", "    function addFloatingFloor(")}
    return { scene, edgeScene, draw(actor, now, context = null) {
      activeRenderContext = context;
      scene.children.length = 0;
      edgeScene.children.length = 0;
      addGem(actor, 0, 0, 0, now);
      return scene.children[0];
    }};
  `)(THREE);
}

test("active gem mesh and outlines retain continuous spin through native movement; other rooms stay still", () => {
  const r = gemRenderer();
  const actor = { type: "gem", x: 1, y: 1, hoverSeed: 1.234, modelUrl: "gem.glb" };
  const idle = r.draw(actor, 2000).rotation.y;
  const active = { role: "neighbor", animateGems: true };
  assert.equal(r.draw({ ...actor }, 2000, active).rotation.y, idle, "command start keeps the idle phase");
  for (const now of [2016, 2032, 2048, 2064]) {
    const mesh = r.draw({ ...actor }, now, active);
    assert.equal(mesh.rotation.y, now / 7200 * 2 * Math.PI + actor.hoverSeed);
    assert.equal(r.edgeScene.children[0].rotation.y, mesh.rotation.y);
  }
  assert.equal(r.draw(actor, 2064).rotation.y, r.draw(actor, 2064, active).rotation.y, "landing keeps the tween phase");
  for (const context of [{ role: "neighbor" }, { role: "neighbor", animateGems: false }, { role: "camera-flight" }]) {
    assert.equal(r.draw(actor, 2000, context).rotation.y, r.draw(actor, 6000, context).rotation.y);
  }
});

test("collected gems emit no geometry during a visit and half-opacity mesh and edges on revisit", () => {
  const r = gemRenderer();
  const hidden = { type: "gem", x: 1, y: 1, removed: true, collected: true, showCollectedGhost: false, renderScale: 0, renderAlpha: 0 };
  for (const context of [null, { role: "neighbor", animateGems: true }]) {
    r.draw(hidden, 2000, context);
    assert.equal(r.scene.children.length, 0);
    assert.equal(r.edgeScene.children.length, 0);
    const ghost = r.draw({ ...hidden, showCollectedGhost: true, renderScale: 1, renderAlpha: 0.5 }, 2000, context);
    assert.equal(ghost.children[0].material.opacity, 0.5);
    assert.equal(r.edgeScene.children[0].children[0].material.opacity, 0.5);
  }
});
