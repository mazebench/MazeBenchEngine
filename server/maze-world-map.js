const fs = require("fs");
const path = require("path");

const MAZE_LEVEL_ID_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAZE_WORLD_LEVEL_ID_PATTERN = /^level_([A-Z])x([A-Z])$/;
const MAZE_DEFAULT_LEVEL_ID = "level_HxI";

function createMazeWorldMapService({ buildMazePreviewData, listTopLevelFiles, loadJson, mazeDir }) {
  const mazeWorldMapPath = path.join(mazeDir, "world_map.json");

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
    const worldParsing = loadJson(path.join(mazeDir, "world_parsing.json"), {}) || {};
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

  const mazeWorldConfig = loadMazeWorldConfig();
  const mazeLevelGridWidth = mazeWorldConfig.levelSize.width;
  const mazeLevelGridHeight = mazeWorldConfig.levelSize.height;
  const mazeAuthorDefaultWidth = mazeLevelGridWidth;
  const mazeAuthorDefaultHeight = mazeLevelGridHeight;

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

    const column = normalizeMazeWorldAxisValue(value[0], mazeWorldConfig.worldColumns);
    const row = normalizeMazeWorldAxisValue(value[1], mazeWorldConfig.worldRows);

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

  function parseMazeWorldLevelId(levelId) {
    const match = String(levelId || "").match(MAZE_WORLD_LEVEL_ID_PATTERN);

    if (!match) {
      return null;
    }

    const columnIndex = mazeWorldConfig.worldColumns.indexOf(match[1]);
    const rowIndex = mazeWorldConfig.worldRows.indexOf(match[2]);

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
    if (!fs.existsSync(mazeWorldMapPath)) {
      return buildDefaultMazeWorldMapEntries(levelFiles);
    }

    const worldMap = loadJson(mazeWorldMapPath, {}) || {};
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
      mazeWorldMapPath,
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
      message: options.message || "World map ready.",
      playBaseUrl: `/play/${encodeURIComponent(game.id)}`,
      worldColumns: mazeWorldConfig.worldColumns,
      worldRows: mazeWorldConfig.worldRows
    };
  }

  function ensureMazeWorldLevelMapped(level) {
    if (!isMazeWorldLevelId(level?.id)) {
      return;
    }

    const levelFiles = listTopLevelFiles(path.join(mazeDir, "levels"));
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

  return {
    MAZE_DEFAULT_LEVEL_ID,
    buildMazeFallbackLevelFileName,
    buildMazeWorldLevel,
    buildMazeWorldLevelId,
    buildMazeWorldMapEditorData,
    buildMazeWorldMapState,
    compareMazeWorldPositions,
    defaultLevelIdForGame,
    ensureMazeWorldLevelMapped,
    isMazeWorldLevelId,
    loadMazeWorldMapEntries,
    mazeAuthorDefaultHeight,
    mazeAuthorDefaultWidth,
    mazeLevelGridHeight,
    mazeLevelGridWidth,
    mazeLevelLabel,
    mazeWorldConfig,
    normalizeMazeWorldPosition,
    parseMazeWorldLevelId,
    validateMazeWorldMapEntries,
    writeMazeWorldMap
  };
}

module.exports = {
  createMazeWorldMapService
};
