const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
assert.match(pages, /rel="preload" as="image" href="\/logos\/codex\.png"[^>]*fetchpriority="high"/);
assert.match(pages, /rel="preload" as="image" href="\/logos\/claude\.png"[^>]*fetchpriority="high"/);
assert.match(pages, /rel="preload" as="image" href="\/logos\/prime\.png"[^>]*fetchpriority="high"/);
assert.doesNotMatch(agentScript, /logos\/(?:codex|claude|prime)\.png" alt="" loading="lazy"/);
assert.equal((agentScript.match(/loading="eager" decoding="sync" fetchpriority="high"/g) || []).length, 3);
assert.match(pages, /window\.__PLAY_WORLD_DATA__/);
assert.match(pages, /maze-frame is-loading/);
assert.match(pages, /class="maze-load-label">Loading</);
assert.match(pages, /maze-load-progress/);
assert.match(playScript, /renderer\.primeHomeEdgeReveal/);
assert.match(playScript, /renderer\.beginHomeEdgeReveal/);
assert.match(playScript, /function diveIntoRoom/);
assert.match(playScript, /playData\.hostFullBleedView = true/);
assert.match(pages, /class="mazebench-controls"/);
assert.match(pages, /data-quadrant-pad="move"/);
assert.match(pages, /data-quadrant-pad="camera"/);
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
assert.match(playRenderer, /stepContacts\.keys\.has\(segmentKey\)/);
assert.match(playRenderer, /:\s*isLoweredOrangeSurface\s*\?\s*topHeight/);
assert.match(playRenderer, /const overlaysSupportingSurface =\s*descriptor\.isLoweredOrangeSurface/);
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
assert.match(replayExporter, /const transitionHandoff = await page\.evaluate/);
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
