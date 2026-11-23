bool PlayerGateBlockingActor(uint32_t role) {
  // Floating Floors use the same push/collision semantics as ordinary boxes
  // until they fill a hole. They also keep an occupied gate from rising.
  return role == kPushableRole || role == kFloatingFloorRole ||
      IsWeightlessObjectRole(role);
}

bool IsPlayerGateTrigger(uint32_t role) {
  return role == kPlayerRole || IsCloneObjectRole(role);
}

bool PlayerGateShouldBeRaised(
    Voxel* voxels,
    int32_t count,
    int32_t gate_index,
    int32_t width,
    int32_t height) {
  const Voxel& gate = voxels[gate_index];
  bool same_level_block = false;
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& candidate = voxels[index];
    if (!PlayerGateBlockingActor(candidate.role) ||
        !IsInsideRoom(candidate.x, candidate.y, width, height)) {
      continue;
    }
    same_level_block |= candidate.x == gate.x && candidate.y == gate.y &&
        candidate.z == gate.z;
  }
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& actor = voxels[index];
    if (!IsPlayerGateTrigger(actor.role) ||
        !IsInsideRoom(actor.x, actor.y, width, height) ||
        actor.z == INT32_MIN) {
      continue;
    }
    const int64_t delta_x = static_cast<int64_t>(actor.x) - gate.x;
    const int64_t delta_y = static_cast<int64_t>(actor.y) - gate.y;
    const int64_t distance =
        (delta_x < 0 ? -delta_x : delta_x) +
        (delta_y < 0 ? -delta_y : delta_y);
    const int64_t height_above_gate =
        static_cast<int64_t>(actor.z) - gate.z;
    const bool overlaps_lowered_plate =
        distance == 0 && height_above_gate == 0;
    if (distance <= 1 && height_above_gate >= 0 &&
        height_above_gate <= 1 && !overlaps_lowered_plate &&
        (height_above_gate != 0 || !same_level_block)) {
      return true;
    }
  }
  return false;
}

bool PlayerGatesNeedTick(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height) {
  if (!ActiveWorkspace().scene_has_player_gates) return false;
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& gate = voxels[index];
    if (gate.role != kPlayerGateRole ||
        !IsInsideRoom(gate.x, gate.y, width, height)) {
      continue;
    }
    if ((gate.generic_id == 1) != PlayerGateShouldBeRaised(
            voxels, count, index, width, height)) {
      return true;
    }
  }
  return false;
}

// Red gates react on the animation tick after actor movement. This deliberate
// delay leaves the movement frame visible before the plate rises or cube falls.
bool RefreshPlayerGates(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height) {
  if (!ActiveWorkspace().scene_has_player_gates) return false;
  bool changed = false;
  for (int32_t gate_index = 0; gate_index < count; ++gate_index) {
    Voxel& gate = voxels[gate_index];
    if (gate.role != kPlayerGateRole ||
        !IsInsideRoom(gate.x, gate.y, width, height)) {
      continue;
    }
    const bool raised = PlayerGateShouldBeRaised(
        voxels, count, gate_index, width, height);
    const int32_t next_state = raised ? 1 : 0;
    if (gate.generic_id != next_state) {
      gate.generic_id = next_state;
      changed = true;
    }
  }
  return changed;
}
