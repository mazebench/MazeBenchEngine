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

    function iceSlideMoveMetadata(moves) {
      return moves
        .filter(({ iceSlide = false }) => iceSlide)
        .map(({ actor, fromX, fromY, toX, toY }) => ({
          actorIndex: state.actors.indexOf(actor),
          fromX,
          fromY,
          toX,
          toY
        }))
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
          move.toX === originalMove.fromX &&
          move.toY === originalMove.fromY;

        if (!isReverseMove) {
          return;
        }

        move.iceSlide = true;
        move.reverseIceSlide = true;
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
          toRemoved = false,
          skipHoleFall = false,
          toElevation = actor.elevation ?? 0
        }) => {
          actor.x = toX;
          actor.y = toY;
          actor.renderX = toX;
          actor.renderY = toY;
          actor.elevation = toElevation;
          actor.renderElevation = toElevation;
          actor.renderScale = toRemoved ? 0 : 1;
          actor.renderAlpha = toRemoved ? 0 : 1;
          actor.renderSink = toRemoved && !skipHoleFall ? HOLE_SINK_DISTANCE : 0;
          actor.renderInHole = false;
          actor.removed = Boolean(toRemoved);
        }
      );

      moves.forEach(({ fillsHole = false, fillHoleX = null, fillHoleY = null }) => {
        if (!fillsHole || typeof fillHoleX !== "number" || typeof fillHoleY !== "number") {
          return;
        }

        fillHoleAt(fillHoleX, fillHoleY);
      });
    }

    function applyMoveLogicalPositions(moves) {
      moves.forEach(({ actor, toX, toY }) => {
        actor.x = toX;
        actor.y = toY;
      });
    }

    function performPlayerMove(dx, dy, options = {}) {
      const animate = options.animate !== false;
      const recordHistory = options.recordHistory !== false;
      const onFinish = typeof options.onFinish === "function" ? options.onFinish : null;
      const engine = createCurrentEngine();
      const engineState = engine.cloneState(engine.initialState);
      const previousState = {
        actors: cloneActorPositions(),
        terrain: cloneTerrainState(state.terrain)
      };
      const raisedPlayerGates = computeRaisedPlayerGateSet();
      const raisedOrangeWalls = computeRaisedOrangeWallSet();
      const moveResult = engine.move(engineState, dx, dy);
      const moves = moveResult.moves.map(moveFromEngineRecord).filter(Boolean);
      const liftToggles = Array.isArray(moveResult.liftToggles) ? moveResult.liftToggles : [];

      if (moves.length > 0) {
        if (recordHistory) {
          previousState.iceSlideMoves = iceSlideMoveMetadata(moves);
          moveHistory.push(previousState);
        }

        if (animate) {
          applyMoveLogicalPositions(moves);
          app.gateRenderOverride = raisedPlayerGates;
          app.orangeWallRenderOverride = raisedOrangeWalls;
          app.animateMoves(moves, null, {
            onFinish,
            startLiftPhase: () => {
              liftToggles.forEach(({ x, y, raised }) => {
                setPlayerLiftRaised(x, y, raised);
              });
              app.orangeWallRenderOverride = null;
            }
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

    return {
      applyMoveFinalState,
      applyUndoIceSlideMetadata,
      performPlayerMove
    };
  };

  modules.registerMovementFunctions = function registerMovementFunctions(app) {
    const movement = modules.createMovementController(app);
    app.movement = movement;
    return movement;
  };
})();
