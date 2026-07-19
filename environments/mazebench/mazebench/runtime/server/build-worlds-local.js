const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { defaultEditorState } = require("../shared/default-world-template");

// Local Build Mode: each draft world is a full maze-family game directory
// under games/ (gitignored), so play/author/world-map/flyover and the agent
// runner all work on drafts through the same machinery as the master world.
//
// Directory layout for a draft:
//   games/draft-<guid>/
//     draft.json           local metadata + remote sync state
//     level_parsing.json   copied from games/maze at creation time
//     world_parsing.json   this world's grid + level sizes
//     world_map.json       fileName -> [column, row]
//     levels/level_AxA.txt one file per placed level
//     previews/            editor-generated thumbnails
//     images, assets_3d    relative symlinks into ../maze
//
// The interchange format is MazeJam's `mazebench-build-world-v1` editor state,
// so local drafts can be pushed to / pulled from the hosted site verbatim.

const EDITOR_STATE_VERSION = "mazebench-build-world-v1";
const LOCAL_WORLD_ID_PATTERN = /^(draft|online)-[a-z0-9-]{4,40}$/;
const WORLD_LEVEL_ID_PATTERN = /^level_([A-Z])x([A-Z])$/;
const WORLD_AXIS_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SHARED_ASSET_DIRS = ["images", "assets_3d"];

function createLocalBuildWorldService({
  gamesDir,
  getGame,
  getLevelEditorState,
  listTopLevelFiles,
  loadJson,
  sanitizeEditorPayload,
  worldMaps
}) {
  function isLocalWorldGameId(gameId) {
    return LOCAL_WORLD_ID_PATTERN.test(String(gameId || ""));
  }

  function localWorldDir(gameId) {
    if (!isLocalWorldGameId(gameId)) {
      throw new Error(`"${gameId}" is not a local world id.`);
    }

    return path.join(gamesDir, gameId);
  }

  function draftMetaPath(gameId) {
    return path.join(localWorldDir(gameId), "draft.json");
  }

  function readDraftMeta(gameId) {
    return loadJson(draftMetaPath(gameId), null);
  }

  function writeDraftMeta(gameId, meta) {
    fs.writeFileSync(draftMetaPath(gameId), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }

  function updateDraftMeta(gameId, patch) {
    const meta = readDraftMeta(gameId) || {};
    const updated = { ...meta, ...patch, updated_at: new Date().toISOString() };
    writeDraftMeta(gameId, updated);
    return updated;
  }

  function generateLocalWorldGameId(prefix = "draft") {
    let gameId = "";

    do {
      const guid = crypto
        .randomBytes(12)
        .toString("base64url")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase()
        .slice(0, 10);
      gameId = `${prefix}-${guid}`;
    } while (gameId.length < prefix.length + 7 || fs.existsSync(path.join(gamesDir, gameId)));

    return gameId;
  }

  function clampWorldDimension(value, fallback) {
    const numeric = Number(value);

    if (!Number.isInteger(numeric)) {
      return fallback;
    }

    return Math.max(1, Math.min(WORLD_AXIS_LETTERS.length, numeric));
  }

  function levelIdForPosition(columnIndex, rowIndex) {
    return `level_${WORLD_AXIS_LETTERS[columnIndex]}x${WORLD_AXIS_LETTERS[rowIndex]}`;
  }

  function parseWorldLevelId(levelId) {
    const match = String(levelId || "").match(WORLD_LEVEL_ID_PATTERN);

    if (!match) {
      return null;
    }

    return {
      column: match[1],
      row: match[2],
      columnIndex: WORLD_AXIS_LETTERS.indexOf(match[1]),
      rowIndex: WORLD_AXIS_LETTERS.indexOf(match[2])
    };
  }

  function ensureSharedAssetLinks(gameId) {
    SHARED_ASSET_DIRS.forEach((dirName) => {
      const linkPath = path.join(localWorldDir(gameId), dirName);

      if (!fs.existsSync(linkPath)) {
        fs.symlinkSync(path.join("..", "maze", dirName), linkPath, "dir");
      }
    });
  }

  function writeWorldParsing(gameId, worldWidth, worldHeight) {
    const mazeConfig = worldMaps.worldConfigForGame("maze");

    fs.writeFileSync(
      path.join(localWorldDir(gameId), "world_parsing.json"),
      `${JSON.stringify(
        {
          rules: {
            world_size: [worldWidth, worldHeight],
            level_size: [mazeConfig.levelSize.width, mazeConfig.levelSize.height],
            camera_view: [mazeConfig.cameraView.width, mazeConfig.cameraView.height]
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  function createLocalWorldSkeleton({ gameId, title, worldWidth, worldHeight, remote = null }) {
    const worldDir = localWorldDir(gameId);

    fs.mkdirSync(path.join(worldDir, "levels"), { recursive: true });
    fs.mkdirSync(path.join(worldDir, "previews"), { recursive: true });
    fs.copyFileSync(
      path.join(gamesDir, "maze", "level_parsing.json"),
      path.join(worldDir, "level_parsing.json")
    );
    writeWorldParsing(gameId, worldWidth, worldHeight);
    ensureSharedAssetLinks(gameId);

    const now = new Date().toISOString();
    writeDraftMeta(gameId, {
      id: gameId,
      title,
      created_at: now,
      updated_at: now,
      remote_id: remote?.id || null,
      remote_updated_at: remote?.updated_at || null,
      remote_status: remote?.status || null
    });
  }

  function removeLocalWorld(gameId) {
    const worldDir = localWorldDir(gameId);

    if (!fs.existsSync(draftMetaPath(gameId))) {
      throw new Error(`"${gameId}" is not a local world (missing draft.json).`);
    }

    fs.rmSync(worldDir, { recursive: true, force: true });
  }

  function normalizeEditorState(editorState) {
    if (!editorState || typeof editorState !== "object") {
      throw new Error("Editor state must be an object.");
    }

    if (editorState.version && editorState.version !== EDITOR_STATE_VERSION) {
      throw new Error(`Unsupported editor state version "${editorState.version}".`);
    }

    const worldWidth = clampWorldDimension(editorState.world?.width, 3);
    const worldHeight = clampWorldDimension(editorState.world?.height, 3);
    const rawLevels = Array.isArray(editorState.levels) ? editorState.levels : [];
    const seenIds = new Set();
    const levels = rawLevels.map((level, index) => {
      const coordinates = parseWorldLevelId(level?.id);

      if (!coordinates) {
        throw new Error(`Level ${index + 1} has an invalid id "${level?.id}".`);
      }

      if (coordinates.columnIndex >= worldWidth || coordinates.rowIndex >= worldHeight) {
        throw new Error(`Level "${level.id}" is outside the ${worldWidth}x${worldHeight} world.`);
      }

      if (seenIds.has(level.id)) {
        throw new Error(`Level "${level.id}" appears more than once.`);
      }

      seenIds.add(level.id);

      if (!Array.isArray(level?.cells)) {
        throw new Error(`Level "${level.id}" is missing a cells array.`);
      }

      return {
        id: level.id,
        column: coordinates.column,
        row: coordinates.row,
        cells: level.cells,
        width: level.width,
        height: level.height
      };
    });

    return {
      title: typeof editorState.title === "string" && editorState.title.trim()
        ? editorState.title.trim()
        : "Untitled World",
      worldWidth,
      worldHeight,
      levels
    };
  }

  function applyEditorStateLevels(gameId, levels) {
    const worldDir = localWorldDir(gameId);
    const levelsDir = path.join(worldDir, "levels");
    const game = getGame(gameId);

    if (!game) {
      throw new Error(`Local world "${gameId}" did not load as a game.`);
    }

    const entries = {};

    levels.forEach((level) => {
      const sanitized = sanitizeEditorPayload(game, {
        cells: level.cells,
        width: level.width ?? (level.cells[0] || []).length,
        height: level.height ?? level.cells.length
      });
      const fileName = `${level.id}.txt`;

      fs.writeFileSync(path.join(levelsDir, fileName), `${sanitized.rawText}\n`, "utf8");
      entries[fileName] = [level.column, level.row];
    });

    // Drop level files that are no longer part of the world.
    const keepFileNames = new Set(Object.keys(entries));
    listTopLevelFiles(levelsDir).forEach((fileName) => {
      if (!keepFileNames.has(fileName)) {
        fs.unlinkSync(path.join(levelsDir, fileName));
      }
    });

    fs.writeFileSync(
      path.join(worldDir, "world_map.json"),
      `${JSON.stringify({ levels: entries }, null, 2)}\n`,
      "utf8"
    );
  }

  function createLocalWorld({ title, worldWidth, worldHeight, editorState = null, prefix = "draft", remote = null }) {
    const fallbackTitle =
      typeof title === "string" && title.trim() ? title.trim() : "Untitled World";
    const fallbackWidth = clampWorldDimension(worldWidth, 3);
    const fallbackHeight = clampWorldDimension(worldHeight, 3);
    const normalized = normalizeEditorState(
      editorState ||
        defaultEditorState({
          height: fallbackHeight,
          title: fallbackTitle,
          width: fallbackWidth
        })
    );
    const gameId = generateLocalWorldGameId(prefix);

    try {
      createLocalWorldSkeleton({
        gameId,
        title: title && String(title).trim() ? String(title).trim() : normalized.title,
        worldWidth: normalized.worldWidth,
        worldHeight: normalized.worldHeight,
        remote
      });

      applyEditorStateLevels(gameId, normalized.levels);
    } catch (error) {
      fs.rmSync(path.join(gamesDir, gameId), { recursive: true, force: true });
      throw error;
    }

    return getGame(gameId);
  }

  function replaceLocalWorldFromEditorState(gameId, editorState, { title = null, remote = null } = {}) {
    const normalized = normalizeEditorState(editorState);

    writeWorldParsing(gameId, normalized.worldWidth, normalized.worldHeight);
    applyEditorStateLevels(gameId, normalized.levels);
    updateDraftMeta(gameId, {
      title: title || normalized.title,
      ...(remote
        ? {
            remote_id: remote.id ?? undefined,
            remote_updated_at: remote.updated_at ?? undefined,
            remote_status: remote.status ?? undefined
          }
        : {})
    });

    return getGame(gameId);
  }

  function editorStateForGame(game) {
    const config = worldMaps.worldConfigForGame(game.id);
    const levels = (game.worldMap?.levels || []).map((level) => {
      const editorLevel = getLevelEditorState(game, level);

      return {
        id: level.id,
        column: level.column,
        row: level.row,
        title: `${level.column}x${level.row}`,
        width: editorLevel.width,
        height: editorLevel.height,
        cells: editorLevel.cells
      };
    });

    return {
      version: EDITOR_STATE_VERSION,
      title: game.name,
      world: {
        width: config.worldSize.width,
        height: config.worldSize.height
      },
      levels
    };
  }

  function createLocalWorldFromGame(sourceGameId, title) {
    const sourceGame = getGame(sourceGameId);

    if (!sourceGame || !sourceGame.worldMap) {
      throw new Error(`"${sourceGameId}" is not a world game.`);
    }

    const editorState = editorStateForGame(sourceGame);

    return createLocalWorld({
      title: title || `Copy of ${sourceGame.name}`,
      editorState
    });
  }

  function countWorldGems(game) {
    const gemTokens = new Set(
      Object.entries(game.parser?.objects || {})
        .filter(([name, config]) => (config?.type || name) === "gem")
        .flatMap(([, config]) =>
          typeof config?.token === "string"
            ? [config.token]
            : (config?.tokens || []).map((entry) => (typeof entry === "string" ? entry : entry?.token))
        )
        .filter(Boolean)
    );
    let total = 0;

    (game.worldMap?.levels || []).forEach((level) => {
      const editorLevel = getLevelEditorState(game, level);

      editorLevel.cells.forEach((row) => {
        row.forEach((cell) => {
          String(cell)
            .split("+")
            .forEach((token) => {
              if (gemTokens.has(token.trim())) {
                total += 1;
              }
            });
        });
      });
    });

    return total;
  }

  function describeLocalWorld(gameId) {
    const meta = readDraftMeta(gameId);
    const game = getGame(gameId);

    if (!meta || !game || !game.worldMap) {
      return null;
    }

    const config = worldMaps.worldConfigForGame(gameId);
    const defaultLevelId = worldMaps.defaultLevelIdForGame(game);
    const levelPreviews = Object.fromEntries(
      (game.worldMap?.levels || [])
        .filter((level) => level.previewUrl)
        .map((level) => [level.id, level.previewUrl])
    );

    return {
      id: gameId,
      title: game.name,
      kind: gameId.startsWith("online-") ? "online" : "draft",
      preview_urls: (game.worldMap?.levels || [])
        .map((level) => level.previewUrl)
        .filter(Boolean)
        .slice(0, 4),
      level_previews: levelPreviews,
      world_width: config.worldSize.width,
      world_height: config.worldSize.height,
      level_count: game.worldMap.levels.length,
      total_gems: countWorldGems(game),
      created_at: meta.created_at || null,
      updated_at: meta.updated_at || null,
      remote_id: meta.remote_id || null,
      remote_updated_at: meta.remote_updated_at || null,
      remote_status: meta.remote_status || null,
      default_level_id: defaultLevelId,
      first_level_id: defaultLevelId,
      play_url: `/play/${encodeURIComponent(gameId)}/${encodeURIComponent(defaultLevelId)}`,
      author_url: `/author/${encodeURIComponent(gameId)}/${encodeURIComponent(defaultLevelId)}`,
      world_map_url: `/world-map/${encodeURIComponent(gameId)}`,
      flyover_url: `/flyover/${encodeURIComponent(gameId)}/${encodeURIComponent(defaultLevelId)}`,
      export_url: `/api/build/worlds/${encodeURIComponent(gameId)}/export`
    };
  }

  function listLocalWorlds() {
    if (!fs.existsSync(gamesDir)) {
      return [];
    }

    return fs
      .readdirSync(gamesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isLocalWorldGameId(entry.name))
      .map((entry) => describeLocalWorld(entry.name))
      .filter(Boolean)
      .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")));
  }

  function touchLocalWorld(gameId) {
    if (isLocalWorldGameId(gameId) && fs.existsSync(draftMetaPath(gameId))) {
      updateDraftMeta(gameId, {});
    }
  }

  return {
    EDITOR_STATE_VERSION,
    countWorldGems,
    createLocalWorld,
    createLocalWorldFromGame,
    describeLocalWorld,
    editorStateForGame,
    isLocalWorldGameId,
    listLocalWorlds,
    normalizeEditorState,
    readDraftMeta,
    removeLocalWorld,
    replaceLocalWorldFromEditorState,
    touchLocalWorld,
    updateDraftMeta
  };
}

module.exports = {
  createLocalBuildWorldService
};
