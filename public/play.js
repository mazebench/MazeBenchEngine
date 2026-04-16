(function () {
  const playData = window.__PLAY_DATA__;
  const canvas = document.getElementById("maze-canvas");

  if (!playData || !canvas) {
    return;
  }

  const TILE_SIZE = 64;
  const FUZZY_AMOUNT = 0.1;
  const NOISE_FPS = 8;
  const NOISE_FRAME_MS = 1000 / NOISE_FPS;
  const MOVE_DURATION_MS = 98;
  const ICE_SLIDE_DURATION_MULTIPLIER = 0.82;
  const GATE_RISE_DURATION_MS = 220;
  const GATE_FALL_DURATION_MS = 180;
  const HOLE_FALL_DURATION_MS = 300;
  const HOLE_SINK_DISTANCE = TILE_SIZE * 0.42;
  const GEM_HOVER_BASE = TILE_SIZE * 0.035;
  const GEM_HOVER_BOB = TILE_SIZE * 0.028;
  const GEM_HOVER_PERIOD_MS = 1800;
  const GEM_DRAW_WIDTH = TILE_SIZE * 0.56;
  const GEM_SHADOW_WIDTH = TILE_SIZE * 0.3;
  const GEM_SHADOW_HEIGHT = TILE_SIZE * 0.1;
  const FLOATING_FLOOR_HOVER_BASE = TILE_SIZE * 0.18;
  const FLOATING_FLOOR_HOVER_BOB = TILE_SIZE * 0.045;
  const FLOATING_FLOOR_SHADOW_INSET = TILE_SIZE * 0.16;
  const FLOATING_FLOOR_SHADOW_HEIGHT = TILE_SIZE * 0.12;
  const FLOATING_FLOOR_HOVER_PERIOD_MS = 2400;
  const FLOATING_FLOOR_HOVER_FPS = 30;
  const FLOATING_FLOOR_HOVER_FRAME_MS = 1000 / FLOATING_FLOOR_HOVER_FPS;
  const playShell = document.querySelector(".play-shell");
  const playHeader = document.querySelector(".play-header");
  const playStage = document.querySelector(".play-stage");
  const mazeFrame = document.querySelector(".maze-frame");
  const fuzzyToggle = document.getElementById("fuzzy-toggle");

  const state = {
    width: playData.width,
    height: playData.height,
    terrain: playData.terrain,
    actors: playData.actors.map((actor) => ({
      ...actor,
      hoverSeed:
        (((actor.x + 1) * 0.61803398875 + (actor.y + 1) * 1.41421356237) % 1) * Math.PI * 2,
      renderX: actor.x,
      renderY: actor.y,
      renderScale: 1,
      renderSink: 0,
      renderInHole: false,
      removed: false
    })),
    effects: {
      fuzzyEnabled: fuzzyToggle ? fuzzyToggle.getAttribute("aria-pressed") === "true" : true,
      noisePhase: 0
    }
  };

  const imageUrls = new Set();
  state.terrain.forEach((row) => {
    row.forEach((cell) => {
      if (cell.imageUrl) {
        imageUrls.add(cell.imageUrl);
      }

      if (cell.underlay?.imageUrl) {
        imageUrls.add(cell.underlay.imageUrl);
      }
    });
  });
  state.actors.forEach((actor) => {
    if (actor.imageUrl) {
      imageUrls.add(actor.imageUrl);
    }
  });

  const boardRect = {
    width: state.width * TILE_SIZE,
    height: state.height * TILE_SIZE
  };
  const sceneCanvas = document.createElement("canvas");
  const sceneCtx = sceneCanvas.getContext("2d");
  const weightlessGroupCanvas = document.createElement("canvas");
  const weightlessGroupCtx = weightlessGroupCanvas.getContext("2d");
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false
  });
  const fallbackCtx = gl ? null : canvas.getContext("2d");
  const imageCache = new Map();
  const initialPositions = state.actors.map((actor) => ({
    x: actor.x,
    y: actor.y,
    removed: actor.removed
  }));
  const initialTerrain = cloneTerrainState(state.terrain);
  const moveHistory = [];
  let animationFrameId = null;
  let isAnimating = false;
  let queuedAction = null;
  let renderer = null;
  let noiseFrameId = null;
  let floatingFloorFrameId = null;
  let lastFloatingFloorTickMs = 0;
  let lastNoiseTickMs = 0;
  let liveRaisedPlayerGates = new Set();
  let gateRenderOverride = null;
  let gateAnimationFrameId = null;
  let gateAnimationsInitialized = false;
  const gateAnimations = new Map();

  if (!sceneCtx || (!gl && !fallbackCtx)) {
    return;
  }

  const FRAGMENT_PRECISION =
    gl &&
    typeof gl.getShaderPrecisionFormat === "function" &&
    gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision > 0
      ? "highp"
      : "mediump";
  const NOISE_PHASE_CYCLE = 10;

  const VERTEX_SHADER_SOURCE = `
    attribute vec2 a_position;
    varying vec2 v_uv;

    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const FRAGMENT_SHADER_SOURCE = `
    precision ${FRAGMENT_PRECISION} float;

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
    const program = createProgram(glContext, VERTEX_SHADER_SOURCE, FRAGMENT_SHADER_SOURCE);

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

  renderer = gl ? initializeRenderer(gl) : null;

  function posKey(x, y) {
    return `${x},${y}`;
  }

  function cloneActorPositions() {
    return state.actors.map((actor) => ({
      x: actor.x,
      y: actor.y,
      removed: actor.removed
    }));
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

  function restoreTerrainState(terrain) {
    state.terrain = cloneTerrainState(terrain);
  }

  function restoreActorPositions(positions) {
    state.actors.forEach((actor, index) => {
      const target = positions[index];

      if (!target) {
        return;
      }

      actor.x = target.x;
      actor.y = target.y;
      actor.removed = Boolean(target.removed);
      actor.renderX = target.x;
      actor.renderY = target.y;
      actor.renderScale = actor.removed ? 0 : 1;
      actor.renderSink = actor.removed ? HOLE_SINK_DISTANCE : 0;
      actor.renderInHole = false;
    });
  }

  function buildOccupiedSet(excludedActor = null) {
    const occupied = new Set(
      state.actors
        .filter((actor) => !actor.removed && !isCollectibleActor(actor))
        .map((actor) => posKey(actor.x, actor.y))
    );

    if (excludedActor && !excludedActor.removed) {
      occupied.delete(posKey(excludedActor.x, excludedActor.y));
    }

    return occupied;
  }

  function actorsAt(x, y, predicate = null) {
    return state.actors.filter((actor) => {
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

    return state.actors.filter((actor) => {
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

    const offsetX = Math.round(anchor.renderX * TILE_SIZE) - anchor.x * TILE_SIZE;
    const offsetY = Math.round(anchor.renderY * TILE_SIZE) - anchor.y * TILE_SIZE;

    return {
      offsetX,
      offsetY,
      scale: anchor.renderScale ?? 1,
      sink: anchor.renderSink ?? 0,
      centerX: ((minX + maxX + 1) * TILE_SIZE) / 2 + offsetX,
      centerY: ((minY + maxY + 1) * TILE_SIZE) / 2 + offsetY
    };
  }

  function isWeightlessBoxAt(groupId, x, y) {
    return state.actors.some(
      (actor) =>
        !actor.removed &&
        actor.type === "weightless_box" &&
        actor.groupId === groupId &&
        actor.x === x &&
        actor.y === y
    );
  }

  function isInsideBoard(x, y) {
    return x >= 0 && x < state.width && y >= 0 && y < state.height;
  }

  function terrainAt(x, y) {
    return (
      state.terrain[y]?.[x] || {
        type: "empty",
        label: "Empty",
        imageUrl: null,
        underlay: null
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

  function computeRaisedPlayerGateSet(actors = state.actors) {
    const activeActors = actors.filter((actor) => !actor.removed);
    const occupied = new Set(
      activeActors.filter((actor) => !isCollectibleActor(actor)).map((actor) => posKey(actor.x, actor.y))
    );
    const players = activeActors.filter((actor) => isPlayerActor(actor));
    const raised = new Set();

    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        if (!isPlayerGate(x, y) || occupied.has(posKey(x, y))) {
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
    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        if (!isPlayerGate(x, y)) {
          continue;
        }

        callback(x, y, posKey(x, y));
      }
    }
  }

  function isRaisedPlayerGate(x, y, gateState = liveRaisedPlayerGates) {
    return isPlayerGate(x, y) && gateState.has(posKey(x, y));
  }

  function isTerrainWall(x, y) {
    return terrainAt(x, y).type === "wall";
  }

  function isWall(x, y, gateState = liveRaisedPlayerGates) {
    return isTerrainWall(x, y) || isRaisedPlayerGate(x, y, gateState);
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
    return state.actors.some(
      (actor) =>
        (actor.type === "floating_floor" || actor.type === "gem") &&
        (!actor.removed || (actor.renderScale ?? 0) > 0.001)
    );
  }

  function floatingFloorHoverOffset(actor, now = performance.now()) {
    const hoverBase = actor?.type === "gem" ? GEM_HOVER_BASE : FLOATING_FLOOR_HOVER_BASE;
    const hoverBob = actor?.type === "gem" ? GEM_HOVER_BOB : FLOATING_FLOOR_HOVER_BOB;
    const hoverPeriod = actor?.type === "gem" ? GEM_HOVER_PERIOD_MS : FLOATING_FLOOR_HOVER_PERIOD_MS;
    const oscillation =
      Math.sin((now / hoverPeriod) * Math.PI * 2 + (actor.hoverSeed || 0)) * hoverBob;
    return hoverBase + oscillation;
  }

  function easeOutBack(progress) {
    const overshoot = 1.45;
    const shifted = progress - 1;
    return 1 + (overshoot + 1) * shifted * shifted * shifted + overshoot * shifted * shifted;
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
    const animation = gateAnimations.get(posKey(x, y));
    const target = liveRaisedPlayerGates.has(posKey(x, y)) ? 1 : 0;
    const value = animation ? gateAnimationValue(animation, now) : target;
    return clamp(value, 0, 1.08);
  }

  function startGateAnimationLoop() {
    if (gateAnimationFrameId !== null) {
      return;
    }

    function step(now) {
      let hasActiveAnimation = false;

      gateAnimations.forEach((animation) => {
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

      render();

      if (hasActiveAnimation) {
        gateAnimationFrameId = window.requestAnimationFrame(step);
        return;
      }

      gateAnimationFrameId = null;
    }

    gateAnimationFrameId = window.requestAnimationFrame(step);
  }

  function syncGateAnimationTargets(now = performance.now()) {
    if (!gateAnimationsInitialized) {
      eachPlayerGate((x, y, key) => {
        const target = liveRaisedPlayerGates.has(key) ? 1 : 0;
        gateAnimations.set(key, {
          from: target,
          to: target,
          startMs: null,
          durationMs: GATE_RISE_DURATION_MS
        });
      });
      gateAnimationsInitialized = true;
      return;
    }

    let hasActiveAnimation = false;

    eachPlayerGate((x, y, key) => {
      const target = liveRaisedPlayerGates.has(key) ? 1 : 0;
      const animation = gateAnimations.get(key);

      if (!animation) {
        gateAnimations.set(key, {
          from: target,
          to: target,
          startMs: null,
          durationMs: GATE_RISE_DURATION_MS
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
          target > current ? GATE_RISE_DURATION_MS : GATE_FALL_DURATION_MS;
      }

      if (animation.startMs !== null) {
        hasActiveAnimation = true;
      }
    });

    if (hasActiveAnimation) {
      startGateAnimationLoop();
    }
  }

  function syncFuzzyToggle() {
    if (!fuzzyToggle) {
      return;
    }

    fuzzyToggle.classList.toggle("is-active", state.effects.fuzzyEnabled);
    fuzzyToggle.setAttribute("aria-pressed", state.effects.fuzzyEnabled ? "true" : "false");
  }

  function syncNoiseTicker() {
    if (noiseFrameId !== null) {
      window.cancelAnimationFrame(noiseFrameId);
      noiseFrameId = null;
    }

    if (!state.effects.fuzzyEnabled) {
      lastNoiseTickMs = 0;
      return;
    }

    lastNoiseTickMs = performance.now();

    function step(now) {
      const elapsed = now - lastNoiseTickMs;
      const phaseStep = Math.floor(elapsed / NOISE_FRAME_MS);

      if (phaseStep > 0) {
        state.effects.noisePhase = (state.effects.noisePhase + phaseStep) % NOISE_PHASE_CYCLE;
        lastNoiseTickMs += phaseStep * NOISE_FRAME_MS;

        if (!isAnimating) {
          render();
        }
      }

      if (state.effects.fuzzyEnabled) {
        noiseFrameId = window.requestAnimationFrame(step);
      } else {
        noiseFrameId = null;
      }
    }

    noiseFrameId = window.requestAnimationFrame(step);
  }

  function syncFloatingFloorTicker() {
    if (floatingFloorFrameId !== null) {
      window.cancelAnimationFrame(floatingFloorFrameId);
      floatingFloorFrameId = null;
    }

    if (!hasVisibleFloatingFloorActors()) {
      lastFloatingFloorTickMs = 0;
      return;
    }

    lastFloatingFloorTickMs = 0;

    function step(now) {
      if (!hasVisibleFloatingFloorActors()) {
        floatingFloorFrameId = null;
        lastFloatingFloorTickMs = 0;
        return;
      }

      if (
        lastFloatingFloorTickMs === 0 ||
        now - lastFloatingFloorTickMs >= FLOATING_FLOOR_HOVER_FRAME_MS
      ) {
        lastFloatingFloorTickMs = now;

        if (!isAnimating) {
          render();
        }
      }

      floatingFloorFrameId = window.requestAnimationFrame(step);
    }

    floatingFloorFrameId = window.requestAnimationFrame(step);
  }

  if (gl) {
    canvas.addEventListener("webglcontextlost", function (event) {
      event.preventDefault();
      renderer = null;

      if (noiseFrameId !== null) {
        window.cancelAnimationFrame(noiseFrameId);
        noiseFrameId = null;
      }

      if (floatingFloorFrameId !== null) {
        window.cancelAnimationFrame(floatingFloorFrameId);
        floatingFloorFrameId = null;
      }
    });

    canvas.addEventListener("webglcontextrestored", function () {
      renderer = initializeRenderer(gl);
      setupCanvas();
      syncNoiseTicker();
      syncFloatingFloorTicker();
      if (!isAnimating) {
        render();
      }
    });
  }

  function setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(boardRect.width * dpr);
    canvas.height = Math.round(boardRect.height * dpr);
    canvas.style.aspectRatio = `${state.width} / ${state.height}`;
    sceneCanvas.width = boardRect.width;
    sceneCanvas.height = boardRect.height;
    sceneCtx.setTransform(1, 0, 0, 1, 0, 0);
    sceneCtx.imageSmoothingEnabled = false;

    if (renderer && gl) {
      gl.viewport(0, 0, canvas.width, canvas.height);
    } else if (fallbackCtx) {
      fallbackCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fallbackCtx.imageSmoothingEnabled = false;
    }
  }

  function syncPlayLayout() {
    if (!playShell || !playHeader || !playStage || !mazeFrame) {
      return;
    }

    const frameStyles = window.getComputedStyle(mazeFrame);
    const marginRight = parseFloat(frameStyles.marginRight) || 0;
    const marginBottom = parseFloat(frameStyles.marginBottom) || 0;
    const availableWidth = Math.max(0, playStage.clientWidth - marginRight);
    const availableHeight = Math.max(0, playStage.clientHeight - marginBottom);
    const boardSize = Math.floor(Math.min(availableWidth, availableHeight));

    if (!Number.isFinite(boardSize) || boardSize <= 0) {
      return;
    }

    mazeFrame.style.width = `${boardSize}px`;
    mazeFrame.style.height = `${boardSize}px`;
    const controlWidth = Math.min(playStage.clientWidth, boardSize + marginRight);
    playHeader.style.width = `${controlWidth}px`;
  }

  function preloadImages() {
    return Promise.all(
      Array.from(imageUrls).map((url) => {
        return new Promise((resolve) => {
          const image = new Image();
          image.onload = function () {
            imageCache.set(url, image);
            resolve();
          };
          image.onerror = function () {
            imageCache.set(url, null);
            resolve();
          };
          image.src = url;
        });
      })
    );
  }

  function roundRectPath(context, x, y, width, height, radii) {
    context.beginPath();
    context.moveTo(x + radii.tl, y);
    context.lineTo(x + width - radii.tr, y);
    context.quadraticCurveTo(x + width, y, x + width, y + radii.tr);
    context.lineTo(x + width, y + height - radii.br);
    context.quadraticCurveTo(x + width, y + height, x + width - radii.br, y + height);
    context.lineTo(x + radii.bl, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - radii.bl);
    context.lineTo(x, y + radii.tl);
    context.quadraticCurveTo(x, y, x + radii.tl, y);
    context.closePath();
  }

  function paintFloorTile(x, y, cell) {
    const left = x * TILE_SIZE;
    const top = y * TILE_SIZE;
    const image = cell.imageUrl ? imageCache.get(cell.imageUrl) : null;

    if (image) {
      sceneCtx.drawImage(image, left, top, TILE_SIZE, TILE_SIZE);
      return;
    }

    if (cell.type === "hole") {
      sceneCtx.fillStyle = "#050608";
      sceneCtx.fillRect(left, top, TILE_SIZE, TILE_SIZE);
      return;
    }

    if (cell.type === "player_gate") {
      sceneCtx.fillStyle = "#c75652";
      sceneCtx.fillRect(left, top, TILE_SIZE, TILE_SIZE);
      sceneCtx.strokeStyle = "rgba(0, 0, 0, 0.18)";
      sceneCtx.lineWidth = 1.5;
      sceneCtx.strokeRect(left + 0.75, top + 0.75, TILE_SIZE - 1.5, TILE_SIZE - 1.5);
      return;
    }

    if (cell.type === "ice") {
      const centerX = left + TILE_SIZE * 0.5;
      const centerY = top + TILE_SIZE * 0.5;
      const shineHalfWidth = TILE_SIZE * 0.27;
      const shineHalfHeight = TILE_SIZE * 0.12;

      sceneCtx.fillStyle = "#a9d6f4";
      sceneCtx.fillRect(left, top, TILE_SIZE, TILE_SIZE);
      sceneCtx.strokeStyle = "rgba(110, 170, 212, 0.6)";
      sceneCtx.lineWidth = 1.5;
      sceneCtx.strokeRect(left + 0.75, top + 0.75, TILE_SIZE - 1.5, TILE_SIZE - 1.5);
      sceneCtx.strokeStyle = "rgba(255, 255, 255, 0.7)";
      sceneCtx.lineWidth = 3.5;
      sceneCtx.lineCap = "round";
      sceneCtx.beginPath();
      sceneCtx.moveTo(centerX - shineHalfWidth, centerY + shineHalfHeight);
      sceneCtx.lineTo(centerX + shineHalfWidth, centerY - shineHalfHeight);
      sceneCtx.stroke();
      sceneCtx.lineCap = "butt";
      return;
    }

    sceneCtx.fillStyle = "#d6bd94";
    sceneCtx.fillRect(left, top, TILE_SIZE, TILE_SIZE);
    sceneCtx.strokeStyle = "rgba(0, 0, 0, 0.12)";
    sceneCtx.lineWidth = 1.5;
    sceneCtx.strokeRect(left + 0.75, top + 0.75, TILE_SIZE - 1.5, TILE_SIZE - 1.5);
  }

  function groundFaceColor(cell) {
    const groundCell = groundSurfaceCell(cell);

    if (groundCell.type === "ice") {
      return "#7fb6db";
    }

    if (groundCell.type === "player_gate") {
      return "#a84d46";
    }

    return "#b89c73";
  }

  function paintGroundDropFace(x, y, cell) {
    if (y >= state.height - 1 || !isGroundCell(cell) || !isHole(x, y + 1)) {
      return;
    }

    const groundCell = groundSurfaceCell(cell);
    const left = x * TILE_SIZE;
    const faceTop = (y + 1) * TILE_SIZE;
    const faceHeight = Math.round(TILE_SIZE * 0.24);
    const borderWidth = 3;
    const leftNeighborHasFace =
      x > 0 && isGroundCell(terrainAt(x - 1, y)) && isHole(x - 1, y + 1);
    const rightNeighborHasFace =
      x < state.width - 1 && isGroundCell(terrainAt(x + 1, y)) && isHole(x + 1, y + 1);

    sceneCtx.fillStyle = groundFaceColor(groundCell);
    sceneCtx.fillRect(left, faceTop, TILE_SIZE, faceHeight);
    sceneCtx.lineWidth = borderWidth;
    sceneCtx.strokeStyle = "#000000";
    sceneCtx.beginPath();
    sceneCtx.moveTo(left, faceTop + borderWidth / 2);
    sceneCtx.lineTo(left + TILE_SIZE, faceTop + borderWidth / 2);
    sceneCtx.stroke();
    sceneCtx.fillStyle = "#000000";

    if (!leftNeighborHasFace) {
      sceneCtx.fillRect(left, faceTop, borderWidth, faceHeight);
    }

    if (!rightNeighborHasFace) {
      sceneCtx.fillRect(left + TILE_SIZE - borderWidth, faceTop, borderWidth, faceHeight);
    }
  }

  function paintWallTile(x, y, cell) {
    const left = x * TILE_SIZE;
    const top = y * TILE_SIZE;
    const right = left + TILE_SIZE;
    const bottom = top + TILE_SIZE;
    const image = cell.imageUrl ? imageCache.get(cell.imageUrl) : null;
    const openTop = !isTerrainWall(x, y - 1);
    const openRight = !isTerrainWall(x + 1, y);
    const openBottom = !isTerrainWall(x, y + 1);
    const openLeft = !isTerrainWall(x - 1, y);

    paintFloorTile(x, y, groundSurfaceCell(cell));

    if (image) {
      sceneCtx.drawImage(image, left, top, TILE_SIZE, TILE_SIZE);
      return;
    }

    const faceHeight = Math.round(TILE_SIZE * 0.26);
    const hasFloorAbove = y > 0 && openTop;
    const liftHeight = hasFloorAbove ? faceHeight : 0;
    const wallTop = top - liftHeight;
    const wallHeight = TILE_SIZE + liftHeight;
    const radius = TILE_SIZE * 0.18;
    const radii = {
      tl: openTop && openLeft ? radius : 0,
      tr: openTop && openRight ? radius : 0,
      br: 0,
      bl: 0
    };
    const rightCornerWallTop =
      openRight &&
      !openBottom &&
      x < state.width - 1 &&
      y < state.height - 1 &&
      isTerrainWall(x + 1, y + 1) &&
      !isTerrainWall(x + 1, y)
        ? bottom - faceHeight
        : bottom - radii.br;
    const leftCornerWallTop =
      openLeft &&
      !openBottom &&
      x > 0 &&
      y < state.height - 1 &&
      isTerrainWall(x - 1, y + 1) &&
      !isTerrainWall(x - 1, y)
        ? bottom - faceHeight
        : bottom - radii.bl;

    if (x === 0 && y === 0) {
      radii.tl = 0;
    }
    if (x === state.width - 1 && y === 0) {
      radii.tr = 0;
    }
    if (x === state.width - 1 && y === state.height - 1) {
      radii.br = 0;
    }
    if (x === 0 && y === state.height - 1) {
      radii.bl = 0;
    }

    roundRectPath(sceneCtx, left, wallTop, TILE_SIZE, wallHeight, radii);
    sceneCtx.save();
    sceneCtx.clip();
    sceneCtx.fillStyle = "#23262c";
    sceneCtx.fillRect(left, wallTop, TILE_SIZE, wallHeight);

    if (y < state.height - 1 && !isTerrainWall(x, y + 1)) {
      const shineTop = bottom - faceHeight;
      const shineBorderWidth = 3;
      const leftNeighborHasShine =
        x > 0 && isTerrainWall(x - 1, y) && !isTerrainWall(x - 1, y + 1);
      const rightNeighborHasShine =
        x < state.width - 1 && isTerrainWall(x + 1, y) && !isTerrainWall(x + 1, y + 1);
      sceneCtx.fillStyle = "#4f5560";
      sceneCtx.fillRect(left, shineTop, TILE_SIZE, faceHeight);
      sceneCtx.lineWidth = shineBorderWidth;
      sceneCtx.strokeStyle = "#000000";
      sceneCtx.beginPath();
      sceneCtx.moveTo(left, shineTop + shineBorderWidth / 2);
      sceneCtx.lineTo(right, shineTop + shineBorderWidth / 2);
      sceneCtx.stroke();
      sceneCtx.fillStyle = "#000000";
      if (!openLeft && !leftNeighborHasShine) {
        sceneCtx.fillRect(left, shineTop, shineBorderWidth, faceHeight);
      }
      if (!openRight && !rightNeighborHasShine) {
        sceneCtx.fillRect(right - shineBorderWidth, shineTop, shineBorderWidth, faceHeight);
      }
    }
    sceneCtx.restore();

    sceneCtx.lineWidth = 3;
    sceneCtx.strokeStyle = "#000000";
    sceneCtx.beginPath();

    if (openTop) {
      sceneCtx.moveTo(left + radii.tl, wallTop);
      sceneCtx.lineTo(right - radii.tr, wallTop);
    }

    if (openRight) {
      sceneCtx.moveTo(right, wallTop + radii.tr);
      sceneCtx.lineTo(right, rightCornerWallTop);
    }

    if (openBottom) {
      sceneCtx.moveTo(right - radii.br, bottom);
      sceneCtx.lineTo(left + radii.bl, bottom);
    }

    if (openLeft) {
      sceneCtx.moveTo(left, leftCornerWallTop);
      sceneCtx.lineTo(left, wallTop + radii.tl);
    }

    if (radii.tl > 0) {
      sceneCtx.moveTo(left + radii.tl, wallTop);
      sceneCtx.quadraticCurveTo(left, wallTop, left, wallTop + radii.tl);
    }

    if (radii.tr > 0) {
      sceneCtx.moveTo(right - radii.tr, wallTop);
      sceneCtx.quadraticCurveTo(right, wallTop, right, wallTop + radii.tr);
    }

    if (radii.br > 0) {
      sceneCtx.moveTo(right, bottom - radii.br);
      sceneCtx.quadraticCurveTo(right, bottom, right - radii.br, bottom);
    }

    if (radii.bl > 0) {
      sceneCtx.moveTo(left + radii.bl, bottom);
      sceneCtx.quadraticCurveTo(left, bottom, left, bottom - radii.bl);
    }

    sceneCtx.stroke();
  }

  function paintRaisedPlayerGateTile(x, y, cell, lift = 1) {
    if (lift <= 0.001) {
      return;
    }

    void cell;

    const left = x * TILE_SIZE;
    const top = y * TILE_SIZE;
    const right = left + TILE_SIZE;
    const bottom = top + TILE_SIZE;
    const faceHeight = Math.round(TILE_SIZE * 0.26);
    const liftHeight = y > 0 ? faceHeight : 0;
    const travel = liftHeight * lift;
    const platformTop = top - travel;
    const platformBottom = bottom - travel;
    const borderAlpha = clamp(lift, 0, 1);
    const borderColor = `rgba(0, 0, 0, ${borderAlpha})`;
    const radius = TILE_SIZE * 0.18;
    const radii = {
      tl: radius,
      tr: radius,
      br: 0,
      bl: 0
    };

    if (x === 0 && y === 0) {
      radii.tl = 0;
    }
    if (x === state.width - 1 && y === 0) {
      radii.tr = 0;
    }

    roundRectPath(sceneCtx, left, platformTop, TILE_SIZE, TILE_SIZE + travel, radii);
    sceneCtx.save();
    sceneCtx.clip();
    sceneCtx.fillStyle = "#c75652";
    sceneCtx.fillRect(left, platformTop, TILE_SIZE, TILE_SIZE + travel);

    if (travel > 0.001) {
      sceneCtx.fillStyle = "#d86c63";
      sceneCtx.fillRect(left, platformBottom, TILE_SIZE, Math.min(faceHeight, travel));
    }
    sceneCtx.restore();

    sceneCtx.lineWidth = 3;
    sceneCtx.strokeStyle = borderColor;
    sceneCtx.beginPath();
    sceneCtx.moveTo(left + radii.tl, platformTop);
    sceneCtx.lineTo(right - radii.tr, platformTop);
    sceneCtx.moveTo(right, platformTop + radii.tr);
    sceneCtx.lineTo(right, bottom);
    sceneCtx.moveTo(right, bottom);
    sceneCtx.lineTo(left, bottom);
    sceneCtx.moveTo(left, bottom);
    sceneCtx.lineTo(left, platformTop + radii.tl);
    sceneCtx.moveTo(left + radii.tl, platformTop);
    sceneCtx.quadraticCurveTo(left, platformTop, left, platformTop + radii.tl);
    sceneCtx.moveTo(right - radii.tr, platformTop);
    sceneCtx.quadraticCurveTo(right, platformTop, right, platformTop + radii.tr);

    if (travel > 0.001) {
      sceneCtx.moveTo(left, platformBottom);
      sceneCtx.lineTo(right, platformBottom);
    }

    sceneCtx.stroke();
  }

  function paintExit(x, y, cell) {
    paintFloorTile(x, y, cell);

    const left = x * TILE_SIZE + TILE_SIZE / 2;
    const top = y * TILE_SIZE + TILE_SIZE / 2;
    const image = cell.imageUrl ? imageCache.get(cell.imageUrl) : null;

    if (image) {
      sceneCtx.drawImage(image, x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      return;
    }

    sceneCtx.fillStyle = "#ff7b72";
    sceneCtx.beginPath();
    sceneCtx.arc(left, top, TILE_SIZE * 0.18, 0, Math.PI * 2);
    sceneCtx.fill();
    sceneCtx.lineWidth = 3;
    sceneCtx.strokeStyle = "#000000";
    sceneCtx.stroke();
  }

  function paintGround(now = performance.now()) {
    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        const cell = terrainAt(x, y);
        const gateLift = cell.type === "player_gate" ? gateLiftAt(x, y, now) : 0;

        if (cell.type === "wall") {
          continue;
        }

        if (cell.type === "player_gate" && gateLift > 0.001) {
          continue;
        }

        if (cell.type === "exit") {
          paintExit(x, y, cell);
          continue;
        }

        paintFloorTile(x, y, cell);
      }
    }

    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        if (isPlayerGate(x, y) && gateLiftAt(x, y, now) > 0.001) {
          continue;
        }

        paintGroundDropFace(x, y, terrainAt(x, y));
      }
    }
  }

  function paintWalls() {
    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        const cell = terrainAt(x, y);
        if (cell.type === "wall") {
          paintWallTile(x, y, cell);
        }
      }
    }
  }

  function paintWeightlessBoxTile(actor, offsetX = 0, offsetY = 0, context = sceneCtx) {
    const left = actor.x * TILE_SIZE + offsetX;
    const top = actor.y * TILE_SIZE + offsetY;
    const right = left + TILE_SIZE;
    const bottom = top + TILE_SIZE;
    const openTop = !isWeightlessBoxAt(actor.groupId, actor.x, actor.y - 1);
    const openRight = !isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y);
    const openBottom = !isWeightlessBoxAt(actor.groupId, actor.x, actor.y + 1);
    const openLeft = !isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y);
    const faceHeight = Math.round(TILE_SIZE * 0.26);
    const hasFloorAbove = actor.y > 0 && openTop;
    const liftHeight = hasFloorAbove ? faceHeight : 0;
    const wallTop = top - liftHeight;
    const wallHeight = TILE_SIZE + liftHeight;
    const radius = TILE_SIZE * 0.18;
    const radii = {
      tl: openTop && openLeft ? radius : 0,
      tr: openTop && openRight ? radius : 0,
      br: 0,
      bl: 0
    };
    const rightCornerWallTop =
      openRight &&
      !openBottom &&
      actor.x < state.width - 1 &&
      actor.y < state.height - 1 &&
      isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y + 1) &&
      !isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y)
        ? bottom - faceHeight
        : bottom - radii.br;
    const leftCornerWallTop =
      openLeft &&
      !openBottom &&
      actor.x > 0 &&
      actor.y < state.height - 1 &&
      isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y + 1) &&
      !isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y)
        ? bottom - faceHeight
        : bottom - radii.bl;

    roundRectPath(context, left, wallTop, TILE_SIZE, wallHeight, radii);
    context.save();
    context.clip();
    context.fillStyle = "#315991";
    context.fillRect(left, wallTop, TILE_SIZE, wallHeight);

    if (openBottom) {
      const shineTop = bottom - faceHeight;
      const shineBorderWidth = 3;
      const leftNeighborHasShine =
        actor.x > 0 &&
        isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y) &&
        !isWeightlessBoxAt(actor.groupId, actor.x - 1, actor.y + 1);
      const rightNeighborHasShine =
        actor.x < state.width - 1 &&
        isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y) &&
        !isWeightlessBoxAt(actor.groupId, actor.x + 1, actor.y + 1);
      context.fillStyle = "#79abeb";
      context.fillRect(left, shineTop, TILE_SIZE, faceHeight);
      context.lineWidth = shineBorderWidth;
      context.strokeStyle = "#000000";
      context.beginPath();
      context.moveTo(left, shineTop + shineBorderWidth / 2);
      context.lineTo(right, shineTop + shineBorderWidth / 2);
      context.stroke();
      context.fillStyle = "#000000";
      if (!openLeft && !leftNeighborHasShine) {
        context.fillRect(left, shineTop, shineBorderWidth, faceHeight);
      }
      if (!openRight && !rightNeighborHasShine) {
        context.fillRect(right - shineBorderWidth, shineTop, shineBorderWidth, faceHeight);
      }
    }
    context.restore();

    function traceOutline() {
      context.beginPath();

      if (openTop) {
        context.moveTo(left + radii.tl, wallTop);
        context.lineTo(right - radii.tr, wallTop);
      }

      if (openRight) {
        context.moveTo(right, wallTop + radii.tr);
        context.lineTo(right, rightCornerWallTop);
      }

      if (openBottom) {
        context.moveTo(right - radii.br, bottom);
        context.lineTo(left + radii.bl, bottom);
      }

      if (openLeft) {
        context.moveTo(left, leftCornerWallTop);
        context.lineTo(left, wallTop + radii.tl);
      }

      if (radii.tl > 0) {
        context.moveTo(left + radii.tl, wallTop);
        context.quadraticCurveTo(left, wallTop, left, wallTop + radii.tl);
      }

      if (radii.tr > 0) {
        context.moveTo(right - radii.tr, wallTop);
        context.quadraticCurveTo(right, wallTop, right, wallTop + radii.tr);
      }

      if (radii.br > 0) {
        context.moveTo(right, bottom - radii.br);
        context.quadraticCurveTo(right, bottom, right - radii.br, bottom);
      }

      if (radii.bl > 0) {
        context.moveTo(left + radii.bl, bottom);
        context.quadraticCurveTo(left, bottom, left, bottom - radii.bl);
      }
    }

    context.lineWidth = 3;
    context.strokeStyle = "#315991";
    traceOutline();
    context.stroke();
    context.strokeStyle = "#000000";
    traceOutline();
    context.stroke();
  }

  function paintRaisedPlayer(actor, context = sceneCtx) {
    const scale = actor.renderScale ?? 1;

    if (scale <= 0.001) {
      return;
    }

    const sink = actor.renderSink ?? 0;
    const left = actor.renderX * TILE_SIZE;
    const top = actor.renderY * TILE_SIZE;
    const bottom = top + TILE_SIZE;
    const faceHeight = Math.round(TILE_SIZE * 0.26);
    const liftHeight = actor.renderY > 0 ? faceHeight : 0;
    const blockTop = top - liftHeight;
    const blockHeight = TILE_SIZE + liftHeight;
    const radius = TILE_SIZE * 0.18;
    const radii = {
      tl: radius,
      tr: radius,
      br: 0,
      bl: 0
    };

    context.save();
    context.translate(left + TILE_SIZE / 2, bottom + sink);
    context.scale(scale, scale);
    context.translate(-(left + TILE_SIZE / 2), -bottom);

    roundRectPath(context, left, blockTop, TILE_SIZE, blockHeight, radii);
    context.save();
    context.clip();
    context.fillStyle = "#4d8b52";
    context.fillRect(left, blockTop, TILE_SIZE, blockHeight);

    const shineTop = bottom - faceHeight;
    const shineBorderWidth = 3;
    context.fillStyle = "#86cb7d";
    context.fillRect(left, shineTop, TILE_SIZE, faceHeight);
    context.lineWidth = shineBorderWidth;
    context.strokeStyle = "#000000";
    context.beginPath();
    context.moveTo(left, shineTop + shineBorderWidth / 2);
    context.lineTo(left + TILE_SIZE, shineTop + shineBorderWidth / 2);
    context.stroke();
    context.restore();

    function tracePlayerOutline() {
      context.beginPath();
      context.moveTo(left + radii.tl, blockTop);
      context.lineTo(left + TILE_SIZE - radii.tr, blockTop);
      context.moveTo(left + TILE_SIZE, blockTop + radii.tr);
      context.lineTo(left + TILE_SIZE, bottom);
      context.moveTo(left + TILE_SIZE, bottom);
      context.lineTo(left, bottom);
      context.moveTo(left, bottom);
      context.lineTo(left, blockTop + radii.tl);
      context.moveTo(left + radii.tl, blockTop);
      context.quadraticCurveTo(left, blockTop, left, blockTop + radii.tl);
      context.moveTo(left + TILE_SIZE - radii.tr, blockTop);
      context.quadraticCurveTo(left + TILE_SIZE, blockTop, left + TILE_SIZE, blockTop + radii.tr);
    }

    context.lineWidth = 3;
    context.strokeStyle = "#4d8b52";
    tracePlayerOutline();
    context.stroke();
    context.strokeStyle = "#000000";
    tracePlayerOutline();
    context.stroke();
    context.restore();
  }

  function paintFloatingFloor(actor, context = sceneCtx, now = performance.now()) {
    const scale = actor.renderScale ?? 1;

    if (scale <= 0.001) {
      return;
    }

    const sink = actor.renderSink ?? 0;
    const left = actor.renderX * TILE_SIZE;
    const top = actor.renderY * TILE_SIZE;
    const right = left + TILE_SIZE;
    const bottom = top + TILE_SIZE;
    const hover = Math.max(0, floatingFloorHoverOffset(actor, now));
    const platformTop = top - hover + sink;
    const platformBottom = bottom - hover + sink;
    const radius = Math.min(7, TILE_SIZE * 0.11);

    context.save();
    context.translate(left + TILE_SIZE / 2, bottom + sink);
    context.scale(scale, scale);
    context.translate(-(left + TILE_SIZE / 2), -(bottom + sink));

    roundRectPath(
      context,
      left + FLOATING_FLOOR_SHADOW_INSET,
      bottom - FLOATING_FLOOR_SHADOW_HEIGHT * 0.5 + sink,
      TILE_SIZE - FLOATING_FLOOR_SHADOW_INSET * 2,
      FLOATING_FLOOR_SHADOW_HEIGHT,
      {
        tl: FLOATING_FLOOR_SHADOW_HEIGHT * 0.5,
        tr: FLOATING_FLOOR_SHADOW_HEIGHT * 0.5,
        br: FLOATING_FLOOR_SHADOW_HEIGHT * 0.5,
        bl: FLOATING_FLOOR_SHADOW_HEIGHT * 0.5
      }
    );
    context.fillStyle = "rgba(0, 0, 0, 0.18)";
    context.fill();

    roundRectPath(context, left, platformTop, TILE_SIZE, TILE_SIZE + hover, {
      tl: radius,
      tr: radius,
      br: 0,
      bl: 0
    });
    context.save();
    context.clip();
    context.fillStyle = "#d6bd94";
    context.fillRect(left, platformTop, TILE_SIZE, TILE_SIZE + hover);
    context.strokeStyle = "rgba(0, 0, 0, 0.12)";
    context.lineWidth = 1.5;
    context.strokeRect(left + 0.75, platformTop + 0.75, TILE_SIZE - 1.5, TILE_SIZE - 1.5);

    if (hover > 0.001) {
      context.fillStyle = "#b89c73";
      context.fillRect(left, platformBottom, TILE_SIZE, hover);
    }
    context.restore();

    context.lineWidth = 3;
    context.strokeStyle = "#000000";
    context.beginPath();
    context.moveTo(left + radius, platformTop);
    context.lineTo(right - radius, platformTop);
    context.moveTo(right, platformTop + radius);
    context.lineTo(right, bottom + sink);
    context.moveTo(right, bottom + sink);
    context.lineTo(left, bottom + sink);
    context.moveTo(left, bottom + sink);
    context.lineTo(left, platformTop + radius);
    context.moveTo(left + radius, platformTop);
    context.quadraticCurveTo(left, platformTop, left, platformTop + radius);
    context.moveTo(right - radius, platformTop);
    context.quadraticCurveTo(right, platformTop, right, platformTop + radius);

    if (hover > 0.001) {
      context.moveTo(left, platformBottom);
      context.lineTo(right, platformBottom);
    }

    context.stroke();
    context.restore();
  }

  function animatedWeightlessGroupMembers(groupId) {
    return weightlessGroupMembers(groupId, { includeRemoved: true }).filter(
      (member) => !member.removed || member.renderScale > 0.001
    );
  }

  function paintWeightlessGroup(groupId) {
    const groupState = weightlessGroupRenderState(groupId);

    if (groupState.scale <= 0.001) {
      return;
    }

    const members = animatedWeightlessGroupMembers(groupId).sort((left, right) => {
      if (left.y !== right.y) {
        return left.y - right.y;
      }

      return left.x - right.x;
    });

    if (members.length === 0) {
      return;
    }

    if (!weightlessGroupCtx) {
      members.forEach((member) => {
        paintWeightlessBoxTile(member, groupState.offsetX, groupState.offsetY);
      });
      return;
    }

    const faceHeight = Math.round(TILE_SIZE * 0.26);
    const minX = Math.min(...members.map((member) => member.x));
    const maxX = Math.max(...members.map((member) => member.x));
    const minY = Math.min(...members.map((member) => member.y));
    const maxY = Math.max(...members.map((member) => member.y));
    const bitmapWidth = (maxX - minX + 1) * TILE_SIZE;
    const bitmapHeight = (maxY - minY + 1) * TILE_SIZE + faceHeight;
    const tileOffsetX = -minX * TILE_SIZE;
    const tileOffsetY = faceHeight - minY * TILE_SIZE;
    const drawLeft = minX * TILE_SIZE + groupState.offsetX;
    const drawTop = minY * TILE_SIZE - faceHeight + groupState.offsetY;

    if (weightlessGroupCanvas.width !== bitmapWidth || weightlessGroupCanvas.height !== bitmapHeight) {
      weightlessGroupCanvas.width = bitmapWidth;
      weightlessGroupCanvas.height = bitmapHeight;
    }

    weightlessGroupCtx.setTransform(1, 0, 0, 1, 0, 0);
    weightlessGroupCtx.clearRect(0, 0, bitmapWidth, bitmapHeight);
    weightlessGroupCtx.imageSmoothingEnabled = false;
    members.forEach((member) => {
      paintWeightlessBoxTile(member, tileOffsetX, tileOffsetY, weightlessGroupCtx);
    });

    sceneCtx.save();
    if (groupState.sink > 0.001) {
      sceneCtx.beginPath();
      members.forEach((member) => {
        sceneCtx.rect(member.x * TILE_SIZE, member.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      });
      sceneCtx.clip();
    }
    sceneCtx.translate(groupState.centerX, groupState.centerY + groupState.sink);
    sceneCtx.scale(groupState.scale, groupState.scale);
    sceneCtx.translate(-groupState.centerX, -groupState.centerY);
    sceneCtx.imageSmoothingEnabled = false;
    sceneCtx.drawImage(weightlessGroupCanvas, drawLeft, drawTop);
    sceneCtx.restore();
  }

  function paintDepthSortedScene(now = performance.now()) {
    const drawItems = [];
    const animatedWeightlessGroups = new Set();

    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        const cell = terrainAt(x, y);
        const gateLift = cell.type === "player_gate" ? gateLiftAt(x, y, now) : 0;

        if (cell.type !== "wall" && gateLift <= 0.001) {
          continue;
        }

        drawItems.push({
          depth: y + 1,
          tieBreaker: 0,
          order: drawItems.length,
          paint: function () {
            if (cell.type === "player_gate") {
              paintRaisedPlayerGateTile(x, y, cell, gateLift);
              return;
            }

            paintWallTile(x, y, cell);
          }
        });
      }
    }

    state.actors.forEach((actor, index) => {
      if (actor.removed) {
        return;
      }

      if (actor.type === "weightless_box") {
        const groupState = weightlessGroupRenderState(actor.groupId);
        const isGroupedAnimation =
          Math.abs((groupState.scale ?? 1) - 1) > 0.001 || Math.abs(groupState.sink ?? 0) > 0.001;

        if (isGroupedAnimation) {
          if (animatedWeightlessGroups.has(actor.groupId)) {
            return;
          }

          animatedWeightlessGroups.add(actor.groupId);
          const members = animatedWeightlessGroupMembers(actor.groupId);

          if (members.length === 0) {
            return;
          }

          drawItems.push({
            depth:
              (actor.renderInHole ? 0 : 1) + Math.max(...members.map((member) => member.renderY)),
            tieBreaker: actor.renderInHole ? -1 : 1,
            order: index,
            paint: function () {
              paintWeightlessGroup(actor.groupId);
            }
          });
          return;
        }
      }

      drawItems.push({
        depth: actor.renderY + (actor.renderInHole ? 0 : 1),
        tieBreaker: actor.renderInHole ? -1 : isCollectibleActor(actor) ? 0 : isPlayerActor(actor) ? 2 : 1,
        order: index,
        paint: function () {
          paintActor(actor, now);
        }
      });
    });

    drawItems.sort((left, right) => {
      if (left.depth !== right.depth) {
        return left.depth - right.depth;
      }

      if (left.tieBreaker !== right.tieBreaker) {
        return left.tieBreaker - right.tieBreaker;
      }

      return left.order - right.order;
    });

    drawItems.forEach((item) => item.paint());
  }

  function paintActor(actor, now = performance.now()) {
    if (actor.removed) {
      return;
    }

    const scale = actor.renderScale ?? 1;

    if (scale <= 0.001) {
      return;
    }

    const sink = actor.renderSink ?? 0;
    const left = actor.renderX * TILE_SIZE;
    const top = actor.renderY * TILE_SIZE;
    const image = actor.imageUrl ? imageCache.get(actor.imageUrl) : null;
    const clipToHole = sink > 0.001;

    if (clipToHole) {
      sceneCtx.save();
      sceneCtx.beginPath();
      sceneCtx.rect(left, top, TILE_SIZE, TILE_SIZE);
      sceneCtx.clip();
    }

    if (actor.type === "weightless_box") {
      const groupState = weightlessGroupRenderState(actor.groupId);
      paintWeightlessBoxTile(actor, groupState.offsetX, groupState.offsetY);
      if (clipToHole) {
        sceneCtx.restore();
      }
      return;
    }

    if (actor.type === "floating_floor") {
      paintFloatingFloor(actor, sceneCtx, now);
      if (clipToHole) {
        sceneCtx.restore();
      }
      return;
    }

    if (actor.type === "gem") {
      const hover = Math.max(0, floatingFloorHoverOffset(actor, now));
      const drawWidth = GEM_DRAW_WIDTH * scale;
      const drawHeight = image ? drawWidth * (image.height / image.width) : drawWidth;
      const drawLeft = left + (TILE_SIZE - drawWidth) / 2;
      const drawTop = top + TILE_SIZE * 0.66 - drawHeight + sink - hover;
      const shadowWidth = GEM_SHADOW_WIDTH * scale;
      const shadowHeight = GEM_SHADOW_HEIGHT * scale;

      sceneCtx.fillStyle = "rgba(0, 0, 0, 0.18)";
      sceneCtx.beginPath();
      sceneCtx.ellipse(
        left + TILE_SIZE / 2,
        top + TILE_SIZE * 0.76 + sink,
        shadowWidth / 2,
        shadowHeight / 2,
        0,
        0,
        Math.PI * 2
      );
      sceneCtx.fill();

      if (image) {
        sceneCtx.drawImage(image, drawLeft, drawTop, drawWidth, drawHeight);
      } else {
        sceneCtx.fillStyle = "#6cd7ff";
        sceneCtx.beginPath();
        sceneCtx.moveTo(left + TILE_SIZE / 2, drawTop);
        sceneCtx.lineTo(drawLeft + drawWidth, drawTop + drawHeight * 0.45);
        sceneCtx.lineTo(left + TILE_SIZE / 2, drawTop + drawHeight);
        sceneCtx.lineTo(drawLeft, drawTop + drawHeight * 0.45);
        sceneCtx.closePath();
        sceneCtx.fill();
      }

      if (clipToHole) {
        sceneCtx.restore();
      }
      return;
    }

    if (image) {
      if (actor.type === "box") {
        const drawWidth = TILE_SIZE * scale;
        const drawHeight = drawWidth * (image.height / image.width);
        const drawLeft = left + (TILE_SIZE - drawWidth) / 2;
        const drawTop = top + TILE_SIZE - drawHeight + sink;

        sceneCtx.drawImage(image, drawLeft, drawTop, drawWidth, drawHeight);
        if (clipToHole) {
          sceneCtx.restore();
        }
        return;
      }

      const drawWidth = TILE_SIZE * scale;
      const drawHeight = TILE_SIZE * scale;
      const drawLeft = left + (TILE_SIZE - drawWidth) / 2;
      const drawTop = top + (TILE_SIZE - drawHeight) / 2 + sink;

      sceneCtx.drawImage(image, drawLeft, drawTop, drawWidth, drawHeight);
      if (clipToHole) {
        sceneCtx.restore();
      }
      return;
    }

    if (actor.type === "circle_player") {
      sceneCtx.fillStyle = "#5aa95c";
      sceneCtx.beginPath();
      sceneCtx.arc(
        left + TILE_SIZE / 2,
        top + TILE_SIZE / 2 + sink,
        TILE_SIZE * 0.338 * scale,
        0,
        Math.PI * 2
      );
      sceneCtx.fill();
      sceneCtx.lineWidth = 3;
      sceneCtx.strokeStyle = "#000000";
      sceneCtx.stroke();
      if (clipToHole) {
        sceneCtx.restore();
      }
      return;
    }

    if (actor.type === "player") {
      paintRaisedPlayer(actor);
      if (clipToHole) {
        sceneCtx.restore();
      }
      return;
    }

    if (actor.type === "box") {
      sceneCtx.save();
      sceneCtx.translate(left + TILE_SIZE / 2, top + TILE_SIZE + sink);
      sceneCtx.scale(scale, scale);
      sceneCtx.translate(-(left + TILE_SIZE / 2), -(top + TILE_SIZE));
      const inset = TILE_SIZE * 0.19;
      const boxLeft = left + inset;
      const boxTop = top + inset;
      const boxSize = TILE_SIZE - inset * 2;
      const boxBottom = boxTop + boxSize;
      const lipHeight = Math.max(6, Math.round(TILE_SIZE * 0.12));
      const radius = Math.min(8, TILE_SIZE * 0.12);

      roundRectPath(sceneCtx, boxLeft, boxTop, boxSize, boxSize, {
        tl: radius,
        tr: radius,
        br: radius * 0.75,
        bl: radius * 0.75
      });
      sceneCtx.fillStyle = "#2a2d33";
      sceneCtx.fill();
      sceneCtx.lineWidth = 3;
      sceneCtx.strokeStyle = "#000000";
      sceneCtx.stroke();

      sceneCtx.fillStyle = "#5b616d";
      sceneCtx.fillRect(boxLeft, boxBottom - lipHeight, boxSize, lipHeight);
      sceneCtx.beginPath();
      sceneCtx.moveTo(boxLeft, boxBottom - lipHeight);
      sceneCtx.lineTo(boxLeft + boxSize, boxBottom - lipHeight);
      sceneCtx.lineWidth = 3;
      sceneCtx.strokeStyle = "#000000";
      sceneCtx.stroke();
      sceneCtx.restore();
    }

    if (clipToHole) {
      sceneCtx.restore();
    }
  }

  function getEffectSettings() {
    const fuzzy = state.effects.fuzzyEnabled ? FUZZY_AMOUNT : 0;
    const fuzzyMix = clamp(fuzzy / FUZZY_AMOUNT, 0, 1);

    return {
      bleed: clamp(0.78 * fuzzyMix, 0, 1),
      bloom: clamp(0.38 * fuzzyMix, 0, 1),
      softness: clamp(0.74 * fuzzyMix, 0, 1),
      scanlines: clamp(0.16 * fuzzyMix, 0, 1),
      mask: clamp(0.03 * fuzzyMix, 0, 1),
      ghosting: clamp(0.03 * fuzzyMix, 0, 1),
      noise: fuzzy,
      vignetteStrength: fuzzyMix
    };
  }

  function renderWithShader(sourceCanvas, settings) {
    if (!gl || !renderer || (typeof gl.isContextLost === "function" && gl.isContextLost())) {
      return false;
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.839, 0.741, 0.58, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(renderer.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, renderer.positionBuffer);
    gl.enableVertexAttribArray(renderer.attribs.position);
    gl.vertexAttribPointer(renderer.attribs.position, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAG_FILTER,
      gl.LINEAR
    );
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
    gl.uniform1i(renderer.uniforms.texture, 0);
    gl.uniform2f(renderer.uniforms.logicalResolution, boardRect.width, boardRect.height);
    gl.uniform1f(renderer.uniforms.bleed, settings.bleed);
    gl.uniform1f(renderer.uniforms.bloom, settings.bloom);
    gl.uniform1f(renderer.uniforms.softness, settings.softness);
    gl.uniform1f(renderer.uniforms.scanlines, settings.scanlines);
    gl.uniform1f(renderer.uniforms.mask, settings.mask);
    gl.uniform1f(renderer.uniforms.ghosting, settings.ghosting);
    gl.uniform1f(renderer.uniforms.noise, settings.noise);
    gl.uniform1f(renderer.uniforms.vignetteStrength, settings.vignetteStrength);
    gl.uniform1f(renderer.uniforms.noisePhase, state.effects.noisePhase);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  function renderFallback(sourceCanvas) {
    if (!fallbackCtx) {
      return;
    }

    fallbackCtx.clearRect(0, 0, boardRect.width, boardRect.height);
    fallbackCtx.imageSmoothingEnabled = false;
    fallbackCtx.drawImage(sourceCanvas, 0, 0, boardRect.width, boardRect.height);
  }

  function render() {
    const now = performance.now();
    liveRaisedPlayerGates = gateRenderOverride || computeRaisedPlayerGateSet();
    syncGateAnimationTargets(now);
    sceneCtx.clearRect(0, 0, boardRect.width, boardRect.height);
    paintGround(now);
    paintDepthSortedScene(now);
    const settings = getEffectSettings();

    if (!renderWithShader(sceneCanvas, settings)) {
      renderFallback(sceneCanvas);
    }
  }

  function canMoveInto(x, y, occupied, gateState = liveRaisedPlayerGates) {
    if (!isInsideBoard(x, y)) {
      return false;
    }

    if (isWall(x, y, gateState)) {
      return false;
    }

    return !occupied.has(posKey(x, y));
  }

  function findSlideDestination(startX, startY, dx, dy, occupied, gateState = liveRaisedPlayerGates) {
    let nextX = startX;
    let nextY = startY;

    while (canMoveInto(nextX + dx, nextY + dy, occupied, gateState)) {
      nextX += dx;
      nextY += dy;

      if (!isIce(nextX, nextY)) {
        break;
      }
    }

    return { x: nextX, y: nextY };
  }

  function moveBox(box, dx, dy, occupied, moves, gateState = liveRaisedPlayerGates) {
    const fromX = box.x;
    const fromY = box.y;
    occupied.delete(posKey(fromX, fromY));

    const target = findSlideDestination(fromX, fromY, dx, dy, occupied, gateState);

    if (target.x === fromX && target.y === fromY) {
      occupied.add(posKey(fromX, fromY));
      return false;
    }

    box.x = target.x;
    box.y = target.y;
    moves.push({
      actor: box,
      fromX,
      fromY,
      toX: target.x,
      toY: target.y
    });
    occupied.add(posKey(box.x, box.y));
    return true;
  }

  function countSupportingPlayers(player, dx, dy) {
    let count = 1;
    let checkX = player.x;
    let checkY = player.y;

    while (true) {
      checkX -= dx;
      checkY -= dy;

      if (!actorAt(checkX, checkY, (actor) => isPlayerActor(actor))) {
        break;
      }

      count += 1;
    }

    return count;
  }

  function collectGemsAt(x, y, moves, collectedGems) {
    actorsAt(x, y, (actor) => isCollectibleActor(actor) && !collectedGems.has(actor)).forEach((gem) => {
      collectedGems.add(gem);
      moves.push({
        actor: gem,
        fromX: gem.x,
        fromY: gem.y,
        toX: gem.x,
        toY: gem.y,
        fromRemoved: false,
        toRemoved: true,
        skipHoleFall: true,
        visibleDuringMove: true
      });
    });
  }

  function collectGemsAlongPath(fromX, fromY, toX, toY, moves, collectedGems) {
    if (fromX === toX && fromY === toY) {
      return;
    }

    const stepX = Math.sign(toX - fromX);
    const stepY = Math.sign(toY - fromY);
    let currentX = fromX + stepX;
    let currentY = fromY + stepY;

    while (true) {
      collectGemsAt(currentX, currentY, moves, collectedGems);

      if (currentX === toX && currentY === toY) {
        return;
      }

      currentX += stepX;
      currentY += stepY;
    }
  }

  function canMoveWeightlessGroup(members, dx, dy, occupied, gateState = liveRaisedPlayerGates) {
    return members.every((member) => {
      const targetX = member.x + dx;
      const targetY = member.y + dy;

      if (!isInsideBoard(targetX, targetY) || isWall(targetX, targetY, gateState)) {
        return false;
      }

      return !occupied.has(posKey(targetX, targetY));
    });
  }

  function moveWeightlessGroup(groupId, dx, dy, occupied, moves, gateState = liveRaisedPlayerGates) {
    const members = weightlessGroupMembers(groupId);

    if (members.length === 0) {
      return false;
    }

    const startPositions = members.map((actor) => ({
      actor,
      fromX: actor.x,
      fromY: actor.y
    }));

    members.forEach((member) => {
      occupied.delete(posKey(member.x, member.y));
    });

    let moved = false;

    while (canMoveWeightlessGroup(members, dx, dy, occupied, gateState)) {
      members.forEach((member) => {
        member.x += dx;
        member.y += dy;
      });

      moved = true;

      if (members.every((member) => isHole(member.x, member.y))) {
        break;
      }

      if (!members.every((member) => isIceOrHole(member.x, member.y))) {
        break;
      }
    }

    if (!moved) {
      startPositions.forEach(({ fromX, fromY }) => {
        occupied.add(posKey(fromX, fromY));
      });
      return false;
    }

    startPositions.forEach(({ actor, fromX, fromY }) => {
      moves.push({
        actor,
        fromX,
        fromY,
        toX: actor.x,
        toY: actor.y
      });
    });

    members.forEach((member) => {
      occupied.add(posKey(member.x, member.y));
    });

    return true;
  }

  function attemptPushActor(
    actor,
    dx,
    dy,
    occupied,
    moves,
    budget,
    handled = new Set(),
    gateState = liveRaisedPlayerGates
  ) {
    const entityKey = pushEntityKey(actor);

    if (handled.has(entityKey)) {
      return budget;
    }

    const cost = pushWeight(actor);

    if (budget < cost) {
      return null;
    }

    let remainingBudget = budget - cost;
    const members = pushActorMembers(actor);
    const memberSet = new Set(members);
    const blockers = [];
    const blockerKeys = new Set();

    for (const member of members) {
      const targetX = member.x + dx;
      const targetY = member.y + dy;

      if (!isInsideBoard(targetX, targetY) || isWall(targetX, targetY, gateState)) {
        return null;
      }

      const blocker = actorAt(
        targetX,
        targetY,
        (candidate) => !memberSet.has(candidate) && !isCollectibleActor(candidate)
      );

      if (!blocker) {
        continue;
      }

      if (!isPushableActor(blocker)) {
        return null;
      }

      const blockerKey = pushEntityKey(blocker);

      if (!blockerKeys.has(blockerKey)) {
        blockers.push(blocker);
        blockerKeys.add(blockerKey);
      }
    }

    for (const blocker of blockers) {
      const result = attemptPushActor(
        blocker,
        dx,
        dy,
        occupied,
        moves,
        remainingBudget,
        handled,
        gateState
      );

      if (result === null) {
        return null;
      }

      remainingBudget = result;
    }

    const moved =
      actor.type === "weightless_box"
        ? moveWeightlessGroup(actor.groupId, dx, dy, occupied, moves, gateState)
        : moveBox(actor, dx, dy, occupied, moves, gateState);

    if (!moved) {
      return null;
    }

    handled.add(entityKey);
    return remainingBudget;
  }

  function applyHoleFalls(moves) {
    const moveByActor = new Map(moves.map((move) => [move.actor, move]));
    const handledGroups = new Set();

    moves.forEach((move) => {
      move.fromRemoved = Boolean(move.fromRemoved);
      move.toRemoved = Boolean(move.toRemoved);

      if (move.actor.type === "weightless_box") {
        if (handledGroups.has(move.actor.groupId)) {
          return;
        }

        handledGroups.add(move.actor.groupId);
        const members = weightlessGroupMembers(move.actor.groupId);

        if (members.length > 0 && members.every((member) => isHole(member.x, member.y))) {
          members.forEach((member) => {
            const memberMove = moveByActor.get(member);

            if (memberMove) {
              memberMove.toRemoved = true;
            }
          });
        }

        return;
      }

      if (move.actor.type === "floating_floor" && isHole(move.actor.x, move.actor.y)) {
        move.toRemoved = true;
        move.skipHoleFall = true;
        move.visibleDuringMove = true;
        move.fillsHole = true;
        move.fillHoleX = move.actor.x;
        move.fillHoleY = move.actor.y;
        return;
      }

      if (isHole(move.actor.x, move.actor.y)) {
        move.toRemoved = true;
      }
    });
  }

  function buildFloorTerrainCell() {
    return {
      type: "floor",
      label: "Floor",
      imageUrl: null,
      underlay: null
    };
  }

  function fillHoleAt(x, y) {
    if (!isInsideBoard(x, y)) {
      return;
    }

    state.terrain[y][x] = buildFloorTerrainCell();
  }

  function easeInOutQuad(progress) {
    if (progress < 0.5) {
      return 2 * progress * progress;
    }

    return 1 - Math.pow(-2 * progress + 2, 2) / 2;
  }

  function finishAnimation(moves) {
    moves.forEach(({ actor, toX, toY, toRemoved = false, skipHoleFall = false }) => {
      actor.renderX = toX;
      actor.renderY = toY;
      actor.renderScale = toRemoved ? 0 : 1;
      actor.renderSink = toRemoved && !skipHoleFall ? HOLE_SINK_DISTANCE : 0;
      actor.renderInHole = false;
      actor.removed = Boolean(toRemoved);
    });

    moves.forEach(({ fillsHole = false, fillHoleX = null, fillHoleY = null }) => {
      if (!fillsHole || typeof fillHoleX !== "number" || typeof fillHoleY !== "number") {
        return;
      }

      fillHoleAt(fillHoleX, fillHoleY);
    });

    gateRenderOverride = null;
    isAnimating = false;
    animationFrameId = null;
    syncFloatingFloorTicker();
    render();

    if (queuedAction) {
      const nextAction = queuedAction;
      queuedAction = null;
      runAction(nextAction);
    }
  }

  function animateMoves(moves, durationMs = null) {
    if (moves.length === 0) {
      return;
    }

    isAnimating = true;
    const startTime = performance.now();
    const holeStateMoves = moves.filter(
      ({
        fromRemoved = false,
        toRemoved = false,
        skipHoleFall = false,
        snapHoleRestore = false
      }) => !skipHoleFall && !snapHoleRestore && fromRemoved !== toRemoved
    );
    const moveDuration =
      typeof durationMs === "number"
        ? durationMs
        : MOVE_DURATION_MS *
          Math.max(
            1,
            ...moves.map(
              ({ fromX, fromY, toX, toY, timingDistance = null }) =>
                typeof timingDistance === "number"
                  ? timingDistance
                  : Math.abs(toX - fromX) + Math.abs(toY - fromY)
            )
          );

    function startFallPhase() {
      if (holeStateMoves.length === 0) {
        finishAnimation(moves);
        return;
      }

      const fallStartTime = performance.now();

      function stepFall(now) {
        const progress = Math.min(1, (now - fallStartTime) / HOLE_FALL_DURATION_MS);
        const eased = easeInOutQuad(progress);

        moves.forEach(
          ({
            actor,
            toX,
            toY,
            fromRemoved = false,
            toRemoved = false,
            skipHoleFall = false
          }) => {
          actor.renderX = toX;
          actor.renderY = toY;
          actor.renderInHole = !skipHoleFall && fromRemoved !== toRemoved;

          if (skipHoleFall) {
            actor.renderScale = 1;
            actor.renderSink = 0;
            return;
          }

          if (fromRemoved && !toRemoved) {
            actor.renderScale = eased;
            actor.renderSink = HOLE_SINK_DISTANCE * (1 - eased);
            return;
          }

          if (!fromRemoved && toRemoved) {
            actor.renderScale = 1 - eased;
            actor.renderSink = HOLE_SINK_DISTANCE * eased;
            return;
          }

          actor.renderScale = toRemoved ? 0 : 1;
          actor.renderSink = toRemoved ? HOLE_SINK_DISTANCE : 0;
          }
        );

        render();

        if (progress < 1) {
          animationFrameId = window.requestAnimationFrame(stepFall);
          return;
        }

        finishAnimation(moves);
      }

      animationFrameId = window.requestAnimationFrame(stepFall);
    }

    function step(now) {
      const progress = Math.min(1, (now - startTime) / moveDuration);
      const eased = easeInOutQuad(progress);

      moves.forEach(
        ({
          actor,
          fromX,
          fromY,
          toX,
          toY,
          fromRemoved = false,
          visibleDuringMove = false
        }) => {
          actor.renderX = fromX + (toX - fromX) * eased;
          actor.renderY = fromY + (toY - fromY) * eased;
          actor.renderInHole = false;

          if (fromRemoved && !visibleDuringMove) {
            actor.renderScale = 0;
            actor.renderSink = HOLE_SINK_DISTANCE;
            return;
          }

          actor.renderScale = 1;
          actor.renderSink = 0;
        }
      );

      render();

      if (progress < 1) {
        animationFrameId = window.requestAnimationFrame(step);
        return;
      }

      startFallPhase();
    }

    if (animationFrameId !== null) {
      window.cancelAnimationFrame(animationFrameId);
    }

    animationFrameId = window.requestAnimationFrame(step);
  }

  function sortActorsForMove(dx, dy) {
    return function (left, right) {
      if (dx > 0) {
        return right.x - left.x || left.y - right.y;
      }
      if (dx < 0) {
        return left.x - right.x || left.y - right.y;
      }
      if (dy > 0) {
        return right.y - left.y || left.x - right.x;
      }
      return left.y - right.y || left.x - right.x;
    };
  }

  function buildMovesToPositions(targetPositions) {
    const moves = [];

    state.actors.forEach((actor, index) => {
      const target = targetPositions[index];

      if (!target) {
        return;
      }

      const fromX = actor.x;
      const fromY = actor.y;
      const fromRemoved = Boolean(actor.removed);
      const toRemoved = Boolean(target.removed);
      actor.x = target.x;
      actor.y = target.y;

      if (!toRemoved) {
        actor.removed = false;
      }

      if (fromX === target.x && fromY === target.y && fromRemoved === toRemoved) {
        actor.renderX = target.x;
        actor.renderY = target.y;
        actor.renderScale = toRemoved ? 0 : 1;
        actor.renderSink = toRemoved ? HOLE_SINK_DISTANCE : 0;
        actor.renderInHole = false;
        actor.removed = toRemoved;
        return;
      }

      actor.renderX = fromX;
      actor.renderY = fromY;
      actor.renderScale = fromRemoved ? 0 : 1;
      actor.renderSink = fromRemoved ? HOLE_SINK_DISTANCE : 0;
      actor.renderInHole = false;
      moves.push({
        actor,
        fromX,
        fromY,
        toX: target.x,
        toY: target.y,
        fromRemoved,
        toRemoved,
        snapHoleRestore: fromRemoved && !toRemoved,
        skipHoleFall: actor.type === "floating_floor" && fromRemoved !== toRemoved,
        visibleDuringMove:
          fromRemoved && !toRemoved
            ? true
            : actor.type === "floating_floor" && fromRemoved !== toRemoved
      });
    });

    return moves;
  }

  function movePlayers(dx, dy) {
    if (isAnimating) {
      queuedAction = { type: "move", dx, dy };
      return;
    }

    const players = state.actors.filter((actor) => isPlayerActor(actor) && !actor.removed);
    let occupied = buildOccupiedSet();
    const raisedPlayerGates = computeRaisedPlayerGateSet();
    const orderedPlayers = players.slice().sort(sortActorsForMove(dx, dy));
    const previousState = {
      actors: cloneActorPositions(),
      terrain: cloneTerrainState(state.terrain)
    };
    const moves = [];
    const collectedGems = new Set();

    orderedPlayers.forEach((player) => {
      const fromX = player.x;
      const fromY = player.y;
      occupied.delete(posKey(player.x, player.y));

      let nextX = fromX;
      let nextY = fromY;

      while (true) {
        const targetX = nextX + dx;
        const targetY = nextY + dy;
        const isInitialStep = nextX === fromX && nextY === fromY;

        if (!isInsideBoard(targetX, targetY) || isWall(targetX, targetY, raisedPlayerGates)) {
          break;
        }

        const blockingActor = actorAt(
          targetX,
          targetY,
          (actor) => actor !== player && !isCollectibleActor(actor)
        );

        if (blockingActor) {
          let didMoveBlockingActor = false;

          if (isInitialStep && isPushableActor(blockingActor)) {
            const attemptSnapshot = cloneActorPositions();
            const moveCount = moves.length;
            const pushBudget = countSupportingPlayers(player, dx, dy);
            const result = attemptPushActor(
              blockingActor,
              dx,
              dy,
              occupied,
              moves,
              pushBudget,
              new Set(),
              raisedPlayerGates
            );

            if (result !== null) {
              didMoveBlockingActor = true;
            } else {
              restoreActorPositions(attemptSnapshot);
              moves.length = moveCount;
              occupied = buildOccupiedSet(player);
            }
          }

          if (!didMoveBlockingActor) {
            break;
          }
        } else if (!canMoveInto(targetX, targetY, occupied, raisedPlayerGates)) {
          break;
        }

        nextX = targetX;
        nextY = targetY;

        if (!isIce(nextX, nextY)) {
          break;
        }
      }

      if (nextX !== fromX || nextY !== fromY) {
        player.x = nextX;
        player.y = nextY;
        const travelDistance = Math.abs(nextX - fromX) + Math.abs(nextY - fromY);
        moves.push({
          actor: player,
          fromX,
          fromY,
          toX: nextX,
          toY: nextY,
          timingDistance:
            travelDistance > 1
              ? 1 + (travelDistance - 1) * ICE_SLIDE_DURATION_MULTIPLIER
              : travelDistance
        });
        collectGemsAlongPath(fromX, fromY, nextX, nextY, moves, collectedGems);
      }

      occupied.add(posKey(player.x, player.y));
    });

    if (moves.length > 0) {
      applyHoleFalls(moves);
      gateRenderOverride = raisedPlayerGates;
      moveHistory.push(previousState);
      animateMoves(moves);
    }
  }

  function undoMove() {
    if (isAnimating) {
      queuedAction = { type: "undo" };
      return;
    }

    const previousState = moveHistory.pop();

    if (!previousState) {
      return;
    }

    restoreTerrainState(previousState.terrain);
    gateRenderOverride = computeRaisedPlayerGateSet();
    const moves = buildMovesToPositions(previousState.actors);

    if (moves.length > 0) {
      animateMoves(moves);
      return;
    }

    gateRenderOverride = null;
    syncFloatingFloorTicker();
    render();
  }

  function resetPositions() {
    if (isAnimating) {
      queuedAction = { type: "reset" };
      return;
    }

    moveHistory.length = 0;
    restoreTerrainState(initialTerrain);
    gateRenderOverride = computeRaisedPlayerGateSet();
    const moves = buildMovesToPositions(initialPositions);

    if (moves.length > 0) {
      animateMoves(moves, MOVE_DURATION_MS);
      return;
    }

    gateRenderOverride = null;
    syncFloatingFloorTicker();
    render();
  }

  function runAction(action) {
    if (!action) {
      return;
    }

    if (action.type === "move") {
      movePlayers(action.dx, action.dy);
      return;
    }

    if (action.type === "undo") {
      undoMove();
      return;
    }

    if (action.type === "reset") {
      resetPositions();
    }
  }

  function handleKeydown(event) {
    const directionalMoves = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0]
    };
    const key = event.key.toLowerCase();

    if (directionalMoves[event.key]) {
      event.preventDefault();
      const [dx, dy] = directionalMoves[event.key];
      movePlayers(dx, dy);
      return;
    }

    if (key === "z" || key === "u") {
      event.preventDefault();
      undoMove();
      return;
    }

    if (key === "r") {
      event.preventDefault();
      resetPositions();
    }
  }

  function preventScroll(event) {
    event.preventDefault();
  }

  if (fuzzyToggle) {
    fuzzyToggle.addEventListener("click", function () {
      state.effects.fuzzyEnabled = !state.effects.fuzzyEnabled;
      syncFuzzyToggle();
      syncNoiseTicker();
      render();
    });
  }

  syncPlayLayout();
  setupCanvas();
  syncFuzzyToggle();
  syncNoiseTicker();
  syncFloatingFloorTicker();
  preloadImages().finally(render);
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("wheel", preventScroll, { passive: false });
  window.addEventListener("resize", function () {
    syncPlayLayout();
    setupCanvas();
    render();
  });
})();
