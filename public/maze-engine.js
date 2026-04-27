(function () {
  const terrainTypes = {
    empty: 0,
    floor: 1,
    wall: 2,
    exit: 3,
    ice: 4,
    hole: 5,
    player_gate: 6,
    player_lift: 7,
    orange_wall: 8,
    orange_button: 9
  };
  const fallbackTerrainCell = {
    type: "empty",
    raised: false
  };
  const directionNames = {
    "-1,0": "L",
    "0,-1": "U",
    "0,1": "D",
    "1,0": "R"
  };

  function actorType(actor) {
    return typeof actor?.type === "string" ? actor.type : "";
  }

  function isPlayerType(type) {
    return type === "player" || type === "circle_player";
  }

  function isCollectibleType(type) {
    return type === "gem";
  }

  function isPushableType(type) {
    return type === "box" || type === "floating_floor" || type === "weightless_box";
  }

  function pushWeightForType(type) {
    return type === "box" || type === "floating_floor" ? 1 : 0;
  }

  function normalizedTerrainType(type) {
    return terrainTypes[type] ?? terrainTypes.empty;
  }

  function encodeKeyValue(value) {
    return String.fromCharCode(Math.max(0, Math.min(65534, value | 0)));
  }

  function createEngine(playData) {
    const width = Math.max(1, Number(playData?.width) || 1);
    const height = Math.max(1, Number(playData?.height) || 1);
    const cellCount = width * height;
    const sourceTerrain = Array.isArray(playData?.terrain) ? playData.terrain : [];
    const baseTerrain = new Uint8Array(cellCount);
    const baseLiftRaised = new Uint8Array(cellCount);
    const playerGateCells = [];
    const playerLiftCells = [];
    const orangeWallCells = [];
    const orangeButtonCells = [];
    const actorSource = Array.isArray(playData?.actors) ? playData.actors : [];
    const actorTypes = actorSource.map((actor) => actorType(actor));
    const actorGroupIds = actorSource.map((actor) => actor?.groupId ?? "");
    const actorCount = actorSource.length;
    const searchSeenActors = new Uint32Array(actorCount);
    let searchSeenStamp = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const cell = sourceTerrain[y]?.[x] || fallbackTerrainCell;
        const index = cellIndex(x, y);
        const terrainType = normalizedTerrainType(cell.type);

        baseTerrain[index] = terrainType;

        if (terrainType === terrainTypes.player_lift && cell.raised === true) {
          baseLiftRaised[index] = 1;
        }

        if (terrainType === terrainTypes.player_lift) {
          playerLiftCells.push(index);
        }

        if (terrainType === terrainTypes.player_gate) {
          playerGateCells.push(index);
        }

        if (terrainType === terrainTypes.orange_wall) {
          orangeWallCells.push(index);
        }

        if (terrainType === terrainTypes.orange_button) {
          orangeButtonCells.push(index);
        }
      }
    }

    function cellIndex(x, y) {
      return y * width + x;
    }

    function cellX(index) {
      return index % width;
    }

    function cellY(index) {
      return Math.floor(index / width);
    }

    function isInsideBoard(x, y) {
      return x >= 0 && x < width && y >= 0 && y < height;
    }

    function createInitialState() {
      const state = createStateBuffer();

      state.liftRaised.set(baseLiftRaised);
      state.terrain.set(baseTerrain);

      actorSource.forEach((actor, index) => {
        state.actorX[index] = Number.isInteger(actor?.x) ? actor.x : 0;
        state.actorY[index] = Number.isInteger(actor?.y) ? actor.y : 0;
        state.actorElevation[index] = actor?.elevation ?? 0;
        state.actorRemoved[index] = actor?.removed ? 1 : 0;
      });

      const gateState = computeRaisedPlayerGateSet(state);
      const orangeButtonsPressed = areOrangeButtonsPressed(state);
      const initializedWeightlessGroups = new Set();

      for (let index = 0; index < actorCount; index += 1) {
        if (isPlayerActor(index)) {
          state.actorElevation[index] =
            playerSurfaceHeightAt(
              state,
              state.actorX[index],
              state.actorY[index],
              gateState,
              orangeButtonsPressed
            ) === 1
              ? 1
              : 0;
          continue;
        }

        if (actorTypes[index] !== "weightless_box") {
          state.actorElevation[index] = 0;
          continue;
        }

        const groupId = actorGroupIds[index];

        if (initializedWeightlessGroups.has(groupId)) {
          continue;
        }

        initializedWeightlessGroups.add(groupId);

        const members = weightlessGroupMembers(state, groupId);
        const elevation = weightlessGroupSupportedElevation(
          state,
          members,
          gateState,
          orangeButtonsPressed
        );

        members.forEach((member) => {
          state.actorElevation[member] = elevation;
        });
      }

      return state;
    }

    function createStateBuffer() {
      return {
        actorElevation: new Int8Array(actorCount),
        actorRemoved: new Uint8Array(actorCount),
        actorX: new Int16Array(actorCount),
        actorY: new Int16Array(actorCount),
        liftRaised: new Uint8Array(cellCount),
        terrain: new Uint8Array(cellCount)
      };
    }

    function cloneState(state) {
      return {
        actorElevation: new Int8Array(state.actorElevation),
        actorRemoved: new Uint8Array(state.actorRemoved),
        actorX: new Int16Array(state.actorX),
        actorY: new Int16Array(state.actorY),
        liftRaised: new Uint8Array(state.liftRaised),
        terrain: new Uint8Array(state.terrain)
      };
    }

    function copyStateInto(target, source) {
      target.actorElevation.set(source.actorElevation);
      target.actorRemoved.set(source.actorRemoved);
      target.actorX.set(source.actorX);
      target.actorY.set(source.actorY);
      target.liftRaised.set(source.liftRaised);
      target.terrain.set(source.terrain);
    }

    const searchAttemptSnapshot = createStateBuffer();
    const searchOccupiedSnapshot = new Uint8Array(cellCount);

    function stateKey(state) {
      let key = "";

      for (let index = 0; index < actorCount; index += 1) {
        key +=
          encodeKeyValue(state.actorX[index] + 1) +
          encodeKeyValue(state.actorY[index] + 1) +
          encodeKeyValue(state.actorElevation[index] + 2) +
          encodeKeyValue(state.actorRemoved[index]);
      }

      key += "\uffff";

      for (let index = 0; index < cellCount; index += 1) {
        if (state.terrain[index] !== baseTerrain[index]) {
          key += encodeKeyValue(index) + encodeKeyValue(state.terrain[index]);
        }
      }

      key += "\uffff";

      for (let index = 0; index < playerLiftCells.length; index += 1) {
        const cell = playerLiftCells[index];

        if (state.liftRaised[cell] !== baseLiftRaised[cell]) {
          key += encodeKeyValue(cell) + encodeKeyValue(state.liftRaised[cell]);
        }
      }

      return key;
    }

    function actorCell(state, actorIndex) {
      return cellIndex(state.actorX[actorIndex], state.actorY[actorIndex]);
    }

    function isPlayerActor(actorIndex) {
      return isPlayerType(actorTypes[actorIndex]);
    }

    function isCollectibleActor(actorIndex) {
      return isCollectibleType(actorTypes[actorIndex]);
    }

    function isPushableActor(actorIndex) {
      return isPushableType(actorTypes[actorIndex]);
    }

    function actorElevation(state, actorIndex) {
      return isPlayerActor(actorIndex) || actorTypes[actorIndex] === "weightless_box"
        ? state.actorElevation[actorIndex] || 0
        : 0;
    }

    function isTerrainTypeAt(state, x, y, type) {
      return isInsideBoard(x, y) && state.terrain[cellIndex(x, y)] === type;
    }

    function isIce(state, x, y) {
      return isTerrainTypeAt(state, x, y, terrainTypes.ice);
    }

    function isHole(state, x, y) {
      return isTerrainTypeAt(state, x, y, terrainTypes.hole);
    }

    function isIceOrHole(state, x, y) {
      return isIce(state, x, y) || isHole(state, x, y);
    }

    function isPlayerLift(x, y) {
      return isInsideBoard(x, y) && baseTerrain[cellIndex(x, y)] === terrainTypes.player_lift;
    }

    function isRaisedPlayerLift(state, x, y) {
      return isPlayerLift(x, y) && state.liftRaised[cellIndex(x, y)] === 1;
    }

    function setPlayerLiftRaised(state, x, y, raised) {
      if (!isPlayerLift(x, y)) {
        return false;
      }

      state.liftRaised[cellIndex(x, y)] = raised ? 1 : 0;
      return state.liftRaised[cellIndex(x, y)] === 1;
    }

    function isOrangeWall(x, y) {
      return isInsideBoard(x, y) && baseTerrain[cellIndex(x, y)] === terrainTypes.orange_wall;
    }

    function areOrangeButtonsPressed(state) {
      if (orangeButtonCells.length === 0) {
        return false;
      }

      const occupiedGround = new Uint8Array(cellCount);

      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index] || isCollectibleActor(index) || actorElevation(state, index) !== 0) {
          continue;
        }

        occupiedGround[actorCell(state, index)] = 1;
      }

      for (let index = 0; index < orangeButtonCells.length; index += 1) {
        if (!occupiedGround[orangeButtonCells[index]]) {
          return false;
        }
      }

      return true;
    }

    function isRaisedOrangeWall(x, y, orangeButtonsPressed) {
      return isOrangeWall(x, y) && !orangeButtonsPressed;
    }

    function isPlayerGate(x, y) {
      return isInsideBoard(x, y) && baseTerrain[cellIndex(x, y)] === terrainTypes.player_gate;
    }

    function isRaisedPlayerGate(x, y, gateState) {
      return isPlayerGate(x, y) && gateState.has(cellIndex(x, y));
    }

    function isTerrainWall(state, x, y) {
      return isTerrainTypeAt(state, x, y, terrainTypes.wall);
    }

    function isWall(state, x, y, gateState, orangeButtonsPressed = areOrangeButtonsPressed(state)) {
      return (
        isTerrainWall(state, x, y) ||
        isRaisedPlayerGate(x, y, gateState) ||
        isRaisedPlayerLift(state, x, y) ||
        isRaisedOrangeWall(x, y, orangeButtonsPressed)
      );
    }

    function terrainSurfaceHeightAt(state, x, y, gateState, orangeButtonsPressed = areOrangeButtonsPressed(state)) {
      if (!isInsideBoard(x, y)) {
        return null;
      }

      if (isWall(state, x, y, gateState, orangeButtonsPressed)) {
        return 1;
      }

      const terrain = state.terrain[cellIndex(x, y)];

      if (terrain === terrainTypes.hole || terrain === terrainTypes.empty) {
        return null;
      }

      return 0;
    }

    function weightlessGroupSupportedElevation(state, members, gateState, orangeButtonsPressed) {
      return members.some(
        (member) =>
          terrainSurfaceHeightAt(
            state,
            state.actorX[member],
            state.actorY[member],
            gateState,
            orangeButtonsPressed
          ) === 1
      )
        ? 1
        : 0;
    }

    function hasElevatedActorSurfaceAt(state, x, y) {
      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index]) {
          continue;
        }

        if (state.actorX[index] !== x || state.actorY[index] !== y) {
          continue;
        }

        if (actorTypes[index] === "floating_floor" || actorTypes[index] === "weightless_box") {
          return true;
        }
      }

      return false;
    }

    function playerSurfaceHeightAt(state, x, y, gateState, orangeButtonsPressed = areOrangeButtonsPressed(state)) {
      const terrainHeight = terrainSurfaceHeightAt(state, x, y, gateState, orangeButtonsPressed);

      if (terrainHeight === 1 || hasElevatedActorSurfaceAt(state, x, y)) {
        return 1;
      }

      return terrainHeight;
    }

    function computeRaisedPlayerGateSet(state) {
      const occupiedGround = new Uint8Array(cellCount);
      const players = [];
      const raised = new Set();

      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index]) {
          continue;
        }

        if (!isCollectibleActor(index) && actorElevation(state, index) === 0) {
          occupiedGround[actorCell(state, index)] = 1;
        }

        if (isPlayerActor(index)) {
          players.push(index);
        }
      }

      playerGateCells.forEach((gateCell) => {
        const x = cellX(gateCell);
        const y = cellY(gateCell);

        for (const player of players) {
          if (
            actorElevation(state, player) === 1 &&
            state.actorX[player] === x &&
            state.actorY[player] === y
          ) {
            raised.add(gateCell);
            return;
          }
        }

        if (occupiedGround[gateCell]) {
          return;
        }

        for (const player of players) {
          if (Math.abs(state.actorX[player] - x) + Math.abs(state.actorY[player] - y) === 1) {
            raised.add(gateCell);
            return;
          }
        }
      });

      return raised;
    }

    function buildOccupiedMap(state, excludedActor = -1) {
      const occupied = new Uint8Array(cellCount);

      for (let index = 0; index < actorCount; index += 1) {
        if (index === excludedActor || state.actorRemoved[index] || isCollectibleActor(index)) {
          continue;
        }

        occupied[actorCell(state, index)] = 1;
      }

      return occupied;
    }

    function actorAt(state, x, y, predicate = null) {
      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index]) {
          continue;
        }

        if (state.actorX[index] !== x || state.actorY[index] !== y) {
          continue;
        }

        if (!predicate || predicate(index)) {
          return index;
        }
      }

      return -1;
    }

    function actorsAt(state, x, y, predicate = null) {
      const matches = [];

      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index]) {
          continue;
        }

        if (state.actorX[index] !== x || state.actorY[index] !== y) {
          continue;
        }

        if (!predicate || predicate(index)) {
          matches.push(index);
        }
      }

      return matches;
    }

    function pushEntityKey(actorIndex) {
      return actorTypes[actorIndex] === "weightless_box"
        ? `weightless:${actorGroupIds[actorIndex]}`
        : `actor:${actorIndex}`;
    }

    function pushActorMembers(state, actorIndex) {
      if (actorTypes[actorIndex] !== "weightless_box") {
        return [actorIndex];
      }

      return weightlessGroupMembers(state, actorGroupIds[actorIndex]);
    }

    function weightlessGroupMembers(state, groupId) {
      const members = [];

      for (let index = 0; index < actorCount; index += 1) {
        if (
          !state.actorRemoved[index] &&
          actorTypes[index] === "weightless_box" &&
          actorGroupIds[index] === groupId
        ) {
          members.push(index);
        }
      }

      return members;
    }

    function weightlessClusterMembers(state, groupIds) {
      const groupIdSet = new Set(groupIds);
      const members = [];

      for (let index = 0; index < actorCount; index += 1) {
        if (
          !state.actorRemoved[index] &&
          actorTypes[index] === "weightless_box" &&
          groupIdSet.has(actorGroupIds[index])
        ) {
          members.push(index);
        }
      }

      return members;
    }

    function canMoveInto(state, x, y, occupied, gateState, orangeButtonsPressed) {
      if (!isInsideBoard(x, y)) {
        return false;
      }

      if (isWall(state, x, y, gateState, orangeButtonsPressed)) {
        return false;
      }

      return occupied[cellIndex(x, y)] === 0;
    }

    function findSlideDestination(state, startX, startY, dx, dy, occupied, gateState, orangeButtonsPressed) {
      let nextX = startX;
      let nextY = startY;

      while (canMoveInto(state, nextX + dx, nextY + dy, occupied, gateState, orangeButtonsPressed)) {
        nextX += dx;
        nextY += dy;

        if (!isIce(state, nextX, nextY)) {
          break;
        }
      }

      return { x: nextX, y: nextY };
    }

    function moveBox(state, actorIndex, dx, dy, occupied, moves, gateState, orangeButtonsPressed, searchMode) {
      const fromX = state.actorX[actorIndex];
      const fromY = state.actorY[actorIndex];
      occupied[cellIndex(fromX, fromY)] = 0;

      const target = findSlideDestination(
        state,
        fromX,
        fromY,
        dx,
        dy,
        occupied,
        gateState,
        orangeButtonsPressed
      );

      if (target.x === fromX && target.y === fromY) {
        occupied[cellIndex(fromX, fromY)] = 1;
        return false;
      }

      state.actorX[actorIndex] = target.x;
      state.actorY[actorIndex] = target.y;

      const moveRecord = {
        actorIndex,
        actorType: actorTypes[actorIndex],
        fromX,
        fromY,
        toX: target.x,
        toY: target.y
      };

      if (!searchMode) {
        moveRecord.iceSlide = Math.abs(target.x - fromX) + Math.abs(target.y - fromY) > 1;
      }

      moves.push(moveRecord);
      occupied[cellIndex(target.x, target.y)] = 1;
      return true;
    }

    function countSupportingPlayers(state, player, dx, dy) {
      let count = 1;
      let checkX = state.actorX[player];
      let checkY = state.actorY[player];

      while (true) {
        checkX -= dx;
        checkY -= dy;

        const occupant = actorAt(
          state,
          checkX,
          checkY,
          (actor) => isPlayerActor(actor) && actorElevation(state, actor) === actorElevation(state, player)
        );

        if (occupant === -1) {
          break;
        }

        count += 1;
      }

      return count;
    }

    function blockingActorAtElevation(state, x, y, elevation, mover) {
      return actorAt(
        state,
        x,
        y,
        (actor) =>
          actor !== mover &&
          !isCollectibleActor(actor) &&
          actorElevation(state, actor) === elevation
      );
    }

    function collectGemsAt(
      state,
      x,
      y,
      moves,
      collectedGems,
      fadeStartProgress,
      fadeEndProgress,
      searchMode
    ) {
      actorsAt(
        state,
        x,
        y,
        (actor) => isCollectibleActor(actor) && !collectedGems.has(actor)
      ).forEach((gem) => {
        collectedGems.add(gem);
        const moveRecord = {
          actorIndex: gem,
          actorType: actorTypes[gem],
          fromX: state.actorX[gem],
          fromY: state.actorY[gem],
          toX: state.actorX[gem],
          toY: state.actorY[gem],
          fromRemoved: false,
          toRemoved: true
        };

        if (!searchMode) {
          moveRecord.fadeOut = true;
          moveRecord.fadeStartProgress = fadeStartProgress;
          moveRecord.fadeEndProgress = fadeEndProgress;
          moveRecord.skipHoleFall = true;
          moveRecord.visibleDuringMove = true;
        }

        moves.push(moveRecord);
      });
    }

    function collectGemsAtEndpoint(
      state,
      fromX,
      fromY,
      toX,
      toY,
      moves,
      collectedGems,
      searchMode
    ) {
      const travelDistance = Math.abs(toX - fromX) + Math.abs(toY - fromY);
      collectGemsAt(
        state,
        toX,
        toY,
        moves,
        collectedGems,
        travelDistance > 1 ? (travelDistance - 1) / travelDistance : 0,
        1,
        searchMode
      );
    }

    function canWeightlessMemberEnter(
      state,
      member,
      targetX,
      targetY,
      gateState,
      orangeButtonsPressed
    ) {
      if (!isInsideBoard(targetX, targetY)) {
        return false;
      }

      return (
        actorElevation(state, member) === 1 ||
        !isWall(state, targetX, targetY, gateState, orangeButtonsPressed)
      );
    }

    function canMoveWeightlessGroup(state, members, dx, dy, occupied, gateState, orangeButtonsPressed) {
      return members.every((member) => {
        const targetX = state.actorX[member] + dx;
        const targetY = state.actorY[member] + dy;

        if (!canWeightlessMemberEnter(state, member, targetX, targetY, gateState, orangeButtonsPressed)) {
          return false;
        }

        return occupied[cellIndex(targetX, targetY)] === 0;
      });
    }

    function collectWeightlessPushCluster(
      state,
      groupId,
      dx,
      dy,
      gateState,
      orangeButtonsPressed,
      ignoredActors
    ) {
      const clusterGroupIds = new Set([groupId]);
      const blockers = [];
      const blockerKeys = new Set();
      let expanded = true;

      while (expanded) {
        expanded = false;

        Array.from(clusterGroupIds).forEach((currentGroupId) => {
          const members = weightlessGroupMembers(state, currentGroupId);

          for (const member of members) {
            const targetX = state.actorX[member] + dx;
            const targetY = state.actorY[member] + dy;

            if (!canWeightlessMemberEnter(state, member, targetX, targetY, gateState, orangeButtonsPressed)) {
              blockers.push(null);
              return;
            }

            const blocker = actorAt(
              state,
              targetX,
              targetY,
              (candidate) =>
                !ignoredActors.has(candidate) &&
                candidate !== member &&
                !isCollectibleActor(candidate) &&
                !(actorTypes[candidate] === "weightless_box" && clusterGroupIds.has(actorGroupIds[candidate]))
            );

            if (blocker === -1) {
              continue;
            }

            if (actorElevation(state, blocker) !== actorElevation(state, member)) {
              blockers.push(null);
              return;
            }

            if (!isPushableActor(blocker)) {
              blockers.push(null);
              return;
            }

            if (actorTypes[blocker] === "weightless_box") {
              if (!clusterGroupIds.has(actorGroupIds[blocker])) {
                clusterGroupIds.add(actorGroupIds[blocker]);
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
        });

        if (blockers.includes(null)) {
          return null;
        }
      }

      return {
        blockers,
        groupIds: Array.from(clusterGroupIds)
      };
    }

    function moveWeightlessCluster(
      state,
      groupIds,
      dx,
      dy,
      occupied,
      moves,
      gateState,
      orangeButtonsPressed,
      searchMode
    ) {
      const members = weightlessClusterMembers(state, groupIds);

      if (members.length === 0) {
        return false;
      }

      const startPositions = members.map((actorIndex) => ({
        actorIndex,
        fromElevation: actorElevation(state, actorIndex),
        fromX: state.actorX[actorIndex],
        fromY: state.actorY[actorIndex]
      }));
      const groupElevation = actorElevation(state, members[0]);

      members.forEach((member) => {
        occupied[actorCell(state, member)] = 0;
      });

      let moved = false;

      while (canMoveWeightlessGroup(state, members, dx, dy, occupied, gateState, orangeButtonsPressed)) {
        members.forEach((member) => {
          state.actorX[member] += dx;
          state.actorY[member] += dy;
        });

        moved = true;

        if (members.every((member) => isHole(state, state.actorX[member], state.actorY[member]))) {
          break;
        }

        if (
          groupElevation !== 0 ||
          !members.every((member) => isIceOrHole(state, state.actorX[member], state.actorY[member]))
        ) {
          break;
        }
      }

      if (!moved) {
        startPositions.forEach(({ fromX, fromY }) => {
          occupied[cellIndex(fromX, fromY)] = 1;
        });
        return false;
      }

      startPositions.forEach(({ actorIndex, fromElevation, fromX, fromY }) => {
        const moveRecord = {
          actorIndex,
          actorType: actorTypes[actorIndex],
          fromElevation,
          fromX,
          fromY,
          toElevation: fromElevation,
          toX: state.actorX[actorIndex],
          toY: state.actorY[actorIndex]
        };

        if (!searchMode) {
          moveRecord.iceSlide =
            Math.abs(state.actorX[actorIndex] - fromX) +
              Math.abs(state.actorY[actorIndex] - fromY) >
            1;
        }

        moves.push(moveRecord);
      });

      members.forEach((member) => {
        occupied[actorCell(state, member)] = 1;
      });

      return true;
    }

    function attemptPushActor(
      state,
      actorIndex,
      dx,
      dy,
      occupied,
      moves,
      budget,
      handled = new Set(),
      gateState,
      orangeButtonsPressed,
      ignoredActors = new Set(),
      searchMode = false
    ) {
      const entityKey = pushEntityKey(actorIndex);

      if (handled.has(entityKey)) {
        return budget;
      }

      const cost = pushWeightForType(actorTypes[actorIndex]);

      if (budget < cost) {
        return null;
      }

      let remainingBudget = budget - cost;
      const blockers = [];
      const weightlessCluster =
        actorTypes[actorIndex] === "weightless_box"
          ? collectWeightlessPushCluster(
              state,
              actorGroupIds[actorIndex],
              dx,
              dy,
              gateState,
              orangeButtonsPressed,
              ignoredActors
            )
          : null;

      if (actorTypes[actorIndex] === "weightless_box") {
        if (!weightlessCluster) {
          return null;
        }

        blockers.push(...weightlessCluster.blockers);
      } else {
        const members = pushActorMembers(state, actorIndex);
        const memberSet = new Set(members);
        const blockerKeys = new Set();

        for (const member of members) {
          const targetX = state.actorX[member] + dx;
          const targetY = state.actorY[member] + dy;

          if (
            !isInsideBoard(targetX, targetY) ||
            isWall(state, targetX, targetY, gateState, orangeButtonsPressed)
          ) {
            return null;
          }

          const blocker = actorAt(
            state,
            targetX,
            targetY,
            (candidate) =>
              !ignoredActors.has(candidate) &&
              !memberSet.has(candidate) &&
              !isCollectibleActor(candidate)
          );

          if (blocker === -1) {
            continue;
          }

          if (actorElevation(state, blocker) !== actorElevation(state, member)) {
            return null;
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
          state,
          blocker,
          dx,
          dy,
          occupied,
          moves,
          remainingBudget,
          handled,
          gateState,
          orangeButtonsPressed,
          ignoredActors,
          searchMode
        );

        if (result === null) {
          return null;
        }

        remainingBudget = result;
      }

      const moved =
        actorTypes[actorIndex] === "weightless_box"
          ? moveWeightlessCluster(
              state,
              weightlessCluster.groupIds,
              dx,
              dy,
              occupied,
              moves,
              gateState,
              orangeButtonsPressed,
              searchMode
            )
          : moveBox(
              state,
              actorIndex,
              dx,
              dy,
              occupied,
              moves,
              gateState,
              orangeButtonsPressed,
              searchMode
            );

      if (!moved) {
        return null;
      }

      if (actorTypes[actorIndex] === "weightless_box") {
        weightlessCluster.groupIds.forEach((groupId) => {
          handled.add(`weightless:${groupId}`);
        });
      } else {
        handled.add(entityKey);
      }

      return remainingBudget;
    }

    function applyHoleFalls(state, moves) {
      moves.forEach((move) => {
        move.fromRemoved = Boolean(move.fromRemoved);
        move.toRemoved = Boolean(move.toRemoved);

        if (move.actorType === "weightless_box") {
          return;
        }

        if (move.actorType === "floating_floor" && isHole(state, state.actorX[move.actorIndex], state.actorY[move.actorIndex])) {
          move.toRemoved = true;
          move.skipHoleFall = true;
          move.visibleDuringMove = true;
          move.fillsHole = true;
          move.fillHoleX = state.actorX[move.actorIndex];
          move.fillHoleY = state.actorY[move.actorIndex];
          return;
        }

        if (
          isHole(state, state.actorX[move.actorIndex], state.actorY[move.actorIndex]) &&
          (!isPlayerType(move.actorType) || (move.toElevation ?? state.actorElevation[move.actorIndex] ?? 0) === 0)
        ) {
          move.toRemoved = true;
        }
      });
    }

    function applyMoveFinalState(state, moves) {
      moves.forEach((move) => {
        const toElevation = move.toElevation ?? state.actorElevation[move.actorIndex] ?? 0;

        state.actorX[move.actorIndex] = move.toX;
        state.actorY[move.actorIndex] = move.toY;
        state.actorElevation[move.actorIndex] = toElevation;
        state.actorRemoved[move.actorIndex] = move.toRemoved ? 1 : 0;
      });

      moves.forEach(({ fillsHole = false, fillHoleX = null, fillHoleY = null }) => {
        if (!fillsHole || typeof fillHoleX !== "number" || typeof fillHoleY !== "number") {
          return;
        }

        state.terrain[cellIndex(fillHoleX, fillHoleY)] = terrainTypes.floor;
      });
    }

    function syncDynamicActorElevationsAndFalls(state, moves) {
      const moveByActor = new Map(moves.map((move) => [move.actorIndex, move]));
      const originalElevations = new Int8Array(state.actorElevation);
      let gateState = computeRaisedPlayerGateSet(state);
      let orangeButtonsPressed = areOrangeButtonsPressed(state);

      for (let iteration = 0; iteration < 4; iteration += 1) {
        gateState = computeRaisedPlayerGateSet(state);
        orangeButtonsPressed = areOrangeButtonsPressed(state);
        let changed = false;

        if (orangeWallCells.length > 0) {
          for (let index = 0; index < actorCount; index += 1) {
            if (!isPlayerActor(index) || state.actorRemoved[index]) {
              continue;
            }

            const x = state.actorX[index];
            const y = state.actorY[index];

            if (!isOrangeWall(x, y)) {
              continue;
            }

            const toElevation =
              playerSurfaceHeightAt(state, x, y, gateState, orangeButtonsPressed) === 1
                ? 1
                : 0;

            if (state.actorElevation[index] !== toElevation) {
              state.actorElevation[index] = toElevation;
              changed = true;
            }
          }
        }

        const handledWeightlessGroups = new Set();

        for (let index = 0; index < actorCount; index += 1) {
          if (actorTypes[index] !== "weightless_box" || state.actorRemoved[index]) {
            continue;
          }

          const groupId = actorGroupIds[index];

          if (handledWeightlessGroups.has(groupId)) {
            continue;
          }

          handledWeightlessGroups.add(groupId);

          const members = weightlessGroupMembers(state, groupId);
          const toElevation = weightlessGroupSupportedElevation(
            state,
            members,
            gateState,
            orangeButtonsPressed
          );

          members.forEach((member) => {
            if (state.actorElevation[member] !== toElevation) {
              state.actorElevation[member] = toElevation;
              changed = true;
            }
          });
        }

        if (!changed) {
          break;
        }
      }

      gateState = computeRaisedPlayerGateSet(state);
      orangeButtonsPressed = areOrangeButtonsPressed(state);

      function ensureDynamicMove(index, toElevation) {
        const existingMove = moveByActor.get(index);

        if (existingMove) {
          if (typeof existingMove.fromElevation !== "number") {
            existingMove.fromElevation = originalElevations[index] || 0;
          }

          existingMove.toElevation = toElevation;
          return existingMove;
        }

        const moveRecord = {
          actorIndex: index,
          actorType: actorTypes[index],
          fromX: state.actorX[index],
          fromY: state.actorY[index],
          toX: state.actorX[index],
          toY: state.actorY[index],
          fromElevation: originalElevations[index] || 0,
          toElevation
        };
        moves.push(moveRecord);
        moveByActor.set(index, moveRecord);
        return moveRecord;
      }

      for (let index = 0; index < actorCount; index += 1) {
        if (!isPlayerActor(index) || state.actorRemoved[index]) {
          continue;
        }

        const x = state.actorX[index];
        const y = state.actorY[index];

        if (!isOrangeWall(x, y)) {
          continue;
        }

        const toElevation =
          playerSurfaceHeightAt(state, x, y, gateState, orangeButtonsPressed) === 1
            ? 1
            : 0;

        if ((originalElevations[index] || 0) === toElevation) {
          continue;
        }

        ensureDynamicMove(index, toElevation);
        state.actorElevation[index] = toElevation;
      }

      const handledWeightlessGroups = new Set();

      for (let index = 0; index < actorCount; index += 1) {
        if (actorTypes[index] !== "weightless_box" || state.actorRemoved[index]) {
          continue;
        }

        const groupId = actorGroupIds[index];

        if (handledWeightlessGroups.has(groupId)) {
          continue;
        }

        handledWeightlessGroups.add(groupId);

        const members = weightlessGroupMembers(state, groupId);
        const toElevation = weightlessGroupSupportedElevation(
          state,
          members,
          gateState,
          orangeButtonsPressed
        );
        const groupMovedOrChangedElevation = members.some(
          (member) => moveByActor.has(member) || (originalElevations[member] || 0) !== toElevation
        );
        const shouldFallIntoHole =
          groupMovedOrChangedElevation &&
          toElevation === 0 &&
          members.length > 0 &&
          members.every((member) => isHole(state, state.actorX[member], state.actorY[member]));

        members.forEach((member) => {
          if ((originalElevations[member] || 0) !== toElevation || shouldFallIntoHole) {
            const moveRecord = ensureDynamicMove(member, toElevation);
            moveRecord.toRemoved = shouldFallIntoHole;
          }

          state.actorElevation[member] = toElevation;
          state.actorRemoved[member] = shouldFallIntoHole ? 1 : 0;
        });
      }
    }

    function sortPlayersForMove(state, dx, dy) {
      const players = [];

      for (let index = 0; index < actorCount; index += 1) {
        if (isPlayerActor(index) && !state.actorRemoved[index]) {
          players.push(index);
        }
      }

      return players.sort((left, right) => {
        if (dx > 0) {
          return state.actorX[right] - state.actorX[left] || state.actorY[left] - state.actorY[right];
        }
        if (dx < 0) {
          return state.actorX[left] - state.actorX[right] || state.actorY[left] - state.actorY[right];
        }
        if (dy > 0) {
          return state.actorY[right] - state.actorY[left] || state.actorX[left] - state.actorX[right];
        }
        return state.actorY[left] - state.actorY[right] || state.actorX[left] - state.actorX[right];
      });
    }

    function move(state, dx, dy, options = {}) {
      const searchMode = options.search === true;
      const attemptSnapshotBuffer = options.attemptSnapshot || null;
      const occupiedSnapshotBuffer = options.occupiedSnapshot || null;
      const occupied = buildOccupiedMap(state);
      const raisedPlayerGates = computeRaisedPlayerGateSet(state);
      const orangeButtonsPressed = areOrangeButtonsPressed(state);
      const orderedPlayers = sortPlayersForMove(state, dx, dy);
      const moves = [];
      const collectedGems = new Set();
      const pendingLiftToggles = [];

      orderedPlayers.forEach((player) => {
        const fromX = state.actorX[player];
        const fromY = state.actorY[player];
        const fromElevation = actorElevation(state, player);
        occupied[cellIndex(fromX, fromY)] = 0;

        let nextX = fromX;
        let nextY = fromY;

        while (true) {
          const targetX = nextX + dx;
          const targetY = nextY + dy;
          const isInitialStep = nextX === fromX && nextY === fromY;
          const targetSurfaceHeight =
            fromElevation === 1
              ? playerSurfaceHeightAt(
                  state,
                  targetX,
                  targetY,
                  raisedPlayerGates,
                  orangeButtonsPressed
                )
              : terrainSurfaceHeightAt(
                  state,
                  targetX,
                  targetY,
                  raisedPlayerGates,
                  orangeButtonsPressed
                );
          const canEnterHole = fromElevation === 0 && isHole(state, targetX, targetY);

          if (
            !isInsideBoard(targetX, targetY) ||
            (!canEnterHole && targetSurfaceHeight !== fromElevation)
          ) {
            break;
          }

          const blockingActor = blockingActorAtElevation(
            state,
            targetX,
            targetY,
            fromElevation,
            player
          );

          if (blockingActor !== -1) {
            let didMoveBlockingActor = false;

            if (isInitialStep && isPushableActor(blockingActor)) {
              const attemptSnapshot = attemptSnapshotBuffer || cloneState(state);
              const occupiedSnapshot =
                occupiedSnapshotBuffer || new Uint8Array(occupied);
              const moveCount = moves.length;
              const pushBudget = countSupportingPlayers(state, player, dx, dy);

              if (attemptSnapshotBuffer) {
                copyStateInto(attemptSnapshotBuffer, state);
              }

              if (occupiedSnapshotBuffer) {
                occupiedSnapshotBuffer.set(occupied);
              }

              const result = attemptPushActor(
                state,
                blockingActor,
                dx,
                dy,
                occupied,
                moves,
                pushBudget,
                new Set(),
                raisedPlayerGates,
                orangeButtonsPressed,
                new Set([player]),
                searchMode
              );

              if (result !== null) {
                didMoveBlockingActor = true;
              } else {
                copyStateInto(state, attemptSnapshot);
                occupied.set(occupiedSnapshot);
                moves.length = moveCount;
              }
            }

            if (!didMoveBlockingActor) {
              break;
            }
          }

          nextX = targetX;
          nextY = targetY;

          if (fromElevation !== 0 || !isIce(state, nextX, nextY)) {
            break;
          }
        }

        if (nextX !== fromX || nextY !== fromY) {
          state.actorX[player] = nextX;
          state.actorY[player] = nextY;
          let toElevation = fromElevation;

          if (isPlayerLift(nextX, nextY)) {
            const toRaised = !isRaisedPlayerLift(state, nextX, nextY);
            pendingLiftToggles.push({
              x: nextX,
              y: nextY,
              raised: toRaised
            });
            toElevation = toRaised ? 1 : 0;
          } else {
            toElevation =
              playerSurfaceHeightAt(
                state,
                nextX,
                nextY,
                raisedPlayerGates,
                orangeButtonsPressed
              ) ?? fromElevation;
          }

          const travelDistance = Math.abs(nextX - fromX) + Math.abs(nextY - fromY);
          const moveRecord = {
            actorIndex: player,
            actorType: actorTypes[player],
            fromX,
            fromY,
            toX: nextX,
            toY: nextY,
            fromElevation,
            toElevation
          };

          if (!searchMode) {
            moveRecord.iceSlide = travelDistance > 1;
          }

          moves.push(moveRecord);

          if (
            !isHole(state, nextX, nextY) &&
            (toElevation === 0 || (fromElevation === 0 && isPlayerLift(nextX, nextY)))
          ) {
            collectGemsAtEndpoint(
              state,
              fromX,
              fromY,
              nextX,
              nextY,
              moves,
              collectedGems,
              searchMode
            );
          }
        }

        occupied[cellIndex(state.actorX[player], state.actorY[player])] = 1;
      });

      if (moves.length > 0) {
        applyHoleFalls(state, moves);
        pendingLiftToggles.forEach(({ x, y, raised }) => {
          setPlayerLiftRaised(state, x, y, raised);
        });
        applyMoveFinalState(state, moves);
        syncDynamicActorElevationsAndFalls(state, moves);
      }

      return {
        direction: directionNames[`${dx},${dy}`] || "",
        liftToggles: pendingLiftToggles.map(({ x, y, raised }) => ({ x, y, raised })),
        moved: moves.length > 0,
        moves
      };
    }

    function countNonPlayerMoves(moves) {
      let count = 0;

      searchSeenStamp += 1;

      if (searchSeenStamp >= 4294967295) {
        searchSeenActors.fill(0);
        searchSeenStamp = 1;
      }

      moves.forEach((moveRecord) => {
        if (
          isPlayerType(moveRecord.actorType) ||
          isCollectibleType(moveRecord.actorType) ||
          (moveRecord.fromX === moveRecord.toX && moveRecord.fromY === moveRecord.toY)
        ) {
          return;
        }

        if (searchSeenActors[moveRecord.actorIndex] === searchSeenStamp) {
          return;
        }

        searchSeenActors[moveRecord.actorIndex] = searchSeenStamp;
        count += 1;
      });

      return count;
    }

    function moveForSearch(state, dx, dy) {
      const result = move(state, dx, dy, {
        attemptSnapshot: searchAttemptSnapshot,
        occupiedSnapshot: searchOccupiedSnapshot,
        search: true
      });
      result.nonPlayerMoveCount = result.moved ? countNonPlayerMoves(result.moves) : 0;
      return result;
    }

    function undoMove(state, moveResult) {
      if (!moveResult?.moved || !Array.isArray(moveResult.moves)) {
        return;
      }

      for (let index = moveResult.moves.length - 1; index >= 0; index -= 1) {
        const moveRecord = moveResult.moves[index];
        const actorIndex = moveRecord.actorIndex;

        state.actorX[actorIndex] = moveRecord.fromX;
        state.actorY[actorIndex] = moveRecord.fromY;
        state.actorElevation[actorIndex] = moveRecord.fromElevation ?? 0;
        state.actorRemoved[actorIndex] = moveRecord.fromRemoved ? 1 : 0;

        if (
          moveRecord.fillsHole &&
          typeof moveRecord.fillHoleX === "number" &&
          typeof moveRecord.fillHoleY === "number"
        ) {
          state.terrain[cellIndex(moveRecord.fillHoleX, moveRecord.fillHoleY)] =
            terrainTypes.hole;
        }
      }

      if (Array.isArray(moveResult.liftToggles)) {
        moveResult.liftToggles.forEach(({ x, y, raised }) => {
          setPlayerLiftRaised(state, x, y, !raised);
        });
      }
    }

    function isSolved(state) {
      for (let index = 0; index < actorCount; index += 1) {
        if (actorTypes[index] === "gem" && state.actorRemoved[index]) {
          return true;
        }
      }

      for (let gem = 0; gem < actorCount; gem += 1) {
        if (actorTypes[gem] !== "gem" || state.actorRemoved[gem]) {
          continue;
        }

        for (let player = 0; player < actorCount; player += 1) {
          if (!isPlayerActor(player) || state.actorRemoved[player] || actorElevation(state, player) !== 0) {
            continue;
          }

          if (state.actorX[player] === state.actorX[gem] && state.actorY[player] === state.actorY[gem]) {
            return true;
          }
        }
      }

      return false;
    }

    function heuristic(state) {
      let best = 2;
      let hasPlayer = false;
      let hasGem = false;

      for (let player = 0; player < actorCount; player += 1) {
        if (!isPlayerActor(player) || state.actorRemoved[player]) {
          continue;
        }

        hasPlayer = true;

        for (let gem = 0; gem < actorCount; gem += 1) {
          if (actorTypes[gem] !== "gem" || state.actorRemoved[gem]) {
            continue;
          }

          hasGem = true;

          if (
            state.actorX[player] === state.actorX[gem] &&
            state.actorY[player] === state.actorY[gem] &&
            actorElevation(state, player) === 0
          ) {
            best = 0;
          } else if (state.actorX[player] === state.actorX[gem] || state.actorY[player] === state.actorY[gem]) {
            best = Math.min(best, 1);
          }
        }
      }

      return hasPlayer && hasGem ? best : 0;
    }

    function isPlayerMove(moveRecord) {
      return isPlayerType(moveRecord?.actorType);
    }

    const initialState = createInitialState();

    return {
      actorCount,
      actorGroupIds,
      actorTypes,
      cellCount,
      cellIndex,
      cloneState,
      copyStateInto,
      createStateBuffer,
      height,
      heuristic,
      initialState,
      isPlayerLift,
      isPlayerMove,
      isSolved,
      move,
      moveForSearch,
      stateKey,
      terrainTypes,
      undoMove,
      width
    };
  }

  window.MazeEngine = {
    createEngine,
    terrainTypes
  };
})();
