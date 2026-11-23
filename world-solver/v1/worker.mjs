import { instantiateMazeBenchEngineV1 } from "../../engine/current/engine.mjs";
import { loadMainWorldV2 } from "../../render/v1/voxel-world-v2.mjs";
import { runRandomAgentV1 } from "./random-agent.mjs";
import { runRoomBfsV1 } from "./room-bfs.mjs";

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "start") return;
  try {
    self.postMessage({ type: "loading" });
    const search = event.data.mode !== "random";
    const [engine, world] = await Promise.all([
      fetch(new URL("./random-agent.wasm", import.meta.url))
        .then((response) => {
          if (!response.ok) throw new Error("Could not load the random-agent accelerator.");
          return instantiateMazeBenchEngineV1(response);
        }),
      loadMainWorldV2()
    ]);
    const run = search ? runRoomBfsV1 : runRandomAgentV1;
    await run(engine, world, {
      metaStrategy: event.data.mode === "dfs-meta"
        ? "depth"
        : event.data.mode === "super-astar"
          ? "super-astar"
          : event.data.mode === "row-astar" ? "row-astar" : "breadth",
      onProgress: (message) => self.postMessage(message)
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      mode: event.data.mode,
      error: error?.message || "World Solver failed."
    });
  }
});
