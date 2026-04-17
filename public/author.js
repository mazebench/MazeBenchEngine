(function () {
  const authorData = window.__AUTHOR_DATA__;

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
    frameLevel: document.getElementById("frame-level"),
    grid: document.getElementById("author-grid"),
    levelColumn: document.getElementById("level-column"),
    levelRow: document.getElementById("level-row"),
    palette: document.getElementById("palette"),
    playLink: document.getElementById("author-play-link"),
    rawOutput: document.getElementById("raw-output"),
    resizeLevel: document.getElementById("resize-level"),
    saveLevel: document.getElementById("save-level"),
    selectedCellLabel: document.getElementById("selected-cell-label"),
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
  const state = {
    cells: cloneCells(authorData.initialLevel.cells),
    exists: authorData.initialLevel.exists,
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

  function serializeCells() {
    return state.cells.map((row) => row.join(authorData.separator)).join("\n");
  }

  function getCellDescriptor(value) {
    const tokens = String(value || "")
      .split(authorData.blockAdder)
      .map((token) => token.trim())
      .filter(Boolean);
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

  function syncLevelSelectors() {
    const coordinates = parseLevelCoordinates(state.levelId);

    if (!coordinates) {
      return;
    }

    elements.levelColumn.value = coordinates.column;
    elements.levelRow.value = coordinates.row;
  }

  function renderLevelSelectors() {
    const options = authorData.letters
      .map((letter) => '<option value="' + letter + '">' + letter + "</option>")
      .join("");

    elements.levelColumn.innerHTML = options;
    elements.levelRow.innerHTML = options;
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
    const nextWidth = Math.max(1, Math.min(authorData.maxBoardSize, requestedWidth || state.width));
    const nextHeight = Math.max(1, Math.min(authorData.maxBoardSize, requestedHeight || state.height));
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

  function frameLevel() {
    for (let y = 0; y < state.height; y += 1) {
      for (let x = 0; x < state.width; x += 1) {
        const isEdge = x === 0 || y === 0 || x === state.width - 1 || y === state.height - 1;

        if (isEdge) {
          state.cells[y][x] = authorData.defaultWallToken;
        }
      }
    }

    setStatus("Wrapped the border in walls.", "warning");
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
      state.filePath = payload.filePath;
      state.height = payload.height;
      state.isDirty = false;
      state.levelId = payload.levelId;
      state.message = payload.message || "Saved.";
      state.messageTone = "success";
      state.width = payload.width;
      syncLevelSelectors();
      renderAll();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save that level.", "error");
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
  elements.applyCellValue.addEventListener("click", applySelectedCellValue);
  elements.cellValue.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      applySelectedCellValue();
    }
  });
  elements.saveLevel.addEventListener("click", saveLevel);

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
