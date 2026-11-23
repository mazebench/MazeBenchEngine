const CAMERA_KEYS = new Set(["a", "d", "w", "s", "q", "e", "arrowleft", "arrowright", "arrowup", "arrowdown"]);

export function installFlyoverControls(renderer, { window, document } = globalThis) {
  const canvas = renderer.canvas;
  const contextmenu = event => event.preventDefault();
  const pointerdown = event => {
    if (renderer.pointer || ![0, 1, 2].includes(event.button)) return;
    canvas.setPointerCapture(event.pointerId);
    renderer.cancelCameraMotion();
    renderer.onInspect?.(null);
    renderer.pointer = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY, moved: false
    };
  };
  const pointermove = event => {
    const pointer = renderer.pointer;
    if (!pointer) { renderer.onInspect?.(renderer.hitTest(event)); return; }
    if (pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    pointer.moved ||= Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 3;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    renderer.setFreeYaw(renderer.yaw - dx * 0.006);
    renderer.pitch = renderer.clampPitch(renderer.pitch + dy * 0.004);
    renderer.render();
  };
  const pointerleave = () => { if (!renderer.pointer) renderer.onInspect?.(null); };
  const finishPointer = event => {
    const pointer = renderer.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    renderer.pointer = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (event.type === "pointerup" && event.button === 0 && !pointer.moved) {
      renderer.onSelect?.(renderer.hitTest(event));
    }
  };
  const keydown = event => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey
      || event.target?.isContentEditable || event.target?.closest?.("input, textarea, select, [role='textbox']")) return;
    const key = event.key.toLowerCase();
    if (key === "/") {
      event.preventDefault();
      if (!event.repeat) renderer.centerBoard();
    } else if (CAMERA_KEYS.has(key)) {
      event.preventDefault();
      renderer.cameraMotion.heldKeys.add(key);
      if (key === "q" || key === "e") renderer.cameraMotion.zoomAnimation = null;
      renderer.recomputeContinuousDirections();
    }
  };
  const keyup = event => {
    if (renderer.cameraMotion.heldKeys.delete(event.key.toLowerCase())) renderer.recomputeContinuousDirections();
  };
  const cancel = () => {
    if (renderer.pointer) finishPointer({ type: "pointercancel", pointerId: renderer.pointer.id });
    renderer.cancelCameraMotion();
  };
  const visibility = () => { if (document.hidden) cancel(); };
  const events = [
    [canvas, "contextmenu", contextmenu], [canvas, "pointerdown", pointerdown],
    [canvas, "pointermove", pointermove], [canvas, "pointerleave", pointerleave],
    [canvas, "pointerup", finishPointer], [canvas, "pointercancel", finishPointer],
    [canvas, "lostpointercapture", finishPointer], [window, "keydown", keydown],
    [window, "keyup", keyup], [window, "blur", cancel], [document, "visibilitychange", visibility]
  ];
  for (const [target, type, handler] of events) target.addEventListener(type, handler);
  return () => {
    cancel();
    for (const [target, type, handler] of events) target.removeEventListener(type, handler);
  };
}
