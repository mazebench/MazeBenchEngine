import { mountEditorCameraPad } from "../../ui/editor-camera-pad.mjs";
import { WorldContextRenderer } from "../../ui/world-context-renderer.mjs";
import { bindCameraHold } from "../../render/v1/camera-controls.mjs";
import { installTruncateControls } from "../../ui/truncate-controls.mjs";
import { createWorldContext } from "../../ui/play-world-context.mjs";
import { cellForTool, describeCell } from "../../render/v1/world-renderer.mjs";
import { encodeVoxelRoom } from "../../render/v1/voxel-world-v2.mjs";
import { loadBrowserWorld, updateLoadProgress, paintLoadProgress } from "../../ui/browser-world.mjs";
import {
  eraseOneObjectAtCell,
  objectPaintsInsideClickedBody,
  objectsAtCell,
  placeObjectInCell
} from "../../render/v1/cell-objects-v2.mjs";
import { renderToolboxPreviews } from "./toolbox-previews.mjs";
import { isDirectionalTool, parserToolTokens, portraitToken } from "./directional-tools.mjs";
import {
  editorEraseRowKey,
  editorPaintLayer,
  resolveEditorEraseTargetV2,
  resolveEditorPaintTargetV2,
  rotateVoxelObject,
  voxelPlacementForTool
} from "./face-placement-v2.mjs";
import {
  EDITOR_SOLVER_PRESETS_V1,
  EditorSolversV1,
  replayEngineSolutionV1,
  solverPathLabelV1
} from "./solvers.mjs";
import {
  MAX_GENERIC_ID,
  canonicalGenericToolToken,
  concreteGenericToolToken,
  genericToolDescriptionKey,
  genericToolDescriptor
} from "./generic-tools.mjs";

mountEditorCameraPad(document.querySelector(".camera-pad"));

const elements = {
  stage: document.getElementById("stage"),
  canvas: document.getElementById("editor-canvas"),
  loading: document.getElementById("loading"),
  loadProgress: document.getElementById("load-progress"),
  menu: document.getElementById("editor-menu"),
  roomName: document.getElementById("room-name"),
  roomGrid: document.getElementById("room-grid"),
  fileName: document.getElementById("file-name"),
  gemCount: document.getElementById("gem-count"),
  toolbox: document.getElementById("toolbox"),
  toolName: document.getElementById("tool-name"),
  toolDescription: document.getElementById("tool-description"),
  cellPosition: document.getElementById("cell-position"),
  cellValue: document.getElementById("cell-value"),
  applyCell: document.getElementById("apply-cell"),
  resetView: document.getElementById("reset-view"),
  eraser: document.getElementById("eraser"),
  undo: document.getElementById("undo"),
  save: document.getElementById("save"),
  status: document.getElementById("status"),
  playLink: document.getElementById("play-link"),
  quickSolve: document.getElementById("quick-solve"),
  exactSolve: document.getElementById("exact-solve"),
  physicsInteractionWeight: document.getElementById("physics-interaction-weight"),
  cancelSolve: document.getElementById("cancel-solve"),
  replaySolution: document.getElementById("replay-solution"),
  solverResult: document.getElementById("solver-result"),
  solverPath: document.getElementById("solver-path"),
  copySolutionUdlr: document.getElementById("copy-solution-udlr"),
  solverCopyStatus: document.getElementById("solver-copy-status"),
  solverCopyFallback: document.getElementById("solver-copy-fallback"),
  genericDialog: document.getElementById("generic-dialog"),
  genericForm: document.getElementById("generic-form"),
  genericTitle: document.getElementById("generic-title"),
  genericMessage: document.getElementById("generic-message"),
  genericId: document.getElementById("generic-id"),
  genericError: document.getElementById("generic-error"),
  genericCancel: document.getElementById("generic-cancel")
};

let world;
let parser;
let toolboxCatalog;
let renderer;
let roomWorld;
let currentRoom;
let currentTool = ".";
let selectedCell = null;
let undoStack = [];
let savedObjects = null;
let dirty = false;
let hoverHit = null;
let paintStrokeLayer = null;
let eraseStrokeRow = null;
const solvers = new EditorSolversV1();
let solverBusy = false;
let replayGeneration = 0;
let lastSolution = null;
let genericPrompt = null;
const selectedGenericIds = { block: 0, clone: 0 };
let toolboxPreviewEntries = [];

const cloneObjects = (objects) => objects.map((object) => ({ ...object }));
const countBlock = (objects, blockId) => objects.filter((object) => object.blockId === blockId).length;
const coordinateLabel = ({ x, y, z }) => `${x}, ${y}, ${z}`;

function renderEditorRoom(renderedRoom = currentRoom, options = {}) {
  renderer.setWorld(roomWorld(currentRoom, renderedRoom), options);
}

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.hidden = !message;
  elements.status.classList.toggle("is-error", error);
}

function formatRate(value) {
  const rate = Math.max(0, Number(value) || 0);
  if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(2)}M`;
  if (rate >= 1_000) return `${(rate / 1_000).toFixed(1)}k`;
  return rate.toFixed(0);
}

function invalidateSolution({ cancel = true } = {}) {
  replayGeneration += 1;
  if (cancel) solvers.cancel();
  solverBusy = false;
  lastSolution = null;
  elements.quickSolve.disabled = false;
  elements.exactSolve.disabled = false;
  elements.physicsInteractionWeight.disabled = false;
  elements.cancelSolve.disabled = true;
  elements.replaySolution.disabled = true;
  updateSolutionCopy();
  elements.solverResult.textContent = "Room changed; run a solver again.";
  elements.solverPath.textContent = "";
}

function setSolverBusy(busy, label = "") {
  solverBusy = busy;
  elements.quickSolve.disabled = busy;
  elements.exactSolve.disabled = busy;
  elements.physicsInteractionWeight.disabled = busy;
  elements.cancelSolve.disabled = !busy;
  elements.replaySolution.disabled = busy || !lastSolution?.solution?.length;
  updateSolutionCopy();
  if (label) elements.solverResult.textContent = label;
}

function markDirty(message = "Unsaved changes.") {
  invalidateSolution();
  dirty = true;
  elements.save.textContent = "Save";
  elements.save.disabled = false;
  elements.save.classList.add("primary");
  elements.gemCount.textContent = String(countBlock(currentRoom.objects, "gem"));
  setStatus(message);
}

function markSaved() {
  dirty = false;
  savedObjects = cloneObjects(currentRoom.objects);
  elements.save.textContent = "Saved";
  elements.save.disabled = true;
  elements.save.classList.remove("primary");
  setStatus(`Saved ${currentRoom.fileName}.`);
}

function pushUndo() {
  undoStack.push(cloneObjects(currentRoom.objects));
  if (undoStack.length > 50) undoStack.shift();
  elements.undo.disabled = false;
}

function inspectCoordinate(coordinate, { select = true } = {}) {
  selectedCell = { ...coordinate };
  elements.cellPosition.textContent = coordinateLabel(coordinate);
  elements.cellValue.disabled = false;
  elements.applyCell.disabled = false;
  elements.cellValue.value = JSON.stringify(objectsAtCell(currentRoom.objects, coordinate), null, 2);
  if (select) renderer.selectCell(renderer.world.rooms.find(room => !room.renderDimmed), coordinate.x, coordinate.y, coordinate.z);
  else renderer.selectCell(null);
}

function inspect(hit) {
  hoverHit = hit;
  if (!hit) {
    renderer.clearPlacementPreview();
    renderer.selectCell(null);
    return;
  }
  const coordinate = {
    x: hit.sourceX ?? hit.cellX,
    y: hit.sourceY ?? hit.cellY,
    z: hit.sourceZ ?? 0
  };
  inspectCoordinate(coordinate, { select: currentTool === "__erase_top__" });
  updatePlacementPreview(hit);
}

function placementFromHit(hit, strokeLayer = null) {
  if (!hit || currentTool === "__erase_top__") return null;
  const preview = voxelPlacementForTool(currentTool, { x: 0, y: 0, z: 0 }, hit, renderer.cameraDirections());
  if (!preview) return null;
  const selectedBlock = world.blockDefinitions.get(preview.blockId);
  const coordinate = resolveEditorPaintTargetV2(hit, {
    selectedCanShare: objectPaintsInsideClickedBody(selectedBlock)
  });
  coordinate.z = editorPaintLayer(preview.blockId, coordinate.z, strokeLayer);
  if (renderer.cutawayHeight !== null) {
    coordinate.z = Math.min(coordinate.z, renderer.cutawayHeight - 1);
  }
  if (coordinate.x < 0 || coordinate.y < 0 || coordinate.x >= currentRoom.width || coordinate.y >= currentRoom.height) {
    return null;
  }
  return voxelPlacementForTool(currentTool, coordinate, hit, renderer.cameraDirections());
}

function updatePlacementPreview(hit = hoverHit) {
  if (!renderer) return;
  if (!hit || currentTool === "__erase_top__") {
    renderer.setPlacementPreview(null);
    if (hit && currentTool === "__erase_top__") {
      renderer.selectCell(
        renderer.world.rooms.find(room => !room.renderDimmed),
        hit.sourceX ?? hit.cellX,
        hit.sourceY ?? hit.cellY,
        hit.sourceZ ?? 0
      );
    }
    return;
  }
  renderer.selectCell(null);
  renderer.setPlacementPreview(placementFromHit(hit));
}

function paint(hit, gesture) {
  const erase = currentTool === "__erase_top__";
  if (gesture.start) {
    paintStrokeLayer = null;
    eraseStrokeRow = null;
    pushUndo();
  }

  if (erase) {
    const coordinate = resolveEditorEraseTargetV2(hit, eraseStrokeRow);
    if (!coordinate) return;
    const result = eraseOneObjectAtCell(currentRoom.objects, coordinate, hit.selectionKey);
    if (!result.changed) return;
    if (eraseStrokeRow === null) eraseStrokeRow = editorEraseRowKey(hit);
    currentRoom.objects = result.objects;
    renderEditorRoom(currentRoom, { preserveCamera: true });
    inspectCoordinate(coordinate);
    markDirty(`Erased ${result.removed.blockId} at ${coordinateLabel(coordinate)}.`);
    return;
  }

  const placement = placementFromHit(hit, paintStrokeLayer);
  if (!placement) {
    setStatus("That object cannot be placed on this face or outside the room.", true);
    return;
  }
  if (paintStrokeLayer === null) paintStrokeLayer = placement.z;
  if (placement.blockId === "player") {
    currentRoom.objects = currentRoom.objects.filter((object) => object.blockId !== "player");
  }
  const result = placeObjectInCell(currentRoom.objects, placement, world.blockDefinitions);
  if (!result.changed) return;
  currentRoom.objects = result.objects;
  renderEditorRoom(currentRoom, { preserveCamera: true });
  inspectCoordinate(placement);
  markDirty(`Placed ${toolName(currentTool)} at ${coordinateLabel(placement)}.`);
}

function parserLabel(token) {
  for (const [name, definition] of Object.entries(parser.objects || {})) {
    if (definition.token === token) return definition.label || name.replaceAll("_", " ");
    for (const entry of definition.tokens || []) {
      if ((typeof entry === "string" ? entry : entry.token) === token) {
        return (typeof entry === "object" && entry.label) || definition.label || name.replaceAll("_", " ");
      }
    }
  }
  return token;
}

function toolName(token) {
  const generic = genericToolDescriptor(token);
  if (generic) return generic.name;
  return toolboxCatalog.tools?.[token]?.name || parserLabel(token) || token;
}

function toolDescription(token) {
  const descriptionKey = genericToolDescriptionKey(token);
  if (toolboxCatalog.tools?.[descriptionKey]?.description) return toolboxCatalog.tools[descriptionKey].description;
  const baseToken = token.replace(/^S[rlud]/, "Sr");
  return toolboxCatalog.tools?.[baseToken]?.description || `Place the MazeBench ${token} object.`;
}

function setTool(token) {
  currentTool = token;
  elements.toolName.textContent = toolName(token);
  elements.toolDescription.textContent = toolDescription(token);
  elements.toolbox.querySelectorAll(".tool").forEach((button) => {
    button.classList.toggle("is-current", button.dataset.token === canonicalGenericToolToken(token));
  });
  const erasing = token === "__erase_top__";
  elements.eraser.classList.toggle("is-current", erasing);
  elements.eraser.setAttribute("aria-pressed", String(erasing));
  updatePlacementPreview();
}

function concreteTokenForButton(button) {
  const descriptor = genericToolDescriptor(button.dataset.token);
  return descriptor
    ? concreteGenericToolToken(button.dataset.token, selectedGenericIds[descriptor.family])
    : button.dataset.token;
}

function refreshGenericFamily(family, { previews = true } = {}) {
  const entries = [];
  elements.toolbox.querySelectorAll(`.tool[data-generic-family="${family}"]`).forEach((button) => {
    const token = concreteTokenForButton(button);
    const descriptor = genericToolDescriptor(token);
    button.querySelector("span").textContent = String(descriptor.id);
    button.title = `${descriptor.name} — choose a numeric ID, then paint`;
    button.setAttribute("aria-label", `${descriptor.name}; choose numeric ID`);
    const preview = toolboxPreviewEntries.find((entry) => entry.button === button);
    if (preview) entries.push({ ...preview, token });
  });
  if (previews && entries.length) {
    renderToolboxPreviews(entries).catch((error) =>
      console.warn("Generic toolbox previews could not be refreshed.", error));
  }
}

function closeGenericPrompt() {
  genericPrompt = null;
  elements.genericDialog.hidden = true;
  elements.genericError.textContent = "";
}

function openGenericPrompt(token) {
  const descriptor = genericToolDescriptor(token);
  if (!descriptor) return setTool(token);
  genericPrompt = { token: descriptor.canonical, descriptor };
  elements.genericTitle.textContent = `Choose ${descriptor.familyName} ID`;
  elements.genericMessage.textContent = descriptor.slope
    ? `This slope and every ${descriptor.familyName.toLowerCase()} piece with the same number move as one object.`
    : `Every ${descriptor.familyName.toLowerCase()} cube and slope with this number moves as one object.`;
  elements.genericId.value = String(selectedGenericIds[descriptor.family]);
  elements.genericError.textContent = "";
  elements.genericDialog.hidden = false;
  requestAnimationFrame(() => {
    elements.genericId.focus();
    elements.genericId.select();
  });
}

function confirmGenericPrompt() {
  if (!genericPrompt) return;
  const id = Number(elements.genericId.value.trim());
  if (!Number.isInteger(id) || id < 0 || id > MAX_GENERIC_ID) {
    elements.genericError.textContent = `Enter a whole number from 0 to ${MAX_GENERIC_ID.toLocaleString()}.`;
    return;
  }
  const { descriptor, token } = genericPrompt;
  selectedGenericIds[descriptor.family] = id;
  closeGenericPrompt();
  const concrete = concreteGenericToolToken(token, id);
  setTool(concrete);
  refreshGenericFamily(descriptor.family);
  setStatus(`${toolName(concrete)} selected. Pieces with ID ${id} join the same object.`);
}

function buildToolbox() {
  const fragment = document.createDocumentFragment();
  const previews = [];
  parserToolTokens(parser).forEach((token) => {
    const button = document.createElement("button");
    const descriptor = describeCell(cellForTool(token));
    const visual = descriptor.actor || descriptor.terrain;
    button.type = "button";
    button.className = "tool";
    button.dataset.token = token;
    if (token === "__erase_top__") button.classList.add("eraser-tool");
    const generic = genericToolDescriptor(token);
    if (generic) button.dataset.genericFamily = generic.family;
    const displayToken = generic
      ? concreteGenericToolToken(token, selectedGenericIds[generic.family])
      : token;
    const placementHint = /^[pP][rlud]$/.test(token)
      ? " — faces a highlighted wall, or the camera on a horizontal surface"
      : isDirectionalTool(parser, token) ? " — faces camera when placed" : "";
    button.title = `${toolName(displayToken)} — ${displayToken}${placementHint}`;
    button.setAttribute("aria-label", `${toolName(displayToken)}${generic ? "; choose numeric ID" : placementHint}`);
    button.style.setProperty("--tool-color", visual?.color || "#050608");
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    canvas.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = token === "__erase_top__" ? "ERASE" : generic ? String(selectedGenericIds[generic.family]) : token;
    button.append(canvas, label);
    button.addEventListener("click", () => generic ? openGenericPrompt(token) : setTool(token));
    fragment.append(button);
    if (token !== "__erase_top__") previews.push({
      button,
      canvas,
      token: generic ? displayToken : portraitToken(parser, token)
    });
  });
  elements.toolbox.replaceChildren(fragment);
  toolboxPreviewEntries = previews;
  setTool(currentTool);
  renderToolboxPreviews(previews).catch((error) => console.warn("Toolbox previews could not be rendered.", error));
}

function buildRoomControls() {
  const sorted = world.rooms.slice().sort((a, b) => a.rowIndex - b.rowIndex || a.columnIndex - b.columnIndex);
  sorted.forEach((room) => {
    const label = room.position.join("×");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.file = room.fileName;
    button.title = `${label} — ${room.fileName}`;
    button.setAttribute("aria-label", `Open room ${label}`);
    button.addEventListener("click", () => switchRoom(room));
    elements.roomGrid.append(button);
  });
}

function updateRoomChrome() {
  const label = currentRoom.position.join("×");
  const routeRoom = encodeURIComponent(currentRoom.position.join("x"));
  elements.roomName.textContent = label;
  elements.fileName.textContent = currentRoom.fileName;
  elements.fileName.title = currentRoom.fileName;
  elements.gemCount.textContent = String(countBlock(currentRoom.objects, "gem"));
  elements.playLink.href = `../../play/v1/?room=${routeRoom}`;
  elements.playLink.setAttribute("aria-label", `Play room ${label}`);
  elements.playLink.title = `Play room ${label}`;
  elements.roomGrid.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("is-current", button.dataset.file === currentRoom.fileName);
    button.setAttribute("aria-pressed", String(button.dataset.file === currentRoom.fileName));
  });
  const url = new URL(location.href);
  url.searchParams.set("room", currentRoom.position.join("x"));
  history.replaceState(null, "", url);
}

function switchRoom(room) {
  if (room === currentRoom) return;
  if (dirty && !confirm(`Discard unsaved changes to room ${currentRoom.position.join("×")}?`)) {
    return;
  }
  if (dirty) currentRoom.objects = cloneObjects(savedObjects);
  currentRoom = room;
  invalidateSolution();
  savedObjects = cloneObjects(room.objects);
  undoStack = [];
  dirty = false;
  selectedCell = null;
  hoverHit = null;
  elements.undo.disabled = true;
  elements.cellValue.disabled = true;
  elements.applyCell.disabled = true;
  elements.cellPosition.textContent = "—";
  renderEditorRoom(room);
  updateRoomChrome();
  elements.save.textContent = "Saved";
  elements.save.disabled = true;
  elements.save.classList.remove("primary");
  setStatus("");
}

function transformRoom(transform) {
  pushUndo();
  currentRoom.objects = currentRoom.objects.map((object) =>
    rotateVoxelObject(object, transform, currentRoom.width, currentRoom.height));
  renderEditorRoom(currentRoom, { preserveCamera: true });
  selectedCell = null;
  elements.cellValue.disabled = true;
  elements.applyCell.disabled = true;
  elements.cellPosition.textContent = "—";
  markDirty(`${transform} transform applied.`);
}

async function saveRoom() {
  if (!dirty || elements.save.disabled) return;
  elements.save.disabled = true;
  setStatus(`Saving ${currentRoom.fileName}…`);
  try {
    const response = await fetch(`/api/v2/levels/${encodeURIComponent(currentRoom.fileName)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(encodeVoxelRoom(currentRoom))
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Save failed.");
    markSaved();
    const updatedRuns = payload.run_updates?.filter(update => update.changed).length || 0;
    if (updatedRuns) setStatus(`Saved. ${updatedRuns} run${updatedRuns === 1 ? "" : "s"} will use this edit on fresh entry.`);
  } catch (error) {
    setStatus(error.message || "Save failed.", true);
  } finally {
    elements.save.disabled = !dirty;
  }
}

async function runSolver(preset) {
  if (solverBusy) return;
  lastSolution = null;
  elements.solverPath.textContent = "";
  const interactionWeight = preset.id === "fast-astar"
    ? Math.max(0, Math.min(1_000, Math.floor(Number(elements.physicsInteractionWeight.value) || 0)))
    : 0;
  elements.physicsInteractionWeight.value = String(
    Math.max(0, Math.min(1_000, Math.floor(Number(elements.physicsInteractionWeight.value) || 0)))
  );
  setSolverBusy(true, `${preset.label} C++ search is starting…`);
  setStatus(`Running engine v1 ${preset.label.toLowerCase()} solver…`);
  try {
    const result = await solvers.solve(currentRoom, world.blocks, preset, {
      interactionWeight,
      onProgress: (progress) => {
        const elapsed = progress.elapsedMs < 1_000
          ? `${progress.elapsedMs.toFixed(0)} ms`
          : `${(progress.elapsedMs / 1_000).toFixed(1)} s`;
        elements.solverResult.textContent =
          `${preset.label} · ${progress.expanded.toLocaleString()} states · ` +
          `${formatRate(progress.statesPerSecond)} board states/s · ` +
          `${formatRate(progress.actionsPerSecond)} command sims/s · ${elapsed}`;
      }
    });
    lastSolution = result.solution.length ? result : null;
    const elapsed = result.elapsedMs < 1000
      ? `${result.elapsedMs.toFixed(0)} ms`
      : `${(result.elapsedMs / 1000).toFixed(2)} s`;
    const proof = result.proven ? "proven shortest" : result.status === "solved-unproven" ? "route found, not proven" : result.status;
    const route = result.solution.length ? `${result.moves} moves` : "no route";
    elements.solverResult.textContent =
      `${proof} · ${route} · ${result.expanded.toLocaleString()} states · ` +
      `${formatRate(result.statesPerSecond)} board states/s · ` +
      `${formatRate(result.actionsPerSecond)} command sims/s · ${elapsed}`;
    elements.solverPath.textContent = solverPathLabelV1(result.solution);
    setStatus(result.solution.length
      ? `Engine v1 found a ${result.moves}-move ${result.proven ? "optimal " : ""}route.`
      : `Engine v1 search finished: ${result.status}.`, !result.solution.length);
  } catch (error) {
    if (error?.name !== "AbortError") {
      elements.solverResult.textContent = error?.message || "Solver failed.";
      setStatus(error?.message || "Solver failed.", true);
    }
  } finally {
    setSolverBusy(false);
  }
}

function updateSolutionCopy() {
  const unavailable = !lastSolution?.solution?.length;
  elements.copySolutionUdlr.disabled = unavailable;
  if (unavailable) {
    elements.solverCopyStatus.textContent = "";
    elements.solverCopyFallback.hidden = true;
    elements.solverCopyFallback.value = "";
  }
}

async function copySolution() {
  const solution = lastSolution?.solution;
  if (!solution?.length) return;
  const text = solverPathLabelV1(solution);
  elements.solverCopyFallback.hidden = true;
  try {
    await navigator.clipboard.writeText(text);
    if (lastSolution?.solution !== solution) return;
    elements.solverCopyStatus.textContent = "UDLR string copied.";
  } catch {
    if (lastSolution?.solution !== solution) return;
    elements.solverCopyFallback.value = text;
    elements.solverCopyFallback.hidden = false;
    elements.solverCopyFallback.focus();
    elements.solverCopyFallback.select();
    elements.solverCopyStatus.textContent = "Press ⌘C or Ctrl+C to copy the selected solution.";
  }
}

async function replaySolution() {
  if (solverBusy || !lastSolution?.solution?.length) return;
  const generation = ++replayGeneration;
  setSolverBusy(true, `Replaying ${lastSolution.solution.length} engine commands…`);
  try {
    await replayEngineSolutionV1(
      currentRoom,
      world.blocks,
      lastSolution.solution,
      (room) => renderEditorRoom(room, { preserveCamera: true }),
      { isCancelled: () => generation !== replayGeneration }
    );
    if (generation === replayGeneration) {
      setStatus("Solution replay complete; the authored room is unchanged.");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    setStatus(error?.message || "Replay failed.", true);
  } finally {
    if (generation === replayGeneration) {
      renderEditorRoom(currentRoom, { preserveCamera: true });
      setSolverBusy(false);
    }
  }
}

elements.menu.addEventListener("click", (event) => {
  if (event.target.closest(".menu-items button, .menu-items a")) {
    elements.menu.open = false;
    elements.menu.querySelector("summary").focus();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!elements.menu.contains(event.target)) elements.menu.open = false;
});
document.addEventListener("focusin", (event) => {
  if (!elements.menu.contains(event.target)) elements.menu.open = false;
});
elements.resetView.addEventListener("click", () => renderer?.resetView());
elements.eraser.addEventListener("click", () => setTool("__erase_top__"));
elements.save.addEventListener("click", saveRoom);
elements.genericForm.addEventListener("submit", (event) => {
  event.preventDefault();
  confirmGenericPrompt();
});
elements.genericId.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  confirmGenericPrompt();
});
elements.genericCancel.addEventListener("click", closeGenericPrompt);
elements.genericDialog.addEventListener("pointerdown", (event) => {
  if (event.target === elements.genericDialog) closeGenericPrompt();
});
elements.quickSolve.addEventListener("click", () => runSolver(EDITOR_SOLVER_PRESETS_V1.fast));
elements.exactSolve.addEventListener("click", () => runSolver(EDITOR_SOLVER_PRESETS_V1.exact));
elements.cancelSolve.addEventListener("click", () => {
  replayGeneration += 1;
  if (solvers.cancel()) setStatus("Solver cancelled.");
  if (renderer && currentRoom) renderEditorRoom(currentRoom, { preserveCamera: true });
  setSolverBusy(false);
});
elements.replaySolution.addEventListener("click", replaySolution);
elements.copySolutionUdlr.addEventListener("click", copySolution);
elements.undo.addEventListener("click", () => {
  const previous = undoStack.pop();
  if (!previous) return;
  currentRoom.objects = previous;
  renderEditorRoom(currentRoom, { preserveCamera: true });
  elements.undo.disabled = undoStack.length === 0;
  markDirty("Undid the last edit.");
});
elements.applyCell.addEventListener("click", () => {
  if (!selectedCell) return;
  try {
    const parsed = JSON.parse(elements.cellValue.value || "[]");
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const replacements = entries.map((entry) => {
      if (!entry || typeof entry !== "object" || !world.blockDefinitions.has(entry.blockId)) {
        throw new Error("Every 3D object needs a known blockId.");
      }
      return { ...entry, ...selectedCell };
    });
    pushUndo();
    const selectedKey = coordinateLabel(selectedCell);
    currentRoom.objects = [
      ...currentRoom.objects.filter((object) => coordinateLabel(object) !== selectedKey),
      ...replacements
    ];
    renderEditorRoom(currentRoom, { preserveCamera: true });
    inspectCoordinate(selectedCell);
    markDirty(`Applied ${replacements.length} object${replacements.length === 1 ? "" : "s"} at ${coordinateLabel(selectedCell)}.`);
  } catch (error) {
    setStatus(error.message || "Invalid object JSON.", true);
  }
});
document.querySelectorAll("[data-transform]").forEach((button) => {
  button.addEventListener("click", () => transformRoom(button.dataset.transform));
});
window.addEventListener("beforeunload", (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && elements.menu.open) {
    event.preventDefault();
    elements.menu.open = false;
    elements.menu.querySelector("summary").focus();
    return;
  }
  if (event.key === "Escape" && genericPrompt) {
    event.preventDefault();
    closeGenericPrompt();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveRoom();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    elements.undo.click();
  }
  if (!event.repeat && ["a", "d"].includes(event.key.toLowerCase())) {
    setTimeout(() => updatePlacementPreview(), 410);
  }
});

for (const [id, key] of [["tilt-up", "w"], ["tilt-down", "s"]]) {
  bindCameraHold(document.getElementById(id), { key, getRenderer: () => renderer });
}
for (const [id, direction] of [["rotate-left", -1], ["rotate-right", 1]]) {
  document.getElementById(id).addEventListener("click", () => {
    renderer?.rotateCardinal(direction);
    setTimeout(() => updatePlacementPreview(), 410);
  });
}

try {
  const loadingControls = [elements.eraser, elements.quickSolve, elements.exactSolve,
    ...document.querySelectorAll("[data-transform], .camera-pad .pad-button")];
  loadingControls.forEach((button) => { button.disabled = true; });
  [world, parser, toolboxCatalog] = await Promise.all([
    loadBrowserWorld((complete, total, phase) => updateLoadProgress(elements.loadProgress, complete, total, phase)),
    fetch("./level_parsing.json").then((response) => response.json()),
    fetch("./toolbox.json").then((response) => response.json())
  ]);
  buildToolbox();
  buildRoomControls();
  const requested = new URL(location.href).searchParams.get("room")?.toUpperCase();
  currentRoom = world.rooms.find((room) => room.position.join("X") === requested) || world.rooms[0];
  savedObjects = cloneObjects(currentRoom.objects);
  roomWorld = createWorldContext(world);
  updateLoadProgress(elements.loadProgress, 85, 100, "Drawing room");
  await paintLoadProgress();
  renderer = new WorldContextRenderer(elements.canvas, roomWorld(currentRoom), {
    mode: "editor",
    onInspect: inspect,
    onSelect: inspect,
    onPaint: paint
  });
  installTruncateControls(document.getElementById("cutaway-controls"), renderer, {
    onChange: () => { hoverHit = null; updatePlacementPreview(); }
  });
  new ResizeObserver(() => renderer.resize()).observe(elements.stage);
  updateRoomChrome();
  await paintLoadProgress();
  elements.loadProgress.value = elements.loadProgress.max;
  loadingControls.forEach((button) => { button.disabled = false; });
  elements.stage.classList.add("is-ready");
  setStatus("");
} catch (error) {
  elements.loading.textContent = error.message || "Could not load editor.";
  elements.loading.classList.add("is-error");
  elements.loading.setAttribute("role", "alert");
  setStatus("Editor failed to load.", true);
  console.error(error);
}
