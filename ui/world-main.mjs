import { setupCurrentVersionBadge } from './current-version.mjs';
// Browser entry point; retain render/v1/main.mjs for signed historical runs.
import { bindCameraHold } from "../render/v1/camera-controls.mjs";
import { RENDERER_VERSION } from "../render/v1/world-renderer.mjs";
import { FlyoverRenderer } from "./flyover-renderer.mjs";
import { loadBrowserWorld, updateLoadProgress, paintLoadProgress } from "./browser-world.mjs";
import { prepareWorldSurfaces } from "./prepared-world-surfaces.mjs";
import { installFlyoverGamepadControls } from "./play-gamepad.mjs";
import { installGamepadPresentation } from "./gamepad-presentation.mjs";

setupCurrentVersionBadge(document.querySelector('.identity'), { benchmark: true });

const elements = {
  canvas: document.getElementById("world"),
  viewport: document.getElementById("viewport"),
  status: document.getElementById("status"),
  loading: document.getElementById("loading"),
  loadProgress: document.getElementById("load-progress"),
  roomActions: document.getElementById("room-actions"),
  selectedRoom: document.getElementById("selected-room"),
  roomPlay: document.getElementById("room-play"),
  roomEdit: document.getElementById("room-edit"),
  dismissRoom: document.getElementById("dismiss-room"),
  selectedHighlight: document.getElementById("selected-highlight"),
  hoverHighlight: document.getElementById("hover-highlight"),
  hoverLabel: document.getElementById("hover-room-label"),
  editor: document.getElementById("editor-link")
};

let renderer = null;
let selectedRoom = null;
let hoveredRoom = null;

function drawHighlight(element, room, view) {
  const points = room && view ? view.projectRoomOutline(room) : [];
  element.toggleAttribute("hidden", points.length < 3);
  if (points.length >= 3) {
    const polygon = points.map(({ x, y }) => `${x},${y}`).join(" ");
    element.querySelectorAll("polygon").forEach((face) => face.setAttribute("points", polygon));
  }
  return points;
}

function updateHighlights(view = renderer) {
  drawHighlight(elements.selectedHighlight, selectedRoom, view);
  const points = drawHighlight(elements.hoverHighlight, hoveredRoom !== selectedRoom ? hoveredRoom : null, view);
  elements.hoverLabel.hidden = points.length < 3;
  if (points.length < 3) return;
  const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const topY = Math.min(...points.map((point) => point.y));
  elements.hoverLabel.textContent = hoveredRoom.position.join("×");
  elements.hoverLabel.style.left = `${Math.max(36, Math.min(elements.canvas.clientWidth - 36, centerX))}px`;
  elements.hoverLabel.style.top = `${Math.max(38, Math.min(elements.canvas.clientHeight - 8, topY - 8))}px`;
}

function inspect(hit) {
  const room = hit?.room || null;
  if (hoveredRoom === room) return;
  hoveredRoom = room;
  elements.canvas.classList.toggle("is-hovering-room", Boolean(room));
  updateHighlights();
}

function dismissSelection() {
  const restoreFocus = elements.roomActions.contains(document.activeElement);
  selectedRoom = null;
  elements.roomActions.hidden = true;
  elements.editor.href = "./editor/v1/?room=HxI";
  inspect(null);
  updateHighlights();
  if (restoreFocus) elements.viewport.focus({ preventScroll: true });
}

function select(hit) {
  if (!hit) return dismissSelection();
  selectedRoom = hit.room;
  const routeRoom = encodeURIComponent(hit.room.position.join("x"));
  const roomLabel = hit.room.position.join("×");
  updateHighlights();
  elements.selectedRoom.textContent = roomLabel;
  elements.roomPlay.href = `./play/v1/?room=${routeRoom}`;
  elements.roomPlay.setAttribute("aria-label", `Play room ${roomLabel}`);
  elements.roomEdit.href = `./editor/v1/?room=${routeRoom}`;
  elements.roomEdit.setAttribute("aria-label", `Edit room ${roomLabel}`);
  elements.editor.href = elements.roomEdit.href;
  elements.roomActions.hidden = false;
}

function bindHold(id, key, tap) {
  return bindCameraHold(document.getElementById(id), { key, getRenderer: () => renderer, tap });
}

bindHold("zoom-in", "q", () => renderer.zoomBy(0.8));
bindHold("zoom-out", "e", () => renderer.zoomBy(1 / 0.8));
bindHold("tilt-up", "w");
bindHold("tilt-down", "s");
bindHold("rotate-left", "a");
bindHold("rotate-right", "d");
const gamepadButtons = {
  left: document.getElementById("rotate-left"), right: document.getElementById("rotate-right"),
  up: document.getElementById("tilt-up"), down: document.getElementById("tilt-down"),
  zoomIn: document.getElementById("zoom-in"), zoomOut: document.getElementById("zoom-out")
};
installFlyoverGamepadControls({
  ...installGamepadPresentation(),
  isReady: () => Boolean(renderer && !elements.viewport.classList.contains("is-loading")),
  onCameraInput: input => renderer?.setGamepadCameraInput(input),
  onFeedback: ({ yaw, tilt, zoom }) => {
    const active = { left: yaw < 0, right: yaw > 0, up: tilt > 0, down: tilt < 0,
      zoomIn: zoom < 0, zoomOut: zoom > 0 };
    for (const [name, button] of Object.entries(gamepadButtons)) {
      button.classList.toggle("is-gamepad-active", active[name]);
    }
  }
});
elements.canvas.addEventListener("dblclick", () => renderer?.focusRoom(selectedRoom));
elements.dismissRoom.addEventListener("click", dismissSelection);
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !selectedRoom) return;
  event.preventDefault();
  dismissSelection();
});

try {
  const progress = (complete, total, phase) => updateLoadProgress(elements.loadProgress, complete, total, phase);
  const world = await loadBrowserWorld(progress);
  await prepareWorldSurfaces(world, (complete, total) => progress(65 + 30 * complete / total, 100, "Building world"));
  progress(95, 100, "Drawing world");
  await paintLoadProgress();
  renderer = new FlyoverRenderer(elements.canvas, world, {
    mode: "world",
    onSelect: select,
    onInspect: inspect,
    onViewChange: updateHighlights
  });
  new ResizeObserver(() => renderer.resize()).observe(elements.viewport);
  await paintLoadProgress();
  progress(100, 100, "World ready");
  elements.viewport.classList.remove("is-loading");
  const objectCount = world.rooms.reduce((total, room) => total + room.objects.length, 0);
  elements.status.textContent = `${world.rooms.length} rooms · ${objectCount.toLocaleString()} 3D objects`;
  document.title = `MazeBench — Main World · renderer v${RENDERER_VERSION}`;
} catch (error) {
  elements.loading.textContent = error.message || "Could not render the world.";
  elements.loading.setAttribute("role", "alert");
  elements.status.textContent = "Load failed";
  elements.loading.classList.add("is-error");
  console.error(error);
}
