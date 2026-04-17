const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const ROOT_DIR = __dirname;
const GAMES_DIR = path.join(ROOT_DIR, "games");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const MAZE_LEVEL_GRID_SIZE = 26;
const MAZE_WORLD_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAZE_WORLD_LEVEL_ID_PATTERN = /^level_([A-Z])x([A-Z])$/;
const MAZE_DEFAULT_LEVEL_ID = "level_AxA";
const MAZE_AUTHOR_DEFAULT_SIZE = 14;

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

  return {
    column: match[1],
    row: match[2]
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

function buildMazeWorldLevel(levelId) {
  if (!isMazeWorldLevelId(levelId)) {
    return null;
  }

  return {
    fileName: `${levelId}.txt`,
    id: levelId,
    number: levelId,
    label: mazeLevelLabel(levelId),
    playUrl: `/play/maze/${levelId}`
  };
}

function defaultLevelIdForGame(game) {
  if (game?.id === "maze") {
    return MAZE_DEFAULT_LEVEL_ID;
  }

  return game?.levels?.[0]?.id || null;
}

function clampMazeLevelDimension(value, fallback = MAZE_AUTHOR_DEFAULT_SIZE) {
  const numericValue = Number(value);

  if (!Number.isInteger(numericValue)) {
    return fallback;
  }

  return Math.max(1, Math.min(MAZE_LEVEL_GRID_SIZE, numericValue));
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
  const boardSize = game.id === "maze" ? MAZE_LEVEL_GRID_SIZE : Math.max(
    rawRows.length,
    rawRows.reduce((maxColumns, row) => Math.max(maxColumns, row.length), 0)
  );

  Array.from({ length: boardSize }, (_, y) => {
    const row = rawRows[y] || [];
    const terrainRow = [];

    Array.from({ length: boardSize }, (_, index) => {
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
    width: boardSize,
    height: boardSize,
    terrain,
    actors
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
    ? clampMazeLevelDimension(
        rawRows.reduce((maxColumns, row) => Math.max(maxColumns, row.length), 0),
        MAZE_AUTHOR_DEFAULT_SIZE
      )
    : MAZE_AUTHOR_DEFAULT_SIZE;
  const height = exists
    ? clampMazeLevelDimension(rawRows.length, MAZE_AUTHOR_DEFAULT_SIZE)
    : MAZE_AUTHOR_DEFAULT_SIZE;
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
  const width = clampMazeLevelDimension(payload?.width, MAZE_AUTHOR_DEFAULT_SIZE);
  const height = clampMazeLevelDimension(payload?.height, MAZE_AUTHOR_DEFAULT_SIZE);
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
    defaultSize: MAZE_AUTHOR_DEFAULT_SIZE,
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
    letters: Array.from(MAZE_WORLD_LETTERS),
    maxBoardSize: MAZE_LEVEL_GRID_SIZE,
    palette: buildAuthorPalette(game),
    separator:
      typeof game.parser?.rules?.separator === "string" && game.parser.rules.separator.length > 0
        ? game.parser.rules.separator
        : " "
  };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;

      if (body.length > 1024 * 1024) {
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

  const levelFiles = fs.existsSync(levelsDir)
    ? fs
        .readdirSync(levelsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    : [];

  return {
    id: gameId,
    name: titleCase(gameId),
    player: fs.existsSync(path.join(gameDir, "player.py")) ? "Python Player" : "Unknown Player",
    parser: loadJson(parserPath, {}),
    parserUrl: `/games/${gameId}/level_parsing.json`,
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

function getLevel(game, levelId) {
  const requestedLevelId =
    typeof levelId === "string" && levelId.length > 0 ? levelId : defaultLevelIdForGame(game);
  const existingLevel = game.levels.find((level) => level.id === requestedLevelId) || null;

  if (existingLevel) {
    return existingLevel;
  }

  if (game.id === "maze" && isMazeWorldLevelId(requestedLevelId)) {
    return buildMazeWorldLevel(requestedLevelId);
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
      </nav>
      <header class="author-header">
        <h1>${escapeHtml(game.name)} Author</h1>
        <p class="author-subtitle">Paint a maze level, tune the grid, and save a real <code>level_BxB.txt</code> file.</p>
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
          <div class="author-meta">
            <span class="author-meta__label">File</span>
            <span id="current-file-name" class="author-meta__value"></span>
          </div>
        </div>
        <div class="author-toolbar__group">
          <label class="field">
            <span>Width</span>
            <input id="board-width" type="number" min="1" max="${MAZE_LEVEL_GRID_SIZE}" inputmode="numeric">
          </label>
          <label class="field">
            <span>Height</span>
            <input id="board-height" type="number" min="1" max="${MAZE_LEVEL_GRID_SIZE}" inputmode="numeric">
          </label>
          <button id="resize-level" class="tool-button" type="button">Resize</button>
          <button id="clear-level" class="tool-button" type="button">Clear</button>
          <button id="frame-level" class="tool-button" type="button">Frame Walls</button>
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
      <script src="/author.js" defer></script>
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

    const level = getLevel(game, MAZE_DEFAULT_LEVEL_ID);
    if (!level) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    sendHtml(response, 200, renderAuthorPage(game, level));
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

    const level = getLevel(game, segments[2]);
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

    const level = getLevel(game, segments[3]);
    if (!level) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    sendJson(response, 200, getLevelState(game, level));
    return;
  }

  if (segments.length === 4 && segments[0] === "api" && segments[1] === "author") {
    const game = getGame(segments[2]);
    if (!game || game.id !== "maze" || !isMazeWorldLevelId(segments[3])) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    const level = getLevel(game, segments[3]);
    if (!level) {
      sendHtml(response, 404, renderNotFound());
      return;
    }

    if (request.method === "GET") {
      sendJson(response, 200, getLevelEditorState(game, level));
      return;
    }

    if (request.method === "POST") {
      const payload = await readJsonBody(request);
      const editorState = sanitizeEditorPayload(game, payload);
      const levelPath = getLevelFilePath(game, level);
      fs.writeFileSync(levelPath, editorState.rawText, "utf8");
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
