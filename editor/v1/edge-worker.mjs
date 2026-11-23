import { loadMazeBenchEngineV1 } from "../../engine/current/engine.mjs";
import { loadMainWorldV2 } from "../../render/v1/voxel-world-v2.mjs";
import { findRoomTransitionsV1, tagEdgeFinderObjectsV1 } from "./edge-runtime.mjs";

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  try {
    const [engine, loadedWorld] = await Promise.all([
      loadMazeBenchEngineV1(),
      loadMainWorldV2()
    ]);
    const world = tagEdgeFinderObjectsV1(loadedWorld, message.room);
    const room = world.rooms.find((candidate) => candidate.fileName === message.room.fileName);
    const node = {
      id: "authored",
      roomFileName: room.fileName,
      state: engine.createState(room),
      collectedGemIds: []
    };
    self.postMessage({ type: "progress", message: `Searching authored start in ${room.fileName}…` });
    const found = await findRoomTransitionsV1(engine, world.blocks, world, node, message);
    self.postMessage({
      type: "complete",
      results: [{
        startId: node.id,
        search: found.search,
        transitions: found.transitions.map((transition) => ({
          ...transition,
          destinationRoom: {
            fileName: transition.destinationRoom.fileName,
            position: transition.destinationRoom.position
          }
        }))
      }]
    });
  } catch (error) {
    self.postMessage({ type: "error", error: error?.message || "Edge Finder failed." });
  }
});
