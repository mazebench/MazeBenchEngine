const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PREVIEW_REQUEST_BODY_MAX_BYTES = 20 * 1024 * 1024;

function createRequestRouter({
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
  gamesDir,
  isMazeWorldLevelId,
  loadJson,
  mazeDefaultLevelId,
  publicFileRoutes,
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
}) {
  async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const segments = url.pathname.split("/").filter(Boolean);
    const publicFilePath = publicFileRoutes.get(url.pathname);

    if (publicFilePath) {
      sendFile(response, publicFilePath, getContentType(publicFilePath));
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
      const parserPath = path.join(gamesDir, segments[1], "level_parsing.json");
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

      const level = getEditableLevel(game, mazeDefaultLevelId);
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
          `/author/${encodeURIComponent(game.id)}/${encodeURIComponent(mazeDefaultLevelId)}`
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

      const payload = await readJsonBody(request, { maxBytes: PREVIEW_REQUEST_BODY_MAX_BYTES });
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
  }

  return {
    handleRequest
  };
}

module.exports = {
  createRequestRouter
};
