// Visual feedback only: the existing game and camera handlers own all actions.
export function installControlPadFeedback(document, window) {
  const buttons = [...document.querySelectorAll(".camera-pad .pad-button, .movement-pad .pad-button")];
  const shortcuts = new Map(buttons.map(button => [button.getAttribute("aria-keyshortcuts")?.toLowerCase(), button]));
  const keys = new Map();
  const pointers = new Map();
  const paint = () => {
    for (const button of buttons) {
      button.classList.toggle("is-key-active", [...keys.values()].includes(button));
      button.classList.toggle("is-pointer-active", [...pointers.values()].includes(button));
    }
  };
  const clear = () => { keys.clear(); pointers.clear(); paint(); };
  const keydown = event => {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey ||
        event.target?.isContentEditable || event.target?.closest?.("input, textarea, select, [role='textbox']")) return;
    const key = event.key.toLowerCase();
    const button = shortcuts.get(key);
    if (!button || button.disabled) return;
    keys.set(event.code || key, button);
    paint();
  };
  const keyup = event => {
    keys.delete(event.code || event.key.toLowerCase());
    paint();
  };
  const pointerdown = event => {
    const button = event.target?.closest?.(".pad-button");
    if (event.button !== 0 || !buttons.includes(button) || button.disabled) return;
    pointers.set(event.pointerId, button);
    paint();
  };
  const pointerup = event => { pointers.delete(event.pointerId); paint(); };
  const visibility = () => { if (document.hidden) clear(); };
  // Capture observes handled game keys without changing their propagation or action.
  window.addEventListener("keydown", keydown, true);
  window.addEventListener("keyup", keyup, true);
  window.addEventListener("pointerdown", pointerdown, true);
  window.addEventListener("pointerup", pointerup, true);
  window.addEventListener("pointercancel", pointerup, true);
  window.addEventListener("lostpointercapture", pointerup, true);
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    for (const [type, listener] of [["keydown", keydown], ["keyup", keyup], ["pointerdown", pointerdown],
      ["pointerup", pointerup], ["pointercancel", pointerup], ["lostpointercapture", pointerup]]) {
      window.removeEventListener(type, listener, true);
    }
    window.removeEventListener("blur", clear);
    document.removeEventListener("visibilitychange", visibility);
    clear();
  };
}

if (typeof document !== "undefined") installControlPadFeedback(document, window);
