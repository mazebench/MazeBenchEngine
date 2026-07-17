const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "server", "app.js"), "utf8");
const agentScript = fs.readFileSync(path.join(root, "public", "agent.js"), "utf8");
const buildScript = fs.readFileSync(path.join(root, "public", "build.js"), "utf8");
const buildTheme = fs.readFileSync(path.join(root, "public", "build-theme.css"), "utf8");
const pageChrome = fs.readFileSync(path.join(root, "server", "page-chrome.js"), "utf8");
const pages = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");
const playCore = fs.readFileSync(path.join(root, "public", "play-core.js"), "utf8");
const playRenderer = fs.readFileSync(path.join(root, "public", "play-render-three.js"), "utf8");
const playScript = fs.readFileSync(path.join(root, "public", "play.js"), "utf8");
const playTheme = fs.readFileSync(path.join(root, "public", "play-theme.css"), "utf8");
const siteTheme = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");
const replayExporter = fs.readFileSync(path.join(root, "scripts", "maze-export-replay.js"), "utf8");
const favicon = fs.readFileSync(path.join(root, "public", "favicon.svg"), "utf8");
const router = fs.readFileSync(path.join(root, "server", "router.js"), "utf8");
const { nativeFrameCountIsAcceptable } = require(path.join(root, "scripts", "maze-export-replay.js"));

assert.match(buildScript, /world-card new-world-card/);
assert.match(buildScript, /world-card world-card--draft/);
assert.match(buildScript, /badge badge--updated/);
assert.match(buildScript, /card-actions card-actions--draft/);
assert.match(buildScript, /class="world-card__link" href="\$\{escapeText\(world\.author_url\)\}"/);
assert.match(buildScript, />Edit<\/a>/);
assert.match(buildScript, />Play<\/a>/);
assert.match(buildScript, />Delete<\/button>/);
assert.doesNotMatch(buildScript, />Publish<\/button>/);
assert.match(buildTheme, /\.new-world-card__plus/);
assert.match(buildTheme, /\.world-card--draft \.card-body/);
assert.match(buildTheme, /\.world-card--draft \.card-actions/);
assert.match(buildTheme, /\.build-modal\.open/);
assert.match(pages, /Build and Play/);
assert.doesNotMatch(pages, /modeCard\("\/play"/);
assert.match(pages, /\["Edit", `\/author\/maze\//);
assert.doesNotMatch(pages, /\["Edit Levels", `\/author\/maze\//);
assert.doesNotMatch(pageChrome, /href="\/play">Play<\/a>/);
assert.match(pageChrome, /<span class="brand-mark"[^>]*>\$\{BRAND_MARK_SVG\}<\/span>Maze Bench/);
assert.match(playTheme, /\.wm \{ fill: #ffd15c; stroke: #ffd15c; stroke-width: 1\.5; \}/);
assert.doesNotMatch(playTheme, /mbChromL|mbChromR|mbWrtick|mbWbtick/);
assert.match(playTheme, /translate: 0 calc\(-1 \* var\(--mb-logo-lift, 0px\)\)/);
assert.doesNotMatch(playTheme, /--mb-sign-gap|--mb-scene-h/);
assert.doesNotMatch(playTheme, /wordmark-m/);
assert.doesNotMatch(playTheme, /mbTick/);
assert.match(router, /if \(url\.pathname === "\/play"\) \{[\s\S]*?sendRedirect\(response, "\/build"\)/);
assert.match(favicon, /Maze Bench Minotaur/);
assert.match(favicon, /M 358\.428 591\.327/);
assert.match(favicon, /M 684 591\.750/);
assert.match(favicon, /fill-rule="evenodd"/);
assert.doesNotMatch(favicon, /Minotaur icon by Lorc|M189\.78 118\.22|<ellipse/);
assert.match(favicon, /stroke="#34e7f0" stroke-width="3"/);
assert.match(pageChrome, /BRAND_MARK_SVG = `[\s\S]*?M 358\.428 591\.327/);

assert.match(
  pages,
  /id="train-model-loading" class="models-loading" role="status" aria-live="polite"><span class="inline-spinner" aria-hidden="true"><\/span><span class="models-loading__label">Loading models<\/span>/
);
assert.match(siteTheme, /\.inline-spinner \{[\s\S]*?animation: loading-spin 0\.85s linear infinite/);
assert.match(siteTheme, /@keyframes loading-spin \{[\s\S]*?transform: rotate\(360deg\)/);
assert.match(pages, /rel="preload" as="image" href="\/logos\/codex\.png"[^>]*fetchpriority="high"/);
assert.match(pages, /rel="preload" as="image" href="\/logos\/claude\.png"[^>]*fetchpriority="high"/);
assert.match(pages, /rel="preload" as="image" href="\/logos\/prime\.png"[^>]*fetchpriority="high"/);
assert.doesNotMatch(agentScript, /logos\/(?:codex|claude|prime)\.png" alt="" loading="lazy"/);
assert.equal((agentScript.match(/loading="eager" decoding="sync" fetchpriority="high"/g) || []).length, 3);
assert.match(agentScript, /const HARNESSES = \[/);
assert.match(agentScript, /id: "none",\s*name: "Prime Intellect",\s*logo: '<img src="\/logos\/prime\.png"/);
assert.match(agentScript, /id: "codex",\s*name: "Codex"/);
assert.match(agentScript, /id: "claude-code",\s*name: "Claude Code"/);
assert.match(agentScript, /kind: "prime",\s*harness: state\.harness/);
assert.match(agentScript, /kind: "local",\s*subscription: true/);
assert.match(pages, /data-execution="prime"/);
assert.match(pages, /data-execution="local"/);
assert.match(pages, /data-execution="prime"[\s\S]*?src="\/logos\/prime\.png"/);
assert.match(pages, /id="local-run-status"[^>]*hidden/);
assert.doesNotMatch(agentScript, /provider-card__avail/);
assert.ok(
  pages.indexOf('id="provider-picker"') < pages.indexOf('id="harness-execution"'),
  "Run through choices should appear beneath the selected harness"
);
assert.match(pages, /<h3>Harness<\/h3>/);
assert.match(pages, /window\.__PLAY_WORLD_DATA__/);
assert.match(pages, /maze-frame is-loading/);
assert.match(pages, /class="maze-load-label">Loading</);
assert.match(pages, /maze-load-progress/);
assert.match(playScript, /renderer\.primeHomeEdgeReveal/);
assert.match(playScript, /renderer\.beginHomeEdgeReveal/);
assert.match(playScript, /function diveIntoRoom/);
assert.match(playScript, /playData\.hostFullBleedView = true/);
assert.match(playScript, /function syncPlayCameraDownshift\(\)/);
assert.match(playScript, /if \(playData\.hostOwnsPlayHud === true\)/);
assert.match(playScript, /shellRect\.bottom - viewportBottom/);
assert.match(playScript, /app\.playCameraDownshiftPx = clippedBottom \/ 2/);
assert.match(playRenderer, /isEditorRenderMode\(\)[\s\S]*?app\.editorCameraDownshiftPx[\s\S]*?app\.playCameraDownshiftPx/);
assert.match(pages, /class="mazebench-controls"/);
assert.match(pages, /data-quadrant-pad="move"/);
assert.match(pages, /data-quadrant-pad="camera"/);
assert.match(pages, /const PLAY_HUD_ICONS = Object\.freeze/);
assert.match(pages, /id="play-hud-rooms" class="play-hud-stat play-hud-stat--rooms"/);
assert.match(pages, /id="play-hud-gems" class="play-hud-stat play-hud-stat--gems"/);
assert.match(pages, /data-action="undo" aria-label="Undo last move">Undo<\/button>/);
assert.doesNotMatch(pages, /id="play-hud-room">Room --/);
assert.doesNotMatch(pages, /data-action="undo"[^>]*><svg/);
assert.match(playScript, /const visitedPlayRoomIds = new Set\(\)/);
assert.match(playScript, /if \(playData\.hostOwnsPlayHud === true\) return/);
assert.match(playScript, /visitedPlayRoomIds\.add\(currentLevelId\)/);
assert.match(playScript, /roomTarget\.setAttribute\("aria-label", `\$\{roomCount\} room/);
assert.match(playTheme, /\.play-hud \{[\s\S]*?left: 50%[\s\S]*?position: absolute[\s\S]*?transform: translateX\(-50%\)/);
assert.match(playTheme, /\.play-hud-stat--gems/);
assert.match(playTheme, /\.play-hud-stat svg/);
assert.match(playScript, /const sourceWidth = Math\.max\(1, Number\(app\.boardRect\?\.width\) \/ renderScale \|\| roomWidth\)/);
assert.doesNotMatch(playScript, /function playWorldFitOptions/);
assert.match(playRenderer, /app\.worldViewVistaMode !== true/);
assert.match(playRenderer, /app\.homeVectorTheme !== true/);
assert.match(playRenderer, /const zoomDistanceFactor = Math\.max\(/);
assert.match(
  playRenderer,
  /edgeGeometry: descriptor\.isLoweredOrangeSurface\s*\? componentTopPlaneEdgeGeometry\(cells, descriptor, now\)/
);
assert.match(playRenderer, /function hasOrangeSurfaceAtLevel\(x, y, level, now\)/);
assert.match(playRenderer, /topContacts\.keys\.has\(segmentKey\)/);
assert.match(playRenderer, /function orangePolycubeTopContacts\(voxels, now\)/);
assert.match(
  playRenderer,
  /suppressOrangePolycubeTopContacts\(suppressedEdges, orangeTopContacts\)/
);
assert.match(playRenderer, /function loweredOrangeWrapsForWallVoxels\(voxels, now\)/);
assert.match(playRenderer, /function orangeWallCoversElevationPlane\(x, y, elevation, now\)/);
assert.match(
  playRenderer,
  /suppressWallTopEdgesWrappedByLoweredOrange\(suppressedEdges, loweredOrangeWraps\)/
);
assert.match(playRenderer, /const coversTop = orangeWallCoversElevationPlane\(/);
assert.match(playRenderer, /function variableSolidStepContactEdges\(boxes\)/);
assert.match(playRenderer, /function iceSlopeGroupLabelGeometry\(direction\)/);
assert.match(playRenderer, /const across = \{/);
assert.match(playRenderer, /const uphill = \{/);
assert.match(playRenderer, /across\.x \* localX \+ uphill\.x \* localY/);
assert.match(playRenderer, /function addWeightlessSlopeGroupLabel\(actor, center, bottomY, opacity\)/);
assert.match(playRenderer, /addWeightlessSlopeGroupLabel\(/);
assert.match(playRenderer, /function groupedSlopeActorContactsForVoxels\(voxels, groupId, actorType\)/);
assert.match(playRenderer, /function groupedSlopeActorsCanMergeAtContact\(base, neighbor, contact, neighborContact\)/);
assert.match(playRenderer, /function groupedSlopeActorSuppressedEdgeContacts\(actor\)/);
assert.match(playRenderer, /base\.groupId !== neighbor\.groupId/);
assert.match(playRenderer, /edgeGeometry: polycubeEdgeGeometry\(voxels, \{ groupedSlopeContacts \}\)/);
assert.match(playRenderer, /iceSlopeEdgeGeometry\(actor\.direction, \{ suppressContacts \}\)/);
assert.match(playRenderer, /stepContacts\.keys\.has\(segmentKey\)/);

function rendererFunctionSource(name, nextName) {
  const start = playRenderer.indexOf(`function ${name}`);
  const end = playRenderer.indexOf(`function ${nextName}`, start + 1);

  assert.notEqual(start, -1, `missing renderer function ${name}`);
  assert.notEqual(end, -1, `missing renderer function ${nextName}`);
  return playRenderer.slice(start, end).trim();
}

const groupedSlopeCanMerge = vm.runInNewContext(
  `(${rendererFunctionSource(
    "groupedSlopeActorsCanMergeAtContact",
    "groupedSlopeActorSuppressedEdgeContacts"
  )})`,
  {
    groupedActorCanMergeVisually: () => true,
    groupedActorPolycubeLevel: (actor) => actor.elevation,
    normalizeCardinalDirection: (direction) => direction
  }
);
const groupedSlope = (groupId, direction, elevation = 0) => ({
  direction,
  elevation,
  groupId,
  type: "weightless_box"
});

assert.equal(
  groupedSlopeCanMerge(groupedSlope("M0", "right"), groupedSlope("M0", "right"), "left-side", "right-side"),
  true
);
assert.equal(
  groupedSlopeCanMerge(groupedSlope("M0", "right"), groupedSlope("M1", "right"), "left-side", "right-side"),
  false
);
assert.equal(
  groupedSlopeCanMerge(groupedSlope("M0", "right"), groupedSlope("M0", "right", 1), "high", "low"),
  true
);
assert.equal(
  groupedSlopeCanMerge(groupedSlope("M0", "right"), groupedSlope("M0", "left"), "high", "high"),
  true
);
assert.match(playRenderer, /:\s*isLoweredOrangeSurface\s*\?\s*topHeight/);
assert.match(playRenderer, /const overlaysSupportingSurface =\s*descriptor\.isLoweredOrangeSurface/);
assert.match(
  playRenderer,
  /const supportingSurfaceDepthOffset = descriptor\.isLoweredOrangeSurface \? -1 : -6;/
);
assert.match(playRenderer, /polygonOffsetFactor: supportingSurfaceDepthOffset/);
assert.match(playRenderer, /polygonOffsetUnits: supportingSurfaceDepthOffset/);
assert.match(playCore, /liveSurfaceActorCodes = null;\s*liveSurfaceActorState = null;\s*invalidateTerrainFeatureIndex\(\)/);
assert.match(playRenderer, /4 \*\s*zoomDistanceFactor/);
assert.match(playScript, /app\.homeVectorTheme = true/);
assert.match(playScript, /app\.vectorGlowAmount = 1/);
assert.match(pages, /data-action="world-map" aria-controls="world-map-overlay"/);
assert.match(pages, /id="world-map-overlay" class="world-map-overlay"/);
assert.match(pages, /id="world-map-grid" class="world-map-grid"/);
assert.match(pages, /play-theme\.css\?v=\$\{PLAY_ASSET_VERSION\}/);
assert.match(pages, /play\.js\?v=\$\{PLAY_ASSET_VERSION\}/);
assert.match(appSource, /STATIC_CACHE_CONTROL = "no-cache, max-age=0, must-revalidate"/);
assert.match(playScript, /function renderPlayWorldMap\(\)/);
assert.match(playScript, /async function switchPlayWorldLevel\(levelId, options = \{\}\)/);
assert.match(playScript, /window\.__PIXEL_GAME_REPLAY_CAPTURE__ !== true/);
assert.match(playScript, /options\.reloadCurrent !== true/);
assert.match(playScript, /app\.switchPlayWorldLevel = switchPlayWorldLevel/);
assert.match(replayExporter, /app\.switchPlayWorldLevel\(nextLevelId, \{ reloadCurrent: true \}\)/);
assert.match(replayExporter, /async function settleReplayActionBoundary\(\)/);
assert.match(replayExporter, /const actionHandoff = await settleReplayActionBoundary\(\)/);
assert.match(replayExporter, /ordinary directional move[\s\S]*cross a room edge/);
assert.match(replayExporter, /app\.render\?\.\(performance\.now\(\)\)/);
assert.match(replayExporter, /Room transition did not settle before the next action/);
assert.match(replayExporter, /const terminalColumns = 64/);
assert.match(replayExporter, /const terminalRows = 64/);
assert.match(replayExporter, /What the model sees:/);
assert.match(replayExporter, /app\.autoUndoPlayerFalls = false/);
assert.match(replayExporter, /--use-angle=swiftshader/);
assert.match(replayExporter, /function startRawVideoEncoder/);
assert.match(replayExporter, /__advanceMazeReplayFrame__/);
assert.match(replayExporter, /new MediaRecorder\(stream/);
assert.match(replayExporter, /Native replay recorder retained/);
assert.equal(nativeFrameCountIsAcceptable(2698, 2698), true);
assert.equal(nativeFrameCountIsAcceptable(2697, 2698), true);
assert.equal(nativeFrameCountIsAcceptable(2696, 2698), false);
assert.equal(nativeFrameCountIsAcceptable(2699, 2698), false);
assert.match(replayExporter, /Accelerated replay produced a blank gameplay frame/);
assert.match(replayExporter, /Accelerated replay diverged after action/);
assert.match(replayExporter, /await captureFixedFrames\(edgeFrames\)/);
assert.match(replayExporter, /const startedAt = Number\(window\.__MAZE_REPLAY_NOW__\) \|\| performance\.now\(\)/);
assert.match(replayExporter, /app\.vectorGlowAmount = 1 - eased/);
assert.match(replayExporter, /await captureFixedFrames\(diveFrames\)/);
assert.ok(
  replayExporter.indexOf("await captureFixedFrames(edgeFrames)") <
    replayExporter.indexOf("app.vectorGlowAmount = 1 - eased") &&
    replayExporter.indexOf("app.vectorGlowAmount = 1 - eased") <
      replayExporter.indexOf("await captureFixedFrames(diveFrames)"),
  "replay intro must finish the blue edge sweep before the color-fade camera dive"
);
assert.doesNotMatch(replayExporter, /ASCII OBSERVATION/);
assert.match(pages, /id="regenerate-video"/);
assert.match(pages, /id="cancel-video"/);
assert.match(router, /segments\.length === 5 \|\| segments\.length === 6/);
assert.match(router, /segments\[5\] === "cancel"/);
assert.match(router, /segments\[5\] === "regenerate"/);
assert.match(playCore, /hostOwnsWorldMapNavigation: playData\?\.hostOwnsWorldMapNavigation === true/);
assert.match(playCore, /if \(!app\.isEditorRenderApp && areOrangeButtonsPressed\(actors\)\)/);
assert.match(playCore, /autoUndoPlayerFalls: playData\?\.autoUndoPlayerFalls === true/);
assert.match(playCore, /new window\.CustomEvent\("mazebench:level-state-applied"/);
assert.match(
  playCore,
  /function rememberHorizontalNeighborLevelState\(levelState\) \{\s*rememberCanonicalLevelPlayerStart\(levelState\)/
);
assert.match(playCore, /`\$\{nextPath\}\$\{window\.location\.search \|\| ""\}\$\{window\.location\.hash \|\| ""\}`/);
assert.match(playCore, /\{ \.\.\.\(window\.history\.state \|\| \{\}\), levelId: app\.currentLevelId \}/);
assert.match(playScript, /if \(app\.hostOwnsWorldMapNavigation === true\) return;/);
assert.match(playScript, /function playWorldMapTransitionSnapshot\(\)/);
assert.match(playScript, /const roomDistance = Math\.hypot\(dx, dy\)/);
assert.match(playScript, /prewarmAdjacentLevelTransition\?\.\(transitionData, durationMs\)/);
assert.match(playScript, /startLevelTransition\(null, null, dx, dy/);
assert.match(playTheme, /#world-map-overlay \.world-map-grid \{[\s\S]*?grid-auto-rows: var\(--world-map-tile-size/);
assert.match(playTheme, /#game-root \.maze-load-label \{/);
assert.match(playTheme, /font-size: clamp\(16px, 1\.8vw, 22px\)/);
assert.ok(
  playScript.indexOf("let worldMapSwitching = false;") < playScript.indexOf("installPlayControls();"),
  "Play overlay state must initialize before controls synchronize it"
);
assert.match(playScript, /const cameraYawDurationMs = 400/);
assert.match(playScript, /skipRender: true/);
assert.match(playScript, /skipResize: true/);
assert.match(playScript, /preserveSceneCache: true/);
assert.match(playScript, /\(now, "camera"\)/);
assert.match(playCore, /renderedFrameChannels/);
assert.match(playCore, /renderOncePerFrame\(now = performance\.now\(\), channel = "scene"\)/);
assert.match(playRenderer, /fitCameraToScene\(cameraFlightFitOptions\(\) \|\| \{\}\)/);
assert.match(playScript, /const moveRepeatIntervalMs = 100/);
assert.match(playScript, /function quadrantPadButtonAtPoint\(pad, clientX, clientY\)/);
assert.match(playScript, /Math\.hypot\(dx, dy\) > radius/);
assert.match(playScript, /Math\.abs\(dx\) > Math\.abs\(dy\)/);
assert.match(playTheme, /\.control-pad\[data-quadrant-pad\] \{[\s\S]*?pointer-events: auto/);
assert.doesNotMatch(playTheme, /clip-path: circle/);
assert.match(playScript, /Math\.min\(rect\.width, rect\.height\) \* 0\.56/);
assert.match(playScript, /app\.cancelQueuedAction\?\.\(inputSource\)/);
assert.match(playScript, /playData\.autoUndoPlayerFalls = true/);
assert.match(playScript, /const cameraTiltAcceleration = Math\.PI \* 3\.4/);
assert.match(playScript, /enableCameraControls: false/);
assert.doesNotMatch(playScript, /new KeyboardEvent/);

console.log("site-parity-source: OK — MazeJam cards and blue-edge opening motion are canonical locally.");
