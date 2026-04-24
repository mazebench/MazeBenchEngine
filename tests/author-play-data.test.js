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
    { imageUrl: null, label: "Wall", name: "wall", token: "W" },
    { imageUrl: null, initialRaised: false, label: "Player Lift l", name: "player_lift", token: "l", type: "player_lift" },
    { imageUrl: null, initialRaised: true, label: "Raised Player Lift", name: "player_lift", token: "L", type: "player_lift" },
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
assert.equal(playData.terrain[1][1].type, "floor");
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

console.log("author play data tests passed");
