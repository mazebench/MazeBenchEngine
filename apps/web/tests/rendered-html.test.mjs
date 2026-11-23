import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("opens the unit test library before the editor", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>VoxelBench/);
  assert.match(html, /<h1>Test Suite<\/h1>/);
  assert.match(html, /aria-label="Test Suite workspace"/);
  assert.match(html, /aria-label="Back to home"/);
  assert.match(html, /aria-label="Find folders"/);
  assert.match(html, /All tests/);
  assert.match(html, /Run suite/);
  assert.match(html, /class="suite-test-table"/);
  assert.match(html, />Editor<\/button>/);
  assert.doesNotMatch(html, /class="app-shell maze-editor lab-editor"/);
  assert.doesNotMatch(html, /aria-label="Editor actions"/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("MazeBench renderer prints each generic ID on exposed polycube faces", async () => {
  const renderer = await readFile(
    new URL("../public/mazebench-runtime/play-render-three.js", import.meta.url),
    "utf8",
  );
  assert.match(renderer, /descriptor\.layer\?\.genericLabel/);
  assert.match(renderer, /addWeightlessGroupFaceLabels\([\s\S]*?descriptor\.layer\.genericLabel/);
  assert.match(renderer, /modelAssetsReady/);
  assert.match(renderer, /modelAssetsFailed/);
});

test("Player Lifts never merge into neighboring purple solids", async () => {
  const renderer = await readFile(
    new URL("../public/mazebench-runtime/play-render-three.js", import.meta.url),
    "utf8",
  );
  assert.match(renderer, /lower\.type !== "player_lift"/);
  assert.match(renderer, /upper\.type !== "player_lift"/);
  assert.match(renderer, /descriptor\.type === "player_lift" \? `\$\{x\},\$\{y\}` : ""/);
});

test("the suite uses proper lock icons and one lazy serialized 3D preview renderer", async () => {
  const [component, styles] = await Promise.all([
    readFile(new URL("../app/VoxelBench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(component, /function LockIcon/);
  assert.match(component, /M7 11V7a5 5 0 0 1 10 0v4/);
  assert.match(component, /M7 11V7a5 5 0 0 1 9\.9-1/);
  assert.match(component, /new IntersectionObserver/);
  assert.match(component, /className="suite-preview-capture"[\s\S]*?<MazeBenchCanvas/);
  assert.match(component, /previewQueue/);
  assert.match(component, /suitePreviewFrames\(test\)/);
  assert.match(component, /cameraLayerRangeForFrames\(suitePreviewFrames\(previewTest\)\)/);
  assert.match(component, /cameraLayerRange=\{cameraLayerRangeForFrames/);
  assert.match(component, /className="suite-test-preview__pager"/);
  assert.match(component, /className="suite-test-row__details"/);
  assert.match(component, /onUpdateTest\(test\.id, \{ name: event\.target\.value \}\)/);
  assert.match(component, /onUpdateTest\(test\.id, \{ description: event\.target\.value \}\)/);
  assert.doesNotMatch(component, /lockedFolderIds|testTagsAreLocked|onToggleFolderLocked|suite-folder-lock/);
  assert.match(component, /normalizeTestTagPlacement/);
  assert.match(component, /flattenSubtags/);
  assert.match(component, /type TagCombinationAlias/);
  assert.match(component, /combinationAliases/);
  assert.match(component, /directSubtagViewIncludesTest/);
  assert.match(component, /combinationViewIncludesTest/);
  assert.match(component, /Parent tag group for/);
  assert.match(component, /Subtags must stay inside the test's parent tag group/);
  assert.match(component, /tagIds: \[defaultId\]/);
  assert.match(component, /className="test-tag-picker"/);
  assert.match(component, /test\.tagIds\.includes\(folder\.id\)/);
  assert.doesNotMatch(component, /via subtag/);
  assert.match(component, /onToggleTestTag\(test\.id, tagId\)/);
  assert.match(component, /disabled=\{sortOrder !== "manual" \|\| scopeIndex === 0\}/);
  assert.doesNotMatch(component, /Locked tests cannot be reordered/);
  assert.doesNotMatch(component, /Locked by tag|Unlock the affected tags|Unlock tag|Lock tag/);
  assert.match(component, /testIsInSelectedView/);
  assert.match(component, /folderTestCounts\.get\(folder\.id\)/);
  assert.match(component, /suite-tree__row--alias/);
  assert.match(component, /effectiveParentId = requestedParent\?\.parentId \?\? parentId/);
  assert.match(component, /relatedAliasSections/);
  assert.match(component, /alias\.tagIds\.includes\(selectedFolder\.id\)/);
  assert.match(component, /className="suite-related-combinations"/);
  assert.match(component, /className="suite-related-combination"/);
  assert.match(component, /Open combination →/);
  assert.match(component, /renderTestCard\(test, index, scopeTests\)/);
  assert.match(component, /className="suite-tree__rename-button"/);
  assert.match(component, /className="suite-tree__delete-button"/);
  assert.match(component, /className="suite-tree__rename"/);
  assert.match(component, /onRenameFolder\(folder\.id, name\)/);
  assert.match(component, /onDeleteFolder\(folder\.id\)/);
  assert.match(component, /const folderTestCounts[\s\S]*?tests\.filter\(\(test\) => testUsesTag\(test, folder\)\)\.length/);
  assert.match(component, /testUsesTag\(test, folder\)/);
  assert.match(component, /Default is a reserved subtag and cannot be deleted/);
  assert.match(component, /The final parent tag group cannot be deleted/);
  assert.match(component, /if \(event\.key === "Escape"\)/);
  assert.match(component, /Move \$\{test\.name\} left/);
  assert.match(component, /Move \$\{test\.name\} right/);
  assert.match(styles, /\.suite-test-table[^}]*grid-template-columns: repeat\(auto-fill, minmax\(320px, 1fr\)\)/);
  assert.match(styles, /\.suite-test-preview__scene img[^}]*object-fit: contain/);
  assert.match(styles, /\.suite-test-preview[^}]*grid-template-rows: minmax\(0, 1fr\) 32px/);
  assert.match(styles, /\.suite-test-row__identity[^}]*grid-template-columns/);
  assert.match(styles, /\.test-tag-picker__menu/);
  assert.match(styles, /\.suite-tree__row--alias/);
  assert.match(styles, /\.suite-tree__delete-button/);
  assert.match(styles, /\.suite-browser__content/);
  assert.match(styles, /\.suite-related-combinations/);
  assert.match(styles, /\.suite-related-combination/);
  assert.doesNotMatch(styles, /\.suite-folder-lock|\.suite-tree__row\.is-locked/);
  assert.match(styles, /\.suite-test-row__details input:focus/);
  assert.match(styles, /button\.is-locked[^}]*color: var\(--amber\)/);
  assert.doesNotMatch(styles, /\.lock-glyph/);
});

test("non-cube editor meshes use exact full-cell picking proxies", async () => {
  const renderer = await readFile(
    new URL("../public/mazebench-runtime/play-render-three.js", import.meta.url),
    "utf8",
  );
  assert.match(renderer, /function addNonCubeEditorPickVolume/);
  assert.match(renderer, /addNonCubeEditorPickVolume\(center\.x, center\.z, baseY, editorPick\)/);
  assert.match(renderer, /descriptor\.isLoweredPlayerLift[\s\S]*?addNonCubeEditorPickVolume/);
  assert.match(renderer, /selectionKey: actor\.selectionKey/);
  assert.match(renderer, /selectionKey: cell\.selectionKey \|\| pick\.selectionKey/);
});

test("non-cube hover and selection are drawn on their real geometry", async () => {
  const [renderer, canvas] = await Promise.all([
    readFile(
      new URL("../public/mazebench-runtime/play-render-three.js", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/MazeBenchCanvas.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(renderer, /if \(editorHoverTarget\.highlightShape\) \{\s*return;/);
  assert.match(renderer, /function editorGeometryColor/);
  assert.match(renderer, /highlightShape: "surface"/);
  assert.match(renderer, /highlightShape: "geometry"/);
  assert.match(renderer, /terrainColor\(descriptor\.type, descriptor\)/);
  assert.match(renderer, /editorGeometryColor\("#f59e0b", selectionKey, selected\)/);
  assert.match(renderer, /actor\.selected === true/);
  assert.match(canvas, /const selected = selectedVoxelKeys\.has\(cellObjectSelectionKey\(voxel\)\)/);
  assert.match(canvas, /selected,\s*selectionKey: cellObjectSelectionKey\(voxel\)/);
});

test("visible and invisible Orange Walls render at their authored positions", async () => {
  const canvas = await readFile(
    new URL("../app/MazeBenchCanvas.tsx", import.meta.url),
    "utf8",
  );
  assert.match(canvas, /hiddenOrangeWall \? "hidden" as const : "cube" as const/);
  assert.match(canvas, /elevation: voxel\.z \+ layerOffset/);
  assert.match(canvas, /editorOnly: true, editorOpacity: 0\.5/);
});

test("the editor exposes visible and invisible Orange Walls and Buttons", async () => {
  const editor = await readFile(
    new URL("../app/VoxelBench.tsx", import.meta.url),
    "utf8",
  );
  assert.match(editor, /id: "orange-wall", name: "Orange wall"[\s\S]*?occupancy: "inactive"/);
  assert.match(editor, /id: "orange-wall-hidden", name: "Invisible orange wall"[\s\S]*?orangeForm: "hidden"/);
  assert.match(editor, /id: "orange-button", name: "Orange button"[\s\S]*?occupancy: "sensor"/);
  assert.match(editor, /id: "orange-button-hidden", name: "Invisible orange button"[\s\S]*?buttonForm: "hidden"/);
  assert.doesNotMatch(editor, /id: "orange-wall-face"/);
  assert.match(editor, /hiddenButton[\s\S]*?invisible editor-only pressure sensor/);
});

test("red gates and punchers use the MazeBench Three.js recipes", async () => {
  const [editor, canvas, renderer, manifest] = await Promise.all([
    readFile(new URL("../app/VoxelBench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/MazeBenchCanvas.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/mazebench-runtime/play-render-three.js", import.meta.url), "utf8"),
    readFile(new URL("../public/assets/objects/manifest.json", import.meta.url), "utf8"),
  ]);
  assert.match(editor, /id: "player-gate", name: "Red gate"[\s\S]*?genericMax: GATE_GENERIC_MAX[\s\S]*?kind: "gate"/);
  assert.match(editor, /id: "puncher", name: "Puncher"[\s\S]*?genericMax: PUNCHER_GENERIC_MAX[\s\S]*?variantMax: 3[\s\S]*?kind: "puncher"/);
  assert.match(canvas, /definition\.visual\.kind === "puncher"[\s\S]*?sprung: puncherIsSprung\(voxel\.genericId\)[\s\S]*?type: isRigidFamilyMember/);
  assert.match(canvas, /isGate[\s\S]*?gateIsRaised\(voxel\.genericId\)[\s\S]*?"player_gate"/);
  assert.match(renderer, /layer\.type === "player_gate"[\s\S]*?isEditorRenderMode\(\)[\s\S]*?layer\.raised === true \? 1 : 0/);
  assert.match(renderer, /function addPuncher\(/);
  assert.match(renderer, /actor\.sprung === true[\s\S]*?addAuthoredSprungPuncherArm/);
  assert.match(renderer, /highlightShape: "geometry",\s*selectionKey: actor\.selectionKey/);
  assert.match(renderer, /addPuncherCylinderPart\([\s\S]*?"#ef4444"[\s\S]*?"#f8fafc"[\s\S]*?"#b91c1c"/);
  assert.match(manifest, /"mazebench-player-gate"/);
  assert.match(manifest, /"mazebench-puncher"[\s\S]*?"states": \["unsprung", "sprung"\][\s\S]*?"MazeBenchBenchmarking"/);
});

test("the cell inspector imports its Orange Wall number formatter", async () => {
  const editor = await readFile(
    new URL("../app/VoxelBench.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    editor,
    /import \{[\s\S]*?orangeWallMechanismDepth[\s\S]*?\} from "\.\/orangeWalls\.mjs"/,
  );
  assert.match(editor, /rise \$\{orangeWallMechanismDepth\(voxel\)\}/);
});

test("the MazeBench GLTF loader has every local module dependency", async () => {
  const [loader, threeModule, threeCore, geometryUtils, skeletonUtils] = await Promise.all([
    readFile(new URL("../public/vendor/GLTFLoader.js", import.meta.url), "utf8"),
    readFile(new URL("../public/vendor/three.module.js", import.meta.url), "utf8"),
    readFile(new URL("../public/vendor/three.core.js", import.meta.url), "utf8"),
    readFile(new URL("../public/utils/BufferGeometryUtils.js", import.meta.url), "utf8"),
    readFile(new URL("../public/utils/SkeletonUtils.js", import.meta.url), "utf8"),
  ]);

  for (const source of [loader, geometryUtils, skeletonUtils]) {
    assert.match(source, /from '\/vendor\/three\.module\.js'/);
    assert.doesNotMatch(source, /from 'three'/);
  }
  assert.match(loader, /from '\.\.\/utils\/BufferGeometryUtils\.js'/);
  assert.match(loader, /from '\.\.\/utils\/SkeletonUtils\.js'/);
  assert.match(threeModule, /from '\.\/three\.core\.js'/);
  assert.match(threeCore, /const REVISION = '184'/);
});
