(function () {
  const modules = window.AuthorPlayData || (window.AuthorPlayData = {});
  const actorNames = new Set([
    "player",
    "circle_player",
    "box",
    "gem",
    "floating_floor",
    "weightless_box"
  ]);
  const supportActorNames = new Set([
    "player",
    "circle_player",
    "box",
    "floating_floor",
    "weightless_box"
  ]);
  const raisedTerrainNames = new Set(["wall", "orange_wall"]);

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
    const defaultFloorToken = authorData?.defaultFloorToken || ".";
    const palette = Array.isArray(authorData?.palette) ? authorData.palette : [];
    const toolByToken = new Map(palette.map((tool) => [tool.token, tool]));
    const toolByName = new Map(palette.map((tool) => [tool.name, tool]));

    function toolType(tool) {
      return tool?.type || tool?.name;
    }

    function normalizeCellValue(value) {
      const trimmedValue = String(value ?? "").trim();

      if (!trimmedValue) {
        return defaultFloorToken;
      }

      const tokens = trimmedValue.split(blockAdder).map((token) => token.trim());

      if (tokens.length === 0 || tokens.every((token) => token.length === 0)) {
        return defaultFloorToken;
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
        .map((token) => token.trim());
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

    function cellStackMetadata(tokens) {
      const entries = [];
      let surfaceHeight = null;
      let previousSurfaceTerrain = false;

      tokens.forEach((token, index) => {
        if (token.length === 0) {
          const elevation = Math.max(0, surfaceHeight ?? 0);
          entries.push({ elevation, index, isAir: true, token });
          surfaceHeight = elevation + 1;
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

          if (isSupportActorTool(tool)) {
            surfaceHeight = elevation + 1;
            previousSurfaceTerrain = false;
          }

          return;
        }

        const isRaisedTerrain = isRaisedTerrainTool(tool);
        let elevation = Math.max(0, surfaceHeight ?? 0);

        if (!isRaisedTerrain && previousSurfaceTerrain && surfaceHeight !== null) {
          elevation = surfaceHeight + 1;
        }

        entries.push({ elevation, index, isAir: false, token, tool });
        surfaceHeight = elevation + (isRaisedTerrain ? 1 : 0);
        previousSurfaceTerrain = !isRaisedTerrain;
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
        ? isSupportActorTool(entry.tool)
        : isRaisedTerrainTool(entry.tool);
    }

    function trimTrailingAirTokens(tokens) {
      while (tokens.length > 0 && String(tokens[tokens.length - 1] || "").trim().length === 0) {
        tokens.pop();
      }

      return tokens;
    }

    function getCellDescriptor(value) {
      const tokens = getCellTokens(value);
      const topToken = tokens.slice().reverse().find((token) => token.length > 0) || defaultFloorToken;
      const tool = toolByToken.get(topToken) || toolByToken.get(tokens[0]) || null;

      return {
        label: tool ? tool.label : topToken,
        tool,
        topToken,
        tokens
      };
    }

    function isActorTool(tool) {
      return actorNames.has(toolType(tool));
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

    function buildTerrainCell(type, tool = null, options = {}) {
      return {
        type,
        label: tool?.label || titleCaseName(type),
        imageUrl: tool?.imageUrl || null,
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

      entries.forEach((entry) => {
        if (entry?.isAir) {
          surfaceHeight = Math.max(0, surfaceHeight ?? 0) + 1;
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

          if (isSupportActorTool(tool)) {
            surfaceHeight = elevation + 1;
            previousSurfaceTerrain = false;
          }

          return;
        }

        const terrainType = toolType(tool);
        const isRaisedTerrain = isRaisedTerrainTool(tool);
        let elevation = Math.max(0, surfaceHeight ?? 0);

        if (!isRaisedTerrain && previousSurfaceTerrain && surfaceHeight !== null) {
          elevation = surfaceHeight + 1;
        }

        terrainLayers.push(buildTerrainLayer(tool, elevation));
        surfaceHeight = elevation + (isRaisedTerrain ? 1 : 0);
        previousSurfaceTerrain = !isRaisedTerrain;
      });

      const wallLayer = terrainLayers.find((layer) => layer.type === "wall") || null;
      const exitLayer = terrainLayers.find((layer) => layer.type === "exit") || null;
      const topLayer =
        terrainLayers.length > 0
          ? terrainLayers.reduce((highest, layer) =>
              layer.elevation >= highest.elevation ? layer : highest
            )
          : null;
      const terrainLayer = wallLayer || exitLayer || topLayer || null;
      const terrainLayerTool = terrainLayer || null;
      const layers = terrainLayers.map((layer) => ({ ...layer }));

      if (wallLayer) {
        const underlayLayer = terrainLayers.find((layer) => layer.type !== "wall") || null;
        const underlayTool = underlayLayer || floorTool;

        return {
          actors,
          terrain: buildTerrainCell("wall", terrainLayerTool || wallLayer, {
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

      if (actors.length > 0) {
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
      const tokens = getCellTokens(currentValue);
      const elevation = Math.max(0, Math.floor(Number(targetElevation) || 0));
      let metadata = cellStackMetadata(tokens);
      const matchingEntry = metadata.entries.find((entry) => entry.elevation === elevation);

      if (matchingEntry) {
        tokens[matchingEntry.index] = normalizedToken;
        return normalizeCellValue(tokens.join(blockAdder));
      }

      while (metadata.nextElevation < elevation) {
        tokens.push("");
        metadata = cellStackMetadata(tokens);
      }

      tokens.push(normalizedToken);

      return normalizeCellValue(tokens.join(blockAdder));
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

      if (hasNonAirAbove && stackEntryCreatesElevationSlot(matchingEntry)) {
        tokens[matchingEntry.index] = "";
      } else {
        tokens.splice(matchingEntry.index, 1);
      }

      trimTrailingAirTokens(tokens);

      return normalizeCellValue(
        tokens.some((token) => token.length > 0)
          ? tokens.join(blockAdder)
          : defaultFloorToken
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
          const entries = getCellStackEntries(cells[y]?.[x] || defaultFloorToken);
          const cellStack = buildCellStack(entries);

          terrainRow.push(cellStack.terrain);
          cellStack.actors.forEach(({ tool, elevation }) => {
            if (!includeGems && tool.name === "gem") {
              return;
            }

            actors.push({
              type: toolType(tool),
              groupId: toolType(tool) === "weightless_box" ? tool.token : null,
              label: tool.label,
              imageUrl: tool.imageUrl || null,
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
        levelId: options.levelId || "__editor__",
        levelLabel: options.levelLabel || options.levelId || "__editor__",
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
      isActorTool,
      normalizeCellValue,
      setCellElevationToken,
      toolByName,
      toolByToken
    };
  }

  modules.createAdapter = createAdapter;
})();
