import { instantiateMazeBenchEngineV1 } from "../../engine/current/engine.mjs";
import { createEditorSolverSessionV1 } from "./native-solver-runtime.mjs";

const yieldToWorker = () => new Promise((resolve) => setTimeout(resolve, 0));

self.addEventListener("message", async (event) => {
  const {
    id,
    room,
    blocks,
    heuristicWeight,
    interactionWeight
  } = event.data || {};
  try {
    const response = await fetch(new URL("../../world-solver/v1/editor-solver.wasm", import.meta.url));
    if (!response.ok) throw new Error("Could not load the native editor solver wrapper.");
    const engine = await instantiateMazeBenchEngineV1(await response.arrayBuffer());
    const session = createEditorSolverSessionV1(engine, room, blocks, {
      heuristicWeight,
      interactionWeight
    });
    let result = session.snapshot();
    while (result.statusCode === 0) {
      result = session.runChunk(65_536);
      self.postMessage({ id, type: "progress", result });
      await yieldToWorker();
    }
    self.postMessage({ id, type: "complete", result });
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      error: error?.message || "Native editor solver failed."
    });
  }
});
