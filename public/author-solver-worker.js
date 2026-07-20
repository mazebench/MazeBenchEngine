// Editor solver worker: runs A*/BFS searches off the main thread so the
// editor never freezes and a run can be cancelled instantly (the host page
// terminates the worker). Loaded as a classic worker from the site root.
//
// Protocol
//   in : { type: "run", id, op: "solve" | "place_gem", playData, options }
//   in : { type: "continue", id, continuationId, options }
//   in : { type: "discard", continuationId }
//         options.solve     -> { algorithm, maxExpandedStates }
//         options.placeGem  -> { maxExpandedStates,
//                                surfaces: { valid: [], blocked: [], width, height } }
//   out: { type: "progress", id, expanded, maxExpanded }
//   out: { type: "done", id, result }
//   out: { type: "error", id, message }

self.window = self;
importScripts("maze-engine.js", "maze-solver.js");

const PROGRESS_POST_INTERVAL_MS = 66;
const continuations = new Map();

function createProgressPoster(id) {
  let lastPostAt = 0;

  return function postProgress(progress, force) {
    const now = Date.now();

    if (!force && now - lastPostAt < PROGRESS_POST_INTERVAL_MS) {
      return;
    }

    lastPostAt = now;
    self.postMessage({
      type: "progress",
      id,
      expanded: Math.max(0, progress?.expanded ?? 0),
      maxExpanded: Math.max(1, progress?.maxExpanded ?? 1)
    });
  };
}

function createGemSurfacePredicate(surfaces) {
  const validSurfaces = new Set(surfaces?.valid || []);
  const blockedSurfaces = new Set(surfaces?.blocked || []);
  const width = Math.max(0, Number(surfaces?.width) || 0);
  const height = Math.max(0, Number(surfaces?.height) || 0);

  return function canPlaceGemAt(x, y, elevation) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
      return false;
    }

    const key = x + "," + y + "," + Math.max(0, Math.floor(Number(elevation) || 0));
    return validSurfaces.has(key) && !blockedSurfaces.has(key);
  };
}

async function runJob(message) {
  const options = message.options || {};
  const onProgress = createProgressPoster(message.id);
  let continuationId = "";
  let engine;
  let op;
  let solverContinuation = null;

  if (message.type === "continue") {
    continuationId = String(message.continuationId || "");
    const saved = continuations.get(continuationId);

    if (!saved) {
      throw new Error("The saved solver search is no longer available.");
    }

    engine = saved.engine;
    op = saved.op;
    solverContinuation = saved.continuation;
  } else {
    continuations.clear();
    continuationId = "author-solver-" + Number(message.id || 0);
    engine = self.MazeEngine.createEngine(message.playData);
    op = message.op;
  }

  let result;

  if (op === "solve") {
    result = await self.MazeSolver.solveWithAStar(engine, {
      algorithm: options.algorithm,
      additionalExpandedStates: options.additionalExpandedStates,
      continuation: solverContinuation,
      maxExpandedStates: options.maxExpandedStates,
      onProgress,
      progressYieldStateInterval: options.progressYieldStateInterval
    });
  } else if (op === "place_gem") {
    result = await self.MazeSolver.findHardestGemPlacement(engine, {
      additionalExpandedStates: options.additionalExpandedStates,
      canPlaceGemAt: createGemSurfacePredicate(options.surfaces),
      continuation: solverContinuation,
      maxExpandedStates: options.maxExpandedStates,
      onProgress,
      progressYieldStateInterval: options.progressYieldStateInterval
    });
  } else {
    throw new Error("Unknown solver worker op: " + op + ".");
  }

  if (result?.status === "capped" && result.continuation) {
    continuations.set(continuationId, {
      continuation: result.continuation,
      engine,
      op
    });
  } else {
    continuations.delete(continuationId);
    continuationId = "";
  }

  return { result: { ...result }, continuationId };
}

self.onmessage = function (event) {
  const message = event.data || {};

  if (message.type === "discard") {
    continuations.delete(String(message.continuationId || ""));
    return;
  }

  if (message.type !== "run" && message.type !== "continue") {
    return;
  }

  runJob(message)
    .then(({ continuationId, result }) => {
      self.postMessage({ type: "done", id: message.id, continuationId, result });
    })
    .catch((error) => {
      self.postMessage({
        type: "error",
        id: message.id,
        message: error instanceof Error ? error.message : "Solver worker failed."
      });
    });
};
