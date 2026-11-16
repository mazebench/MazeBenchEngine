const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/play.js"), "utf8");
const functions = [
  source.slice(source.indexOf("  function bindInput()"), source.indexOf("  function syncPlayHud()")),
  source.slice(source.indexOf("  function installPlayControls()"), source.indexOf("  function primeWorldStates()"))
].join("\n");

function target() {
  return { listeners: new Map(), addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener); this.listeners.set(type, list);
  }, emit(type, event) { for (const listener of this.listeners.get(type) || []) listener(event); } };
}

function harness(hosted) {
  const controls = target(), window = target(), commands = [];
  const button = { dataset: { move: "right" }, classList: { add() {}, remove() {} }, blur() {} };
  const pad = { dataset: { quadrantPad: "move" }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), querySelector: () => button };
  Object.assign(controls, { contains: () => true, setPointerCapture() {}, querySelectorAll: () => [] });
  Object.assign(window, { setInterval() {}, requestAnimationFrame: () => 1 });
  const app = { handleKeydown: () => commands.push("runtime-key"), handleKeyup() {}, preventScroll() {} };
  vm.runInNewContext(`${functions}\n installPlayControls(); bindInput();`, {
    playData: { hostOwnsPlayControls: hosted }, app, window, inputBound: false,
    document: { querySelector: () => controls, getElementById: () => null },
    cameraInputLocked: () => false, runMoveControl: () => commands.push("runtime-pointer"),
    syncPlayOverlayInputLock() {}, syncPlayHud() {}, performance: { now: () => 0 }
  });
  return { controls, window, commands, pointer: { target: { closest: () => pad }, clientX: 80, clientY: 50, pointerId: 1, preventDefault() {} } };
}

const standalone = harness(false);
standalone.controls.emit("pointerdown", standalone.pointer);
standalone.window.emit("keydown", {});
assert.deepEqual(standalone.commands, ["runtime-pointer", "runtime-key"]);

for (const engine of ["v1", "v1.1"]) {
  const hosted = harness(true);
  let actions = 0;
  const saveAwareHandler = () => { actions++; hosted.commands.push(`${engine}-host`); };
  hosted.controls.addEventListener("pointerdown", saveAwareHandler);
  hosted.window.addEventListener("keydown", saveAwareHandler);
  hosted.controls.emit("pointerdown", hosted.pointer);
  hosted.window.emit("keydown", {});
  assert.equal(actions, 2);
  assert.deepEqual(hosted.commands, [`${engine}-host`, `${engine}-host`]);
  assert.equal(hosted.controls.listeners.has("click"), false, "runtime must not also handle synthetic clicks or undo/reset");
}
console.log("hosted control ownership passed");
