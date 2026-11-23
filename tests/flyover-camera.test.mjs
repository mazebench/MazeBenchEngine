import assert from "node:assert/strict";
import test from "node:test";
import { FlyoverRenderer } from "../ui/flyover-renderer.mjs";
import { installFlyoverControls } from "../ui/flyover-controls.mjs";

function fixture() {
  const renderer = Object.create(FlyoverRenderer.prototype);
  const canvas = new EventTarget(), window = new EventTarget(), document = new EventTarget();
  const captures = new Set(), selections = [];
  Object.assign(canvas, {
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id)
  });
  Object.assign(renderer, {
    canvas, yaw: 0, heading: 0, pitch: 0.72, mode: "world", pointer: null,
    cameraMotion: { frameId: 0, lastMs: 0, heldKeys: new Set() },
    render() {}, scheduleCameraFrame() {}, hitTest: () => ({ room: "AxA" }),
    onSelect: hit => selections.push(hit), centerBoard() {}
  });
  const dispose = installFlyoverControls(renderer, { window, document });
  const emit = (target, type, props = {}) => {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
  };
  const pointer = (type, x, y, extra = {}) => emit(canvas, type, { pointerId: 1, button: 0, clientX: x, clientY: y, ...extra });
  return { renderer, canvas, window, document, selections, captures, emit, pointer, dispose };
}

test("Flyover dragging rotates by arbitrary angles, preserves pitch limits, and never snaps on release", () => {
  const f = fixture(), { renderer } = f;
  f.pointer("pointerdown", 100, 100);
  f.pointer("pointermove", 125, 120);
  const yaw = renderer.yaw;
  assert.ok(Math.abs(yaw - (Math.PI * 2 - 0.15)) < 1e-10);
  assert.ok(Math.abs(renderer.pitch - 0.8) < 1e-10);
  f.pointer("pointerup", 125, 120);
  assert.equal(renderer.yaw, yaw);
  assert.equal(f.selections.length, 0);
  assert.equal(f.captures.size, 0);
  f.pointer("pointerdown", 10, 10);
  f.pointer("pointermove", 10, 10000);
  assert.equal(renderer.pitch, renderer.clampPitch(100));
  f.pointer("pointercancel", 10, 10000);
  assert.equal(f.selections.length, 0);
  f.dispose();
});

test("room clicks still select, while cumulative small drags and cancelled capture do not", () => {
  const f = fixture();
  f.pointer("pointerdown", 100, 100);
  f.pointer("pointerup", 100, 100);
  assert.equal(f.selections.length, 1);
  f.pointer("pointerdown", 100, 100);
  for (let x = 101; x <= 110; x++) f.pointer("pointermove", x, 100);
  f.pointer("pointerup", 110, 100);
  assert.equal(f.selections.length, 1);
  f.pointer("pointerdown", 100, 100);
  f.pointer("lostpointercapture", 100, 100);
  assert.equal(f.renderer.pointer, null);
  assert.equal(f.selections.length, 1);
  f.dispose();
});

test("keyboard and button holds turn continuously and settle at a non-cardinal angle", () => {
  const f = fixture(), { renderer } = f;
  f.emit(f.window, "keydown", { key: "d" });
  for (let now = 16; now <= 160; now += 16) renderer.runCameraFrame(now);
  assert.ok(renderer.yaw > 0 && renderer.yaw < Math.PI / 2);
  f.emit(f.window, "keyup", { key: "d" });
  for (let now = 176; now <= 800; now += 16) renderer.runCameraFrame(now);
  const settled = renderer.yaw;
  assert.ok(settled > 0 && settled < Math.PI / 2);
  assert.equal(renderer.cameraMotion.yawVelocity, 0);
  renderer.runCameraFrame(900);
  assert.equal(renderer.yaw, settled);
  renderer.setCameraControl("a", true);
  for (let now = 916; now <= 1000; now += 16) renderer.runCameraFrame(now);
  assert.ok(renderer.yaw < settled);
  renderer.setCameraControl("a", false);
  f.emit(f.window, "blur");
  assert.equal(renderer.cameraMotion.yawVelocity, 0);
  assert.equal(renderer.cameraMotion.yawDirection, 0);
  assert.equal(renderer.cameraMotion.heldKeys.size, 0);
  f.dispose();
});

test("typing and hidden pages cannot keep the Flyover camera turning", () => {
  const f = fixture();
  f.emit(f.window, "keydown", { key: "a", target: { isContentEditable: true } });
  assert.equal(f.renderer.cameraMotion.heldKeys.size, 0);
  f.emit(f.window, "keydown", { key: "a" });
  f.renderer.runCameraFrame(16);
  f.document.hidden = true;
  f.emit(f.document, "visibilitychange");
  assert.equal(f.renderer.cameraMotion.yawVelocity, 0);
  assert.equal(f.renderer.cameraMotion.heldKeys.size, 0);
  f.dispose();
  f.emit(f.window, "keydown", { key: "d" });
  assert.equal(f.renderer.cameraMotion.heldKeys.size, 0);
});

test("Flyover combines analog controller motion with keyboard input without taking over key holds", () => {
  const f = fixture(), { renderer } = f;
  renderer.cameraMotion.heldKeys.add("d");
  renderer.cameraMotion.heldKeys.add("arrowright");
  renderer.setGamepadCameraInput({ yaw: -0.4, panHorizontal: -0.25, panForward: 0.6, tilt: 0.5, zoom: -0.8 });
  assert.equal(renderer.cameraMotion.yawDirection, 0.6);
  assert.equal(renderer.cameraMotion.panHorizontal, 0.75);
  assert.equal(renderer.cameraMotion.panForward, 0.6);
  assert.equal(renderer.cameraMotion.tiltDirection, 0.5);
  assert.equal(renderer.cameraMotion.zoomDirection, -0.8);
  renderer.setGamepadCameraInput({});
  assert.equal(renderer.cameraMotion.yawDirection, 1);
  assert.equal(renderer.cameraMotion.panHorizontal, 1);
  assert.equal(renderer.cameraMotion.tiltDirection, 0);
  assert.equal(renderer.cameraMotion.zoomDirection, 0);
  f.dispose();
});
