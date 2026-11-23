import { loadMazeBenchEngineV1 } from "../../engine/v1/engine.mjs";
import { AsciiMazeRendererV1 } from "../../render-ascii/v1/ascii-renderer.mjs";
import { roomContextWorld } from "../../render/v1/room-context.mjs";
import { ThreeMazeRendererV1 } from "../../render/v1/three-renderer.mjs";
import { installCutawayControls } from "../../render/v1/cutaway-controls.mjs";
import { loadMainWorldV2 } from "../../render/v1/voxel-world-v2.mjs";
import { bindCameraHold } from "../../render/v1/camera-controls.mjs";
import { cameraRelativeMoveDirection } from "./camera-relative-input.mjs";
import { ConnectedWorldSessionV1 } from "./connected-world-session.mjs";
import {
  DEFAULT_PLAY_FRAME_DELAY_MS,
  PlaySessionV1
} from "./play-session.mjs";
import { installRoomControlsV1 } from "./room-controls.mjs";

const elements = {
  stage: document.getElementById("stage"),
  canvas: document.getElementById("play-canvas"),
  asciiView: document.getElementById("ascii-view"),
  asciiBoard: document.getElementById("ascii-board"),
  asciiCamera: document.getElementById("ascii-camera"),
  asciiLegend: document.getElementById("ascii-legend"),
  asciiSeed: document.getElementById("ascii-seed"),
  seededGlyphs: document.getElementById("seeded-glyphs"),
  zoomControls: document.getElementById("zoom-controls"),
  loading: document.getElementById("loading"),
  loadProgress: document.getElementById("load-progress"),
  roomName: document.getElementById("room-name"),
  roomGrid: document.getElementById("room-grid"),
  gemCount: document.getElementById("gem-count"),
  state: document.getElementById("play-state"),
  animationDelay: document.getElementById("animation-delay"),
  animationRate: document.getElementById("animation-rate"),
  reset: document.getElementById("reset"),
  undo: document.getElementById("undo"),
  viewToggle: document.getElementById("view-toggle"),
  viewLabel: document.getElementById("view-label"),
  editorLink: document.getElementById("editor-link"),
  directionButtons: [...document.querySelectorAll("[data-direction]")]
};

let world;
let engine;
let renderer;
let asciiRenderer;
let session;
let connectedWorld;
let currentRoom;
let markCurrentRoom;
let viewMode = "3d";
let asciiPitch = 1;
let lastAsciiPitchStep = 0;

const MIN_ANIMATION_DELAY_MS = 0;
const MAX_ANIMATION_DELAY_MS = 10_000;
const initialParams = new URL(location.href).searchParams;
const requestedAnimationDelay = initialParams.has("animationMs")
  ? Number(initialParams.get("animationMs"))
  : Number.NaN;
let animationDelayMs = initialParams.get("instantAnimations") === "1"
  ? 0
  : Number.isFinite(requestedAnimationDelay) &&
    requestedAnimationDelay >= MIN_ANIMATION_DELAY_MS && requestedAnimationDelay <= MAX_ANIMATION_DELAY_MS
    ? requestedAnimationDelay
    : DEFAULT_PLAY_FRAME_DELAY_MS;

const ASCII_VIEW_NAMES = Object.freeze([
  "top",
  "top-diagonal",
  "diagonal",
  "side-diagonal",
  "side"
]);

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ["SELECT", "TEXTAREA"].includes(target.tagName)) return true;
  if (target.tagName !== "INPUT") return false;
  return !["button", "checkbox", "radio", "range"].includes(target.type);
}

function roomWorld(room, renderedRoom = room) {
  return roomContextWorld(world, room, renderedRoom, {
    omitDimmedRoleIds: ["player"]
  });
}

function showFrame(state, room) {
  const renderedRoom = engine.roomFromState(state, room);
  renderer.setWorld(roomWorld(room, renderedRoom), { preserveCamera: true });
  asciiRenderer.setRoom(renderedRoom);
}

function updateAsciiCameraLabel() {
  const yaw = renderer?.heading || 0;
  elements.asciiCamera.textContent = `${ASCII_VIEW_NAMES[asciiPitch]} · ${yaw * 90}°`;
}

function setAsciiPitch(pitch) {
  asciiPitch = Math.max(0, Math.min(ASCII_VIEW_NAMES.length - 1, Math.round(pitch)));
  asciiRenderer?.setPitch(asciiPitch);
  updateAsciiCameraLabel();
}

function moveFromCamera(direction) {
  const worldDirection = cameraRelativeMoveDirection(direction, renderer?.heading || 0);
  if (worldDirection) return session?.move(worldDirection);
}

function setViewMode(mode) {
  cancelCameraButtons.forEach((cancel) => cancel());
  renderer?.cancelCameraMotion();
  viewMode = mode === "ascii" ? "ascii" : "3d";
  const ascii = viewMode === "ascii";
  elements.asciiView.hidden = !ascii;
  elements.stage.classList.toggle("is-ascii", ascii);
  elements.stage.dataset.viewMode = viewMode;
  elements.viewLabel.textContent = ascii ? "3D" : "ASCII";
  elements.viewToggle.setAttribute("aria-pressed", String(ascii));
  elements.zoomControls.hidden = ascii;
  if (ascii) {
    asciiRenderer.setYaw(renderer.heading);
    asciiRenderer.setPitch(asciiPitch);
    updateAsciiCameraLabel();
  }
}

function toggleViewMode() {
  if (!asciiRenderer || !renderer) return;
  setViewMode(viewMode === "3d" ? "ascii" : "3d");
}

function updateSeedOptions({ persist = true } = {}) {
  const hideNames = elements.seededGlyphs.checked;
  const hideNamesSeed = elements.asciiSeed.value.trim() || "1";
  elements.asciiSeed.disabled = !hideNames;
  asciiRenderer?.setSeedOptions({ hideNames, hideNamesSeed });
  if (!persist) return;
  const url = new URL(location.href);
  if (hideNames) {
    url.searchParams.set("seededGlyphs", "1");
    url.searchParams.set("asciiSeed", hideNamesSeed);
  } else {
    url.searchParams.delete("seededGlyphs");
    url.searchParams.delete("asciiSeed");
  }
  history.replaceState(null, "", url);
}

function updateSession(summary) {
  elements.gemCount.textContent = String(summary.gems);
  elements.directionButtons.forEach((button) => {
    button.disabled = !summary.playerActive;
  });
  elements.undo.disabled = !summary.canUndo;
  if (summary.error) elements.state.textContent = summary.error;
  else if (!summary.playerActive) elements.state.textContent = "Player fell out of the room.";
  else if (summary.cycle) elements.state.textContent = "Cycle detected; command rolled back.";
  else elements.state.textContent = "";
  elements.state.hidden = !elements.state.textContent;
}

function formatAnimationDelay(value) {
  return String(Number(value.toFixed(2)));
}

function updateAnimationSettings({ persist = true } = {}) {
  const requestedDelay = Number(elements.animationDelay.value);
  if (Number.isFinite(requestedDelay) &&
      requestedDelay >= MIN_ANIMATION_DELAY_MS && requestedDelay <= MAX_ANIMATION_DELAY_MS) {
    animationDelayMs = requestedDelay;
  } else {
    elements.animationDelay.value = formatAnimationDelay(animationDelayMs);
  }
  elements.animationRate.textContent = animationDelayMs === 0
    ? "Instant moves"
    : `${Number((1000 / animationDelayMs).toFixed(2))} frames per second`;
  session?.setFrameDelay(animationDelayMs);
  if (!persist) return;
  const url = new URL(location.href);
  if (Math.abs(animationDelayMs - DEFAULT_PLAY_FRAME_DELAY_MS) < 0.001) {
    url.searchParams.delete("animationMs");
  } else {
    url.searchParams.set("animationMs", formatAnimationDelay(animationDelayMs));
  }
  url.searchParams.delete("instantAnimations");
  history.replaceState(null, "", url);
}

function activateRoom(room) {
  currentRoom = room;
  const label = room.position.join("×");
  const routeRoom = encodeURIComponent(room.position.join("x"));
  elements.roomName.textContent = label;
  elements.editorLink.href = `../../editor/v1/?room=${routeRoom}`;
  elements.editorLink.setAttribute("aria-label", `Edit room ${label}`);
  markCurrentRoom(room);
  const url = new URL(location.href);
  url.searchParams.set("room", room.position.join("x"));
  history.replaceState(null, "", url);
}

function openRoom(room) {
  activateRoom(room);
  asciiRenderer.openRoom(room);
  session.open(room);
}

function rotateCamera(direction) {
  renderer?.rotateCardinal(direction);
  if (viewMode === "ascii") {
    asciiRenderer?.setYaw(renderer?.heading || 0);
    updateAsciiCameraLabel();
  }
}

const cancelCameraButtons = [];
function bindCamera(id, key, tap) {
  cancelCameraButtons.push(bindCameraHold(document.getElementById(id), {
    key,
    getRenderer: () => renderer,
    tap,
    discreteStep: () => {
      if (viewMode !== "ascii" || (key !== "w" && key !== "s")) return false;
      setAsciiPitch(asciiPitch + (key === "w" ? -1 : 1));
      return true;
    }
  }));
}
bindCamera("tilt-up", "w");
bindCamera("tilt-down", "s");
bindCamera("zoom-in", "q", () => renderer.zoomBy(0.8));
bindCamera("zoom-out", "e", () => renderer.zoomBy(1 / 0.8));
document.getElementById("rotate-left").addEventListener("click", () => rotateCamera(-1));
document.getElementById("rotate-right").addEventListener("click", () => rotateCamera(1));

elements.viewToggle.addEventListener("click", toggleViewMode);
elements.reset.addEventListener("click", () => session?.reset());
elements.undo.addEventListener("click", () => session?.undo());
elements.seededGlyphs.addEventListener("change", updateSeedOptions);
elements.asciiSeed.addEventListener("change", updateSeedOptions);
elements.animationDelay.value = formatAnimationDelay(animationDelayMs);
elements.animationDelay.addEventListener("change", updateAnimationSettings);
updateAnimationSettings({ persist: false });
elements.directionButtons.forEach((button) => {
  button.addEventListener("click", () => moveFromCamera(button.dataset.direction));
});
window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;
  const key = event.key.toLowerCase();
  if (key === "m") {
    event.preventDefault();
    if (!event.repeat) toggleViewMode();
    return;
  }
  if (key === "r" || key === "z") {
    event.preventDefault();
    if (event.repeat) return;
    if (key === "r") session?.reset();
    else session?.undo();
    return;
  }
  if (viewMode === "ascii" && (key === "w" || key === "s")) {
    event.preventDefault();
    const now = performance.now();
    if (!event.repeat || now - lastAsciiPitchStep >= 140) {
      lastAsciiPitchStep = now;
      setAsciiPitch(asciiPitch + (key === "w" ? -1 : 1));
    }
    return;
  }
  if (viewMode === "ascii" && (key === "a" || key === "d")) {
    event.preventDefault();
    if (!event.repeat) {
      rotateCamera(key === "a" ? -1 : 1);
    }
    return;
  }
  if (viewMode === "ascii" && (key === "q" || key === "e")) {
    event.preventDefault();
    return;
  }
  const direction = {
    ArrowUp: "up",
    ArrowRight: "right",
    ArrowDown: "down",
    ArrowLeft: "left"
  }[event.key];
  if (!direction) return;
  event.preventDefault();
  if (!event.repeat) moveFromCamera(direction);
});

try {
  [world, engine] = await Promise.all([
    loadMainWorldV2((complete, total) => {
      elements.loadProgress.max = total + 1;
      elements.loadProgress.value = complete;
    }),
    loadMazeBenchEngineV1()
  ]);
  markCurrentRoom = installRoomControlsV1(
    world,
    elements.roomGrid,
    openRoom
  );
  const requested = new URL(location.href).searchParams.get("room")?.toUpperCase() || "HXI";
  currentRoom = world.rooms.find((room) => room.position.join("X") === requested) || world.rooms[0];
  renderer = new ThreeMazeRendererV1(elements.canvas, roomWorld(currentRoom), { mode: "play" });
  installCutawayControls(document.getElementById("cutaway-controls"), renderer, { ghosts: true });
  const params = new URL(location.href).searchParams;
  elements.seededGlyphs.checked = params.get("seededGlyphs") === "1";
  elements.asciiSeed.value = params.get("asciiSeed") || "1";
  asciiRenderer = new AsciiMazeRendererV1(
    elements.asciiBoard,
    elements.asciiLegend,
    world.blockDefinitions,
    {
      hideNames: elements.seededGlyphs.checked,
      hideNamesSeed: elements.asciiSeed.value
    }
  );
  updateSeedOptions({ persist: false });
  connectedWorld = new ConnectedWorldSessionV1(engine, world.blocks, world.rooms);
  session = new PlaySessionV1(engine, world.blocks, {
    onFrame: showFrame,
    onChange: updateSession,
    onRoomChange: activateRoom,
    resolveCommand: (state, room, direction) =>
      connectedWorld.simulateCommand(state, room, direction),
    frameDelay: animationDelayMs
  });
  new ResizeObserver(() => renderer.resize()).observe(elements.canvas.parentElement);
  openRoom(currentRoom);
  setViewMode("3d");
  elements.viewToggle.disabled = false;
  elements.reset.disabled = false;
  elements.loadProgress.value = elements.loadProgress.max;
  elements.stage.classList.add("is-ready");
} catch (error) {
  elements.loading.textContent = error?.message || "Play mode failed to load.";
  elements.loading.classList.add("is-error");
  elements.loading.setAttribute("role", "alert");
  elements.state.textContent = "Play mode failed to load.";
  console.error(error);
}
