// Browser entry point; keep play/v1/main.mjs unchanged for signed historical runs.
import { loadMazeBenchEngineV1 } from "../engine/current/engine.mjs";
import { AsciiMazeRendererV2 } from "../render-ascii/v2/ascii-renderer.mjs";
import { createPlayWorldContext } from "./play-world-context.mjs";
import { PlayWorldRenderer } from "./play-world-renderer.mjs";
import { installTruncateControls } from "./truncate-controls.mjs";
import { loadBrowserWorld, updateLoadProgress, paintLoadProgress } from "./browser-world.mjs";
import { bindCameraHold } from "../render/v1/camera-controls.mjs";
import { cameraRelativeMoveDirection } from "../play/v1/camera-relative-input.mjs";
import { ConnectedWorldSessionV1 } from "../play/current/connected-world-session.mjs";
import { PlaySessionV1 } from "../play/current/play-session.mjs";
import { DEFAULT_STEP_MS } from "../animations/v1/timeline.mjs";
import { animateAsciiCommand } from "../animations/v1/ascii-playback.mjs";
import { installRoomControlsV1 } from "../play/v1/room-controls.mjs";
import { MoveSequencePlayer, parseMoveSequence } from "./move-sequence.mjs";
import { installPlayGamepadControls } from "./play-gamepad.mjs";
import { installGamepadPresentation } from "./gamepad-presentation.mjs";

const elements = {
  stage: document.getElementById("stage"),
  canvas: document.getElementById("play-canvas"),
  asciiView: document.getElementById("ascii-view"),
  asciiBoard: document.getElementById("ascii-board"),
  asciiCamera: document.getElementById("ascii-camera"),
  asciiSeed: document.getElementById("ascii-seed"),
  seededGlyphs: document.getElementById("seeded-glyphs"),
  zoomControls: document.getElementById("zoom-controls"),
  loading: document.getElementById("loading"),
  loadProgress: document.getElementById("load-progress"),
  roomName: document.getElementById("room-name"),
  roomGrid: document.getElementById("room-grid"),
  gemCount: document.getElementById("gem-count"),
  state: document.getElementById("play-state"),
  motionTweens: document.getElementById("motion-tweens"),
  animationRate: document.getElementById("animation-rate"),
  sequenceInput: document.getElementById("move-sequence"),
  sequenceRun: document.getElementById("run-sequence"),
  sequenceStop: document.getElementById("stop-sequence"),
  sequenceStatus: document.getElementById("sequence-status"),
  roomMoves: document.getElementById("room-moves"),
  roomMovesCopy: document.getElementById("copy-room-moves"),
  roomMovesStatus: document.getElementById("room-moves-status"),
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
let roomWorld;
let viewMode = "3d";
let asciiPitch = 1;
let lastAsciiPitchStep = 0;
const sequencePlayer = new MoveSequencePlayer(() => session, ({ message }) => {
  elements.sequenceStatus.textContent = message;
  updateSequenceControls();
});

function updateSequenceControls() {
  elements.sequenceInput.disabled = sequencePlayer.running;
  elements.sequenceRun.disabled = sequencePlayer.running || !session?.state || session.running || session.playerCount < 1 || !elements.sequenceInput.value.trim();
  elements.sequenceStop.disabled = !sequencePlayer.running || Boolean(sequencePlayer.reason);
  elements.directionButtons.forEach(button => {
    button.disabled = sequencePlayer.running || !session?.state || session.playerCount < 1;
  });
}

function resetPlay() { sequencePlayer.stop("Stopped: room reset"); session?.reset(); }
function undoPlay() { sequencePlayer.stop("Stopped: move undone"); session?.undo(); }

const initialParams = new URL(location.href).searchParams;
let savedTweens = true;
try { savedTweens = localStorage.getItem("mazebench.motionTweens") !== "off"; } catch { /* Storage may be unavailable. */ }
let tweensEnabled = initialParams.has("tweens") ? initialParams.get("tweens") !== "off"
  : initialParams.get("instantAnimations") === "1" || initialParams.get("animationMs") === "0" ? false : savedTweens;
let animationDelayMs = tweensEnabled ? DEFAULT_STEP_MS : 0;

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

function showFrame(state, room, { preserveCameraPosition = false } = {}) {
  const renderedRoom = engine.roomFromState(state, room);
  if (viewMode === "3d") renderer.setWorld(roomWorld(room, renderedRoom), {
    preserveCamera: true, preserveCameraPosition,
    animateCamera: animationDelayMs > 0
  });
  if (viewMode === "ascii") asciiRenderer.setRoom(renderedRoom);
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
  if (sequencePlayer.running) return;
  const worldDirection = cameraRelativeMoveDirection(direction, renderer?.heading || 0);
  if (worldDirection) return session?.move(worldDirection);
}

function setViewMode(mode) {
  cancelCameraButtons.forEach((cancel) => cancel());
  renderer?.cancelCameraMotion();
  const previousMode = viewMode;
  viewMode = mode === "ascii" ? "ascii" : "3d";
  const ascii = viewMode === "ascii";
  renderer?.setGemMotionEnabled(!ascii && tweensEnabled);
  elements.asciiView.hidden = !ascii;
  elements.stage.classList.toggle("is-ascii", ascii);
  elements.stage.dataset.viewMode = viewMode;
  elements.viewLabel.textContent = ascii ? "3D" : "ASCII";
  elements.viewToggle.setAttribute("aria-pressed", String(ascii));
  elements.zoomControls.hidden = ascii;
  if (!ascii && previousMode === "ascii" && session?.state) showFrame(session.state, session.room);
  if (ascii) {
    if (previousMode !== "ascii" && session?.state) asciiRenderer.setRoom(engine.roomFromState(session.state, session.room));
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
  if (elements.roomMoves.value !== summary.roomMoves) {
    elements.roomMoves.value = summary.roomMoves;
    elements.roomMoves.scrollTop = elements.roomMoves.scrollHeight;
    elements.roomMovesStatus.textContent = "";
  }
  elements.roomMovesCopy.disabled = !summary.roomMoves;
  elements.directionButtons.forEach((button) => {
    button.disabled = !summary.playerActive;
  });
  elements.undo.disabled = !summary.canUndo;
  if (summary.error) elements.state.textContent = summary.error;
  else if (!summary.playerActive) elements.state.textContent = "Player fell out of the room.";
  else if (summary.cycle) elements.state.textContent = "Cycle detected; command rolled back.";
  else elements.state.textContent = "";
  elements.state.hidden = !elements.state.textContent;
  if (summary.error) sequencePlayer.stop(summary.error, true);
  updateSequenceControls();
}

function updateAnimationSettings({ persist = true } = {}) {
  tweensEnabled = elements.motionTweens.checked;
  animationDelayMs = tweensEnabled ? DEFAULT_STEP_MS : 0;
  elements.animationRate.textContent = tweensEnabled
    ? "Steps 100 ms · Slides 40 ms/tile · Rooms 250 ms" : "Instant moves";
  session?.setFrameDelay(animationDelayMs);
  renderer?.setGemMotionEnabled(viewMode === "3d" && tweensEnabled);
  if (!tweensEnabled) renderer?.finishRoomTransition();
  if (!persist) return;
  try { localStorage.setItem("mazebench.motionTweens", tweensEnabled ? "on" : "off"); } catch { /* Keep the in-memory preference. */ }
  const url = new URL(location.href);
  if (tweensEnabled) url.searchParams.delete("tweens");
  else url.searchParams.set("tweens", "off");
  url.searchParams.delete("animationMs");
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
  sequencePlayer.stop("Stopped: room changed");
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

const gamepadButtons = {
  turnLeft: document.getElementById("rotate-left"),
  turnRight: document.getElementById("rotate-right"),
  tiltUp: document.getElementById("tilt-up"),
  tiltDown: document.getElementById("tilt-down"),
  zoomIn: document.getElementById("zoom-in"),
  zoomOut: document.getElementById("zoom-out"),
  undo: elements.undo
};
installPlayGamepadControls({
  ...installGamepadPresentation(),
  isReady: () => Boolean(session && renderer && elements.stage.classList.contains("is-ready")),
  canMove: () => !sequencePlayer.running && Boolean(session?.state) && !session.running
    && !session.queue.length && !elements.directionButtons[0].disabled,
  isAscii: () => viewMode === "ascii",
  onMove: moveFromCamera,
  onUndo: undoPlay,
  onRotate: rotateCamera,
  onPitchStep: step => setAsciiPitch(asciiPitch + step),
  onCameraInput: input => renderer?.setGamepadCameraInput(input),
  onStatus: text => { document.getElementById("controller-status").textContent = text; },
  onFeedback: ({ move, turn, tilt, zoom, undoButtons }) => {
    for (const button of elements.directionButtons) {
      button.classList.toggle("is-gamepad-active", !button.disabled && button.dataset.direction === move);
    }
    const active = { turnLeft: turn < 0, turnRight: turn > 0, tiltUp: tilt > 0,
      tiltDown: tilt < 0, zoomIn: zoom < 0, zoomOut: zoom > 0, undo: Boolean(undoButtons) && !elements.undo.disabled };
    for (const [name, button] of Object.entries(gamepadButtons)) {
      button.classList.toggle("is-gamepad-active", active[name]);
    }
  }
});

elements.viewToggle.addEventListener("click", toggleViewMode);
elements.reset.addEventListener("click", resetPlay);
elements.undo.addEventListener("click", undoPlay);
elements.sequenceInput.addEventListener("input", () => {
  try {
    const moves = parseMoveSequence(elements.sequenceInput.value);
    elements.sequenceStatus.textContent = `${moves.length} moves ready.`;
  } catch (error) {
    elements.sequenceStatus.textContent = elements.sequenceInput.value.trim() ? error.message : "";
  }
  updateSequenceControls();
});
elements.sequenceRun.addEventListener("click", async () => {
  try { await sequencePlayer.run(elements.sequenceInput.value); }
  catch (error) { elements.sequenceStatus.textContent = error.message; }
});
elements.sequenceStop.addEventListener("click", () => sequencePlayer.stop());
elements.roomMovesCopy.addEventListener("click", async () => {
  const text = elements.roomMoves.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (elements.roomMoves.value === text) elements.roomMovesStatus.textContent = "Copied";
  } catch {
    elements.roomMoves.focus();
    elements.roomMoves.select();
    elements.roomMovesStatus.textContent = "Select and copy the moves above.";
  }
});
elements.seededGlyphs.addEventListener("change", updateSeedOptions);
elements.asciiSeed.addEventListener("change", updateSeedOptions);
elements.motionTweens.checked = tweensEnabled;
elements.motionTweens.addEventListener("change", updateAnimationSettings);
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
    if (key === "r") resetPlay();
    else undoPlay();
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
    loadBrowserWorld((complete, total, phase) => updateLoadProgress(elements.loadProgress, complete, total, phase)),
    loadMazeBenchEngineV1()
  ]);
  markCurrentRoom = installRoomControlsV1(
    world,
    elements.roomGrid,
    openRoom
  );
  const requested = new URL(location.href).searchParams.get("room")?.toUpperCase() || "HXI";
  currentRoom = world.rooms.find((room) => room.position.join("X") === requested) || world.rooms[0];
  roomWorld = createPlayWorldContext(world);
  updateLoadProgress(elements.loadProgress, 85, 100, "Drawing room");
  await paintLoadProgress();
  renderer = new PlayWorldRenderer(elements.canvas, roomWorld(currentRoom), { mode: "play" });
  installTruncateControls(document.getElementById("cutaway-controls"), renderer, { ghosts: true });
  const params = new URL(location.href).searchParams;
  elements.seededGlyphs.checked = params.get("seededGlyphs") === "1";
  elements.asciiSeed.value = params.get("asciiSeed") || "1";
  asciiRenderer = new AsciiMazeRendererV2(
    elements.asciiBoard,
    null,
    world.blockDefinitions,
    {
      hideNames: elements.seededGlyphs.checked,
      hideNamesSeed: elements.asciiSeed.value
    }
  );
  updateSeedOptions({ persist: false });
  connectedWorld = new ConnectedWorldSessionV1(engine, world.blocks, world.rooms, { presentation: true });
  session = new PlaySessionV1(engine, world.blocks, {
    onFrame: showFrame,
    onChange: updateSession,
    onRoomChange: activateRoom,
    capturePresentation: () => renderer.capturePresentation(),
    animateReset: reset => viewMode === "3d"
      ? renderer.animateReset(reset, { finish: () => viewMode !== "3d" || session.frameDelay === 0 || document.hidden })
      : false,
    animateCommand: command => viewMode === "3d"
      ? renderer.animateCommand(command, { finish: () => viewMode !== "3d" || session.frameDelay === 0 || document.hidden })
      : animateAsciiCommand(command, { definitions: world.blockDefinitions,
        finish: () => viewMode !== "ascii" || session.frameDelay === 0 || document.hidden }),
    resolveCommand: (state, room, direction) =>
      connectedWorld.simulateCommand(state, room, direction),
    frameDelay: animationDelayMs
  });
  new ResizeObserver(() => renderer.resize()).observe(elements.canvas.parentElement);
  openRoom(currentRoom);
  setViewMode("3d");
  elements.viewToggle.disabled = false;
  elements.reset.disabled = false;
  await paintLoadProgress();
  elements.loadProgress.value = elements.loadProgress.max;
  elements.stage.classList.add("is-ready");
} catch (error) {
  elements.loading.textContent = error?.message || "Play mode failed to load.";
  elements.loading.classList.add("is-error");
  elements.loading.setAttribute("role", "alert");
  elements.state.textContent = "Play mode failed to load.";
  console.error(error);
}
