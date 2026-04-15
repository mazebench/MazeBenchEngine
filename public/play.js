(function () {
  const playData = window.__PLAY_DATA__;
  const canvas = document.getElementById("maze-canvas");

  if (!playData || !canvas) {
    return;
  }

  const TILE_SIZE = 64;
  const FUZZY_AMOUNT = 0.1;
  const NOISE_FPS = 12;
  const MOVE_DURATION_MS = 98;
  const playShell = document.querySelector(".play-shell");
  const playNav = document.querySelector(".play-nav");
  const playStage = document.querySelector(".play-stage");
  const mazeFrame = document.querySelector(".maze-frame");
  const playControls = document.querySelector(".play-controls");
  const fuzzyToggle = document.getElementById("fuzzy-toggle");

  const state = {
    width: playData.width,
    height: playData.height,
    terrain: playData.terrain,
    actors: playData.actors.map((actor) => ({
      ...actor,
      renderX: actor.x,
      renderY: actor.y
    })),
    effects: {
      fuzzyEnabled: fuzzyToggle ? fuzzyToggle.getAttribute("aria-pressed") === "true" : true
    }
  };

  const imageUrls = new Set();
  state.terrain.forEach((row) => {
    row.forEach((cell) => {
      if (cell.imageUrl) {
        imageUrls.add(cell.imageUrl);
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
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false
  });
  const fallbackCtx = gl ? null : canvas.getContext("2d");
  const imageCache = new Map();
  const initialPositions = state.actors.map((actor) => ({ x: actor.x, y: actor.y }));
  const moveHistory = [];
  let animationFrameId = null;
  let isAnimating = false;
  let queuedAction = null;
  let renderer = null;
  let noiseIntervalId = null;

  if (!sceneCtx || (!gl && !fallbackCtx)) {
    return;
  }

  const VERTEX_SHADER_SOURCE = `
    attribute vec2 a_position;
    varying vec2 v_uv;

    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const FRAGMENT_SHADER_SOURCE = `
    precision mediump float;

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
    uniform float u_time;

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

      float noisePhase = floor(u_time * 12.0);
      float grain = (
        hashNoise(floor(logicalCoord) + vec2(noisePhase * 17.0, noisePhase * 31.0)) - 0.5
      ) * u_noise;
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
        time: glContext.getUniformLocation(program, "u_time")
      }
    };
  }

  renderer = gl ? initializeRenderer(gl) : null;

  function posKey(x, y) {
    return `${x},${y}`;
  }

  function cloneActorPositions() {
    return state.actors.map((actor) => ({ x: actor.x, y: actor.y }));
  }

  function isInsideBoard(x, y) {
    return x >= 0 && x < state.width && y >= 0 && y < state.height;
  }

  function terrainAt(x, y) {
    return state.terrain[y]?.[x] || { type: "empty", label: "Empty", imageUrl: null };
  }

  function isWall(x, y) {
    return terrainAt(x, y).type === "wall";
  }

  function syncFuzzyToggle() {
    if (!fuzzyToggle) {
      return;
    }

    fuzzyToggle.classList.toggle("is-active", state.effects.fuzzyEnabled);
    fuzzyToggle.setAttribute("aria-pressed", state.effects.fuzzyEnabled ? "true" : "false");
  }

  function syncNoiseTicker() {
    if (noiseIntervalId !== null) {
      window.clearInterval(noiseIntervalId);
      noiseIntervalId = null;
    }

    if (!state.effects.fuzzyEnabled) {
      return;
    }

    noiseIntervalId = window.setInterval(function () {
      if (!isAnimating) {
        render();
      }
    }, 1000 / NOISE_FPS);
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
    if (!playShell || !playNav || !playStage || !mazeFrame) {
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
    playNav.style.width = `${controlWidth}px`;

    if (playControls) {
      playControls.style.width = `${controlWidth}px`;
    }
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

    sceneCtx.fillStyle = "#d6bd94";
    sceneCtx.fillRect(left, top, TILE_SIZE, TILE_SIZE);
    sceneCtx.strokeStyle = "rgba(0, 0, 0, 0.12)";
    sceneCtx.lineWidth = 1.5;
    sceneCtx.strokeRect(left + 0.75, top + 0.75, TILE_SIZE - 1.5, TILE_SIZE - 1.5);
  }

  function paintWallTile(x, y, cell) {
    const left = x * TILE_SIZE;
    const top = y * TILE_SIZE;
    const right = left + TILE_SIZE;
    const bottom = top + TILE_SIZE;
    const image = cell.imageUrl ? imageCache.get(cell.imageUrl) : null;
    const openTop = !isWall(x, y - 1);
    const openRight = !isWall(x + 1, y);
    const openBottom = !isWall(x, y + 1);
    const openLeft = !isWall(x - 1, y);

    paintFloorTile(x, y, { imageUrl: null });

    if (image) {
      sceneCtx.drawImage(image, left, top, TILE_SIZE, TILE_SIZE);
      return;
    }

    const radius = TILE_SIZE * 0.18;
    const radii = {
      tl: openTop && openLeft ? radius : 0,
      tr: openTop && openRight ? radius : 0,
      br: 0,
      bl: 0
    };

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

    roundRectPath(sceneCtx, left, top, TILE_SIZE, TILE_SIZE, radii);
    sceneCtx.save();
    sceneCtx.clip();
    sceneCtx.fillStyle = "#23262c";
    sceneCtx.fillRect(left, top, TILE_SIZE, TILE_SIZE);

    if (y < state.height - 1 && !isWall(x, y + 1)) {
      const shineHeight = Math.round(TILE_SIZE * 0.26);
      const shineTop = bottom - shineHeight;
      const shineBorderWidth = 3;
      const leftNeighborHasShine = x > 0 && isWall(x - 1, y) && !isWall(x - 1, y + 1);
      const rightNeighborHasShine = x < state.width - 1 && isWall(x + 1, y) && !isWall(x + 1, y + 1);
      sceneCtx.fillStyle = "#4f5560";
      sceneCtx.fillRect(left, shineTop, TILE_SIZE, shineHeight);
      sceneCtx.lineWidth = shineBorderWidth;
      sceneCtx.strokeStyle = "#000000";
      sceneCtx.beginPath();
      sceneCtx.moveTo(left, shineTop + shineBorderWidth / 2);
      sceneCtx.lineTo(right, shineTop + shineBorderWidth / 2);
      sceneCtx.stroke();
      sceneCtx.fillStyle = "#000000";
      if (!openLeft && !leftNeighborHasShine) {
        sceneCtx.fillRect(left, shineTop, shineBorderWidth, shineHeight);
      }
      if (!openRight && !rightNeighborHasShine) {
        sceneCtx.fillRect(right - shineBorderWidth, shineTop, shineBorderWidth, shineHeight);
      }
    }
    sceneCtx.restore();

    sceneCtx.lineWidth = 3;
    sceneCtx.strokeStyle = "#000000";
    sceneCtx.beginPath();

    if (openTop) {
      sceneCtx.moveTo(left + radii.tl, top);
      sceneCtx.lineTo(right - radii.tr, top);
    }

    if (openRight) {
      sceneCtx.moveTo(right, top + radii.tr);
      sceneCtx.lineTo(right, bottom - radii.br);
    }

    if (openBottom) {
      sceneCtx.moveTo(right - radii.br, bottom);
      sceneCtx.lineTo(left + radii.bl, bottom);
    }

    if (openLeft) {
      sceneCtx.moveTo(left, bottom - radii.bl);
      sceneCtx.lineTo(left, top + radii.tl);
    }

    if (radii.tl > 0) {
      sceneCtx.moveTo(left + radii.tl, top);
      sceneCtx.quadraticCurveTo(left, top, left, top + radii.tl);
    }

    if (radii.tr > 0) {
      sceneCtx.moveTo(right - radii.tr, top);
      sceneCtx.quadraticCurveTo(right, top, right, top + radii.tr);
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

  function paintTerrain() {
    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        const cell = terrainAt(x, y);

        if (cell.type === "wall") {
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
        const cell = terrainAt(x, y);
        if (cell.type === "wall") {
          paintWallTile(x, y, cell);
        }
      }
    }
  }

  function paintActor(actor) {
    const left = actor.renderX * TILE_SIZE;
    const top = actor.renderY * TILE_SIZE;
    const image = actor.imageUrl ? imageCache.get(actor.imageUrl) : null;

    if (image) {
      sceneCtx.drawImage(image, left, top, TILE_SIZE, TILE_SIZE);
      return;
    }

    if (actor.type === "player") {
      sceneCtx.fillStyle = "#5aa95c";
      sceneCtx.beginPath();
      sceneCtx.arc(left + TILE_SIZE / 2, top + TILE_SIZE / 2, TILE_SIZE * 0.338, 0, Math.PI * 2);
      sceneCtx.fill();
      sceneCtx.lineWidth = 3;
      sceneCtx.strokeStyle = "#000000";
      sceneCtx.stroke();
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
    if (!gl || !renderer) {
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
    gl.uniform1f(renderer.uniforms.time, performance.now() * 0.001);
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
    sceneCtx.clearRect(0, 0, boardRect.width, boardRect.height);
    paintTerrain();
    state.actors.forEach(paintActor);
    const settings = getEffectSettings();

    if (!renderWithShader(sceneCanvas, settings)) {
      renderFallback(sceneCanvas);
    }
  }

  function canMoveInto(x, y, occupied) {
    if (!isInsideBoard(x, y)) {
      return false;
    }

    if (isWall(x, y)) {
      return false;
    }

    return !occupied.has(posKey(x, y));
  }

  function easeInOutQuad(progress) {
    if (progress < 0.5) {
      return 2 * progress * progress;
    }

    return 1 - Math.pow(-2 * progress + 2, 2) / 2;
  }

  function finishAnimation(moves) {
    moves.forEach(({ actor, toX, toY }) => {
      actor.renderX = toX;
      actor.renderY = toY;
    });

    isAnimating = false;
    animationFrameId = null;
    render();

    if (queuedAction) {
      const nextAction = queuedAction;
      queuedAction = null;
      runAction(nextAction);
    }
  }

  function animateMoves(moves) {
    if (moves.length === 0) {
      return;
    }

    isAnimating = true;
    const startTime = performance.now();

    function step(now) {
      const progress = Math.min(1, (now - startTime) / MOVE_DURATION_MS);
      const eased = easeInOutQuad(progress);

      moves.forEach(({ actor, fromX, fromY, toX, toY }) => {
        actor.renderX = fromX + (toX - fromX) * eased;
        actor.renderY = fromY + (toY - fromY) * eased;
      });

      render();

      if (progress < 1) {
        animationFrameId = window.requestAnimationFrame(step);
        return;
      }

      finishAnimation(moves);
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
      actor.x = target.x;
      actor.y = target.y;

      if (fromX === target.x && fromY === target.y) {
        actor.renderX = target.x;
        actor.renderY = target.y;
        return;
      }

      moves.push({
        actor,
        fromX,
        fromY,
        toX: target.x,
        toY: target.y
      });
    });

    return moves;
  }

  function movePlayers(dx, dy) {
    if (isAnimating) {
      queuedAction = { type: "move", dx, dy };
      return;
    }

    const players = state.actors.filter((actor) => actor.type === "player");
    const occupied = new Set(state.actors.map((actor) => posKey(actor.x, actor.y)));
    const orderedPlayers = players.slice().sort(sortActorsForMove(dx, dy));
    const previousPositions = cloneActorPositions();
    const moves = [];

    orderedPlayers.forEach((player) => {
      const fromX = player.x;
      const fromY = player.y;
      occupied.delete(posKey(player.x, player.y));

      const nextX = player.x + dx;
      const nextY = player.y + dy;

      if (canMoveInto(nextX, nextY, occupied)) {
        player.x = nextX;
        player.y = nextY;
        moves.push({
          actor: player,
          fromX,
          fromY,
          toX: nextX,
          toY: nextY
        });
      }

      occupied.add(posKey(player.x, player.y));
    });

    if (moves.length > 0) {
      moveHistory.push(previousPositions);
      animateMoves(moves);
    }
  }

  function undoMove() {
    if (isAnimating) {
      queuedAction = { type: "undo" };
      return;
    }

    const previousPositions = moveHistory.pop();

    if (!previousPositions) {
      return;
    }

    const moves = buildMovesToPositions(previousPositions);

    if (moves.length > 0) {
      animateMoves(moves);
      return;
    }

    render();
  }

  function resetPositions() {
    if (isAnimating) {
      queuedAction = { type: "reset" };
      return;
    }

    moveHistory.length = 0;
    const moves = buildMovesToPositions(initialPositions);

    if (moves.length > 0) {
      animateMoves(moves);
      return;
    }

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
  preloadImages().finally(render);
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("wheel", preventScroll, { passive: false });
  window.addEventListener("resize", function () {
    syncPlayLayout();
    setupCanvas();
    render();
  });
})();
