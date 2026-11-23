import {
  ENGINE_V1_DIRECTIONS,
  countActiveRoleV1,
  createEngineStateV1,
  engineVoxelCountV1
} from "../../engine/current/adapter.mjs";

const STATUS_LABELS = Object.freeze({
  [-1]: "invalid",
  [0]: "searching",
  [1]: "solved",
  [2]: "resource-limit",
  [3]: "solved-unproven",
  [4]: "unsolved"
});

const REQUIRED_EXPORTS = [
  "editor_solver_begin",
  "editor_solver_run",
  "editor_solver_expanded",
  "editor_solver_generated",
  "editor_solver_transpositions",
  "editor_solver_local_expanded",
  "editor_solver_command_transitions",
  "editor_solver_full_physics_transitions",
  "editor_solver_open_states",
  "editor_solver_best_priority",
  "editor_solver_node_count",
  "editor_solver_maximum_nodes",
  "editor_solver_node_capacity",
  "editor_solver_solution_interactions",
  "editor_solver_solution_length",
  "editor_solver_solution_step"
];

function nonNegativeInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.max(0, Math.min(maximum, number)) : fallback;
}

export function createEditorSolverSessionV1(engine, stateOrRoom, definitions, options = {}) {
  for (const name of REQUIRED_EXPORTS) {
    if (typeof engine.exports[name] !== "function") {
      throw new Error(`The editor solver wrapper is missing ${name}.`);
    }
  }
  const state = createEngineStateV1(stateOrRoom);
  if (engineVoxelCountV1(state, definitions) > engine.exports.search_voxel_capacity()) {
    throw new Error(`Editor search supports at most ${engine.exports.search_voxel_capacity()} objects.`);
  }
  if (countActiveRoleV1(state, definitions, "player") < 1) {
    throw new Error("Place a player before running a solver.");
  }
  if (countActiveRoleV1(state, definitions, "goal") < 1) {
    throw new Error("Place at least one gem before running a solver.");
  }

  const heuristicWeight = nonNegativeInteger(options.heuristicWeight, 0, 1_000);
  const interactionWeight = nonNegativeInteger(options.interactionWeight, 0, 1_000);
  const algorithm = heuristicWeight === 0 && interactionWeight === 0
    ? "exact-shortest"
    : "fast-astar";
  const { count } = engine.writeState(state, definitions);
  if (engine.exports.editor_solver_begin(
    count,
    state.width,
    state.height,
    heuristicWeight,
    interactionWeight,
    1,
    0
  ) !== 1) {
    throw new Error("The native editor solver rejected this room.");
  }

  const startedAt = performance.now();
  let statusCode = 0;

  function snapshot() {
    const elapsedMs = Math.max(0, performance.now() - startedAt);
    const elapsedSeconds = elapsedMs / 1_000;
    const expanded = engine.exports.editor_solver_expanded();
    const commandTransitions = engine.exports.editor_solver_command_transitions();
    const solution = [];
    if (statusCode === 1 || statusCode === 3) {
      for (let index = 0; index < engine.exports.editor_solver_solution_length(); index += 1) {
        solution.push(ENGINE_V1_DIRECTIONS[engine.exports.editor_solver_solution_step(index)]);
      }
    }
    return {
      status: STATUS_LABELS[statusCode] || "invalid",
      statusCode,
      algorithm,
      proven: statusCode === 1,
      maximumNodes: engine.exports.editor_solver_maximum_nodes(),
      nodeCapacity: engine.exports.editor_solver_node_capacity(),
      heuristicWeight,
      interactionWeight,
      elapsedMs,
      moves: solution.length,
      expanded,
      generated: engine.exports.editor_solver_generated(),
      transpositions: engine.exports.editor_solver_transpositions(),
      localExpanded: engine.exports.editor_solver_local_expanded(),
      commandTransitions,
      fullPhysicsTransitions: engine.exports.editor_solver_full_physics_transitions(),
      openStates: engine.exports.editor_solver_open_states(),
      bestPriority: engine.exports.editor_solver_best_priority(),
      nodeCount: engine.exports.editor_solver_node_count(),
      interactionEvents: engine.exports.editor_solver_solution_interactions(),
      statesPerSecond: elapsedSeconds > 0 ? expanded / elapsedSeconds : 0,
      actionsPerSecond: elapsedSeconds > 0 ? commandTransitions / elapsedSeconds : 0,
      solution
    };
  }

  return Object.freeze({
    runChunk(maximumExpansions = 256) {
      if (statusCode !== 0) return snapshot();
      statusCode = engine.exports.editor_solver_run(
        Math.max(1, nonNegativeInteger(maximumExpansions, 256, 100_000))
      );
      return snapshot();
    },
    snapshot
  });
}
