// Browser-standard mapping: https://www.w3.org/TR/gamepad/#remapping
const DEAD_ZONE = 0.28;
const MOVE_THRESHOLD = 0.5;
const RELEASE_THRESHOLD = 0.35;
const MOVE_REPEAT_MS = 130;
const FIRST_REPEAT_PAUSE_MS = 130;

function axis(pad, index) {
  const value = pad.axes?.[index];
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

function button(pad, index) {
  const value = pad.buttons?.[index];
  return Math.max(0, Math.min(1, Number(value?.value) || Number(value?.pressed) || 0));
}

function analog(value) {
  return Math.abs(value) <= DEAD_ZONE ? 0
    : Math.sign(value) * (Math.abs(value) - DEAD_ZONE) / (1 - DEAD_ZONE);
}

function direction(x, y, previous) {
  if (!x && !y) return null;
  // Keep diagonals stable until the other axis is clearly stronger.
  const horizontal = previous === "left" || previous === "right";
  const vertical = previous === "up" || previous === "down";
  const useX = horizontal && x && Math.abs(x) >= Math.abs(y) - 0.12
    || !(vertical && y && Math.abs(y) >= Math.abs(x) - 0.12) && Math.abs(x) > Math.abs(y);
  return useX ? (x < 0 ? "left" : "right") : (y < 0 ? "up" : "down");
}

export function readPlayGamepad(pad, previousMove = null) {
  if (!pad || pad.connected === false || pad.mapping !== "standard") return null;
  const dpad = [12, 13, 14, 15].map(index => button(pad, index) >= 0.5);
  const dpadActive = dpad.some(Boolean);
  const threshold = previousMove ? RELEASE_THRESHOLD : MOVE_THRESHOLD;
  const x = axis(pad, 0), y = axis(pad, 1);
  const move = dpadActive
    ? direction(Number(dpad[3]) - Number(dpad[2]), Number(dpad[1]) - Number(dpad[0]), previousMove)
    : Math.max(Math.abs(x), Math.abs(y)) >= threshold ? direction(x, y, previousMove) : null;
  return {
    move,
    moveSource: move ? (dpadActive ? "dpad" : "stick") : null,
    turn: Math.abs(axis(pad, 2)) >= 0.55 ? Math.sign(axis(pad, 2)) : 0,
    yaw: analog(axis(pad, 2)),
    panHorizontal: dpadActive ? Number(dpad[3]) - Number(dpad[2]) : analog(x),
    panForward: dpadActive ? Number(dpad[0]) - Number(dpad[1]) : -analog(y),
    tilt: -analog(axis(pad, 3)),
    // Left trigger (ZL/L2/LT) zooms in; right trigger (ZR/R2/RT) zooms out.
    zoom: analog(button(pad, 7)) - analog(button(pad, 6)),
    undoButtons: [0, 1, 2, 3].reduce((mask, index) => mask | (button(pad, index) >= 0.5 ? 1 << index : 0), 0)
  };
}

// One movement command at a time; never enqueue repeats behind an animation.
export class PlayGamepadInput {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.reset();
  }

  reset(pad) {
    this.move = null;
    this.moveKey = "";
    this.moved = false;
    this.turn = 0;
    this.pitchStep = 0;
    // Preserve edge detection across mouse/focus changes; held buttons aren't new presses.
    this.undoButtons = pad === undefined ? this.undoButtons || 0 : readPlayGamepad(pad)?.undoButtons || 0;
    this.nextMove = this.nextTurn = this.nextPitch = 0;
    this.callbacks.onCameraInput({ tilt: 0, zoom: 0 });
    this.callbacks.onFeedback?.({});
  }

  update(pad, now) {
    const input = readPlayGamepad(pad, this.move);
    if (!input) { this.reset(null); return; }
    const undoPressed = input.undoButtons & ~this.undoButtons;
    this.undoButtons = input.undoButtons;
    if (undoPressed) this.callbacks.onUndo?.();
    // A held movement stick must not immediately redo the move being undone.
    const move = input.undoButtons ? null : input.move;
    const moveKey = move ? `${input.moveSource}:${move}` : "";
    if (moveKey !== this.moveKey) {
      this.moveKey = moveKey;
      this.move = move;
      this.moved = false;
      this.nextMove = now;
    }
    if (this.move && now >= this.nextMove && this.callbacks.canMove()) {
      this.callbacks.onMove(this.move);
      // The stick gets half the D-pad's extra pause before the second step.
      const firstPause = this.moved ? 0
        : FIRST_REPEAT_PAUSE_MS * (input.moveSource === "dpad" ? 1 : 0.5);
      this.nextMove = now + MOVE_REPEAT_MS + firstPause;
      this.moved = true;
    }
    if (input.turn !== this.turn) { this.turn = input.turn; this.nextTurn = now; }
    if (this.turn && now >= this.nextTurn) {
      this.callbacks.onRotate(this.turn);
      this.nextTurn = now + 450;
    }
    const ascii = this.callbacks.isAscii();
    const pitchStep = ascii ? -Math.sign(input.tilt) : 0;
    if (pitchStep !== this.pitchStep) { this.pitchStep = pitchStep; this.nextPitch = now; }
    if (pitchStep && now >= this.nextPitch) {
      this.callbacks.onPitchStep(pitchStep);
      this.nextPitch = now + 220;
    }
    this.callbacks.onCameraInput(ascii ? { tilt: 0, zoom: 0 } : input);
    this.callbacks.onFeedback?.({ ...input, move: this.move, zoom: ascii ? 0 : input.zoom });
  }
}

export class FlyoverGamepadInput {
  constructor(callbacks) { this.callbacks = callbacks; this.reset(); }

  reset() {
    this.callbacks.onCameraInput({ yaw: 0, tilt: 0, zoom: 0, panHorizontal: 0, panForward: 0 });
    this.callbacks.onFeedback?.({});
  }

  update(pad) {
    const input = readPlayGamepad(pad);
    if (!input) { this.reset(); return; }
    this.callbacks.onCameraInput(input);
    this.callbacks.onFeedback?.(input);
  }
}

export function installPlayGamepadControls(callbacks, environment = globalThis) {
  return installGamepadControls(new PlayGamepadInput(callbacks), callbacks, environment);
}

export function installFlyoverGamepadControls(callbacks, environment = globalThis) {
  return installGamepadControls(new FlyoverGamepadInput(callbacks), callbacks, environment);
}

function installGamepadControls(input, callbacks, { window, document, navigator }) {
  let frame = 0, activeIndex = null, status = "", disposed = false, wasActive = false;
  const publishStatus = text => {
    if (text === status) return;
    status = text;
    callbacks.onStatus?.(text);
  };
  const getPads = () => {
    try { return Array.from(navigator.getGamepads?.() || []).filter(pad => pad?.connected); }
    catch { return []; }
  };
  const suspended = () => document.hidden || !document.hasFocus();
  const stop = () => {
    window.cancelAnimationFrame(frame);
    frame = 0;
    input.reset();
    callbacks.onSuspend?.();
  };
  const poll = now => {
    frame = 0;
    if (disposed || suspended()) { input.reset(); return; }
    const pads = getPads();
    const supported = pads.filter(pad => pad.mapping === "standard");
    const active = supported.find(pad => pad.index === activeIndex);
    const hasInput = pad => Object.values(readPlayGamepad(pad)).some(Boolean);
    const pad = active && hasInput(active) ? active : supported.find(hasInput) || active || supported[0];
    if ((pad?.index ?? null) !== activeIndex) {
      input.reset(null);
      activeIndex = pad?.index ?? null;
      wasActive = false;
    }
    publishStatus(pad ? "Controller connected"
      : pads.length ? "This controller is not mapped by your browser."
        : "Press a controller button to connect.");
    const editing = document.activeElement?.isContentEditable
      || document.activeElement?.closest?.("input, textarea, select, [role='textbox'], [role='dialog'], dialog[open]");
    const activeInput = Boolean(pad && hasInput(pad));
    if (!pad || editing || !callbacks.isReady()) input.reset(pad || null);
    else {
      // Take over presentation once per gesture, not on every held-input frame.
      // Mouse/keyboard can restore the UI until the controller is released again.
      if (activeInput && !wasActive) callbacks.onActivity?.();
      input.update(pad, now);
    }
    wasActive = activeInput;
    if (!pad) callbacks.onSuspend?.();
    if (pads.length) frame = window.requestAnimationFrame(poll);
  };
  const start = () => {
    if (!disposed && !frame && typeof navigator.getGamepads === "function" && !suspended()) {
      frame = window.requestAnimationFrame(poll);
    }
  };
  const refresh = () => { stop(); start(); };
  const visibility = () => document.hidden ? stop() : start();
  const events = [[window, "gamepadconnected", start], [window, "gamepaddisconnected", refresh],
    [window, "blur", stop], [window, "focus", start], [window, "pagehide", stop],
    [window, "pageshow", start], [document, "visibilitychange", visibility],
    [document, "focusin", refresh]];
  for (const [target, name, handler] of events) target.addEventListener(name, handler);
  publishStatus(navigator.getGamepads ? "Press a controller button to connect." : "Controller input is unavailable in this browser.");
  start();
  return () => {
    disposed = true;
    stop();
    for (const [target, name, handler] of events) target.removeEventListener(name, handler);
  };
}
