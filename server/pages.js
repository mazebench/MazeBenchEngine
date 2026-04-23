const { escapeHtml, serializeForScript } = require("./support");

function createPageRenderer({
  buildAuthorPageData,
  buildMazeWorldMapEditorData,
  defaultLevelIdForGame,
  getLevelState,
  listGames,
  mazeLevelGridHeight,
  mazeLevelGridWidth,
  mazeWorldConfig
}) {
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
          <script src="/play-rules.js" defer></script>
          <script src="/play-core.js" defer></script>
          <script src="/play-render-effects.js" defer></script>
          <script src="/play-render-terrain.js" defer></script>
          <script src="/play-render-actors.js" defer></script>
          <script src="/play-render-compositor.js" defer></script>
          <script src="/play-render.js" defer></script>
          <script src="/play-movement.js" defer></script>
          <script src="/play-world-transitions.js" defer></script>
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
              <input id="board-width" type="number" min="1" max="${mazeLevelGridWidth}" inputmode="numeric">
            </label>
            <label class="field">
              <span>Height</span>
              <input id="board-height" type="number" min="1" max="${mazeLevelGridHeight}" inputmode="numeric">
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
              <div id="author-grid" class="author-grid" aria-label="Maze author grid">
                <canvas id="author-canvas" class="author-grid__canvas"></canvas>
                <div id="author-hit-grid" class="author-grid__hit-grid"></div>
              </div>
            </section>
            <section class="author-panel">
              <h2>Text Output</h2>
              <textarea id="raw-output" class="raw-output" readonly spellcheck="false"></textarea>
            </section>
          </section>
        </div>
        <script>window.__AUTHOR_DATA__ = ${serializeForScript(authorData)};</script>
        <script src="/play-rules.js" defer></script>
        <script src="/play-core.js" defer></script>
        <script src="/play-render-effects.js" defer></script>
        <script src="/play-render-terrain.js" defer></script>
        <script src="/play-render-actors.js" defer></script>
        <script src="/play-render-compositor.js" defer></script>
        <script src="/play-render.js" defer></script>
        <script src="/play-movement.js" defer></script>
        <script src="/play-world-transitions.js" defer></script>
        <script src="/play-gameplay.js" defer></script>
        <script src="/level-preview.js" defer></script>
        <script src="/author-play-data.js" defer></script>
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
              <span class="author-meta__value">${mazeWorldConfig.worldColumns.length} x ${mazeWorldConfig.worldRows.length}</span>
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

  return {
    renderAuthorPage,
    renderGamePage,
    renderHomePage,
    renderNotFound,
    renderPlayPage,
    renderWorldMapEditorPage
  };
}

module.exports = {
  createPageRenderer
};
