// Canonical exhaustive room-analysis worker. The main thread owns world
// traversal; this worker uses MazeBench's built-in solver so even very large
// room state spaces never freeze the renderer.
self.window = self;
importScripts("maze-engine.js", "maze-solver.js");

let activeJobId = 0;
const continuations = new Map();

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

function publicGemResult(target, result) {
  return {
    ...target,
    expanded: Number(result?.expanded || 0),
    moves: Number(result?.moves || 0),
    path: result?.status === "solved" ? String(result.path || "") : "",
    status: result?.status || "unsolved"
  };
}

function publicPositionResult(result) {
  return {
    expanded: Number(result?.expanded || 0),
    maxExpanded: Number(result?.maxExpanded || 0),
    reachable: Array.isArray(result?.reachable) ? result.reachable : [],
    status: result?.status || "exhausted",
    unreachable: Array.isArray(result?.unreachable) ? result.unreachable : []
  };
}

function analysisResult(session, activeResult = null) {
  const gemResults = session.gemResults.slice();
  let positionResult = session.positionResult || {
    status: "found_all",
    expanded: 0,
    reachable: [],
    unreachable: []
  };

  if (session.phase === "gems" && activeResult) {
    gemResults.push(publicGemResult(session.gemTargets[session.gemIndex], activeResult));
  } else if (session.phase === "space" && activeResult) {
    positionResult = publicPositionResult(activeResult);
  }

  return {
    exhaustive: !activeResult,
    gemResults,
    positionResult
  };
}

async function runAnalysisSession(session, jobId, additionalExpandedStates = null) {
  while (session.gemIndex < session.gemTargets.length) {
    const target = session.gemTargets[session.gemIndex];
    if (session.phase !== "gems" || !session.searchContinuation) {
      session.phase = "gems";
      session.engine = self.MazeEngine.createEngine(gemPlayData(session.playData, target));
    }
    const continuing = Boolean(session.searchContinuation);
    const result = await self.MazeSolver.solveWithAStar(session.engine, {
      additionalExpandedStates: continuing ? additionalExpandedStates : undefined,
      algorithm: "astar",
      continuation: session.searchContinuation,
      maxExpandedStates: continuing ? undefined : session.maxExpandedStates,
      progressYieldStateInterval: 2048,
      onProgress(progress, force) {
        postProgress(
          jobId,
          "gems",
          `${session.gemIndex + 1}/${session.gemTargets.length}`,
          progress,
          force
        );
      }
    });

    if (result.status === "capped" && result.continuation) {
      session.searchContinuation = result.continuation;
      return analysisResult(session, result);
    }

    session.searchContinuation = null;
    session.gemResults.push(publicGemResult(target, result));
    session.gemIndex += 1;
    additionalExpandedStates = null;
  }

  if (session.positionTargets.length > 0 && !session.positionResult) {
    if (session.phase !== "space" || !session.searchContinuation) {
      session.phase = "space";
      session.engine = self.MazeEngine.createEngine(session.playData);
    }
    const continuing = Boolean(session.searchContinuation);
    const result = await self.MazeSolver.findReachablePositions(
      session.engine,
      session.positionTargets,
      {
        additionalExpandedStates: continuing ? additionalExpandedStates : undefined,
        continuation: session.searchContinuation,
        maxExpandedStates: continuing ? undefined : session.maxExpandedStates,
        progressYieldStateInterval: 2048,
        onProgress(progress, force) {
          postProgress(jobId, "space", `${session.positionTargets.length} targets`, progress, force);
        }
      }
    );

    if (result.status === "capped" && result.continuation) {
      session.searchContinuation = result.continuation;
      return analysisResult(session, result);
    }

    session.searchContinuation = null;
    session.positionResult = publicPositionResult(result);
  }

  session.phase = "done";
  return analysisResult(session);
}

self.onmessage = async function (event) {
  const message = event.data || {};

  if (message.type === "discard") {
    continuations.delete(String(message.continuationId || ""));
    return;
  }

  if (message.type !== "analyze_room" && message.type !== "continue_analysis") return;
  const jobId = Number(message.id || 0);
  activeJobId = jobId;
  postProgress.lastAt = 0;
  let continuationId = String(message.continuationId || "");

  try {
    let session;
    let additionalExpandedStates = null;

    if (message.type === "continue_analysis") {
      session = continuations.get(continuationId);
      if (!session) throw new Error("The saved room search is no longer available.");
      additionalExpandedStates = Number.isFinite(Number(message.additionalExpandedStates))
        ? Math.max(1, Number(message.additionalExpandedStates))
        : session.maxExpandedStates;
    } else {
      continuations.clear();
      continuationId = "world-solver-" + jobId;
      session = {
        engine: null,
        gemIndex: 0,
        gemResults: [],
        gemTargets: Array.isArray(message.gemTargets) ? message.gemTargets : [],
        maxExpandedStates: Number.isFinite(Number(message.maxExpandedStates))
          ? Math.max(1, Number(message.maxExpandedStates))
          : Number.MAX_SAFE_INTEGER,
        phase: "gems",
        playData: message.playData,
        positionResult: null,
        positionTargets: Array.isArray(message.positionTargets) ? message.positionTargets : [],
        searchContinuation: null
      };
    }

    const result = await runAnalysisSession(session, jobId, additionalExpandedStates);
    if (!result.exhaustive) {
      continuations.set(continuationId, session);
    } else {
      continuations.delete(continuationId);
      continuationId = "";
    }

    if (activeJobId === jobId) {
      self.postMessage({ type: "done", id: jobId, continuationId, result });
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
