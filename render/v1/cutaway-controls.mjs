import { stepCutawayHeight } from "./cutaway.mjs";

export function installCutawayControls(container, renderer, { ghosts = false, onChange } = {}) {
  container.innerHTML = `
    <label class="cutaway-title" for="cutaway-height">Cutaway</label>
    <output id="cutaway-readout" class="cutaway-readout" for="cutaway-height">Full</output>
    <input id="cutaway-height" class="cutaway-height" type="range" min="1" max="1" step="1" value="1"
      aria-label="Visible height" aria-orientation="vertical" aria-keyshortcuts="Shift+ArrowUp Shift+ArrowDown"
      title="Drag down to cut away upper layers · Shift+↑ / Shift+↓">
    <span id="cutaway-layer" class="cutaway-layer">All layers</span>
    <button id="cutaway-reset" class="cutaway-reset" type="button" title="Reveal all layers">Show all</button>
    <label class="cutaway-follow" title="Automatically cut upper layers above the player's current height">
      <input id="cutaway-follow-player" type="checkbox"><span>Only cut above player</span>
    </label>
    ${ghosts ? `<div class="cutaway-visibility">
      <label for="cutaway-opacity">Upper layers <output id="cutaway-opacity-readout" for="cutaway-opacity">20%</output></label>
      <input id="cutaway-opacity" type="range" min="0" max="100" step="5" value="20" aria-label="Upper layer visibility">
    </div>` : ""}`;
  const height = container.querySelector("#cutaway-height");
  const opacity = container.querySelector("#cutaway-opacity");
  const readout = container.querySelector("#cutaway-readout");
  const layer = container.querySelector("#cutaway-layer");
  const reset = container.querySelector("#cutaway-reset");
  const followPlayer = container.querySelector("#cutaway-follow-player");
  const opacityReadout = container.querySelector("#cutaway-opacity-readout");
  if (ghosts) renderer.setCutaway({ opacity: 0.2 });

  const sync = () => {
    const max = renderer.cutawayMaxHeight;
    const ceiling = renderer.cutawayHeight;
    const full = ceiling === null || ceiling >= max;
    const value = full ? max : Math.min(max, ceiling);
    height.max = String(max);
    height.value = String(value);
    height.disabled = max <= 1;
    height.setAttribute("aria-valuetext", full ? "All layers visible" : `Showing through Z ${value - 1}; ${max - value} upper layers cut away`);
    readout.textContent = full ? "Full" : `−${max - value}`;
    layer.textContent = full ? "All layers" : `Through Z ${value - 1}`;
    followPlayer.checked = renderer.cutaway.followPlayer;
    reset.disabled = ceiling === null && !renderer.cutaway.followPlayer;
    if (opacity) {
      opacity.value = String(Math.round(renderer.cutaway.opacity * 100));
      opacityReadout.textContent = `${opacity.value}%`;
      opacity.disabled = full;
    }
  };
  height.addEventListener("input", () => {
    const value = Number(height.value);
    renderer.setCutaway({ height: value >= renderer.cutawayMaxHeight ? null : value, followPlayer: false });
    onChange?.();
  });
  followPlayer.addEventListener("change", () => {
    renderer.setCutaway({ followPlayer: followPlayer.checked });
    onChange?.();
  });
  opacity?.addEventListener("input", () => renderer.setCutaway({ opacity: Number(opacity.value) / 100 }));
  reset.addEventListener("click", () => {
    renderer.setCutaway({ height: null, followPlayer: false });
    onChange?.();
  });
  // Capture before the player/camera handlers so a cutaway shortcut never moves
  // the board. Leave text fields, dialogs and the room-local ASCII view alone.
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey ||
        !["ArrowUp", "ArrowDown"].includes(event.key) || !container.getClientRects().length ||
        document.querySelector("dialog[open]")) return;
    const target = event.target;
    if (target.isContentEditable || (!container.contains(target) &&
        ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))) return;
    event.preventDefault();
    event.stopPropagation();
    renderer.setCutaway({
      height: stepCutawayHeight(renderer.cutawayHeight, renderer.cutawayMaxHeight, event.key === "ArrowUp" ? 1 : -1),
      followPlayer: false
    });
    onChange?.();
  }, { capture: true });
  // Arrow keys adjust the focused slider without moving the camera/player.
  container.addEventListener("keydown", (event) => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation();
  });
  renderer.onCutawayChange = sync;
  sync();
  container.hidden = false;
}
