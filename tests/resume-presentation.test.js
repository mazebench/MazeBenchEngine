const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");

const source = fs.readFileSync(require.resolve("../public/play-core.js"), "utf8");
const helpers = source.slice(source.indexOf("    function captureResumePresentation()"), source.indexOf("    async function restoreResumeState("));

function harness() {
  const frames = new Map(), rendered = [], views = [];
  let next = 0, camera = { yaw: Math.PI * 1.9, tilt: 0.22, zoom: 1 };
  const app = {
    currentLevelId: "level_AxA", state: { actors: [{ type: "box", x: 1, y: 2, elevation: 0 }] },
    threeRenderer: {
      getDebugCameraYaw: () => camera.yaw, getDebugCameraTilt: () => camera.tilt, getDebugCameraZoom: () => camera.zoom,
      setDebugCameraView(view) { views.push(view); camera = { ...camera, ...view }; }
    },
    renderOncePerFrame() { rendered.push({ x: app.state.actors[0].renderX, y: app.state.actors[0].renderY,
      elevation: app.state.actors[0].renderElevation, camera: { ...camera }, locked: app.isAnimating }); }
  };
  const api = new Function("app", "window", "performance", helpers + "return {captureResumePresentation, animateResumePresentation};")(
    app, { requestAnimationFrame: (fn) => { frames.set(++next, fn); return next; } }, { now: () => 0 });
  function step(now) {
    const [id, fn] = frames.entries().next().value;
    frames.delete(id); fn(now);
  }
  return { app, api, frames, rendered, views, step, setCamera: (value) => { camera = value; } };
}

for (const version of ["v1", "v1.1"]) {
  test(`${version}: resume eases objects and camera together after the arrival frame`, async () => {
    const h = harness(); h.app.engineVersion = version;
    const from = h.api.captureResumePresentation();
    h.app.state.actors = [{ type: "box", x: 9, y: 6, elevation: 2, renderX: 9, renderY: 6, renderElevation: 2 }];
    h.setCamera({ yaw: Math.PI * 0.1, tilt: 1, zoom: 1.5 });
    const tween = h.api.animateResumePresentation(from, 400);
    assert.equal(h.rendered[0].x, 1, "first visible restored frame keeps the landing pose");
    assert.equal(h.rendered[0].camera.yaw, from.camera.yaw);
    for (let now = 0; now <= 400; now += 50) h.step(now);
    await tween;
    const midpoint = h.rendered[5];
    assert.equal(midpoint.x, 5); assert.equal(midpoint.y, 4); assert.equal(midpoint.elevation, 1);
    assert.ok(Math.abs(midpoint.camera.yaw - Math.PI * 2) < 1e-9, "saved angle rotates the short way");
    assert.equal(midpoint.camera.tilt, 0.61); assert.equal(midpoint.camera.zoom, 1.25);
    assert.equal(h.app.state.actors[0].x, 9, "presentation never alters the saved physics position");
    assert.equal(h.app.state.actors[0].renderX, 9);
    assert.ok(h.rendered.every(frame => frame.locked));
    assert.ok(h.views.every(view => view.preserveSceneCache && view.skipResize && view.skipRender));
    assert.equal(h.app.isAnimating, false); assert.equal(h.app.animationFrameId, null);
  });
}

test("resume does not interpolate an actor from a different room, and rendering errors release animation", async () => {
  const h = harness(), from = h.api.captureResumePresentation();
  h.app.currentLevelId = "level_BxA";
  h.app.state.actors = [{ type: "box", x: 9, y: 6, elevation: 2, renderX: 9, renderY: 6, renderElevation: 2 }];
  h.app.renderOncePerFrame = () => { throw new Error("renderer lost"); };
  await assert.rejects(h.api.animateResumePresentation(from), /renderer lost/);
  assert.equal(h.app.state.actors[0].renderX, 9);
  assert.equal(h.app.isAnimating, false);
  assert.equal(h.app.animationFrameId, null);
});
