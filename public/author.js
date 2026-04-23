(function () {
  const authorData = window.__AUTHOR_DATA__;
  const authorPlayData = window.AuthorPlayData;
  const levelPreviewRenderer = window.LevelPreviewRenderer;

  if (!authorData) {
    return;
  }

  const elements = {
    applyCellValue: document.getElementById("apply-cell-value"),
    boardHeight: document.getElementById("board-height"),
    boardSizeLabel: document.getElementById("board-size-label"),
    boardWidth: document.getElementById("board-width"),
    canvas: document.getElementById("author-canvas"),
    cellValue: document.getElementById("cell-value"),
    clearLevel: document.getElementById("clear-level"),
    currentFileName: document.getElementById("current-file-name"),
    currentLevelName: document.getElementById("current-level-name"),
    existingLevels: document.getElementById("existing-levels"),
    flipHorizontal: document.getElementById("flip-horizontal"),
    flipVertical: document.getElementById("flip-vertical"),
    frameLevel: document.getElementById("frame-level"),
    grid: document.getElementById("author-grid"),
    gridShell: document.querySelector(".author-grid-shell"),
    hitGrid: document.getElementById("author-hit-grid"),
    levelNeighbors: document.getElementById("level-neighbors"),
    levelColumn: document.getElementById("level-column"),
    levelRow: document.getElementById("level-row"),
    palette: document.getElementById("palette"),
    placeGem: document.getElementById("place-gem"),
    playLink: document.getElementById("author-play-link"),
    rawOutput: document.getElementById("raw-output"),
    resizeLevel: document.getElementById("resize-level"),
    rotateLeft: document.getElementById("rotate-left"),
    rotateRight: document.getElementById("rotate-right"),
    saveLevel: document.getElementById("save-level"),
    selectedCellLabel: document.getElementById("selected-cell-label"),
    selectedToolLabel: document.getElementById("selected-tool-label"),
    sidebar: document.querySelector(".author-sidebar"),
    solveLevel: document.getElementById("solve-level"),
    status: document.getElementById("author-status")
  };

  const optionalElementKeys = new Set([
    "boardSizeLabel",
    "currentFileName",
    "currentLevelName",
    "existingLevels",
    "levelColumn",
    "levelRow"
  ]);

  if (
    Object.entries(elements).some(
      ([key, element]) => !element && !optionalElementKeys.has(key)
    )
  ) {
    return;
  }

  if (!authorPlayData || typeof authorPlayData.createAdapter !== "function") {
    return;
  }

  const playDataAdapter = authorPlayData.createAdapter(authorData);
  const {
    buildPlayData,
    getCellDescriptor,
    getCellTokens,
    getCellTools,
    isActorTool,
    normalizeCellValue,
    toolByName,
    toolByToken
  } = playDataAdapter;
  const editorTileSize = 64;
  const minimumEditorTileSize = 12;
  const editorGridOutlineSize = 8;
  const editorRenderer = {
    app: null,
    layoutFrameId: null,
    preloadVersion: 0
  };
  const palettePreviewRenderer = {
    previewsByToken: new Map(),
    promise: null
  };
  const solverDirections = [
    { label: "U", dx: 0, dy: -1 },
    { label: "D", dx: 0, dy: 1 },
    { label: "L", dx: -1, dy: 0 },
    { label: "R", dx: 1, dy: 0 }
  ];
  const solverMaxExpandedStates = 150000;
  const worldColumns =
    Array.isArray(authorData.worldColumns) && authorData.worldColumns.length > 0
      ? authorData.worldColumns
      : ["A"];
  const worldRows =
    Array.isArray(authorData.worldRows) && authorData.worldRows.length > 0
      ? authorData.worldRows
      : ["A"];
  const columnIndexByValue = new Map(worldColumns.map((letter, index) => [letter, index]));
  const rowIndexByValue = new Map(worldRows.map((letter, index) => [letter, index]));
  const state = {
    cells: cloneCells(authorData.initialLevel.cells),
    exists: authorData.initialLevel.exists,
    fileName: authorData.initialLevel.fileName,
    filePath: authorData.initialLevel.filePath,
    height: authorData.initialLevel.height,
    isDirty: false,
    levelId: authorData.initialLevel.levelId,
    message: authorData.initialLevel.exists
      ? "Loaded existing level."
      : "Fresh level. Paint something good.",
    messageTone: authorData.initialLevel.exists ? "success" : "warning",
    paintPointerId: null,
    selectedCell: { x: 0, y: 0 },
    selectedToken:
      authorData.defaultWallToken || authorData.palette[0]?.token || authorData.defaultFloorToken,
    width: authorData.initialLevel.width
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function cloneCells(cells) {
    return cells.map((row) => row.slice());
  }

  function createBlankCells(width, height, fillToken) {
    return Array.from({ length: height }, () => Array.from({ length: width }, () => fillToken));
  }

  function parseLevelCoordinates(levelId) {
    const match = String(levelId || "").match(/^level_([A-Z])x([A-Z])$/);

    if (!match) {
      return null;
    }

    return {
      column: match[1],
      row: match[2]
    };
  }

  function levelIdFromSelectors() {
    return "level_" + elements.levelColumn.value + "x" + elements.levelRow.value;
  }

  function adjacentLevelId(levelId, dx, dy) {
    const coordinates = parseLevelCoordinates(levelId);

    if (!coordinates || worldColumns.length === 0 || worldRows.length === 0) {
      return levelId;
    }

    const columnIndex = columnIndexByValue.get(coordinates.column);
    const rowIndex = rowIndexByValue.get(coordinates.row);

    if (typeof columnIndex !== "number" || typeof rowIndex !== "number") {
      return levelId;
    }

    const nextColumnIndex = (columnIndex + dx + worldColumns.length) % worldColumns.length;
    const nextRowIndex = (rowIndex + dy + worldRows.length) % worldRows.length;

    return "level_" + worldColumns[nextColumnIndex] + "x" + worldRows[nextRowIndex];
  }

  function serializeCells() {
    return state.cells.map((row) => row.join(authorData.separator)).join("\n");
  }

  function isSolverActorTool(tool) {
    return isActorTool(tool);
  }

  function levelHasGem() {
    return state.cells.some((row) =>
      row.some((cell) => getCellTools(cell).some((tool) => tool.name === "gem"))
    );
  }

  function levelHasPlayer() {
    return state.cells.some((row) =>
      row.some((cell) =>
        getCellTools(cell).some((tool) => tool.name === "player" || tool.name === "circle_player")
      )
    );
  }

  function isTerrainOnlyGemPlacementCell(x, y) {
    const tools = getCellTools(state.cells[y]?.[x]);

    if (tools.some((tool) => tool.name === "gem")) {
      return false;
    }

    return !tools.some((tool) => isSolverActorTool(tool));
  }

  function gemPlacementValueForCell(x, y) {
    const gemToken = toolByName.get("gem")?.token || "G";
    const tokens = getCellTokens(state.cells[y]?.[x]);

    if (tokens.includes(gemToken)) {
      return tokens.join(authorData.blockAdder);
    }

    return tokens.concat(gemToken).join(authorData.blockAdder);
  }

  function stripGemFromCellValue(value) {
    const gemToken = toolByName.get("gem")?.token || "G";
    const tokens = getCellTokens(value).filter((token) => token !== gemToken);

    return tokens.length > 0 ? tokens.join(authorData.blockAdder) : authorData.defaultFloorToken;
  }

  function buildEditorPlayData(options = {}) {
    return buildPlayData({
      cameraView: options.cameraView || null,
      cells: state.cells,
      gameId: authorData.game.id,
      height: state.height,
      includeGems: options.includeGems,
      levelId: options.levelId || "__editor_solver__",
      levelLabel: options.levelLabel || state.levelId,
      sourceFileName: state.fileName,
      width: state.width,
      worldColumns: options.worldColumns || null,
      worldRows: options.worldRows || null
    });
  }

  function isSolverPlayerActor(actor) {
    return actor?.type === "player" || actor?.type === "circle_player";
  }

  function isSolvedSolverSnapshot(snapshot) {
    if (snapshot.actors.some((actor) => actor.type === "gem" && actor.removed)) {
      return true;
    }

    const players = snapshot.actors.filter(
      (actor) => isSolverPlayerActor(actor) && !actor.removed && (actor.elevation ?? 0) === 0
    );
    const gems = snapshot.actors.filter((actor) => actor.type === "gem" && !actor.removed);

    return gems.some((gem) => players.some((player) => player.x === gem.x && player.y === gem.y));
  }

  function solverHeuristic(snapshot) {
    const players = snapshot.actors.filter((actor) => isSolverPlayerActor(actor) && !actor.removed);
    const gems = snapshot.actors.filter((actor) => actor.type === "gem" && !actor.removed);

    if (players.length === 0 || gems.length === 0) {
      return 0;
    }

    let best = 2;

    players.forEach((player) => {
      gems.forEach((gem) => {
        if (player.x === gem.x && player.y === gem.y && (player.elevation ?? 0) === 0) {
          best = 0;
        } else if (player.x === gem.x || player.y === gem.y) {
          best = Math.min(best, 1);
        }
      });
    });

    return best;
  }

  function solverTerrainKey(terrain) {
    return terrain
      .map((row) => row.map((cell) => cell.type + (cell.raised ? "^" : "")).join(","))
      .join("/");
  }

  function solverStateKey(snapshot) {
    const actorKey = snapshot.actors
      .map((actor) =>
        [
          actor.type,
          actor.groupId || "",
          actor.x,
          actor.y,
          actor.elevation ?? 0,
          actor.removed ? 1 : 0
        ].join(":")
      )
      .join("|");

    return solverTerrainKey(snapshot.terrain) + "::" + actorKey;
  }

  function captureSolverSnapshot(app) {
    return {
      width: app.state.width,
      height: app.state.height,
      terrain: app.cloneTerrainState(app.state.terrain),
      actors: app.cloneActorStateList()
    };
  }

  function restoreSolverSnapshot(app, snapshot) {
    app.state.width = snapshot.width;
    app.state.height = snapshot.height;
    app.state.terrain = app.cloneTerrainState(snapshot.terrain);
    app.state.actors = snapshot.actors.map((actor) => app.createRuntimeActor(actor));
    app.moveHistory.length = 0;
    app.isAnimating = false;
    app.isTransitioningLevel = false;
    app.queuedAction = null;
    app.gateRenderOverride = null;
    app.liveRaisedPlayerGates.clear();
  }

  function createSolverApp(playData) {
    const modules = window.PlayModules || {};

    if (
      typeof modules.createPlayCore !== "function" ||
      typeof modules.registerGameplayFunctions !== "function"
    ) {
      throw new Error("Solver modules are not available.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, playData.width * 64);
    canvas.height = Math.max(1, playData.height * 64);

    const app = modules.createPlayCore({
      playData,
      canvas,
      playShell: null,
      playHeader: null,
      playStage: null,
      mazeFrame: null,
      fuzzyToggle: null
    });

    if (!app) {
      throw new Error("Could not initialize the solver.");
    }

    app.render = function () {};
    modules.registerGameplayFunctions(app);

    if (typeof app.tryMovePlayersInstant !== "function") {
      throw new Error("Instant movement is not available to the solver.");
    }

    return app;
  }

  function buildEditorRenderPlayData() {
    return buildEditorPlayData({
      cameraView: {
        width: state.width,
        height: state.height
      },
      levelId: "__editor_render__",
      levelLabel: state.levelId
    });
  }

  function ensureEditorRenderApp(playData) {
    const modules = window.PlayModules || {};

    if (
      typeof modules.createPlayCore !== "function" ||
      typeof modules.registerRenderFunctions !== "function"
    ) {
      return null;
    }

    if (editorRenderer.app) {
      return editorRenderer.app;
    }

    const app = modules.createPlayCore({
      playData,
      canvas: elements.canvas,
      playShell: null,
      playHeader: null,
      playStage: null,
      mazeFrame: null,
      fuzzyToggle: null
    });

    if (!app) {
      return null;
    }

    modules.registerRenderFunctions(app);
    editorRenderer.app = app;
    return app;
  }

  function renderEditorScene() {
    const playData = buildEditorRenderPlayData();
    const shouldStartNoiseTicker = !editorRenderer.app;
    const app = ensureEditorRenderApp(playData);

    if (!app || typeof app.applyLevelState !== "function") {
      return;
    }

    app.applyLevelState(playData, {
      deferRender: true,
      immediateCamera: true,
      resetHistory: true,
      resetLevelEntry: true
    });

    if (shouldStartNoiseTicker) {
      app.syncNoiseTicker();
    }

    app.render();

    const preloadVersion = editorRenderer.preloadVersion + 1;
    editorRenderer.preloadVersion = preloadVersion;

    app.preloadImagesForLevelState(playData)
      .then(() => {
        if (editorRenderer.app === app && editorRenderer.preloadVersion === preloadVersion) {
          app.render();
        }
      })
      .catch(() => {});
  }

  function compareSolverNodes(left, right) {
    return left.priority - right.priority || left.cost - right.cost || left.order - right.order;
  }

  class SolverHeap {
    constructor() {
      this.items = [];
    }

    get size() {
      return this.items.length;
    }

    push(item) {
      this.items.push(item);
      this.bubbleUp(this.items.length - 1);
    }

    pop() {
      if (this.items.length === 0) {
        return null;
      }

      const first = this.items[0];
      const last = this.items.pop();

      if (this.items.length > 0) {
        this.items[0] = last;
        this.bubbleDown(0);
      }

      return first;
    }

    bubbleUp(index) {
      let currentIndex = index;

      while (currentIndex > 0) {
        const parentIndex = Math.floor((currentIndex - 1) / 2);

        if (compareSolverNodes(this.items[parentIndex], this.items[currentIndex]) <= 0) {
          return;
        }

        [this.items[parentIndex], this.items[currentIndex]] = [
          this.items[currentIndex],
          this.items[parentIndex]
        ];
        currentIndex = parentIndex;
      }
    }

    bubbleDown(index) {
      let currentIndex = index;

      while (true) {
        const leftIndex = currentIndex * 2 + 1;
        const rightIndex = currentIndex * 2 + 2;
        let smallestIndex = currentIndex;

        if (
          leftIndex < this.items.length &&
          compareSolverNodes(this.items[leftIndex], this.items[smallestIndex]) < 0
        ) {
          smallestIndex = leftIndex;
        }

        if (
          rightIndex < this.items.length &&
          compareSolverNodes(this.items[rightIndex], this.items[smallestIndex]) < 0
        ) {
          smallestIndex = rightIndex;
        }

        if (smallestIndex === currentIndex) {
          return;
        }

        [this.items[currentIndex], this.items[smallestIndex]] = [
          this.items[smallestIndex],
          this.items[currentIndex]
        ];
        currentIndex = smallestIndex;
      }
    }
  }

  function solveWithAStar(app, initialSnapshot) {
    const open = new SolverHeap();
    const bestCostByKey = new Map();
    let order = 0;
    let expanded = 0;
    const initialKey = solverStateKey(initialSnapshot);

    bestCostByKey.set(initialKey, 0);
    open.push({
      snapshot: initialSnapshot,
      cost: 0,
      path: "",
      priority: solverHeuristic(initialSnapshot),
      order: order
    });
    order += 1;

    while (open.size > 0) {
      const current = open.pop();
      const currentKey = solverStateKey(current.snapshot);

      if (current.cost !== bestCostByKey.get(currentKey)) {
        continue;
      }

      if (isSolvedSolverSnapshot(current.snapshot)) {
        return {
          status: "solved",
          moves: current.cost,
          path: current.path,
          expanded
        };
      }

      expanded += 1;

      if (expanded > solverMaxExpandedStates) {
        return {
          status: "capped",
          expanded,
          maxExpanded: solverMaxExpandedStates
        };
      }

      solverDirections.forEach((direction) => {
        restoreSolverSnapshot(app, current.snapshot);
        const moveResult = app.tryMovePlayersInstant(direction.dx, direction.dy);

        if (!moveResult?.moved) {
          return;
        }

        const nextSnapshot = captureSolverSnapshot(app);
        const nextCost = current.cost + 1;
        const nextKey = solverStateKey(nextSnapshot);
        const bestKnownCost = bestCostByKey.get(nextKey);

        if (typeof bestKnownCost === "number" && bestKnownCost <= nextCost) {
          return;
        }

        bestCostByKey.set(nextKey, nextCost);
        open.push({
          snapshot: nextSnapshot,
          cost: nextCost,
          path: current.path + direction.label,
          priority: nextCost + solverHeuristic(nextSnapshot),
          order
        });
        order += 1;
      });
    }

    return {
      status: "unsolved",
      expanded
    };
  }

  function canCollectGemAtMoveEndpoint(app, move) {
    if (!isSolverPlayerActor(move.actor) || move.toRemoved) {
      return false;
    }

    const toElevation = move.toElevation ?? move.actor.elevation ?? 0;
    const fromElevation = move.fromElevation ?? 0;

    return toElevation === 0 || (fromElevation === 0 && app.isPlayerLift(move.toX, move.toY));
  }

  function recordGemPlacementCandidates(app, moveResult, cost, path, bestCandidateByCell) {
    moveResult.moves.forEach((move) => {
      if (!canCollectGemAtMoveEndpoint(app, move)) {
        return;
      }

      if (!isTerrainOnlyGemPlacementCell(move.toX, move.toY)) {
        return;
      }

      const key = move.toX + "," + move.toY;
      const previousCandidate = bestCandidateByCell.get(key);

      if (previousCandidate && previousCandidate.moves <= cost) {
        return;
      }

      bestCandidateByCell.set(key, {
        x: move.toX,
        y: move.toY,
        moves: cost,
        path
      });
    });
  }

  function hardestGemPlacementCandidate(bestCandidateByCell) {
    let hardest = null;

    bestCandidateByCell.forEach((candidate) => {
      if (!hardest || candidate.moves > hardest.moves) {
        hardest = candidate;
      }
    });

    return hardest;
  }

  function findHardestGemPlacement(app, initialSnapshot) {
    const open = new SolverHeap();
    const bestCostByKey = new Map();
    const bestCandidateByCell = new Map();
    let order = 0;
    let expanded = 0;
    const initialKey = solverStateKey(initialSnapshot);

    bestCostByKey.set(initialKey, 0);
    open.push({
      snapshot: initialSnapshot,
      cost: 0,
      path: "",
      priority: 0,
      order
    });
    order += 1;

    while (open.size > 0) {
      const current = open.pop();
      const currentKey = solverStateKey(current.snapshot);

      if (current.cost !== bestCostByKey.get(currentKey)) {
        continue;
      }

      expanded += 1;

      if (expanded > solverMaxExpandedStates) {
        return {
          status: "capped",
          candidate: hardestGemPlacementCandidate(bestCandidateByCell),
          expanded,
          maxExpanded: solverMaxExpandedStates
        };
      }

      solverDirections.forEach((direction) => {
        restoreSolverSnapshot(app, current.snapshot);
        const moveResult = app.tryMovePlayersInstant(direction.dx, direction.dy);

        if (!moveResult?.moved) {
          return;
        }

        const nextCost = current.cost + 1;
        const nextPath = current.path + direction.label;
        const nextSnapshot = captureSolverSnapshot(app);
        const nextKey = solverStateKey(nextSnapshot);
        const bestKnownCost = bestCostByKey.get(nextKey);

        recordGemPlacementCandidates(app, moveResult, nextCost, nextPath, bestCandidateByCell);

        if (typeof bestKnownCost === "number" && bestKnownCost <= nextCost) {
          return;
        }

        bestCostByKey.set(nextKey, nextCost);
        open.push({
          snapshot: nextSnapshot,
          cost: nextCost,
          path: nextPath,
          priority: nextCost,
          order
        });
        order += 1;
      });
    }

    const candidate = hardestGemPlacementCandidate(bestCandidateByCell);

    return {
      status: candidate ? "found" : "none",
      candidate,
      expanded
    };
  }

  function setStatus(message, tone) {
    state.message = message;
    state.messageTone = tone || "warning";
    renderStatus();
  }

  function renderStatus() {
    const dirtySuffix = state.isDirty ? " Unsaved changes." : "";
    elements.status.textContent = state.message + dirtySuffix;
    elements.status.className = "author-status is-" + state.messageTone;
  }

  function syncSolverButtonState() {
    const hasGem = levelHasGem();
    const hasPlayer = levelHasPlayer();

    elements.solveLevel.disabled = !hasGem;
    elements.solveLevel.title = hasGem
      ? "Run A* from the current editor grid."
      : "Add a gem before running the solver.";
    elements.placeGem.disabled = !hasPlayer;
    elements.placeGem.title = hasPlayer
      ? "Find the hardest empty terrain cell the player can reach."
      : "Add a player before finding a gem placement.";
  }

  function syncLevelSelectors() {
    if (!elements.levelColumn || !elements.levelRow) {
      return;
    }

    const coordinates = parseLevelCoordinates(state.levelId);

    if (!coordinates) {
      return;
    }

    elements.levelColumn.value = coordinates.column;
    elements.levelRow.value = coordinates.row;
  }

  function renderLevelSelectors() {
    if (!elements.levelColumn || !elements.levelRow) {
      return;
    }

    const columnOptions = worldColumns
      .map((letter) => '<option value="' + escapeHtml(letter) + '">' + escapeHtml(letter) + "</option>")
      .join("");
    const rowOptions = worldRows
      .map((letter) => '<option value="' + escapeHtml(letter) + '">' + escapeHtml(letter) + "</option>")
      .join("");

    elements.levelColumn.innerHTML = columnOptions;
    elements.levelRow.innerHTML = rowOptions;
    syncLevelSelectors();
  }

  function renderPalette() {
    elements.palette.innerHTML = authorData.palette
      .map((tool) => {
        const previewUrl = palettePreviewRenderer.previewsByToken.get(tool.token);
        const swatchContents = previewUrl
          ? '<img src="' + escapeHtml(previewUrl) + '" alt="">'
          : '<span class="palette__swatch-placeholder" aria-hidden="true"></span>';
        const accessibleLabel = tool.label + " (" + tool.token + ")";

        return (
          '<button class="tool-button palette__button' +
          (tool.token === state.selectedToken ? " is-active" : "") +
          '" type="button" data-token="' +
          escapeHtml(tool.token) +
          '" aria-label="' +
          escapeHtml(accessibleLabel) +
          '" title="' +
          escapeHtml(accessibleLabel) +
          '">' +
          '<span class="palette__swatch">' +
          swatchContents +
          "</span>" +
          '<span class="palette__token">' +
          escapeHtml(tool.token) +
          "</span>" +
          "</button>"
        );
      })
      .join("");
  }

  function createPalettePreviewPlayData() {
    const stride = 3;
    const columns = Math.max(1, Math.min(4, authorData.palette.length));
    const rows = Math.max(1, Math.ceil(authorData.palette.length / columns));
    const width = columns * stride;
    const height = rows * stride;
    const cells = createBlankCells(width, height, authorData.defaultFloorToken);
    const positionsByToken = new Map();

    authorData.palette.forEach((tool, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * stride + 1;
      const y = row * stride + 1;

      cells[y][x] = tool.token;
      positionsByToken.set(tool.token, { x, y });
    });

    return {
      playData: buildPlayData({
        cameraView: { width, height },
        cells,
        gameId: authorData.game.id,
        height,
        includeGems: true,
        levelId: "__palette_preview__",
        levelLabel: "Palette",
        width
      }),
      positionsByToken
    };
  }

  function cropPalettePreview(sceneCanvas, position) {
    const sourceSize = 80;
    const previewCanvas = document.createElement("canvas");
    const previewContext = previewCanvas.getContext("2d");

    if (!previewContext) {
      return "";
    }

    const sourceCenterX = position.x * editorTileSize + editorTileSize / 2;
    const sourceCenterY = position.y * editorTileSize + editorTileSize / 2;
    const sourceX = Math.round(sourceCenterX - sourceSize / 2);
    const sourceY = Math.round(sourceCenterY - sourceSize / 2 - 8);

    previewCanvas.width = sourceSize;
    previewCanvas.height = sourceSize;
    previewContext.imageSmoothingEnabled = true;
    previewContext.fillStyle = "#d6bd94";
    previewContext.fillRect(0, 0, sourceSize, sourceSize);
    previewContext.drawImage(
      sceneCanvas,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      sourceSize,
      sourceSize
    );

    return previewCanvas.toDataURL("image/png");
  }

  async function renderPalettePreviews() {
    if (palettePreviewRenderer.promise) {
      return palettePreviewRenderer.promise;
    }

    palettePreviewRenderer.promise = (async function () {
      const modules = window.PlayModules || {};

      if (
        typeof modules.createPlayCore !== "function" ||
        typeof modules.registerRenderFunctions !== "function"
      ) {
        return;
      }

      const { playData, positionsByToken } = createPalettePreviewPlayData();
      const canvas = document.createElement("canvas");
      const app = modules.createPlayCore({
        playData,
        canvas,
        playShell: null,
        playHeader: null,
        playStage: null,
        mazeFrame: null,
        fuzzyToggle: null
      });

      if (!app) {
        return;
      }

      modules.registerRenderFunctions(app);
      await app.preloadImagesForLevelState(playData);
      app.setupCanvas();
      app.liveRaisedPlayerGates = app.computeRaisedPlayerGateSet();
      app.syncGateAnimationTargets(0);
      app.syncPlayerLiftAnimationTargets(0);
      app.renderCompositor.drawScene(0);

      const previewsByToken = new Map();
      positionsByToken.forEach((position, token) => {
        const previewUrl = cropPalettePreview(app.sceneCanvas, position);

        if (previewUrl) {
          previewsByToken.set(token, previewUrl);
        }
      });

      palettePreviewRenderer.previewsByToken = previewsByToken;
      renderPalette();
    })().catch(() => {});

    return palettePreviewRenderer.promise;
  }

  function renderSelectedTool() {
    const tool = toolByToken.get(state.selectedToken);

    elements.selectedToolLabel.textContent = state.selectedToken;
    elements.selectedToolLabel.title = tool ? tool.label : state.selectedToken;
  }

  function renderNeighborButtons() {
    Array.from(elements.levelNeighbors.querySelectorAll("[data-dx][data-dy]")).forEach(function (button) {
      const dx = Number(button.dataset.dx);
      const dy = Number(button.dataset.dy);
      const nextLevelId = adjacentLevelId(state.levelId, dx, dy);
      button.dataset.levelId = nextLevelId;
      button.title = "Go to " + nextLevelId.replace("level_", "");
      button.setAttribute("aria-label", "Go to " + nextLevelId);
    });
  }

  function updateCellButton(button, x, y) {
    const value = state.cells[y][x];
    const descriptor = getCellDescriptor(value);
    const isSelected = state.selectedCell.x === x && state.selectedCell.y === y;

    button.className = "author-grid__cell" + (isSelected ? " is-selected" : "");
    button.textContent = "";
    button.setAttribute(
      "aria-label",
      "Cell " + (x + 1) + ", " + (y + 1) + ": " + value + " (" + descriptor.label + ")"
    );
    button.title = "Cell " + (x + 1) + ", " + (y + 1) + ": " + value;
  }

  function readPixelValue(value) {
    const parsed = parseFloat(value);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  function clampEditorTileSize(value) {
    return Math.max(minimumEditorTileSize, Math.min(editorTileSize, Math.floor(value)));
  }

  function measureEditorTileSize() {
    const shellStyles = window.getComputedStyle(elements.gridShell);
    const paddingX =
      readPixelValue(shellStyles.paddingLeft) + readPixelValue(shellStyles.paddingRight);
    const paddingY =
      readPixelValue(shellStyles.paddingTop) + readPixelValue(shellStyles.paddingBottom);
    const viewportHeight =
      window.visualViewport?.height || window.innerHeight || state.height * editorTileSize;
    const shellRect = elements.gridShell.getBoundingClientRect();
    const cappedTop = Math.max(0, Math.min(shellRect.top, Math.max(120, viewportHeight * 0.28)));
    const availableWidth = Math.max(
      minimumEditorTileSize,
      elements.gridShell.clientWidth - paddingX - editorGridOutlineSize
    );
    const availableHeight = Math.max(
      minimumEditorTileSize,
      viewportHeight - cappedTop - paddingY - editorGridOutlineSize - 24
    );
    const widthTileSize = availableWidth / Math.max(1, state.width);
    const heightTileSize = availableHeight / Math.max(1, state.height);

    return clampEditorTileSize(Math.min(widthTileSize, heightTileSize));
  }

  function syncEditorGridLayout() {
    const displayTileSize = measureEditorTileSize();
    const gridWidth = state.width * displayTileSize;
    const gridHeight = state.height * displayTileSize;

    elements.grid.style.setProperty("--editor-cell-size", displayTileSize + "px");
    elements.grid.style.width = gridWidth + "px";
    elements.grid.style.height = gridHeight + "px";
    elements.hitGrid.style.gridTemplateColumns =
      "repeat(" + state.width + ", " + displayTileSize + "px)";
    elements.hitGrid.style.gridTemplateRows =
      "repeat(" + state.height + ", " + displayTileSize + "px)";

    const gridShellHeight = Math.ceil(elements.gridShell.getBoundingClientRect().height);
    if (Number.isFinite(gridShellHeight) && gridShellHeight > 0) {
      elements.sidebar.style.setProperty("--author-level-tray-height", gridShellHeight + "px");
    }
  }

  function scheduleEditorGridLayout() {
    if (editorRenderer.layoutFrameId !== null) {
      return;
    }

    editorRenderer.layoutFrameId = window.requestAnimationFrame(() => {
      editorRenderer.layoutFrameId = null;
      syncEditorGridLayout();
    });
  }

  function renderGrid(options = {}) {
    const cellCount = state.width * state.height;

    syncEditorGridLayout();

    if (
      elements.hitGrid.children.length !== cellCount ||
      elements.hitGrid.dataset.width !== String(state.width) ||
      elements.hitGrid.dataset.height !== String(state.height)
    ) {
      elements.hitGrid.innerHTML = "";
      elements.hitGrid.dataset.width = String(state.width);
      elements.hitGrid.dataset.height = String(state.height);

      for (let y = 0; y < state.height; y += 1) {
        for (let x = 0; x < state.width; x += 1) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.x = String(x);
          button.dataset.y = String(y);
          elements.hitGrid.appendChild(button);
        }
      }
    }

    Array.from(elements.hitGrid.children).forEach((button) => {
      const x = Number(button.dataset.x);
      const y = Number(button.dataset.y);
      updateCellButton(button, x, y);
    });

    if (options.renderScene !== false) {
      renderEditorScene();
    }
  }

  function renderSelectedCell() {
    const x = state.selectedCell.x;
    const y = state.selectedCell.y;
    const value = state.cells[y][x];
    const descriptor = getCellDescriptor(value);

    elements.selectedCellLabel.textContent =
      "Cell " +
      (x + 1) +
      ", " +
      (y + 1) +
      " is " +
      value +
      " (" +
      descriptor.label +
      "). Right-click a cell to grab its token.";
    elements.cellValue.value = value;
  }

  function renderRawOutput() {
    elements.rawOutput.value = serializeCells();
  }

  function renderMeta() {
    elements.boardWidth.value = String(state.width);
    elements.boardHeight.value = String(state.height);
    if (elements.boardSizeLabel) {
      elements.boardSizeLabel.textContent = state.width + " x " + state.height;
    }
    if (elements.currentFileName) {
      elements.currentFileName.textContent = state.filePath;
    }
    if (elements.currentLevelName) {
      elements.currentLevelName.textContent = state.levelId.replace("level_", "");
    }
    elements.playLink.href = "/play/" + encodeURIComponent(authorData.game.id) + "/" + encodeURIComponent(state.levelId);
    elements.playLink.setAttribute("aria-label", "Play " + state.levelId);
    syncSolverButtonState();
  }

  function renderExistingLevels() {
    if (!elements.existingLevels) {
      return;
    }

    const levelIds = new Set(authorData.existingLevels.map((level) => level.id));

    if (state.exists && !levelIds.has(state.levelId)) {
      authorData.existingLevels.push({
        authorUrl: "/author/" + encodeURIComponent(authorData.game.id) + "/" + encodeURIComponent(state.levelId),
        id: state.levelId,
        label: state.levelId.replace("level_", "Level "),
        playUrl: "/play/" + encodeURIComponent(authorData.game.id) + "/" + encodeURIComponent(state.levelId)
      });
      authorData.existingLevels.sort((left, right) => left.id.localeCompare(right.id));
    }

    elements.existingLevels.innerHTML = authorData.existingLevels
      .map((level) => {
        return (
          '<a class="author-level-pill' +
          (level.id === state.levelId ? " is-active" : "") +
          '" href="' +
          escapeHtml(level.authorUrl) +
          '" data-level-id="' +
          escapeHtml(level.id) +
          '">' +
          escapeHtml(level.id.replace("level_", "")) +
          "</a>"
        );
      })
      .join("");
  }

  function renderAll() {
    renderStatus();
    renderMeta();
    renderNeighborButtons();
    renderSelectedTool();
    renderGrid();
    renderSelectedCell();
    renderRawOutput();
    renderExistingLevels();
  }

  function selectToken(token) {
    if (!toolByToken.has(token)) {
      return;
    }

    state.selectedToken = token;
    renderPalette();
    renderSelectedTool();
  }

  function selectCell(x, y) {
    state.selectedCell = {
      x: Math.max(0, Math.min(state.width - 1, x)),
      y: Math.max(0, Math.min(state.height - 1, y))
    };
    renderGrid({ renderScene: false });
    renderSelectedCell();
  }

  function markDirty() {
    state.isDirty = true;
    renderStatus();
    renderRawOutput();
    syncSolverButtonState();
  }

  function paintCell(x, y, value) {
    const normalizedValue = normalizeCellValue(value);

    if (state.cells[y][x] === normalizedValue) {
      selectCell(x, y);
      return;
    }

    state.cells[y][x] = normalizedValue;
    state.selectedCell = {
      x: Math.max(0, Math.min(state.width - 1, x)),
      y: Math.max(0, Math.min(state.height - 1, y))
    };
    renderGrid();
    renderSelectedCell();
    markDirty();
  }

  function resizeLevel() {
    const requestedWidth = Number(elements.boardWidth.value);
    const requestedHeight = Number(elements.boardHeight.value);
    const nextWidth = Math.max(1, Math.min(authorData.maxBoardWidth, requestedWidth || state.width));
    const nextHeight = Math.max(1, Math.min(authorData.maxBoardHeight, requestedHeight || state.height));
    const nextCells = createBlankCells(nextWidth, nextHeight, authorData.defaultFloorToken);

    for (let y = 0; y < Math.min(state.height, nextHeight); y += 1) {
      for (let x = 0; x < Math.min(state.width, nextWidth); x += 1) {
        nextCells[y][x] = state.cells[y][x];
      }
    }

    state.width = nextWidth;
    state.height = nextHeight;
    state.cells = nextCells;
    state.selectedCell = {
      x: Math.min(state.selectedCell.x, state.width - 1),
      y: Math.min(state.selectedCell.y, state.height - 1)
    };
    setStatus("Resized the board.", "warning");
    state.isDirty = true;
    renderAll();
  }

  function clearLevel() {
    state.cells = createBlankCells(state.width, state.height, authorData.defaultFloorToken);
    state.selectedCell = { x: 0, y: 0 };
    setStatus("Cleared the board to floor tiles.", "warning");
    state.isDirty = true;
    renderAll();
  }

  function centeredEdgeOpeningRange(length) {
    const openingSize = Math.max(0, Math.min(4, length - 2));

    if (openingSize === 0) {
      return null;
    }

    const start = Math.floor((length - openingSize) / 2);

    return {
      start,
      end: start + openingSize - 1
    };
  }

  function frameLevel() {
    const horizontalOpening = centeredEdgeOpeningRange(state.width);
    const verticalOpening = centeredEdgeOpeningRange(state.height);

    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        const isEdge = x === 0 || y === 0 || x === state.width - 1 || y === state.height - 1;
        const isHorizontalOpening =
          horizontalOpening !== null &&
          (y === 0 || y === state.height - 1) &&
          x >= horizontalOpening.start &&
          x <= horizontalOpening.end;
        const isVerticalOpening =
          verticalOpening !== null &&
          (x === 0 || x === state.width - 1) &&
          y >= verticalOpening.start &&
          y <= verticalOpening.end;

        if (isEdge) {
          state.cells[y][x] =
            isHorizontalOpening || isVerticalOpening
              ? authorData.defaultFloorToken
              : authorData.defaultWallToken;
        }
      }
    }

    setStatus("Wrapped the border and left 4-tile openings centered on each side.", "warning");
    state.isDirty = true;
    renderAll();
  }

  function transformLevel(transformType) {
    const oldCells = state.cells;
    const oldWidth = state.width;
    const oldHeight = state.height;
    const oldSelectedCell = state.selectedCell;
    let nextCells;
    let nextWidth = oldWidth;
    let nextHeight = oldHeight;
    let nextSelectedCell = oldSelectedCell;
    let message = "Transformed the board.";

    if (transformType === "rotate-left" || transformType === "rotate-right") {
      nextWidth = oldHeight;
      nextHeight = oldWidth;

      if (nextWidth > authorData.maxBoardWidth || nextHeight > authorData.maxBoardHeight) {
        setStatus("That rotation would exceed the editor board limits.", "error");
        return;
      }
    }

    if (transformType === "rotate-left") {
      nextCells = Array.from({ length: nextHeight }, (_, y) =>
        Array.from({ length: nextWidth }, (_, x) => oldCells[x][oldWidth - 1 - y])
      );
      nextSelectedCell = {
        x: oldSelectedCell.y,
        y: oldWidth - 1 - oldSelectedCell.x
      };
      message = "Rotated the board left.";
    } else if (transformType === "rotate-right") {
      nextCells = Array.from({ length: nextHeight }, (_, y) =>
        Array.from({ length: nextWidth }, (_, x) => oldCells[oldHeight - 1 - x][y])
      );
      nextSelectedCell = {
        x: oldHeight - 1 - oldSelectedCell.y,
        y: oldSelectedCell.x
      };
      message = "Rotated the board right.";
    } else if (transformType === "flip-horizontal") {
      nextCells = oldCells.map((row) => row.slice().reverse());
      nextSelectedCell = {
        x: oldWidth - 1 - oldSelectedCell.x,
        y: oldSelectedCell.y
      };
      message = "Flipped the board horizontally.";
    } else if (transformType === "flip-vertical") {
      nextCells = oldCells.slice().reverse().map((row) => row.slice());
      nextSelectedCell = {
        x: oldSelectedCell.x,
        y: oldHeight - 1 - oldSelectedCell.y
      };
      message = "Flipped the board vertically.";
    } else {
      return;
    }

    state.width = nextWidth;
    state.height = nextHeight;
    state.cells = nextCells;
    state.selectedCell = nextSelectedCell;
    setStatus(message, "warning");
    state.isDirty = true;
    renderAll();
  }

  function applySelectedCellValue() {
    try {
      paintCell(state.selectedCell.x, state.selectedCell.y, elements.cellValue.value);
      setStatus("Updated that cell.", "warning");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update that cell.", "error");
      renderSelectedCell();
    }
  }

  function shouldDiscardUnsavedChanges() {
    return !state.isDirty || window.confirm("Discard your unsaved changes?");
  }

  async function loadLevel(levelId) {
    if (!shouldDiscardUnsavedChanges()) {
      syncLevelSelectors();
      return;
    }

    try {
      const response = await fetch(
        authorData.authorApiBaseUrl + "/" + encodeURIComponent(levelId),
        { headers: { Accept: "application/json" } }
      );
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not load that level.");
      }

      state.cells = cloneCells(payload.cells);
      state.exists = payload.exists;
      state.fileName = payload.fileName;
      state.filePath = payload.filePath;
      state.height = payload.height;
      state.isDirty = false;
      state.levelId = payload.levelId;
      state.message = payload.exists ? "Loaded existing level." : "Fresh level. Paint something good.";
      state.messageTone = payload.exists ? "success" : "warning";
      state.selectedCell = { x: 0, y: 0 };
      state.width = payload.width;
      syncLevelSelectors();
      window.history.replaceState(
        null,
        "",
        "/author/" + encodeURIComponent(authorData.game.id) + "/" + encodeURIComponent(state.levelId)
      );
      renderAll();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load that level.", "error");
      syncLevelSelectors();
    }
  }

  async function saveLevel() {
    try {
      const response = await fetch(
        authorData.authorApiBaseUrl + "/" + encodeURIComponent(state.levelId),
        {
          body: JSON.stringify({
            cells: state.cells,
            fileName: state.fileName,
            height: state.height,
            width: state.width
          }),
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          method: "POST"
        }
      );
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not save that level.");
      }

      state.cells = cloneCells(payload.cells);
      state.exists = true;
      state.fileName = payload.fileName;
      state.filePath = payload.filePath;
      state.height = payload.height;
      state.isDirty = false;
      state.levelId = payload.levelId;
      state.width = payload.width;
      let previewMessage = payload.message || "Saved.";
      let previewTone = "success";

      if (levelPreviewRenderer && typeof levelPreviewRenderer.savePreview === "function") {
        try {
          const playResponse = await fetch(
            "/api/play/" + encodeURIComponent(authorData.game.id) + "/" + encodeURIComponent(state.levelId),
            { headers: { Accept: "application/json" } }
          );
          const playPayload = await playResponse.json();

          if (!playResponse.ok) {
            throw new Error(playPayload.error || "Could not load the saved level preview.");
          }

          const previewPayload = await levelPreviewRenderer.savePreview({
            levelId: state.levelId,
            playData: playPayload,
            previewApiBaseUrl: authorData.previewApiBaseUrl || authorData.authorApiBaseUrl
          });
          previewMessage =
            (payload.message || "Saved the level.") +
            " " +
            (previewPayload.message || "Refreshed its preview.");
        } catch (previewError) {
          previewMessage =
            (payload.message || "Saved the level.") +
            " Preview refresh failed: " +
            (previewError instanceof Error ? previewError.message : "Unknown error.");
          previewTone = "warning";
        }
      }

      state.message = previewMessage;
      state.messageTone = previewTone;
      syncLevelSelectors();
      renderAll();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save that level.", "error");
    }
  }

  function formatSolverPath(path) {
    return path.length > 0 ? path : "(empty)";
  }

  function applyGemPlacement(candidate) {
    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        state.cells[y][x] = stripGemFromCellValue(state.cells[y][x]);
      }
    }

    const placedValue = gemPlacementValueForCell(candidate.x, candidate.y);
    state.cells[candidate.y][candidate.x] = placedValue;
    state.selectedCell = { x: candidate.x, y: candidate.y };
    state.isDirty = true;
    renderGrid();
    renderSelectedCell();
    renderRawOutput();
    syncSolverButtonState();

    return placedValue;
  }

  async function placeGem() {
    if (!levelHasPlayer()) {
      setStatus("Place Gem needs a player first.", "error");
      syncSolverButtonState();
      return;
    }

    setStatus("Place Gem running reachability search...", "warning");
    elements.placeGem.disabled = true;

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    try {
      const app = createSolverApp(buildEditorPlayData({ includeGems: false }));
      const result = findHardestGemPlacement(app, captureSolverSnapshot(app));

      if (result.candidate) {
        const placedValue = applyGemPlacement(result.candidate);
        const prefix =
          result.status === "capped"
            ? "Place Gem: placed best spot before cap at "
            : "Place Gem: placed hardest spot at ";
        const suffix =
          result.status === "capped"
            ? " Search stopped after " + result.expanded + " states."
            : "";

        setStatus(
          prefix +
            "cell " +
            (result.candidate.x + 1) +
            ", " +
            (result.candidate.y + 1) +
            " as " +
            placedValue +
            " in " +
            result.candidate.moves +
            " move" +
            (result.candidate.moves === 1 ? "" : "s") +
            ". UDLR: " +
            formatSolverPath(result.candidate.path) +
            "." +
            suffix,
          "success"
        );
        return;
      }

      setStatus(
        "Place Gem: no reachable empty terrain cell found. Explored " +
          result.expanded +
          " state" +
          (result.expanded === 1 ? "" : "s") +
          ".",
        "warning"
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Place Gem failed.", "error");
    } finally {
      syncSolverButtonState();
    }
  }

  async function solveLevel() {
    if (!levelHasGem()) {
      setStatus("Solver needs a gem first.", "error");
      syncSolverButtonState();
      return;
    }

    const playData = buildEditorPlayData();

    if (!playData.actors.some((actor) => isSolverPlayerActor(actor))) {
      setStatus("Solver needs a player first.", "error");
      syncSolverButtonState();
      return;
    }

    setStatus("Solver running A*...", "warning");
    elements.solveLevel.disabled = true;

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    try {
      const app = createSolverApp(playData);
      const result = solveWithAStar(app, captureSolverSnapshot(app));

      if (result.status === "solved") {
        setStatus(
          "Solver: possible in " +
            result.moves +
            " move" +
            (result.moves === 1 ? "" : "s") +
            ". UDLR: " +
            formatSolverPath(result.path) +
            ".",
          "success"
        );
      } else if (result.status === "unsolved") {
        setStatus(
          "Solver: not possible. Explored " +
            result.expanded +
            " state" +
            (result.expanded === 1 ? "" : "s") +
            ".",
          "warning"
        );
      } else {
        setStatus(
          "Solver: no answer within " +
            result.maxExpanded +
            " states. Search stopped after " +
            result.expanded +
            ".",
          "warning"
        );
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Solver failed.", "error");
    } finally {
      syncSolverButtonState();
    }
  }

  function handleGridPointerDown(event) {
    const button = event.target.closest(".author-grid__cell");

    if (!button) {
      return;
    }

    event.preventDefault();
    state.paintPointerId = event.pointerId;
    paintCell(Number(button.dataset.x), Number(button.dataset.y), state.selectedToken);
  }

  function handleGridPointerMove(event) {
    if (state.paintPointerId !== event.pointerId || event.buttons !== 1) {
      return;
    }

    const button = event.target.closest(".author-grid__cell");

    if (!button) {
      return;
    }

    paintCell(Number(button.dataset.x), Number(button.dataset.y), state.selectedToken);
  }

  function stopPainting(event) {
    if (state.paintPointerId === event.pointerId) {
      state.paintPointerId = null;
    }
  }

  function resetDisclosureBodyStyles(body) {
    body.style.height = "";
    body.style.opacity = "";
    body.style.overflow = "";
  }

  function setDisclosureOpen(details, shouldOpen) {
    const body = details.querySelector(".author-disclosure__body");

    if (!body || details.classList.contains("is-animating")) {
      return;
    }

    const isOpen = details.hasAttribute("open");

    if (isOpen === shouldOpen) {
      return;
    }

    details.classList.add("is-animating");
    body.style.overflow = "hidden";

    let finished = false;
    const finish = function () {
      if (finished) {
        return;
      }

      finished = true;
      body.removeEventListener("transitionend", handleTransitionEnd);
      details.classList.remove("is-animating");

      if (!shouldOpen) {
        details.removeAttribute("open");
      }

      resetDisclosureBodyStyles(body);
      scheduleEditorGridLayout();
    };
    const handleTransitionEnd = function (event) {
      if (event.target === body && event.propertyName === "height") {
        finish();
      }
    };

    body.addEventListener("transitionend", handleTransitionEnd);

    if (shouldOpen) {
      details.setAttribute("open", "");
      body.style.height = "0px";
      body.style.opacity = "0";

      window.requestAnimationFrame(() => {
        body.style.height = body.scrollHeight + "px";
        body.style.opacity = "1";
      });
    } else {
      body.style.height = body.scrollHeight + "px";
      body.style.opacity = "1";

      window.requestAnimationFrame(() => {
        body.style.height = "0px";
        body.style.opacity = "0";
      });
    }

    window.setTimeout(finish, 260);
  }

  function initializeAuthorDisclosures() {
    document.querySelectorAll(".author-disclosure").forEach((details) => {
      const summary = details.querySelector(".author-disclosure__summary");
      const body = details.querySelector(".author-disclosure__body");

      if (!summary || !body) {
        return;
      }

      details.removeAttribute("open");
      resetDisclosureBodyStyles(body);
      summary.addEventListener("click", function (event) {
        event.preventDefault();
        setDisclosureOpen(details, !details.hasAttribute("open"));
      });
    });
  }

  renderLevelSelectors();
  renderPalette();
  renderPalettePreviews();
  renderAll();
  initializeAuthorDisclosures();

  elements.palette.addEventListener("click", function (event) {
    const button = event.target.closest("[data-token]");

    if (!button) {
      return;
    }

    selectToken(button.dataset.token);
  });

  elements.grid.addEventListener("pointerdown", handleGridPointerDown);
  elements.grid.addEventListener("pointermove", handleGridPointerMove);
  elements.grid.addEventListener("pointerup", stopPainting);
  elements.grid.addEventListener("pointercancel", stopPainting);
  elements.grid.addEventListener("contextmenu", function (event) {
    const button = event.target.closest(".author-grid__cell");

    if (!button) {
      return;
    }

    event.preventDefault();
    const x = Number(button.dataset.x);
    const y = Number(button.dataset.y);
    const descriptor = getCellDescriptor(state.cells[y][x]);

    selectCell(x, y);
    selectToken(descriptor.topToken);
  });

  if (elements.levelColumn && elements.levelRow) {
    elements.levelColumn.addEventListener("change", function () {
      const nextLevelId = levelIdFromSelectors();

      if (nextLevelId !== state.levelId) {
        loadLevel(nextLevelId);
      }
    });

    elements.levelRow.addEventListener("change", function () {
      const nextLevelId = levelIdFromSelectors();

      if (nextLevelId !== state.levelId) {
        loadLevel(nextLevelId);
      }
    });
  }

  elements.resizeLevel.addEventListener("click", resizeLevel);
  elements.clearLevel.addEventListener("click", clearLevel);
  elements.frameLevel.addEventListener("click", frameLevel);
  elements.rotateLeft.addEventListener("click", function () {
    transformLevel("rotate-left");
  });
  elements.rotateRight.addEventListener("click", function () {
    transformLevel("rotate-right");
  });
  elements.flipHorizontal.addEventListener("click", function () {
    transformLevel("flip-horizontal");
  });
  elements.flipVertical.addEventListener("click", function () {
    transformLevel("flip-vertical");
  });
  elements.placeGem.addEventListener("click", placeGem);
  elements.applyCellValue.addEventListener("click", applySelectedCellValue);
  elements.cellValue.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      applySelectedCellValue();
    }
  });
  elements.solveLevel.addEventListener("click", solveLevel);
  elements.saveLevel.addEventListener("click", saveLevel);

  elements.levelNeighbors.addEventListener("click", function (event) {
    const button = event.target.closest("[data-level-id]");

    if (!button) {
      return;
    }

    const nextLevelId = button.dataset.levelId;

    if (nextLevelId && nextLevelId !== state.levelId) {
      loadLevel(nextLevelId);
    }
  });

  if (elements.existingLevels) {
    elements.existingLevels.addEventListener("click", function (event) {
      const link = event.target.closest("[data-level-id]");

      if (!link) {
        return;
      }

      event.preventDefault();
      const nextLevelId = link.dataset.levelId;

      if (nextLevelId !== state.levelId) {
        if (elements.levelColumn && elements.levelRow) {
          const coordinates = parseLevelCoordinates(nextLevelId);

          if (coordinates) {
            elements.levelColumn.value = coordinates.column;
            elements.levelRow.value = coordinates.row;
          }
        }
        loadLevel(nextLevelId);
      }
    });
  }

  window.addEventListener("beforeunload", function (event) {
    if (!state.isDirty) {
      return;
    }

    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("resize", scheduleEditorGridLayout);
})();
