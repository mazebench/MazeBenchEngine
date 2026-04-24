(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.registerGameplayFunctions = function registerGameplayFunctions(app) {
    // Ice ramps smoothly to capped speed across this many tiles.
    const ICE_SLIDE_TOP_SPEED_MULTIPLIER = 2.67;
    const ICE_SLIDE_ACCELERATION_DISTANCE = 5;
    const ICE_SLIDE_STOP_DISTANCE = 1;
    const {
      state,
      moveHistory,
      MOVE_DURATION_MS,
      PLAYER_LIFT_RISE_DURATION_MS,
      PLAYER_LIFT_FALL_DURATION_MS,
      HOLE_FALL_DURATION_MS,
      HOLE_SINK_DISTANCE
    } = app;
    const {
      restoreTerrainState,
      computeRaisedPlayerGateSet,
      easeOutBack,
      easeInOutQuad,
      syncFloatingFloorTicker,
      applyLevelState
    } = app;
    let movement = null;

    function fadeAlphaForMoveProgress(progress, fadeStartProgress = 0, fadeEndProgress = 1) {
      if (progress <= fadeStartProgress) {
        return 1;
      }

      if (progress >= fadeEndProgress) {
        return 0;
      }

      const duration = Math.max(0.0001, fadeEndProgress - fadeStartProgress);
      const localProgress = (progress - fadeStartProgress) / duration;
      return 1 - easeInOutQuad(localProgress);
    }

    function moveDistance({ fromX, fromY, toX, toY }) {
      return Math.abs(toX - fromX) + Math.abs(toY - fromY);
    }

    function iceSlideDuration(distance) {
      if (distance <= 0 || MOVE_DURATION_MS <= 0) {
        return 0;
      }

      if (isShortIceSlide(distance)) {
        return shortIceSlideDuration(distance);
      }

      const accelerationDurationMs = iceSlideAccelerationDuration();
      const stopDurationMs = iceSlideStopDuration();
      const cruiseDistance =
        distance - ICE_SLIDE_ACCELERATION_DISTANCE - ICE_SLIDE_STOP_DISTANCE;
      const cruiseDurationMs =
        (cruiseDistance * MOVE_DURATION_MS) / ICE_SLIDE_TOP_SPEED_MULTIPLIER;

      return accelerationDurationMs + cruiseDurationMs + stopDurationMs;
    }

    function isShortIceSlide(distance) {
      return distance < ICE_SLIDE_ACCELERATION_DISTANCE + ICE_SLIDE_STOP_DISTANCE;
    }

    function shortIceSlideDuration(distance) {
      return Math.max(
        MOVE_DURATION_MS,
        (distance * 1.5 * MOVE_DURATION_MS) / ICE_SLIDE_TOP_SPEED_MULTIPLIER
      );
    }

    function iceSlideAccelerationDuration() {
      return (
        ((ICE_SLIDE_ACCELERATION_DISTANCE * 1.5) / ICE_SLIDE_TOP_SPEED_MULTIPLIER) *
        MOVE_DURATION_MS
      );
    }

    function iceSlideStopDuration() {
      return (
        ((ICE_SLIDE_STOP_DISTANCE * 3) / ICE_SLIDE_TOP_SPEED_MULTIPLIER) *
        MOVE_DURATION_MS
      );
    }

    function iceSlideAccelerationEase(progress) {
      return 1.5 * progress * progress - 0.5 * progress * progress * progress;
    }

    function iceSlideShortEase(progress) {
      return progress * progress * (3 - 2 * progress);
    }

    function iceSlideStopEase(progress) {
      return 1 - Math.pow(1 - progress, 3);
    }

    function forwardIceSlideProgress(elapsedMs, distance) {
      if (distance <= 0 || MOVE_DURATION_MS <= 0) {
        return 1;
      }

      const durationMs = iceSlideDuration(distance);
      const timeProgress = Math.min(1, Math.max(0, elapsedMs / durationMs));

      if (isShortIceSlide(distance)) {
        return iceSlideShortEase(timeProgress);
      }

      let traveledDistance = 0;
      const accelerationDurationMs = iceSlideAccelerationDuration();
      const stopDurationMs = iceSlideStopDuration();
      const cruiseDistance =
        distance - ICE_SLIDE_ACCELERATION_DISTANCE - ICE_SLIDE_STOP_DISTANCE;
      const cruiseDurationMs =
        (cruiseDistance * MOVE_DURATION_MS) / ICE_SLIDE_TOP_SPEED_MULTIPLIER;

      if (elapsedMs < accelerationDurationMs) {
        const progress = Math.max(0, elapsedMs / accelerationDurationMs);
        traveledDistance = ICE_SLIDE_ACCELERATION_DISTANCE * iceSlideAccelerationEase(progress);
      } else if (elapsedMs < accelerationDurationMs + cruiseDurationMs) {
        traveledDistance =
          ICE_SLIDE_ACCELERATION_DISTANCE +
          ((elapsedMs - accelerationDurationMs) * ICE_SLIDE_TOP_SPEED_MULTIPLIER) /
            MOVE_DURATION_MS;
      } else {
        const stopProgress = Math.min(
          1,
          Math.max(0, (elapsedMs - accelerationDurationMs - cruiseDurationMs) / stopDurationMs)
        );
        traveledDistance =
          ICE_SLIDE_ACCELERATION_DISTANCE +
          cruiseDistance +
          ICE_SLIDE_STOP_DISTANCE * iceSlideStopEase(stopProgress);
      }

      return Math.min(1, traveledDistance / distance);
    }

    function iceSlideProgress(elapsedMs, distance, reverse = false) {
      if (!reverse) {
        return forwardIceSlideProgress(elapsedMs, distance);
      }

      const duration = iceSlideDuration(distance);
      return 1 - forwardIceSlideProgress(Math.max(0, duration - elapsedMs), distance);
    }

    function moveDurationFor(move) {
      const distance = moveDistance(move);

      if (move.iceSlide) {
        return iceSlideDuration(distance);
      }

      return MOVE_DURATION_MS * distance;
    }

    function runQueuedAction() {
      if (!app.queuedAction) {
        return;
      }

      const nextAction = app.queuedAction;
      app.queuedAction = null;
      runAction(nextAction);
    }

    function finishAnimation(moves, options = {}) {
      const onFinish = typeof options.onFinish === "function" ? options.onFinish : null;
      movement.applyMoveFinalState(moves);
      app.gateRenderOverride = null;
      app.isAnimating = false;
      app.animationFrameId = null;
      syncFloatingFloorTicker();
      app.render();

      if (onFinish) {
        onFinish();
        return;
      }

      runQueuedAction();
    }

    function animateMoves(moves, durationMs = null, options = {}) {
      if (moves.length === 0) {
        return;
      }

      app.isAnimating = true;
      const startLiftPhaseCallback =
        typeof options.startLiftPhase === "function" ? options.startLiftPhase : null;
      const liftPhaseFirst = options.liftPhaseFirst === true;
      const holeStateMoves = moves.filter(
        ({
          fromRemoved = false,
          toRemoved = false,
          skipHoleFall = false,
          snapHoleRestore = false
        }) => !skipHoleFall && !snapHoleRestore && fromRemoved !== toRemoved
      );
      const liftStateMoves = moves.filter(
        ({ fromElevation = 0, toElevation = fromElevation }) => fromElevation !== toElevation
      );
      const moveDuration =
        typeof durationMs === "number"
          ? durationMs
          : Math.max(MOVE_DURATION_MS, ...moves.map(moveDurationFor));
      const useIceSlideTiming = typeof durationMs !== "number";

      function startLiftPhase(nextPhase) {
        if (startLiftPhaseCallback) {
          startLiftPhaseCallback();
          app.render();
        }

        if (liftStateMoves.length === 0) {
          nextPhase();
          return;
        }

        const liftStartTime = performance.now();

        function stepLift(now) {
          let hasActiveLift = false;

          moves.forEach(
            ({
              actor,
              fromX,
              fromY,
              toX,
              toY,
              fromElevation = actor.elevation ?? 0,
              toElevation = fromElevation,
              fromRemoved = false,
              visibleDuringMove = false,
              fadeOut = false,
              toRemoved = false
            }) => {
              actor.renderX = liftPhaseFirst ? fromX : toX;
              actor.renderY = liftPhaseFirst ? fromY : toY;
              actor.renderInHole = false;

              if (fromRemoved && !visibleDuringMove) {
                actor.renderScale = 0;
                actor.renderSink = HOLE_SINK_DISTANCE;
              } else {
                actor.renderScale = 1;
                actor.renderSink = 0;
              }

              if (fromElevation === toElevation) {
                actor.renderElevation = toElevation;
                actor.renderAlpha = fadeOut && toRemoved ? 0 : 1;
                return;
              }

              const duration =
                toElevation > fromElevation
                  ? PLAYER_LIFT_RISE_DURATION_MS
                  : PLAYER_LIFT_FALL_DURATION_MS;
              const progress = Math.min(1, (now - liftStartTime) / duration);
              const eased =
                toElevation > fromElevation ? easeOutBack(progress) : easeInOutQuad(progress);

              actor.renderElevation = fromElevation + (toElevation - fromElevation) * eased;
              actor.renderAlpha = fadeOut && toRemoved ? 0 : 1;

              if (progress < 1) {
                hasActiveLift = true;
              }
            }
          );

          app.render();

          if (hasActiveLift) {
            app.animationFrameId = window.requestAnimationFrame(stepLift);
            return;
          }

          nextPhase();
        }

        app.animationFrameId = window.requestAnimationFrame(stepLift);
      }

      function startMovePhase(useToElevation = false) {
        const moveStartTime = performance.now();

        function step(now) {
          const elapsedMs = now - moveStartTime;
          const progress = moveDuration <= 0 ? 1 : Math.min(1, elapsedMs / moveDuration);
          const eased = easeInOutQuad(progress);

          moves.forEach(
            ({
              actor,
              fromX,
              fromY,
              toX,
              toY,
              fromRemoved = false,
              visibleDuringMove = false,
              fromElevation = actor.elevation ?? 0,
              toElevation = fromElevation,
              fadeOut = false,
              toRemoved = false,
              fadeStartProgress = 0,
              fadeEndProgress = 1,
              iceSlide = false,
              reverseIceSlide = false
            }) => {
              const positionProgress = useIceSlideTiming && iceSlide
                ? iceSlideProgress(
                    elapsedMs,
                    moveDistance({ fromX, fromY, toX, toY }),
                    reverseIceSlide
                  )
                : eased;
              actor.renderX = fromX + (toX - fromX) * positionProgress;
              actor.renderY = fromY + (toY - fromY) * positionProgress;
              actor.renderElevation = useToElevation ? toElevation : fromElevation;
              actor.renderInHole = false;
              actor.renderAlpha =
                fadeOut && toRemoved
                  ? fadeAlphaForMoveProgress(progress, fadeStartProgress, fadeEndProgress)
                  : 1;

              if (fromRemoved && !visibleDuringMove) {
                actor.renderScale = 0;
                actor.renderSink = HOLE_SINK_DISTANCE;
                return;
              }

              actor.renderScale = 1;
              actor.renderSink = 0;
            }
          );

          app.render();

          if (progress < 1) {
            app.animationFrameId = window.requestAnimationFrame(step);
            return;
          }

          if (liftPhaseFirst) {
            startFallPhase();
            return;
          }

          startLiftPhase(startFallPhase);
        }

        app.animationFrameId = window.requestAnimationFrame(step);
      }

      function startFallPhase() {
        if (holeStateMoves.length === 0) {
          finishAnimation(moves, options);
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
              skipHoleFall = false,
              toElevation = actor.elevation ?? 0,
              fadeOut = false
            }) => {
              actor.renderX = toX;
              actor.renderY = toY;
              actor.renderElevation = toElevation;
              actor.renderInHole = !skipHoleFall && fromRemoved !== toRemoved;
              actor.renderAlpha = fadeOut && toRemoved ? 0 : 1;

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

          app.render();

          if (progress < 1) {
            app.animationFrameId = window.requestAnimationFrame(stepFall);
            return;
          }

          finishAnimation(moves, options);
        }

        app.animationFrameId = window.requestAnimationFrame(stepFall);
      }

      if (app.animationFrameId !== null) {
        window.cancelAnimationFrame(app.animationFrameId);
      }

      if (liftPhaseFirst) {
        startLiftPhase(() => {
          startMovePhase(true);
        });
        return;
      }

      startMovePhase(false);
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
        const fromElevation = actor.elevation ?? 0;
        const toElevation = target.elevation ?? 0;
        actor.x = target.x;
        actor.y = target.y;
        actor.elevation = toElevation;

        if (!toRemoved) {
          actor.removed = false;
        }

        if (
          fromX === target.x &&
          fromY === target.y &&
          fromRemoved === toRemoved &&
          fromElevation === toElevation
        ) {
          actor.renderX = target.x;
          actor.renderY = target.y;
          actor.renderElevation = toElevation;
          actor.renderScale = toRemoved ? 0 : 1;
          actor.renderAlpha = toRemoved ? 0 : 1;
          actor.renderSink = toRemoved ? HOLE_SINK_DISTANCE : 0;
          actor.renderInHole = false;
          actor.removed = toRemoved;
          return;
        }

        actor.renderX = fromX;
        actor.renderY = fromY;
        actor.renderElevation = fromElevation;
        actor.renderScale = fromRemoved ? 0 : 1;
        actor.renderAlpha = fromRemoved ? 0 : 1;
        actor.renderSink = fromRemoved ? HOLE_SINK_DISTANCE : 0;
        actor.renderInHole = false;
        moves.push({
          actor,
          actorIndex: index,
          fromX,
          fromY,
          toX: target.x,
          toY: target.y,
          fromRemoved,
          toRemoved,
          fromElevation,
          toElevation,
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

    function tryMovePlayersInstant(dx, dy) {
      if (app.isAnimating || app.isTransitioningLevel) {
        return {
          moved: false,
          moves: [],
          blocked: true
        };
      }

      return movement.performPlayerMove(dx, dy, {
        animate: false,
        recordHistory: false
      });
    }

    function movePlayers(dx, dy) {
      if (app.isAnimating || app.isTransitioningLevel) {
        app.queuedAction = { type: "move", dx, dy };
        return;
      }

      const edgeTransition =
        typeof app.edgeTransitionForMove === "function" ? app.edgeTransitionForMove(dx, dy) : null;

      if (edgeTransition) {
        void app.transitionToAdjacentLevel(edgeTransition);
        return;
      }

      movement.performPlayerMove(dx, dy, {
        animate: true,
        recordHistory: true
      });
    }

    function undoMove() {
      if (app.isAnimating || app.isTransitioningLevel) {
        app.queuedAction = { type: "undo" };
        return;
      }

      const previousState = moveHistory.pop();

      if (!previousState) {
        return;
      }

      if (previousState.kind === "level-transition") {
        applyLevelState(previousState.level, {
          updateUrl: true,
          immediateCamera: true
        });
        if (typeof app.restoreLevelEntryState === "function") {
          app.restoreLevelEntryState(previousState.entry);
        }
        syncFloatingFloorTicker();
        app.render();
        return;
      }

      const raisedPlayerGates = computeRaisedPlayerGateSet();
      const moves = buildMovesToPositions(previousState.actors);
      movement.applyUndoIceSlideMetadata(moves, previousState);
      const hasLiftReversal = moves.some(
        ({ fromElevation = 0, toElevation = fromElevation }) => fromElevation !== toElevation
      );

      if (moves.length > 0) {
        if (hasLiftReversal) {
          app.gateRenderOverride = raisedPlayerGates;
          animateMoves(moves, null, {
            liftPhaseFirst: true,
            startLiftPhase: () => {
              restoreTerrainState(previousState.terrain);
              app.gateRenderOverride = null;
            }
          });
          return;
        }

        restoreTerrainState(previousState.terrain);
        app.gateRenderOverride = raisedPlayerGates;
        animateMoves(moves);
        return;
      }

      restoreTerrainState(previousState.terrain);
      app.gateRenderOverride = null;
      syncFloatingFloorTicker();
      app.render();
    }

    function resetPositions() {
      if (app.isAnimating || app.isTransitioningLevel) {
        app.queuedAction = { type: "reset" };
        return;
      }

      moveHistory.length = 0;
      restoreTerrainState(app.initialTerrain);
      app.gateRenderOverride = computeRaisedPlayerGateSet();
      const moves = buildMovesToPositions(app.initialPositions);

      if (moves.length > 0) {
        animateMoves(moves, MOVE_DURATION_MS);
        return;
      }

      app.gateRenderOverride = null;
      syncFloatingFloorTicker();
      app.render();
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

    Object.assign(app, {
      finishAnimation,
      animateMoves,
      buildMovesToPositions,
      tryMovePlayersInstant,
      movePlayers,
      undoMove,
      resetPositions,
      runQueuedAction,
      runAction,
      handleKeydown,
      preventScroll
    });

    if (typeof modules.createMovementController === "function") {
      movement = modules.createMovementController(app);
      app.movement = movement;
    } else if (typeof modules.registerMovementFunctions === "function") {
      movement = modules.registerMovementFunctions(app);
    }

    if (!movement) {
      throw new Error("play-movement.js must be loaded before play-gameplay.js");
    }

    if (typeof modules.registerWorldTransitionFunctions === "function") {
      modules.registerWorldTransitionFunctions(app);
    }
  };
})();
