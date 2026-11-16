(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.createMovementController = function createMovementController(app) {
    const mazeEngine = window.MazeEngine;
    const versions = window.MazeEngineVersions;
    const requestedVersion = app.engineVersion || app.playData?.engineVersion || app.playData?.engine_version || "v1";
    app.engineVersion = requestedVersion;
    if (requestedVersion !== "v1") {
      if (!versions) throw new Error("The versioned physics runtime is missing.");
      app.engineReady = versions.load(requestedVersion);
      // Keep failure observable to the host while preventing an unhandled rejection
      // on direct engine pages that have no host boot promise.
      app.engineReady.catch((error) => { app.engineLoadError = error; console.error(error); });
    } else {
      app.engineReady = Promise.resolve();
    }

    if (!mazeEngine || typeof mazeEngine.createEngine !== "function") {
      throw new Error("maze-engine.js must be loaded before play-movement.js");
    }

    const {
      state,
      moveHistory,
      HOLE_SINK_DISTANCE,
      cloneActorPositions,
      cloneTerrainState,
      computeRaisedPlayerGateSet,
      computeRaisedOrangeWallSet,
      setRaisedOrangeWallState,
      setPlayerLiftRaised
    } = app;

    function engineActorFromRuntime(actor) {
      return {
        elevation: actor.elevation ?? 0,
        direction: actor.direction || actor.facing || null,
        groupId: actor.groupId,
        removed: Boolean(actor.removed),
        // Attached lifts round-trip their raised state through the runtime
        // actor so each per-keypress engine rebuild starts from the live bit.
        raised: actor.raised === true,
        v11GenericId: actor.v11GenericId,
        shape: actor.shape || null,
        type: actor.type,
        x: actor.x,
        y: actor.y
      };
    }

    function createCurrentEngine() {
      return (versions || mazeEngine).createEngine({
        engineVersion: app.engineVersion,
        actors: state.actors.map(engineActorFromRuntime),
        height: state.height,
        terrain: state.terrain,
        width: state.width
      });
    }

    // Exposed edges are lethal for players wherever the world has no
    // neighboring room in that direction — and everywhere in single-room
    // play (adjacentWorldLevelId returns nothing for non-world level ids).
    // Interior room boundaries keep their rail: legitimate crossings are
    // claimed by the world-transition planner before the engine is asked.
    function edgeFallsEnabledFor(dx, dy) {
      if (typeof app.adjacentWorldLevelId !== "function" || !app.currentLevelId) {
        return true;
      }

      return !app.adjacentWorldLevelId(app.currentLevelId, dx, dy);
    }

    function moveFromEngineRecord(record) {
      const actor = state.actors[record.actorIndex];

      if (!actor) {
        return null;
      }

      return {
        ...record,
        actor
      };
    }

    function hasOrangeWallLowered(fromRaised, toRaised) {
      for (const key of fromRaised) {
        if (!toRaised.has(key)) {
          return true;
        }
      }

      return false;
    }

    function isOrangeButtonAt(x, y) {
      const cell = state.terrain[y]?.[x];

      return (
        cell?.type === "orange_button" ||
        (Array.isArray(cell?.layers) && cell.layers.some((layer) => layer.type === "orange_button")) ||
        state.actors.some((actor) => !actor.removed && actor.type === "orange_button" && actor.x === x && actor.y === y)
      );
    }

    function preTerrainOrangeButtonLiftMoves(moves, fromRaisedOrangeWalls, toRaisedOrangeWalls) {
      if (!hasOrangeWallLowered(fromRaisedOrangeWalls, toRaisedOrangeWalls)) {
        return new Set();
      }

      const buttonPressingActors = new Set();
      const buttonPressingWeightlessGroups = new Set();

      moves.forEach((move) => {
        const fromElevation = move.fromElevation ?? move.actor?.elevation ?? 0;
        const toElevation = move.toElevation ?? fromElevation;

        if (toElevation !== 0 || fromElevation <= toElevation || !isOrangeButtonAt(move.toX, move.toY)) {
          return;
        }

        if (move.actor?.type === "weightless_box") {
          buttonPressingWeightlessGroups.add(move.actor.groupId);
          return;
        }

        buttonPressingActors.add(move.actor);
      });

      if (buttonPressingActors.size === 0 && buttonPressingWeightlessGroups.size === 0) {
        return new Set();
      }

      return new Set(
        moves.filter((move) => {
          const fromElevation = move.fromElevation ?? move.actor?.elevation ?? 0;
          const toElevation = move.toElevation ?? fromElevation;

          if (toElevation !== 0 || fromElevation <= toElevation) {
            return false;
          }

          return (
            buttonPressingActors.has(move.actor) ||
            (move.actor?.type === "weightless_box" &&
              buttonPressingWeightlessGroups.has(move.actor.groupId))
          );
        })
      );
    }

    function iceSlideMoveMetadata(moves) {
      return moves
        .filter(({ iceSlide = false }) => iceSlide)
        .map(({
          actor,
          fromElevation = 0,
          fromX,
          fromY,
          path,
          pathControlsElevation = false,
          toElevation = fromElevation,
          toX,
          toY
        }) => {
          const metadata = {
            actorIndex: state.actors.indexOf(actor),
            fromElevation,
            fromX,
            fromY,
            toElevation,
            toX,
            toY
          };

          if (Array.isArray(path) && path.length > 1) {
            metadata.path = path.map((point) => ({
              elevation: Number(point?.elevation),
              x: Number(point?.x),
              y: Number(point?.y)
            }));
            metadata.pathControlsElevation =
              pathControlsElevation ||
              metadata.path.some((point) => point.elevation !== fromElevation);
          }

          return metadata;
        })
        .filter(({ actorIndex }) => actorIndex !== -1);
    }

    function applyUndoIceSlideMetadata(moves, previousState) {
      if (!Array.isArray(previousState.iceSlideMoves) || previousState.iceSlideMoves.length === 0) {
        return;
      }

      const iceSlideMoveByActorIndex = new Map(
        previousState.iceSlideMoves.map((move) => [move.actorIndex, move])
      );

      moves.forEach((move) => {
        const originalMove = iceSlideMoveByActorIndex.get(move.actorIndex);

        if (!originalMove) {
          return;
        }

        const isReverseMove =
          move.fromX === originalMove.toX &&
          move.fromY === originalMove.toY &&
          (originalMove.toElevation === undefined || move.fromElevation === originalMove.toElevation) &&
          move.toX === originalMove.fromX &&
          move.toY === originalMove.fromY &&
          (originalMove.fromElevation === undefined || move.toElevation === originalMove.fromElevation);

        if (!isReverseMove) {
          return;
        }

        move.iceSlide = true;
        move.reverseIceSlide = true;

        if (Array.isArray(originalMove.path) && originalMove.path.length > 1) {
          move.path = originalMove.path
            .slice()
            .reverse()
            .map((point) => ({ ...point }));
          move.pathControlsElevation =
            originalMove.pathControlsElevation ||
            move.path.some((point) => point.elevation !== move.fromElevation);
          move.pathEndElevation = move.path[move.path.length - 1]?.elevation ?? move.toElevation;
        }
      });
    }

    function buildFloorTerrainCell() {
      return {
        type: "floor",
        label: "Floor",
        imageUrl: null,
        underlay: null,
        raised: false
      };
    }

    function fillHoleAt(x, y) {
      app.terrainRenderVersion = (Number(app.terrainRenderVersion) || 0) + 1;
      if (!app.isInsideBoard(x, y)) {
        return;
      }

      state.terrain[y][x] = buildFloorTerrainCell();
    }

    function applyMoveFinalState(moves) {
      moves.forEach(
        ({
          actor,
          toX,
          toY,
          toElevation = actor.elevation ?? 0,
          finalX = toX,
          finalY = toY,
          finalElevation = toElevation,
          visualOnly = false,
          toRemoved = false,
          toGenericId,
          skipHoleFall = false,
          collectedGemVisual = null
        }) => {
          actor.x = visualOnly ? finalX : toX;
          actor.y = visualOnly ? finalY : toY;
          actor.renderX = actor.x;
          actor.renderY = actor.y;
          actor.elevation = visualOnly ? finalElevation : toElevation;
          actor.renderElevation = actor.elevation;
          actor.renderInHole = false;
          actor.renderPunchEffect = false;
          actor.removed = Boolean(toRemoved);
          if (Number.isInteger(toGenericId)) {
            actor.v11GenericId = toGenericId;
            if (actor.type === "attached_lift" || actor.type === "attached_gate") actor.raised = (toGenericId & 1) === 1;
          }

          if (
            actor.type === "gem" &&
            (actor.collected === true ||
              (actor.collectionId && app.collectedGemIds?.has?.(actor.collectionId)))
          ) {
            if (collectedGemVisual === "ghost" && toRemoved !== true) {
              app.applyCollectedGemVisual?.(actor);
            } else {
              app.hideCollectedGemVisual?.(actor);
            }
            return;
          }

          actor.renderScale = toRemoved ? 0 : 1;
          actor.renderAlpha = toRemoved ? 0 : 1;
          actor.renderSink = toRemoved && !skipHoleFall ? HOLE_SINK_DISTANCE : 0;
        }
      );

      moves.forEach(({ fillsHole = false, fillHoleX = null, fillHoleY = null }) => {
        if (!fillsHole || typeof fillHoleX !== "number" || typeof fillHoleY !== "number") {
          return;
        }

        fillHoleAt(fillHoleX, fillHoleY);
      });

      app.hideCollectedGemsAtPlayers?.();
    }

    function applyMoveLogicalPositions(moves) {
      moves.forEach(({ actor, toX, toY, visualOnly = false }) => {
        if (visualOnly) {
          return;
        }

        actor.x = toX;
        actor.y = toY;
      });
    }

    function applyModernMechanisms(terrain, genericIds, durationMs = 0) {
      if (terrain) {
        const changes = new Map();
        terrain.forEach((row, y) => row.forEach((cell, x) => (cell.layers || []).forEach((layer, index) => {
          if (layer.type !== "orange_wall") return;
          const before = state.terrain[y]?.[x]?.layers?.[index];
          const from = before?.v11GenericId || 0;
          if (from !== layer.v11GenericId) changes.set(`${x},${y},${layer.v11AnchorElevation}`, from);
        })));
        app.v11TerrainTransition = durationMs > 0 && changes.size ? { changes, startedAt: performance.now(), durationMs } : null;
        app.restoreTerrainState(terrain);
      }
      (genericIds || []).forEach((genericId, index) => {
        const actor = state.actors[index];
        if (!actor) return;
        actor.v11GenericId = genericId;
        if (actor.type === "attached_lift" || actor.type === "attached_gate") actor.raised = (genericId & 1) === 1;
      });
    }

    function animateModernCommand(result, durationMs, onFinish, onMoveFrame) {
      const ticks = result.ticks || [];
      let nextTick = 0;
      function advance() {
        if (nextTick >= ticks.length) {
          applyModernMechanisms(result.terrainAfter, result.actorGenericId);
          if (onFinish) onFinish();
          return;
        }
        const tick = ticks[nextTick++];
        const moves = tick.moves.map(moveFromEngineRecord).filter(Boolean);
        const tickDuration = typeof durationMs === "number" ? durationMs / ticks.length : app.MOVE_DURATION_MS;
        applyModernMechanisms(tick.terrain, tick.actorGenericId, tickDuration);
        if (!moves.length) {
          if (!tick.terrain || tickDuration <= 0) { advance(); return; }
          app.isAnimating = true;
          let elapsed = 0, last = null;
          const step = (now) => {
            elapsed += last === null ? 0 : Math.min(40, Math.max(0, now - last)); last = now;
            app.render(now);
            if (elapsed < tickDuration) app.animationFrameId = window.requestAnimationFrame(step);
            else { app.isAnimating = false; app.animationFrameId = null; advance(); }
          };
          app.animationFrameId = window.requestAnimationFrame(step);
          return;
        }
        applyMoveLogicalPositions(moves);
        app.animateMoves(moves, tickDuration, {
          onFinish: advance,
          onMoveFrame: onMoveFrame ? (frame) => onMoveFrame({ ...frame, progress: (nextTick - 1 + frame.progress) / ticks.length }) : null
        });
      }
      advance();
    }

    function performPlayerMove(dx, dy, options = {}) {
      const animate = options.animate !== false;
      const recordHistory = options.recordHistory !== false;
      const onFinish = typeof options.onFinish === "function" ? options.onFinish : null;
      const beforeAnimate =
        typeof options.beforeAnimate === "function" ? options.beforeAnimate : null;
      const onMoveFrame =
        typeof options.onMoveFrame === "function" ? options.onMoveFrame : null;
      const durationMs = Number.isFinite(options.durationMs)
        ? Math.max(0, options.durationMs)
        : null;
      const engine = createCurrentEngine();
      const engineState = engine.cloneState(engine.initialState);
      const raisedPlayerGates = computeRaisedPlayerGateSet();
      const raisedOrangeWalls = computeRaisedOrangeWallSet();
      const moveResult = engine.move(engineState, dx, dy, {
        continuePunchSlide: options.continuePunchSlide === true,
        startOnCurrentSlope: options.startOnCurrentSlope === true,
        suppressCloneInput: options.suppressCloneInput === true,
        edgeFalls: edgeFallsEnabledFor(dx, dy)
      });
      const moves = moveResult.moves.map(moveFromEngineRecord).filter(Boolean);
      const modern = moveResult.engineVersion === "v1.1";
      // Snapshots are only taken once we know the move actually goes
      // somewhere — blocked moves skip all of the deep clones below. The
      // snapshot must precede recordCollectedGemsFromMoves, which mutates
      // the gem-collection fields cloneActorPositions captures.
      const previousState =
        (modern ? moveResult.moved : moves.length > 0)
          ? {
              actors: cloneActorPositions(),
              terrain: cloneTerrainState(state.terrain),
              raisedOrangeWalls: Array.from(raisedOrangeWalls),
              levelSnapshot:
                typeof app.cloneLevelSnapshot === "function" ? app.cloneLevelSnapshot() : null,
              levelEntrySnapshot:
                typeof app.cloneStoredLevelSnapshot === "function"
                  ? app.cloneStoredLevelSnapshot(app.levelEntrySnapshot)
                  : null,
              undoGroupId: app.activeUndoGroupId || null
            }
          : null;
      app.recordCollectedGemsFromMoves?.(moves);
      const liftToggles = Array.isArray(moveResult.liftToggles) ? moveResult.liftToggles : [];
      const finalRaisedOrangeWalls = new Set(
        Array.isArray(moveResult.raisedOrangeWalls)
          ? moveResult.raisedOrangeWalls
          : engine.raisedOrangeWallKeys(engineState)
      );
      const preTerrainLiftMoves = preTerrainOrangeButtonLiftMoves(
        moves,
        raisedOrangeWalls,
        finalRaisedOrangeWalls
      );
      const hasLogicalMoves = modern ? moveResult.moved : moves.some((move) => move.visualOnly !== true);

      if (modern ? moveResult.moved : moves.length > 0) {
        if (beforeAnimate) {
          beforeAnimate({
            moveResult: {
              ...moveResult,
              moves
            },
            moves,
            previousState
          });
        }

        if (recordHistory && hasLogicalMoves) {
          previousState.iceSlideMoves = iceSlideMoveMetadata(moves);
          moveHistory.push(previousState);

          if (moveHistory.length > 500) {
            moveHistory.splice(0, moveHistory.length - 500);
          }
        }

        if (modern) {
          if (animate) animateModernCommand(moveResult, durationMs, onFinish, onMoveFrame);
          else {
            applyModernMechanisms(moveResult.terrainAfter, moveResult.actorGenericId);
            applyMoveFinalState(moves);
            if (onFinish) onFinish();
          }
        } else if (animate) {
          applyMoveLogicalPositions(moves);
          app.gateRenderOverride = raisedPlayerGates;
          app.orangeWallRenderOverride = raisedOrangeWalls;
          app.animateMoves(moves, durationMs, {
            onFinish,
            preTerrainLiftMoves,
            startLiftPhase: () => {
              liftToggles.forEach(({ x, y, raised }) => {
                setPlayerLiftRaised(x, y, raised);
              });
              setRaisedOrangeWallState(finalRaisedOrangeWalls);
              app.orangeWallRenderOverride = null;
            },
            onMoveFrame
          });
        } else {
          liftToggles.forEach(({ x, y, raised }) => {
            setPlayerLiftRaised(x, y, raised);
          });
          setRaisedOrangeWallState(finalRaisedOrangeWalls);
          applyMoveFinalState(moves);
          app.gateRenderOverride = null;
          app.orangeWallRenderOverride = null;
          if (onFinish) {
            onFinish();
          }
        }
      } else if (onFinish) {
        onFinish();
      }

      return {
        moved: modern ? moveResult.moved : moves.length > 0,
        moves,
        previousState
      };
    }

    function previewPlayerMove(dx, dy, options = {}) {
      const engine = createCurrentEngine();
      const engineState = engine.cloneState(engine.initialState);
      const moveResult = engine.move(engineState, dx, dy, {
        continuePunchSlide: options.continuePunchSlide === true,
        startOnCurrentSlope: options.startOnCurrentSlope === true,
        edgeFalls: edgeFallsEnabledFor(dx, dy)
      });
      const moves = moveResult.moves.map(moveFromEngineRecord).filter(Boolean);

      return {
        ...moveResult,
        moved: moveResult.engineVersion === "v1.1" ? moveResult.moved : moves.length > 0,
        moves
      };
    }

    return {
      applyMoveFinalState,
      applyUndoIceSlideMetadata,
      previewPlayerMove,
      performPlayerMove
    };
  };

  modules.registerMovementFunctions = function registerMovementFunctions(app) {
    const movement = modules.createMovementController(app);
    app.movement = movement;
    return movement;
  };
})();
