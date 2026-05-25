const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMazeLevelService } = require("../server/maze-levels");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-game-author-"));
const gamesDir = path.join(tempRoot, "games");
const levelDir = path.join(gamesDir, "maze", "levels");

fs.mkdirSync(levelDir, { recursive: true });

const game = {
  id: "maze",
  levels: [],
  levelFiles: ["test-empty.txt"],
  parser: {
    rules: {
      block_adder: "+",
      separator: " "
    },
    objects: {
      floor: { token: "." },
      wall: { token: "#" },
      ice: { token: "i" },
      orange_button: { token: "o", label: "Orange Button" },
      block_asset_1: {
        token: "b1",
        label: "Block 1",
        type: "block_asset",
        model: "assets_3d/b1.glb"
      },
      puncher: {
        label: "Puncher",
        type: "puncher",
        tokens: [
          { token: "pr", direction: "right" },
          { token: "pd", direction: "down", selectable: false }
        ]
      }
    }
  },
  worldMap: {
    byPosition: new Map([
      [
        "level_AxA",
        {
          fileName: "test-empty.txt",
          id: "level_AxA",
          label: "Level AxA"
        }
      ]
    ])
  }
};

fs.writeFileSync(path.join(levelDir, "test-empty.txt"), "+ . +++#\n", "utf8");
fs.writeFileSync(path.join(levelDir, "legacy_hole.txt"), "h h+# #+h+#\n", "utf8");

const service = createMazeLevelService({
  buildGameAssetUrl: () => "",
  buildMazeFallbackLevelFileName: () => "fallback.txt",
  buildMazePreviewData: () => ({ previewUrl: null }),
  buildMazeWorldLevel: (levelId, options = {}) => ({
    fileName: options.fileName || "fallback.txt",
    id: levelId,
    label: levelId
  }),
  buildMazeWorldMapState: () => ({}),
  defaultLevelIdForGame: () => "level_AxA",
  gamesDir,
  isMazeWorldLevelId: (levelId) => /^level_[A-Z]x[A-Z]$/.test(levelId),
  listTopLevelFiles: () => [],
  loadJson: () => ({}),
  loadText: (filePath, fallback) => fs.readFileSync(filePath, "utf8") || fallback,
  mazeAuthorDefaultHeight: 1,
  mazeAuthorDefaultWidth: 3,
  mazeDefaultLevelId: "level_AxA",
  mazeLevelGridHeight: 16,
  mazeLevelGridWidth: 16,
  mazeLevelLabel: (levelId) => levelId,
  mazeWorldConfig: {
    cameraView: { width: 3, height: 1 },
    worldColumns: ["A"],
    worldRows: ["A"]
  },
  resolveGameAssetPath: () => null,
  rootDir: tempRoot,
  titleCase: (value) => String(value)
});

const editorState = service.getLevelEditorState(game, game.worldMap.byPosition.get("level_AxA"));

assert.deepEqual(editorState.cells[0].slice(0, 3), ["+", ".", "+++#"]);

const legacyHoleEditorState = service.getLevelEditorState(
  game,
  { id: "legacy_hole", fileName: "legacy_hole.txt", label: "Legacy Hole" }
);

assert.deepEqual(legacyHoleEditorState.cells[0].slice(0, 3), ["+", "+#", "#++#"]);

const legacyHolePlayState = service.getLevelState(
  game,
  { id: "legacy_hole", fileName: "legacy_hole.txt", label: "Legacy Hole" }
);

assert.equal(legacyHolePlayState.terrain[0][0].type, "empty");
assert.deepEqual(
  legacyHolePlayState.terrain[0][2].layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["wall", 0],
    ["wall", 2]
  ]
);
assert.equal(editorState.rawText, "+ . +++#");

const sanitized = service.sanitizeEditorPayload(game, {
  cells: [["+", ".", "+++#"]],
  height: 1,
  width: 3
});

assert.deepEqual(sanitized.cells[0], ["+", ".", "+++#"]);
assert.equal(sanitized.rawText, "+ . +++#");

const legacySanitized = service.sanitizeEditorPayload(game, {
  width: 3,
  height: 1,
  cells: [["h", "h+#", "#+h+#"]]
});

assert.deepEqual(legacySanitized.cells[0], ["+", "+#", "#++#"]);
assert.equal(legacySanitized.rawText, "+ +# #++#");

const puncherSanitized = service.sanitizeEditorPayload(game, {
  cells: [["#+pd", ".+pr", "+"]],
  height: 1,
  width: 3
});

assert.deepEqual(puncherSanitized.cells[0], ["#+pd", ".+pr", "+"]);

fs.writeFileSync(path.join(levelDir, "test-empty.txt"), puncherSanitized.rawText + "\n", "utf8");

const puncherPlayState = service.getLevelState(game, game.worldMap.byPosition.get("level_AxA"));

assert.deepEqual(
  puncherPlayState.actors.map((actor) => [actor.type, actor.x, actor.y, actor.elevation, actor.direction]),
  [
    ["puncher", 0, 0, 1, "down"],
    ["puncher", 1, 0, 0, "right"]
  ]
);

fs.writeFileSync(path.join(levelDir, "test-empty.txt"), ".+b1\n", "utf8");

const blockAssetPlayState = service.getLevelState(game, game.worldMap.byPosition.get("level_AxA"));
const blockAssetCell = blockAssetPlayState.terrain[0][0];

assert.equal(blockAssetCell.type, "block_asset");
assert.deepEqual(
  blockAssetCell.layers.map((layer) => [layer.type, layer.elevation]),
  [
    ["floor", 0],
    ["block_asset", 0]
  ]
);

fs.writeFileSync(path.join(levelDir, "test-empty.txt"), "i+o #+o o\n", "utf8");

const orangeButtonPlayState = service.getLevelState(game, game.worldMap.byPosition.get("level_AxA"));

assert.equal(orangeButtonPlayState.terrain[0][0].type, "ice");
assert.equal(orangeButtonPlayState.terrain[0][1].type, "wall");
assert.equal(orangeButtonPlayState.terrain[0][2].type, "empty");
assert.deepEqual(
  orangeButtonPlayState.actors.map((actor) => [actor.type, actor.x, actor.y, actor.elevation]),
  [
    ["orange_button", 0, 0, 0],
    ["orange_button", 1, 0, 1],
    ["orange_button", 2, 0, 0]
  ]
);

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log("maze author level serialization tests passed");
