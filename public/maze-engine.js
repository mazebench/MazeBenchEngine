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
    ice_block: 11,
    shrub: 12,
    block_asset: 13,
    ice_slope: 14
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

  function isNonBlockingType(type) {
    return isCollectibleType(type) || type === "puncher";
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

  function normalizePuncherDirection(direction) {
    const value = String(direction || "").toLowerCase();

    if (value === "left" || value === "l" || value === "-1,0") {
      return "left";
    }

    if (value === "up" || value === "u" || value === "0,-1") {
      return "up";
    }

    if (value === "down" || value === "d" || value === "0,1") {
      return "down";
    }

    return "right";
  }

  function puncherDirectionVector(direction) {
    const normalized = normalizePuncherDirection(direction);

    if (normalized === "left") {
      return { dx: -1, dy: 0 };
    }

    if (normalized === "up") {
      return { dx: 0, dy: -1 };
    }

    if (normalized === "down") {
      return { dx: 0, dy: 1 };
    }

    return { dx: 1, dy: 0 };
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
          direction: typeof layer?.direction === "string" ? layer.direction : null,
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
    const actorDirections = actorSource.map((actor) =>
      normalizePuncherDirection(actor?.direction || actor?.facing)
    );
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

    function isNonBlockingActor(actorIndex) {
      return isNonBlockingType(actorTypes[actorIndex]);
    }

    function isPuncherActor(actorIndex) {
      return actorTypes[actorIndex] === "puncher";
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

      if (
        layer.type === terrainTypes.wall ||
        layer.type === terrainTypes.ice_block ||
        layer.type === terrainTypes.ice_slope ||
        layer.type === terrainTypes.shrub ||
        layer.type === terrainTypes.block_asset
      ) {
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

    function iceSlopeLayersAt(state, x, y) {
      if (!isInsideBoard(x, y)) {
        return [];
      }

      return terrainLayersForCell(state, cellIndex(x, y)).filter(
        (layer) => layer.type === terrainTypes.ice_slope
      );
    }

    function vectorMatches(left, right) {
      return left.dx === right.dx && left.dy === right.dy;
    }

    function iceSlopeTraversalForEntry(
      state,
      slopeX,
      slopeY,
      dx,
      dy,
      elevation
    ) {
      const moveVector = { dx, dy };

      for (const layer of iceSlopeLayersAt(state, slopeX, slopeY)) {
        const layerElevation = layer.elevation ?? 0;
        const uphill = puncherDirectionVector(layer.direction);
        const downhill = { dx: -uphill.dx, dy: -uphill.dy };

        if (vectorMatches(moveVector, uphill) && elevation === layerElevation) {
          return {
            entryElevation: elevation,
            exitElevation: layerElevation + 1,
            exitX: slopeX + uphill.dx,
            exitY: slopeY + uphill.dy,
            slopeX,
            slopeY,
            slopeLayer: layer
          };
        }

        if (vectorMatches(moveVector, downhill) && elevation === layerElevation + 1) {
          return {
            entryElevation: elevation,
            exitElevation: layerElevation,
            exitX: slopeX + downhill.dx,
            exitY: slopeY + downhill.dy,
            slopeX,
            slopeY,
            slopeLayer: layer
          };
        }
      }

      return null;
    }

    function iceSlopeTraversalPathPoints(traversal) {
      const isUphill = traversal.exitElevation > traversal.entryElevation;

      return [
        {
          x: traversal.slopeX,
          y: traversal.slopeY,
          elevation: isUphill ? traversal.exitElevation : traversal.entryElevation
        }
      ];
    }

    function iceSlopeExitCenterPoint(traversal) {
      return {
        x: traversal.exitX,
        y: traversal.exitY,
        elevation: traversal.exitElevation
      };
    }

    function iceSlopeTopSlideLayersAt(state, x, y, elevation) {
      return iceSlopeLayersAt(state, x, y)
        .filter((layer) => (layer.elevation ?? 0) + 1 === elevation)
        .sort((left, right) => right.elevation - left.elevation);
    }

    function resolveIceSlopeTopSlideTraversal(
      state,
      slopeX,
      slopeY,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      options = {}
    ) {
      for (const layer of iceSlopeTopSlideLayersAt(state, slopeX, slopeY, elevation)) {
        const uphill = puncherDirectionVector(layer.direction);
        const downhill = { dx: -uphill.dx, dy: -uphill.dy };
        let traversal = resolveIceSlopeTraversal(
          state,
          slopeX,
          slopeY,
          downhill.dx,
          downhill.dy,
          elevation,
          occupied,
          gateState,
          orangeButtonsPressed,
          options
        );

        if (!traversal && typeof options.pushSlopeBlocker === "function") {
          const blockedSlope = blockedIceSlopePushForEntry(
            state,
            slopeX,
            slopeY,
            downhill.dx,
            downhill.dy,
            elevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options.ignoredActors || new Set()
          );

          if (blockedSlope && options.pushSlopeBlocker(blockedSlope.blocker, downhill.dx, downhill.dy)) {
            traversal = resolveIceSlopeTraversal(
              state,
              slopeX,
              slopeY,
              downhill.dx,
              downhill.dy,
              elevation,
              occupied,
              gateState,
              orangeButtonsPressed,
              options
            );
          }
        }

        if (traversal) {
          return traversal;
        }
      }

      return null;
    }

    function samePathPoint(left, right) {
      return (
        left &&
        right &&
        left.x === right.x &&
        left.y === right.y &&
        left.elevation === right.elevation
      );
    }

    function appendPathPoints(path, points) {
      points.forEach((point) => {
        if (!samePathPoint(path[path.length - 1], point)) {
          path.push(point);
        }
      });
    }

    function pathOffsetsForTraversal(traversal, fromX, fromY, fromElevation) {
      return traversal.path.map((point) => ({
        dx: point.x - fromX,
        dy: point.y - fromY,
        elevation: point.elevation - fromElevation
      }));
    }

    function samePathOffset(left, right) {
      return (
        left &&
        right &&
        left.dx === right.dx &&
        left.dy === right.dy &&
        left.elevation === right.elevation
      );
    }

    function samePathOffsets(left, right) {
      return (
        Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((point, index) => samePathOffset(point, right[index]))
      );
    }

    function canTravelThroughSpace(
      state,
      x,
      y,
      occupied,
      gateState,
      orangeButtonsPressed,
      elevation
    ) {
      if (!isInsideBoard(x, y)) {
        return false;
      }

      if (terrainBlocksElevation(state, x, y, elevation, gateState, orangeButtonsPressed)) {
        return false;
      }

      return !isOccupiedAtElevation(occupied, x, y, elevation);
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
        if (state.actorRemoved[index] || isNonBlockingActor(index)) {
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
          layer.type === terrainTypes.ice_slope ||
          layer.type === terrainTypes.tree ||
          layer.type === terrainTypes.shrub ||
          layer.type === terrainTypes.block_asset
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

      if (
        layer.type === terrainTypes.wall ||
        layer.type === terrainTypes.ice_block ||
        layer.type === terrainTypes.block_asset
      ) {
        return layerElevation === elevation;
      }

      if (layer.type === terrainTypes.ice_slope) {
        return elevation === layerElevation || elevation === layerElevation + 1;
      }

      if (layer.type === terrainTypes.shrub) {
        return elevation >= layerElevation && elevation <= layerElevation + 1;
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

    function landingElevationAtLocation(
      state,
      x,
      y,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      ignoredActors = null
    ) {
      if (
        canMoveIntoAtElevation(
          state,
          x,
          y,
          occupied,
          gateState,
          orangeButtonsPressed,
          elevation
        )
      ) {
        return elevation;
      }

      if (
        !isInsideBoard(x, y) ||
        terrainBlocksElevation(state, x, y, elevation, gateState, orangeButtonsPressed) ||
        isOccupiedAtElevation(occupied, x, y, elevation)
      ) {
        return null;
      }

      const supportHeights = terrainSurfaceHeightsAt(
        state,
        x,
        y,
        gateState,
        orangeButtonsPressed
      )
        .concat(actorSupportSurfaceHeightsAt(state, x, y, ignoredActors, true))
        .filter((height) => height < elevation)
        .sort((left, right) => right - left);

      return supportHeights.find(
        (height) =>
          !terrainBlocksElevation(state, x, y, height, gateState, orangeButtonsPressed) &&
          !isOccupiedAtElevation(occupied, x, y, height)
      ) ?? null;
    }

    function lacksLandingSupportAtOrBelowLocation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed,
      ignoredActors
    ) {
      const supportHeights = terrainSurfaceHeightsAt(
        state,
        x,
        y,
        gateState,
        orangeButtonsPressed
      ).concat(actorSupportSurfaceHeightsAt(state, x, y, ignoredActors, true));

      return !supportHeights.some((height) => height <= elevation);
    }

    function playerIceSlipLanding(
      state,
      player,
      fromX,
      fromY,
      targetX,
      targetY,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed
    ) {
      const ignoredActors = new Set([player]);

      if (
        !isInsideBoard(targetX, targetY) ||
        terrainBlocksElevation(state, targetX, targetY, elevation, gateState, orangeButtonsPressed) ||
        blockingActorAtElevation(state, targetX, targetY, elevation, player) !== -1
      ) {
        return null;
      }

      if (!isIce(state, fromX, fromY, elevation, gateState, orangeButtonsPressed)) {
        return null;
      }

      const slopeFall = iceSlopeFallTraversal(
        state,
        targetX,
        targetY,
        elevation,
        occupied,
        gateState,
        orangeButtonsPressed
      );

      if (slopeFall) {
        return {
          path: slopeFall.path,
          slopeSlide: true,
          toElevation: slopeFall.exitElevation,
          toX: slopeFall.exitX,
          toY: slopeFall.exitY
        };
      }

      const supportHeights = terrainSurfaceHeightsAt(
        state,
        targetX,
        targetY,
        gateState,
        orangeButtonsPressed
      )
        .concat(actorSupportSurfaceHeightsAt(state, targetX, targetY, ignoredActors, true))
        .filter((height) => height < elevation)
        .sort((left, right) => right - left);
      const landingElevation = supportHeights.find(
        (height) =>
          !terrainBlocksElevation(state, targetX, targetY, height, gateState, orangeButtonsPressed) &&
          blockingActorAtElevation(state, targetX, targetY, height, player) === -1
      );

      if (landingElevation === undefined && supportHeights.length > 0) {
        return null;
      }

      return {
        toElevation: landingElevation ?? elevation
      };
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
          (actor) => !isNonBlockingActor(actor) && actorElevation(state, actor) === gateLayer.elevation
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
        if (index === excludedActor || state.actorRemoved[index] || isNonBlockingActor(index)) {
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

    function canMoveIntoAtElevation(
      state,
      x,
      y,
      occupied,
      gateState,
      orangeButtonsPressed,
      elevation
    ) {
      return canMoveInto(state, x, y, occupied, gateState, orangeButtonsPressed, elevation);
    }

    function resolveIceSlopeTraversal(
      state,
      slopeX,
      slopeY,
      dx,
      dy,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      options = {}
    ) {
      let traversal = iceSlopeTraversalForEntry(state, slopeX, slopeY, dx, dy, elevation);
      const path = traversal ? iceSlopeTraversalPathPoints(traversal) : [];
      let guard = width * height + 1;

      while (traversal && guard > 0) {
        guard -= 1;

        if (
          canTravelThroughSpace(
            state,
            traversal.exitX,
            traversal.exitY,
            occupied,
            gateState,
            orangeButtonsPressed,
            traversal.exitElevation
          )
        ) {
          const resultPath = path.concat(iceSlopeExitCenterPoint(traversal)).map((point) => ({ ...point }));
          const fallTraversal = resolveIceSlopeFallTraversalForLanding(
            state,
            traversal.exitX,
            traversal.exitY,
            traversal.exitElevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options
          );

          if (fallTraversal) {
            appendPathPoints(resultPath, fallTraversal.path.map((point) => ({ ...point })));
            return {
              ...fallTraversal,
              path: resultPath
            };
          }

          return {
            ...traversal,
            path: resultPath
          };
        }

        const nextTraversal = iceSlopeTraversalForEntry(
          state,
          traversal.exitX,
          traversal.exitY,
          dx,
          dy,
          traversal.exitElevation
        );

        if (
          !nextTraversal ||
          isOccupiedAtElevation(occupied, traversal.exitX, traversal.exitY, traversal.exitElevation)
        ) {
          return null;
        }

        traversal = nextTraversal;
        appendPathPoints(path, iceSlopeTraversalPathPoints(traversal));
      }

      return null;
    }

    function blockedIceSlopeBouncePathForEntry(
      state,
      slopeX,
      slopeY,
      dx,
      dy,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed
    ) {
      let traversal = iceSlopeTraversalForEntry(state, slopeX, slopeY, dx, dy, elevation);
      const path = traversal ? iceSlopeTraversalPathPoints(traversal) : [];
      let guard = width * height + 1;

      while (traversal && guard > 0) {
        guard -= 1;

        if (
          canTravelThroughSpace(
            state,
            traversal.exitX,
            traversal.exitY,
            occupied,
            gateState,
            orangeButtonsPressed,
            traversal.exitElevation
          )
        ) {
          return null;
        }

        const nextTraversal = iceSlopeTraversalForEntry(
          state,
          traversal.exitX,
          traversal.exitY,
          dx,
          dy,
          traversal.exitElevation
        );

        if (
          !nextTraversal ||
          isOccupiedAtElevation(occupied, traversal.exitX, traversal.exitY, traversal.exitElevation)
        ) {
          return path.map((point) => ({ ...point }));
        }

        traversal = nextTraversal;
        appendPathPoints(path, iceSlopeTraversalPathPoints(traversal));
      }

      return null;
    }

    function pushableBlockingActorAtElevation(state, x, y, elevation, ignoredActors = new Set()) {
      return actorAt(
        state,
        x,
        y,
        (actor) =>
          !ignoredActors.has(actor) &&
          !isNonBlockingActor(actor) &&
          actorElevation(state, actor) === elevation &&
          isPushableActor(actor)
      );
    }

    function blockedIceSlopePushForEntry(
      state,
      slopeX,
      slopeY,
      dx,
      dy,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      ignoredActors = new Set()
    ) {
      let traversal = iceSlopeTraversalForEntry(state, slopeX, slopeY, dx, dy, elevation);
      const path = traversal ? iceSlopeTraversalPathPoints(traversal) : [];
      let guard = width * height + 1;

      while (traversal && guard > 0) {
        guard -= 1;

        if (
          canTravelThroughSpace(
            state,
            traversal.exitX,
            traversal.exitY,
            occupied,
            gateState,
            orangeButtonsPressed,
            traversal.exitElevation
          )
        ) {
          return null;
        }

        const nextTraversal = iceSlopeTraversalForEntry(
          state,
          traversal.exitX,
          traversal.exitY,
          dx,
          dy,
          traversal.exitElevation
        );

        if (!nextTraversal) {
          const blocker = !terrainBlocksElevation(
            state,
            traversal.exitX,
            traversal.exitY,
            traversal.exitElevation,
            gateState,
            orangeButtonsPressed
          )
            ? pushableBlockingActorAtElevation(
                state,
                traversal.exitX,
                traversal.exitY,
                traversal.exitElevation,
                ignoredActors
              )
            : -1;

          return blocker === -1
            ? null
            : {
                blocker,
                traversal: {
                  ...traversal,
                  path: path.concat(iceSlopeExitCenterPoint(traversal)).map((point) => ({ ...point }))
                }
              };
        }

        if (isOccupiedAtElevation(occupied, traversal.exitX, traversal.exitY, traversal.exitElevation)) {
          return null;
        }

        traversal = nextTraversal;
        appendPathPoints(path, iceSlopeTraversalPathPoints(traversal));
      }

      return null;
    }

    function iceSlopeFallTraversal(
      state,
      slopeX,
      slopeY,
      fromElevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      options = {}
    ) {
      const layers = iceSlopeLayersAt(state, slopeX, slopeY)
        .filter((layer) => layer.elevation + 1 < fromElevation)
        .sort((left, right) => right.elevation - left.elevation);

      for (const layer of layers) {
        const uphill = puncherDirectionVector(layer.direction);
        const downhill = { dx: -uphill.dx, dy: -uphill.dy };
        let traversal = resolveIceSlopeTraversal(
          state,
          slopeX,
          slopeY,
          downhill.dx,
          downhill.dy,
          layer.elevation + 1,
          occupied,
          gateState,
          orangeButtonsPressed,
          options
        );

        if (!traversal && typeof options.pushSlopeBlocker === "function") {
          const blockedSlope = blockedIceSlopePushForEntry(
            state,
            slopeX,
            slopeY,
            downhill.dx,
            downhill.dy,
            layer.elevation + 1,
            occupied,
            gateState,
            orangeButtonsPressed,
            options.ignoredActors || new Set()
          );

          if (blockedSlope && options.pushSlopeBlocker(blockedSlope.blocker, downhill.dx, downhill.dy)) {
            traversal = resolveIceSlopeTraversal(
              state,
              slopeX,
              slopeY,
              downhill.dx,
              downhill.dy,
              layer.elevation + 1,
              occupied,
              gateState,
              orangeButtonsPressed,
              options
            );
          }
        }

        if (traversal) {
          return traversal;
        }
      }

      return null;
    }

    function resolveIceSlopeFallTraversalForLanding(
      state,
      slopeX,
      slopeY,
      elevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      options = {}
    ) {
      const traversal = iceSlopeFallTraversal(
        state,
        slopeX,
        slopeY,
        elevation,
        occupied,
        gateState,
        orangeButtonsPressed,
        options
      );

      if (!traversal) {
        return null;
      }

      return {
        ...traversal,
        path: [
          { x: slopeX, y: slopeY, elevation },
          ...traversal.path.map((point) => ({ ...point }))
        ]
      };
    }

    function findSlideDestination(
      state,
      startX,
      startY,
      dx,
      dy,
      occupied,
      gateState,
      orangeButtonsPressed,
      elevation = 0,
      options = {}
    ) {
      let nextX = startX;
      let nextY = startY;
      let nextElevation = elevation;
      const path = [{ x: startX, y: startY, elevation }];

      while (true) {
        let slopeTraversal = resolveIceSlopeTraversal(
          state,
          nextX + dx,
          nextY + dy,
          dx,
          dy,
          nextElevation,
          occupied,
          gateState,
          orangeButtonsPressed,
          options
        );

        if (!slopeTraversal && typeof options.pushSlopeBlocker === "function") {
          const blockedSlope = blockedIceSlopePushForEntry(
            state,
            nextX + dx,
            nextY + dy,
            dx,
            dy,
            nextElevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options.ignoredActors || new Set()
          );

          if (blockedSlope && options.pushSlopeBlocker(blockedSlope.blocker)) {
            slopeTraversal = resolveIceSlopeTraversal(
              state,
              nextX + dx,
              nextY + dy,
              dx,
              dy,
              nextElevation,
              occupied,
              gateState,
              orangeButtonsPressed,
              options
            );
          }
        }

        if (!slopeTraversal) {
          slopeTraversal = resolveIceSlopeFallTraversalForLanding(
            state,
            nextX + dx,
            nextY + dy,
            nextElevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options
          );
        }

        if (!slopeTraversal) {
          slopeTraversal = resolveIceSlopeTopSlideTraversal(
            state,
            nextX + dx,
            nextY + dy,
            nextElevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options
          );
        }

        if (slopeTraversal) {
          nextX = slopeTraversal.exitX;
          nextY = slopeTraversal.exitY;
          nextElevation = slopeTraversal.exitElevation;
          path.push(...slopeTraversal.path);

          if (!isIce(state, nextX, nextY, nextElevation, gateState, orangeButtonsPressed)) {
            break;
          }

          continue;
        }

        if (!canMoveInto(state, nextX + dx, nextY + dy, occupied, gateState, orangeButtonsPressed, nextElevation)) {
          break;
        }

        nextX += dx;
        nextY += dy;
        path.push({ x: nextX, y: nextY, elevation: nextElevation });

        if (!isIce(state, nextX, nextY, nextElevation, gateState, orangeButtonsPressed)) {
          break;
        }
      }

      const landingElevation = landingElevationAtLocation(
        state,
        nextX,
        nextY,
        nextElevation,
        occupied,
        gateState,
        orangeButtonsPressed
      );
      const finalPath =
        landingElevation !== null && landingElevation !== nextElevation
          ? path.concat({ x: nextX, y: nextY, elevation: landingElevation })
          : path;

      return {
        elevation: landingElevation ?? nextElevation,
        hasLandingSupport: landingElevation !== null,
        path: finalPath,
        pathEndElevation: nextElevation,
        x: nextX,
        y: nextY
      };
    }

    function moveBox(
      state,
      actorIndex,
      dx,
      dy,
      occupied,
      moves,
      gateState,
      orangeButtonsPressed,
      searchMode,
      pushContext = null
    ) {
      const fromX = state.actorX[actorIndex];
      const fromY = state.actorY[actorIndex];
      const elevation = actorElevation(state, actorIndex);
      removeOccupiedAtElevation(occupied, fromX, fromY, elevation);
      const ignoredActors = new Set(pushContext?.ignoredActors || []);
      ignoredActors.add(actorIndex);

      const target = findSlideDestination(
        state,
        fromX,
        fromY,
        dx,
        dy,
        occupied,
        gateState,
        orangeButtonsPressed,
        elevation,
        pushContext
          ? {
              ignoredActors,
              pushSlopeBlocker: (blocker, pushDx = dx, pushDy = dy) => {
                if (blocker === actorIndex) {
                  return false;
                }

                const result = attemptPushActor(
                  state,
                  blocker,
                  pushDx,
                  pushDy,
                  occupied,
                  moves,
                  1,
                  pushContext.handled || new Set(),
                  gateState,
                  orangeButtonsPressed,
                  ignoredActors,
                  searchMode
                );

                return result !== null;
              }
            }
          : {}
      );

      if (target.x === fromX && target.y === fromY && target.elevation === elevation) {
        addOccupiedAtElevation(occupied, fromX, fromY, elevation);
        return false;
      }

      state.actorX[actorIndex] = target.x;
      state.actorY[actorIndex] = target.y;
      state.actorElevation[actorIndex] = target.elevation;

      const moveRecord = {
        actorIndex,
        actorType: actorTypes[actorIndex],
        fromElevation: elevation,
        fromX,
        fromY,
        toElevation: target.elevation,
        toX: target.x,
        toY: target.y
      };
      const pathControlsElevation = target.path.some((point) => point.elevation !== elevation);

      if (target.path.length > 2 || pathControlsElevation) {
        moveRecord.path = target.path;
        moveRecord.pathControlsElevation = pathControlsElevation;
        moveRecord.pathEndElevation = target.pathEndElevation;
      }

      if (!searchMode) {
        moveRecord.iceSlide =
          target.path.length > 2 ||
          Math.abs(target.x - fromX) + Math.abs(target.y - fromY) > 1 ||
          target.pathEndElevation !== elevation;

        if (target.elevation !== target.pathEndElevation || !target.hasLandingSupport) {
          moveRecord.iceSlipOff = true;
        }
      }

      moves.push(moveRecord);
      addOccupiedAtElevation(occupied, target.x, target.y, target.elevation);
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
          !isNonBlockingActor(actor) &&
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
      targetElevation,
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
        targetElevation,
        gateState,
        orangeButtonsPressed
      );
    }

    function weightlessMemberCanOccupy(
      state,
      member,
      targetX,
      targetY,
      targetElevation,
      occupied,
      gateState,
      orangeButtonsPressed
    ) {
      if (
        !canWeightlessMemberEnter(
          state,
          member,
          targetX,
          targetY,
          targetElevation,
          gateState,
          orangeButtonsPressed
        )
      ) {
        return false;
      }

      return !isOccupiedAtElevation(occupied, targetX, targetY, targetElevation);
    }

    function weightlessClusterStep(
      state,
      members,
      dx,
      dy,
      occupied,
      gateState,
      orangeButtonsPressed,
      options = {}
    ) {
      let slopeDelta = null;
      let slopePathOffsets = null;

      for (const member of members) {
        const elevation = actorElevation(state, member);
        const targetX = state.actorX[member] + dx;
        const targetY = state.actorY[member] + dy;
        let traversal = resolveIceSlopeTraversal(
          state,
          targetX,
          targetY,
          dx,
          dy,
          elevation,
          occupied,
          gateState,
          orangeButtonsPressed,
          options
        );

        if (!traversal && typeof options.pushSlopeBlocker === "function") {
          const blockedSlope = blockedIceSlopePushForEntry(
            state,
            targetX,
            targetY,
            dx,
            dy,
            elevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options.ignoredActors || new Set()
          );

          if (blockedSlope && options.pushSlopeBlocker(blockedSlope.blocker)) {
            traversal = resolveIceSlopeTraversal(
              state,
              targetX,
              targetY,
              dx,
              dy,
              elevation,
              occupied,
              gateState,
              orangeButtonsPressed,
              options
            );
          }
        }

        if (!traversal) {
          traversal = resolveIceSlopeFallTraversalForLanding(
            state,
            targetX,
            targetY,
            elevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options
          );
        }

        if (!traversal) {
          traversal = resolveIceSlopeTopSlideTraversal(
            state,
            targetX,
            targetY,
            elevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options
          );
        }

        if (!traversal) {
          continue;
        }

        const delta = {
          dx: traversal.exitX - state.actorX[member],
          dy: traversal.exitY - state.actorY[member],
          elevation: traversal.exitElevation - elevation
        };
        const pathOffsets = pathOffsetsForTraversal(
          traversal,
          state.actorX[member],
          state.actorY[member],
          elevation
        );

        if (
          slopeDelta &&
          (slopeDelta.dx !== delta.dx ||
            slopeDelta.dy !== delta.dy ||
            slopeDelta.elevation !== delta.elevation)
        ) {
          return null;
        }

        if (slopePathOffsets && !samePathOffsets(slopePathOffsets, pathOffsets)) {
          return null;
        }

        slopeDelta = delta;
        slopePathOffsets = pathOffsets;
      }

      const step = slopeDelta
        ? { ...slopeDelta, pathOffsets: slopePathOffsets || [] }
        : { dx, dy, elevation: 0, pathOffsets: [] };

      if (
        members.every((member) => {
          const targetX = state.actorX[member] + step.dx;
          const targetY = state.actorY[member] + step.dy;
          const targetElevation = actorElevation(state, member) + step.elevation;

          return weightlessMemberCanOccupy(
            state,
            member,
            targetX,
            targetY,
            targetElevation,
            occupied,
            gateState,
            orangeButtonsPressed
          );
        })
      ) {
        return step;
      }

      return null;
    }

    function collectWeightlessPushCluster(
      state,
      groupId,
      dx,
      dy,
      occupied,
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
        const clusterMembers = new Set(weightlessClusterMembers(state, clusterGroupIds));

        Array.from(clusterGroupIds).forEach((currentGroupId) => {
          const members = weightlessGroupMembers(state, currentGroupId);

          for (const member of members) {
            const memberElevation = actorElevation(state, member);
            const targetX = state.actorX[member] + dx;
            const targetY = state.actorY[member] + dy;
            const slopeTraversal = resolveIceSlopeTraversal(
              state,
              targetX,
              targetY,
              dx,
              dy,
              memberElevation,
              occupied,
              gateState,
              orangeButtonsPressed
            );
            const slopeIgnoredActors = new Set(ignoredActors);
            clusterMembers.forEach((clusterMember) => slopeIgnoredActors.add(clusterMember));
            const blockedSlope = slopeTraversal
              ? null
              : blockedIceSlopePushForEntry(
                  state,
                  targetX,
                  targetY,
                  dx,
                  dy,
                  memberElevation,
                  occupied,
                  gateState,
                  orangeButtonsPressed,
                  slopeIgnoredActors
                );
            const fallSlopeTraversal =
              slopeTraversal || blockedSlope
                ? null
                : resolveIceSlopeFallTraversalForLanding(
                    state,
                    targetX,
                    targetY,
                    memberElevation,
                    occupied,
                    gateState,
                    orangeButtonsPressed
                  );
            const topSlopeTraversal =
              slopeTraversal || blockedSlope || fallSlopeTraversal
                ? null
                : resolveIceSlopeTopSlideTraversal(
                    state,
                    targetX,
                    targetY,
                    memberElevation,
                    occupied,
                    gateState,
                    orangeButtonsPressed
                  );

            if (
              !slopeTraversal &&
              !blockedSlope &&
              !fallSlopeTraversal &&
              !topSlopeTraversal &&
              !canWeightlessMemberEnter(
                state,
                member,
                targetX,
                targetY,
                memberElevation,
                gateState,
                orangeButtonsPressed
              )
            ) {
              blockers.push(null);
              return;
            }

            if (slopeTraversal || blockedSlope || fallSlopeTraversal || topSlopeTraversal) {
              continue;
            }

            const blocker = actorAt(
              state,
              targetX,
              targetY,
              (candidate) =>
                !ignoredActors.has(candidate) &&
                candidate !== member &&
                !isNonBlockingActor(candidate) &&
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
      searchMode,
      pushContext = null
    ) {
      const members = weightlessClusterMembers(state, groupIds);

      if (members.length === 0) {
        return false;
      }

      const startPositions = members.map((actorIndex) => ({
        actorIndex,
        fromElevation: actorElevation(state, actorIndex),
        fromX: state.actorX[actorIndex],
        fromY: state.actorY[actorIndex],
        path: [
          {
            x: state.actorX[actorIndex],
            y: state.actorY[actorIndex],
            elevation: actorElevation(state, actorIndex)
          }
        ]
      }));
      const startPositionByActor = new Map(
        startPositions.map((position) => [position.actorIndex, position])
      );
      members.forEach((member) => {
        removeOccupiedAtElevation(
          occupied,
          state.actorX[member],
          state.actorY[member],
          actorElevation(state, member)
        );
      });
      const ignoredActors = new Set(pushContext?.ignoredActors || []);
      members.forEach((member) => ignoredActors.add(member));

      let moved = false;

      while (true) {
        const attemptSnapshot = pushContext ? cloneState(state) : null;
        const occupiedSnapshot = pushContext ? new Set(occupied) : null;
        const moveCount = moves.length;
        const step = weightlessClusterStep(
          state,
          members,
          dx,
          dy,
          occupied,
          gateState,
          orangeButtonsPressed,
          pushContext
            ? {
                ignoredActors,
                pushSlopeBlocker: (blocker, pushDx = dx, pushDy = dy) => {
                  if (ignoredActors.has(blocker)) {
                    return false;
                  }

                  const result = attemptPushActor(
                    state,
                    blocker,
                    pushDx,
                    pushDy,
                    occupied,
                    moves,
                    1,
                    pushContext.handled || new Set(),
                    gateState,
                    orangeButtonsPressed,
                    ignoredActors,
                    searchMode
                  );

                  return result !== null;
                }
              }
            : {}
        );

        if (!step) {
          if (attemptSnapshot && occupiedSnapshot) {
            copyStateInto(state, attemptSnapshot);
            occupied.clear();
            occupiedSnapshot.forEach((key) => occupied.add(key));
            moves.length = moveCount;
          }
          break;
        }

        members.forEach((member) => {
          const start = startPositionByActor.get(member);
          const fromElevation = actorElevation(state, member);
          const fromX = state.actorX[member];
          const fromY = state.actorY[member];
          const pathOffsets = Array.isArray(step.pathOffsets) ? step.pathOffsets : [];

          if (start) {
            if (pathOffsets.length > 0) {
              appendPathPoints(
                start.path,
                pathOffsets.map((point) => ({
                  x: fromX + point.dx,
                  y: fromY + point.dy,
                  elevation: fromElevation + point.elevation
                }))
              );
            } else if (Math.abs(step.dx) > 1 || Math.abs(step.dy) > 1 || step.elevation !== 0) {
              appendPathPoints(start.path, [
                {
                  x: fromX + step.dx / 2,
                  y: fromY + step.dy / 2,
                  elevation: fromElevation + step.elevation / 2
                }
              ]);
            }
          }

          state.actorX[member] += step.dx;
          state.actorY[member] += step.dy;
          state.actorElevation[member] += step.elevation;

          if (start) {
            appendPathPoints(start.path, [
              {
                x: state.actorX[member],
                y: state.actorY[member],
                elevation: actorElevation(state, member)
              }
            ]);
          }
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

      startPositions.forEach(({ actorIndex, fromElevation, fromX, fromY, path }) => {
        const moveRecord = {
          actorIndex,
          actorType: actorTypes[actorIndex],
          fromElevation,
          fromX,
          fromY,
          toElevation: actorElevation(state, actorIndex),
          toX: state.actorX[actorIndex],
          toY: state.actorY[actorIndex]
        };
        const pathControlsElevation = path.some((point) => point.elevation !== fromElevation);

        if (path.length > 2 || pathControlsElevation) {
          moveRecord.path = path;
          moveRecord.pathControlsElevation = pathControlsElevation;
          moveRecord.pathEndElevation = path[path.length - 1]?.elevation ?? actorElevation(state, actorIndex);
        }

        if (!searchMode) {
          moveRecord.iceSlide =
            Math.abs(state.actorX[actorIndex] - fromX) +
              Math.abs(state.actorY[actorIndex] - fromY) >
              1 ||
            actorElevation(state, actorIndex) !== fromElevation;
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
              occupied,
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
          let slopeTraversal = resolveIceSlopeTraversal(
            state,
            targetX,
            targetY,
            dx,
            dy,
            memberElevation,
            occupied,
            gateState,
            orangeButtonsPressed
          );
          const blockedSlope = slopeTraversal
            ? null
            : blockedIceSlopePushForEntry(
                state,
                targetX,
                targetY,
                dx,
                dy,
                memberElevation,
                occupied,
                gateState,
                orangeButtonsPressed,
                new Set([...ignoredActors, ...memberSet])
              );
          const fallSlopeTraversal =
            slopeTraversal || blockedSlope
              ? null
              : resolveIceSlopeFallTraversalForLanding(
                  state,
                  targetX,
                  targetY,
                  memberElevation,
                  occupied,
                  gateState,
                  orangeButtonsPressed
                );
          const topSlopeTraversal =
            slopeTraversal || blockedSlope || fallSlopeTraversal
              ? null
              : resolveIceSlopeTopSlideTraversal(
                  state,
                  targetX,
                  targetY,
                  memberElevation,
                  occupied,
                  gateState,
                  orangeButtonsPressed
                );
          const slideTraversal = slopeTraversal || fallSlopeTraversal || topSlopeTraversal;
          const blockerX = slideTraversal
            ? slideTraversal.exitX
            : blockedSlope
              ? blockedSlope.traversal.exitX
              : targetX;
          const blockerY = slideTraversal
            ? slideTraversal.exitY
            : blockedSlope
              ? blockedSlope.traversal.exitY
              : targetY;
          const blockerElevation = slideTraversal
            ? slideTraversal.exitElevation
            : blockedSlope
              ? blockedSlope.traversal.exitElevation
              : memberElevation;

          if (
            !isInsideBoard(targetX, targetY) ||
            (!slideTraversal &&
              !blockedSlope &&
              !canEnterHole &&
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

          if (blockedSlope) {
            continue;
          }

          const blocker = actorAt(
            state,
            blockerX,
            blockerY,
            (candidate) =>
              !ignoredActors.has(candidate) &&
              !memberSet.has(candidate) &&
              !isNonBlockingActor(candidate) &&
              actorElevation(state, candidate) === blockerElevation
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
              searchMode,
              {
                handled,
                ignoredActors
              }
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
              searchMode,
              {
                handled,
                ignoredActors
              }
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

    function puncherActorAt(state, x, y, elevation) {
      return actorAt(
        state,
        x,
        y,
        (actor) => isPuncherActor(actor) && actorElevation(state, actor) === elevation
      );
    }

    function canPunchActorCarryPuncher(type) {
      return type === "box" || type === "floating_floor" || type === "weightless_box";
    }

    function mergeMoveRecord(
      state,
      moves,
      actorIndex,
      originalActorX,
      originalActorY,
      originalActorElevation,
      options = {}
    ) {
      let moveRecord = moves.find((move) => move.actorIndex === actorIndex && !move.visualOnly);

      if (!moveRecord) {
        moveRecord = {
          actorIndex,
          actorType: actorTypes[actorIndex],
          fromX: originalActorX[actorIndex],
          fromY: originalActorY[actorIndex],
          toX: state.actorX[actorIndex],
          toY: state.actorY[actorIndex],
          fromElevation: originalActorElevation[actorIndex] || 0,
          toElevation: actorElevation(state, actorIndex)
        };
        moves.push(moveRecord);
      }

      moveRecord.toX = state.actorX[actorIndex];
      moveRecord.toY = state.actorY[actorIndex];
      moveRecord.toElevation = actorElevation(state, actorIndex);

      if (options.iceSlide === true) {
        moveRecord.iceSlide = true;
      }

      if (options.punchSlide === true) {
        moveRecord.punchSlide = true;
      }

      return moveRecord;
    }

    function canPunchActorStep(
      state,
      actorIndex,
      targetX,
      targetY,
      occupied,
      gateState,
      orangeButtonsPressed
    ) {
      const elevation = actorElevation(state, actorIndex);

      if (!isInsideBoard(targetX, targetY)) {
        return false;
      }

      if (terrainBlocksElevation(state, targetX, targetY, elevation, gateState, orangeButtonsPressed)) {
        return false;
      }

      return !isOccupiedAtElevation(occupied, targetX, targetY, elevation);
    }

    function punchSingleActor(
      state,
      actorIndex,
      dx,
      dy,
      occupied,
      moves,
      gateState,
      orangeButtonsPressed,
      originalActorX,
      originalActorY,
      originalActorElevation,
      searchMode
    ) {
      const fromX = state.actorX[actorIndex];
      const fromY = state.actorY[actorIndex];
      const elevation = actorElevation(state, actorIndex);
      removeOccupiedAtElevation(occupied, fromX, fromY, elevation);

      let nextX = fromX;
      let nextY = fromY;

      while (
        canPunchActorStep(
          state,
          actorIndex,
          nextX + dx,
          nextY + dy,
          occupied,
          gateState,
          orangeButtonsPressed
        )
      ) {
        nextX += dx;
        nextY += dy;
      }

      if (nextX === fromX && nextY === fromY) {
        addOccupiedAtElevation(occupied, fromX, fromY, elevation);
        return false;
      }

      state.actorX[actorIndex] = nextX;
      state.actorY[actorIndex] = nextY;
      addOccupiedAtElevation(occupied, nextX, nextY, elevation);

      if (!searchMode) {
        mergeMoveRecord(
          state,
          moves,
          actorIndex,
          originalActorX,
          originalActorY,
          originalActorElevation,
          {
            iceSlide: true,
            punchSlide: true
          }
        );
      } else {
        mergeMoveRecord(state, moves, actorIndex, originalActorX, originalActorY, originalActorElevation, {
          punchSlide: true
        });
      }

      return true;
    }

    function canPunchWeightlessStep(state, members, dx, dy, occupied, gateState, orangeButtonsPressed) {
      const memberSet = new Set(members);

      return members.every((member) => {
        const targetX = state.actorX[member] + dx;
        const targetY = state.actorY[member] + dy;
        const elevation = actorElevation(state, member);

        if (!isInsideBoard(targetX, targetY)) {
          return false;
        }

        if (terrainBlocksElevation(state, targetX, targetY, elevation, gateState, orangeButtonsPressed)) {
          return false;
        }

        const blocker = actorAt(
          state,
          targetX,
          targetY,
          (actor) =>
            !memberSet.has(actor) &&
            !isNonBlockingActor(actor) &&
            actorElevation(state, actor) === elevation
        );

        if (blocker !== -1) {
          return false;
        }

        return !isOccupiedAtElevation(occupied, targetX, targetY, elevation);
      });
    }

    function punchWeightlessGroup(
      state,
      actorIndex,
      dx,
      dy,
      occupied,
      moves,
      gateState,
      orangeButtonsPressed,
      originalActorX,
      originalActorY,
      originalActorElevation,
      searchMode
    ) {
      const members = weightlessGroupMembers(state, actorGroupIds[actorIndex]);

      if (members.length === 0) {
        return false;
      }

      members.forEach((member) => {
        removeOccupiedAtElevation(
          occupied,
          state.actorX[member],
          state.actorY[member],
          actorElevation(state, member)
        );
      });

      let moved = false;

      while (
        canPunchWeightlessStep(state, members, dx, dy, occupied, gateState, orangeButtonsPressed)
      ) {
        members.forEach((member) => {
          state.actorX[member] += dx;
          state.actorY[member] += dy;
        });
        moved = true;
      }

      members.forEach((member) => {
        addOccupiedAtElevation(
          occupied,
          state.actorX[member],
          state.actorY[member],
          actorElevation(state, member)
        );
      });

      if (!moved) {
        return false;
      }

      members.forEach((member) => {
        mergeMoveRecord(
          state,
          moves,
          member,
          originalActorX,
          originalActorY,
          originalActorElevation,
          {
            iceSlide: !searchMode,
            punchSlide: true
          }
        );
      });

      return true;
    }

    function punchStartSnapshotsForActor(state, actorIndex, moves) {
      const members =
        actorTypes[actorIndex] === "weightless_box"
          ? weightlessGroupMembers(state, actorGroupIds[actorIndex])
          : [actorIndex];

      return members.map((member) => {
        const moveRecord = moves.find((move) => move.actorIndex === member && !move.visualOnly);

        return {
          actorIndex: member,
          elevation: actorElevation(state, member),
          iceSlide: moveRecord?.iceSlide === true,
          x: state.actorX[member],
          y: state.actorY[member]
        };
      });
    }

    function markPunchStartOnMoves(moves, punchStarts) {
      punchStarts.forEach(({ actorIndex, elevation, iceSlide, x, y }) => {
        const moveRecord = moves.find((move) => move.actorIndex === actorIndex && !move.visualOnly);

        if (!moveRecord || typeof moveRecord.punchStartX === "number") {
          return;
        }

        moveRecord.punchStartX = x;
        moveRecord.punchStartY = y;
        moveRecord.punchStartElevation = elevation;
        moveRecord.punchStartIceSlide = iceSlide === true;
      });
    }

    function addPuncherVisualMove(
      state,
      puncher,
      targetX,
      targetY,
      moves,
      originalActorX,
      originalActorY,
      originalActorElevation,
      searchMode
    ) {
      if (searchMode || moves.some((move) => move.actorIndex === puncher)) {
        return;
      }

      moves.push({
        actorIndex: puncher,
        actorType: actorTypes[puncher],
        fromX: state.actorX[puncher],
        fromY: state.actorY[puncher],
        toX: targetX,
        toY: targetY,
        finalX: state.actorX[puncher],
        finalY: state.actorY[puncher],
        fromElevation: actorElevation(state, puncher),
        toElevation: actorElevation(state, puncher),
        finalElevation: actorElevation(state, puncher),
        iceSlide: true,
        punchEffect: true,
        visualOnly: true
      });
    }

    function puncherWasAttachedToActorAtMoveStart(
      puncher,
      actorIndex,
      originalActorX,
      originalActorY,
      originalActorElevation
    ) {
      if (!canPunchActorCarryPuncher(actorTypes[actorIndex])) {
        return false;
      }

      const { dx, dy } = puncherDirectionVector(actorDirections[puncher]);

      return (
        statePositionEquals(
          originalActorX[puncher],
          originalActorY[puncher],
          originalActorElevation[puncher] || 0,
          originalActorX[actorIndex] + dx,
          originalActorY[actorIndex] + dy,
          originalActorElevation[actorIndex] || 0
        )
      );
    }

    function statePositionEquals(leftX, leftY, leftElevation, rightX, rightY, rightElevation) {
      return leftX === rightX && leftY === rightY && leftElevation === rightElevation;
    }

    function applyPunchers(
      state,
      moves,
      originalActorX,
      originalActorY,
      originalActorElevation,
      searchMode
    ) {
      if (!actorTypes.includes("puncher")) {
        return;
      }

      const triggered = new Set();
      let triggeredThisPass = true;
      let passCount = 0;

      while (triggeredThisPass && passCount < actorCount + width + height) {
        triggeredThisPass = false;
        passCount += 1;

        const occupied = buildOccupiedMap(state);
        const gateState = computeRaisedPlayerGateSet(state);
        const orangeButtonsPressed = areOrangeButtonsPressed(state);
        const candidates = moves
          .filter((move) => !move.visualOnly && !move.toRemoved)
          .map((move) => move.actorIndex)
          .filter(
            (actorIndex, index, actorIndexes) =>
              actorIndexes.indexOf(actorIndex) === index &&
              !state.actorRemoved[actorIndex] &&
              (isPlayerActor(actorIndex) || isPushableActor(actorIndex))
          );

        for (const actorIndex of candidates) {
          const elevation = actorElevation(state, actorIndex);
          const puncher = puncherActorAt(
            state,
            state.actorX[actorIndex],
            state.actorY[actorIndex],
            elevation
          );

          if (puncher === -1) {
            continue;
          }

          if (
            puncherWasAttachedToActorAtMoveStart(
              puncher,
              actorIndex,
              originalActorX,
              originalActorY,
              originalActorElevation
            )
          ) {
            continue;
          }

          const triggerKey = `${pushEntityKey(actorIndex)}:${puncher}:${state.actorX[actorIndex]},${state.actorY[actorIndex]},${elevation}`;

          if (triggered.has(triggerKey)) {
            continue;
          }

          triggered.add(triggerKey);
          const { dx, dy } = puncherDirectionVector(actorDirections[puncher]);
          const punchStarts = punchStartSnapshotsForActor(state, actorIndex, moves);
          const didPunch =
            actorTypes[actorIndex] === "weightless_box"
              ? punchWeightlessGroup(
                  state,
                  actorIndex,
                  dx,
                  dy,
                  occupied,
                  moves,
                  gateState,
                  orangeButtonsPressed,
                  originalActorX,
                  originalActorY,
                  originalActorElevation,
                  searchMode
                )
              : punchSingleActor(
                  state,
                  actorIndex,
                  dx,
                  dy,
                  occupied,
                  moves,
                  gateState,
                  orangeButtonsPressed,
                  originalActorX,
                  originalActorY,
                  originalActorElevation,
                  searchMode
                );

          if (!didPunch) {
            continue;
          }

          markPunchStartOnMoves(moves, punchStarts);
          addPuncherVisualMove(
            state,
            puncher,
            state.actorX[actorIndex],
            state.actorY[actorIndex],
            moves,
            originalActorX,
            originalActorY,
            originalActorElevation,
            searchMode
          );
          triggeredThisPass = true;
        }
      }
    }

    function syncAttachedPunchersForMoves(
      state,
      moves,
      originalActorX,
      originalActorY,
      originalActorElevation,
      searchMode
    ) {
      if (!actorTypes.includes("puncher")) {
        return;
      }

      moves
        .filter(
          (move) =>
            !move.visualOnly &&
            canPunchActorCarryPuncher(move.actorType) &&
            (move.fromX !== move.toX ||
              move.fromY !== move.toY ||
              (move.fromElevation ?? 0) !== (move.toElevation ?? move.fromElevation ?? 0))
        )
        .forEach((move) => {
          for (let puncher = 0; puncher < actorCount; puncher += 1) {
            if (!isPuncherActor(puncher) || state.actorRemoved[puncher]) {
              continue;
            }

            const { dx, dy } = puncherDirectionVector(actorDirections[puncher]);

            if (
              state.actorX[puncher] !== move.fromX + dx ||
              state.actorY[puncher] !== move.fromY + dy ||
              actorElevation(state, puncher) !== (move.fromElevation ?? 0)
            ) {
              continue;
            }

            state.actorX[puncher] = move.toX + dx;
            state.actorY[puncher] = move.toY + dy;
            state.actorElevation[puncher] = move.toElevation ?? move.fromElevation ?? 0;
            const visualMoveIndex = moves.findIndex(
              (candidate) => candidate.actorIndex === puncher && candidate.visualOnly
            );

            if (visualMoveIndex !== -1) {
              moves.splice(visualMoveIndex, 1);
            }

            mergeMoveRecord(
              state,
              moves,
              puncher,
              originalActorX,
              originalActorY,
              originalActorElevation,
              {
                iceSlide: !searchMode && move.iceSlide === true
              }
            );
          }
        });
    }

    function actorIgnoredSupportSet(state, actorIndex) {
      if (actorTypes[actorIndex] !== "weightless_box") {
        return new Set([actorIndex]);
      }

      return new Set(weightlessGroupMembers(state, actorGroupIds[actorIndex]));
    }

    function lacksLandingSupportAtOrBelow(
      state,
      actorIndex,
      elevation,
      gateState,
      orangeButtonsPressed,
      ignoredActors = actorIgnoredSupportSet(state, actorIndex)
    ) {
      const x = state.actorX[actorIndex];
      const y = state.actorY[actorIndex];
      return lacksLandingSupportAtOrBelowLocation(
        state,
        x,
        y,
        elevation,
        gateState,
        orangeButtonsPressed,
        ignoredActors
      );
    }

    function applyHoleFalls(state, moves) {
      const gateState = computeRaisedPlayerGateSet(state);
      const orangeButtonsPressed = areOrangeButtonsPressed(state);

      moves.forEach((move) => {
        if (move.visualOnly) {
          return;
        }

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

        const toElevation = move.toElevation ?? actorElevation(state, move.actorIndex);
        const actorIsOnHole = isHole(
          state,
          state.actorX[move.actorIndex],
          state.actorY[move.actorIndex],
          toElevation
        );
        const actorIsOverOpenPit =
          (move.punchSlide === true || move.iceSlipOff === true) &&
          !actorIsOnHole &&
          lacksLandingSupportAtOrBelow(
            state,
            move.actorIndex,
            toElevation,
            gateState,
            orangeButtonsPressed
          );

        if (
          (actorIsOnHole || actorIsOverOpenPit) &&
          (!isPlayerType(move.actorType) || actorIsOverOpenPit || toElevation === 0)
        ) {
          move.toRemoved = true;
        }
      });
    }

    function applyMoveFinalState(state, moves) {
      moves.forEach((move) => {
        if (move.visualOnly) {
          return;
        }

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
        const memberSet = new Set(members);
        const shouldFallIntoHole =
          groupMovedOrChangedElevation &&
          members.length > 0 &&
          members.every((member) => {
            const toElevation = baseElevation + (weightlessRelativeElevations[member] || 0);

            return (
              isHole(state, state.actorX[member], state.actorY[member], toElevation) ||
              lacksLandingSupportAtOrBelow(
                state,
                member,
                toElevation,
                gateState,
                orangeButtonsPressed,
                memberSet
              )
            );
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
      const originalActorX = new Int16Array(state.actorX);
      const originalActorY = new Int16Array(state.actorY);
      const originalActorElevation = new Int16Array(state.actorElevation);

      orderedPlayers.forEach((player) => {
        const fromX = state.actorX[player];
        const fromY = state.actorY[player];
        const fromElevation = actorElevation(state, player);
        removeOccupiedAtElevation(occupied, fromX, fromY, fromElevation);

        let nextX = fromX;
        let nextY = fromY;
        let travelElevation = fromElevation;
        const travelPath = [{ x: fromX, y: fromY, elevation: fromElevation }];
        let iceSlipLanding = null;
        const ignoredPlayerSet = new Set([player]);

        while (true) {
          const targetX = nextX + dx;
          const targetY = nextY + dy;
          const isInitialStep = nextX === fromX && nextY === fromY;
          const pushSlopeBlocker = (blocker, pushDx = dx, pushDy = dy) => {
            const attemptSnapshot = attemptSnapshotBuffer || cloneState(state);
            const occupiedSnapshot = occupiedSnapshotBuffer || new Set(occupied);
            const moveCount = moves.length;
            const pushBudget = countSupportingPlayers(state, player, pushDx, pushDy);

            if (attemptSnapshotBuffer) {
              copyStateInto(attemptSnapshotBuffer, state);
            }

            if (occupiedSnapshotBuffer) {
              occupiedSnapshotBuffer.clear();
              occupied.forEach((key) => occupiedSnapshotBuffer.add(key));
            }

            const result = attemptPushActor(
              state,
              blocker,
              pushDx,
              pushDy,
              occupied,
              moves,
              pushBudget,
              new Set(),
              raisedPlayerGates,
              orangeButtonsPressed,
              ignoredPlayerSet,
              searchMode
            );

            if (result !== null) {
              return true;
            }

            copyStateInto(state, attemptSnapshot);
            occupied.clear();
            occupiedSnapshot.forEach((key) => occupied.add(key));
            moves.length = moveCount;
            return false;
          };
          let slopeTraversal = resolveIceSlopeTraversal(
            state,
            targetX,
            targetY,
            dx,
            dy,
            travelElevation,
            occupied,
            raisedPlayerGates,
            orangeButtonsPressed,
            {
              ignoredActors: ignoredPlayerSet,
              pushSlopeBlocker
            }
          );

          if (!slopeTraversal) {
            const blockedSlope = blockedIceSlopePushForEntry(
              state,
              targetX,
              targetY,
              dx,
              dy,
              travelElevation,
              occupied,
              raisedPlayerGates,
              orangeButtonsPressed,
              new Set([player])
            );

            if (blockedSlope) {
              if (pushSlopeBlocker(blockedSlope.blocker)) {
                slopeTraversal = resolveIceSlopeTraversal(
                  state,
                  targetX,
                  targetY,
                  dx,
                  dy,
                  travelElevation,
                  occupied,
                  raisedPlayerGates,
                  orangeButtonsPressed,
                  {
                    ignoredActors: ignoredPlayerSet,
                    pushSlopeBlocker
                  }
                );
              }
            }
          }

          const canTraverseSlope =
            slopeTraversal !== null;
          const moveTargetX = canTraverseSlope ? slopeTraversal.exitX : targetX;
          const moveTargetY = canTraverseSlope ? slopeTraversal.exitY : targetY;
          const moveTargetElevation = canTraverseSlope ? slopeTraversal.exitElevation : travelElevation;
          const canEnterHole = moveTargetElevation === 0 && isHole(state, moveTargetX, moveTargetY, 0);
          const canStandAtTarget = canPlayerStandAtElevation(
            state,
            moveTargetX,
            moveTargetY,
            moveTargetElevation,
            raisedPlayerGates,
            orangeButtonsPressed,
            new Set([player])
          );
          const slipLanding =
            !canEnterHole && !canStandAtTarget
              ? playerIceSlipLanding(
                  state,
                  player,
                  nextX,
                  nextY,
                  moveTargetX,
                  moveTargetY,
                  moveTargetElevation,
                  occupied,
                  raisedPlayerGates,
                  orangeButtonsPressed
                )
              : null;
          const canSlipOffIce = slipLanding !== null;

          if (
            !isInsideBoard(targetX, targetY) ||
            (!canTraverseSlope && !canEnterHole && !canStandAtTarget && !canSlipOffIce)
          ) {
            if (!searchMode && isInsideBoard(targetX, targetY)) {
              const bouncePath = blockedIceSlopeBouncePathForEntry(
                state,
                targetX,
                targetY,
                dx,
                dy,
                travelElevation,
                occupied,
                raisedPlayerGates,
                orangeButtonsPressed
              );

              if (bouncePath && bouncePath.length > 0) {
                const path = [
                  { x: nextX, y: nextY, elevation: travelElevation },
                  ...bouncePath,
                  ...bouncePath
                    .slice(0, -1)
                    .reverse()
                    .map((point) => ({ ...point })),
                  { x: nextX, y: nextY, elevation: travelElevation }
                ];

                moves.push({
                  actorIndex: player,
                  actorType: actorTypes[player],
                  fromX: nextX,
                  fromY: nextY,
                  toX: nextX,
                  toY: nextY,
                  finalX: nextX,
                  finalY: nextY,
                  fromElevation: travelElevation,
                  toElevation: travelElevation,
                  finalElevation: travelElevation,
                  path,
                  pathControlsElevation: true,
                  pathEndElevation: travelElevation,
                  iceSlide: true,
                  visualOnly: true
                });
              }
            }

            break;
          }

          const blockingActor = canSlipOffIce || canTraverseSlope
            ? -1
            : blockingActorAtElevation(
                state,
                moveTargetX,
                moveTargetY,
                moveTargetElevation,
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

          nextX = moveTargetX;
          nextY = moveTargetY;
          travelElevation = moveTargetElevation;

          if (canTraverseSlope) {
            travelPath.push(...slopeTraversal.path);
          } else {
            travelPath.push({
              x: nextX,
              y: nextY,
              elevation: travelElevation
            });
          }

          if (canSlipOffIce) {
            iceSlipLanding = slipLanding;
            if (Array.isArray(slipLanding.path)) {
              travelPath.push(...slipLanding.path);
            }
            if (Number.isInteger(slipLanding.toX) && Number.isInteger(slipLanding.toY)) {
              nextX = slipLanding.toX;
              nextY = slipLanding.toY;
            }
            travelElevation = slipLanding.toElevation;
            break;
          }

          if (!isIce(state, nextX, nextY, travelElevation, raisedPlayerGates, orangeButtonsPressed)) {
            break;
          }
        }

        let occupiedElevation = fromElevation;

        if (nextX !== fromX || nextY !== fromY || travelElevation !== fromElevation) {
          state.actorX[player] = nextX;
          state.actorY[player] = nextY;
          let toElevation = fromElevation;

          const playerLiftLayer = playerLiftLayerAtElevation(
            state,
            nextX,
            nextY,
            travelElevation,
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
          } else if (iceSlipLanding) {
            toElevation = iceSlipLanding.toElevation;
          } else {
            toElevation =
              playerSurfaceHeightAt(
                state,
                nextX,
                nextY,
                raisedPlayerGates,
                orangeButtonsPressed,
                travelElevation
              ) ?? travelElevation;
          }

          const pathEndElevation = travelPath[travelPath.length - 1]?.elevation ?? travelElevation;

          if (!playerLiftLayer && toElevation !== pathEndElevation) {
            travelPath.push({
              x: nextX,
              y: nextY,
              elevation: toElevation
            });
          }

          state.actorElevation[player] = toElevation;
          occupiedElevation = toElevation;

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
          const pathControlsElevation = travelPath.some((point) => point.elevation !== fromElevation);

          if (travelPath.length > 2 || pathControlsElevation) {
            moveRecord.path = travelPath;
            moveRecord.pathControlsElevation = pathControlsElevation;
            moveRecord.pathEndElevation = pathEndElevation;
          }

          if (!searchMode) {
            moveRecord.iceSlide = travelDistance > 1 || iceSlipLanding !== null;

            if (
              iceSlipLanding ||
              (!playerLiftLayer &&
                (toElevation !== (moveRecord.pathEndElevation ?? toElevation) ||
                  !canPlayerStandAtElevation(
                    state,
                    nextX,
                    nextY,
                    toElevation,
                    raisedPlayerGates,
                    orangeButtonsPressed
                  )))
            ) {
              moveRecord.iceSlipOff = true;
            }
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
          occupiedElevation
        );
      });

      if (moves.length > 0) {
        applyPunchers(
          state,
          moves,
          originalActorX,
          originalActorY,
          originalActorElevation,
          searchMode
        );
        syncAttachedPunchersForMoves(
          state,
          moves,
          originalActorX,
          originalActorY,
          originalActorElevation,
          searchMode
        );
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
          moveRecord.visualOnly ||
          moveRecord.actorType === "puncher" ||
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

        if (moveRecord.visualOnly) {
          continue;
        }

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
