bool VoxelWillLandOnSlope(
    Voxel* voxels,
    int32_t count,
    const Voxel& voxel,
    int32_t ignored_object,
    int32_t width) {
  const int32_t support = FindNearestVoxelBelow(
      voxels, count, voxel.x, voxel.y, voxel.z, ignored_object, width);
  return support >= 0 && IsIceSlopeRole(voxels[support].role);
}

bool MovingObjectWillLandOnSlope(
    Voxel* voxels,
    int32_t count,
    int32_t width) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0) continue;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (VoxelWillLandOnSlope(
              voxels, count, voxels[member], object, width)) {
        return true;
      }
    }
  }
  return false;
}

void SettleAllObjects(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height) {
  ClearMovingObjects();
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_moving_objects[object] = 1;
  }
  SettleFlaggedObjects(voxels, count, width, height);
}

bool ObjectsNeedGravityTick(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    bool rebuild_spatial_index = true) {
  // Carrier rejection can restore a body after an earlier translation built
  // the index. Rebuild here so the final quiescence decision never observes a
  // ghost support at a body's former coordinate.
  if (rebuild_spatial_index) {
    BuildSpatialIndex(voxels, count, width, height);
  }
  // Settle flags propagate through a support stack to a fixed point. A single
  // pass left an extra blank animation tick when upper bodies happened to be
  // stored before their newly landed supports.
  bool cleared_falling;
  bool needs_tick;
  do {
    cleared_falling = false;
    needs_tick = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (!ObjectIsActive(voxels, object, width, height)) continue;
      if ((ObjectIsFloatingFloor(voxels, object) &&
           g_object_gravity_armed[object] == 0) ||
          ObjectIsUnarmedPlayerLift(voxels, object)) {
        continue;
      }
      // A vertically interlocked component can give every member apparent
      // direct support even while the entire component is falling. The settle
      // pass owns the decision to clear this flag when the component lands.
      if (g_object_gravity_armed[object] != 0 &&
          g_object_falling[object] != 0) {
        if (ObjectHasStableDirectSupport(
                voxels, object, width, height)) {
          g_object_falling[object] = 0;
          cleared_falling = true;
          continue;
        }
        needs_tick = true;
        continue;
      }
      if (ObjectHasDirectSupport(voxels, object, width, height)) {
        g_object_falling[object] = 0;
        g_object_gravity_armed[object] = 1;
        continue;
      }
      // A command is not quiescent while an active body is unsupported. This
      // also catches a carried body that was rejected after its support moved:
      // it must begin falling in the current command, not remain suspended until
      // the next input happens to initialize gravity again.
      g_object_gravity_armed[object] = 1;
      g_object_falling[object] = 1;
      needs_tick = true;
    }
    if (cleared_falling && needs_tick) {
      for (int32_t object = 0; object < g_object_count; ++object) {
        if (g_object_falling[object] != 0 &&
            BuildVerticalComponent(voxels, object, width, height) > 1 &&
            ComponentContainsSupportCycle(voxels, width, height)) {
          // Mutual support cannot prove stability. The component gravity pass
          // must resolve its external supports before any flags propagate.
          return true;
        }
      }
    }
  } while (cleared_falling && needs_tick);
  return needs_tick;
}

bool ObjectsAdvancedThisTick() {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_fell_objects[object] != 0) return true;
  }
  return false;
}
