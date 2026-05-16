(function () {
  const modules = window.PlayModules || (window.PlayModules = {});
  const threeModuleUrl = "/vendor/three.module.js";

  modules.registerThreeRenderFunctions = function registerThreeRenderFunctions(app) {
    const threeCanvas = document.createElement("canvas");
    let THREE = null;
    let renderer = null;
    let scene = null;
    let edgeScene = null;
    let camera = null;
    let raycaster = null;
    let lastWidth = 0;
    let lastHeight = 0;
    let lastSceneSignature = "";
    let lastSceneContentSignature = "";
    let lastCameraFitSignature = "";
    let lastCameraFitHeight = 0;
    let hasRenderedScene = false;
    let debugCameraYaw = 0;
    let debugCameraTilt = 0.22;
    let debugCameraTargetYaw = debugCameraYaw;
    let debugCameraTargetTilt = debugCameraTilt;
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
    const compositeCanvas = document.createElement("canvas");
    const compositeCtx = compositeCanvas.getContext("2d");
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
    const gemModelWorldSize = unit * 0.87;
    const gemSpinPeriodMs = 7200;
    const puncherRadius = unit * 0.34;
    const puncherDepth = unit * 0.13;
    const puncherArmThickness = unit * 0.18;
    const debugCameraTopTilt = 0;
    const debugCameraSideTilt = Math.PI / 2;
    const debugCameraTiltHoldDurationMs = 500;
    const neighboringRoomBrightness = 0.62;
    const geometryCache = new Map();
    const edgeGeometryCache = new Map();
    const materialCache = new Map();
    const lineMaterialCache = new Map();
    const textureCache = new Map();
    const imageMaterialCache = new Map();
    const modelAssetCache = new Map();
    const outlineOffsetCache = new Map();
    const levelStateSignatureCache = new WeakMap();
    const groupLabelTextureCache = new Map();
    const groupLabelMaterialCache = new Map();
    const polycubeFaceCellsCache = new Map();
    const playerLiftMarkerMeshes = new Set();
    let polycubeComponentNeighborOffsetCache = null;
    let polycubeEdgeContactOffsetCache = null;

    function renderState() {
      return activeRenderContext?.state || app.state;
    }

    function invalidateSceneCache() {
      lastSceneSignature = "";
      lastSceneContentSignature = "";
      hasRenderedScene = false;
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
        ? new THREE.PerspectiveCamera(34, 1, 1, 8000)
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

    function debugCameraSignature() {
      if (!debugCameraActive) {
        return `camera:${cameraMode}:default`;
      }

      return `camera:${cameraMode}:${Math.round(debugCameraYaw * 1000)}:${Math.round(debugCameraTilt * 1000)}`;
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

      const progress = clamp01((now - debugCameraAnimation.startMs) / debugCameraAnimation.durationMs);
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

      lastSceneSignature = "";

      if (progress >= 1) {
        debugCameraYaw = debugCameraAnimation.targetYaw;

        if (debugCameraAnimation.targetTilt !== null) {
          debugCameraTilt = debugCameraAnimation.targetTilt;
          debugCameraTargetTilt = debugCameraTilt;
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

        if (typeof app.render === "function") {
          app.render(now);
        }

        if (stillAnimating) {
          scheduleDebugCameraAnimation();
        }
      });
    }

    function animateDebugCameraToTarget(durationMs = 220, options = {}) {
      const animateTilt = options.animateTilt !== false;

      debugCameraAnimation = {
        durationMs,
        startMs: performance.now(),
        startYaw: debugCameraYaw,
        startTilt: debugCameraTilt,
        targetYaw: debugCameraTargetYaw,
        targetTilt: animateTilt ? debugCameraTargetTilt : null
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

        if (typeof app.render === "function") {
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

    function handleDebugCameraKeydown(event) {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        eventTargetsEditableText(event)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      const yawStep = Math.PI / 2;
      let handled = true;
      let durationMs = 180;

      if (key === "w") {
        startDebugCameraTiltHold(key);
        event.preventDefault();
        return;
      } else if (key === "s") {
        startDebugCameraTiltHold(key);
        event.preventDefault();
        return;
      } else if (key === "a") {
        if (event.repeat) {
          return;
        }
        debugCameraTargetYaw -= yawStep;
        durationMs = 260;
      } else if (key === "d") {
        if (event.repeat) {
          return;
        }
        debugCameraTargetYaw += yawStep;
        durationMs = 260;
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

      const key = event.key.toLowerCase();

      if (key !== "w" && key !== "s") {
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
      return dimHexColor(color, renderContextBrightness());
    }

    function material(color, opacity = 1) {
      const alpha = Math.max(0, Math.min(1, opacity));
      const renderColor = renderContextColor(color);
      const key = `${renderColor}:${Math.round(alpha * 1000)}`;

      if (!materialCache.has(key)) {
        const options = {
          color: renderColor,
          flatShading: true,
          opacity: alpha,
          transparent: alpha < 0.999,
          depthWrite: alpha >= 0.999
        };

        if (renderColor !== "#050608") {
          options.emissive = renderColor;
          options.emissiveIntensity = renderColor === "#b85f16" ? 0.28 : 0.12;
        }

        materialCache.set(
          key,
          new THREE.MeshLambertMaterial(options)
        );
      }

      return materialCache.get(key);
    }

    function lineMaterial(color = "#000000", opacity = 1) {
      const alpha = Math.max(0, Math.min(1, opacity));
      const key = `${color}:${Math.round(alpha * 1000)}`;

      if (!lineMaterialCache.has(key)) {
        lineMaterialCache.set(
          key,
          new THREE.LineBasicMaterial({
            color,
            depthTest: true,
            depthWrite: false,
            linewidth: 1,
            opacity: alpha,
            transparent: alpha < 0.999
          })
        );
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

    function xmlElements(parent, tagName) {
      if (!parent || typeof parent.getElementsByTagNameNS !== "function") {
        return [];
      }

      return Array.from(parent.getElementsByTagNameNS("*", tagName));
    }

    function firstXmlElement(parent, tagName) {
      return xmlElements(parent, tagName)[0] || null;
    }

    function childXmlElements(parent, tagName) {
      if (!parent?.children) {
        return [];
      }

      return Array.from(parent.children).filter((child) => child.localName === tagName);
    }

    function parseFloatList(text) {
      const normalizedText = String(text || "").trim();

      if (!normalizedText) {
        return [];
      }

      return normalizedText
        .split(/\s+/)
        .map(Number)
        .filter((value) => Number.isFinite(value));
    }

    function stripColladaRef(value) {
      return String(value || "").replace(/^#/, "");
    }

    function colorHexFromFloats(values, fallback = "#2f7d3f") {
      if (!Array.isArray(values) || values.length < 3) {
        return fallback;
      }

      return `#${values
        .slice(0, 3)
        .map((value) => Math.round(clamp01(value) * 255).toString(16).padStart(2, "0"))
        .join("")}`;
    }

    function colladaMaterialColors(doc) {
      const effectColors = new Map();

      xmlElements(doc, "effect").forEach((effect) => {
        const id = effect.getAttribute("id");
        const diffuse = firstXmlElement(effect, "diffuse");
        const color = firstXmlElement(diffuse, "color");

        if (id && color) {
          effectColors.set(id, colorHexFromFloats(parseFloatList(color.textContent)));
        }
      });

      const materialColors = new Map();

      xmlElements(doc, "material").forEach((materialElement) => {
        const id = materialElement.getAttribute("id");
        const instanceEffect = firstXmlElement(materialElement, "instance_effect");
        const effectId = stripColladaRef(instanceEffect?.getAttribute("url"));

        if (id) {
          materialColors.set(id, effectColors.get(effectId) || "#2f7d3f");
        }
      });

      return materialColors;
    }

    function colladaSourceArrays(meshElement) {
      const sources = new Map();

      xmlElements(meshElement, "source").forEach((source) => {
        const id = source.getAttribute("id");
        const floatArray = firstXmlElement(source, "float_array");
        const accessor = firstXmlElement(source, "accessor");

        if (!id || !floatArray) {
          return;
        }

        sources.set(id, {
          values: parseFloatList(floatArray.textContent),
          stride: Math.max(1, Number(accessor?.getAttribute("stride")) || 3)
        });
      });

      return sources;
    }

    function colladaVertexSources(meshElement) {
      const vertices = new Map();

      xmlElements(meshElement, "vertices").forEach((vertexElement) => {
        const id = vertexElement.getAttribute("id");
        const positionInput = childXmlElements(vertexElement, "input").find(
          (input) => input.getAttribute("semantic") === "POSITION"
        );

        if (id && positionInput) {
          vertices.set(id, stripColladaRef(positionInput.getAttribute("source")));
        }
      });

      return vertices;
    }

    function colladaInputInfo(primitive, vertexSources) {
      const inputs = childXmlElements(primitive, "input").map((input) => ({
        offset: Math.max(0, Number(input.getAttribute("offset")) || 0),
        semantic: input.getAttribute("semantic"),
        source: stripColladaRef(input.getAttribute("source"))
      }));
      const stride = inputs.reduce((max, input) => Math.max(max, input.offset + 1), 1);
      const vertexInput = inputs.find((input) => input.semantic === "VERTEX");
      const positionInput = inputs.find((input) => input.semantic === "POSITION");
      const normalInput = inputs.find((input) => input.semantic === "NORMAL");

      return {
        normalInput,
        positionInput: positionInput || (vertexInput
          ? { ...vertexInput, source: vertexSources.get(vertexInput.source) }
          : null),
        stride
      };
    }

    function colladaVectorFromSource(source, index) {
      if (!source) {
        return null;
      }

      const offset = index * source.stride;

      if (offset + 2 >= source.values.length) {
        return null;
      }

      return [
        source.values[offset],
        source.values[offset + 1],
        source.values[offset + 2]
      ];
    }

    function parseColladaRawGeometryParts(doc, materialColors) {
      const geometryParts = new Map();

      xmlElements(doc, "geometry").forEach((geometryElement) => {
        const geometryId = geometryElement.getAttribute("id");
        const meshElement = firstXmlElement(geometryElement, "mesh");

        if (!geometryId || !meshElement) {
          return;
        }

        const sources = colladaSourceArrays(meshElement);
        const vertexSources = colladaVertexSources(meshElement);
        const parts = [];

        xmlElements(meshElement, "triangles").forEach((triangles) => {
          const { normalInput, positionInput, stride } = colladaInputInfo(triangles, vertexSources);
          const positionSource = sources.get(positionInput?.source);
          const normalSource = sources.get(normalInput?.source);
          const indices = parseFloatList(firstXmlElement(triangles, "p")?.textContent).map((value) => value | 0);

          if (!positionInput || !positionSource || indices.length < stride * 3) {
            return;
          }

          const positions = [];
          const normals = [];

          for (let index = 0; index < indices.length; index += stride) {
            const positionIndex = indices[index + positionInput.offset];
            const position = colladaVectorFromSource(positionSource, positionIndex);

            if (!position) {
              continue;
            }

            positions.push(...position);

            if (normalInput && normalSource) {
              const normalIndex = indices[index + normalInput.offset];
              const normal = colladaVectorFromSource(normalSource, normalIndex);

              if (normal) {
                normals.push(...normal);
              }
            }
          }

          if (positions.length > 0) {
            parts.push({
              color: materialColors.get(triangles.getAttribute("material")) || "#2f7d3f",
              normals: normals.length === positions.length ? normals : null,
              positions
            });
          }
        });

        geometryParts.set(geometryId, parts);
      });

      return geometryParts;
    }

    function colladaNodeMatrix(nodeElement) {
      const matrixElement = firstXmlElement(nodeElement, "matrix");
      const values = parseFloatList(matrixElement?.textContent);

      if (values.length !== 16) {
        return new THREE.Matrix4();
      }

      return new THREE.Matrix4().set(
        values[0], values[1], values[2], values[3],
        values[4], values[5], values[6], values[7],
        values[8], values[9], values[10], values[11],
        values[12], values[13], values[14], values[15]
      );
    }

    function transformedColladaPart(rawPart, matrix) {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
      const position = new THREE.Vector3();
      const normal = new THREE.Vector3();
      const positions = [];
      const normals = [];

      for (let index = 0; index < rawPart.positions.length; index += 3) {
        position
          .set(rawPart.positions[index], rawPart.positions[index + 1], rawPart.positions[index + 2])
          .applyMatrix4(matrix);
        positions.push(position.x, position.z, -position.y);

        if (rawPart.normals) {
          normal
            .set(rawPart.normals[index], rawPart.normals[index + 1], rawPart.normals[index + 2])
            .applyMatrix3(normalMatrix)
            .normalize();
          normals.push(normal.x, normal.z, -normal.y);
        }
      }

      const geometry = new THREE.BufferGeometry();
      geometry.userData.persistentGeometry = true;
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

      if (normals.length === positions.length) {
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
      } else {
        geometry.computeVertexNormals();
      }

      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      return {
        color: rawPart.color,
        geometry
      };
    }

    function parseColladaModel(text) {
      if (typeof DOMParser !== "function" || typeof text !== "string" || !text.trim()) {
        return null;
      }

      const doc = new DOMParser().parseFromString(text, "application/xml");
      const materialColors = colladaMaterialColors(doc);
      const rawGeometryParts = parseColladaRawGeometryParts(doc, materialColors);
      const parts = [];
      const instances = xmlElements(doc, "instance_geometry");

      instances.forEach((instance) => {
        const geometryId = stripColladaRef(instance.getAttribute("url"));
        const rawParts = rawGeometryParts.get(geometryId) || [];
        const matrix = colladaNodeMatrix(instance.parentElement);

        rawParts.forEach((rawPart) => {
          parts.push(transformedColladaPart(rawPart, matrix));
        });
      });

      if (parts.length === 0) {
        rawGeometryParts.forEach((rawParts) => {
          rawParts.forEach((rawPart) => {
            parts.push(transformedColladaPart(rawPart, new THREE.Matrix4()));
          });
        });
      }

      if (parts.length === 0) {
        return null;
      }

      const bounds = new THREE.Box3();
      parts.forEach((part) => {
        if (part.geometry.boundingBox) {
          bounds.union(part.geometry.boundingBox);
        }
      });

      return {
        bounds,
        parts
      };
    }

    function modelUrlIsGlb(url) {
      return /\.glb(?:[?#]|$)/i.test(String(url || ""));
    }

    function parseGlbChunks(arrayBuffer) {
      if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 20) {
        return null;
      }

      const view = new DataView(arrayBuffer);
      const glbMagic = 0x46546c67;
      const jsonChunkType = 0x4e4f534a;
      const binChunkType = 0x004e4942;

      if (view.getUint32(0, true) !== glbMagic || view.getUint32(4, true) !== 2) {
        return null;
      }

      const declaredLength = view.getUint32(8, true);
      const length = Math.min(declaredLength, arrayBuffer.byteLength);
      let offset = 12;
      let json = null;
      let bin = null;

      while (offset + 8 <= length) {
        const chunkLength = view.getUint32(offset, true);
        const chunkType = view.getUint32(offset + 4, true);
        const chunkOffset = offset + 8;
        const chunkEnd = chunkOffset + chunkLength;

        if (chunkEnd > length) {
          return null;
        }

        if (chunkType === jsonChunkType) {
          const text = new TextDecoder().decode(
            new Uint8Array(arrayBuffer, chunkOffset, chunkLength)
          );
          json = JSON.parse(text.trim());
        } else if (chunkType === binChunkType) {
          bin = arrayBuffer.slice(chunkOffset, chunkEnd);
        }

        offset = chunkEnd;
      }

      return json && bin ? { bin, json } : null;
    }

    function gltfComponentInfo(componentType) {
      switch (componentType) {
        case 5120:
          return { byteSize: 1, read: (view, offset) => view.getInt8(offset) };
        case 5121:
          return { byteSize: 1, read: (view, offset) => view.getUint8(offset) };
        case 5122:
          return { byteSize: 2, read: (view, offset) => view.getInt16(offset, true) };
        case 5123:
          return { byteSize: 2, read: (view, offset) => view.getUint16(offset, true) };
        case 5125:
          return { byteSize: 4, read: (view, offset) => view.getUint32(offset, true) };
        case 5126:
          return { byteSize: 4, read: (view, offset) => view.getFloat32(offset, true) };
        default:
          return null;
      }
    }

    function gltfAccessorItemSize(type) {
      return {
        SCALAR: 1,
        VEC2: 2,
        VEC3: 3,
        VEC4: 4,
        MAT2: 4,
        MAT3: 9,
        MAT4: 16
      }[type] || 1;
    }

    function normalizeGltfComponent(value, componentType) {
      switch (componentType) {
        case 5120:
          return Math.max(value / 127, -1);
        case 5121:
          return value / 255;
        case 5122:
          return Math.max(value / 32767, -1);
        case 5123:
          return value / 65535;
        default:
          return value;
      }
    }

    function gltfAccessorReader(gltf, binBuffer, accessorIndex) {
      const accessor = gltf.accessors?.[accessorIndex];
      const bufferView = gltf.bufferViews?.[accessor?.bufferView];
      const component = gltfComponentInfo(accessor?.componentType);

      if (!accessor || !bufferView || !component) {
        return null;
      }

      const itemSize = gltfAccessorItemSize(accessor.type);
      const view = new DataView(binBuffer);
      const byteOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
      const byteStride = bufferView.byteStride || component.byteSize * itemSize;
      const normalized = accessor.normalized === true;

      return {
        count: accessor.count || 0,
        itemSize,
        get(index, componentIndex = 0) {
          const offset = byteOffset + index * byteStride + componentIndex * component.byteSize;

          if (offset < 0 || offset + component.byteSize > binBuffer.byteLength) {
            return 0;
          }

          const value = component.read(view, offset);
          return normalized ? normalizeGltfComponent(value, accessor.componentType) : value;
        }
      };
    }

    function gltfMaterialColor(gltf, primitive) {
      const material = gltf.materials?.[primitive?.material];
      const color = material?.pbrMetallicRoughness?.baseColorFactor;

      return colorHexFromFloats(color, terrainColor("tree"));
    }

    function gltfNodeMatrix(node) {
      if (Array.isArray(node?.matrix) && node.matrix.length === 16) {
        return new THREE.Matrix4().fromArray(node.matrix);
      }

      const translation = Array.isArray(node?.translation) ? node.translation : [0, 0, 0];
      const rotation = Array.isArray(node?.rotation) ? node.rotation : [0, 0, 0, 1];
      const scale = Array.isArray(node?.scale) ? node.scale : [1, 1, 1];

      return new THREE.Matrix4().compose(
        new THREE.Vector3(translation[0] || 0, translation[1] || 0, translation[2] || 0),
        new THREE.Quaternion(
          rotation[0] || 0,
          rotation[1] || 0,
          rotation[2] || 0,
          rotation[3] === undefined ? 1 : rotation[3]
        ),
        new THREE.Vector3(
          scale[0] === undefined ? 1 : scale[0],
          scale[1] === undefined ? 1 : scale[1],
          scale[2] === undefined ? 1 : scale[2]
        )
      );
    }

    function transformedGltfPrimitivePart(gltf, binBuffer, primitive, matrix) {
      if (!primitive || (primitive.mode ?? 4) !== 4) {
        return null;
      }

      const positionReader = gltfAccessorReader(gltf, binBuffer, primitive.attributes?.POSITION);
      const normalReader = gltfAccessorReader(gltf, binBuffer, primitive.attributes?.NORMAL);
      const indexReader = primitive.indices === undefined
        ? null
        : gltfAccessorReader(gltf, binBuffer, primitive.indices);

      if (!positionReader) {
        return null;
      }

      const vertexCount = indexReader?.count || positionReader.count;
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
      const position = new THREE.Vector3();
      const normal = new THREE.Vector3();
      const positions = [];
      const normals = [];

      for (let index = 0; index < vertexCount; index += 1) {
        const vertexIndex = indexReader ? indexReader.get(index, 0) : index;

        position
          .set(
            positionReader.get(vertexIndex, 0),
            positionReader.get(vertexIndex, 1),
            positionReader.get(vertexIndex, 2)
          )
          .applyMatrix4(matrix);
        positions.push(position.x, position.y, position.z);

        if (normalReader) {
          normal
            .set(
              normalReader.get(vertexIndex, 0),
              normalReader.get(vertexIndex, 1),
              normalReader.get(vertexIndex, 2)
            )
            .applyMatrix3(normalMatrix)
            .normalize();
          normals.push(normal.x, normal.y, normal.z);
        }
      }

      if (positions.length < 9) {
        return null;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.userData.persistentGeometry = true;
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

      if (normals.length === positions.length) {
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
      } else {
        geometry.computeVertexNormals();
      }

      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      return {
        color: gltfMaterialColor(gltf, primitive),
        geometry
      };
    }

    function parseGlbModel(arrayBuffer) {
      const chunks = parseGlbChunks(arrayBuffer);

      if (!chunks) {
        return null;
      }

      const { bin, json: gltf } = chunks;
      const parts = [];

      function addMeshParts(meshIndex, matrix) {
        const mesh = gltf.meshes?.[meshIndex];

        if (!mesh || !Array.isArray(mesh.primitives)) {
          return;
        }

        mesh.primitives.forEach((primitive) => {
          const part = transformedGltfPrimitivePart(gltf, bin, primitive, matrix);

          if (part) {
            parts.push(part);
          }
        });
      }

      function visitNode(nodeIndex, parentMatrix) {
        const node = gltf.nodes?.[nodeIndex];

        if (!node) {
          return;
        }

        const matrix = parentMatrix.clone().multiply(gltfNodeMatrix(node));

        if (node.mesh !== undefined) {
          addMeshParts(node.mesh, matrix);
        }

        if (Array.isArray(node.children)) {
          node.children.forEach((childIndex) => visitNode(childIndex, matrix));
        }
      }

      const scene = gltf.scenes?.[gltf.scene ?? 0];
      const rootNodes = Array.isArray(scene?.nodes) ? scene.nodes : [];

      if (rootNodes.length > 0) {
        rootNodes.forEach((nodeIndex) => visitNode(nodeIndex, new THREE.Matrix4()));
      } else if (Array.isArray(gltf.nodes)) {
        gltf.nodes.forEach((node, index) => {
          if (node?.mesh !== undefined) {
            visitNode(index, new THREE.Matrix4());
          }
        });
      } else if (Array.isArray(gltf.meshes)) {
        gltf.meshes.forEach((mesh, index) => addMeshParts(index, new THREE.Matrix4()));
      }

      if (parts.length === 0) {
        return null;
      }

      const bounds = new THREE.Box3();
      parts.forEach((part) => {
        if (part.geometry.boundingBox) {
          bounds.union(part.geometry.boundingBox);
        }
      });

      return {
        bounds,
        parts
      };
    }

    function parseModelAsset(url, data) {
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const arrayBuffer = data instanceof ArrayBuffer
          ? data
          : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        return parseGlbModel(arrayBuffer);
      }

      if (typeof data === "string" && !modelUrlIsGlb(url)) {
        return parseColladaModel(data);
      }

      return null;
    }

    function requestModelAsset(url) {
      if (!url || !THREE) {
        return null;
      }

      const cached = modelAssetCache.get(url);

      if (cached?.status === "ready") {
        return cached.model;
      }

      if (cached?.status === "loading" || cached?.status === "failed") {
        return null;
      }

      const cachedData = app.modelTextCache?.get(url);

      if (cachedData instanceof ArrayBuffer || ArrayBuffer.isView(cachedData) || typeof cachedData === "string") {
        const model = parseModelAsset(url, cachedData);
        modelAssetCache.set(url, model ? { status: "ready", model } : { status: "failed" });
        return model;
      }

      if (cachedData === null) {
        modelAssetCache.set(url, { status: "failed" });
        return null;
      }

      const promise = fetch(url)
        .then((response) => {
          if (!response.ok) {
            return null;
          }

          return modelUrlIsGlb(url) ? response.arrayBuffer() : response.text();
        })
        .then((data) => {
          if (app.modelTextCache) {
            app.modelTextCache.set(url, data);
          }

          const model = parseModelAsset(url, data);
          modelAssetCache.set(url, model ? { status: "ready", model } : { status: "failed" });
          invalidateSceneCache();

          if (typeof app.render === "function") {
            window.requestAnimationFrame(() => app.render());
          }
        })
        .catch(() => {
          if (app.modelTextCache) {
            app.modelTextCache.set(url, null);
          }
          modelAssetCache.set(url, { status: "failed" });
          invalidateSceneCache();
        });

      modelAssetCache.set(url, { status: "loading", promise });
      return null;
    }

    function weightlessGroupLabel(groupId) {
      const value = String(groupId || "").trim();
      const match = value.match(/^M(.+)$/i);

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
      geometryCache.set(key, geometry);
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
      geometryCache.set(key, geometry);
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
      geometryCache.set(key, geometry);
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

    function sameRoomBoundaryDescriptor(leftDescriptor, rightDescriptor, a = null, b = null) {
      if (
        leftDescriptor?.type !== "wall" ||
        rightDescriptor?.type !== "wall"
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
      if (!options?.suppressSharedRoomEdges || options.descriptor?.type !== "wall") {
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

      const geometryIsCached = geometryCacheHas(geometry);
      const loops = orderedBoundaryLoops(cells);
      const rawEdges = geometryIsCached
        ? edgeGeometryFor(geometry, threshold)
        : new THREE.EdgesGeometry(geometry, threshold);
      const rawPositions = rawEdges.getAttribute("position");
      const positions = [];

      for (let index = 0; index < rawPositions.count; index += 2) {
        const a = {
          x: rawPositions.getX(index),
          y: rawPositions.getY(index),
          z: rawPositions.getZ(index)
        };
        const b = {
          x: rawPositions.getX(index + 1),
          y: rawPositions.getY(index + 1),
          z: rawPositions.getZ(index + 1)
        };

        if (!keepComponentEdgeSegment(a, b, loops, height)) {
          continue;
        }

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
            continue;
          }
        } else if (sharedRoomBoundaryEdgeSegment(a, b, options)) {
          continue;
        }

        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }

      if (!geometryIsCached) {
        rawEdges.dispose();
      }

      const filteredEdges = new THREE.BufferGeometry();
      filteredEdges.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

      if (cacheable) {
        edgeGeometryCache.set(key, filteredEdges);
      }

      return filteredEdges;
    }

    function addOutlinedMesh(geometry, color, position, options = {}) {
      const opacity = options.opacity ?? 1;
      const mesh = new THREE.Mesh(geometry, material(color, opacity));
      mesh.position.set(position.x, position.y, position.z);
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

    function addEdgeLines(geometry, position, threshold = 24, opacity = 1, edgeGeometry = null) {
      if (!edgeOutlinesEnabled()) {
        return null;
      }

      const lineOpacity = opacity * renderContextOpacity();

      if (lineOpacity <= 0.015) {
        return null;
      }

      const edges = new THREE.LineSegments(edgeGeometry || edgeGeometryFor(geometry, threshold), lineMaterial("#000000", lineOpacity));
      edges.position.copy(position);
      edges.userData.edgeBasePosition = position.clone();
      edgeScene.add(edges);
      return edges;
    }

    function biasEdgeSceneTowardCamera() {
      const cameraDirection = new THREE.Vector3();
      camera.getWorldDirection(cameraDirection);

      edgeScene.children.forEach((child) => {
        const basePosition = child.userData.edgeBasePosition;

        if (basePosition) {
          child.position.copy(basePosition);
          child.position.addScaledVector(cameraDirection, -edgeDepthBias);
        }
      });
    }

    function outlinePixelRadius() {
      return Math.max(1.5, unit * 0.035 * 0.75);
    }

    function outlinePixelOffsets(radius) {
      const key = Math.round(radius * 1000);

      if (outlineOffsetCache.has(key)) {
        return outlineOffsetCache.get(key);
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

      const loops = orderedBoundaryLoops(cells)
        .map((loop) => ({ loop, area: loopArea(loop) }))
        .filter((entry) => Math.abs(entry.area) > 0.001)
        .sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

      if (loops.length === 0) {
        return new THREE.BufferGeometry();
      }

      const shape = new THREE.Shape();
      const outerLoop = loops[0].area < 0 ? loops[0].loop.slice().reverse() : loops[0].loop;
      addLoopToPath(shape, outerLoop);

      loops.slice(1).forEach((entry) => {
        const hole = new THREE.Path();
        const holeLoop = entry.area > 0 ? entry.loop.slice().reverse() : entry.loop;
        addLoopToPath(hole, holeLoop);
        shape.holes.push(hole);
      });

      const geometry = new THREE.ExtrudeGeometry(shape, {
        bevelEnabled: false,
        depth: height,
        steps: 1
      });

      geometry.rotateX(Math.PI / 2);
      geometry.computeVertexNormals();

      if (cacheKey) {
        geometryCache.set(cacheKey, geometry);
      }

      return geometry;
    }

    function polycubeVoxelKey(x, y, z) {
      return `${x},${y},${z}`;
    }

    function polycubeVoxelSignature(voxels) {
      return voxels
        .map((voxel) => polycubeVoxelKey(voxel.x, voxel.y, voxel.z))
        .sort()
        .join("|");
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

        geometryCache.set(key, geometry);
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

      collectPolycubeFaceCells(voxels).forEach((faceGroup) => {
        faceGroup.cells.forEach((cellKey) => {
          const [a, b] = cellKey.split(",").map(Number);
          addPolycubeFaceQuad(positions, faceGroup.kind, faceGroup.plane, a, b);
        });
      });

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      geometryCache.set(cacheKey, geometry);
      return geometry;
    }

    function polycubeEdgeSegmentKey(from, to) {
      const keyParts = [from, to].map((point) =>
        point.map((value) => Math.round(value * 1000)).join(",")
      ).sort();

      return `${keyParts[0]}:${keyParts[1]}`;
    }

    function addPolycubeEdgeSegment(positions, seenSegments, from, to) {
      const key = polycubeEdgeSegmentKey(from, to);

      if (seenSegments.has(key)) {
        return;
      }

      seenSegments.add(key);
      positions.push(...from, ...to);
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
      faceGroup.cells.forEach((cellKey) => {
        const [a, b] = cellKey.split(",").map(Number);
        const neighbors = [
          { key: `${a - 1},${b}`, from: [a, b], to: [a, b + 1] },
          { key: `${a + 1},${b}`, from: [a + 1, b], to: [a + 1, b + 1] },
          { key: `${a},${b - 1}`, from: [a, b], to: [a + 1, b] },
          { key: `${a},${b + 1}`, from: [a, b + 1], to: [a + 1, b + 1] }
        ];

        neighbors.forEach((edge) => {
          if (faceGroup.cells.has(edge.key)) {
            return;
          }

          const from = polycubePointForFace(faceGroup.kind, faceGroup.plane, edge.from[0], edge.from[1]);
          const to = polycubePointForFace(faceGroup.kind, faceGroup.plane, edge.to[0], edge.to[1]);

          if (suppressedEdges.has(polycubeEdgeSegmentKey(from, to))) {
            return;
          }

          if (
            options?.suppressSharedRoomEdges &&
            sharedRoomBoundaryEdgeSegment(
              { x: from[0], y: from[1], z: from[2] },
              { x: to[0], y: to[1], z: to[2] },
              options
            )
          ) {
            return;
          }

          addPolycubeEdgeSegment(
            positions,
            seenSegments,
            from,
            to
          );
        });
      });
    }

    function polycubeEdgeGeometry(voxels, options = {}) {
      const cacheKey = [
        "polycube-edges",
        Math.round(renderOffsetX() * 100),
        Math.round(renderOffsetZ() * 100),
        options?.suppressSharedRoomEdges ? "shared" : "normal",
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

      collectPolycubeFaceCells(voxels).forEach((faceGroup) => {
        addPolycubeFaceBoundaryEdges(positions, seenSegments, faceGroup, suppressedEdges, options);
      });

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      edgeGeometryCache.set(cacheKey, geometry);
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
      geometryCache.set(key, geometry);
      return geometry;
    }

    function edgeGeometryFor(geometry, threshold) {
      if (!geometryCacheHas(geometry)) {
        return new THREE.EdgesGeometry(geometry, threshold);
      }

      const key = `${geometry.uuid}:${threshold}`;

      if (!edgeGeometryCache.has(key)) {
        edgeGeometryCache.set(key, new THREE.EdgesGeometry(geometry, threshold));
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

      if (type === "ice" || type === "ice_block") {
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
      return type === "floor" || type === "ice" || type === "exit" || type === "orange_button";
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
        (descriptor.type === "floor" || descriptor.type === "exit" || descriptor.type === "orange_button")
      );
    }

    function shouldRenderFloorGridLines() {
      return activeRenderContext?.role !== "neighbor";
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

      editorHoverRenderFrameId = window.requestAnimationFrame(() => {
        editorHoverRenderFrameId = 0;
        app.render();
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

      if (layer.type === "empty" || layer.type === "hole") {
        return null;
      }

      if (layer.type === "wall" || layer.type === "ice_block" || layer.type === "shrub") {
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
        if (activeRenderContext?.raisedOrangeWalls) {
          return elevation + (activeRenderContext.raisedOrangeWalls.has(key) ? 1 : 0);
        }

        return elevation + (isLiveState ? app.orangeWallLiftAt(x, y, now) : layer.raised === true ? 1 : 0);
      }

      return elevation;
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
      geometryCache.set(key, geometry);
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
          geometryCache.set(geometryKey, geometry);
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

    function addTileTopDetails(x, y, layer, topY, now = performance.now()) {
      const visibility = transitionPieceProgressForCell(x, y);

      if (visibility <= 0.05) {
        return;
      }

      const center = cellCenter(x, y);

      if (layer.type === "orange_button") {
        const buttonHeight = Math.max(4, elevationUnit * 0.12);
        const buttonRadius = unit * 0.21;

        addOutlinedMesh(
          cylinderGeometry(buttonRadius, buttonHeight),
          "#f59e0b",
          {
            x: center.x,
            y: topY + buttonHeight / 2,
            z: center.z
          },
          {
            edgeThreshold: 24,
            opacity: visibility
          }
        );
      }

      if (layer.type === "player_lift") {
        const lift = clamp01(renderTerrainLayerLiftValue(layer, x, y, now));

        addPlayerLiftTriangle(center, topY, -1, visibility * (1 - lift));
        addPlayerLiftTriangle(center, topY, 1, visibility * lift);
      }

      if (layer.type === "exit") {
        const gem = new THREE.Mesh(
          new THREE.OctahedronGeometry(unit * 0.18, 0),
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
      const isRaisedPiece = terrainHeight > elevation;
      const isLoweredPlayerLift = type === "player_lift" && !isRaisedPiece;
      const isStackedFloorCube = !isRaisedPiece && elevation > 0 && isStackableFloorType(type);
      const isSunkenFloor = !isRaisedPiece && terrainHeight === 0 && isSunkenFloorType(type);
      const topY = isLoweredPlayerLift
        ? topHeight + playerLiftPlateOffset()
        : isRaisedPiece || isStackedFloorCube
          ? topHeight
          : topHeight - (isSunkenFloor ? floorDrop : 0);
      const blockHeight = isRaisedPiece
        ? Math.max(1, topHeight - baseHeight)
        : isLoweredPlayerLift
          ? playerLiftPlateThickness()
          : isStackedFloorCube
            ? elevationUnit
            : floorThickness;
      const bottomY = topY - blockHeight;
      const descriptor = {
        blockHeight,
        bottomY,
        elevation,
        isLoweredPlayerLift,
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

    function terrainPieceDescriptorsAt(x, y, now = performance.now()) {
      const descriptors = renderTerrainLayersAt(x, y)
        .map((layer) => terrainPieceDescriptorForLayer(layer, x, y, now))
        .filter(Boolean);

      return mergeStackedTerrainPieces(descriptors, x, y);
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
            suppressSharedRoomEdges: descriptor.type === "wall"
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

    function terrainModelWorldScale(descriptor) {
      return descriptor.type === "shrub"
        ? treeModelWorldScale * shrubModelScaleMultiplier
        : treeModelWorldScale;
    }

    function treeModelPlacement(model, cell, descriptor) {
      const scale = terrainModelWorldScale(descriptor);
      const centerX = (cell.left + cell.right) / 2 + renderOffsetX();
      const centerZ = (cell.top + cell.bottom) / 2 + renderOffsetZ();

      return {
        scale,
        position: new THREE.Vector3(
          centerX,
          descriptor.bottomY - model.bounds.min.y * scale,
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
      return type === "tree" || type === "shrub";
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

      if (descriptor.isLoweredPlayerLift) {
        addOutlinedMesh(
          componentTopPlaneGeometry(cells),
          terrainColor(descriptor.type),
          { x: renderOffsetX(), y: descriptor.topY, z: renderOffsetZ() },
          {
            edgeThreshold: 18,
            opacity: visibility,
            castShadow: false,
            receiveShadow: false,
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
      const pieceEntries = [];
      const polycubePieceEntries = [];
      const state = renderState();

      for (let y = 0; y < state.height; y += 1) {
        const descriptorRow = [];
        const pieceMapRow = [];

        for (let x = 0; x < state.width; x += 1) {
          descriptorRow.push(terrainDescriptorAt(x, y, now));

          const pieceMap = new Map();
          terrainPieceDescriptorsAt(x, y, now).forEach((descriptor) => {
            if (canRenderTerrainPolycube(descriptor)) {
              polycubePieceEntries.push({ descriptor, x, y });
              return;
            }

            pieceMap.set(descriptor.key, descriptor);
            pieceEntries.push({ descriptor, x, y });
          });
          pieceMapRow.push(pieceMap);
        }

        descriptors.push(descriptorRow);
        pieceMaps.push(pieceMapRow);
      }

      const previousTerrainDescriptors = activeRenderContext?.terrainDescriptors;

      if (activeRenderContext) {
        activeRenderContext.terrainDescriptors = descriptors;
      }

      addTerrainPolycubeRegions(polycubePieceEntries, now);

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
            addTileTopDetails(x, y, descriptor.layer, descriptor.topY, now);
          }
        }
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
      const canMergeStackedWeightlessEntries = (lower, upper) =>
        lower.groupId === upper.groupId &&
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
        if (actor.type !== "weightless_box" || !actorIsVisible(actor)) {
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
          groupId: actor.groupId || `weightless-${index}`,
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
        new THREE.OctahedronGeometry(unit * 0.22 * scale, 0),
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

      const start = puncherAnchoredCenter(cellCenter(actor.x, actor.y), direction, depth);
      const end = center;
      const lengthX = Math.abs(end.x - start.x);
      const lengthZ = Math.abs(end.z - start.z);
      const horizontal = lengthX >= lengthZ;
      const width = Math.max(puncherArmThickness, lengthX + unit * 0.18);
      const armDepth = Math.max(puncherArmThickness, lengthZ + unit * 0.18);
      const height = unit * 0.16;
      const geometry = boxGeometry(
        horizontal ? width : puncherArmThickness,
        height,
        horizontal ? puncherArmThickness : armDepth
      );
      const mesh = new THREE.Mesh(geometry, material("#9ca3af", opacity));
      const position = new THREE.Vector3(
        (start.x + end.x) / 2,
        elevation * elevationUnit - sink + actorVisualLift + unit * 0.5,
        (start.z + end.z) / 2
      );

      mesh.position.copy(position);
      mesh.castShadow = renderContextCastsShadows();
      mesh.receiveShadow = false;
      scene.add(mesh);
      addEdgeLines(geometry, position, 18, edgeOpacity * 0.84);
    }

    function addPuncherCylinderPart(actor, geometry, color, center, y, direction, rotation, offset, opacity, editorPick) {
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
      addOrientedEdgeLines(geometry, position, rotation, opacity, 18);
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

      addPuncherArm(actor, anchoredCenter, direction, depth, elevation, sink, opacity, edgeOpacity);
      addPuncherCylinderPart(
        actor,
        backGeometry,
        "#ef4444",
        anchoredCenter,
        centerY,
        direction,
        rotation,
        0,
        opacity,
        editorPick
      );
      addPuncherCylinderPart(
        actor,
        middleGeometry,
        "#f8fafc",
        anchoredCenter,
        centerY,
        direction,
        rotation,
        depth * 0.58,
        opacity,
        editorPick
      );
      addPuncherCylinderPart(
        actor,
        bullseyeGeometry,
        "#b91c1c",
        anchoredCenter,
        centerY,
        direction,
        rotation,
        depth * 0.72,
        opacity,
        editorPick
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

      while (targetScene.children.length > 0) {
        const child = targetScene.children[0];

        if (child.geometry && !cachedGeometryHas(child.geometry)) {
          child.geometry.dispose();
        }

        targetScene.remove(child);
      }
    }

    function disposeScene() {
      disposeSceneChildren(scene);
      disposeSceneChildren(edgeScene);
      playerLiftMarkerMeshes.clear();
    }

    function geometryCacheHas(geometry) {
      if (geometry?.userData?.persistentGeometry) {
        return true;
      }

      for (const cached of geometryCache.values()) {
        if (cached === geometry) {
          return true;
        }
      }

      return false;
    }

    function cachedGeometryHas(geometry) {
      if (geometryCacheHas(geometry)) {
        return true;
      }

      for (const cached of edgeGeometryCache.values()) {
        if (cached === geometry) {
          return true;
        }
      }

      return false;
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
      const transitionViews = transitionSurroundingLevelViews(
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

    function resetScene() {
      disposeScene();
      scene = new THREE.Scene();
      edgeScene = new THREE.Scene();
      scene.background = new THREE.Color("#050608");
      scene.add(new THREE.AmbientLight("#ffffff", 1.45));
      const lightBounds = sceneLightBounds();
      const boardCenter = new THREE.Vector3(
        (lightBounds.minX + lightBounds.maxX) / 2,
        0,
        (lightBounds.minZ + lightBounds.maxZ) / 2
      );
      const keyLight = new THREE.DirectionalLight("#ffffff", 1.2);
      keyLight.position.set(boardCenter.x + unit * 5, unit * 18, boardCenter.z - unit * 5);
      keyLight.target.position.copy(boardCenter);
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.width = 1024;
      keyLight.shadow.mapSize.height = 1024;
      keyLight.shadow.bias = -0.0002;
      keyLight.shadow.normalBias = unit * 0.006;
      keyLight.shadow.radius = 4;

      const shadowSpan = Math.max(
        lightBounds.maxX - lightBounds.minX,
        lightBounds.maxZ - lightBounds.minZ,
        unit * 8
      );
      keyLight.shadow.camera.left = -shadowSpan;
      keyLight.shadow.camera.right = shadowSpan;
      keyLight.shadow.camera.top = shadowSpan;
      keyLight.shadow.camera.bottom = -shadowSpan;
      keyLight.shadow.camera.near = 1;
      keyLight.shadow.camera.far = shadowSpan * 3;
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
          app.levelTransition ||
          app.gateAnimationFrameId !== null ||
          app.orangeWallAnimationFrameId !== null ||
          app.playerLiftAnimationFrameId !== null
      );
    }

    function hasShadowAffectingAnimation() {
      return Boolean(
        app.isAnimating ||
          app.levelTransition ||
          app.gateAnimationFrameId !== null ||
          app.orangeWallAnimationFrameId !== null ||
          app.playerLiftAnimationFrameId !== null
      );
    }

    function floatingFloorAnimationSignature(now) {
      if (app.floatingFloorFrameId === null) {
        return "";
      }

      return `floating-floor:${Math.floor(now / Math.max(1, app.FLOATING_FLOOR_HOVER_FRAME_MS || 33))}`;
    }

    function sceneContentSignature(now) {
      const transition = app.levelTransition?.transitionData;
      const surroundingViews = surroundingLevelViews();
      const parts = [
        app.state.width,
        app.state.height,
        app.boardRect.width,
        app.boardRect.height,
        edgeOutlinesEnabled() ? "edges:on" : "edges:off",
        animationSignature(now),
        floatingFloorAnimationSignature(now),
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
        `neighbors:${surroundingViews
          .map((view) => `${view.dx},${view.dy},${view.levelId},${Math.round(view.brightness * 1000)}`)
          .join("|")}`
      ];

      surroundingViews.forEach((view) => {
        parts.push(`neighbor:${view.dx},${view.dy}:${levelStateSignature(view.levelState)}`);
      });

      for (let y = 0; y < app.state.height; y += 1) {
        for (let x = 0; x < app.state.width; x += 1) {
          const layers = app.terrainLayersAt(x, y);
          parts.push(layers.map(layerSignature).join("+") || "empty");
        }
      }

      app.state.actors.forEach((actor) => {
        parts.push(actorSignature(actor));
      });

      return parts.join(";");
    }

    function sceneSignature(now) {
      return [
        sceneContentSignature(now),
        debugCameraSignature()
      ].join(";");
    }

    function syncRendererSize() {
      const width = app.boardRect.width;
      const height = app.boardRect.height;

      if (width !== lastWidth || height !== lastHeight) {
        lastWidth = width;
        lastHeight = height;
        threeCanvas.width = width;
        threeCanvas.height = height;
        compositeCanvas.width = width;
        compositeCanvas.height = height;
        renderer.setSize(width, height, false);
      }

      if (camera.isPerspectiveCamera) {
        camera.aspect = width / Math.max(1, height);
        camera.fov = 34;
        camera.near = 1;
        camera.far = 8000;
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

    function fitCameraToScene(options = {}) {
      const stableHeight =
        options.stableHeight ??
        (isPalettePreviewRenderMode()
          ? palettePreviewCameraWorldHeight()
          : stableCameraWorldHeight());
      const minWorldX = options.minX ?? 0;
      const maxWorldX = options.maxX ?? app.boardRect.width;
      const minWorldZ = options.minZ ?? 0;
      const maxWorldZ = options.maxZ ?? app.boardRect.height;
      const center = new THREE.Vector3(
        options.centerX ?? (minWorldX + maxWorldX) / 2,
        stableHeight / 2,
        options.centerZ ?? (minWorldZ + maxWorldZ) / 2
      );
      const canvasWidth = Math.max(1, app.boardRect.width);
      const canvasHeight = Math.max(1, app.boardRect.height);
      const worldWidth = Math.max(1, maxWorldX - minWorldX);
      const worldHeight = Math.max(1, maxWorldZ - minWorldZ);
      const maxSpan = Math.max(worldWidth, worldHeight, stableHeight, unit);
      const isPalettePreview = isPalettePreviewRenderMode();
      const cameraYaw = isPalettePreview ? 0 : debugCameraYaw;
      const cameraTilt = clampDebugCameraTilt(isPalettePreview ? Math.PI * 0.18 : debugCameraTilt);
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
        );
        camera.updateProjectionMatrix();
        return;
      }

      camera.up.copy(cameraUp);

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

      camera.updateProjectionMatrix();
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

    function renderActorsForCurrentContext(now = performance.now()) {
      const state = renderState();
      const renderedActors = addWeightlessActorGroups();

      state.actors.forEach((actor) => {
        if (activeRenderContext?.hidePlayers && app.isPlayerActor?.(actor)) {
          return;
        }

        if (renderedActors.has(actor)) {
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

    function surroundingLevelBrightness(dx, dy) {
      return neighboringRoomBrightness;
    }

    function surroundingLevelOffset(dx, dy, levelState, currentState = runtimeLevelState()) {
      return {
        x: dx < 0 ? -levelState.width * unit : dx > 0 ? currentState.width * unit : 0,
        z: dy < 0 ? -levelState.height * unit : dy > 0 ? currentState.height * unit : 0
      };
    }

    function surroundingLevelViews() {
      if (!shouldRenderSurroundingLevels()) {
        return [];
      }

      const currentState = runtimeLevelState();
      const views = [];

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }

          const levelId = app.adjacentWorldLevelId?.(app.currentLevelId, dx, dy);

          if (!levelId) {
            continue;
          }

          const levelState = app.cachedHorizontalNeighborLevelState?.(levelId);

          if (!levelState) {
            app.queueHorizontalNeighborLevelState?.(levelId);
            continue;
          }

          if (!levelState.width || !levelState.height) {
            continue;
          }

          views.push({
            dx,
            dy,
            levelId,
            levelState,
            offset: surroundingLevelOffset(dx, dy, levelState, currentState),
            brightness: surroundingLevelBrightness(dx, dy),
            distance: Math.hypot(dx, dy)
          });
        }
      }

      return views;
    }

    function surroundingLevelBounds(views = []) {
      const currentState = runtimeLevelState();
      const currentWidth = Math.max(1, currentState.width) * unit;
      const currentHeight = Math.max(1, currentState.height) * unit;
      const bounds = shouldRenderSurroundingLevels()
        ? {
            minX: -currentWidth,
            maxX: currentWidth * 2,
            minZ: -currentHeight,
            maxZ: currentHeight * 2
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

    function renderSurroundingLevelViews(now, views) {
      views
        .slice()
        .sort((a, b) => b.distance - a.distance)
        .forEach((view) => {
          renderLevelStateAt(view.levelState, view.offset, {
            role: "neighbor",
            brightness: view.brightness,
            dx: view.dx,
            dy: view.dy,
            hidePlayers: true
          }, now);
        });
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

      return coord < 0 ? -levelLength * unit : outgoingLength * unit;
    }

    function incomingNeighborAxisOffset(coord, delta, levelLength, incomingLength, incomingOffset) {
      const relativeCoord = coord - delta;

      if (relativeCoord === 0) {
        return incomingOffset;
      }

      return incomingOffset + (relativeCoord < 0 ? -levelLength * unit : incomingLength * unit);
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

    function transitionLevelIdForCoord(coord, transition, outgoingState, incomingState) {
      const fromOutgoing = app.adjacentWorldLevelId?.(outgoingState.levelId, coord.x, coord.y);

      if (fromOutgoing) {
        return fromOutgoing;
      }

      return app.adjacentWorldLevelId?.(
        incomingState.levelId,
        coord.x - transition.dx,
        coord.y - transition.dy
      );
    }

    function transitionLevelStateForCoord(coord, transition, outgoingState, incomingState) {
      if (coord.x === 0 && coord.y === 0) {
        return outgoingState;
      }

      if (coord.x === transition.dx && coord.y === transition.dy) {
        return incomingState;
      }

      const levelId = transitionLevelIdForCoord(coord, transition, outgoingState, incomingState);

      if (!levelId) {
        return null;
      }

      const levelState = app.cachedHorizontalNeighborLevelState?.(levelId);

      if (!levelState) {
        app.queueHorizontalNeighborLevelState?.(levelId);
      }

      return levelState;
    }

    function transitionSurroundingLevelViews(transition, outgoingState, incomingState, incomingOffset, progress) {
      const coords = new Map();

      for (let y = -1; y <= 1; y += 1) {
        for (let x = -1; x <= 1; x += 1) {
          coords.set(`${x},${y}`, { x, y });
          coords.set(`${transition.dx + x},${transition.dy + y}`, {
            x: transition.dx + x,
            y: transition.dy + y
          });
        }
      }

      const views = [];

      coords.forEach((coord) => {
        const isOutgoingRoom = coord.x === 0 && coord.y === 0;
        const isIncomingRoom = coord.x === transition.dx && coord.y === transition.dy;

        if (isOutgoingRoom || isIncomingRoom) {
          return;
        }

        const inOutgoingNeighborhood = Math.abs(coord.x) <= 1 && Math.abs(coord.y) <= 1;
        const inIncomingNeighborhood =
          Math.abs(coord.x - transition.dx) <= 1 && Math.abs(coord.y - transition.dy) <= 1;

        let alpha = 1;

        if (inOutgoingNeighborhood && !inIncomingNeighborhood) {
          alpha = transitionSurroundingLevelAlpha(progress, false);
        } else if (!inOutgoingNeighborhood && inIncomingNeighborhood) {
          alpha = transitionSurroundingLevelAlpha(progress, true);
        }

        if (alpha <= 0.015) {
          return;
        }

        const levelState = transitionLevelStateForCoord(coord, transition, outgoingState, incomingState);

        if (!levelState?.width || !levelState?.height) {
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
          levelState,
          offset,
          brightness: neighboringRoomBrightness,
          alpha,
          distance: Math.hypot(coord.x - progress * transition.dx, coord.y - progress * transition.dy)
        });
      });

      return views;
    }

    function renderTransitionSurroundingLevelViews(now, views) {
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

    function addTransitionPlayer(transition, outgoingOffset, incomingOffset, progress, now) {
      const sourcePlayer = transition.sourcePlayer || null;
      const targetPlayer = transition.targetPlayer || sourcePlayer;
      const from = transitionPlayerCenter(sourcePlayer, outgoingOffset);
      const to = transitionPlayerCenter(targetPlayer, incomingOffset);

      if (!from || !to) {
        return;
      }

      const transitionDuration = Math.max(1, app.levelTransition?.durationMs || app.LEVEL_TRANSITION_DURATION_MS || 500);
      const moveWindow = Math.max(0.08, Math.min(0.24, (app.MOVE_DURATION_MS || 100) / transitionDuration));
      const moveProgress = app.easeInOutQuad
        ? app.easeInOutQuad(localProgress(progress, 0, moveWindow))
        : localProgress(progress, 0, moveWindow);
      const worldX = from.x + (to.x - from.x) * moveProgress;
      const worldZ = from.z + (to.z - from.z) * moveProgress;
      const elevation = from.elevation + (to.elevation - from.elevation) * moveProgress;
      const actor = {
        ...(targetPlayer || sourcePlayer),
        type: targetPlayer?.type || sourcePlayer?.type || "player",
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
      const transitionViews = transitionSurroundingLevelViews(
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
      const cameraProgress = smootherStep(progress);
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
      renderer.setClearColor("#050608", 1);
      renderer.clear(true, true, true);
      renderer.shadowMap.needsUpdate = shouldUpdateShadowMap;
      renderer.render(scene, camera);
      compositeCtx.clearRect(0, 0, app.boardRect.width, app.boardRect.height);
      compositeCtx.drawImage(threeCanvas, 0, 0);

      if (edgeOutlinesEnabled()) {
        biasEdgeSceneTowardCamera();
        renderer.setClearColor("#000000", 0);
        renderer.clear(true, false, false);
        renderer.render(edgeScene, camera);
        drawToonOutlineOverlay(compositeCtx);
      }

      app.sceneCtx.clearRect(0, 0, app.boardRect.width, app.boardRect.height);
      app.sceneCtx.drawImage(compositeCanvas, 0, 0);
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

    function renderScene(now = performance.now()) {
      if (!THREE || !renderer || !camera) {
        return false;
      }

      syncRendererSize();
      const forceRender = hasActiveSceneAnimation();
      const contentSignature = forceRender ? "" : sceneContentSignature(now);
      const signature = forceRender ? "" : `${contentSignature};${debugCameraSignature()}`;
      const contentChanged =
        forceRender ||
        !hasRenderedScene ||
        contentSignature !== lastSceneContentSignature;
      const shouldUpdateShadowMap =
        contentChanged || hasShadowAffectingAnimation();

      if (!forceRender && hasRenderedScene && signature === lastSceneSignature) {
        app.sceneCtx.clearRect(0, 0, app.boardRect.width, app.boardRect.height);
        app.sceneCtx.drawImage(compositeCanvas, 0, 0);
        return true;
      }

      if (!contentChanged) {
        fitCameraToScene(editorSurroundingFitOptions() || {});
        renderSceneToComposite(false);
        lastSceneSignature = signature;
        return true;
      }

      resetScene();

      if (app.levelTransition?.transitionData?.kind === "adjacent-scene") {
        renderAdjacentLevelTransition(now);
      } else {
        const surroundingViews = surroundingLevelViews();

        renderSurroundingLevelViews(now, surroundingViews);
        addTerrainRegions(now);
        renderActorsForCurrentContext(now);
        fitCameraToScene(editorSurroundingFitOptions() || {});
      }

      addEditorHoverHighlight();
      renderSceneToComposite(shouldUpdateShadowMap);
      lastSceneSignature = forceRender ? "" : signature;
      lastSceneContentSignature = forceRender ? "" : contentSignature;
      hasRenderedScene = true;
      return true;
    }

    app.threeRendererReady = import(threeModuleUrl)
      .then((module) => {
        THREE = module;
        renderer = new THREE.WebGLRenderer({
          alpha: true,
          antialias: true,
          canvas: threeCanvas,
          preserveDrawingBuffer: false
        });
        renderer.autoClear = false;
        renderer.setClearColor("#050608", 1);
        renderer.setPixelRatio(1);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        scene = new THREE.Scene();
        edgeScene = new THREE.Scene();
        createCameraForMode();
        updateCameraModeToggle();
        invalidateSceneCache();

        if (typeof app.render === "function") {
          window.requestAnimationFrame(() => app.render());
        }
      })
      .catch(() => {
        THREE = null;
        renderer = null;
      });

    app.threeRenderer = {
      pickEditorFace,
      setEditorHoverTarget,
      useLevelPreviewCamera,
      invalidateSceneCache,
      prewarmAdjacentLevelTransition,
      renderScene,
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
