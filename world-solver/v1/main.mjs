const ids = [
  "status", "world-canvas", "actions-per-second", "actions", "rooms", "gems",
  "undos", "teleports", "current-room", "states-per-second", "exact-states",
  "bfs-actions-per-second",
  "expanded-states", "tested-actions", "edge-states", "exit-tiles",
  "state-capacity", "bfs-rooms", "bfs-processed-rooms", "bfs-gems",
  "active-searches", "search-slices", "heuristic-weight", "opportunities",
  "row-targets", "row-visited", "rows-discovered", "row-coverage",
  "bfs-current-room", "random-stats", "bfs-stats", "random-legend", "bfs-legend",
  "map-room-details", "intro-description", "mode-random", "mode-bfs", "mode-dfs", "mode-super",
  "mode-row", "restart", "stop"
];
const elements = Object.fromEntries(ids.map((id) => [
  id.replaceAll("-", ""),
  document.getElementById(id)
]));

const context = elements.worldcanvas.getContext("2d", { alpha: false });
let worker = null;
let mode = "bfs";
let width = 256;
let height = 256;
let roomWidth = 16;
let roomHeight = 16;
let visited = new Uint8Array(width * height);
let reachedRooms = new Map();
let roomsByGridPosition = new Map();
let exitCells = new Set();
let recent = [];
let lastStats = {};
const lockedSearchModes = new Set();
const searchSnapshots = new Map();

const isSearchMode = () => mode !== "random";
const searchName = () => mode === "dfs-meta"
  ? "DFS Meta"
  : mode === "super-astar"
    ? "Super A*"
    : mode === "row-astar" ? "Row A*" : "World BFS";

function resetMap(nextWidth, nextHeight) {
  width = nextWidth;
  height = nextHeight;
  elements.worldcanvas.width = width;
  elements.worldcanvas.height = height;
  elements.worldcanvas.setAttribute(
    "aria-label",
    `${width} by ${height} ${isSearchMode() ? searchName() : "random-agent"} visit map`
  );
  visited = new Uint8Array(width * height);
  reachedRooms = new Map();
  roomsByGridPosition = new Map();
  exitCells = new Set();
  recent = [];
  lastStats = {};
  draw();
}

function draw() {
  const image = context.createImageData(width, height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    image.data[offset] = 9;
    image.data[offset + 1] = 12;
    image.data[offset + 2] = 16;
    image.data[offset + 3] = 255;
  }
  for (const room of reachedRooms.values()) {
    const firstX = room.columnIndex * roomWidth;
    const firstY = room.rowIndex * roomHeight;
    for (let y = firstY; y < firstY + roomHeight; y += 1) {
      for (let x = firstX; x < firstX + roomWidth; x += 1) {
        const offset = (y * width + x) * 4;
        if (!isSearchMode()) {
          image.data[offset] = 27;
          image.data[offset + 1] = 70;
          image.data[offset + 2] = 37;
        } else if (room.searchStatus === "searched") {
          image.data[offset] = 102;
          image.data[offset + 1] = 49;
          image.data[offset + 2] = 15;
        } else {
          image.data[offset] = 82;
          image.data[offset + 1] = 68;
          image.data[offset + 2] = 18;
        }
      }
    }
  }
  for (let index = 0; index < visited.length; index += 1) {
    if (!visited[index]) continue;
    const offset = index * 4;
    const room = roomAtCell(index);
    if (isSearchMode() && room?.searchStatus === "searched") {
      image.data[offset] = 255;
      image.data[offset + 1] = 139;
      image.data[offset + 2] = 37;
    } else {
      image.data[offset] = 255;
      image.data[offset + 1] = 216;
      image.data[offset + 2] = 64;
    }
  }
  for (const index of exitCells) {
    if (index < 0 || index >= visited.length) continue;
    const offset = index * 4;
    image.data[offset] = 108;
    image.data[offset + 1] = 215;
    image.data[offset + 2] = 255;
  }
  recent.forEach((index, age) => {
    if (index < 0 || index >= visited.length) return;
    if (isSearchMode() && roomAtCell(index)?.searchStatus === "searched") return;
    const amount = recent.length === 1 ? 1 : age / (recent.length - 1);
    const offset = index * 4;
    image.data[offset] = 255;
    image.data[offset + 1] = Math.round(216 + (52 - 216) * amount);
    image.data[offset + 2] = Math.round(64 + (35 - 64) * amount);
  });
  for (const room of reachedRooms.values()) {
    if (!room.gemCount) continue;
    const markerX = room.columnIndex * roomWidth + roomWidth - 3;
    const markerY = room.rowIndex * roomHeight + 1;
    for (let y = markerY; y < markerY + 2; y += 1) {
      for (let x = markerX; x < markerX + 2; x += 1) {
        const offset = (y * width + x) * 4;
        image.data[offset] = 238;
        image.data[offset + 1] = 111;
        image.data[offset + 2] = 255;
      }
    }
  }
  context.putImageData(image, 0, 0);
}

function roomAtCell(index) {
  const x = index % width;
  const y = Math.floor(index / width);
  const columnIndex = Math.floor(x / roomWidth);
  const rowIndex = Math.floor(y / roomHeight);
  return roomsByGridPosition.get(`${columnIndex},${rowIndex}`);
}

elements.worldcanvas.addEventListener("pointermove", (event) => {
  const bounds = elements.worldcanvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - bounds.left) * width / bounds.width);
  const y = Math.floor((event.clientY - bounds.top) * height / bounds.height);
  const room = roomAtCell(y * width + x);
  elements.maproomdetails.textContent = room
    ? `${room.position?.join("×") || room.fileName} · ${formatNumber(room.gemCount)} gems found`
    : "Unreached room";
});

elements.worldcanvas.addEventListener("pointerleave", () => {
  elements.maproomdetails.textContent = "Hover a room to see its coordinate and gems.";
});

function setReachedRoom(room) {
  reachedRooms.set(room.fileName, room);
  roomsByGridPosition.set(`${room.columnIndex},${room.rowIndex}`, room);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function showStats(stats) {
  lastStats = stats;
  if (isSearchMode()) {
    elements.statespersecond.textContent = formatNumber(stats.statesPerSecond);
    elements.bfsactionspersecond.textContent = formatNumber(stats.actionsPerSecond);
    elements.exactstates.textContent = formatNumber(stats.states);
    elements.bfsrooms.textContent = formatNumber(stats.rooms);
    elements.bfsprocessedrooms.textContent = formatNumber(stats.processedRooms);
    elements.bfsgems.textContent = formatNumber(stats.gems);
    elements.bfscurrentroom.textContent = stats.currentRoom || "H×I";
    elements.expandedstates.textContent = formatNumber(stats.expanded);
    elements.testedactions.textContent = formatNumber(stats.transitions);
    elements.edgestates.textContent = formatNumber(stats.edgeStates);
    elements.exittiles.textContent = formatNumber(stats.exitCells);
    elements.statecapacity.textContent = formatNumber(stats.stateCapacity);
    elements.activesearches.textContent = formatNumber(stats.activeSearches);
    elements.searchslices.textContent = formatNumber(stats.searchSlices);
    elements.heuristicweight.textContent = formatNumber(stats.heuristicWeight);
    elements.opportunities.textContent = formatNumber(stats.opportunities);
    elements.rowtargets.textContent = formatNumber(stats.rowTargets);
    elements.rowvisited.textContent = formatNumber(stats.rowVisited);
    elements.rowsdiscovered.textContent = formatNumber(stats.rowsDiscovered);
    elements.rowcoverage.textContent = stats.rowCoverageComplete ? "Yes" : "No";
    return;
  }
  elements.actionspersecond.textContent = formatNumber(stats.actionsPerSecond);
  elements.actions.textContent = formatNumber(stats.actions);
  elements.rooms.textContent = formatNumber(stats.rooms);
  elements.gems.textContent = formatNumber(stats.gems);
  elements.undos.textContent = formatNumber(stats.undos);
  elements.teleports.textContent = formatNumber(stats.teleports);
  elements.currentroom.textContent = stats.currentRoom || "H×I";
}

function update(message) {
  if (message.width && message.height &&
      (message.width !== width || message.height !== height)) {
    resetMap(message.width, message.height);
  }
  roomWidth = message.roomWidth || roomWidth;
  roomHeight = message.roomHeight || roomHeight;
  for (const room of message.reachedRooms || []) setReachedRoom(room);
  for (const room of message.gemRooms || []) {
    setReachedRoom({
      ...(reachedRooms.get(room.fileName) || {}),
      ...room,
      gemCount: room.count
    });
  }
  for (const update of message.roomUpdates || []) {
    setReachedRoom({
      ...(reachedRooms.get(update.fileName) || {}),
      ...update
    });
  }
  for (const index of message.visitedCells || []) {
    if (index >= 0 && index < visited.length) visited[index] = 1;
  }
  for (const edge of message.exitStates || []) {
    if (edge.cell >= 0 && edge.cell < visited.length) exitCells.add(edge.cell);
  }
  if (message.trailReplaces) recent = [];
  for (const index of message.trail || []) {
    if (index >= 0 && index < visited.length &&
        (!isSearchMode() || roomAtCell(index)?.searchStatus !== "searched")) {
      recent.push(index);
    }
  }
  if (recent.length > 50) recent.splice(0, recent.length - 50);
  showStats(message.stats || {});
  draw();
}

function setModeUi() {
  const search = isSearchMode();
  elements.modebfs.setAttribute("aria-pressed", String(mode === "bfs"));
  elements.modedfs.setAttribute("aria-pressed", String(mode === "dfs-meta"));
  elements.modesuper.setAttribute("aria-pressed", String(mode === "super-astar"));
  elements.moderow.setAttribute("aria-pressed", String(mode === "row-astar"));
  elements.moderandom.setAttribute("aria-pressed", String(mode === "random"));
  elements.bfsstats.hidden = !search;
  elements.randomstats.hidden = search;
  elements.bfslegend.hidden = !search;
  elements.randomlegend.hidden = search;
  elements.introdescription.textContent = mode === "bfs"
    ? "Finishes each room's exact BFS before opening the next newly reached room. Every room resets to authored state and uses its first discovered entrance."
    : mode === "dfs-meta"
      ? "Runs exact BFS inside each room, but suspends it immediately when a new-room entrance appears. It explores that room first, then resumes the saved BFS frontier."
      : mode === "super-astar"
        ? "Time-slices a global portfolio of weighted A* searches. Every room attacks its nearest gems and undiscovered outlets without letting one difficult search monopolize the run."
        : mode === "row-astar"
          ? "Targets every unvisited standable tile on each reached vertical row. Gems and exits are incidental; floating floors dynamically extend the landscape, and exhausted rooms stay closed."
      : "Randomly presses only ↑ → ↓ ←. A death immediately undoes that action; every 10,000 moves it teleports to a random reached room to escape softlocks.";
  elements.restart.textContent = search ? `Restart ${searchName()}` : "Restart at H×I";
}

function terminateWorker() {
  worker?.terminate();
  worker = null;
  elements.stop.disabled = true;
}

function saveSearchSnapshot() {
  searchSnapshots.set(mode, {
    width,
    height,
    roomWidth,
    roomHeight,
    visited: visited.slice(),
    reachedRooms: new Map(reachedRooms),
    exitCells: new Set(exitCells),
    recent: [...recent],
    stats: { ...lastStats }
  });
}

function restoreSearchSnapshot() {
  const snapshot = searchSnapshots.get(mode);
  if (!snapshot) return;
  width = snapshot.width;
  height = snapshot.height;
  roomWidth = snapshot.roomWidth;
  roomHeight = snapshot.roomHeight;
  elements.worldcanvas.width = width;
  elements.worldcanvas.height = height;
  visited = snapshot.visited.slice();
  reachedRooms = new Map(snapshot.reachedRooms);
  roomsByGridPosition = new Map([...reachedRooms.values()].map((room) => [
    `${room.columnIndex},${room.rowIndex}`,
    room
  ]));
  exitCells = new Set(snapshot.exitCells);
  recent = [...snapshot.recent];
  showStats(snapshot.stats);
  draw();
}

function stop(message) {
  terminateWorker();
  elements.status.textContent = message ||
    (isSearchMode() ? `${searchName()} stopped.` : "Random agent stopped.");
}

function finishSearch() {
  lockedSearchModes.add(mode);
  saveSearchSnapshot();
  terminateWorker();
  elements.restart.disabled = true;
  elements.restart.textContent = `${searchName()} locked`;
  elements.status.textContent =
    `${searchName()} complete · ${formatNumber(lastStats.rooms)} rooms · ` +
    `${formatNumber(lastStats.gems)} gems · ${formatNumber(lastStats.states)} states`;
}

function start() {
  terminateWorker();
  setModeUi();
  elements.status.style.color = "";
  if (isSearchMode() && lockedSearchModes.has(mode)) {
    restoreSearchSnapshot();
    elements.restart.disabled = true;
    elements.restart.textContent = `${searchName()} locked`;
    elements.status.textContent =
      `${searchName()} complete · ${formatNumber(lastStats.rooms)} rooms · ` +
      `${formatNumber(lastStats.gems)} gems · ${formatNumber(lastStats.states)} states`;
    return;
  }

  elements.restart.disabled = false;
  resetMap(256, 256);
  elements.stop.disabled = false;
  elements.status.textContent = isSearchMode()
    ? `Loading ${searchName()} at H×I…`
    : "Loading engine and world at H×I…";
  worker = new Worker(new URL("./worker.mjs", import.meta.url), {
    type: "module",
    name: `mazebench-${mode}-v1`
  });
  worker.addEventListener("message", (event) => {
    const message = event.data || {};
    if (["ready", "room-start", "room-resume", "room-suspend", "search-yield", "progress", "room-complete", "complete", "limit-hit"].includes(message.type)) {
      update(message);
      if (message.type === "complete" && isSearchMode()) {
        finishSearch();
      } else if (isSearchMode()) {
        elements.status.textContent =
          `${mode === "dfs-meta" ? "DFS Meta" : mode === "super-astar" ? "Super A*" : mode === "row-astar" ? "Row A*" : "BFS"} ${message.stats.currentRoom} · ${formatNumber(message.stats.rooms)} rooms · ` +
          `${formatNumber(message.stats.actionsPerSecond)} actions/sec`;
      } else {
        elements.status.textContent =
          `Running in ${message.stats.currentRoom} · ` +
          `${formatNumber(message.stats.actionsPerSecond)} actions/sec`;
      }
    } else if (message.type === "error") {
      stop(message.error);
      elements.status.style.color = "#ff7b72";
    }
  });
  worker.addEventListener("error", (event) => {
    stop(event.message || "World Solver worker failed.");
    elements.status.style.color = "#ff7b72";
  }, { once: true });
  worker.postMessage({ type: "start", mode });
}

function selectMode(nextMode) {
  mode = nextMode;
  start();
}

elements.modebfs.addEventListener("click", () => selectMode("bfs"));
elements.modedfs.addEventListener("click", () => selectMode("dfs-meta"));
elements.modesuper.addEventListener("click", () => selectMode("super-astar"));
elements.moderow.addEventListener("click", () => selectMode("row-astar"));
elements.moderandom.addEventListener("click", () => selectMode("random"));
elements.restart.addEventListener("click", start);
elements.stop.addEventListener("click", () => stop());
window.addEventListener("beforeunload", terminateWorker);

setModeUi();
start();
