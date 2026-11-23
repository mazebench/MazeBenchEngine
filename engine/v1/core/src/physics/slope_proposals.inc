bool SceneHasIceSlopes(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height) {
  const WorkspaceData& workspace = ActiveWorkspace();
  if (workspace.prepared_voxels == voxels &&
      workspace.prepared_count == count &&
      workspace.prepared_width == width &&
      workspace.prepared_height == height) {
    return workspace.prepared_has_ice_slopes;
  }
  for (int32_t index = 0; index < count; ++index) {
    if (IsIceSlopeRole(voxels[index].role)) return true;
  }
  return false;
}

int32_t ObjectSlopeVerticalDelta(
    Voxel* voxels,
    int32_t object,
    int32_t direction,
    int32_t width,
    int32_t height,
    bool deliberate_vertical) {
  bool has_uphill_foot = false;
  bool has_downhill_foot = false;
  bool has_level_foot = false;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const int32_t member_dz = deliberate_vertical
        ? DeliberateSlopeVerticalDelta(
              voxels, voxels[member], direction, width, height, true)
        : SlopeVerticalDelta(
              voxels, voxels[member], direction, width, height);

    // Only exposed feet constrain a rigid body's ramp elevation. Internal
    // members stacked above the same polycube do not vote a second time, and
    // unsupported overhangs follow the supported portion. A level external
    // foot is significant: a polycube cannot descend through that foot
    // merely because another part of the same body rests on a wedge.
    int32_t support = -1;
    if (voxels[member].z != INT32_MIN) {
      support = FindVoxelAt(
          voxels,
          voxels[member].x,
          voxels[member].y,
          voxels[member].z - 1,
          width,
          height);
    }
    if (support >= 0 && g_voxel_object[support] == object) continue;
    if (support < 0 && member_dz <= 0) continue;

    has_uphill_foot |= member_dz > 0;
    has_downhill_foot |= member_dz < 0;
    has_level_foot |= member_dz == 0;
  }
  // Reduce all external contacts without depending on voxel traversal order.
  // An uphill foot lifts the body away from flat support; level support only
  // blocks descent through that surface. Destination collisions are validated
  // for every member by the transaction before any coordinate is committed.
  return has_uphill_foot ? 1
      : has_downhill_foot && !has_level_foot ? -1 : 0;
}

// Read-only contact closure for a crest impact. Reuse the same whole-body
// elevation rule as movement, and visit each contacted polycube once without
// recursion, allocations, or changing the tick's existing motion proposals.
bool CanPushSlopeContactChain(
    Voxel* voxels, int32_t object, int32_t direction,
    int32_t width, int32_t height) {
  if (!ObjectAcceptsSlopeContactPush(voxels, object)) return false;
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  WorkspaceData& workspace = ActiveWorkspace();
  const int32_t words = (g_object_count + 63) / 64;
  int32_t pending = 1;
  workspace.slope_push_seen[object / 64] = uint64_t{1} << (object % 64);
  workspace.slope_push_pending[object / 64] = uint64_t{1} << (object % 64);
  bool clear = true;
  bool has_floating_floor = false;
  while (pending > 0 && clear) {
    for (int32_t word = 0; word < words && clear; ++word) {
      while (workspace.slope_push_pending[word] != 0 && clear) {
        const int32_t bit = __builtin_ctzll(workspace.slope_push_pending[word]);
        const int32_t moving = word * 64 + bit;
        workspace.slope_push_pending[word] &= ~(uint64_t{1} << bit);
        --pending;
        const int32_t dz = ObjectSlopeVerticalDelta(
            voxels, moving, direction, width, height, false);
        if (ObjectIsFloatingFloor(voxels, moving)) {
          // Match the committing push closure's single ordinary-body limit.
          if (has_floating_floor ||
              !FloatingFloorDestinationIsSupportedOrFillable(
                  voxels, moving, kDx[direction], kDy[direction], dz,
                  width, height)) {
            clear = false;
            break;
          }
          has_floating_floor = true;
        }
        for (int32_t member = g_object_head[moving]; member >= 0;
             member = g_next_object_voxel[member]) {
          const int32_t x = voxels[member].x + kDx[direction];
          const int32_t y = voxels[member].y + kDy[direction];
          const int32_t z = voxels[member].z + dz;
          if (!VoxelDestinationIsInsideRoom(voxels[member], x, y, width, height)) {
            clear = false;
            break;
          }
          const int32_t occupant = FindVoxelAt(voxels, x, y, z, width, height);
          if (occupant < 0) continue;
          const int32_t other = g_voxel_object[occupant];
          if (other == moving) continue;
          if (!ObjectAcceptsSlopeContactPush(voxels, other)) {
            clear = false;
            break;
          }
          const uint64_t mask = uint64_t{1} << (other % 64);
          if ((workspace.slope_push_seen[other / 64] & mask) == 0) {
            workspace.slope_push_seen[other / 64] |= mask;
            workspace.slope_push_pending[other / 64] |= mask;
            ++pending;
          }
        }
      }
    }
  }
  for (int32_t index = 0; index < words; ++index) {
    workspace.slope_push_seen[index] = 0;
    workspace.slope_push_pending[index] = 0;
  }
  return clear;
}

void PrepareSlopeObjectProposal(
    Voxel* voxels, int32_t object, int32_t width, int32_t height,
    bool allow_redirect, bool deliberate_vertical = false) {
  constexpr int8_t kDx[] = {0, 1, 0, -1};
  constexpr int8_t kDy[] = {-1, 0, 1, 0};
  int32_t direction = g_object_direction[object] <= 3
      ? g_object_direction[object] : 0;
  if (allow_redirect) {
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const int32_t redirected = RedirectSlopeDirection(
          voxels, voxels[member], direction, width, height);
      if (redirected != direction) {
        direction = redirected;
        g_object_redirected[object] = 1;
        break;
      }
    }
  }
  g_object_direction[object] = static_cast<uint8_t>(direction);
  g_object_dx[object] = kDx[direction];
  g_object_dy[object] = kDy[direction];
  g_object_dz[object] = static_cast<int8_t>(ObjectSlopeVerticalDelta(
      voxels, object, direction, width, height, deliberate_vertical));
}

int32_t ObjectDownhillSlopeDirection(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  int32_t downhill = -1;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const int32_t support = SlopeSupportingVoxel(
        voxels, voxels[member], width, height);
    if (support < 0) continue;
    const int32_t member_downhill = OppositeDirection(
        IceSlopeDirection(voxels[support].role));
    if (downhill >= 0 && downhill != member_downhill) return -1;
    downhill = member_downhill;
  }
  return downhill;
}

bool ObjectHasConflictingSlopeSupports(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  int32_t downhill = -1;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const int32_t support = SlopeSupportingVoxel(
        voxels, voxels[member], width, height);
    if (support < 0) continue;
    const int32_t member_downhill = OppositeDirection(
        IceSlopeDirection(voxels[support].role));
    if (downhill >= 0 && downhill != member_downhill) return true;
    downhill = member_downhill;
  }
  return false;
}

bool ObjectBridgesSlopeAndFlatIce(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  bool has_slope_support = false;
  bool has_flat_ice_support = false;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const Voxel& voxel = voxels[member];
    if (voxel.z == INT32_MIN) continue;
    const int32_t support = FindVoxelAt(
        voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
    if (support < 0 || g_voxel_object[support] == object) continue;
    has_slope_support |= IsIceSlopeRole(voxels[support].role);
    has_flat_ice_support |= voxels[support].role == kIceRole;
  }
  return has_slope_support && has_flat_ice_support;
}

bool ObjectProposalVacatesCell(
    Voxel* voxels,
    int32_t object,
    int32_t x,
    int32_t y,
    int32_t z);

bool DeferredSlopeProposalIsClear(
    Voxel* voxels,
    int32_t object,
    int32_t player_index,
    int32_t width,
    int32_t height);

bool AddAutonomousSlopeObjects(
    Voxel* voxels,
    int32_t player_index,
    int32_t player_direction,
    int32_t width,
    int32_t height,
    bool preserve_deliberate_proposals = false) {
  bool added = false;
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  const Voxel& player = voxels[player_index];
  const int32_t player_target_x = player.x + kDx[player_direction];
  const int32_t player_target_y = player.y + kDy[player_direction];
  const int32_t player_target_z = player.z + DeliberateSlopeVerticalDelta(
      voxels,
      player,
      player_direction,
      width,
      height,
      false);
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_deferred_slope_objects[object] = 0;
  }

  // The command direction advances matching ramps everywhere. Other ramp
  // directions awaken only when their downhill proposal enters a source cell
  // being vacated in this tick; this is what makes perpendicular ramp chains
  // propagate without making unrelated bodies elsewhere in the room move.
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] != 0 ||
        g_object_kind[object] == kMechanismObject ||
        !ObjectIsActive(voxels, object, width, height) ||
        !ObjectIsFullyOnIce(voxels, object, width, height)) {
      continue;
    }
    bool supports_player_target = false;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (voxels[member].x == player_target_x &&
          voxels[member].y == player_target_y &&
          voxels[member].z == player_target_z - 1) {
        supports_player_target = true;
        break;
      }
    }
    if (supports_player_target) continue;
    if (MovingSupportBelowObject(
            voxels,
            object,
            player_index,
            false,
            width,
            height) >= 0) {
      // Carrier motion wins for this synchronized tick. A rider resting on a
      // movable ramp follows that ramp's exact 3D proposal first; after the
      // commit PreserveMovableSlopeRiderMomentum may arm the rider's own
      // downhill motion for the following tick.
      continue;
    }
    const int32_t downhill = ObjectDownhillSlopeDirection(
        voxels, object, width, height);
    if (downhill < 0 || downhill != player_direction ||
        ObjectBridgesSlopeAndFlatIce(voxels, object, width, height)) {
      // A rigid body bridging a wedge and level Ice has a stable level foot.
      // It can still be deliberately pushed, but slope gravity alone cannot
      // move it without changing its shape.
      continue;
    }
    const uint8_t previous_direction = g_object_direction[object];
    g_object_direction[object] = static_cast<uint8_t>(downhill);
    // Slope gravity cannot borrow the deliberate push's contact permissions.
    // Only seed a free downhill proposal here. A body blocked by a source
    // cell that really vacates is recruited by the propagation pass below.
    if (!DeferredSlopeProposalIsClear(
            voxels, object, player_index, width, height)) {
      g_object_direction[object] = previous_direction;
      continue;
    }
    g_mandatory_objects[object] = 1;
    g_moving_objects[object] = 1;
    added = true;
  }

  bool propagated = true;
  while (propagated) {
    propagated = false;
    for (int32_t moving = 0; moving < g_object_count; ++moving) {
      if (g_mandatory_objects[moving] != 0) {
        // This is the command's initial synchronized proposal. Deliberately
        // pushed bodies keep the command direction; slope redirection begins
        // only on their subsequent momentum ticks.
        PrepareSlopeObjectProposal(
            voxels,
            moving,
            width,
            height,
            false,
            preserve_deliberate_proposals);
      }
    }
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_mandatory_objects[object] != 0 ||
          g_object_kind[object] == kMechanismObject ||
          !ObjectIsActive(voxels, object, width, height) ||
          !ObjectIsFullyOnIce(voxels, object, width, height) ||
          ObjectBridgesSlopeAndFlatIce(voxels, object, width, height)) {
        // A vacated cell removes a collision, not a stationary foothold.
        // Propagated slope gravity must obey the same friction and level-foot
        // rules as the initial autonomous proposal. Otherwise a wrapping
        // polycube can follow a player walking on its own supported surface.
        continue;
      }
      const int32_t downhill = ObjectDownhillSlopeDirection(
          voxels, object, width, height);
      if (downhill < 0) continue;
      const uint8_t previous_direction = g_object_direction[object];
      g_object_direction[object] = static_cast<uint8_t>(downhill);
      PrepareSlopeObjectProposal(voxels, object, width, height, false);
      bool enters_vacated_source = false;
      int32_t vacating_direction = player_direction;
      bool vacating_is_deferred = false;
      for (int32_t member = g_object_head[object]; member >= 0 &&
           !enters_vacated_source; member = g_next_object_voxel[member]) {
        const int32_t next_x = voxels[member].x + kDx[downhill];
        const int32_t next_y = voxels[member].y + kDy[downhill];
        const int32_t next_z = voxels[member].z + g_object_dz[object];
        if (voxels[player_index].x == next_x &&
            voxels[player_index].y == next_y &&
            voxels[player_index].z == next_z) {
          enters_vacated_source = true;
          break;
        }
        const int32_t occupant = FindVoxelAt(
            voxels, next_x, next_y, next_z, width, height);
        const int32_t other = occupant >= 0 ? g_voxel_object[occupant] : -1;
        enters_vacated_source = other >= 0 &&
            (g_mandatory_objects[other] != 0 ||
             g_deferred_slope_objects[other] != 0) &&
            ObjectProposalVacatesCell(
                voxels, other, next_x, next_y, next_z);
        if (enters_vacated_source) {
          vacating_direction = g_object_direction[other];
          vacating_is_deferred =
              g_deferred_slope_objects[other] != 0;
        }
      }
      if (!enters_vacated_source) {
        // Computing an autonomous proposal is speculative. Leaving the
        // downhill direction behind on an object that was not recruited
        // makes the carrier pass mistake an ordinary ramp rider for a body
        // with independent latent momentum, so it gets left behind when its
        // movable ramp translates on another axis.
        g_object_direction[object] = previous_direction;
        continue;
      }
      if (vacating_is_deferred || downhill != vacating_direction) {
        // The source cell is available only after the other body's proposal
        // commits. Preserve this body's own downhill direction as momentum
        // for the next tick instead of dragging it along the vacating axis.
        const bool newly_deferred = g_deferred_slope_objects[object] == 0;
        g_deferred_slope_objects[object] = 1;
        added = true;
        propagated |= newly_deferred;
        continue;
      }
      g_mandatory_objects[object] = 1;
      g_moving_objects[object] = 1;
      added = true;
      propagated = true;
    }
  }
  return added;
}

bool PromoteDeferredSlopeMomentum(
    Voxel* voxels,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  bool promoted = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_deferred_slope_objects[object] == 0 ||
        g_object_kind[object] == kMechanismObject ||
        !ObjectIsActive(voxels, object, width, height)) {
      continue;
    }
    const int32_t downhill = ObjectDownhillSlopeDirection(
        voxels, object, width, height);
    if (downhill < 0) continue;
    g_mandatory_objects[object] = 1;
    g_moving_objects[object] = 1;
    g_object_direction[object] = static_cast<uint8_t>(downhill);
    if (!DeferredSlopeProposalIsClear(
            voxels, object, player_index, width, height)) {
      g_mandatory_objects[object] = 0;
      g_moving_objects[object] = 0;
      continue;
    }
    promoted = true;
  }
  return promoted;
}

bool SlopeObjectProposalEntersPlayerFromDifferentDirection(
    Voxel* voxels,
    int32_t player_index,
    int32_t player_dx,
    int32_t player_dy,
    int32_t width,
    int32_t height) {
  const Voxel& player = voxels[player_index];
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0) continue;
    PrepareSlopeObjectProposal(voxels, object, width, height, true);
    if (g_object_dx[object] == player_dx &&
        g_object_dy[object] == player_dy) {
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (voxels[member].x + g_object_dx[object] == player.x &&
          voxels[member].y + g_object_dy[object] == player.y &&
          voxels[member].z + g_object_dz[object] == player.z) {
        return true;
      }
    }
  }
  return false;
}

int32_t UphillSlopeContactObject(
    Voxel* voxels,
    const Voxel& source,
    int32_t movement_direction,
    int32_t width,
    int32_t height) {
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  const int32_t maximum_steps = width > height ? width : height;
  for (int32_t slope_direction = 0; slope_direction < 4;
       ++slope_direction) {
    if (slope_direction == movement_direction ||
        slope_direction == OppositeDirection(movement_direction)) {
      continue;
    }
    for (int32_t step = 1; step <= maximum_steps; ++step) {
      const int32_t candidate_x = source.x + kDx[slope_direction] * step;
      const int32_t candidate_y = source.y + kDy[slope_direction] * step;
      const int32_t candidate_z = source.z + step;
      if (!IsInsideRoom(candidate_x, candidate_y, width, height)) break;
      const int32_t support = FindVoxelAt(
          voxels,
          candidate_x,
          candidate_y,
          candidate_z - 1,
          width,
          height);
      if (support < 0 || !IsIceSlopeRole(voxels[support].role) ||
          IceSlopeDirection(voxels[support].role) != slope_direction) {
        break;
      }
      const int32_t occupant = FindVoxelAt(
          voxels, candidate_x, candidate_y, candidate_z, width, height);
      if (occupant >= 0 && g_voxel_object[occupant] >= 0 &&
          g_object_kind[g_voxel_object[occupant]] == kWeightlessObject) {
        return g_voxel_object[occupant];
      }
    }
  }
  return -1;
}

void AddDeliberateUphillSlopeContactClosure(
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  bool added = true;
  while (added) {
    added = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_mandatory_objects[object] == 0 ||
          g_object_kind[object] != kWeightlessObject) {
        continue;
      }
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const int32_t uphill = UphillSlopeContactObject(
            voxels,
            voxels[member],
            g_object_direction[object],
            width,
            height);
        if (uphill < 0 || g_mandatory_objects[uphill] != 0 ||
            g_object_falling[uphill] != 0) {
          continue;
        }
        g_mandatory_objects[uphill] = 1;
        g_moving_objects[uphill] = 1;
        g_object_direction[uphill] = g_object_direction[object];
        added = true;
      }
    }
  }
}

bool DeferredSlopeProposalIsClear(
    Voxel* voxels,
    int32_t object,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  PrepareSlopeObjectProposal(voxels, object, width, height, false);
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const int32_t next_x = voxels[member].x + g_object_dx[object];
    const int32_t next_y = voxels[member].y + g_object_dy[object];
    const int32_t next_z = voxels[member].z + g_object_dz[object];
    if (!VoxelDestinationIsInsideRoom(voxels[member], next_x, next_y, width, height)) return false;
    const int32_t occupant = FindVoxelAt(
        voxels, next_x, next_y, next_z, width, height);
    if (occupant < 0 || occupant == player_index ||
        g_voxel_object[occupant] == object) {
      continue;
    }
    const int32_t other = g_voxel_object[occupant];
    if (other >= 0 && g_deferred_slope_objects[other] != 0 &&
        ObjectProposalVacatesCell(
            voxels, other, next_x, next_y, next_z)) {
      continue;
    }
    return false;
  }
  return true;
}

bool ObjectProposalVacatesCell(
    Voxel* voxels,
    int32_t object,
    int32_t x,
    int32_t y,
    int32_t z) {
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    if (voxels[member].x + g_object_dx[object] == x &&
        voxels[member].y + g_object_dy[object] == y &&
        voxels[member].z + g_object_dz[object] == z) {
      return false;
    }
  }
  return true;
}

bool ObjectProposalsSwap(
    Voxel* voxels,
    int32_t first,
    int32_t second) {
  for (int32_t first_member = g_object_head[first]; first_member >= 0;
       first_member = g_next_object_voxel[first_member]) {
    const int32_t first_x = voxels[first_member].x;
    const int32_t first_y = voxels[first_member].y;
    const int32_t first_z = voxels[first_member].z;
    const int32_t first_next_x = first_x + g_object_dx[first];
    const int32_t first_next_y = first_y + g_object_dy[first];
    const int32_t first_next_z = first_z + g_object_dz[first];
    for (int32_t second_member = g_object_head[second]; second_member >= 0;
         second_member = g_next_object_voxel[second_member]) {
      const int32_t second_x = voxels[second_member].x;
      const int32_t second_y = voxels[second_member].y;
      const int32_t second_z = voxels[second_member].z;
      if (first_next_x == second_x && first_next_y == second_y &&
          first_next_z == second_z &&
          second_x + g_object_dx[second] == first_x &&
          second_y + g_object_dy[second] == first_y &&
          second_z + g_object_dz[second] == first_z) {
        return true;
      }
    }
  }
  return false;
}

void AddSlopeCarriedObjects(
    Voxel* voxels,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool preserve_matching_latent_motion,
    bool player_is_vacating) {
  BuildCarriedObjects(
      voxels, player_index, false, width, height, player_is_vacating, true);
  bool promoted = true;
  while (promoted) {
    promoted = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_carried_objects[object] == 0) continue;
      // A previous pass already copied this carrier's proposal. Do not
      // reinterpret that newly promoted rider as independent momentum and
      // erase the parent needed to stop it when the carrier leaves Ice.
      if (g_mandatory_objects[object] != 0) continue;
      const int32_t carrier = g_carrier_parent[object];
      bool carrier_is_movable_ramp = false;
      if (carrier >= 0) {
        for (int32_t member = g_object_head[carrier]; member >= 0;
             member = g_next_object_voxel[member]) {
          carrier_is_movable_ramp |=
              IsBlueBoxSlopeRole(voxels[member].role) ||
              IsYellowCloneSlopeRole(voxels[member].role);
        }
      }
      const bool rider_continues_before_redirect =
          preserve_matching_latent_motion && carrier >= 0 &&
          !carrier_is_movable_ramp &&
          g_object_direction[object] <= 3 &&
          g_object_direction[object] == g_component_indegree[carrier];
      if (g_object_falling[object] != 0 ||
          rider_continues_before_redirect) {
        // A body already committed to gravity or matching latent momentum
        // keeps that proposal as support departs. A latent falling
        // stack which arrived with its carrier also continues vertically when
        // that support moves out underneath it. Otherwise, a body arriving
        // from another axis has just been caught and follows its carrier.
        g_carried_objects[object] = 0;
        g_moving_objects[object] = g_mandatory_objects[object];
        g_carrier_parent[object] = -1;
        continue;
      }
      if (carrier < 0 || g_mandatory_objects[carrier] == 0) continue;
      g_mandatory_objects[object] = 1;
      g_moving_objects[object] = 1;
      g_object_direction[object] = g_object_direction[carrier];
      g_object_dx[object] = g_object_dx[carrier];
      g_object_dy[object] = g_object_dy[carrier];
      g_object_dz[object] = g_object_dz[carrier];
      promoted = true;
    }
  }
}

bool SlopeObjectDestinationIsClear(
    Voxel* voxels,
    int32_t object,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool player_is_vacating,
    bool deliberate_actor_entry = false) {
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const int32_t next_x = voxels[member].x + g_object_dx[object];
    const int32_t next_y = voxels[member].y + g_object_dy[object];
    const int32_t next_z = voxels[member].z + g_object_dz[object];
    if (!VoxelDestinationIsInsideRoom(voxels[member], next_x, next_y, width, height)) return false;
    if (deliberate_actor_entry && g_object_dz[object] > 0) {
      // Match the singleton player's ascending entry check for every cell
      // of an actor polycube. A ramp beneath one foot cannot lift another
      // foot through an adjacent wall's vertical face. Internal cells and
      // bodies vacating the swept cell in this transaction are harmless.
      const int32_t swept = FindVoxelAt(
          voxels, next_x, next_y, voxels[member].z, width, height);
      if (swept >= 0 && g_voxel_object[swept] != object &&
          !IsIceSlopeRole(voxels[swept].role) &&
          !IsPassThroughVoxel(voxels[swept])) {
        const int32_t other = g_voxel_object[swept];
        if (other < 0 || g_mandatory_objects[other] == 0 ||
            !ObjectProposalVacatesCell(
                voxels, other, next_x, next_y, voxels[member].z)) return false;
      }
    }
    const int32_t occupant = FindVoxelAt(
        voxels, next_x, next_y, next_z, width, height);
    if (g_object_kind[object] == kMechanismObject &&
        MovingFixtureIgnoresOccupant(
            voxels[member], occupant >= 0 ? &voxels[occupant] : nullptr)) {
      continue;
    }
    if (occupant < 0 || g_voxel_object[occupant] == object) continue;
    if (occupant == player_index) {
      if (player_is_vacating) continue;
      return false;
    }
    const int32_t other = g_voxel_object[occupant];
    if (other >= 0 && g_mandatory_objects[other] != 0 &&
        ObjectProposalVacatesCell(voxels, other, next_x, next_y, next_z)) {
      continue;
    }
    if (other >= 0 && g_object_falling[other] != 0 &&
        g_moving_objects[other] == 0 &&
        !FallingObjectRefillsCell(
            voxels, next_x, next_y, next_z, width, height)) {
      continue;
    }
    return false;
  }
  return true;
}

bool ResolveSlopeCarriedCollisions(
    Voxel* voxels,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool player_is_vacating) {
  // Carrying is optional, unlike the deliberate push closure. A passenger
  // caught by terrain stays behind; it does not anchor its moving support.
  // Iterate to revoke passengers of a stopped passenger and proposals whose
  // destination is no longer vacated. No coordinates change until validation.
  bool changed = true;
  while (changed) {
    changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_carried_objects[object] == 0 ||
          g_rejected_carriers[object] != 0) continue;
      const int32_t carrier = g_carrier_parent[object];
      const bool carrier_moves =
          carrier >= 0 && g_mandatory_objects[carrier] != 0;
      if (carrier_moves && SlopeObjectDestinationIsClear(
              voxels, object, player_index, width, height,
              player_is_vacating)) continue;
      if (carrier_moves && g_object_kind[object] == kMechanismObject) {
        // Rigid mounted fixtures retain the existing attachment rule: a
        // blocked raised fixture anchors its carrier, not a loose passenger.
        return false;
      }
      g_rejected_carriers[object] = 1;
      g_mandatory_objects[object] = 0;
      g_moving_objects[object] = 0;
      g_carrier_parent[object] = -1;
      g_object_direction[object] = 0xff;
      g_object_dx[object] = 0;
      g_object_dy[object] = 0;
      g_object_dz[object] = 0;
      changed = true;
    }
  }
  return true;
}

void PreserveSlopeCarriedMomentum(
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  // Carried stacks continue only while the bottom carrier still has slippery
  // support.  This avoids granting a rider an extra tick when the carrier has
  // just reached Wall/Floor, while preserving a whole stack over continuing
  // Ice (including a body partly supported by its moving carrier).
  for (int32_t pass = 0; pass < g_object_count; ++pass) {
    bool changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      const int32_t carrier = g_carrier_parent[object];
      if (carrier < 0) continue;
      const bool carrier_continues = carrier >= 0 &&
          (ObjectIsFullyOnIce(voxels, carrier, width, height) ||
           g_inherited_support_motion[carrier] != 0);
      const uint8_t inherited = carrier_continues
          ? static_cast<uint8_t>(g_object_direction[object] + 1)
          : 0;
      if (g_inherited_support_motion[object] != inherited) {
        g_inherited_support_motion[object] = inherited;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

void PreserveMovableSlopeRiderMomentum(
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_moving_objects[object] == 0 ||
        g_object_redirected[object] == 2) {
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (voxels[member].z == INT32_MIN) continue;
      const int32_t support = FindVoxelAt(
          voxels,
          voxels[member].x,
          voxels[member].y,
          voxels[member].z - 1,
          width,
          height);
      const int32_t carrier = support >= 0 ? g_voxel_object[support] : -1;
      if (carrier < 0 || carrier == object ||
          g_moving_objects[carrier] == 0 ||
          (!IsBlueBoxSlopeRole(voxels[support].role) &&
           !IsYellowCloneSlopeRole(voxels[support].role))) {
        continue;
      }
      g_inherited_support_motion[object] = static_cast<uint8_t>(
          OppositeDirection(IceSlopeDirection(voxels[support].role)) + 1);
      break;
    }
  }
}

bool ObjectCurrentSlopeProposalIsBlocked(
    Voxel* voxels,
    int32_t object,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool player_moves_horizontally) {
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const int32_t next_x = voxels[member].x + g_object_dx[object];
    const int32_t next_y = voxels[member].y + g_object_dy[object];
    const int32_t next_z = voxels[member].z + g_object_dz[object];
    if (!IsInsideRoom(next_x, next_y, width, height)) return true;
    const int32_t occupant = FindVoxelAt(
        voxels, next_x, next_y, next_z, width, height);
    if (occupant < 0 || g_voxel_object[occupant] == object) continue;
    if (occupant == player_index) return !player_moves_horizontally;
    const int32_t other = g_voxel_object[occupant];
    if (other >= 0 && g_mandatory_objects[other] != 0 &&
        ObjectProposalVacatesCell(
            voxels, other, next_x, next_y, next_z)) {
      continue;
    }
    return true;
  }
  return false;
}

// A movable ramp that advances low-edge-first into a horizontally trapped
// weightless body wedges underneath it. The ramp keeps its horizontal
// proposal while the trapped body converts its failed horizontal proposal to
// one vertical step. Untrapped bodies retain the ordinary push closure.
void ConvertTrappedBodiesToMovableSlopeLifts(
    Voxel* voxels,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool player_moves_horizontally) {
  for (int32_t slope_object = 0; slope_object < g_object_count;
       ++slope_object) {
    if (g_mandatory_objects[slope_object] == 0 ||
        (g_object_kind[slope_object] != kWeightlessObject &&
         g_object_kind[slope_object] != kCloneObject)) {
      continue;
    }
    const int32_t movement_direction = g_object_direction[slope_object];
    if (movement_direction < 0 || movement_direction > 3) continue;
    for (int32_t member = g_object_head[slope_object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const uint32_t role = voxels[member].role;
      if ((!IsBlueBoxSlopeRole(role) && !IsYellowCloneSlopeRole(role)) ||
          IceSlopeDirection(role) != OppositeDirection(movement_direction)) {
        continue;
      }
      const int32_t next_x = voxels[member].x + g_object_dx[slope_object];
      const int32_t next_y = voxels[member].y + g_object_dy[slope_object];
      const int32_t next_z = voxels[member].z + g_object_dz[slope_object];
      const int32_t occupant = FindVoxelAt(
          voxels, next_x, next_y, next_z, width, height);
      if (occupant < 0) continue;
      const int32_t lifted = g_voxel_object[occupant];
      if (lifted < 0 || lifted == slope_object ||
          g_object_kind[lifted] != kWeightlessObject ||
          g_mandatory_objects[lifted] == 0 ||
          !ObjectCurrentSlopeProposalIsBlocked(
              voxels,
              lifted,
              player_index,
              width,
              height,
              player_moves_horizontally)) {
        continue;
      }
      g_object_dx[lifted] = 0;
      g_object_dy[lifted] = 0;
      g_object_dz[lifted] = 1;
      // Reflection propagation has already completed, so value 2 is a local
      // marker for this converted vertical proposal. It is cleared before
      // returning to the tick state machine.
      g_object_redirected[lifted] = 2;
    }
  }
}
