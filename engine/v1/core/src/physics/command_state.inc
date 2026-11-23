constexpr int32_t kMotionReady = 0;
constexpr int32_t kMotionPlayerIce = 1;
constexpr int32_t kMotionObjectIce = 2;
constexpr int32_t kMotionGravity = 3;
constexpr int32_t kMotionComplete = 4;
constexpr int32_t kMotionPlayerLift = 5;
constexpr int32_t kMotionOrangeMechanisms = 6;
constexpr int32_t kMotionPlayerPunch = 7;
constexpr int32_t kMotionPlayerPunchUp = 8;
constexpr int32_t kMotionPlayerPunchDown = 9;
constexpr int32_t kMotionPlayerGates = 10;
constexpr int32_t kMotionActorLift = 11;
constexpr int32_t kMotionVacatedLift = 12;
constexpr uint8_t kResumeNothing = 0;
constexpr uint8_t kResumePlayerIce = 1;
constexpr uint8_t kResumeObjectIce = 2;
constexpr uint8_t kResumeCommand = 3;

constexpr uint8_t kPunchMomentumBase = 9;
constexpr uint8_t kLatentPunchMomentumBase = 13;

bool IsPunchMomentum(uint8_t momentum) {
  return momentum >= kPunchMomentumBase &&
      momentum < kLatentPunchMomentumBase + 4;
}

bool IsPlayerPunchPhase(int32_t phase) {
  return phase == kMotionPlayerPunch ||
      phase == kMotionPlayerPunchUp ||
      phase == kMotionPlayerPunchDown;
}

bool IsLatentMomentum(uint8_t momentum) {
  return (momentum >= 5 && momentum <= 8) ||
      momentum >= kLatentPunchMomentumBase;
}

uint8_t ReadObjectFlag(
    const uint8_t* flags,
    int32_t object) {
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    if ((flags[member] & 1u) != 0) return 1;
  }
  return 0;
}

uint8_t ReadObjectMomentum(
    const uint8_t* flags,
    int32_t object) {
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    if (flags[member] != 0) return flags[member];
  }
  return 0;
}

void LoadObjectMotion(const MotionState* state) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_object_falling[object] = ReadObjectFlag(state->falling, object);
    g_object_gravity_armed[object] =
        ReadObjectFlag(state->gravity_armed, object);
  }
}

void StoreObjectMotion(MotionState* state, int32_t count,
                       bool preserve_lift_entries = true) {
  const int32_t motion_count = MotionVoxelCount(count);
  for (int32_t index = 0; index < motion_count; ++index) {
    state->falling[index] = 0;
    state->gravity_armed[index] = preserve_lift_entries
        ? state->gravity_armed[index] & kLiftContinuationMask : 0;
  }
  for (int32_t object = 0; object < g_object_count; ++object) {
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      state->falling[member] = g_object_falling[object];
      state->gravity_armed[member] |= g_object_gravity_armed[object];
    }
  }
}

void ClearHorizontalMomentum(MotionState* state, int32_t count) {
  const int32_t motion_count = MotionVoxelCount(count);
  for (int32_t index = 0; index < motion_count; ++index) {
    state->horizontal_momentum[index] = 0;
  }
}

void ClearImmutableMotionSuffix(MotionState* state, int32_t count) {
  // Prepared scenes keep immutable terrain after the dynamic prefix. Physics
  // never reads motion for that suffix, but MotionState is public and
  // serializable, so initialize the exposed bytes once per command.
  const int32_t motion_count = MotionVoxelCount(count);
  for (int32_t index = motion_count; index < count; ++index) {
    state->horizontal_momentum[index] = 0;
    state->falling[index] = 0;
    state->gravity_armed[index] = 0;
  }
}

void StoreMandatoryMomentum(
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t fallback_direction) {
  ClearHorizontalMomentum(state, count);
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0 ||
        g_object_kind[object] == kMechanismObject ||
        !ObjectIsActive(voxels, object, width, height)) {
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const int32_t direction = g_object_direction[object] <= 3
          ? g_object_direction[object]
          : fallback_direction;
      state->horizontal_momentum[member] =
          static_cast<uint8_t>(direction + 1);
    }
  }
}

bool FloatingFloorHasIceDrivenActorBehind(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  if (!ObjectIsFloatingFloor(voxels, object) ||
      g_object_direction[object] > 3) {
    return false;
  }
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  const int32_t direction = g_object_direction[object];
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const int32_t behind = FindVoxelAt(
        voxels,
        voxels[member].x - kDx[direction],
        voxels[member].y - kDy[direction],
        voxels[member].z,
        width,
        height);
    if (behind < 0 ||
        (voxels[behind].role != kPlayerRole &&
         !IsCloneObjectRole(voxels[behind].role))) {
      continue;
    }
    if (IsSupportedByIce(voxels, voxels[behind], width, height)) {
      return true;
    }
  }
  return false;
}

bool StoreSupportedMandatoryMomentum(
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t fallback_direction) {
  // Snapshot the incoming serialized momentum before replacing it. A body
  // can land on a lower slope during the gravity half of this very tick; it
  // is no longer marked falling or mandatory by then, but its saved direction
  // must resume on the newly reached ramp.
  const uint8_t player_punch = g_voxel_object[state->player_index] < 0
      ? state->horizontal_momentum[state->player_index] : 0;
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_object_redirected[object] = ReadObjectMomentum(
        state->horizontal_momentum, object);
  }
  ClearHorizontalMomentum(state, count);
  if (IsPunchMomentum(player_punch)) {
    state->horizontal_momentum[state->player_index] = player_punch;
  }
  bool stored = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_object_kind[object] == kMechanismObject ||
        !ObjectIsActive(voxels, object, width, height)) {
      continue;
    }
    const bool punch_momentum = IsPunchMomentum(g_object_redirected[object]);
    const bool ice_driven_floating_floor =
        FloatingFloorHasIceDrivenActorBehind(
            voxels, object, width, height);
    const bool supported_momentum =
        (g_inherited_support_motion[object] != 0 ||
         g_mandatory_objects[object] != 0 ||
         g_object_redirected[object] != 0) &&
        (punch_momentum || g_inherited_support_motion[object] != 0 ||
         ObjectIsFullyOnIce(voxels, object, width, height) ||
         ice_driven_floating_floor);
    bool supported_by_momentum_body = false;
    bool supported_by_nonfalling_momentum_body = false;
    uint8_t supporting_momentum_direction = UINT8_MAX;
    if (!supported_momentum && g_object_redirected[object] != 0) {
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const Voxel& voxel = voxels[member];
        const int32_t support = FindVoxelAt(
            voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
        if (support < 0) continue;
        const int32_t support_object = g_voxel_object[support];
        if (support_object >= 0 && support_object != object &&
            g_object_redirected[support_object] != 0) {
          supported_by_momentum_body = true;
          supported_by_nonfalling_momentum_body |=
              g_object_falling[support_object] == 0;
          if (g_object_falling[support_object] == 0 &&
              g_object_direction[support_object] <= 3) {
            supporting_momentum_direction =
                g_object_direction[support_object];
          }
        }
      }
    }
    const bool moved_with_momentum_body =
        supported_by_nonfalling_momentum_body &&
        g_mandatory_objects[object] != 0 &&
        // Carried passengers already receive continuing momentum through
        // PreserveSlopeCarriedMomentum. The carrier's incoming momentum may
        // have ended on ordinary terrain this tick; it must not grant the
        // passenger another active step off the now-stationary stack.
        g_carried_objects[object] == 0;
    bool falling_toward_slope = false;
    if (!supported_momentum && g_object_falling[object] != 0) {
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if (VoxelWillLandOnSlope(
                voxels, count, voxels[member], object, width)) {
          falling_toward_slope = true;
          break;
        }
      }
    }
    if (!supported_momentum && !falling_toward_slope &&
        !supported_by_momentum_body) {
      continue;
    }
    stored |= supported_momentum || moved_with_momentum_body;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const int32_t direction =
          moved_with_momentum_body && supporting_momentum_direction <= 3
          ? supporting_momentum_direction
          : g_object_direction[object] <= 3
              ? g_object_direction[object]
              : fallback_direction;
      const bool moving = supported_momentum || moved_with_momentum_body;
      state->horizontal_momentum[member] = static_cast<uint8_t>(direction +
          (punch_momentum
              ? moving ? kPunchMomentumBase : kLatentPunchMomentumBase
              : moving ? 1 : 5));
    }
  }
  return stored;
}

void RestoreMandatoryMomentum(
    const MotionState* state,
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  ClearMovingObjects();
  for (int32_t object = 0; object < g_object_count; ++object) {
    const uint8_t momentum = ReadObjectMomentum(
        state->horizontal_momentum, object);
    if (momentum == 0) {
      g_object_direction[object] = UINT8_MAX;
      continue;
    }
    g_mandatory_objects[object] = 1;
    g_moving_objects[object] = 1;
    g_object_direction[object] = static_cast<uint8_t>((momentum - 1) & 3);
    if ((IsLatentMomentum(momentum) && !IsPunchMomentum(momentum) &&
         !ObjectIsFullyOnIce(voxels, object, width, height)) ||
        g_object_falling[object] != 0) {
      // Momentum remains serialized while a body falls toward a lower slope,
      // but it is not a horizontal proposal until the body lands.
      g_mandatory_objects[object] = 0;
      g_moving_objects[object] = 0;
    }
  }
}

void CancelConflictingLandedSlopeMomentum(
    MotionState* state,
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  // A rigid body landing across slopes with different downhill directions is
  // stable. Its pre-fall direction cannot choose one supporting wedge over
  // another. A later deliberate push may still move the body transactionally.
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0 ||
        !ObjectHasConflictingSlopeSupports(
            voxels, object, width, height)) {
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      state->horizontal_momentum[member] = 0;
    }
    g_mandatory_objects[object] = 0;
    g_moving_objects[object] = 0;
  }
}

bool StoredMomentumWillLandOnSlope(
    const MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (ReadObjectMomentum(state->horizontal_momentum, object) == 0 ||
        g_object_falling[object] == 0) {
      continue;
    }
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

struct RiderSnapshot {
  int32_t object = -1;
  int32_t member = -1;
  int32_t x = 0;
  int32_t y = 0;
  int32_t z = 0;
};

RiderSnapshot CapturePlayerRider(
    Voxel* voxels,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  RiderSnapshot rider;
  const Voxel& player = voxels[player_index];
  if (player.z == INT32_MIN) return rider;
  const int32_t support = FindVoxelAt(
      voxels, player.x, player.y, player.z - 1, width, height);
  if (support < 0 || g_voxel_object[support] < 0) return rider;
  // Internal cells of a player polycube are part of the same rigid body.
  // Treating one as a separate carrier translates the representative twice
  // and tears the player apart when storage happens to list an upper cell first.
  if (g_voxel_object[support] == g_voxel_object[player_index]) return rider;
  rider.object = g_voxel_object[support];
  rider.member = g_object_head[rider.object];
  rider.x = voxels[rider.member].x;
  rider.y = voxels[rider.member].y;
  rider.z = voxels[rider.member].z;
  return rider;
}

bool MovePlayerWithRider(
    Voxel* voxels,
    int32_t player_index,
    const RiderSnapshot& rider,
    int32_t width,
    int32_t height) {
  if (rider.object < 0 || g_moving_objects[rider.object] == 0 ||
      !ObjectIsActive(voxels, rider.object, width, height)) {
    return false;
  }
  voxels[player_index].x += voxels[rider.member].x - rider.x;
  voxels[player_index].y += voxels[rider.member].y - rider.y;
  voxels[player_index].z += voxels[rider.member].z - rider.z;
  return true;
}

void InitializeMotion(
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t player_index,
    int32_t direction) {
  state->version = kMotionStateVersion;
  state->phase = kMotionReady;
  state->direction = direction;
  state->tick = 0;
  state->voxel_count = count;
  state->player_index = player_index;
  state->player_gravity_armed = 0;
  state->player_falling = 0;
  state->reserved[0] = kResumeNothing;
  state->reserved[1] = 0;
  // reserved[1] stores the phase resumed after an orange mechanism tick.
  state->reserved[1] = static_cast<uint8_t>(kMotionReady);
  for (int32_t index = 0; index < count; ++index) {
    g_blocked_orange_walls[index] = 0;
  }
  // StoreObjectMotion below replaces the falling/gravity arrays completely;
  // only horizontal momentum needs an independent reset here.
  ClearHorizontalMomentum(state, count);
  bool needs_initial_gravity = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (ObjectHasDirectSupport(voxels, object, width, height)) {
      g_object_gravity_armed[object] = 1;
      continue;
    }
    if (ObjectIsActive(voxels, object, width, height)) {
      if (ObjectIsFloatingFloor(voxels, object) ||
          ObjectIsUnarmedPlayerLift(voxels, object)) {
        // Hovering floors and terrain lifts remain at their authored anchors.
        // Once translated, the movement kernels arm it so subsequent support
        // loss is animated normally. This is what distinguishes an authored
        // hovering platform from an accidentally airborne ordinary body.
        continue;
      }
      // Dynamic bodies are never allowed to begin a command suspended in the
      // editor volume. Arm them even over the abyss so they settle or leave
      // the world before the requested horizontal input is evaluated.
      g_object_gravity_armed[object] = 1;
      g_object_falling[object] = 1;
      needs_initial_gravity = true;
    }
  }
  const Voxel& player = voxels[player_index];
  const bool player_active =
      IsInsideRoom(player.x, player.y, width, height) &&
      player.z != INT32_MIN;
  const bool player_supported = player_active && FindVoxelAt(
      voxels, player.x, player.y, player.z - 1, width, height) >= 0;
  state->player_gravity_armed = player_active ? 1 : 0;
  if (player_active && !player_supported) {
    state->player_falling = 1;
    needs_initial_gravity = true;
  }
  if (needs_initial_gravity) {
    state->phase = kMotionGravity;
    state->reserved[0] = kResumeCommand;
  }
  StoreObjectMotion(state, count, false);
  ClearImmutableMotionSuffix(state, count);
}

void InitializeQuiescentMotion(
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t direction,
    int32_t width,
    int32_t height) {
  state->version = kMotionStateVersion;
  state->phase = kMotionReady;
  state->direction = direction;
  state->tick = 0;
  state->voxel_count = count;
  state->player_index = player_index;
  state->player_gravity_armed = 1;
  state->player_falling = 0;
  state->reserved[0] = kResumeNothing;
  state->reserved[1] = 0;
  state->reserved[1] = static_cast<uint8_t>(kMotionReady);
  for (int32_t index = 0; index < count; ++index) {
    g_blocked_orange_walls[index] = 0;
  }
  // StoreObjectMotion below replaces the falling/gravity arrays completely.
  ClearHorizontalMomentum(state, count);
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_object_gravity_armed[object] =
        ObjectIsUnarmedPlayerLift(voxels, object) &&
        !ObjectHasDirectSupport(voxels, object, width, height) ? 0 : 1;
    g_object_falling[object] = 0;
  }
  StoreObjectMotion(state, count, false);
  // This state is private to simulate_quiescent_turn and is never serialized;
  // unlike the public step_tick path, its immutable suffix need not be stored.
}

void CollectGoalsAtPlayer(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  if (player_index < 0 || player_index >= count) return;
  const Voxel& player = voxels[player_index];
  if (IsPreparedScene(voxels, count, width, height)) {
    const WorkspaceData& workspace = ActiveWorkspace();
    for (int32_t goal = 0; goal < workspace.prepared_goal_count; ++goal) {
      Voxel& voxel = voxels[workspace.prepared_goal_indices[goal]];
      if (voxel.x == player.x && voxel.y == player.y && voxel.z == player.z) {
        voxel.x = -1;
      }
    }
    return;
  }
  for (int32_t index = 0; index < count; ++index) {
    if (voxels[index].role == kGoalRole && voxels[index].x == player.x &&
        voxels[index].y == player.y && voxels[index].z == player.z) {
      voxels[index].x = -1;
    }
  }
}

void CollectGoalsAtPlayerBody(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  CollectGoalsAtPlayer(voxels, count, player_index, width, height);
  auto collect_if_overlapped = [&](int32_t goal_index) {
    Voxel& goal = voxels[goal_index];
    if (goal.role != kGoalRole ||
        !IsInsideRoom(goal.x, goal.y, width, height)) {
      return;
    }
    for (int32_t index = 0; index < count; ++index) {
      // Every player-polycube member can collect; clones of any shape cannot.
      if (voxels[index].role == kPlayerRole &&
          voxels[index].x == goal.x && voxels[index].y == goal.y &&
          voxels[index].z == goal.z) {
        goal.x = -1;
        return;
      }
    }
  };
  if (IsPreparedScene(voxels, count, width, height)) {
    const WorkspaceData& workspace = ActiveWorkspace();
    for (int32_t goal = 0; goal < workspace.prepared_goal_count; ++goal) {
      collect_if_overlapped(workspace.prepared_goal_indices[goal]);
    }
    return;
  }
  for (int32_t index = 0; index < count; ++index) {
    if (voxels[index].role == kGoalRole) collect_if_overlapped(index);
  }
}

#include "orange_mechanisms.inc"
#include "passive_commands.inc"
