// One control definition for the DOM level editor and React test editor.
export const EDITOR_CAMERA_BUTTONS = Object.freeze([
  { id: "tilt-up", direction: "up", key: "W", label: "Tilt camera up" },
  { id: "rotate-left", direction: "left", key: "A", label: "Rotate camera left" },
  { id: "rotate-right", direction: "right", key: "D", label: "Rotate camera right" },
  { id: "tilt-down", direction: "down", key: "S", label: "Tilt camera down" },
].map((button) => Object.freeze(button)));

export function mountEditorCameraPad(container) {
  for (const { id, direction, key, label } of EDITOR_CAMERA_BUTTONS) {
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className = "pad-button";
    button.dataset.camera = direction;
    button.disabled = true;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-keyshortcuts", key);
    button.title = `${label} (${key})`;
    const triangle = document.createElement("span");
    triangle.className = `pad-arrow ${direction}`;
    triangle.setAttribute("aria-hidden", "true");
    const caption = document.createElement("kbd");
    caption.setAttribute("aria-hidden", "true");
    caption.textContent = key;
    button.append(triangle, caption);
    container.append(button);
  }
  const label = document.createElement("span");
  label.className = "pad-label";
  label.setAttribute("aria-hidden", "true");
  label.textContent = "CAM";
  container.append(label);
}
