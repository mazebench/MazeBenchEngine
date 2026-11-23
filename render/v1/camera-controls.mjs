// A tap takes one step; a hold uses the renderer's smooth keyboard motion.
// Pointer capture and cancellation prevent a released control from sticking.
export function bindCameraHold(button, { key, getRenderer, tap, discreteStep }) {
  let holdTimer;
  let pulseTimer;
  let stepTimer;
  let holding = false;
  let suppressClick = false;
  let pointerId = null;
  const stop = () => {
    clearTimeout(holdTimer);
    clearTimeout(pulseTimer);
    clearInterval(stepTimer);
    getRenderer()?.setCameraControl(key, false);
    button.classList.remove("is-active");
    pointerId = null;
  };
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || pointerId !== null || button.disabled || !getRenderer()) return;
    stop();
    pointerId = event.pointerId;
    holding = false;
    suppressClick = false;
    button.setPointerCapture(event.pointerId);
    button.classList.add("is-active");
    holdTimer = setTimeout(() => {
      holding = true;
      if (discreteStep?.()) stepTimer = setInterval(discreteStep, 140);
      else getRenderer()?.setCameraControl(key, true);
    }, 180);
  });
  button.addEventListener("pointerup", (event) => {
    if (event.pointerId !== pointerId) return;
    suppressClick = holding;
    stop();
  });
  const cancel = () => {
    suppressClick = true;
    stop();
  };
  button.addEventListener("pointercancel", cancel);
  button.addEventListener("lostpointercapture", () => { if (pointerId !== null) cancel(); });
  window.addEventListener("blur", cancel);
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); });
  button.addEventListener("click", (event) => {
    if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
    const renderer = getRenderer();
    if (!renderer || button.disabled || discreteStep?.()) return;
    if (tap) tap();
    else {
      clearTimeout(pulseTimer);
      renderer.setCameraControl(key, true);
      pulseTimer = setTimeout(stop, 150);
    }
  });
  return cancel;
}
