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
    orange_button: 9,
    tree: 10,
    ice_block: 11
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

  function isSupportActorType(type) {
    return (
      type === "player" ||
      type === "circle_player" ||
      type === "box" ||
      type === "floating_floor" ||
      type === "weightless_box"
    );
  }

  function pushWeightForType(type) {
    return type === "box" || type === "floating_floor" ? 1 : 0;
  }

  function normalizedTerrainType(type) {
    return terrainTypes[type] ?? terrainTypes.empty;
  }

  function normalizedTerrainLayers(cell, fallbackType = terrainTypes.empty) {
    const sourceLayers = Array.isArray(cell?.layers) ? cell.layers : null;
    const layers =
      sourceLayers && sourceLayers.length > 0
        ? sourceLayers
        : fallbackType === terrainTypes.empty
          ? []
          : [
              {
                type: cell?.type || "empty",
                elevation: 0,
                raised: cell?.raised === true
              }
            ];

    return layers
      .map((layer) => {
        const elevation = Number.isInteger(layer?.elevation) ? layer.elevation : 0;

        return {
          type: normalizedTerrainType(layer?.type),
          elevation: Math.max(0, elevation),
          raised: layer?.raised === true
        };
      })
      .filter((layer) => layer.type !== terrainTypes.empty)
      .sort((left, right) => left.elevation - right.elevation);
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
    const terrainLayers = Array.from({ length: cellCount }, () => []);
    const playerGateCells = [];
    const playerLiftCells = [];
    const orangeWallCells = [];
    const orangeButtonCells = [];
    const actorSource = Array.isArray(playData?.actors) ? playData.actors : [];
    const actorTypes = actorSource.map((actor) => actorType(actor));
    const actorGroupIds = actorSource.map((actor) => actor?.groupId ?? "");
    const actorCount = actorSource.length;
    const actorInitialElevations = [];
    const weightlessRelativeElevations = [];
    const searchSeenActors = new Uint32Array(actorCount);
    let searchSeenStamp = 0;

    for (let index = 0; index < actorCount; index += 1) {
      actorInitialElevations[index] = initialActorElevation(actorSource[index], index);
      weightlessRelativeElevations[index] = 0;
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const cell = sourceTerrain[y]?.[x] || fallbackTerrainCell;
        const index = cellIndex(x, y);
        const terrainType = normalizedTerrainType(cell.type);

        baseTerrain[index] = terrainType;
        terrainLayers[index] = normalizedTerrainLayers(cell, terrainType);

        if (
          terrainType === terrainTypes.player_lift && cell.raised === true ||
          terrainLayers[index].some(
            (layer) => layer.type === terrainTypes.player_lift && layer.raised === true
          )
        ) {
          baseLiftRaised[index] = 1;
        }

        if (terrainLayers[index].some((layer) => layer.type === terrainTypes.player_lift)) {
          playerLiftCells.push(index);
        }

        if (terrainLayers[index].some((layer) => layer.type === terrainTypes.player_gate)) {
          playerGateCells.push(index);
        }

        if (terrainLayers[index].some((layer) => layer.type === terrainTypes.orange_wall)) {
          orangeWallCells.push(index);
        }

        if (terrainLayers[index].some((layer) => layer.type === terrainTypes.orange_button)) {
          orangeButtonCells.push(index);
        }
      }
    }

    initializeWeightlessRelativeElevations();

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
        state.actorElevation[index] = actorInitialElevations[index] || 0;
        state.actorRemoved[index] = actor?.removed ? 1 : 0;
      });

      let gateState = computeRaisedPlayerGateSet(state);
      let orangeButtonsPressed = areOrangeButtonsPressed(state);

      for (let iteration = 0; iteration < 4; iteration += 1) {
        const changed = syncWeightlessGroupElevations(
          state,
          gateState,
          orangeButtonsPressed,
          true
        );

        gateState = computeRaisedPlayerGateSet(state);
        orangeButtonsPressed = areOrangeButtonsPressed(state);

        if (!changed) {
          break;
        }
      }

      for (let index = 0; index < actorCount; index += 1) {
        if (isPlayerActor(index)) {
          if (hasExplicitElevation(actorSource[index])) {
            continue;
          }

          state.actorElevation[index] =
            playerSurfaceHeightAt(
              state,
              state.actorX[index],
              state.actorY[index],
              gateState,
              orangeButtonsPressed
            ) ?? 0;
        }
      }

      return state;
    }

    function hasExplicitElevation(actor) {
      return Object.prototype.hasOwnProperty.call(actor ?? {}, "elevation");
    }

    function initialActorElevation(actor, index) {
      if (hasExplicitElevation(actor)) {
        return actor?.elevation ?? 0;
      }

      if (!isSupportActorType(actorTypes[index]) && !isCollectibleType(actorTypes[index])) {
        return 0;
      }

      const x = Number.isInteger(actor?.x) ? actor.x : 0;
      const y = Number.isInteger(actor?.y) ? actor.y : 0;
      let elevation = 0;

      for (let other = 0; other < index; other += 1) {
        const otherActor = actorSource[other];

        if (
          isSupportActorType(actorTypes[other]) &&
          !otherActor?.removed &&
          (Number.isInteger(otherActor?.x) ? otherActor.x : 0) === x &&
          (Number.isInteger(otherActor?.y) ? otherActor.y : 0) === y
        ) {
          elevation = Math.max(elevation, (actorInitialElevations[other] || 0) + 1);
        }
      }

      return elevation;
    }

    function initializeWeightlessRelativeElevations() {
      const groupBaseElevations = new Map();

      for (let index = 0; index < actorCount; index += 1) {
        if (actorTypes[index] !== "weightless_box") {
          continue;
        }

        const groupId = actorGroupIds[index];
        const elevation = actorInitialElevations[index] || 0;
        const groupBase = groupBaseElevations.has(groupId)
          ? Math.min(groupBaseElevations.get(groupId), elevation)
          : elevation;

        groupBaseElevations.set(groupId, groupBase);
      }

      for (let index = 0; index < actorCount; index += 1) {
        if (actorTypes[index] !== "weightless_box") {
          continue;
        }

        weightlessRelativeElevations[index] =
          (actorInitialElevations[index] || 0) -
          (groupBaseElevations.get(actorGroupIds[index]) || 0);
      }
    }

    function syncWeightlessGroupElevations(
      state,
      gateState,
      orangeButtonsPressed,
      preserveAuthoredElevations = false
    ) {
      const initializedWeightlessGroups = new Set();
      let changed = false;

      for (let index = 0; index < actorCount; index += 1) {
        if (actorTypes[index] !== "weightless_box" || state.actorRemoved[index]) {
          continue;
        }

        const groupId = actorGroupIds[index];

        if (initializedWeightlessGroups.has(groupId)) {
          continue;
        }

        initializedWeightlessGroups.add(groupId);

        const members = weightlessGroupMembers(state, groupId);

        if (
          preserveAuthoredElevations &&
          members.every((member) => hasExplicitElevation(actorSource[member]))
        ) {
          continue;
        }

        const baseElevation = weightlessGroupSupportedElevation(
          state,
          members,
          gateState,
          orangeButtonsPressed
        );

        members.forEach((member) => {
          const elevation = baseElevation + (weightlessRelativeElevations[member] || 0);

          if (state.actorElevation[member] !== elevation) {
            state.actorElevation[member] = elevation;
            changed = true;
          }
        });
      }

      return changed;
    }

    function createStateBuffer() {
      return {
        actorElevation: new Int16Array(actorCount),
        actorRemoved: new Uint8Array(actorCount),
        actorX: new Int16Array(actorCount),
        actorY: new Int16Array(actorCount),
        liftRaised: new Uint8Array(cellCount),
        terrain: new Uint8Array(cellCount)
      };
    }

    function cloneState(state) {
      return {
        actorElevation: new Int16Array(state.actorElevation),
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
    const searchOccupiedSnapshot = new Set();

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
      return state.actorElevation[actorIndex] || 0;
    }

    function occupiedElevationKey(x, y, elevation) {
      return `${x},${y},${elevation || 0}`;
    }

    function isOccupiedAtElevation(occupied, x, y, elevation) {
      return occupied.has(occupiedElevationKey(x, y, elevation));
    }

    function addOccupiedAtElevation(occupied, x, y, elevation) {
      occupied.add(occupiedElevationKey(x, y, elevation));
    }

    function removeOccupiedAtElevation(occupied, x, y, elevation) {
      occupied.delete(occupiedElevationKey(x, y, elevation));
    }

    function terrainLayersForCell(state, cell) {
      if (state.terrain[cell] !== baseTerrain[cell]) {
        const type = state.terrain[cell];

        return type === terrainTypes.empty
          ? []
          : [
              {
                type,
                elevation: 0,
                raised: state.liftRaised[cell] === 1
              }
            ];
      }

      return terrainLayers[cell] || [];
    }

    function terrainLayerSurfaceHeight(state, cell, layer, gateState, orangeButtonsPressed) {
      if (layer.type === terrainTypes.empty || layer.type === terrainTypes.hole) {
        return null;
      }

      if (layer.type === terrainTypes.wall || layer.type === terrainTypes.ice_block) {
        return layer.elevation + 1;
      }

      if (layer.type === terrainTypes.tree) {
        return layer.elevation + 3;
      }

      if (layer.type === terrainTypes.player_gate) {
        return gateState.has(cell) ? layer.elevation + 1 : layer.elevation;
      }

      if (layer.type === terrainTypes.player_lift) {
        return state.liftRaised[cell] === 1 ? layer.elevation + 1 : layer.elevation;
      }

      if (layer.type === terrainTypes.orange_wall) {
        return orangeButtonsPressed ? layer.elevation : layer.elevation + 1;
      }

      return layer.elevation;
    }

    function terrainSurfaceHeightsAt(
      state,
      x,
      y,
      gateState,
      orangeButtonsPressed = areOrangeButtonsPressed(state)
    ) {
      if (!isInsideBoard(x, y)) {
        return [];
      }

      const cell = cellIndex(x, y);
      const heights = [];

      terrainLayersForCell(state, cell).forEach((layer) => {
        const height = terrainLayerSurfaceHeight(
          state,
          cell,
          layer,
          gateState,
          orangeButtonsPressed
        );

        if (height !== null) {
          heights.push(height);
        }
      });

      return heights;
    }

    function terrainSurfaceHeightAt(
      state,
      x,
      y,
      gateState,
      orangeButtonsPressed = areOrangeButtonsPressed(state)
    ) {
      const heights = terrainSurfaceHeightsAt(state, x, y, gateState, orangeButtonsPressed);

      return heights.length > 0 ? Math.max(...heights) : null;
    }

    function terrainSupportsElevation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed = areOrangeButtonsPressed(state)
    ) {
      return terrainSurfaceHeightsAt(state, x, y, gateState, orangeButtonsPressed).includes(elevation);
    }

    function terrainLayerOfTypeAtElevation(
      state,
      x,
      y,
      type,
      elevation,
      gateState,
      orangeButtonsPressed = areOrangeButtonsPressed(state)
    ) {
      if (!isInsideBoard(x, y)) {
        return null;
      }

      const cell = cellIndex(x, y);

      return (
        terrainLayersForCell(state, cell).find((layer) => {
          if (layer.type !== type) {
            return false;
          }

          if (type === terrainTypes.hole) {
            return layer.elevation === elevation;
          }

          return (
            terrainLayerSurfaceHeight(state, cell, layer, gateState, orangeButtonsPressed) ===
            elevation
          );
        }) || null
      );
    }

    function terrainLayersOfType(x, y, type) {
      if (!isInsideBoard(x, y)) {
        return [];
      }

      return terrainLayers[cellIndex(x, y)].filter((layer) => layer.type === type);
    }

    function isIce(state, x, y, elevation = 0, gateState = computeRaisedPlayerGateSet(state), orangeButtonsPressed = areOrangeButtonsPressed(state)) {
      return Boolean(
        terrainLayerOfTypeAtElevation(
          state,
          x,
          y,
          terrainTypes.ice,
          elevation,
          gateState,
          orangeButtonsPressed
        ) ||
        terrainLayerOfTypeAtElevation(
          state,
          x,
          y,
          terrainTypes.ice_block,
          elevation,
          gateState,
          orangeButtonsPressed
        )
      );
    }

    function isHole(state, x, y, elevation = 0) {
      return Boolean(
        terrainLayerOfTypeAtElevation(
          state,
          x,
          y,
          terrainTypes.hole,
          elevation,
          new Set(),
          false
        )
      );
    }

    function isIceOrHole(state, x, y, elevation = 0, gateState = computeRaisedPlayerGateSet(state), orangeButtonsPressed = areOrangeButtonsPressed(state)) {
      return (
        isIce(state, x, y, elevation, gateState, orangeButtonsPressed) ||
        isHole(state, x, y, elevation)
      );
    }

    function isPlayerLift(x, y) {
      return terrainLayersOfType(x, y, terrainTypes.player_lift).length > 0;
    }

    function playerLiftLayerAtElevation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed = areOrangeButtonsPressed(state)
    ) {
      return terrainLayerOfTypeAtElevation(
        state,
        x,
        y,
        terrainTypes.player_lift,
        elevation,
        gateState,
        orangeButtonsPressed
      );
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
      return terrainLayersOfType(x, y, terrainTypes.orange_wall).length > 0;
    }

    function isOrangeButtonPressed(state, cell, layer) {
      const x = cellX(cell);
      const y = cellY(cell);

      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index] || isCollectibleActor(index)) {
          continue;
        }

        if (
          state.actorX[index] === x &&
          state.actorY[index] === y &&
          actorElevation(state, index) === layer.elevation
        ) {
          return true;
        }
      }

      return false;
    }

    function areOrangeButtonsPressed(state) {
      if (orangeButtonCells.length === 0) {
        return false;
      }

      for (let index = 0; index < orangeButtonCells.length; index += 1) {
        const cell = orangeButtonCells[index];
        const buttonLayers = terrainLayersForCell(state, cell).filter(
          (layer) => layer.type === terrainTypes.orange_button
        );

        if (
          buttonLayers.length === 0 ||
          !buttonLayers.every((layer) => isOrangeButtonPressed(state, cell, layer))
        ) {
          return false;
        }
      }

      return true;
    }

    function isRaisedOrangeWall(x, y, orangeButtonsPressed) {
      return isOrangeWall(x, y) && !orangeButtonsPressed;
    }

    function isPlayerGate(x, y) {
      return terrainLayersOfType(x, y, terrainTypes.player_gate).length > 0;
    }

    function isRaisedPlayerGate(x, y, gateState) {
      return isPlayerGate(x, y) && gateState.has(cellIndex(x, y));
    }

    function isTerrainWall(state, x, y) {
      if (!isInsideBoard(x, y)) {
        return false;
      }

      return terrainLayersForCell(state, cellIndex(x, y)).some(
        (layer) =>
          layer.type === terrainTypes.wall ||
          layer.type === terrainTypes.ice_block ||
          layer.type === terrainTypes.tree
      );
    }

    function isWall(state, x, y, gateState, orangeButtonsPressed = areOrangeButtonsPressed(state), elevation = 0) {
      const height = terrainSurfaceHeightAt(state, x, y, gateState, orangeButtonsPressed);

      return height !== null && height > elevation;
    }

    function terrainLayerBlocksElevation(
      state,
      cell,
      layer,
      gateState,
      orangeButtonsPressed,
      elevation
    ) {
      const layerElevation = layer.elevation ?? 0;

      if (layer.type === terrainTypes.wall || layer.type === terrainTypes.ice_block) {
        return layerElevation === elevation;
      }

      if (layer.type === terrainTypes.tree) {
        return elevation >= layerElevation && elevation < layerElevation + 3;
      }

      if (layer.type === terrainTypes.player_gate) {
        return gateState.has(cell) && layerElevation === elevation;
      }

      if (layer.type === terrainTypes.player_lift) {
        return state.liftRaised[cell] === 1 && layerElevation === elevation;
      }

      if (layer.type === terrainTypes.orange_wall) {
        return !orangeButtonsPressed && layerElevation === elevation;
      }

      return false;
    }

    function terrainBlocksElevation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed = areOrangeButtonsPressed(state)
    ) {
      if (!isInsideBoard(x, y)) {
        return true;
      }

      const cell = cellIndex(x, y);

      return terrainLayersForCell(state, cell).some((layer) =>
        terrainLayerBlocksElevation(
          state,
          cell,
          layer,
          gateState,
          orangeButtonsPressed,
          elevation
        )
      );
    }

    function actorSupportSurfaceHeightsAt(state, x, y, ignoredActors = null, includePlayers = false) {
      const heights = [];

      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index]) {
          continue;
        }

        if (ignoredActors?.has(index)) {
          continue;
        }

        if (state.actorX[index] !== x || state.actorY[index] !== y) {
          continue;
        }

        if (!isSupportActorType(actorTypes[index])) {
          continue;
        }

        if (!includePlayers && isPlayerActor(index)) {
          continue;
        }

        heights.push(actorElevation(state, index) + 1);
      }

      return heights;
    }

    function actorSupportsElevation(state, x, y, elevation, ignoredActors = null, includePlayers = false) {
      return actorSupportSurfaceHeightsAt(state, x, y, ignoredActors, includePlayers).includes(elevation);
    }

    function canPlayerStandAtElevation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed = areOrangeButtonsPressed(state),
      ignoredActors = null
    ) {
      if (terrainBlocksElevation(state, x, y, elevation, gateState, orangeButtonsPressed)) {
        return false;
      }

      return (
        terrainSupportsElevation(state, x, y, elevation, gateState, orangeButtonsPressed) ||
        actorSupportsElevation(state, x, y, elevation, ignoredActors, false)
      );
    }

    function weightlessGroupSupportedElevation(state, members, gateState, orangeButtonsPressed) {
      const memberSet = new Set(members);
      let baseElevation = 0;

      members.forEach((member) => {
        const x = state.actorX[member];
        const y = state.actorY[member];
        const currentElevation = actorElevation(state, member);
        const relativeElevation = weightlessRelativeElevations[member] || 0;
        const supportHeights = terrainSurfaceHeightsAt(
          state,
          x,
          y,
          gateState,
          orangeButtonsPressed
        ).concat(actorSupportSurfaceHeightsAt(state, x, y, memberSet, true));

        supportHeights.forEach((height) => {
          if (height > currentElevation + 1) {
            return;
          }

          baseElevation = Math.max(baseElevation, height - relativeElevation);
        });
      });

      return Math.max(0, baseElevation);
    }

    function playerSurfaceHeightAt(
      state,
      x,
      y,
      gateState,
      orangeButtonsPressed = areOrangeButtonsPressed(state),
      currentElevation = null
    ) {
      if (
        Number.isInteger(currentElevation) &&
        canPlayerStandAtElevation(
          state,
          x,
          y,
          currentElevation,
          gateState,
          orangeButtonsPressed
        )
      ) {
        return currentElevation;
      }

      const heights = terrainSurfaceHeightsAt(state, x, y, gateState, orangeButtonsPressed).concat(
        actorSupportSurfaceHeightsAt(state, x, y, null, false)
      );

      return heights.length > 0 ? Math.max(...heights) : null;
    }

    function computeRaisedPlayerGateSet(state) {
      const players = [];
      const raised = new Set();

      for (let index = 0; index < actorCount; index += 1) {
        if (state.actorRemoved[index]) {
          continue;
        }

        if (isPlayerActor(index)) {
          players.push(index);
        }
      }

      playerGateCells.forEach((gateCell) => {
        const x = cellX(gateCell);
        const y = cellY(gateCell);
        const gateLayers = terrainLayersForCell(state, gateCell).filter(
          (layer) => layer.type === terrainTypes.player_gate
        );

        for (const gateLayer of gateLayers) {
          for (const player of players) {
            if (
              actorElevation(state, player) === gateLayer.elevation + 1 &&
              state.actorX[player] === x &&
              state.actorY[player] === y
            ) {
              raised.add(gateCell);
              return;
            }
          }

          const isOccupied = actorAt(
            state,
            x,
            y,
            (actor) => !isCollectibleActor(actor) && actorElevation(state, actor) === gateLayer.elevation
          );

          if (isOccupied !== -1) {
            continue;
          }

          for (const player of players) {
            if (
              actorElevation(state, player) === gateLayer.elevation &&
              Math.abs(state.actorX[player] - x) + Math.abs(state.actorY[player] - y) === 1
            ) {
              raised.add(gateCell);
              return;
            }
          }
        }
      });

      return raised;
    }

    function buildOccupiedMap(state, excludedActor = -1) {
      const occupied = new Set();

      for (let index = 0; index < actorCount; index += 1) {
        if (index === excludedActor || state.actorRemoved[index] || isCollectibleActor(index)) {
          continue;
        }

        addOccupiedAtElevation(
          occupied,
          state.actorX[index],
          state.actorY[index],
          actorElevation(state, index)
        );
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

    function canMoveInto(state, x, y, occupied, gateState, orangeButtonsPressed, elevation = 0) {
      if (!isInsideBoard(x, y)) {
        return false;
      }

      if (terrainBlocksElevation(state, x, y, elevation, gateState, orangeButtonsPressed)) {
        return false;
      }

      if (
        !(elevation === 0 && isHole(state, x, y, 0)) &&
        !terrainSupportsElevation(state, x, y, elevation, gateState, orangeButtonsPressed)
      ) {
        return false;
      }

      return !isOccupiedAtElevation(occupied, x, y, elevation);
    }

    function findSlideDestination(state, startX, startY, dx, dy, occupied, gateState, orangeButtonsPressed, elevation = 0) {
      let nextX = startX;
      let nextY = startY;

      while (canMoveInto(state, nextX + dx, nextY + dy, occupied, gateState, orangeButtonsPressed, elevation)) {
        nextX += dx;
        nextY += dy;

        if (!isIce(state, nextX, nextY, elevation, gateState, orangeButtonsPressed)) {
          break;
        }
      }

      return { x: nextX, y: nextY };
    }

    function moveBox(state, actorIndex, dx, dy, occupied, moves, gateState, orangeButtonsPressed, searchMode) {
      const fromX = state.actorX[actorIndex];
      const fromY = state.actorY[actorIndex];
      const elevation = actorElevation(state, actorIndex);
      removeOccupiedAtElevation(occupied, fromX, fromY, elevation);

      const target = findSlideDestination(
        state,
        fromX,
        fromY,
        dx,
        dy,
        occupied,
        gateState,
        orangeButtonsPressed,
        elevation
      );

      if (target.x === fromX && target.y === fromY) {
        addOccupiedAtElevation(occupied, fromX, fromY, elevation);
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
      addOccupiedAtElevation(occupied, target.x, target.y, elevation);
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
      elevation,
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
        (actor) =>
          isCollectibleActor(actor) &&
          actorElevation(state, actor) === elevation &&
          !collectedGems.has(actor)
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
      elevation,
      moves,
      collectedGems,
      searchMode
    ) {
      const travelDistance = Math.abs(toX - fromX) + Math.abs(toY - fromY);
      collectGemsAt(
        state,
        toX,
        toY,
        elevation,
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

      return !terrainBlocksElevation(
        state,
        targetX,
        targetY,
        actorElevation(state, member),
        gateState,
        orangeButtonsPressed
      );
    }

    function canMoveWeightlessGroup(state, members, dx, dy, occupied, gateState, orangeButtonsPressed) {
      return members.every((member) => {
        const targetX = state.actorX[member] + dx;
        const targetY = state.actorY[member] + dy;

        if (!canWeightlessMemberEnter(state, member, targetX, targetY, gateState, orangeButtonsPressed)) {
          return false;
        }

        return !isOccupiedAtElevation(
          occupied,
          targetX,
          targetY,
          actorElevation(state, member)
        );
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
                actorElevation(state, candidate) === actorElevation(state, member) &&
                !(actorTypes[candidate] === "weightless_box" && clusterGroupIds.has(actorGroupIds[candidate]))
            );

            if (blocker === -1) {
              continue;
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
      const groupElevation = Math.min(...members.map((member) => actorElevation(state, member)));

      members.forEach((member) => {
        removeOccupiedAtElevation(
          occupied,
          state.actorX[member],
          state.actorY[member],
          actorElevation(state, member)
        );
      });

      let moved = false;

      while (canMoveWeightlessGroup(state, members, dx, dy, occupied, gateState, orangeButtonsPressed)) {
        members.forEach((member) => {
          state.actorX[member] += dx;
          state.actorY[member] += dy;
        });

        moved = true;

        if (
          members.every((member) =>
            isHole(state, state.actorX[member], state.actorY[member], actorElevation(state, member))
          )
        ) {
          break;
        }

        if (
          groupElevation !== 0 ||
          !members.every((member) =>
            isIceOrHole(
              state,
              state.actorX[member],
              state.actorY[member],
              actorElevation(state, member),
              gateState,
              orangeButtonsPressed
            )
          )
        ) {
          break;
        }
      }

      if (!moved) {
        startPositions.forEach(({ fromElevation, fromX, fromY }) => {
          addOccupiedAtElevation(occupied, fromX, fromY, fromElevation);
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
        addOccupiedAtElevation(
          occupied,
          state.actorX[member],
          state.actorY[member],
          actorElevation(state, member)
        );
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

          const memberElevation = actorElevation(state, member);
          const canEnterHole = memberElevation === 0 && isHole(state, targetX, targetY, 0);

          if (
            !isInsideBoard(targetX, targetY) ||
            (!canEnterHole &&
              !terrainSupportsElevation(
                state,
                targetX,
                targetY,
                memberElevation,
                gateState,
                orangeButtonsPressed
              ))
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
              !isCollectibleActor(candidate) &&
              actorElevation(state, candidate) === actorElevation(state, member)
          );

          if (blocker === -1) {
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

        if (
          move.actorType === "floating_floor" &&
          isHole(
            state,
            state.actorX[move.actorIndex],
            state.actorY[move.actorIndex],
            move.toElevation ?? actorElevation(state, move.actorIndex)
          )
        ) {
          move.toRemoved = true;
          move.skipHoleFall = true;
          move.visibleDuringMove = true;
          move.fillsHole = true;
          move.fillHoleX = state.actorX[move.actorIndex];
          move.fillHoleY = state.actorY[move.actorIndex];
          return;
        }

        if (
          isHole(
            state,
            state.actorX[move.actorIndex],
            state.actorY[move.actorIndex],
            move.toElevation ?? actorElevation(state, move.actorIndex)
          ) &&
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
      const originalElevations = new Int16Array(state.actorElevation);
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
              playerSurfaceHeightAt(
                state,
                x,
                y,
                gateState,
                orangeButtonsPressed,
                actorElevation(state, index)
              ) ?? 0;

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
          const baseElevation = weightlessGroupSupportedElevation(
            state,
            members,
            gateState,
            orangeButtonsPressed
          );

          members.forEach((member) => {
            const toElevation = baseElevation + (weightlessRelativeElevations[member] || 0);

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
          playerSurfaceHeightAt(
            state,
            x,
            y,
            gateState,
            orangeButtonsPressed,
            actorElevation(state, index)
          ) ?? 0;

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
        const baseElevation = weightlessGroupSupportedElevation(
          state,
          members,
          gateState,
          orangeButtonsPressed
        );
        const groupMovedOrChangedElevation = members.some(
          (member) =>
            moveByActor.has(member) ||
            (originalElevations[member] || 0) !==
              baseElevation + (weightlessRelativeElevations[member] || 0)
        );
        const shouldFallIntoHole =
          groupMovedOrChangedElevation &&
          members.length > 0 &&
          members.every((member) => {
            const toElevation = baseElevation + (weightlessRelativeElevations[member] || 0);

            return isHole(state, state.actorX[member], state.actorY[member], toElevation);
          });

        members.forEach((member) => {
          const toElevation = baseElevation + (weightlessRelativeElevations[member] || 0);

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
        removeOccupiedAtElevation(occupied, fromX, fromY, fromElevation);

        let nextX = fromX;
        let nextY = fromY;

        while (true) {
          const targetX = nextX + dx;
          const targetY = nextY + dy;
          const isInitialStep = nextX === fromX && nextY === fromY;
          const canEnterHole = fromElevation === 0 && isHole(state, targetX, targetY, 0);
          const canStandAtTarget = canPlayerStandAtElevation(
            state,
            targetX,
            targetY,
            fromElevation,
            raisedPlayerGates,
            orangeButtonsPressed,
            new Set([player])
          );

          if (
            !isInsideBoard(targetX, targetY) ||
            (!canEnterHole && !canStandAtTarget)
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
              const occupiedSnapshot = occupiedSnapshotBuffer || new Set(occupied);
              const moveCount = moves.length;
              const pushBudget = countSupportingPlayers(state, player, dx, dy);

              if (attemptSnapshotBuffer) {
                copyStateInto(attemptSnapshotBuffer, state);
              }

              if (occupiedSnapshotBuffer) {
                occupiedSnapshotBuffer.clear();
                occupied.forEach((key) => occupiedSnapshotBuffer.add(key));
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
                occupied.clear();
                occupiedSnapshot.forEach((key) => occupied.add(key));
                moves.length = moveCount;
              }
            }

            if (!didMoveBlockingActor) {
              break;
            }
          }

          nextX = targetX;
          nextY = targetY;

          if (!isIce(state, nextX, nextY, fromElevation, raisedPlayerGates, orangeButtonsPressed)) {
            break;
          }
        }

        if (nextX !== fromX || nextY !== fromY) {
          state.actorX[player] = nextX;
          state.actorY[player] = nextY;
          let toElevation = fromElevation;

          const playerLiftLayer = playerLiftLayerAtElevation(
            state,
            nextX,
            nextY,
            fromElevation,
            raisedPlayerGates,
            orangeButtonsPressed
          );

          if (playerLiftLayer) {
            const toRaised = !isRaisedPlayerLift(state, nextX, nextY);
            pendingLiftToggles.push({
              x: nextX,
              y: nextY,
              raised: toRaised
            });
            toElevation = playerLiftLayer.elevation + (toRaised ? 1 : 0);
          } else {
            toElevation =
              playerSurfaceHeightAt(
                state,
                nextX,
                nextY,
                raisedPlayerGates,
                orangeButtonsPressed,
                fromElevation
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
            !isHole(state, nextX, nextY, toElevation)
          ) {
            collectGemsAtEndpoint(
              state,
              fromX,
              fromY,
              nextX,
              nextY,
              toElevation,
              moves,
              collectedGems,
              searchMode
            );
          }
        }

        addOccupiedAtElevation(
          occupied,
          state.actorX[player],
          state.actorY[player],
          actorElevation(state, player)
        );
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
        if (!isPlayerActor(player) || state.actorRemoved[player]) {
          continue;
        }

        if (
          state.actorX[player] === state.actorX[gem] &&
          state.actorY[player] === state.actorY[gem] &&
          actorElevation(state, player) === actorElevation(state, gem)
        ) {
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
            actorElevation(state, player) === actorElevation(state, gem)
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
