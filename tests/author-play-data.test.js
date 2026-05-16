const assert = require("node:assert/strict");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

global.window = {};

loadBrowserScript("public/author-play-data.js");

const authorData = {
  blockAdder: "+",
  defaultFloorToken: ".",
  game: { id: "maze" },
  palette: [
    { imageUrl: null, label: "Floor", name: "floor", token: "." },
    { imageUrl: null, label: "Ice", name: "ice", token: "i", type: "ice" },
    { imageUrl: null, label: "Ice Block", name: "ice_block", token: "I", type: "ice_block" },
    { imageUrl: null, label: "Wall", name: "wall", token: "W" },
    {
      imageUrl: null,
      label: "Tree 1",
      modelUrl: "/assets/maze/assets_3d/t1.glb",
      name: "tree_1",
      token: "t1",
      type: "tree"
    },
    { imageUrl: null, initialRaised: false, label: "Player Lift l", name: "player_lift", token: "l", type: "player_lift" },
    { imageUrl: null, initialRaised: true, label: "Raised Player Lift", name: "player_lift", token: "L", type: "player_lift" },
    { imageUrl: null, label: "Orange Wall", name: "orange_wall", token: "O", type: "orange_wall" },
    { imageUrl: null, label: "Orange Button", name: "orange_button", token: "o", type: "orange_button" },
    { imageUrl: null, label: "Player", name: "player", token: "P" },
    { imageUrl: "/assets/maze/images/gem.png", label: "Gem", name: "gem", token: "G" },
    {
      imageUrl: "/assets/maze/images/crate.png",
      label: "Weightless Box",
      name: "weightless_box",
      token: "B"
    }
  ]
};

const adapter = window.AuthorPlayData.createAdapter(authorData);
const playData = adapter.buildPlayData({
  cameraView: { width: 3, height: 2 },
  cells: [
    ["W+.", "P+G", "B"],
    [".", "", "W"]
  ],
  height: 2,
  levelId: "__editor_render__",
  levelLabel: "Level AxA",
  sourceFileName: "level_AxA.txt",
  width: 3
});

assert.equal(playData.gameId, "maze");
assert.deepEqual(playData.cameraView, { width: 3, height: 2 });
assert.equal(playData.terrain[0][0].type, "wall");
assert.equal(playData.terrain[0][0].underlay.type, "floor");
assert.equal(playData.terrain[0][1].type, "floor");
assert.equal(playData.terrain[1][1].type, "empty");
assert.deepEqual(
  playData.actors.map((actor) => [actor.type, actor.x, actor.y, actor.groupId]),
  [
    ["player", 1, 0, null],
    ["gem", 1, 0, null],
    ["weightless_box", 2, 0, "B"]
  ]
);

const noGemPlayData = adapter.buildPlayData({
  cells: [["P+G"]],
  height: 1,
  includeGems: false,
  width: 1
});

assert.deepEqual(
  noGemPlayData.actors.map((actor) => actor.type),
  ["player"]
);
assert.equal(adapter.getCellDescriptor("P+G").topToken, "G");
assert.throws(() => adapter.normalizeCellValue("NOPE"), /Unknown token/);
assert.equal(adapter.normalizeCellValue("W++W"), "W++W");
assert.equal(adapter.normalizeCellValue(""), "+");
assert.equal(adapter.normalizeCellValue("+"), "+");
assert.equal(adapter.normalizeCellValue("++"), "+");
assert.equal(adapter.normalizeCellValue("++W"), "++W");
assert.equal(adapter.setCellElevationToken(".", "W", 1), ".++W");
assert.equal(adapter.setCellElevationToken(".", "W", 0, { preserveBaseSurface: true }), ".+W");
assert.equal(adapter.setCellElevationToken(".", "I", 0, { preserveBaseSurface: true }), ".+I");
assert.equal(adapter.setCellElevationToken(".+W", "O", 0, { preserveBaseSurface: true }), ".+O");
assert.equal(adapter.setCellElevationToken("+", ".", 0), ".");
assert.equal(adapter.setCellElevationToken("+", "W", 0), "W");
assert.equal(adapter.setCellElevationToken(".", ".", 0, { stackBaseSurface: true }), ".");
assert.equal(adapter.setCellElevationToken(".+.", ".", 1, { stackBaseSurface: true }), ".");
assert.equal(adapter.setCellElevationToken("W", ".", 0), ".+W");
assert.equal(adapter.setCellElevationToken("W", "i", 2), "i+W");
assert.equal(adapter.setCellElevationToken(".", "t1", 0, { preserveBaseSurface: true }), ".+t1");
assert.equal(adapter.appendCellToken("+", "W"), "W");
assert.equal(adapter.appendCellToken(".", "W"), ".+W");
assert.equal(adapter.appendCellToken("W", "B"), "W+B");
assert.equal(adapter.appendCellToken(".+W", "i"), "i+W");
assert.equal(adapter.normalizeAuthoringCellValue(".+W+i"), "i+W");
assert.equal(adapter.normalizeAuthoringCellValue("W"), "W");
assert.equal(adapter.setCellElevationToken("", "W", 3), "+++W");
assert.equal(adapter.eraseCellElevationValue("W++W", 0), "++W");
assert.equal(adapter.eraseCellElevationValue("W++W", 2), "W");
assert.equal(adapter.eraseCellElevationValue(".++W", 0), "+W");
assert.equal(adapter.eraseCellElevationValue(".+W", 0), ".");
assert.equal(adapter.eraseCellElevationValue(".", 0), "+");
assert.equal(adapter.eraseCellElevationValue("B++B", 0), "++B");
assert.equal(adapter.eraseCellElevationValue(".+l", 1), ".");
assert.equal(adapter.eraseCellElevationValue("W+l", 1), "W");
assert.equal(adapter.eraseCellElevationValue(".+L", 0), ".");

const loweredLiftPlayData = adapter.buildPlayData({
  cells: [["l"]],
  height: 1,
  width: 1
});
assert.equal(loweredLiftPlayData.terrain[0][0].type, "player_lift");
assert.equal(loweredLiftPlayData.terrain[0][0].raised, false);

const raisedLiftPlayData = adapter.buildPlayData({
  cells: [["L"]],
  height: 1,
  width: 1
});
assert.equal(raisedLiftPlayData.terrain[0][0].type, "player_lift");
assert.equal(raisedLiftPlayData.terrain[0][0].raised, true);

const orangePlayData = adapter.buildPlayData({
  cells: [["O", "o+B"]],
  height: 1,
  width: 2
});
assert.equal(orangePlayData.terrain[0][0].type, "orange_wall");
assert.equal(orangePlayData.terrain[0][1].type, "orange_button");
assert.deepEqual(
  orangePlayData.actors.map((actor) => [actor.type, actor.x, actor.y]),
  [["weightless_box", 1, 0]]
);

const stackedPlayData = adapter.buildPlayData({
  cells: [["W+L+B+G", "B+B"]],
  height: 1,
  width: 2
});

assert.deepEqual(
  stackedPlayData.terrain[0][0].layers.map((layer) => [layer.type, layer.elevation, layer.raised]),
  [
    ["wall", 0, false],
    ["player_lift", 1, true]
  ]
);
assert.deepEqual(
  stackedPlayData.actors.map((actor) => [actor.type, actor.x, actor.y, actor.elevation]),
  [
    ["weightless_box", 0, 0, 2],
    ["gem", 0, 0, 3],
    ["weightless_box", 1, 0, 0],
    ["weightless_box", 1, 0, 1]
  ]
);

const gappedStackPlayData = adapter.buildPlayData({
  cells: [["W++W", "W++B"]],
  height: 1,
  width: 2
});

assert.deepEqual(
  gappedStackPlayData.terrain[0][0].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["wall", 0],
    ["wall", 2]
  ]
);
assert.deepEqual(
  gappedStackPlayData.actors.map((actor) => [actor.type, actor.x, actor.y, actor.elevation]),
  [["weightless_box", 1, 0, 2]]
);

const baseSurfacePlayData = adapter.buildPlayData({
  cells: [[".+W", ".+."]],
  height: 1,
  width: 2
});

assert.deepEqual(
  baseSurfacePlayData.terrain[0][0].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["wall", 0]
  ]
);
assert.deepEqual(
  baseSurfacePlayData.terrain[0][1].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["floor", 1]
  ]
);

const iceBlockPlayData = adapter.buildPlayData({
  cells: [["I+P", "I+I"]],
  height: 1,
  width: 2
});

assert.equal(iceBlockPlayData.terrain[0][0].type, "ice_block");
assert.equal(iceBlockPlayData.terrain[0][0].underlay.type, "floor");
assert.deepEqual(
  iceBlockPlayData.terrain[0][1].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["ice_block", 0],
    ["ice_block", 1]
  ]
);
assert.deepEqual(
  iceBlockPlayData.actors.map((actor) => [actor.type, actor.elevation]),
  [["player", 1]]
);

const treePlayData = adapter.buildPlayData({
  cells: [["t1+P", "t1+t1"]],
  height: 1,
  width: 2
});

assert.equal(treePlayData.terrain[0][0].type, "tree");
assert.equal(treePlayData.terrain[0][0].modelUrl, "/assets/maze/assets_3d/t1.glb");
assert.deepEqual(
  treePlayData.terrain[0][1].layers.map((layer) => [layer.type, layer.elevation, layer.modelUrl]),
  [
    ["tree", 0, "/assets/maze/assets_3d/t1.glb"],
    ["tree", 3, "/assets/maze/assets_3d/t1.glb"]
  ]
);
assert.deepEqual(
  treePlayData.actors.map((actor) => [actor.type, actor.elevation]),
  [["player", 3]]
);

console.log("author play data tests passed");
