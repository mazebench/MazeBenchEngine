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
      computeRaisedOrangeWallSet,
      easeOutBack,
      easeInOutQuad,
      syncFloatingFloorTicker,
      applyLevelState
    } = app;
    let movement = null;
    const ANIMATION_STARTUP_GRACE_MS = 1000 / 60;
    const MAX_ANIMATION_FRAME_STEP_MS = 1000 / 30;
    const SYNTHETIC_FRAME_DELTA_EPSILON_MS = 0.5;
    const HOLE_FADE_START_PROGRESS = 0.42;
    const HOLE_PRE_FADE_SINK_DISTANCE = Math.max(HOLE_SINK_DISTANCE * 0.62, app.TILE_SIZE * 2);
    const HOLE_FADE_SINK_DISTANCE = Math.max(HOLE_SINK_DISTANCE * 0.72, app.TILE_SIZE * 2);

    function createAnimationElapsedTracker() {
      const replayFrameStepMs = Number(app.replayAnimationFrameStepMs);

      if (Number.isFinite(replayFrameStepMs) && replayFrameStepMs > 0) {
        let replayElapsedMs = 0;

        return function replayAnimationElapsed() {
          replayElapsedMs += replayFrameStepMs;
          return replayElapsedMs;
        };
      }

      const requestedAt = performance.now();
      let elapsedMs = 0;
      let previousNow = null;

      return function animationElapsed(now) {
        if (previousNow === null) {
          elapsedMs = Math.min(
            Math.max(0, now - requestedAt),
            ANIMATION_STARTUP_GRACE_MS
          );
          previousNow = now;
          return elapsedMs;
        }

        let deltaMs = now - previousNow;

        if (deltaMs < SYNTHETIC_FRAME_DELTA_EPSILON_MS) {
          deltaMs = MAX_ANIMATION_FRAME_STEP_MS;
        }

        elapsedMs += Math.min(Math.max(0, deltaMs), MAX_ANIMATION_FRAME_STEP_MS);
        previousNow = now;
        return elapsedMs;
      };
    }

    function localAnimationProgress(progress, start, duration) {
      return Math.max(0, Math.min(1, (progress - start) / Math.max(0.0001, duration)));
    }

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

    function holeFallAlphaForProgress(progress) {
      return fadeAlphaForMoveProgress(progress, HOLE_FADE_START_PROGRESS, 1);
    }

    function holeFallSinkForProgress(progress) {
      const preFadeProgress = easeInOutQuad(
        localAnimationProgress(progress, 0, HOLE_FADE_START_PROGRESS)
      );
      const fadeProgress = easeInOutQuad(
        localAnimationProgress(progress, HOLE_FADE_START_PROGRESS, 1 - HOLE_FADE_START_PROGRESS)
      );

      return HOLE_PRE_FADE_SINK_DISTANCE * preFadeProgress + HOLE_FADE_SINK_DISTANCE * fadeProgress;
    }

    function moveDistance({ fromX, fromY, toX, toY }) {
      return Math.abs(toX - fromX) + Math.abs(toY - fromY);
    }

    function normalizedMovePath(move) {
      if (!Array.isArray(move.path) || move.path.length < 2) {
        return [
          {
            x: move.fromX,
            y: move.fromY,
            elevation: move.fromElevation ?? move.actor?.elevation ?? 0
          },
          {
            x: move.toX,
            y: move.toY,
            elevation: move.toElevation ?? move.fromElevation ?? move.actor?.elevation ?? 0
          }
        ];
      }

      return move.path
        .map((point) => ({
          x: Number(point?.x),
          y: Number(point?.y),
          elevation: Number(point?.elevation)
        }))
        .filter(
          (point) =>
            Number.isFinite(point.x) &&
            Number.isFinite(point.y) &&
            Number.isFinite(point.elevation)
        );
    }

    function pathSegmentDistance(from, to) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.elevation - from.elevation;

      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    function pathDistanceFor(move) {
      const path = normalizedMovePath(move);
      let distance = 0;

      for (let index = 1; index < path.length; index += 1) {
        distance += pathSegmentDistance(path[index - 1], path[index]);
      }

      return distance;
    }

    function pointAlongPath(move, progress) {
      const path = normalizedMovePath(move);

      if (path.length === 0) {
        return {
          x: move.toX,
          y: move.toY,
          elevation: move.toElevation ?? move.fromElevation ?? move.actor?.elevation ?? 0
        };
      }

      if (path.length === 1) {
        return path[0];
      }

      const totalDistance = pathDistanceFor(move);

      if (totalDistance <= 0) {
        return path[path.length - 1];
      }

      let remainingDistance = totalDistance * Math.max(0, Math.min(1, progress));

      for (let index = 1; index < path.length; index += 1) {
        const from = path[index - 1];
        const to = path[index];
        const segmentDistanceValue = pathSegmentDistance(from, to);

        if (remainingDistance > segmentDistanceValue && index < path.length - 1) {
          remainingDistance -= segmentDistanceValue;
          continue;
        }

        const segmentProgress =
          segmentDistanceValue <= 0 ? 1 : Math.max(0, Math.min(1, remainingDistance / segmentDistanceValue));

        return {
          x: from.x + (to.x - from.x) * segmentProgress,
          y: from.y + (to.y - from.y) * segmentProgress,
          elevation: from.elevation + (to.elevation - from.elevation) * segmentProgress
        };
      }

      return path[path.length - 1];
    }

    function pointAlongPathDistance(move, traveledDistance) {
      const path = normalizedMovePath(move);

      if (path.length === 0) {
        return {
          x: move.toX,
          y: move.toY,
          elevation: move.toElevation ?? move.fromElevation ?? move.actor?.elevation ?? 0
        };
      }

      if (path.length === 1) {
        return path[0];
      }

      const totalDistance = pathDistanceFor(move);

      if (totalDistance <= 0) {
        return path[path.length - 1];
      }

      let remainingDistance = Math.max(0, Math.min(totalDistance, traveledDistance));

      for (let index = 1; index < path.length; index += 1) {
        const from = path[index - 1];
        const to = path[index];
        const segmentDistanceValue = pathSegmentDistance(from, to);

        if (remainingDistance > segmentDistanceValue && index < path.length - 1) {
          remainingDistance -= segmentDistanceValue;
          continue;
        }

        const segmentProgress =
          segmentDistanceValue <= 0 ? 1 : Math.max(0, Math.min(1, remainingDistance / segmentDistanceValue));

        return {
          x: from.x + (to.x - from.x) * segmentProgress,
          y: from.y + (to.y - from.y) * segmentProgress,
          elevation: from.elevation + (to.elevation - from.elevation) * segmentProgress
        };
      }

      return path[path.length - 1];
    }

    function pathPointMatches(left, right) {
      return (
        Math.abs(left.x - right.x) < 0.0001 &&
        Math.abs(left.y - right.y) < 0.0001 &&
        Math.abs(left.elevation - right.elevation) < 0.0001
      );
    }

    function pathDistanceToPoint(move, targetPoint) {
      const path = normalizedMovePath(move);
      let distance = 0;

      if (path.length === 0) {
        return null;
      }

      if (pathPointMatches(path[0], targetPoint)) {
        return 0;
      }

      for (let index = 1; index < path.length; index += 1) {
        const from = path[index - 1];
        const to = path[index];
        const segmentDistanceValue = pathSegmentDistance(from, to);

        if (pathPointMatches(to, targetPoint)) {
          return distance + segmentDistanceValue;
        }

        distance += segmentDistanceValue;
      }

      return null;
    }

    function pointAlongPathToPoint(move, targetPoint, progress) {
      const targetDistance = pathDistanceToPoint(move, targetPoint);

      if (targetDistance === null) {
        return pointAlongPath(move, progress);
      }

      return pointAlongPathDistance(move, targetDistance * Math.max(0, Math.min(1, progress)));
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

    function iceSlideProgressForDuration(elapsedMs, distance, durationMs, reverse = false) {
      const nativeDurationMs = iceSlideDuration(distance);

      if (
        nativeDurationMs <= 0 ||
        !Number.isFinite(durationMs) ||
        durationMs <= nativeDurationMs
      ) {
        return iceSlideProgress(elapsedMs, distance, reverse);
      }

      return iceSlideProgress(
        (Math.max(0, elapsedMs) / durationMs) * nativeDurationMs,
        distance,
        reverse
      );
    }

    function moveDurationFor(move) {
      const distance = Array.isArray(move.path) ? pathDistanceFor(move) : moveDistance(move);

      if (move.iceSlide) {
        return iceSlideDuration(distance);
      }

      return MOVE_DURATION_MS * distance;
    }

    function hasPunchStart(move) {
      return typeof move.punchStartX === "number" && typeof move.punchStartY === "number";
    }

    function isPunchVisualMove(move) {
      return move.visualOnly === true && move.punchEffect === true;
    }

    function normalizedPunchSegments(move) {
      if (!Array.isArray(move.punchSegments)) {
        return [];
      }

      return move.punchSegments
        .map((segment) => ({
          sequence: Number(segment?.sequence),
          fromX: Number(segment?.fromX),
          fromY: Number(segment?.fromY),
          fromElevation: Number(segment?.fromElevation),
          toX: Number(segment?.toX),
          toY: Number(segment?.toY),
          toElevation: Number(segment?.toElevation),
          startIceSlide: segment?.startIceSlide === true,
          punchSlide: segment?.punchSlide === true
        }))
        .filter(
          (segment) =>
            Number.isFinite(segment.sequence) &&
            Number.isFinite(segment.fromX) &&
            Number.isFinite(segment.fromY) &&
            Number.isFinite(segment.fromElevation) &&
            Number.isFinite(segment.toX) &&
            Number.isFinite(segment.toY) &&
            Number.isFinite(segment.toElevation)
        )
        .sort((left, right) => left.sequence - right.sequence);
    }

    function firstPunchSegment(move) {
      const segments = normalizedPunchSegments(move);
      return segments.length > 0 ? segments[0] : null;
    }

    function punchSegmentDistance(segment) {
      return pathSegmentDistance(
        { x: segment.fromX, y: segment.fromY, elevation: segment.fromElevation },
        { x: segment.toX, y: segment.toY, elevation: segment.toElevation }
      );
    }

    function punchSegmentDurationFor(move, segment) {
      return segmentDuration(
        punchSegmentDistance(segment),
        segment.punchSlide === true || move.punchSlide === true || move.iceSlide === true
      );
    }

    function segmentDistance(fromX, fromY, toX, toY) {
      return Math.abs(toX - fromX) + Math.abs(toY - fromY);
    }

    function segmentDuration(distance, iceSlide = false) {
      if (distance <= 0) {
        return 0;
      }

      return iceSlide ? iceSlideDuration(distance) : MOVE_DURATION_MS * distance;
    }

    function punchPhaseOneDistance(move) {
      if (isPunchVisualMove(move)) {
        return 0;
      }

      const firstSegment = firstPunchSegment(move);

      if (firstSegment && Array.isArray(move.path) && move.path.length > 1) {
        const distanceToPunch = pathDistanceToPoint(move, {
          x: firstSegment.fromX,
          y: firstSegment.fromY,
          elevation: firstSegment.fromElevation
        });

        return distanceToPunch === null ? pathDistanceFor(move) : distanceToPunch;
      }

      if (firstSegment) {
        return pathSegmentDistance(
          { x: move.fromX, y: move.fromY, elevation: move.fromElevation ?? 0 },
          { x: firstSegment.fromX, y: firstSegment.fromY, elevation: firstSegment.fromElevation }
        );
      }

      if (hasPunchStart(move) && Array.isArray(move.path) && move.path.length > 1) {
        return pathDistanceFor(move);
      }

      if (hasPunchStart(move)) {
        return segmentDistance(move.fromX, move.fromY, move.punchStartX, move.punchStartY);
      }

      return moveDistance(move);
    }

    function punchPhaseTwoDistance(move) {
      if (isPunchVisualMove(move)) {
        return moveDistance(move);
      }

      const firstSegment = firstPunchSegment(move);

      if (firstSegment) {
        return punchSegmentDistance(firstSegment);
      }

      if (hasPunchStart(move)) {
        return segmentDistance(move.punchStartX, move.punchStartY, move.toX, move.toY);
      }

      return 0;
    }

    function punchPhaseOneDurationFor(move) {
      return segmentDuration(
        punchPhaseOneDistance(move),
        hasPunchStart(move) ? move.punchStartIceSlide === true : move.iceSlide === true
      );
    }

    function punchPhaseTwoDurationFor(move) {
      return segmentDuration(
        punchPhaseTwoDistance(move),
        isPunchVisualMove(move) || move.punchSlide === true || move.iceSlide === true
      );
    }

    function punchRetractDistance(move) {
      if (!isPunchVisualMove(move)) {
        return 0;
      }

      return segmentDistance(
        move.toX,
        move.toY,
        typeof move.finalX === "number" ? move.finalX : move.fromX,
        typeof move.finalY === "number" ? move.finalY : move.fromY
      );
    }

    function punchRetractDurationFor(move) {
      return segmentDuration(punchRetractDistance(move), isPunchVisualMove(move));
    }

    function punchSequenceForVisualMove(move) {
      const sequence = Number(move.punchSequence);
      return Number.isFinite(sequence) ? sequence : 0;
    }

    function buildPunchSequenceTimings(moves, initialDuration, retractPunchDuringFall) {
      const sequenceSet = new Set();

      moves.forEach((move) => {
        normalizedPunchSegments(move).forEach((segment) => {
          sequenceSet.add(segment.sequence);
        });

        if (isPunchVisualMove(move)) {
          sequenceSet.add(punchSequenceForVisualMove(move));
        }
      });

      const sequences = Array.from(sequenceSet).sort((left, right) => left - right);
      const timings = new Map();
      let cursor = initialDuration;
      let totalDuration = initialDuration;

      sequences.forEach((sequence) => {
        let punchDuration = MOVE_DURATION_MS;
        let retractDuration = 0;

        moves.forEach((move) => {
          normalizedPunchSegments(move)
            .filter((segment) => segment.sequence === sequence)
            .forEach((segment) => {
              punchDuration = Math.max(punchDuration, punchSegmentDurationFor(move, segment));
            });

          if (isPunchVisualMove(move) && punchSequenceForVisualMove(move) === sequence) {
            punchDuration = Math.max(punchDuration, punchPhaseTwoDurationFor(move));

            if (!retractPunchDuringFall) {
              retractDuration = Math.max(retractDuration, punchRetractDurationFor(move));
            }
          }
        });

        const timing = {
          sequence,
          start: cursor,
          punchDuration,
          retractDuration,
          punchEnd: cursor + punchDuration,
          retractEnd: cursor + punchDuration + retractDuration
        };

        timings.set(sequence, timing);
        cursor = timing.punchEnd;
        totalDuration = Math.max(totalDuration, timing.retractEnd);
      });

      return { timings, totalDuration };
    }

    function segmentProgress(elapsedMs, distance, durationMs, iceSlide = false, reverse = false) {
      if (distance <= 0) {
        return 1;
      }

      if (iceSlide) {
        return iceSlideProgressForDuration(elapsedMs, distance, durationMs, reverse);
      }

      const progress = durationMs <= 0 ? 1 : Math.min(1, elapsedMs / durationMs);
      return easeInOutQuad(progress);
    }

    function runQueuedAction() {
      if (!app.queuedAction) {
        return;
      }

      const nextAction = app.queuedAction;
      app.queuedAction = null;
      runAction(nextAction);
    }

    function syncSurfaceAnimationTargets(now) {
      app.liveRaisedPlayerGates = app.gateRenderOverride || computeRaisedPlayerGateSet();
      app.liveRaisedOrangeWalls = app.orangeWallRenderOverride || computeRaisedOrangeWallSet();
      app.syncGateAnimationTargets?.(now);
      app.syncOrangeWallAnimationTargets?.(now);
      app.syncPlayerLiftAnimationTargets?.(now);
    }

    function liftRenderElevation(fromElevation, toElevation, progress) {
      const eased =
        toElevation > fromElevation ? easeOutBack(progress) : easeInOutQuad(progress);
      const cappedProgress = toElevation > fromElevation ? Math.min(1.08, eased) : eased;

      return fromElevation + (toElevation - fromElevation) * cappedProgress;
    }

    function liftPhaseStartElevationForMove(move) {
      const fromElevation = move.fromElevation ?? move.actor?.elevation ?? 0;

      if (move.pathControlsElevation === true && Array.isArray(move.path) && move.path.length > 0) {
        const pathEndElevation = pathRenderEndElevationForMove(move);

        if (Number.isFinite(pathEndElevation)) {
          return pathEndElevation;
        }
      }

      return fromElevation;
    }

    function pathRenderEndElevationForMove(move) {
      if (!Array.isArray(move.path) || move.path.length === 0) {
        return null;
      }

      const pathEndElevation = Number(move.path[move.path.length - 1]?.elevation);

      return Number.isFinite(pathEndElevation) ? pathEndElevation : null;
    }

    function shouldDeferPathDropToHoleFall(move) {
      return (
        move.fromRemoved !== true &&
        move.toRemoved === true &&
        move.pathControlsElevation === true &&
        pathRenderEndElevationForMove(move) !== null
      );
    }

    function fallPhaseStartElevationForMove(move) {
      if (shouldDeferPathDropToHoleFall(move)) {
        return pathRenderEndElevationForMove(move);
      }

      return move.toElevation ?? move.actor?.elevation ?? 0;
    }

    function finishAnimation(moves, options = {}) {
      const onFinish = typeof options.onFinish === "function" ? options.onFinish : null;
      movement.applyMoveFinalState(moves);
      app.gateRenderOverride = null;
      app.orangeWallRenderOverride = null;
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
        (move) => {
          if (shouldDeferPathDropToHoleFall(move)) {
            return false;
          }

          const liftFromElevation = liftPhaseStartElevationForMove(move);
          return liftFromElevation !== (move.toElevation ?? liftFromElevation);
        }
      );
      const preTerrainLiftMoveSet =
        options.preTerrainLiftMoves instanceof Set ? options.preTerrainLiftMoves : new Set();
      const preTerrainLiftStateMoves = liftStateMoves.filter((move) =>
        preTerrainLiftMoveSet.has(move)
      );
      const postTerrainLiftStateMoves = liftStateMoves.filter(
        (move) => !preTerrainLiftMoveSet.has(move)
      );
      const hasPunchPhase = moves.some((move) => hasPunchStart(move) || isPunchVisualMove(move));
      const retractPunchDuringFall =
        hasPunchPhase && holeStateMoves.length > 0 && typeof durationMs !== "number";
      const hasSequencedPunchPhase =
        hasPunchPhase &&
        typeof durationMs !== "number" &&
        moves.some(
          (move) =>
            normalizedPunchSegments(move).some((segment) => segment.sequence > 0) ||
            (isPunchVisualMove(move) && punchSequenceForVisualMove(move) > 0)
        );
      const punchPhaseOneDuration =
        hasPunchPhase && typeof durationMs !== "number"
          ? Math.max(MOVE_DURATION_MS, ...moves.map(punchPhaseOneDurationFor))
          : 0;
      const punchSequenceTimings = hasSequencedPunchPhase
        ? buildPunchSequenceTimings(moves, punchPhaseOneDuration, retractPunchDuringFall)
        : { timings: new Map(), totalDuration: 0 };
      const punchPhaseTwoDuration =
        hasPunchPhase && typeof durationMs !== "number"
          ? Math.max(MOVE_DURATION_MS, ...moves.map(punchPhaseTwoDurationFor))
          : 0;
      const punchRetractDuration =
        hasPunchPhase && typeof durationMs !== "number" && !retractPunchDuringFall
          ? Math.max(MOVE_DURATION_MS, ...moves.map(punchRetractDurationFor))
          : 0;
      const moveDuration =
        typeof durationMs === "number"
          ? durationMs
          : hasPunchPhase
            ? hasSequencedPunchPhase
              ? punchSequenceTimings.totalDuration
              : punchPhaseOneDuration + punchPhaseTwoDuration + punchRetractDuration
            : Math.max(MOVE_DURATION_MS, ...moves.map(moveDurationFor));
      const useIceSlideTiming = typeof durationMs !== "number";
      const completedLiftMoves = new Set();

      function runLiftAnimation(activeLiftMoves, nextPhase, options = {}) {
        if (activeLiftMoves.length === 0) {
          nextPhase();
          return;
        }

        const activeLiftMoveSet = new Set(activeLiftMoves);
        const commitElevationAtEnd = options.commitElevationAtEnd === true;
        const elapsedForLift = createAnimationElapsedTracker();
        syncSurfaceAnimationTargets(performance.now());

        function stepLift(now) {
          const elapsedMs = elapsedForLift(now);
          let hasActiveLift = false;

          moves.forEach((move) => {
            const {
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
            } = move;
            const liftFromElevation = liftPhaseStartElevationForMove(move);

            actor.renderPunchEffect =
              retractPunchDuringFall && isPunchVisualMove(move) ? true : false;
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

            if (liftFromElevation === toElevation) {
              actor.renderElevation = toElevation;
              actor.renderAlpha = fadeOut && toRemoved ? 0 : 1;
              return;
            }

            if (!activeLiftMoveSet.has(move)) {
              actor.renderElevation = completedLiftMoves.has(move) ? toElevation : liftFromElevation;
              actor.renderAlpha = fadeOut && toRemoved ? 0 : 1;
              return;
            }

            const duration =
              toElevation > liftFromElevation
                ? PLAYER_LIFT_RISE_DURATION_MS
                : PLAYER_LIFT_FALL_DURATION_MS;
            const progress = Math.min(1, elapsedMs / duration);
            actor.renderElevation = liftRenderElevation(liftFromElevation, toElevation, progress);
            actor.renderAlpha = fadeOut && toRemoved ? 0 : 1;

            if (progress < 1) {
              hasActiveLift = true;
            }
          });

          app.render(now);

          if (hasActiveLift) {
            app.animationFrameId = window.requestAnimationFrame(stepLift);
            return;
          }

          activeLiftMoves.forEach((move) => {
            completedLiftMoves.add(move);

            if (commitElevationAtEnd) {
              move.actor.elevation = move.toElevation ?? move.fromElevation ?? move.actor.elevation ?? 0;
              move.actor.renderElevation = move.actor.elevation;
            }
          });

          nextPhase();
        }

        app.animationFrameId = window.requestAnimationFrame(stepLift);
      }

      function startLiftPhase(nextPhase) {
        const startPostTerrainLiftPhase = () => {
          if (startLiftPhaseCallback) {
            startLiftPhaseCallback();
          }

          runLiftAnimation(postTerrainLiftStateMoves, nextPhase);
        };

        if (preTerrainLiftStateMoves.length > 0) {
          runLiftAnimation(preTerrainLiftStateMoves, startPostTerrainLiftPhase, {
            commitElevationAtEnd: true
          });
          return;
        }

        startPostTerrainLiftPhase();
      }

      function startMovePhase(useToElevation = false) {
        const elapsedForMove = createAnimationElapsedTracker();

        function step(now) {
          const elapsedMs = elapsedForMove(now);
          const progress = moveDuration <= 0 ? 1 : Math.min(1, elapsedMs / moveDuration);
          const eased = easeInOutQuad(progress);

          moves.forEach(
            (move) => {
              const {
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
                reverseIceSlide = false,
                punchEffect = false
              } = move;
              let renderFromX = fromX;
              let renderFromY = fromY;
              let renderToX = toX;
              let renderToY = toY;
              let renderFromElevation = fromElevation;
              let renderToElevation = useToElevation ? toElevation : fromElevation;
              const usesPath = Array.isArray(move.path) && move.path.length > 1;
              const pathDistance = usesPath ? pathDistanceFor(move) : 0;
              let positionProgress = useIceSlideTiming && iceSlide
                ? iceSlideProgressForDuration(
                    elapsedMs,
                    usesPath ? pathDistance : moveDistance({ fromX, fromY, toX, toY }),
                    moveDuration,
                    reverseIceSlide
                  )
                : eased;
              let renderPunchEffect = punchEffect === true;
              let pathPointOverride = null;

              if (hasSequencedPunchPhase && useIceSlideTiming) {
                const punchSegments = normalizedPunchSegments(move);

                if (isPunchVisualMove(move)) {
                  const timing = punchSequenceTimings.timings.get(punchSequenceForVisualMove(move));

                  if (!timing || elapsedMs < timing.start) {
                    renderToX = fromX;
                    renderToY = fromY;
                    renderToElevation = fromElevation;
                    positionProgress = 1;
                    renderPunchEffect = false;
                  } else if (elapsedMs < timing.punchEnd) {
                    const distance = punchPhaseTwoDistance(move);
                    const duration = punchPhaseTwoDurationFor(move);

                    positionProgress = segmentProgress(elapsedMs - timing.start, distance, duration, true);
                    renderPunchEffect = true;
                  } else if (retractPunchDuringFall) {
                    renderFromX = toX;
                    renderFromY = toY;
                    renderToX = toX;
                    renderToY = toY;
                    renderFromElevation = toElevation;
                    renderToElevation = toElevation;
                    positionProgress = 1;
                    renderPunchEffect = true;
                  } else if (elapsedMs < timing.retractEnd) {
                    const finalX = typeof move.finalX === "number" ? move.finalX : fromX;
                    const finalY = typeof move.finalY === "number" ? move.finalY : fromY;
                    const finalElevation =
                      typeof move.finalElevation === "number" ? move.finalElevation : fromElevation;
                    const distance = punchRetractDistance(move);
                    const duration = punchRetractDurationFor(move);

                    renderFromX = toX;
                    renderFromY = toY;
                    renderToX = finalX;
                    renderToY = finalY;
                    renderFromElevation = toElevation;
                    renderToElevation = finalElevation;
                    positionProgress = segmentProgress(
                      elapsedMs - timing.punchEnd,
                      distance,
                      duration,
                      true
                    );
                    renderPunchEffect = true;
                  } else {
                    const finalX = typeof move.finalX === "number" ? move.finalX : fromX;
                    const finalY = typeof move.finalY === "number" ? move.finalY : fromY;
                    const finalElevation =
                      typeof move.finalElevation === "number" ? move.finalElevation : fromElevation;

                    renderFromX = finalX;
                    renderFromY = finalY;
                    renderToX = finalX;
                    renderToY = finalY;
                    renderFromElevation = finalElevation;
                    renderToElevation = finalElevation;
                    positionProgress = 1;
                    renderPunchEffect = false;
                  }
                } else if (punchSegments.length > 0) {
                  const firstSegment = punchSegments[0];

                  if (elapsedMs < punchPhaseOneDuration) {
                    const distance = punchPhaseOneDistance(move);
                    const duration = punchPhaseOneDurationFor(move);

                    positionProgress = segmentProgress(
                      elapsedMs,
                      distance,
                      duration,
                      firstSegment.startIceSlide === true,
                      reverseIceSlide
                    );

                    if (usesPath) {
                      pathPointOverride = pointAlongPathToPoint(
                        move,
                        {
                          x: firstSegment.fromX,
                          y: firstSegment.fromY,
                          elevation: firstSegment.fromElevation
                        },
                        positionProgress
                      );
                    } else {
                      renderToX = firstSegment.fromX;
                      renderToY = firstSegment.fromY;
                      renderToElevation = firstSegment.fromElevation;
                    }
                  } else {
                    let activeSegment = null;
                    let activeTiming = null;
                    let lastCompletedSegment = null;

                    for (let index = 0; index < punchSegments.length; index += 1) {
                      const segment = punchSegments[index];
                      const timing = punchSequenceTimings.timings.get(segment.sequence);

                      if (!timing) {
                        continue;
                      }

                      if (elapsedMs < timing.start) {
                        break;
                      }

                      if (elapsedMs < timing.punchEnd) {
                        activeSegment = segment;
                        activeTiming = timing;
                        break;
                      }

                      lastCompletedSegment = segment;
                    }

                    const renderSegment = activeSegment || lastCompletedSegment || firstSegment;

                    if (activeSegment && activeTiming) {
                      const distance = punchSegmentDistance(activeSegment);
                      const duration = punchSegmentDurationFor(move, activeSegment);

                      renderFromX = activeSegment.fromX;
                      renderFromY = activeSegment.fromY;
                      renderToX = activeSegment.toX;
                      renderToY = activeSegment.toY;
                      renderFromElevation = activeSegment.fromElevation;
                      renderToElevation = activeSegment.toElevation;
                      positionProgress = segmentProgress(
                        elapsedMs - activeTiming.start,
                        distance,
                        duration,
                        activeSegment.punchSlide === true ||
                          move.punchSlide === true ||
                          iceSlide === true
                      );
                    } else {
                      renderFromX = renderSegment.toX;
                      renderFromY = renderSegment.toY;
                      renderToX = renderSegment.toX;
                      renderToY = renderSegment.toY;
                      renderFromElevation = renderSegment.toElevation;
                      renderToElevation = renderSegment.toElevation;
                      positionProgress = 1;
                    }
                  }
                } else if (elapsedMs >= punchPhaseOneDuration) {
                  renderFromX = toX;
                  renderFromY = toY;
                  renderToX = toX;
                  renderToY = toY;
                  renderFromElevation = toElevation;
                  renderToElevation = toElevation;
                  positionProgress = 1;
                  renderPunchEffect = false;
                } else {
                  const distance = punchPhaseOneDistance(move);
                  const duration = punchPhaseOneDurationFor(move);

                  positionProgress = segmentProgress(elapsedMs, distance, duration, iceSlide, reverseIceSlide);
                }
              } else if (hasPunchPhase && useIceSlideTiming) {
                const punchPhaseTwoStart = punchPhaseOneDuration;
                const punchRetractStart = punchPhaseOneDuration + punchPhaseTwoDuration;
                const inPunchPhase = elapsedMs >= punchPhaseTwoStart;
                const inRetractPhase = !retractPunchDuringFall && elapsedMs >= punchRetractStart;
                const punchElapsedMs = Math.max(0, elapsedMs - punchPhaseTwoStart);
                const retractElapsedMs = Math.max(0, elapsedMs - punchRetractStart);

                if (isPunchVisualMove(move)) {
                  if (inRetractPhase) {
                    const finalX = typeof move.finalX === "number" ? move.finalX : fromX;
                    const finalY = typeof move.finalY === "number" ? move.finalY : fromY;
                    const distance = punchRetractDistance(move);
                    const duration = punchRetractDurationFor(move);

                    renderFromX = toX;
                    renderFromY = toY;
                    renderToX = finalX;
                    renderToY = finalY;
                    positionProgress = segmentProgress(retractElapsedMs, distance, duration, true);
                    renderPunchEffect = true;
                  } else if (inPunchPhase) {
                    const distance = punchPhaseTwoDistance(move);
                    const duration = punchPhaseTwoDurationFor(move);

                    positionProgress = segmentProgress(punchElapsedMs, distance, duration, true);
                    renderPunchEffect = true;
                  } else {
                    renderToX = fromX;
                    renderToY = fromY;
                    positionProgress = 1;
                    renderPunchEffect = false;
                  }
                } else if (hasPunchStart(move)) {
                  if (inRetractPhase) {
                    renderFromX = toX;
                    renderFromY = toY;
                    positionProgress = 1;
                    renderPunchEffect = false;
                  } else if (inPunchPhase) {
                    const distance = punchPhaseTwoDistance(move);
                    const duration = punchPhaseTwoDurationFor(move);

                    renderFromX = move.punchStartX;
                    renderFromY = move.punchStartY;
                    positionProgress = segmentProgress(
                      punchElapsedMs,
                      distance,
                      duration,
                      move.punchSlide === true || iceSlide === true
                    );
                  } else {
                    const distance = punchPhaseOneDistance(move);
                    const duration = punchPhaseOneDurationFor(move);

                    positionProgress = segmentProgress(
                      elapsedMs,
                      distance,
                      duration,
                      move.punchStartIceSlide === true,
                      reverseIceSlide
                    );

                    if (usesPath) {
                      pathPointOverride = pointAlongPath(move, positionProgress);
                    } else {
                      renderToX = move.punchStartX;
                      renderToY = move.punchStartY;
                    }
                  }
                } else if (inPunchPhase) {
                  renderFromX = toX;
                  renderFromY = toY;
                  positionProgress = 1;
                  renderPunchEffect = false;
                } else {
                  const distance = punchPhaseOneDistance(move);
                  const duration = punchPhaseOneDurationFor(move);

                  positionProgress = segmentProgress(elapsedMs, distance, duration, iceSlide, reverseIceSlide);
                }
              }

              if (pathPointOverride) {
                actor.renderX = pathPointOverride.x;
                actor.renderY = pathPointOverride.y;
                actor.renderElevation = pathPointOverride.elevation;
              } else if (usesPath && !hasPunchStart(move) && !isPunchVisualMove(move)) {
                const pathPoint = pointAlongPath(move, positionProgress);

                actor.renderX = pathPoint.x;
                actor.renderY = pathPoint.y;
                actor.renderElevation = pathPoint.elevation;
              } else {
                actor.renderX = renderFromX + (renderToX - renderFromX) * positionProgress;
                actor.renderY = renderFromY + (renderToY - renderFromY) * positionProgress;
                actor.renderElevation =
                  renderFromElevation + (renderToElevation - renderFromElevation) * positionProgress;
              }
              actor.renderInHole = false;
              actor.renderPunchEffect = renderPunchEffect;
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

          app.render(now);

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

        if (retractPunchDuringFall) {
          moves.forEach((move) => {
            if (!isPunchVisualMove(move)) {
              return;
            }

            move.actor.renderX = move.toX;
            move.actor.renderY = move.toY;
            move.actor.renderElevation = move.toElevation ?? move.actor.elevation ?? 0;
            move.actor.renderPunchEffect = true;
            move.actor.renderAlpha = 1;
            move.actor.renderScale = 1;
            move.actor.renderSink = 0;
          });
        }

        const elapsedForFall = createAnimationElapsedTracker();

        function stepFall(now) {
          const elapsedMs = elapsedForFall(now);
          const progress = Math.min(1, elapsedMs / HOLE_FALL_DURATION_MS);
          const eased = easeInOutQuad(progress);

          moves.forEach(
            (move) => {
              const {
                actor,
                toX,
                toY,
                fromRemoved = false,
                toRemoved = false,
                skipHoleFall = false,
                toElevation = actor.elevation ?? 0,
                fadeOut = false
              } = move;
              const fallStartElevation = fallPhaseStartElevationForMove(move);

              if (retractPunchDuringFall && isPunchVisualMove(move)) {
                const finalX = typeof move.finalX === "number" ? move.finalX : move.fromX;
                const finalY = typeof move.finalY === "number" ? move.finalY : move.fromY;

                actor.renderX = toX + (finalX - toX) * eased;
                actor.renderY = toY + (finalY - toY) * eased;
                actor.renderElevation = fallStartElevation;
                actor.renderInHole = false;
                actor.renderPunchEffect = true;
                actor.renderAlpha = 1;
                actor.renderScale = 1;
                actor.renderSink = 0;
                return;
              }

              actor.renderX = toX;
              actor.renderY = toY;
              actor.renderElevation = fallStartElevation;
              actor.renderInHole = !skipHoleFall && fromRemoved !== toRemoved;
              actor.renderPunchEffect = false;
              actor.renderAlpha = fadeOut && toRemoved ? 0 : 1;

              if (skipHoleFall) {
                actor.renderScale = 1;
                actor.renderSink = 0;
                return;
              }

              if (fromRemoved && !toRemoved) {
                actor.renderScale = 1;
                actor.renderAlpha = eased;
                actor.renderSink = HOLE_SINK_DISTANCE * (1 - eased);
                return;
              }

              if (!fromRemoved && toRemoved) {
                actor.renderScale = 1;
                actor.renderAlpha = holeFallAlphaForProgress(progress);
                actor.renderSink = holeFallSinkForProgress(progress);
                return;
              }

              actor.renderScale = toRemoved ? 0 : 1;
              actor.renderSink = toRemoved ? HOLE_SINK_DISTANCE : 0;
            }
          );

          app.render(now);

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

    function buildMovesToPositions(targetPositions, options = {}) {
      const moves = [];
      const collectedGemVisual = options.collectedGemVisual || null;

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
        const isCollectedGemTarget =
          actor.type === "gem" &&
          (target.collected === true ||
            (target.collectionId && app.collectedGemIds?.has?.(target.collectionId)) ||
            (actor.collectionId && app.collectedGemIds?.has?.(actor.collectionId)));
        actor.x = target.x;
        actor.y = target.y;
        actor.elevation = toElevation;
        actor.collectionId = target.collectionId || actor.collectionId || null;
        actor.collected = isCollectedGemTarget;

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
          if (isCollectedGemTarget) {
            if (collectedGemVisual === "ghost" || target.showCollectedGhost === true) {
              app.applyCollectedGemVisual?.(actor);
            } else {
              app.hideCollectedGemVisual?.(actor);
            }
            return;
          }
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
          collectedGemVisual,
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
        durationMs: Number.isFinite(app.replayMoveDurationMs)
          ? app.replayMoveDurationMs
          : null,
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
      const raisedOrangeWalls = computeRaisedOrangeWallSet();
      const moves = buildMovesToPositions(previousState.actors, {
        collectedGemVisual: "hidden"
      });
      movement.applyUndoIceSlideMetadata(moves, previousState);
      const hasLiftReversal = moves.some(
        (move) => {
          const liftFromElevation = liftPhaseStartElevationForMove(move);
          return liftFromElevation !== (move.toElevation ?? liftFromElevation);
        }
      );

      if (moves.length > 0) {
        if (hasLiftReversal) {
          app.gateRenderOverride = raisedPlayerGates;
          app.orangeWallRenderOverride = raisedOrangeWalls;
          animateMoves(moves, null, {
            liftPhaseFirst: true,
            startLiftPhase: () => {
              restoreTerrainState(previousState.terrain);
              app.gateRenderOverride = null;
              app.orangeWallRenderOverride = null;
            }
          });
          return;
        }

        restoreTerrainState(previousState.terrain);
        app.gateRenderOverride = raisedPlayerGates;
        app.orangeWallRenderOverride = raisedOrangeWalls;
        animateMoves(moves);
        return;
      }

      restoreTerrainState(previousState.terrain);
      app.gateRenderOverride = null;
      app.orangeWallRenderOverride = null;
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
      app.orangeWallRenderOverride = computeRaisedOrangeWallSet();
      const moves = buildMovesToPositions(app.initialPositions, {
        collectedGemVisual: "ghost"
      });

      if (moves.length > 0) {
        animateMoves(moves, MOVE_DURATION_MS);
        return;
      }

      app.gateRenderOverride = null;
      app.orangeWallRenderOverride = null;
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
        const [rawDx, rawDy] = directionalMoves[event.key];
        const [dx, dy] =
          typeof app.mapCameraRelativeDirection === "function"
            ? app.mapCameraRelativeDirection(rawDx, rawDy)
            : [rawDx, rawDy];
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
