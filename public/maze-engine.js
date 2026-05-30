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
  const ICE_SLOPE_VISUAL_CLEARANCE = 0.08;
  const STATE_ELEVATION_KEY_OFFSET = 1024;
  const terrainSideBlockingSupportTypes = new Set([
    terrainTypes.floor,
    terrainTypes.ice
  ]);

  function actorType(actor) {
    return typeof actor?.type === "string" ? actor.type : "";
  }

  function isMainPlayerType(type) {
    return type === "player" || type === "circle_player";
  }

  function isPlayerType(type) {
    return isMainPlayerType(type) || type === "clone";
  }

  function isCloneType(type) {
    return type === "clone";
  }

  function isCollectibleType(type) {
    return type === "gem";
  }

  function isNonBlockingType(type) {
    return isCollectibleType(type) || type === "orange_button" || type === "puncher";
  }

  function isPushableType(type) {
    return type === "box" || type === "floating_floor" || type === "weightless_box";
  }

  function isSupportActorType(type) {
    return (
      type === "player" ||
      type === "circle_player" ||
      type === "clone" ||
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
    const orangeButtonActors = [];
    const actorInitialElevations = [];
    const weightlessRelativeElevations = [];
    const searchSeenActors = new Uint32Array(actorCount);
    let searchSeenStamp = 0;

    for (let index = 0; index < actorCount; index += 1) {
      actorInitialElevations[index] = initialActorElevation(actorSource[index], index);
      weightlessRelativeElevations[index] = 0;

      if (actorTypes[index] === "orange_button") {
        orangeButtonActors.push(index);
      }
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
              orangeButtonsPressed,
              null,
              new Set([index])
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
          encodeKeyValue(state.actorElevation[index] + STATE_ELEVATION_KEY_OFFSET) +
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

    function isCloneActor(actorIndex) {
      return isCloneType(actorTypes[actorIndex]);
    }

    function isMainPlayerActor(actorIndex) {
      return isMainPlayerType(actorTypes[actorIndex]);
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

    function isOrangeButtonActor(actorIndex) {
      return actorTypes[actorIndex] === "orange_button";
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

    function hasOrangeWallLayerAtElevation(state, cell, elevation) {
      return terrainLayersForCell(state, cell).some(
        (candidate) =>
          candidate.type === terrainTypes.orange_wall &&
          (candidate.elevation ?? 0) === elevation
      );
    }

    function hasOrangeWallLayerBelow(state, cell, layer) {
      const elevation = layer.elevation ?? 0;

      return elevation > 0 && hasOrangeWallLayerAtElevation(state, cell, elevation - 1);
    }

    function hasNonOrangeTerrainSupportAtElevation(
      state,
      cell,
      elevation,
      gateState,
      orangeButtonsPressed,
      ignoredLayer = null
    ) {
      return terrainLayersForCell(state, cell).some((candidate) => {
        if (candidate === ignoredLayer || candidate.type === terrainTypes.orange_wall) {
          return false;
        }

        return (
          terrainLayerSurfaceHeight(
            state,
            cell,
            candidate,
            gateState,
            orangeButtonsPressed
          ) === elevation
        );
      });
    }

    function shouldLowerPressedOrangeWallAsBlock(
      state,
      cell,
      layer,
      gateState,
      orangeButtonsPressed
    ) {
      const elevation = layer.elevation ?? 0;

      return (
        elevation > 0 &&
        (hasOrangeWallLayerBelow(state, cell, layer) ||
          !hasNonOrangeTerrainSupportAtElevation(
            state,
            cell,
            elevation,
            gateState,
            orangeButtonsPressed,
            layer
          ))
      );
    }

    function terrainLayerSurfaceHeight(state, cell, layer, gateState, orangeButtonsPressed) {
      if (
        layer.type === terrainTypes.empty ||
        layer.type === terrainTypes.hole ||
        layer.type === terrainTypes.orange_button
      ) {
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

    function terrainSupportSideBlocksWeightlessEntry(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed
    ) {
      if (!isInsideBoard(x, y)) {
        return false;
      }

      const cell = cellIndex(x, y);

      return terrainLayersForCell(state, cell).some((layer) => {
        if (!terrainSideBlockingSupportTypes.has(layer.type)) {
          return false;
        }

        const surfaceHeight = terrainLayerSurfaceHeight(
          state,
          cell,
          layer,
          gateState,
          orangeButtonsPressed
        );

        return surfaceHeight !== null && elevation < surfaceHeight;
      });
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

    function isEmptyVoidAtElevation(state, x, y, elevation = 0) {
      if (!isInsideBoard(x, y) || elevation !== 0) {
        return false;
      }

      const cell = cellIndex(x, y);
      const layers = terrainLayersForCell(state, cell);

      return !layers.some((layer) => {
        if (layer.type === terrainTypes.hole || layer.type === terrainTypes.orange_button) {
          return false;
        }

        return (
          terrainLayerSurfaceHeight(state, cell, layer, new Set(), false) === elevation ||
          terrainLayerBlocksElevation(state, cell, layer, new Set(), false, elevation)
        );
      });
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

    function iceSlopeSharedEdgePoint(traversal, dx, dy) {
      return {
        x: traversal.exitX - dx * 0.5,
        y: traversal.exitY - dy * 0.5,
        elevation: traversal.exitElevation + ICE_SLOPE_VISUAL_CLEARANCE
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

    function moveRecordPathPoints(move) {
      if (Array.isArray(move.path) && move.path.length > 0) {
        return move.path
          .map((point) => ({
            x: Number(point.x),
            y: Number(point.y),
            elevation: Number(point.elevation)
          }))
          .filter(
            (point) =>
              Number.isFinite(point.x) &&
              Number.isFinite(point.y) &&
              Number.isFinite(point.elevation)
          );
      }

      return [
        {
          x: move.fromX,
          y: move.fromY,
          elevation: move.fromElevation ?? 0
        },
        {
          x: move.toX,
          y: move.toY,
          elevation: move.toElevation ?? move.fromElevation ?? 0
        }
      ];
    }

    function playerFollowPathForPushedMove(moves, startIndex, actorIndex, dx, dy) {
      const pushedMove = moves
        .slice(startIndex)
        .find((move) => move.actorIndex === actorIndex && !move.visualOnly);

      if (!pushedMove) {
        return null;
      }

      const path = moveRecordPathPoints(pushedMove);

      if (path.length < 2) {
        return null;
      }

      const startElevation = path[0].elevation;
      const movesFlatlyForward = path.every((point, index) => {
        if (point.elevation !== startElevation) {
          return false;
        }

        if (index === 0) {
          return true;
        }

        const previous = path[index - 1];
        return point.x - previous.x === dx && point.y - previous.y === dy;
      });

      if (!movesFlatlyForward) {
        return null;
      }

      return path.map((point) => ({
        x: point.x - dx,
        y: point.y - dy,
        elevation: point.elevation
      }));
    }

    function pushedSupportMembersUnderPlayer(beforeState, player, members) {
      const playerX = beforeState.actorX[player];
      const playerY = beforeState.actorY[player];
      const playerElevation = actorElevation(beforeState, player);

      return new Set(
        members.filter(
          (member) =>
            beforeState.actorX[member] === playerX &&
            beforeState.actorY[member] === playerY &&
            actorElevation(beforeState, member) + 1 === playerElevation
        )
      );
    }

    function playerRidePathForPushedSupport(moves, startIndex, supportMembers) {
      for (const member of supportMembers) {
        const supportMove = moves
          .slice(startIndex)
          .find((move) => move.actorIndex === member && !move.visualOnly);

        if (!supportMove) {
          continue;
        }

        const path = moveRecordPathPoints(supportMove);

        if (path.length < 2) {
          continue;
        }

        return path.map((point) => ({
          x: point.x,
          y: point.y,
          elevation: point.elevation + 1
        }));
      }

      return null;
    }

    function cloneRidersForMove(state, members, dx, dy, gateState, orangeButtonsPressed) {
      const riders = [];
      const memberSet = new Set(members);
      const riderIndexes = new Set();

      for (const member of members) {
        const supportX = state.actorX[member];
        const supportY = state.actorY[member];
        const supportElevation = actorElevation(state, member);

        for (let actor = 0; actor < actorCount; actor += 1) {
          if (
            riderIndexes.has(actor) ||
            state.actorRemoved[actor] ||
            !isMainPlayerActor(actor) ||
            state.actorX[actor] !== supportX ||
            state.actorY[actor] !== supportY ||
            actorElevation(state, actor) !== supportElevation + 1
          ) {
            continue;
          }

          const targetX = state.actorX[actor] + dx;
          const targetY = state.actorY[actor] + dy;
          const targetElevation = actorElevation(state, actor);
          const ignoredActors = new Set(memberSet);
          ignoredActors.add(actor);

          if (
            !isInsideBoard(targetX, targetY) ||
            terrainBlocksElevation(
              state,
              targetX,
              targetY,
              targetElevation,
              gateState,
              orangeButtonsPressed
            )
          ) {
            continue;
          }

          const blocker = actorAt(
            state,
            targetX,
            targetY,
            (candidate) =>
              !ignoredActors.has(candidate) &&
              !isNonBlockingActor(candidate) &&
              actorElevation(state, candidate) === targetElevation
          );

          if (blocker !== -1) {
            continue;
          }

          riders.push({
            actorIndex: actor,
            fromElevation: targetElevation,
            fromX: state.actorX[actor],
            fromY: state.actorY[actor],
            supportMember: member
          });
          riderIndexes.add(actor);
        }
      }

      return riders;
    }

    function pathOffsetsForTraversal(traversal, fromX, fromY, fromElevation) {
      return traversal.path.map((point) => ({
        dx: point.x - fromX,
        dy: point.y - fromY,
        elevation: point.elevation - fromElevation
      }));
    }

    function pathOffsetsForPoints(points, fromX, fromY, fromElevation) {
      return points.map((point) => ({
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
      return (
        isEmptyVoidAtElevation(state, x, y, elevation) ||
        Boolean(
          terrainLayerOfTypeAtElevation(
            state,
            x,
            y,
            terrainTypes.hole,
            elevation,
            new Set(),
            false
          )
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

    function isOrangeButtonActorPressed(state, buttonIndex) {
      const x = state.actorX[buttonIndex];
      const y = state.actorY[buttonIndex];
      const elevation = actorElevation(state, buttonIndex);

      for (let index = 0; index < actorCount; index += 1) {
        if (
          index === buttonIndex ||
          state.actorRemoved[index] ||
          isNonBlockingActor(index)
        ) {
          continue;
        }

        if (
          state.actorX[index] === x &&
          state.actorY[index] === y &&
          actorElevation(state, index) === elevation
        ) {
          return true;
        }
      }

      return false;
    }

    function areOrangeButtonsPressed(state) {
      if (orangeButtonCells.length === 0 && orangeButtonActors.length === 0) {
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

      for (let index = 0; index < orangeButtonActors.length; index += 1) {
        const button = orangeButtonActors[index];

        if (state.actorRemoved[button] || !isOrangeButtonActorPressed(state, button)) {
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
        if (!orangeButtonsPressed) {
          return layerElevation === elevation;
        }

        return shouldLowerPressedOrangeWallAsBlock(
          state,
          cell,
          layer,
          gateState,
          orangeButtonsPressed
        ) && layerElevation - 1 === elevation;
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

    function terrainBlockingLayersAtElevation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed = areOrangeButtonsPressed(state)
    ) {
      if (!isInsideBoard(x, y)) {
        return [];
      }

      const cell = cellIndex(x, y);

      return terrainLayersForCell(state, cell).filter((layer) =>
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

    function terrainBlocksOnlyByIceSlope(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed = areOrangeButtonsPressed(state)
    ) {
      const blockers = terrainBlockingLayersAtElevation(
        state,
        x,
        y,
        elevation,
        gateState,
        orangeButtonsPressed
      );

      return blockers.length > 0 && blockers.every((layer) => layer.type === terrainTypes.ice_slope);
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

        if (!includePlayers && isMainPlayerActor(index)) {
          continue;
        }

        heights.push(actorElevation(state, index) + 1);
      }

      return heights;
    }

    function actorSupportsElevation(state, x, y, elevation, ignoredActors = null, includePlayers = false) {
      return actorSupportSurfaceHeightsAt(state, x, y, ignoredActors, includePlayers).includes(elevation);
    }

    function surfaceSupportsElevation(
      state,
      x,
      y,
      elevation,
      gateState,
      orangeButtonsPressed,
      ignoredActors = null,
      includePlayers = false
    ) {
      return (
        terrainSupportsElevation(state, x, y, elevation, gateState, orangeButtonsPressed) ||
        actorSupportsElevation(state, x, y, elevation, ignoredActors, includePlayers)
      );
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
        surfaceSupportsElevation(
          state,
          x,
          y,
          elevation,
          gateState,
          orangeButtonsPressed,
          ignoredActors,
          false
        )
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

    function weightlessGroupCurrentBaseElevation(state, groupId) {
      const members = weightlessGroupMembers(state, groupId);
      let baseElevation = Infinity;

      members.forEach((member) => {
        baseElevation = Math.min(
          baseElevation,
          actorElevation(state, member) - (weightlessRelativeElevations[member] || 0)
        );
      });

      return Number.isFinite(baseElevation) ? baseElevation : 0;
    }

    function weightlessComponentSupportedElevation(state, groupIds, gateState, orangeButtonsPressed) {
      const members = weightlessClusterMembers(state, groupIds);
      const memberSet = new Set(members);
      const groupBaseElevations = new Map();
      let componentCurrentBase = Infinity;

      groupIds.forEach((groupId) => {
        const groupBase = weightlessGroupCurrentBaseElevation(state, groupId);
        groupBaseElevations.set(groupId, groupBase);
        componentCurrentBase = Math.min(componentCurrentBase, groupBase);
      });

      if (!Number.isFinite(componentCurrentBase)) {
        componentCurrentBase = 0;
      }

      const groupBaseOffsets = new Map();
      groupIds.forEach((groupId) => {
        groupBaseOffsets.set(groupId, groupBaseElevations.get(groupId) - componentCurrentBase);
      });

      let baseElevation = -Infinity;

      members.forEach((member) => {
        const x = state.actorX[member];
        const y = state.actorY[member];
        const currentElevation = actorElevation(state, member);
        const relativeElevation =
          (groupBaseOffsets.get(actorGroupIds[member]) ?? 0) +
          (weightlessRelativeElevations[member] || 0);
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

      return {
        baseElevation: Number.isFinite(baseElevation) ? baseElevation : componentCurrentBase,
        groupBaseOffsets,
        memberSet,
        members
      };
    }

    function playerSurfaceHeightAt(
      state,
      x,
      y,
      gateState,
      orangeButtonsPressed = areOrangeButtonsPressed(state),
      currentElevation = null,
      ignoredActors = null
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
        actorSupportSurfaceHeightsAt(state, x, y, ignoredActors, false)
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
          const gateElevation = gateLayer.elevation ?? 0;
          const sameLevelBlockOnGate =
            actorAt(
              state,
              x,
              y,
              (actor) =>
                !isPlayerActor(actor) &&
                !isNonBlockingActor(actor) &&
                actorElevation(state, actor) === gateElevation
            ) !== -1;

          if (
            players.some(
              (player) => {
                const playerElevation = actorElevation(state, player);
                const xyDistance = Math.abs(state.actorX[player] - x) + Math.abs(state.actorY[player] - y);
                const standingOnGate = xyDistance === 0 && playerElevation === gateElevation;

                return (
                  xyDistance <= 1 &&
                  !standingOnGate &&
                  (playerElevation !== gateElevation || !sameLevelBlockOnGate)
                );
              }
            )
          ) {
            raised.add(gateCell);
            return;
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
      if (actorTypes[actorIndex] === "weightless_box") {
        return `weightless:${actorGroupIds[actorIndex]}`;
      }

      if (isCloneActor(actorIndex)) {
        return `clone:${actorGroupIds[actorIndex] || ""}`;
      }

      return `actor:${actorIndex}`;
    }

    function pushActorMembers(state, actorIndex) {
      if (actorTypes[actorIndex] === "weightless_box") {
        return weightlessGroupMembers(state, actorGroupIds[actorIndex]);
      }

      if (isCloneActor(actorIndex)) {
        return cloneGroupMembers(state, actorGroupIds[actorIndex]);
      }

      return [actorIndex];
    }

    function cloneGroupMembers(state, groupId) {
      const members = [];
      const normalizedGroupId = groupId || "";

      for (let index = 0; index < actorCount; index += 1) {
        if (
          !state.actorRemoved[index] &&
          isCloneActor(index) &&
          (actorGroupIds[index] || "") === normalizedGroupId
        ) {
          members.push(index);
        }
      }

      return members;
    }

    function weightlessGroupMembers(state, groupId, actorType = "weightless_box") {
      const members = [];

      for (let index = 0; index < actorCount; index += 1) {
        if (
          !state.actorRemoved[index] &&
          actorTypes[index] === actorType &&
          actorGroupIds[index] === groupId
        ) {
          members.push(index);
        }
      }

      return members;
    }

    function weightlessClusterMembers(state, groupIds, actorType = "weightless_box") {
      const groupIdSet = new Set(groupIds);
      const members = [];

      for (let index = 0; index < actorCount; index += 1) {
        if (
          !state.actorRemoved[index] &&
          actorTypes[index] === actorType &&
          groupIdSet.has(actorGroupIds[index])
        ) {
          members.push(index);
        }
      }

      return members;
    }

    function weightlessActorsVerticallyTouch(state, left, right) {
      return (
        state.actorX[left] === state.actorX[right] &&
        state.actorY[left] === state.actorY[right] &&
        Math.abs(actorElevation(state, left) - actorElevation(state, right)) === 1
      );
    }

    function weightlessVerticalSupportComponentGroupIds(state, startGroupId) {
      const componentGroupIds = new Set([startGroupId]);
      let changed = true;

      while (changed) {
        changed = false;
        const componentMembers = weightlessClusterMembers(state, componentGroupIds);

        for (let index = 0; index < actorCount; index += 1) {
          if (state.actorRemoved[index] || actorTypes[index] !== "weightless_box") {
            continue;
          }

          const groupId = actorGroupIds[index];

          if (componentGroupIds.has(groupId)) {
            continue;
          }

          if (componentMembers.some((member) => weightlessActorsVerticallyTouch(state, member, index))) {
            componentGroupIds.add(groupId);
            changed = true;
          }
        }
      }

      return componentGroupIds;
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

        if (!isInsideBoard(traversal.exitX, traversal.exitY)) {
          if (options.allowLevelExit !== true) {
            return null;
          }

          const resultPath = path.map((point) => ({ ...point }));
          const pathEnd = resultPath[resultPath.length - 1] || {
            x: traversal.slopeX,
            y: traversal.slopeY,
            elevation: traversal.entryElevation
          };

          return {
            ...traversal,
            exitX: traversal.slopeX,
            exitY: traversal.slopeY,
            exitElevation: pathEnd.elevation,
            levelExit: true,
            levelExitDx: dx,
            levelExitDy: dy,
            levelExitElevation: traversal.exitElevation,
            levelExitSourceType: "ice_slope",
            path: resultPath
          };
        }

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

        if (
          traversal.exitElevation < traversal.entryElevation &&
          nextTraversal.exitElevation > nextTraversal.entryElevation
        ) {
          appendPathPoints(path, [iceSlopeSharedEdgePoint(traversal, dx, dy)]);
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
      let stepDx = dx;
      let stepDy = dy;
      let reversedAfterSlopeBounce = false;
      const path = [{ x: startX, y: startY, elevation }];

      while (true) {
        let slopeTraversal = resolveIceSlopeTraversal(
          state,
          nextX + stepDx,
          nextY + stepDy,
          stepDx,
          stepDy,
          nextElevation,
          occupied,
          gateState,
          orangeButtonsPressed,
          options
        );

        if (!slopeTraversal && typeof options.pushSlopeBlocker === "function") {
          const blockedSlope = blockedIceSlopePushForEntry(
            state,
            nextX + stepDx,
            nextY + stepDy,
            stepDx,
            stepDy,
            nextElevation,
            occupied,
            gateState,
            orangeButtonsPressed,
            options.ignoredActors || new Set()
          );

          if (blockedSlope && options.pushSlopeBlocker(blockedSlope.blocker, stepDx, stepDy)) {
            slopeTraversal = resolveIceSlopeTraversal(
              state,
              nextX + stepDx,
              nextY + stepDy,
              stepDx,
              stepDy,
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
            nextX + stepDx,
            nextY + stepDy,
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
            nextX + stepDx,
            nextY + stepDy,
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

        if (
          options.reverseOnBlockedSlopeBounceFromIce === true &&
          !reversedAfterSlopeBounce
        ) {
          const bouncePath = blockedIceSlopeBouncePathForEntry(
            state,
            nextX + stepDx,
            nextY + stepDy,
            stepDx,
            stepDy,
            nextElevation,
            occupied,
            gateState,
            orangeButtonsPressed
          );

          if (
            bouncePath &&
            bouncePath.length > 0 &&
            isIce(state, nextX, nextY, nextElevation, gateState, orangeButtonsPressed)
          ) {
            appendPathPoints(path, bouncePath.map((point) => ({ ...point })));
            appendPathPoints(
              path,
              bouncePath
                .slice(0, -1)
                .reverse()
                .map((point) => ({ ...point }))
            );
            appendPathPoints(path, [{ x: nextX, y: nextY, elevation: nextElevation }]);
            stepDx = -stepDx;
            stepDy = -stepDy;
            reversedAfterSlopeBounce = true;
            continue;
          }
        }

        if (!canMoveInto(state, nextX + stepDx, nextY + stepDy, occupied, gateState, orangeButtonsPressed, nextElevation)) {
          break;
        }

        nextX += stepDx;
        nextY += stepDy;
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
              reverseOnBlockedSlopeBounceFromIce: true,
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

    function pushableSupportActorUnderPlayer(state, player) {
      const playerElevation = actorElevation(state, player);

      if (playerElevation <= 0) {
        return -1;
      }

      return actorAt(
        state,
        state.actorX[player],
        state.actorY[player],
        (actor) =>
          isPushableActor(actor) &&
          actorElevation(state, actor) + 1 === playerElevation
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
      orangeButtonsPressed,
      options = {}
    ) {
      if (!isInsideBoard(targetX, targetY)) {
        return false;
      }

      const canEnter = !terrainBlocksElevation(
        state,
        targetX,
        targetY,
        targetElevation,
        gateState,
        orangeButtonsPressed
      );

      if (
        canEnter &&
        options.blockSupportSide === true &&
        (state.actorX[member] !== targetX || state.actorY[member] !== targetY) &&
        terrainSupportSideBlocksWeightlessEntry(
          state,
          targetX,
          targetY,
          targetElevation,
          gateState,
          orangeButtonsPressed
        )
      ) {
        return false;
      }

      return canEnter;
    }

    function weightlessMemberCanOccupy(
      state,
      member,
      targetX,
      targetY,
      targetElevation,
      occupied,
      gateState,
      orangeButtonsPressed,
      options = {}
    ) {
      if (
        !canWeightlessMemberEnter(
          state,
          member,
          targetX,
          targetY,
          targetElevation,
          gateState,
          orangeButtonsPressed,
          options
        )
      ) {
        if (
          !options.allowIceSlopeTransit ||
          !terrainBlocksOnlyByIceSlope(
            state,
            targetX,
            targetY,
            targetElevation,
            gateState,
            orangeButtonsPressed
          )
        ) {
          return false;
        }
      }

      return !isOccupiedAtElevation(occupied, targetX, targetY, targetElevation);
    }

    function weightlessClusterHasIceSlopeTransit(
      state,
      members,
      gateState,
      orangeButtonsPressed
    ) {
      return members.some((member) =>
        terrainBlocksOnlyByIceSlope(
          state,
          state.actorX[member],
          state.actorY[member],
          actorElevation(state, member),
          gateState,
          orangeButtonsPressed
        )
      );
    }

    function weightlessClusterHasTrailingMember(state, members, dx, dy) {
      const memberPositions = new Set(
        members.map(
          (member) =>
            `${state.actorX[member]},${state.actorY[member]},${actorElevation(state, member)}`
        )
      );

      return members.some((member) =>
        memberPositions.has(
          `${state.actorX[member] - dx},${state.actorY[member] - dy},${actorElevation(state, member)}`
        )
      );
    }

    function weightlessClusterCanStartIceSlopeTransit(
      state,
      members,
      dx,
      dy,
      occupied,
      gateState,
      orangeButtonsPressed
    ) {
      return members.some((member) =>
        Boolean(
          resolveIceSlopeTraversal(
            state,
            state.actorX[member] + dx,
            state.actorY[member] + dy,
            dx,
            dy,
            actorElevation(state, member),
            occupied,
            gateState,
            orangeButtonsPressed
          )
        )
      );
    }

    function weightlessClusterShouldContinueSliding(
      state,
      members,
      gateState,
      orangeButtonsPressed,
      predictedSupports = null
    ) {
      const memberSet = new Set(members);
      let hasIceSlideContact = false;

      for (const member of members) {
        const x = state.actorX[member];
        const y = state.actorY[member];
        const elevation = actorElevation(state, member);

        if (isIceOrHole(state, x, y, elevation, gateState, orangeButtonsPressed)) {
          hasIceSlideContact = true;
          continue;
        }

        if (terrainBlocksOnlyByIceSlope(state, x, y, elevation, gateState, orangeButtonsPressed)) {
          hasIceSlideContact = true;
          continue;
        }

        if (
          terrainSupportsElevation(state, x, y, elevation, gateState, orangeButtonsPressed) ||
          actorSupportSurfaceHeightsAt(state, x, y, memberSet, true).includes(elevation) ||
          predictedSupportsElevation(predictedSupports, x, y, elevation, memberSet)
        ) {
          return false;
        }
      }

      return (
        hasIceSlideContact ||
        weightlessClusterHasIceSlopeTransit(state, members, gateState, orangeButtonsPressed)
      );
    }

    function weightlessMemberHasCurrentSupport(
      state,
      member,
      gateState,
      orangeButtonsPressed,
      memberSet,
      predictedSupports = null
    ) {
      const x = state.actorX[member];
      const y = state.actorY[member];
      const elevation = actorElevation(state, member);

      return (
        terrainSupportsElevation(state, x, y, elevation, gateState, orangeButtonsPressed) ||
        actorSupportSurfaceHeightsAt(state, x, y, memberSet, true).includes(elevation) ||
        predictedSupportsElevation(predictedSupports, x, y, elevation, memberSet)
      );
    }

    function predictedSupportsElevation(
      predictedSupports,
      x,
      y,
      elevation,
      ignoredActors = null
    ) {
      if (!Array.isArray(predictedSupports) || predictedSupports.length === 0) {
        return false;
      }

      return predictedSupports.some((support) => {
        if (ignoredActors?.has(support.actorIndex)) {
          return false;
        }

        return support.x === x && support.y === y && support.elevation + 1 === elevation;
      });
    }

    function settleWeightlessClusterDownOneLayer(
      state,
      members,
      occupied,
      gateState,
      orangeButtonsPressed,
      predictedSupports = null
    ) {
      const memberSet = new Set(members);

      if (
        members.some((member) =>
          weightlessMemberHasCurrentSupport(
            state,
            member,
            gateState,
            orangeButtonsPressed,
            memberSet,
            predictedSupports
          )
        )
      ) {
        return false;
      }

      if (
        !members.every((member) =>
          weightlessMemberCanOccupy(
            state,
            member,
            state.actorX[member],
            state.actorY[member],
            actorElevation(state, member) - 1,
            occupied,
            gateState,
            orangeButtonsPressed
          )
        )
      ) {
        return false;
      }

      members.forEach((member) => {
        state.actorElevation[member] -= 1;
      });

      return true;
    }

    function clusterHasSupportedMemberAfterStep(
      state,
      members,
      step,
      gateState,
      orangeButtonsPressed,
      predictedSupports = null
    ) {
      const memberSet = new Set(members);

      return members.some((member) => {
        const targetX = state.actorX[member] + step.dx;
        const targetY = state.actorY[member] + step.dy;
        const targetElevation = actorElevation(state, member) + step.elevation;

        return (
          terrainSupportsElevation(
            state,
            targetX,
            targetY,
            targetElevation,
            gateState,
            orangeButtonsPressed
          ) ||
          actorSupportSurfaceHeightsAt(state, targetX, targetY, memberSet, true).includes(
            targetElevation
          ) ||
          predictedSupportsElevation(
            predictedSupports,
            targetX,
            targetY,
            targetElevation,
            memberSet
          )
        );
      });
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
      const traversingSlopeMembers = new Set();
      const allowClusterIceSlopeTransit =
        options.allowIceSlopeTransit === true ||
        weightlessClusterCanStartIceSlopeTransit(
          state,
          members,
          dx,
          dy,
          occupied,
          gateState,
          orangeButtonsPressed
        );

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

        if (!traversal && !allowClusterIceSlopeTransit) {
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

        if (!traversal && !allowClusterIceSlopeTransit) {
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

        traversingSlopeMembers.add(member);
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

      if (slopeDelta?.elevation < 0) {
        for (const member of members) {
          if (traversingSlopeMembers.has(member)) {
            continue;
          }

          if (
            terrainBlocksOnlyByIceSlope(
              state,
              state.actorX[member] + dx,
              state.actorY[member] + dy,
              actorElevation(state, member),
              gateState,
              orangeButtonsPressed
            )
          ) {
            return null;
          }
        }
      }

      const delaySlopeDescent =
        slopeDelta?.elevation < 0 && weightlessClusterHasTrailingMember(state, members, dx, dy);
      const step = slopeDelta
        ? {
            ...slopeDelta,
            elevation: delaySlopeDescent ? 0 : slopeDelta.elevation,
            pathOffsets: delaySlopeDescent
              ? (slopePathOffsets || []).map((point) => ({ ...point, elevation: 0 }))
              : slopePathOffsets || []
          }
        : { dx, dy, elevation: 0, pathOffsets: [] };
      const allowIceSlopeTransit =
        Boolean(slopeDelta) || allowClusterIceSlopeTransit;

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
            orangeButtonsPressed,
            {
              allowIceSlopeTransit,
              blockSupportSide: step.dx !== 0 || step.dy !== 0
            }
          );
        })
      ) {
        return step;
      }

      return null;
    }

    function weightlessClusterBlockedSlopeBounceOffsets(
      state,
      members,
      dx,
      dy,
      occupied,
      gateState,
      orangeButtonsPressed
    ) {
      let bounceOffsets = null;

      for (const member of members) {
        const elevation = actorElevation(state, member);
        const bouncePath = blockedIceSlopeBouncePathForEntry(
          state,
          state.actorX[member] + dx,
          state.actorY[member] + dy,
          dx,
          dy,
          elevation,
          occupied,
          gateState,
          orangeButtonsPressed
        );

        if (!bouncePath || bouncePath.length === 0) {
          continue;
        }

        if (
          !isIce(
            state,
            state.actorX[member],
            state.actorY[member],
            elevation,
            gateState,
            orangeButtonsPressed
          )
        ) {
          return null;
        }

        const memberBounceOffsets = pathOffsetsForPoints(
          bouncePath
            .concat(
              bouncePath
                .slice(0, -1)
                .reverse()
                .map((point) => ({ ...point })),
              { x: state.actorX[member], y: state.actorY[member], elevation }
            ),
          state.actorX[member],
          state.actorY[member],
          elevation
        );

        if (bounceOffsets && !samePathOffsets(bounceOffsets, memberBounceOffsets)) {
          return null;
        }

        bounceOffsets = memberBounceOffsets;
      }

      return bounceOffsets;
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
          const canStartIceSlopeTransit = weightlessClusterCanStartIceSlopeTransit(
            state,
            members,
            dx,
            dy,
            occupied,
            gateState,
            orangeButtonsPressed
          );

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
            const blockedSlopeBouncePath =
              slopeTraversal || blockedSlope || fallSlopeTraversal || topSlopeTraversal
                ? null
                : blockedIceSlopeBouncePathForEntry(
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
            const canBounceBackFromSlope =
              blockedSlopeBouncePath &&
              blockedSlopeBouncePath.length > 0 &&
              isIce(
                state,
                state.actorX[member],
                state.actorY[member],
                memberElevation,
                gateState,
                orangeButtonsPressed
              );

            if (
              !slopeTraversal &&
              !blockedSlope &&
              !fallSlopeTraversal &&
              !topSlopeTraversal &&
              !canBounceBackFromSlope &&
              !canWeightlessMemberEnter(
                state,
                member,
                targetX,
                targetY,
                memberElevation,
                gateState,
                orangeButtonsPressed,
                { blockSupportSide: true }
              ) &&
              !(
                canStartIceSlopeTransit &&
                terrainBlocksOnlyByIceSlope(
                  state,
                  targetX,
                  targetY,
                  memberElevation,
                  gateState,
                  orangeButtonsPressed
                )
              )
            ) {
              blockers.push(null);
              return;
            }

            if (
              slopeTraversal ||
              blockedSlope ||
              fallSlopeTraversal ||
              topSlopeTraversal ||
              canBounceBackFromSlope
            ) {
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
      pushContext = null,
      actorType = "weightless_box",
      options = {}
    ) {
      const members = weightlessClusterMembers(state, groupIds, actorType);

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
      const carriedRiders =
        Array.isArray(options.carriedRiders) && options.carriedRiders.length > 0
          ? options.carriedRiders
          : [];
      members.forEach((member) => {
        removeOccupiedAtElevation(
          occupied,
          state.actorX[member],
          state.actorY[member],
          actorElevation(state, member)
        );
      });
      carriedRiders.forEach((rider) => {
        removeOccupiedAtElevation(
          occupied,
          rider.fromX,
          rider.fromY,
          rider.fromElevation
        );
      });
      const ignoredActors = new Set(pushContext?.ignoredActors || []);
      members.forEach((member) => ignoredActors.add(member));
      carriedRiders.forEach((rider) => ignoredActors.add(rider.actorIndex));

      let moved = false;
      let stepDx = dx;
      let stepDy = dy;
      let reversedAfterSlopeBounce = false;
      const predictedSupports = Array.isArray(pushContext?.predictedSupports)
        ? pushContext.predictedSupports
        : null;

      while (true) {
        const attemptSnapshot = pushContext ? cloneState(state) : null;
        const occupiedSnapshot = pushContext ? new Set(occupied) : null;
        const moveCount = moves.length;
        const allowIceSlopeTransit = weightlessClusterHasIceSlopeTransit(
          state,
          members,
          gateState,
          orangeButtonsPressed
        );
        const step = weightlessClusterStep(
          state,
          members,
          stepDx,
          stepDy,
          occupied,
          gateState,
          orangeButtonsPressed,
          pushContext
            ? {
                ignoredActors,
                allowIceSlopeTransit,
                pushSlopeBlocker: (blocker, pushDx = stepDx, pushDy = stepDy) => {
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
            : { allowIceSlopeTransit }
        );

        if (!step) {
          const bounceOffsets = !reversedAfterSlopeBounce
            ? weightlessClusterBlockedSlopeBounceOffsets(
                state,
                members,
                stepDx,
                stepDy,
                occupied,
                gateState,
                orangeButtonsPressed
              )
            : null;

          if (bounceOffsets && bounceOffsets.length > 0) {
            if (attemptSnapshot && occupiedSnapshot) {
              copyStateInto(state, attemptSnapshot);
              occupied.clear();
              occupiedSnapshot.forEach((key) => occupied.add(key));
              moves.length = moveCount;
            }

            members.forEach((member) => {
              const start = startPositionByActor.get(member);
              const fromElevation = actorElevation(state, member);
              const fromX = state.actorX[member];
              const fromY = state.actorY[member];

              if (start) {
                appendPathPoints(
                  start.path,
                  bounceOffsets.map((point) => ({
                    x: fromX + point.dx,
                    y: fromY + point.dy,
                    elevation: fromElevation + point.elevation
                  }))
                );
              }
            });
            stepDx = -stepDx;
            stepDy = -stepDy;
            reversedAfterSlopeBounce = true;
            continue;
          }

          if (attemptSnapshot && occupiedSnapshot) {
            copyStateInto(state, attemptSnapshot);
            occupied.clear();
            occupiedSnapshot.forEach((key) => occupied.add(key));
            moves.length = moveCount;
          }
          break;
        }

        if (
          actorType === "clone" &&
          !clusterHasSupportedMemberAfterStep(
            state,
            members,
            step,
            gateState,
            orangeButtonsPressed,
            predictedSupports
          )
        ) {
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

        let settledDown = false;
        const supportCheckMemberSet = new Set(members);

        function appendSettledPathPoint() {
          members.forEach((member) => {
            const start = startPositionByActor.get(member);

            if (!start) {
              return;
            }

            appendPathPoints(start.path, [
              {
                x: state.actorX[member],
                y: state.actorY[member],
                elevation: actorElevation(state, member)
              }
            ]);
          });
        }

        const hasPendingPuncherTrigger = members.some(
          (member) =>
            puncherActorAt(
              state,
              state.actorX[member],
              state.actorY[member],
              actorElevation(state, member)
            ) !== -1
        );

        while (
          !hasPendingPuncherTrigger &&
          settleWeightlessClusterDownOneLayer(
            state,
            members,
            occupied,
            gateState,
            orangeButtonsPressed,
            predictedSupports
          )
        ) {
          const hasSupportAfterSettling = members.some((member) =>
            weightlessMemberHasCurrentSupport(
              state,
              member,
              gateState,
              orangeButtonsPressed,
              supportCheckMemberSet,
              predictedSupports
            )
          );
          const fullyAtOrBelowFloor = members.every((member) => actorElevation(state, member) <= 0);

          appendSettledPathPoint();
          settledDown = true;

          if (hasSupportAfterSettling || fullyAtOrBelowFloor) {
            break;
          }
        }

        moved = true;

        if (
          members.every((member) =>
            isHole(state, state.actorX[member], state.actorY[member], actorElevation(state, member))
          )
        ) {
          break;
        }

        if (settledDown) {
          break;
        }

        if (
          !weightlessClusterShouldContinueSliding(
            state,
            members,
            gateState,
            orangeButtonsPressed,
            predictedSupports
          )
        ) {
          break;
        }
      }

      if (!moved) {
        startPositions.forEach(({ fromElevation, fromX, fromY }) => {
          addOccupiedAtElevation(occupied, fromX, fromY, fromElevation);
        });
        carriedRiders.forEach((rider) => {
          addOccupiedAtElevation(occupied, rider.fromX, rider.fromY, rider.fromElevation);
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
            path.length > 2 ||
            pathControlsElevation ||
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

      carriedRiders.forEach((rider) => {
        const supportMove = moves
          .slice(options.moveStartIndex || 0)
          .find((move) => move.actorIndex === rider.supportMember && !move.visualOnly);

        if (!supportMove) {
          addOccupiedAtElevation(occupied, rider.fromX, rider.fromY, rider.fromElevation);
          return;
        }

        const path = moveRecordPathPoints(supportMove).map((point) => ({
          x: point.x,
          y: point.y,
          elevation: point.elevation + 1
        }));
        const toX = supportMove.toX;
        const toY = supportMove.toY;
        const toElevation = (supportMove.toElevation ?? rider.fromElevation - 1) + 1;
        const moveRecord = {
          actorIndex: rider.actorIndex,
          actorType: actorTypes[rider.actorIndex],
          fromElevation: rider.fromElevation,
          fromX: rider.fromX,
          fromY: rider.fromY,
          toElevation,
          toX,
          toY
        };

        if (path.length > 2 || path.some((point) => point.elevation !== rider.fromElevation)) {
          moveRecord.path = path;
          moveRecord.pathControlsElevation = path.some(
            (point) => point.elevation !== rider.fromElevation
          );
          moveRecord.pathEndElevation = path[path.length - 1]?.elevation ?? toElevation;
        }

        if (!searchMode && supportMove.iceSlide === true) {
          moveRecord.iceSlide = true;
        }

        state.actorX[rider.actorIndex] = toX;
        state.actorY[rider.actorIndex] = toY;
        state.actorElevation[rider.actorIndex] = toElevation;
        moves.push(moveRecord);
        addOccupiedAtElevation(occupied, toX, toY, toElevation);

        if (options.carriedPlayers instanceof Set) {
          options.carriedPlayers.add(rider.actorIndex);
        }
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
      searchMode = false,
      pushContext = null
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
          const blockedSlopeBouncePath =
            slideTraversal || blockedSlope
              ? null
              : blockedIceSlopeBouncePathForEntry(
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
          const canBounceBackFromSlope =
            blockedSlopeBouncePath &&
            blockedSlopeBouncePath.length > 0 &&
            isIce(state, state.actorX[member], state.actorY[member], memberElevation, gateState, orangeButtonsPressed);
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
              !canBounceBackFromSlope &&
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
          searchMode,
          pushContext
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
                ignoredActors,
                predictedSupports: pushContext?.predictedSupports || null
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

    function punchTriggerActorAt(state, x, y, elevation) {
      return actorAt(
        state,
        x,
        y,
        (actor) =>
          actorElevation(state, actor) === elevation &&
          (isPlayerActor(actor) || isPushableActor(actor))
      );
    }

    function canPunchActorCarryPuncher(type) {
      return type === "box" || type === "floating_floor" || type === "weightless_box";
    }

    function canActorCarrySurfaceAttachment(type) {
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

    function movePathForMerge(move) {
      const fromElevation = move.fromElevation ?? 0;
      const toElevation = move.toElevation ?? fromElevation;
      const path = Array.isArray(move.path)
        ? move.path
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
            )
        : [];

      if (path.length > 0) {
        return path;
      }

      return [
        { x: move.fromX, y: move.fromY, elevation: fromElevation },
        { x: move.toX, y: move.toY, elevation: toElevation }
      ];
    }

    function mergeActorMoveData(target, source) {
      const targetPath = movePathForMerge(target);
      const sourcePath = movePathForMerge(source);

      appendPathPoints(targetPath, sourcePath);

      target.toX = source.toX;
      target.toY = source.toY;
      target.toElevation = source.toElevation ?? target.toElevation ?? target.fromElevation ?? 0;
      target.finalX = source.finalX ?? target.finalX;
      target.finalY = source.finalY ?? target.finalY;
      target.finalElevation = source.finalElevation ?? target.finalElevation;
      target.iceSlide = target.iceSlide === true || source.iceSlide === true || targetPath.length > 2;

      if (source.toRemoved === true || target.toRemoved === true) {
        target.toRemoved = true;
      }

      if (source.punchSlide === true) {
        target.punchSlide = true;
      }

      if (source.iceSlipOff === true) {
        target.iceSlipOff = true;
      }

      if (source.visibleDuringMove === true) {
        target.visibleDuringMove = true;
      }

      if (source.skipHoleFall === true) {
        target.skipHoleFall = true;
      }

      if (source.snapHoleRestore === true) {
        target.snapHoleRestore = true;
      }

      if (source.fadeOut === true) {
        target.fadeOut = true;
      }

      if (source.fadeStartProgress !== undefined) {
        target.fadeStartProgress = source.fadeStartProgress;
      }

      if (source.fadeEndProgress !== undefined) {
        target.fadeEndProgress = source.fadeEndProgress;
      }

      if (source.fillsHole === true) {
        target.fillsHole = true;
        target.fillHoleX = source.fillHoleX ?? target.fillHoleX;
        target.fillHoleY = source.fillHoleY ?? target.fillHoleY;
        target.fillHolePreviousTerrain =
          source.fillHolePreviousTerrain ?? target.fillHolePreviousTerrain;
      }

      if (typeof source.punchStartX === "number" && typeof target.punchStartX !== "number") {
        target.punchStartX = source.punchStartX;
        target.punchStartY = source.punchStartY;
        target.punchStartElevation = source.punchStartElevation;
        target.punchStartIceSlide = source.punchStartIceSlide;
      }

      if (Array.isArray(source.punchSegments) && source.punchSegments.length > 0) {
        const targetSegments = Array.isArray(target.punchSegments) ? target.punchSegments : [];

        target.punchSegments = targetSegments.concat(
          source.punchSegments.map((segment) => ({ ...segment }))
        );
      }

      if (
        targetPath.length > 2 ||
        targetPath.some((point) => point.elevation !== (target.fromElevation ?? 0))
      ) {
        target.path = targetPath;
        target.pathControlsElevation = targetPath.some(
          (point) => point.elevation !== (target.fromElevation ?? 0)
        );
        target.pathEndElevation = targetPath[targetPath.length - 1]?.elevation ?? target.toElevation;
      } else {
        delete target.path;
        delete target.pathControlsElevation;
        delete target.pathEndElevation;
      }

      return target;
    }

    function collapseSequentialActorMoves(moves) {
      const collapsed = [];
      const moveByActor = new Map();

      moves.forEach((move) => {
        if (move.visualOnly || typeof move.actorIndex !== "number") {
          collapsed.push(move);
          return;
        }

        const existing = moveByActor.get(move.actorIndex);

        if (!existing) {
          moveByActor.set(move.actorIndex, move);
          collapsed.push(move);
          return;
        }

        mergeActorMoveData(existing, move);
      });

      if (collapsed.length !== moves.length) {
        moves.length = 0;
        collapsed.forEach((move) => moves.push(move));
      }
    }

    function punchStartSnapshotsForMembers(state, members, moves) {
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

    function recordPunchSegments(state, moves, punchStarts, sequence, searchMode) {
      if (searchMode) {
        return;
      }

      punchStarts.forEach(({ actorIndex, elevation, iceSlide, x, y }) => {
        const moveRecord = moves.find((move) => move.actorIndex === actorIndex && !move.visualOnly);

        if (!moveRecord) {
          return;
        }

        if (!Array.isArray(moveRecord.punchSegments)) {
          moveRecord.punchSegments = [];
        }

        moveRecord.punchSegments.push({
          sequence,
          fromX: x,
          fromY: y,
          fromElevation: elevation,
          toX: state.actorX[actorIndex],
          toY: state.actorY[actorIndex],
          toElevation: actorElevation(state, actorIndex),
          startIceSlide: iceSlide === true,
          punchSlide: true
        });
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
      searchMode,
      punchSequence = 0
    ) {
      if (
        searchMode ||
        moves.some((move) => move.actorIndex === puncher && move.visualOnly && move.punchEffect)
      ) {
        return;
      }

      const carrierMove = moves.find((move) => move.actorIndex === puncher && !move.visualOnly);
      const fromX = carrierMove?.fromX ?? state.actorX[puncher];
      const fromY = carrierMove?.fromY ?? state.actorY[puncher];
      const fromElevation = carrierMove?.fromElevation ?? actorElevation(state, puncher);
      const finalX = carrierMove?.toX ?? state.actorX[puncher];
      const finalY = carrierMove?.toY ?? state.actorY[puncher];
      const finalElevation = carrierMove?.toElevation ?? actorElevation(state, puncher);
      const { dx, dy } = puncherDirectionVector(actorDirections[puncher]);
      const lungeX = finalX + dx;
      const lungeY = finalY + dy;

      moves.push({
        actorIndex: puncher,
        actorType: actorTypes[puncher],
        fromX,
        fromY,
        targetX,
        targetY,
        toX: lungeX,
        toY: lungeY,
        finalX,
        finalY,
        fromElevation,
        toElevation: finalElevation,
        finalElevation,
        iceSlide: true,
        punchEffect: true,
        punchSequence,
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

    function puncherWasAttachedToPushEntityAtMoveStart(
      state,
      puncher,
      actorIndex,
      originalActorX,
      originalActorY,
      originalActorElevation
    ) {
      const members = pushActorMembers(state, actorIndex);

      return members.some((member) =>
        puncherWasAttachedToActorAtMoveStart(
          puncher,
          member,
          originalActorX,
          originalActorY,
          originalActorElevation
        )
      );
    }

    function statePositionEquals(leftX, leftY, leftElevation, rightX, rightY, rightElevation) {
      return leftX === rightX && leftY === rightY && leftElevation === rightElevation;
    }

    function pushEntityHasPunchSegment(moves, actorIndex) {
      const entityKey = pushEntityKey(actorIndex);

      return moves.some(
        (move) =>
          !move.visualOnly &&
          pushEntityKey(move.actorIndex) === entityKey &&
          Array.isArray(move.punchSegments) &&
          move.punchSegments.length > 0
      );
    }

    function punchFrontSortValue(state, actorIndex, dx, dy) {
      const members =
        isPushableActor(actorIndex) || isCloneActor(actorIndex)
          ? pushActorMembers(state, actorIndex)
          : [actorIndex];

      return members.reduce((front, member) => {
        const value = state.actorX[member] * dx + state.actorY[member] * dy;

        return Math.max(front, value);
      }, -Infinity);
    }

    function punchTriggerMembers(state, actorIndex) {
      return isPushableActor(actorIndex) || isCloneActor(actorIndex)
        ? pushActorMembers(state, actorIndex)
        : [actorIndex];
    }

    function collectPunchTrainMembers(state, actorIndex, dx, dy) {
      const members = [];
      const memberSet = new Set();
      const entityKeys = new Set();

      function entityKeyForPunchActor(actor) {
        return isPushableActor(actor) || isCloneActor(actor)
          ? pushEntityKey(actor)
          : `actor:${actor}`;
      }

      function addActorEntity(actor) {
        const entityKey = entityKeyForPunchActor(actor);

        if (entityKeys.has(entityKey)) {
          return false;
        }

        entityKeys.add(entityKey);
        punchTriggerMembers(state, actor).forEach((member) => {
          if (!memberSet.has(member)) {
            memberSet.add(member);
            members.push(member);
          }
        });

        return true;
      }

      addActorEntity(actorIndex);

      let expanded = true;

      while (expanded) {
        expanded = false;

        members.slice().forEach((member) => {
          const targetX = state.actorX[member] + dx;
          const targetY = state.actorY[member] + dy;
          const elevation = actorElevation(state, member);
          const nextActor = actorAt(
            state,
            targetX,
            targetY,
            (actor) =>
              !memberSet.has(actor) &&
              actorElevation(state, actor) === elevation &&
              (isPlayerActor(actor) || isPushableActor(actor))
          );

          if (nextActor !== -1 && addActorEntity(nextActor)) {
            expanded = true;
          }
        });
      }

      return members;
    }

    function removePunchMembersFromOccupied(state, occupied, members) {
      members.forEach((member) => {
        removeOccupiedAtElevation(
          occupied,
          state.actorX[member],
          state.actorY[member],
          actorElevation(state, member)
        );
      });
    }

    function addPunchMembersToOccupied(state, occupied, members) {
      members.forEach((member) => {
        addOccupiedAtElevation(
          occupied,
          state.actorX[member],
          state.actorY[member],
          actorElevation(state, member)
        );
      });
    }

    function applyPunchers(
      state,
      moves,
      originalActorX,
      originalActorY,
      originalActorElevation,
      searchMode,
      options = {}
    ) {
      if (!actorTypes.includes("puncher")) {
        return;
      }

      const candidateActorIndexes =
        options.candidateActorIndexes instanceof Set ? options.candidateActorIndexes : null;
      const includeUnpunchedMovedActors = options.includeUnpunchedMovedActors === true;
      const sequenceBase = Number.isFinite(options.sequenceBase) ? options.sequenceBase : 0;
      const triggered = new Set();
      let triggeredThisPass = true;
      let passCount = 0;

      function positionKey(x, y, elevation) {
        return `${x},${y},${elevation || 0}`;
      }

      function movingMemberInfoMap(infos) {
        const map = new Map();

        infos.forEach((info) => {
          info.members.forEach((member) => {
            map.set(member, info);
          });
        });

        return map;
      }

      function targetKeysForInfo(info) {
        return info.members.map((member) =>
          positionKey(
            state.actorX[member] + info.dx,
            state.actorY[member] + info.dy,
            actorElevation(state, member)
          )
        );
      }

      function targetCountsForInfos(infos) {
        const counts = new Map();

        infos.forEach((info) => {
          targetKeysForInfo(info).forEach((key) => {
            counts.set(key, (counts.get(key) || 0) + 1);
          });
        });

        return counts;
      }

      function actorTargetsPosition(actor, info, x, y, elevation) {
        return (
          state.actorX[actor] + info.dx === x &&
          state.actorY[actor] + info.dy === y &&
          actorElevation(state, actor) === elevation
        );
      }

      function canSimultaneousPunchStep(info, movingMemberInfo, targetCounts, occupied) {
        return info.members.every((member) => {
          const targetX = state.actorX[member] + info.dx;
          const targetY = state.actorY[member] + info.dy;
          const elevation = actorElevation(state, member);
          const targetKey = positionKey(targetX, targetY, elevation);

          if (!isInsideBoard(targetX, targetY)) {
            return false;
          }

          if (terrainBlocksElevation(state, targetX, targetY, elevation, info.gateState, info.orangeButtonsPressed)) {
            return false;
          }

          if ((targetCounts.get(targetKey) || 0) > 1) {
            return false;
          }

          const blocker = actorAt(
            state,
            targetX,
            targetY,
            (actor) =>
              !info.memberSet.has(actor) &&
              !isNonBlockingActor(actor) &&
              actorElevation(state, actor) === elevation
          );

          if (blocker !== -1) {
            if (!movingMemberInfo.has(blocker)) {
              return false;
            }

            const blockerInfo = movingMemberInfo.get(blocker);

            if (
              blockerInfo &&
              blockerInfo !== info &&
              actorTargetsPosition(
                blocker,
                blockerInfo,
                state.actorX[member],
                state.actorY[member],
                elevation
              )
            ) {
              return false;
            }
          }

          if (
            blocker === -1 &&
            isOccupiedAtElevation(occupied, targetX, targetY, elevation)
          ) {
            return false;
          }

          return true;
        });
      }

      function moveSimultaneousPunchGroup(infos, occupied) {
        const movedInfos = new Set();
        let stepCount = 0;

        while (stepCount < actorCount + width + height) {
          stepCount += 1;
          let movingInfos = infos.slice();
          let changed = true;

          while (changed) {
            changed = false;
            const movingMemberInfo = movingMemberInfoMap(movingInfos);
            const targetCounts = targetCountsForInfos(movingInfos);
            const nextMovingInfos = movingInfos.filter((info) =>
              canSimultaneousPunchStep(info, movingMemberInfo, targetCounts, occupied)
            );

            if (nextMovingInfos.length !== movingInfos.length) {
              changed = true;
              movingInfos = nextMovingInfos;
            }
          }

          if (movingInfos.length === 0) {
            break;
          }

          movingInfos.forEach((info) => {
            info.members.forEach((member) => {
              state.actorX[member] += info.dx;
              state.actorY[member] += info.dy;
            });
            movedInfos.add(info);
          });
        }

        return movedInfos;
      }

      while (triggeredThisPass && passCount < actorCount + width + height) {
        triggeredThisPass = false;
        passCount += 1;

        const occupied = buildOccupiedMap(state);
        const gateState = computeRaisedPlayerGateSet(state);
        const orangeButtonsPressed = areOrangeButtonsPressed(state);
        const candidateSource = (
          candidateActorIndexes
            ? Array.from(candidateActorIndexes)
            : moves.filter((move) => !move.visualOnly && !move.toRemoved).map((move) => move.actorIndex)
        );

        if (candidateActorIndexes && includeUnpunchedMovedActors) {
          moves.forEach((move) => {
            if (
              move.visualOnly ||
              move.toRemoved ||
              pushEntityHasPunchSegment(moves, move.actorIndex)
            ) {
              return;
            }

            candidateSource.push(move.actorIndex);
          });
        }

        const candidates = candidateSource.filter(
          (actorIndex, index, actorIndexes) =>
            actorIndexes.indexOf(actorIndex) === index &&
            !state.actorRemoved[actorIndex] &&
            (isPlayerActor(actorIndex) || isPushableActor(actorIndex))
        );
        const triggers = [];

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
            puncherWasAttachedToPushEntityAtMoveStart(
              state,
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

          const { dx, dy } = puncherDirectionVector(actorDirections[puncher]);

          triggers.push({
            actorIndex,
            dx,
            dy,
            elevation,
            front: punchFrontSortValue(state, actorIndex, dx, dy),
            puncher,
            triggerKey
          });
        }

        triggers.sort(
          (left, right) =>
            left.dx - right.dx ||
            left.dy - right.dy ||
            left.front - right.front ||
            left.actorIndex - right.actorIndex
        );

        const claimedMembers = new Set();
        const triggerInfos = [];

        triggers
          .filter(
            ({ actorIndex, triggerKey }) =>
              !state.actorRemoved[actorIndex] && !triggered.has(triggerKey)
          )
          .forEach((trigger) => {
            const members = collectPunchTrainMembers(state, trigger.actorIndex, trigger.dx, trigger.dy);

            if (members.some((member) => claimedMembers.has(member))) {
              return;
            }

            members.forEach((member) => claimedMembers.add(member));
            triggerInfos.push({
              ...trigger,
              gateState,
              members,
              memberSet: new Set(members),
              orangeButtonsPressed,
              punchStarts: punchStartSnapshotsForMembers(state, members, moves)
            });
          });

        triggerInfos.forEach(({ members }) => {
          if (members.length > 0) {
            removePunchMembersFromOccupied(state, occupied, members);
          }
        });

        const movedInfos = moveSimultaneousPunchGroup(triggerInfos, occupied);

        triggerInfos.forEach(({ members }) => {
          addPunchMembersToOccupied(state, occupied, members);
        });

        for (const info of triggerInfos) {
          if (!movedInfos.has(info)) {
            continue;
          }

          const { actorIndex, puncher, triggerKey, punchStarts } = info;
          triggered.add(triggerKey);
          const punchSequence = sequenceBase + passCount - 1;

          info.members.forEach((member) => {
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

          markPunchStartOnMoves(moves, punchStarts);
          recordPunchSegments(state, moves, punchStarts, punchSequence, searchMode);
          addPuncherVisualMove(
            state,
            puncher,
            state.actorX[actorIndex],
            state.actorY[actorIndex],
            moves,
            originalActorX,
            originalActorY,
            originalActorElevation,
            searchMode,
            punchSequence
          );

          if (candidateActorIndexes) {
            info.members.forEach((member) => candidateActorIndexes.add(member));
          }

          triggeredThisPass = true;
        }
      }
    }

    function nextPunchSequence(moves) {
      let nextSequence = 0;

      moves.forEach((move) => {
        if (Array.isArray(move.punchSegments)) {
          move.punchSegments.forEach((segment) => {
            const sequence = Number(segment?.sequence);

            if (Number.isFinite(sequence)) {
              nextSequence = Math.max(nextSequence, sequence + 1);
            }
          });
        }

        if (move.visualOnly && move.punchEffect) {
          const sequence = Number(move.punchSequence);

          if (Number.isFinite(sequence)) {
            nextSequence = Math.max(nextSequence, sequence + 1);
          }
        }
      });

      return nextSequence;
    }

    function syncAttachedPunchersForMoves(
      state,
      moves,
      originalActorX,
      originalActorY,
      originalActorElevation,
      searchMode
    ) {
      const punchCandidates = new Set();
      const syncedPunchers = new Set();

      if (!actorTypes.includes("puncher")) {
        return punchCandidates;
      }

      function copyStickyCarrierMoveData(carrierMove, puncherMove, dx, dy) {
        puncherMove.stickyCarrierActorIndex = carrierMove.actorIndex;
        puncherMove.stickyCarrierEntityKey = pushEntityKey(carrierMove.actorIndex);
        puncherMove.stickyCarrierDx = dx;
        puncherMove.stickyCarrierDy = dy;

        if (carrierMove.iceSlide === true) {
          puncherMove.iceSlide = true;
        }

        if (carrierMove.punchSlide === true) {
          puncherMove.punchSlide = true;
        }

        if (typeof carrierMove.punchStartX === "number") {
          puncherMove.punchStartX = carrierMove.punchStartX + dx;
          puncherMove.punchStartY = carrierMove.punchStartY + dy;
          puncherMove.punchStartElevation = carrierMove.punchStartElevation;
          puncherMove.punchStartIceSlide = carrierMove.punchStartIceSlide;
        }

        if (Array.isArray(carrierMove.punchSegments)) {
          puncherMove.punchSegments = carrierMove.punchSegments.map((segment) => ({
            ...segment,
            fromX: segment.fromX + dx,
            fromY: segment.fromY + dy,
            toX: segment.toX + dx,
            toY: segment.toY + dy
          }));
        }

        if (Array.isArray(carrierMove.path)) {
          puncherMove.path = carrierMove.path.map((point) => ({
            x: point.x + dx,
            y: point.y + dy,
            elevation: point.elevation
          }));
          puncherMove.pathControlsElevation = carrierMove.pathControlsElevation;
          puncherMove.pathEndElevation = carrierMove.pathEndElevation;
        }

        if (carrierMove.toRemoved === true) {
          puncherMove.toRemoved = true;
          puncherMove.skipHoleFall = carrierMove.skipHoleFall;
          puncherMove.visibleDuringMove = carrierMove.visibleDuringMove;
          puncherMove.fadeOut = carrierMove.fadeOut;
          puncherMove.fadeStartProgress = carrierMove.fadeStartProgress;
          puncherMove.fadeEndProgress = carrierMove.fadeEndProgress;
        }
      }

      function retargetPuncherVisualMove(visualMove, puncherMove) {
        if (!visualMove || !puncherMove) {
          return;
        }

        const { dx, dy } = puncherDirectionVector(actorDirections[visualMove.actorIndex]);
        const baseX = puncherMove.toX;
        const baseY = puncherMove.toY;
        const baseElevation = puncherMove.toElevation ?? puncherMove.fromElevation ?? 0;

        visualMove.toX = baseX + dx;
        visualMove.toY = baseY + dy;
        visualMove.toElevation = baseElevation;
        visualMove.finalX = baseX;
        visualMove.finalY = baseY;
        visualMove.finalElevation = baseElevation;
      }

      moves.forEach((move) => {
        if (
          move.visualOnly ||
          move.actorType !== "puncher" ||
          typeof move.stickyCarrierActorIndex !== "number"
        ) {
          return;
        }

        const carrierMove = moves.find(
          (candidate) =>
            !candidate.visualOnly &&
            candidate.actorIndex === move.stickyCarrierActorIndex &&
            pushEntityKey(candidate.actorIndex) === move.stickyCarrierEntityKey
        );

        if (!carrierMove) {
          return;
        }

        const dx =
          typeof move.stickyCarrierDx === "number"
            ? move.stickyCarrierDx
            : move.fromX - carrierMove.fromX;
        const dy =
          typeof move.stickyCarrierDy === "number"
            ? move.stickyCarrierDy
            : move.fromY - carrierMove.fromY;
        move.toX = carrierMove.toX + dx;
        move.toY = carrierMove.toY + dy;
        move.toElevation = carrierMove.toElevation ?? carrierMove.fromElevation ?? 0;
        state.actorX[move.actorIndex] = move.toX;
        state.actorY[move.actorIndex] = move.toY;
        state.actorElevation[move.actorIndex] = move.toElevation;
        state.actorRemoved[move.actorIndex] = carrierMove.toRemoved === true ? 1 : 0;
        copyStickyCarrierMoveData(carrierMove, move, dx, dy);
        retargetPuncherVisualMove(
          moves.find(
            (candidate) =>
              candidate.actorIndex === move.actorIndex &&
              candidate.visualOnly &&
              candidate.punchEffect === true
          ),
          move
        );
        syncedPunchers.add(move.actorIndex);
      });

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
            if (!isPuncherActor(puncher) || state.actorRemoved[puncher] || syncedPunchers.has(puncher)) {
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
            syncedPunchers.add(puncher);
            const targetActor = punchTriggerActorAt(
              state,
              state.actorX[puncher],
              state.actorY[puncher],
              actorElevation(state, puncher)
            );

            if (
              targetActor !== -1 &&
              pushEntityKey(targetActor) !== pushEntityKey(move.actorIndex)
            ) {
              punchCandidates.add(targetActor);
            }

            const visualMove = moves.find(
              (candidate) =>
                candidate.actorIndex === puncher &&
                candidate.visualOnly &&
                candidate.punchEffect === true
            );

            const puncherMove = mergeMoveRecord(
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

            copyStickyCarrierMoveData(move, puncherMove, dx, dy);
            retargetPuncherVisualMove(visualMove, puncherMove);

            if (move.toRemoved === true) {
              state.actorRemoved[puncher] = 1;
            }
          }
        });

      return punchCandidates;
    }

    function syncAttachedSurfaceAttachmentsForMoves(
      state,
      moves,
      originalActorX,
      originalActorY,
      originalActorElevation,
      searchMode
    ) {
      if (orangeButtonActors.length === 0) {
        return;
      }

      moves
        .filter(
          (move) =>
            !move.visualOnly &&
            canActorCarrySurfaceAttachment(move.actorType) &&
            (move.fromX !== move.toX ||
              move.fromY !== move.toY ||
              (move.fromElevation ?? 0) !== (move.toElevation ?? move.fromElevation ?? 0) ||
              move.toRemoved === true)
        )
        .forEach((move) => {
          for (let index = 0; index < orangeButtonActors.length; index += 1) {
            const button = orangeButtonActors[index];
            const carrierFromElevation = move.fromElevation ?? originalActorElevation[move.actorIndex] ?? 0;

            if (
              state.actorRemoved[button] ||
              originalActorX[button] !== move.fromX ||
              originalActorY[button] !== move.fromY ||
              (originalActorElevation[button] || 0) !== carrierFromElevation + 1
            ) {
              continue;
            }

            state.actorX[button] = move.toX;
            state.actorY[button] = move.toY;
            state.actorElevation[button] = (move.toElevation ?? carrierFromElevation) + 1;
            state.actorRemoved[button] = move.toRemoved === true ? 1 : 0;

            const buttonMove = mergeMoveRecord(
              state,
              moves,
              button,
              originalActorX,
              originalActorY,
              originalActorElevation,
              {
                iceSlide: !searchMode && move.iceSlide === true,
                punchSlide: move.punchSlide === true
              }
            );

            if (Array.isArray(move.path) && move.path.length > 1) {
              buttonMove.path = move.path.map((point) => ({
                x: point.x,
                y: point.y,
                elevation: (point.elevation ?? carrierFromElevation) + 1
              }));
              buttonMove.pathControlsElevation = true;
              buttonMove.pathEndElevation =
                buttonMove.path[buttonMove.path.length - 1]?.elevation ?? buttonMove.toElevation;
            }

            if (move.toRemoved === true) {
              buttonMove.toRemoved = true;
              buttonMove.fadeOut = move.fadeOut;
              buttonMove.fadeStartProgress = move.fadeStartProgress;
              buttonMove.fadeEndProgress = move.fadeEndProgress;
            }
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
      const stickyPuncherMoves = [];

      function copyCarrierRemovalToStickyPuncher(move) {
        const carrierMove = moves.find(
          (candidate) =>
            !candidate.visualOnly &&
            candidate.actorIndex === move.stickyCarrierActorIndex &&
            pushEntityKey(candidate.actorIndex) === move.stickyCarrierEntityKey
        );

        move.toRemoved = Boolean(carrierMove?.toRemoved);

        if (carrierMove?.toRemoved === true) {
          move.skipHoleFall = carrierMove.skipHoleFall;
          move.visibleDuringMove = carrierMove.visibleDuringMove;
          move.fadeOut = carrierMove.fadeOut;
          move.fadeStartProgress = carrierMove.fadeStartProgress;
          move.fadeEndProgress = carrierMove.fadeEndProgress;
        }
      }

      moves.forEach((move) => {
        if (move.visualOnly) {
          return;
        }

        move.fromRemoved = Boolean(move.fromRemoved);
        move.toRemoved = Boolean(move.toRemoved);

        if (
          move.actorType === "puncher" &&
          typeof move.stickyCarrierActorIndex === "number"
        ) {
          stickyPuncherMoves.push(move);
          return;
        }

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
          move.fillHolePreviousTerrain =
            state.terrain[cellIndex(move.fillHoleX, move.fillHoleY)];
          return;
        }

        const toElevation = move.toElevation ?? actorElevation(state, move.actorIndex);
        const actorIsOnHole = isHole(
          state,
          state.actorX[move.actorIndex],
          state.actorY[move.actorIndex],
          toElevation
        );
        const actorHasSurfaceSupport = surfaceSupportsElevation(
          state,
          state.actorX[move.actorIndex],
          state.actorY[move.actorIndex],
          toElevation,
          gateState,
          orangeButtonsPressed,
          new Set([move.actorIndex]),
          true
        );
        const actorIsOnUnsupportedHole = actorIsOnHole && !actorHasSurfaceSupport;
        const actorIsOverOpenPit =
          (move.punchSlide === true || move.iceSlipOff === true) &&
          !actorIsOnUnsupportedHole &&
          lacksLandingSupportAtOrBelow(
            state,
            move.actorIndex,
            toElevation,
            gateState,
            orangeButtonsPressed
          );

        if (
          (actorIsOnUnsupportedHole || actorIsOverOpenPit) &&
          (!isPlayerType(move.actorType) || actorIsOverOpenPit || toElevation === 0)
        ) {
          move.toRemoved = true;
        }
      });

      stickyPuncherMoves.forEach(copyCarrierRemovalToStickyPuncher);
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

    function syncDynamicActorElevationsAndFalls(
      state,
      moves,
      previousGateState = computeRaisedPlayerGateSet(state),
      previousOrangeButtonsPressed = areOrangeButtonsPressed(state)
    ) {
      const moveByActor = new Map(moves.map((move) => [move.actorIndex, move]));
      const originalElevations = new Int16Array(state.actorElevation);
      let gateState = computeRaisedPlayerGateSet(state);
      let orangeButtonsPressed = areOrangeButtonsPressed(state);

      function dynamicTerrainSurfaceTransitionsAt(x, y, nextGateState, nextOrangeButtonsPressed) {
        if (!isInsideBoard(x, y)) {
          return [];
        }

        const cell = cellIndex(x, y);
        return terrainLayersForCell(state, cell)
          .map((layer) => ({
            from: terrainLayerSurfaceHeight(
              state,
              cell,
              layer,
              previousGateState,
              previousOrangeButtonsPressed
            ),
            to: terrainLayerSurfaceHeight(
              state,
              cell,
              layer,
              nextGateState,
              nextOrangeButtonsPressed
            )
          }))
          .filter(
            (transition) =>
              transition.from !== null &&
              transition.to !== null &&
              transition.from !== transition.to
          );
      }

      function dynamicTerrainRideElevation(index, nextGateState, nextOrangeButtonsPressed) {
        const elevation = actorElevation(state, index);
        const hasActorSupport = actorSupportsElevation(
          state,
          state.actorX[index],
          state.actorY[index],
          elevation,
          new Set([index]),
          true
        );

        if (hasActorSupport) {
          return elevation;
        }

        const transitions = dynamicTerrainSurfaceTransitionsAt(
          state.actorX[index],
          state.actorY[index],
          nextGateState,
          nextOrangeButtonsPressed
        );

        for (const transition of transitions) {
          if (transition.from === elevation) {
            return transition.to;
          }
        }

        return elevation;
      }

      const maxDynamicElevationIterations = Math.max(4, actorCount);

      for (let iteration = 0; iteration < maxDynamicElevationIterations; iteration += 1) {
        gateState = computeRaisedPlayerGateSet(state);
        orangeButtonsPressed = areOrangeButtonsPressed(state);
        let changed = false;
        const iterationStartElevations = new Int16Array(state.actorElevation);
        const changedSupportActors = new Set();

        function setDynamicElevation(index, toElevation) {
          if (state.actorElevation[index] === toElevation) {
            return;
          }

          state.actorElevation[index] = toElevation;
          changed = true;

          if (isSupportActorType(actorTypes[index])) {
            changedSupportActors.add(index);
          }
        }

        for (let index = 0; index < actorCount; index += 1) {
          if (
            state.actorRemoved[index] ||
            actorTypes[index] === "weightless_box" ||
            !isSupportActorType(actorTypes[index])
          ) {
            continue;
          }

          setDynamicElevation(index, dynamicTerrainRideElevation(index, gateState, orangeButtonsPressed));
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

          const componentGroupIds = weightlessVerticalSupportComponentGroupIds(state, groupId);
          componentGroupIds.forEach((componentGroupId) => handledWeightlessGroups.add(componentGroupId));

          const component = weightlessComponentSupportedElevation(
            state,
            componentGroupIds,
            gateState,
            orangeButtonsPressed
          );

          component.members.forEach((member) => {
            const toElevation =
              component.baseElevation +
              (component.groupBaseOffsets.get(actorGroupIds[member]) ?? 0) +
              (weightlessRelativeElevations[member] || 0);

            setDynamicElevation(member, toElevation);
          });
        }

        const propagationQueue = Array.from(changedSupportActors);
        for (let queueIndex = 0; queueIndex < propagationQueue.length; queueIndex += 1) {
          const lower = propagationQueue[queueIndex];
          const lowerFromElevation = iterationStartElevations[lower] || 0;
          const lowerToElevation = actorElevation(state, lower);

          if (lowerFromElevation === lowerToElevation) {
            continue;
          }

          for (let upper = 0; upper < actorCount; upper += 1) {
            if (
              upper === lower ||
              state.actorRemoved[upper] ||
              !isSupportActorType(actorTypes[upper]) ||
              actorTypes[upper] === "weightless_box" ||
              state.actorX[upper] !== state.actorX[lower] ||
              state.actorY[upper] !== state.actorY[lower] ||
              (iterationStartElevations[upper] || 0) !== lowerFromElevation + 1
            ) {
              continue;
            }

            setDynamicElevation(upper, lowerToElevation + 1);
            propagationQueue.push(upper);
          }
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
        if (
          state.actorRemoved[index] ||
          actorTypes[index] === "weightless_box" ||
          !isSupportActorType(actorTypes[index])
        ) {
          continue;
        }

        const toElevation = actorElevation(state, index);
        if ((originalElevations[index] || 0) === toElevation) {
          continue;
        }

        ensureDynamicMove(index, toElevation);
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

        const componentGroupIds = weightlessVerticalSupportComponentGroupIds(state, groupId);
        componentGroupIds.forEach((componentGroupId) => handledWeightlessGroups.add(componentGroupId));

        const component = weightlessComponentSupportedElevation(
          state,
          componentGroupIds,
          gateState,
          orangeButtonsPressed
        );
        const componentTargetElevation = (member) =>
          component.baseElevation +
          (component.groupBaseOffsets.get(actorGroupIds[member]) ?? 0) +
          (weightlessRelativeElevations[member] || 0);
        const componentMovedOrChangedElevation = component.members.some((member) => {
          const toElevation = componentTargetElevation(member);

          return moveByActor.has(member) || (originalElevations[member] || 0) !== toElevation;
        });
        const componentFullyAtOrBelowFloor = component.members.every(
          (member) => componentTargetElevation(member) <= 0
        );
        const componentHasTargetSupport = component.members.some((member) => {
          const toElevation = componentTargetElevation(member);

          return (
            terrainSupportsElevation(
              state,
              state.actorX[member],
              state.actorY[member],
              toElevation,
              gateState,
              orangeButtonsPressed
            ) ||
            actorSupportSurfaceHeightsAt(
              state,
              state.actorX[member],
              state.actorY[member],
              component.memberSet,
              true
            ).includes(toElevation)
          );
        });
        const shouldFallIntoHole =
          componentMovedOrChangedElevation &&
          component.members.length > 0 &&
          componentFullyAtOrBelowFloor &&
          !componentHasTargetSupport;

        component.members.forEach((member) => {
          const toElevation = componentTargetElevation(member);

          if ((originalElevations[member] || 0) !== toElevation || shouldFallIntoHole) {
            const moveRecord = ensureDynamicMove(member, toElevation);

            if (
              !shouldFallIntoHole &&
              Array.isArray(moveRecord.path) &&
              moveRecord.path.length > 0
            ) {
              const pathEnd = moveRecord.path[moveRecord.path.length - 1];

              if (
                pathEnd &&
                pathEnd.x === state.actorX[member] &&
                pathEnd.y === state.actorY[member] &&
                pathEnd.elevation !== toElevation
              ) {
                if (typeof moveRecord.pathEndElevation !== "number") {
                  moveRecord.pathEndElevation = pathEnd.elevation;
                }

                appendPathPoints(moveRecord.path, [
                  {
                    x: state.actorX[member],
                    y: state.actorY[member],
                    elevation: toElevation
                  }
                ]);
                moveRecord.pathControlsElevation = true;
              }
            }

            moveRecord.toRemoved = shouldFallIntoHole;
          }

          state.actorElevation[member] = toElevation;
          state.actorRemoved[member] = shouldFallIntoHole ? 1 : 0;
        });
      }
    }

    function sortPlayersForMove(state, dx, dy) {
      const players = [];
      const moveOrderElevation = (actorIndex) => {
        if (!isCloneActor(actorIndex)) {
          return actorElevation(state, actorIndex);
        }

        return cloneGroupMembers(state, actorGroupIds[actorIndex]).reduce(
          (lowest, member) => Math.min(lowest, actorElevation(state, member)),
          Infinity
        );
      };

      for (let index = 0; index < actorCount; index += 1) {
        if (isPlayerActor(index) && !state.actorRemoved[index]) {
          players.push(index);
        }
      }

      const sortedPlayers = players.sort((left, right) => {
        if (dx > 0) {
          return (
            state.actorX[right] - state.actorX[left] ||
            state.actorY[left] - state.actorY[right] ||
            moveOrderElevation(left) - moveOrderElevation(right)
          );
        }
        if (dx < 0) {
          return (
            state.actorX[left] - state.actorX[right] ||
            state.actorY[left] - state.actorY[right] ||
            moveOrderElevation(left) - moveOrderElevation(right)
          );
        }
        if (dy > 0) {
          return (
            state.actorY[right] - state.actorY[left] ||
            state.actorX[left] - state.actorX[right] ||
            moveOrderElevation(left) - moveOrderElevation(right)
          );
        }
        return (
          state.actorY[left] - state.actorY[right] ||
          state.actorX[left] - state.actorX[right] ||
          moveOrderElevation(left) - moveOrderElevation(right)
        );
      });
      const seenCloneGroups = new Set();

      return sortedPlayers.filter((actorIndex) => {
        if (!isCloneActor(actorIndex)) {
          return true;
        }

        const groupKey = actorGroupIds[actorIndex] || "";

        if (seenCloneGroups.has(groupKey)) {
          return false;
        }

        seenCloneGroups.add(groupKey);
        return true;
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
      const continuePunchSlide = options.continuePunchSlide === true;
      const carriedPlayers = new Set();

      orderedPlayers.forEach((player) => {
        if (carriedPlayers.has(player)) {
          return;
        }

        const fromX = state.actorX[player];
        const fromY = state.actorY[player];
        const fromElevation = actorElevation(state, player);
        const canExitLevel = isMainPlayerActor(player);

        if (isCloneActor(player)) {
          const members = cloneGroupMembers(state, actorGroupIds[player]);
          const carriedRiders = cloneRidersForMove(
            state,
            members,
            dx,
            dy,
            raisedPlayerGates,
            orangeButtonsPressed
          );
          const moveStartIndex = moves.length;

          moveWeightlessCluster(
            state,
            [actorGroupIds[player] || ""],
            dx,
            dy,
            occupied,
            moves,
            raisedPlayerGates,
            orangeButtonsPressed,
            searchMode,
            null,
            "clone",
            {
              carriedPlayers,
              carriedRiders,
              moveStartIndex
            }
          );
          return;
        }

        removeOccupiedAtElevation(occupied, fromX, fromY, fromElevation);

        let nextX = fromX;
        let nextY = fromY;
        let travelElevation = fromElevation;
        const travelPath = [{ x: fromX, y: fromY, elevation: fromElevation }];
        let iceSlipLanding = null;
        const ignoredPlayerSet = new Set([player]);
        let stepDx = dx;
        let stepDy = dy;
        let reversedAfterSlopeBounce = false;
        let levelExit = null;
        let stopAfterStartSlope = false;

        if (!continuePunchSlide && options.startOnCurrentSlope === true) {
          const startSlopeTraversal = resolveIceSlopeTraversal(
            state,
            nextX,
            nextY,
            stepDx,
            stepDy,
            travelElevation,
            occupied,
            raisedPlayerGates,
            orangeButtonsPressed,
            {
              allowLevelExit: true,
              ignoredActors: ignoredPlayerSet
            }
          );

          if (startSlopeTraversal) {
            nextX = startSlopeTraversal.exitX;
            nextY = startSlopeTraversal.exitY;
            travelElevation = startSlopeTraversal.exitElevation;
            appendPathPoints(travelPath, startSlopeTraversal.path);

            if (startSlopeTraversal.levelExit === true) {
              if (canExitLevel) {
                levelExit = {
                  dx: startSlopeTraversal.levelExitDx,
                  dy: startSlopeTraversal.levelExitDy,
                  elevation: startSlopeTraversal.levelExitElevation,
                  sourceType: startSlopeTraversal.levelExitSourceType
                };
              } else {
                stopAfterStartSlope = true;
              }
            } else if (
              !isIce(state, nextX, nextY, travelElevation, raisedPlayerGates, orangeButtonsPressed)
            ) {
              stopAfterStartSlope = true;
            }
          }
        }

        while (true) {
          if (levelExit || stopAfterStartSlope) {
            break;
          }

          const targetX = nextX + stepDx;
          const targetY = nextY + stepDy;
          const isInitialStep =
            travelPath.length === 1 && nextX === fromX && nextY === fromY;

          if (continuePunchSlide) {
            if (!isInsideBoard(targetX, targetY)) {
              if (canExitLevel) {
                levelExit = {
                  dx: stepDx,
                  dy: stepDy,
                  elevation: travelElevation,
                  sourceType: "punch"
                };
              }
              break;
            }

            if (
              terrainBlocksElevation(
                state,
                targetX,
                targetY,
                travelElevation,
                raisedPlayerGates,
                orangeButtonsPressed
              ) ||
              blockingActorAtElevation(state, targetX, targetY, travelElevation, player) !== -1
            ) {
              break;
            }

            nextX = targetX;
            nextY = targetY;
            travelPath.push({
              x: nextX,
              y: nextY,
              elevation: travelElevation
            });
            continue;
          }

          const pushSlopeBlocker = (blocker, pushDx = stepDx, pushDy = stepDy) => {
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
            stepDx,
            stepDy,
            travelElevation,
            occupied,
            raisedPlayerGates,
            orangeButtonsPressed,
            {
              allowLevelExit: true,
              ignoredActors: ignoredPlayerSet,
              pushSlopeBlocker
            }
          );

          if (!slopeTraversal) {
            const blockedSlope = blockedIceSlopePushForEntry(
              state,
              targetX,
              targetY,
              stepDx,
              stepDy,
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
                  stepDx,
                  stepDy,
                  travelElevation,
                  occupied,
                  raisedPlayerGates,
                  orangeButtonsPressed,
                  {
                    allowLevelExit: true,
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
          let slipLanding =
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
          let canSlipOffIce = slipLanding !== null;
          const blockingActor =
            !isInsideBoard(targetX, targetY) || canSlipOffIce || canTraverseSlope
              ? -1
              : blockingActorAtElevation(
                  state,
                  moveTargetX,
                  moveTargetY,
                  moveTargetElevation,
                  player
                );
          const supportActor = isInitialStep ? pushableSupportActorUnderPlayer(state, player) : -1;
          const actorToPush = blockingActor;
          const canAttemptInitialPush =
            actorToPush !== -1 && isInitialStep && isPushableActor(actorToPush);
          let pushedFollowPath = null;
          let pushedFollowTargetX = moveTargetX;
          let pushedFollowTargetY = moveTargetY;
          let pushedFollowTargetElevation = moveTargetElevation;

          if (
            !isInsideBoard(targetX, targetY) ||
            (!canTraverseSlope &&
              !canEnterHole &&
              !canStandAtTarget &&
              !canSlipOffIce &&
              !canAttemptInitialPush)
          ) {
            if (isInsideBoard(targetX, targetY)) {
              const bouncePath = blockedIceSlopeBouncePathForEntry(
                state,
                targetX,
                targetY,
                stepDx,
                stepDy,
                travelElevation,
                occupied,
                raisedPlayerGates,
                orangeButtonsPressed
              );

              if (bouncePath && bouncePath.length > 0) {
                const returnPath = bouncePath
                  .slice(0, -1)
                  .reverse()
                  .map((point) => ({ ...point }));
                const pathHome = { x: nextX, y: nextY, elevation: travelElevation };

                if (
                  !reversedAfterSlopeBounce &&
                  isIce(state, nextX, nextY, travelElevation, raisedPlayerGates, orangeButtonsPressed)
                ) {
                  appendPathPoints(travelPath, bouncePath.map((point) => ({ ...point })));
                  appendPathPoints(travelPath, returnPath);
                  appendPathPoints(travelPath, [pathHome]);
                  stepDx = -stepDx;
                  stepDy = -stepDy;
                  reversedAfterSlopeBounce = true;
                  continue;
                }

                if (travelPath.length > 1) {
                  appendPathPoints(travelPath, bouncePath.map((point) => ({ ...point })));
                  appendPathPoints(travelPath, returnPath);
                  appendPathPoints(travelPath, [pathHome]);
                } else if (!searchMode) {
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
                    path: [
                      pathHome,
                      ...bouncePath,
                      ...returnPath,
                      { ...pathHome }
                    ],
                    pathControlsElevation: true,
                    pathEndElevation: travelElevation,
                    iceSlide: true,
                    visualOnly: true
                  });
                }
              }
            }

            break;
          }

          if (blockingActor !== -1) {
            let didMoveBlockingActor = false;

            if (canAttemptInitialPush) {
              const attemptSnapshot = attemptSnapshotBuffer || cloneState(state);
              const occupiedSnapshot = occupiedSnapshotBuffer || new Set(occupied);
              const moveCount = moves.length;
              const pushBudget = countSupportingPlayers(state, player, stepDx, stepDy);
              const pushedActorMembers = pushActorMembers(state, actorToPush);
              const pushRidesSupport =
                supportActor !== -1 &&
                pushEntityKey(supportActor) === pushEntityKey(actorToPush);

              if (attemptSnapshotBuffer) {
                copyStateInto(attemptSnapshotBuffer, state);
              }

              if (occupiedSnapshotBuffer) {
                occupiedSnapshotBuffer.clear();
                occupied.forEach((key) => occupiedSnapshotBuffer.add(key));
              }

              const result = attemptPushActor(
                state,
                actorToPush,
                stepDx,
                stepDy,
                occupied,
                moves,
                pushBudget,
                new Set(),
                raisedPlayerGates,
                orangeButtonsPressed,
                new Set([player]),
                searchMode,
                {
                  predictedSupports: [
                    {
                      actorIndex: player,
                      x: moveTargetX,
                      y: moveTargetY,
                      elevation: moveTargetElevation
                    }
                  ]
                }
              );

              if (result !== null) {
                const ridingSupportMembers = pushRidesSupport
                  ? pushedSupportMembersUnderPlayer(attemptSnapshot, player, pushedActorMembers)
                  : new Set();
                const rideFollowPath =
                  ridingSupportMembers.size > 0
                    ? playerRidePathForPushedSupport(moves, moveCount, ridingSupportMembers)
                    : null;
                const canFollowPushedIcePath = isIce(
                  state,
                  nextX,
                  nextY,
                  travelElevation,
                  raisedPlayerGates,
                  orangeButtonsPressed
                );
                const followPath =
                  rideFollowPath ||
                  (canFollowPushedIcePath
                    ? playerFollowPathForPushedMove(
                        moves,
                        moveCount,
                        actorToPush,
                        stepDx,
                        stepDy
                      )
                    : null);
                const followTarget =
                  followPath && followPath.length > 1 ? followPath[followPath.length - 1] : null;
                pushedFollowPath = followPath && followPath.length > 1 ? followPath : null;
                pushedFollowTargetX = followTarget?.x ?? moveTargetX;
                pushedFollowTargetY = followTarget?.y ?? moveTargetY;
                pushedFollowTargetElevation = followTarget?.elevation ?? moveTargetElevation;
                const ignoredPostPushSupports = new Set([player, ...pushedActorMembers]);
                ridingSupportMembers.forEach((member) => ignoredPostPushSupports.delete(member));
                if (pushedFollowPath) {
                  const followTargetBlocked =
                    blockingActorAtElevation(
                      state,
                      pushedFollowTargetX,
                      pushedFollowTargetY,
                      pushedFollowTargetElevation,
                      player
                    ) !== -1;
                  const followCanEnterHole =
                    pushedFollowTargetElevation === 0 &&
                    isHole(state, pushedFollowTargetX, pushedFollowTargetY, 0);
                  const followCanStand =
                    !followTargetBlocked &&
                    canPlayerStandAtElevation(
                      state,
                      pushedFollowTargetX,
                      pushedFollowTargetY,
                      pushedFollowTargetElevation,
                      raisedPlayerGates,
                      orangeButtonsPressed,
                      ignoredPostPushSupports
                    );

                  if (followTargetBlocked || (!followCanEnterHole && !followCanStand)) {
                    pushedFollowPath = null;
                    pushedFollowTargetX = moveTargetX;
                    pushedFollowTargetY = moveTargetY;
                    pushedFollowTargetElevation = moveTargetElevation;
                  }
                }
                const postPushCanEnterHole =
                  pushedFollowTargetElevation === 0 &&
                  isHole(state, pushedFollowTargetX, pushedFollowTargetY, 0);
                const targetBlockedAfterPush =
                  blockingActorAtElevation(
                    state,
                    pushedFollowTargetX,
                    pushedFollowTargetY,
                    pushedFollowTargetElevation,
                    player
                  ) !== -1;
                const canStandAtTargetAfterPush =
                  !targetBlockedAfterPush &&
                  canPlayerStandAtElevation(
                    state,
                    pushedFollowTargetX,
                    pushedFollowTargetY,
                    pushedFollowTargetElevation,
                    raisedPlayerGates,
                    orangeButtonsPressed,
                    ignoredPostPushSupports
                );
                const postPushSlipLanding =
                  !targetBlockedAfterPush && !postPushCanEnterHole && !canStandAtTargetAfterPush
                    ? playerIceSlipLanding(
                        state,
                        player,
                        nextX,
                        nextY,
                        pushedFollowTargetX,
                        pushedFollowTargetY,
                        pushedFollowTargetElevation,
                        occupied,
                        raisedPlayerGates,
                        orangeButtonsPressed
                      )
                    : null;
                const canOccupyTargetAfterPush =
                  !targetBlockedAfterPush &&
                  (postPushCanEnterHole || canStandAtTargetAfterPush || postPushSlipLanding !== null);

                if (canOccupyTargetAfterPush) {
                  if (postPushSlipLanding) {
                    slipLanding = postPushSlipLanding;
                    canSlipOffIce = true;
                  }
                  didMoveBlockingActor = true;
                } else {
                  copyStateInto(state, attemptSnapshot);
                  occupied.clear();
                  occupiedSnapshot.forEach((key) => occupied.add(key));
                  moves.length = moveCount;
                }
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

          nextX = pushedFollowTargetX;
          nextY = pushedFollowTargetY;
          travelElevation = pushedFollowTargetElevation;

          if (pushedFollowPath) {
            appendPathPoints(travelPath, pushedFollowPath.slice(1));
          } else if (canTraverseSlope) {
            travelPath.push(...slopeTraversal.path);
            if (slopeTraversal.levelExit === true) {
              if (canExitLevel) {
                levelExit = {
                  dx: slopeTraversal.levelExitDx,
                  dy: slopeTraversal.levelExitDy,
                  elevation: slopeTraversal.levelExitElevation,
                  sourceType: slopeTraversal.levelExitSourceType
                };
              } else {
                stopAfterStartSlope = true;
              }
            }
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

          if (levelExit) {
            break;
          }

          if (!isIce(state, nextX, nextY, travelElevation, raisedPlayerGates, orangeButtonsPressed)) {
            break;
          }
        }

        let occupiedElevation = fromElevation;

        if (continuePunchSlide && !levelExit) {
          const landingElevation = landingElevationAtLocation(
            state,
            nextX,
            nextY,
            travelElevation,
            occupied,
            raisedPlayerGates,
            orangeButtonsPressed,
            ignoredPlayerSet
          );

          if (landingElevation !== null && landingElevation !== travelElevation) {
            travelElevation = landingElevation;
            travelPath.push({
              x: nextX,
              y: nextY,
              elevation: travelElevation
            });
          }
        }

        if (nextX !== fromX || nextY !== fromY || travelElevation !== fromElevation || levelExit) {
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

          if (continuePunchSlide) {
            toElevation = travelElevation;
          } else if (playerLiftLayer) {
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
            const canStandAtTravelElevation = canPlayerStandAtElevation(
              state,
              nextX,
              nextY,
              travelElevation,
              raisedPlayerGates,
              orangeButtonsPressed,
              ignoredPlayerSet
            );

            if (isHole(state, nextX, nextY, travelElevation) && !canStandAtTravelElevation) {
              toElevation = travelElevation;
            } else {
              toElevation =
                playerSurfaceHeightAt(
                  state,
                  nextX,
                  nextY,
                  raisedPlayerGates,
                  orangeButtonsPressed,
                  travelElevation,
                  ignoredPlayerSet
                ) ?? travelElevation;
            }
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
            moveRecord.iceSlide =
              continuePunchSlide ||
              travelDistance > 1 ||
              iceSlipLanding !== null ||
              travelPath.length > 2 ||
              pathControlsElevation;

            if (continuePunchSlide) {
              moveRecord.punchSlide = true;
            }

            if (levelExit) {
              moveRecord.levelExit = true;
              moveRecord.levelExitDx = levelExit.dx;
              moveRecord.levelExitDy = levelExit.dy;
              moveRecord.levelExitElevation = levelExit.elevation;
              moveRecord.levelExitSourceType = levelExit.sourceType;
            }

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
        } else if (!searchMode && travelPath.length > 1) {
          const pathEndElevation = travelPath[travelPath.length - 1]?.elevation ?? fromElevation;

          moves.push({
            actorIndex: player,
            actorType: actorTypes[player],
            fromX,
            fromY,
            toX: fromX,
            toY: fromY,
            finalX: fromX,
            finalY: fromY,
            fromElevation,
            toElevation: fromElevation,
            finalElevation: fromElevation,
            path: travelPath,
            pathControlsElevation: travelPath.some((point) => point.elevation !== fromElevation),
            pathEndElevation,
            iceSlide: true,
            visualOnly: true
          });
        }

        addOccupiedAtElevation(
          occupied,
          state.actorX[player],
          state.actorY[player],
          occupiedElevation
        );
      });

      if (moves.length > 0) {
        collapseSequentialActorMoves(moves);
        let movedPuncherCandidates = syncAttachedPunchersForMoves(
          state,
          moves,
          originalActorX,
          originalActorY,
          originalActorElevation,
          searchMode
        );

        applyPunchers(
          state,
          moves,
          originalActorX,
          originalActorY,
          originalActorElevation,
          searchMode,
          movedPuncherCandidates.size > 0
            ? {
                candidateActorIndexes: movedPuncherCandidates,
                includeUnpunchedMovedActors: true,
                sequenceBase: nextPunchSequence(moves)
              }
            : {}
        );
        movedPuncherCandidates = syncAttachedPunchersForMoves(
          state,
          moves,
          originalActorX,
          originalActorY,
          originalActorElevation,
          searchMode
        );
        let stickyPuncherPassCount = 0;

        while (
          movedPuncherCandidates.size > 0 &&
          stickyPuncherPassCount < actorCount + width + height
        ) {
          stickyPuncherPassCount += 1;
          applyPunchers(
            state,
            moves,
            originalActorX,
            originalActorY,
            originalActorElevation,
            searchMode,
            {
              candidateActorIndexes: movedPuncherCandidates,
              includeUnpunchedMovedActors: true,
              sequenceBase: nextPunchSequence(moves)
            }
          );
          movedPuncherCandidates = syncAttachedPunchersForMoves(
            state,
            moves,
            originalActorX,
            originalActorY,
            originalActorElevation,
            searchMode
          );
        }
        collapseSequentialActorMoves(moves);
        applyHoleFalls(state, moves);
        pendingLiftToggles.forEach(({ x, y, raised }) => {
          setPlayerLiftRaised(state, x, y, raised);
        });
        applyMoveFinalState(state, moves);
        syncDynamicActorElevationsAndFalls(state, moves, raisedPlayerGates, orangeButtonsPressed);
        syncAttachedPunchersForMoves(
          state,
          moves,
          originalActorX,
          originalActorY,
          originalActorElevation,
          searchMode
        );
        syncAttachedSurfaceAttachmentsForMoves(
          state,
          moves,
          originalActorX,
          originalActorY,
          originalActorElevation,
          searchMode
        );
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
          moveRecord.actorType === "orange_button" ||
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
            Number.isInteger(moveRecord.fillHolePreviousTerrain)
              ? moveRecord.fillHolePreviousTerrain
              : terrainTypes.empty;
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
      let best = Infinity;
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

          best = Math.min(
            best,
            Math.abs(state.actorX[player] - state.actorX[gem]) +
              Math.abs(state.actorY[player] - state.actorY[gem]) +
              Math.abs(actorElevation(state, player) - actorElevation(state, gem))
          );
        }
      }

      return hasPlayer && hasGem && Number.isFinite(best) ? best : 0;
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
      computeRaisedPlayerGateSet,
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
