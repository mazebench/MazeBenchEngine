(function () {
  const authorData = window.__AUTHOR_DATA__;
  const levelPreviewRenderer = window.LevelPreviewRenderer;

  if (!authorData) {
    return;
  }

  const elements = {
    applyCellValue: document.getElementById("apply-cell-value"),
    boardHeight: document.getElementById("board-height"),
    boardWidth: document.getElementById("board-width"),
    cellValue: document.getElementById("cell-value"),
    clearLevel: document.getElementById("clear-level"),
    currentFileName: document.getElementById("current-file-name"),
    existingLevels: document.getElementById("existing-levels"),
    flipHorizontal: document.getElementById("flip-horizontal"),
    flipVertical: document.getElementById("flip-vertical"),
    frameLevel: document.getElementById("frame-level"),
    grid: document.getElementById("author-grid"),
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
    solveLevel: document.getElementById("solve-level"),
    status: document.getElementById("author-status")
  };

  if (Object.values(elements).some((element) => !element)) {
    return;
  }

  const toneByName = {
    box: { background: "#d6bd94", color: "#111111" },
    circle_player: { background: "#8dc7ff", color: "#111111" },
    exit: { background: "#ff7b72", color: "#111111" },
    floating_floor: { background: "#7ee0a1", color: "#111111" },
    floor: { background: "#ffffff", color: "#111111" },
    gem: { background: "#7ee0a1", color: "#111111" },
    hole: { background: "#3a5876", color: "#ffffff" },
    ice: { background: "#c6ecff", color: "#111111" },
    player: { background: "#8dc7ff", color: "#111111" },
    player_gate: { background: "#ffd84d", color: "#111111" },
    player_lift: { background: "#ffb36c", color: "#111111" },
    wall: { background: "#242424", color: "#ffffff" },
    weightless_box: { background: "#ffb36c", color: "#111111" }
  };

  const toolByToken = new Map(authorData.palette.map((tool) => [tool.token, tool]));
  const toolByName = new Map(authorData.palette.map((tool) => [tool.name, tool]));
  const solverActorNames = new Set([
    "player",
    "circle_player",
    "box",
    "gem",
    "floating_floor",
    "weightless_box"
  ]);
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

  function normalizeCellValue(value) {
    const trimmedValue = String(value ?? "").trim();

    if (!trimmedValue) {
      return authorData.defaultFloorToken;
    }

    const tokens = trimmedValue
      .split(authorData.blockAdder)
      .map((token) => token.trim())
      .filter(Boolean);

    if (tokens.length === 0) {
      return authorData.defaultFloorToken;
    }

    const invalidToken = tokens.find((token) => !toolByToken.has(token));

    if (invalidToken) {
      throw new Error('Unknown token "' + invalidToken + '".');
    }

    return tokens.join(authorData.blockAdder);
  }

  function getCellTokens(value) {
    return String(value || "")
      .split(authorData.blockAdder)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  function getCellTools(value) {
    return getCellTokens(value)
      .map((token) => toolByToken.get(token))
      .filter(Boolean);
  }

  function serializeCells() {
    return state.cells.map((row) => row.join(authorData.separator)).join("\n");
  }

  function getCellDescriptor(value) {
    const tokens = getCellTokens(value);
    const topToken = tokens[tokens.length - 1] || authorData.defaultFloorToken;
    const tool = toolByToken.get(topToken) || toolByToken.get(tokens[0]) || null;
    const tone = toneByName[tool?.name] || { background: "#ffffff", color: "#111111" };

    return {
      label: tool ? tool.label : topToken,
      tone,
      tool,
      topToken,
      tokens
    };
  }

  function titleCaseName(name) {
    return String(name || "")
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function isSolverActorTool(tool) {
    return solverActorNames.has(tool?.name);
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

  function buildSolverTerrainCell(type, tool = null, options = {}) {
    return {
      type,
      label: tool?.label || titleCaseName(type),
      imageUrl: tool?.imageUrl || null,
      underlay: options.underlay || null,
      raised: options.raised === true
    };
  }

  function buildSolverCellState(tools) {
    const floorTool = toolByName.get("floor") || null;
    const exitTool = toolByName.get("exit") || null;
    const terrainTools = tools.filter((tool) => !isSolverActorTool(tool));
    const wallTool = terrainTools.find((tool) => tool.name === "wall") || null;
    const exitCellTool = terrainTools.find((tool) => tool.name === "exit") || null;
    const terrainTool = wallTool || exitCellTool || terrainTools[0] || null;

    if (wallTool) {
      const underlayTool = terrainTools.find((tool) => tool.name !== "wall") || floorTool;

      return buildSolverTerrainCell("wall", wallTool, {
        underlay: buildSolverTerrainCell(underlayTool?.name || "floor", underlayTool)
      });
    }

    if (terrainTool?.name === "exit") {
      return buildSolverTerrainCell("exit", exitTool || terrainTool);
    }

    if (terrainTool) {
      return buildSolverTerrainCell(terrainTool.name, terrainTool, {
        raised: terrainTool.name === "player_lift" ? false : undefined
      });
    }

    if (tools.some((tool) => isSolverActorTool(tool))) {
      return buildSolverTerrainCell("floor", floorTool);
    }

    return buildSolverTerrainCell("empty");
  }

  function buildSolverPlayData(options = {}) {
    const includeGems = options.includeGems !== false;
    const terrain = [];
    const actors = [];

    for (let y = 0; y < state.height; y += 1) {
      const terrainRow = [];

      for (let x = 0; x < state.width; x += 1) {
        const tools = getCellTools(state.cells[y][x]);

        terrainRow.push(buildSolverCellState(tools));
        tools.forEach((tool) => {
          if (!isSolverActorTool(tool)) {
            return;
          }

          if (!includeGems && tool.name === "gem") {
            return;
          }

          actors.push({
            type: tool.name,
            groupId: tool.name === "weightless_box" ? tool.token : null,
            label: tool.label,
            imageUrl: tool.imageUrl || null,
            x,
            y
          });
        });
      }

      terrain.push(terrainRow);
    }

    return {
      gameId: authorData.game.id,
      levelId: "__editor_solver__",
      levelLabel: state.levelId,
      sourceFileName: state.fileName,
      width: state.width,
      height: state.height,
      terrain,
      actors,
      cameraView: null,
      worldColumns: null,
      worldRows: null
    };
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
    const coordinates = parseLevelCoordinates(state.levelId);

    if (!coordinates) {
      return;
    }

    elements.levelColumn.value = coordinates.column;
    elements.levelRow.value = coordinates.row;
  }

  function renderLevelSelectors() {
    const columnOptions = worldColumns
      .map((letter) => '<option value="' + letter + '">' + letter + "</option>")
      .join("");
    const rowOptions = worldRows.map((letter) => '<option value="' + letter + '">' + letter + "</option>").join("");

    elements.levelColumn.innerHTML = columnOptions;
    elements.levelRow.innerHTML = rowOptions;
    syncLevelSelectors();
  }

  function renderPalette() {
    elements.palette.innerHTML = authorData.palette
      .map((tool) => {
        const swatchContents = tool.imageUrl
          ? '<img src="' + tool.imageUrl + '" alt="">'
          : '<span>' + tool.token + "</span>";

        return (
          '<button class="tool-button palette__button' +
          (tool.token === state.selectedToken ? " is-active" : "") +
          '" type="button" data-token="' +
          tool.token +
          '">' +
          '<span class="palette__swatch">' +
          swatchContents +
          "</span>" +
          '<span class="palette__meta">' +
          '<span class="palette__label">' +
          tool.label +
          "</span>" +
          '<span class="palette__token">' +
          tool.token +
          "</span>" +
          "</span>" +
          "</button>"
        );
      })
      .join("");
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
    button.textContent = value;
    button.style.background = descriptor.tone.background;
    button.style.color = descriptor.tone.color;
    button.setAttribute(
      "aria-label",
      "Cell " + (x + 1) + ", " + (y + 1) + ": " + value + " (" + descriptor.label + ")"
    );
    button.title = "Cell " + (x + 1) + ", " + (y + 1) + ": " + value;
  }

  function renderGrid() {
    const cellCount = state.width * state.height;

    elements.grid.style.gridTemplateColumns =
      "repeat(" + state.width + ", var(--author-cell-size, 32px))";

    if (elements.grid.children.length !== cellCount) {
      elements.grid.innerHTML = "";

      for (let y = 0; y < state.height; y += 1) {
        for (let x = 0; x < state.width; x += 1) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.x = String(x);
          button.dataset.y = String(y);
          elements.grid.appendChild(button);
        }
      }
    }

    Array.from(elements.grid.children).forEach((button) => {
      const x = Number(button.dataset.x);
      const y = Number(button.dataset.y);
      updateCellButton(button, x, y);
    });
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
    elements.currentFileName.textContent = state.filePath;
    elements.playLink.href = "/play/" + encodeURIComponent(authorData.game.id) + "/" + encodeURIComponent(state.levelId);
    elements.playLink.setAttribute("aria-label", "Play " + state.levelId);
    syncSolverButtonState();
  }

  function renderExistingLevels() {
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
          level.authorUrl +
          '" data-level-id="' +
          level.id +
          '">' +
          level.id.replace("level_", "") +
          "</a>"
        );
      })
      .join("");
  }

  function renderAll() {
    renderStatus();
    renderMeta();
    renderNeighborButtons();
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
  }

  function selectCell(x, y) {
    state.selectedCell = {
      x: Math.max(0, Math.min(state.width - 1, x)),
      y: Math.max(0, Math.min(state.height - 1, y))
    };
    renderGrid();
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
    selectCell(x, y);
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
      const app = createSolverApp(buildSolverPlayData({ includeGems: false }));
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

    const playData = buildSolverPlayData();

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

  renderLevelSelectors();
  renderPalette();
  renderAll();

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

  elements.existingLevels.addEventListener("click", function (event) {
    const link = event.target.closest("[data-level-id]");

    if (!link) {
      return;
    }

    event.preventDefault();
    const nextLevelId = link.dataset.levelId;

    if (nextLevelId !== state.levelId) {
      elements.levelColumn.value = parseLevelCoordinates(nextLevelId).column;
      elements.levelRow.value = parseLevelCoordinates(nextLevelId).row;
      loadLevel(nextLevelId);
    }
  });

  window.addEventListener("beforeunload", function (event) {
    if (!state.isDirty) {
      return;
    }

    event.preventDefault();
    event.returnValue = "";
  });
})();
