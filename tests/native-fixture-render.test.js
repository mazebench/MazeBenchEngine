const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../public/play-render-three.js"), "utf8");
const layoutSource = source.slice(source.indexOf("    function sideFixtureLayout("), source.indexOf("    function addSideFixture("));
const layout = new Function(`
  const unit = 64, elevationUnit = 64, actorVisualLift = 0;
  const orangeButtonHeight = () => 8, playerLiftPlateThickness = () => 4;
  ${layoutSource}
  return sideFixtureLayout;
`)();

test("wall lifts extend along their native face normal with arrows on the exposed face", () => {
  const center = { x: 100, z: 200 };
  for (const [direction, normal] of Object.entries({ north: [0,-1], east: [1,0], south: [0,1], west: [-1,0] })) {
    const lowered = layout({ type: "attached_lift", direction, raised: false }, center, 2, 1, 0);
    assert.equal(lowered.x, 100 - normal[0] * 30);
    assert.equal(lowered.z, 200 - normal[1] * 30);
    assert.equal(lowered.y, 160);
    assert.equal(lowered.width, normal[0] ? 4 : 64);
    assert.equal(lowered.depth, normal[1] ? 4 : 64);
    const raised = layout({ type: "attached_lift", direction, raised: true }, center, 2, 1, 0);
    assert.deepEqual([raised.x, raised.y, raised.z, raised.width, raised.height, raised.depth], [100,160,200,64,64,64]);
  }
});

test("side buttons lie on the wall face; original top devices retain the existing renderer", () => {
  const button = layout({ type: "orange_button", orientation: "west" }, { x: 0, z: 0 }, 0, 1, 0);
  assert.deepEqual([button.x, button.y, button.z, button.width], [28,32,0,8]);
  assert.equal(layout({ type: "attached_lift", direction: "top" }, {}, 0, 1, 0), null);
  assert.equal(layout({ type: "orange_button" }, {}, 0, 1, 0), null);
});

test("native numeric group IDs cannot crash slope colors, while black wall slopes preserve their art", () => {
  const colorSource = source.slice(source.indexOf("    function slopeStyleColor("), source.indexOf("    function actorColor("));
  const color = new Function(`const terrainColor = (type) => type === 'wall' ? '#23262c' : '#b85f16'; ${colorSource} return slopeStyleColor;`)();
  assert.equal(color(1, "#315991"), "#315991");
  assert.equal(color("M1", "#a9d6f4"), "#315991");
  assert.equal(color("c1", "#a9d6f4"), "#b59a2a");
  assert.equal(color("wall", "#a9d6f4"), "#23262c");
});

test("native raised gates render authoritative physics state; v1 retains its animated gate height", () => {
  const gateSource = source.slice(source.indexOf("    function attachedGateRenderLift("), source.indexOf("    function sideFixtureLayout("));
  const lift = new Function(`const app = { attachedGateLiftAt: () => 0.45 }; ${gateSource} return attachedGateRenderLift;`)();
  assert.equal(lift({ v11GenericId: 1 }, 100), 1);
  assert.equal(lift({ v11GenericId: 0 }, 100), 0);
  assert.equal(lift({}, 100), 0.45);
});
