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
    hillClimb: document.getElementById("hill-climb"),
    hillClimbMode: document.getElementById("hill-climb-mode"),
    hillClimbNext: document.getElementById("hill-climb-next"),
    hillClimbPrev: document.getElementById("hill-climb-prev"),
    hillClimbResultLabel: document.getElementById("hill-climb-result-label"),
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
    solverAlgorithm: document.getElementById("solver-algorithm"),
    solverCancel: document.getElementById("solver-cancel"),
    solverProgress: document.getElementById("solver-progress"),
    solverProgressBar: document.getElementById("solver-progress-bar"),
    solverProgressText: document.getElementById("solver-progress-text"),
    solverProgressTrack: document.getElementById("solver-progress-track"),
    solverMaxStates: document.getElementById("solver-max-states"),
    status: document.getElementById("author-status"),
    undoLevel: document.getElementById("undo-level")
  };

  const optionalElementKeys = new Set([
    "boardSizeLabel",
    "currentFileName",
    "currentLevelName",
    "existingLevels",
    "hillClimb",
    "hillClimbMode",
    "hillClimbNext",
    "hillClimbPrev",
    "hillClimbResultLabel",
    "levelColumn",
    "levelRow",
    "solverAlgorithm",
    "solverCancel",
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
    appendCellToken,
    normalizeAuthoringCellValue,
    normalizeCellValue,
    setCellElevationToken,
    setSurfaceAttachmentToken,
    toolByName,
    toolByToken
  } = playDataAdapter;
  const editorTileSize = 64;
  const minimumEditorTileSize = 12;
  const editorGridOutlineSize = 8;
  const editorRenderer = {
    app: null,
    hasCompletedPreload: false,
    layoutFrameId: null,
    preloadVersion: 0,
    preloadedTokens: new Set(),
    sceneFrameId: null
  };
  // MazeBench editor boot: when the host page exposes a MARK_READY hook, the
  // first canvas frames render in the home "vector boot" look (black blocks,
  // blue edges primed hidden), the loading cover lifts over that frame, the
  // edge sweep traces the room in, then the glow melts into editor colors.
  // pending -> armed (theme applied before first mesh) -> running -> done.
  const editorBootReveal = { state: "pending" };
  const palettePreviewRenderer = {
    previewsByToken: new Map(),
    promise: null
  };
  const editorGridRectCache = { rect: null };
  const pointerMoveScheduler = {
    event: null,
    frameId: null,
    processor: null
  };
  const defaultSolverMaxExpandedStates = 1000000;
  const solverProgressYieldStateInterval = 4096;
  const solverProgressRenderIntervalMs = 80;
  const undoStackLimit = 80;
  const solutionDirections = {
    U: { label: "U", dx: 0, dy: -1 },
    D: { label: "D", dx: 0, dy: 1 },
    L: { label: "L", dx: -1, dy: 0 },
    R: { label: "R", dx: 1, dy: 0 }
  };
  const eraserToken = "__erase_top__";
  const emptyCellToken = authorData.blockAdder || "+";
  const noopToken = "__select_only__";
  const noopTool = {
    imageUrl: null,
    label: "Select",
    name: "select_only",
    selectable: true,
    token: noopToken,
    type: "select_only"
  };
  const eraserTool = {
    imageUrl: null,
    label: "Eraser",
    name: "eraser",
    selectable: true,
    token: eraserToken,
    type: "eraser"
  };
  const iceSlopeTools = authorData.palette.filter((tool) => isIceSlopeTool(tool));
  const canonicalIceSlopeToken = iceSlopeTools[0]?.token || null;
  const iceSlopeTokenByDirection = new Map(
    iceSlopeTools
      .filter((tool) => typeof tool.direction === "string" && tool.direction)
      .map((tool) => [tool.direction, tool.token])
  );
  const iceSlopePaletteTool = canonicalIceSlopeToken
    ? {
        ...iceSlopeTools[0],
        description:
          "An icy ramp that carries a slide between heights. It aims to match the camera — turn the camera to change which way it climbs.",
        displayToken: "S",
        label: "Ice Slope",
        token: canonicalIceSlopeToken
      }
    : null;

  function toolDescription(tool) {
    if (!tool) return "";
    if (tool.token === noopToken) return "Inspect and select cells without painting anything.";
    if (tool.token === eraserToken) return "Clear the cell back to plain floor.";
    return typeof tool.description === "string" ? tool.description : "";
  }
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
    isLevelSwitching: false,
    isSolutionPlaying: false,
    isSolverBusy: false,
    levelId: authorData.initialLevel.levelId,
    message: authorData.initialLevel.exists
      ? "Loaded existing level."
      : "Fresh level. Paint something good.",
    messageTone: authorData.initialLevel.exists ? "success" : "warning",
    lastPaintTargetKey: null,
    eraseGestureMode: null,
    hillClimbResults: [],
    hillClimbResultIndex: -1,
    paintDragPlane: null,
    paintPointerId: null,
    paintStrokeDidPaint: false,
    savedBoardSignature: boardSignature(
      authorData.initialLevel.width,
      authorData.initialLevel.height,
      authorData.initialLevel.cells
    ),
    selectedCell: { x: 0, y: 0 },
    selectedToken:
      authorData.defaultWallToken || authorData.palette[0]?.token || authorData.defaultFloorToken,
    solverAbortController: null,
    solverSolutionCellsKey: null,
    solverSolutionPath: null,
    undoStack: [],
    width: authorData.initialLevel.width
  };

  function editorSnapshot() {
    return {
      cells: cloneCells(state.cells),
      height: state.height,
      selectedCell: {
        x: state.selectedCell.x,
        y: state.selectedCell.y
      },
      width: state.width
    };
  }

  function snapshotSignature(snapshot) {
    return boardSignature(snapshot.width, snapshot.height, snapshot.cells);
  }

  function undoSnapshotSignature(snapshot) {
    if (typeof snapshot.signature !== "string") {
      snapshot.signature = snapshotSignature(snapshot);
    }

    return snapshot.signature;
  }

  function syncUndoButtonState() {
    const isLocked = state.isLevelSwitching || state.isSolverBusy || state.isSolutionPlaying;

    elements.undoLevel.disabled = state.undoStack.length === 0 || isLocked;
    elements.undoLevel.title =
      state.undoStack.length === 0
        ? "Nothing to undo yet."
        : isLocked
          ? "Finish the current editor action before undoing."
          : "Undo the last editor change.";
  }

  // Callers that already verified the board is about to change (for example
  // per-cell painting) pass { boardChanged: true } so drag strokes skip the
  // full-board signature comparison entirely. Signatures are computed at most
  // once per snapshot and cached for later comparisons.
  function pushUndoSnapshot(options = {}) {
    const snapshot = editorSnapshot();
    const previous = state.undoStack[state.undoStack.length - 1];

    if (
      previous &&
      options.boardChanged !== true &&
      undoSnapshotSignature(previous) === undoSnapshotSignature(snapshot)
    ) {
      return;
    }

    state.undoStack.push(snapshot);

    if (state.undoStack.length > undoStackLimit) {
      state.undoStack.shift();
    }

    syncUndoButtonState();
  }

  function clearHillClimbResults() {
    state.hillClimbResults = [];
    state.hillClimbResultIndex = -1;
    syncHillClimbResultControls();
  }

  function clearUndoHistory() {
    state.undoStack = [];
    syncUndoButtonState();
  }

  function restoreEditorSnapshot(snapshot) {
    state.cells = cloneCells(snapshot.cells);
    state.height = snapshot.height;
    state.selectedCell = {
      x: Math.max(0, Math.min(snapshot.width - 1, snapshot.selectedCell.x)),
      y: Math.max(0, Math.min(snapshot.height - 1, snapshot.selectedCell.y))
    };
    state.width = snapshot.width;
    state.isDirty =
      boardSignature(state.width, state.height, state.cells) !== state.savedBoardSignature;
    clearSolverSolution();
    clearHillClimbResults();
    renderAll();
  }

  function undoLastEdit() {
    if (state.isLevelSwitching || state.isSolverBusy || state.isSolutionPlaying) {
      return false;
    }

    const snapshot = state.undoStack.pop();

    if (!snapshot) {
      setStatus("Nothing to undo.", "warning");
      return false;
    }

    restoreEditorSnapshot(snapshot);
    setStatus("Undid the last edit.", state.isDirty ? "warning" : "success");
    syncUndoButtonState();
    return true;
  }

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

  function boardSignature(width, height, cells) {
    return [
      width,
      height,
      cells.map((row) => row.join(authorData.separator)).join("\n")
    ].join("\n");
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

    const nextColumnIndex = columnIndex + dx;
    const nextRowIndex = rowIndex + dy;

    if (
      nextColumnIndex < 0 ||
      nextRowIndex < 0 ||
      nextColumnIndex >= worldColumns.length ||
      nextRowIndex >= worldRows.length
    ) {
      return null;
    }

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

  function currentHillClimbResult() {
    if (
      !Array.isArray(state.hillClimbResults) ||
      state.hillClimbResultIndex < 0 ||
      state.hillClimbResultIndex >= state.hillClimbResults.length
    ) {
      return null;
    }

    return state.hillClimbResults[state.hillClimbResultIndex];
  }

  function hillClimbResultSummary(result, index = state.hillClimbResultIndex, total = state.hillClimbResults.length) {
    if (!result) {
      return "";
    }

    return (
      "Result " +
      (index + 1) +
      "/" +
      total +
      ": wall " +
      (result.wallX + 1) +
      ", " +
      (result.wallY + 1) +
      " - " +
      result.moves +
      " move" +
      (result.moves === 1 ? "" : "s")
    );
  }

  function syncHillClimbResultControls() {
    const hasResults = Array.isArray(state.hillClimbResults) && state.hillClimbResults.length > 0;
    const isLocked = state.isSolverBusy || state.isSolutionPlaying || state.isLevelSwitching;

    if (elements.hillClimbPrev) {
      elements.hillClimbPrev.disabled =
        isLocked || !hasResults || state.hillClimbResultIndex <= 0;
      elements.hillClimbPrev.title = hasResults
        ? "Show the previous hill-climb result."
        : "Run Hill-Climb before paging results.";
    }

    if (elements.hillClimbNext) {
      elements.hillClimbNext.disabled =
        isLocked ||
        !hasResults ||
        state.hillClimbResultIndex >= state.hillClimbResults.length - 1;
      elements.hillClimbNext.title = hasResults
        ? "Show the next hill-climb result."
        : "Run Hill-Climb before paging results.";
    }

    if (elements.hillClimbResultLabel) {
      elements.hillClimbResultLabel.textContent = hasResults
        ? hillClimbResultSummary(currentHillClimbResult())
        : "";
    }
  }

  function levelHasGem() {
    const cells = arguments.length > 0 ? arguments[0] : state.cells;

    return cells.some((row) =>
      row.some((cell) => getCellTools(cell).some((tool) => tool.name === "gem"))
    );
  }

  function levelHasPlayer() {
    const cells = arguments.length > 0 ? arguments[0] : state.cells;

    return cells.some((row) =>
      row.some((cell) =>
        getCellTools(cell).some((tool) => tool.name === "player" || tool.name === "circle_player")
      )
    );
  }

  function gemPlacementSurfaceKey(x, y, elevation) {
    return x + "," + y + "," + Math.max(0, Math.floor(Number(elevation) || 0));
  }

  function gemTerrainSurfaceElevation(layer) {
    const type = layer?.type || "";
    const elevation = Math.max(0, Math.floor(Number(layer?.elevation) || 0));

    if (!type || type === "empty" || type === "hole") {
      return null;
    }

    if (type === "tree") {
      return elevation + 3;
    }

    if (type === "player_lift") {
      return elevation + (layer.raised === true ? 1 : 0);
    }

    if (["wall", "ice_block", "ice_slope", "shrub", "block_asset", "orange_wall"].includes(type)) {
      return elevation + 1;
    }

    return elevation;
  }

  function gemPlacementSurfaceSets(cells = state.cells) {
    const playData = buildEditorPlayData({ cells, includeGems: false });
    const blockedSurfaces = new Set();
    const validSurfaces = new Set();

    playData.terrain.forEach((row, y) => {
      row.forEach((terrain, x) => {
        const layers = Array.isArray(terrain?.layers) ? terrain.layers : [];

        layers.forEach((layer) => {
          const surfaceElevation = gemTerrainSurfaceElevation(layer);

          if (surfaceElevation !== null) {
            validSurfaces.add(gemPlacementSurfaceKey(x, y, surfaceElevation));
          }
        });
      });
    });

    playData.actors.forEach((actor) => {
      if (actor.type === "gem") {
        return;
      }

      const elevation = Math.max(0, Math.floor(Number(actor.elevation) || 0));
      blockedSurfaces.add(gemPlacementSurfaceKey(actor.x, actor.y, elevation));

      if (["box", "floating_floor", "weightless_box"].includes(actor.type)) {
        validSurfaces.add(gemPlacementSurfaceKey(actor.x, actor.y, elevation + 1));
      }
    });

    return { blockedSurfaces, validSurfaces };
  }

  function canPlaceGemAtSurface(x, y, elevation, surfaceSets) {
    if (!isInsideEditorCell(x, y)) {
      return false;
    }

    const key = gemPlacementSurfaceKey(x, y, elevation);
    return surfaceSets.validSurfaces.has(key) && !surfaceSets.blockedSurfaces.has(key);
  }

  function gemPlacementValueForCell(x, y, elevation = 0) {
    return gemPlacementValueForCells(state.cells, x, y, elevation);
  }

  function gemPlacementValueForCells(cells, x, y, elevation = 0) {
    const gemToken = toolByName.get("gem")?.token || "G";
    return setCellElevationToken(cells[y]?.[x] ?? emptyCellToken, gemToken, elevation);
  }

  function stripGemFromCellValue(value) {
    const gemToken = toolByName.get("gem")?.token || "G";
    const tokens = getCellTokens(value).filter((token) => token !== gemToken);

    return normalizeAuthoringCellValue(
      tokens.some((token) => token.length > 0)
        ? tokens.join(authorData.blockAdder)
        : emptyCellToken
    );
  }

  function buildEditorPlayData(options = {}) {
    return buildPlayData({
      cameraView: options.cameraView || null,
      cells: options.cells || state.cells,
      editorRender: options.editorRender === true,
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

  function getSolverAlgorithm() {
    if (elements.solverAlgorithm?.value === "bfs") {
      return "bfs";
    }

    return elements.solverAlgorithm?.value === "weighted_astar" ? "weighted_astar" : "astar";
  }

  function solverAlgorithmLabel(algorithm = getSolverAlgorithm()) {
    if (algorithm === "bfs") {
      return "BFS";
    }

    return algorithm === "weighted_astar" ? "Weighted A*" : "A*";
  }

  function getHillClimbMode() {
    return elements.hillClimbMode?.value === "fixed_gem" ? "fixed_gem" : "place_gem";
  }

  function hillClimbModeLabel(mode = getHillClimbMode()) {
    return mode === "fixed_gem" ? "Fixed Gem" : "Place Gem";
  }

  function createSolverAbortController() {
    if (typeof window.AbortController === "function") {
      return new window.AbortController();
    }

    const signal = { aborted: false };

    return {
      signal,
      abort() {
        signal.aborted = true;
      }
    };
  }

  function beginSolverRun() {
    state.solverAbortController = createSolverAbortController();
    state.isSolverBusy = true;
    syncSolverButtonState();
    return state.solverAbortController.signal;
  }

  function finishSolverRun() {
    state.isSolverBusy = false;
    state.solverAbortController = null;
    hideSolverProgress();
    syncSolverButtonState();
  }

  function isSolverCancelError(error) {
    return Boolean(error && (error.name === "AbortError" || error.message === "Solver cancelled."));
  }

  function cancelSolverRun() {
    if (!state.isSolverBusy || !state.solverAbortController) {
      return;
    }

    state.solverAbortController.abort();
    setStatus("Cancelling solver...", "warning");
    syncSolverButtonState();
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
      editorRender: true,
      levelId: state.levelId,
      levelLabel: state.levelId,
      worldColumns,
      worldRows
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
    app.isEditorRenderApp = true;
    if (
      editorBootReveal.state === "pending" &&
      typeof window.__MAZEBENCH_AUTHOR_MARK_READY__ === "function"
    ) {
      // Theme BEFORE the first mesh so the initial frame is already the
      // vector look — no colored flash under the loading cover.
      editorBootReveal.state = "armed";
      app.homeVectorTheme = true;
      app.vectorGlowAmount = 1;
    }
    editorRenderer.app = app;
    return app;
  }

  function boardImageTokens() {
    const tokens = new Set();

    state.cells.forEach((row) => {
      row.forEach((value) => {
        getCellTokens(value).forEach((token) => {
          if (token.length > 0) {
            tokens.add(token);
          }
        });
      });
    });

    return tokens;
  }

  function hasUnpreloadedBoardToken(tokens) {
    for (const token of tokens) {
      if (!editorRenderer.preloadedTokens.has(token)) {
        return true;
      }
    }

    return false;
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

    if (editorBootReveal.state === "armed") {
      editorBootReveal.state = "running";
      runEditorBootReveal(app);
    }

    // Only re-run the image preload pass when the board introduces a token
    // whose imagery has not been preloaded successfully yet.
    const boardTokens = boardImageTokens();

    if (editorRenderer.hasCompletedPreload && !hasUnpreloadedBoardToken(boardTokens)) {
      return;
    }

    const preloadVersion = editorRenderer.preloadVersion + 1;
    editorRenderer.preloadVersion = preloadVersion;

    app.preloadImagesForLevelState(playData)
      .then(() => {
        if (editorRenderer.app === app && editorRenderer.preloadVersion === preloadVersion) {
          editorRenderer.hasCompletedPreload = true;
          boardTokens.forEach((token) => editorRenderer.preloadedTokens.add(token));
          app.render();
        }
      })
      .catch(() => {});
  }

  function markAuthorPageReady() {
    try {
      window.__MAZEBENCH_AUTHOR_MARK_READY__?.();
      window.__MAZEJAM_AUTHOR_MARK_READY__?.();
    } catch {
      // The cover's own fallback timer still lifts it.
    }
  }

  async function runEditorBootReveal(app) {
    const timing = (window.__MAZEBENCH_AUTHOR_BOOT__ = window.__MAZEBENCH_AUTHOR_BOOT__ || {});
    const finishLook = () => {
      editorBootReveal.state = "done";
      timing.fallbackAtMs = Math.round(performance.now());
      app.homeVectorTheme = false;
      app.vectorGlowAmount = 0;
      app.threeRenderer?.invalidateSceneCache?.();
      app.render();
    };
    try {
      if (app.threeRendererReady && typeof app.threeRendererReady.then === "function") {
        await app.threeRendererReady;
      }
      const renderer = app.threeRenderer;
      if (!renderer || typeof renderer.beginHomeEdgeReveal !== "function") {
        finishLook();
        markAuthorPageReady();
        return;
      }
      // Hide the edges, render the black vector-boot frame while the cover
      // is still up, then lift the cover into the sweep. The sweep sizes its
      // own duration to the room, so small boards finish quickly.
      const reducedMotion =
        window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
      if (!reducedMotion && typeof renderer.setDebugCameraView === "function") {
        // Start pulled back at a vista-like low angle; the editor's resting
        // framing IS the debug camera at (yaw 0, tilt 0.22, zoom 1), so the
        // post-sweep swoop lands exactly on the normal editor view.
        renderer.setDebugCameraView({
          yaw: 0,
          tilt: 1.15,
          zoom: 0.55,
          mode: "perspective",
          skipRender: true
        });
      }
      renderer.primeHomeEdgeReveal?.();
      renderer.invalidateSceneCache?.();
      app.render();
      markAuthorPageReady();
      timing.sweepStartedAtMs = Math.round(performance.now());
      renderer.beginHomeEdgeReveal({
        onComplete: () => {
          timing.sweepDoneAtMs = Math.round(performance.now());
          // Swoop down into the editing view while the glow melts into the
          // normal palette — the same construction-then-dive the play routes
          // land with.
          const swoopMs = reducedMotion ? 0 : 700;
          if (swoopMs > 0) {
            renderer.setDebugCameraView({
              yaw: 0,
              tilt: 0.22,
              zoom: 1,
              animate: true,
              durationMs: swoopMs
            });
          }
          meltEditorVectorLook(app, reducedMotion ? 220 : swoopMs);
        }
      });
    } catch {
      finishLook();
      markAuthorPageReady();
    }
  }

  function meltEditorVectorLook(app, durationMs = 450) {
    const renderer = app.threeRenderer;
    const startedAt = performance.now();
    const step = (now) => {
      const raw = (now - startedAt) / Math.max(1, durationMs);
      const progress = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const eased = progress * progress * (3 - 2 * progress);
      app.vectorGlowAmount = 1 - eased;
      renderer?.invalidateSceneCache?.();
      // Coalesce with the camera swoop's own per-frame renders.
      (app.renderOncePerFrame || app.render)(now);
      if (progress < 1) {
        window.requestAnimationFrame(step);
        return;
      }
      editorBootReveal.state = "done";
      if (window.__MAZEBENCH_AUTHOR_BOOT__) {
        window.__MAZEBENCH_AUTHOR_BOOT__.meltDoneAtMs = Math.round(performance.now());
      }
      app.homeVectorTheme = false;
      app.vectorGlowAmount = 0;
      renderer?.invalidateSceneCache?.();
      app.render();
    };
    window.requestAnimationFrame(step);
  }

  function scheduleEditorSceneRender() {
    if (editorRenderer.sceneFrameId !== null) {
      return;
    }

    editorRenderer.sceneFrameId = window.requestAnimationFrame(() => {
      editorRenderer.sceneFrameId = null;
      renderEditorScene();
    });
  }

  function cancelScheduledEditorSceneRender() {
    if (editorRenderer.sceneFrameId === null) {
      return;
    }

    window.cancelAnimationFrame(editorRenderer.sceneFrameId);
    editorRenderer.sceneFrameId = null;
  }

  function setStatus(message, tone) {
    state.message = message;
    state.messageTone = tone || "warning";
    renderStatus();
  }

  function renderStatus() {
    elements.status.textContent = state.message;
    elements.status.className = "author-status is-" + state.messageTone;
    // The Save button carries the dirty state: amber + pulsing dot while
    // there are unsaved changes, quiet "Saved" once everything is stored.
    if (elements.saveLevel) {
      elements.saveLevel.disabled = !state.isDirty;
      elements.saveLevel.textContent = state.isDirty ? "Save" : "Saved";
      elements.saveLevel.classList.toggle("has-unsaved", state.isDirty);
    }
    renderWorldStats();
    syncUndoButtonState();
  }

  function currentLevelGemCount() {
    let count = 0;
    state.cells.forEach((row) => {
      row.forEach((cell) => {
        String(cell || "")
          .split(/[+\s]+/)
          .forEach((token) => {
            if (token === "G") {
              count += 1;
            }
          });
      });
    });
    return count;
  }

  function formatWorldUpdatedAt(value) {
    if (!value) {
      return "--";
    }
    const parsed = new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z"));
    if (Number.isNaN(parsed.getTime())) {
      return String(value);
    }
    return parsed.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function renderWorldStats() {
    const meta = authorData.worldMeta;
    const sizeEl = document.getElementById("world-stat-size");
    if (!meta || !sizeEl) {
      return;
    }
    const gemsByLevel = { ...meta.gemsByLevel, [state.levelId]: currentLevelGemCount() };
    const roomIds = new Set(Object.keys(meta.gemsByLevel));
    // Fresh rooms only count as built once they have actually been saved.
    if (state.exists) {
      roomIds.add(state.levelId);
    }
    const totalGems = Object.values(gemsByLevel).reduce((sum, value) => sum + (value || 0), 0);
    sizeEl.textContent = meta.width + " × " + meta.height + " rooms";
    const roomsEl = document.getElementById("world-stat-rooms");
    if (roomsEl) {
      roomsEl.textContent = roomIds.size + " / " + meta.width * meta.height;
    }
    const gemsEl = document.getElementById("world-stat-gems");
    if (gemsEl) {
      gemsEl.textContent = String(totalGems);
    }
    const statusEl = document.getElementById("world-stat-status");
    if (statusEl) {
      statusEl.textContent =
        meta.status === "published"
          ? meta.reviewStatus === "approved"
            ? "Published v" + (meta.publishVersion || 1)
            : "Published (in review)"
          : "Draft";
    }
    const updatedEl = document.getElementById("world-stat-updated");
    if (updatedEl) {
      updatedEl.textContent = state.isDirty
        ? "Unsaved changes"
        : meta.savedThisSession
          ? "Just now"
          : formatWorldUpdatedAt(meta.updatedAt);
      updatedEl.classList.toggle("is-dirty", state.isDirty);
    }
  }

  function syncSolverButtonState() {
    const hasGem = levelHasGem();
    const hasPlayer = levelHasPlayer();

    if (state.isSolverBusy || state.isSolutionPlaying) {
      elements.solveLevel.disabled = true;
      elements.solveLevel.title = state.isSolverBusy ? "Search is running." : "Solution is playing.";
      elements.placeGem.disabled = true;
      elements.placeGem.title = elements.solveLevel.title;
      if (elements.hillClimb) {
        elements.hillClimb.disabled = true;
        elements.hillClimb.title = elements.solveLevel.title;
      }
      elements.playSolution.disabled = true;
      elements.playSolution.title = elements.solveLevel.title;
      if (elements.solverAlgorithm) {
        elements.solverAlgorithm.disabled = true;
      }
      if (elements.hillClimbMode) {
        elements.hillClimbMode.disabled = true;
      }
      if (elements.solverCancel) {
        elements.solverCancel.disabled = !state.isSolverBusy;
        elements.solverCancel.title = state.isSolverBusy
          ? "Cancel the running search."
          : "No solver search is running.";
      }
      syncHillClimbResultControls();
      syncUndoButtonState();
      return;
    }

    if (elements.solverAlgorithm) {
      elements.solverAlgorithm.disabled = false;
    }
    if (elements.hillClimbMode) {
      elements.hillClimbMode.disabled = false;
    }
    if (elements.solverCancel) {
      elements.solverCancel.disabled = true;
      elements.solverCancel.title = "No solver search is running.";
    }
    elements.solveLevel.disabled = !hasGem;
    elements.solveLevel.title = hasGem
      ? "Run " + solverAlgorithmLabel() + " from the current editor grid."
      : "Add a gem before running the solver.";
    elements.placeGem.disabled = !hasPlayer;
    elements.placeGem.title = hasPlayer
      ? "Find the hardest open surface the player can reach."
      : "Add a player before finding a gem placement.";
    if (elements.hillClimb) {
      const fixedGemMode = getHillClimbMode() === "fixed_gem";
      const canHillClimb = hasPlayer && (!fixedGemMode || hasGem);
      elements.hillClimb.disabled = !canHillClimb;
      elements.hillClimb.title = !hasPlayer
        ? "Add a player before hill-climbing wall placement."
        : fixedGemMode && !hasGem
          ? "Add a gem before hill-climbing with a fixed gem."
          : fixedGemMode
            ? "Try one added wall per tile and keep the longest solution to the current gem."
            : "Try one added wall per tile and keep the longest Place Gem result.";
    }
    elements.playSolution.disabled = !hasPlayableSolution();
    elements.playSolution.title = hasPlayableSolution()
      ? "Animate the last solver solution."
      : "Run the solver successfully before playing a solution.";
    syncHillClimbResultControls();
    syncUndoButtonState();
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
    const tools = [noopTool, eraserTool];
    let hasAddedIceSlope = false;

    authorData.palette.forEach((tool) => {
      if (
        tool.selectable === false ||
        tool.name === "hole" ||
        tool.name === "box" ||
        tool.token === "b"
      ) {
        return;
      }

      if (isIceSlopeTool(tool)) {
        if (hasAddedIceSlope || !iceSlopePaletteTool) {
          return;
        }

        hasAddedIceSlope = true;
        tools.push(iceSlopePaletteTool);
        return;
      }

      tools.push(tool);
    });

    return tools;
  }

  // ---- Toolbox (inventory) + bottom hotbar ----
  const INVENTORY_GROUPS = [
    { match: (tool) => ["select_only", "eraser", "floor", "ice", "wall", "ice_block"].includes(tool.name), name: "Basics" },
    {
      match: (tool) =>
        ["ice_slope", "player_gate", "player_lift", "orange_wall", "orange_button", "puncher", "floating_floor", "weightless_box"].includes(tool.name),
      name: "Mechanisms"
    },
    { match: (tool) => ["player", "clone", "gem"].includes(tool.name), name: "Players & Goals" },
    { match: () => true, name: "Scenery" }
  ];
  const HOTBAR_BASE_TOKENS = [
    noopToken,
    eraserToken,
    authorData.defaultFloorToken,
    "i",
    authorData.defaultWallToken,
    canonicalIceSlopeToken,
    "G",
    "p"
  ].filter(Boolean);
  let hotbarExtraToken = "g";
  let hotbarToolnameTimer = 0;

  function toolForToken(token) {
    if (token === noopToken) {
      return noopTool;
    }
    if (token === eraserToken) {
      return eraserTool;
    }
    if (iceSlopePaletteTool && token === iceSlopePaletteTool.token) {
      return iceSlopePaletteTool;
    }
    return toolByToken.get(token) || null;
  }

  function hotbarTokens() {
    const tokens = HOTBAR_BASE_TOKENS.slice();
    if (hotbarExtraToken && !tokens.includes(hotbarExtraToken) && toolForToken(hotbarExtraToken)) {
      tokens.push(hotbarExtraToken);
    }
    return tokens;
  }

  function toolSwatchMarkup(tool) {
    if (tool.token === noopToken) {
      return '<span class="palette__swatch-glyph" aria-hidden="true">-</span>';
    }
    if (tool.token === eraserToken) {
      return '<span class="palette__swatch-glyph" aria-hidden="true">&times;</span>';
    }
    const previewUrl = palettePreviewRenderer.previewsByToken.get(tool.token);
    return previewUrl
      ? '<img src="' + escapeHtml(previewUrl) + '" alt="">'
      : '<span class="palette__swatch-placeholder" aria-hidden="true"></span>';
  }

  function renderPalette() {
    if (!elements.palette) {
      return;
    }
    const tools = selectablePaletteTools();
    const used = new Set();
    elements.palette.innerHTML = INVENTORY_GROUPS.map((group) => {
      const groupTools = tools.filter((tool) => !used.has(tool.token) && group.match(tool));
      groupTools.forEach((tool) => used.add(tool.token));
      if (!groupTools.length) {
        return "";
      }
      return (
        '<section class="author-inv-group"><h4>' +
        escapeHtml(group.name) +
        "</h4>" +
        '<div class="author-inv-group__items">' +
        groupTools
          .map(
            (tool) =>
              '<button class="author-inv-item' +
              (tool.token === state.selectedToken ? " is-active" : "") +
              '" type="button" data-token="' +
              escapeHtml(tool.token) +
              '" title="' +
              escapeHtml(tool.label || tool.token) +
              '">' +
              '<span class="palette__swatch">' +
              toolSwatchMarkup(tool) +
              "</span>" +
              '<span class="author-inv-item__name">' +
              escapeHtml(tool.label || tool.token) +
              "</span>" +
              "</button>"
          )
          .join("") +
        "</div></section>"
      );
    }).join("");
    renderHotbar();
    renderInventoryDetail();
  }

  function renderHotbar() {
    const slots = document.getElementById("hotbar-slots");
    if (!slots) {
      return;
    }
    slots.innerHTML = hotbarTokens()
      .map((token, index) => {
        const tool = toolForToken(token);
        if (!tool) {
          return "";
        }
        return (
          '<button class="author-hotbar__slot' +
          (token === state.selectedToken ? " is-active" : "") +
          '" type="button" data-token="' +
          escapeHtml(token) +
          '" title="' +
          escapeHtml((tool.label || token) + " (" + (index + 1) + ")") +
          '" aria-label="' +
          escapeHtml(tool.label || token) +
          '">' +
          '<span class="author-hotbar__key" aria-hidden="true">' +
          (index + 1) +
          "</span>" +
          '<span class="palette__swatch">' +
          toolSwatchMarkup(tool) +
          "</span>" +
          "</button>"
        );
      })
      .join("");
  }

  function demoClassForTool(tool) {
    const kind = tool.name || tool.type || "";
    if (kind === "gem") {
      return "demo-gem";
    }
    if (kind === "ice" || kind === "ice_block" || kind === "ice_slope") {
      return "demo-shimmer";
    }
    if (kind === "puncher") {
      return "demo-jab";
    }
    if (kind === "player_lift" || kind === "player_gate" || kind === "orange_wall" || kind === "orange_button") {
      return "demo-rise";
    }
    if (kind === "weightless_box" || kind === "floating_floor") {
      return "demo-slide";
    }
    if (kind === "player" || kind === "clone") {
      return "demo-hop";
    }
    return "";
  }

  function renderInventoryDetail() {
    const nameEl = document.getElementById("inventory-detail-name");
    if (!nameEl) {
      return;
    }
    const tool = toolForToken(state.selectedToken);
    const stage = document.getElementById("inventory-detail-stage");
    const swatch = document.getElementById("inventory-detail-swatch");
    const tokenEl = document.getElementById("inventory-detail-token");
    const textEl = document.getElementById("inventory-detail-text");
    if (!tool) {
      nameEl.textContent = "Pick a tool";
      if (textEl) {
        textEl.textContent = "Click any tool to see what it does.";
      }
      return;
    }
    nameEl.textContent = tool.label || tool.token;
    if (tokenEl) {
      tokenEl.textContent =
        tool.token === noopToken || tool.token === eraserToken
          ? ""
          : "Board token: " + (tool.displayToken || tool.token);
    }
    if (textEl) {
      textEl.textContent = toolDescription(tool) || "No description yet.";
    }
    if (swatch) {
      swatch.innerHTML = toolSwatchMarkup(tool);
    }
    if (stage) {
      const demoClass = demoClassForTool(tool);
      stage.className = "author-inventory__stage" + (demoClass ? " " + demoClass : "");
    }
  }

  function isInventoryOpen() {
    const inventory = document.getElementById("author-inventory");
    return Boolean(inventory && !inventory.hidden);
  }

  function setInventoryOpen(open) {
    const inventory = document.getElementById("author-inventory");
    if (!inventory) {
      return;
    }
    inventory.hidden = !open;
    document.getElementById("hotbar-backpack")?.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      renderInventoryDetail();
    }
  }

  function flashHotbarToolname(label) {
    const el = document.getElementById("hotbar-toolname");
    if (!el || !label) {
      return;
    }
    el.textContent = label;
    el.classList.add("is-visible");
    window.clearTimeout(hotbarToolnameTimer);
    hotbarToolnameTimer = window.setTimeout(() => el.classList.remove("is-visible"), 1400);
  }

  function createPalettePreviewPlayData(tool) {
    const width = 1;
    const height = 1;
    const cells = createBlankCells(width, height, authorData.defaultFloorToken);

    cells[0][0] =
      (tool.type || tool.name) === "orange_button"
        ? appendCellToken(authorData.defaultFloorToken, tool.token)
        : tool.token;

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

      const paletteTools = selectablePaletteTools().filter(
        (tool) => tool.token !== eraserToken && tool.token !== noopToken
      );

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
    if (!elements.selectedToolLabel) {
      return;
    }
    const tool = toolByToken.get(state.selectedToken);
    const isNoop = state.selectedToken === noopToken;
    const isEraser = state.selectedToken === eraserToken;
    const isIceSlope = isIceSlopeToken(state.selectedToken);

    elements.selectedToolLabel.textContent =
      isNoop
        ? "Select"
        : isEraser
          ? "Erase"
          : isIceSlope
            ? "Ice Slope"
            : tool
              ? tool.label
              : state.selectedToken;
    elements.selectedToolLabel.title =
      isNoop
        ? noopTool.label
        : isEraser
          ? eraserTool.label
          : isIceSlope
            ? "Ice Slope"
        : tool
          ? tool.label
          : state.selectedToken;
  }

  function renderNeighborButtons() {
    Array.from(elements.levelNeighbors.querySelectorAll("[data-dx][data-dy]")).forEach(function (button) {
      const dx = Number(button.dataset.dx);
      const dy = Number(button.dataset.dy);
      const nextLevelId = adjacentLevelId(state.levelId, dx, dy);
      if (!nextLevelId) {
        delete button.dataset.levelId;
        button.disabled = true;
        button.title = "World edge";
        button.setAttribute("aria-label", "World edge");
        return;
      }

      button.disabled = false;
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

  function isPaintStrokeActive() {
    return state.paintPointerId !== null;
  }

  function refreshHitButton(x, y) {
    if (!isInsideEditorCell(x, y)) {
      return;
    }

    const button = elements.hitGrid.children[y * state.width + x];

    if (button) {
      updateCellButton(button, x, y);
    }
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

    invalidateEditorGridRect();
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

    const levelsById = new Map(authorData.existingLevels.map((level) => [level.id, level]));

    if (state.exists && !levelsById.has(state.levelId)) {
      const created = {
        authorUrl: "/author/" + encodeURIComponent(authorData.game.id) + "/" + encodeURIComponent(state.levelId),
        id: state.levelId,
        label: state.levelId.replace("level_", "Level "),
        playUrl: "/play/" + encodeURIComponent(authorData.game.id) + "/" + encodeURIComponent(state.levelId)
      };
      authorData.existingLevels.push(created);
      authorData.existingLevels.sort((left, right) => left.id.localeCompare(right.id));
      levelsById.set(created.id, created);
    }

    // The tray is the WHOLE world map: every room of the NxM grid renders as
    // a tile (thumbnail when the room has been built, dimmed placeholder when
    // it hasn't), and clicking any tile switches the editor to that room.
    elements.existingLevels.style.setProperty("--author-world-columns", String(worldColumns.length));

    const previewFor = (levelId) => {
      const fromWorld = authorData.worldPreviewUrls && authorData.worldPreviewUrls[levelId];
      return fromWorld || levelsById.get(levelId)?.previewUrl || null;
    };

    const tiles = [];
    worldRows.forEach((rowLetter) => {
      worldColumns.forEach((columnLetter) => {
        const levelId = "level_" + columnLetter + "x" + rowLetter;
        const exists = levelsById.has(levelId);
        const isActive = levelId === state.levelId;
        const preview = previewFor(levelId);
        const coordinateLabel = columnLetter + "x" + rowLetter;
        tiles.push(
          '<a class="author-level-pill' +
          (isActive ? " is-active" : "") +
          (exists || isActive ? "" : " is-empty") +
          '" href="?level=' +
          encodeURIComponent(levelId) +
          '" data-level-id="' +
          escapeHtml(levelId) +
          '" title="' +
          escapeHtml((exists || isActive ? "Edit room " : "Start room ") + coordinateLabel) +
          '">' +
          (preview ? '<img class="author-level-pill__thumb" src="' + escapeHtml(preview) + '" alt="">' : "") +
          '<span class="author-level-pill__label">' +
          escapeHtml(coordinateLabel) +
          "</span>" +
          "</a>"
        );
      });
    });

    elements.existingLevels.innerHTML = tiles.join("");
  }

  function renderAll(options = {}) {
    const renderScene = options.renderScene !== false;

    renderStatus();
    renderMeta();
    renderNeighborButtons();
    renderSelectedTool();
    renderGrid({ renderScene });
    renderSelectedCell();
    renderRawOutput();
    renderExistingLevels();
  }

  function selectToken(token) {
    if (token !== eraserToken && token !== noopToken && !toolByToken.has(token)) {
      return;
    }

    state.selectedToken = token;
    // Tools picked from the toolbox that aren't hotbar staples take over the
    // last hotbar slot (most-recently-used, Minecraft style).
    if (!HOTBAR_BASE_TOKENS.includes(token)) {
      hotbarExtraToken = token;
    }
    renderPalette();
    renderSelectedTool();
    flashHotbarToolname(toolForToken(token)?.label || "");
  }

  function selectCell(x, y) {
    const previousCell = state.selectedCell;

    state.selectedCell = {
      x: Math.max(0, Math.min(state.width - 1, x)),
      y: Math.max(0, Math.min(state.height - 1, y))
    };

    if (isPaintStrokeActive()) {
      refreshHitButton(previousCell.x, previousCell.y);
      refreshHitButton(state.selectedCell.x, state.selectedCell.y);
    } else {
      renderGrid({ renderScene: false });
    }

    renderSelectedCell();
  }

  function markDirty() {
    clearSolverSolution();
    clearHillClimbResults();
    state.isDirty = true;
    renderStatus();

    if (isPaintStrokeActive()) {
      // Raw output and solver button syncing are flushed once when the paint
      // stroke ends (see stopPainting).
      return;
    }

    renderRawOutput();
    syncSolverButtonState();
  }

  // Cheap render path used while a paint stroke is active: refreshes only the
  // hit buttons whose cells (or selection) changed and coalesces the 3D scene
  // re-render to at most one per animation frame. The full grid refresh runs
  // once when the stroke ends.
  function renderPaintStrokeChange(changedCells, selectedX, selectedY) {
    const previousCell = state.selectedCell;

    state.paintStrokeDidPaint = true;
    state.selectedCell = {
      x: Math.max(0, Math.min(state.width - 1, selectedX)),
      y: Math.max(0, Math.min(state.height - 1, selectedY))
    };
    refreshHitButton(previousCell.x, previousCell.y);
    changedCells.forEach((cell) => refreshHitButton(cell.x, cell.y));
    refreshHitButton(state.selectedCell.x, state.selectedCell.y);
    renderSelectedCell();
    markDirty();
    scheduleEditorSceneRender();
  }

  function updateCellValue(x, y, normalizedValue) {
    if (state.cells[y][x] === normalizedValue) {
      selectCell(x, y);
      return;
    }

    pushUndoSnapshot({ boardChanged: true });
    state.cells[y][x] = normalizedValue;

    if (isPaintStrokeActive()) {
      renderPaintStrokeChange([{ x, y }], x, y);
      return;
    }

    state.selectedCell = {
      x: Math.max(0, Math.min(state.width - 1, x)),
      y: Math.max(0, Math.min(state.height - 1, y))
    };
    renderGrid();
    renderSelectedCell();
    markDirty();
  }

  function updateCellsForSingleMainPlayerPlacement(x, y, normalizedValue) {
    const nextCells = state.cells.map((row) => row.slice());
    const targetValue = keepFirstMainPlayerTokenInCellValue(normalizedValue);
    const changedCells = [];

    if (nextCells[y][x] !== targetValue) {
      changedCells.push({ x, y });
    }

    nextCells[y][x] = targetValue;

    for (let rowIndex = 0; rowIndex < state.height; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < state.width; columnIndex += 1) {
        if (rowIndex === y && columnIndex === x) {
          continue;
        }

        const strippedValue = stripMainPlayerTokensFromCellValue(nextCells[rowIndex][columnIndex]);

        if (strippedValue !== nextCells[rowIndex][columnIndex]) {
          changedCells.push({ x: columnIndex, y: rowIndex });
          nextCells[rowIndex][columnIndex] = strippedValue;
        }
      }
    }

    if (changedCells.length === 0) {
      selectCell(x, y);
      return;
    }

    pushUndoSnapshot({ boardChanged: true });
    state.cells = nextCells;

    if (isPaintStrokeActive()) {
      renderPaintStrokeChange(changedCells, x, y);
      return;
    }

    state.selectedCell = {
      x: Math.max(0, Math.min(state.width - 1, x)),
      y: Math.max(0, Math.min(state.height - 1, y))
    };
    renderGrid();
    renderSelectedCell();
    markDirty();
  }

  function setCellValue(x, y, value) {
    const normalizedValue = normalizeAuthoringCellValue(value);

    if (cellValueHasMainPlayerToken(normalizedValue)) {
      updateCellsForSingleMainPlayerPlacement(x, y, normalizedValue);
      return;
    }

    updateCellValue(x, y, normalizedValue);
  }

  function appendTokenToCellValue(currentValue, token) {
    return appendCellToken(currentValue, token);
  }

  function eraseTopCellValue(currentValue) {
    const tokens = getCellTokens(currentValue);

    tokens.pop();

    return normalizeCellValue(
      tokens.some((token) => token.length > 0)
        ? tokens.join(authorData.blockAdder)
        : emptyCellToken
    );
  }

  function eraseResultForTarget(target) {
    if (!isInsideEditorCell(target.sourceX, target.sourceY)) {
      return null;
    }

    const currentValue = state.cells[target.sourceY][target.sourceX];
    const beforeTokens = getCellTokens(currentValue);
    const nextValue =
      target.sourceLayer === null || target.sourceLayer === undefined
        ? eraseTopCellValue(currentValue)
        : eraseCellElevationValue(currentValue, target.sourceLayer);

    if (nextValue === currentValue) {
      return null;
    }

    const afterTokens = getCellTokens(nextValue);
    const changedIndex = beforeTokens.findIndex((token, index) => token !== afterTokens[index]);
    const erasedToken = beforeTokens[
      changedIndex >= 0 ? changedIndex : Math.max(0, beforeTokens.length - 1)
    ];

    return {
      erasedToken,
      mode: isBaseSurfaceToken(erasedToken) ? "base" : "nonBase",
      nextValue
    };
  }

  function canEraseInCurrentGesture(mode) {
    if (!mode) {
      return false;
    }

    if (!state.eraseGestureMode) {
      return true;
    }

    return state.eraseGestureMode === "base" && mode === "base";
  }

  function paintCell(x, y, value) {
    if (value === noopToken) {
      selectCell(x, y);
      return;
    }

    if (value === eraserToken) {
      updateCellValue(x, y, eraseTopCellValue(state.cells[y][x]));
      return;
    }

    const isMainPlayerPaint = isMainPlayerToken(value);
    const currentValue = isMainPlayerPaint
      ? stripMainPlayerTokensFromCellValue(state.cells[y][x])
      : state.cells[y][x];
    const nextValue = appendTokenToCellValue(currentValue, value);

    if (isMainPlayerPaint) {
      updateCellsForSingleMainPlayerPlacement(x, y, nextValue);
      return;
    }

    updateCellValue(x, y, nextValue);
  }

  function isInsideEditorCell(x, y) {
    return x >= 0 && y >= 0 && x < state.width && y < state.height;
  }

  function fallbackPaintTargetFromCell(x, y) {
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

  function fallbackPaintTargetFromButton(button) {
    if (!button) {
      return null;
    }

    return fallbackPaintTargetFromCell(Number(button.dataset.x), Number(button.dataset.y));
  }

  // The editor grid rect is cached and invalidated on resize/scroll/layout
  // changes instead of calling getBoundingClientRect per pointer event.
  function editorGridBoundingRect() {
    if (!editorGridRectCache.rect) {
      editorGridRectCache.rect = elements.grid.getBoundingClientRect();
    }

    return editorGridRectCache.rect;
  }

  function invalidateEditorGridRect() {
    editorGridRectCache.rect = null;
  }

  function fallbackPaintTargetFromPoint(clientX, clientY) {
    const rect = editorGridBoundingRect();

    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      clientX < rect.left ||
      clientX >= rect.right ||
      clientY < rect.top ||
      clientY >= rect.bottom
    ) {
      return null;
    }

    const x = Math.floor(((clientX - rect.left) / rect.width) * state.width);
    const y = Math.floor(((clientY - rect.top) / rect.height) * state.height);

    return fallbackPaintTargetFromCell(x, y);
  }

  function targetElementFromEvent(event) {
    return event.target instanceof Element ? event.target : null;
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

    return (
      fallbackPaintTargetFromButton(
        targetElementFromEvent(event)?.closest(".author-grid__cell")
      ) || fallbackPaintTargetFromPoint(event.clientX, event.clientY)
    );
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

    if (target.kind === "levelSwitch") {
      return "level-switch:" + (target.levelId || "") + ":" + (target.dx || 0) + ":" + (target.dy || 0);
    }

    if (state.selectedToken === noopToken) {
      return "";
    }

    const isEraser = state.selectedToken === eraserToken;
    const paintToken = isEraser ? state.selectedToken : effectivePaintToken();
    const x = isEraser ? target.sourceX : target.paintX;
    const y = isEraser ? target.sourceY : target.paintY;
    const paintLayer = adjustedPaintLayerForTarget(target);

    return [
      paintToken,
      x,
      y,
      paintLayer ?? "top",
      target.sourceLayer ?? "top",
      target.sourceX,
      target.sourceY,
      target.face || "top"
    ].join(":");
  }

  function isBaseSurfaceToken(token) {
    const tool = toolByToken.get(token);
    const type = tool?.type || tool?.name;

    return type === "floor" || type === "ice";
  }

  function isIceSlopeTool(tool) {
    return (tool?.type || tool?.name) === "ice_slope";
  }

  function isIceSlopeToken(token) {
    return isIceSlopeTool(toolByToken.get(token));
  }

  function toolTypeForToken(token) {
    const tool = toolByToken.get(token);
    return tool?.type || tool?.name || "";
  }

  function isMainPlayerToken(token) {
    const type = toolTypeForToken(token);

    return type === "player" || type === "circle_player";
  }

  function cellValueHasMainPlayerToken(value) {
    return getCellTokens(value).some((token) => isMainPlayerToken(token));
  }

  function stripMainPlayerTokensFromCellValue(value) {
    const tokens = getCellTokens(value).map((token) => (isMainPlayerToken(token) ? "" : token));

    return normalizeAuthoringCellValue(
      tokens.some((token) => token.length > 0)
        ? tokens.join(authorData.blockAdder)
        : emptyCellToken
    );
  }

  function keepFirstMainPlayerTokenInCellValue(value) {
    let hasMainPlayer = false;
    const tokens = getCellTokens(value).map((token) => {
      if (!isMainPlayerToken(token)) {
        return token;
      }

      if (hasMainPlayer) {
        return "";
      }

      hasMainPlayer = true;
      return token;
    });

    return normalizeAuthoringCellValue(
      tokens.some((token) => token.length > 0)
        ? tokens.join(authorData.blockAdder)
        : emptyCellToken
    );
  }

  function isPuncherToken(token) {
    return toolTypeForToken(token) === "puncher";
  }

  function isOrangeButtonToken(token) {
    return toolTypeForToken(token) === "orange_button";
  }

  function directionForPaintTarget(target) {
    const dx = Math.sign(Number(target?.dx) || 0);
    const dy = Math.sign(Number(target?.dy) || 0);

    if (dx > 0) {
      return "right";
    }

    if (dx < 0) {
      return "left";
    }

    if (dy > 0) {
      return "down";
    }

    if (dy < 0) {
      return "up";
    }

    return "";
  }

  function cameraFarDirection() {
    const [dx, dy] =
      typeof editorRenderer.app?.mapCameraRelativeDirection === "function"
        ? editorRenderer.app.mapCameraRelativeDirection(0, -1)
        : [0, -1];

    return directionForPaintTarget({ dx, dy });
  }

  function cameraFacingIceSlopeToken() {
    const direction = cameraFarDirection();

    return iceSlopeTokenByDirection.get(direction) || canonicalIceSlopeToken || state.selectedToken;
  }

  function effectivePaintToken() {
    return isIceSlopeToken(state.selectedToken) ? cameraFacingIceSlopeToken() : state.selectedToken;
  }

  function puncherTokenForDirection(direction) {
    for (const [token, tool] of toolByToken.entries()) {
      if ((tool.type || tool.name) === "puncher" && tool.direction === direction) {
        return token;
      }
    }

    return "";
  }

  function targetHasPuncherSupport(target) {
    if (!target || target.kind === "levelSwitch") {
      return false;
    }

    if (!directionForPaintTarget(target)) {
      return false;
    }

    const sideHeight = Math.max(0, (target.topY ?? 0) - (target.bottomY ?? 0));

    return sideHeight >= 32;
  }

  function adjustedPaintLayerForTarget(target) {
    if (!target || state.selectedToken === eraserToken || state.selectedToken === noopToken) {
      return target?.paintLayer;
    }

    if (isBaseSurfaceToken(state.selectedToken)) {
      return 0;
    }

    return target.paintLayer;
  }

  function paintPuncherTarget(target) {
    if (!targetHasPuncherSupport(target)) {
      return false;
    }

    if (!isInsideEditorCell(target.paintX, target.paintY)) {
      return false;
    }

    const directionToken = puncherTokenForDirection(directionForPaintTarget(target));

    if (!directionToken) {
      return false;
    }

    const paintLayer = Math.max(0, Math.floor(Number(target.sourceLayer) || 0));
    const currentValue = state.cells[target.paintY][target.paintX];
    const nextValue = setCellElevationToken(currentValue, directionToken, paintLayer);

    updateCellValue(target.paintX, target.paintY, nextValue);
    return true;
  }

  function paintOrangeButtonTarget(target) {
    if (!target || target.kind === "levelSwitch" || target.face !== "top") {
      return false;
    }

    if (!isInsideEditorCell(target.paintX, target.paintY)) {
      return false;
    }

    const paintLayer = adjustedPaintLayerForTarget(target);

    if (paintLayer === null || paintLayer === undefined) {
      return false;
    }

    const paintToken = effectivePaintToken();
    const currentValue = state.cells[target.paintY][target.paintX];
    const nextValue = setSurfaceAttachmentToken(currentValue, paintToken, paintLayer);

    if (nextValue === currentValue) {
      selectCell(target.paintX, target.paintY);
      return false;
    }

    updateCellValue(target.paintX, target.paintY, nextValue);
    return true;
  }

  function paintFaceTarget(target) {
    if (!target || target.kind === "levelSwitch") {
      return false;
    }

    if (state.selectedToken === noopToken) {
      const x = Number.isFinite(target.sourceX) ? target.sourceX : target.paintX;
      const y = Number.isFinite(target.sourceY) ? target.sourceY : target.paintY;

      if (isInsideEditorCell(x, y)) {
        selectCell(x, y);
      }

      return false;
    }

    if (state.selectedToken === eraserToken) {
      const eraseResult = eraseResultForTarget(target);

      if (!eraseResult || !canEraseInCurrentGesture(eraseResult.mode)) {
        return false;
      }

      state.eraseGestureMode = eraseResult.mode;
      updateCellValue(target.sourceX, target.sourceY, eraseResult.nextValue);
      return true;
    }

    if (isPuncherToken(state.selectedToken)) {
      return paintPuncherTarget(target);
    }

    if (isOrangeButtonToken(state.selectedToken)) {
      return paintOrangeButtonTarget(target);
    }

    if (!isInsideEditorCell(target.paintX, target.paintY)) {
      return false;
    }

    const paintToken = effectivePaintToken();
    const paintLayer = adjustedPaintLayerForTarget(target);
    const isMainPlayerPaint = isMainPlayerToken(paintToken);
    const currentValue = isMainPlayerPaint
      ? stripMainPlayerTokensFromCellValue(state.cells[target.paintY][target.paintX])
      : state.cells[target.paintY][target.paintX];
    const nextValue =
      paintLayer === null || paintLayer === undefined
        ? appendTokenToCellValue(currentValue, paintToken)
        : setCellElevationToken(currentValue, paintToken, paintLayer);

    if (isMainPlayerPaint) {
      updateCellsForSingleMainPlayerPlacement(target.paintX, target.paintY, nextValue);
      return true;
    }

    updateCellValue(target.paintX, target.paintY, nextValue);
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
      : adjustedPaintLayerForTarget(target);
  }

  function canDragEraseFromTarget(target, layer) {
    if (state.selectedToken !== eraserToken) {
      return true;
    }

    if (
      !target ||
      target.face !== "top" ||
      Math.max(0, Math.floor(Number(layer) || 0)) !== 0 ||
      !isInsideEditorCell(target.sourceX, target.sourceY)
    ) {
      return false;
    }

    const bottomToken = String(getCellTokens(state.cells[target.sourceY][target.sourceX])?.[0] || "").trim();
    const topY = Number(target.topY);

    return isBaseSurfaceToken(bottomToken) && (!Number.isFinite(topY) || topY <= 0.05);
  }

  function paintDragPlaneForTarget(target) {
    if (
      !target ||
      target.kind === "levelSwitch" ||
      state.selectedToken === noopToken ||
      target.face !== "top"
    ) {
      return null;
    }

    const layer = paintGestureLayerForTarget(target);

    if (layer === null || layer === undefined) {
      return null;
    }

    if (!canDragEraseFromTarget(target, layer)) {
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

    const layer = paintGestureLayerForTarget(target);

    if (layer !== state.paintDragPlane.layer) {
      return false;
    }

    if (state.selectedToken === eraserToken) {
      return canDragEraseFromTarget(target, layer);
    }

    return true;
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

    pushUndoSnapshot();
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
    pushUndoSnapshot();
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

    pushUndoSnapshot();
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
              : appendCellToken(authorData.defaultFloorToken, authorData.defaultWallToken);
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

    pushUndoSnapshot();
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

  async function fetchAuthorLevelPayload(levelId) {
    const response = await fetch(
      authorData.authorApiBaseUrl + "/" + encodeURIComponent(levelId),
      { headers: { Accept: "application/json" } }
    );
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Could not load that level.");
    }

    return payload;
  }

  function applyAuthorLevelPayload(payload, options = {}) {
    state.cells = cloneCells(payload.cells);
    state.exists = payload.exists;
    state.fileName = payload.fileName;
    state.filePath = payload.filePath;
    state.height = payload.height;
    state.isDirty = false;
    state.levelId = payload.levelId;
    state.message =
      options.message ||
      (payload.exists ? "Loaded existing level." : "Fresh level. Paint something good.");
    state.messageTone =
      options.messageTone || (payload.exists ? "success" : "warning");
    state.savedBoardSignature = boardSignature(payload.width, payload.height, payload.cells);
    state.selectedCell = { x: 0, y: 0 };
    clearSolverSolution();
    clearUndoHistory();
    state.width = payload.width;
  }

  async function loadLevel(levelId) {
    if (!shouldDiscardUnsavedChanges()) {
      syncLevelSelectors();
      return;
    }

    try {
      applyAuthorLevelPayload(await fetchAuthorLevelPayload(levelId));
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

  async function saveLevel(options = {}) {
    const renderAfterSave = options.renderAfterSave !== false;
    const refreshPreview = options.refreshPreview !== false;
    const updateStatus = options.updateStatus !== false;
    const throwOnError = options.throwOnError === true;

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
      state.savedBoardSignature = boardSignature(state.width, state.height, state.cells);
      if (authorData.worldMeta) {
        authorData.worldMeta.gemsByLevel[state.levelId] = currentLevelGemCount();
        authorData.worldMeta.savedThisSession = true;
      }
      if (state.solverSolutionCellsKey !== serializeCells()) {
        clearSolverSolution();
      }
      let previewMessage = payload.message || "Saved.";
      let previewTone = "success";

      if (
        refreshPreview &&
        levelPreviewRenderer &&
        typeof levelPreviewRenderer.savePreview === "function"
      ) {
        try {
          const playResponse = await fetch(
            (authorData.playApiBaseUrl
              ? authorData.playApiBaseUrl.replace(/\/+$/, "")
              : "/api/play/" + encodeURIComponent(authorData.game.id)) +
              "/" + encodeURIComponent(state.levelId),
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

      if (updateStatus) {
        state.message = previewMessage;
        state.messageTone = previewTone;
      }
      syncLevelSelectors();
      if (renderAfterSave) {
        renderAll();
      }
      return payload;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save that level.", "error");
      if (throwOnError) {
        throw error;
      }
      return null;
    }
  }

  function raisedSurfaceSnapshotForApp(app) {
    const raisedPlayerGates =
      typeof app.computeRaisedPlayerGateSet === "function"
        ? app.computeRaisedPlayerGateSet()
        : new Set();
    const raisedOrangeWalls =
      typeof app.computeRaisedOrangeWallSet === "function"
        ? app.computeRaisedOrangeWallSet()
        : new Set();

    app.liveRaisedPlayerGates = raisedPlayerGates;
    app.liveRaisedOrangeWalls = raisedOrangeWalls;
    app.syncGateAnimationTargets?.(0);
    app.syncOrangeWallAnimationTargets?.(0);
    app.syncPlayerLiftAnimationTargets?.(0);

    return {
      raisedPlayerGates: Array.from(raisedPlayerGates),
      raisedOrangeWalls: Array.from(raisedOrangeWalls)
    };
  }

  function editorLevelSnapshotForTransition(app) {
    const snapshot =
      typeof app.cloneLevelSnapshot === "function"
        ? app.cloneLevelSnapshot()
        : buildEditorRenderPlayData();

    return {
      ...snapshot,
      ...raisedSurfaceSnapshotForApp(app)
    };
  }

  async function prepareEditorAppLevelState(app, playData) {
    app.applyLevelState(playData, {
      deferRender: true,
      immediateCamera: true,
      resetHistory: true,
      resetLevelEntry: true
    });
    await app.preloadImagesForLevelState?.(playData);
    if (app.threeRendererReady && typeof app.threeRendererReady.then === "function") {
      await app.threeRendererReady.catch(() => {});
    }

    return editorLevelSnapshotForTransition(app);
  }

  function renderLoadedLevelWithoutScene(payload, options = {}) {
    applyAuthorLevelPayload(payload, options);
    syncLevelSelectors();
    window.history.replaceState(
      null,
      "",
      "/author/" + encodeURIComponent(authorData.game.id) + "/" + encodeURIComponent(state.levelId)
    );
    renderAll({ renderScene: false });
  }

  async function switchToNeighborLevel(target) {
    if (state.isLevelSwitching || !target || target.kind !== "levelSwitch") {
      return;
    }

    const dx = Math.max(-1, Math.min(1, Math.round(Number(target.dx) || 0)));
    const dy = Math.max(-1, Math.min(1, Math.round(Number(target.dy) || 0)));
    const nextLevelId = target.levelId || adjacentLevelId(state.levelId, dx, dy);

    if (!nextLevelId || nextLevelId === state.levelId) {
      return;
    }

    state.isLevelSwitching = true;
    clearEditorHoverTarget();
    setStatus("Saving before switching rooms...", "warning");

    try {
      await saveLevel({
        refreshPreview: false,
        renderAfterSave: false,
        throwOnError: true,
        updateStatus: false
      });

      const outgoingPlayData = buildEditorRenderPlayData();
      const app = ensureEditorRenderApp(outgoingPlayData);

      if (
        !app ||
        typeof app.applyLevelState !== "function" ||
        !app.renderCompositor?.startLevelTransition
      ) {
        state.isLevelSwitching = false;
        syncUndoButtonState();
        await loadLevel(nextLevelId);
        return;
      }

      const outgoingLevel = await prepareEditorAppLevelState(app, outgoingPlayData);
      const payload = await fetchAuthorLevelPayload(nextLevelId);
      renderLoadedLevelWithoutScene(payload, {
        message: "Saved and switched to " + nextLevelId.replace("level_", "") + ".",
        messageTone: payload.exists ? "success" : "warning"
      });

      const incomingPlayData = buildEditorRenderPlayData();
      const incomingLevel = await prepareEditorAppLevelState(app, incomingPlayData);
      const incomingRaised = raisedSurfaceSnapshotForApp(app);

      app.renderCompositor.startLevelTransition(null, null, dx, dy, null, null, null, {
        durationMs: app.LEVEL_TRANSITION_DURATION_MS || 1000,
        renderImmediately: false,
        transitionData: {
          kind: "adjacent-scene",
          dx,
          dy,
          outgoingLevel,
          outgoingResetLevel: outgoingLevel,
          incomingLevel,
          incomingRaisedPlayerGates: incomingRaised.raisedPlayerGates,
          incomingRaisedOrangeWalls: incomingRaised.raisedOrangeWalls
        },
        onComplete: () => {
          state.isLevelSwitching = false;
          syncUndoButtonState();
          renderEditorScene();
        }
      });
      app.render();
    } catch (error) {
      state.isLevelSwitching = false;
      syncUndoButtonState();
      setStatus(
        error instanceof Error ? error.message : "Could not switch to that level.",
        "error"
      );
    }
  }

  function formatSolverPath(path) {
    return path.length > 0 ? path : "(empty)";
  }

  function applyGemPlacement(candidate) {
    pushUndoSnapshot();
    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        state.cells[y][x] = stripGemFromCellValue(state.cells[y][x]);
      }
    }

    const placedValue = gemPlacementValueForCell(candidate.x, candidate.y, candidate.elevation ?? 0);
    state.cells[candidate.y][candidate.x] = placedValue;
    clearSolverSolution();
    clearHillClimbResults();
    state.selectedCell = { x: candidate.x, y: candidate.y };
    state.isDirty = true;
    renderGrid();
    renderSelectedCell();
    renderRawOutput();
    syncSolverButtonState();

    return placedValue;
  }

  function canHillClimbPlaceWallAtCell(value) {
    const tokens = getCellTokens(value).filter((token) => token.length > 0);

    return tokens.every((token) => {
      const tool = toolByToken.get(token);
      const type = tool?.type || tool?.name || "";

      return type === "floor" || type === "ice";
    });
  }

  function hillClimbBaseCells(mode = getHillClimbMode()) {
    const cells = cloneCells(state.cells);

    return mode === "fixed_gem"
      ? cells
      : cells.map((row) => row.map(stripGemFromCellValue));
  }

  function firstGemLocation(cells = state.cells) {
    for (let y = 0; y < cells.length; y += 1) {
      for (let x = 0; x < cells[y].length; x += 1) {
        if (getCellTools(cells[y][x]).some((tool) => tool.name === "gem")) {
          return { x, y };
        }
      }
    }

    return null;
  }

  function hillClimbWallCandidateCells(baseCells, x, y, wallToken) {
    const currentValue = baseCells[y]?.[x] ?? emptyCellToken;

    if (!canHillClimbPlaceWallAtCell(currentValue)) {
      return null;
    }

    const nextValue = setCellElevationToken(currentValue, wallToken, 0);

    if (nextValue === currentValue) {
      return null;
    }

    const candidateCells = cloneCells(baseCells);
    candidateCells[y][x] = nextValue;
    return candidateCells;
  }

  function canHillClimbPlaceWallAtPosition(baseCells, x, y, wallToken) {
    const currentValue = baseCells[y]?.[x] ?? emptyCellToken;

    if (!canHillClimbPlaceWallAtCell(currentValue)) {
      return false;
    }

    return setCellElevationToken(currentValue, wallToken, 0) !== currentValue;
  }

  function hillClimbCandidatePositions(baseCells, wallToken) {
    const positions = [];

    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        if (canHillClimbPlaceWallAtPosition(baseCells, x, y, wallToken)) {
          positions.push({ x, y });
        }
      }
    }

    return positions;
  }

  function createHillClimbProgressReporter(
    candidateIndex,
    candidateCount,
    maxExpandedStates,
    baseExpanded = 0,
    progressState = null
  ) {
    const sharedProgressState = progressState || {
      lastRenderAt: 0
    };
    const safeCandidateCount = Math.max(1, candidateCount);
    const safeMaxExpandedStates = Math.max(1, maxExpandedStates);
    const label = "Hill-Climb " + (candidateIndex + 1) + "/" + safeCandidateCount;

    return async function reportHillClimbProgress(progress, force = false) {
      const expanded = Math.max(0, progress?.expanded ?? 0);
      const now =
        window.performance && typeof window.performance.now === "function"
          ? window.performance.now()
          : Date.now();

      if (now - sharedProgressState.lastRenderAt < solverProgressRenderIntervalMs) {
        return;
      }

      sharedProgressState.lastRenderAt = now;
      renderSolverProgress(
        label,
        Math.min(safeMaxExpandedStates, baseExpanded + expanded),
        safeMaxExpandedStates
      );
      await nextSolverProgressFrame();
    };
  }

  function addAffectedCellKey(keys, x, y) {
    const cellX = Math.floor(Number(x));
    const cellY = Math.floor(Number(y));

    if (isInsideEditorCell(cellX, cellY)) {
      keys.add(cellX + "," + cellY);
    }
  }

  function addAffectedPathPoint(keys, point) {
    if (!point) {
      return;
    }

    const x = Number(point.x);
    const y = Number(point.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }

    addAffectedCellKey(keys, Math.floor(x), Math.floor(y));
    addAffectedCellKey(keys, Math.ceil(x), Math.floor(y));
    addAffectedCellKey(keys, Math.floor(x), Math.ceil(y));
    addAffectedCellKey(keys, Math.ceil(x), Math.ceil(y));
  }

  function addMoveAffectedCells(keys, move) {
    addAffectedCellKey(keys, move?.fromX, move?.fromY);
    addAffectedCellKey(keys, move?.toX, move?.toY);

    if (Array.isArray(move?.path)) {
      move.path.forEach((point) => addAffectedPathPoint(keys, point));
    }
  }

  function solverPathAffectedCellKeys(cells, path) {
    const engine = createSolverEngine(buildEditorPlayData({ cells }));
    const replayState = engine.createStateBuffer();
    const keys = new Set();

    engine.copyStateInto(replayState, engine.initialState);

    for (const label of String(path || "")) {
      const direction = solutionDirections[label];

      if (!direction) {
        break;
      }

      const moveResult = engine.moveForSearch(replayState, direction.dx, direction.dy);

      if (!moveResult?.moved) {
        break;
      }

      if (Array.isArray(moveResult.moves)) {
        moveResult.moves.forEach((move) => addMoveAffectedCells(keys, move));
      }
    }

    return keys;
  }

  function rankHillClimbResults(results) {
    return results.slice().sort((left, right) => {
      if (right.moves !== left.moves) {
        return right.moves - left.moves;
      }

      if (left.wallY !== right.wallY) {
        return left.wallY - right.wallY;
      }

      return left.wallX - right.wallX;
    });
  }

  function setHillClimbResults(results) {
    state.hillClimbResults = rankHillClimbResults(results);
    state.hillClimbResultIndex = state.hillClimbResults.length > 0 ? 0 : -1;
    syncHillClimbResultControls();
  }

  function applyHillClimbResult(best, options = {}) {
    if (options.recordUndo !== false) {
      pushUndoSnapshot();
    }
    state.cells = cloneCells(best.cells);
    if (typeof best.solutionPath === "string") {
      rememberSolverSolution(best.solutionPath);
    } else {
      clearSolverSolution();
    }
    state.selectedCell = best.selectedCell
      ? { x: best.selectedCell.x, y: best.selectedCell.y }
      : { x: best.wallX, y: best.wallY };
    state.isDirty = true;
    renderGrid();
    renderSelectedCell();
    renderRawOutput();
    syncSolverButtonState();
  }

  function showHillClimbResult(index) {
    if (!Array.isArray(state.hillClimbResults) || state.hillClimbResults.length === 0) {
      return false;
    }

    const nextIndex = Math.max(0, Math.min(state.hillClimbResults.length - 1, index));

    if (nextIndex === state.hillClimbResultIndex) {
      syncHillClimbResultControls();
      return false;
    }

    state.hillClimbResultIndex = nextIndex;
    const result = currentHillClimbResult();

    if (!result) {
      syncHillClimbResultControls();
      return false;
    }

    applyHillClimbResult(result, { recordUndo: false });
    setStatus(
      hillClimbResultSummary(result) +
        ". UDLR: " +
        formatSolverPath(result.path) +
        ".",
      "success"
    );
    return true;
  }

  function pageHillClimbResult(delta) {
    return showHillClimbResult(state.hillClimbResultIndex + delta);
  }

  async function hillClimb() {
    if (!levelHasPlayer()) {
      setStatus("Hill-Climb needs a player first.", "error");
      syncSolverButtonState();
      return;
    }

    const mode = getHillClimbMode();

    if (mode === "fixed_gem" && !levelHasGem()) {
      setStatus("Fixed Gem Hill-Climb needs a gem first.", "error");
      syncSolverButtonState();
      return;
    }

    const wallToken = toolByName.get("wall")?.token || "#";
    const baseCells = hillClimbBaseCells(mode);
    const positions = hillClimbCandidatePositions(baseCells, wallToken);

    if (positions.length === 0) {
      setStatus("Hill-Climb found no empty floor or ice cells for a trial wall.", "warning");
      syncSolverButtonState();
      return;
    }

    const algorithm = getSolverAlgorithm();
    const algorithmLabel = solverAlgorithmLabel(algorithm);

    setStatus(
      "Hill-Climb " +
        hillClimbModeLabel(mode) +
        (mode === "fixed_gem" ? " with " + algorithmLabel : "") +
        " trying wall placements...",
      "warning"
    );
    const signal = beginSolverRun();
    const maxExpandedStates = normalizeSolverMaxExpandedStatesInput();
    renderSolverProgress("Hill-Climb", 0, maxExpandedStates);

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    let best = null;
    let cappedCount = 0;
    const hillClimbResults = [];
    const hillClimbProgressState = { lastRenderAt: 0 };
    let fixedGemBaseline = null;
    let fixedGemAffectedCells = null;

    try {
      const mazeSolver = getMazeSolver();

      if (mode === "fixed_gem") {
        fixedGemBaseline = await mazeSolver.solveWithAStar(
          createSolverEngine(buildEditorPlayData({ cells: baseCells })),
          {
            algorithm,
            maxExpandedStates,
            onProgress: createHillClimbProgressReporter(
              0,
              positions.length,
              maxExpandedStates,
              0,
              hillClimbProgressState
            ),
            progressYieldStateInterval: solverProgressYieldStateInterval,
            signal
          }
        );

        if (fixedGemBaseline.status === "solved") {
          fixedGemAffectedCells = solverPathAffectedCellKeys(baseCells, fixedGemBaseline.path);
        } else if (fixedGemBaseline.status === "capped") {
          cappedCount += 1;
        }
      }

      for (let index = 0; index < positions.length; index += 1) {
        const position = positions[index];
        const candidateCells = hillClimbWallCandidateCells(
          baseCells,
          position.x,
          position.y,
          wallToken
        );

        if (!candidateCells || !levelHasPlayer(candidateCells)) {
          continue;
        }

        if (mode === "fixed_gem") {
          const positionKey = position.x + "," + position.y;

          if (fixedGemBaseline?.status === "solved" && !fixedGemAffectedCells?.has(positionKey)) {
            const candidateResult = {
              cells: candidateCells,
              moves: fixedGemBaseline.moves,
              path: fixedGemBaseline.path,
              resultStatus: fixedGemBaseline.status,
              selectedCell: firstGemLocation(candidateCells) || { x: position.x, y: position.y },
              solutionPath: fixedGemBaseline.path,
              wallX: position.x,
              wallY: position.y
            };

            hillClimbResults.push(candidateResult);
            if (!best || candidateResult.moves > best.moves) {
              best = candidateResult;
            }
            continue;
          }

          const result = await mazeSolver.solveWithAStar(
            createSolverEngine(buildEditorPlayData({ cells: candidateCells })),
            {
              algorithm,
              maxExpandedStates,
              onProgress: createHillClimbProgressReporter(
                index,
                positions.length,
                maxExpandedStates,
                0,
                hillClimbProgressState
              ),
              progressYieldStateInterval: solverProgressYieldStateInterval,
              signal
            }
          );

          if (result.status === "capped") {
            cappedCount += 1;
            continue;
          }

          if (result.status === "solved") {
            const candidateResult = {
              cells: candidateCells,
              moves: result.moves,
              path: result.path,
              resultStatus: result.status,
              selectedCell: firstGemLocation(candidateCells) || { x: position.x, y: position.y },
              solutionPath: result.path,
              wallX: position.x,
              wallY: position.y
            };

            hillClimbResults.push(candidateResult);
            if (!best || candidateResult.moves > best.moves) {
              best = candidateResult;
            }
          }
        } else {
          const engine = createSolverEngine(
            buildEditorPlayData({ cells: candidateCells, includeGems: false })
          );
          const gemSurfaceSets = gemPlacementSurfaceSets(candidateCells);
          const result = await mazeSolver.findHardestGemPlacement(engine, {
            canPlaceGemAt: (x, y, elevation) =>
              canPlaceGemAtSurface(x, y, elevation, gemSurfaceSets),
            maxExpandedStates,
            onProgress: createHillClimbProgressReporter(
              index,
              positions.length,
              maxExpandedStates,
              0,
              hillClimbProgressState
            ),
            progressYieldStateInterval: solverProgressYieldStateInterval,
            signal
          });

          if (result.status === "capped") {
            cappedCount += 1;
            continue;
          }

          if (result.candidate) {
            const cellsWithGem = cloneCells(candidateCells);
            cellsWithGem[result.candidate.y][result.candidate.x] = gemPlacementValueForCells(
              cellsWithGem,
              result.candidate.x,
              result.candidate.y,
              result.candidate.elevation ?? 0
            );
            const candidateResult = {
              cells: cellsWithGem,
              moves: result.candidate.moves,
              path: result.candidate.path,
              resultStatus: result.status,
              selectedCell: { x: result.candidate.x, y: result.candidate.y },
              solutionPath: result.candidate.path,
              wallX: position.x,
              wallY: position.y
            };

            hillClimbResults.push(candidateResult);
            if (!best || candidateResult.moves > best.moves) {
              best = candidateResult;
            }
          }
        }
      }

      if (hillClimbResults.length === 0 || !best) {
        setStatus(
          "Hill-Climb: no trial wall left a reachable gem placement after " +
            positions.length +
            " candidate" +
            (positions.length === 1 ? "" : "s") +
            ".",
          "warning"
        );
        return;
      }

      setHillClimbResults(hillClimbResults);
      best = currentHillClimbResult() || best;
      applyHillClimbResult(best);
      setStatus(
        "Hill-Climb " +
          hillClimbModeLabel(mode) +
          ": kept result 1/" +
          state.hillClimbResults.length +
          " wall at cell " +
          (best.wallX + 1) +
          ", " +
          (best.wallY + 1) +
          " for " +
          best.moves +
          " move" +
          (best.moves === 1 ? "" : "s") +
          ". UDLR: " +
          formatSolverPath(best.path) +
          "." +
          (cappedCount > 0
            ? " " + cappedCount + " trial" + (cappedCount === 1 ? "" : "s") + " hit the cap."
            : ""),
        best.resultStatus === "capped" ? "warning" : "success"
      );
    } catch (error) {
      setStatus(
        isSolverCancelError(error)
          ? "Hill-Climb cancelled."
          : error instanceof Error
            ? error.message
            : "Hill-Climb failed.",
        isSolverCancelError(error) ? "warning" : "error"
      );
    } finally {
      finishSolverRun();
    }
  }

  async function placeGem() {
    if (!levelHasPlayer()) {
      setStatus("Place Gem needs a player first.", "error");
      syncSolverButtonState();
      return;
    }

    setStatus("Place Gem running reachability search...", "warning");
    const signal = beginSolverRun();
    const maxExpandedStates = normalizeSolverMaxExpandedStatesInput();
    renderSolverProgress("Place Gem", 0, maxExpandedStates);

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    try {
      const engine = createSolverEngine(buildEditorPlayData({ includeGems: false }));
      const gemSurfaceSets = gemPlacementSurfaceSets();
      const result = await getMazeSolver().findHardestGemPlacement(engine, {
        canPlaceGemAt: (x, y, elevation) =>
          canPlaceGemAtSurface(x, y, elevation, gemSurfaceSets),
        maxExpandedStates,
        onProgress: createSolverProgressReporter("Place Gem", maxExpandedStates),
        progressYieldStateInterval: solverProgressYieldStateInterval,
        signal
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
          "Place Gem: no reachable open surface found. Explored " +
          formatStateCount(result.expanded) +
          " state" +
          (result.expanded === 1 ? "" : "s") +
          ".",
        "warning"
      );
    } catch (error) {
      setStatus(
        isSolverCancelError(error)
          ? "Place Gem cancelled."
          : error instanceof Error
            ? error.message
            : "Place Gem failed.",
        isSolverCancelError(error) ? "warning" : "error"
      );
    } finally {
      finishSolverRun();
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

    const algorithm = getSolverAlgorithm();
    const algorithmLabel = solverAlgorithmLabel(algorithm);

    setStatus("Solver running " + algorithmLabel + "...", "warning");
    const signal = beginSolverRun();
    const maxExpandedStates = normalizeSolverMaxExpandedStatesInput();
    renderSolverProgress(algorithmLabel, 0, maxExpandedStates);

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    try {
      const engine = createSolverEngine(playData);
      const result = await getMazeSolver().solveWithAStar(engine, {
        algorithm,
        maxExpandedStates,
        onProgress: createSolverProgressReporter(algorithmLabel, maxExpandedStates),
        progressYieldStateInterval: solverProgressYieldStateInterval,
        signal
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
      if (!isSolverCancelError(error)) {
        clearSolverSolution();
      }
      setStatus(
        isSolverCancelError(error)
          ? "Solver cancelled."
          : error instanceof Error
            ? error.message
            : "Solver failed.",
        isSolverCancelError(error) ? "warning" : "error"
      );
    } finally {
      finishSolverRun();
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

  function isTypingTarget(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const tagName = element.tagName.toLowerCase();

    return (
      tagName === "input" ||
      tagName === "textarea" ||
      tagName === "select" ||
      element.isContentEditable ||
      Boolean(element.closest("[contenteditable='true']"))
    );
  }

  function handleEditorKeydown(event) {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      isTypingTarget(event.target)
    ) {
      return;
    }

    const key = String(event.key || "").toLowerCase();

    if (key === "escape") {
      if (isInventoryOpen()) {
        event.preventDefault();
        setInventoryOpen(false);
      }
      return;
    }

    if (key === "e") {
      event.preventDefault();
      setInventoryOpen(!isInventoryOpen());
      return;
    }

    if (/^[1-9]$/.test(key)) {
      const token = hotbarTokens()[Number(key) - 1];
      if (token) {
        event.preventDefault();
        selectToken(token);
      }
      return;
    }

    if (key !== "u" && key !== "z") {
      return;
    }

    event.preventDefault();
    undoLastEdit();
  }

  function handleGridPointerDown(event) {
    const target = syncEditorHoverFromPointerEvent(event);

    if (!target) {
      return;
    }

    event.preventDefault();

    if (target.kind === "levelSwitch") {
      switchToNeighborLevel(target);
      return;
    }

    if (state.selectedToken === noopToken) {
      paintFaceTarget(target);
      return;
    }

    state.paintPointerId = event.pointerId;
    state.lastPaintTargetKey = null;
    state.eraseGestureMode = null;
    state.paintDragPlane = paintDragPlaneForTarget(target);
    try {
      elements.grid.setPointerCapture?.(event.pointerId);
    } catch (_) {}
    paintFaceTargetOnce(target);
  }

  // Pointer moves are throttled to one raycast pick per animation frame: the
  // listeners only stash the latest event and the work happens in the rAF.
  function schedulePointerMove(event, processor) {
    pointerMoveScheduler.event = event;
    pointerMoveScheduler.processor = processor;

    if (pointerMoveScheduler.frameId !== null) {
      return;
    }

    pointerMoveScheduler.frameId = window.requestAnimationFrame(() => {
      const pendingEvent = pointerMoveScheduler.event;
      const pendingProcessor = pointerMoveScheduler.processor;

      pointerMoveScheduler.frameId = null;
      pointerMoveScheduler.event = null;
      pointerMoveScheduler.processor = null;

      if (pendingEvent && pendingProcessor) {
        pendingProcessor(pendingEvent);
      }
    });
  }

  function processGridPointerMove(event) {
    const target = syncEditorHoverFromPointerEvent(event);

    if (state.paintPointerId !== event.pointerId || event.buttons !== 1) {
      return;
    }

    if (!canDragPaintTarget(target)) {
      return;
    }

    paintFaceTargetOnce(target);
  }

  function handleGridPointerMove(event) {
    schedulePointerMove(event, processGridPointerMove);
  }

  function stopPainting(event) {
    if (state.paintPointerId !== event.pointerId) {
      return;
    }

    const didPaint = state.paintStrokeDidPaint;

    state.paintPointerId = null;
    state.paintStrokeDidPaint = false;
    state.lastPaintTargetKey = null;
    state.eraseGestureMode = null;
    state.paintDragPlane = null;
    try {
      if (elements.grid.hasPointerCapture?.(event.pointerId)) {
        elements.grid.releasePointerCapture(event.pointerId);
      }
    } catch (_) {}

    if (didPaint) {
      // One full refresh per stroke: rebuild every hit button, render the 3D
      // scene immediately, and flush the deferred raw output / solver state.
      cancelScheduledEditorSceneRender();
      renderGrid();
      renderSelectedCell();
      renderRawOutput();
      syncSolverButtonState();
    }
  }

  function eventTargetsEditorGrid(event) {
    return event.target instanceof Node && elements.grid.contains(event.target);
  }

  function handleDocumentGridPointerDown(event) {
    if (eventTargetsEditorGrid(event) || !fallbackPaintTargetFromPoint(event.clientX, event.clientY)) {
      return;
    }

    handleGridPointerDown(event);
  }

  function processDocumentGridPointerMove(event) {
    const isActivePaintPointer = state.paintPointerId === event.pointerId;
    const isOverGrid = Boolean(fallbackPaintTargetFromPoint(event.clientX, event.clientY));

    if (!isActivePaintPointer && !isOverGrid) {
      clearEditorHoverTarget();
      return;
    }

    processGridPointerMove(event);
  }

  function handleDocumentGridPointerMove(event) {
    if (eventTargetsEditorGrid(event)) {
      return;
    }

    schedulePointerMove(event, processDocumentGridPointerMove);
  }

  function handleDocumentGridPointerEnd(event) {
    if (!eventTargetsEditorGrid(event) && state.paintPointerId === event.pointerId) {
      stopPainting(event);
    }
  }

  function handleGridContextMenu(event) {
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
  }

  function handleDocumentGridContextMenu(event) {
    if (eventTargetsEditorGrid(event) || !fallbackPaintTargetFromPoint(event.clientX, event.clientY)) {
      return;
    }

    handleGridContextMenu(event);
  }

  function resetDisclosureBodyStyles(body) {
    body.style.height = "";
    body.style.opacity = "";
    body.style.overflow = "";
    body.style.paddingTop = "";
    body.style.paddingBottom = "";
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

    // Animate padding alongside height so the collapse lands at a true 0px
    // instead of popping over the body's padding at the end.
    if (shouldOpen) {
      details.setAttribute("open", "");
      const computed = window.getComputedStyle(body);
      const targetHeight = body.scrollHeight;
      const targetPaddingTop = computed.paddingTop;
      const targetPaddingBottom = computed.paddingBottom;
      body.style.height = "0px";
      body.style.opacity = "0";
      body.style.paddingTop = "0px";
      body.style.paddingBottom = "0px";

      window.requestAnimationFrame(() => {
        body.style.height = targetHeight + "px";
        body.style.opacity = "1";
        body.style.paddingTop = targetPaddingTop;
        body.style.paddingBottom = targetPaddingBottom;
      });
    } else {
      const computed = window.getComputedStyle(body);
      body.style.height = body.scrollHeight + "px";
      body.style.opacity = "1";
      body.style.paddingTop = computed.paddingTop;
      body.style.paddingBottom = computed.paddingBottom;

      window.requestAnimationFrame(() => {
        body.style.height = "0px";
        body.style.opacity = "0";
        body.style.paddingTop = "0px";
        body.style.paddingBottom = "0px";
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

      // Panels marked data-open="1" start expanded (no animation on load);
      // everything else starts collapsed.
      if (details.dataset.open === "1") {
        details.setAttribute("open", "");
      } else {
        details.removeAttribute("open");
      }
      resetDisclosureBodyStyles(body);
      summary.addEventListener("click", function (event) {
        event.preventDefault();
        setDisclosureOpen(details, !details.hasAttribute("open"));
      });

      const infoButton = summary.querySelector("[data-panel-info]");
      const note = body.querySelector(".author-panel__note");

      if (infoButton && note) {
        infoButton.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          const showNote = note.hidden;
          note.hidden = !showNote;
          infoButton.setAttribute("aria-expanded", showNote ? "true" : "false");
          if (showNote && !details.hasAttribute("open")) {
            setDisclosureOpen(details, true);
          }
        });
      }
    });
  }

  function initializeAuthorPageExtras() {
    const meta = authorData.worldMeta;
    const titleInput = document.getElementById("world-title-input");
    const titleSave = document.getElementById("world-title-save");

    if (meta && titleInput && titleSave) {
      titleInput.value = meta.title || "";
      const rename = async () => {
        const title = titleInput.value.trim();
        if (!title || title === meta.title) {
          return;
        }
        titleSave.disabled = true;
        try {
          const response = await fetch(meta.apiUrl, {
            body: JSON.stringify({ title }),
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            method: "PATCH"
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || "Could not rename the world.");
          }
          meta.title = payload.world?.title || title;
          titleInput.value = meta.title;
          const heading = document.querySelector(".author-topbar h1");
          if (heading) {
            heading.textContent = meta.title;
          }
          document.title = meta.title + " — Maze Bench Editor";
          setStatus("World renamed.", "success");
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Could not rename the world.", "error");
        } finally {
          titleSave.disabled = false;
        }
      };
      titleSave.addEventListener("click", rename);
      titleInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          rename();
        }
      });
    }

    // Entering test mode always saves first, so the run you play is the run
    // you just painted.
    const testLink = document.getElementById("author-test-link");
    if (testLink) {
      testLink.addEventListener("click", async (event) => {
        if (!state.isDirty) {
          return;
        }
        event.preventDefault();
        setStatus("Saving before test...", "success");
        const saved = await saveLevel({ refreshPreview: false });
        if (saved) {
          window.location.assign(testLink.href);
        }
      });
    }

    document.getElementById("hotbar-slots")?.addEventListener("click", (event) => {
      const slot = event.target.closest("[data-token]");
      if (slot) {
        selectToken(slot.dataset.token);
      }
    });
    document.getElementById("hotbar-backpack")?.addEventListener("click", () => {
      setInventoryOpen(!isInventoryOpen());
    });
    document.getElementById("inventory-close")?.addEventListener("click", () => {
      setInventoryOpen(false);
    });

    window.addEventListener("keydown", (event) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        String(event.key).toLowerCase() === "s"
      ) {
        event.preventDefault();
        if (state.isDirty && !state.isSolverBusy) {
          saveLevel();
        }
      }
    });
  }

  renderLevelSelectors();
  renderPalette();
  renderPalettePreviews();
  renderAll();
  initializeAuthorDisclosures();
  initializeAuthorPageExtras();

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
  elements.grid.addEventListener("contextmenu", handleGridContextMenu);
  document.addEventListener("pointerdown", handleDocumentGridPointerDown, true);
  document.addEventListener("pointermove", handleDocumentGridPointerMove, true);
  document.addEventListener("pointerup", handleDocumentGridPointerEnd, true);
  document.addEventListener("pointercancel", handleDocumentGridPointerEnd, true);
  document.addEventListener("contextmenu", handleDocumentGridContextMenu, true);

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
  elements.hillClimb?.addEventListener("click", hillClimb);
  elements.hillClimbMode?.addEventListener("change", syncSolverButtonState);
  elements.hillClimbPrev?.addEventListener("click", function () {
    pageHillClimbResult(-1);
  });
  elements.hillClimbNext?.addEventListener("click", function () {
    pageHillClimbResult(1);
  });
  elements.playSolution.addEventListener("click", playSolution);
  elements.solverCancel?.addEventListener("click", cancelSolverRun);
  elements.solverAlgorithm?.addEventListener("change", syncSolverButtonState);
  elements.solverMaxStates.addEventListener("change", normalizeSolverMaxExpandedStatesInput);
  elements.applyCellValue.addEventListener("click", applySelectedCellValue);
  elements.cellValue.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      applySelectedCellValue();
    }
  });
  elements.solveLevel.addEventListener("click", solveLevel);
  elements.undoLevel.addEventListener("click", undoLastEdit);
  elements.saveLevel.addEventListener("click", saveLevel);
  document.addEventListener("keydown", handleEditorKeydown);

  elements.levelNeighbors.addEventListener("click", function (event) {
    const button = event.target.closest("[data-level-id]");

    if (!button) {
      return;
    }

    const nextLevelId = button.dataset.levelId;
    const dx = Number(button.dataset.dx);
    const dy = Number(button.dataset.dy);

    if (nextLevelId && nextLevelId !== state.levelId) {
      switchToNeighborLevel({
        dx,
        dy,
        kind: "levelSwitch",
        levelId: nextLevelId
      });
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
  window.addEventListener("resize", invalidateEditorGridRect);
  document.addEventListener("scroll", invalidateEditorGridRect, { capture: true, passive: true });
})();
