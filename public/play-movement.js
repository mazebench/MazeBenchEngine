(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.createMovementController = function createMovementController(app) {
    const mazeEngine = window.MazeEngine;

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
      setPlayerLiftRaised
    } = app;

    function engineActorFromRuntime(actor) {
      return {
        elevation: actor.elevation ?? 0,
        direction: actor.direction || actor.facing || null,
        groupId: actor.groupId,
        removed: Boolean(actor.removed),
        type: actor.type,
        x: actor.x,
        y: actor.y
      };
    }

    function createCurrentEngine() {
      return mazeEngine.createEngine({
        actors: state.actors.map(engineActorFromRuntime),
        height: state.height,
        terrain: state.terrain,
        width: state.width
      });
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

    function actorSnapshotsFromEngineState(engineState) {
      return state.actors.map((actor, index) => ({
        ...actor,
        elevation: engineState.actorElevation[index] ?? actor.elevation ?? 0,
        removed: Boolean(engineState.actorRemoved[index]),
        x: engineState.actorX[index] ?? actor.x,
        y: engineState.actorY[index] ?? actor.y
      }));
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
        startOnCurrentSlope: options.startOnCurrentSlope === true
      });
      const moves = moveResult.moves.map(moveFromEngineRecord).filter(Boolean);
      // Snapshots are only taken once we know the move actually goes
      // somewhere — blocked moves skip all of the deep clones below. The
      // snapshot must precede recordCollectedGemsFromMoves, which mutates
      // the gem-collection fields cloneActorPositions captures.
      const previousState =
        moves.length > 0
          ? {
              actors: cloneActorPositions(),
              terrain: cloneTerrainState(state.terrain),
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
      const finalRaisedOrangeWalls = computeRaisedOrangeWallSet(
        actorSnapshotsFromEngineState(engineState)
      );
      const preTerrainLiftMoves = preTerrainOrangeButtonLiftMoves(
        moves,
        raisedOrangeWalls,
        finalRaisedOrangeWalls
      );
      const hasLogicalMoves = moves.some((move) => move.visualOnly !== true);

      if (moves.length > 0) {
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

        if (animate) {
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
              app.orangeWallRenderOverride = null;
            },
            onMoveFrame
          });
        } else {
          liftToggles.forEach(({ x, y, raised }) => {
            setPlayerLiftRaised(x, y, raised);
          });
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
        moved: moves.length > 0,
        moves,
        previousState
      };
    }

    function previewPlayerMove(dx, dy, options = {}) {
      const engine = createCurrentEngine();
      const engineState = engine.cloneState(engine.initialState);
      const moveResult = engine.move(engineState, dx, dy, {
        continuePunchSlide: options.continuePunchSlide === true,
        startOnCurrentSlope: options.startOnCurrentSlope === true
      });
      const moves = moveResult.moves.map(moveFromEngineRecord).filter(Boolean);

      return {
        ...moveResult,
        moved: moves.length > 0,
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
