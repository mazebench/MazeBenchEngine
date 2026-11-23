import { codingLabel } from "../capabilities.mjs";
export function setupPromptPreview(container, getSpec) {
  const text = container.querySelector("#prompt-text");
  const status = container.querySelector("#prompt-status");
  const context = container.querySelector("#prompt-context");
  const description = container.querySelector("#prompt-description");
  const copy = container.querySelector("#copy-prompt");
  let generation = 0;
  let previousQuery = "";
  let controller;

  copy.addEventListener("click", async () => {
    const current = generation;
    try {
      await navigator.clipboard.writeText(text.textContent);
      if (current === generation) status.textContent = "Prompt copied.";
    } catch {
      if (current === generation) status.textContent = "Copy unavailable. Select the prompt text to copy it manually.";
    }
  });

  return async function updatePrompt() {
    const spec = getSpec();
    const query = new URLSearchParams({
      world: spec.world,
      observation_mode: spec.observation_mode || "ascii",
      provider: spec.provider,
      tools_enabled: String(spec.tools_enabled),
      coding_mode: spec.coding_mode || (spec.tools_enabled ? "python" : "off"),
      action_limit: spec.action_limit ?? "unlimited",
      sequence_enabled: String(spec.sequence_enabled ?? true)
    }).toString();
    if (query === previousQuery) return;
    previousQuery = query;
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    const world = { "main-world": "Main World", "ice-maze": "Ice Maze", slotski: "Slotski" }[spec.world];
    const observation = spec.observation_mode === "vision" ? "Vision" : "ASCII";
    const python = codingLabel(spec);
    context.textContent = `${world} · ${observation} · ${python}`;
    description.textContent = spec.provider === "prime-agent"
      ? "Updates with the settings above. Prime Agent uses its native Python workspace."
      : "Updates with the settings above. Choose a coding tier to read its exact prompt.";
    container.setAttribute("aria-busy", "true");
    status.textContent = "Loading prompt…";
    text.textContent = "";
    text.hidden = true;
    copy.disabled = true;
    try {
      // Always read the local prompt preview, even when the vision runner is offline.
      const response = await fetch(`/api/benchmark/v1/prompt?${query}`, { signal: controller.signal });
      const value = await response.json();
      if (current !== generation) return;
      if (!response.ok) throw new Error(value.error || "The prompt could not be loaded.");
      text.textContent = value.prompt;
      text.hidden = false;
      copy.disabled = false;
      status.textContent = "";
    } catch (error) {
      if (current !== generation) return;
      previousQuery = "";
      status.textContent = error.message;
    } finally {
      if (current === generation) container.setAttribute("aria-busy", "false");
    }
  };
}
