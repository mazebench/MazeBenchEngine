(function () {
  const playData = window.__PLAY_DATA__;
  const canvas = document.getElementById("maze-canvas");
  const modules = window.PlayModules || {};

  if (
    !playData ||
    !canvas ||
    typeof modules.createPlayCore !== "function" ||
    typeof modules.registerRenderFunctions !== "function"
  ) {
    return;
  }

  const app = modules.createPlayCore({
    playData,
    canvas,
    playShell: document.querySelector(".play-shell"),
    playHeader: document.querySelector(".play-header"),
    playStage: document.querySelector(".play-stage"),
    mazeFrame: document.querySelector(".maze-frame"),
    fuzzyToggle: null,
    edgeToggle: null,
    cameraModeToggle: null,
    resetProgressButton: null,
    enableCameraControls: false
  });

  if (!app) {
    return;
  }

  modules.registerRenderFunctions(app);

  const camera = {
    yaw: 0,
    tilt: Math.atan(1 / 5),
    zoom: 1
  };
  const flight = {
    frameId: 0,
    lastMs: 0,
    lastPrefetchLevelId: "",
    lastMinimapLevelId: "",
    lastStatsHudMs: 0,
    forwardEnabled: false,
    diagnosticsVisible: false,
    manualSpeedMultiplier: 8,
    speedRoomsPerSecond: 0.32
  };
  const roomSize = {
    width: Math.max(1, Number(playData.width) || 16),
    height: Math.max(1, Number(playData.height) || 16)
  };
  const worldColumns = Array.isArray(playData.worldColumns) ? playData.worldColumns : [];
  const worldRows = Array.isArray(playData.worldRows) ? playData.worldRows : [];
  const rotateStep = Math.PI / 24;
  const tiltStep = Math.PI / 72;
  const minTilt = Math.PI * 0.02;
  const maxTilt = Math.PI * 0.42;
  const zoomStep = 1.18;
  const minZoom = 0.55;
  const maxZoom = 10;
  const selectionCameraTilt = Math.PI / 3;
  const selectionCameraZoom = 3;
  const cameraHoldRampMs = 200;
  const cameraEaseSeconds = 0.12;
  const cameraMaxRates = {
    yaw: rotateStep / 0.055,
    tilt: tiltStep / 0.055,
    zoom: Math.log(zoomStep) / 0.055
  };
  const cameraVelocity = {
    yaw: 0,
    tilt: 0,
    zoom: 0
  };
  const flightVelocity = {
    xRoomsPerSecond: 0,
    zRoomsPerSecond: 0
  };
  const heldCameraControls = new Map();
  const heldFlightControls = new Map();
  app.flyoverRoomFadeDurationMs = 900;
  app.flyoverRoomFadeIns = new Map();
  app.flyoverDepartingViews = [];
  app.flyoverCameraOffsetX = 0;
  app.flyoverCameraOffsetZ = 0;
  app.flyoverRoomTileWidth = roomSize.width;
  app.flyoverRoomTileHeight = roomSize.height;
  app.deferNeighborLoadRenders = true;
  app.preloadQueuedNeighborAssets = true;
  app.horizontalNeighborLoadConcurrency = 12;
  app.flyoverWholeWorld = true;
  app.flyoverWholeWorldReady = false;
  app.flyoverFocusTransitionEasesScale = true;
  app.flyoverSceneVersion = 0;
  app.flyoverSelectedLevelId = "";
  app.flyoverFocusedLevelId = "";
  app.flyoverRenderableLevelIds = new Set([app.currentLevelId]);
  app.flyoverPendingRenderableLevelIds = new Set();
  app.flyoverRenderableFlushId = 0;
  app.homeVectorTheme = true;
  app.vectorGlowAmount = 1;
  app.worldViewUniformBrightness = true;
  let selectionPanel = null;
  let selectionPreviousForwardEnabled = null;
  let selectionPreviousCameraTilt = null;
  let selectionPreviousCameraZoom = null;
  const selectionOrbit = {
    pausedUntilMs: 0,
    radiansPerSecond: (Math.PI * 2) / 20
  };
  let vectorThemeFrameId = 0;
  let edgeModeEnabled = true;
  let titleEnabled = false;
  let presentationModeEnabled = false;

  function syncEdgeModeToggle() {
    const button = document.getElementById("flyover-edge-toggle");
    if (!button) return;
    button.setAttribute("aria-pressed", edgeModeEnabled ? "true" : "false");
    button.title = edgeModeEnabled
      ? "Use full color without fuzz"
      : "Use blue glow and fuzzy overlay";
  }

  function setFlyoverEdgeMode(enabled, options = {}) {
    const nextEnabled = enabled === true;
    const durationMs = Math.max(0, Number(options.durationMs ?? 520));
    const from = Math.max(0, Math.min(1, Number(app.vectorGlowAmount) || 0));
    const to = nextEnabled ? 1 : 0;
    edgeModeEnabled = nextEnabled;
    syncEdgeModeToggle();
    app.state.effects.fuzzyEnabled = nextEnabled;
    app.syncNoiseTicker();
    if (vectorThemeFrameId) window.cancelAnimationFrame(vectorThemeFrameId);
    vectorThemeFrameId = 0;
    app.homeVectorTheme = true;
    if (nextEnabled) app.worldViewUniformBrightness = true;
    const startedAt = performance.now();

    const finish = () => {
      app.vectorGlowAmount = to;
      app.homeVectorTheme = nextEnabled;
      app.worldViewUniformBrightness = nextEnabled;
      app.threeRenderer?.invalidateSceneCache?.();
      app.render();
    };
    if (durationMs === 0 || Math.abs(to - from) < 0.001) {
      finish();
      return;
    }

    const step = (now) => {
      const progress = Math.max(0, Math.min(1, (now - startedAt) / durationMs));
      const eased = 0.5 - Math.cos(Math.PI * progress) / 2;
      app.vectorGlowAmount = from + (to - from) * eased;
      app.threeRenderer?.invalidateSceneCache?.();
      app.render(now);
      if (progress < 1) {
        vectorThemeFrameId = window.requestAnimationFrame(step);
      } else {
        vectorThemeFrameId = 0;
        finish();
      }
    };
    vectorThemeFrameId = window.requestAnimationFrame(step);
  }

  function syncTitleToggle() {
    const button = document.getElementById("flyover-title-toggle");
    const title = document.getElementById("flyover-social-title");
    button?.setAttribute("aria-pressed", titleEnabled ? "true" : "false");
    if (button) {
      button.title = titleEnabled ? "Hide Maze Bench title" : "Show Maze Bench title";
    }
    if (title) {
      title.hidden = !titleEnabled;
      title.setAttribute("aria-hidden", titleEnabled ? "false" : "true");
    }
  }

  function setFlyoverTitle(enabled) {
    titleEnabled = enabled === true;
    syncTitleToggle();
    setFlyoverPresentationMode(titleEnabled);
  }

  function syncPresentationLayout() {
    window.requestAnimationFrame(() => {
      app.syncPlayLayout();
      app.setupCanvas();
      app.syncCameraTarget(true);
      app.threeRenderer?.invalidateSceneCache?.();
      app.render();
    });
  }

  function setFlyoverPresentationMode(enabled) {
    const nextEnabled = enabled === true;
    if (presentationModeEnabled === nextEnabled) return;
    presentationModeEnabled = nextEnabled;
    document.body.classList.toggle("is-flyover-presentation", presentationModeEnabled);
    syncPresentationLayout();
  }

  function revealLoadedFlyoverWorld() {
    const gameRoot = document.getElementById("game-root");
    const frame = document.querySelector(".flyover-frame");
    const loading = document.querySelector(".flyover-loading");
    gameRoot?.classList.remove("is-loading");
    gameRoot?.classList.add("is-flyover-revealing");
    frame?.classList.remove("is-loading");
    loading?.classList.add("is-hidden");
    window.setTimeout(() => loading?.remove(), 280);

    const completeReveal = () => {
      gameRoot?.classList.remove("is-flyover-revealing");
      setFlyoverEdgeMode(false, { durationMs: 950 });
    };
    if (typeof app.threeRenderer?.beginHomeEdgeReveal === "function") {
      app.threeRenderer.beginHomeEdgeReveal({ onComplete: completeReveal });
    } else {
      completeReveal();
    }
  }

  function currentWorldIndex() {
    return app.parseWorldLevelId?.(app.currentLevelId || playData.levelId) || null;
  }

  function rebuildFlyoverWorldEntries() {
    const current = currentWorldIndex();
    const entries = [];

    if (!current || worldColumns.length === 0 || worldRows.length === 0) {
      return entries;
    }

    worldRows.forEach((row, rowIndex) => {
      worldColumns.forEach((column, columnIndex) => {
        const levelId = app.worldLevelId?.(columnIndex, rowIndex);

        if (!levelId) {
          return;
        }

        entries.push({
          column,
          row,
          columnIndex,
          rowIndex,
          dx: columnIndex - current.columnIndex,
          dy: rowIndex - current.rowIndex,
          levelId
        });
      });
    });

    return entries;
  }

  function syncFlyoverWorldMetadata() {
    const entries = rebuildFlyoverWorldEntries();
    const roomWorldWidth = roomSize.width * app.TILE_SIZE;
    const roomWorldHeight = roomSize.height * app.TILE_SIZE;
    const current = currentWorldIndex();
    const fallbackBounds = {
      minX: 0,
      maxX: roomWorldWidth,
      minZ: 0,
      maxZ: roomWorldHeight
    };

    app.flyoverWorldEntries = entries;
    app.flyoverWorldLevelIds = new Set(entries.map((entry) => entry.levelId));
    app.flyoverWorldTotalLevelCount = entries.length || 1;
    app.flyoverWorldLoadedLevelCount = 1;
    app.flyoverWorldRoomWidth = roomWorldWidth;
    app.flyoverWorldRoomHeight = roomWorldHeight;
    app.flyoverWorldColumns = worldColumns.length;
    app.flyoverWorldRows = worldRows.length;
    app.flyoverWorldBounds = current
      ? {
          minX: -current.columnIndex * roomWorldWidth,
          maxX: (worldColumns.length - current.columnIndex) * roomWorldWidth,
          minZ: -current.rowIndex * roomWorldHeight,
          maxZ: (worldRows.length - current.rowIndex) * roomWorldHeight
        }
      : fallbackBounds;
  }

  syncFlyoverWorldMetadata();

  function applyCamera(animate = true, durationMs = animate ? 180 : 0) {
    app.threeRenderer?.setDebugCameraView?.({
      animate,
      durationMs,
      mode: "perspective",
      tilt: camera.tilt,
      yaw: camera.yaw,
      zoom: camera.zoom
    });
  }

  function shortestYawDelta(from, to) {
    return Math.atan2(Math.sin(to - from), Math.cos(to - from));
  }

  function nudgeCameraControl(control, stepScale = 1) {
    if (control === "rotate-left") {
      camera.yaw -= rotateStep * stepScale;
      return true;
    }

    if (control === "rotate-right") {
      camera.yaw += rotateStep * stepScale;
      return true;
    }

    if (control === "tilt-up") {
      if (isSelectionCameraControlLocked(control)) {
        return false;
      }

      camera.tilt = Math.max(minTilt, camera.tilt - tiltStep * stepScale);
      return true;
    }

    if (control === "tilt-down") {
      if (isSelectionCameraControlLocked(control)) {
        return false;
      }

      camera.tilt = Math.min(maxTilt, camera.tilt + tiltStep * stepScale);
      return true;
    }

    if (control === "zoom-in") {
      if (isSelectionCameraControlLocked(control)) {
        return false;
      }

      camera.zoom = Math.min(maxZoom, camera.zoom * Math.pow(zoomStep, stepScale));
      return true;
    }

    if (control === "zoom-out") {
      if (isSelectionCameraControlLocked(control)) {
        return false;
      }

      camera.zoom = Math.max(minZoom, camera.zoom / Math.pow(zoomStep, stepScale));
      return true;
    }

    return false;
  }

  function applyHeldCameraControls(elapsedSeconds, now) {
    if (isSelectionCameraLocked()) {
      stopHeldSelectionFixedControls();
      camera.tilt = selectionCameraTilt;
    }

    const targetVelocity = {
      yaw: 0,
      tilt: 0,
      zoom: 0
    };

    heldCameraControls.forEach((startedAt, control) => {
      const holdMs = Math.max(0, now - startedAt);
      const ramp = Math.min(1, holdMs / cameraHoldRampMs);
      const easedRamp = ramp * ramp * (3 - 2 * ramp);

      if (control === "rotate-left") {
        targetVelocity.yaw -= cameraMaxRates.yaw * easedRamp;
      } else if (control === "rotate-right") {
        targetVelocity.yaw += cameraMaxRates.yaw * easedRamp;
      } else if (control === "tilt-up") {
        targetVelocity.tilt -= cameraMaxRates.tilt * easedRamp;
      } else if (control === "tilt-down") {
        targetVelocity.tilt += cameraMaxRates.tilt * easedRamp;
      } else if (control === "zoom-in") {
        targetVelocity.zoom += cameraMaxRates.zoom * easedRamp;
      } else if (control === "zoom-out") {
        targetVelocity.zoom -= cameraMaxRates.zoom * easedRamp;
      }
    });

    const blend = 1 - Math.exp(-elapsedSeconds / cameraEaseSeconds);

    cameraVelocity.yaw += (targetVelocity.yaw - cameraVelocity.yaw) * blend;
    cameraVelocity.tilt += (targetVelocity.tilt - cameraVelocity.tilt) * blend;
    cameraVelocity.zoom += (targetVelocity.zoom - cameraVelocity.zoom) * blend;

    if (heldCameraControls.size === 0) {
      if (Math.abs(cameraVelocity.yaw) < 0.002) {
        cameraVelocity.yaw = 0;
      }

      if (Math.abs(cameraVelocity.tilt) < 0.002) {
        cameraVelocity.tilt = 0;
      }

      if (Math.abs(cameraVelocity.zoom) < 0.002) {
        cameraVelocity.zoom = 0;
      }
    }

    const changed =
      Math.abs(cameraVelocity.yaw) > 0 ||
      Math.abs(cameraVelocity.tilt) > 0 ||
      Math.abs(cameraVelocity.zoom) > 0;

    if (changed) {
      camera.yaw += cameraVelocity.yaw * elapsedSeconds;
      camera.tilt = Math.max(minTilt, Math.min(maxTilt, camera.tilt + cameraVelocity.tilt * elapsedSeconds));
      camera.zoom = Math.max(
        minZoom,
        Math.min(maxZoom, camera.zoom * Math.exp(cameraVelocity.zoom * elapsedSeconds))
      );
    }

    if (changed) {
      applyCamera(false);
    }

    return changed;
  }

  function applyHeldFlightControls(elapsedSeconds, now) {
    const targetVelocity = {
      xRoomsPerSecond: 0,
      zRoomsPerSecond: 0
    };
    const manualSpeedRoomsPerSecond =
      flight.speedRoomsPerSecond * flight.manualSpeedMultiplier;

    if (heldFlightControls.size > 0) {
      heldFlightControls.forEach((startedAt, control) => {
        const holdMs = Math.max(0, now - startedAt);
        const ramp = Math.min(1, holdMs / cameraHoldRampMs);
        const easedRamp = ramp * ramp * (3 - 2 * ramp);

        if (control === "forward") {
          targetVelocity.zRoomsPerSecond += manualSpeedRoomsPerSecond * easedRamp;
        } else if (control === "backward") {
          targetVelocity.zRoomsPerSecond -= manualSpeedRoomsPerSecond * easedRamp;
        } else if (control === "left") {
          targetVelocity.xRoomsPerSecond -= manualSpeedRoomsPerSecond * easedRamp;
        } else if (control === "right") {
          targetVelocity.xRoomsPerSecond += manualSpeedRoomsPerSecond * easedRamp;
        }
      });

      targetVelocity.xRoomsPerSecond = Math.max(
        -manualSpeedRoomsPerSecond,
        Math.min(manualSpeedRoomsPerSecond, targetVelocity.xRoomsPerSecond)
      );
      targetVelocity.zRoomsPerSecond = Math.max(
        -manualSpeedRoomsPerSecond,
        Math.min(manualSpeedRoomsPerSecond, targetVelocity.zRoomsPerSecond)
      );
    } else if (flight.forwardEnabled) {
      targetVelocity.zRoomsPerSecond = flight.speedRoomsPerSecond;
    }

    const blend = 1 - Math.exp(-elapsedSeconds / cameraEaseSeconds);
    const yawSin = Math.sin(camera.yaw);
    const yawCos = Math.cos(camera.yaw);

    flightVelocity.xRoomsPerSecond +=
      (targetVelocity.xRoomsPerSecond - flightVelocity.xRoomsPerSecond) * blend;
    flightVelocity.zRoomsPerSecond +=
      (targetVelocity.zRoomsPerSecond - flightVelocity.zRoomsPerSecond) * blend;

    if (
      targetVelocity.xRoomsPerSecond === 0 &&
      Math.abs(flightVelocity.xRoomsPerSecond) < 0.002
    ) {
      flightVelocity.xRoomsPerSecond = 0;
    }

    if (
      targetVelocity.zRoomsPerSecond === 0 &&
      Math.abs(flightVelocity.zRoomsPerSecond) < 0.002
    ) {
      flightVelocity.zRoomsPerSecond = 0;
    }

    return {
      x: (yawCos * flightVelocity.xRoomsPerSecond - yawSin * flightVelocity.zRoomsPerSecond) *
        elapsedSeconds,
      z: (-yawSin * flightVelocity.xRoomsPerSecond - yawCos * flightVelocity.zRoomsPerSecond) *
        elapsedSeconds
    };
  }

  function bindHoldButton(id, control) {
    const button = document.getElementById(id);

    if (!button) {
      return;
    }

    let suppressNextClick = false;

    function stop() {
      heldCameraControls.delete(control);
    }

    function step(animate = true, scale = 1) {
      const changed = nudgeCameraControl(control, scale);

      if (!changed) {
        return;
      }

      applyCamera(animate);
      app.render();
    }

    button.addEventListener("click", () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }

      step(true);
    });
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      if (isSelectionCameraControlLocked(control)) {
        event.preventDefault();
        stop();
        return;
      }

      suppressNextClick = true;
      heldCameraControls.set(control, performance.now());
    });
    button.addEventListener("pointerup", stop);
    button.addEventListener("pointercancel", stop);
    button.addEventListener("pointerleave", stop);
  }

  function nudgeFlightControl(control, distanceRooms = 0.14) {
    const local = {
      forward: { x: 0, z: distanceRooms },
      backward: { x: 0, z: -distanceRooms },
      left: { x: -distanceRooms, z: 0 },
      right: { x: distanceRooms, z: 0 }
    }[control];
    if (!local) return false;
    const yawSin = Math.sin(camera.yaw);
    const yawCos = Math.cos(camera.yaw);
    const worldX = yawCos * local.x - yawSin * local.z;
    const worldZ = -yawSin * local.x - yawCos * local.z;
    app.flyoverCameraOffsetX += worldX * roomSize.width * app.TILE_SIZE;
    app.flyoverCameraOffsetZ += worldZ * roomSize.height * app.TILE_SIZE;
    tryRecenterFlyover();
    app.render();
    return true;
  }

  function bindFlightHoldButton(id, control) {
    const button = document.getElementById(id);
    if (!button) return;
    let suppressNextClick = false;
    const stop = () => heldFlightControls.delete(control);

    button.addEventListener("click", () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      nudgeFlightControl(control);
    });
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      suppressNextClick = true;
      nudgeFlightControl(control, 0.08);
      heldFlightControls.set(control, performance.now());
    });
    button.addEventListener("pointerup", stop);
    button.addEventListener("pointercancel", stop);
    button.addEventListener("pointerleave", stop);
  }

  function bindFlyoverLevelSelection() {
    if (!app.mazeFrame) {
      return;
    }

    let pointerStart = null;

    app.mazeFrame.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        pointerStart = null;
        return;
      }

      pointerStart = {
        x: event.clientX,
        y: event.clientY
      };
    });

    app.mazeFrame.addEventListener("pointerup", (event) => {
      if (event.button !== 0 || !pointerStart) {
        pointerStart = null;
        return;
      }

      const dx = event.clientX - pointerStart.x;
      const dy = event.clientY - pointerStart.y;
      pointerStart = null;

      if (dx * dx + dy * dy > 14 * 14) {
        return;
      }

      const targetElement = app.threeRenderer?.threeCanvas || app.mazeFrame;
      const pick = app.threeRenderer?.pickFlyoverLevel?.(
        event.clientX,
        event.clientY,
        targetElement
      );

      if (pick?.levelId) {
        event.preventDefault();
        selectFlyoverLevel(pick);
        return;
      }

      if (app.flyoverSelectedLevelId) {
        clearFlyoverSelection();
      }
    });
  }

  function normalizeIndex(value, length) {
    return ((value % length) + length) % length;
  }

  function renderMinimap() {
    const target = document.getElementById("flyover-minimap");
    const rules = modules.PlayRules;
    const columns = Array.isArray(playData.worldColumns) ? playData.worldColumns : [];
    const rows = Array.isArray(playData.worldRows) ? playData.worldRows : [];

    if (!target || !rules || columns.length === 0 || rows.length === 0) {
      return;
    }

    const current = rules.parseWorldLevelId(app.currentLevelId || playData.levelId, columns, rows);

    if (!current) {
      return;
    }

    const radius = Math.max(1, Math.min(6, Number(playData.flyoverRadius) || 3));
    target.style.setProperty("--flyover-columns", columns.length);
    target.style.setProperty("--flyover-rows", rows.length);
    target.innerHTML = "";

    rows.forEach((row, rowIndex) => {
      columns.forEach((column, columnIndex) => {
        const levelId = rules.worldLevelId(columnIndex, rowIndex, columns, rows);
        const cell = document.createElement("a");
        const columnDistance = Math.abs(columnIndex - current.columnIndex);
        const rowDistance = Math.abs(rowIndex - current.rowIndex);
        const visible =
          columnDistance <= radius &&
          rowDistance <= radius &&
          (columnDistance !== 0 || rowDistance !== 0);
        const active =
          normalizeIndex(columnIndex, columns.length) === current.columnIndex &&
          normalizeIndex(rowIndex, rows.length) === current.rowIndex;

        cell.className = "flyover-minimap__cell";
        cell.href = `/flyover/${encodeURIComponent(playData.gameId)}/${encodeURIComponent(levelId)}`;
        cell.title = `Level ${column}x${row}`;
        cell.setAttribute("aria-label", `Fly to level ${column}x${row}`);
        cell.dataset.visible = visible ? "true" : "false";
        cell.dataset.active = active ? "true" : "false";
        target.appendChild(cell);
      });
    });
  }

  function formatStatNumber(value) {
    const number = Number(value) || 0;

    return number.toLocaleString("en-US");
  }

  function formatFlyoverLevelName(levelId, fallback = "") {
    if (fallback) {
      return fallback;
    }

    const parsed = app.parseWorldLevelId?.(levelId);
    const column = parsed ? app.worldColumns?.[parsed.columnIndex] : "";
    const row = parsed ? app.worldRows?.[parsed.rowIndex] : "";

    if (column && row) {
      return `Level ${column}x${row}`;
    }

    return String(levelId || "Level");
  }

  function ensureSelectionPanel() {
    if (selectionPanel?.isConnected) {
      return selectionPanel;
    }

    const stage = document.querySelector(".flyover-stage");

    if (!stage) {
      return null;
    }

    selectionPanel = document.createElement("aside");
    selectionPanel.className = "flyover-selection-panel";
    selectionPanel.setAttribute("aria-live", "polite");

    const title = document.createElement("h2");
    title.className = "flyover-selection-panel__title";
    title.dataset.flyoverSelectionTitle = "true";

    const actions = document.createElement("div");
    actions.className = "flyover-selection-panel__actions";

    const playButton = document.createElement("button");
    playButton.className = "flyover-selection-panel__button flyover-selection-panel__button--play";
    playButton.type = "button";
    playButton.textContent = "Play";
    playButton.dataset.flyoverSelectionPlay = "true";

    const exitButton = document.createElement("button");
    exitButton.className = "flyover-selection-panel__button";
    exitButton.type = "button";
    exitButton.textContent = "Exit";
    exitButton.dataset.flyoverSelectionExit = "true";

    actions.append(playButton, exitButton);
    selectionPanel.append(title, actions);
    selectionPanel.addEventListener("pointerdown", (event) => event.stopPropagation());
    selectionPanel.addEventListener("click", (event) => event.stopPropagation());
    stage.appendChild(selectionPanel);
    return selectionPanel;
  }

  function updateSelectionPanel(pick) {
    const panel = ensureSelectionPanel();

    if (!panel) {
      return;
    }

    const levelId = pick.levelId;
    const levelName = formatFlyoverLevelName(levelId, pick.levelLabel);
    const title = panel.querySelector("[data-flyover-selection-title]");
    const playButton = panel.querySelector("[data-flyover-selection-play]");
    const exitButton = panel.querySelector("[data-flyover-selection-exit]");

    panel.dataset.levelId = levelId;

    if (title) {
      title.textContent = levelName;
    }

    if (playButton) {
      playButton.onclick = () => {
        window.location.href = `/play/${encodeURIComponent(playData.gameId)}/${encodeURIComponent(levelId)}`;
      };
    }

    if (exitButton) {
      exitButton.onclick = () => clearFlyoverSelection();
    }
  }

  function startFocusTransition(toLevelId, durationMs = 900, options = {}) {
    app.flyoverFocusTransition = {
      fromLevelId: app.flyoverFocusedLevelId || "",
      toLevelId: toLevelId || "",
      startMs: performance.now(),
      durationMs
    };

    if (Number.isFinite(options.fromZoom)) {
      app.flyoverFocusTransition.fromZoom = options.fromZoom;
    }

    if (Number.isFinite(options.toZoom)) {
      app.flyoverFocusTransition.toZoom = options.toZoom;
    }
  }

  function isZoomCameraControl(control) {
    return control === "zoom-in" || control === "zoom-out";
  }

  function isTiltCameraControl(control) {
    return control === "tilt-up" || control === "tilt-down";
  }

  function isSelectionCameraLocked() {
    return Boolean(app.flyoverSelectedLevelId);
  }

  function isSelectionCameraControlLocked(control) {
    return isSelectionCameraLocked() && (isZoomCameraControl(control) || isTiltCameraControl(control));
  }

  function stopHeldSelectionFixedControls() {
    heldCameraControls.delete("tilt-up");
    heldCameraControls.delete("tilt-down");
    heldCameraControls.delete("zoom-in");
    heldCameraControls.delete("zoom-out");
    cameraVelocity.tilt = 0;
    cameraVelocity.zoom = 0;
  }

  function clearFlyoverSelection(options = {}) {
    if (!app.flyoverSelectedLevelId && !selectionPanel) {
      return;
    }

    const targetTilt =
      selectionPreviousCameraTilt !== null
        ? Math.max(minTilt, Math.min(maxTilt, selectionPreviousCameraTilt))
        : camera.tilt;
    const targetZoom =
      selectionPreviousCameraZoom !== null
        ? Math.max(minZoom, Math.min(maxZoom, selectionPreviousCameraZoom))
        : camera.zoom;

    startFocusTransition("", 620, {
      fromZoom: camera.zoom,
      toZoom: targetZoom
    });
    app.flyoverSelectedLevelId = "";
    app.flyoverFocusedLevelId = "";
    selectionOrbit.pausedUntilMs = 0;
    selectionPanel?.remove();
    selectionPanel = null;

    if (selectionPreviousForwardEnabled !== null) {
      flight.forwardEnabled = selectionPreviousForwardEnabled;
      selectionPreviousForwardEnabled = null;
    }

    if (selectionPreviousCameraTilt !== null) {
      camera.tilt = targetTilt;
      selectionPreviousCameraTilt = null;
    }

    if (selectionPreviousCameraZoom !== null) {
      camera.zoom = targetZoom;
      selectionPreviousCameraZoom = null;
    }

    if (options.animate !== false) {
      applyCamera(true, 620);
    }

    app.render();
  }

  function selectFlyoverLevel(pick) {
    if (!pick?.levelId) {
      return;
    }

    const wasSelectionActive = Boolean(app.flyoverSelectedLevelId);

    if (selectionPreviousForwardEnabled === null) {
      selectionPreviousForwardEnabled = flight.forwardEnabled;
    }

    if (selectionPreviousCameraZoom === null) {
      selectionPreviousCameraZoom = camera.zoom;
    }

    if (selectionPreviousCameraTilt === null) {
      selectionPreviousCameraTilt = camera.tilt;
    }

    flight.forwardEnabled = false;
    flightVelocity.xRoomsPerSecond = 0;
    flightVelocity.zRoomsPerSecond = 0;
    heldFlightControls.clear();
    stopHeldSelectionFixedControls();
    app.flyoverSelectedLevelId = pick.levelId;
    startFocusTransition(pick.levelId, 920, {
      fromZoom: wasSelectionActive ? camera.zoom : selectionPreviousCameraZoom ?? camera.zoom,
      toZoom: selectionCameraZoom
    });
    app.flyoverFocusedLevelId = pick.levelId;
    selectionOrbit.pausedUntilMs = performance.now() + 920;
    camera.tilt = selectionCameraTilt;
    camera.zoom = selectionCameraZoom;
    updateSelectionPanel(pick);
    applyCamera(true, 920);
    app.render();
  }

  function updateFlyoverStatsHud(now = performance.now(), force = false) {
    if (!flight.diagnosticsVisible) {
      document.getElementById("flyover-stats")?.remove();
      return;
    }

    if (!force && now - flight.lastStatsHudMs < 400) {
      return;
    }

    const hud = document.querySelector(".flyover-hud");

    if (!hud) {
      return;
    }

    let target = document.getElementById("flyover-stats");

    if (!target) {
      target = document.createElement("div");
      target.id = "flyover-stats";
      target.className = "flyover-stats";
      target.setAttribute("aria-live", "polite");
      hud.appendChild(target);
    }

    flight.lastStatsHudMs = now;
    const stats = app.threeRenderStats || {};
    let frameStats = null;

    try {
      frameStats = app.canvas?.dataset?.frameStats
        ? JSON.parse(app.canvas.dataset.frameStats)
        : null;
    } catch {
      frameStats = null;
    }

    const fps = frameStats?.averageFps ? Math.round(frameStats.averageFps) : 0;
    target.textContent = [
      `${formatStatNumber(app.flyoverWorldLoadedLevelCount || 1)}/${formatStatNumber(app.flyoverWorldTotalLevelCount || 1)} rooms`,
      `${formatStatNumber(stats.triangles)} tris`,
      `${formatStatNumber(stats.lines)} lines`,
      `${formatStatNumber(stats.calls)} calls`,
      fps > 0 ? `${fps} fps` : ""
    ].filter(Boolean).join(" | ");
  }

  function visibleFlyoverRadius() {
    return Math.max(1, Math.min(6, Number(app.flyoverRadius || playData.flyoverRadius) || 3));
  }

  function flyoverLevelIdWithinRadius(levelId, centerLevelId, radius = visibleFlyoverRadius()) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (app.adjacentWorldLevelId?.(centerLevelId, dx, dy) === levelId) {
          return true;
        }
      }
    }

    return false;
  }

  function releasePendingRenderableFlyoverLevels() {
    app.flyoverRenderableFlushId = 0;

    if (!(app.flyoverPendingRenderableLevelIds instanceof Set)) {
      return;
    }

    const now = performance.now();
    let releasedAny = false;

    const currentCoordinates = app.parseWorldLevelId?.(app.currentLevelId);

    app.flyoverPendingRenderableLevelIds.forEach((levelId) => {
      if (!app.cachedHorizontalNeighborLevelState?.(levelId)) {
        return;
      }

      if (!app.flyoverRenderableLevelIds.has(levelId)) {
        releasedAny = true;
        app.flyoverRenderableLevelIds.add(levelId);

        if (levelId === app.currentLevelId) {
          return;
        }

        if (app.flyoverWholeWorld === true) {
          // Whole world: every room fades in, staggered outward from the
          // current room so the world reveals as a slow ripple.
          const coordinates = app.parseWorldLevelId?.(levelId);
          const distance =
            coordinates && currentCoordinates
              ? Math.max(
                  Math.abs(coordinates.columnIndex - currentCoordinates.columnIndex),
                  Math.abs(coordinates.rowIndex - currentCoordinates.rowIndex)
                )
              : 0;

          app.flyoverRoomFadeIns.set(levelId, now + Math.min(3000, distance * 130));
        } else if (flyoverLevelIdWithinRadius(levelId, app.currentLevelId)) {
          app.flyoverRoomFadeIns.set(levelId, now);
        }
      }
    });
    app.flyoverPendingRenderableLevelIds.clear();

    if (releasedAny) {
      app.flyoverSceneVersion = (Number(app.flyoverSceneVersion) || 0) + 1;
      app.threeRenderer?.invalidateSceneCache?.();
    }
  }

  function scheduleRenderableFlyoverLevel(levelId, immediate = false) {
    if (!levelId || app.flyoverRenderableLevelIds.has(levelId)) {
      return;
    }

    app.flyoverPendingRenderableLevelIds.add(levelId);

    if (immediate) {
      if (app.flyoverRenderableFlushId) {
        window.clearTimeout(app.flyoverRenderableFlushId);
      }
      releasePendingRenderableFlyoverLevels();
      return;
    }

    if (!app.flyoverRenderableFlushId) {
      app.flyoverRenderableFlushId = window.setTimeout(releasePendingRenderableFlyoverLevels, 90);
    }
  }

  function flyoverLoadPriority(dx, dy) {
    const chebyshev = Math.max(Math.abs(dx), Math.abs(dy));
    const forwardDx = -Math.sin(camera.yaw);
    const forwardDy = -Math.cos(camera.yaw);
    const forwardBias = dx * forwardDx + dy * forwardDy;

    return chebyshev * 12 - forwardBias;
  }

  function queueFlyoverLevels(extraRadius = 4) {
    if (app.flyoverWholeWorld === true && Array.isArray(app.flyoverWorldEntries)) {
      const requests = [];

      app.flyoverRenderableLevelIds.add(app.currentLevelId);
      app.flyoverWorldEntries.forEach((entry) => {
        if (entry.levelId === app.currentLevelId) {
          return;
        }

        requests.push({
          ...entry,
          priority: flyoverLoadPriority(entry.dx, entry.dy)
        });
      });

      requests
        .sort((left, right) => left.priority - right.priority)
        .forEach((request) => {
          if (app.cachedHorizontalNeighborLevelState?.(request.levelId)) {
            scheduleRenderableFlyoverLevel(request.levelId);
            return;
          }

          app.queueHorizontalNeighborLevelState?.(request.levelId, {
            priority: request.priority
          });
        });
      return;
    }

    const radius = Math.min(8, visibleFlyoverRadius() + extraRadius);
    const requests = [];

    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const levelId = app.adjacentWorldLevelId?.(app.currentLevelId, dx, dy);

        if (!levelId) {
          continue;
        }

        if (dx === 0 && dy === 0) {
          app.flyoverRenderableLevelIds.add(levelId);
          continue;
        }

        requests.push({
          dx,
          dy,
          levelId,
          priority: flyoverLoadPriority(dx, dy)
        });
      }
    }

    requests
      .sort((left, right) => left.priority - right.priority)
      .forEach((request) => {
        if (app.cachedHorizontalNeighborLevelState?.(request.levelId)) {
          scheduleRenderableFlyoverLevel(request.levelId);
          return;
        }

        app.queueHorizontalNeighborLevelState?.(request.levelId, {
          priority: request.priority
        });
      });
  }

  function updateFlyoverUrl() {
    if (!app.currentGameId || !app.currentLevelId || typeof window.history?.replaceState !== "function") {
      return;
    }

    const nextUrl = `/flyover/${encodeURIComponent(app.currentGameId)}/${encodeURIComponent(app.currentLevelId)}`;

    if (window.location.pathname !== nextUrl) {
      window.history.replaceState({ levelId: app.currentLevelId }, "", nextUrl);
    }
  }

  function updateMinimapIfNeeded() {
    if (flight.lastMinimapLevelId === app.currentLevelId) {
      return;
    }

    flight.lastMinimapLevelId = app.currentLevelId;
    renderMinimap();
  }

  function maybePrefetchFlyoverLevels() {
    if (app.flyoverWholeWorld === true) {
      if (flight.lastPrefetchLevelId !== "__whole_world__") {
        flight.lastPrefetchLevelId = "__whole_world__";
        queueFlyoverLevels(0);
      }
      return;
    }

    if (flight.lastPrefetchLevelId === app.currentLevelId) {
      return;
    }

    flight.lastPrefetchLevelId = app.currentLevelId;
    queueFlyoverLevels(4);
  }

  function visibleFlyoverLevelIds(centerLevelId = app.currentLevelId, radius = visibleFlyoverRadius()) {
    if (app.flyoverWholeWorld === true && Array.isArray(app.flyoverWorldEntries)) {
      return app.flyoverWorldEntries.map((entry) => entry.levelId);
    }

    const levelIds = [];

    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const levelId = app.adjacentWorldLevelId?.(centerLevelId, dx, dy);

        if (levelId) {
          levelIds.push(levelId);
        }
      }
    }

    return levelIds;
  }

  function flyoverWindowReady(centerLevelId = app.currentLevelId, radius = visibleFlyoverRadius()) {
    return visibleFlyoverLevelIds(centerLevelId, radius).every((levelId) => {
      if (levelId === app.currentLevelId) {
        return true;
      }

      return Boolean(app.cachedHorizontalNeighborLevelState?.(levelId));
    });
  }

  function waitForInitialFlyoverWindow(timeoutMs = 7200) {
    const startedAt = performance.now();
    // Whole world: reveal as soon as the immediate neighborhood is in and
    // let the remaining rooms stream in with staggered fade-ins, instead of
    // blocking the first frame on hundreds of level fetches.
    const preloadRadius =
      app.flyoverWholeWorld === true ? 2 : Math.min(8, visibleFlyoverRadius() + 4);
    const waitTimeoutMs = app.flyoverWholeWorld === true ? Math.max(timeoutMs, 15000) : timeoutMs;

    return new Promise((resolve) => {
      function poll() {
        if (
          flyoverWindowReady(app.currentLevelId, preloadRadius) ||
          performance.now() - startedAt >= waitTimeoutMs
        ) {
          visibleFlyoverLevelIds().forEach((levelId) => {
            if (levelId !== app.currentLevelId && app.cachedHorizontalNeighborLevelState?.(levelId)) {
              scheduleRenderableFlyoverLevel(levelId);
            }
          });
          if (app.flyoverRenderableFlushId) {
            window.clearTimeout(app.flyoverRenderableFlushId);
          }
          releasePendingRenderableFlyoverLevels();
          app.horizontalNeighborLoadConcurrency = app.flyoverWholeWorld === true ? 6 : 2;
          app.flyoverWholeWorldReady =
            app.flyoverWholeWorld === true
              ? flyoverWindowReady(app.currentLevelId, preloadRadius)
              : true;
          resolve();
          return;
        }

        window.setTimeout(poll, 50);
      }

      poll();
    });
  }

  function resetFlyoverFrameStats() {
    if (typeof app.resetFrameTimingStats === "function") {
      app.resetFrameTimingStats();
      return;
    }

    const stats = window.__PIXEL_GAME_FRAME_STATS__;

    if (!stats || !Array.isArray(stats.samples)) {
      return;
    }

    stats.samples.length = 0;
    stats.active = false;
  }

  function currentRuntimeLevelState() {
    return {
      levelId: app.currentLevelId,
      width: app.state.width,
      height: app.state.height,
      terrain: app.state.terrain,
      actors: app.state.actors
    };
  }

  app.onNeighborLevelStateLoaded = function onNeighborLevelStateLoaded(levelState) {
    const levelId = levelState?.levelId;

    if (!levelId) {
      return;
    }

    scheduleRenderableFlyoverLevel(levelId);

    if (app.flyoverWholeWorld === true) {
      app.flyoverWorldLoadedLevelCount = visibleFlyoverLevelIds().filter((loadedLevelId) => {
        if (loadedLevelId === app.currentLevelId) {
          return true;
        }

        return Boolean(app.cachedHorizontalNeighborLevelState?.(loadedLevelId));
      }).length;
      app.flyoverWholeWorldReady =
        app.flyoverWorldLoadedLevelCount >= (Number(app.flyoverWorldTotalLevelCount) || 1);
    }
  };

  app.flyoverSurroundingLevelViews = function flyoverSurroundingLevelViews() {
    if (app.flyoverWholeWorld !== true || !Array.isArray(app.flyoverWorldEntries)) {
      return null;
    }

    const roomWorldWidth = roomSize.width * app.TILE_SIZE;
    const roomWorldHeight = roomSize.height * app.TILE_SIZE;
    const views = [];

    app.flyoverWorldEntries.forEach((entry) => {
      if (entry.levelId === app.currentLevelId) {
        return;
      }

      if (
        app.flyoverRenderableLevelIds instanceof Set &&
        !app.flyoverRenderableLevelIds.has(entry.levelId)
      ) {
        return;
      }

      const levelState = app.cachedHorizontalNeighborLevelState?.(entry.levelId);

      if (!levelState || !levelState.width || !levelState.height) {
        return;
      }

      views.push({
        dx: entry.dx,
        dy: entry.dy,
        levelId: entry.levelId,
        levelState,
        offset: {
          x: entry.dx * roomWorldWidth,
          z: entry.dy * roomWorldHeight
        },
        brightness: 1,
        distance: Math.hypot(entry.dx, entry.dy)
      });
    });

    return views;
  };

  function flyoverVisibleRooms(centerLevelId) {
    const radius = visibleFlyoverRadius();
    const rooms = new Map();
    const currentState = currentRuntimeLevelState();
    const roomWorldWidth = roomSize.width * app.TILE_SIZE;
    const roomWorldHeight = roomSize.height * app.TILE_SIZE;

    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const levelId = app.adjacentWorldLevelId?.(centerLevelId, dx, dy);

        if (!levelId || rooms.has(levelId)) {
          continue;
        }

        const levelState =
          dx === 0 && dy === 0 && centerLevelId === app.currentLevelId
            ? currentState
            : app.cachedHorizontalNeighborLevelState?.(levelId);

        if (
          levelId !== app.currentLevelId &&
          app.flyoverRenderableLevelIds instanceof Set &&
          !app.flyoverRenderableLevelIds.has(levelId)
        ) {
          continue;
        }

        if (!levelState) {
          continue;
        }

        rooms.set(levelId, {
          dx,
          dy,
          levelId,
          levelState,
          offset: {
            x: dx * roomWorldWidth,
            z: dy * roomWorldHeight
          }
        });
      }
    }

    return rooms;
  }

  function scheduleRoomWindowFades(nextLevelId, shiftX, shiftY) {
    const now = performance.now();
    const roomWorldWidth = roomSize.width * app.TILE_SIZE;
    const roomWorldHeight = roomSize.height * app.TILE_SIZE;
    const previousRooms = flyoverVisibleRooms(app.currentLevelId);
    const nextRoomIds = new Set(flyoverVisibleRooms(nextLevelId).keys());
    const previousRoomIds = new Set(previousRooms.keys());

    app.flyoverDepartingViews = (app.flyoverDepartingViews || [])
      .filter((view) => now - view.startMs < view.durationMs)
      .filter((view) => !nextRoomIds.has(view.levelId));

    previousRooms.forEach((room, levelId) => {
      if (nextRoomIds.has(levelId)) {
        return;
      }

      app.flyoverDepartingViews.push({
        levelId,
        levelState: room.levelState,
        offset: {
          x: room.offset.x - shiftX * roomWorldWidth,
          z: room.offset.z - shiftY * roomWorldHeight
        },
        startMs: now,
        durationMs: app.flyoverRoomFadeDurationMs
      });
    });

    nextRoomIds.forEach((levelId) => {
      if (previousRoomIds.has(levelId)) {
        return;
      }

      app.flyoverRoomFadeIns.set(levelId, now);
    });
  }

  function tryRecenterFlyover() {
    const roomWorldWidth = roomSize.width * app.TILE_SIZE;
    const roomWorldHeight = roomSize.height * app.TILE_SIZE;

    if (app.flyoverWholeWorld === true) {
      const totalWidth = roomWorldWidth * Math.max(1, worldColumns.length);
      const totalHeight = roomWorldHeight * Math.max(1, worldRows.length);
      const bounds = app.flyoverWorldBounds || {
        minX: 0,
        maxX: totalWidth,
        minZ: 0,
        maxZ: totalHeight
      };
      const clampAxis = (value, min, max, roomSpan) => {
        if (!Number.isFinite(value) || !Number.isFinite(roomSpan) || roomSpan <= 0) {
          return value;
        }

        const low = min - roomSpan * 0.5;
        const high = max - roomSpan * 0.5;

        if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
          return low;
        }

        return Math.max(low, Math.min(high, value));
      };
      app.flyoverCameraOffsetX = clampAxis(
        Number(app.flyoverCameraOffsetX) || 0,
        Number(bounds.minX) || 0,
        Number(bounds.maxX) || totalWidth,
        roomWorldWidth
      );
      app.flyoverCameraOffsetZ = clampAxis(
        Number(app.flyoverCameraOffsetZ) || 0,
        Number(bounds.minZ) || 0,
        Number(bounds.maxZ) || totalHeight,
        roomWorldHeight
      );
      return;
    }

    let nextOffsetX = app.flyoverCameraOffsetX;
    let nextOffsetZ = app.flyoverCameraOffsetZ;
    const consumeAxisOffset = (offset, span) => {
      const threshold = span * 1.5;

      if (offset >= threshold) {
        const rooms = Math.max(1, Math.floor(offset / span + 0.5));

        return {
          offset: offset - rooms * span,
          shift: rooms
        };
      }

      if (offset <= -threshold) {
        const rooms = Math.max(1, Math.floor(-offset / span + 0.5));

        return {
          offset: offset + rooms * span,
          shift: -rooms
        };
      }

      return { offset, shift: 0 };
    };
    const xAxis = consumeAxisOffset(nextOffsetX, roomWorldWidth);
    const zAxis = consumeAxisOffset(nextOffsetZ, roomWorldHeight);
    const shiftX = xAxis.shift;
    const shiftY = zAxis.shift;

    nextOffsetX = xAxis.offset;
    nextOffsetZ = zAxis.offset;

    if (shiftX === 0 && shiftY === 0) {
      return;
    }

    const nextLevelId = app.adjacentWorldLevelId?.(app.currentLevelId, shiftX, shiftY);

    if (!nextLevelId) {
      return;
    }

    const cached = app.cachedHorizontalNeighborLevelState?.(nextLevelId);

    if (cached) {
      app.flyoverRenderableLevelIds.add(nextLevelId);
      scheduleRoomWindowFades(nextLevelId, shiftX, shiftY);
      app.flyoverCameraOffsetX = nextOffsetX;
      app.flyoverCameraOffsetZ = nextOffsetZ;
      app.applyLevelState(cached, {
        deferRender: true,
        immediateCamera: true,
        preserveAnimation: true,
        resetLevelEntry: false,
        resetHistory: false,
        updateUrl: false
      });
      app.threeRenderer?.invalidateSceneCache?.();
      updateFlyoverUrl();
      updateMinimapIfNeeded();
      maybePrefetchFlyoverLevels();
      return;
    }

    app.queueHorizontalNeighborLevelState?.(nextLevelId);
  }

  function advanceFlight(now) {
    if (flight.lastMs === 0) {
      flight.lastMs = now;
      return;
    }

    const elapsedSeconds = Math.min(0.08, Math.max(0, (now - flight.lastMs) / 1000));
    flight.lastMs = now;
    const movementRooms = applyHeldFlightControls(elapsedSeconds, now);

    applyHeldCameraControls(elapsedSeconds, now);
    if (app.flyoverSelectedLevelId && now >= selectionOrbit.pausedUntilMs) {
      camera.yaw += selectionOrbit.radiansPerSecond * elapsedSeconds;
      applyCamera(false);
    }

    if (movementRooms.x !== 0 || movementRooms.z !== 0) {
      app.flyoverCameraOffsetX += movementRooms.x * roomSize.width * app.TILE_SIZE;
      app.flyoverCameraOffsetZ += movementRooms.z * roomSize.height * app.TILE_SIZE;
      tryRecenterFlyover();
    }
  }

  function flightRenderSignature() {
    return [
      camera.yaw,
      camera.tilt,
      camera.zoom,
      app.flyoverCameraOffsetX,
      app.flyoverCameraOffsetZ,
      app.currentLevelId || "",
      app.flyoverSelectedLevelId || ""
    ].join(";");
  }

  function scheduleFlight() {
    if (flight.frameId) {
      return;
    }

    flight.frameId = window.requestAnimationFrame((now) => {
      flight.frameId = 0;
      const beforeSignature = flightRenderSignature();
      advanceFlight(now);

      // Skip the render pipeline entirely on frames where nothing moved —
      // the flight loop stays alive only to react to input.
      if (
        flightRenderSignature() !== beforeSignature ||
        heldCameraControls.size > 0 ||
        heldFlightControls.size > 0 ||
        cameraVelocity.yaw !== 0 ||
        cameraVelocity.tilt !== 0 ||
        cameraVelocity.zoom !== 0 ||
        flightVelocity.xRoomsPerSecond !== 0 ||
        flightVelocity.zRoomsPerSecond !== 0 ||
        (app.flyoverRoomFadeIns instanceof Map && app.flyoverRoomFadeIns.size > 0) ||
        (app.flyoverDepartingViews || []).length > 0
      ) {
        (app.renderOncePerFrame || app.render)(now);
      }

      updateFlyoverStatsHud(now);
      scheduleFlight();
    });
  }

  bindHoldButton("flyover-rotate-left", "rotate-left");
  bindHoldButton("flyover-rotate-right", "rotate-right");
  bindHoldButton("flyover-tilt-up", "tilt-up");
  bindHoldButton("flyover-tilt-down", "tilt-down");
  bindHoldButton("flyover-zoom-in", "zoom-in");
  bindHoldButton("flyover-zoom-out", "zoom-out");
  bindFlightHoldButton("flyover-move-forward", "forward");
  bindFlightHoldButton("flyover-move-backward", "backward");
  bindFlightHoldButton("flyover-move-left", "left");
  bindFlightHoldButton("flyover-move-right", "right");
  bindFlyoverLevelSelection();
  document.getElementById("flyover-edge-toggle")?.addEventListener("click", () => {
    setFlyoverEdgeMode(!edgeModeEnabled);
  });
  document.getElementById("flyover-title-toggle")?.addEventListener("click", () => {
    setFlyoverTitle(!titleEnabled);
  });
  document.querySelector(".flyover-stage")?.addEventListener("click", (event) => {
    if (!presentationModeEnabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setFlyoverPresentationMode(false);
  }, true);
  syncEdgeModeToggle();
  syncTitleToggle();

  function cameraControlForKey(key) {
    if (key === "a") {
      return "rotate-left";
    }

    if (key === "d") {
      return "rotate-right";
    }

    if (key === "w") {
      return "tilt-up";
    }

    if (key === "s") {
      return "tilt-down";
    }

    if (key === "q") {
      return "zoom-in";
    }

    if (key === "e") {
      return "zoom-out";
    }

    return "";
  }

  function flightControlForKey(key) {
    if (key === "arrowup") {
      return "forward";
    }

    if (key === "arrowdown") {
      return "backward";
    }

    if (key === "arrowleft") {
      return "left";
    }

    if (key === "arrowright") {
      return "right";
    }

    return "";
  }

  function isSpaceKey(event) {
    return (
      event.code === "Space" ||
      event.key === " " ||
      event.key.toLowerCase() === "spacebar"
    );
  }

  function toggleDiagnostics() {
    flight.diagnosticsVisible = !flight.diagnosticsVisible;
    updateFlyoverStatsHud(performance.now(), true);
  }

  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    if (isSpaceKey(event)) {
      event.preventDefault();

      if (!event.repeat) {
        flight.forwardEnabled = !flight.forwardEnabled;
      }

      return;
    }

    const key = event.key.toLowerCase();

    if (key === "escape" && app.flyoverSelectedLevelId) {
      event.preventDefault();
      clearFlyoverSelection();
      return;
    }

    if (key === "p") {
      event.preventDefault();

      if (!event.repeat) {
        toggleDiagnostics();
      }

      return;
    }

    const flightControl = flightControlForKey(key);

    if (flightControl) {
      event.preventDefault();

      if (!heldFlightControls.has(flightControl)) {
        heldFlightControls.set(flightControl, performance.now());
      }

      return;
    }

    const control = cameraControlForKey(key);

    if (!control) {
      return;
    }

    if (isSelectionCameraControlLocked(control)) {
      event.preventDefault();
      stopHeldSelectionFixedControls();
      return;
    }

    event.preventDefault();
    if (!heldCameraControls.has(control)) {
      heldCameraControls.set(control, performance.now());
    }
  }, true);

  window.addEventListener("keyup", (event) => {
    const key = event.key.toLowerCase();
    const flightControl = flightControlForKey(key);

    if (flightControl) {
      heldFlightControls.delete(flightControl);
      return;
    }

    const control = cameraControlForKey(key);

    if (control) {
      heldCameraControls.delete(control);
    }
  }, true);

  function releaseHeldControls() {
    heldFlightControls.clear();
    heldCameraControls.clear();
  }

  window.addEventListener("blur", releaseHeldControls);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      releaseHeldControls();
    }
  });

  app.state.effects.fuzzyEnabled = false;
  app.syncPlayLayout();
  app.setupCanvas();
  app.syncCameraTarget(true);
  app.syncEdgeToggle();
  app.syncNoiseTicker();
  app.syncFloatingFloorTicker();
  renderMinimap();
  maybePrefetchFlyoverLevels();
  app.preloadImages().finally(() => {
    const rendererReady = app.threeRendererReady || Promise.resolve();

    rendererReady
      .then(() => {
        applyCamera(false);
        app.threeRenderer?.primeHomeEdgeReveal?.();
        app.threeRenderer?.invalidateSceneCache?.();
        app.render();
        return waitForInitialFlyoverWindow();
      })
      .finally(() => {
        resetFlyoverFrameStats();
        app.threeRenderer?.invalidateSceneCache?.();
        app.render();
        revealLoadedFlyoverWorld();
        updateFlyoverStatsHud(performance.now(), true);
        scheduleFlight();
      });
  });

  window.addEventListener("resize", function () {
    app.syncPlayLayout();
    app.setupCanvas();
    app.syncCameraTarget(true);
    app.render();
  });

  window.__PIXEL_GAME_FLYOVER_APP__ = app;

  if (window.__PIXEL_GAME_DEBUG__ === true) {
    window.__PIXEL_GAME_APP__ = app;
  }
})();
