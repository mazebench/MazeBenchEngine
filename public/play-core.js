(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.createPlayCore = function createPlayCore({
    playData,
    canvas,
    playShell,
    playHeader,
    playStage,
    mazeFrame,
    fuzzyToggle
  }) {
    const currentPathSegments = window.location.pathname.split("/").filter(Boolean);
    const currentGameId =
      (typeof playData?.gameId === "string" && playData.gameId) ||
      (currentPathSegments[0] === "play" ? currentPathSegments[1] : "") ||
      "maze";
    const currentLevelId =
      (typeof playData?.levelId === "string" && playData.levelId) ||
      (currentPathSegments[0] === "play" ? currentPathSegments[2] : "") ||
      "";
    function normalizeAxisValues(values, fallback) {
      if (!Array.isArray(values) || values.length === 0) {
        return fallback.slice();
      }

      const normalized = values
        .filter((value) => typeof value === "string" && /^[A-Z]$/.test(value))
        .slice();

      return normalized.length > 0 ? normalized : fallback.slice();
    }

    function normalizeViewportTiles(cameraView, fallbackWidth, fallbackHeight) {
      const widthValue = Number(cameraView?.width);
      const heightValue = Number(cameraView?.height);

      return {
        width: Number.isInteger(widthValue) && widthValue > 0 ? widthValue : fallbackWidth,
        height: Number.isInteger(heightValue) && heightValue > 0 ? heightValue : fallbackHeight
      };
    }

    const defaultWorldAxis = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    const initialViewportTiles = normalizeViewportTiles(playData?.cameraView, 10, 10);
    const app = {
      playData,
      currentGameId,
      currentLevelId,
      currentLevelLabel: playData.levelLabel || currentLevelId,
      worldColumns: normalizeAxisValues(playData?.worldColumns, defaultWorldAxis),
      worldRows: normalizeAxisValues(playData?.worldRows, defaultWorldAxis),
      canvas,
      playShell,
      playHeader,
      playStage,
      mazeFrame,
      fuzzyToggle,
      TILE_SIZE: 64,
      FUZZY_AMOUNT: 0.1,
      NOISE_FPS: 8,
      MOVE_DURATION_MS: 98,
      GATE_RISE_DURATION_MS: 220,
      GATE_FALL_DURATION_MS: 180,
      PLAYER_LIFT_RISE_DURATION_MS: 220,
      PLAYER_LIFT_FALL_DURATION_MS: 180,
      HOLE_FALL_DURATION_MS: 300,
      PLAYER_REVIVE_BLINK_DURATION_MS: 620,
      HOLE_SINK_DISTANCE: 64 * 0.42,
      GEM_HOVER_BASE: 64 * 0.035,
      GEM_HOVER_BOB: 64 * 0.028,
      GEM_HOVER_PERIOD_MS: 1800,
      GEM_DRAW_WIDTH: 64 * 0.56,
      GEM_SHADOW_WIDTH: 64 * 0.3,
      GEM_SHADOW_HEIGHT: 64 * 0.1,
      FLOATING_FLOOR_HOVER_BASE: 64 * 0.18,
      FLOATING_FLOOR_HOVER_BOB: 64 * 0.045,
      FLOATING_FLOOR_SHADOW_INSET: 64 * 0.16,
      FLOATING_FLOOR_SHADOW_HEIGHT: 64 * 0.12,
      FLOATING_FLOOR_HOVER_PERIOD_MS: 2400,
      FLOATING_FLOOR_HOVER_FPS: 30,
      VIEWPORT_TILE_WIDTH: initialViewportTiles.width,
      VIEWPORT_TILE_HEIGHT: initialViewportTiles.height,
      CAMERA_FOLLOW_SMOOTHING_MS: 210,
      LEVEL_TRANSITION_DURATION_MS: 340,
      PLAYER_LIFT_ARROW_URL: `/assets/${encodeURIComponent(currentGameId)}/images/arrow.png`,
      state: {
        width: playData.width,
        height: playData.height,
        terrain: playData.terrain,
        actors: playData.actors.map((actor) => ({
          ...actor,
          hoverSeed:
            (((actor.x + 1) * 0.61803398875 + (actor.y + 1) * 1.41421356237) % 1) * Math.PI * 2,
          renderX: actor.x,
          renderY: actor.y,
          elevation: 0,
          renderElevation: 0,
          renderScale: 1,
          renderAlpha: 1,
          renderSink: 0,
          renderInHole: false,
          removed: false
        })),
        effects: {
          fuzzyEnabled: fuzzyToggle ? fuzzyToggle.getAttribute("aria-pressed") === "true" : true,
          noisePhase: 0
        }
      },
      imageUrls: new Set(),
      sceneCanvas: document.createElement("canvas"),
      viewCanvas: document.createElement("canvas"),
      weightlessGroupCanvas: document.createElement("canvas"),
      imageCache: new Map(),
      moveHistory: [],
      animationFrameId: null,
      isAnimating: false,
      isTransitioningLevel: false,
      queuedAction: null,
      renderer: null,
      noiseFrameId: null,
      floatingFloorFrameId: null,
      lastFloatingFloorTickMs: 0,
      lastNoiseTickMs: 0,
      liveRaisedPlayerGates: new Set(),
      gateRenderOverride: null,
      gateAnimationFrameId: null,
      gateAnimationsInitialized: false,
      gateAnimations: new Map(),
      playerLiftAnimationFrameId: null,
      playerLiftAnimationsInitialized: false,
      playerLiftAnimations: new Map(),
      levelTransition: null,
      levelTransitionFrameId: null,
      cameraFrameId: null,
      lastCameraTickMs: 0,
      cameraX: 0,
      cameraY: 0,
      cameraTargetX: 0,
      cameraTargetY: 0
    };

    app.NOISE_FRAME_MS = 1000 / app.NOISE_FPS;
    app.FLOATING_FLOOR_HOVER_FRAME_MS = 1000 / app.FLOATING_FLOOR_HOVER_FPS;
    app.horizontalNeighborLevelStates = new Map();

    function parseWorldLevelId(levelId) {
      const match = String(levelId || "").match(/^level_([A-Z])x([A-Z])$/);

      if (!match) {
        return null;
      }

      const columnIndex = app.worldColumns.indexOf(match[1]);
      const rowIndex = app.worldRows.indexOf(match[2]);

      if (columnIndex === -1 || rowIndex === -1) {
        return null;
      }

      return {
        columnIndex,
        rowIndex
      };
    }

    function worldLevelId(columnIndex, rowIndex) {
      if (app.worldColumns.length === 0 || app.worldRows.length === 0) {
        return null;
      }

      const normalizedColumn = ((columnIndex % app.worldColumns.length) + app.worldColumns.length) % app.worldColumns.length;
      const normalizedRow = ((rowIndex % app.worldRows.length) + app.worldRows.length) % app.worldRows.length;
      return `level_${app.worldColumns[normalizedColumn]}x${app.worldRows[normalizedRow]}`;
    }

    function adjacentWorldLevelId(levelId, dx, dy) {
      const coordinates = parseWorldLevelId(levelId);

      if (!coordinates) {
        return null;
      }

      return worldLevelId(coordinates.columnIndex + dx, coordinates.rowIndex + dy);
    }

    function rememberHorizontalNeighborLevelState(levelState) {
      if (typeof levelState?.levelId !== "string" || !Array.isArray(levelState?.terrain)) {
        return null;
      }

      const storedLevelState = {
        levelId: levelState.levelId,
        width: Number(levelState.width) || 0,
        height: Number(levelState.height) || 0,
        terrain: cloneTerrainState(levelState.terrain)
      };

      app.horizontalNeighborLevelStates.set(levelState.levelId, storedLevelState);
      return storedLevelState;
    }

    function cachedHorizontalNeighborLevelState(levelId) {
      const cached = app.horizontalNeighborLevelStates.get(levelId);
      return cached && typeof cached.then !== "function" ? cached : null;
    }

    async function loadHorizontalNeighborLevelState(levelId) {
      if (!levelId || typeof window.fetch !== "function") {
        return null;
      }

      const cached = app.horizontalNeighborLevelStates.get(levelId);

      if (cached) {
        return typeof cached.then === "function" ? cached : Promise.resolve(cached);
      }

      const request = window
        .fetch(`/api/play/${encodeURIComponent(app.currentGameId)}/${encodeURIComponent(levelId)}`, {
          headers: {
            Accept: "application/json"
          }
        })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Unable to load ${levelId}`);
          }

          return rememberHorizontalNeighborLevelState(await response.json());
        })
        .catch((error) => {
          app.horizontalNeighborLevelStates.delete(levelId);
          throw error;
        });

      app.horizontalNeighborLevelStates.set(levelId, request);
      return request;
    }

    function queueHorizontalNeighborLevelState(levelId) {
      if (!levelId || typeof window.fetch !== "function") {
        return;
      }

      if (app.horizontalNeighborLevelStates.has(levelId)) {
        return;
      }

      loadHorizontalNeighborLevelState(levelId)
        .then(() => {
          if (!app.isTransitioningLevel && typeof app.render === "function") {
            app.render();
          }
        })
        .catch(() => {});
    }

    function syncHorizontalNeighborLevelStates() {
      queueHorizontalNeighborLevelState(adjacentWorldLevelId(app.currentLevelId, -1, 0));
      queueHorizontalNeighborLevelState(adjacentWorldLevelId(app.currentLevelId, 1, 0));
    }

    function hoverSeedForActor(actor) {
      return (((actor.x + 1) * 0.61803398875 + (actor.y + 1) * 1.41421356237) % 1) * Math.PI * 2;
    }

    function createRuntimeActor(actor) {
      const removed = Boolean(actor?.removed);
      const elevation = actor?.elevation ?? 0;

      return {
        ...actor,
        hoverSeed: actor?.hoverSeed ?? hoverSeedForActor(actor),
        renderX: actor?.renderX ?? actor.x,
        renderY: actor?.renderY ?? actor.y,
        elevation,
        renderElevation: actor?.renderElevation ?? elevation,
        renderScale: actor?.renderScale ?? (removed ? 0 : 1),
        renderAlpha: actor?.renderAlpha ?? (removed ? 0 : 1),
        renderSink: actor?.renderSink ?? (removed ? app.HOLE_SINK_DISTANCE : 0),
        renderInHole: Boolean(actor?.renderInHole),
        removed
      };
    }

    function registerImageUrl(url) {
      if (typeof url === "string" && url.length > 0) {
        app.imageUrls.add(url);
      }
    }

    function registerTerrainImageUrls(terrain) {
      terrain.forEach((row) => {
        row.forEach((cell) => {
          registerImageUrl(cell?.imageUrl || null);
          registerImageUrl(cell?.underlay?.imageUrl || null);
        });
      });
    }

    function registerActorImageUrls(actors) {
      actors.forEach((actor) => {
        registerImageUrl(actor?.imageUrl || null);
      });
    }

    app.state.actors = app.state.actors.map((actor) => createRuntimeActor(actor));
    registerTerrainImageUrls(app.state.terrain);
    registerActorImageUrls(app.state.actors);
    registerImageUrl(app.PLAYER_LIFT_ARROW_URL);

    function updateBoardMetrics(width = app.state.width, height = app.state.height) {
      app.boardRect = {
        width: width * app.TILE_SIZE,
        height: height * app.TILE_SIZE
      };
      app.viewportRect = {
        width: Math.min(width, app.VIEWPORT_TILE_WIDTH) * app.TILE_SIZE,
        height: Math.min(height, app.VIEWPORT_TILE_HEIGHT) * app.TILE_SIZE
      };
    }

    updateBoardMetrics();
    app.sceneCtx = app.sceneCanvas.getContext("2d");
    app.viewCtx = app.viewCanvas.getContext("2d");
    app.weightlessGroupCtx = app.weightlessGroupCanvas.getContext("2d");
    app.gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false
    });
    app.fallbackCtx = app.gl ? null : canvas.getContext("2d");

    if (!app.sceneCtx || !app.viewCtx || (!app.gl && !app.fallbackCtx)) {
      return null;
    }

    app.FRAGMENT_PRECISION =
      app.gl &&
      typeof app.gl.getShaderPrecisionFormat === "function" &&
      app.gl.getShaderPrecisionFormat(app.gl.FRAGMENT_SHADER, app.gl.HIGH_FLOAT)?.precision > 0
        ? "highp"
        : "mediump";
    app.NOISE_PHASE_CYCLE = 10;
    app.VERTEX_SHADER_SOURCE = `
      attribute vec2 a_position;
      varying vec2 v_uv;

      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;
    app.FRAGMENT_SHADER_SOURCE = `
      precision ${app.FRAGMENT_PRECISION} float;

      varying vec2 v_uv;

      uniform sampler2D u_texture;
      uniform vec2 u_logicalResolution;
      uniform float u_bleed;
      uniform float u_bloom;
      uniform float u_softness;
      uniform float u_scanlines;
      uniform float u_mask;
      uniform float u_ghosting;
      uniform float u_noise;
      uniform float u_vignetteStrength;
      uniform float u_noisePhase;

      float hashNoise(vec2 point) {
        return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
      }

      vec3 sampleSource(vec2 uv) {
        return texture2D(u_texture, clamp(uv, 0.0, 1.0)).rgb;
      }

      vec3 blurCross(vec2 uv, float radius) {
        vec2 uvPerPixel = 1.0 / u_logicalResolution;
        vec2 offset = uvPerPixel * radius;
        vec3 color = sampleSource(uv) * 0.28;
        color += sampleSource(uv + vec2(offset.x, 0.0)) * 0.18;
        color += sampleSource(uv - vec2(offset.x, 0.0)) * 0.18;
        color += sampleSource(uv + vec2(0.0, offset.y)) * 0.18;
        color += sampleSource(uv - vec2(0.0, offset.y)) * 0.18;
        color += sampleSource(uv + offset) * 0.045;
        color += sampleSource(uv - offset) * 0.045;
        color += sampleSource(uv + vec2(offset.x, -offset.y)) * 0.035;
        color += sampleSource(uv + vec2(-offset.x, offset.y)) * 0.035;
        return color;
      }

      vec3 buildMask(vec2 logicalCoord) {
        if (u_mask <= 0.0) {
          return vec3(1.0);
        }

        float stride = 1.0;
        float rowBand = 1.0;
        float column = floor(logicalCoord.x / stride);
        float row = floor(logicalCoord.y / rowBand);
        float phase = mod(column + mod(row, 2.0), 3.0);
        float monoMask = phase < 0.5 ? 1.08 : (phase < 1.5 ? 0.98 : 0.88);
        return vec3(mix(1.0, monoMask, u_mask));
      }

      void main() {
        vec2 logicalCoord = v_uv * u_logicalResolution;
        vec3 base = sampleSource(v_uv);
        vec3 soft = blurCross(v_uv, mix(0.55, 2.4, u_softness));
        vec3 bloom = blurCross(v_uv, 0.8 + u_bloom * 3.0);
        vec3 bleed = blurCross(v_uv, 0.45 + u_bleed * 1.85);
        vec2 uvPerPixel = 1.0 / u_logicalResolution;
        vec2 ghostOffset = uvPerPixel * vec2(0.25 + u_ghosting * 4.2, 0.16);
        float bleedShift = 0.4 + u_bleed * 2.6;
        vec3 bleedLeft = sampleSource(v_uv - vec2(uvPerPixel.x * bleedShift, 0.0));
        vec3 bleedRight = sampleSource(v_uv + vec2(uvPerPixel.x * bleedShift, 0.0));
        vec3 bleedShifted = (bleedLeft + bleed + bleedRight) / 3.0;
        vec3 ghost = sampleSource(v_uv + ghostOffset);
        float blurStrength = 0.5;
        float softMix = u_softness * 0.9 * blurStrength;
        vec3 color = mix(base, soft, softMix);
        color = mix(color, bleedShifted, u_bleed * 0.82 * blurStrength);

        color += max(vec3(0.0), bloom - base) * (u_bloom * 0.45 * blurStrength);
        color = mix(color, ghost, u_ghosting * 0.22 * blurStrength);

        float scanPhase = fract(logicalCoord.y);
        float beamProfile = 0.35 + 0.65 * (0.5 - 0.5 * cos(scanPhase * 6.28318530718));
        float beam = mix(1.0, beamProfile, u_scanlines);
        color *= beam;
        color *= buildMask(logicalCoord);

        float edgeDistance = length(v_uv * 2.0 - 1.0) / 1.41421356237;
        float vignette = mix(1.0, 1.0 - pow(edgeDistance, 2.2) * 0.32, u_vignetteStrength);
        color *= vignette;

        float phase = mod(floor(u_noisePhase + 0.5), 10.0);
        vec2 phaseOffset = vec2(phase * 7.0, phase * 13.0);
        float grain = (hashNoise(floor(logicalCoord) + phaseOffset) - 0.5) * u_noise;
        color += grain;

        gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
      }
    `;

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function usesScrollingViewport() {
      return (
        app.viewportRect.width !== app.boardRect.width || app.viewportRect.height !== app.boardRect.height
      );
    }

    function clampCameraAxis(target, boardSpan, viewSpan) {
      if (boardSpan <= viewSpan) {
        return -(viewSpan - boardSpan) / 2;
      }

      return clamp(target, 0, boardSpan - viewSpan);
    }

    function cameraFocusPoint() {
      const players = app.state.actors.filter((actor) => isPlayerActor(actor) && !actor.removed);

      if (players.length === 0) {
        return {
          x: app.cameraTargetX + app.viewportRect.width / 2,
          y: app.cameraTargetY + app.viewportRect.height / 2
        };
      }

      const focus = players.reduce(
        (sum, actor) => {
          sum.x += (actor.renderX + 0.5) * app.TILE_SIZE;
          sum.y += (actor.renderY + 0.5) * app.TILE_SIZE;
          return sum;
        },
        { x: 0, y: 0 }
      );

      return {
        x: focus.x / players.length,
        y: focus.y / players.length
      };
    }

    function syncCameraTarget(immediate = false) {
      if (!usesScrollingViewport()) {
        app.cameraX = 0;
        app.cameraY = 0;
        app.cameraTargetX = 0;
        app.cameraTargetY = 0;
        app.lastCameraTickMs = 0;
        return false;
      }

      const focus = cameraFocusPoint();
      app.cameraTargetX = clampCameraAxis(
        focus.x - app.viewportRect.width / 2,
        app.boardRect.width,
        app.viewportRect.width
      );
      app.cameraTargetY = clampCameraAxis(
        focus.y - app.viewportRect.height / 2,
        app.boardRect.height,
        app.viewportRect.height
      );

      if (immediate || app.lastCameraTickMs === 0) {
        app.cameraX = app.cameraTargetX;
        app.cameraY = app.cameraTargetY;
        app.lastCameraTickMs = performance.now();
        return false;
      }

      return true;
    }

    function isCameraInMotion() {
      return (
        Math.abs(app.cameraTargetX - app.cameraX) > 0.35 ||
        Math.abs(app.cameraTargetY - app.cameraY) > 0.35
      );
    }

    function advanceCamera(now = performance.now()) {
      if (!usesScrollingViewport()) {
        return false;
      }

      if (app.lastCameraTickMs === 0) {
        app.lastCameraTickMs = now;
      }

      const elapsed = Math.max(0, now - app.lastCameraTickMs);
      app.lastCameraTickMs = now;
      const smoothing = 1 - Math.exp(-elapsed / app.CAMERA_FOLLOW_SMOOTHING_MS);

      app.cameraX += (app.cameraTargetX - app.cameraX) * smoothing;
      app.cameraY += (app.cameraTargetY - app.cameraY) * smoothing;

      if (!isCameraInMotion()) {
        app.cameraX = app.cameraTargetX;
        app.cameraY = app.cameraTargetY;
        return false;
      }

      return true;
    }

    function startCameraFollowLoop() {
      if (!usesScrollingViewport() || app.isAnimating || app.cameraFrameId !== null) {
        return;
      }

      function step() {
        app.cameraFrameId = null;
        app.render();
      }

      app.cameraFrameId = window.requestAnimationFrame(step);
    }

    function createShader(glContext, type, source) {
      const shader = glContext.createShader(type);

      if (!shader) {
        return null;
      }

      glContext.shaderSource(shader, source);
      glContext.compileShader(shader);

      if (!glContext.getShaderParameter(shader, glContext.COMPILE_STATUS)) {
        console.error(glContext.getShaderInfoLog(shader));
        glContext.deleteShader(shader);
        return null;
      }

      return shader;
    }

    function createProgram(glContext, vertexSource, fragmentSource) {
      const vertexShader = createShader(glContext, glContext.VERTEX_SHADER, vertexSource);
      const fragmentShader = createShader(glContext, glContext.FRAGMENT_SHADER, fragmentSource);

      if (!vertexShader || !fragmentShader) {
        return null;
      }

      const program = glContext.createProgram();

      if (!program) {
        glContext.deleteShader(vertexShader);
        glContext.deleteShader(fragmentShader);
        return null;
      }

      glContext.attachShader(program, vertexShader);
      glContext.attachShader(program, fragmentShader);
      glContext.linkProgram(program);
      glContext.deleteShader(vertexShader);
      glContext.deleteShader(fragmentShader);

      if (!glContext.getProgramParameter(program, glContext.LINK_STATUS)) {
        console.error(glContext.getProgramInfoLog(program));
        glContext.deleteProgram(program);
        return null;
      }

      return program;
    }

    function initializeRenderer(glContext) {
      const program = createProgram(glContext, app.VERTEX_SHADER_SOURCE, app.FRAGMENT_SHADER_SOURCE);

      if (!program) {
        return null;
      }

      const positionBuffer = glContext.createBuffer();
      const texture = glContext.createTexture();

      if (!positionBuffer || !texture) {
        return null;
      }

      glContext.bindBuffer(glContext.ARRAY_BUFFER, positionBuffer);
      glContext.bufferData(
        glContext.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        glContext.STATIC_DRAW
      );

      glContext.bindTexture(glContext.TEXTURE_2D, texture);
      glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_S, glContext.CLAMP_TO_EDGE);
      glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_T, glContext.CLAMP_TO_EDGE);

      return {
        program,
        positionBuffer,
        texture,
        attribs: {
          position: glContext.getAttribLocation(program, "a_position")
        },
        uniforms: {
          texture: glContext.getUniformLocation(program, "u_texture"),
          logicalResolution: glContext.getUniformLocation(program, "u_logicalResolution"),
          bleed: glContext.getUniformLocation(program, "u_bleed"),
          bloom: glContext.getUniformLocation(program, "u_bloom"),
          softness: glContext.getUniformLocation(program, "u_softness"),
          scanlines: glContext.getUniformLocation(program, "u_scanlines"),
          mask: glContext.getUniformLocation(program, "u_mask"),
          ghosting: glContext.getUniformLocation(program, "u_ghosting"),
          noise: glContext.getUniformLocation(program, "u_noise"),
          vignetteStrength: glContext.getUniformLocation(program, "u_vignetteStrength"),
          noisePhase: glContext.getUniformLocation(program, "u_noisePhase")
        }
      };
    }

    function posKey(x, y) {
      return `${x},${y}`;
    }

    function cloneActorPositions() {
      return app.state.actors.map((actor) => ({
        x: actor.x,
        y: actor.y,
        removed: actor.removed,
        elevation: actor.elevation ?? 0
      }));
    }

    function cloneActorState(actor) {
      return {
        type: actor.type,
        groupId: actor.groupId ?? null,
        label: actor.label,
        imageUrl: actor.imageUrl || null,
        x: actor.x,
        y: actor.y,
        removed: Boolean(actor.removed),
        elevation: actor.elevation ?? 0
      };
    }

    function cloneActorStateList(actors = app.state.actors) {
      return actors.map((actor) => cloneActorState(actor));
    }

    function cloneTerrainCell(cell) {
      return {
        ...cell,
        underlay: cell?.underlay ? cloneTerrainCell(cell.underlay) : null
      };
    }

    function cloneTerrainState(terrain) {
      return terrain.map((row) => row.map((cell) => cloneTerrainCell(cell)));
    }

    function preloadImageUrl(url) {
      if (typeof url !== "string" || url.length === 0) {
        return Promise.resolve();
      }

      registerImageUrl(url);

      if (app.imageCache.has(url)) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        const image = new Image();
        image.onload = function () {
          app.imageCache.set(url, image);
          resolve();
        };
        image.onerror = function () {
          app.imageCache.set(url, null);
          resolve();
        };
        image.src = url;
      });
    }

    function preloadImagesForLevelState(levelState) {
      const urls = new Set([app.PLAYER_LIFT_ARROW_URL]);
      registerImageUrl(app.PLAYER_LIFT_ARROW_URL);

      (levelState?.terrain || []).forEach((row) => {
        row.forEach((cell) => {
          if (cell?.imageUrl) {
            urls.add(cell.imageUrl);
          }
          if (cell?.underlay?.imageUrl) {
            urls.add(cell.underlay.imageUrl);
          }
        });
      });

      (levelState?.actors || []).forEach((actor) => {
        if (actor?.imageUrl) {
          urls.add(actor.imageUrl);
        }
      });

      return Promise.all(Array.from(urls).map((url) => preloadImageUrl(url)));
    }

    function restoreTerrainState(terrain) {
      app.state.terrain = cloneTerrainState(terrain);
    }

    function syncDocumentLevelState() {
      const levelMeta = app.playHeader?.querySelector(".play-header-meta p");

      if (levelMeta && app.currentLevelLabel) {
        levelMeta.textContent = app.currentLevelLabel;
      }

      const gameTitle = app.playHeader?.querySelector("h1")?.textContent?.trim();

      if (gameTitle && app.currentLevelLabel) {
        document.title = `${gameTitle} ${app.currentLevelLabel}`;
      }
    }

    function cloneLevelSnapshot() {
      return {
        gameId: app.currentGameId,
        levelId: app.currentLevelId,
        levelLabel: app.currentLevelLabel,
        width: app.state.width,
        height: app.state.height,
        terrain: cloneTerrainState(app.state.terrain),
        actors: cloneActorStateList()
      };
    }

    function applyLevelState(levelState, options = {}) {
      if (!levelState) {
        return;
      }

      const {
        updateUrl = false,
        resetHistory = false,
        resetLevelEntry = false,
        immediateCamera = true,
        deferRender = false
      } = options;

      if (app.animationFrameId !== null) {
        window.cancelAnimationFrame(app.animationFrameId);
        app.animationFrameId = null;
      }

      if (app.gateAnimationFrameId !== null) {
        window.cancelAnimationFrame(app.gateAnimationFrameId);
        app.gateAnimationFrameId = null;
      }

      if (app.playerLiftAnimationFrameId !== null) {
        window.cancelAnimationFrame(app.playerLiftAnimationFrameId);
        app.playerLiftAnimationFrameId = null;
      }

      if (app.levelTransitionFrameId !== null) {
        window.cancelAnimationFrame(app.levelTransitionFrameId);
        app.levelTransitionFrameId = null;
      }

      app.isAnimating = false;
      app.isTransitioningLevel = false;
      app.levelTransition = null;
      app.gateRenderOverride = null;
      app.currentLevelId = levelState.levelId || app.currentLevelId;
      app.currentLevelLabel = levelState.levelLabel || app.currentLevelLabel || app.currentLevelId;
      app.worldColumns = normalizeAxisValues(levelState.worldColumns, app.worldColumns);
      app.worldRows = normalizeAxisValues(levelState.worldRows, app.worldRows);
      const viewportTiles = normalizeViewportTiles(
        levelState.cameraView,
        app.VIEWPORT_TILE_WIDTH,
        app.VIEWPORT_TILE_HEIGHT
      );
      app.VIEWPORT_TILE_WIDTH = viewportTiles.width;
      app.VIEWPORT_TILE_HEIGHT = viewportTiles.height;
      app.state.width = levelState.width;
      app.state.height = levelState.height;
      app.state.terrain = cloneTerrainState(levelState.terrain || []);
      app.state.actors = (levelState.actors || []).map((actor) => createRuntimeActor(actor));
      registerTerrainImageUrls(app.state.terrain);
      registerActorImageUrls(app.state.actors);
      updateBoardMetrics(app.state.width, app.state.height);
      app.gateAnimations.clear();
      app.gateAnimationsInitialized = false;
      app.playerLiftAnimations.clear();
      app.playerLiftAnimationsInitialized = false;
      initializeActorElevations();
      setupCanvas();
      syncDocumentLevelState();
      rememberHorizontalNeighborLevelState(levelState);
      syncHorizontalNeighborLevelStates();
      syncCameraTarget(immediateCamera);
      syncFloatingFloorTicker();

      if (resetHistory) {
        app.moveHistory.length = 0;
      }

      if (resetLevelEntry) {
        app.initialPositions = cloneActorPositions();
        app.initialTerrain = cloneTerrainState(app.state.terrain);
        app.levelEntrySnapshot = cloneLevelSnapshot();
      }

      if (updateUrl && app.currentLevelId) {
        const nextUrl = `/play/${encodeURIComponent(app.currentGameId)}/${encodeURIComponent(app.currentLevelId)}`;
        window.history.replaceState({ levelId: app.currentLevelId }, "", nextUrl);
      }

      if (!deferRender) {
        app.render();
      }
    }

    async function loadLevelState(levelId) {
      const response = await window.fetch(
        `/api/play/${encodeURIComponent(app.currentGameId)}/${encodeURIComponent(levelId)}`,
        {
          headers: {
            Accept: "application/json"
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Unable to load ${levelId}`);
      }

      const levelState = await response.json();
      rememberHorizontalNeighborLevelState(levelState);
      await preloadImagesForLevelState(levelState);
      return levelState;
    }

    function restoreActorPositions(positions) {
      app.state.actors.forEach((actor, index) => {
        const target = positions[index];

        if (!target) {
          return;
        }

        actor.x = target.x;
        actor.y = target.y;
        actor.removed = Boolean(target.removed);
        actor.elevation = target.elevation ?? 0;
        actor.renderX = target.x;
        actor.renderY = target.y;
        actor.renderElevation = actor.elevation;
        actor.renderScale = actor.removed ? 0 : 1;
        actor.renderAlpha = actor.removed ? 0 : 1;
        actor.renderSink = actor.removed ? app.HOLE_SINK_DISTANCE : 0;
        actor.renderInHole = false;
      });
    }

    function buildOccupiedSet(excludedActor = null) {
      const occupied = new Set(
        app.state.actors
          .filter((actor) => !actor.removed && !isCollectibleActor(actor))
          .map((actor) => posKey(actor.x, actor.y))
      );

      if (excludedActor && !excludedActor.removed) {
        occupied.delete(posKey(excludedActor.x, excludedActor.y));
      }

      return occupied;
    }

    function actorsAt(x, y, predicate = null) {
      return app.state.actors.filter((actor) => {
        if (actor.removed) {
          return false;
        }

        if (actor.x !== x || actor.y !== y) {
          return false;
        }

        return typeof predicate === "function" ? predicate(actor) : true;
      });
    }

    function actorAt(x, y, predicate = null) {
      return actorsAt(x, y, predicate)[0] || null;
    }

    function pushEntityKey(actor) {
      return actor.type === "weightless_box" ? `weightless:${actor.groupId}` : actor;
    }

    function isPlayerActorType(type) {
      return type === "player" || type === "circle_player";
    }

    function isPlayerActor(actor) {
      return isPlayerActorType(actor?.type);
    }

    function actorElevation(actor) {
      if (!isPlayerActor(actor)) {
        return 0;
      }

      return actor?.elevation ?? 0;
    }

    function actorRenderElevation(actor) {
      if (!isPlayerActor(actor)) {
        return 0;
      }

      return actor?.renderElevation ?? actor?.elevation ?? 0;
    }

    function isCollectibleActor(actor) {
      return actor?.type === "gem";
    }

    function pushWeight(actor) {
      return actor.type === "box" || actor.type === "floating_floor" ? 1 : 0;
    }

    function isPushableActor(actor) {
      return actor?.type === "box" || actor?.type === "floating_floor" || actor?.type === "weightless_box";
    }

    function pushActorMembers(actor) {
      return actor.type === "weightless_box" ? weightlessGroupMembers(actor.groupId) : [actor];
    }

    function weightlessGroupMembers(groupId, options = {}) {
      const includeRemoved = options.includeRemoved === true;

      return app.state.actors.filter((actor) => {
        if (actor.type !== "weightless_box" || actor.groupId !== groupId) {
          return false;
        }

        return includeRemoved || !actor.removed;
      });
    }

    function weightlessGroupRenderState(groupId) {
      const members = weightlessGroupMembers(groupId, { includeRemoved: true });
      const anchor = members[0];

      if (!anchor) {
        return {
          offsetX: 0,
          offsetY: 0,
          scale: 1,
          sink: 0,
          centerX: 0,
          centerY: 0
        };
      }

      const visibleMembers = members.filter((member) => !member.removed || member.renderScale > 0.001);
      const boundsSource = visibleMembers.length > 0 ? visibleMembers : members;
      let minX = boundsSource[0].x;
      let maxX = boundsSource[0].x;
      let minY = boundsSource[0].y;
      let maxY = boundsSource[0].y;

      boundsSource.forEach((member) => {
        minX = Math.min(minX, member.x);
        maxX = Math.max(maxX, member.x);
        minY = Math.min(minY, member.y);
        maxY = Math.max(maxY, member.y);
      });

      const offsetX = Math.round(anchor.renderX * app.TILE_SIZE) - anchor.x * app.TILE_SIZE;
      const offsetY = Math.round(anchor.renderY * app.TILE_SIZE) - anchor.y * app.TILE_SIZE;

      return {
        offsetX,
        offsetY,
        scale: anchor.renderScale ?? 1,
        sink: anchor.renderSink ?? 0,
        centerX: ((minX + maxX + 1) * app.TILE_SIZE) / 2 + offsetX,
        centerY: ((minY + maxY + 1) * app.TILE_SIZE) / 2 + offsetY
      };
    }

    function isWeightlessBoxAt(groupId, x, y) {
      return app.state.actors.some(
        (actor) =>
          !actor.removed &&
          actor.type === "weightless_box" &&
          actor.groupId === groupId &&
          actor.x === x &&
          actor.y === y
      );
    }

    function isInsideBoard(x, y) {
      return x >= 0 && x < app.state.width && y >= 0 && y < app.state.height;
    }

    function terrainAt(x, y) {
      return (
        app.state.terrain[y]?.[x] || {
          type: "empty",
          label: "Empty",
          imageUrl: null,
          underlay: null,
          raised: false
        }
      );
    }

    function groundSurfaceCell(cell) {
      if (cell?.type === "wall" && cell.underlay) {
        return cell.underlay;
      }

      return cell;
    }

    function isPlayerGate(x, y) {
      return terrainAt(x, y).type === "player_gate";
    }

    function isPlayerLift(x, y) {
      return terrainAt(x, y).type === "player_lift";
    }

    function eachPlayerLift(callback) {
      for (let y = 0; y < app.state.height; y += 1) {
        for (let x = 0; x < app.state.width; x += 1) {
          if (!isPlayerLift(x, y)) {
            continue;
          }

          callback(x, y, posKey(x, y));
        }
      }
    }

    function isRaisedPlayerLift(x, y) {
      return isPlayerLift(x, y) && terrainAt(x, y).raised === true;
    }

    function setPlayerLiftRaised(x, y, raised) {
      if (!isPlayerLift(x, y)) {
        return false;
      }

      terrainAt(x, y).raised = Boolean(raised);
      return terrainAt(x, y).raised;
    }

    function togglePlayerLiftAt(x, y) {
      return setPlayerLiftRaised(x, y, !isRaisedPlayerLift(x, y));
    }

    function terrainSurfaceHeightAt(x, y, gateState = app.liveRaisedPlayerGates) {
      if (!isInsideBoard(x, y)) {
        return null;
      }

      if (isTerrainWall(x, y) || isRaisedPlayerGate(x, y, gateState) || isRaisedPlayerLift(x, y)) {
        return 1;
      }

      const cell = terrainAt(x, y);

      if (cell.type === "hole" || cell.type === "empty") {
        return null;
      }

      return 0;
    }

    function hasElevatedActorSurfaceAt(x, y) {
      return (
        actorsAt(
          x,
          y,
          (actor) => actor.type === "floating_floor" || actor.type === "weightless_box"
        ).length > 0
      );
    }

    function playerSurfaceHeightAt(x, y, gateState = app.liveRaisedPlayerGates) {
      const terrainHeight = terrainSurfaceHeightAt(x, y, gateState);

      if (terrainHeight === 1 || hasElevatedActorSurfaceAt(x, y)) {
        return 1;
      }

      return terrainHeight;
    }

    function computeRaisedPlayerGateSet(actors = app.state.actors) {
      const activeActors = actors.filter((actor) => !actor.removed);
      const occupiedGround = new Set(
        activeActors
          .filter((actor) => !isCollectibleActor(actor) && actorElevation(actor) === 0)
          .map((actor) => posKey(actor.x, actor.y))
      );
      const players = activeActors.filter((actor) => isPlayerActor(actor));
      const raised = new Set();

      for (let y = 0; y < app.state.height; y += 1) {
        for (let x = 0; x < app.state.width; x += 1) {
          if (!isPlayerGate(x, y)) {
            continue;
          }

          if (
            players.some(
              (actor) => actorElevation(actor) === 1 && actor.x === x && actor.y === y
            )
          ) {
            raised.add(posKey(x, y));
            continue;
          }

          if (occupiedGround.has(posKey(x, y))) {
            continue;
          }

          if (players.some((actor) => Math.abs(actor.x - x) + Math.abs(actor.y - y) === 1)) {
            raised.add(posKey(x, y));
          }
        }
      }

      return raised;
    }

    function eachPlayerGate(callback) {
      for (let y = 0; y < app.state.height; y += 1) {
        for (let x = 0; x < app.state.width; x += 1) {
          if (!isPlayerGate(x, y)) {
            continue;
          }

          callback(x, y, posKey(x, y));
        }
      }
    }

    function isRaisedPlayerGate(x, y, gateState = app.liveRaisedPlayerGates) {
      return isPlayerGate(x, y) && gateState.has(posKey(x, y));
    }

    function isTerrainWall(x, y) {
      return terrainAt(x, y).type === "wall";
    }

    function terrainCellAcrossHorizontalWorldEdge(x, y) {
      if (y < 0 || y >= app.state.height) {
        return null;
      }

      if (x >= 0 && x < app.state.width) {
        return terrainAt(x, y);
      }

      if (x !== -1 && x !== app.state.width) {
        return null;
      }

      const neighborLevelId = adjacentWorldLevelId(app.currentLevelId, x < 0 ? -1 : 1, 0);
      const neighborLevelState = cachedHorizontalNeighborLevelState(neighborLevelId);

      if (!neighborLevelState) {
        queueHorizontalNeighborLevelState(neighborLevelId);
        return null;
      }

      const neighborX = x < 0 ? neighborLevelState.width - 1 : 0;

      if (neighborX < 0 || y >= neighborLevelState.height) {
        return null;
      }

      return neighborLevelState.terrain?.[y]?.[neighborX] || null;
    }

    function isTerrainWallAcrossHorizontalWorldEdge(x, y) {
      return terrainCellAcrossHorizontalWorldEdge(x, y)?.type === "wall";
    }

    function isWall(x, y, gateState = app.liveRaisedPlayerGates) {
      return isTerrainWall(x, y) || isRaisedPlayerGate(x, y, gateState) || isRaisedPlayerLift(x, y);
    }

    function elevatedBlockFamiliesAt(x, y, gateState = app.liveRaisedPlayerGates) {
      const families = new Set();

      if ((x === -1 || x === app.state.width) && isTerrainWallAcrossHorizontalWorldEdge(x, y)) {
        families.add("terrain:wall");
        return families;
      }

      if (!isInsideBoard(x, y)) {
        return families;
      }

      if (isTerrainWall(x, y)) {
        families.add("terrain:wall");
      }

      if (isRaisedPlayerGate(x, y, gateState)) {
        families.add("terrain:player_gate");
      }

      if (isRaisedPlayerLift(x, y)) {
        families.add("terrain:player_lift");
      }

      app.state.actors.forEach((actor) => {
        if (actor.removed || actor.x !== x || actor.y !== y) {
          return;
        }

        if (actor.type === "weightless_box") {
          families.add(`actor:weightless_box:${actor.groupId ?? "__ungrouped__"}`);
          return;
        }

        if (actor.type === "player" || actor.type === "floating_floor") {
          families.add(`actor:${actor.type}`);
        }
      });

      return families;
    }

    function sharedElevatedBlockFamilies(positions, gateState = app.liveRaisedPlayerGates) {
      let sharedFamilies = null;

      for (const position of positions) {
        const families = elevatedBlockFamiliesAt(position.x, position.y, gateState);

        if (families.size === 0) {
          return new Set();
        }

        if (sharedFamilies === null) {
          sharedFamilies = new Set(families);
          continue;
        }

        sharedFamilies = new Set(
          Array.from(sharedFamilies).filter((family) => families.has(family))
        );

        if (sharedFamilies.size === 0) {
          return new Set();
        }
      }

      return sharedFamilies || new Set();
    }

    function sharedElevatedBlockFamily(positions, gateState = app.liveRaisedPlayerGates) {
      return sharedElevatedBlockFamilies(positions, gateState).size > 0;
    }

    function elevatedSideBleedCoverFamily(x, y, dx, gateState = app.liveRaisedPlayerGates) {
      if (dx !== -1 && dx !== 1) {
        return null;
      }

      if (y >= app.state.height - 1) {
        return null;
      }

      const families = sharedElevatedBlockFamilies(
        [
          { x: x + dx, y },
          { x, y: y + 1 },
          { x: x + dx, y: y + 1 }
        ],
        gateState
      );

      return families.values().next().value || null;
    }

    function isIce(x, y) {
      return terrainAt(x, y).type === "ice";
    }

    function isHole(x, y) {
      return terrainAt(x, y).type === "hole";
    }

    function isIceOrHole(x, y) {
      return isIce(x, y) || isHole(x, y);
    }

    function isGroundCell(cell) {
      const groundCell = groundSurfaceCell(cell);
      return groundCell.type !== "wall" && groundCell.type !== "hole" && groundCell.type !== "empty";
    }

    function hasVisibleFloatingFloorActors() {
      return app.state.actors.some(
        (actor) =>
          (actor.type === "floating_floor" || actor.type === "gem") &&
          (!actor.removed || (actor.renderScale ?? 0) > 0.001)
      );
    }

    function floatingFloorHoverOffset(actor, now = performance.now()) {
      const hoverBase = actor?.type === "gem" ? app.GEM_HOVER_BASE : app.FLOATING_FLOOR_HOVER_BASE;
      const hoverBob = actor?.type === "gem" ? app.GEM_HOVER_BOB : app.FLOATING_FLOOR_HOVER_BOB;
      const hoverPeriod =
        actor?.type === "gem" ? app.GEM_HOVER_PERIOD_MS : app.FLOATING_FLOOR_HOVER_PERIOD_MS;
      const oscillation =
        Math.sin((now / hoverPeriod) * Math.PI * 2 + (actor.hoverSeed || 0)) * hoverBob;
      return hoverBase + oscillation;
    }

    function easeOutBack(progress) {
      const overshoot = 1.45;
      const shifted = progress - 1;
      return 1 + (overshoot + 1) * shifted * shifted * shifted + overshoot * shifted * shifted;
    }

    function easeInOutQuad(progress) {
      if (progress < 0.5) {
        return 2 * progress * progress;
      }

      return 1 - Math.pow(-2 * progress + 2, 2) / 2;
    }

    function gateAnimationValue(animation, now) {
      if (!animation) {
        return 0;
      }

      if (animation.startMs === null || animation.from === animation.to) {
        return animation.to;
      }

      const progress = clamp((now - animation.startMs) / animation.durationMs, 0, 1);
      const eased =
        animation.to > animation.from ? easeOutBack(progress) : easeInOutQuad(progress);
      return animation.from + (animation.to - animation.from) * eased;
    }

    function gateLiftAt(x, y, now = performance.now()) {
      const animation = app.gateAnimations.get(posKey(x, y));
      const target = app.liveRaisedPlayerGates.has(posKey(x, y)) ? 1 : 0;
      const value = animation ? gateAnimationValue(animation, now) : target;
      return clamp(value, 0, 1.08);
    }

    function startGateAnimationLoop() {
      if (app.gateAnimationFrameId !== null) {
        return;
      }

      function step(now) {
        let hasActiveAnimation = false;

        app.gateAnimations.forEach((animation) => {
          if (animation.startMs === null) {
            return;
          }

          if (now - animation.startMs >= animation.durationMs) {
            animation.from = animation.to;
            animation.startMs = null;
            return;
          }

          hasActiveAnimation = true;
        });

        app.render();

        if (hasActiveAnimation) {
          app.gateAnimationFrameId = window.requestAnimationFrame(step);
          return;
        }

        app.gateAnimationFrameId = null;
      }

      app.gateAnimationFrameId = window.requestAnimationFrame(step);
    }

    function syncGateAnimationTargets(now = performance.now()) {
      if (!app.gateAnimationsInitialized) {
        eachPlayerGate((x, y, key) => {
          const target = app.liveRaisedPlayerGates.has(key) ? 1 : 0;
          app.gateAnimations.set(key, {
            from: target,
            to: target,
            startMs: null,
            durationMs: app.GATE_RISE_DURATION_MS
          });
        });
        app.gateAnimationsInitialized = true;
        return;
      }

      let hasActiveAnimation = false;

      eachPlayerGate((x, y, key) => {
        const target = app.liveRaisedPlayerGates.has(key) ? 1 : 0;
        const animation = app.gateAnimations.get(key);

        if (!animation) {
          app.gateAnimations.set(key, {
            from: target,
            to: target,
            startMs: null,
            durationMs: app.GATE_RISE_DURATION_MS
          });
          return;
        }

        if (animation.startMs !== null && now - animation.startMs >= animation.durationMs) {
          animation.from = animation.to;
          animation.startMs = null;
        }

        const current = gateAnimationValue(animation, now);

        if (animation.to !== target) {
          animation.from = current;
          animation.to = target;
          animation.startMs = now;
          animation.durationMs =
            target > current ? app.GATE_RISE_DURATION_MS : app.GATE_FALL_DURATION_MS;
        }

        if (animation.startMs !== null) {
          hasActiveAnimation = true;
        }
      });

      if (hasActiveAnimation) {
        startGateAnimationLoop();
      }
    }

    function playerLiftAt(x, y, now = performance.now()) {
      const animation = app.playerLiftAnimations.get(posKey(x, y));
      const target = isRaisedPlayerLift(x, y) ? 1 : 0;
      const value = animation ? gateAnimationValue(animation, now) : target;
      return clamp(value, 0, 1.08);
    }

    function startPlayerLiftAnimationLoop() {
      if (app.playerLiftAnimationFrameId !== null) {
        return;
      }

      function step(now) {
        let hasActiveAnimation = false;

        app.playerLiftAnimations.forEach((animation) => {
          if (animation.startMs === null) {
            return;
          }

          if (now - animation.startMs >= animation.durationMs) {
            animation.from = animation.to;
            animation.startMs = null;
            return;
          }

          hasActiveAnimation = true;
        });

        app.render();

        if (hasActiveAnimation) {
          app.playerLiftAnimationFrameId = window.requestAnimationFrame(step);
          return;
        }

        app.playerLiftAnimationFrameId = null;
      }

      app.playerLiftAnimationFrameId = window.requestAnimationFrame(step);
    }

    function syncPlayerLiftAnimationTargets(now = performance.now()) {
      if (!app.playerLiftAnimationsInitialized) {
        eachPlayerLift((x, y, key) => {
          const target = isRaisedPlayerLift(x, y) ? 1 : 0;
          app.playerLiftAnimations.set(key, {
            from: target,
            to: target,
            startMs: null,
            durationMs: app.PLAYER_LIFT_RISE_DURATION_MS
          });
        });
        app.playerLiftAnimationsInitialized = true;
        return;
      }

      let hasActiveAnimation = false;

      eachPlayerLift((x, y, key) => {
        const target = isRaisedPlayerLift(x, y) ? 1 : 0;
        const animation = app.playerLiftAnimations.get(key);

        if (!animation) {
          app.playerLiftAnimations.set(key, {
            from: target,
            to: target,
            startMs: null,
            durationMs: app.PLAYER_LIFT_RISE_DURATION_MS
          });
          return;
        }

        if (animation.startMs !== null && now - animation.startMs >= animation.durationMs) {
          animation.from = animation.to;
          animation.startMs = null;
        }

        const current = gateAnimationValue(animation, now);

        if (animation.to !== target) {
          animation.from = current;
          animation.to = target;
          animation.startMs = now;
          animation.durationMs =
            target > current ? app.PLAYER_LIFT_RISE_DURATION_MS : app.PLAYER_LIFT_FALL_DURATION_MS;
        }

        if (animation.startMs !== null) {
          hasActiveAnimation = true;
        }
      });

      if (hasActiveAnimation) {
        startPlayerLiftAnimationLoop();
      }
    }

    function initializeActorElevations() {
      const gateState = computeRaisedPlayerGateSet(app.state.actors);

      app.state.actors.forEach((actor) => {
        if (!isPlayerActor(actor)) {
          actor.elevation = 0;
          actor.renderElevation = 0;
          return;
        }

        const elevation = playerSurfaceHeightAt(actor.x, actor.y, gateState) === 1 ? 1 : 0;
        actor.elevation = elevation;
        actor.renderElevation = elevation;
      });
    }

    function syncFuzzyToggle() {
      if (!app.fuzzyToggle) {
        return;
      }

      app.fuzzyToggle.classList.toggle("is-active", app.state.effects.fuzzyEnabled);
      app.fuzzyToggle.setAttribute("aria-pressed", app.state.effects.fuzzyEnabled ? "true" : "false");
    }

    function syncNoiseTicker() {
      if (app.noiseFrameId !== null) {
        window.cancelAnimationFrame(app.noiseFrameId);
        app.noiseFrameId = null;
      }

      if (!app.state.effects.fuzzyEnabled) {
        app.lastNoiseTickMs = 0;
        return;
      }

      app.lastNoiseTickMs = performance.now();

      function step(now) {
        const elapsed = now - app.lastNoiseTickMs;
        const phaseStep = Math.floor(elapsed / app.NOISE_FRAME_MS);

        if (phaseStep > 0) {
          app.state.effects.noisePhase = (app.state.effects.noisePhase + phaseStep) % app.NOISE_PHASE_CYCLE;
          app.lastNoiseTickMs += phaseStep * app.NOISE_FRAME_MS;

          if (!app.isAnimating) {
            app.render();
          }
        }

        if (app.state.effects.fuzzyEnabled) {
          app.noiseFrameId = window.requestAnimationFrame(step);
        } else {
          app.noiseFrameId = null;
        }
      }

      app.noiseFrameId = window.requestAnimationFrame(step);
    }

    function syncFloatingFloorTicker() {
      if (app.floatingFloorFrameId !== null) {
        window.cancelAnimationFrame(app.floatingFloorFrameId);
        app.floatingFloorFrameId = null;
      }

      if (!hasVisibleFloatingFloorActors()) {
        app.lastFloatingFloorTickMs = 0;
        return;
      }

      app.lastFloatingFloorTickMs = 0;

      function step(now) {
        if (!hasVisibleFloatingFloorActors()) {
          app.floatingFloorFrameId = null;
          app.lastFloatingFloorTickMs = 0;
          return;
        }

        if (
          app.lastFloatingFloorTickMs === 0 ||
          now - app.lastFloatingFloorTickMs >= app.FLOATING_FLOOR_HOVER_FRAME_MS
        ) {
          app.lastFloatingFloorTickMs = now;

          if (!app.isAnimating) {
            app.render();
          }
        }

        app.floatingFloorFrameId = window.requestAnimationFrame(step);
      }

      app.floatingFloorFrameId = window.requestAnimationFrame(step);
    }

    function setupCanvas() {
      const dpr = window.devicePixelRatio || 1;
      app.canvas.width = Math.round(app.viewportRect.width * dpr);
      app.canvas.height = Math.round(app.viewportRect.height * dpr);
      app.canvas.style.aspectRatio = `${app.viewportRect.width} / ${app.viewportRect.height}`;
      app.sceneCanvas.width = app.boardRect.width;
      app.sceneCanvas.height = app.boardRect.height;
      app.sceneCtx.setTransform(1, 0, 0, 1, 0, 0);
      app.sceneCtx.imageSmoothingEnabled = false;
      app.viewCanvas.width = app.viewportRect.width;
      app.viewCanvas.height = app.viewportRect.height;
      app.viewCtx.setTransform(1, 0, 0, 1, 0, 0);
      app.viewCtx.imageSmoothingEnabled = false;

      if (app.renderer && app.gl) {
        app.gl.viewport(0, 0, app.canvas.width, app.canvas.height);
      } else if (app.fallbackCtx) {
        app.fallbackCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        app.fallbackCtx.imageSmoothingEnabled = false;
      }
    }

    function syncPlayLayout() {
      if (!app.playShell || !app.playHeader || !app.playStage || !app.mazeFrame) {
        return;
      }

      const frameStyles = window.getComputedStyle(app.mazeFrame);
      const marginRight = parseFloat(frameStyles.marginRight) || 0;
      const marginBottom = parseFloat(frameStyles.marginBottom) || 0;
      const availableWidth = Math.max(0, app.playStage.clientWidth - marginRight);
      const availableHeight = Math.max(0, app.playStage.clientHeight - marginBottom);
      const boardSize = Math.floor(Math.min(availableWidth, availableHeight));

      if (!Number.isFinite(boardSize) || boardSize <= 0) {
        return;
      }

      app.mazeFrame.style.width = `${boardSize}px`;
      app.mazeFrame.style.height = `${boardSize}px`;
      const controlWidth = Math.min(app.playStage.clientWidth, boardSize + marginRight);
      app.playHeader.style.width = `${controlWidth}px`;
    }

    function preloadImages() {
      return Promise.all(Array.from(app.imageUrls).map((url) => preloadImageUrl(url)));
    }

    Object.assign(app, {
      clamp,
      usesScrollingViewport,
      cameraFocusPoint,
      syncCameraTarget,
      advanceCamera,
      startCameraFollowLoop,
      parseWorldLevelId,
      worldLevelId,
      adjacentWorldLevelId,
      rememberHorizontalNeighborLevelState,
      cachedHorizontalNeighborLevelState,
      loadHorizontalNeighborLevelState,
      queueHorizontalNeighborLevelState,
      syncHorizontalNeighborLevelStates,
      createRuntimeActor,
      registerImageUrl,
      registerTerrainImageUrls,
      registerActorImageUrls,
      updateBoardMetrics,
      createShader,
      createProgram,
      initializeRenderer,
      posKey,
      cloneActorPositions,
      cloneActorState,
      cloneActorStateList,
      cloneTerrainCell,
      cloneTerrainState,
      preloadImageUrl,
      preloadImagesForLevelState,
      restoreTerrainState,
      syncDocumentLevelState,
      cloneLevelSnapshot,
      applyLevelState,
      loadLevelState,
      restoreActorPositions,
      buildOccupiedSet,
      actorsAt,
      actorAt,
      pushEntityKey,
      isPlayerActorType,
      isPlayerActor,
      actorElevation,
      actorRenderElevation,
      isCollectibleActor,
      pushWeight,
      isPushableActor,
      pushActorMembers,
      weightlessGroupMembers,
      weightlessGroupRenderState,
      isWeightlessBoxAt,
      isInsideBoard,
      terrainAt,
      groundSurfaceCell,
      isPlayerGate,
      isPlayerLift,
      eachPlayerLift,
      isRaisedPlayerLift,
      setPlayerLiftRaised,
      togglePlayerLiftAt,
      terrainSurfaceHeightAt,
      hasElevatedActorSurfaceAt,
      playerSurfaceHeightAt,
      computeRaisedPlayerGateSet,
      eachPlayerGate,
      isRaisedPlayerGate,
      isTerrainWall,
      terrainCellAcrossHorizontalWorldEdge,
      isTerrainWallAcrossHorizontalWorldEdge,
      isWall,
      elevatedBlockFamiliesAt,
      sharedElevatedBlockFamilies,
      sharedElevatedBlockFamily,
      elevatedSideBleedCoverFamily,
      isIce,
      isHole,
      isIceOrHole,
      isGroundCell,
      hasVisibleFloatingFloorActors,
      floatingFloorHoverOffset,
      easeOutBack,
      easeInOutQuad,
      gateAnimationValue,
      gateLiftAt,
      playerLiftAt,
      startGateAnimationLoop,
      syncGateAnimationTargets,
      startPlayerLiftAnimationLoop,
      syncPlayerLiftAnimationTargets,
      initializeActorElevations,
      syncFuzzyToggle,
      syncNoiseTicker,
      syncFloatingFloorTicker,
      setupCanvas,
      syncPlayLayout,
      preloadImages
    });

    initializeActorElevations();
    syncDocumentLevelState();
    rememberHorizontalNeighborLevelState(playData);
    syncHorizontalNeighborLevelStates();
    syncCameraTarget(true);
    app.initialPositions = cloneActorPositions();
    app.initialTerrain = cloneTerrainState(app.state.terrain);
    app.levelEntrySnapshot = cloneLevelSnapshot();
    app.renderer = app.gl ? initializeRenderer(app.gl) : null;

    return app;
  };
})();
