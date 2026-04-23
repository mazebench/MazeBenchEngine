(function () {
  const worldMapData = window.__WORLD_MAP_EDITOR_DATA__;

  if (!worldMapData) {
    return;
  }

  const elements = {
    authorLink: document.getElementById("world-map-author-link"),
    canvas: document.querySelector(".world-map-canvas"),
    columns: document.getElementById("world-map-columns"),
    deselect: document.getElementById("world-map-deselect"),
    grid: document.getElementById("world-map-grid"),
    gridShell: document.querySelector(".world-map-grid-shell"),
    playLink: document.getElementById("world-map-play-link"),
    rows: document.getElementById("world-map-rows"),
    save: document.getElementById("world-map-save"),
    sidebar: document.querySelector(".world-map-sidebar"),
    status: document.getElementById("world-map-status"),
    unplaced: document.getElementById("world-map-unplaced")
  };

  if (Object.values(elements).some((element) => !element)) {
    return;
  }

  const worldColumns =
    Array.isArray(worldMapData.worldColumns) && worldMapData.worldColumns.length > 0
      ? worldMapData.worldColumns
      : ["A"];
  const worldRows =
    Array.isArray(worldMapData.worldRows) && worldMapData.worldRows.length > 0
      ? worldMapData.worldRows
      : ["A"];
  const columnIndexByValue = new Map(worldColumns.map((value, index) => [value, index]));
  const rowIndexByValue = new Map(worldRows.map((value, index) => [value, index]));
  const state = {
    entries: cloneEntries(worldMapData.entries || []),
    isDirty: false,
    layoutFrameId: null,
    message: "World map ready.",
    messageTone: "warning",
    savedEntries: cloneEntries(worldMapData.entries || []),
    selectedFileName: null,
    selectedPosition: null
  };
  const worldMapMaxCellSize = 56;
  const worldMapMinCellSize = 8;
  const worldMapMinAxisSize = 22;
  const worldMapMaxAxisSize = 36;
  const worldMapGapSize = 2;
  const worldMapGridPadding = 4;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function readPixelValue(value) {
    const parsed = parseFloat(value);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  function clampWorldMapSize(value, min, max) {
    return Math.max(min, Math.min(max, Math.floor(value)));
  }

  function cloneEntries(entries) {
    return entries.map((entry) => ({
      authorUrl: entry.authorUrl || "",
      fileName: entry.fileName,
      id: entry.id,
      label: entry.label,
      previewUrl: entry.previewUrl || "",
      playUrl: entry.playUrl || "",
      position: Array.isArray(entry.position) ? entry.position.slice(0, 2) : ["A", "A"]
    }));
  }

  function sortEntries(entries) {
    return entries
      .slice()
      .sort((left, right) => {
        const leftRow = rowIndexByValue.get(left.position[1]) ?? Number.MAX_SAFE_INTEGER;
        const rightRow = rowIndexByValue.get(right.position[1]) ?? Number.MAX_SAFE_INTEGER;

        if (leftRow !== rightRow) {
          return leftRow - rightRow;
        }

        const leftColumn = columnIndexByValue.get(left.position[0]) ?? Number.MAX_SAFE_INTEGER;
        const rightColumn = columnIndexByValue.get(right.position[0]) ?? Number.MAX_SAFE_INTEGER;

        if (leftColumn !== rightColumn) {
          return leftColumn - rightColumn;
        }

        return left.fileName.localeCompare(right.fileName, undefined, { numeric: true });
      });
  }

  function buildLevelId(position) {
    return "level_" + position[0] + "x" + position[1];
  }

  function buildLevelLabel(position) {
    return "Level " + position[0] + "x" + position[1];
  }

  function buildPlayUrl(levelId) {
    return worldMapData.playBaseUrl + "/" + encodeURIComponent(levelId);
  }

  function buildAuthorUrl(levelId) {
    return worldMapData.authorBaseUrl + "/" + encodeURIComponent(levelId);
  }

  function buildEntry(fileName, position) {
    const levelId = buildLevelId(position);
    const fileRecord = getFileRecord(fileName);

    return {
      authorUrl: buildAuthorUrl(levelId),
      fileName,
      id: levelId,
      label: buildLevelLabel(position),
      previewUrl: fileRecord?.previewUrl || "",
      playUrl: buildPlayUrl(levelId),
      position: position.slice(0, 2)
    };
  }

  function getFileRecord(fileName) {
    return worldMapData.files.find((file) => file.fileName === fileName) || null;
  }

  function getEntryByFileName(fileName) {
    return state.entries.find((entry) => entry.fileName === fileName) || null;
  }

  function getEntryAtPosition(column, row) {
    return state.entries.find((entry) => entry.position[0] === column && entry.position[1] === row) || null;
  }

  function getUnplacedFiles() {
    const mappedFileNames = new Set(state.entries.map((entry) => entry.fileName));

    return worldMapData.files.filter((file) => !mappedFileNames.has(file.fileName));
  }

  function getPreviewUrlForFile(fileName) {
    return getFileRecord(fileName)?.previewUrl || "";
  }

  function formatPosition(position) {
    return position[0] + "x" + position[1];
  }

  function positionsMatch(left, right) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left[0] === right[0] &&
      left[1] === right[1]
    );
  }

  function describeSelection(entry) {
    if (!entry) {
      return "No tile selected. Click a placed tile or an unplaced file to begin moving it.";
    }

    return entry.fileName + " is currently at " + formatPosition(entry.position) + ".";
  }

  function describeUnplaced(fileName) {
    return fileName + " is currently unplaced. Click a world slot to put it on the map.";
  }

  function describeEmptySlot(position) {
    return "Empty slot " + formatPosition(position) + " selected. Press Edit Slot to create or edit it.";
  }

  function markDirty(message) {
    state.isDirty = true;
    state.message = message;
    state.messageTone = "warning";
    renderAll();
  }

  function setStatus(message, tone) {
    state.message = message;
    state.messageTone = tone || "warning";
    renderStatus();
  }

  function renderStatus() {
    const dirtySuffix = state.isDirty ? " Unsaved changes." : "";
    elements.status.textContent = state.message + dirtySuffix;
    elements.status.className = "sr-only";
  }

  function measureWorldMapLayout() {
    const shellStyles = window.getComputedStyle(elements.gridShell);
    const paddingX =
      readPixelValue(shellStyles.paddingLeft) + readPixelValue(shellStyles.paddingRight);
    const paddingY =
      readPixelValue(shellStyles.paddingTop) + readPixelValue(shellStyles.paddingBottom);
    const viewportHeight =
      window.visualViewport?.height || window.innerHeight || worldRows.length * worldMapMaxCellSize;
    const shellRect = elements.gridShell.getBoundingClientRect();
    const cappedTop = Math.max(0, Math.min(shellRect.top, Math.max(120, viewportHeight * 0.28)));
    const availableWidth = Math.max(
      worldMapMinCellSize,
      elements.gridShell.clientWidth - paddingX
    );
    const availableHeight = Math.max(
      worldMapMinCellSize,
      viewportHeight - cappedTop - paddingY - 24
    );
    const axisSize = clampWorldMapSize(
      Math.min(availableWidth, availableHeight) * 0.1,
      worldMapMinAxisSize,
      worldMapMaxAxisSize
    );
    const widthExtras =
      axisSize +
      worldMapGapSize +
      worldMapGridPadding +
      Math.max(0, worldColumns.length - 1) * worldMapGapSize;
    const heightExtras =
      axisSize +
      worldMapGapSize +
      worldMapGridPadding +
      Math.max(0, worldRows.length - 1) * worldMapGapSize;
    const cellByWidth = (availableWidth - widthExtras) / Math.max(1, worldColumns.length);
    const cellByHeight = (availableHeight - heightExtras) / Math.max(1, worldRows.length);

    return {
      axisSize,
      cellSize: clampWorldMapSize(
        Math.min(cellByWidth, cellByHeight),
        worldMapMinCellSize,
        worldMapMaxCellSize
      )
    };
  }

  function syncWorldMapTrayHeight() {
    const trayHeight = Math.ceil(elements.gridShell.getBoundingClientRect().height);

    if (Number.isFinite(trayHeight) && trayHeight > 0) {
      elements.sidebar.style.setProperty("--world-map-tray-height", trayHeight + "px");
    }
  }

  function syncWorldMapLayout() {
    const layout = measureWorldMapLayout();

    elements.canvas.style.setProperty("--world-map-axis-size", layout.axisSize + "px");
    elements.canvas.style.setProperty("--world-map-cell-size", layout.cellSize + "px");
    syncWorldMapTrayHeight();
  }

  function scheduleWorldMapLayout() {
    if (state.layoutFrameId !== null) {
      return;
    }

    state.layoutFrameId = window.requestAnimationFrame(() => {
      state.layoutFrameId = null;
      syncWorldMapLayout();
    });
  }

  function renderAxes() {
    syncWorldMapLayout();
    elements.columns.style.gridTemplateColumns =
      "repeat(" + worldColumns.length + ", var(--world-map-cell-size, 56px))";
    elements.columns.innerHTML = worldColumns
      .map((value) => '<span class="world-map-axis__label">' + escapeHtml(value) + "</span>")
      .join("");
    elements.rows.innerHTML = worldRows
      .map((value) => '<span class="world-map-row-label">' + escapeHtml(value) + "</span>")
      .join("");
  }

  function renderGrid() {
    const cellCount = worldColumns.length * worldRows.length;

    syncWorldMapLayout();
    elements.grid.style.gridTemplateColumns =
      "repeat(" + worldColumns.length + ", var(--world-map-cell-size, 56px))";

    if (elements.grid.children.length !== cellCount) {
      elements.grid.innerHTML = "";

      worldRows.forEach((row) => {
        worldColumns.forEach((column) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "world-map-grid__cell";
          button.dataset.column = column;
          button.dataset.row = row;
          elements.grid.appendChild(button);
        });
      });
    }

    Array.from(elements.grid.children).forEach((button) => {
      const column = button.dataset.column;
      const row = button.dataset.row;
      const entry = getEntryAtPosition(column, row);
      const position = [column, row];
      const isSelected = entry
        ? entry.fileName === state.selectedFileName
        : positionsMatch(state.selectedPosition, position);

      button.className =
        "world-map-grid__cell" +
        (entry ? " is-filled" : " is-empty") +
        (isSelected ? " is-selected" : "");

      if (entry) {
        const previewUrl = getPreviewUrlForFile(entry.fileName);
        const previewMarkup = previewUrl
          ? '<img class="world-map-grid__preview" src="' + escapeHtml(previewUrl) + '" alt="">'
          : '<span class="world-map-grid__placeholder">No preview</span>';
        const selectionMarkup = isSelected
          ? '<span class="world-map-grid__selection-frame" aria-hidden="true"></span>'
          : "";
        button.innerHTML =
          selectionMarkup +
          '<span class="world-map-grid__preview-shell">' +
          previewMarkup +
          "</span>";
        button.setAttribute(
          "aria-label",
          entry.fileName + " at " + formatPosition(entry.position)
        );
        button.title = entry.fileName + " at " + formatPosition(entry.position);
      } else {
        button.innerHTML =
          (isSelected
            ? '<span class="world-map-grid__selection-frame" aria-hidden="true"></span>'
            : "") + '<span class="world-map-grid__empty">.</span>';
        button.setAttribute("aria-label", "Empty slot " + formatPosition([column, row]));
        button.title = "Empty slot " + formatPosition([column, row]);
      }
    });
  }

  function renderSelection() {
    const selectedEntry = getEntryByFileName(state.selectedFileName);
    const selectedPosition =
      Array.isArray(state.selectedPosition) && state.selectedPosition.length >= 2
        ? state.selectedPosition.slice(0, 2)
        : null;
    const selectedSlotIsEmpty =
      selectedPosition && !getEntryAtPosition(selectedPosition[0], selectedPosition[1]);
    const hasSelection = Boolean(state.selectedFileName || selectedPosition);

    function setLinkState(link, href, isEnabled) {
      link.href = isEnabled ? href : "#";
      link.classList.toggle("is-disabled", !isEnabled);
      link.classList.toggle("is-active", isEnabled);
      link.setAttribute("aria-disabled", isEnabled ? "false" : "true");
    }

    elements.deselect.disabled = !hasSelection;
    elements.deselect.classList.toggle("is-disabled", !hasSelection);
    elements.deselect.setAttribute("aria-disabled", hasSelection ? "false" : "true");

    if (selectedEntry) {
      setLinkState(elements.playLink, selectedEntry.playUrl, true);
      setLinkState(elements.authorLink, selectedEntry.authorUrl, true);
    } else if (selectedSlotIsEmpty) {
      setLinkState(elements.playLink, "#", false);
      setLinkState(
        elements.authorLink,
        buildAuthorUrl(buildLevelId(selectedPosition)),
        true
      );
    } else {
      setLinkState(elements.playLink, "#", false);
      setLinkState(elements.authorLink, "#", false);
    }
  }

  function renderLists() {
    const unplacedFiles = getUnplacedFiles();

    elements.unplaced.innerHTML = unplacedFiles.length
      ? unplacedFiles
          .map((file) => {
            const previewMarkup = file.previewUrl
              ? '<img class="world-map-list__preview" src="' + escapeHtml(file.previewUrl) + '" alt="">'
              : '<span class="world-map-list__preview-placeholder">No preview</span>';
            return (
              '<button class="tool-button world-map-list__item' +
              (file.fileName === state.selectedFileName ? " is-active" : "") +
              '" type="button" data-file-name="' +
              escapeHtml(file.fileName) +
              '">' +
              '<span class="world-map-list__preview-shell">' +
              previewMarkup +
              "</span>" +
              '<span class="world-map-list__body">' +
              '<span class="world-map-list__title">' +
              escapeHtml(file.fileName) +
              "</span>" +
              '<span class="world-map-list__meta">Unplaced</span>' +
              "</span>" +
              "</button>"
            );
          })
          .join("")
      : '<p class="world-map-empty-copy">Every tile is currently mapped.</p>';
  }

  function renderAll() {
    state.entries = sortEntries(state.entries);
    renderStatus();
    renderGrid();
    renderSelection();
    renderLists();
    scheduleWorldMapLayout();
  }

  function selectFile(fileName, message) {
    if (!fileName) {
      state.selectedFileName = null;
      state.selectedPosition = null;
      setStatus("Selection cleared.", "warning");
      renderAll();
      return;
    }

    state.selectedFileName = fileName;
    state.selectedPosition = null;
    const selectedEntry = getEntryByFileName(fileName);

    if (selectedEntry) {
      setStatus(message || describeSelection(selectedEntry), "warning");
    } else {
      setStatus(message || describeUnplaced(fileName), "warning");
    }

    renderAll();
  }

  function selectEmptySlot(column, row, message) {
    state.selectedFileName = null;
    state.selectedPosition = [column, row];
    setStatus(message || describeEmptySlot(state.selectedPosition), "warning");
    renderAll();
  }

  function clearSelection(message) {
    state.selectedFileName = null;
    state.selectedPosition = null;
    setStatus(message || "Selection cleared.", "warning");
    renderAll();
  }

  function moveSelectedTo(column, row) {
    if (!state.selectedFileName) {
      setStatus("Select a tile first.", "warning");
      return;
    }

    const selectedFileName = state.selectedFileName;
    const selectedEntry = getEntryByFileName(state.selectedFileName);
    const occupant = getEntryAtPosition(column, row);

    if (selectedEntry && selectedEntry.position[0] === column && selectedEntry.position[1] === row) {
      selectFile(selectedEntry.fileName, describeSelection(selectedEntry));
      return;
    }

    if (selectedEntry) {
      const previousPosition = selectedEntry.position.slice();
      selectedEntry.position = [column, row];
      selectedEntry.id = buildLevelId(selectedEntry.position);
      selectedEntry.label = buildLevelLabel(selectedEntry.position);
      selectedEntry.playUrl = buildPlayUrl(selectedEntry.id);
      selectedEntry.authorUrl = buildAuthorUrl(selectedEntry.id);

      if (occupant && occupant.fileName !== selectedEntry.fileName) {
        occupant.position = previousPosition;
        occupant.id = buildLevelId(occupant.position);
        occupant.label = buildLevelLabel(occupant.position);
        occupant.playUrl = buildPlayUrl(occupant.id);
        occupant.authorUrl = buildAuthorUrl(occupant.id);
        state.selectedFileName = null;
        markDirty(
          "Swapped " +
            selectedFileName +
            " into " +
            formatPosition(selectedEntry.position) +
            " and moved " +
            occupant.fileName +
            " to " +
            formatPosition(occupant.position) +
            "."
        );
        return;
      }

      state.selectedFileName = null;
      markDirty("Moved " + selectedFileName + " to " + formatPosition(selectedEntry.position) + ".");
      return;
    }

    if (occupant) {
      state.entries = state.entries.filter((entry) => entry.fileName !== occupant.fileName);
      state.entries.push(buildEntry(selectedFileName, [column, row]));
      state.selectedFileName = null;
      markDirty(
        "Placed " +
          selectedFileName +
          " at " +
          formatPosition([column, row]) +
          " and moved " +
          occupant.fileName +
          " to the unplaced list."
      );
      return;
    }

    state.selectedFileName = null;
    state.entries.push(buildEntry(selectedFileName, [column, row]));
    markDirty("Placed " + selectedFileName + " at " + formatPosition([column, row]) + ".");
  }

  async function saveMap() {
    try {
      const response = await fetch(worldMapData.apiUrl, {
        body: JSON.stringify({
          entries: state.entries.map((entry) => ({
            fileName: entry.fileName,
            position: entry.position.slice(0, 2)
          }))
        }),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        method: "POST"
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not save the world map.");
      }

      worldMapData.entries = cloneEntries(payload.entries || []);
      worldMapData.files = Array.isArray(payload.files) ? payload.files.slice() : worldMapData.files;
      state.entries = cloneEntries(payload.entries || []);
      state.savedEntries = cloneEntries(payload.entries || []);
      state.isDirty = false;
      state.message = payload.message || "Saved world_map.json.";
      state.messageTone = "success";
      renderAll();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save the world map.", "error");
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
      scheduleWorldMapLayout();
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

  function initializeWorldMapDisclosures() {
    document.querySelectorAll(".world-map-sidebar .author-disclosure").forEach((details) => {
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

  renderAxes();
  renderAll();
  initializeWorldMapDisclosures();

  elements.grid.addEventListener("click", function (event) {
    const button = event.target.closest(".world-map-grid__cell");

    if (!button) {
      return;
    }

    const column = button.dataset.column;
    const row = button.dataset.row;
    const occupant = getEntryAtPosition(column, row);
    const position = [column, row];

    if (!state.selectedFileName) {
      if (occupant) {
        selectFile(occupant.fileName);
        return;
      }

      if (positionsMatch(state.selectedPosition, position)) {
        clearSelection("Deselected empty slot " + formatPosition(position) + ".");
        return;
      }

      selectEmptySlot(column, row);
      return;
    }

    if (occupant && occupant.fileName === state.selectedFileName) {
      clearSelection("Deselected " + occupant.fileName + ".");
      return;
    }

    moveSelectedTo(column, row);
  });

  elements.unplaced.addEventListener("click", function (event) {
    const button = event.target.closest("[data-file-name]");

    if (!button) {
      return;
    }

    if (button.dataset.fileName === state.selectedFileName) {
      clearSelection("Deselected " + button.dataset.fileName + ".");
      return;
    }

    selectFile(button.dataset.fileName);
  });

  elements.deselect.addEventListener("click", function () {
    clearSelection("Selection cleared.");
  });
  elements.save.addEventListener("click", saveMap);

  elements.playLink.addEventListener("click", function (event) {
    if (elements.playLink.classList.contains("is-disabled")) {
      event.preventDefault();
    }
  });

  elements.authorLink.addEventListener("click", function (event) {
    if (elements.authorLink.classList.contains("is-disabled")) {
      event.preventDefault();
    }
  });
  window.addEventListener("resize", scheduleWorldMapLayout);
})();
