import { loadMazeBenchEngineV1 } from "./engine.mjs";

self.addEventListener("message", async (event) => {
  const { id, room, blocks, maximumNodes } = event.data || {};
  try {
    const engine = await loadMazeBenchEngineV1();
    const result = engine.solve(room, blocks, { maximumNodes });
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error?.message || "engine/v1 solver failed." });
  }
});

