import assert from "node:assert/strict";
import test from "node:test";
import { PlayGamepadInput, FlyoverGamepadInput, readPlayGamepad, installPlayGamepadControls } from "../ui/play-gamepad.mjs";
import { PlayWorldRenderer } from "../ui/play-world-renderer.mjs";
import { installGamepadPresentation } from "../ui/gamepad-presentation.mjs";

function pad(axes = [], pressed = [], index = 0) {
  return { connected: true, mapping: "standard", index, axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: Number(pressed.includes(i)) })) };
}

function fixture() {
  const moves = [], rotations = [], pitches = [], camera = [], feedback = [], statuses = [];
  let busy = false, ascii = false, ready = true;
  const callbacks = {
    isReady: () => ready, canMove: () => !busy, isAscii: () => ascii,
    onMove: move => moves.push(move), onRotate: turn => rotations.push(turn),
    onPitchStep: pitch => pitches.push(pitch), onCameraInput: input => camera.push(input),
    onFeedback: input => feedback.push(input), onStatus: status => statuses.push(status)
  };
  return { callbacks, moves, rotations, pitches, camera, feedback, statuses,
    setBusy(value) { busy = value; }, setAscii(value) { ascii = value; }, setReady(value) { ready = value; } };
}

test("standard controller mapping handles sticks, all D-pad buttons, triggers, drift, and diagonals", () => {
  assert.equal(Object.values(readPlayGamepad(pad([0.2, -0.25, 0.1, -0.2]))).some(Boolean), false);
  for (const [index, direction] of [[12, "up"], [13, "down"], [14, "left"], [15, "right"]]) {
    assert.equal(readPlayGamepad(pad([1, 0], [index])).move, direction);
  }
  for (const [axes, direction] of [[[0, -1], "up"], [[0, 1], "down"], [[-1, 0], "left"], [[1, 0], "right"]]) {
    assert.equal(readPlayGamepad(pad(axes)).move, direction);
  }
  assert.equal(readPlayGamepad(pad([0.8, -0.85]), "right").move, "right");
  assert.equal(readPlayGamepad(pad([0.8, -1]), "right").move, "up");
  assert.equal(readPlayGamepad(pad([0.4, 0])).move, null);
  assert.equal(readPlayGamepad(pad([0.4, 0]), "right").move, "right");
  assert.equal(readPlayGamepad(pad([0.2, 0]), "right").move, null);
  assert.equal(readPlayGamepad(pad([1, 0], [14, 15])).move, null);
  const camera = readPlayGamepad(pad([0, 0, -1, -1], [6]));
  assert.equal(camera.turn, -1);
  assert.equal(camera.yaw, -1);
  assert.equal(camera.tilt, 1);
  assert.equal(camera.zoom, -1);
  assert.equal(readPlayGamepad(pad([], [7])).zoom, 1);
  assert.equal(readPlayGamepad(pad([], [6, 7])).zoom, 0);
  assert.equal(readPlayGamepad({ ...pad(), mapping: "" }), null);
  assert.equal(readPlayGamepad({ ...pad(), connected: false }), null);
});

test("a D-pad tap moves once; held input repeats without queuing behind animation or sequence playback", () => {
  const f = fixture(), input = new PlayGamepadInput(f.callbacks), held = pad([], [15]);
  input.update(held, 0);
  input.update(held, 259);
  assert.deepEqual(f.moves, ["right"]);
  f.setBusy(true);
  for (let now = 260; now < 2000; now += 16) input.update(held, now);
  assert.deepEqual(f.moves, ["right"]);
  f.setBusy(false);
  input.update(held, 2000);
  input.update(held, 2129);
  input.update(held, 2130);
  assert.deepEqual(f.moves, ["right", "right", "right"]);
  input.update(pad(), 2140);
  input.update(pad(), 5000);
  assert.equal(f.moves.length, 3);
  input.update(pad([0, -1]), 5001);
  assert.equal(f.moves.at(-1), "up");
  // Releasing during a slow command must not leave any future movement behind.
  f.setBusy(true);
  input.update(held, 5002);
  input.update(pad(), 5500);
  f.setBusy(false);
  input.update(pad(), 6000);
  assert.equal(f.moves.length, 4);
});

test("stick holds get half the D-pad initial pause, then both repeat at the normal pace", () => {
  for (const [held, times] of [[pad([1, 0]), [0, 195, 325, 455]], [pad([], [15]), [0, 260, 390, 520]]]) {
    const f = fixture(), input = new PlayGamepadInput(f.callbacks), actual = [];
    for (let now = 0; now <= 520; now++) {
      const before = f.moves.length;
      input.update(held, now);
      if (f.moves.length > before) actual.push(now);
      if (actual.length === times.length) break;
    }
    assert.deepEqual(actual, times);
  }
});

test("switching between stick and D-pad in the same direction uses the new control's repeat delay", () => {
  const f = fixture(), input = new PlayGamepadInput(f.callbacks), stick = pad([1, 0]), dpad = pad([1, 0], [15]);
  input.update(stick, 0);
  input.update(dpad, 10);
  input.update(dpad, 269);
  assert.equal(f.moves.length, 2, "D-pad takes priority and starts its initial pause");
  input.update(dpad, 270);
  assert.equal(f.moves.length, 3);
  input.update(stick, 280);
  input.update(stick, 474);
  assert.equal(f.moves.length, 4);
  input.update(stick, 475);
  assert.equal(f.moves.length, 5, "returning to the stick starts its shorter initial pause");
});

test("right stick turns and tilts, with bounded repeats and discrete ASCII pitch", () => {
  const f = fixture(), input = new PlayGamepadInput(f.callbacks), held = pad([0, 0, 1, -1], [7]);
  input.update(held, 0);
  input.update(held, 449);
  assert.deepEqual(f.rotations, [1]);
  input.update(held, 450);
  assert.deepEqual(f.rotations, [1, 1]);
  assert.equal(f.camera.at(-1).tilt, 1);
  assert.equal(f.camera.at(-1).zoom, 1);
  f.setAscii(true);
  input.update(held, 500);
  input.update(held, 719);
  input.update(held, 720);
  assert.deepEqual(f.pitches, [-1, -1]);
  assert.deepEqual(f.camera.at(-1), { tilt: 0, zoom: 0 });
  input.update(null, 800);
  assert.deepEqual(f.feedback.at(-1), {});
  assert.deepEqual(f.camera.at(-1), { tilt: 0, zoom: 0 });
});

test("camera input stays independent of held keyboard and pointer controls", () => {
  const renderer = Object.create(PlayWorldRenderer.prototype);
  renderer.cameraMotion = { heldKeys: new Set(["w", "control:e"]), zoomAnimation: {} };
  renderer.scheduleCameraFrame = () => {};
  renderer.setGamepadCameraInput({ tilt: -0.4, zoom: -0.7 });
  assert.equal(renderer.cameraMotion.tiltDirection, 0.6);
  assert.ok(Math.abs(renderer.cameraMotion.zoomDirection - 0.3) < 1e-10);
  assert.equal(renderer.cameraMotion.zoomAnimation, null);
  renderer.setGamepadCameraInput({ tilt: 0, zoom: 0 });
  assert.equal(renderer.cameraMotion.tiltDirection, 1);
  assert.equal(renderer.cameraMotion.zoomDirection, 1);
  assert.deepEqual([...renderer.cameraMotion.heldKeys], ["w", "control:e"]);
});

test("each right-side face button undoes once per press, including while a move is busy", () => {
  const f = fixture();
  let undos = 0;
  f.callbacks.onUndo = () => undos++;
  const input = new PlayGamepadInput(f.callbacks);
  f.setBusy(true);
  for (let index = 0; index < 4; index++) {
    input.update(pad([], [index]), index * 2000);
    input.update(pad([], [index]), index * 2000 + 1000);
    input.reset();
    input.update(pad([], [index]), index * 2000 + 1100);
    assert.equal(undos, index + 1, "holds and focus resets do not repeat Undo");
    input.update(pad(), index * 2000 + 1200);
  }
  f.setBusy(false);
  input.update(pad([1, 0], [0]), 9000);
  assert.equal(f.moves.length, 0, "Undo takes priority over a held movement stick");
  input.update(pad([1, 0], [0, 1]), 9100);
  assert.equal(undos, 6, "a different newly pressed face button also undoes");
  input.reset(pad([], [2]));
  input.update(pad([], [2]), 9200);
  assert.equal(undos, 6, "a button held while typing cannot undo when typing ends");
});

test("Flyover uses analog pan and free rotation with the same trigger mapping", () => {
  const f = fixture(), input = new FlyoverGamepadInput(f.callbacks);
  input.update(pad([0.7, -0.8, 0.6, -0.9], [6]));
  const camera = f.camera.at(-1);
  for (const key of ["panHorizontal", "panForward", "yaw", "tilt"]) {
    assert.ok(camera[key] > 0 && camera[key] < 1, key);
  }
  assert.equal(camera.zoom, -1);
  assert.deepEqual(f.rotations, [], "Flyover does not issue cardinal turns");
  assert.deepEqual(f.moves, [], "Flyover does not issue game moves");
  input.update(pad([1, 0], [12, 14, 7]));
  assert.equal(f.camera.at(-1).panHorizontal, -1);
  assert.equal(f.camera.at(-1).panForward, 1);
  assert.equal(f.camera.at(-1).zoom, 1);
  input.reset();
  assert.equal(Object.values(f.camera.at(-1)).some(Boolean), false);
});

test("browser polling handles late connection, text focus, blur, disconnect, and disposal", () => {
  const f = fixture(), window = new EventTarget(), document = new EventTarget();
  let pads = [], focused = true, frames = new Map(), id = 0;
  const classes = new Set();
  document.body = { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } };
  const presentation = installGamepadPresentation({ window, document });
  Object.assign(f.callbacks, presentation);
  Object.assign(window, {
    requestAnimationFrame(callback) { frames.set(++id, callback); return id; },
    cancelAnimationFrame(key) { frames.delete(key); }
  });
  Object.assign(document, { hidden: false, hasFocus: () => focused, activeElement: null });
  const advance = now => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)); };
  const dispose = installPlayGamepadControls(f.callbacks, { window, document, navigator: { getGamepads: () => pads } });
  advance(0);
  assert.equal(frames.size, 0, "no idle RAF loop without a connected controller");
  pads = [null, pad([1, 0, 0, -1], [7], 1)];
  window.dispatchEvent(new Event("gamepadconnected"));
  advance(1);
  assert.deepEqual(f.moves, ["right"]);
  assert.equal(classes.has("is-controller-active"), true);
  window.dispatchEvent(new Event("pointerdown"));
  advance(10);
  assert.equal(classes.has("is-controller-active"), false, "held input cannot re-hide UI after a click");
  pads = [pad([], [], 1)];
  advance(15);
  pads = [pad([1, 0], [], 1)];
  advance(20);
  assert.equal(classes.has("is-controller-active"), true, "a fresh controller gesture hides UI again");
  window.dispatchEvent(new Event("keydown"));
  advance(25);
  assert.equal(classes.has("is-controller-active"), false);
  const movesBeforeEditing = f.moves.length;
  document.activeElement = { isContentEditable: true };
  document.dispatchEvent(new Event("focusin"));
  advance(1000);
  assert.equal(f.moves.length, movesBeforeEditing);
  assert.deepEqual(f.camera.at(-1), { tilt: 0, zoom: 0 });
  document.activeElement = null;
  focused = false;
  window.dispatchEvent(new Event("blur"));
  advance(2000);
  assert.equal(frames.size, 0);
  assert.equal(f.moves.length, movesBeforeEditing);
  focused = true;
  window.dispatchEvent(new Event("focus"));
  advance(2001);
  assert.equal(f.moves.length, movesBeforeEditing + 1);
  pads = [];
  window.dispatchEvent(new Event("gamepaddisconnected"));
  advance(3000);
  assert.equal(frames.size, 0);
  assert.deepEqual(f.feedback.at(-1), {});
  assert.deepEqual(f.camera.at(-1), { tilt: 0, zoom: 0 });
  dispose();
  presentation.dispose();
  pads = [pad([1, 0])];
  window.dispatchEvent(new Event("gamepadconnected"));
  advance(4000);
  assert.equal(frames.size, 0);
  assert.equal(f.moves.length, movesBeforeEditing + 1);
});

test("45-degree holds keep one direction in every quadrant, at the existing repeat cadence", () => {
  for (const x of [-1, 1]) for (const y of [-1, 1]) {
    const f = fixture(), input = new PlayGamepadInput(f.callbacks);
    const held = pad([x * .8, y * .8]);
    const vertical = y < 0 ? "up" : "down";
    input.update(held, 0);
    for (let now = 1; now < 195; now++) input.update(held, now);
    assert.deepEqual(f.moves, [vertical], "polling cannot bypass the repeat delay");
    for (let now = 195; now <= 715; now += 130) input.update(held, now);
    assert.deepEqual(f.moves, Array(6).fill(vertical));
    assert.equal(f.feedback.at(-1).move, vertical);
  }
});

const anglePad = degrees => pad([Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)]);

test("off-centre joystick holds choose the stronger axis at every angle", () => {
  for (const [angle, direction] of [[0, "right"], [90, "down"], [180, "left"], [270, "up"]]) {
    for (const offset of [-40, -30, -15, 0, 15, 30, 40]) {
      const f = fixture(), input = new PlayGamepadInput(f.callbacks), held = anglePad(angle + offset);
      for (let now = 0; now < 2000; now += 300) input.update(held, now);
      assert(f.moves.every(move => move === direction), `${angle + offset} degrees snaps to ${direction}`);
    }
  }
});

test("joystick direction remains stable near diagonals and switches when the other axis is clearly stronger", () => {
  const f = fixture(), input = new PlayGamepadInput(f.callbacks);
  input.update(pad([1, -.8]), 0);
  input.update(pad([.8, -.85]), 195);
  input.update(pad([.8, -.8]), 325);
  assert.deepEqual(f.moves, ["right", "right", "right"]);
  input.update(pad([.8, -1]), 455);
  input.update(pad([.85, -.8]), 650);
  assert.deepEqual(f.moves, ["right", "right", "right", "up", "up"]);
});

test("joystick movement waits for playback, works in ASCII, and resets on release or disconnect", () => {
  const f = fixture(), input = new PlayGamepadInput(f.callbacks), held = pad([.8, -.8]);
  f.setAscii(true);
  input.update(held, 0);
  f.setBusy(true);
  for (let now = 260; now < 2000; now += 16) input.update(held, now);
  assert.deepEqual(f.moves, ["up"]);
  f.setBusy(false);
  input.update(held, 2000);
  input.update(held, 2130);
  assert.deepEqual(f.moves, ["up", "up", "up"]);
  input.update(pad(), 2200);
  input.update(held, 2201);
  assert.equal(f.moves.at(-1), "up");
  input.update(null, 2300);
  input.update(held, 2400);
  assert.equal(f.moves.at(-1), "up");
  input.update(pad([.8, -.8], [0]), 2700);
  const count = f.moves.length;
  input.update(pad([.8, -.8], [0]), 3000);
  assert.equal(f.moves.length, count, "Undo suppresses a held joystick");
});
