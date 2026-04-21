const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const ROOT_DIR = __dirname;
const GAMES_DIR = path.join(ROOT_DIR, "games");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const MAZE_DIR = path.join(GAMES_DIR, "maze");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const MAZE_LEVEL_ID_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAZE_WORLD_LEVEL_ID_PATTERN = /^level_([A-Z])x([A-Z])$/;
const MAZE_DEFAULT_LEVEL_ID = "level_AxA";
const MAZE_WORLD_MAP_PATH = path.join(MAZE_DIR, "world_map.json");
const MAZE_PREVIEWS_DIR = path.join(MAZE_DIR, "previews");
const MAZE_LEVEL_FILE_GUID_LENGTH = 10;
const MAZE_LEVEL_FILE_GUID_PATTERN = new RegExp(`^[a-z0-9]{${MAZE_LEVEL_FILE_GUID_LENGTH}}\\.txt$`);

function clampMazeConfigDimension(value, fallback, max = MAZE_LEVEL_ID_LETTERS.length) {
  const numericValue = Number(value);

  if (!Number.isInteger(numericValue)) {
    return fallback;
  }

  return Math.max(1, Math.min(max, numericValue));
}

function normalizeMazeConfigPair(value, fallback, max = MAZE_LEVEL_ID_LETTERS.length) {
  const fallbackWidth = Array.isArray(fallback) ? fallback[0] : fallback;
  const fallbackHeight = Array.isArray(fallback) ? fallback[1] : fallbackWidth;

  if (!Array.isArray(value)) {
    return {
      width: clampMazeConfigDimension(fallbackWidth, 1, max),
      height: clampMazeConfigDimension(fallbackHeight, 1, max)
    };
  }

  return {
    width: clampMazeConfigDimension(value[0], fallbackWidth, max),
    height: clampMazeConfigDimension(value[1], fallbackHeight, max)
  };
}

function buildMazeLetterAxis(length) {
  return Array.from(MAZE_LEVEL_ID_LETTERS.slice(0, length));
}

function loadMazeWorldConfig() {
  const worldParsing = loadJson(path.join(MAZE_DIR, "world_parsing.json"), {}) || {};
  const rules = worldParsing.rules || {};
  const worldSize = normalizeMazeConfigPair(rules.world_size, [26, 26]);
  const levelSize = normalizeMazeConfigPair(rules.level_size, [26, 26]);
  const cameraView = normalizeMazeConfigPair(rules.camera_view, [10, 10], 256);

  return {
    worldSize,
    levelSize,
    cameraView,
    worldColumns: buildMazeLetterAxis(worldSize.width),
    worldRows: buildMazeLetterAxis(worldSize.height)
  };
}

const MAZE_WORLD_CONFIG = loadMazeWorldConfig();
const MAZE_LEVEL_GRID_WIDTH = MAZE_WORLD_CONFIG.levelSize.width;
const MAZE_LEVEL_GRID_HEIGHT = MAZE_WORLD_CONFIG.levelSize.height;
const MAZE_AUTHOR_DEFAULT_WIDTH = MAZE_LEVEL_GRID_WIDTH;
const MAZE_AUTHOR_DEFAULT_HEIGHT = MAZE_LEVEL_GRID_HEIGHT;

function listTopLevelFiles(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function buildMazeWorldLevelId(column, row) {
  return `level_${column}x${row}`;
}

function buildMazeFallbackLevelFileName(levelId, levelFiles = [], worldMap = null) {
  const preferredFileName = `${levelId}.txt`;
  const mappedLevel = worldMap?.byFileName?.get(preferredFileName) || null;

  if (!mappedLevel || mappedLevel.id === levelId) {
    return preferredFileName;
  }

  const existingFileNames = new Set(levelFiles);
  let candidate = `slot_${levelId}.txt`;
  let suffix = 1;

  while (existingFileNames.has(candidate) && worldMap?.byFileName?.has(candidate)) {
    candidate = `slot_${levelId}_${suffix}.txt`;
    suffix += 1;
  }

  return candidate;
}

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

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function getMazePreviewFileName(fileName) {
  return `${path.parse(fileName).name}.png`;
}

function getMazePreviewFilePath(fileName) {
  return path.join(MAZE_PREVIEWS_DIR, getMazePreviewFileName(fileName));
}

function writeMazePreviewImageData(level, imageDataUrl) {
  const match = String(imageDataUrl || "").match(/^data:image\/png;base64,(.+)$/);

  if (!match) {
    throw new Error("Preview payload must be a PNG data URL.");
  }

  const previewBuffer = Buffer.from(match[1], "base64");

  if (previewBuffer.length === 0) {
    throw new Error("Preview payload is empty.");
  }

  if (previewBuffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Preview payload must be a PNG image.");
  }

  ensureDirectory(MAZE_PREVIEWS_DIR);
  const previewPath = getMazePreviewFilePath(level.fileName);
  fs.writeFileSync(previewPath, previewBuffer);
  return previewPath;
}

function buildMazePreviewData(game, fileName) {
  if (game?.id !== "maze" || typeof fileName !== "string" || !fileName) {
    return {
      previewUrl: null
    };
  }

  const previewPath = getMazePreviewFilePath(fileName);

  if (!previewPath || !fs.existsSync(previewPath)) {
    return {
      previewUrl: null
    };
  }

  const previewVersion = Math.round(fs.statSync(previewPath).mtimeMs);

  return {
    previewUrl: `${buildGameAssetUrl(game.id, `previews/${getMazePreviewFileName(fileName)}`)}?v=${previewVersion}`
  };
}

function normalizeMazeWorldAxisValue(value, axisValues) {
  const normalizedStringValue = String(value ?? "").trim().toUpperCase();

  if (normalizedStringValue) {
    const index = axisValues.indexOf(normalizedStringValue);

    if (index !== -1) {
      return {
        index,
        value: axisValues[index]
      };
    }
  }

  const numericValue = Number(value);

  if (Number.isInteger(numericValue) && numericValue >= 0 && numericValue < axisValues.length) {
    return {
      index: numericValue,
      value: axisValues[numericValue]
    };
  }

  return null;
}

function normalizeMazeWorldPosition(value) {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }

  const column = normalizeMazeWorldAxisValue(value[0], MAZE_WORLD_CONFIG.worldColumns);
  const row = normalizeMazeWorldAxisValue(value[1], MAZE_WORLD_CONFIG.worldRows);

  if (!column || !row) {
    return null;
  }

  return {
    column: column.value,
    row: row.value,
    columnIndex: column.index,
    rowIndex: row.index,
    levelId: buildMazeWorldLevelId(column.value, row.value),
    position: [column.value, row.value]
  };
}

function compareMazeWorldPositions(left, right) {
  return (
    left.rowIndex - right.rowIndex ||
    left.columnIndex - right.columnIndex ||
    String(left.fileName || "").localeCompare(String(right.fileName || ""), undefined, {
      numeric: true
    })
  );
}

function parseMazeWorldMapEntriesInput(rawLevels) {
  if (Array.isArray(rawLevels)) {
    return rawLevels;
  }

  if (rawLevels && typeof rawLevels === "object") {
    return Object.entries(rawLevels).map(([fileName, position]) => ({
      fileName,
      position
    }));
  }

  return null;
}

function buildDefaultMazeWorldMapEntries(levelFiles) {
  return levelFiles
    .map((fileName) => {
      const coordinates = parseMazeWorldLevelId(path.parse(fileName).name);

      if (!coordinates) {
        return null;
      }

      return {
        fileName,
        position: [coordinates.column, coordinates.row],
        column: coordinates.column,
        row: coordinates.row,
        columnIndex: coordinates.columnIndex,
        rowIndex: coordinates.rowIndex,
        levelId: buildMazeWorldLevelId(coordinates.column, coordinates.row)
      };
    })
    .filter(Boolean)
    .sort(compareMazeWorldPositions);
}

function sanitizeMazeWorldMapEntries(levelFiles, rawLevels) {
  const entries = parseMazeWorldMapEntriesInput(rawLevels);

  if (!entries) {
    return [];
  }

  const validFileNames = new Set(levelFiles);
  const seenFileNames = new Set();
  const seenPositions = new Set();
  const sanitized = [];

  entries.forEach((entry) => {
    const fileName = typeof entry?.fileName === "string" ? entry.fileName.trim() : "";
    const coordinates = normalizeMazeWorldPosition(entry?.position);

    if (!fileName || !validFileNames.has(fileName) || !coordinates) {
      return;
    }

    if (seenFileNames.has(fileName) || seenPositions.has(coordinates.levelId)) {
      return;
    }

    seenFileNames.add(fileName);
    seenPositions.add(coordinates.levelId);
    sanitized.push({
      fileName,
      position: [coordinates.column, coordinates.row],
      column: coordinates.column,
      row: coordinates.row,
      columnIndex: coordinates.columnIndex,
      rowIndex: coordinates.rowIndex,
      levelId: coordinates.levelId
    });
  });

  return sanitized.sort(compareMazeWorldPositions);
}

function validateMazeWorldMapEntries(levelFiles, rawLevels) {
  const entries = parseMazeWorldMapEntriesInput(rawLevels);

  if (!entries) {
    throw new Error("World map payload must include a levels mapping.");
  }

  const validFileNames = new Set(levelFiles);
  const seenFileNames = new Set();
  const seenPositions = new Set();

  return entries
    .map((entry, index) => {
      const fileName = typeof entry?.fileName === "string" ? entry.fileName.trim() : "";

      if (!fileName) {
        throw new Error(`World map entry ${index + 1} is missing a fileName.`);
      }

      if (!validFileNames.has(fileName)) {
        throw new Error(`World map entry ${index + 1} references unknown file "${fileName}".`);
      }

      if (seenFileNames.has(fileName)) {
        throw new Error(`World map file "${fileName}" is listed more than once.`);
      }

      const coordinates = normalizeMazeWorldPosition(entry?.position);

      if (!coordinates) {
        throw new Error(`World map entry ${index + 1} has an invalid position.`);
      }

      if (seenPositions.has(coordinates.levelId)) {
        throw new Error(`World map position ${coordinates.levelId} is already occupied.`);
      }

      seenFileNames.add(fileName);
      seenPositions.add(coordinates.levelId);

      return {
        fileName,
        position: [coordinates.column, coordinates.row],
        column: coordinates.column,
        row: coordinates.row,
        columnIndex: coordinates.columnIndex,
        rowIndex: coordinates.rowIndex,
        levelId: coordinates.levelId
      };
    })
    .sort(compareMazeWorldPositions);
}

function loadMazeWorldMapEntries(levelFiles) {
  if (!fs.existsSync(MAZE_WORLD_MAP_PATH)) {
    return buildDefaultMazeWorldMapEntries(levelFiles);
  }

  const worldMap = loadJson(MAZE_WORLD_MAP_PATH, {}) || {};
  return sanitizeMazeWorldMapEntries(levelFiles, worldMap.levels);
}

function writeMazeWorldMap(entries) {
  const serializedLevels = {};

  entries
    .slice()
    .sort(compareMazeWorldPositions)
    .forEach((entry) => {
      serializedLevels[entry.fileName] = [entry.column, entry.row];
    });

  fs.writeFileSync(
    MAZE_WORLD_MAP_PATH,
    JSON.stringify(
      {
        levels: serializedLevels
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function titleCase(value) {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function serializeForScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function loadJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadText(filePath, fallback = "") {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return fs.readFileSync(filePath, "utf8");
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function buildGameAssetUrl(gameId, relativePath) {
  const encodedPath = relativePath
    .split(/[\\/]/)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `/assets/${encodeURIComponent(gameId)}/${encodedPath}`;
}

function resolveGameAssetPath(gameId, relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    return null;
  }

  const gameDir = path.resolve(GAMES_DIR, gameId);
  const assetPath = path.resolve(gameDir, relativePath);
  const gameDirPrefix = `${gameDir}${path.sep}`;

  if (assetPath !== gameDir && !assetPath.startsWith(gameDirPrefix)) {
    return null;
  }

  if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
    return null;
  }

  return assetPath;
}

function parseLevelRows(rawLevel) {
  return rawLevel.split(/\r?\n/).filter((row) => row.length > 0);
}

function parseMazeWorldLevelId(levelId) {
  const match = String(levelId || "").match(MAZE_WORLD_LEVEL_ID_PATTERN);

  if (!match) {
    return null;
  }

  const columnIndex = MAZE_WORLD_CONFIG.worldColumns.indexOf(match[1]);
  const rowIndex = MAZE_WORLD_CONFIG.worldRows.indexOf(match[2]);

  if (columnIndex === -1 || rowIndex === -1) {
    return null;
  }

  return {
    column: match[1],
    row: match[2],
    columnIndex,
    rowIndex
  };
}

function isMazeWorldLevelId(levelId) {
  return parseMazeWorldLevelId(levelId) !== null;
}

function mazeLevelLabel(levelId) {
  const coordinates = parseMazeWorldLevelId(levelId);

  if (!coordinates) {
    return `Level ${levelId}`;
  }

  return `Level ${coordinates.column}x${coordinates.row}`;
}

function buildMazeWorldLevel(levelId, options = {}) {
  const coordinates = parseMazeWorldLevelId(levelId);

  if (!coordinates) {
    return null;
  }

  const fileName =
    typeof options.fileName === "string" && options.fileName.length > 0
      ? options.fileName
      : `${levelId}.txt`;

  return {
    authorUrl: `/author/maze/${levelId}`,
    column: coordinates.column,
    columnIndex: coordinates.columnIndex,
    fileName,
    fileLevelId: path.parse(fileName).name,
    id: levelId,
    mapped: Boolean(options.mapped),
    number: levelId,
    label: mazeLevelLabel(levelId),
    previewUrl: options.previewUrl || null,
    playUrl: `/play/maze/${levelId}`,
    position: [coordinates.column, coordinates.row],
    row: coordinates.row,
    rowIndex: coordinates.rowIndex
  };
}

function buildMazeWorldMapState(game) {
  const levelFiles = Array.isArray(game?.levelFiles) ? game.levelFiles : [];
  const entries = loadMazeWorldMapEntries(levelFiles);
  const levels = entries.map((entry) =>
    buildMazeWorldLevel(entry.levelId, {
      fileName: entry.fileName,
      mapped: true,
      previewUrl: buildMazePreviewData(game, entry.fileName).previewUrl
    })
  );

  return {
    byFileName: new Map(levels.map((level) => [level.fileName, level])),
    byPosition: new Map(levels.map((level) => [level.id, level])),
    entries,
    levels
  };
}

function defaultLevelIdForGame(game) {
  if (game?.id === "maze") {
    if (game.worldMap?.byPosition?.has(MAZE_DEFAULT_LEVEL_ID)) {
      return MAZE_DEFAULT_LEVEL_ID;
    }

    return game.levels?.[0]?.id || MAZE_DEFAULT_LEVEL_ID;
  }

  return game?.levels?.[0]?.id || null;
}

function clampMazeLevelDimension(value, max, fallback) {
  const numericValue = Number(value);

  if (!Number.isInteger(numericValue)) {
    return fallback;
  }

  return Math.max(1, Math.min(max, numericValue));
}

function clampMazeLevelWidth(value, fallback = MAZE_AUTHOR_DEFAULT_WIDTH) {
  return clampMazeLevelDimension(value, MAZE_LEVEL_GRID_WIDTH, fallback);
}

function clampMazeLevelHeight(value, fallback = MAZE_AUTHOR_DEFAULT_HEIGHT) {
  return clampMazeLevelDimension(value, MAZE_LEVEL_GRID_HEIGHT, fallback);
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
      .filter((token) => token.length > 0);
  }

  return cell ? [cell] : [];
}

function getDefinitionTokens(config) {
  if (typeof config?.token === "string" && config.token.length > 0) {
    return [config.token];
  }

  if (Array.isArray(config?.tokens)) {
    return config.tokens.filter((token) => typeof token === "string" && token.length > 0);
  }

  return [];
}

function getObjectDefinitions(game) {
  const definitions = Object.entries(game.parser?.objects || {}).map(([name, config]) => {
    const relativeImagePath = typeof config?.image === "string" ? config.image : null;
    const assetPath = relativeImagePath ? resolveGameAssetPath(game.id, relativeImagePath) : null;

    return {
      name,
      tokens: getDefinitionTokens(config),
      imageUrl: assetPath ? buildGameAssetUrl(game.id, relativeImagePath) : null,
      label: titleCase(name)
    };
  });

  return {
    byName: new Map(definitions.map((definition) => [definition.name, definition])),
    byToken: new Map(
      definitions
        .flatMap((definition) =>
          definition.tokens.map((token) => [
            token,
            {
              ...definition,
              token
            }
          ])
        )
    )
  };
}

function buildTerrainCell(type, definition = null, options = {}) {
  return {
    type,
    label: definition?.label || titleCase(type),
    imageUrl: definition?.imageUrl || null,
    underlay: options.underlay || null,
    raised: Boolean(options.raised)
  };
}

function isActorDefinition(definition) {
  return (
    definition?.name === "player" ||
    definition?.name === "circle_player" ||
    definition?.name === "box" ||
    definition?.name === "gem" ||
    definition?.name === "floating_floor" ||
    definition?.name === "weightless_box"
  );
}

function isTerrainDefinition(definition) {
  return Boolean(definition) && !isActorDefinition(definition);
}

function buildCellState(cellDefinitions, floorDefinition, exitDefinition) {
  const terrainDefinitions = cellDefinitions.filter((definition) => isTerrainDefinition(definition));
  const wallDefinition = terrainDefinitions.find((definition) => definition.name === "wall") || null;
  const exitCellDefinition = terrainDefinitions.find((definition) => definition.name === "exit") || null;
  const terrainDefinition =
    wallDefinition ||
    exitCellDefinition ||
    terrainDefinitions[0] ||
    null;

  if (wallDefinition) {
    const underlayDefinition =
      terrainDefinitions.find((definition) => definition.name !== "wall") || floorDefinition || null;

    return buildTerrainCell("wall", wallDefinition, {
      underlay: buildTerrainCell(
        underlayDefinition?.name || "floor",
        underlayDefinition
      )
    });
  }

  if (terrainDefinition?.name === "exit") {
    return buildTerrainCell("exit", exitDefinition || terrainDefinition);
  }

  if (terrainDefinition) {
    return buildTerrainCell(terrainDefinition.name, terrainDefinition, {
      raised: terrainDefinition.name === "player_lift" ? false : undefined
    });
  }

  if (cellDefinitions.some((definition) => isActorDefinition(definition))) {
    return buildTerrainCell("floor", floorDefinition);
  }

  return buildTerrainCell("empty");
}

function getLevelState(game, level) {
  const levelPath = path.join(GAMES_DIR, game.id, "levels", level.fileName);
  const rawLevel = loadText(levelPath, "");
  const rawRows = parseLevelRows(rawLevel).map((row) => parseLevelCells(game.parser, row));
  const definitions = getObjectDefinitions(game);
  const floorDefinition = definitions.byName.get("floor") || null;
  const exitDefinition = definitions.byName.get("exit") || null;
  const terrain = [];
  const actors = [];
  const boardWidth =
    game.id === "maze"
      ? MAZE_LEVEL_GRID_WIDTH
      : rawRows.reduce((maxColumns, row) => Math.max(maxColumns, row.length), 0);
  const boardHeight = game.id === "maze" ? MAZE_LEVEL_GRID_HEIGHT : rawRows.length;

  Array.from({ length: boardHeight }, (_, y) => {
    const row = rawRows[y] || [];
    const terrainRow = [];

    Array.from({ length: boardWidth }, (_, index) => {
      const hasSourceCell = y < rawRows.length && index < row.length;
      const cell = hasSourceCell ? row[index] : "";
      const cellDefinitions = parseCellStack(game.parser, cell)
        .map((token) => definitions.byToken.get(token))
        .filter(Boolean);

      terrainRow.push(
        hasSourceCell
          ? buildCellState(cellDefinitions, floorDefinition, exitDefinition)
          : buildTerrainCell("floor", floorDefinition)
      );

      cellDefinitions.forEach((definition) => {
        if (!isActorDefinition(definition)) {
          return;
        }

        actors.push({
          type: definition.name,
          groupId: definition.name === "weightless_box" ? definition.token : null,
          label: definition.label,
          imageUrl: definition.imageUrl,
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
            width: MAZE_WORLD_CONFIG.cameraView.width,
            height: MAZE_WORLD_CONFIG.cameraView.height
          }
        : null,
    worldColumns: game.id === "maze" ? MAZE_WORLD_CONFIG.worldColumns : null,
    worldRows: game.id === "maze" ? MAZE_WORLD_CONFIG.worldRows : null
  };
}

function getLevelFilePath(game, level) {
  return path.join(GAMES_DIR, game.id, "levels", level.fileName);
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
  const trimmedCell = String(cell ?? "").trim();

  if (!trimmedCell) {
    return floorToken;
  }

  const tokens = parseCellStack(game.parser, trimmedCell).map((token) => String(token).trim()).filter(Boolean);

  if (tokens.length === 0) {
    return floorToken;
  }

  const invalidToken = tokens.find((token) => !definitions.byToken.has(token));

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
        MAZE_AUTHOR_DEFAULT_WIDTH
      )
    : MAZE_AUTHOR_DEFAULT_WIDTH;
  const height = exists
    ? clampMazeLevelHeight(rawRows.length, MAZE_AUTHOR_DEFAULT_HEIGHT)
    : MAZE_AUTHOR_DEFAULT_HEIGHT;
  const cells =
    exists && rawRows.length > 0
      ? Array.from({ length: height }, (_, y) =>
          Array.from({ length: width }, (_, x) =>
            normalizeEditorCellValue(game, definitions, rawRows[y]?.[x] || floorToken, floorToken)
          )
        )
      : buildBlankEditorCells(width, height, floorToken);

  return {
    cells,
    exists,
    fileName: level.fileName,
    filePath: path.relative(ROOT_DIR, levelPath).replace(/\\/g, "/"),
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
  const width = clampMazeLevelWidth(payload?.width, MAZE_AUTHOR_DEFAULT_WIDTH);
  const height = clampMazeLevelHeight(payload?.height, MAZE_AUTHOR_DEFAULT_HEIGHT);
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
    const tokens = getDefinitionTokens(config);

    tokens.forEach((token) => {
      palette.push({
        imageUrl: definition?.imageUrl || null,
        label:
          tokens.length > 1
            ? `${definition?.label || titleCase(name)} ${token}`
            : definition?.label || titleCase(name),
        name,
        token
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
    defaultLevelId: MAZE_DEFAULT_LEVEL_ID,
    defaultHeight: MAZE_AUTHOR_DEFAULT_HEIGHT,
    defaultWidth: MAZE_AUTHOR_DEFAULT_WIDTH,
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
    worldColumns: MAZE_WORLD_CONFIG.worldColumns,
    worldRows: MAZE_WORLD_CONFIG.worldRows,
    maxBoardHeight: MAZE_LEVEL_GRID_HEIGHT,
    maxBoardWidth: MAZE_LEVEL_GRID_WIDTH,
    palette: buildAuthorPalette(game),
    separator:
      typeof game.parser?.rules?.separator === "string" && game.parser.rules.separator.length > 0
        ? game.parser.rules.separator
        : " "
  };
}

function buildMazeWorldMapEditorData(game, options = {}) {
  return {
    apiUrl: `/api/world-map/${encodeURIComponent(game.id)}`,
    authorBaseUrl: `/author/${encodeURIComponent(game.id)}`,
    defaultLevelId: defaultLevelIdForGame(game),
    files: game.levelFiles.map((fileName) => ({
      fileName,
      mappedLevelId: game.worldMap?.byFileName?.get(fileName)?.id || null,
      previewUrl: buildMazePreviewData(game, fileName).previewUrl
    })),
    game: {
      id: game.id,
      name: game.name
    },
    entries: (game.worldMap?.levels || []).map((level) => ({
      authorUrl: level.authorUrl,
      fileName: level.fileName,
      id: level.id,
      label: level.label,
      previewUrl: level.previewUrl || buildMazePreviewData(game, level.fileName).previewUrl,
      playUrl: level.playUrl,
      position: [level.column, level.row]
    })),
    message:
      options.message ||
      (game.worldMap?.levels?.length
        ? "Select a level tile, then click a world slot to move it."
        : "Pick a level file from the unplaced list, then click a world slot."),
    playBaseUrl: `/play/${encodeURIComponent(game.id)}`,
    worldColumns: MAZE_WORLD_CONFIG.worldColumns,
    worldRows: MAZE_WORLD_CONFIG.worldRows
  };
}

function ensureMazeWorldLevelMapped(level) {
  if (!isMazeWorldLevelId(level?.id)) {
    return;
  }

  const levelFiles = listTopLevelFiles(path.join(MAZE_DIR, "levels"));
  const existingEntries = loadMazeWorldMapEntries(levelFiles);

  if (existingEntries.some((entry) => entry.levelId === level.id)) {
    return;
  }

  const coordinates = parseMazeWorldLevelId(level.id);

  if (!coordinates) {
    return;
  }

  writeMazeWorldMap(
    validateMazeWorldMapEntries(levelFiles, [
      ...existingEntries,
      {
        fileName: level.fileName,
        position: [coordinates.column, coordinates.row]
      }
    ])
  );
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;

      if (body.length > 5 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function readJsonBody(request) {
  const body = await readRequestBody(request);

  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error("Request body must be valid JSON.");
  }
}

function listGames() {
  if (!fs.existsSync(GAMES_DIR)) {
    return [];
  }

  return fs
    .readdirSync(GAMES_DIR, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }

      const gameDir = path.join(GAMES_DIR, entry.name);
      return fs.existsSync(path.join(gameDir, "levels")) && fs.existsSync(path.join(gameDir, "level_parsing.json"));
    })
    .map((entry) => getGame(entry.name))
    .filter(Boolean);
}

function getGame(gameId) {
  const gameDir = path.join(GAMES_DIR, gameId);
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

function sendHtml(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function sendRedirect(response, location, statusCode = 302) {
  response.writeHead(statusCode, {
    Location: location
  });
  response.end();
}

function sendFile(response, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    sendHtml(response, 404, renderNotFound());
    return;
  }

  response.writeHead(200, { "Content-Type": contentType });
  response.end(fs.readFileSync(filePath));
}

function renderPage({ title, body, bodyClass = "" }) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body class="${escapeHtml(bodyClass)}">
    ${body}
  </body>
</html>`;
}

function renderHomePage() {
  const games = listGames();
  const items = games
    .map(
      (game) => `<a class="game-link" href="${
        game.id === "maze"
          ? `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(defaultLevelIdForGame(game))}`
          : `/games/${encodeURIComponent(game.id)}`
      }">
        <span class="game-link__title">${escapeHtml(game.name)}</span>
      </a>`
    )
    .join("");

  return renderPage({
    title: "Games",
    body: `<main class="shell">
      <h1>Choose a game</h1>
      <div class="game-list">${items}</div>
    </main>`
  });
}

function renderGamePage(game) {
  const startLevelId = defaultLevelIdForGame(game);
  const startLink = startLevelId
    ? `<a class="back-link" href="/play/${encodeURIComponent(game.id)}/${encodeURIComponent(startLevelId)}">Play</a>`
    : "";
  const authorLink =
    game.id === "maze" && startLevelId
      ? `<a class="back-link" href="/author/${encodeURIComponent(game.id)}/${encodeURIComponent(startLevelId)}">Author</a>`
      : "";
  const worldMapLink =
    game.id === "maze"
      ? `<a class="back-link" href="/world-map/${encodeURIComponent(game.id)}">World Map</a>`
      : "";
  const levelsSection =
    game.id === "maze"
      ? ""
      : `<section class="stack">
        <h2>Levels</h2>
        <ul class="level-list">${game.levels
          .map(
            (level) => `<li><a href="${escapeHtml(level.playUrl)}">${escapeHtml(level.label)}</a></li>`
          )
          .join("")}</ul>
      </section>`;

  return renderPage({
    title: game.name,
    body: `<main class="shell">
      <nav class="page-nav">
        <a class="back-link" href="/">Back</a>
      </nav>
      <h1>${escapeHtml(game.name)}</h1>
      ${startLink}
      ${authorLink}
      ${worldMapLink}
      ${levelsSection}
    </main>`
  });
}

function renderPlayPage(game, level) {
  const levelState = getLevelState(game, level);
  const hasBoard = levelState.width > 0 && levelState.height > 0;
  const fuzzyToggleMarkup = hasBoard
    ? `<button
          id="fuzzy-toggle"
          class="effect-toggle is-active"
          type="button"
          aria-pressed="true"
          aria-label="Fuzzy noise"
          title="Fuzzy"
        >
          <span class="effect-icon effect-icon--fuzzy" aria-hidden="true"></span>
          <span class="effect-toggle-track" aria-hidden="true">
            <span class="effect-toggle-thumb"></span>
          </span>
        </button>`
    : "";
  const boardMarkup =
    hasBoard
      ? `<section class="play-stage" aria-label="${escapeHtml(game.name)} board">
          <div class="maze-frame">
            <canvas
              id="maze-canvas"
              class="maze-canvas"
              width="${levelState.width * 64}"
              height="${levelState.height * 64}"
              aria-label="${escapeHtml(game.name)} board"
            ></canvas>
          </div>
        </section>
        <script>window.__PLAY_DATA__ = ${serializeForScript(levelState)};</script>
        <script src="/play-core.js" defer></script>
        <script src="/play-render.js" defer></script>
        <script src="/play-gameplay.js" defer></script>
        <script src="/play.js" defer></script>`
      : `<section class="play-stage"><p>This level is empty.</p></section>`;

  return renderPage({
    title: `${game.name} ${level.label}`,
    bodyClass: "play-body",
    body: `<main class="play-shell">
      <header class="play-header">
        <h1>${escapeHtml(game.name)}</h1>
        <div class="play-header-meta">
          <a class="back-link" href="/games/${encodeURIComponent(game.id)}">Back</a>
          <a class="back-link" href="/author/${encodeURIComponent(game.id)}/${encodeURIComponent(level.id)}">Author</a>
          <a class="back-link" href="/world-map/${encodeURIComponent(game.id)}">World Map</a>
          <p>${escapeHtml(level.label)}</p>
          ${fuzzyToggleMarkup}
        </div>
      </header>
      ${boardMarkup}
    </main>`
  });
}

function renderAuthorPage(game, level) {
  const authorData = buildAuthorPageData(game, level);

  return renderPage({
    title: `${game.name} Author`,
    body: `<main class="shell author-shell">
      <nav class="page-nav">
        <a class="back-link" href="/games/${encodeURIComponent(game.id)}">Back</a>
        <a class="back-link" id="author-play-link" href="/play/${encodeURIComponent(game.id)}/${encodeURIComponent(level.id)}">Play</a>
        <a class="back-link" href="/world-map/${encodeURIComponent(game.id)}">World Map</a>
      </nav>
      <header class="author-header">
        <h1>${escapeHtml(game.name)} Author</h1>
        <p class="author-subtitle">Paint a maze level, tune the grid, and save the file that backs this world slot.</p>
      </header>
      <section class="author-toolbar">
        <div class="author-toolbar__group">
          <label class="field">
            <span>Column</span>
            <select id="level-column" aria-label="Level column"></select>
          </label>
          <label class="field">
            <span>Row</span>
            <select id="level-row" aria-label="Level row"></select>
          </label>
          <div id="level-neighbors" class="author-neighbors" aria-label="Neighbor levels">
            <button class="tool-button author-neighbors__button author-neighbors__button--up" type="button" data-dx="0" data-dy="-1">Up</button>
            <button class="tool-button author-neighbors__button author-neighbors__button--left" type="button" data-dx="-1" data-dy="0">Left</button>
            <button class="tool-button author-neighbors__button author-neighbors__button--right" type="button" data-dx="1" data-dy="0">Right</button>
            <button class="tool-button author-neighbors__button author-neighbors__button--down" type="button" data-dx="0" data-dy="1">Down</button>
          </div>
          <div class="author-meta">
            <span class="author-meta__label">File</span>
            <span id="current-file-name" class="author-meta__value"></span>
          </div>
        </div>
        <div class="author-toolbar__group">
          <label class="field">
            <span>Width</span>
            <input id="board-width" type="number" min="1" max="${MAZE_LEVEL_GRID_WIDTH}" inputmode="numeric">
          </label>
          <label class="field">
            <span>Height</span>
            <input id="board-height" type="number" min="1" max="${MAZE_LEVEL_GRID_HEIGHT}" inputmode="numeric">
          </label>
          <button id="resize-level" class="tool-button" type="button">Resize</button>
          <button id="clear-level" class="tool-button" type="button">Clear</button>
          <button id="frame-level" class="tool-button" type="button">Frame Walls</button>
          <button id="rotate-left" class="tool-button" type="button" title="Rotate level left">Rotate Left</button>
          <button id="rotate-right" class="tool-button" type="button" title="Rotate level right">Rotate Right</button>
          <button id="flip-horizontal" class="tool-button" type="button" title="Mirror level left to right">Flip Horizontal</button>
          <button id="flip-vertical" class="tool-button" type="button" title="Mirror level top to bottom">Flip Vertical</button>
          <button id="place-gem" class="tool-button" type="button">Place Gem</button>
          <button id="solve-level" class="tool-button" type="button">Solver</button>
          <button id="save-level" class="tool-button tool-button--primary" type="button">Save</button>
        </div>
      </section>
      <p id="author-status" class="author-status" role="status" aria-live="polite"></p>
      <div class="author-layout">
        <aside class="author-sidebar">
          <section class="author-panel">
            <h2>Paint</h2>
            <div id="palette" class="palette"></div>
          </section>
          <section class="author-panel">
            <h2>Cell</h2>
            <p id="selected-cell-label" class="author-panel__copy"></p>
            <label class="field">
              <span>Raw value</span>
              <input id="cell-value" type="text" spellcheck="false" aria-label="Selected cell raw value">
            </label>
            <button id="apply-cell-value" class="tool-button" type="button">Apply Cell</button>
          </section>
          <section class="author-panel">
            <h2>Existing World Levels</h2>
            <div id="existing-levels" class="author-level-pills"></div>
          </section>
        </aside>
        <section class="author-workspace">
          <section class="author-grid-shell">
            <div id="author-grid" class="author-grid" aria-label="Maze author grid"></div>
          </section>
          <section class="author-panel">
            <h2>Text Output</h2>
            <textarea id="raw-output" class="raw-output" readonly spellcheck="false"></textarea>
          </section>
        </section>
      </div>
      <script>window.__AUTHOR_DATA__ = ${serializeForScript(authorData)};</script>
      <script src="/play-core.js" defer></script>
      <script src="/play-render.js" defer></script>
      <script src="/play-gameplay.js" defer></script>
      <script src="/level-preview.js" defer></script>
      <script src="/author.js" defer></script>
    </main>`
  });
}

function renderWorldMapEditorPage(game) {
  const worldMapData = buildMazeWorldMapEditorData(game);
  const startLevelId = defaultLevelIdForGame(game);
  const playLink = startLevelId
    ? `<a class="back-link" href="/play/${encodeURIComponent(game.id)}/${encodeURIComponent(startLevelId)}">Play</a>`
    : "";
  const authorLink = startLevelId
    ? `<a class="back-link" href="/author/${encodeURIComponent(game.id)}/${encodeURIComponent(startLevelId)}">Author</a>`
    : "";

  return renderPage({
    title: `${game.name} World Map`,
    body: `<main class="shell world-map-shell">
      <nav class="page-nav">
        <a class="back-link" href="/games/${encodeURIComponent(game.id)}">Back</a>
        ${playLink}
        ${authorLink}
      </nav>
      <header class="author-header">
        <h1>${escapeHtml(game.name)} World Map</h1>
        <p class="author-subtitle">Move level files around the world without renaming them. The saved layout lives in <code>world_map.json</code>.</p>
      </header>
      <section class="author-toolbar world-map-toolbar">
        <div class="author-toolbar__group">
          <div class="author-meta">
            <span class="author-meta__label">World Size</span>
            <span class="author-meta__value">${MAZE_WORLD_CONFIG.worldColumns.length} x ${MAZE_WORLD_CONFIG.worldRows.length}</span>
          </div>
          <div class="author-meta">
            <span class="author-meta__label">Placed Files</span>
            <span id="world-map-count" class="author-meta__value"></span>
          </div>
        </div>
        <div class="author-toolbar__group">
          <button id="world-map-unmap" class="tool-button" type="button">Unmap Selected</button>
          <button id="world-map-reset" class="tool-button" type="button">Reset</button>
          <button id="world-map-save" class="tool-button tool-button--primary" type="button">Save</button>
        </div>
      </section>
      <p id="world-map-status" class="author-status" role="status" aria-live="polite"></p>
      <div class="world-map-layout">
        <aside class="world-map-sidebar">
          <section class="author-panel">
            <h2>Selected Slot</h2>
            <p id="world-map-selection" class="author-panel__copy"></p>
            <div class="world-map-selection__links">
              <a id="world-map-play-link" class="author-level-pill" href="#">Play Slot</a>
              <a id="world-map-author-link" class="author-level-pill" href="#">Author Slot</a>
            </div>
          </section>
          <section class="author-panel">
            <h2>Placed Tiles</h2>
            <div id="world-map-placed" class="world-map-list"></div>
          </section>
          <section class="author-panel">
            <h2>Unplaced Files</h2>
            <div id="world-map-unplaced" class="world-map-list"></div>
          </section>
        </aside>
        <section class="world-map-workspace">
          <section class="author-grid-shell world-map-grid-shell">
            <div class="world-map-canvas">
              <div class="world-map-corner" aria-hidden="true"></div>
              <div id="world-map-columns" class="world-map-axis world-map-axis--columns" aria-hidden="true"></div>
              <div id="world-map-rows" class="world-map-axis world-map-axis--rows" aria-hidden="true"></div>
              <div id="world-map-grid" class="world-map-grid" aria-label="World map grid"></div>
            </div>
          </section>
        </section>
      </div>
      <script>window.__WORLD_MAP_EDITOR_DATA__ = ${serializeForScript(worldMapData)};</script>
      <script src="/world-map.js" defer></script>
    </main>`
  });
}

function renderNotFound() {
  return renderPage({
    title: "Not Found",
    body: `<main class="shell">
      <h1>Not Found</h1>
    </main>`
  });
}

const server = http.createServer(async (request, response) => {
  try {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const segments = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/styles.css") {
    sendFile(response, path.join(PUBLIC_DIR, "styles.css"), "text/css; charset=utf-8");
    return;
  }

  if (url.pathname === "/play.js") {
    sendFile(response, path.join(PUBLIC_DIR, "play.js"), "application/javascript; charset=utf-8");
    return;
  }

  if (url.pathname === "/play-core.js") {
    sendFile(
      response,
      path.join(PUBLIC_DIR, "play-core.js"),
      "application/javascript; charset=utf-8"
    );
    return;
  }

  if (url.pathname === "/play-render.js") {
    sendFile(
      response,
      path.join(PUBLIC_DIR, "play-render.js"),
      "application/javascript; charset=utf-8"
    );
    return;
  }

  if (url.pathname === "/play-gameplay.js") {
    sendFile(
      response,
      path.join(PUBLIC_DIR, "play-gameplay.js"),
      "application/javascript; charset=utf-8"
    );
    return;
  }

  if (url.pathname === "/author.js") {
    sendFile(response, path.join(PUBLIC_DIR, "author.js"), "application/javascript; charset=utf-8");
    return;
  }

  if (url.pathname === "/world-map.js") {
    sendFile(
      response,
      path.join(PUBLIC_DIR, "world-map.js"),
      "application/javascript; charset=utf-8"
    );
    return;
  }

  if (url.pathname === "/level-preview.js") {
    sendFile(
      response,
      path.join(PUBLIC_DIR, "level-preview.js"),
      "application/javascript; charset=utf-8"
    );
    return;
  }

  if (segments.length >= 3 && segments[0] === "assets") {
    const gameId = segments[1];
    const relativePath = segments.slice(2).map(decodeURIComponent).join(path.sep);
    const assetPath = resolveGameAssetPath(gameId, relativePath);

    if (!assetPath) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    sendFile(response, assetPath, getContentType(assetPath));
    return;
  }

  if (url.pathname === "/") {
    sendHtml(response, 200, renderHomePage());
    return;
  }

  if (segments.length === 3 && segments[0] === "games" && segments[2] === "level_parsing.json") {
    const parserPath = path.join(GAMES_DIR, segments[1], "level_parsing.json");
    if (!fs.existsSync(parserPath)) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    sendJson(response, 200, loadJson(parserPath, {}));
    return;
  }

  if (segments.length === 2 && segments[0] === "games") {
    const game = getGame(segments[1]);
    if (!game) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    sendHtml(response, 200, renderGamePage(game));
    return;
  }

  if (segments.length === 2 && segments[0] === "author") {
    const game = getGame(segments[1]);
    if (!game || game.id !== "maze") {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    const level = getEditableLevel(game, MAZE_DEFAULT_LEVEL_ID);
    if (!level) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    sendHtml(response, 200, renderAuthorPage(game, level));
    return;
  }

  if (segments.length === 2 && segments[0] === "world-map") {
    const game = getGame(segments[1]);
    if (!game || game.id !== "maze") {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    sendHtml(response, 200, renderWorldMapEditorPage(game));
    return;
  }

  if (segments.length === 3 && segments[0] === "author") {
    const game = getGame(segments[1]);
    if (!game || game.id !== "maze") {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    if (!isMazeWorldLevelId(segments[2])) {
      sendRedirect(
        response,
        `/author/${encodeURIComponent(game.id)}/${encodeURIComponent(MAZE_DEFAULT_LEVEL_ID)}`
      );
      return;
    }

    const level = getEditableLevel(game, segments[2]);
    if (!level) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    sendHtml(response, 200, renderAuthorPage(game, level));
    return;
  }

  if (segments.length === 2 && segments[0] === "play") {
    const game = getGame(segments[1]);
    if (!game) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    const levelId = defaultLevelIdForGame(game);
    if (!levelId) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    sendRedirect(response, `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(levelId)}`);
    return;
  }

  if (segments.length === 3 && segments[0] === "play") {
    const game = getGame(segments[1]);
    if (!game) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    if (game.id === "maze" && !isMazeWorldLevelId(segments[2])) {
      sendRedirect(
        response,
        `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(defaultLevelIdForGame(game))}`
      );
      return;
    }

    const level = getLevel(game, segments[2]);
    if (!level) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    sendHtml(response, 200, renderPlayPage(game, level));
    return;
  }

  if (segments.length === 4 && segments[0] === "api" && segments[1] === "play") {
    const game = getGame(segments[2]);
    if (!game) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    if (game.id === "maze" && !isMazeWorldLevelId(segments[3])) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    const level = getLevel(game, segments[3]);
    if (!level) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    sendJson(response, 200, getLevelState(game, level));
    return;
  }

  if (
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "author" &&
    segments[4] === "preview"
  ) {
    const game = getGame(segments[2]);
    if (!game || game.id !== "maze" || !isMazeWorldLevelId(segments[3])) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
      response.end();
      return;
    }

    const level = getLevel(game, segments[3]);
    if (!level) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    const payload = await readJsonBody(request);
    writeMazePreviewImageData(level, payload?.imageDataUrl);
    sendJson(response, 200, {
      fileName: level.fileName,
      levelId: level.id,
      message: `Saved preview for ${level.fileName}.`,
      previewUrl: buildMazePreviewData(game, level.fileName).previewUrl
    });
    return;
  }

  if (segments.length === 4 && segments[0] === "api" && segments[1] === "author") {
    const game = getGame(segments[2]);
    if (!game || game.id !== "maze" || !isMazeWorldLevelId(segments[3])) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    if (request.method === "GET") {
      const level = getEditableLevel(game, segments[3]);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      sendJson(response, 200, getLevelEditorState(game, level));
      return;
    }

    if (request.method === "POST") {
      const payload = await readJsonBody(request);
      const level = getEditableLevel(game, segments[3], payload?.fileName);
      if (!level) {
        sendHtml(response, 404, renderNotFound());
        return;
      }

      const editorState = sanitizeEditorPayload(game, payload);
      const levelPath = getLevelFilePath(game, level);
      fs.writeFileSync(levelPath, editorState.rawText, "utf8");
      ensureMazeWorldLevelMapped(level);
      sendJson(response, 200, {
        ...getLevelEditorState(game, level),
        message: `Saved ${level.fileName}.`,
        playUrl: `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(level.id)}`
      });
      return;
    }

    response.writeHead(405, { Allow: "GET, POST" });
    response.end();
    return;
  }

  if (segments.length === 3 && segments[0] === "api" && segments[1] === "world-map") {
    const game = getGame(segments[2]);
    if (!game || game.id !== "maze") {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    if (request.method === "GET") {
      sendJson(response, 200, buildMazeWorldMapEditorData(game));
      return;
    }

    if (request.method === "POST") {
      const payload = await readJsonBody(request);
      const rawLevels =
        payload && Object.prototype.hasOwnProperty.call(payload, "entries")
          ? payload.entries
          : payload?.levels;
      const entries = validateMazeWorldMapEntries(game.levelFiles, rawLevels);
      writeMazeWorldMap(entries);
      sendJson(
        response,
        200,
        buildMazeWorldMapEditorData(getGame(game.id), {
          message: `Saved world_map.json with ${entries.length} placed tile${entries.length === 1 ? "" : "s"}.`
        })
      );
      return;
    }

    response.writeHead(405, { Allow: "GET, POST" });
    response.end();
    return;
  }

  sendHtml(response, 404, renderNotFound());
  } catch (error) {
    const statusCode = error?.message === "Request body is too large." ? 413 : 400;
    sendJson(response, statusCode, {
      error: error instanceof Error ? error.message : "Something went wrong."
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PixelGameTest running at http://${HOST}:${PORT}`);
});
