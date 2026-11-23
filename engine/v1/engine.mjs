import {
  ENGINE_V1_ABI,
  ENGINE_V1_DIRECTIONS,
  ENGINE_V1_VOXEL_STRIDE,
  countActiveRoleV1,
  createEngineStateV1,
  engineCollisionStateV1,
  engineVoxelCountV1,
  normalizeEngineDirectionV1,
  readEngineStateV1,
  roomFromEngineStateV1,
  writeEngineStateV1
} from "./adapter.mjs";
export {
  ENGINE_SOURCE_COMMIT,
  ENGINE_SOURCE_REPOSITORY,
  ENGINE_SOURCE_TREE,
  ENGINE_WASM_SHA256
} from "./upstream.mjs";

export const ENGINE_VERSION = "v1";

const SEARCH_STATUSES = Object.freeze({
  [-1]: "invalid",
  [0]: "unsolved",
  [1]: "solved",
  [2]: "limit-hit",
  [3]: "solved-unproven"
});

function sameState(left, right) {
  return left.objects.length === right.objects.length && left.objects.every((object, index) => {
    const other = right.objects[index];
    return object.x === other.x && object.y === other.y && object.z === other.z &&
      object.engineGenericId === other.engineGenericId &&
      object.mechanismDepth === other.mechanismDepth;
  });
}

export class MazeBenchEngineV1 {
  constructor(exports) {
    this.exports = exports;
    if (exports.physics_abi_version() !== ENGINE_V1_ABI ||
        exports.voxel_stride() !== ENGINE_V1_VOXEL_STRIDE) {
      throw new Error("engine/v1 JavaScript and WebAssembly ABI versions do not match.");
    }
    this.encoder = new TextEncoder();
    this.roleCodes = new Map();
  }

  get info() {
    return Object.freeze({
      version: ENGINE_VERSION,
      abi: this.exports.physics_abi_version(),
      voxelCapacity: this.exports.voxel_capacity(),
      searchVoxelCapacity: this.exports.search_voxel_capacity(),
      searchNodeCapacity: this.exports.search_node_capacity()
    });
  }

  createState(room) {
    return createEngineStateV1(room);
  }

  roomFromState(state, room) {
    return roomFromEngineStateV1(state, room);
  }

  roleCode(roleId) {
    if (this.roleCodes.has(roleId)) return this.roleCodes.get(roleId);
    const bytes = this.encoder.encode(roleId);
    if (bytes.length > this.exports.role_buffer_capacity()) {
      throw new Error(`Engine role name is too long: ${roleId}`);
    }
    new Uint8Array(
      this.exports.memory.buffer,
      this.exports.role_buffer(),
      bytes.length
    ).set(bytes);
    const code = this.exports.role_code(bytes.length);
    this.roleCodes.set(roleId, code);
    return code;
  }

  writeState(state, definitions) {
    const count = engineVoxelCountV1(state, definitions);
    if (count > this.exports.voxel_capacity()) {
      throw new Error(`engine/v1 supports at most ${this.exports.voxel_capacity()} objects.`);
    }
    const stride = this.exports.voxel_stride();
    const buffer = new Int32Array(
      this.exports.memory.buffer,
      this.exports.voxel_buffer(),
      count * stride
    );
    writeEngineStateV1(engineCollisionStateV1(state, definitions), definitions,
      (roleId) => this.roleCode(roleId), buffer, stride);
    return { buffer, stride, count };
  }

  async simulateCommand(stateOrRoom, direction, definitions) {
    const state = createEngineStateV1(stateOrRoom);
    const { buffer, stride, count } = this.writeState(state, definitions);
    const code = normalizeEngineDirectionV1(direction);
    const readState = () => readEngineStateV1(state, definitions, buffer, stride);
    this.exports.reset_command();
    const frames = [];
    let previousTick = 0;
    for (let iteration = 0; iteration < 100_000; iteration += 1) {
      const status = this.exports.step_command_tick(
        count,
        state.width,
        state.height,
        code
      );
      if (status === -1) throw new Error("engine/v1 rejected invalid command data.");
      if (status === -2) throw new Error("engine/v1 could not find an active player.");
      const tick = this.exports.command_tick();
      if (tick !== previousTick) {
        frames.push(readState());
        previousTick = tick;
      }
      if (status === 0) {
        const final = readState();
        const last = frames.at(-1) || state;
        if (this.exports.command_cycle_detected() || !sameState(last, final)) frames.push(final);
        return {
          direction: ENGINE_V1_DIRECTIONS[code],
          final,
          frames,
          cycle: this.exports.command_cycle_detected()
            ? {
                startTick: this.exports.command_cycle_start_tick(),
                repeatTick: this.exports.command_cycle_repeat_tick(),
                onCycle: "rollback-command"
              }
            : null
        };
      }
    }
    throw new Error("engine/v1 command did not settle within 100,000 ticks.");
  }

  solve(stateOrRoom, definitions, options = {}) {
    const state = createEngineStateV1(stateOrRoom);
    if (engineVoxelCountV1(state, definitions) > this.exports.search_voxel_capacity()) {
      throw new Error(`engine/v1 search supports at most ${this.exports.search_voxel_capacity()} objects.`);
    }
    if (countActiveRoleV1(state, definitions, "player") < 1) {
      throw new Error("Place a player before running a solver.");
    }
    if (countActiveRoleV1(state, definitions, "goal") < 1) {
      throw new Error("Place at least one gem before running a solver.");
    }
    const { count } = this.writeState(state, definitions);
    const capacity = this.exports.search_node_capacity();
    const maximumNodes = Math.max(1, Math.min(
      capacity,
      Math.floor(Number(options.maximumNodes) || capacity)
    ));
    const startedAt = performance.now();
    const statusCode = this.exports.search_solve(
      count,
      state.width,
      state.height,
      maximumNodes
    );
    const solution = [];
    for (let index = 0; index < this.exports.search_solution_length(); index += 1) {
      const directionCode = this.exports.search_solution_step(index);
      solution.push(ENGINE_V1_DIRECTIONS[directionCode]);
    }
    return {
      status: SEARCH_STATUSES[statusCode] || "invalid",
      statusCode,
      proven: statusCode === 1,
      maximumNodes,
      elapsedMs: performance.now() - startedAt,
      moves: this.exports.search_moves(),
      expanded: this.exports.search_expanded(),
      generated: this.exports.search_generated(),
      transpositions: this.exports.search_transpositions(),
      localExpanded: this.exports.search_local_expanded(),
      commandTransitions: this.exports.search_command_transitions(),
      fullPhysicsTransitions: this.exports.search_full_physics_transitions(),
      solution
    };
  }

  findEdges(stateOrRoom, definitions, options = {}) {
    const state = createEngineStateV1(stateOrRoom);
    if (engineVoxelCountV1(state, definitions) > this.exports.search_voxel_capacity()) {
      throw new Error(`engine/v1 search supports at most ${this.exports.search_voxel_capacity()} objects.`);
    }
    if (countActiveRoleV1(state, definitions, "player") < 1) {
      throw new Error("Place a player before finding room edges.");
    }
    const { count } = this.writeState(state, definitions);
    const capacity = this.exports.search_node_capacity();
    const maximumNodes = Math.max(1, Math.min(
      capacity,
      Math.floor(Number(options.maximumNodes) || capacity)
    ));
    const startedAt = performance.now();
    const statusCode = this.exports.search_edges(
      count,
      state.width,
      state.height,
      maximumNodes
    );
    const edgeCount = this.exports.search_edge_count();
    const metrics = {
      expanded: this.exports.search_expanded(),
      generated: this.exports.search_generated(),
      transpositions: this.exports.search_transpositions(),
      localExpanded: this.exports.search_local_expanded(),
      commandTransitions: this.exports.search_command_transitions(),
      fullPhysicsTransitions: this.exports.search_full_physics_transitions()
    };
    const maximumEdges = Math.max(0, Math.min(
      edgeCount,
      Math.floor(Number(options.maximumEdges) || edgeCount)
    ));
    const edges = [];
    for (let index = 0; index < maximumEdges; index += 1) {
      if (this.exports.search_edge_solution(
        index,
        count,
        state.width,
        state.height
      ) !== 1) {
        throw new Error(`engine/v1 could not reconstruct edge ${index}.`);
      }
      const solution = [];
      for (let step = 0; step < this.exports.search_solution_length(); step += 1) {
        solution.push(ENGINE_V1_DIRECTIONS[this.exports.search_solution_step(step)]);
      }
      edges.push({ index, moves: solution.length, solution });
    }
    return {
      status: SEARCH_STATUSES[statusCode] || "invalid",
      statusCode,
      proven: statusCode === 1,
      maximumNodes,
      elapsedMs: performance.now() - startedAt,
      edgeCount,
      truncatedEdges: edgeCount - edges.length,
      edges,
      ...metrics
    };
  }
}

export async function instantiateMazeBenchEngineV1(source) {
  const bytes = source instanceof Response ? await source.arrayBuffer() : source;
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return new MazeBenchEngineV1(instance.exports);
}

let sharedEnginePromise = null;

export function loadMazeBenchEngineV1() {
  if (!sharedEnginePromise) {
    sharedEnginePromise = fetch(new URL("./voxel_physics.wasm", import.meta.url))
      .then((response) => {
        if (!response.ok) throw new Error(`engine/v1 failed to load (${response.status}).`);
        return instantiateMazeBenchEngineV1(response);
      });
  }
  return sharedEnginePromise;
}
