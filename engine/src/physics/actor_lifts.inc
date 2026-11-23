bool SceneHasActorLifts(Voxel* voxels) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (voxels[g_object_head[object]].role == kPlayerLiftRole) return true;
  }
  return false;
}

void QueueMovingActorLiftEntries(
    MotionState* state, Voxel* voxels, int32_t count,
    int32_t width, int32_t height) {
  if (!SceneHasActorLifts(voxels)) return;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (!IsCommandActorObject(object) || g_moving_objects[object] == 0 ||
        g_carried_objects[object] != 0 ||
        IsPunchMomentum(ReadObjectMomentum(state->horizontal_momentum, object))) {
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (PlayerLiftCanToggleOnEntry(voxels, count, member,
              voxels[member].x - g_object_dx[object],
              voxels[member].y - g_object_dy[object], width, height)) {
        state->gravity_armed[member] |= kActorLiftEntryPending;
      }
    }
  }
}

bool HasPendingActorLifts(const MotionState* state) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (!IsCommandActorObject(object)) continue;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if ((state->gravity_armed[member] & kActorLiftEntryPending) != 0) return true;
    }
  }
  return false;
}

// Like the player, an actor can press a terrain-mounted raised side lift
// inward. Fold it for collision validation, and roll it back if any part of
// the rigid body's command is blocked. Movable mounts retain normal pushing.
bool FoldActorSideLiftsForEntry(
    MotionState* state, Voxel* voxels, int32_t count,
    int32_t direction, int32_t width, int32_t height) {
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  bool folded = false;
  if (!SceneHasActorLifts(voxels)) return false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_component_objects[object] == 0) continue;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const Voxel& actor = voxels[member];
      const int32_t target = FindVoxelAt(voxels, actor.x + kDx[direction],
          actor.y + kDy[direction], actor.z, width, height);
      if (target < 0 || voxels[target].role != kPlayerLiftRole ||
          !PlayerLiftIsRaised(voxels[target])) continue;
      const int32_t outward = PlayerLiftSideOutwardDirection(voxels[target]);
      if (outward < 0 || direction != OppositeDirection(outward)) continue;
      const int32_t attachment = PlayerLiftSideAttachmentVoxel(
          voxels, g_voxel_object[target], width, height);
      const int32_t support = attachment >= 0 ? g_voxel_object[attachment] : -1;
      if (support >= 0 && (g_object_kind[support] == kNormalObject ||
              g_object_kind[support] == kWeightlessObject)) continue;
      state->gravity_armed[target] |= kActorLiftSelected;
      --voxels[target].generic_id;
      folded = true;
    }
  }
  if (folded) BuildSpatialIndex(voxels, count, width, height);
  return folded;
}

void FinishActorSideLiftEntry(
    MotionState* state, Voxel* voxels, int32_t count,
    int32_t width, int32_t height, bool moved) {
  for (int32_t index = 0; index < count; ++index) {
    if ((state->gravity_armed[index] & kActorLiftSelected) == 0) continue;
    if (!moved) ++voxels[index].generic_id;
    else {
      for (int32_t object = 0; object < g_object_count; ++object) {
        if (!IsCommandActorObject(object)) continue;
        for (int32_t member = g_object_head[object]; member >= 0;
             member = g_next_object_voxel[member]) {
          if (voxels[member].x == voxels[index].x &&
              voxels[member].y == voxels[index].y &&
              voxels[member].z == voxels[index].z) {
            state->gravity_armed[member] &= static_cast<uint8_t>(~kActorLiftEntryPending);
          }
        }
      }
    }
    state->gravity_armed[index] &= static_cast<uint8_t>(~kActorLiftSelected);
  }
  BuildSpatialIndex(voxels, count, width, height);
}

bool ActorLiftContactComesFirst(const Voxel& left, const Voxel& right) {
  return left.z < right.z || (left.z == right.z &&
      (left.y < right.y || (left.y == right.y && left.x < right.x)));
}

bool AdvancePendingActorLifts(
    MotionState* state, Voxel* voxels, int32_t count,
    int32_t player_index, int32_t width, int32_t height) {
  constexpr int32_t kLiftDx[] = {0, 1, 0, -1};
  constexpr int32_t kLiftDy[] = {-1, 0, 1, 0};
  bool advanced = false;
  for (;;) {
    int32_t next_actor = -1;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (!IsCommandActorObject(object)) continue;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if ((state->gravity_armed[member] & kActorLiftEntryPending) != 0 &&
            (next_actor < 0 || ActorLiftContactComesFirst(
                voxels[member], voxels[next_actor]))) next_actor = member;
      }
    }
    if (next_actor < 0) break;
    const int32_t object = g_voxel_object[next_actor];
    const bool punched = IsPunchMomentum(ReadObjectMomentum(
        state->horizontal_momentum, object));
    int32_t contact = -1, lift_index = -1, outward = -1;
    int32_t proposed_dx = 0, proposed_dy = 0, proposed_dz = 0;
    bool conflict = false;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const bool pending = (state->gravity_armed[member] & kActorLiftEntryPending) != 0;
      state->gravity_armed[member] &= static_cast<uint8_t>(~kActorLiftEntryPending);
      if (!pending || punched) continue;
      bool raise = false;
      const int32_t lift = PlayerLiftAtPlayer(voxels, count, member, width, height, raise);
      if (lift < 0) continue;
      const bool recoil = PlayerLiftCountAtPlayer(voxels, count, member, width, height) > 1;
      const int32_t direction = !recoil && raise
          ? PlayerLiftSideOutwardDirection(voxels[lift]) : -1;
      const int32_t dx = direction >= 0 ? kLiftDx[direction] : 0;
      const int32_t dy = direction >= 0 ? kLiftDy[direction] : 0;
      const int32_t dz = recoil || direction >= 0 ? 0 : raise ? 1 : -1;
      if (contact >= 0 && (dx != proposed_dx || dy != proposed_dy || dz != proposed_dz)) {
        conflict = true;
      }
      if (!recoil) state->gravity_armed[lift] |= kActorLiftSelected;
      if (contact < 0 || ActorLiftContactComesFirst(voxels[member], voxels[contact])) {
        contact = member;
        lift_index = lift;
        outward = direction;
        proposed_dx = dx;
        proposed_dy = dy;
        proposed_dz = dz;
      }
    }
    if (contact >= 0 && !punched) {
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) state->horizontal_momentum[member] = 0;
      const Voxel player_before = voxels[player_index];
      const bool toggled = !conflict && TogglePlayerLiftAtPlayer(
          voxels, count, contact, width, height, player_index, state->gravity_armed);
      if (toggled) {
        // Every compatible contact under this rigid body shares one proposal.
        // The shared payload transaction already moved all attached fixtures.
        for (int32_t index = 0; index < count; ++index) {
          if (index != lift_index && (state->gravity_armed[index] & kActorLiftSelected) != 0) {
            voxels[index].generic_id ^= 1;
          }
        }
        advanced = true;
        (void)RefreshOrangeButtonVisibility(voxels, count);
        BuildSpatialIndex(voxels, count, width, height);
        if (outward >= 0 && ObjectIsFullyOnIce(voxels, object, width, height)) {
          for (int32_t member = g_object_head[object]; member >= 0;
               member = g_next_object_voxel[member]) {
            state->horizontal_momentum[member] = static_cast<uint8_t>(outward + 1);
          }
        }
        if (voxels[player_index].x != player_before.x ||
            voxels[player_index].y != player_before.y ||
            voxels[player_index].z != player_before.z) state->player_gravity_armed = 1;
      }
    }
    for (int32_t index = 0; index < count; ++index) {
      state->gravity_armed[index] &= static_cast<uint8_t>(~kActorLiftSelected);
    }
  }
  return advanced;
}
