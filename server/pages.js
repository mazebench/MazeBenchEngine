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
    const edgeToggleMarkup = hasBoard
      ? `<button
            id="edge-toggle"
            class="effect-toggle is-active"
            type="button"
            aria-pressed="true"
            aria-label="Black edges"
            title="Black edges"
          >
            <span class="effect-icon effect-icon--edges" aria-hidden="true"></span>
            <span class="effect-toggle-track" aria-hidden="true">
              <span class="effect-toggle-thumb"></span>
            </span>
          </button>`
      : "";
    const cameraModeToggleMarkup = hasBoard
      ? `<button
            id="camera-mode-toggle"
            class="camera-mode-toggle"
            type="button"
            aria-pressed="true"
            title="Switch camera projection"
          >Perspective</button>`
      : "";
    const resetProgressButtonMarkup = hasBoard
      ? `<button
            id="reset-progress"
            class="progress-reset-button"
            type="button"
            title="Reset collected gems"
          >Reset Progress</button>`
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
          <script src="/play-render-three.js" defer></script>
          <script src="/play-render-compositor.js" defer></script>
          <script src="/play-render.js" defer></script>
          <script src="/maze-engine.js" defer></script>
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
            <a class="back-link" data-play-author-link href="/author/${encodeURIComponent(game.id)}/${encodeURIComponent(level.id)}">Author</a>
            <a class="back-link" href="/world-map/${encodeURIComponent(game.id)}">World Map</a>
            <p>${escapeHtml(level.label)}</p>
            ${resetProgressButtonMarkup}
            ${cameraModeToggleMarkup}
            ${edgeToggleMarkup}
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
      bodyClass: "author-body",
      body: `<main class="shell author-shell">
        <header class="author-header">
          <div class="author-topbar">
            <h1>Editor</h1>
            <nav class="page-nav author-nav" aria-label="Author navigation">
              <a class="back-link" id="author-play-link" href="/play/${encodeURIComponent(game.id)}/${encodeURIComponent(level.id)}">Play</a>
              <a class="back-link" href="/world-map/${encodeURIComponent(game.id)}">World Map</a>
            </nav>
            <button id="undo-level" class="tool-button author-undo-button" type="button" disabled>Undo</button>
            <button id="save-level" class="tool-button tool-button--primary author-save-button" type="button">Save</button>
            <p id="author-status" class="author-status" role="status" aria-live="polite"></p>
            <div id="solver-progress" class="solver-progress" hidden>
              <div
                id="solver-progress-track"
                class="solver-progress__track"
                role="progressbar"
                aria-label="Solver search progress"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow="0"
              >
                <div id="solver-progress-bar" class="solver-progress__bar"></div>
              </div>
              <span id="solver-progress-text" class="solver-progress__text">0 / 1,000,000 states</span>
            </div>
          </div>
        </header>
        <div class="author-layout">
          <aside class="author-sidebar">
            <details class="author-panel author-disclosure author-disclosure--world">
              <summary class="author-disclosure__summary">
                <span>World Slot</span>
              </summary>
              <div class="author-disclosure__body">
                <div id="level-neighbors" class="author-neighbors" aria-label="Neighbor levels">
                  <button class="tool-button author-neighbors__button author-neighbors__button--up" type="button" data-dx="0" data-dy="-1"><span aria-hidden="true">&#8593;</span></button>
                  <button class="tool-button author-neighbors__button author-neighbors__button--left" type="button" data-dx="-1" data-dy="0"><span aria-hidden="true">&#8592;</span></button>
                  <button class="tool-button author-neighbors__button author-neighbors__button--right" type="button" data-dx="1" data-dy="0"><span aria-hidden="true">&#8594;</span></button>
                  <button class="tool-button author-neighbors__button author-neighbors__button--down" type="button" data-dx="0" data-dy="1"><span aria-hidden="true">&#8595;</span></button>
                </div>
              </div>
            </details>
            <details class="author-panel author-disclosure author-panel--palette">
              <summary class="author-disclosure__summary">
                <span>Paint</span>
                <span id="selected-tool-label" class="author-panel__badge"></span>
              </summary>
              <div class="author-disclosure__body">
                <div id="palette" class="palette"></div>
              </div>
            </details>
            <details class="author-panel author-disclosure">
              <summary class="author-disclosure__summary">
                <span>Board</span>
              </summary>
              <div class="author-disclosure__body">
                <div class="author-control-row">
                  <label class="field field--compact">
                    <span>Width</span>
                    <input id="board-width" type="number" min="1" max="${mazeLevelGridWidth}" inputmode="numeric">
                  </label>
                  <label class="field field--compact">
                    <span>Height</span>
                    <input id="board-height" type="number" min="1" max="${mazeLevelGridHeight}" inputmode="numeric">
                  </label>
                  <button id="resize-level" class="tool-button" type="button">Resize</button>
                </div>
                <div class="author-control-row">
                  <button id="clear-level" class="tool-button tool-button--danger" type="button">
                    <span class="tool-button__icon" aria-hidden="true">&#10005;</span>
                    <span>Clear</span>
                  </button>
                  <button id="frame-level" class="tool-button" type="button">
                    <span class="tool-button__icon" aria-hidden="true">&#9633;</span>
                    <span>Frame</span>
                  </button>
                </div>
              </div>
            </details>
            <details class="author-panel author-disclosure">
              <summary class="author-disclosure__summary">
                <span>Transformer</span>
              </summary>
              <div class="author-disclosure__body">
                <div class="author-control-row">
                  <button id="rotate-left" class="tool-button" type="button" title="Rotate level left">
                    <span class="tool-button__icon" aria-hidden="true">&#8634;</span>
                    <span>Rotate Left</span>
                  </button>
                  <button id="rotate-right" class="tool-button" type="button" title="Rotate level right">
                    <span class="tool-button__icon" aria-hidden="true">&#8635;</span>
                    <span>Rotate Right</span>
                  </button>
                  <button id="flip-horizontal" class="tool-button" type="button" title="Mirror level left to right">
                    <span class="tool-button__icon" aria-hidden="true">&#8596;</span>
                    <span>Flip H</span>
                  </button>
                  <button id="flip-vertical" class="tool-button" type="button" title="Mirror level top to bottom">
                    <span class="tool-button__icon" aria-hidden="true">&#8597;</span>
                    <span>Flip V</span>
                  </button>
                </div>
              </div>
            </details>
            <details class="author-panel author-disclosure">
              <summary class="author-disclosure__summary">
                <span>Solver</span>
              </summary>
              <div class="author-disclosure__body">
                <div class="author-control-row">
                  <label class="field">
                    <span>Search states</span>
                    <input id="solver-max-states" type="number" min="1" step="1" value="1000000" inputmode="numeric" aria-label="Solver search state limit">
                  </label>
                  <label class="field">
                    <span>Algorithm</span>
                    <select id="solver-algorithm" aria-label="Solver algorithm">
                      <option value="astar" selected>A*</option>
                      <option value="weighted_astar">Weighted A*</option>
                      <option value="bfs">BFS</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Hill-Climb</span>
                    <select id="hill-climb-mode" aria-label="Hill-Climb mode">
                      <option value="place_gem" selected>Place Gem</option>
                      <option value="fixed_gem">Fixed Gem</option>
                    </select>
                  </label>
                </div>
                <div class="author-control-row">
                  <button id="place-gem" class="tool-button" type="button">Place Gem</button>
                  <button id="hill-climb" class="tool-button" type="button">Hill-Climb</button>
                  <button id="solver-cancel" class="tool-button" type="button" disabled>Cancel</button>
                  <button id="solve-level" class="tool-button" type="button">Solver</button>
                  <button id="play-solution" class="tool-button" type="button">
                    <span class="tool-button__icon" aria-hidden="true">&#9654;</span>
                    <span>Play Solution</span>
                  </button>
                </div>
                <div class="author-control-row">
                  <button id="hill-climb-prev" class="tool-button" type="button" disabled>Prev Result</button>
                  <button id="hill-climb-next" class="tool-button" type="button" disabled>Next Result</button>
                  <span id="hill-climb-result-label" class="author-panel__copy"></span>
                </div>
              </div>
            </details>
            <details class="author-panel author-disclosure">
              <summary class="author-disclosure__summary">
                <span>Cell</span>
              </summary>
              <div class="author-disclosure__body">
                <p id="selected-cell-label" class="author-panel__copy"></p>
                <label class="field">
                  <span>Raw value</span>
                  <input id="cell-value" type="text" spellcheck="false" aria-label="Selected cell raw value">
                </label>
                <button id="apply-cell-value" class="tool-button" type="button">Apply Cell</button>
              </div>
            </details>
            <details class="author-panel author-disclosure author-output-panel">
              <summary class="author-disclosure__summary">
                <span>Text Output</span>
              </summary>
              <div class="author-disclosure__body">
                <textarea id="raw-output" class="raw-output" readonly spellcheck="false"></textarea>
              </div>
            </details>
          </aside>
          <section class="author-workspace">
            <section class="author-stage" aria-label="Level canvas">
              <section class="author-grid-shell">
                <div id="author-grid" class="author-grid" aria-label="Maze author grid">
                  <canvas id="author-canvas" class="author-grid__canvas"></canvas>
                  <div id="author-hit-grid" class="author-grid__hit-grid"></div>
                </div>
              </section>
            </section>
          </section>
        </div>
        <script>window.__AUTHOR_DATA__ = ${serializeForScript(authorData)};</script>
        <script src="/play-rules.js" defer></script>
        <script src="/play-core.js" defer></script>
        <script src="/play-render-effects.js" defer></script>
        <script src="/play-render-terrain.js" defer></script>
        <script src="/play-render-actors.js" defer></script>
        <script src="/play-render-three.js" defer></script>
        <script src="/play-render-compositor.js" defer></script>
        <script src="/play-render.js" defer></script>
        <script src="/maze-engine.js" defer></script>
        <script src="/play-movement.js" defer></script>
        <script src="/play-world-transitions.js" defer></script>
        <script src="/play-gameplay.js" defer></script>
        <script src="/level-preview.js" defer></script>
        <script src="/author-play-data.js" defer></script>
        <script src="/maze-solver.js" defer></script>
        <script src="/author.js" defer></script>
      </main>`
    });
  }

  function renderWorldMapEditorPage(game) {
    const worldMapData = buildMazeWorldMapEditorData(game);

    return renderPage({
      title: `${game.name} World Editor`,
      bodyClass: "author-body",
      body: `<main class="shell world-map-shell">
        <header class="author-header">
          <div class="author-topbar world-map-topbar">
            <h1>World Editor</h1>
            <a id="world-map-play-link" class="back-link world-map-slot-link is-disabled" href="#" aria-disabled="true">Play Slot</a>
            <a id="world-map-author-link" class="back-link world-map-slot-link is-disabled" href="#" aria-disabled="true">Edit Slot</a>
            <button id="world-map-save" class="tool-button tool-button--primary" type="button">Save</button>
            <button id="world-map-deselect" class="tool-button" type="button">Deselect</button>
            <p id="world-map-status" class="sr-only" role="status" aria-live="polite"></p>
          </div>
        </header>
        <div class="world-map-layout">
          <aside class="author-sidebar world-map-sidebar">
            <details class="author-panel author-disclosure world-map-unmapped-panel">
              <summary class="author-disclosure__summary">
                <span>Unmapped Tiles</span>
              </summary>
              <div class="author-disclosure__body">
                <div id="world-map-unplaced" class="world-map-list"></div>
              </div>
            </details>
          </aside>
          <section class="world-map-workspace">
            <section class="author-grid-shell world-map-grid-shell">
              <div class="world-map-canvas">
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
