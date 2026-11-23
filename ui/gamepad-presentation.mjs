export function installGamepadPresentation({ window, document } = globalThis) {
  const show = () => document.body.classList.remove("is-controller-active");
  const events = ["pointerdown", "keydown", "wheel"];
  for (const event of events) window.addEventListener(event, show, { capture: true, passive: true });
  return {
    onActivity: () => document.body.classList.add("is-controller-active"),
    onSuspend: show,
    dispose() {
      show();
      for (const event of events) window.removeEventListener(event, show, true);
    }
  };
}
