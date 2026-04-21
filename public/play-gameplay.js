(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.registerGameplayFunctions = function registerGameplayFunctions(app) {
    const WORLD_LEVEL_PATTERN = /^level_([A-Z])x([A-Z])$/;
    const worldColumns =
      Array.isArray(app.worldColumns) && app.worldColumns.length > 0
        ? app.worldColumns
        : Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    const worldRows =
      Array.isArray(app.worldRows) && app.worldRows.length > 0
        ? app.worldRows
        : Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
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
      posKey,
      cloneActorPositions,
      cloneTerrainState,
      restoreTerrainState,
      restoreActorPositions,
      buildOccupiedSet,
      actorsAt,
      actorAt,
      pushEntityKey,
      isPlayerActor,
      actorElevation,
      isCollectibleActor,
      pushWeight,
      isPushableActor,
      pushActorMembers,
      weightlessGroupMembers,
      isInsideBoard,
      terrainAt,
      isWall,
      terrainSurfaceHeightAt,
      playerSurfaceHeightAt,
      isPlayerLift,
      isRaisedPlayerLift,
      setPlayerLiftRaised,
      computeRaisedPlayerGateSet,
      isIce,
      isHole,
      isIceOrHole,
      easeOutBack,
      easeInOutQuad,
      syncFloatingFloorTicker,
      cloneLevelSnapshot,
      applyLevelState,
      loadLevelState,
      captureSceneSnapshot,
      captureForegroundOccluderSnapshot,
      captureViewportSnapshot,
      viewportPositionForActor,
      startLevelTransition
    } = app;

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

    function parseWorldLevelId(levelId) {
      const match = String(levelId || "").match(WORLD_LEVEL_PATTERN);

      if (!match) {
        return null;
      }

      const columnIndex = worldColumns.indexOf(match[1]);
      const rowIndex = worldRows.indexOf(match[2]);

      if (columnIndex === -1 || rowIndex === -1) {
        return null;
      }

      return {
        columnIndex,
        rowIndex
      };
    }

    function worldLevelId(columnIndex, rowIndex) {
      const normalizedColumn = ((columnIndex % worldColumns.length) + worldColumns.length) % worldColumns.length;
      const normalizedRow = ((rowIndex % worldRows.length) + worldRows.length) % worldRows.length;
      return `level_${worldColumns[normalizedColumn]}x${worldRows[normalizedRow]}`;
    }

    function adjacentWorldLevelId(levelId, dx, dy) {
      const coordinates = parseWorldLevelId(levelId);

      if (!coordinates) {
        return null;
      }

      return worldLevelId(coordinates.columnIndex + dx, coordinates.rowIndex + dy);
    }

    function edgeTransitionForMove(dx, dy) {
      const players = state.actors.filter((actor) => isPlayerActor(actor) && !actor.removed);

      if (players.length !== 1) {
        return null;
      }

      const player = players[0];

      if (actorElevation(player) !== 0 || terrainAt(player.x, player.y).type !== "floor") {
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
      const previousLevelSnapshot = cloneLevelSnapshot();
      const previousEntrySnapshot = cloneStoredLevelSnapshot(app.levelEntrySnapshot || previousLevelSnapshot);
      const outgoingCameraX = app.cameraX;
      const outgoingCameraY = app.cameraY;
      const outgoingPlayerPosition = viewportPositionForActor(transition.player);
      const outgoingSceneSnapshot = captureSceneSnapshot({
        skipActorsPredicate: (actor) => isPlayerActor(actor)
      });
      const outgoingForegroundSnapshot = captureForegroundOccluderSnapshot({
        occludingActor: transition.player,
        skipActorsPredicate: (actor) => isPlayerActor(actor)
      });
      const outgoingSnapshot = captureViewportSnapshot({
        skipActorsPredicate: (actor) => isPlayerActor(actor)
      });

      try {
        const nextLevelState = await loadLevelState(transition.nextLevelId);
        const transferredPlayer = {
          type: transition.player.type,
          groupId: transition.player.groupId ?? null,
          label: transition.player.label,
          imageUrl: transition.player.imageUrl || null,
          x: transition.targetX,
          y: transition.targetY,
          removed: false,
          elevation: 0
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

        if (transition.dx !== 0) {
          app.cameraY = outgoingCameraY;
        }

        if (transition.dy !== 0) {
          app.cameraX = outgoingCameraX;
        }

        const incomingPlayer = state.actors.find((actor) => isPlayerActor(actor) && !actor.removed) || null;
        const incomingPlayerPosition = incomingPlayer
          ? viewportPositionForActor(incomingPlayer)
          : outgoingPlayerPosition;
        const incomingSnapshot = captureViewportSnapshot({
          skipActorsPredicate: (actor) => isPlayerActor(actor)
        });
        startLevelTransition(outgoingSnapshot, incomingSnapshot, transition.dx, transition.dy, {
          actor: incomingPlayer ? { ...incomingPlayer } : { ...transition.player },
          from: outgoingPlayerPosition,
          sourceActor: { ...transition.player },
          to: incomingPlayerPosition,
          targetActor: incomingPlayer
        }, {
          canvas: outgoingSceneSnapshot,
          cameraX: outgoingCameraX,
          cameraY: outgoingCameraY,
          boardRect: {
            width: previousLevelSnapshot.width * app.TILE_SIZE,
            height: previousLevelSnapshot.height * app.TILE_SIZE
          },
          viewportRect: {
            width: app.viewportRect.width,
            height: app.viewportRect.height
          }
        }, {
          canvas: outgoingForegroundSnapshot,
          boardRect: {
            width: previousLevelSnapshot.width * app.TILE_SIZE,
            height: previousLevelSnapshot.height * app.TILE_SIZE
          },
          viewportRect: {
            width: app.viewportRect.width,
            height: app.viewportRect.height
          }
        });

        return true;
      } catch (error) {
        console.error(error);
        app.isTransitioningLevel = false;
        return false;
      }
    }

    function canMoveInto(x, y, occupied, gateState = app.liveRaisedPlayerGates) {
      if (!isInsideBoard(x, y)) {
        return false;
      }

      if (isWall(x, y, gateState)) {
        return false;
      }

      return !occupied.has(posKey(x, y));
    }

    function findSlideDestination(startX, startY, dx, dy, occupied, gateState = app.liveRaisedPlayerGates) {
      let nextX = startX;
      let nextY = startY;

      while (canMoveInto(nextX + dx, nextY + dy, occupied, gateState)) {
        nextX += dx;
        nextY += dy;

        if (!isIce(nextX, nextY)) {
          break;
        }
      }

      return { x: nextX, y: nextY };
    }

    function moveBox(box, dx, dy, occupied, moves, gateState = app.liveRaisedPlayerGates) {
      const fromX = box.x;
      const fromY = box.y;
      occupied.delete(posKey(fromX, fromY));

      const target = findSlideDestination(fromX, fromY, dx, dy, occupied, gateState);

      if (target.x === fromX && target.y === fromY) {
        occupied.add(posKey(fromX, fromY));
        return false;
      }

      box.x = target.x;
      box.y = target.y;
      const distance = Math.abs(target.x - fromX) + Math.abs(target.y - fromY);
      moves.push({
        actor: box,
        fromX,
        fromY,
        toX: target.x,
        toY: target.y,
        iceSlide: distance > 1
      });
      occupied.add(posKey(box.x, box.y));
      return true;
    }

    function countSupportingPlayers(player, dx, dy) {
      let count = 1;
      let checkX = player.x;
      let checkY = player.y;

      while (true) {
        checkX -= dx;
        checkY -= dy;

        if (
          !actorAt(
            checkX,
            checkY,
            (actor) => isPlayerActor(actor) && actorElevation(actor) === actorElevation(player)
          )
        ) {
          break;
        }

        count += 1;
      }

      return count;
    }

    function blockingActorAtElevation(x, y, elevation, mover) {
      return actorAt(
        x,
        y,
        (actor) =>
          actor !== mover &&
          !isCollectibleActor(actor) &&
          actorElevation(actor) === elevation
      );
    }

    function collectGemsAt(
      x,
      y,
      moves,
      collectedGems,
      { fadeStartProgress = 0, fadeEndProgress = 1 } = {}
    ) {
      actorsAt(x, y, (actor) => isCollectibleActor(actor) && !collectedGems.has(actor)).forEach((gem) => {
        collectedGems.add(gem);
        moves.push({
          actor: gem,
          fromX: gem.x,
          fromY: gem.y,
          toX: gem.x,
          toY: gem.y,
          fromRemoved: false,
          toRemoved: true,
          fadeOut: true,
          fadeStartProgress,
          fadeEndProgress,
          skipHoleFall: true,
          visibleDuringMove: true
        });
      });
    }

    function collectGemsAlongPath(fromX, fromY, toX, toY, moves, collectedGems) {
      if (fromX === toX && fromY === toY) {
        return;
      }

      const stepX = Math.sign(toX - fromX);
      const stepY = Math.sign(toY - fromY);
      const totalSteps = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY), 1);
      let stepIndex = 1;
      let currentX = fromX + stepX;
      let currentY = fromY + stepY;

      while (true) {
        collectGemsAt(currentX, currentY, moves, collectedGems, {
          fadeStartProgress: (stepIndex - 1) / totalSteps,
          fadeEndProgress: stepIndex / totalSteps
        });

        if (currentX === toX && currentY === toY) {
          return;
        }

        currentX += stepX;
        currentY += stepY;
        stepIndex += 1;
      }
    }

    function canMoveWeightlessGroup(members, dx, dy, occupied, gateState = app.liveRaisedPlayerGates) {
      return members.every((member) => {
        const targetX = member.x + dx;
        const targetY = member.y + dy;

        if (!isInsideBoard(targetX, targetY) || isWall(targetX, targetY, gateState)) {
          return false;
        }

        return !occupied.has(posKey(targetX, targetY));
      });
    }

    function weightlessClusterMembers(groupIds) {
      const groupIdSet = new Set(groupIds);

      return app.state.actors.filter(
        (actor) =>
          !actor.removed &&
          actor.type === "weightless_box" &&
          groupIdSet.has(actor.groupId)
      );
    }

    function collectWeightlessPushCluster(
      groupId,
      dx,
      dy,
      gateState = app.liveRaisedPlayerGates,
      ignoredActors = new Set()
    ) {
      const clusterGroupIds = new Set([groupId]);
      const blockers = [];
      const blockerKeys = new Set();
      let expanded = true;

      while (expanded) {
        expanded = false;

        for (const currentGroupId of Array.from(clusterGroupIds)) {
          const members = weightlessGroupMembers(currentGroupId);

          for (const member of members) {
            const targetX = member.x + dx;
            const targetY = member.y + dy;

            if (!isInsideBoard(targetX, targetY) || isWall(targetX, targetY, gateState)) {
              return null;
            }

            const blocker = actorAt(
              targetX,
              targetY,
              (candidate) =>
                !ignoredActors.has(candidate) &&
                candidate !== member &&
                !isCollectibleActor(candidate) &&
                !(candidate.type === "weightless_box" && clusterGroupIds.has(candidate.groupId))
            );

            if (!blocker) {
              continue;
            }

            if (!isPushableActor(blocker)) {
              return null;
            }

            if (blocker.type === "weightless_box") {
              if (!clusterGroupIds.has(blocker.groupId)) {
                clusterGroupIds.add(blocker.groupId);
                expanded = true;
              }

              continue;
            }

            const blockerKey = pushEntityKey(blocker);

            if (!blockerKeys.has(blockerKey)) {
              blockers.push(blocker);
              blockerKeys.add(blockerKey);
            }
          }
        }
      }

      return {
        blockers,
        groupIds: Array.from(clusterGroupIds)
      };
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

    function moveWeightlessGroup(groupId, dx, dy, occupied, moves, gateState = app.liveRaisedPlayerGates) {
      return moveWeightlessCluster([groupId], dx, dy, occupied, moves, gateState);
    }

    function moveWeightlessCluster(groupIds, dx, dy, occupied, moves, gateState = app.liveRaisedPlayerGates) {
      const members = weightlessClusterMembers(groupIds);

      if (members.length === 0) {
        return false;
      }

      const startPositions = members.map((actor) => ({
        actor,
        fromX: actor.x,
        fromY: actor.y
      }));

      members.forEach((member) => {
        occupied.delete(posKey(member.x, member.y));
      });

      let moved = false;

      while (canMoveWeightlessGroup(members, dx, dy, occupied, gateState)) {
        members.forEach((member) => {
          member.x += dx;
          member.y += dy;
        });

        moved = true;

        if (members.every((member) => isHole(member.x, member.y))) {
          break;
        }

        if (!members.every((member) => isIceOrHole(member.x, member.y))) {
          break;
        }
      }

      if (!moved) {
        startPositions.forEach(({ fromX, fromY }) => {
          occupied.add(posKey(fromX, fromY));
        });
        return false;
      }

      startPositions.forEach(({ actor, fromX, fromY }) => {
        const distance = Math.abs(actor.x - fromX) + Math.abs(actor.y - fromY);
        moves.push({
          actor,
          fromX,
          fromY,
          toX: actor.x,
          toY: actor.y,
          iceSlide: distance > 1
        });
      });

      members.forEach((member) => {
        occupied.add(posKey(member.x, member.y));
      });

      return true;
    }

    function attemptPushActor(
      actor,
      dx,
      dy,
      occupied,
      moves,
      budget,
      handled = new Set(),
      gateState = app.liveRaisedPlayerGates,
      ignoredActors = new Set()
    ) {
      const entityKey = pushEntityKey(actor);

      if (handled.has(entityKey)) {
        return budget;
      }

      const cost = pushWeight(actor);

      if (budget < cost) {
        return null;
      }

      let remainingBudget = budget - cost;
      const weightlessCluster =
        actor.type === "weightless_box"
          ? collectWeightlessPushCluster(actor.groupId, dx, dy, gateState, ignoredActors)
          : null;
      const members = actor.type === "weightless_box" ? null : pushActorMembers(actor);
      const memberSet = members ? new Set(members) : null;
      const blockers = [];

      if (actor.type === "weightless_box") {
        if (!weightlessCluster) {
          return null;
        }

        blockers.push(...weightlessCluster.blockers);
      } else {
        const blockerKeys = new Set();

        for (const member of members) {
          const targetX = member.x + dx;
          const targetY = member.y + dy;

          if (!isInsideBoard(targetX, targetY) || isWall(targetX, targetY, gateState)) {
            return null;
          }

          const blocker = actorAt(
            targetX,
            targetY,
            (candidate) =>
              !ignoredActors.has(candidate) &&
              !memberSet.has(candidate) &&
              !isCollectibleActor(candidate)
          );

          if (!blocker) {
            continue;
          }

          if (!isPushableActor(blocker)) {
            return null;
          }

          const blockerKey = pushEntityKey(blocker);

          if (!blockerKeys.has(blockerKey)) {
            blockers.push(blocker);
            blockerKeys.add(blockerKey);
          }
        }
      }

      for (const blocker of blockers) {
        const result = attemptPushActor(
          blocker,
          dx,
          dy,
          occupied,
          moves,
          remainingBudget,
          handled,
          gateState,
          ignoredActors
        );

        if (result === null) {
          return null;
        }

        remainingBudget = result;
      }

      const moved =
        actor.type === "weightless_box"
          ? moveWeightlessCluster(weightlessCluster.groupIds, dx, dy, occupied, moves, gateState)
          : moveBox(actor, dx, dy, occupied, moves, gateState);

      if (!moved) {
        return null;
      }

      if (actor.type === "weightless_box") {
        weightlessCluster.groupIds.forEach((clusterGroupId) => {
          handled.add(`weightless:${clusterGroupId}`);
        });
      } else {
        handled.add(entityKey);
      }
      return remainingBudget;
    }

    function applyHoleFalls(moves) {
      const moveByActor = new Map(moves.map((move) => [move.actor, move]));
      const handledGroups = new Set();

      moves.forEach((move) => {
        move.fromRemoved = Boolean(move.fromRemoved);
        move.toRemoved = Boolean(move.toRemoved);

        if (move.actor.type === "weightless_box") {
          if (handledGroups.has(move.actor.groupId)) {
            return;
          }

          handledGroups.add(move.actor.groupId);
          const members = weightlessGroupMembers(move.actor.groupId);

          if (members.length > 0 && members.every((member) => isHole(member.x, member.y))) {
            members.forEach((member) => {
              const memberMove = moveByActor.get(member);

              if (memberMove) {
                memberMove.toRemoved = true;
              }
            });
          }

          return;
        }

        if (move.actor.type === "floating_floor" && isHole(move.actor.x, move.actor.y)) {
          move.toRemoved = true;
          move.skipHoleFall = true;
          move.visibleDuringMove = true;
          move.fillsHole = true;
          move.fillHoleX = move.actor.x;
          move.fillHoleY = move.actor.y;
          return;
        }

        if (isHole(move.actor.x, move.actor.y)) {
          move.toRemoved = true;
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
      if (!isInsideBoard(x, y)) {
        return;
      }

      state.terrain[y][x] = buildFloorTerrainCell();
    }

    function finishAnimation(moves) {
      moves.forEach(
        ({
          actor,
          toX,
          toY,
          toRemoved = false,
          skipHoleFall = false,
          toElevation = actor.elevation ?? 0
        }) => {
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

      app.gateRenderOverride = null;
      app.isAnimating = false;
      app.animationFrameId = null;
      syncFloatingFloorTicker();
      app.render();

      if (app.queuedAction) {
        const nextAction = app.queuedAction;
        app.queuedAction = null;
        runAction(nextAction);
      }
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
          finishAnimation(moves);
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

          finishAnimation(moves);
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

    function movePlayers(dx, dy) {
      if (app.isAnimating || app.isTransitioningLevel) {
        app.queuedAction = { type: "move", dx, dy };
        return;
      }

      const edgeTransition = edgeTransitionForMove(dx, dy);

      if (edgeTransition) {
        void transitionToAdjacentLevel(edgeTransition);
        return;
      }

      const players = state.actors.filter((actor) => isPlayerActor(actor) && !actor.removed);
      let occupied = buildOccupiedSet();
      const raisedPlayerGates = computeRaisedPlayerGateSet();
      const orderedPlayers = players.slice().sort(sortActorsForMove(dx, dy));
      const previousState = {
        actors: cloneActorPositions(),
        terrain: cloneTerrainState(state.terrain)
      };
      const moves = [];
      const collectedGems = new Set();
      const pendingLiftToggles = [];

      orderedPlayers.forEach((player) => {
        const fromX = player.x;
        const fromY = player.y;
        const fromElevation = actorElevation(player);
        occupied.delete(posKey(player.x, player.y));

        let nextX = fromX;
        let nextY = fromY;

        while (true) {
          const targetX = nextX + dx;
          const targetY = nextY + dy;
          const isInitialStep = nextX === fromX && nextY === fromY;
          const targetSurfaceHeight =
            fromElevation === 1
              ? playerSurfaceHeightAt(targetX, targetY, raisedPlayerGates)
              : terrainSurfaceHeightAt(targetX, targetY, raisedPlayerGates);
          const canEnterHole = fromElevation === 0 && isHole(targetX, targetY);

          if (
            !isInsideBoard(targetX, targetY) ||
            (!canEnterHole && targetSurfaceHeight !== fromElevation)
          ) {
            break;
          }

          const blockingActor = blockingActorAtElevation(targetX, targetY, fromElevation, player);

          if (blockingActor) {
            let didMoveBlockingActor = false;

            if (fromElevation === 0 && isInitialStep && isPushableActor(blockingActor)) {
              const attemptSnapshot = cloneActorPositions();
              const moveCount = moves.length;
              const pushBudget = countSupportingPlayers(player, dx, dy);
              const result = attemptPushActor(
                blockingActor,
                dx,
                dy,
                occupied,
                moves,
                pushBudget,
                new Set(),
                raisedPlayerGates,
                new Set([player])
              );

              if (result !== null) {
                didMoveBlockingActor = true;
              } else {
                restoreActorPositions(attemptSnapshot);
                moves.length = moveCount;
                occupied = buildOccupiedSet(player);
              }
            }

            if (!didMoveBlockingActor) {
              break;
            }
          }

          nextX = targetX;
          nextY = targetY;

          if (fromElevation !== 0 || !isIce(nextX, nextY)) {
            break;
          }
        }

        if (nextX !== fromX || nextY !== fromY) {
          player.x = nextX;
          player.y = nextY;
          let toElevation = fromElevation;

          if (isPlayerLift(nextX, nextY)) {
            const toRaised = !isRaisedPlayerLift(nextX, nextY);
            pendingLiftToggles.push({
              x: nextX,
              y: nextY,
              raised: toRaised
            });
            toElevation = toRaised ? 1 : 0;
          } else {
            toElevation = playerSurfaceHeightAt(nextX, nextY, raisedPlayerGates) ?? fromElevation;
          }

          const travelDistance = Math.abs(nextX - fromX) + Math.abs(nextY - fromY);
          moves.push({
            actor: player,
            fromX,
            fromY,
            toX: nextX,
            toY: nextY,
            fromElevation,
            toElevation,
            iceSlide: travelDistance > 1
          });

          if (fromElevation === 0 && (toElevation === 0 || isPlayerLift(nextX, nextY))) {
            collectGemsAlongPath(fromX, fromY, nextX, nextY, moves, collectedGems);
          } else if (toElevation === 0) {
            collectGemsAt(nextX, nextY, moves, collectedGems);
          }
        }

        occupied.add(posKey(player.x, player.y));
      });

      if (moves.length > 0) {
        applyHoleFalls(moves);
        previousState.iceSlideMoves = iceSlideMoveMetadata(moves);
        app.gateRenderOverride = raisedPlayerGates;
        moveHistory.push(previousState);
        animateMoves(moves, null, {
          startLiftPhase: () => {
            pendingLiftToggles.forEach(({ x, y, raised }) => {
              setPlayerLiftRaised(x, y, raised);
            });
          }
        });
      }
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
        restoreLevelEntryState(previousState.entry);
        syncFloatingFloorTicker();
        app.render();
        return;
      }

      const raisedPlayerGates = computeRaisedPlayerGateSet();
      const moves = buildMovesToPositions(previousState.actors);
      applyUndoIceSlideMetadata(moves, previousState);
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
      canMoveInto,
      findSlideDestination,
      moveBox,
      countSupportingPlayers,
      collectGemsAt,
      collectGemsAlongPath,
      canMoveWeightlessGroup,
      collectWeightlessPushCluster,
      moveWeightlessGroup,
      moveWeightlessCluster,
      attemptPushActor,
      applyHoleFalls,
      buildFloorTerrainCell,
      fillHoleAt,
      finishAnimation,
      animateMoves,
      sortActorsForMove,
      adjacentWorldLevelId,
      buildMovesToPositions,
      movePlayers,
      undoMove,
      resetPositions,
      runAction,
      handleKeydown,
      preventScroll
    });
  };
})();
