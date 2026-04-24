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

    function normalizeCellValue(value) {
      const trimmedValue = String(value ?? "").trim();

      if (!trimmedValue) {
        return defaultFloorToken;
      }

      const tokens = trimmedValue
        .split(blockAdder)
        .map((token) => token.trim())
        .filter(Boolean);

      if (tokens.length === 0) {
        return defaultFloorToken;
      }

      const invalidToken = tokens.find((token) => !toolByToken.has(token));

      if (invalidToken) {
        throw new Error('Unknown token "' + invalidToken + '".');
      }

      return tokens.join(blockAdder);
    }

    function getCellTokens(value) {
      return String(value || "")
        .split(blockAdder)
        .map((token) => token.trim())
        .filter(Boolean);
    }

    function getCellTools(value) {
      return getCellTokens(value)
        .map((token) => toolByToken.get(token))
        .filter(Boolean);
    }

    function getCellDescriptor(value) {
      const tokens = getCellTokens(value);
      const topToken = tokens[tokens.length - 1] || defaultFloorToken;
      const tool = toolByToken.get(topToken) || toolByToken.get(tokens[0]) || null;

      return {
        label: tool ? tool.label : topToken,
        tool,
        topToken,
        tokens
      };
    }

    function isActorTool(tool) {
      return actorNames.has(tool?.name);
    }

    function buildTerrainCell(type, tool = null, options = {}) {
      return {
        type,
        label: tool?.label || titleCaseName(type),
        imageUrl: tool?.imageUrl || null,
        underlay: options.underlay || null,
        raised: options.raised === true
      };
    }

    function buildCellState(tools) {
      const floorTool = toolByName.get("floor") || null;
      const exitTool = toolByName.get("exit") || null;
      const terrainTools = tools.filter((tool) => !isActorTool(tool));
      const wallTool = terrainTools.find((tool) => tool.name === "wall") || null;
      const exitCellTool = terrainTools.find((tool) => tool.name === "exit") || null;
      const terrainTool = wallTool || exitCellTool || terrainTools[0] || null;

      if (wallTool) {
        const underlayTool = terrainTools.find((tool) => tool.name !== "wall") || floorTool;

        return buildTerrainCell("wall", wallTool, {
          underlay: buildTerrainCell(underlayTool?.name || "floor", underlayTool)
        });
      }

      if (terrainTool?.name === "exit") {
        return buildTerrainCell("exit", exitTool || terrainTool);
      }

      if (terrainTool) {
        return buildTerrainCell(terrainTool.name, terrainTool, {
          raised: terrainTool.name === "player_lift" ? false : undefined
        });
      }

      if (tools.some((tool) => isActorTool(tool))) {
        return buildTerrainCell("floor", floorTool);
      }

      return buildTerrainCell("empty");
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
          const tools = getCellTools(cells[y]?.[x] || defaultFloorToken);

          terrainRow.push(buildCellState(tools));
          tools.forEach((tool) => {
            if (!isActorTool(tool)) {
              return;
            }

            if (!includeGems && tool.name === "gem") {
              return;
            }

            actors.push({
              type: tool.name,
              groupId: tool.name === "weightless_box" ? tool.token : null,
              label: tool.label,
              imageUrl: tool.imageUrl || null,
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
      getCellDescriptor,
      getCellTokens,
      getCellTools,
      isActorTool,
      normalizeCellValue,
      toolByName,
      toolByToken
    };
  }

  modules.createAdapter = createAdapter;
})();
