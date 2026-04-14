const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const ROOT_DIR = __dirname;
const GAMES_DIR = path.join(ROOT_DIR, "games");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);

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

function parseLevelRows(parser, rawLevel) {
  const separator = parser?.rules?.separator;

  if (separator === "") {
    return rawLevel.split(/\r?\n/).filter((row) => row.length > 0);
  }

  if (typeof separator === "string" && separator.length > 0) {
    return rawLevel.split(separator).filter((row) => row.length > 0);
  }

  return rawLevel.split(/\r?\n/).filter((row) => row.length > 0);
}

function getObjectDefinitions(game) {
  const definitions = Object.entries(game.parser?.objects || {}).map(([name, config]) => {
    const relativeImagePath = typeof config?.image === "string" ? config.image : null;
    const assetPath = relativeImagePath ? resolveGameAssetPath(game.id, relativeImagePath) : null;

    return {
      name,
      token: config?.token,
      imageUrl: assetPath ? buildGameAssetUrl(game.id, relativeImagePath) : null,
      label: titleCase(name)
    };
  });

  return {
    byName: new Map(definitions.map((definition) => [definition.name, definition])),
    byToken: new Map(
      definitions
        .filter((definition) => typeof definition.token === "string")
        .map((definition) => [definition.token, definition])
    )
  };
}

function buildTerrainCell(type, definition = null) {
  return {
    type,
    label: definition?.label || titleCase(type),
    imageUrl: definition?.imageUrl || null
  };
}

function getLevelState(game, level) {
  const levelPath = path.join(GAMES_DIR, game.id, "levels", level.fileName);
  const rawLevel = loadText(levelPath, "");
  const rows = parseLevelRows(game.parser, rawLevel);
  const columnCount = rows.reduce((maxColumns, row) => Math.max(maxColumns, row.length), 0);
  const definitions = getObjectDefinitions(game);
  const floorDefinition = definitions.byName.get("floor") || null;
  const exitDefinition = definitions.byName.get("exit") || null;
  const terrain = [];
  const actors = [];

  rows.forEach((row, y) => {
    const terrainRow = [];

    Array.from({ length: columnCount }, (_, index) => {
        const token = row[index] || " ";
        const definition = definitions.byToken.get(token);

        if (!definition) {
          terrainRow.push(buildTerrainCell("empty"));
          return;
        }

        if (definition.name === "player") {
          terrainRow.push(buildTerrainCell("floor", floorDefinition));
          actors.push({
            type: "player",
            label: definition.label,
            imageUrl: definition.imageUrl,
            x: index,
            y
          });
          return;
        }

        if (definition.name === "exit") {
          terrainRow.push(buildTerrainCell("exit", exitDefinition || definition));
          return;
        }

        terrainRow.push(buildTerrainCell(definition.name, definition));
      });

    terrain.push(terrainRow);
  });

  return {
    width: columnCount,
    height: rows.length,
    terrain,
    actors
  };
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
      return {
        fileName,
        id: levelId,
        number,
        label: typeof number === "number" ? `Level ${number}` : `Level ${levelId}`,
        playUrl: `/play/${gameId}/${levelId}`
      };
    })
  };
}

function getLevel(game, levelId) {
  return game.levels.find((level) => level.id === levelId) || null;
}

function sendHtml(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
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
      (game) => `<a class="game-link" href="/games/${encodeURIComponent(game.id)}">
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
  const levels = game.levels
    .map(
      (level) => `<li><a href="${escapeHtml(level.playUrl)}">${escapeHtml(level.label)}</a></li>`
    )
    .join("");

  return renderPage({
    title: game.name,
    body: `<main class="shell">
      <h1>${escapeHtml(game.name)}</h1>
      <section class="stack">
        <h2>Levels</h2>
        <ul class="level-list">${levels}</ul>
      </section>
      <section class="stack">
        <h2>Level parsing JSON</h2>
        <p><a href="${escapeHtml(game.parserUrl)}">Open raw JSON</a></p>
        <pre>${escapeHtml(JSON.stringify(game.parser, null, 2))}</pre>
      </section>
    </main>`
  });
}

function renderPlayPage(game, level) {
  const levelState = getLevelState(game, level);
  const boardMarkup =
    levelState.width > 0 && levelState.height > 0
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
        <script src="/play.js" defer></script>`
      : `<section class="play-stage"><p>This level is empty.</p></section>`;

  return renderPage({
    title: `${game.name} ${level.label}`,
    bodyClass: "play-body",
    body: `<main class="play-shell">
      <header class="play-header">
        <h1>${escapeHtml(game.name)}</h1>
        <p>${escapeHtml(level.label)}</p>
        <p>${escapeHtml(game.player)}</p>
      </header>
      ${boardMarkup}
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

const server = http.createServer((request, response) => {
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

  if (segments.length === 3 && segments[0] === "play") {
    const game = getGame(segments[1]);
    if (!game) {
      sendHtml(response, 404, renderNotFound());
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

  sendHtml(response, 404, renderNotFound());
});

server.listen(PORT, HOST, () => {
  console.log(`PixelGameTest running at http://${HOST}:${PORT}`);
});
