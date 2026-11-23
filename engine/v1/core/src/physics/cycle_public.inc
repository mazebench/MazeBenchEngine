TickResult step_command_tick(
    PhysicsWorkspace* workspace,
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction) {
  if (workspace == nullptr || state == nullptr || voxels == nullptr) {
    return TickResult::kInvalid;
  }
  CommandCycleTracker& tracker = g_command_cycle_tracker;
  if (tracker.pending_rollback && tracker.source_state == state &&
      tracker.source_voxels == voxels && tracker.count == count) {
    RestoreCycleBaseline(workspace, tracker, state, voxels);
    return TickResult::kComplete;
  }
  if (state->direction < 0) {
    BeginCommandCycleTracking(
        workspace, state, voxels, count, width, height, direction);
  }

  const int32_t before_tick = state->tick;
  const int32_t before_phase = state->phase;
  const TickResult result = step_tick(
      workspace, state, voxels, count, width, height, direction);
  if (!tracker.enabled || tracker.source_state != state ||
      tracker.source_voxels != voxels) {
    return result;
  }
  WorkspaceScope post_tick_workspace_scope(workspace);
  if (tracker.wait_for_orange_transition) {
    const int64_t current_depth_sum = OrangeDepthSum(voxels, count);
    if (before_phase == kMotionOrangeMechanisms &&
        current_depth_sum != tracker.last_orange_depth_sum) {
      const bool lowering =
          current_depth_sum > tracker.last_orange_depth_sum;
      int32_t target_depths[kOrangeScopeCount];
      CountPressedOrangeButtons(voxels, count, width, height, target_depths);
      for (int32_t index = 0; index < count; ++index) {
        if (voxels[index].role != kOrangeWallRole) continue;
        const int32_t depth = OrangeWallDepth(voxels[index]);
        const int32_t target_depth = target_depths[OrangeScope(voxels[index])];
        if ((lowering && depth > target_depth) ||
            (!lowering && depth < target_depth)) {
          // The pressure changed across this mechanism step, so the next
          // actuator proposal reverses direction. This turning state is the
          // canonical beginning of an Orange-only autonomous cycle.
          tracker.orange_transition_started = true;
          break;
        }
      }
    }
    tracker.last_orange_depth_sum = current_depth_sum;
  }
  if (state->tick != before_tick) {
    const int32_t cycle_start = tracker.wait_for_orange_transition &&
            !tracker.orange_transition_started
        ? -1
        : FindOrRecordCycleState(tracker, voxels, state);
    if (cycle_start >= 0) {
      state->cycle_start_tick = cycle_start;
      state->cycle_repeat_tick = state->tick;
      tracker.pending_rollback = true;
      return TickResult::kMore;
    }
  }
  if (result == TickResult::kComplete || result == TickResult::kInvalid ||
      result == TickResult::kNoPlayer) {
    tracker.enabled = false;
  }
  return result;
}
