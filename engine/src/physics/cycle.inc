// simulate_command accepts at most one million ticks, so the history can hold
// every post-tick state in the public command horizon without evicting a
// possible first occurrence.
constexpr int32_t kCycleHistoryCapacity = 1 << 20;
constexpr int32_t kCycleHistoryMask = kCycleHistoryCapacity - 1;

struct CycleHistoryEntry {
  uint64_t hash;
  int32_t tick;
  uint32_t generation;
};

struct CommandCycleTracker {
  Voxel baseline[kVoxelCapacity];
  Voxel replay_voxels[kVoxelCapacity];
  PhysicsWorkspace replay_workspace;
  MotionState replay_state;
  CycleHistoryEntry history[kCycleHistoryCapacity];
  uint32_t generation;
  Voxel* source_voxels;
  MotionState* source_state;
  int32_t count;
  int32_t width;
  int32_t height;
  int32_t initial_direction;
  bool replay_workspace_initialized;
  bool enabled;
  bool pending_rollback;
  bool wait_for_orange_transition;
  bool orange_transition_started;
  bool has_puncher;
  int64_t last_orange_depth_sum;
};

#if defined(__wasm__)
CommandCycleTracker g_command_cycle_tracker{};
#else
thread_local CommandCycleTracker g_command_cycle_tracker{};
#endif

uint64_t CycleHashMix(uint64_t hash, uint32_t value) {
  hash ^= value;
  hash *= UINT64_C(1099511628211);
  hash ^= hash >> 32u;
  return hash;
}

void BuildCanonicalPunchCycleDirections(
    const Voxel* voxels,
    int32_t* directions) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    directions[object] = -1;
  }
  for (int32_t fixture = 0; fixture < g_object_count; ++fixture) {
    if (g_object_kind[fixture] != kMechanismObject) continue;
    const int32_t puncher_index = g_object_head[fixture];
    const Voxel& puncher = voxels[puncher_index];
    const int32_t direction = PuncherDirection(puncher);
    if (direction < 0 || PuncherIsSprung(puncher)) continue;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (!ObjectCanBePunched(object)) continue;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if (voxels[member].x == puncher.x &&
            voxels[member].y == puncher.y &&
            voxels[member].z == puncher.z) {
          // Contact with an unsprung puncher deterministically replaces any
          // incoming momentum on the following tick. Normalize that obsolete
          // value so the visible contact frame is the cycle boundary.
          directions[object] = direction;
          break;
        }
      }
    }
  }
}

int64_t OrangeDepthSum(const Voxel* voxels, int32_t count) {
  int64_t total = 0;
  for (int32_t index = 0; index < count; ++index) {
    if (IsOrangeWallRole(voxels[index].role)) {
      total += OrangeWallDepth(voxels[index]);
    }
  }
  return total;
}

uint64_t CycleStateHash(
    const Voxel* voxels,
    int32_t count,
    const MotionState* state) {
  BuildCanonicalPunchCycleDirections(
      voxels, g_component_indegree);
  // Prepared search scenes keep all moving bodies/mechanisms in a prefix.
  // Immutable terrain need not be rehashed at every tick. Hash matches still
  // replay and compare EVERY voxel and motion flag in SameCycleState, including
  // static goals, so this changes cost rather than cycle equivalence.
  const WorkspaceData& workspace = ActiveWorkspace();
  const int32_t hash_count = workspace.prepared_voxels == voxels &&
          workspace.prepared_count == count && workspace.prepared_index_active
      ? workspace.prepared_dynamic_voxel_count
      : count;
  uint64_t hash = UINT64_C(1469598103934665603);
  for (int32_t index = 0; index < hash_count; ++index) {
    hash = CycleHashMix(hash, static_cast<uint32_t>(voxels[index].x));
    hash = CycleHashMix(hash, static_cast<uint32_t>(voxels[index].y));
    hash = CycleHashMix(hash, static_cast<uint32_t>(voxels[index].z));
    hash = CycleHashMix(hash, voxels[index].role);
    hash = CycleHashMix(hash, static_cast<uint32_t>(voxels[index].generic_id));
  }
  hash = CycleHashMix(hash, static_cast<uint32_t>(state->phase));
  hash = CycleHashMix(hash, static_cast<uint32_t>(state->direction));
  hash = CycleHashMix(hash, static_cast<uint32_t>(state->player_index));
  hash = CycleHashMix(hash, state->player_gravity_armed);
  hash = CycleHashMix(hash, state->player_falling);
  hash = CycleHashMix(hash, state->reserved[0]);
  hash = CycleHashMix(hash, state->reserved[1]);
  for (int32_t index = 0; index < hash_count; ++index) {
    const int32_t object = g_voxel_object[index];
    const int32_t punch_direction = object >= 0
        ? g_component_indegree[object]
        : -1;
    const uint8_t horizontal_momentum = punch_direction >= 0
        ? static_cast<uint8_t>(kPunchMomentumBase + punch_direction)
        : state->horizontal_momentum[index];
    const uint32_t flags = horizontal_momentum |
        (static_cast<uint32_t>(state->falling[index]) << 8u) |
        (static_cast<uint32_t>(state->gravity_armed[index]) << 16u);
    hash = CycleHashMix(hash, flags);
  }
  return hash;
}

bool SameCycleState(
    const Voxel* left_voxels,
    const MotionState* left_state,
    const Voxel* right_voxels,
    const MotionState* right_state,
    int32_t count) {
  BuildCanonicalPunchCycleDirections(
      left_voxels, g_component_indegree);
  BuildCanonicalPunchCycleDirections(
      right_voxels, g_object_queue);
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& left = left_voxels[index];
    const Voxel& right = right_voxels[index];
    const int32_t object = g_voxel_object[index];
    const int32_t left_punch_direction = object >= 0
        ? g_component_indegree[object]
        : -1;
    const int32_t right_punch_direction = object >= 0
        ? g_object_queue[object]
        : -1;
    const uint8_t left_momentum = left_punch_direction >= 0
        ? static_cast<uint8_t>(kPunchMomentumBase + left_punch_direction)
        : left_state->horizontal_momentum[index];
    const uint8_t right_momentum = right_punch_direction >= 0
        ? static_cast<uint8_t>(kPunchMomentumBase + right_punch_direction)
        : right_state->horizontal_momentum[index];
    if (left.x != right.x || left.y != right.y || left.z != right.z ||
        left.role != right.role || left.generic_id != right.generic_id ||
        left_momentum != right_momentum ||
        left_state->falling[index] != right_state->falling[index] ||
        left_state->gravity_armed[index] !=
            right_state->gravity_armed[index]) {
      return false;
    }
  }
  return left_state->phase == right_state->phase &&
      left_state->direction == right_state->direction &&
      left_state->player_index == right_state->player_index &&
      left_state->player_gravity_armed == right_state->player_gravity_armed &&
      left_state->player_falling == right_state->player_falling &&
      left_state->reserved[0] == right_state->reserved[0] &&
      left_state->reserved[1] == right_state->reserved[1];
}

bool BaselineCycleStateMatches(
    const CommandCycleTracker& tracker,
    const Voxel* voxels,
    const MotionState* state) {
  if (state->direction != tracker.initial_direction ||
      (state->phase != kMotionPlayerIce &&
       state->phase != kMotionObjectIce &&
       !IsPlayerPunchPhase(state->phase)) ||
      state->player_falling != 0) {
    return false;
  }
  for (int32_t index = 0; index < tracker.count; ++index) {
    const Voxel& baseline = tracker.baseline[index];
    const Voxel& current = voxels[index];
    if (baseline.x != current.x || baseline.y != current.y ||
        baseline.z != current.z || baseline.role != current.role ||
        baseline.generic_id != current.generic_id || state->falling[index] != 0 ||
        (state->gravity_armed[index] & kLiftContinuationMask) != 0) {
      return false;
    }
  }
  return true;
}

void BeginCommandCycleTracking(
    PhysicsWorkspace* workspace,
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction) {
  CommandCycleTracker& tracker = g_command_cycle_tracker;
  tracker.enabled = false;
  tracker.pending_rollback = false;
  tracker.wait_for_orange_transition = false;
  tracker.orange_transition_started = false;
  tracker.has_puncher = false;
  tracker.last_orange_depth_sum = OrangeDepthSum(voxels, count);
  tracker.source_voxels = voxels;
  tracker.source_state = state;
  tracker.count = count;
  tracker.width = width;
  tracker.height = height;
  tracker.initial_direction = direction;

  bool has_slope = false;
  bool has_orange_mechanism = false;
  bool has_puncher = false;
  const WorkspaceData* workspace_data = workspace == nullptr
      ? nullptr
      : WorkspaceStorage(workspace);
  if (workspace_data != nullptr && workspace_data->prepared_voxels == voxels &&
      workspace_data->prepared_count == count &&
      workspace_data->prepared_width == width &&
      workspace_data->prepared_height == height) {
    has_slope = workspace_data->prepared_has_ice_slopes;
    has_orange_mechanism =
        workspace_data->prepared_has_orange_mechanisms;
    has_puncher = workspace_data->prepared_has_punchers;
  } else {
    for (int32_t index = 0; index < count; ++index) {
      has_slope |= IsIceSlopeRole(voxels[index].role);
      has_orange_mechanism |=
          voxels[index].role == kOrangeButtonRole ||
          IsOrangeWallRole(voxels[index].role);
      has_puncher |= voxels[index].role == kPuncherRole;
    }
  }
  if (!has_slope && !has_orange_mechanism && !has_puncher) return;
  tracker.wait_for_orange_transition =
      has_orange_mechanism && !has_slope && !has_puncher;
  tracker.has_puncher = has_puncher;

  for (int32_t index = 0; index < count; ++index) {
    tracker.baseline[index] = voxels[index];
    // Independent scopes may raise and lower simultaneously, cancelling the
    // aggregate depth delta. Use exact state repetition directly in that case.
    if (HasOrangeScope(voxels[index])) tracker.wait_for_orange_transition = false;
  }
  if (!tracker.replay_workspace_initialized) {
    reset_workspace(&tracker.replay_workspace);
    tracker.replay_workspace_initialized = true;
  }
  ++tracker.generation;
  if (tracker.generation == 0) {
    for (int32_t index = 0; index < kCycleHistoryCapacity; ++index) {
      tracker.history[index].generation = 0;
    }
    tracker.generation = 1;
  }
  tracker.enabled = true;
}

bool ReplayMatchesCycleTick(
    CommandCycleTracker& tracker,
    int32_t tick,
    const Voxel* current_voxels,
    const MotionState* current_state) {
  for (int32_t index = 0; index < tracker.count; ++index) {
    tracker.replay_voxels[index] = tracker.baseline[index];
  }
  reset_motion_state(&tracker.replay_state);
  int32_t iterations = 0;
  while (tracker.replay_state.tick < tick && iterations < 1000000) {
    const TickResult result = step_tick(
        &tracker.replay_workspace,
        &tracker.replay_state,
        tracker.replay_voxels,
        tracker.count,
        tracker.width,
        tracker.height,
        tracker.initial_direction);
    if (result == TickResult::kInvalid || result == TickResult::kNoPlayer ||
        result == TickResult::kComplete) {
      return false;
    }
    ++iterations;
  }
  return tracker.replay_state.tick == tick && SameCycleState(
      tracker.replay_voxels,
      &tracker.replay_state,
      current_voxels,
      current_state,
      tracker.count);
}

int32_t FindOrRecordCycleState(
    CommandCycleTracker& tracker,
    Voxel* voxels,
    MotionState* state) {
  if (BaselineCycleStateMatches(tracker, voxels, state)) return 0;
  if (state->tick == 1 && !tracker.has_puncher) {
    // Tick one contains the commanded actor transition. A level-wide
    // autonomous cycle begins only after that input has seeded the motion;
    // otherwise an actuator which revisits the post-input state reports a
    // cycle one tick earlier than the repeating autonomous interval.
    return -1;
  }
  const uint64_t hash = CycleStateHash(voxels, tracker.count, state);
  int32_t slot = static_cast<int32_t>(
      hash & static_cast<uint64_t>(kCycleHistoryMask));
  for (int32_t probe = 0; probe < kCycleHistoryCapacity; ++probe) {
    CycleHistoryEntry& entry = tracker.history[slot];
    if (entry.generation != tracker.generation) {
      entry = {hash, state->tick, tracker.generation};
      return -1;
    }
    if (entry.hash == hash && ReplayMatchesCycleTick(
            tracker, entry.tick, voxels, state)) {
      return entry.tick;
    }
    slot = (slot + 1) & kCycleHistoryMask;
  }
  tracker.enabled = false;
  return -1;
}

void RestoreCycleBaseline(
    PhysicsWorkspace* workspace,
    CommandCycleTracker& tracker,
    MotionState* state,
    Voxel* voxels) {
  for (int32_t index = 0; index < tracker.count; ++index) {
    voxels[index] = tracker.baseline[index];
    state->horizontal_momentum[index] = 0;
    state->falling[index] = 0;
    state->gravity_armed[index] = 0;
  }
  state->phase = kMotionComplete;
  state->direction = tracker.initial_direction;
  state->player_gravity_armed = 0;
  state->player_falling = 0;
  state->reserved[0] = 0;
  state->reserved[1] = 0;
  WorkspaceData* data = WorkspaceStorage(workspace);
  data->continuation_state = nullptr;
  data->continuation_voxels = nullptr;
  data->continuation_tick = -1;
  tracker.pending_rollback = false;
  tracker.enabled = false;
}
