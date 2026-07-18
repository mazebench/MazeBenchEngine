const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "public", "flyover.js"), "utf8");
const pages = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");
const theme = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");
const runtimeTheme = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

for (const id of [
  "flyover-tilt-up",
  "flyover-rotate-left",
  "flyover-rotate-right",
  "flyover-tilt-down",
  "flyover-zoom-out",
  "flyover-zoom-in",
  "flyover-move-forward",
  "flyover-move-left",
  "flyover-move-right",
  "flyover-move-backward"
]) {
  assert.match(pages, new RegExp(`id=["']${id}["']`), `flyover page is missing #${id}`);
}

assert.match(pages, /class="camera-pad control-pad flyover-pad flyover-pad--camera"/);
assert.match(pages, /class="control-pad flyover-pad flyover-pad--move"/);
assert.match(pages, /class="control-button dpad-button flyover-pad-button"/);
assert.match(pages, /class="dpad-center flyover-pad-center"/);
assert.match(pages, /class="flyover-loading" role="status"/);
assert.match(pages, />Loading world<\/span>/);
assert.match(pages, /id="flyover-edge-toggle"/);
assert.match(pages, /<circle cx="11" cy="11" r="8"><\/circle>/);
assert.match(pages, /<line x1="11" x2="11" y1="8" y2="14"><\/line>/);
assert.match(pages, /<path d="M7 12h10"><\/path>/);
assert.match(source, /forwardEnabled: false/);
assert.match(source, /app\.homeVectorTheme = true/);
assert.match(source, /app\.vectorGlowAmount = 1/);
assert.match(source, /primeHomeEdgeReveal/);
assert.match(source, /beginHomeEdgeReveal/);
assert.match(source, /function revealLoadedFlyoverWorld/);
assert.match(source, /function setFlyoverEdgeMode/);
assert.match(source, /setFlyoverEdgeMode\(false, \{ durationMs: 950 \}\)/);
assert.match(source, /setFlyoverEdgeMode\(!edgeModeEnabled\)/);
assert.match(source, /function bindFlightHoldButton/);
assert.match(source, /bindFlightHoldButton\("flyover-move-forward", "forward"\)/);
assert.match(source, /bindFlightHoldButton\("flyover-move-backward", "backward"\)/);
assert.match(source, /bindFlightHoldButton\("flyover-move-left", "left"\)/);
assert.match(source, /bindFlightHoldButton\("flyover-move-right", "right"\)/);
assert.match(theme, /\.flyover-controls/);
assert.match(theme, /\.flyover-loading__spinner/);
assert.match(theme, /\.flyover-zoom-controls/);
assert.match(theme, /border-color: var\(--cyan/);
assert.match(theme, /\.flyover-body \.flyover-stage::after \{\s*content: none;/);
assert.doesNotMatch(theme, /\.flyover-pad-button::before/);
const selectionStart = runtimeTheme.indexOf(".flyover-selection-panel {");
const selectionEnd = runtimeTheme.indexOf(".flyover-minimap__cell", selectionStart);
const selectionTheme = runtimeTheme.slice(selectionStart, selectionEnd);
assert.notEqual(selectionStart, -1);
assert.notEqual(selectionEnd, -1);
assert.match(selectionTheme, /background: rgba\(5, 8, 18, 0\.94\)/);
assert.match(selectionTheme, /border: 1px solid rgba\(84, 240, 255, 0\.52\)/);
assert.match(selectionTheme, /transform: translateX\(-50%\)/);
assert.match(selectionTheme, /@keyframes flyover-selection-enter/);
assert.doesNotMatch(selectionTheme, /#fff8df|border: 4px solid #000000|var\(--pg-shadow/);

console.log("flyover-source: OK — blue vector reveal and manual camera/flight controls are wired.");
