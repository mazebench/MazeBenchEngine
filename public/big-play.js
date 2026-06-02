(function () {
  const playData = window.__PLAY_DATA__;
  const canvas = document.getElementById("maze-canvas");
  const modules = window.PlayModules || {};

  if (
    !playData ||
    !canvas ||
    typeof modules.createPlayCore !== "function" ||
    typeof modules.registerRenderFunctions !== "function" ||
    typeof modules.registerGameplayFunctions !== "function"
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
    resetProgressButton: document.getElementById("reset-progress"),
    enableCameraControls: true
  });

  if (!app) {
    return;
  }

  const roomSize = {
    width: Math.max(1, Number(playData.width) || 16),
    height: Math.max(1, Number(playData.height) || 16)
  };
  const worldColumns = Array.isArray(playData.worldColumns) ? playData.worldColumns : [];
  const worldRows = Array.isArray(playData.worldRows) ? playData.worldRows : [];

  app.bigPlayMode = true;
  app.playRoutePrefix = "big-play";
  app.flyoverWholeWorld = true;
  app.flyoverWholeWorldReady = false;
  app.flyoverSceneVersion = 0;
  app.flyoverSelectedLevelId = "";
  app.flyoverFocusedLevelId = app.currentLevelId;
  app.flyoverRoomTileWidth = roomSize.width;
  app.flyoverRoomTileHeight = roomSize.height;
  app.flyoverCameraOffsetX = 0;
  app.flyoverCameraOffsetZ = 0;
  app.flyoverRoomFadeDurationMs = 0;
  app.flyoverRoomFadeIns = new Map();
  app.flyoverDepartingViews = [];
  app.flyoverRenderableLevelIds = new Set([app.currentLevelId]);
  app.flyoverPendingRenderableLevelIds = new Set();
  app.flyoverRenderableFlushId = 0;
  app.horizontalNeighborLoadConcurrency = 6;
  app.deferNeighborLoadRenders = true;
  app.preloadQueuedNeighborAssets = true;

  function currentWorldIndex() {
    return app.parseWorldLevelId?.(app.currentLevelId || playData.levelId) || null;
  }

  function rebuildWorldEntries() {
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

  function syncWorldMetadata() {
    const entries = rebuildWorldEntries();
    const current = currentWorldIndex();
    const roomWorldWidth = roomSize.width * app.TILE_SIZE;
    const roomWorldHeight = roomSize.height * app.TILE_SIZE;

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
      : {
          minX: 0,
          maxX: roomWorldWidth,
          minZ: 0,
          maxZ: roomWorldHeight
        };
  }

  function updateReturnLink() {
    const returnLink = document.querySelector("[data-big-play-return]");

    if (!returnLink || !app.currentGameId || !app.currentLevelId) {
      return;
    }

    returnLink.href = `/flyover/${encodeURIComponent(app.currentGameId)}/${encodeURIComponent(app.currentLevelId)}`;
  }

  function visibleWorldLevelIds() {
    if (!Array.isArray(app.flyoverWorldEntries)) {
      return [app.currentLevelId];
    }

    return app.flyoverWorldEntries.map((entry) => entry.levelId);
  }

  function releaseRenderableLevels() {
    app.flyoverRenderableFlushId = 0;
    let releasedAny = false;

    app.flyoverPendingRenderableLevelIds.forEach((levelId) => {
      if (!app.cachedHorizontalNeighborLevelState?.(levelId)) {
        return;
      }

      if (!app.flyoverRenderableLevelIds.has(levelId)) {
        releasedAny = true;
        app.flyoverRenderableLevelIds.add(levelId);
      }
    });
    app.flyoverPendingRenderableLevelIds.clear();

    if (releasedAny) {
      app.flyoverSceneVersion = (Number(app.flyoverSceneVersion) || 0) + 1;
      app.threeRenderer?.invalidateSceneCache?.();
      app.render();
    }
  }

  function scheduleRenderableLevel(levelId) {
    if (!levelId || app.flyoverRenderableLevelIds.has(levelId)) {
      return;
    }

    app.flyoverPendingRenderableLevelIds.add(levelId);

    if (!app.flyoverRenderableFlushId) {
      app.flyoverRenderableFlushId = window.setTimeout(releaseRenderableLevels, 80);
    }
  }

  function queueWorldLevels() {
    if (!Array.isArray(app.flyoverWorldEntries)) {
      return;
    }

    app.flyoverRenderableLevelIds.add(app.currentLevelId);
    app.flyoverWorldEntries
      .filter((entry) => entry.levelId !== app.currentLevelId)
      .map((entry) => ({
        ...entry,
        priority: Math.hypot(entry.dx, entry.dy)
      }))
      .sort((left, right) => left.priority - right.priority)
      .forEach((entry) => {
        if (app.cachedHorizontalNeighborLevelState?.(entry.levelId)) {
          scheduleRenderableLevel(entry.levelId);
          return;
        }

        app.queueHorizontalNeighborLevelState?.(entry.levelId, {
          priority: entry.priority
        });
      });
  }

  const coreApplyLevelState = app.applyLevelState;

  app.applyLevelState = function applyBigPlayLevelState(levelState, options = {}) {
    coreApplyLevelState(levelState, options);
    syncWorldMetadata();
    app.flyoverFocusedLevelId = app.currentLevelId;
    app.flyoverSelectedLevelId = "";
    app.flyoverRenderableLevelIds.add(app.currentLevelId);
    app.flyoverSceneVersion = (Number(app.flyoverSceneVersion) || 0) + 1;
    app.threeRenderer?.invalidateSceneCache?.();
    updateReturnLink();
    queueWorldLevels();
  };

  modules.registerRenderFunctions(app);
  modules.registerGameplayFunctions(app);

  app.onNeighborLevelStateLoaded = function onNeighborLevelStateLoaded(levelState) {
    const levelId = levelState?.levelId;

    if (!levelId) {
      return;
    }

    scheduleRenderableLevel(levelId);
    app.flyoverWorldLoadedLevelCount = visibleWorldLevelIds().filter((loadedLevelId) => {
      if (loadedLevelId === app.currentLevelId) {
        return true;
      }

      return Boolean(app.cachedHorizontalNeighborLevelState?.(loadedLevelId));
    }).length;
    app.flyoverWholeWorldReady =
      app.flyoverWorldLoadedLevelCount >= (Number(app.flyoverWorldTotalLevelCount) || 1);
  };

  app.flyoverSurroundingLevelViews = function flyoverSurroundingLevelViews() {
    if (!Array.isArray(app.flyoverWorldEntries)) {
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

      if (!levelState?.width || !levelState?.height) {
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

  if (app.resetProgressButton) {
    app.resetProgressButton.addEventListener("click", function () {
      app.resetCollectionProgress();
    });
  }

  app.state.effects.fuzzyEnabled = false;
  syncWorldMetadata();
  updateReturnLink();
  app.syncPlayLayout();
  app.setupCanvas();
  app.syncCameraTarget(true);
  app.syncEdgeToggle();
  app.syncNoiseTicker();
  app.syncFloatingFloorTicker();
  queueWorldLevels();
  app.preloadImages().finally(() => {
    const rendererReady = app.threeRendererReady || Promise.resolve();

    rendererReady
      .then(() => {
        app.threeRenderer?.setDebugCameraView?.({
          animate: false,
          mode: "perspective",
          tilt: Math.PI * 0.16,
          yaw: 0,
          zoom: 1
        });
        app.render();
      })
      .finally(() => {
        app.deferNeighborLoadRenders = false;
      });
  });

  window.addEventListener("keydown", app.handleKeydown);
  window.addEventListener("wheel", app.preventScroll, { passive: false });
  window.addEventListener("resize", function () {
    app.syncPlayLayout();
    app.setupCanvas();
    app.syncCameraTarget(true);
    app.render();
  });

  window.__PIXEL_GAME_BIG_PLAY_APP__ = app;

  if (window.__PIXEL_GAME_DEBUG__ === true) {
    window.__PIXEL_GAME_APP__ = app;
  }
})();
