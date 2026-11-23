int32_t simulate_command(
    PhysicsWorkspace* workspace,
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction,
    TickObserver observer,
    void* context) {
  if (state == nullptr) return -1;
  reset_motion_state(state);
  constexpr int32_t kMaximumTicks = 1000000;
  for (int32_t iteration = 0; iteration < kMaximumTicks; ++iteration) {
    const int32_t before_tick = state->tick;
    const TickResult result = step_command_tick(
        workspace, state, voxels, count, width, height, direction);
    if (result == TickResult::kInvalid) return -1;
    if (result == TickResult::kNoPlayer) return -2;
    if (observer != nullptr &&
        (state->tick != before_tick || result == TickResult::kComplete)) {
      observer(voxels, count, state, context);
    }
    if (result == TickResult::kComplete) return 0;
  }
  return -1;
}

int32_t simulate_turn(
    PhysicsWorkspace* workspace,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction) {
  MotionState state;
  return simulate_command(
      workspace, &state, voxels, count, width, height, direction);
}

int32_t simulate_quiescent_turn(
    PhysicsWorkspace* workspace,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction,
    bool passive_already_declined) {
  const int64_t cell_count = static_cast<int64_t>(width) * height;
  if (workspace == nullptr || voxels == nullptr || count < 0 ||
      count > kVoxelCapacity || width <= 0 || height <= 0 ||
      cell_count <= 0 || cell_count > UINT32_MAX ||
      direction < 0 || direction > 3) {
    return -1;
  }
  if (!passive_already_declined) {
    WorkspaceScope workspace_scope(workspace);
    const int32_t passive = TrySimulatePassiveQuiescentTurn(
        voxels, count, width, height, direction, true);
    if (passive > 0) return 0;
    if (passive < 0) return passive;
  }
  WorkspaceData* data = WorkspaceStorage(workspace);
  data->assume_quiescent_start = true;
  MotionState state;
  const int32_t result = simulate_command(
      workspace, &state, voxels, count, width, height, direction);
  data->assume_quiescent_start = false;
  return result;
}

int32_t try_simulate_passive_quiescent_turn(
    PhysicsWorkspace* workspace,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction) {
  const int64_t cell_count = static_cast<int64_t>(width) * height;
  if (workspace == nullptr || voxels == nullptr || count < 0 ||
      count > kVoxelCapacity || width <= 0 || height <= 0 ||
      cell_count <= 0 || cell_count > UINT32_MAX ||
      direction < 0 || direction > 3) {
    return -1;
  }
  WorkspaceScope workspace_scope(workspace);
  return TrySimulatePassiveQuiescentTurn(
      voxels, count, width, height, direction, false);
}

int32_t simulate_turn(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction) {
  static thread_local PhysicsWorkspace workspace;
  static thread_local bool initialized = false;
  if (!initialized) {
    reset_workspace(&workspace);
    initialized = true;
  }
  return simulate_turn(&workspace, voxels, count, width, height, direction);
}
