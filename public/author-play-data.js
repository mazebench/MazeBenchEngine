(function () {
  const modules = window.AuthorPlayData || (window.AuthorPlayData = {});
  const actorNames = new Set([
    "player",
    "circle_player",
    "clone",
    "box",
    "gem",
    "floating_floor",
    "orange_button",
    "puncher",
    "weightless_box"
  ]);
  const supportActorNames = new Set([
    "player",
    "circle_player",
    "clone",
    "box",
    "floating_floor",
    "weightless_box"
  ]);
  const raisedTerrainNames = new Set([
    "wall",
    "ice_block",
    "ice_slope",
    "tree",
    "shrub",
    "block_asset",
    "orange_wall"
  ]);
  const baseSurfaceNames = new Set(["floor", "ice"]);
  const surfaceAttachmentNames = new Set(["orange_button"]);

  function titleCaseName(name) {
    return String(name || "")
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function createAdapter(authorData) {
    const blockAdder =
      typeof authorData?.blockAdder === "string" && authorData.blockAdder.length > 0
        ? authorData.blockAdder
        : "+";
    const emptyCellToken = blockAdder;
    const defaultFloorToken = authorData?.defaultFloorToken || ".";
    const palette = Array.isArray(authorData?.palette) ? authorData.palette : [];
    const toolByToken = new Map(palette.map((tool) => [tool.token, tool]));
    const toolByName = new Map(palette.map((tool) => [tool.name, tool]));

    function toolType(tool) {
      return tool?.type || tool?.name;
    }

    function normalizeLegacyToken(token) {
      const trimmedToken = String(token ?? "").trim();
      return trimmedToken === "h" ? "" : trimmedToken;
    }

    function normalizeCellValue(value) {
      const trimmedValue = String(value ?? "").trim();

      if (!trimmedValue) {
        return emptyCellToken;
      }

      const tokens = trimmedValue.split(blockAdder).map(normalizeLegacyToken);

      if (tokens.length === 0 || tokens.every((token) => token.length === 0)) {
        return emptyCellToken;
      }

      const invalidToken = tokens.find((token) => token.length > 0 && !toolByToken.has(token));

      if (invalidToken) {
        throw new Error('Unknown token "' + invalidToken + '".');
      }

      return tokens.join(blockAdder);
    }

    function getCellTokens(value) {
      return String(value || "")
        .split(blockAdder)
        .map(normalizeLegacyToken);
    }

    function getCellTools(value) {
      return getCellTokens(value)
        .map((token) => toolByToken.get(token))
        .filter(Boolean);
    }

    function getCellStackEntries(value) {
      return getCellTokens(value)
        .map((token) => (token.length === 0 ? { isAir: true } : toolByToken.get(token)))
        .filter(Boolean);
    }

    // In maze level text, "+" is a layer separator. Even thin or non-blocking
    // tokens still reserve their written layer so later tokens stack above them.
    function actorToolLayerSlotHeight(tool) {
      return isActorTool(tool) ? 1 : 0;
    }

    function terrainToolLayerSlotHeight(tool) {
      if (isBaseSurfaceTool(tool)) {
        return 0;
      }

      return Math.max(1, terrainToolStackHeight(tool));
    }

    function cellStackMetadata(tokens) {
      const entries = [];
      let surfaceHeight = null;
      let previousSurfaceTerrain = false;
      let consumedBaseVoid = false;

      tokens.forEach((token, index) => {
        if (token.length === 0) {
          if (surfaceHeight === null && !consumedBaseVoid) {
            entries.push({ elevation: 0, index, isAir: true, isBaseVoid: true, token });
            consumedBaseVoid = true;
            previousSurfaceTerrain = false;
            return;
          }

          const elevation = Math.max(0, surfaceHeight ?? 0);
          entries.push({ elevation, index, isAir: true, token });
          surfaceHeight = elevation + 1;
          consumedBaseVoid = true;
          previousSurfaceTerrain = false;
          return;
        }

        const tool = toolByToken.get(token);

        if (!tool) {
          return;
        }

        if (isActorTool(tool)) {
          const elevation = Math.max(0, surfaceHeight ?? 0);
          entries.push({ elevation, index, isAir: false, token, tool });

          surfaceHeight = elevation + actorToolLayerSlotHeight(tool);
          previousSurfaceTerrain = false;

          return;
        }

        const isRaisedTerrain = isRaisedTerrainTool(tool);
        const isBaseSurface = isBaseSurfaceTool(tool);
        const stackHeight = terrainToolLayerSlotHeight(tool);
        let elevation = Math.max(0, surfaceHeight ?? 0);

        if (isBaseSurface && !isRaisedTerrain && previousSurfaceTerrain && surfaceHeight !== null) {
          elevation = surfaceHeight + 1;
        }

        entries.push({ elevation, index, isAir: false, token, tool });
        surfaceHeight = elevation + stackHeight;
        previousSurfaceTerrain = isBaseSurface;
      });

      return {
        entries,
        nextElevation: Math.max(0, surfaceHeight ?? 0)
      };
    }

    function stackEntryCreatesElevationSlot(entry) {
      if (!entry || entry.isAir || !entry.tool) {
        return false;
      }

      return isActorTool(entry.tool)
        ? actorToolLayerSlotHeight(entry.tool) > 0
        : terrainToolLayerSlotHeight(entry.tool) > 0;
    }

    function trimTrailingAirTokens(tokens) {
      while (tokens.length > 0 && String(tokens[tokens.length - 1] || "").trim().length === 0) {
        tokens.pop();
      }

      return tokens;
    }

    function isAirToken(token) {
      return String(token || "").trim().length === 0;
    }

    function isBaseSurfaceToken(token) {
      return isBaseSurfaceTool(toolByToken.get(String(token || "").trim()));
    }

    function normalizeTokenRows(tokens) {
      const trimmedTokens = trimTrailingAirTokens(tokens.slice());

      return normalizeCellValue(
        trimmedTokens.some((token) => !isAirToken(token))
          ? trimmedTokens.join(blockAdder)
          : emptyCellToken
      );
    }

    function enforceBottomSurfaceRows(tokens) {
      const rows = tokens.map((token) => String(token || "").trim());
      let bottomSurfaceToken = null;

      for (let index = 0; index < rows.length; index += 1) {
        if (!isBaseSurfaceToken(rows[index])) {
          continue;
        }

        bottomSurfaceToken = rows[index];
        rows[index] = "";
      }

      if (bottomSurfaceToken !== null) {
        if (isAirToken(rows[0])) {
          rows[0] = bottomSurfaceToken;
        } else {
          rows.unshift(bottomSurfaceToken);
        }
      }

      return trimTrailingAirTokens(rows);
    }

    function normalizeAuthoringCellValue(value) {
      return normalizeTokenRows(enforceBottomSurfaceRows(getCellTokens(normalizeCellValue(value))));
    }

    function setBottomSurfaceToken(currentValue, token) {
      const normalizedToken = normalizeCellValue(token);

      if (!isBaseSurfaceToken(normalizedToken)) {
        return normalizeAuthoringCellValue(currentValue);
      }

      const tokens = enforceBottomSurfaceRows(getCellTokens(currentValue));

      if (tokens.length === 0) {
        tokens.push(normalizedToken);
      } else if (isAirToken(tokens[0])) {
        tokens[0] = normalizedToken;
      } else if (isBaseSurfaceToken(tokens[0])) {
        tokens[0] = normalizedToken;
      } else {
        tokens.unshift(normalizedToken);
      }

      return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
    }

    function setAboveBottomRowToken(currentValue, token) {
      const normalizedToken = normalizeCellValue(token);

      if (isBaseSurfaceToken(normalizedToken)) {
        return setBottomSurfaceToken(currentValue, normalizedToken);
      }

      const tokens = enforceBottomSurfaceRows(getCellTokens(currentValue));

      if (tokens.length === 0 || isAirToken(tokens[0])) {
        tokens[0] = normalizedToken;
        return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
      }

      if (isBaseSurfaceToken(tokens[0])) {
        while (tokens.length < 2) {
          tokens.push("");
        }

        tokens[1] = normalizedToken;
      } else {
        tokens[0] = normalizedToken;
      }

      return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
    }

    function appendCellToken(currentValue, token) {
      const normalizedToken = normalizeCellValue(token);

      if (isBaseSurfaceToken(normalizedToken)) {
        return setBottomSurfaceToken(currentValue, normalizedToken);
      }

      const tokens = enforceBottomSurfaceRows(getCellTokens(currentValue));

      tokens.push(normalizedToken);

      return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
    }

    function getCellDescriptor(value) {
      const tokens = getCellTokens(value);
      const topToken = tokens.slice().reverse().find((token) => token.length > 0) || "";
      const tool = toolByToken.get(topToken) || toolByToken.get(tokens[0]) || null;

      return {
        label: tool ? tool.label : topToken || "Empty",
        tool,
        topToken,
        tokens
      };
    }

    function isActorTool(tool) {
      return actorNames.has(toolType(tool));
    }

    function isSurfaceAttachmentTool(tool) {
      return surfaceAttachmentNames.has(toolType(tool));
    }

    function isSupportActorTool(tool) {
      return supportActorNames.has(toolType(tool));
    }

    function isRaisedTerrainTool(tool) {
      const type = toolType(tool);

      return (
        raisedTerrainNames.has(type) ||
        (type === "player_lift" && tool?.initialRaised === true)
      );
    }

    function terrainToolStackHeight(tool) {
      return toolType(tool) === "tree" ? 3 : isRaisedTerrainTool(tool) ? 1 : 0;
    }

    function isBaseSurfaceTool(tool) {
      return baseSurfaceNames.has(toolType(tool));
    }

    function isAttachableSurfaceTool(tool) {
      if (!tool || isSurfaceAttachmentTool(tool)) {
        return false;
      }

      if (toolType(tool) === "ice_slope") {
        return false;
      }

      return isActorTool(tool) ? isSupportActorTool(tool) : true;
    }

    function setSurfaceAttachmentToken(currentValue, token, targetElevation) {
      const normalizedToken = normalizeCellValue(token);
      const attachmentTool = toolByToken.get(normalizedToken);

      if (!isSurfaceAttachmentTool(attachmentTool)) {
        return normalizeAuthoringCellValue(currentValue);
      }

      const elevation = Math.max(0, Math.floor(Number(targetElevation) || 0));
      const tokens = enforceBottomSurfaceRows(getCellTokens(currentValue));
      let surfaceHeight = null;
      let previousSurfaceTerrain = false;
      let insertionIndex = -1;

      for (let index = 0; index < tokens.length; index += 1) {
        const currentToken = String(tokens[index] || "").trim();

        if (currentToken.length === 0) {
          surfaceHeight = Math.max(0, surfaceHeight ?? 0) + 1;
          previousSurfaceTerrain = false;
          continue;
        }

        const tool = toolByToken.get(currentToken);

        if (!tool) {
          continue;
        }

        if (isActorTool(tool)) {
          const actorElevation = Math.max(0, surfaceHeight ?? 0);

          if (isSurfaceAttachmentTool(tool) && actorElevation === elevation) {
            tokens[index] = normalizedToken;
            return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
          }

          if (isSupportActorTool(tool)) {
            const supportHeight = actorElevation + 1;

            if (supportHeight === elevation && isAttachableSurfaceTool(tool)) {
              insertionIndex = index + 1;
            }

            surfaceHeight = supportHeight;
            previousSurfaceTerrain = false;
          }

          surfaceHeight = Math.max(
            surfaceHeight ?? actorElevation,
            actorElevation + actorToolLayerSlotHeight(tool)
          );
          previousSurfaceTerrain = false;

          continue;
        }

        const isRaisedTerrain = isRaisedTerrainTool(tool);
        const isBaseSurface = isBaseSurfaceTool(tool);
        const stackHeight = terrainToolLayerSlotHeight(tool);
        let terrainElevation = Math.max(0, surfaceHeight ?? 0);

        if (isBaseSurface && !isRaisedTerrain && previousSurfaceTerrain && surfaceHeight !== null) {
          terrainElevation = surfaceHeight + 1;
        }

        const supportHeight = terrainElevation + stackHeight;

        if (supportHeight === elevation && isAttachableSurfaceTool(tool)) {
          insertionIndex = index + 1;
        }

        surfaceHeight = supportHeight;
        previousSurfaceTerrain = isBaseSurface;
      }

      if (insertionIndex === -1) {
        return normalizeAuthoringCellValue(currentValue);
      }

      tokens.splice(insertionIndex, 0, normalizedToken);
      return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
    }

    function buildTerrainCell(type, tool = null, options = {}) {
      return {
        type,
        direction: tool?.direction || null,
        label: tool?.label || titleCaseName(type),
        imageUrl: tool?.imageUrl || null,
        modelUrl: tool?.modelUrl || null,
        layers: Array.isArray(options.layers) ? options.layers : null,
        underlay: options.underlay || null,
        raised: options.raised === true
      };
    }

    function buildTerrainLayer(tool, elevation) {
      const type = toolType(tool);

      return {
        type,
        label: tool?.label || titleCaseName(type),
        imageUrl: tool?.imageUrl || null,
        modelUrl: tool?.modelUrl || null,
        direction: tool?.direction || null,
        elevation,
        raised: type === "player_lift" ? tool?.initialRaised === true : false
      };
    }

    function buildCellStack(entries) {
      const floorTool = toolByName.get("floor") || null;
      const exitTool = toolByName.get("exit") || null;
      const terrainLayers = [];
      const actors = [];
      let surfaceHeight = null;
      let previousSurfaceTerrain = false;
      let hasAirEntry = false;
      let consumedBaseVoid = false;

      entries.forEach((entry) => {
        if (entry?.isAir) {
          hasAirEntry = true;

          if (surfaceHeight === null && !consumedBaseVoid) {
            consumedBaseVoid = true;
            previousSurfaceTerrain = false;
            return;
          }

          surfaceHeight = Math.max(0, surfaceHeight ?? 0) + 1;
          consumedBaseVoid = true;
          previousSurfaceTerrain = false;
          return;
        }

        const tool = entry;

        if (isActorTool(tool)) {
          const elevation = Math.max(0, surfaceHeight ?? 0);

          actors.push({
            elevation,
            tool
          });

          surfaceHeight = elevation + actorToolLayerSlotHeight(tool);
          previousSurfaceTerrain = false;

          return;
        }

        const isRaisedTerrain = isRaisedTerrainTool(tool);
        const isBaseSurface = isBaseSurfaceTool(tool);
        const stackHeight = terrainToolLayerSlotHeight(tool);
        let elevation = Math.max(0, surfaceHeight ?? 0);

        if (isBaseSurface && !isRaisedTerrain && previousSurfaceTerrain && surfaceHeight !== null) {
          elevation = surfaceHeight + 1;
        }

        terrainLayers.push(buildTerrainLayer(tool, elevation));
        surfaceHeight = elevation + stackHeight;
        previousSurfaceTerrain = isBaseSurface;
      });

      const wallLayer = terrainLayers.find((layer) => layer.type === "wall") || null;
      const iceBlockLayer = terrainLayers.find((layer) => layer.type === "ice_block") || null;
      const iceSlopeLayer = terrainLayers.find((layer) => layer.type === "ice_slope") || null;
      const treeLayer = terrainLayers.find((layer) => layer.type === "tree") || null;
      const shrubLayer = terrainLayers.find((layer) => layer.type === "shrub") || null;
      const blockAssetLayer = terrainLayers.find((layer) => layer.type === "block_asset") || null;
      const raisedBlockLayer =
        wallLayer || iceBlockLayer || iceSlopeLayer || treeLayer || shrubLayer || blockAssetLayer;
      const exitLayer = terrainLayers.find((layer) => layer.type === "exit") || null;
      const topLayer =
        terrainLayers.length > 0
          ? terrainLayers.reduce((highest, layer) =>
              layer.elevation >= highest.elevation ? layer : highest
            )
          : null;
      const terrainLayer = raisedBlockLayer || exitLayer || topLayer || null;
      const terrainLayerTool = terrainLayer || null;
      const layers = terrainLayers.map((layer) => ({ ...layer }));

      if (raisedBlockLayer) {
        const underlayLayer =
          terrainLayers.find((layer) => layer.type !== raisedBlockLayer.type) || null;
        const underlayTool = underlayLayer || floorTool;

        return {
          actors,
          terrain: buildTerrainCell(raisedBlockLayer.type, raisedBlockLayer, {
            layers,
            underlay: buildTerrainCell(
              underlayLayer?.type || toolType(underlayTool) || "floor",
              underlayTool
            )
          })
        };
      }

      if (terrainLayer?.type === "exit") {
        return {
          actors,
          terrain: buildTerrainCell("exit", exitTool || terrainLayerTool || terrainLayer, {
            layers
          })
        };
      }

      if (terrainLayer) {
        const terrainType = terrainLayer.type;
        const tool = terrainLayerTool || terrainLayer;

        return {
          actors,
          terrain: buildTerrainCell(terrainType, tool, {
            layers,
            raised: terrainType === "player_lift" ? terrainLayer.raised === true : undefined
          })
        };
      }

      if (!hasAirEntry && actors.some(({ tool }) => !isSurfaceAttachmentTool(tool))) {
        return {
          actors,
          terrain: buildTerrainCell("floor", floorTool, {
            layers: [buildTerrainLayer(floorTool || { name: "floor", type: "floor" }, 0)]
          })
        };
      }

      return {
        actors,
        terrain: buildTerrainCell("empty", null, { layers: [] })
      };
    }

    function buildCellState(tools) {
      return buildCellStack(tools).terrain;
    }

    function setCellElevationToken(currentValue, token, targetElevation) {
      const normalizedToken = normalizeCellValue(token);
      const elevation = Math.max(0, Math.floor(Number(targetElevation) || 0));
      const tool = toolByToken.get(normalizedToken);
      const tokens = enforceBottomSurfaceRows(getCellTokens(currentValue));

      if (isBaseSurfaceTool(tool)) {
        return setBottomSurfaceToken(currentValue, normalizedToken);
      }

      if (elevation === 0) {
        return setAboveBottomRowToken(currentValue, normalizedToken);
      }

      let metadata = cellStackMetadata(tokens);
      const sameElevationEntries = metadata.entries.filter((entry) => entry.elevation === elevation);
      const matchingEntry = sameElevationEntries[0];

      if (matchingEntry) {
        tokens[matchingEntry.index] = normalizedToken;
        trimTrailingAirTokens(tokens);
        return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
      }

      while (metadata.nextElevation < elevation) {
        tokens.push("");
        metadata = cellStackMetadata(tokens);
      }

      tokens.push(normalizedToken);

      return normalizeTokenRows(enforceBottomSurfaceRows(tokens));
    }

    function eraseCellElevationValue(currentValue, targetElevation) {
      const tokens = getCellTokens(currentValue);
      const elevation = Math.max(0, Math.floor(Number(targetElevation) || 0));
      const metadata = cellStackMetadata(tokens);
      const matchingEntry = metadata.entries
        .slice()
        .reverse()
        .find((entry) => !entry.isAir && entry.elevation === elevation);

      if (!matchingEntry) {
        return normalizeCellValue(currentValue);
      }

      const hasNonAirAbove = metadata.entries.some(
        (entry) => !entry.isAir && entry.index > matchingEntry.index
      );

      if (
        hasNonAirAbove &&
        (stackEntryCreatesElevationSlot(matchingEntry) || isBaseSurfaceTool(matchingEntry.tool))
      ) {
        tokens[matchingEntry.index] = "";
      } else {
        tokens.splice(matchingEntry.index, 1);
      }

      trimTrailingAirTokens(tokens);

      return normalizeCellValue(
        tokens.some((token) => token.length > 0)
          ? tokens.join(blockAdder)
          : emptyCellToken
      );
    }

    function buildPlayData(options = {}) {
      const includeGems = options.includeGems !== false;
      const width = Math.max(1, Number(options.width) || 1);
      const height = Math.max(1, Number(options.height) || 1);
      const cells = Array.isArray(options.cells) ? options.cells : [];
      const terrain = [];
      const actors = [];

      for (let y = 0; y < height; y += 1) {
        const terrainRow = [];

        for (let x = 0; x < width; x += 1) {
          const entries = getCellStackEntries(cells[y]?.[x] ?? defaultFloorToken);
          const cellStack = buildCellStack(entries);

          terrainRow.push(cellStack.terrain);
          cellStack.actors.forEach(({ tool, elevation }) => {
            if (!includeGems && tool.name === "gem") {
              return;
            }

            actors.push({
              type: toolType(tool),
              groupId:
                toolType(tool) === "weightless_box" || toolType(tool) === "clone"
                  ? tool.token
                  : null,
              label: tool.label,
              imageUrl: tool.imageUrl || null,
              modelUrl: tool.modelUrl || null,
              direction: tool.direction || null,
              elevation,
              x,
              y
            });
          });
        }

        terrain.push(terrainRow);
      }

      return {
        gameId: options.gameId || authorData?.game?.id || "maze",
        playApiBaseUrl: options.playApiBaseUrl || authorData?.playApiBaseUrl || "",
        levelId: options.levelId || "__editor__",
        levelLabel: options.levelLabel || options.levelId || "__editor__",
        editorRender: options.editorRender === true,
        sourceFileName: options.sourceFileName || "",
        width,
        height,
        terrain,
        actors,
        cameraView: options.cameraView || null,
        worldColumns: options.worldColumns || null,
        worldRows: options.worldRows || null
      };
    }

    return {
      actorNames,
      buildCellState,
      buildPlayData,
      eraseCellElevationValue,
      getCellDescriptor,
      getCellTokens,
      getCellTools,
      appendCellToken,
      isActorTool,
      normalizeAuthoringCellValue,
      normalizeCellValue,
      setCellElevationToken,
      setSurfaceAttachmentToken,
      toolByName,
      toolByToken
    };
  }

  modules.createAdapter = createAdapter;
})();
