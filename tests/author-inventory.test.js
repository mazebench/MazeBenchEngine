const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadBrowserScript } = require("./helpers/browser-module-loader");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "author.js"), "utf8");

function sourceSection(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const auxiliarySection = sourceSection(
  "function createAuxiliaryRenderApp",
  "function demoPlayData"
);
assert.match(auxiliarySection, /hostFullBleedView: true/);
assert.match(auxiliarySection, /playStage: hostFrame/);
assert.match(auxiliarySection, /mazeFrame: hostFrame/);
assert.match(auxiliarySection, /app\.MOVE_DURATION_MS = 220/);

const detailSection = sourceSection(
  "function renderInventoryDetail",
  "function isInventoryOpen"
);
assert.doesNotMatch(detailSection, /stage\.className\s*=/);
assert.match(detailSection, /stage\.classList\.remove\(\.\.\.INVENTORY_DEMO_CLASSES\)/);

const demoDataSection = sourceSection("function demoPlayData", "function demoSceneForTool");
assert.match(demoDataSection, /levelId: "__toolbox_demo_"/);
assert.doesNotMatch(demoDataSection, /levelId: "level_AxA"/);

const demoRunSection = sourceSection("async function runDemoScene", "Local world-map thumbnails");
assert.match(demoRunSection, /!app\.isAnimating/);
assert.match(demoRunSection, /if \(scene\.ambient\)/);
assert.doesNotMatch(demoRunSection, /scene\.orbit/);
assert.doesNotMatch(demoRunSection, /durationMs:/);
assert.match(demoRunSection, /is-demo-resetting/);

const thumbnailSection = sourceSection(
  "async function renderLevelThumbFromCells",
  "function scheduleCurrentLevelThumbRefresh"
);
assert.match(thumbnailSection, /levelId: "__author_thumbnail_"/);

const previewSection = sourceSection(
  "function createPalettePreviewPlayData",
  "function renderSelectedTool"
);
assert.match(previewSection, /const width = 1/);
assert.match(previewSection, /"__palette_preview_"/);
assert.match(previewSection, /const orderedTools =/);
assert.match(previewSection, /\.\.\.hotbarTokens\(\)/);
assert.match(previewSection, /const preloadWindowSize = 4/);
assert.match(previewSection, /await preloadTool\(tool\)/);
assert.match(previewSection, /publishPalettePreview\(tool, previewUrl\)/);
assert.match(previewSection, /await yieldPalettePreviewPaint\(\)/);
assert.match(previewSection, /disposeAuxiliaryRenderApp\(app, canvas\)/);
assert.doesNotMatch(previewSection, /await Promise\.all\(/);
assert.doesNotMatch(previewSection, /palettePreviewRenderer\.previewsByToken\s*=/);

const defaultHotbarSection = sourceSection(
  "const defaultHotbarTokens",
  "const hotbarPersistenceEnabled"
);
const defaultHotbarMarkers = [
  "noopToken",
  "eraserToken",
  'toolByName.get("player")',
  'toolByName.get("gem")',
  "authorData.defaultWallToken",
  "authorData.defaultFloorToken",
  'toolByName.get("ice")',
  'toolByToken.get("M1")',
  'toolByToken.get("M2")',
  'toolByToken.get("l")'
];
let previousDefaultMarkerIndex = -1;
for (const marker of defaultHotbarMarkers) {
  const markerIndex = defaultHotbarSection.indexOf(marker);
  assert.ok(markerIndex > previousDefaultMarkerIndex, `default hotbar marker is out of order: ${marker}`);
  previousDefaultMarkerIndex = markerIndex;
}
assert.match(source, /const hotbarPersistenceEnabled = Array\.isArray\(authorData\.hotbarTokens\)/);
assert.match(source, /if \(normalized\.length >= 10\)/);
assert.match(source, /\.slice\(0, 10\)/);
assert.match(source, /const slotIndex = key === "0" \? 9 : Number\(key\) - 1/);
assert.match(source, /label: "Deselect"/);
assert.match(source, /label: "Erase"/);
assert.match(source, /lucide\.dev\/icons\/mouse-pointer-2-off/);
assert.match(source, /lucide\.dev\/icons\/eraser/);
assert.match(source, /return deselectToolIconSvg/);
assert.match(source, /return eraserToolIconSvg/);

const dirtyStateSection = sourceSection(
  "function syncEditorDirtyState",
  "function applyPersistedHotbarTokens"
);
assert.match(dirtyStateSection, /hotbarPersistenceEnabled && hotbarSignature\(\) !== savedHotbarSignature/);

const saveSection = sourceSection("async function saveLevel", "function raisedSurfaceSnapshotForApp");
assert.match(saveSection, /const submittedHotbarTokens = hotbarTokens\(\)/);
assert.match(saveSection, /hotbarTokens: submittedHotbarTokens/);
assert.match(saveSection, /const liveHotbarUnchanged = hotbarSignature\(\) === submittedHotbarSignature/);
assert.match(saveSection, /applyPersistedHotbarTokens\(payload\.hotbarTokens, submittedHotbarTokens\)/);
assert.match(saveSection, /rememberPersistedHotbarTokens\(payload\.hotbarTokens, submittedHotbarTokens\)/);
assert.match(saveSection, /New changes are still unsaved\./);

const loadSection = sourceSection("function applyAuthorLevelPayload", "async function loadLevel");
assert.match(loadSection, /applyPersistedHotbarTokens\(payload\.hotbarTokens, savedHotbarTokens\)/);
assert.match(loadSection, /syncEditorDirtyState\(\)/);

const hotbarSwapSource = sourceSection(
  "function swapTokenIntoHotbarSlot",
  "function toolForToken"
).trim();
const swapTokenIntoHotbarSlot = vm.runInNewContext(`(${hotbarSwapSource})`);
const numberedSlots = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

assert.equal(swapTokenIntoHotbarSlot(numberedSlots, 3, "7"), 3);
assert.deepEqual(Array.from(numberedSlots), ["1", "2", "3", "7", "5", "6", "4", "8", "9"]);

const replacementSlots = ["floor", "wall", "gem"];
assert.equal(swapTokenIntoHotbarSlot(replacementSlots, 1, "tree"), 1);
assert.deepEqual(Array.from(replacementSlots), ["floor", "tree", "gem"]);

const selectTokenSection = sourceSection("function selectToken", "function selectCell");
assert.match(selectTokenSection, /options\.assignToActiveSlot === true/);
assert.match(selectTokenSection, /swapTokenIntoHotbarSlot/);
assert.match(selectTokenSection, /syncEditorDirtyState\(\)/);
assert.match(source, /selectToken\(button\.dataset\.token, \{ assignToActiveSlot: true \}\)/);
assert.match(source, /selectToken\(descriptor\.topToken, \{ assignToActiveSlot: true \}\)/);
assert.match(source, /selectToken\(slot\.dataset\.token\);/);

const noop = () => {};
const context2d = {
  clearRect: noop,
  drawImage: noop,
  fillRect: noop,
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  imageSmoothingEnabled: false,
  putImageData: noop,
  setTransform: noop
};
const makeCanvas = () => ({
  height: 0,
  style: {},
  width: 0,
  getContext(type) {
    return type === "2d" ? context2d : null;
  }
});

global.performance = { now: () => 0 };
global.document = {
  title: "",
  createElement(tag) {
    return tag === "canvas" ? makeCanvas() : { style: {} };
  }
};
global.window = {
  PlayModules: {},
  cancelAnimationFrame: noop,
  devicePixelRatio: 2,
  history: { replaceState: noop },
  localStorage: { getItem: () => null, setItem: noop },
  location: { pathname: "/build/worlds/test" },
  requestAnimationFrame: () => 1,
  setTimeout: () => 1
};

loadBrowserScript("public/play-rules.js");
loadBrowserScript("public/play-core.js");

const demoCanvas = makeCanvas();
const demoHost = {
  clientHeight: 140,
  clientWidth: 224,
  style: {},
  getBoundingClientRect: () => ({ height: 140, width: 224 })
};
const floor = () => ({ imageUrl: null, label: "Floor", raised: false, type: "floor", underlay: null });
const demoApp = window.PlayModules.createPlayCore({
  canvas: demoCanvas,
  enableCameraControls: false,
  fuzzyToggle: null,
  mazeFrame: demoHost,
  playData: {
    actors: [{ id: "player", type: "player", x: 1, y: 1 }],
    cameraView: { height: 3, width: 3 },
    editorRender: true,
    gameId: "maze",
    height: 3,
    hostFullBleedView: true,
    levelId: "__toolbox_demo_test",
    levelLabel: "Demo",
    terrain: Array.from({ length: 3 }, () => Array.from({ length: 3 }, floor)),
    width: 3
  },
  playHeader: null,
  playShell: null,
  playStage: demoHost
});
demoApp.setupCanvas();

assert.deepEqual(demoApp.boardRect, { height: 140, width: 224 });
assert.deepEqual(demoApp.viewportRect, { height: 140, width: 224 });
assert.equal(demoCanvas.width, 448);
assert.equal(demoCanvas.height, 280);
assert.equal(demoCanvas.style.aspectRatio, "224 / 140");

console.log("author-inventory: OK");
