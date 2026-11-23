import { installCutawayControls } from "../render/v1/cutaway-controls.mjs";

// Browser defaults are separate from the signed historical renderer modules.
export function installTruncateControls(container, renderer, options = {}) {
  installCutawayControls(container, renderer, options);
  container.querySelector(".cutaway-title").textContent = "Truncate";
  if (options.ghosts) {
    container.querySelector("#cutaway-opacity").defaultValue = "0";
    renderer.setCutaway({ opacity: 0 });
  }
}
