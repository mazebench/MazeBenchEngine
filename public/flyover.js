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
    forwardEnabled: true,
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
  app.flyoverSceneVersion = 0;
  app.flyoverRenderableLevelIds = new Set([app.currentLevelId]);
  app.flyoverPendingRenderableLevelIds = new Set();
  app.flyoverRenderableFlushId = 0;

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
      camera.tilt = Math.max(minTilt, camera.tilt - tiltStep * stepScale);
      return true;
    }

    if (control === "tilt-down") {
      camera.tilt = Math.min(maxTilt, camera.tilt + tiltStep * stepScale);
      return true;
    }

    if (control === "zoom-in") {
      camera.zoom = Math.min(maxZoom, camera.zoom * Math.pow(zoomStep, stepScale));
      return true;
    }

    if (control === "zoom-out") {
      camera.zoom = Math.max(minZoom, camera.zoom / Math.pow(zoomStep, stepScale));
      return true;
    }

    return false;
  }

  function applyHeldCameraControls(elapsedSeconds, now) {
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
      nudgeCameraControl(control, scale);
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

      suppressNextClick = true;
      heldCameraControls.set(control, performance.now());
    });
    button.addEventListener("pointerup", stop);
    button.addEventListener("pointercancel", stop);
    button.addEventListener("pointerleave", stop);
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
        const columnDistance = Math.min(
          Math.abs(columnIndex - current.columnIndex),
          columns.length - Math.abs(columnIndex - current.columnIndex)
        );
        const rowDistance = Math.min(
          Math.abs(rowIndex - current.rowIndex),
          rows.length - Math.abs(rowIndex - current.rowIndex)
        );
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

    app.flyoverPendingRenderableLevelIds.forEach((levelId) => {
      if (!app.cachedHorizontalNeighborLevelState?.(levelId)) {
        return;
      }

      if (!app.flyoverRenderableLevelIds.has(levelId)) {
        releasedAny = true;
        app.flyoverRenderableLevelIds.add(levelId);

        if (
          levelId !== app.currentLevelId &&
          flyoverLevelIdWithinRadius(levelId, app.currentLevelId)
        ) {
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
    const preloadRadius = Math.min(8, visibleFlyoverRadius() + 4);
    const waitTimeoutMs = app.flyoverWholeWorld === true ? Math.max(timeoutMs, 45000) : timeoutMs;

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
      const reflectAxis = (value, min, max, roomSpan) => {
        if (!Number.isFinite(value) || !Number.isFinite(roomSpan) || roomSpan <= 0) {
          return { reflected: false, value };
        }

        const low = min - roomSpan * 0.5;
        const high = max - roomSpan * 0.5;
        const width = high - low;

        if (!Number.isFinite(width) || width <= 0) {
          return { reflected: false, value: low };
        }

        let nextValue = value;
        let reflected = false;

        for (let bounce = 0; bounce < 8; bounce += 1) {
          if (nextValue < low) {
            nextValue = low + (low - nextValue);
            reflected = true;
            continue;
          }

          if (nextValue > high) {
            nextValue = high - (nextValue - high);
            reflected = true;
            continue;
          }

          break;
        }

        return {
          reflected,
          value: Math.max(low, Math.min(high, nextValue))
        };
      };
      const xAxis = reflectAxis(
        Number(app.flyoverCameraOffsetX) || 0,
        Number(bounds.minX) || 0,
        Number(bounds.maxX) || totalWidth,
        roomWorldWidth
      );
      const zAxis = reflectAxis(
        Number(app.flyoverCameraOffsetZ) || 0,
        Number(bounds.minZ) || 0,
        Number(bounds.maxZ) || totalHeight,
        roomWorldHeight
      );

      app.flyoverCameraOffsetX = xAxis.value;
      app.flyoverCameraOffsetZ = zAxis.value;

      const currentYaw = camera.yaw;
      let reflectedYaw = currentYaw;

      if (xAxis.reflected) {
        reflectedYaw = -reflectedYaw;
      }

      if (zAxis.reflected) {
        reflectedYaw = Math.PI - reflectedYaw;
      }

      if (xAxis.reflected || zAxis.reflected) {
        cameraVelocity.yaw = 0;
        camera.yaw = currentYaw + shortestYawDelta(currentYaw, reflectedYaw);
        applyCamera(true, 780);
      }

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
    if (movementRooms.x !== 0 || movementRooms.z !== 0) {
      app.flyoverCameraOffsetX += movementRooms.x * roomSize.width * app.TILE_SIZE;
      app.flyoverCameraOffsetZ += movementRooms.z * roomSize.height * app.TILE_SIZE;
      tryRecenterFlyover();
    }
  }

  function scheduleFlight() {
    if (flight.frameId) {
      return;
    }

    flight.frameId = window.requestAnimationFrame((now) => {
      flight.frameId = 0;
      advanceFlight(now);
      app.render(now);
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
        app.render();
        return waitForInitialFlyoverWindow();
      })
      .finally(() => {
        resetFlyoverFrameStats();
        app.render();
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
