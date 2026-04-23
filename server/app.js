const fs = require("fs");
const path = require("path");
const { createMazeLevelService } = require("./maze-levels");
const { createMazePreviewService } = require("./maze-preview");
const { createMazeWorldMapService } = require("./maze-world-map");
const { createPageRenderer } = require("./pages");
const { createRequestRouter } = require("./router");
const {
  ensureDirectory,
  getContentType,
  listTopLevelFiles,
  loadJson,
  loadText,
  titleCase
} = require("./support");

const ROOT_DIR = path.resolve(__dirname, "..");
const GAMES_DIR = path.join(ROOT_DIR, "games");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const MAZE_DIR = path.join(GAMES_DIR, "maze");
const MAZE_PREVIEWS_DIR = path.join(MAZE_DIR, "previews");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_FILE_ROUTES = new Map(
  [
    "/styles.css",
    "/play.js",
    "/play-rules.js",
    "/play-core.js",
    "/play-render-effects.js",
    "/play-render-terrain.js",
    "/play-render-actors.js",
    "/play-render-compositor.js",
    "/play-render.js",
    "/play-movement.js",
    "/play-world-transitions.js",
    "/play-gameplay.js",
    "/maze-engine.js",
    "/maze-solver.js",
    "/author-play-data.js",
    "/author.js",
    "/world-map.js",
    "/level-preview.js"
  ].map((routePath) => [routePath, path.join(PUBLIC_DIR, routePath.slice(1))])
);

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

const mazePreviewService = createMazePreviewService({
  buildGameAssetUrl,
  ensureDirectory,
  mazePreviewsDir: MAZE_PREVIEWS_DIR
});

const {
  buildMazePreviewData,
  writeMazePreviewImageData
} = mazePreviewService;

const mazeWorldMapService = createMazeWorldMapService({
  buildMazePreviewData,
  listTopLevelFiles,
  loadJson,
  mazeDir: MAZE_DIR
});

const {
  MAZE_DEFAULT_LEVEL_ID,
  buildMazeFallbackLevelFileName,
  buildMazeWorldLevel,
  buildMazeWorldMapEditorData,
  buildMazeWorldMapState,
  defaultLevelIdForGame,
  ensureMazeWorldLevelMapped,
  isMazeWorldLevelId,
  mazeAuthorDefaultHeight,
  mazeAuthorDefaultWidth,
  mazeLevelGridHeight,
  mazeLevelGridWidth,
  mazeLevelLabel,
  mazeWorldConfig,
  validateMazeWorldMapEntries,
  writeMazeWorldMap
} = mazeWorldMapService;

const mazeLevelService = createMazeLevelService({
  buildGameAssetUrl,
  buildMazeFallbackLevelFileName,
  buildMazePreviewData,
  buildMazeWorldLevel,
  buildMazeWorldMapState,
  defaultLevelIdForGame,
  gamesDir: GAMES_DIR,
  isMazeWorldLevelId,
  listTopLevelFiles,
  loadJson,
  loadText,
  mazeAuthorDefaultHeight,
  mazeAuthorDefaultWidth,
  mazeDefaultLevelId: MAZE_DEFAULT_LEVEL_ID,
  mazeLevelGridHeight,
  mazeLevelGridWidth,
  mazeLevelLabel,
  mazeWorldConfig,
  resolveGameAssetPath,
  rootDir: ROOT_DIR,
  titleCase
});

const {
  buildAuthorPageData,
  getEditableLevel,
  getGame,
  getLevel,
  getLevelEditorState,
  getLevelFilePath,
  getLevelState,
  listGames,
  sanitizeEditorPayload
} = mazeLevelService;

const DEFAULT_REQUEST_BODY_MAX_BYTES = 5 * 1024 * 1024;

function readRequestBody(request, options = {}) {
  return new Promise((resolve, reject) => {
    const maxBytes = Number.isFinite(options.maxBytes)
      ? options.maxBytes
      : DEFAULT_REQUEST_BODY_MAX_BYTES;
    let body = "";
    let rejected = false;

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (rejected) {
        return;
      }

      body += chunk;

      if (body.length > maxBytes) {
        rejected = true;
        body = "";
        reject(new Error("Request body is too large."));
        request.resume();
      }
    });
    request.on("end", () => {
      if (!rejected) {
        resolve(body);
      }
    });
    request.on("error", (error) => {
      if (!rejected) {
        rejected = true;
        reject(error);
      }
    });
  });
}

async function readJsonBody(request, options = {}) {
  const body = await readRequestBody(request, options);

  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error("Request body must be valid JSON.");
  }
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

const {
  renderAuthorPage,
  renderGamePage,
  renderHomePage,
  renderNotFound,
  renderPlayPage,
  renderWorldMapEditorPage
} = createPageRenderer({
  buildAuthorPageData,
  buildMazeWorldMapEditorData,
  defaultLevelIdForGame,
  getLevelState,
  listGames,
  mazeLevelGridHeight,
  mazeLevelGridWidth,
  mazeWorldConfig
});

const { handleRequest } = createRequestRouter({
  buildMazePreviewData,
  buildMazeWorldMapEditorData,
  defaultLevelIdForGame,
  ensureMazeWorldLevelMapped,
  getContentType,
  getEditableLevel,
  getGame,
  getLevel,
  getLevelEditorState,
  getLevelFilePath,
  getLevelState,
  gamesDir: GAMES_DIR,
  isMazeWorldLevelId,
  loadJson,
  mazeDefaultLevelId: MAZE_DEFAULT_LEVEL_ID,
  publicFileRoutes: PUBLIC_FILE_ROUTES,
  readJsonBody,
  renderAuthorPage,
  renderGamePage,
  renderHomePage,
  renderNotFound,
  renderPlayPage,
  renderWorldMapEditorPage,
  resolveGameAssetPath,
  sanitizeEditorPayload,
  sendFile,
  sendHtml,
  sendJson,
  sendRedirect,
  validateMazeWorldMapEntries,
  writeMazePreviewImageData,
  writeMazeWorldMap
});

function createRequestHandler() {
  return async function requestHandler(request, response) {
    try {
      await handleRequest(request, response);
    } catch (error) {
      const statusCode = error?.message === "Request body is too large." ? 413 : 400;
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : "Something went wrong."
      });
    }
  };
}

module.exports = {
  HOST,
  PORT,
  createRequestHandler,
  handleRequest
};
