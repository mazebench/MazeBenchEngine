(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.registerWorldTransitionFunctions = function registerWorldTransitionFunctions(app) {
    const playRules = modules.PlayRules;

    if (!playRules) {
      throw new Error("PlayRules must be loaded before play-world-transitions.js");
    }

    const {
      state,
      moveHistory,
      PLAYER_REVIVE_BLINK_DURATION_MS,
      HOLE_SINK_DISTANCE
    } = app;
    const renderCompositor = app.renderCompositor || app;
    const {
      cloneActorPositions,
      cloneTerrainState,
      isPlayerActor,
      actorElevation,
      computeRaisedPlayerGateSet,
      computeRaisedOrangeWallSet,
      playerSurfaceHeightAt,
      cloneLevelSnapshot,
      prepareLevelRenderState,
      applyLevelState,
      loadLevelState,
      cachedHorizontalNeighborLevelState,
      loadHorizontalNeighborLevelState,
      syncFloatingFloorTicker
    } = app;
    const {
      startLevelTransition
    } = renderCompositor;

    function cloneStoredLevelSnapshot(snapshot) {
      if (!snapshot) {
        return null;
      }

      return {
        ...snapshot,
        terrain: cloneTerrainState(snapshot.terrain || []),
        actors: (snapshot.actors || []).map((actor) => ({ ...actor }))
      };
    }

    function restoreLevelEntryState(snapshot) {
      const storedSnapshot = cloneStoredLevelSnapshot(snapshot);

      if (!storedSnapshot) {
        return;
      }

      app.levelEntrySnapshot = storedSnapshot;
      app.initialTerrain = cloneTerrainState(storedSnapshot.terrain);
      app.initialPositions = (storedSnapshot.actors || []).map((actor) => ({
        x: actor.x,
        y: actor.y,
        removed: Boolean(actor.removed),
        elevation: actor.elevation ?? 0
      }));
    }

    function terrainCellInLevelState(levelState, x, y) {
      if (!Array.isArray(levelState?.terrain) || !Number.isInteger(x) || !Number.isInteger(y)) {
        return null;
      }

      return levelState.terrain[y]?.[x] || null;
    }

    function playerStartForLevelState(levelState, preferredType = null) {
      const players = (levelState?.actors || []).filter((actor) => isPlayerActor(actor));

      if (players.length === 0) {
        return null;
      }

      return players.find((actor) => actor.type === preferredType) || players[0];
    }

    function isAllowedEdgeTransition(sourceType, targetType) {
      if (!sourceType || !targetType) {
        return false;
      }

      if (sourceType === "floor" && targetType === "hole") {
        return true;
      }

      return sourceType === targetType;
    }

    function terrainLayersForTransitionCell(cell) {
      if (Array.isArray(cell?.layers)) {
        return cell.layers;
      }

      return cell?.type && cell.type !== "empty"
        ? [
            {
              type: cell.type,
              elevation: 0,
              raised: cell.raised === true
            }
          ]
        : [];
    }

    function transitionTerrainLayerSurfaceHeight(layer, x, y, options = {}) {
      const elevation = layer?.elevation ?? 0;

      if (layer?.type === "empty" || layer?.type === "hole") {
        return null;
      }

      if (layer?.type === "wall" || layer?.type === "ice_block") {
        return elevation + 1;
      }

      if (layer?.type === "tree") {
        return elevation + 3;
      }

      if (layer?.type === "player_gate") {
        return options.raisedPlayerGates?.has?.(`${x},${y}`) ? elevation + 1 : elevation;
      }

      if (layer?.type === "player_lift") {
        return layer.raised === true ? elevation + 1 : elevation;
      }

      if (layer?.type === "orange_wall") {
        if (options.raisedOrangeWalls) {
          return options.raisedOrangeWalls.has(`${x},${y}`) ? elevation + 1 : elevation;
        }

        return elevation + 1;
      }

      return elevation;
    }

    function transitionTerrainLayerBlocksElevation(layer, x, y, elevation, options = {}) {
      const layerElevation = layer?.elevation ?? 0;

      if (layer?.type === "wall" || layer?.type === "ice_block") {
        return layerElevation === elevation;
      }

      if (layer?.type === "tree") {
        return elevation >= layerElevation && elevation < layerElevation + 3;
      }

      if (layer?.type === "player_gate") {
        return options.raisedPlayerGates?.has?.(`${x},${y}`) && layerElevation === elevation;
      }

      if (layer?.type === "player_lift") {
        return layer.raised === true && layerElevation === elevation;
      }

      if (layer?.type === "orange_wall") {
        const isRaised = options.raisedOrangeWalls
          ? options.raisedOrangeWalls.has(`${x},${y}`)
          : true;

        return isRaised && layerElevation === elevation;
      }

      return false;
    }

    function transitionTerrainBlocksElevation(levelState, x, y, elevation, options = {}) {
      const cell = terrainCellInLevelState(levelState, x, y);

      if (!cell) {
        return true;
      }

      return terrainLayersForTransitionCell(cell).some((layer) =>
        transitionTerrainLayerBlocksElevation(layer, x, y, elevation, options)
      );
    }

    function transitionTerrainSurfaceAtElevation(levelState, x, y, elevation, options = {}) {
      const cell = terrainCellInLevelState(levelState, x, y);

      if (!cell) {
        return null;
      }

      if (transitionTerrainBlocksElevation(levelState, x, y, elevation, options)) {
        return null;
      }

      return (
        terrainLayersForTransitionCell(cell)
          .map((layer, index) => ({
            index,
            layer,
            surfaceHeight: transitionTerrainLayerSurfaceHeight(layer, x, y, options)
          }))
          .filter((entry) => entry.surfaceHeight === elevation)
          .sort(
            (left, right) =>
              (right.layer.elevation ?? 0) - (left.layer.elevation ?? 0) ||
              right.index - left.index
          )[0]
          ?.layer || null
      );
    }

    function transitionTerrainHoleAtElevation(levelState, x, y, elevation) {
      const cell = terrainCellInLevelState(levelState, x, y);

      if (!cell) {
        return null;
      }

      return (
        terrainLayersForTransitionCell(cell).find(
          (layer) => layer.type === "hole" && (layer.elevation ?? 0) === elevation
        ) || null
      );
    }

    function currentLevelTransitionState() {
      return {
        width: state.width,
        height: state.height,
        terrain: state.terrain
      };
    }

    function rememberCurrentLevelEntryState() {
      app.initialPositions = cloneActorPositions();
      app.initialTerrain = cloneTerrainState(state.terrain);
      app.levelEntrySnapshot = cloneLevelSnapshot();
    }

    function attachRaisedSurfaceState(snapshot, raisedPlayerGates, raisedOrangeWalls) {
      if (!snapshot) {
        return snapshot;
      }

      snapshot.raisedPlayerGates = Array.from(raisedPlayerGates || []);
      snapshot.raisedOrangeWalls = Array.from(raisedOrangeWalls || []);
      return snapshot;
    }

    function revivePlayerAtPosition(player, x, y, elevation) {
      player.x = x;
      player.y = y;
      player.elevation = elevation;
      player.removed = false;
      player.renderX = x;
      player.renderY = y;
      player.renderElevation = elevation;
      player.renderScale = 1;
      player.renderSink = 0;
      player.renderInHole = false;
      player.renderAlpha = 0;
    }

    function revivePlayerAtLevelStart(player, startPlayer) {
      const gateState = computeRaisedPlayerGateSet();
      const orangeWallState = computeRaisedOrangeWallSet();
      const elevation =
        playerSurfaceHeightAt(startPlayer.x, startPlayer.y, gateState, orangeWallState) === 1 ? 1 : 0;

      revivePlayerAtPosition(player, startPlayer.x, startPlayer.y, elevation);
      rememberCurrentLevelEntryState();
    }

    function blinkRevivedPlayer(playerOrPlayers) {
      const players = Array.isArray(playerOrPlayers) ? playerOrPlayers : [playerOrPlayers];
      const durationMs = (PLAYER_REVIVE_BLINK_DURATION_MS || 620) / 2.25;
      const blinkCount = 2;
      const startMs = performance.now();

      app.isAnimating = true;

      function finishBlink() {
        players.forEach((player) => {
          player.renderAlpha = 1;
          player.renderScale = 1;
          player.renderSink = 0;
          player.renderInHole = false;
        });
        app.isAnimating = false;
        app.animationFrameId = null;
        syncFloatingFloorTicker();
        app.render();

        if (typeof app.runQueuedAction === "function") {
          app.runQueuedAction();
        }
      }

      function step(now) {
        const progress = Math.min(1, (now - startMs) / durationMs);

        if (progress >= 1) {
          finishBlink();
          return;
        }

        const phase = Math.floor(progress * blinkCount * 2);
        players.forEach((player) => {
          player.renderAlpha = phase % 2 === 0 ? 0 : 1;
        });
        app.render();
        app.animationFrameId = window.requestAnimationFrame(step);
      }

      app.animationFrameId = window.requestAnimationFrame(step);
    }

    function playEntryHoleFallAndRespawn(player, startPlayer) {
      if (!player || !startPlayer) {
        return true;
      }

      app.animateMoves(
        [
          {
            actor: player,
            fromX: player.x,
            fromY: player.y,
            toX: player.x,
            toY: player.y,
            fromElevation: actorElevation(player),
            toElevation: 0,
            fromRemoved: false,
            toRemoved: true
          }
        ],
        0,
        {
          onFinish: () => {
            revivePlayerAtLevelStart(player, startPlayer);
            blinkRevivedPlayer(player);
          }
        }
      );

      return false;
    }

    function adjacentWorldLevelId(levelId, dx, dy) {
      return playRules.adjacentWorldLevelId(levelId, dx, dy, app.worldColumns, app.worldRows);
    }

    async function loadTransitionLevelState(levelId) {
      const cachedLevelState =
        typeof cachedHorizontalNeighborLevelState === "function"
          ? cachedHorizontalNeighborLevelState(levelId)
          : null;
      const levelState =
        cachedLevelState ||
        (typeof loadHorizontalNeighborLevelState === "function"
          ? await loadHorizontalNeighborLevelState(levelId)
          : null) ||
        await loadLevelState(levelId);

      return cloneStoredLevelSnapshot(levelState) || levelState;
    }

    async function preloadTransitionNeighborhood(outgoingLevelId, incomingLevelId) {
      if (
        typeof loadHorizontalNeighborLevelState !== "function" ||
        typeof app.threeRenderer?.prewarmAdjacentLevelTransition !== "function"
      ) {
        return;
      }

      const levelIds = new Set();
      const addNeighborhood = (levelId) => {
        if (!levelId) {
          return;
        }

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) {
              continue;
            }

            const neighborLevelId = adjacentWorldLevelId(levelId, dx, dy);

            if (neighborLevelId) {
              levelIds.add(neighborLevelId);
            }
          }
        }
      };

      addNeighborhood(outgoingLevelId);
      addNeighborhood(incomingLevelId);
      levelIds.delete(outgoingLevelId);
      levelIds.delete(incomingLevelId);

      await Promise.all(
        Array.from(levelIds, (levelId) => {
          const cachedLevelState =
            typeof cachedHorizontalNeighborLevelState === "function"
              ? cachedHorizontalNeighborLevelState(levelId)
              : null;

          if (cachedLevelState) {
            return cachedLevelState;
          }

          return loadHorizontalNeighborLevelState(levelId).catch(() => null);
        })
      );
    }

    function edgeTransitionForMove(dx, dy) {
      const players = state.actors.filter((actor) => isPlayerActor(actor) && !actor.removed);

      if (players.length !== 1) {
        return null;
      }

      const player = players[0];
      const sourceElevation = actorElevation(player);
      const sourceSurface = transitionTerrainSurfaceAtElevation(
        currentLevelTransitionState(),
        player.x,
        player.y,
        sourceElevation,
        {
          raisedPlayerGates: computeRaisedPlayerGateSet(),
          raisedOrangeWalls: computeRaisedOrangeWallSet()
        }
      );
      const sourceType = sourceSurface?.type || "";

      if (!sourceType) {
        return null;
      }

      const onEdge =
        (dx < 0 && player.x === 0) ||
        (dx > 0 && player.x === state.width - 1) ||
        (dy < 0 && player.y === 0) ||
        (dy > 0 && player.y === state.height - 1);

      if (!onEdge) {
        return null;
      }

      const nextLevelId = adjacentWorldLevelId(app.currentLevelId, dx, dy);

      if (!nextLevelId) {
        return null;
      }

      return {
        player,
        nextLevelId,
        sourceType,
        sourceElevation,
        dx,
        dy,
        targetX: dx < 0 ? state.width - 1 : dx > 0 ? 0 : player.x,
        targetY: dy < 0 ? state.height - 1 : dy > 0 ? 0 : player.y
      };
    }

    async function transitionToAdjacentLevel(transition) {
      if (!transition || app.isTransitioningLevel) {
        return false;
      }

      app.isTransitioningLevel = true;
      const previousLevelSnapshot = attachRaisedSurfaceState(
        cloneLevelSnapshot(),
        computeRaisedPlayerGateSet(),
        computeRaisedOrangeWallSet()
      );
      const previousEntrySnapshot = cloneStoredLevelSnapshot(app.levelEntrySnapshot || previousLevelSnapshot);
      const previousEntryRenderSnapshot =
        prepareLevelRenderState?.(previousEntrySnapshot) || previousEntrySnapshot;

      if (previousEntryRenderSnapshot) {
        app.rememberHorizontalNeighborLevelState?.(previousEntryRenderSnapshot);
      }

      try {
        const nextLevelState = await loadTransitionLevelState(transition.nextLevelId);
        const levelStartPlayer = playerStartForLevelState(nextLevelState, transition.player.type);
        const reviveStartPlayer = levelStartPlayer ? { ...levelStartPlayer } : null;
        const sourceElevation = Number.isInteger(transition.sourceElevation)
          ? transition.sourceElevation
          : actorElevation(transition.player);
        const sourceSurface =
          transition.sourceType
            ? { type: transition.sourceType }
            : transitionTerrainSurfaceAtElevation(
                previousLevelSnapshot,
                transition.player.x,
                transition.player.y,
                sourceElevation,
                {
                  raisedPlayerGates: previousLevelSnapshot.raisedPlayerGates
                    ? new Set(previousLevelSnapshot.raisedPlayerGates)
                    : null,
                  raisedOrangeWalls: previousLevelSnapshot.raisedOrangeWalls
                    ? new Set(previousLevelSnapshot.raisedOrangeWalls)
                    : null
                }
              );
        const sourceType = sourceSurface?.type || "empty";
        const targetSurface = transitionTerrainSurfaceAtElevation(
          nextLevelState,
          transition.targetX,
          transition.targetY,
          sourceElevation
        );
        const targetHole = transitionTerrainHoleAtElevation(
          nextLevelState,
          transition.targetX,
          transition.targetY,
          sourceElevation
        );
        const targetType = targetSurface?.type || targetHole?.type || "empty";

        if (!isAllowedEdgeTransition(sourceType, targetType)) {
          app.isTransitioningLevel = false;
          return false;
        }

        if (typeof app.threeRenderer?.prewarmAdjacentLevelTransition === "function") {
          await preloadTransitionNeighborhood(previousLevelSnapshot.levelId, nextLevelState.levelId);
        }

        const entersHole = targetType === "hole";
        const targetElevation = sourceElevation;
        const transferredPlayer = {
          type: transition.player.type,
          groupId: transition.player.groupId ?? null,
          label: transition.player.label,
          imageUrl: transition.player.imageUrl || null,
          x: transition.targetX,
          y: transition.targetY,
          removed: false,
          elevation: targetElevation
        };

        nextLevelState.actors = [
          ...(nextLevelState.actors || []).filter((actor) => !isPlayerActor(actor)),
          transferredPlayer
        ];

        moveHistory.push({
          kind: "level-transition",
          level: previousLevelSnapshot,
          entry: previousEntrySnapshot
        });
        applyLevelState(nextLevelState, {
          updateUrl: true,
          resetLevelEntry: true,
          immediateCamera: true,
          deferRender: true
        });

        const incomingRaisedPlayerGates = computeRaisedPlayerGateSet();
        const incomingRaisedOrangeWalls = computeRaisedOrangeWallSet();
        app.liveRaisedPlayerGates = incomingRaisedPlayerGates;
        app.liveRaisedOrangeWalls = incomingRaisedOrangeWalls;
        const incomingLevelSnapshot = attachRaisedSurfaceState(
          cloneLevelSnapshot(),
          incomingRaisedPlayerGates,
          incomingRaisedOrangeWalls
        );
        const incomingPlayer = state.actors.find((actor) => isPlayerActor(actor) && !actor.removed) || null;
        const durationMs = app.LEVEL_TRANSITION_DURATION_MS || 1000;
        const transitionData = {
          kind: "adjacent-scene",
          dx: transition.dx,
          dy: transition.dy,
          outgoingLevel: previousLevelSnapshot,
          outgoingResetLevel: previousEntryRenderSnapshot,
          incomingLevel: incomingLevelSnapshot,
          incomingRaisedPlayerGates: incomingLevelSnapshot.raisedPlayerGates,
          incomingRaisedOrangeWalls: incomingLevelSnapshot.raisedOrangeWalls,
          sourcePlayer: { ...transition.player },
          targetPlayer: incomingPlayer ? { ...incomingPlayer } : null
        };

        app.threeRenderer?.prewarmAdjacentLevelTransition?.(transitionData, durationMs);
        startLevelTransition(null, null, transition.dx, transition.dy, null, null, null, {
          durationMs,
          renderImmediately: false,
          transitionData,
          onComplete:
            entersHole && reviveStartPlayer
              ? () => playEntryHoleFallAndRespawn(incomingPlayer, reviveStartPlayer)
              : null
        });

        return true;
      } catch (error) {
        console.error(error);
        app.isTransitioningLevel = false;
        return false;
      }
    }

    Object.assign(app, {
      adjacentWorldLevelId,
      cloneStoredLevelSnapshot,
      restoreLevelEntryState,
      rememberCurrentLevelEntryState,
      edgeTransitionForMove,
      transitionToAdjacentLevel
    });
  };
})();
