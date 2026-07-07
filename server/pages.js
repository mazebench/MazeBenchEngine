const { escapeHtml, serializeForScript } = require("./support");
const { accountActionsHtml, pageHead, siteFooter, topbar } = require("./page-chrome");

// Page renderers. The chrome (topbar, footer, fonts, site.css) is ported from
// the MazeJam repo so the local site looks exactly like the hosted one:
//   - site pages load /site.css + /build-theme.css + /local-site.css
//   - the play/flyover pages load the game runtime /styles.css first, then
//     /site.css and /play-theme.css (MazeJam's play page layer)
//   - the author/world-map editors load /styles.css as a structural base and
//     /author-theme.css (MazeJam's editor skin) on top
function createPageRenderer({
  agentEnvironment,
  buildAuthorPageData,
  buildMazeWorldMapEditorData,
  buildWorlds,
  getGame,
  getLevelState,
  listGames,
  remote,
  worldMaps
}) {
  const defaultLevelIdForGame = (game) => worldMaps.defaultLevelIdForGame(game);

  function remoteStatusSafe() {
    try {
      return remote.getStatus();
    } catch (error) {
      return { connected: false };
    }
  }

  const RUNTIME_SCRIPTS = `<script src="/play-rules.js" defer></script>
          <script src="/play-core.js" defer></script>
          <script src="/play-render-effects.js" defer></script>
          <script src="/play-render-terrain.js" defer></script>
          <script src="/play-render-actors.js" defer></script>
          <script src="/play-render-three.js" defer></script>
          <script src="/play-render-compositor.js" defer></script>
          <script src="/play-render.js" defer></script>
          <script src="/maze-engine.js" defer></script>`;

  function renderSitePage({ title, description = "", main, bodyClass = "", extraHeadHtml = "" }) {
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    ${pageHead({
      title,
      description,
      extraHeadHtml: `<link rel="stylesheet" href="/build-theme.css">
    <link rel="stylesheet" href="/local-site.css">
    ${extraHeadHtml}`
    })}
  </head>
  <body class="${escapeHtml(bodyClass)}">
    ${topbar({ rightHtml: accountActionsHtml(remoteStatusSafe()) })}
    <main class="page-shell">
      ${main}
    </main>
    ${siteFooter()}
  </body>
</html>`;
  }

  function worldCardMosaic(game) {
    const previews = (game?.worldMap?.levels || [])
      .map((level) => level.previewUrl)
      .filter(Boolean)
      .slice(0, 4);

    if (!previews.length) {
      return `<div class="screen-nosignal"><span class="glyph">▦</span></div>`;
    }

    return `<div class="screen-mosaic" data-count="${previews.length}">${previews
      .map((url) => `<img class="mosaic-cell" src="${escapeHtml(url)}" alt="" loading="lazy">`)
      .join("")}</div>`;
  }

  function worldCard({ game, title, subtitle, badges = [], tags = [], stats = [], actions = [], playUrl }) {
    const badgeHtml = badges
      .map((badge) => `<span class="badge">${escapeHtml(badge)}</span>`)
      .join("");
    const tagHtml = tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
    const statsHtml = stats
      .map(([value, label]) => `<span><b>${escapeHtml(value)}</b> ${escapeHtml(label)}</span>`)
      .join("");
    const actionsHtml = actions
      .filter(([, href]) => Boolean(href))
      .map(([label, href, extraClass]) =>
        `<a class="button${extraClass ? ` ${extraClass}` : ""}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
      )
      .join("");

    return `<div class="world-card">
        <a class="card-screen" href="${escapeHtml(playUrl)}" aria-label="Play ${escapeHtml(title)}">
          ${worldCardMosaic(game)}
          <div class="screen-fx"></div>
          <div class="screen-badges">${badgeHtml}</div>
          <div class="screen-play">PLAY</div>
        </a>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(title)}</h3>
          ${subtitle ? `<p class="card-by">${escapeHtml(subtitle)}</p>` : ""}
          ${statsHtml ? `<div class="card-stats">${statsHtml}</div>` : ""}
          ${tagHtml ? `<div class="tags">${tagHtml}</div>` : ""}
          ${actionsHtml ? `<div class="card-actions">${actionsHtml}</div>` : ""}
        </div>
      </div>`;
  }

  function renderHomePage() {
    const otherGames = listGames().filter((game) => !game.worldMap);
    const otherGamesSection = otherGames.length
      ? `<section class="panel">
          <h2>Other Games</h2>
          <div class="card-actions">${otherGames
            .map(
              (game) =>
                `<a class="button" href="/games/${encodeURIComponent(game.id)}">${escapeHtml(game.name)}</a>`
            )
            .join("")}</div>
        </section>`
      : "";

    const modeCard = (href, title, copy) => `<a class="world-card mode-card-link" href="${href}">
        <div class="card-body">
          <h3 class="card-title">${title}</h3>
          <p class="card-by">${copy}</p>
        </div>
      </a>`;

    return renderSitePage({
      title: "Maze Bench",
      main: `<div class="page-head">
          <h1>Maze Bench</h1>
          <p class="page-sub">Ice-maze puzzles, a world editor, and a benchmark arena for coding agents — running locally.</p>
        </div>
        <div class="world-grid">
          ${modeCard("/play", "Play", "Play the master world, your local drafts, or worlds from mazebench.com.")}
          ${modeCard("/build", "Build", "Make and save worlds locally, edit the master world, and sync drafts with your account.")}
          ${modeCard("/agent", "Agent", "Run Codex, Claude Code, or Prime Verifiers on any world and watch live.")}
        </div>
        ${otherGamesSection}`
    });
  }

  function renderPlayModePage() {
    const masterGame = getGame("maze");
    const cards = [];

    if (masterGame) {
      const masterLevel = defaultLevelIdForGame(masterGame);
      cards.push(
        worldCard({
          game: masterGame,
          title: masterGame.name,
          subtitle: "The world agents are benchmarked on",
          badges: ["ENVIRONMENT"],
          stats: [[String(masterGame.worldMap?.levels?.length || 0), "levels"]],
          playUrl: `/play/maze/${encodeURIComponent(masterLevel)}`,
          actions: [
            ["Play", `/play/maze/${encodeURIComponent(masterLevel)}`],
            ["Flyover", `/flyover/maze/${encodeURIComponent(masterLevel)}`]
          ]
        })
      );
    }

    buildWorlds.listLocalWorlds().forEach((world) => {
      const game = getGame(world.id);

      if (!game || !game.worldMap) {
        return;
      }

      cards.push(
        worldCard({
          game,
          title: world.title,
          subtitle: world.kind === "online" ? "Downloaded from mazebench.com" : "Local draft world",
          badges: [`SIZE ${world.world_width}x${world.world_height}`],
          tags: [world.kind === "online" ? "ONLINE COPY" : "DRAFT", ...(world.remote_id ? ["SYNCED"] : [])],
          stats: [[String(world.level_count), world.level_count === 1 ? "level" : "levels"]],
          playUrl: world.play_url,
          actions: [
            ["Play", world.play_url],
            ["Flyover", world.flyover_url]
          ]
        })
      );
    });

    return renderSitePage({
      title: "Play — Maze Bench",
      main: `<div class="page-head">
          <h1>Play</h1>
          <p class="page-sub">Pick a world. Drafts you make in Build Mode show up here automatically.</p>
        </div>
        <div class="world-grid">${cards.join("")}</div>
        ${
          cards.length <= 1
            ? `<div class="empty-state"><span class="glyph">▦</span><p>No local worlds yet — create one in <a class="text-link" href="/build">Build Mode</a>.</p></div>`
            : ""
        }`
    });
  }

  function renderGamePage(game) {
    const startLevelId = defaultLevelIdForGame(game);
    const links = [
      startLevelId ? ["Play", `/play/${encodeURIComponent(game.id)}/${encodeURIComponent(startLevelId)}`] : null,
      game.worldMap && startLevelId
        ? ["Edit Levels", `/author/${encodeURIComponent(game.id)}/${encodeURIComponent(startLevelId)}`]
        : null,
      game.worldMap ? ["World Map", `/world-map/${encodeURIComponent(game.id)}`] : null
    ].filter(Boolean);
    const levelsSection = game.worldMap
      ? ""
      : `<section class="panel">
          <h2>Levels</h2>
          <ul>${game.levels
            .map(
              (level) => `<li><a class="text-link" href="${escapeHtml(level.playUrl)}">${escapeHtml(level.label)}</a></li>`
            )
            .join("")}</ul>
        </section>`;

    return renderSitePage({
      title: `${game.name} — Maze Bench`,
      main: `<div class="page-head">
          <h1>${escapeHtml(game.name)}</h1>
        </div>
        <section class="panel">
          <div class="card-actions">${links
            .map(([label, href]) => `<a class="button" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`)
            .join("")}</div>
        </section>
        ${levelsSection}`
    });
  }

  function playChromeHead(title) {
    return `<meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="theme-color" content="#070811">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>
    <link rel="stylesheet" href="/styles.css">
    <link rel="stylesheet" href="/site.css">
    <link rel="stylesheet" href="/play-theme.css">
    <link rel="stylesheet" href="/local-site.css">`;
  }

  function renderPlayPage(game, level) {
    const levelState = getLevelState(game, level);
    const hasBoard = levelState.width > 0 && levelState.height > 0;
    const controlsMarkup = hasBoard
      ? `<div class="play-header">
          <div class="play-header-meta">
            <a class="back-link" data-play-author-link href="/author/${encodeURIComponent(game.id)}/${encodeURIComponent(level.id)}">Edit</a>
            <a class="back-link" href="/world-map/${encodeURIComponent(game.id)}">Map</a>
            <p>${escapeHtml(level.label)}</p>
            <button id="reset-progress" class="progress-reset-button" type="button" title="Reset collected gems">Reset</button>
            <button id="camera-mode-toggle" class="camera-mode-toggle" type="button" aria-pressed="true" title="Switch camera projection">Perspective</button>
            <button id="edge-toggle" class="effect-toggle is-active" type="button" aria-pressed="true" aria-label="Black edges" title="Black edges">Edges</button>
            <button id="fuzzy-toggle" class="effect-toggle is-active" type="button" aria-pressed="true" aria-label="Fuzzy noise" title="Fuzzy">Fuzzy</button>
          </div>
        </div>`
      : "";
    const boardMarkup = hasBoard
      ? `<main id="game-root" class="is-fullbleed">
        <div class="play-shell">
          <section class="play-stage" aria-label="${escapeHtml(game.name)} board">
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
        </div>
      </main>
      <script>window.__PLAY_DATA__ = ${serializeForScript(levelState)};</script>
      ${RUNTIME_SCRIPTS}
      <script src="/play-movement.js" defer></script>
      <script src="/play-world-transitions.js" defer></script>
      <script src="/play-gameplay.js" defer></script>
      <script src="/play.js" defer></script>`
      : `<main class="page-shell"><section class="panel"><p>This level is empty.</p></section></main>`;

    return `<!DOCTYPE html>
<html lang="en" class="play-mode">
  <head>
    ${playChromeHead(`${game.name} ${level.label} — Maze Bench`)}
  </head>
  <body class="play-body play-mode">
    ${topbar({ rightHtml: accountActionsHtml(remoteStatusSafe()), extraHtml: controlsMarkup })}
    ${boardMarkup}
  </body>
</html>`;
  }

  function renderFlyoverPage(game, level) {
    const levelState = {
      ...getLevelState(game, level),
      flyover: true,
      flyoverRadius: 3
    };
    const hasBoard = levelState.width > 0 && levelState.height > 0;
    const boardMarkup = hasBoard
      ? `<main id="game-root" class="is-fullbleed">
        <div class="play-shell flyover-shell">
          <section class="play-stage flyover-stage" aria-label="${escapeHtml(game.name)} flyover">
            <div class="maze-frame flyover-frame">
              <canvas
                id="maze-canvas"
                class="maze-canvas"
                width="${levelState.width * 64}"
                height="${levelState.height * 64}"
                aria-label="${escapeHtml(game.name)} flyover"
              ></canvas>
            </div>
            <div class="flyover-hud"></div>
          </section>
        </div>
      </main>
      <script>window.__PLAY_DATA__ = ${serializeForScript(levelState)};</script>
      ${RUNTIME_SCRIPTS}
      <script src="/flyover.js" defer></script>`
      : `<main class="page-shell"><section class="panel"><p>This level is empty.</p></section></main>`;

    return `<!DOCTYPE html>
<html lang="en" class="play-mode">
  <head>
    ${playChromeHead(`${game.name} Flyover — Maze Bench`)}
  </head>
  <body class="play-body play-mode flyover-body">
    ${topbar({
      rightHtml: accountActionsHtml(remoteStatusSafe()),
      extraHtml: `<div class="play-header"><div class="play-header-meta"><p>${escapeHtml(game.name)} flyover</p></div></div>`
    })}
    ${boardMarkup}
  </body>
</html>`;
  }

  function editorChromeHead(title) {
    return `<meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="theme-color" content="#070811">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>
    <link rel="stylesheet" href="/styles.css">
    <link rel="stylesheet" href="/site.css">
    <link rel="stylesheet" href="/author-theme.css">
    <link rel="stylesheet" href="/local-site.css">`;
  }

  function renderAuthorPage(game, level) {
    const authorData = buildAuthorPageData(game, level);
    const worldConfig = worldMaps.worldConfigForGame(game.id);
    const backUrl = buildWorlds.isLocalWorldGameId(game.id) ? "/build" : "/build";

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    ${editorChromeHead(`${game.name} — Maze Bench Editor`)}
  </head>
  <body class="author-body">
    <div class="build-mobile-blocker">
      <div class="build-mobile-blocker__panel">
        <h1>Maze Bench Editor</h1>
        <p>The world editor needs a desktop-sized screen and a mouse or trackpad.</p>
        <p><a class="back-link" href="/build">Back to Build</a></p>
      </div>
    </div>
    <main class="author-shell">
      <header class="author-header">
        <div class="author-topbar">
          <h1>${escapeHtml(game.name)}</h1>
          <nav class="page-nav author-nav" aria-label="Author navigation">
            <a class="back-link" href="${backUrl}">Build</a>
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
                  <input id="board-width" type="number" min="1" max="${worldConfig.gridWidth}" inputmode="numeric">
                </label>
                <label class="field field--compact">
                  <span>Height</span>
                  <input id="board-height" type="number" min="1" max="${worldConfig.gridHeight}" inputmode="numeric">
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
      ${RUNTIME_SCRIPTS}
      <script src="/play-movement.js" defer></script>
      <script src="/play-world-transitions.js" defer></script>
      <script src="/play-gameplay.js" defer></script>
      <script src="/level-preview.js" defer></script>
      <script src="/author-play-data.js" defer></script>
      <script src="/maze-solver.js" defer></script>
      <script src="/author.js" defer></script>
    </main>
  </body>
</html>`;
  }

  function renderWorldMapEditorPage(game) {
    const worldMapData = buildMazeWorldMapEditorData(game);

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    ${editorChromeHead(`${game.name} World Map — Maze Bench`)}
  </head>
  <body class="author-body world-map-body">
    <main class="world-map-shell">
      <header class="author-header">
        <div class="author-topbar world-map-topbar">
          <h1>World Map</h1>
          <nav class="page-nav author-nav" aria-label="World map navigation">
            <a class="back-link" href="/build">Build</a>
            <a class="back-link" href="/play/${encodeURIComponent(game.id)}/${encodeURIComponent(defaultLevelIdForGame(game))}">Play</a>
          </nav>
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
    </main>
  </body>
</html>`;
  }

  function renderBuildPage() {
    const buildData = {
      apiUrl: "/api/build/worlds",
      worlds: buildWorlds.listLocalWorlds(),
      remote: remoteStatusSafe()
    };

    const masterGame = getGame("maze");
    const masterSection = masterGame
      ? `<section class="panel" aria-label="Maze Bench Environment">
          <h2>Maze Bench Environment</h2>
          <p class="muted" style="margin-top: -4px">The master benchmark world. Edits here change the world agents are scored on.</p>
          <div class="world-grid">${worldCard({
            game: masterGame,
            title: masterGame.name,
            subtitle: "The world agents are benchmarked on",
            badges: ["ENVIRONMENT"],
            stats: [[String(masterGame.worldMap?.levels?.length || 0), "levels"]],
            playUrl: `/play/maze/${encodeURIComponent(defaultLevelIdForGame(masterGame))}`,
            actions: [
              ["Edit Levels", `/author/maze/${encodeURIComponent(defaultLevelIdForGame(masterGame))}`],
              ["World Map", "/world-map/maze"],
              ["Play", `/play/maze/${encodeURIComponent(defaultLevelIdForGame(masterGame))}`],
              ["Flyover", `/flyover/maze/${encodeURIComponent(defaultLevelIdForGame(masterGame))}`]
            ]
          })}</div>
        </section>`
      : "";

    return renderSitePage({
      title: "Build — Maze Bench",
      main: `<div class="page-head">
          <h1>Build</h1>
          <p class="page-sub">Worlds live in this repo under <span class="mono">games/</span> and never publish anywhere unless you push them.</p>
          <p id="build-status" class="author-status" role="status" aria-live="polite"></p>
        </div>
        ${masterSection}
        <section class="panel" aria-label="My worlds">
          <h2>My Worlds</h2>
          <div id="build-worlds" class="world-grid"></div>
        </section>
        <section class="panel" aria-label="New world">
          <h2>New World</h2>
          <div class="form-grid">
            <label class="field"><span>Title</span><input id="new-world-title" type="text" placeholder="My World"></label>
            <label class="field"><span>Columns</span><input id="new-world-width" type="number" min="1" max="26" value="3" inputmode="numeric"></label>
            <label class="field"><span>Rows</span><input id="new-world-height" type="number" min="1" max="26" value="3" inputmode="numeric"></label>
            <button id="create-world" class="button--primary" type="button">Create World</button>
          </div>
          <div class="card-actions" style="margin-top: 12px">
            <button id="copy-master" type="button">Duplicate Maze Bench Environment</button>
            <button id="import-world" type="button">Import World JSON</button>
            <input id="import-world-file" type="file" accept="application/json,.json" hidden>
          </div>
          <div class="online-pull" style="margin-top: 14px">
            <label class="field"><span>Or download a published world from ${escapeHtml(
              (remoteStatusSafe().origin || "https://dev.mazebench.com").replace(/^https?:\/\//, "")
            )} by id to edit</span><input id="download-world-id" type="text" placeholder="mbw_…" autocomplete="off" spellcheck="false"></label>
            <button id="download-world" type="button">Download &amp; Edit</button>
          </div>
        </section>
        <script>window.__BUILD_DATA__ = ${serializeForScript(buildData)};</script>
        <script src="/build.js" defer></script>`
    });
  }

  function agentWorldOption(game) {
    const config = worldMaps.worldConfigForGame(game.id);
    const levels = (game.worldMap?.levels || []).map((level) => ({
      id: level.id,
      column: level.column,
      row: level.row,
      preview_url: level.previewUrl || null
    }));

    return {
      id: game.id,
      title: game.name,
      is_master: game.id === "maze",
      world_width: config.worldSize.width,
      world_height: config.worldSize.height,
      level_count: levels.length,
      preview_urls: levels.map((level) => level.preview_url).filter(Boolean).slice(0, 4),
      levels,
      default_level_id: defaultLevelIdForGame(game)
    };
  }

  function renderAgentPage() {
    const masterGame = getGame("maze");
    const worlds = [
      ...(masterGame ? [agentWorldOption(masterGame)] : []),
      ...buildWorlds
        .listLocalWorlds()
        .map((world) => getGame(world.id))
        .filter((game) => game && game.worldMap)
        .map(agentWorldOption)
    ];
    const agentData = {
      apiUrl: "/api/agent/runs",
      modelsApiBase: "/api/agent/models",
      worlds,
      environment: agentEnvironment(),
      remote: remoteStatusSafe()
    };

    return renderSitePage({
      title: "Agent — Maze Bench",
      main: `<div class="page-head">
          <h1>Agent</h1>
          <p class="page-sub">Benchmark Codex CLI, Claude Code, or Prime Verifiers on any world and watch the runs live.</p>
          <p id="agent-status" class="author-status" role="status" aria-live="polite"></p>
        </div>
        <section class="panel" aria-label="Launch a run">
          <h2>New Run</h2>

          <h3 class="picker-label">Agent</h3>
          <div id="provider-picker" class="provider-grid" role="radiogroup" aria-label="Agent provider"></div>

          <h3 class="picker-label">Model</h3>
          <p id="model-note" class="muted picker-note" hidden></p>
          <div id="model-picker" class="chip-row" role="radiogroup" aria-label="Model"></div>
          <div id="model-custom" class="model-custom" hidden>
            <label class="field"><span>Model id</span><input id="model-custom-input" type="text" placeholder="e.g. gpt-5.5 or openai/gpt-5-nano" autocomplete="off" spellcheck="false"></label>
          </div>
          <div id="reasoning-row" class="picker-subrow" hidden>
            <span class="picker-sublabel">Reasoning</span>
            <div id="reasoning-picker" class="chip-row chip-row--small" role="radiogroup" aria-label="Reasoning effort"></div>
            <label id="fast-switch" class="switch" hidden>
              <input id="run-codex-fast" type="checkbox">
              <span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span>
              <span class="switch__label">Fast mode</span>
            </label>
          </div>

          <div id="world-section">
            <h3 class="picker-label">World</h3>
            <div id="world-picker" class="world-tile-row" role="radiogroup" aria-label="World"></div>
            <div class="online-pull">
              <label class="field"><span>Or download a published world from ${escapeHtml(
                (remoteStatusSafe().origin || "https://dev.mazebench.com").replace(/^https?:\/\//, "")
              )} by id</span><input id="online-world-id" type="text" placeholder="mbw_…" autocomplete="off" spellcheck="false"></label>
              <button id="online-world-pull" type="button">Download</button>
            </div>

            <h3 class="picker-label">Start level</h3>
            <div id="level-summary" class="level-summary"></div>
            <div id="level-picker" class="level-grid-wrap" hidden></div>
          </div>

          <h3 class="picker-label">Run settings</h3>
          <div id="local-settings">
            <div class="settings-row">
              <label class="field field--narrow"><span>Move budget</span><input id="run-moves" type="number" min="1" max="500" value="20" inputmode="numeric"></label>
              <div class="segmented" id="mode-picker" role="radiogroup" aria-label="Observation mode">
                <button type="button" class="segmented__option is-selected" data-mode="text" aria-pressed="true">Text<small>ASCII board</small></button>
                <button type="button" class="segmented__option" data-mode="vision" aria-pressed="false">Vision<small>rendered PNGs</small></button>
              </div>
            </div>
            <div class="settings-row switches-row">
              <label class="switch">
                <input id="run-container" type="checkbox" checked>
                <span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span>
                <span class="switch__label">Container<small>isolated from your files</small></span>
              </label>
              <label class="switch">
                <input id="run-video" type="checkbox" checked>
                <span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span>
                <span class="switch__label">Replay video<small>rendered when the run ends</small></span>
              </label>
              <label class="switch">
                <input id="run-tools" type="checkbox">
                <span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span>
                <span class="switch__label">Full tool access<small>off = maze commands only</small></span>
              </label>
            </div>
            <div id="docker-action" class="docker-action" hidden></div>
          </div>
          <div id="prime-settings" class="settings-row" hidden>
            <label class="field field--narrow"><span>Examples (n)</span><input id="run-prime-n" type="number" min="1" max="50" value="1"></label>
            <label class="field field--narrow"><span>Rollouts (r)</span><input id="run-prime-r" type="number" min="1" max="10" value="1"></label>
            <label class="field field--narrow"><span>Max turns</span><input id="run-prime-turns" type="number" min="1" max="200" value="8"></label>
          </div>

          <div class="card-actions launch-row">
            <button id="launch-run" class="button--primary" type="button">Launch Run</button>
          </div>
          <p id="agent-environment" class="muted" style="margin-bottom: 0"></p>
        </section>
        <section class="panel" aria-label="Runs">
          <h2>Runs</h2>
          <div id="agent-runs"></div>
        </section>
        <script>window.__AGENT_DATA__ = ${serializeForScript(agentData)};</script>
        <script src="/agent.js" defer></script>`
    });
  }

  function renderAgentRunPage(run) {
    return renderSitePage({
      title: `Run ${run.id} — Maze Bench`,
      main: `<div class="page-head run-head">
          <div class="page-actions">
            <h1 style="margin: 0">Agent Run</h1>
            <button id="stop-run" class="button--coral" type="button" hidden>Stop Run</button>
          </div>
          <h2 id="run-title" class="run-title"></h2>
          <p id="run-meta" class="muted"></p>
          <div id="run-stats" class="agent-stats"></div>
          <p id="run-status" class="author-status" role="status" aria-live="polite"></p>
        </div>

        <section class="panel run-live">
          <h2>Live view</h2>
          <div id="run-live-grid" class="run-live__grid">
            <figure class="run-live__frame">
              <img id="run-live-image" alt="Live maze view" hidden>
              <div id="run-live-placeholder" class="run-live__placeholder">
                <span class="inline-spinner" aria-hidden="true"></span>
                <span>Waiting for the first frame…</span>
              </div>
            </figure>
            <div id="run-board-wrap" class="run-live__board" hidden>
              <div class="run-live__board-label">ASCII board (what the agent reads)</div>
              <pre id="run-board" class="agent-board"></pre>
            </div>
          </div>
        </section>

        <section class="panel" id="run-replay-section" hidden>
          <h2>Replay</h2>
          <div id="run-replay-progress" class="replay-progress" hidden>
            <div class="replay-progress__track"><div id="run-replay-bar" class="replay-progress__fill"></div></div>
            <span id="run-replay-label" class="muted"></span>
          </div>
          <video id="run-video" controls playsinline hidden style="max-width: 100%; border-radius: 9px"></video>
        </section>

        <section class="panel">
          <h2>Moves &amp; reasoning</h2>
          <div id="run-feed" class="agent-feed"></div>
        </section>

        <section class="panel">
          <h2>Runner log</h2>
          <pre id="run-log" class="agent-log"></pre>
        </section>
        <script>window.__AGENT_RUN__ = ${serializeForScript(run)};</script>
        <script src="/agent-run.js" defer></script>`
    });
  }

  function renderNotFound() {
    return renderSitePage({
      title: "Not Found — Maze Bench",
      main: `<div class="empty-state"><span class="glyph">?</span><p>Page not found.</p><p><a class="text-link" href="/">Back to Maze Bench</a></p></div>`
    });
  }

  return {
    renderAgentPage,
    renderAgentRunPage,
    renderAuthorPage,
    renderBuildPage,
    renderFlyoverPage,
    renderGamePage,
    renderHomePage,
    renderNotFound,
    renderPlayModePage,
    renderPlayPage,
    renderWorldMapEditorPage
  };
}

module.exports = {
  createPageRenderer
};
