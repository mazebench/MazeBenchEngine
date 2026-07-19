const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalBuildWorldService } = require("../server/build-worlds-local");
const { createMazeLevelService } = require("../server/maze-levels");
const { createMazeWorldMapService } = require("../server/maze-world-map");
const { listTopLevelFiles, loadJson, loadText, titleCase } = require("../server/support");

// Exercise the local Build Mode service end to end against a temp games dir:
// create a blank draft, import a MazeJam editor_state, export it back
// (roundtrip), copy a world, count gems, rename and delete.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-game-build-"));
const gamesDir = path.join(tempRoot, "games");
const mazeDir = path.join(gamesDir, "maze");

fs.mkdirSync(path.join(mazeDir, "levels"), { recursive: true });
fs.writeFileSync(
  path.join(mazeDir, "level_parsing.json"),
  JSON.stringify({
    rules: { separator: " ", block_adder: "+" },
    objects: {
      floor: { token: "." },
      wall: { token: "#" },
      ice: { token: "i" },
      player: { token: "p", type: "player" },
      gem: { token: "G", type: "gem" },
      exit: { token: "e", type: "exit" }
    }
  }),
  "utf8"
);
fs.writeFileSync(
  path.join(mazeDir, "world_parsing.json"),
  JSON.stringify({ rules: { world_size: [16, 16], level_size: [16, 16], camera_view: [16, 16] } }),
  "utf8"
);
fs.mkdirSync(path.join(mazeDir, "images"), { recursive: true });
fs.mkdirSync(path.join(mazeDir, "assets_3d"), { recursive: true });
fs.writeFileSync(path.join(mazeDir, "levels", "level_AxA.txt"), ". p G\n", "utf8");

const worldMaps = createMazeWorldMapService({
  buildMazePreviewData: () => ({ previewUrl: null }),
  listTopLevelFiles,
  loadJson,
  gamesDir
});

const levelService = createMazeLevelService({
  buildGameAssetUrl: () => "",
  buildMazePreviewData: () => ({ previewUrl: null }),
  gamesDir,
  listTopLevelFiles,
  loadJson,
  loadText,
  resolveGameAssetPath: () => null,
  rootDir: tempRoot,
  titleCase,
  worldMaps
});

const buildWorlds = createLocalBuildWorldService({
  gamesDir,
  getGame: levelService.getGame,
  getLevelEditorState: levelService.getLevelEditorState,
  listTopLevelFiles,
  loadJson,
  sanitizeEditorPayload: levelService.sanitizeEditorPayload,
  worldMaps
});

// --- blank draft creation ---
const blank = buildWorlds.createLocalWorld({ title: "Blank World", worldWidth: 2, worldHeight: 2 });
assert.ok(blank.worldMap, "blank draft loads as a maze-family game");
assert.equal(blank.name, "Blank World");
assert.equal(blank.worldMap.levels.length, 4);
assert.equal(blank.worldMap.levels[0].id, "level_AxA");
assert.ok(fs.existsSync(path.join(gamesDir, blank.id, "levels", "level_AxA.txt")));
assert.ok(fs.existsSync(path.join(gamesDir, blank.id, "levels", "level_BxB.txt")));
const blankAxA = levelService.getLevelEditorState(
  blank,
  blank.worldMap.byPosition.get("level_AxA")
);
assert.deepEqual(blankAxA.cells[0], Array(16).fill(".+#"));
assert.deepEqual(blankAxA.cells.slice(6, 10).map((row) => row[15]), Array(4).fill("."));
assert.deepEqual(blankAxA.cells[15].slice(6, 10), Array(4).fill("."));
assert.equal(blankAxA.cells[7][7], ".+p");

// --- editor_state import + export roundtrip ---
const editorState = {
  version: "mazebench-build-world-v1",
  title: "Imported World",
  world: { width: 3, height: 2 },
  levels: [
    {
      id: "level_AxA",
      column: "A",
      row: "A",
      width: 4,
      height: 3,
      cells: [
        ["#", "#", "#", "#"],
        ["#", ".+p", ".+G", "#"],
        ["#", "#", "#", "#"]
      ]
    },
    {
      id: "level_CxB",
      column: "C",
      row: "B",
      width: 3,
      height: 3,
      cells: [
        [".", ".", "."],
        [".", "i+G", "."],
        [".", ".", "."]
      ]
    }
  ]
};

const imported = buildWorlds.createLocalWorld({ editorState, title: "" });
assert.equal(imported.name, "Imported World");
assert.equal(imported.worldMap.levels.length, 2);

const exported = buildWorlds.editorStateForGame(imported);
assert.equal(exported.version, "mazebench-build-world-v1");
assert.deepEqual(exported.world, { width: 3, height: 2 });
assert.equal(exported.levels.length, 2);

const roundtripAxA = exported.levels.find((level) => level.id === "level_AxA");
assert.deepEqual(roundtripAxA.cells[1], ["#", ".+p", ".+G", "#"]);
assert.equal(roundtripAxA.width, 4);
assert.equal(roundtripAxA.height, 3);

const roundtripCxB = exported.levels.find((level) => level.id === "level_CxB");
assert.deepEqual(roundtripCxB.cells[1], [".", "i+G", "."]);

// --- world play state uses the draft's own world axes ---
const playState = levelService.getLevelState(imported, imported.worldMap.byPosition.get("level_AxA"));
assert.deepEqual(playState.worldColumns, ["A", "B", "C"]);
assert.deepEqual(playState.worldRows, ["A", "B"]);
assert.equal(playState.width, 4);
assert.equal(playState.height, 3);
assert.deepEqual(
  playState.actors.map((actor) => [actor.type, actor.x, actor.y]),
  [
    ["player", 1, 1],
    ["gem", 2, 1]
  ]
);

// --- gem counting ---
assert.equal(buildWorlds.countWorldGems(imported), 2);
assert.equal(buildWorlds.describeLocalWorld(imported.id).total_gems, 2);

// --- local drafts persist the same configurable starting-room choice as hosted worlds ---
buildWorlds.updateDraftMeta(imported.id, { default_level_id: "level_CxB" });
const importedWithStartRoom = levelService.getGame(imported.id);
assert.equal(worldMaps.defaultLevelIdForGame(importedWithStartRoom), "level_CxB");
assert.equal(buildWorlds.describeLocalWorld(imported.id).default_level_id, "level_CxB");

// --- copy an existing world ---
const copy = buildWorlds.createLocalWorldFromGame(imported.id, "The Copy");
assert.equal(copy.worldMap.levels.length, 2);
assert.equal(buildWorlds.editorStateForGame(copy).levels.length, 2);

// --- replace from editor state (remote pull path) ---
const shrunk = {
  ...editorState,
  title: "Shrunk",
  world: { width: 1, height: 1 },
  levels: [editorState.levels[0]]
};
buildWorlds.replaceLocalWorldFromEditorState(copy.id, shrunk, {
  remote: { id: "mbw_test", updated_at: "2026-07-06T00:00:00Z", status: "draft" }
});
const shrunkGame = levelService.getGame(copy.id);
assert.equal(shrunkGame.worldMap.levels.length, 1);
assert.equal(shrunkGame.name, "Shrunk");
const shrunkMeta = buildWorlds.readDraftMeta(copy.id);
assert.equal(shrunkMeta.remote_id, "mbw_test");
assert.ok(!fs.existsSync(path.join(gamesDir, copy.id, "levels", "level_CxB.txt")), "removed levels are deleted");

// --- listing, rename, delete ---
assert.equal(buildWorlds.listLocalWorlds().length, 3);
buildWorlds.updateDraftMeta(blank.id, { title: "Renamed World" });
assert.equal(buildWorlds.describeLocalWorld(blank.id).title, "Renamed World");
buildWorlds.removeLocalWorld(blank.id);
assert.equal(buildWorlds.listLocalWorlds().length, 2);
assert.ok(!fs.existsSync(path.join(gamesDir, blank.id)));

// --- imports reject bad payloads ---
assert.throws(() => buildWorlds.createLocalWorld({ editorState: { levels: [{ id: "nope" }] } }), /invalid id/);
assert.throws(
  () =>
    buildWorlds.createLocalWorld({
      editorState: {
        world: { width: 1, height: 1 },
        levels: [{ id: "level_BxA", column: "B", row: "A", cells: [["."]] }]
      }
    }),
  /outside/
);

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("local build world tests passed");
