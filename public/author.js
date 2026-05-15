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
    playSolution: document.getElementById("play-solution"),
    rawOutput: document.getElementById("raw-output"),
    resizeLevel: document.getElementById("resize-level"),
    rotateLeft: document.getElementById("rotate-left"),
    rotateRight: document.getElementById("rotate-right"),
    saveLevel: document.getElementById("save-level"),
    selectedCellLabel: document.getElementById("selected-cell-label"),
    selectedToolLabel: document.getElementById("selected-tool-label"),
    sidebar: document.querySelector(".author-sidebar"),
    solveLevel: document.getElementById("solve-level"),
    solverProgress: document.getElementById("solver-progress"),
    solverProgressBar: document.getElementById("solver-progress-bar"),
    solverProgressText: document.getElementById("solver-progress-text"),
    solverProgressTrack: document.getElementById("solver-progress-track"),
    solverMaxStates: document.getElementById("solver-max-states"),
    status: document.getElementById("author-status")
  };

  const optionalElementKeys = new Set([
    "boardSizeLabel",
    "currentFileName",
    "currentLevelName",
    "existingLevels",
    "levelColumn",
    "levelRow",
    "solverProgress",
    "solverProgressBar",
    "solverProgressText",
    "solverProgressTrack"
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
    eraseCellElevationValue,
    getCellDescriptor,
    getCellTokens,
    getCellTools,
    isActorTool,
    normalizeCellValue,
    setCellElevationToken,
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
  const defaultSolverMaxExpandedStates = 1000000;
  const solverProgressYieldStateInterval = 4096;
  const solverProgressRenderIntervalMs = 80;
  const solutionDirections = {
    U: { label: "U", dx: 0, dy: -1 },
    D: { label: "D", dx: 0, dy: 1 },
    L: { label: "L", dx: -1, dy: 0 },
    R: { label: "R", dx: 1, dy: 0 }
  };
  const eraserToken = "__erase_top__";
  const eraserTool = {
    imageUrl: null,
    label: "Eraser",
    name: "eraser",
    selectable: true,
    token: eraserToken,
    type: "eraser"
  };
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
    isSolutionPlaying: false,
    isSolverBusy: false,
    levelId: authorData.initialLevel.levelId,
    message: authorData.initialLevel.exists
      ? "Loaded existing level."
      : "Fresh level. Paint something good.",
    messageTone: authorData.initialLevel.exists ? "success" : "warning",
    lastPaintTargetKey: null,
    paintDragPlane: null,
    paintPointerId: null,
    selectedCell: { x: 0, y: 0 },
    selectedToken:
      authorData.defaultWallToken || authorData.palette[0]?.token || authorData.defaultFloorToken,
    solverSolutionCellsKey: null,
    solverSolutionPath: null,
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

  function clearSolverSolution() {
    state.solverSolutionCellsKey = null;
    state.solverSolutionPath = null;
  }

  function rememberSolverSolution(path) {
    state.solverSolutionCellsKey = serializeCells();
    state.solverSolutionPath = String(path ?? "");
  }

  function hasPlayableSolution() {
    return (
      typeof state.solverSolutionPath === "string" &&
      state.solverSolutionCellsKey === serializeCells()
    );
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

    return tokens.some((token) => token.length > 0)
      ? normalizeCellValue(tokens.join(authorData.blockAdder))
      : authorData.defaultFloorToken;
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

  function createSolverEngine(playData) {
    const mazeEngine = window.MazeEngine;

    if (!mazeEngine || typeof mazeEngine.createEngine !== "function") {
      throw new Error("Solver engine is not available.");
    }

    return mazeEngine.createEngine(playData);
  }

  function getMazeSolver() {
    const mazeSolver = window.MazeSolver;

    if (
      !mazeSolver ||
      typeof mazeSolver.solveWithAStar !== "function" ||
      typeof mazeSolver.findHardestGemPlacement !== "function"
    ) {
      throw new Error("Solver module is not available.");
    }

    return mazeSolver;
  }

  function formatStateCount(value) {
    return Math.max(0, value).toLocaleString("en-US");
  }

  function getSolverMaxExpandedStates() {
    const value = Number(elements.solverMaxStates.value);

    if (!Number.isFinite(value) || value < 1) {
      return defaultSolverMaxExpandedStates;
    }

    return Math.max(1, Math.floor(value));
  }

  function normalizeSolverMaxExpandedStatesInput() {
    const maxExpandedStates = getSolverMaxExpandedStates();

    elements.solverMaxStates.value = String(maxExpandedStates);

    return maxExpandedStates;
  }

  function nextSolverProgressFrame() {
    return new Promise((resolve) => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => resolve());
        return;
      }

      window.setTimeout(resolve, 0);
    });
  }

  function renderSolverProgress(label, expanded, maxExpanded) {
    if (
      !elements.solverProgress ||
      !elements.solverProgressBar ||
      !elements.solverProgressText ||
      !elements.solverProgressTrack
    ) {
      return;
    }

    const safeMax = Math.max(1, maxExpanded);
    const safeExpanded = Math.max(0, Math.min(expanded, safeMax));
    const percent = Math.min(100, (safeExpanded / safeMax) * 100);

    elements.solverProgress.hidden = false;
    elements.solverProgress.removeAttribute("aria-hidden");
    elements.solverProgressBar.style.width = percent.toFixed(1) + "%";
    elements.solverProgressTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
    elements.solverProgressText.textContent =
      label +
      ": " +
      formatStateCount(safeExpanded) +
      " / " +
      formatStateCount(safeMax) +
      " states";
  }

  function hideSolverProgress() {
    if (
      !elements.solverProgress ||
      !elements.solverProgressBar ||
      !elements.solverProgressTrack
    ) {
      return;
    }

    elements.solverProgress.hidden = true;
    elements.solverProgress.setAttribute("aria-hidden", "true");
    elements.solverProgressBar.style.width = "0%";
    elements.solverProgressTrack.setAttribute("aria-valuenow", "0");
  }

  function createSolverProgressReporter(label, maxExpandedStates) {
    let lastRenderAt = 0;

    renderSolverProgress(label, 0, maxExpandedStates);

    return async function reportSolverProgress(progress, force = false) {
      const expanded = progress?.expanded ?? 0;
      const maxExpanded = progress?.maxExpanded ?? maxExpandedStates;
      const now =
        window.performance && typeof window.performance.now === "function"
          ? window.performance.now()
          : Date.now();

      if (!force && now - lastRenderAt < solverProgressRenderIntervalMs) {
        return;
      }

      lastRenderAt = now;
      renderSolverProgress(label, expanded, maxExpanded);
      await nextSolverProgressFrame();
    };
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
      fuzzyToggle: null,
      enableCameraControls: true
    });

    if (!app) {
      return null;
    }

    modules.registerRenderFunctions(app);
    if (typeof modules.registerGameplayFunctions === "function") {
      modules.registerGameplayFunctions(app);
    }
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

    if (state.isSolverBusy || state.isSolutionPlaying) {
      elements.solveLevel.disabled = true;
      elements.solveLevel.title = state.isSolverBusy ? "Search is running." : "Solution is playing.";
      elements.placeGem.disabled = true;
      elements.placeGem.title = elements.solveLevel.title;
      elements.playSolution.disabled = true;
      elements.playSolution.title = elements.solveLevel.title;
      return;
    }

    elements.solveLevel.disabled = !hasGem;
    elements.solveLevel.title = hasGem
      ? "Run A* from the current editor grid."
      : "Add a gem before running the solver.";
    elements.placeGem.disabled = !hasPlayer;
    elements.placeGem.title = hasPlayer
      ? "Find the hardest empty terrain cell the player can reach."
      : "Add a player before finding a gem placement.";
    elements.playSolution.disabled = !hasPlayableSolution();
    elements.playSolution.title = hasPlayableSolution()
      ? "Animate the last solver solution."
      : "Run the solver successfully before playing a solution.";
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

  function selectablePaletteTools() {
    return [eraserTool].concat(authorData.palette.filter((tool) => tool.selectable !== false));
  }

  function renderPalette() {
    elements.palette.innerHTML = selectablePaletteTools()
      .map((tool) => {
        const previewUrl = palettePreviewRenderer.previewsByToken.get(tool.token);
        const swatchContents = previewUrl
          ? '<img src="' + escapeHtml(previewUrl) + '" alt="">'
          : '<span class="palette__swatch-placeholder" aria-hidden="true"></span>';
        const accessibleLabel = tool.label + " (" + tool.token + ")";
        const tokenLabel = tool.token === eraserToken ? "Erase" : tool.token;

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
          escapeHtml(tokenLabel) +
          "</span>" +
          "</button>"
        );
      })
      .join("");
  }

  function createPalettePreviewPlayData(tool) {
    const width = 1;
    const height = 1;
    const cells = createBlankCells(width, height, authorData.defaultFloorToken);

    cells[0][0] = tool.token;

    return buildPlayData({
      cameraView: { width, height },
      cells,
      gameId: authorData.game.id,
      height,
      includeGems: true,
      levelId: "__palette_preview_" + encodeURIComponent(tool.token),
      levelLabel: tool.label || tool.token,
      width
    });
  }

  function capturePalettePreview(sceneCanvas) {
    const outputSize = 96;
    const sourceSize = Math.max(
      1,
      Math.round(Math.min(sceneCanvas.width, sceneCanvas.height) * 0.64)
    );
    const sourceX = Math.max(0, Math.round(sceneCanvas.width / 2 - sourceSize / 2));
    const sourceY = Math.max(0, Math.round(sceneCanvas.height / 2 - sourceSize / 2));
    const previewCanvas = document.createElement("canvas");
    const previewContext = previewCanvas.getContext("2d");

    if (!previewContext) {
      return "";
    }

    previewCanvas.width = outputSize;
    previewCanvas.height = outputSize;
    previewContext.imageSmoothingEnabled = true;
    previewContext.imageSmoothingQuality = "high";
    previewContext.fillStyle = "#d6bd94";
    previewContext.fillRect(0, 0, outputSize, outputSize);
    previewContext.drawImage(
      sceneCanvas,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      outputSize,
      outputSize
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

      const paletteTools = selectablePaletteTools().filter((tool) => tool.token !== eraserToken);

      if (paletteTools.length === 0) {
        return;
      }

      const previewPlayDataByToken = new Map(
        paletteTools.map((tool) => [tool.token, createPalettePreviewPlayData(tool)])
      );
      const firstPlayData = previewPlayDataByToken.get(paletteTools[0].token);
      const canvas = document.createElement("canvas");
      const app = modules.createPlayCore({
        playData: firstPlayData,
        canvas,
        playShell: null,
        playHeader: null,
        playStage: null,
        mazeFrame: null,
        fuzzyToggle: null,
        enableCameraControls: false
      });

      if (!app) {
        return;
      }

      modules.registerRenderFunctions(app);
      await Promise.all(
        Array.from(previewPlayDataByToken.values()).map((playData) =>
          app.preloadImagesForLevelState(playData)
        )
      );

      if (app.threeRendererReady && typeof app.threeRendererReady.then === "function") {
        await app.threeRendererReady;
      }

      const previewsByToken = new Map();
      previewPlayDataByToken.forEach((playData, token) => {
        app.applyLevelState(playData, {
          deferRender: true,
          immediateCamera: true,
          resetHistory: true,
          resetLevelEntry: true
        });
        app.liveRaisedPlayerGates = app.computeRaisedPlayerGateSet();
        app.liveRaisedOrangeWalls = app.computeRaisedOrangeWallSet();
        app.syncGateAnimationTargets(0);
        app.syncOrangeWallAnimationTargets(0);
        app.syncPlayerLiftAnimationTargets(0);
        app.renderCompositor.drawScene(0);

        const previewUrl = capturePalettePreview(app.sceneCanvas);

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

    elements.selectedToolLabel.textContent =
      state.selectedToken === eraserToken ? "Erase" : state.selectedToken;
    elements.selectedToolLabel.title =
      state.selectedToken === eraserToken
        ? eraserTool.label
        : tool
          ? tool.label
          : state.selectedToken;
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
    if (token !== eraserToken && !toolByToken.has(token)) {
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
    clearSolverSolution();
    state.isDirty = true;
    renderStatus();
    renderRawOutput();
    syncSolverButtonState();
  }

  function updateCellValue(x, y, normalizedValue) {
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

  function setCellValue(x, y, value) {
    updateCellValue(x, y, normalizeCellValue(value));
  }

  function appendTokenToCellValue(currentValue, token) {
    const normalizedToken = normalizeCellValue(token);
    const tokens = getCellTokens(currentValue);

    return normalizeCellValue(tokens.concat(normalizedToken).join(authorData.blockAdder));
  }

  function eraseTopCellValue(currentValue) {
    const tokens = getCellTokens(currentValue);

    tokens.pop();

    return normalizeCellValue(
      tokens.some((token) => token.length > 0)
        ? tokens.join(authorData.blockAdder)
        : authorData.defaultFloorToken
    );
  }

  function paintCell(x, y, value) {
    if (value === eraserToken) {
      updateCellValue(x, y, eraseTopCellValue(state.cells[y][x]));
      return;
    }

    updateCellValue(x, y, appendTokenToCellValue(state.cells[y][x], value));
  }

  function isInsideEditorCell(x, y) {
    return x >= 0 && y >= 0 && x < state.width && y < state.height;
  }

  function fallbackPaintTargetFromButton(button) {
    if (!button) {
      return null;
    }

    const x = Number(button.dataset.x);
    const y = Number(button.dataset.y);

    if (!isInsideEditorCell(x, y)) {
      return null;
    }

    return {
      face: "top",
      paintLayer: null,
      paintX: x,
      paintY: y,
      sourceLayer: null,
      sourceX: x,
      sourceY: y
    };
  }

  function paintTargetFromPointerEvent(event) {
    const pickedTarget = editorRenderer.app?.threeRenderer?.pickEditorFace?.(
      event.clientX,
      event.clientY,
      elements.canvas
    );

    if (pickedTarget) {
      return pickedTarget;
    }

    return fallbackPaintTargetFromButton(event.target.closest(".author-grid__cell"));
  }

  function syncEditorHoverFromPointerEvent(event) {
    const target = paintTargetFromPointerEvent(event);

    editorRenderer.app?.threeRenderer?.setEditorHoverTarget?.(target);
    return target;
  }

  function clearEditorHoverTarget() {
    editorRenderer.app?.threeRenderer?.setEditorHoverTarget?.(null);
  }

  function paintTargetKey(target) {
    if (!target) {
      return "";
    }

    const isEraser = state.selectedToken === eraserToken;
    const x = isEraser ? target.sourceX : target.paintX;
    const y = isEraser ? target.sourceY : target.paintY;

    return [
      state.selectedToken,
      x,
      y,
      target.paintLayer ?? "top",
      target.sourceLayer ?? "top",
      target.sourceX,
      target.sourceY,
      target.face || "top"
    ].join(":");
  }

  function paintFaceTarget(target) {
    if (!target) {
      return false;
    }

    if (state.selectedToken === eraserToken) {
      if (!isInsideEditorCell(target.sourceX, target.sourceY)) {
        return false;
      }

      updateCellValue(
        target.sourceX,
        target.sourceY,
        target.sourceLayer === null || target.sourceLayer === undefined
          ? eraseTopCellValue(state.cells[target.sourceY][target.sourceX])
          : eraseCellElevationValue(state.cells[target.sourceY][target.sourceX], target.sourceLayer)
      );
      return true;
    }

    if (!isInsideEditorCell(target.paintX, target.paintY)) {
      return false;
    }

    updateCellValue(
      target.paintX,
      target.paintY,
      target.paintLayer === null || target.paintLayer === undefined
        ? appendTokenToCellValue(state.cells[target.paintY][target.paintX], state.selectedToken)
        : setCellElevationToken(
            state.cells[target.paintY][target.paintX],
            state.selectedToken,
            target.paintLayer
          )
    );
    return true;
  }

  function paintFaceTargetOnce(target) {
    const key = paintTargetKey(target);

    if (!key || key === state.lastPaintTargetKey) {
      return false;
    }

    state.lastPaintTargetKey = key;
    return paintFaceTarget(target);
  }

  function paintGestureLayerForTarget(target) {
    if (!target) {
      return null;
    }

    return state.selectedToken === eraserToken
      ? target.sourceLayer
      : target.paintLayer;
  }

  function paintDragPlaneForTarget(target) {
    if (!target || target.face !== "top") {
      return null;
    }

    const layer = paintGestureLayerForTarget(target);

    if (layer === null || layer === undefined) {
      return null;
    }

    return {
      face: "top",
      layer
    };
  }

  function canDragPaintTarget(target) {
    if (!target || !state.paintDragPlane || target.face !== state.paintDragPlane.face) {
      return false;
    }

    return paintGestureLayerForTarget(target) === state.paintDragPlane.layer;
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
    clearSolverSolution();
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
    clearSolverSolution();
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

    clearSolverSolution();
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
    clearSolverSolution();
    state.selectedCell = nextSelectedCell;
    setStatus(message, "warning");
    state.isDirty = true;
    renderAll();
  }

  function applySelectedCellValue() {
    try {
      setCellValue(state.selectedCell.x, state.selectedCell.y, elements.cellValue.value);
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
      clearSolverSolution();
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
      if (state.solverSolutionCellsKey !== serializeCells()) {
        clearSolverSolution();
      }
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
    clearSolverSolution();
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
    state.isSolverBusy = true;
    syncSolverButtonState();
    const maxExpandedStates = normalizeSolverMaxExpandedStatesInput();
    renderSolverProgress("Place Gem", 0, maxExpandedStates);

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    try {
      const engine = createSolverEngine(buildEditorPlayData({ includeGems: false }));
      const result = await getMazeSolver().findHardestGemPlacement(engine, {
        canPlaceGemAt: isTerrainOnlyGemPlacementCell,
        maxExpandedStates,
        onProgress: createSolverProgressReporter("Place Gem", maxExpandedStates),
        progressYieldStateInterval: solverProgressYieldStateInterval
      });

      if (result.candidate) {
        const placedValue = applyGemPlacement(result.candidate);
        const prefix =
          result.status === "capped"
            ? "Place Gem: placed best spot before cap at "
            : "Place Gem: placed hardest spot at ";
        const suffix =
          result.status === "capped"
            ? " Search stopped after " + formatStateCount(result.expanded) + " states."
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
          formatStateCount(result.expanded) +
          " state" +
          (result.expanded === 1 ? "" : "s") +
          ".",
        "warning"
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Place Gem failed.", "error");
    } finally {
      state.isSolverBusy = false;
      hideSolverProgress();
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
    state.isSolverBusy = true;
    syncSolverButtonState();
    const maxExpandedStates = normalizeSolverMaxExpandedStatesInput();
    renderSolverProgress("A*", 0, maxExpandedStates);

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    try {
      const engine = createSolverEngine(playData);
      const result = await getMazeSolver().solveWithAStar(engine, {
        maxExpandedStates,
        onProgress: createSolverProgressReporter("A*", maxExpandedStates),
        progressYieldStateInterval: solverProgressYieldStateInterval
      });

      if (result.status === "solved") {
        rememberSolverSolution(result.path);
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
        clearSolverSolution();
        setStatus(
          "Solver: not possible. Explored " +
            formatStateCount(result.expanded) +
            " state" +
            (result.expanded === 1 ? "" : "s") +
            ".",
          "warning"
        );
      } else {
        clearSolverSolution();
        setStatus(
          "Solver: no answer within " +
            formatStateCount(result.maxExpanded) +
            " states. Search stopped after " +
            formatStateCount(result.expanded) +
            ".",
          "warning"
        );
      }
    } catch (error) {
      clearSolverSolution();
      setStatus(error instanceof Error ? error.message : "Solver failed.", "error");
    } finally {
      state.isSolverBusy = false;
      hideSolverProgress();
      syncSolverButtonState();
    }
  }

  function parseSolutionMoves(path) {
    const moves = [];

    for (const label of String(path ?? "")) {
      const direction = solutionDirections[label];

      if (!direction) {
        throw new Error("Solution contains an unsupported move: " + label + ".");
      }

      moves.push(direction);
    }

    return moves;
  }

  function performSolutionMove(app, direction) {
    let finishMove;
    const completion = new Promise((resolve) => {
      finishMove = resolve;
    });
    const result = app.movement.performPlayerMove(direction.dx, direction.dy, {
      animate: true,
      onFinish: finishMove,
      recordHistory: false
    });

    return result.moved ? completion.then(() => result) : Promise.resolve(result);
  }

  async function playSolution() {
    if (!hasPlayableSolution()) {
      setStatus("Run Solver successfully before playing a solution.", "error");
      syncSolverButtonState();
      return;
    }

    const solutionPath = state.solverSolutionPath;
    let moves;

    try {
      moves = parseSolutionMoves(solutionPath);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read the solution.", "error");
      syncSolverButtonState();
      return;
    }

    const playData = buildEditorRenderPlayData();
    const app = ensureEditorRenderApp(playData);

    if (!app || !app.movement || typeof app.movement.performPlayerMove !== "function") {
      setStatus("Solution playback is not available.", "error");
      syncSolverButtonState();
      return;
    }

    state.isSolutionPlaying = true;
    setStatus("Playing solver solution...", "warning");
    syncSolverButtonState();

    try {
      app.applyLevelState(playData, {
        deferRender: true,
        immediateCamera: true,
        resetHistory: true,
        resetLevelEntry: true
      });
      await app.preloadImagesForLevelState(playData);
      app.render();

      for (let index = 0; index < moves.length; index += 1) {
        const result = await performSolutionMove(app, moves[index]);

        if (!result.moved) {
          throw new Error(
            "Solution stopped at move " +
              (index + 1) +
              " (" +
              moves[index].label +
              ")."
          );
        }
      }

      setStatus(
        "Played solution: " +
          moves.length +
          " move" +
          (moves.length === 1 ? "" : "s") +
          ". UDLR: " +
          formatSolverPath(solutionPath) +
          ".",
        "success"
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not play the solution.", "error");
    } finally {
      state.isSolutionPlaying = false;
      syncSolverButtonState();
    }
  }

  function handleGridPointerDown(event) {
    const target = syncEditorHoverFromPointerEvent(event);

    if (!target) {
      return;
    }

    event.preventDefault();
    state.paintPointerId = event.pointerId;
    state.lastPaintTargetKey = null;
    state.paintDragPlane = paintDragPlaneForTarget(target);
    elements.grid.setPointerCapture?.(event.pointerId);
    paintFaceTargetOnce(target);
  }

  function handleGridPointerMove(event) {
    const target = syncEditorHoverFromPointerEvent(event);

    if (state.paintPointerId !== event.pointerId || event.buttons !== 1) {
      return;
    }

    if (!canDragPaintTarget(target)) {
      return;
    }

    paintFaceTargetOnce(target);
  }

  function stopPainting(event) {
    if (state.paintPointerId === event.pointerId) {
      state.paintPointerId = null;
      state.lastPaintTargetKey = null;
      state.paintDragPlane = null;
      if (elements.grid.hasPointerCapture?.(event.pointerId)) {
        elements.grid.releasePointerCapture(event.pointerId);
      }
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
  elements.grid.addEventListener("pointerleave", function (event) {
    if (state.paintPointerId !== event.pointerId) {
      clearEditorHoverTarget();
    }
  });
  elements.grid.addEventListener("contextmenu", function (event) {
    const target = paintTargetFromPointerEvent(event);

    if (!target || !isInsideEditorCell(target.sourceX, target.sourceY)) {
      return;
    }

    event.preventDefault();
    const x = target.sourceX;
    const y = target.sourceY;
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
  elements.playSolution.addEventListener("click", playSolution);
  elements.solverMaxStates.addEventListener("change", normalizeSolverMaxExpandedStatesInput);
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
