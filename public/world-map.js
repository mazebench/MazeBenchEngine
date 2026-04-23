(function () {
  const worldMapData = window.__WORLD_MAP_EDITOR_DATA__;

  if (!worldMapData) {
    return;
  }

  const elements = {
    authorLink: document.getElementById("world-map-author-link"),
    columns: document.getElementById("world-map-columns"),
    count: document.getElementById("world-map-count"),
    grid: document.getElementById("world-map-grid"),
    placed: document.getElementById("world-map-placed"),
    playLink: document.getElementById("world-map-play-link"),
    reset: document.getElementById("world-map-reset"),
    rows: document.getElementById("world-map-rows"),
    save: document.getElementById("world-map-save"),
    selection: document.getElementById("world-map-selection"),
    status: document.getElementById("world-map-status"),
    unmap: document.getElementById("world-map-unmap"),
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
    message: worldMapData.message || "Select a tile, then click a world slot to move it.",
    messageTone: "warning",
    savedEntries: cloneEntries(worldMapData.entries || []),
    selectedFileName: null,
    selectedPosition: null
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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
    return "Empty slot " + formatPosition(position) + " selected. Press Author Slot to create or edit it.";
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
    elements.status.className = "author-status is-" + state.messageTone;
  }

  function renderAxes() {
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
          '<span class="world-map-grid__slot">' +
          escapeHtml(formatPosition(entry.position)) +
          "</span>" +
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
    const selectedFile = worldMapData.files.find((file) => file.fileName === state.selectedFileName) || null;
    const selectedPosition =
      Array.isArray(state.selectedPosition) && state.selectedPosition.length >= 2
        ? state.selectedPosition.slice(0, 2)
        : null;
    const selectedSlotIsEmpty =
      selectedPosition && !getEntryAtPosition(selectedPosition[0], selectedPosition[1]);
    const hasMappedSelection = Boolean(selectedEntry);

    function setLinkState(link, href, isEnabled) {
      link.href = isEnabled ? href : "#";
      link.classList.toggle("is-disabled", !isEnabled);
      link.setAttribute("aria-disabled", isEnabled ? "false" : "true");
    }

    if (selectedEntry) {
      elements.selection.textContent = describeSelection(selectedEntry);
    } else if (selectedFile) {
      elements.selection.textContent = describeUnplaced(selectedFile.fileName);
    } else if (selectedSlotIsEmpty) {
      elements.selection.textContent = describeEmptySlot(selectedPosition);
    } else {
      elements.selection.textContent = "No tile selected. Click a placed tile or an unplaced file to begin moving it.";
    }

    elements.unmap.disabled = !hasMappedSelection;
    elements.unmap.setAttribute("aria-disabled", hasMappedSelection ? "false" : "true");

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
    const placedEntries = sortEntries(state.entries);
    const unplacedFiles = getUnplacedFiles();

    elements.placed.innerHTML = placedEntries.length
      ? placedEntries
          .map((entry) => {
            const previewUrl = getPreviewUrlForFile(entry.fileName);
            const previewMarkup = previewUrl
              ? '<img class="world-map-list__preview" src="' + escapeHtml(previewUrl) + '" alt="">'
              : '<span class="world-map-list__preview-placeholder">No preview</span>';
            return (
              '<button class="tool-button world-map-list__item' +
              (entry.fileName === state.selectedFileName ? " is-active" : "") +
              '" type="button" data-file-name="' +
              escapeHtml(entry.fileName) +
              '">' +
              '<span class="world-map-list__preview-shell">' +
              previewMarkup +
              "</span>" +
              '<span class="world-map-list__body">' +
              '<span class="world-map-list__title">' +
              escapeHtml(entry.fileName) +
              "</span>" +
              '<span class="world-map-list__meta">' +
              escapeHtml(formatPosition(entry.position)) +
              "</span>" +
              "</span>" +
              "</button>"
            );
          })
          .join("")
      : '<p class="world-map-empty-copy">No tiles are placed yet.</p>';

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
      : '<p class="world-map-empty-copy">Every top-level file is currently on the map.</p>';

    elements.count.textContent = state.entries.length + " / " + worldMapData.files.length;
  }

  function renderAll() {
    state.entries = sortEntries(state.entries);
    renderStatus();
    renderGrid();
    renderSelection();
    renderLists();
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

  function unmapSelected() {
    const selectedEntry = getEntryByFileName(state.selectedFileName);

    if (!selectedEntry) {
      setStatus("Select a placed tile to unmap it.", "warning");
      return;
    }

    state.entries = state.entries.filter((entry) => entry.fileName !== selectedEntry.fileName);
    markDirty("Moved " + selectedEntry.fileName + " to the unplaced list.");
  }

  function resetMap() {
    state.entries = cloneEntries(state.savedEntries);
    state.isDirty = false;
    state.message = "Restored the last saved world map.";
    state.messageTone = "warning";

    if (state.selectedFileName && !worldMapData.files.some((file) => file.fileName === state.selectedFileName)) {
      state.selectedFileName = null;
    }

    renderAll();
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

  renderAxes();
  renderAll();

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

  elements.placed.addEventListener("click", function (event) {
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

  elements.unmap.addEventListener("click", unmapSelected);
  elements.reset.addEventListener("click", resetMap);
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
})();
