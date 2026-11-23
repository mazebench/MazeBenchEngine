void reset_workspace(PhysicsWorkspace* workspace) {
  if (workspace == nullptr) return;
  WorkspaceData* data = WorkspaceStorage(workspace);
  data->hash_generation = 1;
  data->static_hash_generation = 1;
  data->dynamic_column_generation = 1;
  data->object_count = 0;
  data->weightless_object_count = 0;
  data->room_grid_width = 0;
  data->room_grid_height = 0;
  for (int32_t index = 0; index < kVoxelCapacity / 64; ++index) {
    data->slope_push_seen[index] = 0;
    data->slope_push_pending[index] = 0;
  }
  data->dense_columns = false;
  data->linear_spatial = false;
  data->spatial_voxel_count = 0;
  data->moving_objects_fell = false;
  data->ignored_support_voxel = -1;
  data->continuation_state = nullptr;
  data->continuation_voxels = nullptr;
  data->continuation_tick = -1;
  data->prepared_voxels = nullptr;
  data->prepared_count = 0;
  data->prepared_width = 0;
  data->prepared_height = 0;
  data->prepared_dynamic_voxel_count = -1;
  data->prepared_player_index = -1;
  data->prepared_goal_count = 0;
  data->prepared_dense_columns = false;
  data->prepared_has_ice_slopes = false;
  data->prepared_has_player_lifts = false;
  data->prepared_has_orange_mechanisms = false;
  data->prepared_has_punchers = false;
  data->prepared_has_floating_floors = false;
  data->prepared_has_clones = false;
  data->prepared_has_player_polycube = false;
  data->scene_has_orange_mechanisms = false;
  data->scene_has_player_gates = false;
  data->clone_command_tick_active = false;
  data->assume_quiescent_start = false;
  data->motion_voxel_count = -1;
  data->prepared_index_active = false;
  for (int32_t index = 0; index < kHashCapacity; ++index) {
    data->hash_entries[index].stamp = 0;
    data->static_hash_entries[index].stamp = 0;
  }
  for (int32_t cell = 0; cell < kDenseColumnCapacity; ++cell) {
    data->dynamic_column_stamps[cell] = 0;
  }
}

bool prepare_scene(
    PhysicsWorkspace* workspace,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_voxel_count) {
  const int64_t cell_count = static_cast<int64_t>(width) * height;
  if (workspace == nullptr || voxels == nullptr || count < 0 ||
      count > kVoxelCapacity || width <= 0 || height <= 0 ||
      cell_count <= 0 || cell_count > UINT32_MAX ||
      dynamic_voxel_count < 0 || dynamic_voxel_count > count) {
    return false;
  }
  WorkspaceScope workspace_scope(workspace);
  WorkspaceData& data = ActiveWorkspace();
  data.prepared_voxels = nullptr;
  data.prepared_index_active = false;
  for (int32_t index = dynamic_voxel_count; index < count; ++index) {
    const uint32_t role = voxels[index].role;
    if (role == kPlayerRole || IsCloneObjectRole(role) ||
        role == kPushableRole || IsWeightlessObjectRole(role) ||
        role == kPlayerLiftRole || role == kPlayerGateRole ||
        role == kOrangeButtonRole || role == kOrangeWallRole ||
        role == kPuncherRole || role == kFloatingFloorRole) {
      data.prepared_dynamic_voxel_count = -1;
      return false;
    }
  }
  BuildObjects(voxels, count);
  data.prepared_player_index = -1;
  data.prepared_goal_count = 0;
  data.prepared_has_ice_slopes = false;
  data.prepared_has_player_lifts = false;
  data.prepared_has_orange_mechanisms = false;
  data.prepared_has_punchers = false;
  data.prepared_has_floating_floors = false;
  data.prepared_has_clones = false;
  data.prepared_has_player_polycube = false;
  int32_t player_count = 0;
  for (int32_t index = 0; index < count; ++index) {
    data.prepared_has_ice_slopes |= IsIceSlopeRole(voxels[index].role);
    data.prepared_has_player_lifts |= voxels[index].role == kPlayerLiftRole;
    data.prepared_has_orange_mechanisms |=
        voxels[index].role == kOrangeButtonRole ||
        voxels[index].role == kOrangeWallRole;
    data.prepared_has_punchers |= voxels[index].role == kPuncherRole;
    data.prepared_has_floating_floors |=
        voxels[index].role == kFloatingFloorRole;
    data.prepared_has_clones |= IsCloneObjectRole(voxels[index].role);
    player_count += voxels[index].role == kPlayerRole ? 1 : 0;
    if (voxels[index].role == kGoalRole) {
      data.prepared_goal_indices[data.prepared_goal_count++] = index;
    }
  }
  for (int32_t index = 0; index < dynamic_voxel_count; ++index) {
    if (voxels[index].role != kPlayerRole) continue;
    if (data.prepared_player_index < 0) data.prepared_player_index = index;
  }
  if (data.prepared_player_index < 0) return false;
  data.prepared_has_player_polycube = player_count > 1;
  ResetStaticHash();
  data.prepared_dense_columns = cell_count <= kDenseColumnCapacity;
  if (data.prepared_dense_columns) {
    for (int32_t cell = 0; cell < static_cast<int32_t>(cell_count); ++cell) {
      g_static_column_heads[cell] = -1;
    }
  }
  if (!data.prepared_has_orange_mechanisms) {
    for (int32_t index = dynamic_voxel_count; index < count; ++index) {
      g_next_static_column_voxel[index] = -1;
      const Voxel& voxel = voxels[index];
      if (IsOrdinaryPassThroughVoxel(voxel) ||
          !IsInsideRoom(voxel.x, voxel.y, width, height)) continue;
      if (!StaticHashInsert(
              SpatialKey(voxel.x, voxel.y, voxel.z, width), index)) {
        data.prepared_dynamic_voxel_count = -1;
        return false;
      }
      if (data.prepared_dense_columns) {
        const int32_t cell = voxel.y * width + voxel.x;
        g_next_static_column_voxel[index] = g_static_column_heads[cell];
        g_static_column_heads[cell] = index;
      }
    }
  } else {
    for (int32_t index = dynamic_voxel_count; index < count; ++index) {
      g_next_static_column_voxel[index] = -1;
      const Voxel& voxel = voxels[index];
      if (!VoxelBlocksSpace(voxels, count, index) ||
          !IsInsideRoom(voxel.x, voxel.y, width, height)) continue;
      if (!StaticHashInsert(
              SpatialKey(
                  voxel.x,
                  voxel.y,
                  VoxelPhysicalZ(voxels, count, index),
                  width),
              index)) {
        data.prepared_dynamic_voxel_count = -1;
        return false;
      }
      if (data.prepared_dense_columns) {
        const int32_t cell = voxel.y * width + voxel.x;
        g_next_static_column_voxel[index] = g_static_column_heads[cell];
        g_static_column_heads[cell] = index;
      }
    }
  }
  data.prepared_voxels = voxels;
  data.prepared_count = count;
  data.prepared_width = width;
  data.prepared_height = height;
  data.prepared_dynamic_voxel_count = dynamic_voxel_count;
  data.assume_quiescent_start = false;
  data.continuation_state = nullptr;
  data.continuation_voxels = nullptr;
  data.continuation_tick = -1;
  return true;
}

bool prepare_quiescent_snapshot(
    PhysicsWorkspace* workspace,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height) {
  if (workspace == nullptr || voxels == nullptr) return false;
  WorkspaceScope workspace_scope(workspace);
  if (!IsPreparedScene(voxels, count, width, height)) return false;
  ResetObjectMotion();
  if (ActiveWorkspace().prepared_has_floating_floors) {
    // Filling a hole changes a Floating Floor entity into static Floor. Search
    // restores both forms into the same prepared buffer, so rebuild the small
    // dynamic object map before each restored candidate.
    BuildObjects(voxels, ActiveWorkspace().prepared_dynamic_voxel_count);
  }
  BuildSpatialIndex(voxels, count, width, height);
  return true;
}

uint32_t hash_role(const uint8_t* bytes, int32_t length) {
  if (bytes == nullptr || length < 0) return 0;
  uint32_t hash = 2166136261u;
  for (int32_t index = 0; index < length; ++index) {
    hash = (hash ^ bytes[index]) * 16777619u;
  }
  return hash;
}

void reset_motion_state(MotionState* state) {
  if (state == nullptr) return;
  state->version = kMotionStateVersion;
  state->phase = kMotionReady;
  state->direction = -1;
  state->tick = 0;
  state->voxel_count = 0;
  state->player_index = -1;
  state->player_gravity_armed = 0;
  state->player_falling = 0;
  state->reserved[0] = 0;
  state->reserved[1] = 0;
  state->cycle_start_tick = -1;
  state->cycle_repeat_tick = -1;
}
