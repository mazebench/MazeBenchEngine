(function () {
  const modules = window.PlayModules || (window.PlayModules = {});
  const threeModuleUrl = "/vendor/three.module.js";
  const gltfLoaderModuleUrl = "/vendor/GLTFLoader.js";

  modules.registerThreeRenderFunctions = function registerThreeRenderFunctions(app) {
    const threeCanvas = document.createElement("canvas");
    let THREE = null;
    let renderer = null;
    let scene = null;
    let edgeScene = null;
    let camera = null;
    let ambientLight = null;
    let keyLight = null;
    let GLTFLoaderClass = null;
    let raycaster = null;
    let lastWidth = 0;
    let lastHeight = 0;
    let lastSceneSignature = "";
    let lastSceneContentSignature = "";
    let lastShadowSceneSignature = "";
    let lastCameraFitSignature = "";
    let lastCameraFitHeight = 0;
    let lastCameraFitDistance = 0;
    let hasRenderedScene = false;
    let debugCameraYaw = 0;
    let debugCameraTilt = 0.22;
    let debugCameraZoom = 1;
    let debugCameraTargetYaw = debugCameraYaw;
    let debugCameraTargetTilt = debugCameraTilt;
    let debugCameraTargetZoom = debugCameraZoom;
    let debugCameraAnimation = null;
    let debugCameraAnimationFrameId = 0;
    let debugCameraActive = false;
    let cameraMode = "perspective";
    let activeRenderContext = null;
    let cameraEstimateOverride = null;
    let editorHoverTarget = null;
    let editorHoverRenderFrameId = 0;
    let editorHighlightMaterial = null;
    let editorPickMaterial = null;
    let debugCameraTiltHoldFrameId = 0;
    let debugCameraTiltHoldLastMs = 0;
    const debugCameraTiltHoldKeys = new Set();
    const unit = app.TILE_SIZE;
    const elevationUnit = unit;
    const shapeCornerRadius = 0;
    const floorThickness = Math.max(3, Math.round(unit * 0.34));
    const floorDrop = Math.max(3, Math.round(unit * 0.055));
    const actorVisualLift = 0;
    const edgeDepthBias = Math.max(1.25, unit * 0.024);
    const treeReferenceHeightInModelUnits = 5.516;
    const treeModelWorldScale = (unit * 6) / treeReferenceHeightInModelUnits;
    const shrubModelScaleMultiplier = 0.5;
    const blockAssetModelWorldScale = unit / 2;
    const gemModelWorldSize = unit * 0.87;
    const gemSpinPeriodMs = 7200;
    const puncherRadius = unit * 0.34;
    const puncherDepth = unit * 0.13;
    const puncherArmThickness = unit * 0.18;
    const debugCameraTopTilt = 0;
    const debugCameraSideTilt = Math.PI / 2;
    const debugCameraTiltHoldDurationMs = 500;
    const debugCameraMinZoom = 0.55;
    const debugCameraMaxZoom = 10;
    const debugCameraZoomStep = 1.14;
    const neighboringRoomBrightness = 0.62;
    const geometryCache = new Map();
    const edgeGeometryCache = new Map();

    function markPersistentGeometry(geometry) {
      if (geometry?.userData) {
        geometry.userData.persistentGeometry = true;
      }

      return geometry;
    }

    function cacheGeometry(key, geometry) {
      geometryCache.set(key, markPersistentGeometry(geometry));
      return geometry;
    }

    function cacheEdgeGeometry(key, geometry) {
      edgeGeometryCache.set(key, markPersistentGeometry(geometry));
      return geometry;
    }

    const materialCache = new Map();
    const lineMaterialCache = new Map();
    const textureCache = new Map();
    const imageMaterialCache = new Map();
    const modelAssetCache = new Map();
    // Bumped whenever a GLB finishes parsing. World-view room signatures fold
    // it in so groups meshed with fallback primitives re-sign (and rebuild
    // with the real model) once the asset arrives.
    let modelAssetsVersion = 0;
    const outlineOffsetCache = new Map();
    const levelStateSignatureCache = new WeakMap();
    // Level-state signatures are large per-tile strings; comparing or joining
    // them per room per frame is expensive at world scale. Interning them to
    // short tokens keeps equality checks exact while making the per-frame
    // strings tiny.
    const signatureTokenCache = new Map();

    function signatureToken(signature) {
      let token = signatureTokenCache.get(signature);

      if (token === undefined) {
        token = `s${signatureTokenCache.size + 1}`;
        signatureTokenCache.set(signature, token);
      }

      return token;
    }
    const groupLabelTextureCache = new Map();
    const groupLabelMaterialCache = new Map();
    const polycubeFaceCellsCache = new Map();
    const playerLiftMarkerMeshes = new Set();
    // Retained-actor tracking: scene/edge objects created for each actor in
    // the current room, so animation frames can move them in place instead
    // of tearing down and rebuilding the whole scene graph.
    const trackedActorObjects = new Map();
    const trackedStaticActorCodes = new Map();
    // World-view play: merged per-room groups cached across scene rebuilds.
    const worldViewRoomGroups = new Map();
    // Set when the per-frame room-group build budget ran out; drives
    // follow-up renders until the whole world has been built.
    let worldViewRoomBuildPending = false;
    // Flyover whole-world: one consolidated snapshot of all room groups,
    // rebuilt only when the world settles after changes.
    let worldConsolidation = null;
    let trackedBuildStateRef = null;
    let trackedBuildTerrainVersion = -1;
    let terrainScanCacheState = null;
    let terrainScanCacheVersion = -1;
    let terrainScanCacheValue = "";
    let polycubeComponentNeighborOffsetCache = null;
    let polycubeEdgeContactOffsetCache = null;

    function renderState() {
      return activeRenderContext?.state || app.state;
    }

    function renderActorContextKey(actor) {
      return [
        actor?.type || "",
        actor?.groupId || "",
        actor?.direction || actor?.facing || "",
        actor?.x,
        actor?.y,
        actor?.elevation ?? 0
      ].join(":");
    }

    function invalidateSceneCache() {
      lastSceneSignature = "";
      lastSceneContentSignature = "";
      lastShadowSceneSignature = "";
      hasRenderedScene = false;
      terrainScanCacheState = null;
      worldViewRoomSignatureMemo.clear();
    }

    function renderOffsetX() {
      return activeRenderContext?.offsetX || 0;
    }

    function renderOffsetZ() {
      return activeRenderContext?.offsetZ || 0;
    }

    function clamp01(value) {
      return Math.max(0, Math.min(1, value));
    }

    function localProgress(progress, start, duration) {
      return clamp01((progress - start) / Math.max(0.001, duration));
    }

    function transitionProgress(now = performance.now()) {
      const transition = app.levelTransition;

      if (!transition?.transitionData || !transition.durationMs) {
        return 0;
      }

      return clamp01((now - transition.startMs) / transition.durationMs);
    }

    function lerp(start, end, progress) {
      return start + (end - start) * progress;
    }

    function smootherStep(progress) {
      const t = clamp01(progress);
      return t * t * t * (t * (t * 6 - 15) + 10);
    }

    function renderContextOpacity() {
      const context = activeRenderContext;

      return clamp01(Number(context?.alpha ?? 1));
    }

    function renderContextBrightness() {
      const context = activeRenderContext;
      let brightness = clamp01(Number(context?.brightness ?? 1));

      if (context?.role === "incoming") {
        const progress = localProgress(context.progress, 0, 0.36);
        const eased = app.easeInOutQuad ? app.easeInOutQuad(progress) : progress;
        brightness = lerp(neighboringRoomBrightness, 1, eased);
      }

      if (context?.role === "outgoing") {
        const progress = localProgress(context.progress, 0.52, 0.36);
        const eased = app.easeInOutQuad ? app.easeInOutQuad(progress) : progress;
        brightness = lerp(1, neighboringRoomBrightness, eased);
      }

      brightness *= renderContextOpacity();

      return clamp01(brightness);
    }

    function transitionSceneVisibility() {
      return 1;
    }

    function isEditorRenderMode() {
      return (
        app.isEditorRenderApp === true ||
        app.canvas?.id === "author-canvas" ||
        app.currentLevelId === "__editor_render__" ||
        renderState().levelId === "__editor_render__"
      );
    }

    function isPalettePreviewRenderMode() {
      const levelId = renderState().levelId || app.currentLevelId || "";

      return String(levelId).startsWith("__palette_preview_");
    }

    function transitionPieceProgressForCell() {
      return transitionSceneVisibility();
    }

    function transitionPieceProgressForCells() {
      return transitionSceneVisibility();
    }

    function renderContextCastsShadows() {
      if (app.isFlyoverMode) {
        return false;
      }

      return renderContextOpacity() > 0.62 && renderContextBrightness() > 0.72;
    }

    function withRenderContext(context, callback) {
      const previousContext = activeRenderContext;
      activeRenderContext = context;

      try {
        callback();
      } finally {
        activeRenderContext = previousContext;
      }
    }

    function cameraIsPerspective() {
      return cameraMode === "perspective";
    }

    function playSurroundingRadius() {
      // World actions rebuild the scene every frame; render them at the
      // classic radius so they stay cheap, and restore the wide view with a
      // single rebuild when they finish.
      if (app.worldActionAnimation) {
        return 1;
      }

      return Math.max(1, Math.min(26, Math.floor(Number(app.playSurroundingRadius) || 1)));
    }

    function isWorldViewPlayMode() {
      return !app.isFlyoverMode && !isEditorRenderMode() && playSurroundingRadius() > 1;
    }

    function usesRoomGroupWorld() {
      // Both wide-view play and whole-world flyover render neighbor rooms as
      // per-room merged groups cached across scene rebuilds.
      return (
        isWorldViewPlayMode() ||
        (app.isFlyoverMode && app.flyoverWholeWorld === true)
      );
    }

    function perspectiveCameraFarPlane() {
      if (!app.isFlyoverMode) {
        if (isWorldViewPlayMode()) {
          return Math.max(
            24000,
            (surroundingLevelRadius() * 2 + 1) *
              Math.max(app.boardRect.width, app.boardRect.height) *
              4
          );
        }

        return 8000;
      }

      if (app.flyoverWholeWorld === true && app.flyoverWorldBounds) {
        const bounds = app.flyoverWorldBounds;
        const span = Math.max(
          Number(bounds.maxX) - Number(bounds.minX),
          Number(bounds.maxZ) - Number(bounds.minZ),
          app.boardRect.width,
          app.boardRect.height
        );

        return Math.max(24000, span * 8);
      }

      return Math.max(
        24000,
        (surroundingLevelRadius() * 2 + 1) *
          Math.max(app.boardRect.width, app.boardRect.height) *
          4
      );
    }

    function perspectiveCameraNearPlane() {
      return Math.max(2, unit * 0.075);
    }

    function updateCameraModeToggle() {
      if (!app.cameraModeToggle) {
        return;
      }

      app.cameraModeToggle.textContent = cameraIsPerspective() ? "Perspective" : "Isometric";
      app.cameraModeToggle.setAttribute("aria-pressed", cameraIsPerspective() ? "true" : "false");
    }

    function syncEdgeToggleControl() {
      if (!app.edgeToggle) {
        return;
      }

      const enabled = edgeOutlinesEnabled();
      app.edgeToggle.classList.toggle("is-active", enabled);
      app.edgeToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    }

    function ensureEdgeToggleControl() {
      let edgeToggle = document.getElementById("edge-toggle");

      if (!edgeToggle) {
        const fuzzyToggle = document.getElementById("fuzzy-toggle");
        const anchor = fuzzyToggle || app.cameraModeToggle;
        const parent = anchor?.parentNode;

        if (!parent) {
          return;
        }

        edgeToggle = document.createElement("button");
        edgeToggle.id = "edge-toggle";
        edgeToggle.className = "effect-toggle is-active";
        edgeToggle.type = "button";
        edgeToggle.setAttribute("aria-pressed", "true");
        edgeToggle.setAttribute("aria-label", "Black edges");
        edgeToggle.title = "Black edges";
        edgeToggle.innerHTML = [
          '<span class="effect-icon effect-icon--edges" aria-hidden="true"></span>',
          '<span class="effect-toggle-track" aria-hidden="true">',
          '<span class="effect-toggle-thumb"></span>',
          "</span>"
        ].join("");
        parent.insertBefore(edgeToggle, fuzzyToggle || anchor.nextSibling);
      }

      app.edgeToggle = edgeToggle;
      app.state.effects.edgeOutlinesEnabled = edgeOutlinesEnabled();
      syncEdgeToggleControl();

      if (edgeToggle.dataset.edgeToggleBound === "true") {
        return;
      }

      edgeToggle.dataset.edgeToggleBound = "true";
      edgeToggle.addEventListener("click", () => {
        app.state.effects.edgeOutlinesEnabled = !edgeOutlinesEnabled();
        lastSceneSignature = "";
        syncEdgeToggleControl();

        if (typeof app.render === "function") {
          app.render();
        }
      });
    }

    function createCameraForMode() {
      if (!THREE) {
        return;
      }

      camera = cameraIsPerspective()
        ? new THREE.PerspectiveCamera(34, 1, 1, perspectiveCameraFarPlane())
        : new THREE.OrthographicCamera();
      syncRendererSize();
    }

    function setCameraMode(mode) {
      if (mode !== "perspective" && mode !== "isometric") {
        return;
      }

      if (cameraMode === mode) {
        updateCameraModeToggle();
        return;
      }

      cameraMode = mode;
      lastSceneSignature = "";
      createCameraForMode();
      updateCameraModeToggle();

      if (typeof app.render === "function") {
        app.render();
      }
    }

    function toggleCameraMode() {
      setCameraMode(cameraIsPerspective() ? "isometric" : "perspective");
    }

    function useLevelPreviewCamera() {
      if (!THREE) {
        return;
      }

      if (debugCameraAnimationFrameId) {
        window.cancelAnimationFrame(debugCameraAnimationFrameId);
        debugCameraAnimationFrameId = 0;
      }

      debugCameraAnimation = null;
      debugCameraTiltHoldKeys.clear();
      stopDebugCameraTiltHold();
      debugCameraActive = true;
      debugCameraYaw = 0;
      debugCameraTargetYaw = 0;
      debugCameraTilt = debugCameraTopTilt;
      debugCameraTargetTilt = debugCameraTopTilt;
      debugCameraZoom = 1;
      debugCameraTargetZoom = 1;

      if (cameraMode !== "isometric" || !camera?.isOrthographicCamera) {
        cameraMode = "isometric";
        createCameraForMode();
      } else {
        syncRendererSize();
      }

      lastSceneSignature = "";
      updateCameraModeToggle();
      updateCameraDirectionMapper();
    }

    function setDebugCameraView(options = {}) {
      if (!THREE) {
        return;
      }

      const requestedMode =
        options.mode === "perspective" || options.mode === "isometric" ? options.mode : cameraMode;

      debugCameraActive = true;

      if (
        cameraMode !== requestedMode ||
        (requestedMode === "perspective" && !camera?.isPerspectiveCamera) ||
        (requestedMode === "isometric" && !camera?.isOrthographicCamera)
      ) {
        cameraMode = requestedMode;
        createCameraForMode();
      } else {
        syncRendererSize();
      }

      if (Number.isFinite(options.yaw)) {
        debugCameraTargetYaw = options.yaw;
      }

      if (Number.isFinite(options.tilt)) {
        debugCameraTargetTilt = clampDebugCameraTilt(options.tilt);
      }

      if (Number.isFinite(options.zoom)) {
        debugCameraTargetZoom = clampDebugCameraZoom(options.zoom);
      }

      if (options.animate === true) {
        animateDebugCameraToTarget(Number(options.durationMs) || 260, {
          animateTilt: true
        });
        return;
      }

      if (debugCameraAnimationFrameId) {
        window.cancelAnimationFrame(debugCameraAnimationFrameId);
        debugCameraAnimationFrameId = 0;
      }

      debugCameraAnimation = null;
      debugCameraYaw = debugCameraTargetYaw;
      debugCameraTilt = debugCameraTargetTilt;
      debugCameraZoom = debugCameraTargetZoom;
      lastSceneSignature = "";

      // Hosts driving the camera every frame (e.g. the mazebench.com home
      // flyby) render via renderOncePerFrame themselves; skipRender avoids a
      // second full render plus per-frame DOM writes.
      if (options.skipRender === true) {
        updateCameraDirectionMapper();
        return;
      }

      updateCameraModeToggle();
      updateCameraDirectionMapper();

      if (typeof app.render === "function") {
        app.render();
      }
    }

    function isDebugCameraAnimating() {
      return Boolean(debugCameraAnimation || debugCameraAnimationFrameId || debugCameraTiltHoldFrameId);
    }

    function debugCameraSignature() {
      if (!debugCameraActive) {
        return `camera:${cameraMode}:default`;
      }

      const parts = [
        "camera",
        cameraMode,
        Math.round(debugCameraYaw * 1000),
        Math.round(debugCameraTilt * 1000),
        Math.round(debugCameraZoom * 1000)
      ];

      if (app.isFlyoverMode) {
        parts.push(
          "flyover",
          Math.round(Number(app.flyoverCameraOffsetX || 0) * 1000),
          Math.round(Number(app.flyoverCameraOffsetZ || 0) * 1000),
          String(app.flyoverFocusedLevelId || ""),
          flyoverFocusTransitionSignature()
        );
      } else if (app.cameraFlightFitOptions) {
        const fit = app.cameraFlightFitOptions;

        parts.push(
          "flight-fit",
          Math.round(Number(fit.minX || 0) * 10),
          Math.round(Number(fit.maxX || 0) * 10),
          Math.round(Number(fit.minZ || 0) * 10),
          Math.round(Number(fit.maxZ || 0) * 10),
          Math.round(Number(fit.centerX || 0) * 10),
          Math.round(Number(fit.centerZ || 0) * 10)
        );
      } else if (app.worldPanCameraOffsetX || app.worldPanCameraOffsetZ) {
        // World-pan glides must dirty the camera signature, otherwise pure
        // pan frames early-return before fitCameraToScene and the camera
        // only moves on (expensive) content-rebuild frames.
        parts.push(
          "pan",
          Math.round(Number(app.worldPanCameraOffsetX || 0) * 10),
          Math.round(Number(app.worldPanCameraOffsetZ || 0) * 10)
        );
      }

      return parts.join(":");
    }

    function normalizeQuarterTurns(yaw) {
      const quarterTurn = Math.PI / 2;
      return ((Math.round(yaw / quarterTurn) % 4) + 4) % 4;
    }

    function mapCameraRelativeDirection(dx, dy) {
      if (!debugCameraActive) {
        return [dx, dy];
      }

      switch (normalizeQuarterTurns(debugCameraTargetYaw)) {
        case 1:
          return [dy, -dx];
        case 2:
          return [-dx, -dy];
        case 3:
          return [-dy, dx];
        default:
          return [dx, dy];
      }
    }

    function updateCameraDirectionMapper() {
      app.mapCameraRelativeDirection = mapCameraRelativeDirection;
    }

    function clampDebugCameraTilt(tilt) {
      return Math.max(debugCameraTopTilt, Math.min(debugCameraSideTilt, tilt));
    }

    function clampDebugCameraZoom(zoom) {
      // World view allows zooming far out so the whole world is visible
      // while playing.
      const minZoom = isWorldViewPlayMode() ? 0.06 : debugCameraMinZoom;

      return Math.max(minZoom, Math.min(debugCameraMaxZoom, zoom));
    }

    function cameraUpVectorFor(viewDirection, yaw) {
      const worldUp = new THREE.Vector3(0, 1, 0);
      const projectedUp = worldUp
        .clone()
        .sub(viewDirection.clone().multiplyScalar(worldUp.dot(viewDirection)));

      if (projectedUp.lengthSq() > 0.000001) {
        return projectedUp.normalize();
      }

      return new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
    }

    function applyDebugCameraAnimation(now = performance.now()) {
      if (!debugCameraAnimation) {
        return false;
      }

      const replayFrameStepMs = Number(app.replayAnimationFrameStepMs);
      let elapsedMs = now - debugCameraAnimation.startMs;

      if (Number.isFinite(replayFrameStepMs) && replayFrameStepMs > 0) {
        elapsedMs = (debugCameraAnimation.elapsedMs || 0) + replayFrameStepMs;
        debugCameraAnimation.elapsedMs = elapsedMs;
      }

      const progress = clamp01(elapsedMs / debugCameraAnimation.durationMs);
      const eased = app.easeInOutQuad ? app.easeInOutQuad(progress) : progress;
      debugCameraYaw =
        debugCameraAnimation.startYaw +
        (debugCameraAnimation.targetYaw - debugCameraAnimation.startYaw) * eased;

      if (debugCameraAnimation.targetTilt !== null) {
        debugCameraTilt =
          debugCameraAnimation.startTilt +
          (debugCameraAnimation.targetTilt - debugCameraAnimation.startTilt) * eased;
        debugCameraTargetTilt = debugCameraTilt;
      }

      if (debugCameraAnimation.targetZoom !== null) {
        debugCameraZoom =
          debugCameraAnimation.startZoom +
          (debugCameraAnimation.targetZoom - debugCameraAnimation.startZoom) * eased;
        debugCameraTargetZoom = debugCameraZoom;
      }

      lastSceneSignature = "";

      if (progress >= 1) {
        debugCameraYaw = debugCameraAnimation.targetYaw;

        if (debugCameraAnimation.targetTilt !== null) {
          debugCameraTilt = debugCameraAnimation.targetTilt;
          debugCameraTargetTilt = debugCameraTilt;
        }

        if (debugCameraAnimation.targetZoom !== null) {
          debugCameraZoom = debugCameraAnimation.targetZoom;
          debugCameraTargetZoom = debugCameraZoom;
        }

        debugCameraAnimation = null;
        return false;
      }

      return true;
    }

    function scheduleDebugCameraAnimation() {
      if (debugCameraAnimationFrameId) {
        return;
      }

      debugCameraAnimationFrameId = window.requestAnimationFrame((now) => {
        debugCameraAnimationFrameId = 0;
        const stillAnimating = applyDebugCameraAnimation(now);

        if (typeof app.renderOncePerFrame === "function") {
          app.renderOncePerFrame(now);
        } else if (typeof app.render === "function") {
          app.render(now);
        }

        if (stillAnimating) {
          scheduleDebugCameraAnimation();
        }
      });
    }

    function animateDebugCameraToTarget(durationMs = 220, options = {}) {
      const animateTilt = options.animateTilt !== false;
      const animateZoom = options.animateZoom !== false;

      debugCameraAnimation = {
        durationMs,
        startMs: performance.now(),
        startYaw: debugCameraYaw,
        startTilt: debugCameraTilt,
        startZoom: debugCameraZoom,
        targetYaw: debugCameraTargetYaw,
        targetTilt: animateTilt ? debugCameraTargetTilt : null,
        targetZoom: animateZoom ? debugCameraTargetZoom : null
      };
      scheduleDebugCameraAnimation();
    }

    function tiltHoldDirection() {
      const wantsTop = debugCameraTiltHoldKeys.has("w");
      const wantsSide = debugCameraTiltHoldKeys.has("s");

      if (wantsTop === wantsSide) {
        return 0;
      }

      return wantsTop ? -1 : 1;
    }

    function stopDebugCameraTiltHold() {
      debugCameraTiltHoldLastMs = 0;

      if (debugCameraTiltHoldFrameId) {
        window.cancelAnimationFrame(debugCameraTiltHoldFrameId);
        debugCameraTiltHoldFrameId = 0;
      }
    }

    function applyDebugCameraTiltHold(now) {
      const direction = tiltHoldDirection();

      if (direction === 0) {
        debugCameraTiltHoldLastMs = now;
        return false;
      }

      const elapsedMs =
        debugCameraTiltHoldLastMs > 0 ? Math.min(80, Math.max(0, now - debugCameraTiltHoldLastMs)) : 0;
      const tiltRange = debugCameraSideTilt - debugCameraTopTilt;
      const tiltDelta = (tiltRange * elapsedMs * direction) / debugCameraTiltHoldDurationMs;
      const nextTilt = clampDebugCameraTilt(debugCameraTilt + tiltDelta);

      debugCameraTiltHoldLastMs = now;

      if (nextTilt !== debugCameraTilt) {
        debugCameraTilt = nextTilt;
        debugCameraTargetTilt = nextTilt;
        lastSceneSignature = "";
      }

      const isPushingPastTop = nextTilt <= debugCameraTopTilt && direction < 0;
      const isPushingPastSide = nextTilt >= debugCameraSideTilt && direction > 0;

      return debugCameraTiltHoldKeys.size > 0 && !isPushingPastTop && !isPushingPastSide;
    }

    function scheduleDebugCameraTiltHold() {
      if (debugCameraTiltHoldFrameId) {
        return;
      }

      debugCameraTiltHoldFrameId = window.requestAnimationFrame((now) => {
        debugCameraTiltHoldFrameId = 0;
        const shouldContinue = applyDebugCameraTiltHold(now);

        if (typeof app.renderOncePerFrame === "function") {
          app.renderOncePerFrame(now);
        } else if (typeof app.render === "function") {
          app.render(now);
        }

        if (shouldContinue) {
          scheduleDebugCameraTiltHold();
        } else {
          debugCameraTiltHoldLastMs = 0;
        }
      });
    }

    function startDebugCameraTiltHold(key) {
      debugCameraActive = true;
      debugCameraTiltHoldKeys.add(key);
      scheduleDebugCameraTiltHold();
    }

    function eventTargetsEditableText(event) {
      const target = event.target;

      if (!target) {
        return false;
      }

      if (target.isContentEditable) {
        return true;
      }

      const tagName = String(target.tagName || "").toLowerCase();

      return tagName === "input" || tagName === "textarea" || tagName === "select";
    }

    // Camera keys honor the shared controls config (window.__MAZEBENCH_CONTROLS__)
    // when the host page provides one; otherwise the classic WASD/QE defaults apply.
    function matchesCameraControl(event, action, fallbackKeys) {
      const keys = window.__MAZEBENCH_CONTROLS__?.keys;
      const codes = keys && Array.isArray(keys[action]) ? keys[action] : null;
      if (codes) {
        return codes.includes(event.code);
      }
      return fallbackKeys.includes(event.key.toLowerCase());
    }

    function cameraYawKeyDirection() {
      return window.__MAZEBENCH_CONTROLS__?.invertCameraRotation === true ? -1 : 1;
    }

    function handleDebugCameraKeydown(event) {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        window.__MAZEBENCH_CONTROLS_CAPTURE__ === true ||
        window.__MAZEBENCH_INPUT_LOCKED__ === true ||
        eventTargetsEditableText(event)
      ) {
        return;
      }

      const yawStep = (Math.PI / 2) * cameraYawKeyDirection();
      let handled = true;
      let durationMs = 180;

      if (matchesCameraControl(event, "cameraUp", ["w"])) {
        startDebugCameraTiltHold("w");
        event.preventDefault();
        return;
      } else if (matchesCameraControl(event, "cameraDown", ["s"])) {
        startDebugCameraTiltHold("s");
        event.preventDefault();
        return;
      } else if (matchesCameraControl(event, "cameraLeft", ["a"])) {
        if (event.repeat) {
          return;
        }
        debugCameraTargetYaw -= yawStep;
        durationMs = 260;
      } else if (matchesCameraControl(event, "cameraRight", ["d"])) {
        if (event.repeat) {
          return;
        }
        debugCameraTargetYaw += yawStep;
        durationMs = 260;
      } else if (matchesCameraControl(event, "zoomIn", ["q"])) {
        debugCameraTargetZoom = clampDebugCameraZoom(debugCameraTargetZoom * debugCameraZoomStep);
        durationMs = 140;
      } else if (matchesCameraControl(event, "zoomOut", ["e"])) {
        debugCameraTargetZoom = clampDebugCameraZoom(debugCameraTargetZoom / debugCameraZoomStep);
        durationMs = 140;
      } else {
        handled = false;
      }

      if (!handled) {
        return;
      }

      debugCameraActive = true;
      lastSceneSignature = "";
      event.preventDefault();
      animateDebugCameraToTarget(durationMs, { animateTilt: false });
    }

    function handleDebugCameraKeyup(event) {
      if (eventTargetsEditableText(event)) {
        return;
      }

      const key = matchesCameraControl(event, "cameraUp", ["w"])
        ? "w"
        : matchesCameraControl(event, "cameraDown", ["s"])
          ? "s"
          : "";

      if (!key) {
        return;
      }

      debugCameraTiltHoldKeys.delete(key);

      if (debugCameraTiltHoldKeys.size === 0) {
        stopDebugCameraTiltHold();
      } else {
        scheduleDebugCameraTiltHold();
      }
    }

    function dimHexColor(color, brightness = 1) {
      const normalizedBrightness = clamp01(brightness);
      const match = String(color || "").match(/^#([0-9a-f]{6})$/i);

      if (!match || normalizedBrightness >= 0.999) {
        return color;
      }

      const value = parseInt(match[1], 16);
      const r = Math.round(((value >> 16) & 255) * normalizedBrightness);
      const g = Math.round(((value >> 8) & 255) * normalizedBrightness);
      const b = Math.round((value & 255) * normalizedBrightness);

      return `#${[r, g, b]
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("")}`;
    }

    function renderContextColor(color) {
      const brightness = renderContextBrightness();
      // Quantize so fades reuse a bounded set of dimmed colors instead of
      // minting a new material cache entry every animation frame.
      const quantized = brightness >= 0.999 ? 1 : Math.round(brightness * 32) / 32;
      return dimHexColor(color, quantized);
    }

    function material(color, opacity = 1, variants = null) {
      return cachedMaterialForRenderColor(renderContextColor(color), opacity, variants);
    }

    function cachedMaterialForRenderColor(renderColor, opacity = 1, variants = null) {
      const alpha = Math.max(0, Math.min(1, opacity));
      const doubleSide = variants?.doubleSide === true;
      const noDepthWrite = variants?.depthWrite === false;
      const polygonOffset = variants?.polygonOffset === true;
      const polygonOffsetFactor = polygonOffset ? variants.polygonOffsetFactor ?? -2 : 0;
      const polygonOffsetUnits = polygonOffset ? variants.polygonOffsetUnits ?? -2 : 0;
      const key = `${renderColor}:${Math.round(alpha * 1000)}:${doubleSide ? 1 : 0}${noDepthWrite ? 1 : 0}${polygonOffset ? 1 : 0}:${polygonOffsetFactor}:${polygonOffsetUnits}`;

      if (!materialCache.has(key)) {
        const options = {
          color: renderColor,
          flatShading: true,
          opacity: alpha,
          transparent: alpha < 0.999,
          depthWrite: noDepthWrite ? false : alpha >= 0.999
        };

        if (renderColor !== "#050608") {
          options.emissive = renderColor;
          options.emissiveIntensity = renderColor === "#b85f16" ? 0.28 : 0.12;
        }

        const cachedMaterial = new THREE.MeshLambertMaterial(options);

        if (doubleSide) {
          cachedMaterial.side = THREE.DoubleSide;
        }

        if (polygonOffset) {
          cachedMaterial.polygonOffset = true;
          cachedMaterial.polygonOffsetFactor = polygonOffsetFactor;
          cachedMaterial.polygonOffsetUnits = polygonOffsetUnits;
        }

        // Enough provenance to mint the dimmed twin this cache entry's
        // meshes would have been built with at a lower brightness.
        cachedMaterial.userData.dimSource = {
          color: renderColor,
          opacity: alpha,
          doubleSide,
          noDepthWrite,
          polygonOffset,
          polygonOffsetFactor,
          polygonOffsetUnits
        };
        materialCache.set(key, cachedMaterial);
      }

      return materialCache.get(key);
    }

    // Dimmed twin of a cache material; identical to what a rebuild at
    // `factor` would have produced (same dimHexColor + same creator).
    function dimmedWorldMaterial(baseMaterial, factor) {
      const source = baseMaterial?.userData?.dimSource;

      if (!source || factor >= 0.999) {
        return baseMaterial;
      }

      return cachedMaterialForRenderColor(dimHexColor(source.color, factor), source.opacity, {
        doubleSide: source.doubleSide,
        depthWrite: source.noDepthWrite ? false : undefined,
        polygonOffset: source.polygonOffset,
        polygonOffsetFactor: source.polygonOffsetFactor,
        polygonOffsetUnits: source.polygonOffsetUnits
      });
    }

    function lineMaterial(color = "#000000", opacity = 1) {
      const alpha = Math.max(0, Math.min(1, opacity));
      const key = `${color}:${Math.round(alpha * 1000)}`;

      if (!lineMaterialCache.has(key)) {
        const material = new THREE.LineBasicMaterial({
          color,
          depthTest: true,
          depthWrite: false,
          linewidth: 1,
          opacity: alpha,
          transparent: alpha < 0.999
        });

        // Pull each edge vertex toward the eye along its own view ray. Points
        // on the eye ray project to the same screen pixel, so this wins the
        // depth test against the retained main-scene depth buffer without the
        // screen-space parallax a world-space camera-axis translation causes
        // at off-center view angles.
        material.onBeforeCompile = (shader) => {
          shader.vertexShader = shader.vertexShader.replace(
            "#include <project_vertex>",
            [
              "vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );",
              `float edgePullBias = ${edgeDepthBias.toFixed(4)};`,
              "if ( isPerspectiveMatrix( projectionMatrix ) ) {",
              "  float edgeViewDistance = max( length( mvPosition.xyz ), 0.0001 );",
              "  float edgePull = max( edgePullBias, edgeViewDistance * 0.0015 );",
              "  mvPosition.xyz *= max( edgeViewDistance - edgePull, 0.0 ) / edgeViewDistance;",
              "} else {",
              "  mvPosition.z += edgePullBias;",
              "}",
              "gl_Position = projectionMatrix * mvPosition;"
            ].join("\n")
          );
        };
        lineMaterialCache.set(key, material);
      }

      return lineMaterialCache.get(key);
    }

    function imageTexture(url) {
      const image = app.imageCache?.get(url);

      if (!image) {
        return null;
      }

      if (!textureCache.has(url)) {
        const texture = new THREE.CanvasTexture(image);

        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        textureCache.set(url, texture);
      }

      return textureCache.get(url);
    }

    function imageMaterial(url, opacity = 1) {
      const texture = imageTexture(url);

      if (!texture) {
        return null;
      }

      const alpha = clamp01(opacity);
      const key = `${url}:${Math.round(alpha * 1000)}`;

      if (!imageMaterialCache.has(key)) {
        imageMaterialCache.set(
          key,
          new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            opacity: alpha,
            depthWrite: false,
            side: THREE.DoubleSide,
            alphaTest: 0.02
          })
        );
      }

      return imageMaterialCache.get(key);
    }

    function invisibleEditorPickMaterial() {
      if (!editorPickMaterial) {
        editorPickMaterial = new THREE.MeshBasicMaterial({
          color: "#ffffff",
          colorWrite: false,
          depthWrite: false,
          opacity: 0,
          transparent: true
        });
      }

      return editorPickMaterial;
    }

    function averageTextureColor(texture) {
      const image = texture?.image;

      if (!image || !image.width || !image.height) {
        return null;
      }

      try {
        const sampleSize = 8;
        const canvas = document.createElement("canvas");

        canvas.width = sampleSize;
        canvas.height = sampleSize;
        const context = canvas.getContext("2d");

        context.drawImage(image, 0, 0, sampleSize, sampleSize);
        const data = context.getImageData(0, 0, sampleSize, sampleSize).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;

        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 8) {
            continue;
          }

          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          count += 1;
        }

        if (!count) {
          return null;
        }

        const hex = (value) => Math.round(value / count).toString(16).padStart(2, "0");

        return `#${hex(r)}${hex(g)}${hex(b)}`;
      } catch (error) {
        return null;
      }
    }

    function extractModelFromGltf(gltf) {
      const root = gltf?.scene || gltf?.scenes?.[0];

      if (!root) {
        return null;
      }

      root.updateMatrixWorld(true);
      const parts = [];

      root.traverse((child) => {
        if (!child.isMesh || !child.geometry?.attributes?.position) {
          return;
        }

        const geometry = child.geometry.clone();

        geometry.applyMatrix4(child.matrixWorld);

        if (!geometry.attributes.normal) {
          geometry.computeVertexNormals();
        }

        geometry.computeBoundingBox();
        markPersistentGeometry(geometry);

        const material = Array.isArray(child.material) ? child.material[0] : child.material;
        // Raw linear values, matching how the art was authored: the game's
        // look treats glTF baseColorFactor floats as display-space hex.
        let color = material?.color
          ? `#${material.color.getHexString(THREE.LinearSRGBColorSpace)}`
          : null;

        // Textured materials usually carry a white base color; the renderer
        // is flat-shaded, so bake the texture's average color instead.
        if (material?.map && (!color || color === "#ffffff")) {
          color = averageTextureColor(material.map) || color;
        }

        parts.push({
          geometry,
          color
        });
      });

      // The renderer only keeps flat-color part geometry; free the loader's
      // own geometries, materials, and decoded textures.
      root.traverse((child) => {
        child.geometry?.dispose?.();
        const materials = Array.isArray(child.material) ? child.material : [child.material];

        materials.forEach((material) => {
          if (!material) {
            return;
          }

          Object.values(material).forEach((value) => {
            if (value?.isTexture) {
              value.dispose();
            }
          });
          material.dispose?.();
        });
      });

      if (parts.length === 0) {
        return null;
      }

      const bounds = new THREE.Box3();

      parts.forEach((part) => {
        if (part.geometry.boundingBox) {
          bounds.union(part.geometry.boundingBox);
        }
      });

      return { bounds, parts };
    }

    function parseModelAsset(url, data) {
      if (!GLTFLoaderClass || !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
        return Promise.resolve(null);
      }

      const arrayBuffer = data instanceof ArrayBuffer
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

      return new Promise((resolve) => {
        try {
          new GLTFLoaderClass().parse(
            arrayBuffer,
            "",
            (gltf) => resolve(extractModelFromGltf(gltf)),
            (error) => {
              console.warn(`Model parse failed for ${url}`, error);
              resolve(null);
            }
          );
        } catch (error) {
          console.warn(`Model parse failed for ${url}`, error);
          resolve(null);
        }
      });
    }

    const MODEL_RETRY_DELAY_MS = 8000;

    function requestModelAsset(url) {
      if (!url || !THREE) {
        return null;
      }

      const cached = modelAssetCache.get(url);

      if (cached?.status === "ready") {
        return cached.model;
      }

      if (cached?.status === "loading") {
        return null;
      }

      if (cached?.status === "failed") {
        // Transient failures retry instead of poisoning the URL forever.
        if (performance.now() - cached.failedAtMs < MODEL_RETRY_DELAY_MS) {
          return null;
        }

        modelAssetCache.delete(url);

        if (app.modelTextCache?.get(url) === null) {
          app.modelTextCache.delete(url);
        }
      }

      const finalizeModel = (model) => {
        modelAssetCache.set(
          url,
          model
            ? { status: "ready", model }
            : { status: "failed", failedAtMs: performance.now() }
        );
        // A real model arriving must re-sign cached room groups so their
        // fallback primitives rebuild into the actual geometry.
        if (model) {
          modelAssetsVersion += 1;
        }
        invalidateSceneCache();

        if (typeof app.render === "function") {
          window.requestAnimationFrame((now) => (app.renderOncePerFrame || app.render)(now));
        }
      };

      const cachedData = app.modelTextCache?.get(url);

      if (cachedData instanceof ArrayBuffer || ArrayBuffer.isView(cachedData)) {
        modelAssetCache.set(url, {
          status: "loading",
          promise: parseModelAsset(url, cachedData).then(finalizeModel)
        });
        return null;
      }

      const promise = fetch(url)
        .then((response) => (response.ok ? response.arrayBuffer() : null))
        .then((data) => {
          if (data && app.modelTextCache) {
            app.modelTextCache.set(url, data);
          }

          return data ? parseModelAsset(url, data) : null;
        })
        .then(finalizeModel)
        .catch((error) => {
          console.warn(`Model load failed for ${url}`, error);
          finalizeModel(null);
        });

      modelAssetCache.set(url, { status: "loading", promise });
      return null;
    }

    function weightlessGroupLabel(groupId) {
      const value = String(groupId || "").trim();
      const match = value.match(/^[Mc](.+)$/i);

      return match ? match[1] : value;
    }

    function groupLabelTexture(label) {
      const normalizedLabel = String(label || "").trim();

      if (!normalizedLabel) {
        return null;
      }

      if (!groupLabelTextureCache.has(normalizedLabel)) {
        const size = 128;
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");

        canvas.width = size;
        canvas.height = size;

        if (context) {
          context.clearRect(0, 0, size, size);
          context.font = "800 92px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillStyle = "rgba(0, 0, 0, 0.9)";
          context.fillText(normalizedLabel, size / 2, size / 2 + 3);
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        groupLabelTextureCache.set(normalizedLabel, texture);
      }

      return groupLabelTextureCache.get(normalizedLabel);
    }

    function groupLabelMaterial(label, opacity = 1) {
      const texture = groupLabelTexture(label);

      if (!texture) {
        return null;
      }

      const alpha = clamp01(opacity);
      const key = `${label}:${Math.round(alpha * 1000)}`;

      if (!groupLabelMaterialCache.has(key)) {
        groupLabelMaterialCache.set(
          key,
          new THREE.MeshBasicMaterial({
            alphaTest: 0.04,
            depthWrite: false,
            map: texture,
            opacity: alpha,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
            side: THREE.DoubleSide,
            transparent: true
          })
        );
      }

      return groupLabelMaterialCache.get(key);
    }

    function edgeOutlinesEnabled() {
      return app.state.effects.edgeOutlinesEnabled !== false;
    }

    function floorGridMaterial(opacity = 0.34) {
      const alpha = Math.max(0, Math.min(1, opacity));
      const color = renderContextColor("#715c3d");
      const key = `floor-grid:${color}:${Math.round(alpha * 1000)}`;

      if (!lineMaterialCache.has(key)) {
        lineMaterialCache.set(
          key,
          new THREE.LineBasicMaterial({
            color,
            depthTest: true,
            linewidth: 1,
            opacity: alpha,
            transparent: true
          })
        );
      }

      return lineMaterialCache.get(key);
    }

    function roundedRectShape(width, depth, radius, options = {}) {
      radius = shapeCornerRadius;
      const halfWidth = width / 2;
      const halfDepth = depth / 2;
      const clampedRadius = Math.max(0, Math.min(radius, halfWidth, halfDepth));
      const roundNearCorners = options.roundNearCorners !== false;
      const shape = new THREE.Shape();

      if (clampedRadius <= 0.001) {
        shape.moveTo(-halfWidth, -halfDepth);
        shape.lineTo(halfWidth, -halfDepth);
        shape.lineTo(halfWidth, halfDepth);
        shape.lineTo(-halfWidth, halfDepth);
        shape.closePath();
        return shape;
      }

      shape.moveTo(-halfWidth + clampedRadius, -halfDepth);
      shape.lineTo(halfWidth - clampedRadius, -halfDepth);
      shape.quadraticCurveTo(halfWidth, -halfDepth, halfWidth, -halfDepth + clampedRadius);

      if (roundNearCorners) {
        shape.lineTo(halfWidth, halfDepth - clampedRadius);
        shape.quadraticCurveTo(halfWidth, halfDepth, halfWidth - clampedRadius, halfDepth);
        shape.lineTo(-halfWidth + clampedRadius, halfDepth);
        shape.quadraticCurveTo(-halfWidth, halfDepth, -halfWidth, halfDepth - clampedRadius);
      } else {
        shape.lineTo(halfWidth, halfDepth);
        shape.lineTo(-halfWidth, halfDepth);
      }

      shape.lineTo(-halfWidth, -halfDepth + clampedRadius);
      shape.quadraticCurveTo(-halfWidth, -halfDepth, -halfWidth + clampedRadius, -halfDepth);

      return shape;
    }

    function roundedCuboidGeometry(width, depth, height, radius, options = {}) {
      radius = shapeCornerRadius;
      const key = [
        Math.round(width),
        Math.round(depth),
        Math.round(height),
        Math.round(radius),
        options.roundNearCorners === false ? "far" : "all"
      ].join(":");

      if (geometryCache.has(key)) {
        return geometryCache.get(key);
      }

      const geometry = new THREE.ExtrudeGeometry(roundedRectShape(width, depth, radius, options), {
        bevelEnabled: false,
        curveSegments: 8,
        depth: height,
        steps: 1
      });

      geometry.rotateX(Math.PI / 2);
      geometry.computeVertexNormals();
      cacheGeometry(key, geometry);
      return geometry;
    }

    function cylinderGeometry(radius, height, segments = 32) {
      const key = [
        "cylinder",
        Math.round(radius * 100),
        Math.round(height * 100),
        segments
      ].join(":");

      if (geometryCache.has(key)) {
        return geometryCache.get(key);
      }

      const geometry = new THREE.CylinderGeometry(radius, radius, height, segments, 1, false);

      geometry.computeVertexNormals();
      cacheGeometry(key, geometry);
      return geometry;
    }

    function boxGeometry(width, height, depth) {
      const key = [
        "box",
        Math.round(width * 100),
        Math.round(height * 100),
        Math.round(depth * 100)
      ].join(":");

      if (geometryCache.has(key)) {
        return geometryCache.get(key);
      }

      const geometry = new THREE.BoxGeometry(width, height, depth);

      geometry.computeVertexNormals();
      cacheGeometry(key, geometry);
      return geometry;
    }

    function octahedronGeometry(radius) {
      const key = `octa:${Math.round(radius * 100)}`;

      if (geometryCache.has(key)) {
        return geometryCache.get(key);
      }

      return cacheGeometry(key, new THREE.OctahedronGeometry(radius, 0));
    }

    function normalizeCardinalDirection(direction) {
      const value = String(direction || "").toLowerCase();

      if (value === "left" || value === "l") {
        return "left";
      }

      if (value === "up" || value === "u") {
        return "up";
      }

      if (value === "down" || value === "d") {
        return "down";
      }

      return "right";
    }

    function cardinalGridVector(direction) {
      const normalized = normalizeCardinalDirection(direction);

      if (normalized === "left") {
        return { dx: -1, dy: 0 };
      }

      if (normalized === "up") {
        return { dx: 0, dy: -1 };
      }

      if (normalized === "down") {
        return { dx: 0, dy: 1 };
      }

      return { dx: 1, dy: 0 };
    }

    function iceSlopeGeometry(direction) {
      const normalized = normalizeCardinalDirection(direction);
      const key = `ice-slope:${normalized}:${Math.round(unit * 100)}:${Math.round(elevationUnit * 100)}`;

      if (geometryCache.has(key)) {
        return geometryCache.get(key);
      }

      const x0 = -unit / 2;
      const x1 = unit / 2;
      const z0 = -unit / 2;
      const z1 = unit / 2;
      const y0 = 0;
      const y1 = elevationUnit;
      const positions = [];
      const pushTri = (a, b, c) => positions.push(...a, ...b, ...c);
      const pushQuad = (a, b, c, d) => {
        pushTri(a, b, c);
        pushTri(a, c, d);
      };

      if (normalized === "right") {
        pushQuad([x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z1]);
        pushQuad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
        pushTri([x0, y0, z0], [x1, y0, z0], [x1, y1, z0]);
        pushTri([x0, y0, z1], [x1, y1, z1], [x1, y0, z1]);
      } else if (normalized === "left") {
        pushQuad([x1, y0, z0], [x0, y1, z0], [x0, y1, z1], [x1, y0, z1]);
        pushQuad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]);
        pushTri([x1, y0, z0], [x0, y1, z0], [x0, y0, z0]);
        pushTri([x1, y0, z1], [x0, y0, z1], [x0, y1, z1]);
      } else if (normalized === "down") {
        pushQuad([x0, y0, z0], [x0, y1, z1], [x1, y1, z1], [x1, y0, z0]);
        pushQuad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]);
        pushTri([x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
        pushTri([x1, y0, z0], [x1, y1, z1], [x1, y0, z1]);
      } else {
        pushQuad([x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y0, z1]);
        pushQuad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
        pushTri([x0, y0, z1], [x0, y1, z0], [x0, y0, z0]);
        pushTri([x1, y0, z1], [x1, y0, z0], [x1, y1, z0]);
      }

      pushQuad([x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      cacheGeometry(key, geometry);
      return geometry;
    }

    function iceSlopeEdgeGeometry(direction, options = {}) {
      const normalized = normalizeCardinalDirection(direction);
      const suppressedContacts = new Set(options.suppressContacts || []);

      if (options.suppressHighSide === true) {
        suppressedContacts.add("high");
      }

      const contactKey = Array.from(suppressedContacts).sort().join(",") || "open";
      const key = [
        "ice-slope-edges",
        normalized,
        contactKey,
        Math.round(unit * 100),
        Math.round(elevationUnit * 100)
      ].join(":");

      if (edgeGeometryCache.has(key)) {
        return edgeGeometryCache.get(key);
      }

      const x0 = -unit / 2;
      const x1 = unit / 2;
      const z0 = -unit / 2;
      const z1 = unit / 2;
      const y0 = 0;
      const y1 = elevationUnit;
      const segments = [];
      const add = (from, to, ...contacts) => segments.push({ from, to, contacts });

      if (normalized === "left") {
        add([x1, y0, z0], [x1, y0, z1], "low", "bottom");
        add([x1, y0, z0], [x0, y1, z0], "top-side");
        add([x1, y0, z1], [x0, y1, z1], "bottom-side");
        add([x1, y0, z0], [x0, y0, z0], "top-side", "bottom");
        add([x1, y0, z1], [x0, y0, z1], "bottom-side", "bottom");
        add([x0, y1, z0], [x0, y1, z1], "high");
        add([x0, y0, z0], [x0, y0, z1], "high", "bottom");
        add([x0, y0, z0], [x0, y1, z0], "high", "top-side");
        add([x0, y0, z1], [x0, y1, z1], "high", "bottom-side");
      } else if (normalized === "down") {
        add([x0, y0, z0], [x1, y0, z0], "low", "bottom");
        add([x0, y0, z0], [x0, y1, z1], "left-side");
        add([x1, y0, z0], [x1, y1, z1], "right-side");
        add([x0, y0, z0], [x0, y0, z1], "left-side", "bottom");
        add([x1, y0, z0], [x1, y0, z1], "right-side", "bottom");
        add([x0, y1, z1], [x1, y1, z1], "high");
        add([x0, y0, z1], [x1, y0, z1], "high", "bottom");
        add([x0, y0, z1], [x0, y1, z1], "high", "left-side");
        add([x1, y0, z1], [x1, y1, z1], "high", "right-side");
      } else if (normalized === "up") {
        add([x0, y0, z1], [x1, y0, z1], "low", "bottom");
        add([x0, y0, z1], [x0, y1, z0], "left-side");
        add([x1, y0, z1], [x1, y1, z0], "right-side");
        add([x0, y0, z1], [x0, y0, z0], "left-side", "bottom");
        add([x1, y0, z1], [x1, y0, z0], "right-side", "bottom");
        add([x0, y1, z0], [x1, y1, z0], "high");
        add([x0, y0, z0], [x1, y0, z0], "high", "bottom");
        add([x0, y0, z0], [x0, y1, z0], "high", "left-side");
        add([x1, y0, z0], [x1, y1, z0], "high", "right-side");
      } else {
        add([x0, y0, z0], [x0, y0, z1], "low", "bottom");
        add([x0, y0, z0], [x1, y1, z0], "top-side");
        add([x0, y0, z1], [x1, y1, z1], "bottom-side");
        add([x0, y0, z0], [x1, y0, z0], "top-side", "bottom");
        add([x0, y0, z1], [x1, y0, z1], "bottom-side", "bottom");
        add([x1, y1, z0], [x1, y1, z1], "high");
        add([x1, y0, z0], [x1, y0, z1], "high", "bottom");
        add([x1, y0, z0], [x1, y1, z0], "high", "top-side");
        add([x1, y0, z1], [x1, y1, z1], "high", "bottom-side");
      }

      const positions = [];

      segments.forEach((segment) => {
        if (segment.contacts.some((contact) => suppressedContacts.has(contact))) {
          return;
        }

        positions.push(...segment.from, ...segment.to);
      });

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      cacheEdgeGeometry(key, geometry);
      return geometry;
    }

    function pointKey(point) {
      return `${Math.round(point.x * 1000)},${Math.round(point.z * 1000)}`;
    }

    function orderedBoundaryLoops(cells) {
      const cellSet = new Set(cells.map((cell) => `${cell.gridX},${cell.gridY}`));
      const starts = new Map();

      function addSegment(from, to) {
        const key = pointKey(from);

        if (!starts.has(key)) {
          starts.set(key, []);
        }

        starts.get(key).push({ from, to, used: false });
      }

      cells.forEach((cell) => {
        const x0 = cell.left;
        const x1 = cell.right;
        const z0 = cell.top;
        const z1 = cell.bottom;

        if (!cellSet.has(`${cell.gridX},${cell.gridY - 1}`)) {
          addSegment({ x: x0, z: z0 }, { x: x1, z: z0 });
        }

        if (!cellSet.has(`${cell.gridX + 1},${cell.gridY}`)) {
          addSegment({ x: x1, z: z0 }, { x: x1, z: z1 });
        }

        if (!cellSet.has(`${cell.gridX},${cell.gridY + 1}`)) {
          addSegment({ x: x1, z: z1 }, { x: x0, z: z1 });
        }

        if (!cellSet.has(`${cell.gridX - 1},${cell.gridY}`)) {
          addSegment({ x: x0, z: z1 }, { x: x0, z: z0 });
        }
      });

      const loops = [];

      starts.forEach((segments) => {
        segments.forEach((segment) => {
          if (segment.used) {
            return;
          }

          const loop = [segment.from];
          let current = segment;

          while (current && !current.used) {
            current.used = true;
            loop.push(current.to);

            const nextSegments = starts.get(pointKey(current.to)) || [];
            current = nextSegments.find((candidate) => !candidate.used) || null;
          }

          if (loop.length > 3 && pointKey(loop[0]) === pointKey(loop[loop.length - 1])) {
            loops.push(loop);
          }
        });
      });

      return loops;
    }

    function loopArea(loop) {
      let area = 0;

      for (let index = 0; index < loop.length - 1; index += 1) {
        const current = loop[index];
        const next = loop[index + 1];
        area += current.x * next.z - next.x * current.z;
      }

      return area / 2;
    }

    function addLoopToPath(path, loop) {
      const points = loop.slice(0, -1);

      if (points.length === 0) {
        return;
      }

      path.moveTo(points[0].x, points[0].z);

      for (let index = 1; index < points.length; index += 1) {
        path.lineTo(points[index].x, points[index].z);
      }

      path.closePath();
    }

    function nearlyEqual(a, b, tolerance = 0.001) {
      return Math.abs(a - b) <= tolerance;
    }

    function withinInclusive(value, a, b, tolerance = 0.001) {
      return value >= Math.min(a, b) - tolerance && value <= Math.max(a, b) + tolerance;
    }

    function segmentLiesOnBoundary2D(a, b, loops) {
      return loops.some((loop) => {
        for (let index = 0; index < loop.length - 1; index += 1) {
          const current = loop[index];
          const next = loop[index + 1];
          const horizontal = nearlyEqual(current.z, next.z);
          const vertical = nearlyEqual(current.x, next.x);

          if (
            horizontal &&
            nearlyEqual(a.z, b.z) &&
            nearlyEqual(a.z, current.z) &&
            withinInclusive(a.x, current.x, next.x) &&
            withinInclusive(b.x, current.x, next.x)
          ) {
            return true;
          }

          if (
            vertical &&
            nearlyEqual(a.x, b.x) &&
            nearlyEqual(a.x, current.x) &&
            withinInclusive(a.z, current.z, next.z) &&
            withinInclusive(b.z, current.z, next.z)
          ) {
            return true;
          }
        }

        return false;
      });
    }

    function pointLiesOnBoundary2D(point, loops) {
      return segmentLiesOnBoundary2D(point, point, loops);
    }

    function keepComponentEdgeSegment(a, b, loops, height) {
      if (nearlyEqual(a.y, b.y) && (nearlyEqual(a.y, 0) || nearlyEqual(a.y, -height))) {
        return segmentLiesOnBoundary2D(a, b, loops);
      }

      if (nearlyEqual(a.x, b.x) && nearlyEqual(a.z, b.z)) {
        return pointLiesOnBoundary2D(a, loops);
      }

      return true;
    }

    function roomBoundsForContext() {
      const state = renderState();

      return {
        left: renderOffsetX(),
        right: renderOffsetX() + state.width * unit,
        top: renderOffsetZ(),
        bottom: renderOffsetZ() + state.height * unit,
        width: state.width,
        height: state.height
      };
    }

    function roomBoundaryForEdgeSegment(a, b) {
      const bounds = roomBoundsForContext();

      if (nearlyEqual(a.x, b.x)) {
        if (nearlyEqual(a.x, bounds.left)) {
          return { axis: "x", dx: -1, dy: 0, bounds };
        }

        if (nearlyEqual(a.x, bounds.right)) {
          return { axis: "x", dx: 1, dy: 0, bounds };
        }
      }

      if (nearlyEqual(a.z, b.z)) {
        if (nearlyEqual(a.z, bounds.top)) {
          return { axis: "z", dx: 0, dy: -1, bounds };
        }

        if (nearlyEqual(a.z, bounds.bottom)) {
          return { axis: "z", dx: 0, dy: 1, bounds };
        }
      }

      return null;
    }

    function boundarySampleCoordinates(a, b, boundary) {
      const bounds = boundary.bounds;
      const start = boundary.axis === "x" ? Math.min(a.z, b.z) : Math.min(a.x, b.x);
      const end = boundary.axis === "x" ? Math.max(a.z, b.z) : Math.max(a.x, b.x);
      const origin = boundary.axis === "x" ? bounds.top : bounds.left;
      const length = boundary.axis === "x" ? bounds.height : bounds.width;
      const edgeEpsilon = Math.max(0.001, unit * 0.001);
      const samples = [];

      if (end - start <= edgeEpsilon) {
        [start - edgeEpsilon, start + edgeEpsilon, start].forEach((coordinate) => {
          if (coordinate >= origin - edgeEpsilon && coordinate <= origin + length * unit + edgeEpsilon) {
            samples.push(coordinate);
          }
        });
        return samples;
      }

      const firstIndex = Math.max(
        0,
        Math.floor((start - origin + edgeEpsilon) / unit)
      );
      const lastIndex = Math.min(
        length - 1,
        Math.floor((end - origin - edgeEpsilon) / unit)
      );

      for (let index = firstIndex; index <= lastIndex; index += 1) {
        samples.push(origin + (index + 0.5) * unit);
      }

      return samples;
    }

    function neighborLevelStateForBoundary(dx, dy) {
      const levelId = activeRenderContext?.state?.levelId || app.currentLevelId;
      const neighborLevelId = app.adjacentWorldLevelId?.(levelId, dx, dy);

      if (!neighborLevelId) {
        return null;
      }

      if (neighborLevelId === app.currentLevelId) {
        return runtimeLevelState();
      }

      const levelState = app.cachedHorizontalNeighborLevelState?.(neighborLevelId);

      if (!levelState) {
        app.queueHorizontalNeighborLevelState?.(neighborLevelId);
      }

      return levelState || null;
    }

    function terrainDescriptorForState(state, x, y, now) {
      if (!state || x < 0 || y < 0 || x >= state.width || y >= state.height) {
        return null;
      }

      const previousContext = activeRenderContext;
      let descriptor = null;

      activeRenderContext = {
        state,
        offsetX: 0,
        offsetZ: 0,
        raisedPlayerGates: transitionSet(state.raisedPlayerGates),
        raisedOrangeWalls: transitionSet(state.raisedOrangeWalls)
      };

      try {
        descriptor = terrainDescriptorAt(x, y, now);
      } finally {
        activeRenderContext = previousContext;
      }

      return descriptor;
    }

    function terrainPieceDescriptorsForState(state, x, y, now) {
      if (!state || x < 0 || y < 0 || x >= state.width || y >= state.height) {
        return [];
      }

      const previousContext = activeRenderContext;
      let descriptors = [];

      activeRenderContext = {
        state,
        offsetX: 0,
        offsetZ: 0,
        raisedPlayerGates: transitionSet(state.raisedPlayerGates),
        raisedOrangeWalls: transitionSet(state.raisedOrangeWalls)
      };

      try {
        descriptors = terrainPieceDescriptorsAt(x, y, now);
      } finally {
        activeRenderContext = previousContext;
      }

      return descriptors;
    }

    function terrainPieceDescriptorsAtGridOrNeighbor(x, y, now) {
      const state = renderState();

      if (x >= 0 && y >= 0 && x < state.width && y < state.height) {
        return terrainPieceDescriptorsAt(x, y, now);
      }

      let dx = 0;
      let dy = 0;

      if (x < 0) {
        dx = -1;
      } else if (x >= state.width) {
        dx = 1;
      }

      if (y < 0) {
        dy = -1;
      } else if (y >= state.height) {
        dy = 1;
      }

      if (Math.abs(dx) + Math.abs(dy) !== 1) {
        return [];
      }

      const neighborState = neighborLevelStateForBoundary(dx, dy);

      if (!neighborState) {
        return [];
      }

      const neighborX = dx < 0 ? neighborState.width - 1 : dx > 0 ? 0 : x;
      const neighborY = dy < 0 ? neighborState.height - 1 : dy > 0 ? 0 : y;

      return terrainPieceDescriptorsForState(neighborState, neighborX, neighborY, now);
    }

    function descriptorCoversBoundaryYSpan(descriptor, minY, maxY) {
      const tolerance = Math.max(0.001, unit * 0.0001);

      return (
        descriptor.bottomY <= minY + tolerance &&
        descriptor.topY >= maxY - tolerance
      );
    }

    function descriptorsShareHorizontalBoundaryY(leftDescriptor, rightDescriptor, y) {
      const tolerance = Math.max(0.001, unit * 0.0001);
      const shareTop =
        nearlyEqual(leftDescriptor.topY, y) &&
        nearlyEqual(rightDescriptor.topY, y) &&
        leftDescriptor.bottomY < y - tolerance &&
        rightDescriptor.bottomY < y - tolerance;
      const shareBottom =
        nearlyEqual(leftDescriptor.bottomY, y) &&
        nearlyEqual(rightDescriptor.bottomY, y) &&
        leftDescriptor.topY > y + tolerance &&
        rightDescriptor.topY > y + tolerance;

      return shareTop || shareBottom;
    }

    function suppressibleSharedBoundaryType(type) {
      return type === "wall" || type === "block_asset" || type === "ice_block";
    }

    function sameRoomBoundaryDescriptor(leftDescriptor, rightDescriptor, a = null, b = null) {
      if (
        !suppressibleSharedBoundaryType(leftDescriptor?.type) ||
        leftDescriptor?.type !== rightDescriptor?.type
      ) {
        return false;
      }

      if (!a || !b) {
        return (
          nearlyEqual(leftDescriptor.bottomY, rightDescriptor.bottomY) &&
          nearlyEqual(leftDescriptor.topY, rightDescriptor.topY)
        );
      }

      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);

      if (maxY - minY <= Math.max(0.001, unit * 0.0001)) {
        return descriptorsShareHorizontalBoundaryY(leftDescriptor, rightDescriptor, minY);
      }

      return (
        descriptorCoversBoundaryYSpan(leftDescriptor, minY, maxY) &&
        descriptorCoversBoundaryYSpan(rightDescriptor, minY, maxY)
      );
    }

    function sharedRoomBoundaryAtSample(coordinate, boundary, options, a, b) {
      const bounds = boundary.bounds;
      const state = renderState();
      const neighborState = neighborLevelStateForBoundary(boundary.dx, boundary.dy);

      if (!neighborState) {
        return false;
      }

      let x = 0;
      let y = 0;
      let neighborX = 0;
      let neighborY = 0;

      if (boundary.axis === "x") {
        y = Math.floor((coordinate - bounds.top) / unit);
        x = boundary.dx < 0 ? 0 : state.width - 1;
        neighborX = boundary.dx < 0 ? neighborState.width - 1 : 0;
        neighborY = y;
      } else {
        x = Math.floor((coordinate - bounds.left) / unit);
        y = boundary.dy < 0 ? 0 : state.height - 1;
        neighborX = x;
        neighborY = boundary.dy < 0 ? neighborState.height - 1 : 0;
      }

      if (
        x < 0 ||
        y < 0 ||
        x >= state.width ||
        y >= state.height ||
        neighborX < 0 ||
        neighborY < 0 ||
        neighborX >= neighborState.width ||
        neighborY >= neighborState.height
      ) {
        return false;
      }

      const localDescriptors = terrainPieceDescriptorsAt(x, y, options.now);
      const neighborDescriptors = terrainPieceDescriptorsForState(
        neighborState,
        neighborX,
        neighborY,
        options.now
      );

      return localDescriptors.some((localDescriptor) =>
        neighborDescriptors.some((neighborDescriptor) =>
          sameRoomBoundaryDescriptor(localDescriptor, neighborDescriptor, a, b)
        )
      );
    }

    function sharedRoomBoundaryEdgeSegment(a, b, options) {
      if (
        !options?.suppressSharedRoomEdges ||
        !suppressibleSharedBoundaryType(options.descriptor?.type)
      ) {
        return false;
      }

      const boundary = roomBoundaryForEdgeSegment(a, b);

      if (!boundary) {
        return false;
      }

      const samples = boundarySampleCoordinates(a, b, boundary);

      if (samples.length === 0) {
        return false;
      }

      if (nearlyEqual(a.x, b.x) && nearlyEqual(a.z, b.z)) {
        return samples.some((coordinate) =>
          sharedRoomBoundaryAtSample(coordinate, boundary, options, a, b)
        );
      }

      return samples.every((coordinate) =>
        sharedRoomBoundaryAtSample(coordinate, boundary, options, a, b)
      );
    }

    function componentEdgeGeometryFor(geometry, cells, height, threshold, options = {}) {
      const cacheable = geometryCacheHas(geometry) && !options.suppressSharedRoomEdges;
      const key = `component-edges:${geometry.uuid}:${threshold}`;

      if (cacheable && edgeGeometryCache.has(key)) {
        return edgeGeometryCache.get(key);
      }

      // The boundary loops fully determine the outline the old
      // EdgesGeometry + keepComponentEdgeSegment pipeline kept: the top and
      // bottom loop segments, plus a vertical edge at each loop corner
      // (collinear joints between cells produce coplanar side quads, which
      // EdgesGeometry dropped via the angle threshold). Emitting them
      // directly skips the O(triangles) edge scan and the per-segment loop
      // filtering — the bulk of full-world edge meshing.
      const loops = orderedBoundaryLoops(cells);
      const positions = [];

      const pushSegment = (a, b) => {
        if (options?.suppressSharedRoomEdges) {
          const offsetA = {
            ...a,
            x: a.x + (options.offsetX || 0),
            z: a.z + (options.offsetZ || 0)
          };
          const offsetB = {
            ...b,
            x: b.x + (options.offsetX || 0),
            z: b.z + (options.offsetZ || 0)
          };

          if (sharedRoomBoundaryEdgeSegment(offsetA, offsetB, options)) {
            return;
          }
        } else if (sharedRoomBoundaryEdgeSegment(a, b, options)) {
          return;
        }

        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      };

      loops.forEach((loop) => {
        // Loops are closed (last point repeats the first).
        for (let index = 0; index < loop.length - 1; index += 1) {
          const from = loop[index];
          const to = loop[index + 1];

          pushSegment({ x: from.x, y: 0, z: from.z }, { x: to.x, y: 0, z: to.z });
          pushSegment(
            { x: from.x, y: -height, z: from.z },
            { x: to.x, y: -height, z: to.z }
          );

          // Vertical edge only where the boundary turns a corner at `to`.
          const next = index + 2 < loop.length ? loop[index + 2] : loop[1];
          const incomingHorizontal = nearlyEqual(from.z, to.z);
          const outgoingHorizontal = nearlyEqual(to.z, next.z);

          if (incomingHorizontal !== outgoingHorizontal) {
            pushSegment({ x: to.x, y: 0, z: to.z }, { x: to.x, y: -height, z: to.z });
          }
        }
      });

      const filteredEdges = new THREE.BufferGeometry();
      filteredEdges.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

      if (cacheable) {
        cacheEdgeGeometry(key, filteredEdges);
      }

      return filteredEdges;
    }

    function addOutlinedMesh(geometry, color, position, options = {}) {
      const opacity = options.opacity ?? 1;
      const meshMaterial = material(color, opacity, {
        doubleSide: options.doubleSide,
        depthWrite: options.depthWrite,
        polygonOffset: options.polygonOffset,
        polygonOffsetFactor: options.polygonOffsetFactor,
        polygonOffsetUnits: options.polygonOffsetUnits
      });

      const mesh = new THREE.Mesh(geometry, meshMaterial);
      mesh.position.set(position.x, position.y, position.z);
      mesh.renderOrder = options.renderOrder ?? 0;
      mesh.castShadow = options.castShadow !== false;
      mesh.receiveShadow = options.receiveShadow !== false;
      if (options.editorPick) {
        mesh.userData.editorPick = editorPickForRenderContext(options.editorPick);
      }
      scene.add(mesh);

      if (options.outline === false || !edgeOutlinesEnabled()) {
        return mesh;
      }

      const edgeThreshold = options.edgeThreshold ?? 24;
      addEdgeLines(
        geometry,
        mesh.position,
        edgeThreshold,
        options.edgeOpacity ?? opacity,
        options.edgeGeometry
      );
      return mesh;
    }

    function addEdgeLines(geometry, position, threshold = 24, opacity = 1, edgeGeometry = null, scale = null) {
      if (!edgeOutlinesEnabled()) {
        return null;
      }

      const lineOpacity = opacity * renderContextOpacity();

      if (lineOpacity <= 0.015) {
        return null;
      }

      const edges = new THREE.LineSegments(edgeGeometry || edgeGeometryFor(geometry, threshold), lineMaterial("#000000", lineOpacity));
      edges.position.copy(position);

      if (scale) {
        edges.scale.copy(scale);
      }

      edges.userData.edgeBasePosition = position.clone();
      edgeScene.add(edges);
      return edges;
    }

    function mergeGeometryBatch(children) {
      if (!children.length) {
        return null;
      }

      // Batch keys guarantee identical attribute sets (attributeBatchSignature),
      // so sizes can be summed up front and every attribute written straight
      // into one preallocated array — no clone()/toNonIndexed()/applyMatrix4()
      // intermediates. Indexed children are expanded through their index.
      const first = children[0].geometry;
      const attributeNames = Object.keys(first.attributes);
      const merged = new Map();
      let vertexCount = 0;

      children.forEach((child) => {
        const geometry = child.geometry;
        vertexCount += geometry.index ? geometry.index.count : geometry.attributes.position.count;
      });

      attributeNames.forEach((name) => {
        const attribute = first.getAttribute(name);

        merged.set(name, {
          array: new attribute.array.constructor(vertexCount * attribute.itemSize),
          itemSize: attribute.itemSize,
          normalized: attribute.normalized
        });
      });

      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      let vertexOffset = 0;

      children.forEach((child) => {
        const geometry = child.geometry;
        const index = geometry.index ? geometry.index.array : null;
        const count = index ? index.length : geometry.attributes.position.count;
        const e = child.matrixWorld.elements;
        const translationOnly =
          e[0] === 1 && e[5] === 1 && e[10] === 1 && e[15] === 1 &&
          e[1] === 0 && e[2] === 0 && e[3] === 0 &&
          e[4] === 0 && e[6] === 0 && e[7] === 0 &&
          e[8] === 0 && e[9] === 0 && e[11] === 0;
        const rotates = !translationOnly;
        // Inverse-transpose for normals so rotated/scaled children (model
        // props) light correctly; identity for the translation-only fast
        // path that covers all room-block geometry.
        const n = rotates
          ? new THREE.Matrix3().getNormalMatrix(child.matrixWorld).elements
          : null;

        attributeNames.forEach((name) => {
          const source = geometry.getAttribute(name);
          const sourceArray = source.array;
          const itemSize = source.itemSize;
          const target = merged.get(name).array;
          const targetBase = vertexOffset * itemSize;
          const isPosition = name === "position";
          const isNormal = name === "normal";

          for (let i = 0; i < count; i += 1) {
            const si = (index ? index[i] : i) * itemSize;
            const ti = targetBase + i * itemSize;

            if (isPosition && itemSize === 3) {
              const x = sourceArray[si];
              const y = sourceArray[si + 1];
              const z = sourceArray[si + 2];
              let wx;
              let wy;
              let wz;

              if (rotates) {
                wx = e[0] * x + e[4] * y + e[8] * z + e[12];
                wy = e[1] * x + e[5] * y + e[9] * z + e[13];
                wz = e[2] * x + e[6] * y + e[10] * z + e[14];
              } else {
                wx = x + e[12];
                wy = y + e[13];
                wz = z + e[14];
              }

              target[ti] = wx;
              target[ti + 1] = wy;
              target[ti + 2] = wz;

              if (wx < minX) minX = wx;
              if (wy < minY) minY = wy;
              if (wz < minZ) minZ = wz;
              if (wx > maxX) maxX = wx;
              if (wy > maxY) maxY = wy;
              if (wz > maxZ) maxZ = wz;
            } else if (isNormal && itemSize === 3 && rotates) {
              const x = sourceArray[si];
              const y = sourceArray[si + 1];
              const z = sourceArray[si + 2];
              let nx = n[0] * x + n[3] * y + n[6] * z;
              let ny = n[1] * x + n[4] * y + n[7] * z;
              let nz = n[2] * x + n[5] * y + n[8] * z;
              const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

              target[ti] = nx / length;
              target[ti + 1] = ny / length;
              target[ti + 2] = nz / length;
            } else {
              for (let c = 0; c < itemSize; c += 1) {
                target[ti + c] = sourceArray[si + c];
              }
            }
          }
        });

        vertexOffset += count;
      });

      const geometry = new THREE.BufferGeometry();

      merged.forEach((entry, name) => {
        geometry.setAttribute(
          name,
          new THREE.BufferAttribute(entry.array, entry.itemSize, entry.normalized)
        );
      });

      // Box-derived sphere: slightly conservative (safer culling), skips
      // computeBoundingSphere's extra full pass over the merged positions.
      if (vertexCount > 0 && Number.isFinite(minX)) {
        const center = new THREE.Vector3(
          (minX + maxX) / 2,
          (minY + maxY) / 2,
          (minZ + maxZ) / 2
        );
        const radius =
          Math.sqrt(
            (maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2
          ) / 2;

        geometry.boundingSphere = new THREE.Sphere(center, radius);
      } else {
        geometry.computeBoundingSphere();
      }

      return geometry;
    }

    function attributeBatchSignature(geometry) {
      return Object.keys(geometry.attributes)
        .sort()
        .map((name) => {
          const attribute = geometry.attributes[name];
          return [
            name,
            attribute.itemSize,
            attribute.normalized ? 1 : 0,
            attribute.array?.constructor?.name || "Array"
          ].join(":");
        })
        .join("|");
    }

    function mergeImmediateSceneObjects(container, kind) {
      const batches = new Map();
      let sourceCount = 0;
      let mergedCount = 0;

      const children = [];

      container.traverse((child) => {
        if (child === container) {
          return;
        }

        children.push(child);
      });

      children.forEach((child) => {
        const isBatchable =
          kind === "mesh"
            ? child.isMesh
            : child.isLineSegments;

        if (
          !isBatchable ||
          !child.parent ||
          !child.geometry?.attributes?.position ||
          !child.material ||
          Array.isArray(child.material) ||
          child.children.length > 0 ||
          child.userData?.dynamicActorObject === true ||
          child.parent?.userData?.dynamicActorObject === true
        ) {
          return;
        }

        const key = [
          kind,
          child.material.uuid,
          child.castShadow ? 1 : 0,
          child.receiveShadow ? 1 : 0,
          child.renderOrder || 0,
          attributeBatchSignature(child.geometry)
        ].join(":");

        if (!batches.has(key)) {
          batches.set(key, []);
        }

        batches.get(key).push(child);
      });

      batches.forEach((children) => {
        if (children.length <= 1) {
          return;
        }

        const geometry = mergeGeometryBatch(children);

        if (!geometry) {
          return;
        }

        const first = children[0];
        const merged =
          kind === "mesh"
            ? new THREE.Mesh(geometry, first.material)
            : new THREE.LineSegments(geometry, first.material);

        merged.castShadow = first.castShadow;
        merged.receiveShadow = first.receiveShadow;
        merged.renderOrder = first.renderOrder;
        if (kind === "line") {
          merged.userData.edgeBasePosition = new THREE.Vector3(0, 0, 0);
        }
        children.forEach((child) => {
          child.parent?.remove(child);

          if (child.geometry && !cachedGeometryHas(child.geometry)) {
            child.geometry.dispose();
          }
        });
        container.add(merged);
        sourceCount += children.length;
        mergedCount += 1;
      });

      return {
        sourceCount,
        mergedCount
      };
    }

    function biasEdgeSceneTowardCamera() {
      // Depth clearance now happens per-vertex in lineMaterial()'s shader
      // (an eye-ray pull with zero screen drift); just keep edge objects
      // pinned to their base positions.
      edgeScene.children.forEach((child) => {
        const basePosition = child.userData.edgeBasePosition;

        if (basePosition) {
          child.position.copy(basePosition);
        }
      });
    }

    function outlinePixelRadius() {
      // Half-thickness the outline should have in WORLD units (matches the
      // old 1.68px look at the default single-room camera distance).
      const worldRadius = unit * 0.035 * 0.75;
      let pixelsPerUnit = 0;

      if (camera?.isOrthographicCamera) {
        pixelsPerUnit = camera.zoom;
      } else if (camera?.isPerspectiveCamera && lastCameraFitDistance > 0) {
        const fovRadians = (camera.fov * Math.PI) / 180;
        pixelsPerUnit =
          threeCanvas.height /
          (2 * lastCameraFitDistance * Math.tan(fovRadians / 2));
      }

      if (!(pixelsPerUnit > 0)) {
        return Math.max(1.5, worldRadius);
      }

      // Attenuate with distance like perspective geometry; clamp so extreme
      // zoom-in doesn't explode the 2D stamp count (offsets grow ~radius^2).
      return Math.max(0, Math.min(6, worldRadius * pixelsPerUnit));
    }

    function outlinePixelOffsets(radius) {
      const key = Math.round(radius * 1000);

      if (outlineOffsetCache.has(key)) {
        return outlineOffsetCache.get(key);
      }

      if (radius < 0.5) {
        const offsets = [{ x: 0, y: 0 }];

        outlineOffsetCache.set(key, offsets);
        return offsets;
      }

      if (radius <= 2) {
        const offsets = [
          { x: 0, y: 0 },
          { x: -1, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: -1 },
          { x: 0, y: 1 }
        ];

        outlineOffsetCache.set(key, offsets);
        return offsets;
      }

      const scanRadius = Math.ceil(radius);
      const offsets = [];

      for (let y = -scanRadius; y <= scanRadius; y += 1) {
        for (let x = -scanRadius; x <= scanRadius; x += 1) {
          if (x * x + y * y > radius * radius) {
            continue;
          }

          offsets.push({ x, y });
        }
      }

      outlineOffsetCache.set(key, offsets);
      return offsets;
    }

    function drawToonOutlineOverlay(targetContext) {
      const width = threeCanvas.width;
      const height = threeCanvas.height;
      const radius = outlinePixelRadius();

      if (width <= 0 || height <= 0) {
        return;
      }

      targetContext.save();
      targetContext.imageSmoothingEnabled = false;
      outlinePixelOffsets(radius).forEach((offset) => {
        targetContext.drawImage(threeCanvas, offset.x, offset.y);
      });
      targetContext.restore();
    }

    function componentCuboidGeometry(cells, height, options = {}) {
      const cacheKey =
        options.cacheKey === false
          ? null
          : options.cacheKey ||
            `component-shape:${Math.round(height * 100)}:${cells
              .map((cell) =>
                [
                  cell.gridX,
                  cell.gridY,
                  Math.round(cell.left * 100),
                  Math.round(cell.right * 100),
                  Math.round(cell.top * 100),
                  Math.round(cell.bottom * 100)
                ].join(",")
              )
              .join("|")}`;

      if (cacheKey && geometryCache.has(cacheKey)) {
        return geometryCache.get(cacheKey);
      }

      // Direct quad construction instead of THREE.Shape/ExtrudeGeometry:
      // the cells tile the footprint exactly, so the caps need no earcut
      // triangulation (two triangles per cell), and the boundary loops give
      // the side quads directly. This is the hottest geometry builder in
      // full-world room meshing.
      const positions = [];
      const normals = [];

      const pushQuadNormal = (nx, ny, nz) => {
        for (let i = 0; i < 6; i += 1) {
          normals.push(nx, ny, nz);
        }
      };

      cells.forEach((cell) => {
        // Top cap (y = 0), normal +Y — same winding as componentTopPlaneGeometry.
        pushQuadPositions(positions, [
          [cell.left, 0, cell.top],
          [cell.left, 0, cell.bottom],
          [cell.right, 0, cell.bottom],
          [cell.right, 0, cell.top]
        ]);
        pushQuadNormal(0, 1, 0);
        // Bottom cap (y = -height), normal -Y.
        pushQuadPositions(positions, [
          [cell.left, -height, cell.top],
          [cell.right, -height, cell.top],
          [cell.right, -height, cell.bottom],
          [cell.left, -height, cell.bottom]
        ]);
        pushQuadNormal(0, -1, 0);
      });

      // One outward-facing quad per boundary segment (outer loops are wound
      // clockwise in XZ by orderedBoundaryLoops, holes counter-clockwise, so
      // the same vertex order faces away from the solid for both). Outward
      // normal for a segment heading (dx, dz) is (dz, 0, -dx) — matches the
      // quad winding's cross product: north edges (+X heading) face -Z.
      orderedBoundaryLoops(cells).forEach((loop) => {
        for (let index = 0; index < loop.length - 1; index += 1) {
          const from = loop[index];
          const to = loop[index + 1];

          pushQuadPositions(positions, [
            [from.x, 0, from.z],
            [to.x, 0, to.z],
            [to.x, -height, to.z],
            [from.x, -height, from.z]
          ]);

          const dx = Math.sign(to.x - from.x);
          const dz = Math.sign(to.z - from.z);
          pushQuadNormal(dz, 0, -dx);
        }
      });

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));

      if (cacheKey) {
        cacheGeometry(cacheKey, geometry);
      }

      return geometry;
    }

    function polycubeVoxelKey(x, y, z) {
      return `${x},${y},${z}`;
    }

    // Same voxels array flows through polycubeGeometry, polycubeEdgeGeometry
    // and collectPolycubeFaceCells in a single build; derive its signature
    // once. Voxel arrays are built fresh per region and never mutated after.
    const polycubeVoxelSignatureMemo = new WeakMap();

    function polycubeVoxelSignature(voxels) {
      let signature = polycubeVoxelSignatureMemo.get(voxels);

      if (signature === undefined) {
        signature = voxels
          .map((voxel) => polycubeVoxelKey(voxel.x, voxel.y, voxel.z))
          .sort()
          .join("|");
        polycubeVoxelSignatureMemo.set(voxels, signature);
      }

      return signature;
    }

    function polycubeFaceKey(kind, plane) {
      return `${kind}:${plane}`;
    }

    function polycubeComponentNeighborOffsets() {
      if (polycubeComponentNeighborOffsetCache) {
        return polycubeComponentNeighborOffsetCache;
      }

      polycubeComponentNeighborOffsetCache = [
        { x: -1, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: -1, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: -1 },
        { x: 0, y: 0, z: 1 }
      ];
      return polycubeComponentNeighborOffsetCache;
    }

    function polycubeEdgeContactOffsets() {
      if (polycubeEdgeContactOffsetCache) {
        return polycubeEdgeContactOffsetCache;
      }

      polycubeEdgeContactOffsetCache = [];

      return polycubeEdgeContactOffsetCache;
    }

    function collectPolycubeFaceCells(voxels) {
      const cacheKey = polycubeVoxelSignature(voxels);

      if (polycubeFaceCellsCache.has(cacheKey)) {
        return polycubeFaceCellsCache.get(cacheKey);
      }

      const voxelKeys = new Set(voxels.map((voxel) => polycubeVoxelKey(voxel.x, voxel.y, voxel.z)));
      const faceGroups = new Map();
      const addFaceCell = (kind, plane, a, b) => {
        const key = polycubeFaceKey(kind, plane);

        if (!faceGroups.has(key)) {
          faceGroups.set(key, {
            cells: new Set(),
            kind,
            plane
          });
        }

        faceGroups.get(key).cells.add(`${a},${b}`);
      };

      voxels.forEach((voxel) => {
        if (!voxelKeys.has(polycubeVoxelKey(voxel.x + 1, voxel.y, voxel.z))) {
          addFaceCell("xplus", voxel.x + 1, voxel.y, voxel.z);
        }

        if (!voxelKeys.has(polycubeVoxelKey(voxel.x - 1, voxel.y, voxel.z))) {
          addFaceCell("xminus", voxel.x, voxel.y, voxel.z);
        }

        if (!voxelKeys.has(polycubeVoxelKey(voxel.x, voxel.y + 1, voxel.z))) {
          addFaceCell("zplus", voxel.y + 1, voxel.x, voxel.z);
        }

        if (!voxelKeys.has(polycubeVoxelKey(voxel.x, voxel.y - 1, voxel.z))) {
          addFaceCell("zminus", voxel.y, voxel.x, voxel.z);
        }

        if (!voxelKeys.has(polycubeVoxelKey(voxel.x, voxel.y, voxel.z + 1))) {
          addFaceCell("top", voxel.z + 1, voxel.x, voxel.y);
        }

        if (!voxelKeys.has(polycubeVoxelKey(voxel.x, voxel.y, voxel.z - 1))) {
          addFaceCell("bottom", voxel.z, voxel.x, voxel.y);
        }
      });

      polycubeFaceCellsCache.set(cacheKey, faceGroups);
      return faceGroups;
    }

    function polycubePointForFace(kind, plane, a, b) {
      if (kind === "top" || kind === "bottom") {
        return [
          a * unit + renderOffsetX(),
          plane * elevationUnit + actorVisualLift,
          b * unit + renderOffsetZ()
        ];
      }

      if (kind === "xplus" || kind === "xminus") {
        return [
          plane * unit + renderOffsetX(),
          b * elevationUnit + actorVisualLift,
          a * unit + renderOffsetZ()
        ];
      }

      return [
        a * unit + renderOffsetX(),
        b * elevationUnit + actorVisualLift,
        plane * unit + renderOffsetZ()
      ];
    }

    function groupLabelPlaneGeometry(kind) {
      const key = `group-label-plane:${kind}`;

      if (!geometryCache.has(key)) {
        const geometry = new THREE.PlaneGeometry(unit * 0.68, unit * 0.68);

        if (kind === "top") {
          geometry.rotateX(-Math.PI / 2);
        } else if (kind === "bottom") {
          geometry.rotateX(Math.PI / 2);
        } else if (kind === "xplus") {
          geometry.rotateY(Math.PI / 2);
        } else if (kind === "xminus") {
          geometry.rotateY(-Math.PI / 2);
        } else if (kind === "zminus") {
          geometry.rotateY(Math.PI);
        }

        cacheGeometry(key, geometry);
      }

      return geometryCache.get(key);
    }

    function groupLabelPositionForFace(kind, plane, a, b, renderOffset) {
      const normalOffset = Math.max(0.9, unit * 0.014);

      if (kind === "top" || kind === "bottom") {
        return {
          x: (a + 0.5) * unit + renderOffsetX() + renderOffset.x,
          y:
            plane * elevationUnit +
            actorVisualLift +
            renderOffset.y +
            (kind === "top" ? normalOffset : -normalOffset),
          z: (b + 0.5) * unit + renderOffsetZ() + renderOffset.z
        };
      }

      if (kind === "xplus" || kind === "xminus") {
        return {
          x:
            plane * unit +
            renderOffsetX() +
            renderOffset.x +
            (kind === "xplus" ? normalOffset : -normalOffset),
          y: (b + 0.5) * elevationUnit + actorVisualLift + renderOffset.y,
          z: (a + 0.5) * unit + renderOffsetZ() + renderOffset.z
        };
      }

      return {
        x: (a + 0.5) * unit + renderOffsetX() + renderOffset.x,
        y: (b + 0.5) * elevationUnit + actorVisualLift + renderOffset.y,
        z:
          plane * unit +
          renderOffsetZ() +
          renderOffset.z +
          (kind === "zplus" ? normalOffset : -normalOffset)
      };
    }

    function addWeightlessGroupFaceLabels(voxels, groupId, renderOffset, opacity) {
      if (!isEditorRenderMode() && !isPalettePreviewRenderMode()) {
        return;
      }

      const label = weightlessGroupLabel(groupId);
      const labelMaterial = groupLabelMaterial(label, opacity);

      if (!labelMaterial) {
        return;
      }

      collectPolycubeFaceCells(voxels).forEach((faceGroup) => {
        faceGroup.cells.forEach((cellKey) => {
          const [a, b] = cellKey.split(",").map(Number);
          const labelMesh = new THREE.Mesh(
            groupLabelPlaneGeometry(faceGroup.kind),
            labelMaterial
          );
          const position = groupLabelPositionForFace(
            faceGroup.kind,
            faceGroup.plane,
            a,
            b,
            renderOffset
          );

          labelMesh.position.set(position.x, position.y, position.z);
          labelMesh.castShadow = false;
          labelMesh.receiveShadow = false;
          scene.add(labelMesh);
        });
      });
    }

    function pushQuadPositions(positions, vertices) {
      const [a, b, c, d] = vertices;

      positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    }

    function addPolycubeFaceQuad(positions, kind, plane, a, b) {
      if (kind === "top") {
        pushQuadPositions(positions, [
          polycubePointForFace(kind, plane, a, b),
          polycubePointForFace(kind, plane, a, b + 1),
          polycubePointForFace(kind, plane, a + 1, b + 1),
          polycubePointForFace(kind, plane, a + 1, b)
        ]);
        return;
      }

      if (kind === "bottom") {
        pushQuadPositions(positions, [
          polycubePointForFace(kind, plane, a, b),
          polycubePointForFace(kind, plane, a + 1, b),
          polycubePointForFace(kind, plane, a + 1, b + 1),
          polycubePointForFace(kind, plane, a, b + 1)
        ]);
        return;
      }

      if (kind === "xplus") {
        pushQuadPositions(positions, [
          polycubePointForFace(kind, plane, a, b),
          polycubePointForFace(kind, plane, a, b + 1),
          polycubePointForFace(kind, plane, a + 1, b + 1),
          polycubePointForFace(kind, plane, a + 1, b)
        ]);
        return;
      }

      if (kind === "xminus") {
        pushQuadPositions(positions, [
          polycubePointForFace(kind, plane, a, b),
          polycubePointForFace(kind, plane, a + 1, b),
          polycubePointForFace(kind, plane, a + 1, b + 1),
          polycubePointForFace(kind, plane, a, b + 1)
        ]);
        return;
      }

      if (kind === "zplus") {
        pushQuadPositions(positions, [
          polycubePointForFace(kind, plane, a, b),
          polycubePointForFace(kind, plane, a + 1, b),
          polycubePointForFace(kind, plane, a + 1, b + 1),
          polycubePointForFace(kind, plane, a, b + 1)
        ]);
        return;
      }

      pushQuadPositions(positions, [
        polycubePointForFace(kind, plane, a, b),
        polycubePointForFace(kind, plane, a, b + 1),
        polycubePointForFace(kind, plane, a + 1, b + 1),
        polycubePointForFace(kind, plane, a + 1, b)
      ]);
    }

    function polycubeGeometry(voxels) {
      const cacheKey = [
        "polycube-geometry",
        Math.round(renderOffsetX() * 100),
        Math.round(renderOffsetZ() * 100),
        polycubeVoxelSignature(voxels)
      ].join(":");

      if (geometryCache.has(cacheKey)) {
        return geometryCache.get(cacheKey);
      }

      const positions = [];
      const normals = [];
      const faceNormals = {
        top: [0, 1, 0],
        bottom: [0, -1, 0],
        xplus: [1, 0, 0],
        xminus: [-1, 0, 0],
        zplus: [0, 0, 1],
        zminus: [0, 0, -1]
      };

      collectPolycubeFaceCells(voxels).forEach((faceGroup) => {
        const [nx, ny, nz] = faceNormals[faceGroup.kind] || [0, 1, 0];

        faceGroup.cells.forEach((cellKey) => {
          const [a, b] = cellKey.split(",").map(Number);
          addPolycubeFaceQuad(positions, faceGroup.kind, faceGroup.plane, a, b);

          for (let i = 0; i < 6; i += 1) {
            normals.push(nx, ny, nz);
          }
        });
      });

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
      cacheGeometry(cacheKey, geometry);
      return geometry;
    }

    function polycubeEdgeSegmentKey(from, to) {
      // Order-insensitive without array/map/sort allocations — this runs for
      // every candidate edge segment in every polycube build.
      const ax = Math.round(from[0] * 1000);
      const ay = Math.round(from[1] * 1000);
      const az = Math.round(from[2] * 1000);
      const bx = Math.round(to[0] * 1000);
      const by = Math.round(to[1] * 1000);
      const bz = Math.round(to[2] * 1000);

      if (ax < bx || (ax === bx && (ay < by || (ay === by && az <= bz)))) {
        return ax + "," + ay + "," + az + ":" + bx + "," + by + "," + bz;
      }

      return bx + "," + by + "," + bz + ":" + ax + "," + ay + "," + az;
    }

    function addPolycubeEdgeSegment(positions, seenSegments, from, to, key = null) {
      const segmentKey = key || polycubeEdgeSegmentKey(from, to);

      if (seenSegments.has(segmentKey)) {
        return;
      }

      seenSegments.add(segmentKey);
      positions.push(from[0], from[1], from[2], to[0], to[1], to[2]);
    }

    function addPolycubeSuppressedEdge(suppressedEdges, from, to) {
      suppressedEdges.add(polycubeEdgeSegmentKey(from, to));
    }

    function addPolycubeEdgeContact(suppressedEdges, voxel, offset) {
      const worldX = (x) => x * unit + renderOffsetX();
      const worldY = (z) => z * elevationUnit + actorVisualLift;
      const worldZ = (y) => y * unit + renderOffsetZ();
      const fixedX = offset.x === 0 ? null : worldX(voxel.x + (offset.x > 0 ? 1 : 0));
      const fixedY = offset.z === 0 ? null : worldY(voxel.z + (offset.z > 0 ? 1 : 0));
      const fixedZ = offset.y === 0 ? null : worldZ(voxel.y + (offset.y > 0 ? 1 : 0));

      if (offset.x === 0) {
        addPolycubeSuppressedEdge(
          suppressedEdges,
          [worldX(voxel.x), fixedY, fixedZ],
          [worldX(voxel.x + 1), fixedY, fixedZ]
        );
        return;
      }

      if (offset.y === 0) {
        addPolycubeSuppressedEdge(
          suppressedEdges,
          [fixedX, fixedY, worldZ(voxel.y)],
          [fixedX, fixedY, worldZ(voxel.y + 1)]
        );
        return;
      }

      addPolycubeSuppressedEdge(
        suppressedEdges,
        [fixedX, worldY(voxel.z), fixedZ],
        [fixedX, worldY(voxel.z + 1), fixedZ]
      );
    }

    function addPolycubeFaceContactEdges(suppressedEdges, voxel, kind) {
      let plane = voxel.z + 1;
      let a = voxel.x;
      let b = voxel.y;

      if (kind === "bottom") {
        plane = voxel.z;
      } else if (kind === "xplus" || kind === "xminus") {
        plane = kind === "xplus" ? voxel.x + 1 : voxel.x;
        a = voxel.y;
        b = voxel.z;
      } else if (kind === "zplus" || kind === "zminus") {
        plane = kind === "zplus" ? voxel.y + 1 : voxel.y;
        a = voxel.x;
        b = voxel.z;
      }

      const corners = [
        polycubePointForFace(kind, plane, a, b),
        polycubePointForFace(kind, plane, a, b + 1),
        polycubePointForFace(kind, plane, a + 1, b + 1),
        polycubePointForFace(kind, plane, a + 1, b)
      ];

      addPolycubeSuppressedEdge(suppressedEdges, corners[0], corners[1]);
      addPolycubeSuppressedEdge(suppressedEdges, corners[1], corners[2]);
      addPolycubeSuppressedEdge(suppressedEdges, corners[2], corners[3]);
      addPolycubeSuppressedEdge(suppressedEdges, corners[3], corners[0]);
    }

    function iceSlopeDescriptorContactsVoxel(slopeX, slopeY, direction, voxelLevel, now) {
      return terrainPieceDescriptorsAtGridOrNeighbor(slopeX, slopeY, now).some((descriptor) => {
        if (
          descriptor.type !== "ice_slope" ||
          normalizeCardinalDirection(descriptor.layer?.direction) !== direction
        ) {
          return false;
        }

        return (
          terrainPolycubeLevel(descriptor.bottomY) === voxelLevel &&
          terrainPolycubeLevel(descriptor.topY) === voxelLevel + 1
        );
      });
    }

    function iceSlopeHighSideContactsForVoxel(voxel, now) {
      const contacts = [];
      const candidates = [
        { dx: -1, dy: 0, direction: "right", face: "xminus" },
        { dx: 1, dy: 0, direction: "left", face: "xplus" },
        { dx: 0, dy: -1, direction: "down", face: "zminus" },
        { dx: 0, dy: 1, direction: "up", face: "zplus" }
      ];

      candidates.forEach((candidate) => {
        if (
          iceSlopeDescriptorContactsVoxel(
            voxel.x + candidate.dx,
            voxel.y + candidate.dy,
            candidate.direction,
            voxel.z,
            now
          )
        ) {
          contacts.push(candidate.face);
        }
      });

      return contacts;
    }

    function iceSlopeBottomContactsForVoxel(voxel, now) {
      if (!renderIsInsideBoard(voxel.x, voxel.y)) {
        return false;
      }

      return terrainPieceDescriptorsAt(voxel.x, voxel.y, now).some((descriptor) => (
        descriptor.type === "ice_slope" &&
        terrainPolycubeLevel(descriptor.bottomY ?? 0) === voxel.z + 1
      ));
    }

    function iceSlopeContactSignatureForVoxels(voxels, now, options = {}) {
      const includeSideContacts = options.includeSideContacts !== false;
      const includeTopContacts = options.includeTopContacts === true;

      return voxels
        .flatMap((voxel) => {
          const contacts = includeSideContacts
            ? iceSlopeHighSideContactsForVoxel(voxel, now)
            : [];

          if (includeTopContacts && iceSlopeBottomContactsForVoxel(voxel, now)) {
            contacts.push("top");
          }

          return contacts.map((face) => `${voxel.x},${voxel.y},${voxel.z}:${face}`);
        })
        .sort()
        .join("|");
    }

    function iceSlopeCoveredTopFaceCellsForVoxels(voxels, now) {
      return new Set(
        voxels
          .filter((voxel) => iceSlopeBottomContactsForVoxel(voxel, now))
          .map((voxel) => `${voxel.z + 1}:${voxel.x},${voxel.y}`)
      );
    }

    function addIceSlopeContactSuppressedEdges(suppressedEdges, voxels, now, options = {}) {
      const includeSideContacts = options.includeSideContacts !== false;

      voxels.forEach((voxel) => {
        if (includeSideContacts) {
          iceSlopeHighSideContactsForVoxel(voxel, now).forEach((face) => {
            addPolycubeFaceContactEdges(suppressedEdges, voxel, face);
          });
        }
      });
    }

    function polycubeContactEdgeKeys(voxels) {
      const voxelKeys = new Set(voxels.map((voxel) => polycubeVoxelKey(voxel.x, voxel.y, voxel.z)));
      const suppressedEdges = new Set();
      const contactOffsets = polycubeEdgeContactOffsets();

      voxels.forEach((voxel) => {
        contactOffsets.forEach((offset) => {
          if (
            !voxelKeys.has(
              polycubeVoxelKey(voxel.x + offset.x, voxel.y + offset.y, voxel.z + offset.z)
            )
          ) {
            return;
          }

          const horizontalBridgeKey = polycubeVoxelKey(
            voxel.x + offset.x,
            voxel.y + offset.y,
            voxel.z
          );
          const verticalBridgeKey = polycubeVoxelKey(voxel.x, voxel.y, voxel.z + offset.z);

          if (voxelKeys.has(horizontalBridgeKey) || voxelKeys.has(verticalBridgeKey)) {
            return;
          }

          addPolycubeEdgeContact(suppressedEdges, voxel, offset);
        });
      });

      return suppressedEdges;
    }

    function polycubeComponents(voxels) {
      const voxelMap = new Map();
      const visited = new Set();
      const components = [];
      const neighborOffsets = polycubeComponentNeighborOffsets();

      voxels.forEach((voxel) => {
        const key = polycubeVoxelKey(voxel.x, voxel.y, voxel.z);

        if (!voxelMap.has(key)) {
          voxelMap.set(key, voxel);
        }
      });

      voxelMap.forEach((startVoxel, startKey) => {
        if (visited.has(startKey)) {
          return;
        }

        const stack = [startVoxel];
        const component = [];
        visited.add(startKey);

        while (stack.length > 0) {
          const voxel = stack.pop();

          component.push(voxel);

          neighborOffsets.forEach((offset) => {
            const key = polycubeVoxelKey(
              voxel.x + offset.x,
              voxel.y + offset.y,
              voxel.z + offset.z
            );

            if (!voxelMap.has(key) || visited.has(key)) {
              return;
            }

            visited.add(key);
            stack.push(voxelMap.get(key));
          });
        }

        components.push(component);
      });

      return components;
    }

    function addPolycubeFaceBoundaryEdges(
      positions,
      seenSegments,
      faceGroup,
      suppressedEdges,
      options = {}
    ) {
      const hasIceCover = Boolean(options?.iceSlopeCoveredTopFaceCells);
      const visibleCells =
        faceGroup.kind === "top" && hasIceCover
          ? new Set(
              Array.from(faceGroup.cells).filter(
                (cellKey) => !options.iceSlopeCoveredTopFaceCells.has(`${faceGroup.plane}:${cellKey}`)
              )
            )
          : faceGroup.cells;

      // Packed-integer mirror of visibleCells so the 4-neighbor tests in the
      // hot loop are integer Set lookups instead of template-string builds.
      // Cells parse once here instead of per string key.
      const packCell = (a, b) => (a + 512) * 4096 + (b + 512);
      const visiblePacked = new Set();
      const parsedCells = [];

      visibleCells.forEach((cellKey) => {
        const comma = cellKey.indexOf(",");
        const a = Number(cellKey.slice(0, comma));
        const b = Number(cellKey.slice(comma + 1));

        visiblePacked.add(packCell(a, b));
        parsedCells.push(a, b);
      });

      const isSideFace =
        faceGroup.kind === "xplus" ||
        faceGroup.kind === "xminus" ||
        faceGroup.kind === "zplus" ||
        faceGroup.kind === "zminus";

      for (let cellIndex = 0; cellIndex < parsedCells.length; cellIndex += 2) {
        const a = parsedCells[cellIndex];
        const b = parsedCells[cellIndex + 1];
        let sideFaceCoveredTopCellKey = null;

        if (hasIceCover && isSideFace) {
          if (faceGroup.kind === "xplus" || faceGroup.kind === "xminus") {
            const x = faceGroup.kind === "xplus" ? faceGroup.plane - 1 : faceGroup.plane;
            sideFaceCoveredTopCellKey = `${b + 1}:${x},${a}`;
          } else {
            const y = faceGroup.kind === "zplus" ? faceGroup.plane - 1 : faceGroup.plane;
            sideFaceCoveredTopCellKey = `${b + 1}:${a},${y}`;
          }
        }

        // Neighbor deltas: [da, db, fromA, fromB, toA, toB]
        for (let n = 0; n < 4; n += 1) {
          let neighborPacked;
          let fromA;
          let fromB;
          let toA;
          let toB;

          if (n === 0) {
            neighborPacked = packCell(a - 1, b);
            fromA = a; fromB = b; toA = a; toB = b + 1;
          } else if (n === 1) {
            neighborPacked = packCell(a + 1, b);
            fromA = a + 1; fromB = b; toA = a + 1; toB = b + 1;
          } else if (n === 2) {
            neighborPacked = packCell(a, b - 1);
            fromA = a; fromB = b; toA = a + 1; toB = b;
          } else {
            neighborPacked = packCell(a, b + 1);
            fromA = a; fromB = b + 1; toA = a + 1; toB = b + 1;
          }

          if (visiblePacked.has(neighborPacked)) {
            continue;
          }

          if (
            sideFaceCoveredTopCellKey &&
            fromB === b + 1 &&
            toB === b + 1 &&
            options.iceSlopeCoveredTopFaceCells.has(sideFaceCoveredTopCellKey)
          ) {
            continue;
          }

          const from = polycubePointForFace(faceGroup.kind, faceGroup.plane, fromA, fromB);
          const to = polycubePointForFace(faceGroup.kind, faceGroup.plane, toA, toB);
          const segmentKey = polycubeEdgeSegmentKey(from, to);

          if (suppressedEdges.has(segmentKey)) {
            continue;
          }

          if (
            options?.suppressSharedRoomEdges &&
            sharedRoomBoundaryEdgeSegment(
              { x: from[0], y: from[1], z: from[2] },
              { x: to[0], y: to[1], z: to[2] },
              options
            )
          ) {
            continue;
          }

          addPolycubeEdgeSegment(positions, seenSegments, from, to, segmentKey);
        }
      }
    }

    // state -> boolean: does this level contain any ice slope? Ice-slope
    // contact signatures are expensive and run before the edge-geometry
    // cache lookup, so rooms without slopes (the vast majority) pay for
    // nothing. WeakMap self-evicts with the state object.
    const iceSlopePresenceMemo = new WeakMap();

    function stateHasIceSlopes(state) {
      if (!state?.terrain) {
        return false;
      }

      let has = iceSlopePresenceMemo.get(state);

      if (has === undefined) {
        has = false;

        outer: for (let y = 0; y < state.height; y += 1) {
          for (let x = 0; x < state.width; x += 1) {
            if (renderTerrainLayersAt(x, y, state).some((layer) => layer?.type === "ice_slope")) {
              has = true;
              break outer;
            }
          }
        }

        iceSlopePresenceMemo.set(state, has);
      }

      return has;
    }

    function polycubeEdgeGeometry(voxels, options = {}) {
      const wantsIceSideContacts = options?.suppressIceSlopeContacts === true;
      const wantsIceTopContacts = options?.suppressIceSlopeTopContacts === true;
      // Slope contacts can only exist when this room or a boundary neighbor
      // actually contains an ice slope; skip the per-voxel signature work
      // entirely otherwise.
      const anyIceNearby =
        (wantsIceSideContacts || wantsIceTopContacts) &&
        (stateHasIceSlopes(renderState()) ||
          [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) =>
            stateHasIceSlopes(neighborLevelStateForBoundary(dx, dy))
          ));
      const suppressIceSlopeSideContacts = wantsIceSideContacts && anyIceNearby;
      const suppressIceSlopeTopContacts = wantsIceTopContacts && anyIceNearby;
      const iceSlopeContactSignature = suppressIceSlopeSideContacts || suppressIceSlopeTopContacts
        ? iceSlopeContactSignatureForVoxels(voxels, options.now, {
            includeSideContacts: suppressIceSlopeSideContacts,
            includeTopContacts: suppressIceSlopeTopContacts
          })
        : "";
      const cacheKey = [
        "polycube-edges",
        Math.round(renderOffsetX() * 100),
        Math.round(renderOffsetZ() * 100),
        // Boundary suppression depends on which neighbor states are loaded;
        // key the cache on them so seam edges recompute when a neighbor
        // arrives instead of replaying the stale first build.
        options?.suppressSharedRoomEdges
          ? `shared:${boundaryNeighborStatesToken(activeRenderContext?.state?.levelId || app.currentLevelId)}`
          : "normal",
        iceSlopeContactSignature,
        options?.descriptor?.key || "",
        activeRenderContext?.state?.levelId || "",
        polycubeVoxelSignature(voxels)
      ].join(":");

      if (edgeGeometryCache.has(cacheKey)) {
        return edgeGeometryCache.get(cacheKey);
      }

      const positions = [];
      const seenSegments = new Set();
      const suppressedEdges = polycubeContactEdgeKeys(voxels);
      const iceSlopeCoveredTopFaceCells = suppressIceSlopeTopContacts
        ? iceSlopeCoveredTopFaceCellsForVoxels(voxels, options.now)
        : null;

      if (suppressIceSlopeSideContacts || suppressIceSlopeTopContacts) {
        addIceSlopeContactSuppressedEdges(suppressedEdges, voxels, options.now, {
          includeSideContacts: suppressIceSlopeSideContacts,
          includeTopContacts: suppressIceSlopeTopContacts
        });
      }

      collectPolycubeFaceCells(voxels).forEach((faceGroup) => {
        addPolycubeFaceBoundaryEdges(positions, seenSegments, faceGroup, suppressedEdges, {
          ...options,
          iceSlopeCoveredTopFaceCells
        });
      });

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      cacheEdgeGeometry(cacheKey, geometry);
      return geometry;
    }

    function variableSolidBoxSignature(boxes) {
      return boxes
        .map((box) =>
          [
            box.x,
            box.y,
            Math.round(box.bottomY * 1000),
            Math.round(box.topY * 1000)
          ].join(",")
        )
        .sort()
        .join("|");
    }

    function variableSolidSegmentKey(from, to) {
      return [from, to]
        .map((point) => point.map((value) => Math.round(value * 1000)).join(","))
        .sort()
        .join(":");
    }

    function addVariableSolidFace(faces, normal, corners) {
      faces.push({ normal, corners });
    }

    function variableSolidFaces(boxes) {
      const yLevels = Array.from(
        new Set(
          boxes.flatMap((box) => [
            Math.round(box.bottomY * 1000) / 1000,
            Math.round(box.topY * 1000) / 1000
          ])
        )
      ).sort((left, right) => left - right);
      const slabs = [];

      for (let index = 0; index < yLevels.length - 1; index += 1) {
        const bottomY = yLevels[index];
        const topY = yLevels[index + 1];

        if (topY - bottomY > 0.001) {
          slabs.push({ bottomY, topY });
        }
      }

      const voxelMap = new Map();
      const voxelKey = (x, y, slabIndex) => `${x},${y},${slabIndex}`;

      slabs.forEach((slab, slabIndex) => {
        boxes.forEach((box) => {
          if (box.bottomY > slab.bottomY + 0.001 || box.topY < slab.topY - 0.001) {
            return;
          }

          const key = voxelKey(box.x, box.y, slabIndex);

          if (!voxelMap.has(key)) {
            voxelMap.set(key, {
              x: box.x,
              y: box.y,
              slabIndex,
              bottomY: slab.bottomY,
              topY: slab.topY
            });
          }
        });
      });

      const faces = [];
      const hasVoxel = (x, y, slabIndex) => voxelMap.has(voxelKey(x, y, slabIndex));

      voxelMap.forEach((voxel) => {
        const x0 = voxel.x * unit + renderOffsetX();
        const x1 = (voxel.x + 1) * unit + renderOffsetX();
        const z0 = voxel.y * unit + renderOffsetZ();
        const z1 = (voxel.y + 1) * unit + renderOffsetZ();
        const y0 = voxel.bottomY;
        const y1 = voxel.topY;

        if (!hasVoxel(voxel.x + 1, voxel.y, voxel.slabIndex)) {
          addVariableSolidFace(faces, "xplus", [
            [x1, y0, z0],
            [x1, y1, z0],
            [x1, y1, z1],
            [x1, y0, z1]
          ]);
        }

        if (!hasVoxel(voxel.x - 1, voxel.y, voxel.slabIndex)) {
          addVariableSolidFace(faces, "xminus", [
            [x0, y0, z0],
            [x0, y0, z1],
            [x0, y1, z1],
            [x0, y1, z0]
          ]);
        }

        if (!hasVoxel(voxel.x, voxel.y + 1, voxel.slabIndex)) {
          addVariableSolidFace(faces, "zplus", [
            [x0, y0, z1],
            [x1, y0, z1],
            [x1, y1, z1],
            [x0, y1, z1]
          ]);
        }

        if (!hasVoxel(voxel.x, voxel.y - 1, voxel.slabIndex)) {
          addVariableSolidFace(faces, "zminus", [
            [x0, y0, z0],
            [x0, y1, z0],
            [x1, y1, z0],
            [x1, y0, z0]
          ]);
        }

        if (!hasVoxel(voxel.x, voxel.y, voxel.slabIndex + 1)) {
          addVariableSolidFace(faces, "top", [
            [x0, y1, z0],
            [x0, y1, z1],
            [x1, y1, z1],
            [x1, y1, z0]
          ]);
        }

        if (!hasVoxel(voxel.x, voxel.y, voxel.slabIndex - 1)) {
          addVariableSolidFace(faces, "bottom", [
            [x0, y0, z0],
            [x1, y0, z0],
            [x1, y0, z1],
            [x0, y0, z1]
          ]);
        }
      });

      return faces;
    }

    function variableSolidGeometry(boxes) {
      const cacheKey = [
        "variable-solid-geometry",
        Math.round(renderOffsetX() * 100),
        Math.round(renderOffsetZ() * 100),
        variableSolidBoxSignature(boxes)
      ].join(":");

      if (geometryCache.has(cacheKey)) {
        return geometryCache.get(cacheKey);
      }

      const positions = [];

      variableSolidFaces(boxes).forEach((face) => {
        pushQuadPositions(positions, face.corners);
      });

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      cacheGeometry(cacheKey, geometry);
      return geometry;
    }

    function variableSolidEdgeGeometry(boxes) {
      const cacheKey = [
        "variable-solid-edges",
        Math.round(renderOffsetX() * 100),
        Math.round(renderOffsetZ() * 100),
        variableSolidBoxSignature(boxes)
      ].join(":");

      if (edgeGeometryCache.has(cacheKey)) {
        return edgeGeometryCache.get(cacheKey);
      }

      const edgeMap = new Map();

      variableSolidFaces(boxes).forEach((face) => {
        face.corners.forEach((from, index) => {
          const to = face.corners[(index + 1) % face.corners.length];
          const key = variableSolidSegmentKey(from, to);

          if (!edgeMap.has(key)) {
            edgeMap.set(key, {
              from,
              to,
              normals: new Map(),
              total: 0
            });
          }

          const entry = edgeMap.get(key);
          entry.normals.set(face.normal, (entry.normals.get(face.normal) || 0) + 1);
          entry.total += 1;
        });
      });

      const positions = [];

      edgeMap.forEach((entry) => {
        if (entry.normals.size === 1 && entry.total > 1) {
          return;
        }

        positions.push(...entry.from, ...entry.to);
      });

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      cacheEdgeGeometry(cacheKey, geometry);
      return geometry;
    }

    function topCapHeight(height) {
      return Math.min(height, Math.max(5, Math.min(height * 0.32, unit * 0.12)));
    }

    function addTopRoundedCuboid(width, depth, height, radius, color, position, options = {}) {
      radius = shapeCornerRadius;
      const opacity = options.opacity ?? 1;

      addOutlinedMesh(roundedCuboidGeometry(width, depth, height, radius), color, position, {
        edgeThreshold: 18,
        outline: options.outline !== false,
        castShadow: options.castShadow,
        receiveShadow: options.receiveShadow,
        opacity,
        edgeOpacity: options.edgeOpacity,
        editorPick: options.editorPick
      });
    }

    function addTopRoundedComponent(cells, height, color, topY, options = {}) {
      const geometryOptions = options.cacheKey === false ? { cacheKey: false } : {};
      const opacity = options.opacity ?? 1;
      const edgeThreshold = 18;
      const geometry = componentCuboidGeometry(cells, height, geometryOptions);
      const shouldOutline = options.outline !== false;

      addOutlinedMesh(geometry, color, {
        x: options.offsetX || 0,
        y: topY,
        z: options.offsetZ || 0
      }, {
        edgeGeometry: shouldOutline
          ? componentEdgeGeometryFor(geometry, cells, height, edgeThreshold, options.edgeOptions)
          : null,
        edgeThreshold,
        outline: shouldOutline,
        castShadow: options.castShadow,
        receiveShadow: options.receiveShadow,
        opacity,
        edgeOpacity: options.edgeOpacity,
        editorPick: options.editorPick
      });
    }

    function addComponent(cells, height, color, topY, options = {}) {
      if (options.rounded === false) {
        const opacity = options.opacity ?? 1;
        const edgeThreshold = 18;
        const geometry = componentCuboidGeometry(cells, height, options);
        const shouldOutline = options.outline !== false;

        addOutlinedMesh(geometry, color, {
          x: options.offsetX || 0,
          y: topY,
          z: options.offsetZ || 0
        }, {
          edgeGeometry: shouldOutline
            ? componentEdgeGeometryFor(geometry, cells, height, edgeThreshold, options.edgeOptions)
            : null,
          edgeThreshold,
          outline: shouldOutline,
          castShadow: options.castShadow,
          receiveShadow: options.receiveShadow,
          opacity,
          edgeOpacity: options.edgeOpacity,
          editorPick: options.editorPick
        });
        return;
      }

      addTopRoundedComponent(cells, height, color, topY, options);
    }

    function componentTopPlaneGeometry(cells) {
      const key = [
        "component-top-plane",
        cells
          .map((cell) =>
            [
              Math.round(cell.left * 100),
              Math.round(cell.right * 100),
              Math.round(cell.top * 100),
              Math.round(cell.bottom * 100)
            ].join(",")
          )
          .join("|")
      ].join(":");

      if (geometryCache.has(key)) {
        return geometryCache.get(key);
      }

      const positions = [];

      cells.forEach((cell) => {
        positions.push(
          cell.left, 0, cell.top,
          cell.right, 0, cell.bottom,
          cell.right, 0, cell.top,
          cell.left, 0, cell.top,
          cell.left, 0, cell.bottom,
          cell.right, 0, cell.bottom
        );
      });

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      cacheGeometry(key, geometry);
      return geometry;
    }

    function edgeGeometryFor(geometry, threshold) {
      if (!geometryCacheHas(geometry)) {
        return new THREE.EdgesGeometry(geometry, threshold);
      }

      const key = `${geometry.uuid}:${threshold}`;

      if (!edgeGeometryCache.has(key)) {
        cacheEdgeGeometry(key, new THREE.EdgesGeometry(geometry, threshold));
      }

      return edgeGeometryCache.get(key);
    }

    function terrainColor(type) {
      if (type === "wall") {
        return "#23262c";
      }

      if (type === "tree") {
        return "#2f7d3f";
      }

      if (type === "shrub") {
        return "#476b35";
      }

      if (type === "block_asset") {
        return "#5b2f14";
      }

      if (type === "ice" || type === "ice_block" || type === "ice_slope") {
        return "#a9d6f4";
      }

      if (type === "player_gate") {
        return "#c75652";
      }

      if (type === "player_lift") {
        return "#8a63d2";
      }

      if (type === "orange_wall") {
        return "#b85f16";
      }

      if (type === "orange_button") {
        return "#d6bd94";
      }

      if (type === "hole" || type === "empty") {
        return "#050608";
      }

      if (type === "exit") {
        return "#d6bd94";
      }

      return "#d6bd94";
    }

    function isSunkenFloorType(type) {
      return type === "floor" || type === "ice" || type === "exit";
    }

    function isStackableFloorType(type) {
      return type === "floor" || type === "ice";
    }

    function playerLiftPlateThickness() {
      return Math.max(2, unit * 0.06);
    }

    function playerLiftPlateOffset() {
      return Math.max(0.75, unit * 0.012);
    }

    function isGridFloorDescriptor(descriptor) {
      return (
        descriptor.terrainHeight === 0 &&
        (descriptor.type === "floor" || descriptor.type === "exit")
      );
    }

    function shouldRenderFloorGridLines() {
      return !app.isFlyoverMode && activeRenderContext?.role !== "neighbor";
    }

    function shouldRenderTileTopDetails() {
      return activeRenderContext?.role !== "neighbor";
    }

    function renderIsInsideBoard(x, y, state = renderState()) {
      return x >= 0 && x < state.width && y >= 0 && y < state.height;
    }

    function renderTerrainAt(x, y, state = renderState()) {
      return (
        state.terrain?.[y]?.[x] || {
          type: "empty",
          label: "Empty",
          imageUrl: null,
          modelUrl: null,
          underlay: null,
          raised: false
        }
      );
    }

    function renderTerrainLayersAt(x, y, state = renderState()) {
      const cell = renderTerrainAt(x, y, state);

      if (Array.isArray(cell.layers)) {
        return cell.layers;
      }

      return cell.type === "empty"
        ? []
        : [
            {
              type: cell.type,
              elevation: 0,
              modelUrl: cell.modelUrl || null,
              raised: cell.raised === true
            }
          ];
    }

    function actorColor(actor) {
      if (actor.type === "player" || actor.type === "circle_player") {
        return "#5aa95c";
      }

      if (actor.type === "clone") {
        return "#b59a2a";
      }

      if (actor.type === "weightless_box") {
        return "#315991";
      }

      if (actor.type === "floating_floor") {
        return "#d6bd94";
      }

      if (actor.type === "gem") {
        return "#6cd7ff";
      }

      if (actor.type === "puncher") {
        return "#ef4444";
      }

      return "#2a2d33";
    }

    function actorCuboidHeight(scale = 1) {
      return Math.max(1, elevationUnit - actorVisualLift) * scale;
    }

    function actorVisualScale(actor) {
      return actor.renderInHole ? 1 : (actor.renderScale ?? (actor.removed ? 0 : 1));
    }

    function cellCenter(x, y) {
      return {
        x: (x + 0.5) * unit + renderOffsetX(),
        z: (y + 0.5) * unit + renderOffsetZ()
      };
    }

    function editorPickForRenderContext(pick) {
      if (!pick) {
        return null;
      }

      const context = activeRenderContext;

      if (isEditorRenderMode() && context?.role === "neighbor" && context.state?.levelId) {
        return {
          ...pick,
          levelSwitch: true,
          levelId: context.state.levelId,
          dx: Number(context.dx) || 0,
          dy: Number(context.dy) || 0
        };
      }

      return pick;
    }

    function editorHoverTargetKey(target) {
      if (!target) {
        return "";
      }

      return [
        target.kind || "",
        target.levelId || "",
        target.face || "",
        target.sourceX,
        target.sourceY,
        target.paintX,
        target.paintY,
        Math.round((target.topY ?? 0) * 1000),
        Math.round((target.bottomY ?? 0) * 1000)
      ].join(":");
    }

    function scheduleEditorHoverRender() {
      if (editorHoverRenderFrameId || typeof app.render !== "function") {
        return;
      }

      editorHoverRenderFrameId = window.requestAnimationFrame((now) => {
        editorHoverRenderFrameId = 0;

        if (typeof app.renderOncePerFrame === "function") {
          app.renderOncePerFrame(now);
        } else {
          app.render();
        }
      });
    }

    function setEditorHoverTarget(target) {
      const nextTarget = target || null;

      if (editorHoverTargetKey(editorHoverTarget) === editorHoverTargetKey(nextTarget)) {
        return;
      }

      editorHoverTarget = nextTarget;
      lastSceneSignature = "";
      scheduleEditorHoverRender();
    }

    function editorPickableMeshes() {
      if (!scene) {
        return [];
      }

      return scene.children.filter((child) => child.userData?.editorPick);
    }

    function editorPickCellForPoint(pick, point, normal) {
      const cells = Array.isArray(pick?.cells) ? pick.cells : [];
      const tolerance = Math.max(1, unit * 0.035);
      const candidates = cells.filter(
        (cell) =>
          point.x >= cell.left - tolerance &&
          point.x <= cell.right + tolerance &&
          point.z >= cell.top - tolerance &&
          point.z <= cell.bottom + tolerance
      );
      const pool = candidates.length > 0 ? candidates : cells;

      if (pool.length === 0) {
        return null;
      }

      if (Math.abs(normal.x) >= Math.abs(normal.z) && Math.abs(normal.x) > 0.4) {
        const edge = normal.x > 0 ? "right" : "left";
        return pool
          .slice()
          .sort((a, b) => Math.abs(a[edge] - point.x) - Math.abs(b[edge] - point.x))[0];
      }

      if (Math.abs(normal.z) > 0.4) {
        const edge = normal.z > 0 ? "bottom" : "top";
        return pool
          .slice()
          .sort((a, b) => Math.abs(a[edge] - point.z) - Math.abs(b[edge] - point.z))[0];
      }

      return pool
        .slice()
        .sort((a, b) => {
          const ax = (a.left + a.right) / 2 - point.x;
          const az = (a.top + a.bottom) / 2 - point.z;
          const bx = (b.left + b.right) / 2 - point.x;
          const bz = (b.top + b.bottom) / 2 - point.z;

          return ax * ax + az * az - (bx * bx + bz * bz);
        })[0];
    }

    function editorVoxelLayerAt(pointY, mode = "side") {
      const y = Math.max(0, pointY - actorVisualLift);

      if (mode === "top") {
        return Math.max(0, Math.round(y / unit));
      }

      return Math.max(0, Math.floor(Math.max(0, y - 0.001) / unit));
    }

    function editorVoxelLayerBounds(layer) {
      return {
        bottomY: layer * unit + actorVisualLift,
        topY: (layer + 1) * unit + actorVisualLift
      };
    }

    function pickEditorFace(clientX, clientY, targetElement = app.canvas) {
      if (!THREE || !camera || !scene || !targetElement) {
        return null;
      }

      const rect = targetElement.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      if (!raycaster) {
        raycaster = new THREE.Raycaster();
      }

      const pointer = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -(((clientY - rect.top) / rect.height) * 2 - 1)
      );
      raycaster.setFromCamera(pointer, camera);

      const intersections = raycaster.intersectObjects(editorPickableMeshes(), false);

      for (const intersection of intersections) {
        const pick = intersection.object.userData?.editorPick;
        const faceNormal = intersection.face?.normal;

        if (!pick || !faceNormal) {
          continue;
        }

        const normal = faceNormal.clone().transformDirection(intersection.object.matrixWorld);

        if (normal.y < -0.45) {
          continue;
        }

        const cell = editorPickCellForPoint(pick, intersection.point, normal);

        if (!cell) {
          continue;
        }

        let face = "top";
        let dx = 0;
        let dy = 0;
        const isVoxelPick = pick.voxelPick === true;
        let topPaintLayer = isVoxelPick
          ? editorVoxelLayerAt(intersection.point.y, "top")
          : Math.max(0, Math.round((pick.topY || 0) / unit));
        const explicitSourceLayer = Number.isFinite(pick.sourceLayer)
          ? Math.max(0, Math.floor(pick.sourceLayer))
          : null;
        let sourceLayer = explicitSourceLayer ?? Math.max(0, topPaintLayer - 1);
        let targetBottomY = isVoxelPick ? sourceLayer * unit + actorVisualLift : pick.bottomY;
        let targetTopY = isVoxelPick ? topPaintLayer * unit + actorVisualLift : pick.topY;

        if (normal.y <= 0.55) {
          if (isVoxelPick) {
            sourceLayer = editorVoxelLayerAt(intersection.point.y, "side");
            const bounds = editorVoxelLayerBounds(sourceLayer);

            targetBottomY = bounds.bottomY;
            targetTopY = bounds.topY;
          } else if (explicitSourceLayer === null) {
            const sideTopLayer = Math.max(1, Math.ceil((pick.topY || 0) / unit));
            sourceLayer = Math.max(
              0,
              Math.min(sideTopLayer - 1, Math.floor(Math.max(0, intersection.point.y) / unit))
            );
          }

          if (Math.abs(normal.x) >= Math.abs(normal.z)) {
            dx = normal.x >= 0 ? 1 : -1;
            face = dx > 0 ? "right" : "left";
          } else {
            dy = normal.z >= 0 ? 1 : -1;
            face = dy > 0 ? "bottom" : "top-side";
          }
        }

        if (pick.levelSwitch) {
          return {
            bottomY: targetBottomY,
            bounds: {
              left: cell.left,
              right: cell.right,
              top: cell.top,
              bottom: cell.bottom
            },
            dx: pick.dx,
            dy: pick.dy,
            face,
            kind: "levelSwitch",
            levelId: pick.levelId,
            paintLayer: null,
            paintX: cell.gridX,
            paintY: cell.gridY,
            sourceLayer,
            sourceX: cell.gridX,
            sourceY: cell.gridY,
            topY: targetTopY
          };
        }

        return {
          bottomY: targetBottomY,
          bounds: {
            left: cell.left,
            right: cell.right,
            top: cell.top,
            bottom: cell.bottom
          },
          dx,
          dy,
          face,
          kind: pick.kind || "terrain",
          paintLayer: dx === 0 && dy === 0 ? topPaintLayer : sourceLayer,
          paintX: cell.gridX + dx,
          paintY: cell.gridY + dy,
          sourceLayer,
          sourceX: cell.gridX,
          sourceY: cell.gridY,
          topY: targetTopY
        };
      }

      const groundPoint = new THREE.Vector3();
      const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

      if (raycaster.ray.intersectPlane(groundPlane, groundPoint)) {
        const gridX = Math.floor((groundPoint.x - renderOffsetX()) / unit);
        const gridY = Math.floor((groundPoint.z - renderOffsetZ()) / unit);

        if (renderIsInsideBoard(gridX, gridY)) {
          const left = gridX * unit + renderOffsetX();
          const top = gridY * unit + renderOffsetZ();

          return {
            bottomY: -floorThickness,
            bounds: {
              left,
              right: left + unit,
              top,
              bottom: top + unit
            },
            dx: 0,
            dy: 0,
            face: "top",
            kind: "terrain",
            paintLayer: 0,
            paintX: gridX,
            paintY: gridY,
            sourceLayer: 0,
            sourceX: gridX,
            sourceY: gridY,
            topY: 0
          };
        }
      }

      return null;
    }

    function editorHighlightPlaneGeometry(width, height, orientation) {
      const geometry = new THREE.PlaneGeometry(width, height);

      if (orientation === "top") {
        geometry.rotateX(-Math.PI / 2);
      } else if (orientation === "right") {
        geometry.rotateY(Math.PI / 2);
      } else if (orientation === "left") {
        geometry.rotateY(-Math.PI / 2);
      } else if (orientation === "top-side") {
        geometry.rotateY(Math.PI);
      }

      return geometry;
    }

    function editorHighlightMeshMaterial() {
      if (!editorHighlightMaterial) {
        editorHighlightMaterial = new THREE.MeshBasicMaterial({
          color: "#fff3a6",
          depthTest: true,
          depthWrite: false,
          opacity: 0.5,
          side: THREE.DoubleSide,
          transparent: true
        });
      }

      return editorHighlightMaterial;
    }

    function addEditorHoverHighlight() {
      if (!editorHoverTarget || !THREE) {
        return;
      }

      const { bounds } = editorHoverTarget;

      if (!bounds) {
        return;
      }

      const topY = Number(editorHoverTarget.topY);
      const bottomY = Number(editorHoverTarget.bottomY);

      if (!Number.isFinite(topY) || !Number.isFinite(bottomY)) {
        return;
      }

      const faceInset = Math.max(1, unit * 0.035);
      const normalOffset = Math.max(0.75, unit * 0.012);
      const material = editorHighlightMeshMaterial();
      let geometry = null;
      let position = null;

      if (editorHoverTarget.face === "top") {
        geometry = editorHighlightPlaneGeometry(
          Math.max(1, bounds.right - bounds.left - faceInset * 2),
          Math.max(1, bounds.bottom - bounds.top - faceInset * 2),
          "top"
        );
        position = new THREE.Vector3(
          (bounds.left + bounds.right) / 2,
          topY + normalOffset,
          (bounds.top + bounds.bottom) / 2
        );
      } else if (editorHoverTarget.dx !== 0) {
        const height = Math.max(1, topY - bottomY - faceInset);
        geometry = editorHighlightPlaneGeometry(
          Math.max(1, bounds.bottom - bounds.top - faceInset * 2),
          height,
          editorHoverTarget.dx > 0 ? "right" : "left"
        );
        position = new THREE.Vector3(
          editorHoverTarget.dx > 0 ? bounds.right + normalOffset : bounds.left - normalOffset,
          bottomY + (topY - bottomY) / 2,
          (bounds.top + bounds.bottom) / 2
        );
      } else if (editorHoverTarget.dy !== 0) {
        const height = Math.max(1, topY - bottomY - faceInset);
        geometry = editorHighlightPlaneGeometry(
          Math.max(1, bounds.right - bounds.left - faceInset * 2),
          height,
          editorHoverTarget.dy > 0 ? "bottom" : "top-side"
        );
        position = new THREE.Vector3(
          (bounds.left + bounds.right) / 2,
          bottomY + (topY - bottomY) / 2,
          editorHoverTarget.dy > 0 ? bounds.bottom + normalOffset : bounds.top - normalOffset
        );
      }

      if (!geometry || !position) {
        return;
      }

      const highlight = new THREE.Mesh(geometry, material);
      highlight.position.copy(position);
      highlight.castShadow = false;
      highlight.receiveShadow = false;
      scene.add(highlight);
    }

    function renderTerrainLayerSurfaceHeight(layer, x, y, now = performance.now()) {
      const elevation = layer.elevation ?? 0;
      const isLiveState = renderState() === app.state;
      const key = `${x},${y}`;

      if (layer.type === "empty" || layer.type === "hole" || layer.type === "orange_button") {
        return null;
      }

      if (
        layer.type === "wall" ||
        layer.type === "ice_block" ||
        layer.type === "ice_slope" ||
        layer.type === "shrub" ||
        layer.type === "block_asset"
      ) {
        return elevation + 1;
      }

      if (layer.type === "tree") {
        return elevation + 3;
      }

      const surfaceLiftValue = activeRenderContext?.surfaceLiftValues?.get(`${layer.type}:${key}`);

      if (typeof surfaceLiftValue === "number") {
        return elevation + surfaceLiftValue;
      }

      if (layer.type === "player_gate") {
        if (activeRenderContext?.raisedPlayerGates) {
          return elevation + (activeRenderContext.raisedPlayerGates.has(key) ? 1 : 0);
        }

        return elevation + (isLiveState ? app.gateLiftAt(x, y, now) : layer.raised === true ? 1 : 0);
      }

      if (layer.type === "player_lift") {
        return elevation + (isLiveState ? app.playerLiftAt(x, y, now) : layer.raised === true ? 1 : 0);
      }

      if (layer.type === "orange_wall") {
        return elevation + renderOrangeWallLiftValue(x, y, layer, now);
      }

      return elevation;
    }

    function renderOrangeWallLiftValue(x, y, layer, now = performance.now()) {
      const key = `${x},${y}`;
      const surfaceLiftValue = activeRenderContext?.surfaceLiftValues?.get(`orange_wall:${key}`);

      if (typeof surfaceLiftValue === "number") {
        return clamp01(surfaceLiftValue);
      }

      if (activeRenderContext?.raisedOrangeWalls) {
        return activeRenderContext.raisedOrangeWalls.has(key) ? 1 : 0;
      }

      return renderState() === app.state
        ? app.orangeWallLiftAt(x, y, now)
        : layer.raised === true ? 1 : 0;
    }

    function renderCellHasOrangeWallLayerAtElevation(x, y, elevation) {
      return renderTerrainLayersAt(x, y).some(
        (candidate) =>
          candidate.type === "orange_wall" &&
          (candidate.elevation ?? 0) === elevation
      );
    }

    function renderOrangeWallHasLayerBelow(layer, x, y) {
      const elevation = layer.elevation ?? 0;

      return elevation > 0 && renderCellHasOrangeWallLayerAtElevation(x, y, elevation - 1);
    }

    function renderOrangeWallHasNonOrangeSupportBelow(layer, x, y, now = performance.now()) {
      const elevation = layer.elevation ?? 0;

      return renderTerrainLayersAt(x, y).some((candidate) => {
        if (candidate === layer || candidate.type === "orange_wall") {
          return false;
        }

        return renderTerrainLayerSurfaceHeight(candidate, x, y, now) === elevation;
      });
    }

    function renderOrangeWallHasLayerAbove(layer, x, y) {
      const elevation = layer.elevation ?? 0;

      return renderCellHasOrangeWallLayerAtElevation(x, y, elevation + 1);
    }

    function renderPlayerGateHasSurfaceBelow(layer, x, y, now = performance.now()) {
      const elevation = layer.elevation ?? 0;

      if (elevation <= 0) {
        return true;
      }

      return renderTerrainLayersAt(x, y).some((candidate) => {
        if (
          candidate === layer ||
          candidate.type === "empty" ||
          candidate.type === "hole" ||
          candidate.type === "orange_button" ||
          candidate.type === "player_gate"
        ) {
          return false;
        }

        const surfaceHeight = renderTerrainLayerSurfaceHeight(candidate, x, y, now);

        return surfaceHeight !== null && Math.abs(surfaceHeight - elevation) <= 0.001;
      });
    }

    function renderTerrainLayerLiftValue(layer, x, y, now = performance.now()) {
      const key = `${x},${y}`;
      const surfaceLiftValue = activeRenderContext?.surfaceLiftValues?.get(`${layer.type}:${key}`);

      if (typeof surfaceLiftValue === "number") {
        return clamp01(surfaceLiftValue);
      }

      if (layer.type === "player_lift") {
        return renderState() === app.state ? app.playerLiftAt(x, y, now) : layer.raised === true ? 1 : 0;
      }

      return 0;
    }

    function renderTerrainSurfaceHeightAt(x, y, now = performance.now()) {
      if (!renderIsInsideBoard(x, y)) {
        return null;
      }

      const heights = renderTerrainLayersAt(x, y)
        .map((layer) => renderTerrainLayerSurfaceHeight(layer, x, y, now))
        .filter((height) => height !== null);

      return heights.length > 0 ? Math.max(...heights) : null;
    }

    function bestTerrainLayer(x, y, terrainHeight, now = performance.now()) {
      const layers = renderTerrainLayersAt(x, y);
      let best = null;
      let bestHeight = -Infinity;

      layers.forEach((layer) => {
        const height = renderTerrainLayerSurfaceHeight(layer, x, y, now);

        if (height === null) {
          return;
        }

        if (height > bestHeight || (height === bestHeight && layer.elevation >= (best?.elevation ?? 0))) {
          best = layer;
          bestHeight = height;
        }
      });

      return best || {
        type: terrainHeight === null ? "hole" : renderTerrainAt(x, y).type,
        elevation: terrainHeight || 0
      };
    }

    function playerLiftTriangleGeometry(direction) {
      const key = `player-lift-triangle:${direction}`;

      if (geometryCache.has(key)) {
        return geometryCache.get(key);
      }

      const pointZ = direction < 0 ? -unit * 0.22 : unit * 0.22;
      const baseZ = direction < 0 ? unit * 0.16 : -unit * 0.16;
      const halfWidth = unit * 0.17;
      const geometry = new THREE.BufferGeometry();

      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          direction < 0
            ? [
                0,
                0,
                pointZ,
                -halfWidth,
                0,
                baseZ,
                halfWidth,
                0,
                baseZ
              ]
            : [
                0,
                0,
                pointZ,
                halfWidth,
                0,
                baseZ,
                -halfWidth,
                0,
                baseZ
              ],
          3
        )
      );
      geometry.computeVertexNormals();
      cacheGeometry(key, geometry);
      return geometry;
    }

    function playerLiftMarkerCameraYaw() {
      return isPalettePreviewRenderMode() ? 0 : debugCameraYaw;
    }

    function syncPlayerLiftMarkerRotation(marker) {
      const baseRotation = marker.userData.playerLiftArrowImage && marker.userData.playerLiftDirection > 0
        ? Math.PI
        : 0;

      marker.rotation.y = baseRotation + playerLiftMarkerCameraYaw();
    }

    function syncPlayerLiftMarkerRotations() {
      playerLiftMarkerMeshes.forEach((marker) => {
        syncPlayerLiftMarkerRotation(marker);
      });
    }

    function trackPlayerLiftMarker(marker, direction, usesArrowImage) {
      marker.userData.playerLiftDirection = direction;
      marker.userData.playerLiftArrowImage = usesArrowImage;
      syncPlayerLiftMarkerRotation(marker);
      playerLiftMarkerMeshes.add(marker);
    }

    function addPlayerLiftTriangle(center, topY, direction, opacity) {
      const markerOpacity = clamp01(opacity);

      if (markerOpacity <= 0.015) {
        return;
      }

      const arrowMaterial = imageMaterial(app.PLAYER_LIFT_ARROW_URL, markerOpacity);

      if (arrowMaterial) {
        const size = unit * 0.46;
        const geometryKey = `player-lift-arrow-plane:${Math.round(size * 100)}`;

        if (!geometryCache.has(geometryKey)) {
          const geometry = new THREE.PlaneGeometry(size, size);

          geometry.rotateX(-Math.PI / 2);
          cacheGeometry(geometryKey, geometry);
        }

        const arrow = new THREE.Mesh(geometryCache.get(geometryKey), arrowMaterial);

        arrow.position.set(center.x, topY + Math.max(0.75, unit * 0.012), center.z);
        trackPlayerLiftMarker(arrow, direction, true);
        arrow.castShadow = false;
        arrow.receiveShadow = false;
        scene.add(arrow);
        return;
      }

      const triangle = new THREE.Mesh(
        playerLiftTriangleGeometry(direction),
        material("#050608", markerOpacity)
      );

      triangle.position.set(center.x, topY + Math.max(0.75, unit * 0.012), center.z);
      trackPlayerLiftMarker(triangle, direction, false);
      triangle.castShadow = false;
      triangle.receiveShadow = false;
      scene.add(triangle);
    }

    function orangeButtonHeight() {
      return Math.max(4, elevationUnit * 0.12);
    }

    function orangeButtonRadius() {
      return unit * 0.21;
    }

    function addOrangeButtonMesh(center, baseY, opacity, edgeOpacity, editorPick = null) {
      const buttonHeight = orangeButtonHeight();

      addOutlinedMesh(
        cylinderGeometry(orangeButtonRadius(), buttonHeight),
        "#f59e0b",
        {
          x: center.x,
          y: baseY + buttonHeight / 2,
          z: center.z
        },
        {
          castShadow: renderContextCastsShadows(),
          edgeThreshold: 24,
          edgeOpacity,
          opacity,
          receiveShadow: false,
          editorPick
        }
      );
    }

    function orangeButtonTerrainEditorPick(x, y, elevation, baseY) {
      return {
        kind: "terrain",
        cells: [
          {
            gridX: x,
            gridY: y,
            left: x * unit + renderOffsetX(),
            right: (x + 1) * unit + renderOffsetX(),
            top: y * unit + renderOffsetZ(),
            bottom: (y + 1) * unit + renderOffsetZ()
          }
        ],
        topY: baseY + orangeButtonHeight(),
        bottomY: baseY,
        sourceLayer: elevation
      };
    }

    function addTerrainOrangeButtonOverlays(now = performance.now()) {
      const state = renderState();

      for (let y = 0; y < state.height; y += 1) {
        for (let x = 0; x < state.width; x += 1) {
          const visibility = transitionPieceProgressForCell(x, y);

          if (visibility <= 0.05) {
            continue;
          }

          renderTerrainLayersAt(x, y, state)
            .filter((layer) => layer.type === "orange_button")
            .forEach((layer) => {
              const elevation = Math.max(0, layer.elevation ?? 0);
              const baseY = elevation * elevationUnit + actorVisualLift;

              addOrangeButtonMesh(
                cellCenter(x, y),
                baseY,
                visibility,
                visibility,
                orangeButtonTerrainEditorPick(x, y, elevation, baseY)
              );
            });
        }
      }
    }

    function orangeButtonSurfaceBaseY(actor, elevation, sink, now = performance.now()) {
      const defaultBaseY = elevation * elevationUnit - sink + actorVisualLift;

      if (Math.abs(elevation) > 0.001 || Math.abs(sink) > 0.001) {
        return defaultBaseY;
      }

      const surfaceDescriptor = terrainPieceDescriptorsAt(actor.x, actor.y, now)
        .filter((descriptor) =>
          (descriptor.type === "floor" || descriptor.type === "ice" || descriptor.type === "exit") &&
          Math.abs((descriptor.terrainHeight ?? 0) - elevation) <= 0.001
        )
        .sort((left, right) => right.topY - left.topY)[0];

      return surfaceDescriptor ? surfaceDescriptor.topY : defaultBaseY;
    }

    function addTileTopDetails(x, y, layer, topY, now = performance.now()) {
      const visibility = transitionPieceProgressForCell(x, y);

      if (visibility <= 0.05) {
        return;
      }

      const center = cellCenter(x, y);

      if (layer.type === "player_lift") {
        const lift = clamp01(renderTerrainLayerLiftValue(layer, x, y, now));

        addPlayerLiftTriangle(center, topY, -1, visibility * (1 - lift));
        addPlayerLiftTriangle(center, topY, 1, visibility * lift);
      }

      if (layer.type === "exit") {
        const gem = new THREE.Mesh(
          octahedronGeometry(unit * 0.18),
          material("#ff7b72", visibility)
        );
        gem.position.set(center.x, topY + unit * 0.08, center.z);
        gem.castShadow = renderContextCastsShadows();
        gem.receiveShadow = false;
        scene.add(gem);
      }
    }

    function terrainDescriptorAt(x, y, now = performance.now()) {
      const terrainHeight = renderTerrainSurfaceHeightAt(x, y, now);
      const layer = bestTerrainLayer(x, y, terrainHeight, now);
      const topHeight = Math.max(0, terrainHeight ?? 0) * elevationUnit;
      const type = layer.type || "floor";
      const visualLayerDescriptor =
        type === "player_lift" ? terrainPieceDescriptorForLayer(layer, x, y, now) : null;
      const isSunkenFloor = terrainHeight === 0 && isSunkenFloorType(type);
      let blockHeight = floorThickness;

      if (visualLayerDescriptor) {
        blockHeight = visualLayerDescriptor.blockHeight;
      } else if (terrainHeight > 0) {
        blockHeight = Math.max(1, topHeight);
      }

      const topY = visualLayerDescriptor
        ? visualLayerDescriptor.topY
        : terrainHeight === null
          ? 0
          : topHeight - (isSunkenFloor ? floorDrop : 0);

      return {
        blockHeight,
        isVoid: terrainHeight === null || type === "hole" || type === "empty",
        key: [
          type,
          terrainHeight === null ? "null" : terrainHeight,
          Math.round(blockHeight * 100) / 100,
          Math.round(topY * 100) / 100,
          layer.direction || "",
          layer.modelUrl || "",
          type === "player_lift" ? `${x},${y}` : ""
        ].join(":"),
        layer,
        terrainHeight,
        isSunkenFloor,
        topY,
        type
      };
    }

    function terrainPieceDescriptorKey(descriptor, x, y) {
      return [
        descriptor.type,
        Math.round((descriptor.elevation ?? 0) * 100) / 100,
        Math.round((descriptor.terrainHeight ?? 0) * 100) / 100,
        Math.round(descriptor.blockHeight * 100) / 100,
        Math.round(descriptor.topY * 100) / 100,
        Math.round(descriptor.bottomY * 100) / 100,
        descriptor.layer?.direction || "",
        descriptor.layer?.modelUrl || "",
        descriptor.type === "player_lift" ? `${x},${y}` : ""
      ].join(":");
    }

    function terrainPieceDescriptorForLayer(layer, x, y, now = performance.now()) {
      const terrainHeight = renderTerrainLayerSurfaceHeight(layer, x, y, now);

      if (terrainHeight === null) {
        return null;
      }

      const elevation = layer.elevation ?? 0;
      const type = layer.type || "floor";
      const topHeight = Math.max(0, terrainHeight) * elevationUnit;
      const baseHeight = Math.max(0, elevation) * elevationUnit;
      const isOrangeWall = type === "orange_wall";
      const orangeWallLift = isOrangeWall ? renderOrangeWallLiftValue(x, y, layer, now) : null;
      const orangeWallHasBelow = isOrangeWall && renderOrangeWallHasLayerBelow(layer, x, y);
      const orangeWallLowersAsBlock =
        isOrangeWall &&
        !orangeWallHasBelow &&
        elevation > 0 &&
        !renderOrangeWallHasNonOrangeSupportBelow(layer, x, y, now);
      const orangeWallHasAbove = isOrangeWall && renderOrangeWallHasLayerAbove(layer, x, y);
      const isLoweredOrangeSurface =
        isOrangeWall &&
        !orangeWallHasBelow &&
        !orangeWallLowersAsBlock &&
        orangeWallLift <= 0.001;
      const isCollapsingOrangeBase =
        isOrangeWall &&
        !orangeWallHasBelow &&
        !orangeWallLowersAsBlock &&
        orangeWallHasAbove &&
        orangeWallLift > 0.001 &&
        orangeWallLift < 0.999;

      if (isOrangeWall && (orangeWallHasBelow || orangeWallLowersAsBlock)) {
        const topY = (elevation + orangeWallLift) * elevationUnit;
        const blockHeight = elevationUnit;
        const descriptor = {
          blockHeight,
          bottomY: topY - blockHeight,
          elevation,
          isLoweredPlayerLift: false,
          isVoid: false,
          layer,
          terrainHeight,
          isSunkenFloor: false,
          topY,
          type
        };

        descriptor.key = terrainPieceDescriptorKey(descriptor, x, y);
        return descriptor;
      }

      if (isOrangeWall && orangeWallHasAbove && !orangeWallLowersAsBlock && orangeWallLift <= 0.001) {
        return null;
      }

      const isRaisedPiece = terrainHeight > elevation;
      const isLoweredPlayerLift = type === "player_lift" && !isRaisedPiece;
      const isSurfacePlayerGate =
        type === "player_gate" &&
        !isRaisedPiece &&
        renderPlayerGateHasSurfaceBelow(layer, x, y, now);
      const isStackedFloorCube = !isRaisedPiece && elevation > 0 && isStackableFloorType(type);
      const isSunkenFloor = !isRaisedPiece && terrainHeight === 0 && isSunkenFloorType(type);
      const topY = isLoweredPlayerLift
        ? topHeight + playerLiftPlateOffset()
        : isLoweredOrangeSurface || isSurfacePlayerGate
          ? topHeight + playerLiftPlateOffset()
          : isRaisedPiece || isStackedFloorCube
            ? topHeight
            : topHeight - (isSunkenFloor ? floorDrop : 0);
      const blockHeight = isRaisedPiece
        ? Math.max(1, topHeight - baseHeight)
        : isLoweredPlayerLift || isSurfacePlayerGate
          ? playerLiftPlateThickness()
          : isStackedFloorCube
            ? elevationUnit
            : floorThickness;
      const bottomY = topY - blockHeight;
      const descriptor = {
        blockHeight,
        bottomY,
        elevation,
        isLoweredOrangeSurface,
        isLoweredPlayerLift,
        isSurfacePlayerGate,
        isCollapsingOrangeBase,
        isVoid: false,
        layer,
        terrainHeight,
        isSunkenFloor,
        topY,
        type
      };

      descriptor.key = terrainPieceDescriptorKey(descriptor, x, y);
      return descriptor;
    }

    function canMergeStackedTerrainPieces(lower, upper) {
      return (
        lower.type === upper.type &&
        lower.type !== "tree" &&
        lower.type !== "shrub" &&
        lower.type !== "block_asset" &&
        !lower.isCollapsingOrangeBase &&
        !lower.isSunkenFloor &&
        !upper.isSunkenFloor &&
        Math.abs(lower.topY - upper.bottomY) <= 0.001
      );
    }

    function mergeStackedTerrainPieces(descriptors, x, y) {
      const merged = [];

      descriptors
        .slice()
        .sort((left, right) => left.bottomY - right.bottomY || left.topY - right.topY)
        .forEach((descriptor) => {
          const previous = merged[merged.length - 1];

          if (!previous || !canMergeStackedTerrainPieces(previous, descriptor)) {
            merged.push({ ...descriptor });
            return;
          }

          previous.blockHeight = descriptor.topY - previous.bottomY;
          previous.elevation = Math.min(previous.elevation ?? 0, descriptor.elevation ?? 0);
          previous.layer = descriptor.layer;
          previous.terrainHeight = Math.max(previous.terrainHeight ?? 0, descriptor.terrainHeight ?? 0);
          previous.topY = descriptor.topY;
          previous.key = terrainPieceDescriptorKey(previous, x, y);
        });

      return merged;
    }

    // preparedState -> Map(tileIndex -> descriptors). Neighbor/world rooms
    // are static (no animations; raised sets baked at prepare time), so their
    // per-tile descriptors are pure functions of the prepared state. The
    // polycube edge pass re-samples tiles 4-5x each; memoizing collapses
    // ~330k computations per full-world build to one per tile. WeakMap
    // self-evicts when a prepared state is replaced.
    const terrainPieceDescriptorMemo = new WeakMap();

    function terrainPieceDescriptorsAt(x, y, now = performance.now()) {
      const state = renderState();
      const cacheable = activeRenderContext?.role === "neighbor" && state?.terrain;
      let byTile = null;

      if (cacheable) {
        byTile = terrainPieceDescriptorMemo.get(state);

        if (!byTile) {
          byTile = new Map();
          terrainPieceDescriptorMemo.set(state, byTile);
        }

        const hit = byTile.get(y * state.width + x);

        if (hit) {
          return hit;
        }
      }

      const descriptors = mergeStackedTerrainPieces(
        renderTerrainLayersAt(x, y)
          .map((layer) => terrainPieceDescriptorForLayer(layer, x, y, now))
          .filter(Boolean),
        x,
        y
      );

      if (byTile) {
        byTile.set(y * state.width + x, descriptors);
      }

      return descriptors;
    }

    function shouldOutlineTerrainRegion(descriptor) {
      if ((descriptor.terrainHeight ?? 0) > 0) {
        return true;
      }

      return !["floor", "ice", "hole", "empty", "exit", "orange_button"].includes(descriptor.type);
    }

    function terrainPolycubeLevel(value) {
      return Math.round(value / elevationUnit);
    }

    function isTerrainPolycubeLevel(value) {
      return Math.abs(value / elevationUnit - terrainPolycubeLevel(value)) <= 0.001;
    }

    function canRenderTerrainPolycube(descriptor) {
      return (
        (
          descriptor.type === "wall" ||
          descriptor.type === "ice_block" ||
          descriptor.type === "orange_wall" ||
          descriptor.type === "floor" ||
          descriptor.type === "ice"
        ) &&
        !descriptor.isSunkenFloor &&
        isTerrainPolycubeLevel(descriptor.bottomY) &&
        isTerrainPolycubeLevel(descriptor.topY) &&
        terrainPolycubeLevel(descriptor.topY) > terrainPolycubeLevel(descriptor.bottomY)
      );
    }

    function addTerrainPolycubeComponent(voxels, now) {
      const entries = Array.from(new Set(voxels.map((voxel) => voxel.entry)));
      const cells = Array.from(
        entries
          .reduce((cellMap, entry) => {
            const key = `${entry.x},${entry.y}`;

            if (!cellMap.has(key)) {
              cellMap.set(key, {
                gridX: entry.x,
                gridY: entry.y,
                left: entry.x * unit + renderOffsetX(),
                right: (entry.x + 1) * unit + renderOffsetX(),
                top: entry.y * unit + renderOffsetZ(),
                bottom: (entry.y + 1) * unit + renderOffsetZ()
              });
            }

            return cellMap;
          }, new Map())
          .values()
      );
      const visibility = transitionPieceProgressForCells(cells);

      if (visibility <= 0.015) {
        return;
      }

      const descriptor = entries[0].descriptor;
      const bottomY = Math.min(...entries.map((entry) => entry.descriptor.bottomY));
      const topY = Math.max(...entries.map((entry) => entry.descriptor.topY));

      addOutlinedMesh(
        polycubeGeometry(voxels),
        terrainColor(descriptor.type),
        { x: 0, y: 0, z: 0 },
        {
          edgeGeometry: polycubeEdgeGeometry(voxels, {
            descriptor,
            now,
            suppressIceSlopeContacts: descriptor.type === "ice_block",
            suppressIceSlopeTopContacts: true,
            suppressSharedRoomEdges:
              descriptor.type === "wall" || descriptor.type === "ice_block"
          }),
          edgeThreshold: 18,
          opacity: visibility,
          castShadow: renderContextCastsShadows(),
          receiveShadow: descriptor.type !== "orange_wall",
          editorPick: {
            kind: "terrain",
            cells,
            voxelPick: true,
            topY,
            bottomY
          }
        }
      );
    }

    function addTerrainPolycubeRegions(entries, now) {
      const groups = new Map();

      entries.forEach((entry) => {
        const key = entry.descriptor.type;

        if (!groups.has(key)) {
          groups.set(key, []);
        }

        groups.get(key).push(entry);
      });

      groups.forEach((groupEntries) => {
        const voxels = [];

        groupEntries.forEach((entry) => {
          const bottomLevel = terrainPolycubeLevel(entry.descriptor.bottomY);
          const topLevel = terrainPolycubeLevel(entry.descriptor.topY);

          for (let z = bottomLevel; z < topLevel; z += 1) {
            voxels.push({
              entry,
              x: entry.x,
              y: entry.y,
              z
            });
          }
        });

        polycubeComponents(voxels).forEach((component) => {
          addTerrainPolycubeComponent(component, now);
        });
      });
    }

    function canRenderAnimatedOrangeSolid(descriptor) {
      return (
        descriptor.type === "orange_wall" &&
        !descriptor.isLoweredOrangeSurface &&
        !canRenderTerrainPolycube(descriptor)
      );
    }

    function addAnimatedOrangeSolidRegion(entries) {
      if (entries.length === 0) {
        return;
      }

      const cells = Array.from(
        entries
          .reduce((cellMap, entry) => {
            const key = `${entry.x},${entry.y}`;

            if (!cellMap.has(key)) {
              cellMap.set(key, {
                gridX: entry.x,
                gridY: entry.y,
                left: entry.x * unit + renderOffsetX(),
                right: (entry.x + 1) * unit + renderOffsetX(),
                top: entry.y * unit + renderOffsetZ(),
                bottom: (entry.y + 1) * unit + renderOffsetZ()
              });
            }

            return cellMap;
          }, new Map())
          .values()
      );
      const visibility = transitionPieceProgressForCells(cells);

      if (visibility <= 0.015) {
        return;
      }

      const boxes = entries.map((entry) => ({
        x: entry.x,
        y: entry.y,
        bottomY: entry.descriptor.bottomY,
        topY: entry.descriptor.topY
      }));
      const bottomY = Math.min(...boxes.map((box) => box.bottomY));
      const topY = Math.max(...boxes.map((box) => box.topY));

      addOutlinedMesh(
        variableSolidGeometry(boxes),
        terrainColor("orange_wall"),
        { x: 0, y: 0, z: 0 },
        {
          edgeGeometry: variableSolidEdgeGeometry(boxes),
          edgeThreshold: 18,
          opacity: visibility,
          castShadow: renderContextCastsShadows(),
          receiveShadow: false,
          editorPick: {
            kind: "terrain",
            cells,
            voxelPick: true,
            topY,
            bottomY
          }
        }
      );
    }

    function terrainModelWorldScale(descriptor) {
      if (descriptor.type === "block_asset") {
        return blockAssetModelWorldScale;
      }

      if (descriptor.type === "shrub") {
        return treeModelWorldScale * shrubModelScaleMultiplier;
      }

      return treeModelWorldScale;
    }

    function seededTerrainModelRotation(cell, descriptor) {
      const seed = [
        cell.gridX,
        cell.gridY,
        Math.floor(Number(descriptor.elevation) || 0),
        descriptor.layer?.modelUrl || descriptor.type || ""
      ].join(":");
      let hash = 2166136261;

      for (let index = 0; index < seed.length; index += 1) {
        hash ^= seed.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }

      return ((hash >>> 0) / 4294967296) * Math.PI * 2;
    }

    function treeModelPlacement(model, cell, descriptor) {
      const scale = terrainModelWorldScale(descriptor);
      const centerX = (cell.left + cell.right) / 2 + renderOffsetX();
      const centerZ = (cell.top + cell.bottom) / 2 + renderOffsetZ();

      return {
        rotationY: descriptor.type === "tree" || descriptor.type === "shrub"
          ? seededTerrainModelRotation(cell, descriptor)
          : 0,
        scale,
        position: new THREE.Vector3(
          centerX,
          descriptor.type === "block_asset"
            ? descriptor.topY - model.bounds.max.y * scale
            : descriptor.bottomY - model.bounds.min.y * scale,
          centerZ
        )
      };
    }

    function treeEditorPickForCell(cell, descriptor) {
      return editorPickForRenderContext({
        kind: "terrain",
        cells: [
          {
            gridX: cell.gridX,
            gridY: cell.gridY,
            left: cell.left + renderOffsetX(),
            right: cell.right + renderOffsetX(),
            top: cell.top + renderOffsetZ(),
            bottom: cell.bottom + renderOffsetZ()
          }
        ],
        topY: descriptor.topY,
        bottomY: descriptor.bottomY,
        sourceLayer: descriptor.elevation ?? 0
      });
    }

    function addTreeModelCell(cell, descriptor, model, visibility) {
      const placement = treeModelPlacement(model, cell, descriptor);
      const editorPick = treeEditorPickForCell(cell, descriptor);
      const opacity = visibility;
      const castsShadows = renderContextCastsShadows();

      model.parts.forEach((part) => {
        const mesh = new THREE.Mesh(part.geometry, material(part.color, opacity));

        mesh.position.copy(placement.position);
        mesh.scale.setScalar(placement.scale);
        mesh.rotation.y = placement.rotationY;
        mesh.castShadow = castsShadows;
        mesh.receiveShadow = false;
        mesh.userData.editorPick = editorPick;
        scene.add(mesh);

        if (!edgeOutlinesEnabled()) {
          return;
        }

        const edgeOpacity = opacity * renderContextOpacity();

        if (edgeOpacity <= 0.015) {
          return;
        }

        const edges = new THREE.LineSegments(
          edgeGeometryFor(part.geometry, 28),
          lineMaterial("#000000", edgeOpacity)
        );

        edges.position.copy(placement.position);
        edges.scale.setScalar(placement.scale);
        edges.rotation.y = placement.rotationY;
        edges.userData.edgeBasePosition = placement.position.clone();
        edgeScene.add(edges);
      });
    }

    function addTreeFallbackCell(cell, descriptor, visibility, now) {
      addComponent([cell], descriptor.blockHeight, terrainColor(descriptor.type), descriptor.topY, {
        outline: true,
        rounded: false,
        castShadow: renderContextCastsShadows(),
        receiveShadow: false,
        opacity: visibility,
        editorPick: {
          kind: "terrain",
          cells: [
            {
              gridX: cell.gridX,
              gridY: cell.gridY,
              left: cell.left + renderOffsetX(),
              right: cell.right + renderOffsetX(),
              top: cell.top + renderOffsetZ(),
              bottom: cell.bottom + renderOffsetZ()
            }
          ],
          topY: descriptor.topY,
          bottomY: descriptor.bottomY,
          sourceLayer: descriptor.elevation ?? 0
        },
        edgeOptions: {
          descriptor,
          now,
          offsetX: renderOffsetX(),
          offsetZ: renderOffsetZ()
        },
        offsetX: renderOffsetX(),
        offsetZ: renderOffsetZ()
      });
    }

    function isModelTerrainType(type) {
      return type === "tree" || type === "shrub" || type === "block_asset";
    }

    function addTreeComponent(cells, descriptor, now) {
      const visibility = transitionPieceProgressForCells(cells);

      if (visibility <= 0.015) {
        return;
      }

      const model = requestModelAsset(descriptor.layer?.modelUrl);

      cells.forEach((cell) => {
        if (model) {
          addTreeModelCell(cell, descriptor, model, visibility);
        } else {
          addTreeFallbackCell(cell, descriptor, visibility, now);
        }
      });
    }

    function iceSlopeHighSideHasIceBlockContact(cell, descriptor, now) {
      const direction = normalizeCardinalDirection(descriptor.layer?.direction);
      const vector = cardinalGridVector(direction);
      const neighborX = cell.gridX + vector.dx;
      const neighborY = cell.gridY + vector.dy;
      const slopeLevel = terrainPolycubeLevel(descriptor.bottomY ?? 0);

      return terrainPieceDescriptorsAtGridOrNeighbor(neighborX, neighborY, now).some((neighbor) => {
        if (neighbor.type !== "ice_block" || !canRenderTerrainPolycube(neighbor)) {
          return false;
        }

        return (
          terrainPolycubeLevel(neighbor.bottomY) <= slopeLevel &&
          terrainPolycubeLevel(neighbor.topY) > slopeLevel
        );
      });
    }

    function iceSlopeBottomHasIceBlockContact(cell, descriptor, now) {
      const slopeLevel = terrainPolycubeLevel(descriptor.bottomY ?? 0);

      return terrainPieceDescriptorsAt(cell.gridX, cell.gridY, now).some((neighbor) => {
        if (neighbor.type !== "ice_block" || !canRenderTerrainPolycube(neighbor)) {
          return false;
        }

        return terrainPolycubeLevel(neighbor.topY) === slopeLevel;
      });
    }

    function iceSlopeContactForGridOffset(direction, dx, dy) {
      const vector = cardinalGridVector(direction);

      if (dx === vector.dx && dy === vector.dy) {
        return "high";
      }

      if (dx === -vector.dx && dy === -vector.dy) {
        return "low";
      }

      if (dx < 0) {
        return "left-side";
      }

      if (dx > 0) {
        return "right-side";
      }

      if (dy < 0) {
        return "top-side";
      }

      return "bottom-side";
    }

    function iceSlopeLevelRange(descriptor) {
      const bottomY = descriptor.bottomY ?? 0;

      return {
        bottom: terrainPolycubeLevel(bottomY),
        top: terrainPolycubeLevel(descriptor.topY ?? bottomY + elevationUnit)
      };
    }

    function iceSlopeDescriptorsCanMergeAtContact(base, neighbor, contact, neighborContact) {
      if (neighbor.type !== "ice_slope") {
        return false;
      }

      const baseDirection = normalizeCardinalDirection(base.layer?.direction);
      const neighborDirection = normalizeCardinalDirection(neighbor.layer?.direction);
      const baseRange = iceSlopeLevelRange(base);
      const neighborRange = iceSlopeLevelRange(neighbor);

      if (neighborDirection === baseDirection) {
        if (baseRange.bottom === neighborRange.bottom && baseRange.top === neighborRange.top) {
          return true;
        }

        if (contact === "high") {
          return neighborRange.bottom === baseRange.top;
        }

        if (contact === "low") {
          return neighborRange.top === baseRange.bottom;
        }
      }

      if (
        contact === "high" &&
        neighborContact === "high" &&
        baseRange.bottom === neighborRange.bottom &&
        baseRange.top === neighborRange.top
      ) {
        return true;
      }

      return false;
    }

    function iceSlopeSuppressedEdgeContacts(cell, descriptor, now) {
      const direction = normalizeCardinalDirection(descriptor.layer?.direction);
      const contacts = new Set();

      if (iceSlopeHighSideHasIceBlockContact(cell, descriptor, now)) {
        contacts.add("high");
      }

      if (iceSlopeBottomHasIceBlockContact(cell, descriptor, now)) {
        contacts.add("bottom");
      }

      [
        { dx: -1, dy: 0 },
        { dx: 1, dy: 0 },
        { dx: 0, dy: -1 },
        { dx: 0, dy: 1 }
      ].forEach(({ dx, dy }) => {
        const neighborX = cell.gridX + dx;
        const neighborY = cell.gridY + dy;
        const contact = iceSlopeContactForGridOffset(direction, dx, dy);

        if (
          terrainPieceDescriptorsAtGridOrNeighbor(neighborX, neighborY, now).some((neighbor) => {
            const neighborContact = iceSlopeContactForGridOffset(
              neighbor.layer?.direction,
              -dx,
              -dy
            );

            return iceSlopeDescriptorsCanMergeAtContact(
              descriptor,
              neighbor,
              contact,
              neighborContact
            );
          })
        ) {
          contacts.add(contact);
        }
      });

      return contacts;
    }

    function addIceSlopeEditorPickVolume(centerX, centerZ, bottomY, descriptor, editorPick) {
      if (!isEditorRenderMode() || !editorPick) {
        return;
      }

      const height = Math.max(1, (descriptor.topY ?? bottomY + elevationUnit) - bottomY);
      const pickMesh = new THREE.Mesh(
        boxGeometry(unit * 0.96, height, unit * 0.96),
        invisibleEditorPickMaterial()
      );

      pickMesh.position.set(centerX, bottomY + height / 2, centerZ);
      pickMesh.castShadow = false;
      pickMesh.receiveShadow = false;
      pickMesh.userData.editorPick = editorPickForRenderContext(editorPick);
      scene.add(pickMesh);
    }

    function addIceSlopeCell(cell, descriptor, visibility, now) {
      const centerX = (cell.left + cell.right) / 2 + renderOffsetX();
      const centerZ = (cell.top + cell.bottom) / 2 + renderOffsetZ();
      const bottomY = descriptor.bottomY ?? descriptor.topY - descriptor.blockHeight;
      const suppressContacts = iceSlopeSuppressedEdgeContacts(cell, descriptor, now);
      const editorPick = {
        kind: "terrain",
        cells: [
          {
            gridX: cell.gridX,
            gridY: cell.gridY,
            left: cell.left + renderOffsetX(),
            right: cell.right + renderOffsetX(),
            top: cell.top + renderOffsetZ(),
            bottom: cell.bottom + renderOffsetZ()
          }
        ],
        topY: descriptor.topY,
        bottomY,
        sourceLayer: descriptor.elevation ?? 0
      };

      addOutlinedMesh(
        iceSlopeGeometry(descriptor.layer?.direction),
        terrainColor(descriptor.type),
        {
          x: centerX,
          y: bottomY,
          z: centerZ
        },
        {
          edgeGeometry: iceSlopeEdgeGeometry(descriptor.layer?.direction, {
            suppressContacts
          }),
          edgeThreshold: 18,
          opacity: visibility,
          doubleSide: true,
          castShadow: renderContextCastsShadows(),
          receiveShadow: true,
          editorPick
        }
      );

      addIceSlopeEditorPickVolume(centerX, centerZ, bottomY, descriptor, editorPick);
    }

    function addTerrainComponent(cells, descriptor, now) {
      if (descriptor.isVoid) {
        return;
      }

      if (isModelTerrainType(descriptor.type)) {
        addTreeComponent(cells, descriptor, now);
        return;
      }

      const visibility = transitionPieceProgressForCells(cells);

      if (visibility <= 0.015) {
        return;
      }

      if (descriptor.type === "ice_slope") {
        cells.forEach((cell) => addIceSlopeCell(cell, descriptor, visibility, now));
        return;
      }

      if (descriptor.isLoweredPlayerLift || descriptor.isLoweredOrangeSurface || descriptor.isSurfacePlayerGate) {
        addOutlinedMesh(
          componentTopPlaneGeometry(cells),
          terrainColor(descriptor.type),
          { x: renderOffsetX(), y: descriptor.topY, z: renderOffsetZ() },
          {
            edgeThreshold: 18,
            opacity: visibility,
            polygonOffset: descriptor.isSurfacePlayerGate,
            polygonOffsetFactor: -6,
            polygonOffsetUnits: -6,
            renderOrder: descriptor.isSurfacePlayerGate ? 20 : 0,
            castShadow: false,
            receiveShadow: !descriptor.isLoweredPlayerLift,
            editorPick: {
              kind: "terrain",
              cells: cells.map((cell) => ({
                gridX: cell.gridX,
                gridY: cell.gridY,
                left: cell.left + renderOffsetX(),
                right: cell.right + renderOffsetX(),
                top: cell.top + renderOffsetZ(),
                bottom: cell.bottom + renderOffsetZ()
              })),
              topY: descriptor.topY,
              bottomY: descriptor.bottomY,
              sourceLayer: descriptor.elevation ?? 0
            }
          }
        );
        return;
      }

      addComponent(cells, descriptor.blockHeight, terrainColor(descriptor.type), descriptor.topY, {
        outline: shouldOutlineTerrainRegion(descriptor),
        radius: shapeCornerRadius,
        rounded: !descriptor.isSunkenFloor,
        castShadow:
          !descriptor.isLoweredPlayerLift &&
          (descriptor.terrainHeight ?? 0) > 0 &&
          renderContextCastsShadows(),
        receiveShadow: descriptor.type !== "orange_wall",
        opacity: visibility,
        editorPick: {
          kind: "terrain",
          cells: cells.map((cell) => ({
            gridX: cell.gridX,
            gridY: cell.gridY,
            left: cell.left + renderOffsetX(),
            right: cell.right + renderOffsetX(),
            top: cell.top + renderOffsetZ(),
            bottom: cell.bottom + renderOffsetZ()
          })),
          topY: descriptor.topY,
          bottomY: descriptor.bottomY ?? descriptor.topY - descriptor.blockHeight,
          sourceLayer: descriptor.elevation ?? 0
        },
        edgeOptions: {
          descriptor,
          now,
          offsetX: renderOffsetX(),
          offsetZ: renderOffsetZ(),
          suppressSharedRoomEdges: descriptor.type === "wall"
        },
        offsetX: renderOffsetX(),
        offsetZ: renderOffsetZ()
      });
    }

    function addSegment(positions, seenSegments, fromX, fromZ, toX, toZ, y) {
      const keyParts = [
        `${Math.round(fromX * 1000)},${Math.round(fromZ * 1000)}`,
        `${Math.round(toX * 1000)},${Math.round(toZ * 1000)}`
      ].sort();
      const key = `${Math.round(y * 1000)}:${keyParts[0]}:${keyParts[1]}`;

      if (seenSegments.has(key)) {
        return;
      }

      seenSegments.add(key);
      positions.push(fromX, y, fromZ, toX, y, toZ);
    }

    function addFloorGridLines(descriptors) {
      const positions = [];
      const seenSegments = new Set();
      const state = renderState();

      for (let y = 0; y < state.height; y += 1) {
        for (let x = 0; x < state.width; x += 1) {
          const descriptor = descriptors[y][x];

          if (!isGridFloorDescriptor(descriptor)) {
            continue;
          }

          const x0 = x * unit + renderOffsetX();
          const x1 = (x + 1) * unit + renderOffsetX();
          const z0 = y * unit + renderOffsetZ();
          const z1 = (y + 1) * unit + renderOffsetZ();
          const lineY = descriptor.topY + Math.max(0.5, unit * 0.006);

          addSegment(positions, seenSegments, x0, z0, x1, z0, lineY);
          addSegment(positions, seenSegments, x1, z0, x1, z1, lineY);
          addSegment(positions, seenSegments, x1, z1, x0, z1, lineY);
          addSegment(positions, seenSegments, x0, z1, x0, z0, lineY);
        }
      }

      if (positions.length === 0) {
        return;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      scene.add(new THREE.LineSegments(
        geometry,
        floorGridMaterial(0.34 * transitionSceneVisibility())
      ));
    }

    function addTerrainRegions(now = performance.now()) {
      const descriptors = [];
      const pieceMaps = [];
      const pieceDescriptorRows = [];
      const pieceEntries = [];
      const polycubePieceEntries = [];
      const animatedOrangeEntries = [];
      const state = renderState();

      for (let y = 0; y < state.height; y += 1) {
        const descriptorRow = [];
        const pieceMapRow = [];
        const pieceDescriptorRow = [];

        for (let x = 0; x < state.width; x += 1) {
          descriptorRow.push(terrainDescriptorAt(x, y, now));

          const pieceMap = new Map();
          const pieceDescriptors = terrainPieceDescriptorsAt(x, y, now);

          pieceDescriptors.forEach((descriptor) => {
            if (canRenderTerrainPolycube(descriptor)) {
              polycubePieceEntries.push({ descriptor, x, y });
              return;
            }

            if (canRenderAnimatedOrangeSolid(descriptor)) {
              animatedOrangeEntries.push({ descriptor, x, y });
              return;
            }

            pieceMap.set(descriptor.key, descriptor);
            pieceEntries.push({ descriptor, x, y });
          });
          pieceDescriptorRow.push(pieceDescriptors);
          pieceMapRow.push(pieceMap);
        }

        descriptors.push(descriptorRow);
        pieceMaps.push(pieceMapRow);
        pieceDescriptorRows.push(pieceDescriptorRow);
      }

      const previousTerrainDescriptors = activeRenderContext?.terrainDescriptors;

      if (activeRenderContext) {
        activeRenderContext.terrainDescriptors = descriptors;
      }

      addTerrainPolycubeRegions(polycubePieceEntries, now);
      addAnimatedOrangeSolidRegion(animatedOrangeEntries);

      const visitedPieces = new Set();
      const pieceVisitKey = (x, y, key) => `${x},${y}:${key}`;

      pieceEntries.forEach((entry) => {
        const firstKey = pieceVisitKey(entry.x, entry.y, entry.descriptor.key);

        if (visitedPieces.has(firstKey)) {
          return;
        }

        const descriptor = entry.descriptor;
        const stack = [{ x: entry.x, y: entry.y }];
        const cells = [];
        visitedPieces.add(firstKey);

        while (stack.length > 0) {
          const current = stack.pop();
          cells.push({
            gridX: current.x,
            gridY: current.y,
            left: current.x * unit,
            right: (current.x + 1) * unit,
            top: current.y * unit,
            bottom: (current.y + 1) * unit
          });

          [
            { x: current.x + 1, y: current.y },
            { x: current.x - 1, y: current.y },
            { x: current.x, y: current.y + 1 },
            { x: current.x, y: current.y - 1 }
          ].forEach((neighbor) => {
            if (
              neighbor.x < 0 ||
              neighbor.y < 0 ||
              neighbor.x >= state.width ||
              neighbor.y >= state.height ||
              !pieceMaps[neighbor.y][neighbor.x].has(descriptor.key)
            ) {
              return;
            }

            const neighborKey = pieceVisitKey(neighbor.x, neighbor.y, descriptor.key);

            if (visitedPieces.has(neighborKey)) {
              return;
            }

            visitedPieces.add(neighborKey);
            stack.push(neighbor);
          });
        }

        addTerrainComponent(cells, descriptor, now);
      });

      if (activeRenderContext) {
        activeRenderContext.terrainDescriptors = previousTerrainDescriptors;
      }

      if (shouldRenderFloorGridLines()) {
        addFloorGridLines(descriptors);
      }

      if (shouldRenderTileTopDetails()) {
        for (let y = 0; y < state.height; y += 1) {
          for (let x = 0; x < state.width; x += 1) {
            const descriptor = descriptors[y][x];
            const liftDescriptors = (pieceDescriptorRows[y]?.[x] || []).filter(
              (pieceDescriptor) => pieceDescriptor.layer?.type === "player_lift"
            );

            liftDescriptors.forEach((liftDescriptor) => {
              addTileTopDetails(x, y, liftDescriptor.layer, liftDescriptor.topY, now);
            });

            if (descriptor.layer?.type !== "player_lift") {
              addTileTopDetails(x, y, descriptor.layer, descriptor.topY, now);
            }
          }
        }

        addTerrainOrangeButtonOverlays(now);
      }
    }

    function actorFadeVisibility(actor) {
      const fallbackVisibility = actor.removed ? 0 : 1;
      const alpha = actor.renderAlpha ?? fallbackVisibility;
      const scale = actorVisualScale(actor);

      return actor.renderInHole ? Math.min(alpha, scale) : alpha;
    }

    function actorOpacity(actor) {
      return actor.renderInHole ? 1 : actorFadeVisibility(actor);
    }

    function actorRenderColor(actor) {
      const color = actorColor(actor);

      if (!actor.renderInHole) {
        return color;
      }

      return dimHexColor(color, actorFadeVisibility(actor));
    }

    function actorIsVisible(actor) {
      return (
        actorFadeVisibility(actor) > 0.001 &&
        actorVisualScale(actor) > 0.001
      );
    }

    function addWeightlessActorGroups() {
      const renderedActors = new Set();
      const columnsByCell = new Map();
      const groups = new Map();
      const polycubeGroups = new Map();
      const state = renderState();
      const rounded = (value) => Math.round(value * 1000);
      const levelValue = (value) => value / elevationUnit;
      const roundedLevel = (value) => Math.round(levelValue(value));
      const baseLevel = (value) => {
        const nearest = roundedLevel(value);

        return Math.abs(levelValue(value) - nearest) <= 0.001
          ? nearest
          : Math.floor(levelValue(value));
      };
      const columnHeightLevels = (column) => roundedLevel(column.topY - column.bottomY);
      const hasWholeLevelHeight = (column) =>
        Math.abs(levelValue(column.topY - column.bottomY) - columnHeightLevels(column)) <= 0.001;
      const columnYOffset = (column) => column.bottomY - baseLevel(column.bottomY) * elevationUnit;
      const columnRenderOffsetX = (column) => column.renderX - column.gridX;
      const columnRenderOffsetY = (column) => column.renderY - column.gridY;
      const entryCellKey = (entry) => [
        entry.groupId,
        entry.gridX,
        entry.gridY,
        rounded(entry.renderX),
        rounded(entry.renderY),
        rounded(entry.scale),
        rounded(entry.sink),
        entry.actor.renderInHole ? 1 : 0
      ].join(":");
      const columnGroupKey = (column) => [
        column.groupId,
        rounded(column.bottomY),
        rounded(column.topY),
        rounded(column.scale),
        rounded(column.sink),
        column.hasHoleFade ? 1 : 0
      ].join(":");
      const isGroupedPolycubeActor = (actor) =>
        actor?.type === "weightless_box" || actor?.type === "clone";
      const canMergeStackedWeightlessEntries = (lower, upper) =>
        lower.groupId === upper.groupId &&
        lower.actor.type === upper.actor.type &&
        !lower.actor.renderInHole &&
        !upper.actor.renderInHole &&
        Math.abs(lower.scale - upper.scale) <= 0.001 &&
        Math.abs(lower.sink - upper.sink) <= 0.001 &&
        Math.abs(lower.topY - upper.bottomY) <= 0.001;
      const canRenderPolycubeColumn = (column) =>
        !column.hasHoleFade &&
        Math.abs(column.scale - 1) <= 0.001 &&
        Math.abs(column.sink) <= 0.001 &&
        hasWholeLevelHeight(column) &&
        columnHeightLevels(column) > 0;
      const polycubeGroupKey = (column) => [
        column.groupId,
        rounded(columnRenderOffsetX(column)),
        rounded(columnRenderOffsetY(column)),
        rounded(columnYOffset(column)),
        rounded(column.scale),
        rounded(column.sink)
      ].join(":");
      const addColumnToGroup = (targetGroups, key, column) => {
        if (!targetGroups.has(key)) {
          targetGroups.set(key, []);
        }

        targetGroups.get(key).push(column);
      };
      const renderPolycubeComponent = (voxels) => {
        const columns = Array.from(new Set(voxels.map((voxel) => voxel.column)));
        const visibility = transitionPieceProgressForCells(columns);

        if (visibility <= 0.015) {
          return;
        }

        const opacity = Math.min(...columns.map((column) => column.opacity)) * visibility;
        const fade = Math.min(...columns.map((column) => column.fade));
        const edgeOpacity = fade * visibility;
        const bottomY = Math.min(...columns.map((column) => column.bottomY));
        const topY = Math.max(...columns.map((column) => column.topY));
        const renderOffset = {
          x: columnRenderOffsetX(columns[0]) * unit,
          y: columnYOffset(columns[0]),
          z: columnRenderOffsetY(columns[0]) * unit
        };
        const cells = Array.from(
          columns
            .reduce((cellMap, column) => {
              const key = `${column.gridX},${column.gridY}`;

              if (!cellMap.has(key)) {
                cellMap.set(key, {
                  gridX: column.gridX,
                  gridY: column.gridY,
                  left: column.renderX * unit + renderOffsetX(),
                  right: (column.renderX + 1) * unit + renderOffsetX(),
                  top: column.renderY * unit + renderOffsetZ(),
                  bottom: (column.renderY + 1) * unit + renderOffsetZ()
                });
              }

              return cellMap;
            }, new Map())
            .values()
        );

        addOutlinedMesh(
          polycubeGeometry(voxels),
          actorColor(columns[0].actor),
          renderOffset,
          {
            edgeGeometry: polycubeEdgeGeometry(voxels),
            edgeThreshold: 18,
            opacity,
            edgeOpacity,
            castShadow: renderContextCastsShadows(),
            receiveShadow: false,
            editorPick: {
              kind: "actor",
              cells,
              voxelPick: true,
              topY,
              bottomY
            }
          }
        );

        addWeightlessGroupFaceLabels(
          voxels,
          columns[0].groupId,
          renderOffset,
          Math.min(0.92, edgeOpacity)
        );
      };
      const renderPolycubeGroup = (columns) => {
        const voxels = [];

        columns.forEach((column) => {
          const bottomLevel = baseLevel(column.bottomY);
          const topLevel = bottomLevel + columnHeightLevels(column);

          for (let z = bottomLevel; z < topLevel; z += 1) {
            voxels.push({
              column,
              x: column.gridX,
              y: column.gridY,
              z
            });
          }
        });

        polycubeComponents(voxels).forEach(renderPolycubeComponent);
      };

      state.actors.forEach((actor, index) => {
        if (!isGroupedPolycubeActor(actor) || !actorIsVisible(actor)) {
          return;
        }

        if (
          activeRenderContext?.hidePlayers &&
          (
            typeof app.isMainPlayerActor === "function"
              ? app.isMainPlayerActor(actor)
              : app.isPlayerActor?.(actor) && actor?.type !== "clone"
          )
        ) {
          return;
        }

        renderedActors.add(actor);
        const scale = actorVisualScale(actor);
        const height = actorCuboidHeight(scale);
        const elevation = actor.renderElevation ?? actor.elevation ?? 0;
        const sink = actor.renderSink ?? 0;
        const bottomY = elevation * elevationUnit - sink + actorVisualLift;
        const renderX = actor.renderX ?? actor.x;
        const renderY = actor.renderY ?? actor.y;
        const entry = {
          actor,
          bottomY,
          fade: actorFadeVisibility(actor),
          gridX: actor.x,
          gridY: actor.y,
          groupId: actor.groupId || `${actor.type}-${index}`,
          height,
          index,
          opacity: actorOpacity(actor),
          renderX,
          renderY,
          scale,
          sink,
          topY: bottomY + height
        };
        const key = entryCellKey(entry);

        if (!columnsByCell.has(key)) {
          columnsByCell.set(key, []);
        }

        columnsByCell.get(key).push(entry);
      });

      columnsByCell.forEach((entries) => {
        const columns = [];

        entries
          .slice()
          .sort((left, right) => left.bottomY - right.bottomY || left.topY - right.topY)
          .forEach((entry) => {
            const previous = columns[columns.length - 1];

            if (!previous || !canMergeStackedWeightlessEntries(previous, entry)) {
              columns.push({
                ...entry,
                actors: [entry.actor],
                hasHoleFade: Boolean(entry.actor.renderInHole)
              });
              return;
            }

            previous.actors.push(entry.actor);
            previous.fade = Math.min(previous.fade, entry.fade);
            previous.hasHoleFade = previous.hasHoleFade || Boolean(entry.actor.renderInHole);
            previous.height = entry.topY - previous.bottomY;
            previous.opacity = Math.min(previous.opacity, entry.opacity);
            previous.topY = entry.topY;
          });

        columns.forEach((column) => {
          if (canRenderPolycubeColumn(column)) {
            addColumnToGroup(polycubeGroups, polycubeGroupKey(column), column);
            return;
          }

          addColumnToGroup(groups, columnGroupKey(column), column);
        });
      });

      polycubeGroups.forEach(renderPolycubeGroup);

      groups.forEach((columns) => {
        const cellsByKey = new Map();

        columns.forEach((column) => {
          const gridX = column.gridX;
          const gridY = column.gridY;
          const key = `${gridX},${gridY}`;

          if (!cellsByKey.has(key)) {
            cellsByKey.set(key, {
              actor: column.actor,
              actors: column.actors,
              bottomY: column.bottomY,
              fade: column.fade,
              gridX,
              gridY,
              hasHoleFade: column.hasHoleFade,
              height: column.height,
              opacity: column.opacity,
              renderX: column.renderX,
              renderY: column.renderY,
              scale: column.scale,
              sink: column.sink,
              topY: column.topY
            });
          }
        });

        const visited = new Set();

        cellsByKey.forEach((startCell, startKey) => {
          if (visited.has(startKey)) {
            return;
          }

          const stack = [startCell];
          const component = [];
          visited.add(startKey);

          while (stack.length > 0) {
            const current = stack.pop();
            component.push(current);

            [
              { x: current.gridX + 1, y: current.gridY },
              { x: current.gridX - 1, y: current.gridY },
              { x: current.gridX, y: current.gridY + 1 },
              { x: current.gridX, y: current.gridY - 1 }
            ].forEach((neighbor) => {
              const neighborKey = `${neighbor.x},${neighbor.y}`;

              if (!cellsByKey.has(neighborKey) || visited.has(neighborKey)) {
                return;
              }

              visited.add(neighborKey);
              stack.push(cellsByKey.get(neighborKey));
            });
          }

          const visibility = transitionPieceProgressForCells(component);

          if (visibility <= 0.015) {
            return;
          }

          const scale = Math.min(...component.map((cell) => cell.scale));
          const fade = Math.min(...component.map((cell) => cell.fade));
          const hasHoleFade = component.some((cell) => cell.hasHoleFade);
          const usesStaticGeometry = component.every((cell) => {
            return (
              !hasHoleFade &&
              Math.abs(scale - 1) <= 0.001 &&
              Math.abs(cell.renderX - cell.gridX) <= 0.001 &&
              Math.abs(cell.renderY - cell.gridY) <= 0.001
            );
          });
          const opacity =
            Math.min(...component.map((cell) => cell.opacity)) *
            visibility;
          const edgeOpacity = fade * visibility;
          const color = hasHoleFade
            ? dimHexColor(actorColor(component[0].actor), fade)
            : actorColor(component[0].actor);
          const height = component[0].height;
          const topY = component[0].topY;
          const unscaledCells = component.map((cell) => {
            return {
              gridX: cell.gridX,
              gridY: cell.gridY,
              left: cell.renderX * unit + renderOffsetX(),
              right: (cell.renderX + 1) * unit + renderOffsetX(),
              top: cell.renderY * unit + renderOffsetZ(),
              bottom: (cell.renderY + 1) * unit + renderOffsetZ()
            };
          });
          const bounds = unscaledCells.reduce(
            (currentBounds, cell) => ({
              left: Math.min(currentBounds.left, cell.left),
              right: Math.max(currentBounds.right, cell.right),
              top: Math.min(currentBounds.top, cell.top),
              bottom: Math.max(currentBounds.bottom, cell.bottom)
            }),
            { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
          );
          const centerX = (bounds.left + bounds.right) / 2;
          const centerZ = (bounds.top + bounds.bottom) / 2;
          const geometryCells = unscaledCells.map((cell) => ({
            gridX: cell.gridX,
            gridY: cell.gridY,
            left: centerX + (cell.left - centerX) * scale,
            right: centerX + (cell.right - centerX) * scale,
            top: centerZ + (cell.top - centerZ) * scale,
            bottom: centerZ + (cell.bottom - centerZ) * scale
          }));

          addComponent(geometryCells, height, color, topY, {
            cacheKey: usesStaticGeometry ? undefined : false,
            radius: shapeCornerRadius,
            opacity,
            edgeOpacity,
            castShadow: renderContextCastsShadows(),
            receiveShadow: false,
            editorPick: {
              kind: "actor",
              cells: geometryCells.map((cell) => ({
                gridX: cell.gridX,
                gridY: cell.gridY,
                left: cell.left,
                right: cell.right,
                top: cell.top,
                bottom: cell.bottom
              })),
              topY,
              bottomY: topY - height
            }
          });
        });
      });

      return renderedActors;
    }

    function gemModelPlacement(model, x, z, elevation, sink, scale, now, actor) {
      const bounds = model.bounds;
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();

      bounds.getSize(size);
      bounds.getCenter(center);

      const maxModelSize = Math.max(size.x, size.y, size.z, 0.001);
      const modelScale = (gemModelWorldSize / maxModelSize) * scale;
      const hover = Math.max(0, app.floatingFloorHoverOffset(actor, now));

      return {
        bottomY: elevation * elevationUnit - sink + actorVisualLift + hover + unit * 0.14,
        center,
        scale: modelScale,
        spin: ((now % gemSpinPeriodMs) / gemSpinPeriodMs) * Math.PI * 2 + (actor.hoverSeed || 0)
      };
    }

    function gemEditorPick(actor, topY, bottomY) {
      return editorPickForRenderContext({
        kind: "actor",
        cells: [
          {
            gridX: actor.x,
            gridY: actor.y,
            left: (actor.renderX ?? actor.x) * unit + renderOffsetX(),
            right: ((actor.renderX ?? actor.x) + 1) * unit + renderOffsetX(),
            top: (actor.renderY ?? actor.y) * unit + renderOffsetZ(),
            bottom: ((actor.renderY ?? actor.y) + 1) * unit + renderOffsetZ()
          }
        ],
        topY,
        bottomY,
        sourceLayer: Math.max(0, Math.floor(Number(actor.elevation) || 0))
      });
    }

    function addGemEditorPickVolume(actor, x, z, editorPick) {
      if (!isEditorRenderMode() || !editorPick) {
        return;
      }

      const elevation = Math.max(0, Math.floor(Number(actor.elevation) || 0));
      const bottomY = elevation * elevationUnit + unit * 0.06;
      const height = unit * 0.88;
      const pickMesh = new THREE.Mesh(
        boxGeometry(unit, height, unit),
        invisibleEditorPickMaterial()
      );

      pickMesh.position.set(x, bottomY + height / 2, z);
      pickMesh.userData.editorPick = editorPick;
      scene.add(pickMesh);
    }

    function addGemModel(actor, model, x, z, elevation, sink, scale, opacity, visibility, now) {
      const placement = gemModelPlacement(model, x, z, elevation, sink, scale, now, actor);
      const group = new THREE.Group();
      const topY = placement.bottomY + (model.bounds.max.y - model.bounds.min.y) * placement.scale;
      const editorPick = gemEditorPick(actor, topY, placement.bottomY);

      addGemEditorPickVolume(actor, x, z, editorPick);
      group.position.set(x, placement.bottomY, z);
      group.scale.setScalar(placement.scale);
      group.rotation.y = placement.spin;
      group.userData.gemSpinGroup = true;

      model.parts.forEach((part) => {
        const mesh = new THREE.Mesh(part.geometry, material(part.color || actorRenderColor(actor), opacity));

        mesh.position.set(-placement.center.x, -model.bounds.min.y, -placement.center.z);
        mesh.castShadow = renderContextCastsShadows();
        mesh.receiveShadow = false;
        mesh.userData.editorPick = editorPick;
        group.add(mesh);
      });

      scene.add(group);

      if (!edgeOutlinesEnabled()) {
        return;
      }

      const edgeOpacity = actorFadeVisibility(actor) * visibility * renderContextOpacity();

      if (edgeOpacity <= 0.015) {
        return;
      }

      const edgeGroup = new THREE.Group();

      edgeGroup.position.copy(group.position);
      edgeGroup.scale.copy(group.scale);
      edgeGroup.rotation.copy(group.rotation);
      edgeGroup.userData.edgeBasePosition = group.position.clone();
      edgeGroup.userData.gemSpinGroup = true;

      model.parts.forEach((part) => {
        const edges = new THREE.LineSegments(
          edgeGeometryFor(part.geometry, 28),
          lineMaterial("#000000", edgeOpacity)
        );

        edges.position.set(-placement.center.x, -model.bounds.min.y, -placement.center.z);
        edgeGroup.add(edges);
      });

      edgeScene.add(edgeGroup);
    }

    function addGemFallback(actor, x, z, elevation, sink, scale, fade, visibility, opacity, now) {
      const gem = new THREE.Mesh(
        octahedronGeometry(unit * 0.22 * scale),
        material(actorRenderColor(actor), opacity)
      );

      gem.position.set(
        x,
        elevation * elevationUnit - sink + actorVisualLift + unit * 0.32 + Math.max(0, app.floatingFloorHoverOffset(actor, now)),
        z
      );
      gem.userData.editorPick = gemEditorPick(
        actor,
        gem.position.y + unit * 0.22 * scale,
        gem.position.y - unit * 0.22 * scale
      );
      addGemEditorPickVolume(actor, x, z, gem.userData.editorPick);
      gem.castShadow = renderContextCastsShadows();
      gem.receiveShadow = false;
      scene.add(gem);

      addEdgeLines(gem.geometry, gem.position, 1, fade * visibility);
    }

    function addGem(actor, x, z, elevation, now) {
      const sink = actor.renderSink ?? 0;
      const scale = actorVisualScale(actor);
      const visibility = transitionPieceProgressForCell(actor.x, actor.y);
      const fade = actorFadeVisibility(actor);
      const opacity = actorOpacity(actor) * visibility;

      if (visibility <= 0.015 || opacity <= 0.015) {
        return;
      }

      const model = requestModelAsset(actor.modelUrl);

      if (model) {
        addGemModel(actor, model, x, z, elevation, sink, scale, opacity, visibility, now);
        return;
      }

      addGemFallback(actor, x, z, elevation, sink, scale, fade, visibility, opacity, now);
    }

    function addFloatingFloor(actor, center, elevation, scale, sink, fade, opacity, visibility, now) {
      const hover = Math.max(0, app.floatingFloorHoverOffset(actor, now));
      const width = unit * scale;
      const depth = unit * scale;
      const height = Math.max(4, unit * 0.32 * scale);
      const bottomY = elevation * elevationUnit - sink + actorVisualLift + hover;
      const topY = bottomY + height;
      const actorBounds = {
        gridX: actor.x,
        gridY: actor.y,
        left: center.x - width / 2,
        right: center.x + width / 2,
        top: center.z - depth / 2,
        bottom: center.z + depth / 2
      };

      addTopRoundedCuboid(width, depth, height, shapeCornerRadius, actorRenderColor(actor), {
        x: center.x,
        y: topY,
        z: center.z
      }, {
        opacity,
        edgeOpacity: fade * visibility,
        castShadow: renderContextCastsShadows(),
        receiveShadow: false,
        editorPick: {
          kind: "actor",
          cells: [actorBounds],
          topY,
          bottomY
        }
      });
    }

    function normalizePuncherDirection(direction) {
      const value = String(direction || "").toLowerCase();

      if (value === "left" || value === "l") {
        return "left";
      }

      if (value === "up" || value === "u") {
        return "up";
      }

      if (value === "down" || value === "d") {
        return "down";
      }

      return "right";
    }

    function puncherDirectionVector(actor) {
      const direction = normalizePuncherDirection(actor?.direction || actor?.facing);

      if (direction === "left") {
        return { x: -1, z: 0 };
      }

      if (direction === "up") {
        return { x: 0, z: -1 };
      }

      if (direction === "down") {
        return { x: 0, z: 1 };
      }

      return { x: 1, z: 0 };
    }

    function puncherRotationForDirection(direction) {
      const rotation = new THREE.Euler(0, 0, 0);

      if (direction.x > 0) {
        rotation.z = -Math.PI / 2;
      } else if (direction.x < 0) {
        rotation.z = Math.PI / 2;
      } else if (direction.z > 0) {
        rotation.x = Math.PI / 2;
      } else {
        rotation.x = -Math.PI / 2;
      }

      return rotation;
    }

    function addOrientedEdgeLines(geometry, position, rotation, opacity, threshold = 18) {
      if (!edgeOutlinesEnabled()) {
        return;
      }

      const lineOpacity = opacity * renderContextOpacity();

      if (lineOpacity <= 0.015) {
        return;
      }

      const edges = new THREE.LineSegments(
        edgeGeometryFor(geometry, threshold),
        lineMaterial("#000000", lineOpacity)
      );

      edges.position.copy(position);
      edges.rotation.copy(rotation);
      edges.userData.edgeBasePosition = position.clone();
      edgeScene.add(edges);
    }

    function puncherEditorPick(actor, center, topY, bottomY) {
      const renderX = actor.renderX ?? actor.x;
      const renderY = actor.renderY ?? actor.y;

      return editorPickForRenderContext({
        kind: "actor",
        cells: [
          {
            gridX: actor.x,
            gridY: actor.y,
            left: renderX * unit + renderOffsetX(),
            right: (renderX + 1) * unit + renderOffsetX(),
            top: renderY * unit + renderOffsetZ(),
            bottom: (renderY + 1) * unit + renderOffsetZ()
          }
        ],
        topY,
        bottomY
      });
    }

    function puncherAnchoredCenter(center, direction, depth) {
      const backOffset = unit / 2 - depth / 2;

      return {
        x: center.x - direction.x * backOffset,
        z: center.z - direction.z * backOffset
      };
    }

    function addPuncherArm(actor, center, direction, depth, elevation, sink, opacity, edgeOpacity) {
      const renderX = actor.renderX ?? actor.x;
      const renderY = actor.renderY ?? actor.y;
      const movedDistance = Math.abs(renderX - actor.x) + Math.abs(renderY - actor.y);

      if (actor.renderPunchEffect !== true || movedDistance <= 0.001) {
        return;
      }

      const baseX = Number.isFinite(actor.renderPunchBaseX) ? actor.renderPunchBaseX : actor.x;
      const baseY = Number.isFinite(actor.renderPunchBaseY) ? actor.renderPunchBaseY : actor.y;
      const start = puncherAnchoredCenter(cellCenter(baseX, baseY), direction, depth);
      const end = center;
      const lengthX = Math.abs(end.x - start.x);
      const lengthZ = Math.abs(end.z - start.z);
      const horizontal = lengthX >= lengthZ;
      const width = Math.max(puncherArmThickness, lengthX + unit * 0.18);
      const armDepth = Math.max(puncherArmThickness, lengthZ + unit * 0.18);
      const height = unit * 0.16;
      // The arm length animates every frame; scale a shared unit box instead
      // of minting a new cached geometry per animation frame.
      const geometry = boxGeometry(1, 1, 1);
      const visibility = actorFadeVisibility(actor);
      const armColor = actor.renderInHole ? dimHexColor("#9ca3af", visibility) : "#9ca3af";
      const mesh = new THREE.Mesh(geometry, material(armColor, opacity));
      const position = new THREE.Vector3(
        (start.x + end.x) / 2,
        elevation * elevationUnit - sink + actorVisualLift + unit * 0.5,
        (start.z + end.z) / 2
      );

      mesh.position.copy(position);
      mesh.scale.set(
        horizontal ? width : puncherArmThickness,
        height,
        horizontal ? puncherArmThickness : armDepth
      );
      mesh.castShadow = renderContextCastsShadows();
      mesh.receiveShadow = false;
      scene.add(mesh);
      addEdgeLines(geometry, position, 18, edgeOpacity * 0.84, null, mesh.scale);
    }

    function addPuncherCylinderPart(
      actor,
      geometry,
      color,
      center,
      y,
      direction,
      rotation,
      offset,
      opacity,
      editorPick,
      edgeOpacity = opacity
    ) {
      const position = new THREE.Vector3(
        center.x + direction.x * offset,
        y,
        center.z + direction.z * offset
      );
      const mesh = new THREE.Mesh(geometry, material(color, opacity));

      mesh.position.copy(position);
      mesh.rotation.copy(rotation);
      mesh.castShadow = renderContextCastsShadows();
      mesh.receiveShadow = false;
      mesh.userData.editorPick = editorPick;
      scene.add(mesh);
      addOrientedEdgeLines(geometry, position, rotation, edgeOpacity, 18);
    }

    function addPuncher(actor, center, elevation, scale, sink, fade, opacity, visibility) {
      const direction = puncherDirectionVector(actor);
      const rotation = puncherRotationForDirection(direction);
      const radius = puncherRadius * scale;
      const depth = puncherDepth * scale;
      const anchoredCenter = puncherAnchoredCenter(center, direction, depth);
      const centerY = elevation * elevationUnit - sink + actorVisualLift + unit * 0.54 * scale;
      const bottomY = centerY - radius;
      const topY = centerY + radius;
      const editorPick = puncherEditorPick(actor, anchoredCenter, topY, bottomY);
      const edgeOpacity = fade * visibility;
      const backGeometry = cylinderGeometry(radius, depth, 40);
      const middleGeometry = cylinderGeometry(radius * 0.66, depth * 0.45, 40);
      const bullseyeGeometry = cylinderGeometry(radius * 0.34, depth * 0.5, 40);
      const partColor = (color) => actor.renderInHole ? dimHexColor(color, fade) : color;

      addPuncherArm(actor, anchoredCenter, direction, depth, elevation, sink, opacity, edgeOpacity);
      addPuncherCylinderPart(
        actor,
        backGeometry,
        partColor("#ef4444"),
        anchoredCenter,
        centerY,
        direction,
        rotation,
        0,
        opacity,
        editorPick,
        edgeOpacity
      );
      addPuncherCylinderPart(
        actor,
        middleGeometry,
        partColor("#f8fafc"),
        anchoredCenter,
        centerY,
        direction,
        rotation,
        depth * 0.58,
        opacity,
        editorPick,
        edgeOpacity
      );
      addPuncherCylinderPart(
        actor,
        bullseyeGeometry,
        partColor("#b91c1c"),
        anchoredCenter,
        centerY,
        direction,
        rotation,
        depth * 0.72,
        opacity,
        editorPick,
        edgeOpacity
      );
    }

    function addActor(actor, now = performance.now()) {
      if (!actorIsVisible(actor)) {
        return;
      }

      const visibility = transitionPieceProgressForCell(actor.x, actor.y);

      if (visibility <= 0.015) {
        return;
      }

      const renderX = actor.renderX ?? actor.x;
      const renderY = actor.renderY ?? actor.y;
      const center = cellCenter(renderX, renderY);
      const elevation = actor.renderElevation ?? actor.elevation ?? 0;
      const scale = actorVisualScale(actor);
      const sink = actor.renderSink ?? 0;
      const fade = actorFadeVisibility(actor);
      const opacity = actorOpacity(actor) * visibility;

      if (actor.type === "gem") {
        addGem(actor, center.x, center.z, elevation, now);
        return;
      }

      if (actor.type === "floating_floor") {
        addFloatingFloor(actor, center, elevation, scale, sink, fade, opacity, visibility, now);
        return;
      }

      if (actor.type === "orange_button") {
        const buttonHeight = orangeButtonHeight();
        const baseY = orangeButtonSurfaceBaseY(actor, elevation, sink, now);
        const renderX = actor.renderX ?? actor.x;
        const renderY = actor.renderY ?? actor.y;
        const editorPick = {
          kind: "actor",
          cells: [
            {
              gridX: actor.x,
              gridY: actor.y,
              left: renderX * unit + renderOffsetX(),
              right: (renderX + 1) * unit + renderOffsetX(),
              top: renderY * unit + renderOffsetZ(),
              bottom: (renderY + 1) * unit + renderOffsetZ()
            }
          ],
          topY: baseY + buttonHeight,
          bottomY: baseY,
          sourceLayer: elevation
        };

        addOrangeButtonMesh(center, baseY, opacity, fade * visibility, editorPick);
        return;
      }

      if (actor.type === "puncher") {
        addPuncher(actor, center, elevation, scale, sink, fade, opacity, visibility);
        return;
      }

      if (actor.type === "circle_player") {
        const radius = unit * 0.42 * scale;
        const body = new THREE.Mesh(
          new THREE.SphereGeometry(radius, 16, 12),
          material(actorRenderColor(actor), opacity)
        );
        body.position.set(center.x, elevation * elevationUnit - sink + actorVisualLift + radius, center.z);
        body.castShadow = renderContextCastsShadows();
        body.receiveShadow = false;
        scene.add(body);
        addEdgeLines(body.geometry, body.position, 20, fade * visibility);
        return;
      }

      const isPlayer = actor.type === "player";
      const width = unit * scale;
      const depth = unit * scale;
      const height = actorCuboidHeight(scale);
      const topY = elevation * elevationUnit - sink + actorVisualLift + height;
      const radius = shapeCornerRadius;
      const actorBounds = {
        gridX: actor.x,
        gridY: actor.y,
        left: center.x - width / 2,
        right: center.x + width / 2,
        top: center.z - depth / 2,
        bottom: center.z + depth / 2
      };

      addTopRoundedCuboid(width, depth, height, radius, actorRenderColor(actor), {
        x: center.x,
        y: topY,
        z: center.z
      }, {
        opacity,
        edgeOpacity: fade * visibility,
        castShadow: renderContextCastsShadows(),
        receiveShadow: false,
        editorPick: {
          kind: "actor",
          cells: [actorBounds],
          topY,
          bottomY: topY - height
        }
      });
    }

    function disposeSceneChildren(targetScene) {
      if (!targetScene) {
        return;
      }

      for (let i = targetScene.children.length - 1; i >= 0; i -= 1) {
        const child = targetScene.children[i];

        if (child.geometry && !cachedGeometryHas(child.geometry)) {
          child.geometry.dispose();
        }
      }

      targetScene.clear();
    }

    function disposeScene() {
      disposeSceneChildren(scene);
      disposeSceneChildren(edgeScene);
      playerLiftMarkerMeshes.clear();
      trackedActorObjects.clear();
      trackedStaticActorCodes.clear();
      trackedBuildStateRef = null;
      trackedBuildTerrainVersion = -1;
    }

    function geometryCacheHas(geometry) {
      return Boolean(geometry?.userData?.persistentGeometry);
    }

    function cachedGeometryHas(geometry) {
      return geometryCacheHas(geometry);
    }

    function transitionSet(values) {
      if (values instanceof Set) {
        return values;
      }

      return Array.isArray(values) ? new Set(values) : null;
    }

    function sortedTransitionSetSignature(values) {
      return Array.from(transitionSet(values) || []).sort().join(",");
    }

    function transitionResetProgress(progress) {
      const local = localProgress(progress, 0.44, 0.42);
      return app.easeInOutQuad ? app.easeInOutQuad(local) : local;
    }

    function resetActorRenderValue(actor, key, fallback) {
      return actor?.[key] ?? fallback;
    }

    function resetActorDefaultScale(actor) {
      return actor ? (actor.removed ? 0 : 1) : 0;
    }

    function resetActorDefaultAlpha(actor) {
      return actor ? (actor.removed ? 0 : 1) : 0;
    }

    function interpolatedResetActor(fromActor, targetActor, progress) {
      const source = fromActor || targetActor;
      const target = targetActor || fromActor;

      if (!source || !target) {
        return null;
      }

      const fromX = resetActorRenderValue(fromActor, "renderX", fromActor?.x ?? target.x ?? 0);
      const fromY = resetActorRenderValue(fromActor, "renderY", fromActor?.y ?? target.y ?? 0);
      const fromElevation = resetActorRenderValue(
        fromActor,
        "renderElevation",
        fromActor?.elevation ?? target.elevation ?? 0
      );
      const fromScale = resetActorRenderValue(fromActor, "renderScale", resetActorDefaultScale(fromActor));
      const fromAlpha = resetActorRenderValue(fromActor, "renderAlpha", resetActorDefaultAlpha(fromActor));
      const fromSink = resetActorRenderValue(
        fromActor,
        "renderSink",
        fromActor?.removed ? app.HOLE_SINK_DISTANCE : 0
      );
      const targetX = resetActorRenderValue(targetActor, "renderX", targetActor?.x ?? fromX);
      const targetY = resetActorRenderValue(targetActor, "renderY", targetActor?.y ?? fromY);
      const targetElevation = resetActorRenderValue(
        targetActor,
        "renderElevation",
        targetActor?.elevation ?? fromElevation
      );
      const targetScale = resetActorRenderValue(targetActor, "renderScale", resetActorDefaultScale(targetActor));
      const targetAlpha = resetActorRenderValue(targetActor, "renderAlpha", resetActorDefaultAlpha(targetActor));
      const targetSink = resetActorRenderValue(
        targetActor,
        "renderSink",
        targetActor?.removed ? app.HOLE_SINK_DISTANCE : 0
      );

      return {
        ...target,
        ...source,
        x: fromActor?.x ?? targetActor?.x ?? 0,
        y: fromActor?.y ?? targetActor?.y ?? 0,
        elevation: progress >= 1 ? targetElevation : fromActor?.elevation ?? targetActor?.elevation ?? 0,
        removed: false,
        renderX: lerp(fromX, targetX, progress),
        renderY: lerp(fromY, targetY, progress),
        renderElevation: lerp(fromElevation, targetElevation, progress),
        renderScale: lerp(fromScale, targetScale, progress),
        renderAlpha: lerp(fromAlpha, targetAlpha, progress),
        renderSink: lerp(fromSink, targetSink, progress),
        renderInHole: progress < 1 ? Boolean(fromActor?.renderInHole) : Boolean(targetActor?.renderInHole)
      };
    }

    function resetOutgoingLevelState(fromState, targetState, progress) {
      if (!targetState || progress <= 0) {
        return fromState;
      }

      const actors = [];
      const count = Math.max(fromState?.actors?.length || 0, targetState?.actors?.length || 0);

      for (let index = 0; index < count; index += 1) {
        const actor = interpolatedResetActor(
          fromState?.actors?.[index] || null,
          targetState?.actors?.[index] || null,
          progress
        );

        if (actor) {
          actors.push(actor);
        }
      }

      return {
        ...fromState,
        actors
      };
    }

    function transitionLiftLayerValue(state, layer, x, y) {
      const key = `${x},${y}`;

      if (layer.type === "player_gate") {
        const raisedPlayerGates = transitionSet(state?.raisedPlayerGates);
        return raisedPlayerGates
          ? raisedPlayerGates.has(key) ? 1 : 0
          : layer.raised === true ? 1 : 0;
      }

      if (layer.type === "player_lift") {
        return layer.raised === true ? 1 : 0;
      }

      if (layer.type === "orange_wall") {
        const raisedOrangeWalls = transitionSet(state?.raisedOrangeWalls);
        return raisedOrangeWalls
          ? raisedOrangeWalls.has(key) ? 1 : 0
          : layer.raised === true ? 1 : 0;
      }

      return null;
    }

    function matchingTransitionLiftLayer(targetState, sourceLayer, x, y) {
      return renderTerrainLayersAt(x, y, targetState).find(
        (layer) =>
          layer.type === sourceLayer.type &&
          (layer.elevation ?? 0) === (sourceLayer.elevation ?? 0)
      );
    }

    function transitionSurfaceLiftValues(fromState, targetState, progress) {
      if (!targetState || progress <= 0) {
        return null;
      }

      const lifts = new Map();

      for (let y = 0; y < fromState.height; y += 1) {
        for (let x = 0; x < fromState.width; x += 1) {
          renderTerrainLayersAt(x, y, fromState).forEach((layer) => {
            const fromLift = transitionLiftLayerValue(fromState, layer, x, y);

            if (fromLift === null) {
              return;
            }

            const targetLayer = matchingTransitionLiftLayer(targetState, layer, x, y);
            const targetLift = targetLayer
              ? transitionLiftLayerValue(targetState, targetLayer, x, y)
              : fromLift;

            lifts.set(`${layer.type}:${x},${y}`, lerp(fromLift, targetLift ?? fromLift, progress));
          });
        }
      }

      return lifts;
    }

    function sceneLightBounds() {
      if (app.isFlyoverMode) {
        return flyoverStaticBounds();
      }

      const actionBounds = worldActionBounds();

      if (actionBounds) {
        return actionBounds;
      }

      if (isWorldViewPlayMode() && !app.levelTransition) {
        // Keep the shadow frustum on the current room; distant rooms are
        // dimmed scenery and a world-spanning 1024px shadow map would be
        // spread far too thin.
        return {
          minX: 0,
          maxX: Math.max(1, app.state.width) * unit,
          minZ: 0,
          maxZ: Math.max(1, app.state.height) * unit
        };
      }

      const transition = app.levelTransition?.transitionData;

      if (transition?.kind !== "adjacent-scene" || !transition.outgoingLevel) {
        return surroundingLevelBounds(surroundingLevelViews());
      }

      const outgoingState = transition.outgoingLevel;
      const incomingState = runtimeLevelState();
      const incomingOffset = transitionIncomingOffset(
        outgoingState,
        incomingState,
        transition.dx,
        transition.dy
      );
      const progress = transitionProgress();
      const transitionViews = transition.lightweightTransition === true
        ? []
        : transitionSurroundingLevelViews(
            transition,
            outgoingState,
            incomingState,
            incomingOffset,
            progress
          );
      const bounds = surroundingLevelBounds(transitionViews);

      return {
        minX: Math.min(bounds.minX, 0, incomingOffset.x),
        maxX: Math.max(bounds.maxX, outgoingState.width * unit, incomingOffset.x + incomingState.width * unit),
        minZ: Math.min(bounds.minZ, 0, incomingOffset.z),
        maxZ: Math.max(bounds.maxZ, outgoingState.height * unit, incomingOffset.z + incomingState.height * unit)
      };
    }

    function ensureSceneLights() {
      if (ambientLight && keyLight) {
        return;
      }

      ambientLight = new THREE.AmbientLight("#ffffff", 1.45);
      keyLight = new THREE.DirectionalLight("#ffffff", 1.2);
      keyLight.shadow.mapSize.width = 1024;
      keyLight.shadow.mapSize.height = 1024;
      keyLight.shadow.bias = -0.0002;
      keyLight.shadow.normalBias = unit * 0.006;
      keyLight.shadow.radius = 4;
    }

    function resetScene() {
      app.threeSceneRebuildCount = (app.threeSceneRebuildCount || 0) + 1;
      // Cached world-view room groups survive rebuilds; detach them so
      // disposeScene doesn't free their merged geometry.
      detachWorldViewRoomGroups();
      disposeScene();

      if (!scene) {
        scene = new THREE.Scene();
        scene.background = new THREE.Color("#050608");
      }

      if (!edgeScene) {
        edgeScene = new THREE.Scene();
      }

      ensureSceneLights();
      scene.add(ambientLight);
      const lightBounds = sceneLightBounds();
      const boardCenter = new THREE.Vector3(
        (lightBounds.minX + lightBounds.maxX) / 2,
        0,
        (lightBounds.minZ + lightBounds.maxZ) / 2
      );
      keyLight.position.set(boardCenter.x + unit * 5, unit * 18, boardCenter.z - unit * 5);
      keyLight.target.position.copy(boardCenter);
      keyLight.castShadow = !app.isFlyoverMode;

      const shadowSpan = Math.max(
        lightBounds.maxX - lightBounds.minX,
        lightBounds.maxZ - lightBounds.minZ,
        unit * 8
      );
      const shadowCamera = keyLight.shadow.camera;

      if (
        shadowCamera.right !== shadowSpan ||
        shadowCamera.far !== shadowSpan * 3
      ) {
        shadowCamera.left = -shadowSpan;
        shadowCamera.right = shadowSpan;
        shadowCamera.top = shadowSpan;
        shadowCamera.bottom = -shadowSpan;
        shadowCamera.near = 1;
        shadowCamera.far = shadowSpan * 3;
        shadowCamera.updateProjectionMatrix();
      }

      scene.add(keyLight);
      scene.add(keyLight.target);
    }

    function layerSignature(layer) {
      return `${layer.type}:${layer.elevation ?? 0}:${layer.raised ? 1 : 0}:${layer.modelUrl || ""}`;
    }

    function cameraFitSignature() {
      return [
        app.currentLevelId || "",
        app.state.width,
        app.state.height,
        app.boardRect.width,
        app.boardRect.height
      ].join(";");
    }

    function animationSignature(now) {
      const parts = [];

      app.eachPlayerGate?.((x, y) => {
        parts.push(`G${x},${y}:${Math.round(app.gateLiftAt(x, y, now) * 1000)}`);
      });
      app.eachOrangeWall?.((x, y) => {
        parts.push(`O${x},${y}:${Math.round(app.orangeWallLiftAt(x, y, now) * 1000)}`);
      });
      app.eachPlayerLift?.((x, y) => {
        parts.push(`L${x},${y}:${Math.round(app.playerLiftAt(x, y, now) * 1000)}`);
      });

      return parts.join("|");
    }

    function actorSignature(actor) {
      return [
        actor.type,
        actor.groupId || "",
        actor.modelUrl || "",
        actor.direction || actor.facing || "",
        actor.removed ? 1 : 0,
        actor.x,
        actor.y,
        Math.round((actor.renderX ?? actor.x) * 1000),
        Math.round((actor.renderY ?? actor.y) * 1000),
        actor.elevation ?? 0,
        Math.round((actor.renderElevation ?? actor.elevation ?? 0) * 1000),
        Math.round((actor.renderScale ?? 1) * 1000),
        Math.round((actor.renderAlpha ?? 1) * 1000),
        Math.round((actor.renderSink ?? 0) * 1000),
        actor.renderInHole ? 1 : 0,
        actor.renderPunchEffect ? 1 : 0
      ].join(":");
    }

    function levelStateSignature(levelState) {
      if (levelStateSignatureCache.has(levelState)) {
        return levelStateSignatureCache.get(levelState);
      }

      const parts = [
        levelState.levelId || "",
        levelState.width,
        levelState.height,
        `raisedPlayerGates:${sortedTransitionSetSignature(levelState.raisedPlayerGates)}`,
        `raisedOrangeWalls:${sortedTransitionSetSignature(levelState.raisedOrangeWalls)}`
      ];

      for (let y = 0; y < levelState.height; y += 1) {
        for (let x = 0; x < levelState.width; x += 1) {
          parts.push(renderTerrainLayersAt(x, y, levelState).map(layerSignature).join("+") || "empty");
        }
      }

      (levelState.actors || []).forEach((actor) => {
        parts.push(actorSignature(actor));
      });

      const signature = parts.join(";");
      levelStateSignatureCache.set(levelState, signature);
      return signature;
    }

    function hasActiveSceneAnimation() {
      return Boolean(
        app.isAnimating ||
          app.worldActionAnimation ||
          app.levelTransition ||
          app.gateAnimationFrameId !== null ||
          app.orangeWallAnimationFrameId !== null ||
          app.playerLiftAnimationFrameId !== null
      );
    }

    function hasShadowAffectingAnimation() {
      return hasActiveSceneAnimation();
    }

    function terrainScanSignature() {
      const version = Number(app.terrainRenderVersion) || 0;

      // Key on the terrain array identity, not app.state: app.state is
      // mutated in place by applyLevelState (editor repaints replace the
      // terrain array without bumping terrainRenderVersion), so app.state's
      // identity never changes and the cache would return stale scans.
      if (terrainScanCacheState === app.state.terrain && terrainScanCacheVersion === version) {
        return terrainScanCacheValue;
      }

      const parts = [];

      for (let y = 0; y < app.state.height; y += 1) {
        for (let x = 0; x < app.state.width; x += 1) {
          const layers = app.terrainLayersAt(x, y);
          parts.push(layers.map(layerSignature).join("+") || "empty");
        }
      }

      terrainScanCacheState = app.state.terrain;
      terrainScanCacheVersion = version;
      terrainScanCacheValue = parts.join(";");
      return terrainScanCacheValue;
    }

    function flyoverFadeAnimationSignature(now) {
      // Fade steps must dirty the content signature while they animate, or
      // they only advance on frames dirtied by other events. Host pages can
      // opt world-view fades in via worldViewRoomFadeInsEnabled.
      if (!app.isFlyoverMode && app.worldViewRoomFadeInsEnabled !== true) {
        return "";
      }

      const durationMs = Math.max(1, Number(app.flyoverRoomFadeDurationMs) || 900);
      const parts = [];

      (app.flyoverDepartingViews || []).forEach((view) => {
        const progress = clamp01((now - view.startMs) / Math.max(1, view.durationMs || durationMs));

        if (progress < 1) {
          parts.push(`out:${view.levelId}:${Math.floor(progress * 3)}`);
        }
      });

      if (app.flyoverRoomFadeIns instanceof Map) {
        app.flyoverRoomFadeIns.forEach((startMs, levelId) => {
          const progress = clamp01((now - startMs) / durationMs);

          if (progress < 1) {
            parts.push(`in:${levelId}:${Math.floor(progress * 3)}`);
          }
        });
      }

      return parts.length > 0 ? `flyover-fade:${parts.join("|")}` : "";
    }

    function cameraFlightViewsSignature() {
      if (!Array.isArray(app.cameraFlightLevelViews) || app.cameraFlightLevelViews.length === 0) {
        return "";
      }

      return app.cameraFlightLevelViews
        .map((view) => [
          view.levelId || view.levelState?.levelId || "",
          Math.round(Number(view.offset?.x || 0)),
          Math.round(Number(view.offset?.z || 0)),
          view.hidePlayers === true ? "hide" : "show",
          signatureToken(levelStateSignature(view.levelState || {}))
        ].join(":"))
        .join("|");
    }

    function sceneContentSignature(now) {
      const transition = app.levelTransition?.transitionData;
      const worldAction = app.worldActionAnimation;
      const cameraFlightSignature = cameraFlightViewsSignature();

      if (app.isFlyoverMode && app.flyoverWholeWorld === true) {
        return [
          app.state.width,
          app.state.height,
          app.boardRect.width,
          app.boardRect.height,
          edgeOutlinesEnabled() ? "edges:on" : "edges:off",
          animationSignature(now),
          flyoverFadeAnimationSignature(now),
          transition ? "transition" : "no-transition",
          worldAction ? "world-action" : "no-world-action",
          cameraFlightSignature ? `camera-flight:${cameraFlightSignature}` : "no-camera-flight",
          `flyover-whole:${Number(app.flyoverSceneVersion) || 0}`,
          `renderable:${app.flyoverRenderableLevelIds?.size || 0}`,
          `world-levels:${Number(app.flyoverWorldTotalLevelCount) || 0}`
        ].join(";");
      }

      const surroundingViews = surroundingLevelViews();
      const parts = [
        app.state.width,
        app.state.height,
        app.boardRect.width,
        app.boardRect.height,
        edgeOutlinesEnabled() ? "edges:on" : "edges:off",
        animationSignature(now),
        flyoverFadeAnimationSignature(now),
        worldShadowSignature(now),
        app.worldViewVistaMode === true ? "vista-anchor" : "live-anchor",
        app.isFlyoverMode ? "flyover-selection" : "no-flyover-selection",
        transition
          ? [
              transition.kind,
              transition.dx,
              transition.dy,
              transition.outgoingLevel?.levelId || "",
              transition.incomingLevel?.levelId || "",
              Math.round(transitionProgress(now) * 1000)
            ].join(":")
          : "no-transition",
        worldAction
          ? [
              "world-action",
              Math.round((worldAction.currentPoint?.x || 0) * 1000),
              Math.round((worldAction.currentPoint?.y || 0) * 1000),
              Math.round((worldAction.currentPoint?.elevation || 0) * 1000),
              worldAction.visualSignature || ""
            ].join(":")
          : "no-world-action",
        cameraFlightSignature ? `camera-flight:${cameraFlightSignature}` : "no-camera-flight",
        app.isFlyoverMode
          ? `flyover-current:${Math.round(flyoverCurrentLevelBrightness() * 1000)}`
          : "no-flyover-current",
        `neighbors:${surroundingViews
          .map((view) => `${view.dx},${view.dy},${view.levelId},${Math.round(view.brightness * 1000)}`)
          .join("|")}`
      ];

      surroundingViews.forEach((view) => {
        parts.push(`neighbor:${view.dx},${view.dy}:${signatureToken(levelStateSignature(view.levelState))}`);
      });

      parts.push(signatureToken(terrainScanSignature()));

      app.state.actors.forEach((actor) => {
        parts.push(actorSignature(actor));
      });

      return parts.join(";");
    }

    function flyoverShadowSceneSignature() {
      if (app.isFlyoverMode && app.flyoverWholeWorld === true) {
        return [
          app.state.width,
          app.state.height,
          edgeOutlinesEnabled() ? "edges:on" : "edges:off",
          `flyover-whole-shadow:${Number(app.flyoverSceneVersion) || 0}`
        ].join(";");
      }

      const surroundingViews = surroundingLevelViews();
      const parts = [
        app.state.width,
        app.state.height,
        edgeOutlinesEnabled() ? "edges:on" : "edges:off",
        `neighbors:${surroundingViews
          .map((view) => `${view.dx},${view.dy},${view.levelId}`)
          .join("|")}`
      ];

      surroundingViews.forEach((view) => {
        parts.push(`neighbor:${view.dx},${view.dy}:${signatureToken(levelStateSignature(view.levelState))}`);
      });

      parts.push(signatureToken(terrainScanSignature()));

      app.state.actors.forEach((actor) => {
        parts.push(actorSignature(actor));
      });

      return parts.join(";");
    }

    function syncRendererSize() {
      const width = app.boardRect.width;
      const height = app.boardRect.height;

      if (width !== lastWidth || height !== lastHeight) {
        lastWidth = width;
        lastHeight = height;
        threeCanvas.width = width;
        threeCanvas.height = height;
        renderer.setSize(width, height, false);
      }

      if (camera.isPerspectiveCamera) {
        camera.aspect = width / Math.max(1, height);
        camera.fov = 34;
        camera.near = perspectiveCameraNearPlane();
        camera.far = perspectiveCameraFarPlane();
      } else {
        camera.left = -width / 2;
        camera.right = width / 2;
        camera.top = height / 2;
        camera.bottom = -height / 2;
        camera.near = -4000;
        camera.far = 4000;
      }

      camera.updateProjectionMatrix();
    }

    function oneLayerCameraWorldHeight() {
      return Math.max(elevationUnit, 3.25 * elevationUnit + floorThickness + actorVisualLift);
    }

    function palettePreviewCameraWorldHeight() {
      return Math.max(elevationUnit * 1.7, elevationUnit + floorThickness);
    }

    function stableCameraWorldHeight() {
      const signature = cameraFitSignature();

      if (signature === lastCameraFitSignature && lastCameraFitHeight > 0) {
        return lastCameraFitHeight;
      }

      lastCameraFitSignature = signature;
      lastCameraFitHeight = oneLayerCameraWorldHeight();

      return lastCameraFitHeight;
    }

    function uncachedWorldHeightForState() {
      return oneLayerCameraWorldHeight();
    }

    function cameraFlightFitOptions() {
      if (app.isFlyoverMode || isEditorRenderMode()) {
        return null;
      }

      const fit = app.cameraFlightFitOptions;

      if (!fit) {
        return null;
      }

      const minX = Number(fit.minX);
      const maxX = Number(fit.maxX);
      const minZ = Number(fit.minZ);
      const maxZ = Number(fit.maxZ);

      if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) {
        return null;
      }

      const centerX = Number(fit.centerX);
      const centerY = Number(fit.centerY);
      const centerZ = Number(fit.centerZ);
      const stableHeight = Number(fit.stableHeight);

      return {
        minX,
        maxX,
        minZ,
        maxZ,
        centerX: Number.isFinite(centerX) ? centerX : (minX + maxX) / 2,
        centerY: Number.isFinite(centerY) ? centerY : undefined,
        centerZ: Number.isFinite(centerZ) ? centerZ : (minZ + maxZ) / 2,
        stableHeight: Number.isFinite(stableHeight) && stableHeight > 0
          ? stableHeight
          : oneLayerCameraWorldHeight()
      };
    }

    function fitCameraToScene(options = {}) {
      const stableHeight =
        options.stableHeight ??
        (isPalettePreviewRenderMode()
          ? palettePreviewCameraWorldHeight()
          : stableCameraWorldHeight());
      // Default fit bounds are the current room. In the classic square
      // layout boardRect equals the room's world size, but full-bleed hosts
      // (hostFullBleedView) resize boardRect to the frame rect, which would
      // fit — and center the camera on — a viewport-sized world box instead
      // of the room. The consolidated home vista intentionally frames that
      // viewport box, so it keeps the boardRect default.
      const fitCurrentRoomBounds =
        app.hostFullBleedView === true &&
        !app.isFlyoverMode &&
        app.worldViewConsolidate !== true;
      const defaultMaxWorldX = fitCurrentRoomBounds
        ? Math.max(1, Number(app.state?.width) || 1) * unit
        : app.boardRect.width;
      const defaultMaxWorldZ = fitCurrentRoomBounds
        ? Math.max(1, Number(app.state?.height) || 1) * unit
        : app.boardRect.height;
      const minWorldX = options.minX ?? 0;
      const maxWorldX = options.maxX ?? defaultMaxWorldX;
      const minWorldZ = options.minZ ?? 0;
      const maxWorldZ = options.maxZ ?? defaultMaxWorldZ;
      // Host pages can glide the camera across the surrounding world (e.g.
      // the mazebench.com home-page flyby) without moving the current room.
      const worldPanOffsetX = app.isFlyoverMode ? 0 : Number(app.worldPanCameraOffsetX || 0);
      const worldPanOffsetZ = app.isFlyoverMode ? 0 : Number(app.worldPanCameraOffsetZ || 0);
      const center = new THREE.Vector3(
        (options.centerX ?? (minWorldX + maxWorldX) / 2) + worldPanOffsetX,
        options.centerY ?? stableHeight / 2,
        (options.centerZ ?? (minWorldZ + maxWorldZ) / 2) + worldPanOffsetZ
      );
      const canvasWidth = Math.max(1, app.boardRect.width);
      const canvasHeight = Math.max(1, app.boardRect.height);
      const worldWidth = Math.max(1, maxWorldX - minWorldX);
      const worldHeight = Math.max(1, maxWorldZ - minWorldZ);
      const maxSpan = Math.max(worldWidth, worldHeight, stableHeight, unit);
      const isPalettePreview = isPalettePreviewRenderMode();
      const cameraYaw = isPalettePreview ? 0 : debugCameraYaw;
      const cameraTilt = clampDebugCameraTilt(isPalettePreview ? Math.PI * 0.18 : debugCameraTilt);
      const cameraZoom = isPalettePreview ? 1 : debugCameraZoom;
      const horizontalTilt = Math.sin(cameraTilt);
      const verticalTilt = Math.cos(cameraTilt);
      const viewDirection = new THREE.Vector3(
        Math.sin(cameraYaw) * horizontalTilt,
        verticalTilt,
        Math.cos(cameraYaw) * horizontalTilt
      ).normalize();
      const cameraUp = cameraUpVectorFor(viewDirection, cameraYaw);

      camera.zoom = 1;

      const corners = [
        new THREE.Vector3(minWorldX, 0, minWorldZ),
        new THREE.Vector3(minWorldX, 0, maxWorldZ),
        new THREE.Vector3(maxWorldX, 0, minWorldZ),
        new THREE.Vector3(maxWorldX, 0, maxWorldZ),
        new THREE.Vector3(minWorldX, stableHeight, minWorldZ),
        new THREE.Vector3(minWorldX, stableHeight, maxWorldZ),
        new THREE.Vector3(maxWorldX, stableHeight, minWorldZ),
        new THREE.Vector3(maxWorldX, stableHeight, maxWorldZ)
      ];

      if (!camera.isPerspectiveCamera) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        camera.position.copy(center).addScaledVector(viewDirection, maxSpan * 2.6 + unit * 3);
        camera.up.copy(cameraUp);
        camera.lookAt(center);
        camera.zoom = 1;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);

        corners.forEach((corner) => {
          corner.applyMatrix4(camera.matrixWorldInverse);
          minX = Math.min(minX, corner.x);
          maxX = Math.max(maxX, corner.x);
          minY = Math.min(minY, corner.y);
          maxY = Math.max(maxY, corner.y);
        });

        const projectedWidth = Math.max(1, maxX - minX);
        const projectedHeight = Math.max(1, maxY - minY);
        camera.zoom = Math.max(
          0.1,
          Math.min(canvasWidth / projectedWidth, canvasHeight / projectedHeight) * 1.025
        ) * cameraZoom;
        camera.updateProjectionMatrix();
        return;
      }

      camera.up.copy(cameraUp);

      if (Number.isFinite(Number(options.fixedCameraDistance))) {
        const distance = Math.max(unit, Number(options.fixedCameraDistance));

        camera.position.copy(center).addScaledVector(viewDirection, distance / cameraZoom);
        lastCameraFitDistance = distance / cameraZoom;
        camera.lookAt(center);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        return;
      }

      let distance = maxSpan * 1.65 + unit * 3;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        let maxProjected = 0;

        camera.position.copy(center).addScaledVector(viewDirection, distance);
        camera.lookAt(center);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);

        corners.forEach((corner) => {
          const projected = corner.clone().project(camera);
          maxProjected = Math.max(maxProjected, Math.abs(projected.x), Math.abs(projected.y));
        });

        if (maxProjected <= 0.001) {
          break;
        }

        const scale = maxProjected / 0.94;

        if (Math.abs(scale - 1) <= 0.015) {
          break;
        }

        distance *= Math.max(0.35, Math.min(2.4, scale));
      }

      camera.position.copy(center).addScaledVector(viewDirection, distance / cameraZoom);
      lastCameraFitDistance = distance / cameraZoom;
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
    }

    function editorSurroundingFitOptions() {
      if (!isEditorRenderMode() || isPalettePreviewRenderMode()) {
        return null;
      }

      const currentWidth = Math.max(1, app.state.width) * unit;
      const currentHeight = Math.max(1, app.state.height) * unit;

      return {
        minX: 0,
        maxX: currentWidth,
        minZ: 0,
        maxZ: currentHeight,
        centerX: currentWidth / 2,
        centerZ: currentHeight / 2,
        stableHeight: stableCameraWorldHeight()
      };
    }

    function actorSpinAngle(actor, now) {
      return ((now % gemSpinPeriodMs) / gemSpinPeriodMs) * Math.PI * 2 + (actor.hoverSeed || 0);
    }

    function actorHoverOffset(actor, now) {
      return Math.max(0, app.floatingFloorHoverOffset?.(actor, now) || 0);
    }

    function actorStructureCode(actor) {
      // Everything addActor bakes into geometry/material choices EXCEPT the
      // continuously-animated transform fields (renderX/renderY/
      // renderElevation/renderSink/hover/spin), which syncActorTransforms
      // applies as position deltas.
      return [
        actor.type,
        actor.groupId || "",
        actor.modelUrl || "",
        actor.direction || actor.facing || "",
        actor.removed ? 1 : 0,
        actor.x,
        actor.y,
        actor.elevation ?? 0,
        Math.round((actor.renderScale ?? 1) * 1000),
        Math.round((actor.renderAlpha ?? 1) * 1000),
        actor.renderInHole ? 1 : 0,
        actor.renderPunchEffect === true ? 1 : 0,
        actor.showCollectedGhost === true ? 1 : 0
      ].join(":");
    }

    function staticActorCode(actor) {
      return [
        actorStructureCode(actor),
        Math.round(((actor.renderX ?? actor.x)) * 1000),
        Math.round(((actor.renderY ?? actor.y)) * 1000),
        Math.round(((actor.renderElevation ?? actor.elevation ?? 0)) * 1000),
        Math.round(((actor.renderSink ?? 0)) * 1000)
      ].join(":");
    }

    function trackActorSceneObjects(actor, sceneStart, edgeStart, now) {
      const objects = [];

      for (let i = sceneStart; i < scene.children.length; i += 1) {
        const object = scene.children[i];

        object.userData.dynamicActorObject = true;
        objects.push({
          object,
          basePosition: object.position.clone(),
          baseRotationY: object.rotation.y,
          baseEdgeBase: null
        });
      }

      for (let i = edgeStart; i < edgeScene.children.length; i += 1) {
        const object = edgeScene.children[i];

        object.userData.dynamicActorObject = true;
        objects.push({
          object,
          basePosition: object.position.clone(),
          baseRotationY: object.rotation.y,
          baseEdgeBase: object.userData.edgeBasePosition
            ? object.userData.edgeBasePosition.clone()
            : null
        });
      }

      if (!objects.length) {
        return;
      }

      trackedActorObjects.set(actor, {
        objects,
        base: {
          renderX: actor.renderX ?? actor.x,
          renderY: actor.renderY ?? actor.y,
          renderElevation: actor.renderElevation ?? actor.elevation ?? 0,
          sink: actor.renderSink ?? 0,
          hover: actorHoverOffset(actor, now),
          spin: actorSpinAngle(actor, now)
        },
        structureCode: actorStructureCode(actor)
      });
    }

    function syncActorTransforms(now) {
      if (
        trackedBuildStateRef !== app.state ||
        trackedBuildTerrainVersion !== (Number(app.terrainRenderVersion) || 0) ||
        (trackedActorObjects.size === 0 && trackedStaticActorCodes.size === 0)
      ) {
        return false;
      }

      let valid = true;

      trackedActorObjects.forEach((entry, actor) => {
        if (valid && entry.structureCode !== actorStructureCode(actor)) {
          valid = false;
        }
      });
      trackedStaticActorCodes.forEach((code, actor) => {
        if (valid && code !== staticActorCode(actor)) {
          valid = false;
        }
      });

      if (!valid) {
        return false;
      }

      trackedActorObjects.forEach((entry, actor) => {
        const base = entry.base;
        const dx = ((actor.renderX ?? actor.x) - base.renderX) * unit;
        const dz = ((actor.renderY ?? actor.y) - base.renderY) * unit;
        const dy =
          ((actor.renderElevation ?? actor.elevation ?? 0) - base.renderElevation) * elevationUnit -
          ((actor.renderSink ?? 0) - base.sink) +
          (actorHoverOffset(actor, now) - base.hover);
        const spinDelta = actor.type === "gem" ? actorSpinAngle(actor, now) - base.spin : 0;

        entry.objects.forEach((tracked) => {
          tracked.object.position.set(
            tracked.basePosition.x + dx,
            tracked.basePosition.y + dy,
            tracked.basePosition.z + dz
          );

          if (tracked.baseEdgeBase && tracked.object.userData.edgeBasePosition) {
            tracked.object.userData.edgeBasePosition.set(
              tracked.baseEdgeBase.x + dx,
              tracked.baseEdgeBase.y + dy,
              tracked.baseEdgeBase.z + dz
            );
          }

          if (spinDelta !== 0 && tracked.object.userData.gemSpinGroup === true) {
            tracked.object.rotation.y = tracked.baseRotationY + spinDelta;
          }
        });
      });

      return true;
    }

    function renderHoverFrame(now = performance.now()) {
      if (!THREE || !renderer || !camera || !hasRenderedScene) {
        return false;
      }

      if (hasActiveSceneAnimation() || isEditorRenderMode() || app.isFlyoverMode) {
        return false;
      }

      if (!syncActorTransforms(now)) {
        return false;
      }

      // Hover bob is ~2px: skipping the shadow-map update is invisible and
      // avoids re-rendering the shadow pass 30x per second at idle.
      renderSceneToComposite(false);
      return true;
    }

    function renderActorsForCurrentContext(now = performance.now()) {
      const state = renderState();
      const renderedActors = addWeightlessActorGroups();
      const hiddenActorKeys = activeRenderContext?.hiddenActorKeys;
      const trackActors = !activeRenderContext && !isEditorRenderMode() && state === app.state;
      const shouldHidePlayerActor = (actor) =>
        activeRenderContext?.hidePlayers &&
        (
          typeof app.isMainPlayerActor === "function"
            ? app.isMainPlayerActor(actor)
            : app.isPlayerActor?.(actor) && actor?.type !== "clone"
        );

      if (trackActors) {
        trackedActorObjects.clear();
        trackedStaticActorCodes.clear();
        trackedBuildStateRef = app.state;
        trackedBuildTerrainVersion = Number(app.terrainRenderVersion) || 0;
      }

      state.actors.forEach((actor) => {
        if (shouldHidePlayerActor(actor)) {
          return;
        }

        if (hiddenActorKeys?.has?.(renderActorContextKey(actor))) {
          return;
        }

        if (renderedActors.has(actor)) {
          // Weightless-group actors render as merged columns; the fast
          // animation path bails when any of them moves.
          if (trackActors) {
            trackedStaticActorCodes.set(actor, staticActorCode(actor));
          }

          return;
        }

        if (trackActors) {
          const sceneStart = scene.children.length;
          const edgeStart = edgeScene.children.length;

          addActor(actor, now);
          trackActorSceneObjects(actor, sceneStart, edgeStart, now);
          return;
        }

        addActor(actor, now);
      });
    }

    function runtimeLevelState() {
      return {
        levelId: app.currentLevelId,
        width: app.state.width,
        height: app.state.height,
        terrain: app.state.terrain,
        actors: app.state.actors
      };
    }

    function shouldRenderSurroundingLevels() {
      return (
        !app.levelTransition &&
        typeof app.parseWorldLevelId === "function" &&
        Boolean(app.parseWorldLevelId(app.currentLevelId))
      );
    }

    function surroundingLevelRadius() {
      if (app.isFlyoverMode) {
        return Math.max(1, Math.min(6, Number(app.flyoverRadius) || 3));
      }

      return playSurroundingRadius();
    }

    function flyoverRoomWorldWidth() {
      return Math.max(1, Number(app.flyoverRoomTileWidth) || app.state.width || 16) * unit;
    }

    function flyoverRoomWorldHeight() {
      return Math.max(1, Number(app.flyoverRoomTileHeight) || app.state.height || 16) * unit;
    }

    function flyoverStaticBounds() {
      if (app.flyoverWholeWorld === true && app.flyoverWorldBounds) {
        const bounds = app.flyoverWorldBounds;

        return {
          minX: Number(bounds.minX) || 0,
          maxX: Number(bounds.maxX) || flyoverRoomWorldWidth(),
          minZ: Number(bounds.minZ) || 0,
          maxZ: Number(bounds.maxZ) || flyoverRoomWorldHeight()
        };
      }

      const radius = surroundingLevelRadius();
      const roomWidth = flyoverRoomWorldWidth();
      const roomHeight = flyoverRoomWorldHeight();

      return {
        minX: -roomWidth * radius,
        maxX: roomWidth * (radius + 1),
        minZ: -roomHeight * radius,
        maxZ: roomHeight * (radius + 1)
      };
    }

    function flyoverFixedCameraDistance() {
      if (app.flyoverWholeWorld === true && app.flyoverWorldBounds) {
        const bounds = app.flyoverWorldBounds;
        const roomSpan = Math.max(
          Number(bounds.maxX) - Number(bounds.minX),
          Number(bounds.maxZ) - Number(bounds.minZ),
          flyoverRoomWorldWidth(),
          flyoverRoomWorldHeight()
        );

        return roomSpan * 1.68 + unit * 3;
      }

      const radius = surroundingLevelRadius();
      const roomSpan = Math.max(flyoverRoomWorldWidth(), flyoverRoomWorldHeight()) * (radius * 2 + 1);

      return roomSpan * 1.68 + unit * 3;
    }

    function flyoverCurrentLevelBrightness() {
      return flyoverLevelBrightness(app.currentLevelId, 1);
    }

    // World level ids wrap around the grid, so a wide radius revisits the
    // same room at multiple coordinates. The grid is static per world, so the
    // deduped nearest-copy coordinate list is cached per anchor level.
    const worldNeighborCoordsCache = new Map();

    function worldNeighborCoords(levelId, radius) {
      const key = `${levelId}:${radius}`;
      let coords = worldNeighborCoordsCache.get(key);

      if (coords) {
        return coords;
      }

      const byLevelId = new Map();

      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }

          const neighborLevelId = app.adjacentWorldLevelId?.(levelId, dx, dy);

          if (!neighborLevelId || neighborLevelId === levelId) {
            continue;
          }

          const distance = Math.hypot(dx, dy);
          const existing = byLevelId.get(neighborLevelId);

          if (existing && existing.distance <= distance) {
            continue;
          }

          byLevelId.set(neighborLevelId, { dx, dy, levelId: neighborLevelId, distance });
        }
      }

      // Nearest-first so state fetches and room-group builds stream outward
      // from the current room.
      coords = Array.from(byLevelId.values()).sort((a, b) => a.distance - b.distance);
      worldNeighborCoordsCache.set(key, coords);
      return coords;
    }

    function surroundingLevelBrightness(dx, dy) {
      if (app.isFlyoverMode || app.worldViewUniformBrightness === true) {
        return 1;
      }

      return neighboringRoomBrightness;
    }

    // Animated shadow for non-current rooms: room GROUPS are always built at
    // full brightness; this factor dims them by swapping shared cache
    // materials (no re-mesh). Hosts opt into animation via
    // app.worldShadowFadeMs; zero means snap.
    const worldShadowFade = { current: 1, target: 1, from: 1, startMs: 0 };

    function worldShadowTargetFactor() {
      if (app.isFlyoverMode || app.worldViewRoomFadeInsEnabled === true || !isWorldViewPlayMode()) {
        return 1;
      }

      return app.worldViewUniformBrightness === true ? 1 : neighboringRoomBrightness;
    }

    function worldShadowFactor(now) {
      const target = worldShadowTargetFactor();

      if (worldShadowFade.target !== target) {
        worldShadowFade.from = worldShadowFade.current;
        worldShadowFade.target = target;
        worldShadowFade.startMs = now;
      }

      const durationMs = Math.max(0, Number(app.worldShadowFadeMs) || 0);

      if (durationMs === 0) {
        worldShadowFade.current = target;
        return target;
      }

      const progress = clamp01((now - worldShadowFade.startMs) / durationMs);
      const eased = app.easeInOutQuad ? app.easeInOutQuad(progress) : progress;

      worldShadowFade.current =
        progress >= 1 ? target : lerp(worldShadowFade.from, target, eased);
      return worldShadowFade.current;
    }

    function worldShadowQuantized(factor) {
      // Same 1/32 grid as renderContextColor so swapped materials are the
      // exact entries a rebuild at this brightness would have minted.
      return factor >= 0.999 ? 1 : Math.round(factor * 32) / 32;
    }

    function worldShadowAnimating() {
      return worldShadowFade.current !== worldShadowFade.target;
    }

    function worldShadowSignature(now) {
      return `shadow:${Math.round(worldShadowQuantized(worldShadowFactor(now)) * 1000)}`;
    }

    function flyoverLevelBrightness(levelId, brightness = 1) {
      return clamp01(Number(brightness) || 0);
    }

    function surroundingLevelOffset(dx, dy, levelState, currentState = runtimeLevelState()) {
      if (app.isFlyoverMode) {
        return {
          x: dx * flyoverRoomWorldWidth(),
          z: dy * flyoverRoomWorldHeight()
        };
      }

      const currentWidth = Math.max(1, currentState.width) * unit;
      const currentHeight = Math.max(1, currentState.height) * unit;
      const levelWidth = Math.max(1, levelState.width) * unit;
      const levelHeight = Math.max(1, levelState.height) * unit;

      return {
        x: dx < 0 ? dx * levelWidth : dx > 0 ? dx * currentWidth : 0,
        z: dy < 0 ? dy * levelHeight : dy > 0 ? dy * currentHeight : 0
      };
    }

    function surroundingLevelViews() {
      if (!shouldRenderSurroundingLevels()) {
        return [];
      }

      if (app.isFlyoverMode && typeof app.flyoverSurroundingLevelViews === "function") {
        const flyoverViews = app.flyoverSurroundingLevelViews();

        if (Array.isArray(flyoverViews)) {
          return flyoverViews;
        }
      }

      const currentState = runtimeLevelState();
      const views = [];

      worldNeighborCoords(app.currentLevelId, surroundingLevelRadius()).forEach((coord) => {
        const levelId = coord.levelId;
        const levelState = app.cachedHorizontalNeighborLevelState?.(levelId);

        if (!levelState) {
          app.queueHorizontalNeighborLevelState?.(levelId, { priority: coord.distance });
          return;
        }

        if (
          app.isFlyoverMode &&
          app.flyoverRenderableLevelIds instanceof Set &&
          !app.flyoverRenderableLevelIds.has(levelId)
        ) {
          return;
        }

        if (!levelState.width || !levelState.height) {
          return;
        }

        views.push({
          dx: coord.dx,
          dy: coord.dy,
          levelId,
          levelState,
          offset: surroundingLevelOffset(coord.dx, coord.dy, levelState, currentState),
          brightness: surroundingLevelBrightness(coord.dx, coord.dy),
          distance: coord.distance
        });
      });

      return views;
    }

    function surroundingLevelBounds(views = []) {
      if (app.isFlyoverMode) {
        return flyoverStaticBounds();
      }

      const currentState = runtimeLevelState();
      const currentWidth = Math.max(1, currentState.width) * unit;
      const currentHeight = Math.max(1, currentState.height) * unit;
      const radius = surroundingLevelRadius();
      const bounds = shouldRenderSurroundingLevels()
        ? {
            minX: -currentWidth * radius,
            maxX: currentWidth * (radius + 1),
            minZ: -currentHeight * radius,
            maxZ: currentHeight * (radius + 1)
          }
        : {
            minX: 0,
            maxX: currentWidth,
            minZ: 0,
            maxZ: currentHeight
          };

      views.forEach((view) => {
        bounds.minX = Math.min(bounds.minX, view.offset.x);
        bounds.maxX = Math.max(bounds.maxX, view.offset.x + view.levelState.width * unit);
        bounds.minZ = Math.min(bounds.minZ, view.offset.z);
        bounds.maxZ = Math.max(bounds.maxZ, view.offset.z + view.levelState.height * unit);
      });

      return bounds;
    }

    function flyoverFitOptions() {
      if (!app.isFlyoverMode) {
        return null;
      }

      const bounds = flyoverStaticBounds();
      const focusedFrame = flyoverLevelFrame(app.flyoverFocusedLevelId || app.flyoverSelectedLevelId);
      const roomWidth = flyoverRoomWorldWidth();
      const roomHeight = flyoverRoomWorldHeight();
      const defaultOptions = flyoverDefaultFitOptions(bounds, roomWidth, roomHeight);
      const transitionOptions = flyoverFocusTransitionFitOptions(bounds, roomWidth, roomHeight, defaultOptions);

      if (transitionOptions) {
        return transitionOptions;
      }

      if (focusedFrame) {
        return flyoverFocusedFitOptions(focusedFrame, bounds, roomWidth, roomHeight);
      }

      return defaultOptions;
    }

    function flyoverDefaultFitOptions(bounds, roomWidth, roomHeight) {
      const centerX = roomWidth / 2 + Number(app.flyoverCameraOffsetX || 0);
      const centerZ = roomHeight / 2 + Number(app.flyoverCameraOffsetZ || 0);

      return {
        ...bounds,
        centerX,
        centerZ,
        centerY: 0,
        stableHeight: oneLayerCameraWorldHeight(),
        fixedCameraDistance: flyoverFixedCameraDistance()
      };
    }

    function flyoverFocusedFitOptions(focusedFrame, bounds, roomWidth, roomHeight) {
      const focusPaddingMultiplier = 0.85;
      const distanceMultiplier = 2.35;
      const paddingX = roomWidth * focusPaddingMultiplier;
      const paddingZ = roomHeight * focusPaddingMultiplier;
      const focusWidth = focusedFrame.maxX - focusedFrame.minX + paddingX * 2;
      const focusHeight = focusedFrame.maxZ - focusedFrame.minZ + paddingZ * 2;
      const focusSpan = Math.max(focusWidth, focusHeight, oneLayerCameraWorldHeight(), unit);

      return {
        minX: focusedFrame.minX - paddingX,
        maxX: focusedFrame.maxX + paddingX,
        minZ: focusedFrame.minZ - paddingZ,
        maxZ: focusedFrame.maxZ + paddingZ,
        centerX: focusedFrame.centerX,
        centerZ: focusedFrame.centerZ,
        centerY: 0,
        stableHeight: oneLayerCameraWorldHeight(),
        fixedCameraDistance: focusSpan * distanceMultiplier + unit * 3
      };
    }

    function flyoverFocusTransitionProgress() {
      const transition = app.flyoverFocusTransition;

      if (!transition || !Number.isFinite(transition.startMs) || !Number.isFinite(transition.durationMs)) {
        return null;
      }

      const progress = clamp01((performance.now() - transition.startMs) / Math.max(1, transition.durationMs));

      if (progress >= 1) {
        return null;
      }

      return {
        transition,
        progress
      };
    }

    function flyoverFocusTransitionSignature() {
      const active = flyoverFocusTransitionProgress();

      if (!active) {
        return "";
      }

      return [
        "focus-transition",
        active.transition.fromLevelId || "",
        active.transition.toLevelId || "",
        Math.floor(active.progress * 48)
      ].join(":");
    }

    function interpolateFlyoverFitOptions(fromOptions, toOptions, progress, options = {}) {
      const eased = smootherStep(progress);
      const lerpField = (field) => lerp(Number(fromOptions[field]) || 0, Number(toOptions[field]) || 0, eased);
      const positiveNumber = (value, fallback) => {
        const number = Number(value);

        return Number.isFinite(number) && number > 0 ? number : fallback;
      };
      const fixedCameraDistance =
        options.easeEffectiveScale === true
          ? lerp(
              positiveNumber(fromOptions.fixedCameraDistance, 0) /
                positiveNumber(options.fromZoom, 1),
              positiveNumber(toOptions.fixedCameraDistance, 0) /
                positiveNumber(options.toZoom, 1),
              eased
            ) * positiveNumber(debugCameraZoom, 1)
          : lerpField("fixedCameraDistance");

      return {
        minX: lerpField("minX"),
        maxX: lerpField("maxX"),
        minZ: lerpField("minZ"),
        maxZ: lerpField("maxZ"),
        centerX: lerpField("centerX"),
        centerY: lerpField("centerY"),
        centerZ: lerpField("centerZ"),
        stableHeight: lerpField("stableHeight"),
        fixedCameraDistance
      };
    }

    function flyoverFocusTransitionFitOptions(bounds, roomWidth, roomHeight, defaultOptions) {
      const active = flyoverFocusTransitionProgress();

      if (!active) {
        return null;
      }

      const fromFrame = flyoverLevelFrame(active.transition.fromLevelId);
      const toFrame = flyoverLevelFrame(active.transition.toLevelId);
      const fromOptions = fromFrame
        ? flyoverFocusedFitOptions(fromFrame, bounds, roomWidth, roomHeight)
        : defaultOptions;
      const toOptions = toFrame
        ? flyoverFocusedFitOptions(toFrame, bounds, roomWidth, roomHeight)
        : defaultOptions;

      return interpolateFlyoverFitOptions(fromOptions, toOptions, active.progress, {
        easeEffectiveScale: app.flyoverFocusTransitionEasesScale === true,
        fromZoom: active.transition.fromZoom,
        toZoom: active.transition.toZoom
      });
    }

    function flyoverLevelFrame(levelId) {
      if (!app.isFlyoverMode || !levelId) {
        return null;
      }

      const levelIdText = String(levelId);
      const levelState =
        levelIdText === app.currentLevelId
          ? runtimeLevelState()
          : app.cachedHorizontalNeighborLevelState?.(levelIdText);

      if (!levelState?.width || !levelState?.height) {
        return null;
      }

      let offsetX = 0;
      let offsetZ = 0;
      let dx = 0;
      let dy = 0;

      if (Array.isArray(app.flyoverWorldEntries)) {
        const entry = app.flyoverWorldEntries.find((candidate) => candidate.levelId === levelIdText);

        if (entry) {
          dx = Number(entry.dx) || 0;
          dy = Number(entry.dy) || 0;
          offsetX = dx * flyoverRoomWorldWidth();
          offsetZ = dy * flyoverRoomWorldHeight();
        }
      }

      if (levelIdText !== app.currentLevelId && offsetX === 0 && offsetZ === 0) {
        const view = surroundingLevelViews().find((candidate) => candidate.levelId === levelIdText);

        if (!view) {
          return null;
        }

        dx = Number(view.dx) || 0;
        dy = Number(view.dy) || 0;
        offsetX = Number(view.offset?.x) || 0;
        offsetZ = Number(view.offset?.z) || 0;
      }

      const width = levelState.width * unit;
      const height = levelState.height * unit;

      return {
        levelId: levelIdText,
        levelLabel: levelState.levelLabel || (levelIdText === app.currentLevelId ? app.currentLevelLabel : ""),
        levelState,
        dx,
        dy,
        minX: offsetX,
        maxX: offsetX + width,
        minZ: offsetZ,
        maxZ: offsetZ + height,
        centerX: offsetX + width / 2,
        centerZ: offsetZ + height / 2
      };
    }

    function flyoverPickableLevelFrames() {
      if (!app.isFlyoverMode) {
        return [];
      }

      const levelIds = new Set([app.currentLevelId]);

      if (Array.isArray(app.flyoverWorldEntries)) {
        app.flyoverWorldEntries.forEach((entry) => {
          if (entry?.levelId) {
            levelIds.add(entry.levelId);
          }
        });
      } else {
        surroundingLevelViews().forEach((view) => {
          if (view?.levelId) {
            levelIds.add(view.levelId);
          }
        });
      }

      return Array.from(levelIds)
        .map((levelId) => flyoverLevelFrame(levelId))
        .filter(Boolean);
    }

    function pickFlyoverLevel(clientX, clientY, targetElement = threeCanvas) {
      const hitElement = targetElement || threeCanvas || app.canvas;

      if (!THREE || !camera || !hitElement || !app.isFlyoverMode) {
        return null;
      }

      const rect = hitElement.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      if (!raycaster) {
        raycaster = new THREE.Raycaster();
      }

      const pointer = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -(((clientY - rect.top) / rect.height) * 2 - 1)
      );
      const groundPoint = new THREE.Vector3();
      const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

      raycaster.setFromCamera(pointer, camera);

      if (!raycaster.ray.intersectPlane(groundPlane, groundPoint)) {
        return null;
      }

      const tolerance = unit * 0.18;
      const matches = flyoverPickableLevelFrames()
        .filter((frame) => (
          groundPoint.x >= frame.minX - tolerance &&
          groundPoint.x <= frame.maxX + tolerance &&
          groundPoint.z >= frame.minZ - tolerance &&
          groundPoint.z <= frame.maxZ + tolerance
        ))
        .sort((left, right) => {
          const leftDx = left.centerX - groundPoint.x;
          const leftDz = left.centerZ - groundPoint.z;
          const rightDx = right.centerX - groundPoint.x;
          const rightDz = right.centerZ - groundPoint.z;

          return leftDx * leftDx + leftDz * leftDz - (rightDx * rightDx + rightDz * rightDz);
        });

      if (matches.length === 0) {
        return null;
      }

      return {
        ...matches[0],
        point: {
          x: groundPoint.x,
          z: groundPoint.z
        }
      };
    }

    function worldActionBounds(action = app.worldActionAnimation) {
      const rooms = Array.isArray(action?.rooms) ? action.rooms : [];

      if (rooms.length === 0) {
        return null;
      }

      const bounds = {
        minX: Infinity,
        maxX: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity
      };

      rooms.forEach((room) => {
        const levelState = room.levelState;

        if (!levelState?.width || !levelState?.height) {
          return;
        }

        const offsetX = Number(room.offset?.x || 0) * unit;
        const offsetZ = Number(room.offset?.y || 0) * unit;
        bounds.minX = Math.min(bounds.minX, offsetX);
        bounds.maxX = Math.max(bounds.maxX, offsetX + levelState.width * unit);
        bounds.minZ = Math.min(bounds.minZ, offsetZ);
        bounds.maxZ = Math.max(bounds.maxZ, offsetZ + levelState.height * unit);
      });

      return Number.isFinite(bounds.minX) ? bounds : null;
    }

    // The four grid neighbors of a level are static per world.
    const adjacentBoundaryLevelIdsCache = new Map();

    function adjacentBoundaryLevelIds(levelId) {
      let ids = adjacentBoundaryLevelIdsCache.get(levelId);

      if (ids === undefined) {
        ids = [[0, -1], [1, 0], [0, 1], [-1, 0]].map(
          ([dx, dy]) => app.adjacentWorldLevelId?.(levelId, dx, dy) || null
        );
        adjacentBoundaryLevelIdsCache.set(levelId, ids);
      }

      return ids;
    }

    // Wall edge lines at room boundaries are suppressed by sampling the
    // adjacent room's terrain, so a room's rendered content depends on which
    // neighbor states are loaded. This token folds that dependency into room
    // signatures and edge-geometry cache keys: "?" (state not loaded yet)
    // flips to the state's signature token when it arrives, invalidating the
    // stale seam edges.
    function boundaryNeighborStatesToken(levelId) {
      return adjacentBoundaryLevelIds(levelId)
        .map((neighborId) => {
          if (!neighborId) {
            return "-";
          }

          if (neighborId === app.currentLevelId) {
            // Boundary sampling reads the live current-room state, which is
            // always available; its wall layout only changes when the level
            // itself is replaced.
            return "c";
          }

          const state = app.cachedHorizontalNeighborLevelState?.(neighborId);

          return state ? signatureToken(levelStateSignature(state)) : "?";
        })
        .join(",");
    }

    const worldViewRoomSignatureMemo = new Map();

    function worldViewRoomSignature(view, brightness) {
      // While builds stream, this runs for every view every frame; the
      // boundary token derivation dominates. All inputs are captured in the
      // memo key: state identity, brightness, edge toggle, and the neighbor
      // cache version (bumped by rememberHorizontalNeighborLevelState).
      const bKey = Math.round(brightness * 1000);
      const edges = edgeOutlinesEnabled() ? 1 : 0;
      const version = app.horizontalNeighborStatesVersion || 0;
      const modelsVersion = modelAssetsVersion;
      const hit = worldViewRoomSignatureMemo.get(view.levelId);

      if (
        hit &&
        hit.bKey === bKey &&
        hit.edges === edges &&
        hit.version === version &&
        hit.modelsVersion === modelsVersion &&
        hit.state === view.levelState
      ) {
        return hit.value;
      }

      const value = [
        view.levelId,
        signatureToken(levelStateSignature(view.levelState)),
        bKey,
        edges,
        modelsVersion,
        boundaryNeighborStatesToken(view.levelId)
      ].join(":");

      worldViewRoomSignatureMemo.set(view.levelId, {
        bKey,
        edges,
        version,
        modelsVersion,
        state: view.levelState,
        value
      });
      return value;
    }

    function disposeWorldViewRoomEntry(entry) {
      [entry.group, entry.edgeGroup].forEach((container) => {
        container.parent?.remove(container);
        container.traverse((child) => {
          if (child.geometry && !cachedGeometryHas(child.geometry)) {
            child.geometry.dispose();
          }
        });
      });
    }

    function attachWorldViewRoomEntry(entry, view) {
      entry.group.position.set(view.offset.x, 0, view.offset.z);
      entry.edgeGroup.position.set(view.offset.x, 0, view.offset.z);
      entry.edgeGroup.userData.edgeBasePosition.set(view.offset.x, 0, view.offset.z);
      scene.add(entry.group);
      edgeScene.add(entry.edgeGroup);
    }

    // Dim a room group by swapping its meshes onto the dimmed twins of their
    // shared cache materials — pixel-identical to a rebuild at `factor`, but
    // with zero meshing. Edge lines were never brightness-dimmed; the edge
    // group is intentionally untouched.
    function applyWorldViewRoomShadow(entry, factor) {
      const quantized = worldShadowQuantized(factor);

      if (entry.shadowFactor === quantized) {
        return;
      }

      entry.shadowFactor = quantized;
      entry.group.traverse((child) => {
        if (!child.isMesh || !child.material) {
          return;
        }

        if (child.userData.shadowBase === undefined) {
          child.userData.shadowBase = {
            material: child.material,
            castShadow: child.castShadow
          };
        }

        const base = child.userData.shadowBase;

        child.material =
          quantized >= 0.999 ? base.material : dimmedWorldMaterial(base.material, quantized);
        // Mirror renderContextCastsShadows(): neighbors stop casting
        // shadows below the 0.72 brightness gate.
        child.castShadow = base.castShadow && quantized > 0.72;
      });
    }

    function detachWorldViewRoomGroups() {
      worldViewRoomGroups.forEach((entry) => {
        entry.group.parent?.remove(entry.group);
        entry.edgeGroup.parent?.remove(entry.edgeGroup);
      });
    }

    function disposeWorldViewRoomGroups() {
      worldViewRoomGroups.forEach((entry) => {
        disposeWorldViewRoomEntry(entry);
      });
      worldViewRoomGroups.clear();
    }

    function buildWorldViewRoomEntry(view, brightness, signature, now) {
      const group = new THREE.Group();
      const edgeGroup = new THREE.Group();

      edgeGroup.userData.edgeBasePosition = new THREE.Vector3();

      // Room content renders at local origin so the finished group can be
      // repositioned for free when the anchor room changes.
      const previousScene = scene;
      const previousEdgeScene = edgeScene;

      scene = group;
      edgeScene = edgeGroup;

      try {
        renderLevelStateAt(view.levelState, { x: 0, z: 0 }, {
          role: "neighbor",
          brightness,
          dx: view.dx,
          dy: view.dy,
          hidePlayers: true
        }, now);
      } finally {
        scene = previousScene;
        edgeScene = previousEdgeScene;
      }

      group.updateMatrixWorld(true);
      edgeGroup.updateMatrixWorld(true);
      mergeImmediateSceneObjects(group, "mesh");
      mergeImmediateSceneObjects(edgeGroup, "line");
      return { group, edgeGroup, signature };
    }

    function worldViewRoomBrightness(view, now) {
      let brightness = view.brightness;

      // Quantized fade-ins rebuild the room group on every step, so they are
      // reserved for flyover where the whole world is on screen. Play mode
      // streams rooms in at final brightness; they are off-screen anyway.
      // Host pages can opt in (worldViewRoomFadeInsEnabled) for cinematic
      // world views like the mazebench.com home-page flyby.
      if (
        (app.isFlyoverMode || app.worldViewRoomFadeInsEnabled === true) &&
        app.flyoverRoomFadeIns instanceof Map
      ) {
        const startMs = app.flyoverRoomFadeIns.get(view.levelId);

        if (Number.isFinite(startMs)) {
          const durationMs = Math.max(1, Number(app.flyoverRoomFadeDurationMs) || 900);
          const progress = clamp01((now - startMs) / durationMs);

          if (progress >= 1) {
            app.flyoverRoomFadeIns.delete(view.levelId);
          } else {
            const eased = app.easeInOutQuad ? app.easeInOutQuad(progress) : progress;

            // Quantized so each fade step rebuilds the room group once.
            // 3 steps halves fade-driven re-meshes vs the original 6 while
            // staying visually smooth at sub-second fade durations.
            brightness *= Math.round(eased * 3) / 3;
          }
        }
      }

      return flyoverLevelBrightness(view.levelId, brightness);
    }

    function disposeWorldConsolidation() {
      if (!worldConsolidation) {
        return;
      }

      worldConsolidation.objects.forEach(({ object }) => {
        object.parent?.remove(object);
        object.geometry?.dispose();
      });
      // Snapshot restores mint their own materials/textures (they are not in
      // the shared caches); free them with the consolidation.
      worldConsolidation.ownedMaterials?.forEach((material) => material.dispose());
      worldConsolidation.ownedTextures?.forEach((texture) => texture.dispose());
      worldConsolidation = null;
    }

    // ---- World snapshot: serialized consolidated geometry ----
    // A host page can bake the consolidated world at build time and restore
    // it here in a few milliseconds instead of meshing 256 rooms. Positions
    // quantize to a shared uint16 grid (meshes and edge lines stay exactly
    // coincident); normals to int8. Dequantization is free: it rides the
    // object's position/scale transform.
    const WORLD_SNAPSHOT_FORMAT = 1;

    function alignOffset(value, alignment) {
      return Math.ceil(value / alignment) * alignment;
    }

    function serializeWorldConsolidation() {
      if (!worldConsolidation || !THREE) {
        return null;
      }

      const entries = [];
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;

      worldConsolidation.objects.forEach(({ object, targetScene }) => {
        const position = object.geometry?.attributes?.position;

        if (!position || Array.isArray(object.material)) {
          return;
        }

        const array = position.array;

        for (let i = 0; i < array.length; i += 3) {
          if (array[i] < minX) minX = array[i];
          if (array[i] > maxX) maxX = array[i];
          if (array[i + 1] < minY) minY = array[i + 1];
          if (array[i + 1] > maxY) maxY = array[i + 1];
          if (array[i + 2] < minZ) minZ = array[i + 2];
          if (array[i + 2] > maxZ) maxZ = array[i + 2];
        }

        entries.push({ object, targetScene });
      });

      if (!entries.length) {
        return null;
      }

      const spanX = Math.max(1e-6, maxX - minX);
      const spanY = Math.max(1e-6, maxY - minY);
      const spanZ = Math.max(1e-6, maxZ - minZ);
      const sharedMeta = { textures: {}, images: {} };
      const objects = [];
      let byteLength = 0;

      const sections = entries.map(({ object, targetScene }) => {
        const geometry = object.geometry;
        const position = geometry.attributes.position;
        const normal = geometry.attributes.normal || null;
        const uv = geometry.attributes.uv || null;
        const vertexCount = position.count;
        const material = object.material;
        let materialDescriptor;

        if (material.isMeshLambertMaterial && !material.map) {
          materialDescriptor = {
            strategy: "lambert",
            color: `#${material.color.getHexString()}`,
            opacity: material.opacity,
            transparent: material.transparent === true,
            depthWrite: material.depthWrite !== false,
            doubleSide: material.side === THREE.DoubleSide,
            flatShading: material.flatShading === true,
            emissive: material.emissive ? `#${material.emissive.getHexString()}` : null,
            emissiveIntensity: material.emissiveIntensity ?? 1,
            polygonOffset: material.polygonOffset === true,
            polygonOffsetFactor: material.polygonOffsetFactor || 0,
            polygonOffsetUnits: material.polygonOffsetUnits || 0
          };
        } else if (material.isLineBasicMaterial && !material.map) {
          materialDescriptor = {
            strategy: "line",
            color: `#${material.color.getHexString()}`,
            opacity: material.opacity
          };
        } else {
          materialDescriptor = {
            strategy: "json",
            json: material.toJSON(sharedMeta)
          };
        }

        const positionOffset = alignOffset(byteLength, 2);
        byteLength = positionOffset + vertexCount * 3 * 2;
        let normalOffset = null;

        if (object.isMesh && normal) {
          normalOffset = alignOffset(byteLength, 1);
          byteLength = normalOffset + vertexCount * 3;
        }

        let uvOffset = null;

        if (uv) {
          uvOffset = alignOffset(byteLength, 4);
          byteLength = uvOffset + vertexCount * 2 * 4;
        }

        return {
          object,
          targetScene,
          geometry,
          position,
          normal,
          uv,
          vertexCount,
          materialDescriptor,
          positionOffset,
          normalOffset,
          uvOffset
        };
      });

      const buffer = new ArrayBuffer(byteLength);

      sections.forEach((section) => {
        const { object, targetScene, position, normal, uv, vertexCount } = section;
        const quantized = new Uint16Array(buffer, section.positionOffset, vertexCount * 3);
        const source = position.array;
        let localMinX = Infinity;
        let localMinY = Infinity;
        let localMinZ = Infinity;
        let localMaxX = -Infinity;
        let localMaxY = -Infinity;
        let localMaxZ = -Infinity;

        for (let i = 0; i < source.length; i += 3) {
          const nx = (source[i] - minX) / spanX;
          const ny = (source[i + 1] - minY) / spanY;
          const nz = (source[i + 2] - minZ) / spanZ;

          quantized[i] = Math.round(Math.max(0, Math.min(1, nx)) * 65535);
          quantized[i + 1] = Math.round(Math.max(0, Math.min(1, ny)) * 65535);
          quantized[i + 2] = Math.round(Math.max(0, Math.min(1, nz)) * 65535);

          if (nx < localMinX) localMinX = nx;
          if (ny < localMinY) localMinY = ny;
          if (nz < localMinZ) localMinZ = nz;
          if (nx > localMaxX) localMaxX = nx;
          if (ny > localMaxY) localMaxY = ny;
          if (nz > localMaxZ) localMaxZ = nz;
        }

        if (section.normalOffset !== null && normal) {
          const packed = new Int8Array(buffer, section.normalOffset, vertexCount * 3);
          const normals = normal.array;

          for (let i = 0; i < normals.length; i += 1) {
            packed[i] = Math.round(Math.max(-1, Math.min(1, normals[i])) * 127);
          }
        }

        if (section.uvOffset !== null && uv) {
          new Float32Array(buffer, section.uvOffset, vertexCount * 2).set(uv.array);
        }

        const centerX = (localMinX + localMaxX) / 2;
        const centerY = (localMinY + localMaxY) / 2;
        const centerZ = (localMinZ + localMaxZ) / 2;
        const radius =
          Math.sqrt(
            (localMaxX - localMinX) ** 2 +
              (localMaxY - localMinY) ** 2 +
              (localMaxZ - localMinZ) ** 2
          ) / 2;

        objects.push({
          kind: object.isMesh ? "mesh" : "line",
          target: targetScene === edgeScene ? "edge" : "scene",
          vertexCount,
          positionOffset: section.positionOffset,
          normalOffset: section.normalOffset,
          uvOffset: section.uvOffset,
          castShadow: object.castShadow === true,
          receiveShadow: object.receiveShadow === true,
          renderOrder: object.renderOrder || 0,
          boundingSphere: { center: [centerX, centerY, centerZ], radius },
          material: section.materialDescriptor
        });
      });

      return {
        manifest: {
          version: WORLD_SNAPSHOT_FORMAT,
          byteLength: buffer.byteLength,
          bounds: { min: [minX, minY, minZ], span: [spanX, spanY, spanZ] },
          objects,
          textures: Object.values(sharedMeta.textures),
          images: Object.values(sharedMeta.images),
          stats: {
            objectCount: objects.length,
            vertexCount: objects.reduce((sum, entry) => sum + entry.vertexCount, 0)
          }
        },
        buffer
      };
    }

    async function restoreWorldConsolidation(manifest, buffer) {
      if (!THREE || !renderer || !manifest || manifest.version !== WORLD_SNAPSHOT_FORMAT) {
        return false;
      }

      // Manifest and binary travel as two files; a mixed-version cache pair
      // (fresh .json + stale .bin) must fail closed into the live build.
      if (manifest.byteLength !== buffer.byteLength) {
        return false;
      }

      // Already resident (retained across a fly-in/fly-out round trip):
      // re-attach on the next render instead of re-minting GPU buffers.
      if (
        worldConsolidation?.fromSnapshot &&
        worldConsolidation.signature === `snapshot:${manifest.contentKey || ""}`
      ) {
        invalidateSceneCache();
        return true;
      }

      let jsonMaterialsById = null;
      const ownedMaterials = [];
      const ownedTextures = [];

      if (manifest.objects.some((entry) => entry.material?.strategy === "json")) {
        const textureDefs = manifest.textures || [];
        const imageDefs = manifest.images || [];
        const images = {};

        await Promise.all(
          imageDefs.map(
            (imageDef) =>
              new Promise((resolve) => {
                const image = new Image();
                image.onload = () => {
                  images[imageDef.uuid] = image;
                  resolve();
                };
                image.onerror = () => resolve();
                image.src = imageDef.url;
              })
          )
        );

        const textures = {};

        textureDefs.forEach((textureDef) => {
          const texture = new THREE.Texture(images[textureDef.image] || undefined);

          if (textureDef.uuid) texture.uuid = textureDef.uuid;
          if (textureDef.mapping !== undefined) texture.mapping = textureDef.mapping;
          if (textureDef.channel !== undefined) texture.channel = textureDef.channel;
          if (textureDef.magFilter !== undefined) texture.magFilter = textureDef.magFilter;
          if (textureDef.minFilter !== undefined) texture.minFilter = textureDef.minFilter;
          if (textureDef.colorSpace !== undefined) texture.colorSpace = textureDef.colorSpace;
          if (textureDef.flipY !== undefined) texture.flipY = textureDef.flipY;
          if (textureDef.format !== undefined) texture.format = textureDef.format;
          if (textureDef.type !== undefined) texture.type = textureDef.type;
          if (textureDef.anisotropy !== undefined) texture.anisotropy = textureDef.anisotropy;
          if (textureDef.generateMipmaps !== undefined) texture.generateMipmaps = textureDef.generateMipmaps;
          if (textureDef.premultiplyAlpha !== undefined) texture.premultiplyAlpha = textureDef.premultiplyAlpha;
          if (textureDef.unpackAlignment !== undefined) texture.unpackAlignment = textureDef.unpackAlignment;
          if (Array.isArray(textureDef.wrap)) {
            texture.wrapS = textureDef.wrap[0];
            texture.wrapT = textureDef.wrap[1];
          }
          if (Array.isArray(textureDef.repeat)) texture.repeat.fromArray(textureDef.repeat);
          if (Array.isArray(textureDef.offset)) texture.offset.fromArray(textureDef.offset);
          if (Array.isArray(textureDef.center)) texture.center.fromArray(textureDef.center);
          if (textureDef.rotation !== undefined) texture.rotation = textureDef.rotation;
          texture.needsUpdate = true;
          textures[textureDef.uuid] = texture;
          ownedTextures.push(texture);
        });

        const loader = new THREE.MaterialLoader();
        loader.setTextures(textures);
        jsonMaterialsById = new Map();

        manifest.objects.forEach((entry) => {
          if (entry.material?.strategy === "json" && !jsonMaterialsById.has(entry.material.json.uuid)) {
            const parsed = loader.parse(entry.material.json);
            jsonMaterialsById.set(entry.material.json.uuid, parsed);
            ownedMaterials.push(parsed);
          }
        });
      }

      disposeWorldConsolidation();

      const [minX, minY, minZ] = manifest.bounds.min;
      const [spanX, spanY, spanZ] = manifest.bounds.span;
      const objects = manifest.objects.map((entry) => {
        const geometry = new THREE.BufferGeometry();

        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(
            new Uint16Array(buffer, entry.positionOffset, entry.vertexCount * 3),
            3,
            true
          )
        );

        if (entry.normalOffset !== null && entry.normalOffset !== undefined) {
          geometry.setAttribute(
            "normal",
            new THREE.BufferAttribute(
              new Int8Array(buffer, entry.normalOffset, entry.vertexCount * 3),
              3,
              true
            )
          );
        }

        if (entry.uvOffset !== null && entry.uvOffset !== undefined) {
          geometry.setAttribute(
            "uv",
            new THREE.BufferAttribute(
              new Float32Array(buffer, entry.uvOffset, entry.vertexCount * 2),
              2
            )
          );
        }

        geometry.boundingSphere = new THREE.Sphere(
          new THREE.Vector3(...entry.boundingSphere.center),
          entry.boundingSphere.radius
        );
        markPersistentGeometry(geometry);

        const descriptor = entry.material || {};
        let objectMaterial;

        if (descriptor.strategy === "line") {
          objectMaterial = lineMaterial(descriptor.color, descriptor.opacity);
        } else if (descriptor.strategy === "json" && jsonMaterialsById) {
          objectMaterial = jsonMaterialsById.get(descriptor.json.uuid);
        } else {
          const options = {
            color: descriptor.color,
            flatShading: descriptor.flatShading === true,
            opacity: descriptor.opacity ?? 1,
            transparent: descriptor.transparent === true,
            depthWrite: descriptor.depthWrite !== false
          };

          if (descriptor.emissive) {
            options.emissive = descriptor.emissive;
            options.emissiveIntensity = descriptor.emissiveIntensity ?? 1;
          }

          objectMaterial = new THREE.MeshLambertMaterial(options);
          ownedMaterials.push(objectMaterial);

          if (descriptor.doubleSide) {
            objectMaterial.side = THREE.DoubleSide;
          }

          if (descriptor.polygonOffset) {
            objectMaterial.polygonOffset = true;
            objectMaterial.polygonOffsetFactor = descriptor.polygonOffsetFactor;
            objectMaterial.polygonOffsetUnits = descriptor.polygonOffsetUnits;
          }
        }

        const object =
          entry.kind === "mesh"
            ? new THREE.Mesh(geometry, objectMaterial)
            : new THREE.LineSegments(geometry, objectMaterial);

        object.castShadow = entry.castShadow === true;
        object.receiveShadow = entry.receiveShadow === true;
        object.renderOrder = entry.renderOrder || 0;
        // Dequantization rides the object transform: normalized [0,1]
        // attribute values scale/translate back into world space.
        object.position.set(minX, minY, minZ);
        object.scale.set(spanX, spanY, spanZ);

        if (entry.kind === "line") {
          // biasEdgeSceneTowardCamera resets edge objects to this base each
          // pass; it must equal the dequantization offset, not the origin.
          object.userData.edgeBasePosition = new THREE.Vector3(minX, minY, minZ);
        }

        return {
          object,
          // scene/edgeScene may not exist yet when a snapshot restores at
          // boot; resolve the actual Scene at attach time from the kind.
          targetKind: entry.target === "edge" ? "edge" : "scene"
        };
      });

      worldConsolidation = {
        signature: `snapshot:${manifest.contentKey || ""}`,
        fromSnapshot: true,
        objects,
        ownedMaterials,
        ownedTextures
      };
      invalidateSceneCache();
      return true;
    }

    function buildConsolidatedObjects(container, kind, targetScene) {
      const batches = new Map();
      const children = [];

      container.traverse((child) => {
        const isBatchable = kind === "mesh" ? child.isMesh : child.isLineSegments;

        if (
          !isBatchable ||
          !child.geometry?.attributes?.position ||
          !child.material ||
          Array.isArray(child.material)
        ) {
          return;
        }

        children.push(child);
      });

      children.forEach((child) => {
        const key = [
          kind,
          child.material.uuid,
          child.castShadow ? 1 : 0,
          child.receiveShadow ? 1 : 0,
          child.renderOrder || 0,
          attributeBatchSignature(child.geometry)
        ].join(":");

        if (!batches.has(key)) {
          batches.set(key, []);
        }

        batches.get(key).push(child);
      });

      const objects = [];

      batches.forEach((batch) => {
        const geometry = mergeGeometryBatch(batch);

        if (!geometry) {
          return;
        }

        const first = batch[0];
        const merged =
          kind === "mesh"
            ? new THREE.Mesh(geometry, first.material)
            : new THREE.LineSegments(geometry, first.material);

        merged.castShadow = first.castShadow;
        merged.receiveShadow = first.receiveShadow;
        merged.renderOrder = first.renderOrder;
        // Survives disposeSceneChildren across rebuilds; freed explicitly by
        // disposeWorldConsolidation.
        markPersistentGeometry(geometry);

        if (kind === "line") {
          merged.userData.edgeBasePosition = new THREE.Vector3(0, 0, 0);
        }

        objects.push({ object: merged, targetScene });
      });

      return objects;
    }

    function collectLevelStateModelUrls(levelState, urls) {
      (levelState?.terrain || []).forEach((row) => {
        (row || []).forEach((cell) => {
          for (let node = cell; node; node = node.underlay) {
            if (node.modelUrl) {
              urls.add(node.modelUrl);
            }

            (node.layers || []).forEach((layer) => {
              if (layer?.modelUrl) {
                urls.add(layer.modelUrl);
              }
            });
          }
        });
      });

      (levelState?.actors || []).forEach((actor) => {
        if (actor?.modelUrl) {
          urls.add(actor.modelUrl);
        }
      });
    }

    // Kick fetch+parse of every GLB and resolve once they are all ready (or
    // permanently failed). Hosts and the bake harness await this so the first
    // build already has real models instead of fallback primitives.
    function preloadModelAssets(urls) {
      const pending = [];

      (urls instanceof Set ? Array.from(urls) : urls || []).forEach((url) => {
        if (!url || requestModelAsset(url)) {
          return;
        }

        const promise = modelAssetCache.get(url)?.promise;

        if (promise) {
          pending.push(promise.catch(() => null));
        }
      });

      return Promise.all(pending);
    }

    let warmupModelUrls = null;
    let warmupModelUrlsVersion = -1;

    // Build missing world-view room groups into the cache WITHOUT attaching
    // them, so a snapshot-backed vista can warm the per-room world in idle
    // time — by the time the player flies into a save, every room group
    // already exists and nothing visibly regenerates. Returns true when all
    // current views are cached.
    function warmWorldViewRoomGroups(budgetMs = 8) {
      if (!THREE || !renderer || !usesRoomGroupWorld()) {
        return true;
      }

      const views = surroundingLevelViews();

      if (!views.length) {
        return false;
      }

      // Gate the very first builds on every GLB being loaded, so groups are
      // never meshed with fallback primitives (which would then have to be
      // torn down and rebuilt once the model arrives). Failed loads keep
      // their fallback and do not block.
      const statesVersion = app.horizontalNeighborStatesVersion || 0;

      if (!warmupModelUrls || warmupModelUrlsVersion !== statesVersion) {
        warmupModelUrls = new Set();
        warmupModelUrlsVersion = statesVersion;

        if (app.horizontalNeighborLevelStates instanceof Map) {
          app.horizontalNeighborLevelStates.forEach((state) => {
            if (state && typeof state.then !== "function") {
              collectLevelStateModelUrls(state, warmupModelUrls);
            }
          });
        }
      }

      let modelsPending = 0;

      warmupModelUrls.forEach((url) => {
        if (!requestModelAsset(url) && modelAssetCache.get(url)?.status === "loading") {
          modelsPending += 1;
        }
      });

      if (modelsPending > 0) {
        return false;
      }

      const now = performance.now();
      let remaining = 0;

      for (const view of views) {
        // Match renderWorldViewRoomGroups: outside flyover/fade-in
        // choreography groups build at full brightness (dimming is a
        // material swap, not a rebuild), so warmed signatures stay valid
        // across the vista/play brightness flip.
        const brightness =
          app.isFlyoverMode || app.worldViewRoomFadeInsEnabled === true
            ? worldViewRoomBrightness(view, now)
            : 1;
        const signature = worldViewRoomSignature(view, brightness);
        const existing = worldViewRoomGroups.get(view.levelId);

        if (existing && existing.signature === signature) {
          continue;
        }

        // Neighbor states still priming would bake "?" seams; try later.
        if (signature.includes("?")) {
          remaining += 1;
          continue;
        }

        if (performance.now() - now > budgetMs) {
          remaining += 1;
          continue;
        }

        if (existing) {
          disposeWorldViewRoomEntry(existing);
        }

        worldViewRoomGroups.set(
          view.levelId,
          buildWorldViewRoomEntry(view, brightness, signature, now)
        );
      }

      return remaining === 0;
    }

    function renderWorldViewRoomGroups(now, views) {
      // Snapshot-backed vista: the merged world was restored from a baked
      // snapshot, so there are no per-room groups to build — just keep the
      // snapshot objects attached. PLAY clears worldViewConsolidate, which
      // routes back through the normal path and disposes the snapshot.
      if (
        worldConsolidation?.fromSnapshot &&
        !app.isFlyoverMode &&
        app.worldViewConsolidate === true &&
        isWorldViewPlayMode()
      ) {
        worldViewRoomBuildPending = false;
        detachWorldViewRoomGroups();
        worldConsolidation.objects.forEach((entry) => {
          const target = entry.targetKind === "edge" ? edgeScene : scene;

          if (target && entry.object.parent !== target) {
            target.add(entry.object);
          }
        });
        return;
      }

      const activeLevelIds = new Set();
      const consolidationParts = [];
      const isWideLevelTransition =
        !app.isFlyoverMode &&
        app.levelTransition?.transitionData?.kind === "adjacent-scene" &&
        isWorldViewPlayMode();
      // Play mode builds missing room groups nearest-first within a per-frame
      // budget so the world streams in without blocking the frame. Flyover
      // keeps synchronous builds: its reveal choreography expects every room
      // to appear on the frame its fade starts.
      // Hosts that prime every level state up front (mazebench.com home
      // vista) opt into one synchronous whole-world build; play mode keeps
      // the per-frame budget so frames never block.
      const buildBudgetMs =
        app.isFlyoverMode || app.worldViewSynchronousBuild === true
          ? Infinity
          : isWideLevelTransition
            ? 3
            : 32;
      const pendingBuilds = [];
      let allRoomsReady = true;

      worldViewRoomBuildPending = false;

      // Outside flyover/fade-in choreography, room groups always BUILD at
      // full brightness and get dimmed afterwards by cheap material swaps
      // (applyWorldViewRoomShadow) — brightness changes never re-mesh.
      const legacyBrightnessBuilds =
        app.isFlyoverMode || app.worldViewRoomFadeInsEnabled === true;
      const shadowFactor = legacyBrightnessBuilds ? 1 : worldShadowFactor(now);

      views
        .slice()
        .sort((a, b) => b.distance - a.distance)
        .forEach((view) => {
          const brightness = legacyBrightnessBuilds
            ? worldViewRoomBrightness(view, now)
            : 1;
          const signature = worldViewRoomSignature(view, brightness);
          const entry = worldViewRoomGroups.get(view.levelId);

          activeLevelIds.add(view.levelId);

          if (!entry || (!isWideLevelTransition && entry.signature !== signature)) {
            pendingBuilds.push({ view, brightness, signature });

            if (!entry) {
              return;
            }
          }

          attachWorldViewRoomEntry(entry, view);

          if (!legacyBrightnessBuilds) {
            applyWorldViewRoomShadow(entry, shadowFactor);
          }

          consolidationParts.push(`${view.levelId}@${view.offset.x},${view.offset.z}:${entry.signature}`);
        });

      const buildStart = performance.now();

      // Nearest-first; rooms with still-loading boundary neighbors ("?" in
      // the signature) sink to the end — building them now would bake seam
      // edges that need an immediate rebuild once the neighbor arrives.
      pendingBuilds.forEach((pending) => {
        pending.awaitingNeighbors = pending.signature.includes("?") ? 1 : 0;
      });
      pendingBuilds.sort(
        (a, b) =>
          a.awaitingNeighbors - b.awaitingNeighbors ||
          a.view.distance - b.view.distance
      );

      for (const pending of pendingBuilds) {
        if (performance.now() - buildStart > buildBudgetMs) {
          worldViewRoomBuildPending = true;
          allRoomsReady = false;
          break;
        }

        const previous = worldViewRoomGroups.get(pending.view.levelId);

        // A room whose boundary neighbors are still loading would bake "?"
        // seams and need a full re-mesh per neighbor arrival (up to 5 builds
        // per frontier room). Wait for its neighbors instead — the fetch
        // stream keeps frames coming, so it builds once, correctly.
        if (
          pending.awaitingNeighbors &&
          !app.isFlyoverMode &&
          app.worldViewSynchronousBuild !== true &&
          !previous
        ) {
          worldViewRoomBuildPending = true;
          allRoomsReady = false;
          continue;
        }

        if (previous) {
          disposeWorldViewRoomEntry(previous);
        }

        const entry = buildWorldViewRoomEntry(pending.view, pending.brightness, pending.signature, now);

        worldViewRoomGroups.set(pending.view.levelId, entry);
        attachWorldViewRoomEntry(entry, pending.view);

        if (!legacyBrightnessBuilds) {
          applyWorldViewRoomShadow(entry, shadowFactor);
        }

        allRoomsReady = false;
      }

      worldViewRoomGroups.forEach((entry, levelId) => {
        if (!activeLevelIds.has(levelId)) {
          disposeWorldViewRoomEntry(entry);
          worldViewRoomGroups.delete(levelId);
        }
      });

      // Flyover flight and host-flagged static world vistas (mazebench.com
      // home) consolidate into merged meshes: their camera sees every room
      // at once, so draw-call count dominates and frustum culling of
      // per-room groups buys nothing. Play mode (including wide transitions)
      // keeps per-room groups so the camera frustum culls off-screen rooms.
      const wantsWorldConsolidation =
        (app.isFlyoverMode && app.flyoverWholeWorld === true) ||
        (!app.isFlyoverMode && app.worldViewConsolidate === true && isWorldViewPlayMode());

      if (!wantsWorldConsolidation) {
        // Hosts that round-trip between the vista and play (mazebench.com
        // home) keep the merged world cached while it is off screen so
        // returning home re-attaches instead of re-meshing/re-fetching.
        if (worldConsolidation && app.retainWorldConsolidation === true) {
          worldConsolidation.objects.forEach(({ object }) => {
            object.parent?.remove(object);
          });
        } else {
          disposeWorldConsolidation();
        }
        return;
      }

      const fadesPending =
        app.flyoverRoomFadeIns instanceof Map && app.flyoverRoomFadeIns.size > 0;

      if (!allRoomsReady || fadesPending || views.length === 0 || worldShadowAnimating()) {
        disposeWorldConsolidation();
        return;
      }

      const consolidationSignature = consolidationParts.slice().sort().join("|");

      if (!worldConsolidation || worldConsolidation.signature !== consolidationSignature) {
        disposeWorldConsolidation();
        scene.updateMatrixWorld(true);
        edgeScene.updateMatrixWorld(true);
        worldConsolidation = {
          signature: consolidationSignature,
          objects: buildConsolidatedObjects(scene, "mesh", scene).concat(
            buildConsolidatedObjects(edgeScene, "line", edgeScene)
          )
        };
      }

      // Swap the individual groups out for the consolidated snapshot; the
      // groups stay cached for the next time the world changes.
      detachWorldViewRoomGroups();
      worldConsolidation.objects.forEach(({ object, targetScene }) => {
        targetScene.add(object);
      });
    }

    function renderSurroundingLevelViews(now, views) {
      renderFlyoverDepartingLevelViews(now);
      const cameraFlightViews = Array.isArray(app.cameraFlightLevelViews)
        ? app.cameraFlightLevelViews.filter((view) => view?.levelState && view?.offset)
        : [];
      const cameraFlightLevelIds = new Set(
        cameraFlightViews.map((view) => String(view.levelId || view.levelState?.levelId || ""))
      );
      const baseViews = cameraFlightLevelIds.size > 0
        ? views.filter((view) => !cameraFlightLevelIds.has(String(view.levelId || "")))
        : views;

      if (usesRoomGroupWorld()) {
        renderWorldViewRoomGroups(now, baseViews);
        renderCameraFlightLevelViews(now, cameraFlightViews);
        return;
      }

      baseViews
        .slice()
        .sort((a, b) => b.distance - a.distance)
        .forEach((view) => {
          let brightness = view.brightness;

          if (app.isFlyoverMode && app.flyoverRoomFadeIns instanceof Map) {
            const startMs = app.flyoverRoomFadeIns.get(view.levelId);

            if (Number.isFinite(startMs)) {
              const durationMs = Math.max(1, Number(app.flyoverRoomFadeDurationMs) || 900);
              const progress = clamp01((now - startMs) / durationMs);

              if (progress >= 1) {
                app.flyoverRoomFadeIns.delete(view.levelId);
              } else {
                const eased = app.easeInOutQuad ? app.easeInOutQuad(progress) : progress;
                brightness *= eased;
              }
            }
          }

          brightness = flyoverLevelBrightness(view.levelId, brightness);
          renderLevelStateAt(view.levelState, view.offset, {
            role: "neighbor",
            brightness,
            dx: view.dx,
            dy: view.dy,
            hidePlayers: true
          }, now);
        });
      renderCameraFlightLevelViews(now, cameraFlightViews);
    }

    function renderCameraFlightLevelViews(now, views) {
      if (!Array.isArray(views) || views.length === 0) {
        return;
      }

      views
        .slice()
        .sort((a, b) => Number(b.distance || 0) - Number(a.distance || 0))
        .forEach((view) => {
          const brightness = flyoverLevelBrightness(view.levelId || view.levelState?.levelId, view.brightness ?? 1);

          renderLevelStateAt(view.levelState, view.offset, {
            role: view.role || "camera-flight",
            brightness,
            dx: view.dx,
            dy: view.dy,
            hidePlayers: view.hidePlayers === true
          }, now);
        });
    }

    function renderFlyoverDepartingLevelViews(now) {
      if (!app.isFlyoverMode || !Array.isArray(app.flyoverDepartingViews)) {
        return;
      }

      const durationMs = Math.max(1, Number(app.flyoverRoomFadeDurationMs) || 900);
      const remainingViews = [];

      app.flyoverDepartingViews
        .slice()
        .sort((a, b) => {
          const leftDistance = Math.hypot(a.offset?.x || 0, a.offset?.z || 0);
          const rightDistance = Math.hypot(b.offset?.x || 0, b.offset?.z || 0);

          return rightDistance - leftDistance;
        })
        .forEach((view) => {
          const progress = clamp01(
            (now - view.startMs) / Math.max(1, Number(view.durationMs) || durationMs)
          );

          if (progress >= 1) {
            return;
          }

          remainingViews.push(view);
          const eased = app.easeInOutQuad ? app.easeInOutQuad(progress) : progress;
          renderLevelStateAt(view.levelState, view.offset || { x: 0, z: 0 }, {
            role: "neighbor",
            brightness: 1 - eased,
            hidePlayers: true
          }, now);
        });

      app.flyoverDepartingViews = remainingViews;
    }

    function transitionSurroundingLevelAlpha(progress, appears) {
      const local = appears
        ? localProgress(progress, 0.12, 0.38)
        : 1 - localProgress(progress, 0.5, 0.36);

      return app.easeInOutQuad ? app.easeInOutQuad(clamp01(local)) : clamp01(local);
    }

    function outgoingNeighborAxisOffset(coord, levelLength, outgoingLength) {
      if (coord === 0) {
        return 0;
      }

      return coord < 0 ? coord * levelLength * unit : coord * outgoingLength * unit;
    }

    function incomingNeighborAxisOffset(coord, delta, levelLength, incomingLength, incomingOffset) {
      const relativeCoord = coord - delta;

      if (relativeCoord === 0) {
        return incomingOffset;
      }

      return incomingOffset + (
        relativeCoord < 0
          ? relativeCoord * levelLength * unit
          : relativeCoord * incomingLength * unit
      );
    }

    function outgoingNeighborOffset(coord, levelState, outgoingState) {
      return {
        x: outgoingNeighborAxisOffset(coord.x, levelState.width, outgoingState.width),
        z: outgoingNeighborAxisOffset(coord.y, levelState.height, outgoingState.height)
      };
    }

    function incomingNeighborOffset(coord, levelState, incomingState, incomingOffset, dx, dy) {
      return {
        x: incomingNeighborAxisOffset(coord.x, dx, levelState.width, incomingState.width, incomingOffset.x),
        z: incomingNeighborAxisOffset(coord.y, dy, levelState.height, incomingState.height, incomingOffset.z)
      };
    }

    function transitionSurroundingLevelViews(transition, outgoingState, incomingState, incomingOffset, progress) {
      const radius = surroundingLevelRadius();
      // Union of both neighborhoods, deduped to the nearest copy of each
      // room (world level ids wrap around the grid).
      const candidatesByLevelId = new Map();

      const addCandidate = (levelId, x, y) => {
        if (
          !levelId ||
          levelId === outgoingState.levelId ||
          levelId === incomingState.levelId
        ) {
          return;
        }

        const distance = Math.hypot(x - progress * transition.dx, y - progress * transition.dy);
        const existing = candidatesByLevelId.get(levelId);

        if (existing && existing.distance <= distance) {
          return;
        }

        candidatesByLevelId.set(levelId, { levelId, x, y, distance });
      };

      worldNeighborCoords(outgoingState.levelId, radius).forEach((coord) => {
        addCandidate(coord.levelId, coord.dx, coord.dy);
      });
      worldNeighborCoords(incomingState.levelId, radius).forEach((coord) => {
        addCandidate(coord.levelId, coord.dx + transition.dx, coord.dy + transition.dy);
      });

      const views = [];

      candidatesByLevelId.forEach((candidate) => {
        const coord = { x: candidate.x, y: candidate.y };
        const inOutgoingNeighborhood = Math.abs(coord.x) <= radius && Math.abs(coord.y) <= radius;
        const inIncomingNeighborhood =
          Math.abs(coord.x - transition.dx) <= radius &&
          Math.abs(coord.y - transition.dy) <= radius;

        let alpha = 1;

        if (inOutgoingNeighborhood && !inIncomingNeighborhood) {
          alpha = transitionSurroundingLevelAlpha(progress, false);
        } else if (!inOutgoingNeighborhood && inIncomingNeighborhood) {
          alpha = transitionSurroundingLevelAlpha(progress, true);
        }

        if (alpha <= 0.015) {
          return;
        }

        const levelState = app.cachedHorizontalNeighborLevelState?.(candidate.levelId);

        if (!levelState) {
          app.queueHorizontalNeighborLevelState?.(candidate.levelId, { priority: candidate.distance });
          return;
        }

        if (!levelState.width || !levelState.height) {
          return;
        }

        const offset = inOutgoingNeighborhood
          ? outgoingNeighborOffset(coord, levelState, outgoingState)
          : incomingNeighborOffset(
              coord,
              levelState,
              incomingState,
              incomingOffset,
              transition.dx,
              transition.dy
            );

        views.push({
          coord,
          dx: coord.x,
          dy: coord.y,
          levelId: candidate.levelId,
          levelState,
          offset,
          brightness: neighboringRoomBrightness,
          alpha,
          distance: candidate.distance
        });
      });

      return views;
    }

    function renderTransitionSurroundingLevelViews(now, views) {
      if (usesRoomGroupWorld()) {
        renderWorldViewRoomGroups(now, views);
        return;
      }

      views
        .slice()
        .sort((a, b) => b.distance - a.distance)
        .forEach((view) => {
          renderLevelStateAt(view.levelState, view.offset, {
            role: "neighbor",
            brightness: view.brightness,
            alpha: view.alpha,
            hidePlayers: true
          }, now);
        });
    }

    function transitionIncomingOffset(outgoingState, incomingState, dx, dy) {
      return {
        x: dx < 0 ? -incomingState.width * unit : dx > 0 ? outgoingState.width * unit : 0,
        z: dy < 0 ? -incomingState.height * unit : dy > 0 ? outgoingState.height * unit : 0
      };
    }

    function renderLevelStateAt(state, offset, context, now) {
      withRenderContext({
        state,
        offsetX: offset.x,
        offsetZ: offset.z,
        raisedPlayerGates: transitionSet(state.raisedPlayerGates),
        raisedOrangeWalls: transitionSet(state.raisedOrangeWalls),
        ...context
      }, () => {
        addTerrainRegions(now);
        renderActorsForCurrentContext(now);
      });
    }

    function worldActionCameraFrame(action, rooms) {
      const cameraProgress = clamp01(Number(action?.progress || 0));
      const firstRoom = rooms[0];
      const lastRoom = rooms[rooms.length - 1] || firstRoom;
      const firstCenterX =
        (Number(firstRoom?.offset?.x || 0) + Math.max(1, firstRoom?.levelState?.width || app.state.width) / 2) *
        unit;
      const firstCenterZ =
        (Number(firstRoom?.offset?.y || 0) + Math.max(1, firstRoom?.levelState?.height || app.state.height) / 2) *
        unit;
      const lastCenterX =
        (Number(lastRoom?.offset?.x || 0) + Math.max(1, lastRoom?.levelState?.width || app.state.width) / 2) *
        unit;
      const lastCenterZ =
        (Number(lastRoom?.offset?.y || 0) + Math.max(1, lastRoom?.levelState?.height || app.state.height) / 2) *
        unit;
      const cameraPoint = action?.cameraPoint;
      const centerX =
        Number.isFinite(Number(cameraPoint?.x))
          ? Number(cameraPoint.x) * unit
          : lerp(firstCenterX, lastCenterX, cameraProgress);
      const centerZ =
        Number.isFinite(Number(cameraPoint?.y))
          ? Number(cameraPoint.y) * unit
          : lerp(firstCenterZ, lastCenterZ, cameraProgress);
      const stableWidth = Math.max(1, action?.stableWidth || firstRoom?.levelState?.width || app.state.width);
      const stableHeight = Math.max(1, action?.stableHeight || firstRoom?.levelState?.height || app.state.height);
      const focusWidth = stableWidth * unit;
      const focusDepth = stableHeight * unit;

      return {
        centerX,
        centerZ,
        focusDepth,
        focusWidth,
        stableHeight: stableCameraWorldHeight()
      };
    }

    function worldActionRoomKey(room) {
      return [
        Math.round(Number(room?.offset?.x || 0) * 1000),
        Math.round(Number(room?.offset?.y || 0) * 1000)
      ].join(",");
    }

    function worldActionNeighborOffset(room, dx, dy, levelState) {
      const roomState = room?.levelState || {};

      return {
        x:
          Number(room?.offset?.x || 0) +
          (dx < 0 ? -levelState.width : dx > 0 ? Math.max(1, roomState.width || app.state.width) : 0),
        y:
          Number(room?.offset?.y || 0) +
          (dy < 0 ? -levelState.height : dy > 0 ? Math.max(1, roomState.height || app.state.height) : 0)
      };
    }

    function worldActionRoomDistanceFactor(view, frame, fadeStart, fadeDuration) {
      const levelState = view?.levelState;

      if (!levelState?.width || !levelState?.height) {
        return 0;
      }

      const centerX = (Number(view.offset?.x || 0) + levelState.width / 2) * unit;
      const centerZ = (Number(view.offset?.y || 0) + levelState.height / 2) * unit;
      const normalizedDistance = Math.max(
        Math.abs(centerX - frame.centerX) / Math.max(frame.focusWidth, unit),
        Math.abs(centerZ - frame.centerZ) / Math.max(frame.focusDepth, unit)
      );
      const fade = 1 - localProgress(normalizedDistance, fadeStart, fadeDuration);

      return app.easeInOutQuad ? app.easeInOutQuad(clamp01(fade)) : clamp01(fade);
    }

    function worldActionNeighborBrightness(view, frame) {
      const easedFade = worldActionRoomVisibilityFactor(view, frame);

      return neighboringRoomBrightness * easedFade;
    }

    function worldActionRoomVisibilityFactor(view, frame) {
      return worldActionRoomDistanceFactor(view, frame, 1.22, 0.72);
    }

    function worldActionPathRoomBrightness(room, frame) {
      const easedFade = worldActionRoomDistanceFactor(room, frame, 0.34, 0.92);

      return lerp(neighboringRoomBrightness, 1, easedFade);
    }

    function worldActionPathRoomAlpha(room, frame) {
      return worldActionRoomVisibilityFactor(room, frame);
    }

    function worldActionPathRoomView(room, frame) {
      const levelState = room?.levelState;

      if (!levelState?.width || !levelState?.height) {
        return null;
      }

      const alpha = worldActionPathRoomAlpha(room, frame);

      if (alpha <= 0.015) {
        return null;
      }

      return {
        alpha,
        brightness: worldActionPathRoomBrightness(room, frame),
        levelState,
        offset: room.offset
      };
    }

    function worldActionSurroundingLevelViews(action, frame) {
      const rooms = Array.isArray(action?.rooms) ? action.rooms : [];

      if (
        rooms.length === 0 ||
        typeof app.adjacentWorldLevelId !== "function" ||
        typeof app.cachedHorizontalNeighborLevelState !== "function"
      ) {
        return [];
      }

      const pathRoomKeys = new Set(rooms.map((room) => worldActionRoomKey(room)));
      const viewsByOffset = new Map();

      rooms.forEach((room) => {
        const baseLevelId = room?.levelId || room?.levelState?.levelId;

        if (!baseLevelId) {
          return;
        }

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) {
              continue;
            }

            const levelId = app.adjacentWorldLevelId(baseLevelId, dx, dy);
            const levelState = app.cachedHorizontalNeighborLevelState(levelId);

            if (!levelState?.width || !levelState?.height) {
              continue;
            }

            const offset = worldActionNeighborOffset(room, dx, dy, levelState);
            const offsetKey = [
              Math.round(offset.x * 1000),
              Math.round(offset.y * 1000)
            ].join(",");

            if (pathRoomKeys.has(offsetKey)) {
              continue;
            }

            const view = {
              distance: Math.hypot(
                (offset.x + levelState.width / 2) * unit - frame.centerX,
                (offset.y + levelState.height / 2) * unit - frame.centerZ
              ),
              levelId,
              levelState,
              offset
            };
            const brightness = worldActionNeighborBrightness(view, frame);

            if (brightness <= 0.015) {
              continue;
            }

            view.brightness = brightness;
            const previous = viewsByOffset.get(offsetKey);

            if (!previous || view.brightness > previous.brightness) {
              viewsByOffset.set(offsetKey, view);
            }
          }
        }
      });

      return Array.from(viewsByOffset.values());
    }

    function worldActionPuncherTiming(action, visual) {
      const timings = action?.timeline?.eventTimings;

      if (!timings || !Number.isFinite(Number(visual?.sequence))) {
        return null;
      }

      if (timings instanceof Map) {
        return timings.get(visual.sequence) || null;
      }

      return timings[visual.sequence] || null;
    }

    function worldActionActivePuncherVisuals(action) {
      const elapsedMs = Number(action?.elapsedMs || 0);

      return (action?.puncherVisuals || [])
        .map((visual) => {
          const timing = worldActionPuncherTiming(action, visual);

          if (!timing || elapsedMs < timing.lungeStartMs || elapsedMs >= timing.retractEndMs) {
            return null;
          }

          let progress = 0;
          let renderX = visual.finalX;
          let renderY = visual.finalY;

          if (elapsedMs < timing.lungeEndMs) {
            progress = localProgress(
              elapsedMs,
              timing.lungeStartMs,
              Math.max(1, timing.lungeEndMs - timing.lungeStartMs)
            );
            renderX = lerp(visual.finalX, visual.toX, progress);
            renderY = lerp(visual.finalY, visual.toY, progress);
          } else {
            progress = localProgress(
              elapsedMs,
              timing.retractStartMs,
              Math.max(1, timing.retractEndMs - timing.retractStartMs)
            );
            renderX = lerp(visual.toX, visual.finalX, progress);
            renderY = lerp(visual.toY, visual.finalY, progress);
          }

          return {
            ...visual,
            actor: {
              ...(visual.actor || {}),
              elevation: visual.finalElevation,
              removed: false,
              renderAlpha: 1,
              renderElevation: visual.finalElevation,
              renderInHole: false,
              renderPunchBaseX: visual.finalX,
              renderPunchBaseY: visual.finalY,
              renderPunchEffect: true,
              renderScale: 1,
              renderSink: 0,
              renderX,
              renderY,
              type: visual.actor?.type || "puncher",
              x: visual.finalX,
              y: visual.finalY
            }
          };
        })
        .filter(Boolean);
    }

    function renderWorldActionAnimation(now) {
      const action = app.worldActionAnimation;
      const rooms = Array.isArray(action?.rooms) ? action.rooms : [];
      const point = action?.currentPoint;

      if (rooms.length === 0 || !point) {
        addTerrainRegions(now);
        renderActorsForCurrentContext(now);
        fitCameraToScene();
        return;
      }

      const cameraFrame = worldActionCameraFrame(action, rooms);
      const pathRoomViews = rooms
        .map((room) => worldActionPathRoomView(room, cameraFrame))
        .filter(Boolean);
      const surroundingViews = worldActionSurroundingLevelViews(action, cameraFrame);
      const activePuncherVisuals = worldActionActivePuncherVisuals(action);
      const hiddenPuncherKeysByRoom = new Map();

      activePuncherVisuals.forEach((visual) => {
        if (!visual.roomKey || !visual.actorKey) {
          return;
        }

        const hiddenKeys = hiddenPuncherKeysByRoom.get(visual.roomKey) || new Set();

        hiddenKeys.add(visual.actorKey);
        hiddenPuncherKeysByRoom.set(visual.roomKey, hiddenKeys);
      });

      surroundingViews
        .slice()
        .sort((a, b) => b.distance - a.distance)
        .forEach((view) => {
          renderLevelStateAt(
            view.levelState,
            {
              x: Number(view.offset?.x || 0) * unit,
              z: Number(view.offset?.y || 0) * unit
            },
            {
              role: "neighbor",
              brightness: view.brightness,
              hidePlayers: true
            },
            now
          );
        });

      pathRoomViews.forEach((view) => {
        const roomKey = worldActionRoomKey({ offset: view.offset });

        renderLevelStateAt(
          view.levelState,
          {
            x: Number(view.offset?.x || 0) * unit,
            z: Number(view.offset?.y || 0) * unit
          },
          {
            role: "neighbor",
            alpha: view.alpha,
            brightness: view.brightness,
            hidePlayers: true,
            hiddenActorKeys: hiddenPuncherKeysByRoom.get(roomKey)
          },
          now
        );
      });

      const terminalFallProgress =
        action.terminalPlayerRemoved === true &&
        Number.isFinite(Number(action.timeline?.pathEndMs))
          ? clamp01(
              (Number(action.elapsedMs || 0) - Number(action.timeline.pathEndMs)) /
                Math.max(1, app.HOLE_FALL_DURATION_MS || 300)
            )
          : 0;
      const terminalFallEase = app.easeInOutQuad
        ? app.easeInOutQuad(terminalFallProgress)
        : terminalFallProgress;
      const terminalFadeProgress = terminalFallProgress <= 0.42
        ? 0
        : clamp01((terminalFallProgress - 0.42) / 0.58);
      const terminalFadeEase = app.easeInOutQuad
        ? app.easeInOutQuad(terminalFadeProgress)
        : terminalFadeProgress;

      const actor = {
        ...(action.player || {}),
        type: action.player?.type || "player",
        removed: false,
        renderX: point.x,
        renderY: point.y,
        renderElevation: point.elevation,
        renderScale: 1,
        renderAlpha: 1 - terminalFadeEase,
        renderSink: (app.HOLE_SINK_DISTANCE || app.TILE_SIZE * 3) * terminalFallEase,
        renderInHole: terminalFallProgress > 0
      };

      withRenderContext({ state: renderState(), offsetX: 0, offsetZ: 0 }, () => {
        activePuncherVisuals.forEach((visual) => {
          addActor(visual.actor, now);
        });
        addActor(actor, now);
      });

      fitCameraToScene({
        minX: cameraFrame.centerX - cameraFrame.focusWidth / 2,
        maxX: cameraFrame.centerX + cameraFrame.focusWidth / 2,
        minZ: cameraFrame.centerZ - cameraFrame.focusDepth / 2,
        maxZ: cameraFrame.centerZ + cameraFrame.focusDepth / 2,
        centerX: cameraFrame.centerX,
        centerZ: cameraFrame.centerZ,
        stableHeight: cameraFrame.stableHeight
      });
    }

    function transitionPlayerCenter(player, offset) {
      if (!player) {
        return null;
      }

      return {
        x: offset.x + ((player.renderX ?? player.x) + 0.5) * unit,
        z: offset.z + ((player.renderY ?? player.y) + 0.5) * unit,
        elevation: player.renderElevation ?? player.elevation ?? 0
      };
    }

    function liveTransitionTargetPlayer(transition) {
      const targetPlayer = transition?.targetPlayer || null;

      if (!targetPlayer) {
        return null;
      }

      return (
        (renderState().actors || []).find((actor) => {
          if (!app.isPlayerActor?.(actor) || actor.removed) {
            return false;
          }

          if (targetPlayer.type && actor.type !== targetPlayer.type) {
            return false;
          }

          return (
            !targetPlayer.groupId ||
            !actor.groupId ||
            actor.groupId === targetPlayer.groupId
          );
        }) || null
      );
    }

    function addTransitionPlayer(transition, outgoingOffset, incomingOffset, progress, now) {
      const sourcePlayer = transition.sourcePlayer || null;
      const targetPlayer = transition.targetPlayer || sourcePlayer;
      const liveTargetPlayer =
        transition.followIncomingPlayerDuringContinuation === true
          ? liveTransitionTargetPlayer(transition)
          : null;
      const liveSourcePlayer =
        transition.followSourcePlayerBeforeContinuation === true
          ? transition.liveSourcePlayer
          : null;
      const sourceForRender =
        liveSourcePlayer && transition.followIncomingPlayerDuringContinuation !== true
          ? liveSourcePlayer
          : sourcePlayer;
      const from = transitionPlayerCenter(sourceForRender, outgoingOffset);
      const to = transitionPlayerCenter(liveTargetPlayer || targetPlayer, incomingOffset);

      if (!from || !to) {
        return;
      }

      const transitionDuration = Math.max(1, app.levelTransition?.durationMs || app.LEVEL_TRANSITION_DURATION_MS || 500);
      const moveWindow = Math.max(0.08, Math.min(0.24, (app.MOVE_DURATION_MS || 100) / transitionDuration));
      const continuationStartedAtMs = Number(transition.continuationStartedAtMs);
      const hasContinuationHandoff =
        transition.followIncomingPlayerDuringContinuation === true &&
        Number.isFinite(continuationStartedAtMs);
      const handoffElapsedMs = hasContinuationHandoff
        ? Math.max(0, now - continuationStartedAtMs)
        : progress * transitionDuration;
      const handoffProgress = hasContinuationHandoff
        ? clamp01(handoffElapsedMs / Math.max(app.MOVE_DURATION_MS || 100, 1))
        : localProgress(progress, 0, moveWindow);
      const moveProgress = handoffProgress;
      const followLiveTarget =
        liveTargetPlayer &&
        transition.followIncomingPlayerDuringContinuation === true;
      const handoffSource = hasContinuationHandoff && transition.continuationSourcePlayer
        ? transitionPlayerCenter(transition.continuationSourcePlayer, outgoingOffset)
        : from;
      const followLiveSource =
        liveSourcePlayer &&
        transition.followSourcePlayerBeforeContinuation === true &&
        !hasContinuationHandoff;
      const liveTargetEntryOffsetX =
        followLiveTarget && hasContinuationHandoff
          ? -Number(transition.dx || 0) * unit * (1 - handoffProgress)
          : 0;
      const liveTargetEntryOffsetZ =
        followLiveTarget && hasContinuationHandoff
          ? -Number(transition.dy || 0) * unit * (1 - handoffProgress)
          : 0;
      const worldX = followLiveSource
        ? from.x
        : followLiveTarget
          ? to.x + liveTargetEntryOffsetX
          : handoffSource.x + (to.x - handoffSource.x) * moveProgress;
      const worldZ = followLiveSource
        ? from.z
        : followLiveTarget
          ? to.z + liveTargetEntryOffsetZ
          : handoffSource.z + (to.z - handoffSource.z) * moveProgress;
      const elevation = followLiveSource
        ? from.elevation
        : followLiveTarget
          ? to.elevation
          : handoffSource.elevation + (to.elevation - handoffSource.elevation) * moveProgress;
      const actor = {
        ...(liveTargetPlayer || liveSourcePlayer || targetPlayer || sourcePlayer),
        type: liveTargetPlayer?.type || targetPlayer?.type || sourcePlayer?.type || "player",
        removed: false,
        renderX: worldX / unit - 0.5,
        renderY: worldZ / unit - 0.5,
        renderElevation: elevation,
        renderScale: 1,
        renderAlpha: 1,
        renderSink: 0,
        renderInHole: false
      };

      withRenderContext({ state: renderState(), offsetX: 0, offsetZ: 0 }, () => {
        addActor(actor, now);
      });
    }

    function renderAdjacentLevelTransition(now) {
      const transition = app.levelTransition?.transitionData;

      if (transition?.kind !== "adjacent-scene" || !transition.outgoingLevel) {
        addTerrainRegions(now);
        renderActorsForCurrentContext(now);
        fitCameraToScene();
        return;
      }

      const progress = transitionProgress(now);
      const outgoingState = transition.outgoingLevel;
      const outgoingResetProgress = transitionResetProgress(progress);
      const outgoingResetState = transition.outgoingResetLevel || null;
      const outgoingRenderState = resetOutgoingLevelState(
        outgoingState,
        outgoingResetState,
        outgoingResetProgress
      );
      const outgoingSurfaceLiftValues = transitionSurfaceLiftValues(
        outgoingState,
        outgoingResetState,
        outgoingResetProgress
      );
      const incomingState = runtimeLevelState();
      const incomingOffset = transitionIncomingOffset(
        outgoingState,
        incomingState,
        transition.dx,
        transition.dy
      );
      const transitionViews = transition.lightweightTransition === true
        ? []
        : transitionSurroundingLevelViews(
            transition,
            outgoingState,
            incomingState,
            incomingOffset,
            progress
          );
      const outgoingOffset = { x: 0, z: 0 };
      const outgoingCenter = {
        x: outgoingOffset.x + (outgoingState.width * unit) / 2,
        z: outgoingOffset.z + (outgoingState.height * unit) / 2
      };
      const incomingCenter = {
        x: incomingOffset.x + (incomingState.width * unit) / 2,
        z: incomingOffset.z + (incomingState.height * unit) / 2
      };
      const cameraProgress =
        transition.steadyCamera === true ? clamp01(progress) : smootherStep(progress);
      const centerX = outgoingCenter.x + (incomingCenter.x - outgoingCenter.x) * cameraProgress;
      const centerZ = outgoingCenter.z + (incomingCenter.z - outgoingCenter.z) * cameraProgress;
      const focusWidth = Math.max(outgoingState.width, incomingState.width) * unit;
      const focusDepth = Math.max(outgoingState.height, incomingState.height) * unit;
      const stableHeight = Math.max(
        uncachedWorldHeightForState(outgoingState),
        uncachedWorldHeightForState(incomingState)
      );

      cameraEstimateOverride = {
        centerX,
        centerZ,
        stableHeight,
        worldWidth: focusWidth,
        worldHeight: focusDepth
      };

      try {
        renderTransitionSurroundingLevelViews(now, transitionViews);
        renderLevelStateAt(outgoingRenderState, outgoingOffset, {
          role: "outgoing",
          progress,
          dx: transition.dx,
          dy: transition.dy,
          surfaceLiftValues: outgoingSurfaceLiftValues,
          hidePlayers: true
        }, now);
        renderLevelStateAt(incomingState, incomingOffset, {
          role: "incoming",
          progress,
          dx: transition.dx,
          dy: transition.dy,
          raisedPlayerGates: transitionSet(transition.incomingRaisedPlayerGates),
          raisedOrangeWalls: transitionSet(transition.incomingRaisedOrangeWalls),
          hidePlayers: true
        }, now);
        addTransitionPlayer(transition, outgoingOffset, incomingOffset, progress, now);
      } finally {
        cameraEstimateOverride = null;
      }

      fitCameraToScene({
        minX: centerX - focusWidth / 2,
        maxX: centerX + focusWidth / 2,
        minZ: centerZ - focusDepth / 2,
        maxZ: centerZ + focusDepth / 2,
        centerX,
        centerZ,
        stableHeight
      });
    }

    function renderSceneToComposite(shouldUpdateShadowMap) {
      syncPlayerLiftMarkerRotations();
      renderer.info?.reset?.();
      renderer.setClearColor("#050608", 1);
      renderer.clear(true, true, true);
      renderer.shadowMap.needsUpdate = shouldUpdateShadowMap;
      renderer.render(scene, camera);
      const mainRenderInfo = renderer.info?.render
        ? { ...renderer.info.render }
        : { calls: 0, triangles: 0, points: 0, lines: 0 };

      if (app.isFlyoverMode && app.flyoverDirectCanvas === true) {
        if (edgeOutlinesEnabled()) {
          biasEdgeSceneTowardCamera();
          renderer.render(edgeScene, camera);
        }

        const totalRenderInfo = renderer.info?.render
          ? { ...renderer.info.render }
          : mainRenderInfo;
        app.threeRenderStats = {
          calls: totalRenderInfo.calls || 0,
          triangles: totalRenderInfo.triangles || 0,
          lines: totalRenderInfo.lines || 0,
          points: totalRenderInfo.points || 0,
          mainCalls: mainRenderInfo.calls || 0,
          mainTriangles: mainRenderInfo.triangles || 0,
          edgeCalls: Math.max(0, (totalRenderInfo.calls || 0) - (mainRenderInfo.calls || 0)),
          edgeLines: Math.max(0, (totalRenderInfo.lines || 0) - (mainRenderInfo.lines || 0)),
          sceneObjects: scene?.children?.length || 0,
          edgeObjects: edgeScene?.children?.length || 0,
          renderedAtMs: performance.now()
        };
        return;
      }

      app.sceneCtx.clearRect(0, 0, app.boardRect.width, app.boardRect.height);
      app.sceneCtx.drawImage(threeCanvas, 0, 0);

      if (edgeOutlinesEnabled()) {
        biasEdgeSceneTowardCamera();
        renderer.setClearColor("#000000", 0);
        renderer.clear(true, false, false);
        renderer.render(edgeScene, camera);
        drawToonOutlineOverlay(app.sceneCtx);
      }

      const totalRenderInfo = renderer.info?.render
        ? { ...renderer.info.render }
        : mainRenderInfo;
      app.threeRenderStats = {
        calls: totalRenderInfo.calls || 0,
        triangles: totalRenderInfo.triangles || 0,
        lines: totalRenderInfo.lines || 0,
        points: totalRenderInfo.points || 0,
        mainCalls: mainRenderInfo.calls || 0,
        mainTriangles: mainRenderInfo.triangles || 0,
        edgeCalls: Math.max(0, (totalRenderInfo.calls || 0) - (mainRenderInfo.calls || 0)),
        edgeLines: Math.max(0, (totalRenderInfo.lines || 0) - (mainRenderInfo.lines || 0)),
        sceneObjects: scene?.children?.length || 0,
        edgeObjects: edgeScene?.children?.length || 0,
        renderedAtMs: performance.now()
      };

      app.sceneCanvas.__pixelGameTextureVersion =
        (app.sceneCanvas.__pixelGameTextureVersion || 0) + 1;
    }

    function prewarmAdjacentLevelTransition(transitionData, durationMs = app.LEVEL_TRANSITION_DURATION_MS || 1000) {
      if (!THREE || !renderer || !camera || transitionData?.kind !== "adjacent-scene") {
        return;
      }

      const previousTransition = app.levelTransition;
      const previousCameraFitSignature = lastCameraFitSignature;
      const previousCameraFitHeight = lastCameraFitHeight;
      const now = performance.now();

      app.levelTransition = {
        transitionData,
        startMs: now - durationMs * 0.18,
        durationMs
      };

      try {
        resetScene();
        renderAdjacentLevelTransition(now);
        renderer.shadowMap.needsUpdate = true;
        renderer.render(scene, camera);

        if (edgeOutlinesEnabled()) {
          biasEdgeSceneTowardCamera();
          renderer.render(edgeScene, camera);
        }
      } finally {
        app.levelTransition = previousTransition;
        lastCameraFitSignature = previousCameraFitSignature;
        lastCameraFitHeight = previousCameraFitHeight;
        lastSceneSignature = "";
        lastSceneContentSignature = "";
        hasRenderedScene = false;
      }
    }

    // Compile the play-look shader programs (dimmed room materials + the
    // live current-room render) once, before the first fly-in, so the first
    // landing doesn't pay a ~50ms one-time GL program compile. renderer.compile
    // warms the programs without drawing to the canvas; the surrounding
    // scene state is torn down and the vista is rebuilt on the trailing
    // render so nothing visibly changes.
    let playLookShadersWarmed = false;

    function prewarmPlayLookShaders() {
      if (
        playLookShadersWarmed ||
        !THREE ||
        !renderer ||
        !camera ||
        typeof renderer.compile !== "function" ||
        app.isFlyoverMode ||
        !usesRoomGroupWorld()
      ) {
        return;
      }

      const saved = {
        consolidate: app.worldViewConsolidate,
        uniform: app.worldViewUniformBrightness,
        vista: app.worldViewVistaMode,
        fadeMs: app.worldShadowFadeMs,
        fitSignature: lastCameraFitSignature,
        fitHeight: lastCameraFitHeight
      };
      const savedFade = { ...worldShadowFade };

      try {
        // Play look: no consolidation, non-uniform brightness (rooms dim),
        // no vista anchor styling, shadow snapped to target.
        app.worldViewConsolidate = false;
        app.worldViewUniformBrightness = false;
        app.worldViewVistaMode = false;
        app.worldShadowFadeMs = 0;

        const now = performance.now();
        resetScene();
        const views = surroundingLevelViews();
        renderSurroundingLevelViews(now, views);
        addTerrainRegions(now);
        renderActorsForCurrentContext(now);
        fitCameraToScene(cameraFlightFitOptions() || flyoverFitOptions(views) || {});

        renderer.compile(scene, camera);

        if (edgeScene) {
          renderer.compile(edgeScene, camera);
        }

        playLookShadersWarmed = true;
      } catch (error) {
        // Never let a prewarm failure disturb the vista.
      } finally {
        Object.assign(worldShadowFade, savedFade);
        app.worldViewConsolidate = saved.consolidate;
        app.worldViewUniformBrightness = saved.uniform;
        app.worldViewVistaMode = saved.vista;
        app.worldShadowFadeMs = saved.fadeMs;
        lastCameraFitSignature = saved.fitSignature;
        lastCameraFitHeight = saved.fitHeight;
        invalidateSceneCache();
        // Rebuild + composite the vista so the canvas is unchanged.
        (app.renderOncePerFrame || app.render)(performance.now());
      }
    }

    function renderScene(now = performance.now()) {
      if (!THREE || !renderer || !camera) {
        return false;
      }

      syncRendererSize();
      const forceRender = hasActiveSceneAnimation();

      // Movement fast path: while only actor render positions animate, move
      // the tracked actor objects in place and re-render — no scene rebuild.
      if (
        forceRender &&
        app.isAnimating &&
        !app.worldActionAnimation &&
        !app.levelTransition &&
        app.gateAnimationFrameId === null &&
        app.orangeWallAnimationFrameId === null &&
        app.playerLiftAnimationFrameId === null &&
        !app.isFlyoverMode &&
        !isEditorRenderMode() &&
        hasRenderedScene &&
        syncActorTransforms(now)
      ) {
        app.threeFastAnimationFrameCount = (app.threeFastAnimationFrameCount || 0) + 1;
        renderSceneToComposite(true);
        lastSceneSignature = "";
        lastSceneContentSignature = "";
        return true;
      }

      const contentSignature = forceRender ? "" : sceneContentSignature(now);
      const signature = forceRender ? "" : `${contentSignature};${debugCameraSignature()}`;
      const contentChanged =
        forceRender ||
        !hasRenderedScene ||
        worldViewRoomBuildPending ||
        contentSignature !== lastSceneContentSignature;
      const shadowAnimationChanged = !app.isFlyoverMode && hasShadowAffectingAnimation();
      let shadowSignature = lastShadowSceneSignature;
      let shouldUpdateShadowMap = shadowAnimationChanged;

      if (contentChanged || shadowAnimationChanged) {
        shadowSignature = app.isFlyoverMode ? flyoverShadowSceneSignature() : contentSignature;
        shouldUpdateShadowMap =
          shadowAnimationChanged ||
          shadowSignature !== lastShadowSceneSignature;
      }

      if (
        !forceRender &&
        hasRenderedScene &&
        !worldViewRoomBuildPending &&
        signature === lastSceneSignature
      ) {
        // sceneCanvas already holds this exact frame; nothing to redraw —
        // but keep frames coming while the world-shadow fade animates
        // between quantized steps (only the ~12 step frames redraw).
        if (!app.isFlyoverMode && worldShadowAnimating()) {
          window.requestAnimationFrame((frameNow) => (app.renderOncePerFrame || app.render)(frameNow));
        }
        return true;
      }

      if (!contentChanged) {
        fitCameraToScene(editorSurroundingFitOptions() || cameraFlightFitOptions() || flyoverFitOptions() || {});
        renderSceneToComposite(false);
        lastSceneSignature = signature;
        return true;
      }

      resetScene();
      // Re-set by renderWorldViewRoomGroups when the build budget runs out.
      worldViewRoomBuildPending = false;

      if (app.worldActionAnimation) {
        renderWorldActionAnimation(now);
      } else if (app.levelTransition?.transitionData?.kind === "adjacent-scene") {
        renderAdjacentLevelTransition(now);
      } else {
        const surroundingViews = surroundingLevelViews();

        renderSurroundingLevelViews(now, surroundingViews);
        if (app.isFlyoverMode) {
          withRenderContext({
            state: renderState(),
            offsetX: 0,
            offsetZ: 0,
            role: "flyover-current",
            brightness: flyoverCurrentLevelBrightness(),
            hidePlayers: true
          }, () => {
            addTerrainRegions(now);
            renderActorsForCurrentContext(now);
          });
        } else if (app.worldViewVistaMode === true) {
          // Home-vista anchor room: render through the neighbor path so it
          // is indistinguishable from the baked snapshot rooms — no floor
          // grid, no tile-top details, no player avatar, frozen actors.
          renderLevelStateAt(renderState(), { x: 0, z: 0 }, {
            role: "neighbor",
            brightness: 1,
            dx: 0,
            dy: 0,
            hidePlayers: true
          }, now);
        } else {
          addTerrainRegions(now);
          renderActorsForCurrentContext(now);
        }
        fitCameraToScene(editorSurroundingFitOptions() || cameraFlightFitOptions() || flyoverFitOptions(surroundingViews) || {});
      }

      addEditorHoverHighlight();
      // While world rooms are still streaming in, every frame's content
      // signature changes; rebuilding the shadow map each time costs more
      // than the meshing budget itself. Defer it — the first frame after the
      // last room lands still sees a changed shadow signature and updates.
      // Same reasoning during the world-shadow fade and camera flights: the
      // light and geometry are static (only per-room brightness and the
      // camera move), so a briefly-stale shadow map is imperceptible and the
      // settled frame afterwards refreshes it. This is the biggest per-frame
      // saving during the vista→play dive.
      const cameraFlightInProgress =
        Array.isArray(app.cameraFlightLevelViews) && app.cameraFlightLevelViews.length > 0;
      const deferShadowMap =
        worldViewRoomBuildPending ||
        (!app.isFlyoverMode && (worldShadowAnimating() || cameraFlightInProgress));
      const updateShadowMapNow = shouldUpdateShadowMap && !deferShadowMap;
      renderSceneToComposite(updateShadowMapNow);
      lastSceneSignature = forceRender ? "" : signature;
      lastSceneContentSignature = forceRender ? "" : contentSignature;
      lastShadowSceneSignature = updateShadowMapNow ? shadowSignature : lastShadowSceneSignature;
      hasRenderedScene = true;

      if (worldViewRoomBuildPending || (!app.isFlyoverMode && worldShadowAnimating())) {
        // The room-group build budget ran out (or the world-shadow fade is
        // mid-flight); keep rendering frames until the work drains.
        window.requestAnimationFrame((frameNow) => (app.renderOncePerFrame || app.render)(frameNow));
      }

      return true;
    }

    function disposeRenderer() {
      if (debugCameraAnimationFrameId) {
        window.cancelAnimationFrame(debugCameraAnimationFrameId);
        debugCameraAnimationFrameId = 0;
      }

      if (debugCameraTiltHoldFrameId) {
        window.cancelAnimationFrame(debugCameraTiltHoldFrameId);
        debugCameraTiltHoldFrameId = 0;
      }

      if (editorHoverRenderFrameId) {
        window.cancelAnimationFrame(editorHoverRenderFrameId);
        editorHoverRenderFrameId = 0;
      }

      disposeWorldConsolidation();
      disposeWorldViewRoomGroups();
      disposeScene();
      geometryCache.forEach((geometry) => geometry.dispose());
      geometryCache.clear();
      edgeGeometryCache.forEach((geometry) => geometry.dispose());
      edgeGeometryCache.clear();
      materialCache.forEach((cached) => cached.dispose());
      materialCache.clear();
      lineMaterialCache.forEach((cached) => cached.dispose());
      lineMaterialCache.clear();
      imageMaterialCache.forEach((cached) => cached.dispose());
      imageMaterialCache.clear();
      groupLabelMaterialCache.forEach((cached) => cached.dispose());
      groupLabelMaterialCache.clear();
      textureCache.forEach((texture) => texture.dispose());
      textureCache.clear();
      groupLabelTextureCache.forEach((texture) => texture?.dispose?.());
      groupLabelTextureCache.clear();
      keyLight?.shadow?.dispose();
      keyLight?.dispose();
      ambientLight = null;
      keyLight = null;
      scene = null;
      edgeScene = null;
      camera = null;

      if (renderer) {
        renderer.renderLists?.dispose?.();
        renderer.dispose();
        renderer.forceContextLoss?.();
        renderer = null;
      }
    }

    app.threeRendererReady = import(threeModuleUrl)
      .then((module) => {
        THREE = module;
        // The loader resolves its bare "three" import through the page's
        // importmap to the same /vendor/three.module.js instance. Models
        // degrade to fallback shapes if it can't load.
        return import(gltfLoaderModuleUrl)
          .then((loaderModule) => {
            GLTFLoaderClass = loaderModule.GLTFLoader || null;
          })
          .catch(() => {
            GLTFLoaderClass = null;
          });
      })
      .then(() => {
        renderer = new THREE.WebGLRenderer({
          // alpha is load-bearing: the edge-outline overlay pass clears the
          // drawing buffer to transparent before compositing onto the 2D canvas.
          alpha: true,
          antialias: true,
          canvas: threeCanvas,
          logarithmicDepthBuffer: false,
          preserveDrawingBuffer: false
        });
        renderer.autoClear = false;
        renderer.info.autoReset = false;
        renderer.setClearColor("#050608", 1);
        renderer.setPixelRatio(1);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        scene = new THREE.Scene();
        scene.background = new THREE.Color("#050608");
        edgeScene = new THREE.Scene();
        createCameraForMode();
        updateCameraModeToggle();
        invalidateSceneCache();

        if (app.isFlyoverMode && app.mazeFrame && !threeCanvas.parentElement) {
          app.flyoverDirectCanvas = true;
          threeCanvas.className = "maze-canvas flyover-direct-canvas";
          threeCanvas.setAttribute("aria-label", app.canvas?.getAttribute("aria-label") || "Flyover view");
          app.canvas.style.display = "none";
          app.mazeFrame.appendChild(threeCanvas);
        }

        if (typeof app.render === "function") {
          window.requestAnimationFrame((now) => (app.renderOncePerFrame || app.render)(now));
        }
      })
      .catch(() => {
        THREE = null;
        renderer = null;
      });

    app.threeRenderer = {
      pickEditorFace,
      pickFlyoverLevel,
      isDebugCameraAnimating,
      setEditorHoverTarget,
      setDebugCameraView,
      getDebugCameraYaw: () => debugCameraTargetYaw,
      getDebugCameraTilt: () => debugCameraTargetTilt,
      getDebugCameraZoom: () => debugCameraTargetZoom,
      useLevelPreviewCamera,
      invalidateSceneCache,
      prewarmAdjacentLevelTransition,
      serializeWorldConsolidation,
      restoreWorldConsolidation,
      warmWorldViewRoomGroups,
      preloadModelAssets,
      prewarmPlayLookShaders,
      renderScene,
      renderHoverFrame,
      dispose: disposeRenderer,
      getRenderStats: () => ({ ...(app.threeRenderStats || {}) }),
      usesDirectCanvas: () => app.flyoverDirectCanvas === true,
      threeCanvas
    };

    ensureEdgeToggleControl();
    updateCameraDirectionMapper();
    if (app.enableCameraControls) {
      window.addEventListener("keydown", handleDebugCameraKeydown, true);
      window.addEventListener("keyup", handleDebugCameraKeyup, true);
      window.addEventListener("blur", () => {
        debugCameraTiltHoldKeys.clear();
        stopDebugCameraTiltHold();
      });
    }

    if (app.cameraModeToggle) {
      app.cameraModeToggle.addEventListener("click", toggleCameraMode);
      updateCameraModeToggle();
    }
  };
})();
