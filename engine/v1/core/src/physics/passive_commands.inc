// Returns 1 when handled, 0 when the full kernel is required, and a negative
// public simulation error for invalid input/no player.
int32_t TrySimulatePassiveQuiescentTurn(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction,
    bool rebuild_spatial_index) {
  if (!IsPreparedScene(voxels, count, width, height)) return 0;
  if (ActiveWorkspace().prepared_has_player_lifts ||
      ActiveWorkspace().prepared_has_orange_mechanisms ||
      ActiveWorkspace().prepared_has_clones ||
      ActiveWorkspace().prepared_has_player_polycube ||
      ActiveWorkspace().scene_has_player_gates) return 0;
  const int32_t player_index = ActiveWorkspace().prepared_player_index;
  if (player_index < 0 || player_index >= count ||
      voxels[player_index].role != kPlayerRole) {
    return -2;
  }
  Voxel& player = voxels[player_index];
  if (!IsInsideRoom(player.x, player.y, width, height) ||
      player.z == INT32_MIN) {
    return -2;
  }

  if (rebuild_spatial_index) {
    ResetObjectMotion();
    BuildSpatialIndex(voxels, count, width, height);
  } else if (!ActiveWorkspace().prepared_index_active) {
    return 0;
  }
  const bool has_slopes = ActiveWorkspace().prepared_has_ice_slopes;
  const bool has_floating_floors =
      ActiveWorkspace().prepared_has_floating_floors;
  if (has_slopes || has_floating_floors) {
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (!ObjectIsActive(voxels, object, width, height)) continue;
      // A command can awaken a remote ramp body or settle an unsupported
      // Floating Floor. Neither is a player-only transition.
      if (!ObjectHasDirectSupport(voxels, object, width, height)) return 0;
      if (g_object_kind[object] == kMechanismObject) continue;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if (has_slopes && SlopeSupportingVoxel(
                voxels, voxels[member], width, height) >= 0) return 0;
      }
    }
  }
  const bool has_punchers = ActiveWorkspace().prepared_has_punchers;
  if (has_punchers) {
    for (int32_t fixture = 0; fixture < g_object_count; ++fixture) {
      if (g_object_kind[fixture] != kMechanismObject) continue;
      const Voxel& puncher = voxels[g_object_head[fixture]];
      if (puncher.role != kPuncherRole) continue;
      // Passive commands never change fixtures. Sprung, unsupported, carried,
      // or already-contacting punchers must use the full tick kernel.
      if (puncher.generic_id < 0 || (puncher.generic_id & 1) != 0) return 0;
      const int32_t attachment = MechanismAttachmentVoxel(
          voxels, fixture, width, height);
      if (attachment < 0 || attachment == player_index ||
          g_voxel_object[attachment] >= 0) return 0;
      for (int32_t object = 0; object < g_object_count; ++object) {
        if (g_object_kind[object] == kMechanismObject) continue;
        for (int32_t member = g_object_head[object]; member >= 0;
             member = g_next_object_voxel[member]) {
          if (voxels[member].x == puncher.x &&
              voxels[member].y == puncher.y &&
              voxels[member].z == puncher.z) return 0;
        }
      }
    }
  }
  g_ignored_support_voxel = player_index;
  constexpr int32_t kDx[4] = {0, 1, 0, -1};
  constexpr int32_t kDy[4] = {-1, 0, 1, 0};
  const int32_t dx = kDx[direction];
  const int32_t dy = kDy[direction];
  int32_t x = player.x;
  int32_t y = player.y;
  int32_t z = player.z;
  bool automatic_ice_motion = false;

  auto touches_puncher = [&]() {
    if (!has_punchers) return false;
    for (int32_t fixture = 0; fixture < g_object_count; ++fixture) {
      if (g_object_kind[fixture] != kMechanismObject) continue;
      const Voxel& puncher = voxels[g_object_head[fixture]];
      if (puncher.role == kPuncherRole && puncher.x == x &&
          puncher.y == y && puncher.z == z) return true;
    }
    return false;
  };

  auto support_at = [&](int32_t support_x, int32_t support_y, int32_t support_z) {
    const int32_t support = FindVoxelAt(
        voxels, support_x, support_y, support_z, width, height);
    return support == player_index ? -1 : support;
  };
  auto special_support = [&](int32_t support) {
    return support >= 0 && (IsIceSlopeRole(voxels[support].role) ||
        voxels[support].role == kFloatingFloorRole);
  };
  auto has_carried_body = [&]() {
    if (z == INT32_MAX) return false;
    const int32_t above = FindVoxelAt(voxels, x, y, z + 1, width, height);
    return above >= 0 && g_voxel_object[above] >= 0;
  };
  auto fall_until_settled = [&]() {
    for (;;) {
      if (z == INT32_MIN) {
        x = -1;
        return true;
      }
      const int32_t support = support_at(x, y, z - 1);
      if (special_support(support)) return false;
      if (support >= 0) return true;
      const int32_t lower_support = FindNearestVoxelBelow(
          voxels, count, x, y, z, -1, width);
      const int32_t previous_z = z;
      --z;
      if (touches_puncher()) return false;
      if (lower_support < 0 && previous_z < LowestOtherActiveZ(
              voxels, count, width, height, -1, player_index, false, true)) {
        x = -1;
        return true;
      }
    }
  };

  for (;;) {
    if (touches_puncher() || has_carried_body()) {
      g_ignored_support_voxel = -1;
      return 0;
    }
    const int32_t support = support_at(x, y, z - 1);
    if (special_support(support)) {
      g_ignored_support_voxel = -1;
      return 0;
    }
    const bool started_on_ice =
        support >= 0 && IsIceRole(voxels[support].role);
    const int32_t target_x = x + dx;
    const int32_t target_y = y + dy;
    if (!IsInsideRoom(target_x, target_y, width, height)) break;

    const int32_t target = FindVoxelAt(
        voxels, target_x, target_y, z, width, height);
    if (target >= 0 && target != player_index) {
      const int32_t target_object = g_voxel_object[target];
      if (IsIceSlopeRole(voxels[target].role) ||
          (target_object >= 0 && (has_slopes || has_floating_floors))) {
        g_ignored_support_voxel = -1;
        return 0;
      }
      if (!automatic_ice_motion && target_object >= 0) {
        // Reject only collisions that no carrier/chain rule can rescue. This
        // avoids entering the full multi-body kernel for pushes directly into
        // room boundaries or immutable terrain while leaving every ambiguous
        // dynamic interaction to that kernel.
        bool definitely_blocked = false;
        for (int32_t member = g_object_head[target_object]; member >= 0;
             member = g_next_object_voxel[member]) {
          const int32_t member_x = voxels[member].x + dx;
          const int32_t member_y = voxels[member].y + dy;
          if (!VoxelDestinationIsInsideRoom(voxels[member], member_x, member_y, width, height)) {
            definitely_blocked = true;
            break;
          }
          const int32_t occupant = FindVoxelAt(
              voxels,
              member_x,
              member_y,
              voxels[member].z,
              width,
              height);
          if (occupant >= 0 && occupant != player_index &&
              g_voxel_object[occupant] < 0) {
            definitely_blocked = true;
            break;
          }
        }
        if (!definitely_blocked) {
          g_ignored_support_voxel = -1;
          return 0;
        }
        break;
      }
      break;
    }

    const int32_t direct_support = support_at(target_x, target_y, z - 1);
    if (special_support(direct_support)) {
      g_ignored_support_voxel = -1;
      return 0;
    }
    if (direct_support < 0) {
      const int32_t lower_support = FindNearestVoxelBelow(
          voxels, count, target_x, target_y, z, -1, width);
      const int32_t current_support = support_at(x, y, z - 1);
      const bool may_leave_support = automatic_ice_motion || started_on_ice ||
          (current_support >= 0 &&
           voxels[current_support].role == kFloorRole && lower_support < 0);
      if (!may_leave_support) break;
    }

    x = target_x;
    y = target_y;
    // This also catches a puncher partway through an Ice slide. Coordinates
    // stay local until success, so a declined fast path is transactional.
    if (touches_puncher()) {
      g_ignored_support_voxel = -1;
      return 0;
    }
    if (direct_support < 0) {
      if (!fall_until_settled()) {
        g_ignored_support_voxel = -1;
        return 0;
      }
      break;
    }

    const bool now_on_ice = IsIceRole(voxels[direct_support].role);
    if (now_on_ice) {
      automatic_ice_motion = true;
      continue;
    }
    if (automatic_ice_motion) break;

    break;
  }

  player.x = x;
  player.y = y;
  player.z = z;
  CollectGoalsAtPlayer(voxels, count, player_index, width, height);
  g_ignored_support_voxel = -1;
  return 1;
}
