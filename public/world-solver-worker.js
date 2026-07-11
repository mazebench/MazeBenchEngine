// Canonical exhaustive room-analysis worker. The main thread owns world
// traversal; this worker uses MazeBench's built-in solver so even very large
// room state spaces never freeze the renderer.
self.window = self;
importScripts("maze-engine.js", "maze-solver.js");

let activeJobId = 0;

function postProgress(jobId, phase, detail, progress, force) {
  if (activeJobId !== jobId) return;
  const now = Date.now();
  if (!force && now - postProgress.lastAt < 80) return;
  postProgress.lastAt = now;
  self.postMessage({
    type: "progress",
    id: jobId,
    phase,
    detail,
    expanded: Number(progress?.expanded || 0),
    openSize: Number(progress?.openSize || 0)
  });
}
postProgress.lastAt = 0;

function gemPlayData(playData, gem) {
  return {
    ...playData,
    actors: (playData.actors || [])
      .filter((actor) => actor?.type !== "gem")
      .concat([{ ...gem, removed: false, type: "gem" }])
  };
}

self.onmessage = async function (event) {
  const message = event.data || {};
  if (message.type !== "analyze_room") return;
  const jobId = Number(message.id || 0);
  activeJobId = jobId;
  postProgress.lastAt = 0;
  const maxExpandedStates = Number.isFinite(Number(message.maxExpandedStates))
    ? Math.max(1, Number(message.maxExpandedStates))
    : Number.MAX_SAFE_INTEGER;
  try {
    const gemTargets = Array.isArray(message.gemTargets) ? message.gemTargets : [];
    const gemResults = [];
    for (let index = 0; index < gemTargets.length; index += 1) {
      const target = gemTargets[index];
      const engine = self.MazeEngine.createEngine(gemPlayData(message.playData, target));
      const result = await self.MazeSolver.solveWithAStar(engine, {
        algorithm: "astar",
        maxExpandedStates,
        progressYieldStateInterval: 2048,
        onProgress(progress, force) {
          postProgress(jobId, "gems", `${index + 1}/${gemTargets.length}`, progress, force);
        }
      });
      gemResults.push({
        ...target,
        expanded: Number(result?.expanded || 0),
        moves: Number(result?.moves || 0),
        path: result?.status === "solved" ? String(result.path || "") : "",
        status: result?.status || "unsolved"
      });
    }

    const positionTargets = Array.isArray(message.positionTargets) ? message.positionTargets : [];
    let positionResult = { status: "found_all", expanded: 0, reachable: [], unreachable: [] };
    if (positionTargets.length > 0) {
      const engine = self.MazeEngine.createEngine(message.playData);
      positionResult = await self.MazeSolver.findReachablePositions(engine, positionTargets, {
        maxExpandedStates,
        progressYieldStateInterval: 2048,
        onProgress(progress, force) {
          postProgress(jobId, "space", `${positionTargets.length} targets`, progress, force);
        }
      });
    }

    if (activeJobId === jobId) {
      self.postMessage({
        type: "done",
        id: jobId,
        result: {
          exhaustive:
            gemResults.every((result) => result.status !== "capped") &&
            positionResult.status !== "capped",
          gemResults,
          positionResult
        }
      });
    }
  } catch (error) {
    if (activeJobId === jobId) {
      self.postMessage({
        type: "error",
        id: jobId,
        message: error instanceof Error ? error.message : "Room analysis failed."
      });
    }
  }
};
