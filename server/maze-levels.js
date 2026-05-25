const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAZE_LEVEL_FILE_GUID_LENGTH = 10;
const MAZE_LEVEL_FILE_GUID_PATTERN = new RegExp(`^[a-z0-9]{${MAZE_LEVEL_FILE_GUID_LENGTH}}\\.txt$`);

function createMazeLevelService({
  buildGameAssetUrl,
  buildMazeFallbackLevelFileName,
  buildMazePreviewData,
  buildMazeWorldLevel,
  buildMazeWorldMapState,
  defaultLevelIdForGame,
  gamesDir,
  isMazeWorldLevelId,
  listTopLevelFiles,
  loadJson,
  loadText,
  mazeAuthorDefaultHeight,
  mazeAuthorDefaultWidth,
  mazeDefaultLevelId,
  mazeLevelGridHeight,
  mazeLevelGridWidth,
  mazeLevelLabel,
  mazeWorldConfig,
  resolveGameAssetPath,
  rootDir,
  titleCase
}) {
  function normalizeMazeGuidFileName(fileName) {
    const trimmed = typeof fileName === "string" ? fileName.trim().toLowerCase() : "";
    return MAZE_LEVEL_FILE_GUID_PATTERN.test(trimmed) ? trimmed : "";
  }

  function generateMazeLevelGuid(length = MAZE_LEVEL_FILE_GUID_LENGTH) {
    let guid = "";

    while (guid.length < length) {
      guid += crypto
        .randomBytes(length)
        .toString("base64url")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase();
    }

    return guid.slice(0, length);
  }

  function generateMazeLevelFileName(existingFileNames = []) {
    const takenFileNames =
      existingFileNames instanceof Set ? existingFileNames : new Set(existingFileNames);
    let fileName = "";

    do {
      fileName = `${generateMazeLevelGuid()}.txt`;
    } while (takenFileNames.has(fileName));

    return fileName;
  }

  function chooseMazeEditableFileName(game, levelId, preferredFileName = "") {
    const existingLevel = game?.worldMap?.byPosition?.get(levelId) || null;

    if (existingLevel) {
      return existingLevel.fileName;
    }

    const existingFileNames = new Set(Array.isArray(game?.levelFiles) ? game.levelFiles : []);
    const normalizedPreferred = normalizeMazeGuidFileName(preferredFileName);

    if (normalizedPreferred && !existingFileNames.has(normalizedPreferred)) {
      return normalizedPreferred;
    }

    return generateMazeLevelFileName(existingFileNames);
  }

  function clampMazeLevelDimension(value, max, fallback) {
    const numericValue = Number(value);

    if (!Number.isInteger(numericValue)) {
      return fallback;
    }

    return Math.max(1, Math.min(max, numericValue));
  }

  function clampMazeLevelWidth(value, fallback = mazeAuthorDefaultWidth) {
    return clampMazeLevelDimension(value, mazeLevelGridWidth, fallback);
  }

  function clampMazeLevelHeight(value, fallback = mazeAuthorDefaultHeight) {
    return clampMazeLevelDimension(value, mazeLevelGridHeight, fallback);
  }

  function parseLevelRows(rawLevel) {
    return rawLevel.split(/\r?\n/).filter((row) => row.length > 0);
  }

  function parseLevelCells(parser, row) {
    const separator = parser?.rules?.separator;

    if (typeof separator === "string" && separator.length > 0) {
      return row.split(separator);
    }

    return Array.from(row);
  }

  function parseCellStack(parser, cell) {
    const blockAdder = parser?.rules?.block_adder;

    if (typeof blockAdder === "string" && blockAdder.length > 0) {
      return String(cell)
        .split(blockAdder)
        .map(normalizeLegacyMazeToken);
    }

    return cell ? [normalizeLegacyMazeToken(cell)] : [];
  }

  function normalizeLegacyMazeToken(token) {
    const trimmedToken = String(token ?? "").trim();
    return trimmedToken === "h" ? "" : trimmedToken;
  }

  function getDefinitionTokens(config) {
    if (typeof config?.token === "string" && config.token.length > 0) {
      return [config.token];
    }

    if (Array.isArray(config?.tokens)) {
      return config.tokens
        .map((entry) => (typeof entry === "string" ? entry : entry?.token))
        .filter((token) => typeof token === "string" && token.length > 0);
    }

    return [];
  }

  function getDefinitionTokenEntries(config) {
    if (typeof config?.token === "string" && config.token.length > 0) {
      return [
        {
          initialRaised: config.initial_raised === true,
          direction: typeof config.direction === "string" ? config.direction : null,
          label: typeof config.label === "string" ? config.label : null,
          selectable: typeof config.selectable === "boolean" ? config.selectable : null,
          token: config.token
        }
      ];
    }

    if (!Array.isArray(config?.tokens)) {
      return [];
    }

    return config.tokens
      .map((entry) => {
        if (typeof entry === "string") {
          return {
            initialRaised: false,
            direction: null,
            label: null,
            selectable: null,
            token: entry
          };
        }

        return {
          initialRaised: entry?.initial_raised === true,
          direction: typeof entry?.direction === "string" ? entry.direction : null,
          label: typeof entry?.label === "string" ? entry.label : null,
          selectable: typeof entry?.selectable === "boolean" ? entry.selectable : null,
          token: entry?.token
        };
      })
      .filter((entry) => typeof entry.token === "string" && entry.token.length > 0);
  }

  function getObjectDefinitions(game) {
    const definitions = Object.entries(game.parser?.objects || {}).map(([name, config]) => {
      const relativeImagePath = typeof config?.image === "string" ? config.image : null;
      const assetPath = relativeImagePath ? resolveGameAssetPath(game.id, relativeImagePath) : null;
      const relativeModelPath = typeof config?.model === "string" ? config.model : null;
      const modelPath = relativeModelPath ? resolveGameAssetPath(game.id, relativeModelPath) : null;

      return {
        initialRaised: config?.initial_raised === true,
        name,
        tokens: getDefinitionTokens(config),
        tokenEntries: getDefinitionTokenEntries(config),
        imageUrl: assetPath ? buildGameAssetUrl(game.id, relativeImagePath) : null,
        modelUrl: modelPath ? buildGameAssetUrl(game.id, relativeModelPath) : null,
        label: typeof config?.label === "string" ? config.label : titleCase(name),
        type: typeof config?.type === "string" ? config.type : name
      };
    });

    return {
      byName: new Map(definitions.map((definition) => [definition.name, definition])),
      byToken: new Map(
        definitions
          .flatMap((definition) =>
            definition.tokenEntries.map((entry) => [
              entry.token,
              {
                ...definition,
                direction: entry.direction,
                initialRaised: definition.initialRaised || entry.initialRaised,
                label: entry.label || definition.label,
                selectable: entry.selectable,
                token: entry.token
              }
            ])
          )
      )
    };
  }

  function buildTerrainCell(type, definition = null, options = {}) {
    return {
      type,
      direction: definition?.direction || null,
      label: definition?.label || titleCase(type),
      imageUrl: definition?.imageUrl || null,
      modelUrl: definition?.modelUrl || null,
      layers: Array.isArray(options.layers) ? options.layers : null,
      underlay: options.underlay || null,
      raised: Boolean(options.raised)
    };
  }

  function definitionType(definition) {
    return definition?.type || definition?.name;
  }

  function isActorDefinition(definition) {
    const type = definitionType(definition);

    return (
      type === "player" ||
      type === "circle_player" ||
      type === "box" ||
      type === "gem" ||
      type === "floating_floor" ||
      type === "orange_button" ||
      type === "puncher" ||
      type === "weightless_box"
    );
  }

  function isSupportActorDefinition(definition) {
    const type = definitionType(definition);

    return (
      type === "player" ||
      type === "circle_player" ||
      type === "box" ||
      type === "floating_floor" ||
      type === "weightless_box"
    );
  }

  function isTerrainDefinition(definition) {
    return Boolean(definition) && !isActorDefinition(definition);
  }

  function isRaisedTerrainDefinition(definition) {
    const type = definitionType(definition);

    return (
      type === "wall" ||
      type === "ice_block" ||
      type === "ice_slope" ||
      type === "tree" ||
      type === "shrub" ||
      type === "block_asset" ||
      type === "orange_wall" ||
      (type === "player_lift" && definition?.initialRaised === true)
    );
  }

  function terrainDefinitionStackHeight(definition) {
    return definitionType(definition) === "tree" ? 3 : isRaisedTerrainDefinition(definition) ? 1 : 0;
  }

  function isSurfaceAttachmentDefinition(definition) {
    return definitionType(definition) === "orange_button";
  }

  function buildTerrainLayer(definition, elevation) {
    const type = definitionType(definition);

    return {
      type,
      label: definition?.label || titleCase(type),
      imageUrl: definition?.imageUrl || null,
      modelUrl: definition?.modelUrl || null,
      direction: definition?.direction || null,
      elevation,
      raised: type === "player_lift" ? definition?.initialRaised === true : false
    };
  }

  function buildCellStack(cellDefinitions, floorDefinition, exitDefinition) {
    const terrainLayers = [];
    const actors = [];
    let surfaceHeight = null;
    let previousSurfaceTerrain = false;

    cellDefinitions.forEach((definition) => {
      if (definition?.isAir) {
        surfaceHeight = Math.max(0, surfaceHeight ?? 0) + 1;
        previousSurfaceTerrain = false;
        return;
      }

      if (isActorDefinition(definition)) {
        const elevation = Math.max(0, surfaceHeight ?? 0);

        actors.push({
          definition,
          elevation
        });

        if (isSupportActorDefinition(definition)) {
          surfaceHeight = elevation + 1;
          previousSurfaceTerrain = false;
        }

        return;
      }

      if (!isTerrainDefinition(definition)) {
        return;
      }

      const isRaisedTerrain = isRaisedTerrainDefinition(definition);
      const stackHeight = terrainDefinitionStackHeight(definition);
      let elevation = Math.max(0, surfaceHeight ?? 0);

      if (!isRaisedTerrain && previousSurfaceTerrain && surfaceHeight !== null) {
        elevation = surfaceHeight + 1;
      }

      terrainLayers.push(buildTerrainLayer(definition, elevation));
      surfaceHeight = elevation + stackHeight;
      previousSurfaceTerrain = !isRaisedTerrain;
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
    const layers = terrainLayers.map((layer) => ({ ...layer }));

    if (raisedBlockLayer) {
      const underlayLayer =
        terrainLayers.find((layer) => layer.type !== raisedBlockLayer.type) || null;
      const underlayDefinition = underlayLayer || floorDefinition || null;

      return {
        actors,
        terrain: buildTerrainCell(raisedBlockLayer.type, raisedBlockLayer, {
          layers,
          underlay: buildTerrainCell(
            underlayLayer?.type || definitionType(underlayDefinition) || "floor",
            underlayDefinition
          )
        })
      };
    }

    if (terrainLayer?.type === "exit") {
      return {
        actors,
        terrain: buildTerrainCell("exit", exitDefinition || terrainLayer, {
          layers
        })
      };
    }

    if (terrainLayer) {
      return {
        actors,
        terrain: buildTerrainCell(terrainLayer.type, terrainLayer, {
          layers,
          raised: terrainLayer.type === "player_lift" ? terrainLayer.raised === true : undefined
        })
      };
    }

    if (actors.some(({ definition }) => !isSurfaceAttachmentDefinition(definition))) {
      return {
        actors,
        terrain: buildTerrainCell("floor", floorDefinition, {
          layers: [buildTerrainLayer(floorDefinition || { type: "floor", name: "floor" }, 0)]
        })
      };
    }

    return {
      actors,
      terrain: buildTerrainCell("empty", null, { layers: [] })
    };
  }

  function buildCellState(cellDefinitions, floorDefinition, exitDefinition) {
    return buildCellStack(cellDefinitions, floorDefinition, exitDefinition).terrain;
  }

  function getLevelState(game, level) {
    const levelPath = path.join(gamesDir, game.id, "levels", level.fileName);
    const rawLevel = loadText(levelPath, "");
    const rawRows = parseLevelRows(rawLevel).map((row) => parseLevelCells(game.parser, row));
    const definitions = getObjectDefinitions(game);
    const floorDefinition = definitions.byName.get("floor") || null;
    const exitDefinition = definitions.byName.get("exit") || null;
    const terrain = [];
    const actors = [];
    const boardWidth =
      game.id === "maze"
        ? mazeLevelGridWidth
        : rawRows.reduce((maxColumns, row) => Math.max(maxColumns, row.length), 0);
    const boardHeight = game.id === "maze" ? mazeLevelGridHeight : rawRows.length;

    Array.from({ length: boardHeight }, (_, y) => {
      const row = rawRows[y] || [];
      const terrainRow = [];

      Array.from({ length: boardWidth }, (_, index) => {
        const hasSourceCell = y < rawRows.length && index < row.length;
        const cell = hasSourceCell ? row[index] : "";
        const cellDefinitions = parseCellStack(game.parser, cell)
          .map((token) => {
            const normalizedToken = String(token).trim();
            return normalizedToken.length === 0 ? { isAir: true } : definitions.byToken.get(normalizedToken);
          })
          .filter(Boolean);
        const cellStack = hasSourceCell
          ? buildCellStack(cellDefinitions, floorDefinition, exitDefinition)
          : {
              actors: [],
              terrain: buildTerrainCell("floor", floorDefinition)
            };

        terrainRow.push(cellStack.terrain);

        cellStack.actors.forEach(({ definition, elevation }) => {
          actors.push({
            type: definitionType(definition),
            groupId: definitionType(definition) === "weightless_box" ? definition.token : null,
            label: definition.label,
            imageUrl: definition.imageUrl,
            modelUrl: definition.modelUrl,
            direction: definition.direction || null,
            elevation,
            x: index,
            y
          });
        });
      });

      terrain.push(terrainRow);
    });

    return {
      gameId: game.id,
      levelId: level.id,
      levelLabel: level.label,
      sourceFileName: level.fileName,
      width: boardWidth,
      height: boardHeight,
      terrain,
      actors,
      cameraView:
        game.id === "maze"
          ? {
              width: mazeWorldConfig.cameraView.width,
              height: mazeWorldConfig.cameraView.height
            }
          : null,
      worldColumns: game.id === "maze" ? mazeWorldConfig.worldColumns : null,
      worldRows: game.id === "maze" ? mazeWorldConfig.worldRows : null
    };
  }

  function getLevelFilePath(game, level) {
    return path.join(gamesDir, game.id, "levels", level.fileName);
  }

  function buildBlankEditorCells(width, height, fillToken) {
    return Array.from({ length: height }, () => Array.from({ length: width }, () => fillToken));
  }

  function serializeEditorCells(parser, cells) {
    const separator =
      typeof parser?.rules?.separator === "string" && parser.rules.separator.length > 0
        ? parser.rules.separator
        : " ";

    return cells.map((row) => row.join(separator)).join("\n");
  }

  function normalizeEditorCellValue(game, definitions, cell, floorToken) {
    const blockAdder =
      typeof game.parser?.rules?.block_adder === "string" && game.parser.rules.block_adder.length > 0
        ? game.parser.rules.block_adder
        : "+";
    const emptyCellToken = blockAdder;
    const trimmedCell = String(cell ?? "").trim();

    if (!trimmedCell) {
      return emptyCellToken;
    }

    const tokens = parseCellStack(game.parser, trimmedCell).map((token) => String(token).trim());

    if (tokens.length === 0 || tokens.every((token) => token.length === 0)) {
      return emptyCellToken;
    }

    const invalidToken = tokens.find((token) => token.length > 0 && !definitions.byToken.has(token));

    if (invalidToken) {
      throw new Error(`Unknown token "${invalidToken}".`);
    }

    return tokens.join(blockAdder);
  }

  function getLevelEditorState(game, level) {
    const levelPath = getLevelFilePath(game, level);
    const definitions = getObjectDefinitions(game);
    const floorToken = definitions.byName.get("floor")?.tokens?.[0] || ".";
    const rawLevel = loadText(levelPath, "");
    const rawRows = parseLevelRows(rawLevel).map((row) => parseLevelCells(game.parser, row));
    const exists = fs.existsSync(levelPath);
    const width = exists
      ? clampMazeLevelWidth(
          rawRows.reduce((maxColumns, row) => Math.max(maxColumns, row.length), 0),
          mazeAuthorDefaultWidth
        )
      : mazeAuthorDefaultWidth;
    const height = exists
      ? clampMazeLevelHeight(rawRows.length, mazeAuthorDefaultHeight)
      : mazeAuthorDefaultHeight;
    const cells =
      exists && rawRows.length > 0
        ? Array.from({ length: height }, (_, y) =>
            Array.from({ length: width }, (_, x) =>
              normalizeEditorCellValue(game, definitions, rawRows[y]?.[x] ?? floorToken, floorToken)
            )
          )
        : buildBlankEditorCells(width, height, floorToken);

    return {
      cells,
      exists,
      fileName: level.fileName,
      filePath: path.relative(rootDir, levelPath).replace(/\\/g, "/"),
      height,
      levelId: level.id,
      label: level.label,
      previewUrl: game.id === "maze" ? buildMazePreviewData(game, level.fileName).previewUrl : null,
      rawText: serializeEditorCells(game.parser, cells),
      width
    };
  }

  function sanitizeEditorPayload(game, payload) {
    if (!Array.isArray(payload?.cells)) {
      throw new Error("Level payload must include a cells array.");
    }

    const definitions = getObjectDefinitions(game);
    const floorToken = definitions.byName.get("floor")?.tokens?.[0] || ".";
    const width = clampMazeLevelWidth(payload?.width, mazeAuthorDefaultWidth);
    const height = clampMazeLevelHeight(payload?.height, mazeAuthorDefaultHeight);
    const cells = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) =>
        normalizeEditorCellValue(game, definitions, payload.cells?.[y]?.[x] ?? floorToken, floorToken)
      )
    );

    return {
      cells,
      height,
      rawText: serializeEditorCells(game.parser, cells),
      width
    };
  }

  function buildAuthorPalette(game) {
    const definitions = getObjectDefinitions(game);
    const palette = [];

    Object.entries(game.parser?.objects || {}).forEach(([name, config]) => {
      const definition = definitions.byName.get(name);

      definition.tokenEntries.forEach((entry) => {
        palette.push({
          imageUrl: definition?.imageUrl || null,
          modelUrl: definition?.modelUrl || null,
          label:
            entry.label ||
            (definition.tokenEntries.length > 1
              ? `${definition?.label || titleCase(name)} ${entry.token}`
              : definition?.label || titleCase(name)),
          initialRaised: definition.initialRaised || entry.initialRaised,
          name,
          selectable:
            config?.selectable !== false &&
            entry.selectable !== false &&
            name !== "circle_player" &&
            name !== "exit" &&
            name !== "hole",
          token: entry.token,
          type: definition.type,
          direction: entry.direction || null
        });
      });
    });

    return palette;
  }

  function buildAuthorPageData(game, level) {
    const definitions = getObjectDefinitions(game);
    const floorToken = definitions.byName.get("floor")?.tokens?.[0] || ".";
    const wallToken = definitions.byName.get("wall")?.tokens?.[0] || floorToken;
    const initialLevel = getLevelEditorState(game, level);

    return {
      authorApiBaseUrl: `/api/author/${encodeURIComponent(game.id)}`,
      blockAdder:
        typeof game.parser?.rules?.block_adder === "string" && game.parser.rules.block_adder.length > 0
          ? game.parser.rules.block_adder
          : "+",
      defaultFloorToken: floorToken,
      defaultLevelId: mazeDefaultLevelId,
      defaultHeight: mazeAuthorDefaultHeight,
      defaultWidth: mazeAuthorDefaultWidth,
      defaultWallToken: wallToken,
      existingLevels: game.levels
        .filter((candidate) => isMazeWorldLevelId(candidate.id))
        .map((candidate) => ({
          authorUrl: `/author/${encodeURIComponent(game.id)}/${encodeURIComponent(candidate.id)}`,
          id: candidate.id,
          label: candidate.label,
          playUrl: `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(candidate.id)}`
        })),
      game: {
        id: game.id,
        name: game.name
      },
      initialLevel,
      previewApiBaseUrl: `/api/author/${encodeURIComponent(game.id)}`,
      worldColumns: mazeWorldConfig.worldColumns,
      worldRows: mazeWorldConfig.worldRows,
      maxBoardHeight: mazeLevelGridHeight,
      maxBoardWidth: mazeLevelGridWidth,
      palette: buildAuthorPalette(game),
      separator:
        typeof game.parser?.rules?.separator === "string" && game.parser.rules.separator.length > 0
          ? game.parser.rules.separator
          : " "
    };
  }

  function listGames() {
    if (!fs.existsSync(gamesDir)) {
      return [];
    }

    return fs
      .readdirSync(gamesDir, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) {
          return false;
        }

        const gameDir = path.join(gamesDir, entry.name);
        return fs.existsSync(path.join(gameDir, "levels")) && fs.existsSync(path.join(gameDir, "level_parsing.json"));
      })
      .map((entry) => getGame(entry.name))
      .filter(Boolean);
  }

  function getGame(gameId) {
    const gameDir = path.join(gamesDir, gameId);
    const levelsDir = path.join(gameDir, "levels");
    const parserPath = path.join(gameDir, "level_parsing.json");

    if (!fs.existsSync(gameDir) || !fs.existsSync(levelsDir) || !fs.existsSync(parserPath)) {
      return null;
    }

    const levelFiles = listTopLevelFiles(levelsDir);
    const baseGame = {
      id: gameId,
      levelFiles,
      name: titleCase(gameId),
      player: fs.existsSync(path.join(gameDir, "player.py")) ? "Python Player" : "Unknown Player",
      parser: loadJson(parserPath, {}),
      parserUrl: `/games/${gameId}/level_parsing.json`
    };

    if (gameId === "maze") {
      const worldMap = buildMazeWorldMapState(baseGame);

      return {
        ...baseGame,
        levels: worldMap.levels,
        worldMap
      };
    }

    return {
      ...baseGame,
      levels: levelFiles.map((fileName) => {
        const levelId = path.parse(fileName).name;
        const match = fileName.match(/(\d+)/);
        const number = match ? Number(match[1]) : levelId;
        const label =
          gameId === "maze" && isMazeWorldLevelId(levelId)
            ? mazeLevelLabel(levelId)
            : typeof number === "number"
              ? `Level ${number}`
              : `Level ${levelId}`;
        return {
          fileName,
          id: levelId,
          number,
          label,
          playUrl: `/play/${gameId}/${levelId}`
        };
      })
    };
  }

  function findExistingLevel(game, levelId) {
    return game.id === "maze"
      ? game.worldMap?.byPosition?.get(levelId) || null
      : game.levels.find((level) => level.id === levelId) || null;
  }

  function getLevel(game, levelId) {
    const requestedLevelId =
      typeof levelId === "string" && levelId.length > 0 ? levelId : defaultLevelIdForGame(game);
    const existingLevel = findExistingLevel(game, requestedLevelId);

    if (existingLevel) {
      return existingLevel;
    }

    if (game.id === "maze" && isMazeWorldLevelId(requestedLevelId)) {
      const fallbackFileName = buildMazeFallbackLevelFileName(requestedLevelId, game.levelFiles, game.worldMap);
      return buildMazeWorldLevel(requestedLevelId, {
        fileName: fallbackFileName,
        previewUrl: buildMazePreviewData(game, fallbackFileName).previewUrl
      });
    }

    return null;
  }

  function getEditableLevel(game, levelId, preferredFileName = "") {
    const requestedLevelId =
      typeof levelId === "string" && levelId.length > 0 ? levelId : defaultLevelIdForGame(game);
    const existingLevel = findExistingLevel(game, requestedLevelId);

    if (existingLevel) {
      return existingLevel;
    }

    if (game.id === "maze" && isMazeWorldLevelId(requestedLevelId)) {
      const editableFileName = chooseMazeEditableFileName(game, requestedLevelId, preferredFileName);
      return buildMazeWorldLevel(requestedLevelId, {
        fileName: editableFileName,
        previewUrl: buildMazePreviewData(game, editableFileName).previewUrl
      });
    }

    return null;
  }

  return {
    buildAuthorPageData,
    getEditableLevel,
    getGame,
    getLevel,
    getLevelEditorState,
    getLevelFilePath,
    getLevelState,
    listGames,
    sanitizeEditorPayload
  };
}

module.exports = {
  createMazeLevelService
};
