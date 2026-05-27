(function () {
  const defaultDirections = [
    { label: "U", dx: 0, dy: -1 },
    { label: "D", dx: 0, dy: 1 },
    { label: "L", dx: -1, dy: 0 },
    { label: "R", dx: 1, dy: 0 }
  ];
  const defaultMaxExpandedStates = 1000000;
  const defaultNonPlayerMoveRewardCap = 3;
  const defaultProgressYieldStateInterval = 4096;

  function compareSolverNodes(left, right) {
    return left.priority - right.priority || left.cost - right.cost || left.order - right.order;
  }

  class SolverHeap {
    constructor() {
      this.items = [];
    }

    get size() {
      return this.items.length;
    }

    push(item) {
      this.items.push(item);
      this.bubbleUp(this.items.length - 1);
    }

    pop() {
      if (this.items.length === 0) {
        return null;
      }

      const first = this.items[0];
      const last = this.items.pop();

      if (this.items.length > 0) {
        this.items[0] = last;
        this.bubbleDown(0);
      }

      return first;
    }

    bubbleUp(index) {
      let currentIndex = index;

      while (currentIndex > 0) {
        const parentIndex = Math.floor((currentIndex - 1) / 2);

        if (compareSolverNodes(this.items[parentIndex], this.items[currentIndex]) <= 0) {
          return;
        }

        [this.items[parentIndex], this.items[currentIndex]] = [
          this.items[currentIndex],
          this.items[parentIndex]
        ];
        currentIndex = parentIndex;
      }
    }

    bubbleDown(index) {
      let currentIndex = index;

      while (true) {
        const leftIndex = currentIndex * 2 + 1;
        const rightIndex = currentIndex * 2 + 2;
        let smallestIndex = currentIndex;

        if (
          leftIndex < this.items.length &&
          compareSolverNodes(this.items[leftIndex], this.items[smallestIndex]) < 0
        ) {
          smallestIndex = leftIndex;
        }

        if (
          rightIndex < this.items.length &&
          compareSolverNodes(this.items[rightIndex], this.items[smallestIndex]) < 0
        ) {
          smallestIndex = rightIndex;
        }

        if (smallestIndex === currentIndex) {
          return;
        }

        [this.items[currentIndex], this.items[smallestIndex]] = [
          this.items[smallestIndex],
          this.items[currentIndex]
        ];
        currentIndex = smallestIndex;
      }
    }
  }

  class SolverStatePool {
    constructor(engine) {
      this.engine = engine;
      this.items = [];
    }

    acquire(source) {
      const state = this.items.pop() || this.engine.createStateBuffer();

      if (source) {
        this.engine.copyStateInto(state, source);
      }

      return state;
    }

    release(state) {
      if (state) {
        this.items.push(state);
      }
    }
  }

  class SolverNodePool {
    constructor() {
      this.items = [];
    }

    acquire(values) {
      const node = this.items.pop() || {};

      node.cost = values.cost;
      node.key = values.key;
      node.order = values.order;
      node.path = values.path;
      node.priority = values.priority;
      node.searchReward = values.searchReward || 0;
      node.state = values.state;

      return node;
    }

    release(node) {
      if (!node) {
        return;
      }

      node.path = "";
      node.state = null;
      this.items.push(node);
    }
  }

  function numericOption(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function solverAlgorithmOption(value) {
    if (value === "bfs") {
      return "bfs";
    }

    return value === "weighted_astar" || value === "weighted" ? "weighted_astar" : "astar";
  }

  function throwIfSolverAborted(signal) {
    if (!signal?.aborted) {
      return;
    }

    const error = new Error("Solver cancelled.");
    error.name = "AbortError";
    throw error;
  }

  function solverNonPlayerMoveReward(engine, moveResult, rewardCap) {
    if (Number.isFinite(moveResult?.nonPlayerMoveCount)) {
      return Math.min(rewardCap, moveResult.nonPlayerMoveCount);
    }

    const movedActorIndexes = new Set();

    if (!Array.isArray(moveResult?.moves)) {
      return 0;
    }

    moveResult.moves.forEach((move) => {
      if (engine.isPlayerMove(move) || move.actorType === "gem") {
        return;
      }

      if (move.fromX === move.toX && move.fromY === move.toY) {
        return;
      }

      movedActorIndexes.add(move.actorIndex);
    });

    return Math.min(rewardCap, movedActorIndexes.size);
  }

  async function reportProgress(reportProgressFn, expanded, maxExpanded, openSize, force = false) {
    if (!reportProgressFn) {
      return;
    }

    await reportProgressFn(
      {
        expanded,
        maxExpanded,
        openSize
      },
      force
    );
  }

  async function solveWithAStar(engine, options = {}) {
    throwIfSolverAborted(options.signal);
    const algorithm = solverAlgorithmOption(options.algorithm);
    const directions = Array.isArray(options.directions) ? options.directions : defaultDirections;
    const maxExpandedStates = numericOption(
      options.maxExpandedStates,
      defaultMaxExpandedStates
    );
    const progressYieldStateInterval = numericOption(
      options.progressYieldStateInterval,
      defaultProgressYieldStateInterval
    );
    const nonPlayerMoveRewardCap = numericOption(
      options.nonPlayerMoveRewardCap,
      defaultNonPlayerMoveRewardCap
    );
    const heuristicWeight =
      algorithm === "bfs"
        ? 0
        : 1;
    const useSearchReward = algorithm === "weighted_astar";
    const open = new SolverHeap();
    const bestCostByKey = new Map();
    const statePool = new SolverStatePool(engine);
    const nodePool = new SolverNodePool();
    const reportProgressFn =
      typeof options.onProgress === "function" ? options.onProgress : null;
    let order = 0;
    let expanded = 0;
    const initialState = statePool.acquire(engine.initialState);
    const initialKey = engine.stateKey(initialState);

    bestCostByKey.set(initialKey, 0);
    open.push(nodePool.acquire({
      state: initialState,
      key: initialKey,
      cost: 0,
      searchReward: 0,
      path: "",
      priority: heuristicWeight * engine.heuristic(initialState),
      order: order
    }));
    order += 1;

    await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

    while (open.size > 0) {
      throwIfSolverAborted(options.signal);
      const current = open.pop();

      if (current.cost !== bestCostByKey.get(current.key)) {
        statePool.release(current.state);
        nodePool.release(current);
        continue;
      }

      if (engine.isSolved(current.state)) {
        await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

        return {
          status: "solved",
          moves: current.cost,
          path: current.path,
          expanded
        };
      }

      expanded += 1;

      if (expanded % progressYieldStateInterval === 0) {
        await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size);
      }

      if (expanded >= maxExpandedStates) {
        await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

        return {
          status: "capped",
          expanded,
          maxExpanded: maxExpandedStates
        };
      }

      for (const direction of directions) {
        throwIfSolverAborted(options.signal);
        const moveResult = engine.moveForSearch(
          current.state,
          direction.dx,
          direction.dy
        );

        if (!moveResult?.moved) {
          continue;
        }

        const nextCost = current.cost + 1;
        const nextSearchReward =
          useSearchReward
            ? current.searchReward +
              solverNonPlayerMoveReward(engine, moveResult, nonPlayerMoveRewardCap)
            : 0;
        const nextKey = engine.stateKey(current.state);
        const bestKnownCost = bestCostByKey.get(nextKey);

        if (typeof bestKnownCost === "number" && bestKnownCost <= nextCost) {
          engine.undoMove(current.state, moveResult);
          continue;
        }

        const nextState = statePool.acquire(current.state);

        bestCostByKey.set(nextKey, nextCost);
        open.push(nodePool.acquire({
          state: nextState,
          key: nextKey,
          cost: nextCost,
          searchReward: nextSearchReward,
          path: current.path + direction.label,
          priority: nextCost + heuristicWeight * engine.heuristic(nextState) - nextSearchReward,
          order
        }));
        order += 1;

        engine.undoMove(current.state, moveResult);
      }

      statePool.release(current.state);
      nodePool.release(current);
    }

    await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

    return {
      status: "unsolved",
      expanded
    };
  }

  function canCollectGemAtMoveEndpoint(engine, move) {
    if (!engine.isPlayerMove(move) || move.toRemoved) {
      return false;
    }

    return Number.isFinite(Number(move.toElevation ?? 0));
  }

  function recordGemPlacementCandidates(
    engine,
    moveResult,
    cost,
    path,
    bestCandidateByCell,
    canPlaceGemAt
  ) {
    moveResult.moves.forEach((move) => {
      if (!canCollectGemAtMoveEndpoint(engine, move)) {
        return;
      }

      const elevation = Math.max(0, Math.floor(Number(move.toElevation ?? 0) || 0));

      if (!canPlaceGemAt(move.toX, move.toY, elevation, move)) {
        return;
      }

      const key = move.toX + "," + move.toY + "," + elevation;
      const previousCandidate = bestCandidateByCell.get(key);

      if (previousCandidate && previousCandidate.moves <= cost) {
        return;
      }

      bestCandidateByCell.set(key, {
        elevation,
        x: move.toX,
        y: move.toY,
        moves: cost,
        path
      });
    });
  }

  function hardestGemPlacementCandidate(bestCandidateByCell) {
    let hardest = null;

    bestCandidateByCell.forEach((candidate) => {
      if (!hardest || candidate.moves > hardest.moves) {
        hardest = candidate;
      }
    });

    return hardest;
  }

  async function findHardestGemPlacement(engine, options = {}) {
    throwIfSolverAborted(options.signal);
    const directions = Array.isArray(options.directions) ? options.directions : defaultDirections;
    const maxExpandedStates = numericOption(
      options.maxExpandedStates,
      defaultMaxExpandedStates
    );
    const progressYieldStateInterval = numericOption(
      options.progressYieldStateInterval,
      defaultProgressYieldStateInterval
    );
    const canPlaceGemAt =
      typeof options.canPlaceGemAt === "function" ? options.canPlaceGemAt : () => true;
    const open = new SolverHeap();
    const bestCostByKey = new Map();
    const bestCandidateByCell = new Map();
    const statePool = new SolverStatePool(engine);
    const nodePool = new SolverNodePool();
    const reportProgressFn =
      typeof options.onProgress === "function" ? options.onProgress : null;
    let order = 0;
    let expanded = 0;
    const initialState = statePool.acquire(engine.initialState);
    const initialKey = engine.stateKey(initialState);

    bestCostByKey.set(initialKey, 0);
    open.push(nodePool.acquire({
      state: initialState,
      key: initialKey,
      cost: 0,
      path: "",
      priority: 0,
      order
    }));
    order += 1;

    await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

    while (open.size > 0) {
      throwIfSolverAborted(options.signal);
      const current = open.pop();

      if (current.cost !== bestCostByKey.get(current.key)) {
        statePool.release(current.state);
        nodePool.release(current);
        continue;
      }

      expanded += 1;

      if (expanded % progressYieldStateInterval === 0) {
        await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size);
      }

      if (expanded >= maxExpandedStates) {
        await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

        return {
          status: "capped",
          candidate: hardestGemPlacementCandidate(bestCandidateByCell),
          expanded,
          maxExpanded: maxExpandedStates
        };
      }

      for (const direction of directions) {
        throwIfSolverAborted(options.signal);
        const moveResult = engine.moveForSearch(
          current.state,
          direction.dx,
          direction.dy
        );

        if (!moveResult?.moved) {
          continue;
        }

        const nextCost = current.cost + 1;
        const nextPath = current.path + direction.label;
        const nextKey = engine.stateKey(current.state);
        const bestKnownCost = bestCostByKey.get(nextKey);

        recordGemPlacementCandidates(
          engine,
          moveResult,
          nextCost,
          nextPath,
          bestCandidateByCell,
          canPlaceGemAt
        );

        if (typeof bestKnownCost === "number" && bestKnownCost <= nextCost) {
          engine.undoMove(current.state, moveResult);
          continue;
        }

        const nextState = statePool.acquire(current.state);

        bestCostByKey.set(nextKey, nextCost);
        open.push(nodePool.acquire({
          state: nextState,
          key: nextKey,
          cost: nextCost,
          path: nextPath,
          priority: nextCost,
          order
        }));
        order += 1;

        engine.undoMove(current.state, moveResult);
      }

      statePool.release(current.state);
      nodePool.release(current);
    }

    const candidate = hardestGemPlacementCandidate(bestCandidateByCell);

    await reportProgress(reportProgressFn, expanded, maxExpandedStates, open.size, true);

    return {
      status: candidate ? "found" : "none",
      candidate,
      expanded
    };
  }

  window.MazeSolver = {
    findHardestGemPlacement,
    solveWithAStar
  };
})();
