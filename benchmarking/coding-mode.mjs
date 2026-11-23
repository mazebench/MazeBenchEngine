// Explicit conditions for new launches; old signed records retain their boolean.
export const CODING_MODES = ["off", "python", "any"];
export function codingMode(spec = {}) {
  if (spec.coding_mode != null) {
    if (!CODING_MODES.includes(spec.coding_mode)) throw new Error("Unknown coding mode.");
    return spec.coding_mode;
  }
  return spec.tools_enabled === true || spec.tools_enabled === "true" ? "python" : "off";
}
export function codingLabel(run = {}) {
  if (run.provider === "prime-agent") return "Native Python";
  return { off: "Coding off", python: "Python only", any: "Any language" }[codingMode(run)];
}
export function supportsAnyLanguage(spec = {}) {
  return ["codex", "claude-code"].includes(spec.provider || "codex") &&
    (spec.observation_mode || "ascii") === "ascii" &&
    ["main-world", "ice-maze", "slotski"].includes(spec.world || "main-world");
}
