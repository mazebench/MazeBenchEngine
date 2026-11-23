// A terrain lift is stored at its base cell. Even IDs are lowered and odd IDs
// are raised. IDs 0/1 are the upward floor-mounted pair; the remaining pairs
// encode front/right/back/left side mountings. The side orientation is its
// outward direction: raising displaces a rider one cell along that direction.
int32_t PlayerLiftSideOutwardDirection(const Voxel& lift) {
  if (lift.role != kPlayerLiftRole || lift.generic_id < 2 ||
      lift.generic_id > 9) {
    return -1;
  }
  return lift.generic_id / 2 - 1;
}

int32_t PlayerLiftActuatedObjectAt(
    Voxel* voxels,
    int32_t count,
    int32_t x,
    int32_t y,
    int32_t z) {
  for (int32_t index = 0; index < count; ++index) {
    if (voxels[index].x != x || voxels[index].y != y ||
        voxels[index].z != z) {
      continue;
    }
    const int32_t object = g_voxel_object[index];
    if (object >= 0 && g_object_kind[object] != kMechanismObject) {
      return object;
    }
  }
  return -1;
}

bool TranslatePlayerLiftPayload(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t lift_index,
    int32_t source_x,
    int32_t source_y,
    int32_t source_z,
    int32_t dx,
    int32_t dy,
    int32_t dz,
    int32_t width,
    int32_t height,
    bool commit_translation = true,
    int32_t actor_index = -1,
    const uint8_t* selected_lifts = nullptr) {
  if (actor_index < 0) actor_index = player_index;
  ClearMovingObjects();
  int32_t seeded = 0;

  // Fixtures mounted to the actuating lift move with its physical cube even
  // though the lift's authored voxel remains at a stable anchor. Build a
  // transitive attachment closure so a button (and future mechanism fixture)
  // mounted on another attached fixture rides in the same transaction.
  const int32_t lift_object = lift_index >= 0 && lift_index < count
      ? g_voxel_object[lift_index]
      : -1;
  if (lift_object >= 0) {
    for (int32_t object = 0; object < g_object_count; ++object) {
      g_component_objects[object] = 0;
    }
    g_component_objects[lift_object] = 1;
    if (selected_lifts != nullptr) {
      for (int32_t index = 0; index < count; ++index) {
        if ((selected_lifts[index] & kActorLiftSelected) != 0 &&
            voxels[index].role == kPlayerLiftRole && g_voxel_object[index] >= 0) {
          g_component_objects[g_voxel_object[index]] = 1;
        }
      }
    }
    bool added_fixture = true;
    while (added_fixture) {
      added_fixture = false;
      for (int32_t object = 0; object < g_object_count; ++object) {
        if (object == lift_object || g_component_objects[object] != 0 ||
            g_object_kind[object] != kMechanismObject) {
          continue;
        }
        const int32_t fixture = g_object_head[object];
        if (fixture < 0) continue;
        bool attached = OrangeButtonTracksPlayerLift(
            voxels[fixture], voxels[lift_index]);
        if (!attached && selected_lifts != nullptr) {
          for (int32_t index = 0; index < count && !attached; ++index) {
            attached = (selected_lifts[index] & kActorLiftSelected) != 0 &&
                OrangeButtonTracksPlayerLift(voxels[fixture], voxels[index]);
          }
        }
        if (!attached) {
          const int32_t support = MechanismAttachmentVoxel(
              voxels, object, width, height);
          const int32_t support_object = support >= 0
              ? g_voxel_object[support]
              : -1;
          attached = support_object >= 0 &&
              g_component_objects[support_object] != 0;
        }
        if (!attached) continue;
        g_component_objects[object] = 1;
        g_mandatory_objects[object] = 1;
        g_moving_objects[object] = 1;
        ++seeded;
        added_fixture = true;
      }
    }
  }

  auto seed_at = [&](int32_t x, int32_t y, int32_t z) {
    const int32_t object = PlayerLiftActuatedObjectAt(
        voxels, count, x, y, z);
    if (object >= 0 && g_mandatory_objects[object] == 0) {
      g_mandatory_objects[object] = 1;
      g_moving_objects[object] = 1;
      ++seeded;
    }
  };

  if (dz != 0) {
    // A top lift can share its lowered cell with the bottom voxel of a
    // polycube. It also directly contacts a body one cell above the rider.
    // Seed both contacts, then let the ordinary rigid translation closure
    // move every stacked/carried body as one transactional proposal.
    seed_at(source_x, source_y, source_z);
    if (source_z != INT32_MAX) {
      seed_at(source_x, source_y, source_z + 1);
    }
  } else {
    if (g_voxel_object[actor_index] >= 0) {
      seed_at(source_x, source_y, source_z);
    }
    seed_at(source_x + dx, source_y + dy, source_z);
  }

  if (seeded == 0) {
    const int32_t target_x = source_x + dx;
    const int32_t target_y = source_y + dy;
    const int32_t target_z = source_z + dz;
    const int32_t occupant = FindVoxelAt(
        voxels, target_x, target_y, target_z, width, height);
    return occupant < 0 || occupant == player_index || occupant == lift_index;
  }

  // Clone/polycube riders are already in the seeded rigid payload. The main
  // single-cell player is displaced separately only when it rides that payload.
  // A lowering lift's cube vacates the destination in this same transaction.
  // Build fixture attachments before folding it, then restore its state here;
  // the caller commits the visible toggle only after collision validation.
  const bool folds_for_payload = dz < 0 && g_voxel_object[actor_index] >= 0;
  const auto fold_lifts = [&](int32_t delta) {
    if (!folds_for_payload) return;
    voxels[lift_index].generic_id += delta;
    if (selected_lifts != nullptr) {
      for (int32_t index = 0; index < count; ++index) {
        if (index != lift_index && (selected_lifts[index] & kActorLiftSelected) != 0) {
          voxels[index].generic_id += delta;
        }
      }
    }
    BuildSpatialIndex(voxels, count, width, height);
  };
  fold_lifts(-1);
  bool player_follows_payload = actor_index == player_index;
  bool payload_valid = true;
  if (!player_follows_payload && g_voxel_object[player_index] < 0) {
    payload_valid = TranslateMovingObjects(voxels, count, player_index, dx, dy, dz,
        width, height, false, true, true, false, false);
    player_follows_payload = MovingPlayerCarrier(
        voxels, player_index, width, height) >= 0;
  }
  const bool moved = payload_valid && TranslateMovingObjects(
      voxels,
      count,
      player_index,
      dx,
      dy,
      dz,
      width,
      height,
      false,
      true,
      player_follows_payload,
      actor_index == player_index,
      commit_translation);
  fold_lifts(1);
  if (moved && commit_translation && player_follows_payload &&
      actor_index != player_index && g_voxel_object[player_index] < 0) {
    voxels[player_index].x += dx;
    voxels[player_index].y += dy;
    voxels[player_index].z += dz;
    BuildSpatialIndex(voxels, count, width, height);
  }
  return moved;
}

// Only a player that horizontally enters a lowered platform toggles it; a
// rider carried by another body does not retrigger it.
int32_t PlayerLiftAtPlayer(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool& raise) {
  const Voxel& player = voxels[player_index];
  if (!IsInsideRoom(player.x, player.y, width, height)) return -1;
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& lift = voxels[index];
    if (lift.role != kPlayerLiftRole || lift.x != player.x ||
        lift.y != player.y) {
      continue;
    }
    if (lift.generic_id < 0 || lift.generic_id > 9) continue;
    if (!PlayerLiftIsRaised(lift) && lift.z == player.z) {
      raise = true;
      return index;
    }
    if (lift.generic_id <= 1 && PlayerLiftIsRaised(lift) &&
        player.z != INT32_MIN &&
        lift.z == player.z - 1) {
      raise = false;
      return index;
    }
  }
  return -1;
}

int32_t PlayerLiftCountAtPlayer(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  const Voxel& player = voxels[player_index];
  if (!IsInsideRoom(player.x, player.y, width, height)) return 0;
  int32_t matches = 0;
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& lift = voxels[index];
    if (lift.role != kPlayerLiftRole || lift.x != player.x ||
        lift.y != player.y || lift.generic_id < 0 ||
        lift.generic_id > 9) {
      continue;
    }
    if ((!PlayerLiftIsRaised(lift) && lift.z == player.z) ||
        (lift.generic_id <= 1 && PlayerLiftIsRaised(lift) &&
         player.z != INT32_MIN && lift.z == player.z - 1)) {
      ++matches;
    }
  }
  return matches;
}

bool TranslateSlopeMomentumObjects(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool allow_push,
    bool pushed_targets_require_ice,
    bool allow_downhill_contact_push,
    bool player_moves_horizontally,
    bool& player_was_pushed,
    int32_t required_player_carrier = -1,
    MotionState* punch_state = nullptr);

// Several pass-through fixtures may deliberately share a voxel. An overlap
// is not an ordering rule: incompatible lifts cancel instead of allowing the
// first voxel in storage to win. The unambiguous multi-lift arrangement is a
// balanced set of opposed side lifts, each mounted to a distinct movable
// body. In that case the trapped rider stays centered and the mounted bodies
// receive the equal-and-opposite recoil proposals in one transaction.
bool OverlappingPlayerLiftsCanRecoil(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  constexpr int32_t kMaximumDirections = 4;
  int32_t support_objects[kMaximumDirections] = {-1, -1, -1, -1};
  uint8_t directions = 0;
  int32_t matches = 0;
  const Voxel& player = voxels[player_index];
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& lift = voxels[index];
    if (lift.role != kPlayerLiftRole || lift.x != player.x ||
        lift.y != player.y || lift.z != player.z ||
        PlayerLiftIsRaised(lift)) {
      continue;
    }
    const int32_t outward = PlayerLiftSideOutwardDirection(lift);
    const int32_t lift_object = g_voxel_object[index];
    if (outward < 0 || lift_object < 0 || matches >= kMaximumDirections ||
        (directions & (1u << outward)) != 0) {
      return false;
    }
    const int32_t attachment = PlayerLiftSideAttachmentVoxel(
        voxels, lift_object, width, height);
    const int32_t support_object = attachment >= 0
        ? g_voxel_object[attachment]
        : -1;
    if (support_object < 0 || support_object == lift_object ||
        g_object_kind[support_object] == kMechanismObject) {
      return false;
    }
    for (int32_t prior = 0; prior < matches; ++prior) {
      if (support_objects[prior] == support_object) return false;
    }
    support_objects[matches++] = support_object;
    directions |= static_cast<uint8_t>(1u << outward);
  }
  if (matches < 2) return false;
  const bool north_south_balanced =
      ((directions & 0b0001u) != 0) == ((directions & 0b0100u) != 0);
  const bool east_west_balanced =
      ((directions & 0b0010u) != 0) == ((directions & 0b1000u) != 0);
  return north_south_balanced && east_west_balanced;
}

bool RecoilOverlappingPlayerLifts(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height,
    int32_t primary_player_index = -1) {
  if (primary_player_index < 0) primary_player_index = player_index;
  if (!OverlappingPlayerLiftsCanRecoil(
          voxels, count, player_index, width, height)) {
    return false;
  }

  ClearMovingObjects();
  const Voxel& player = voxels[player_index];
  for (int32_t index = 0; index < count; ++index) {
    Voxel& lift = voxels[index];
    if (lift.role != kPlayerLiftRole || lift.x != player.x ||
        lift.y != player.y || lift.z != player.z ||
        PlayerLiftIsRaised(lift)) {
      continue;
    }
    const int32_t lift_object = g_voxel_object[index];
    const int32_t attachment = PlayerLiftSideAttachmentVoxel(
        voxels, lift_object, width, height);
    const int32_t support_object = g_voxel_object[attachment];
    const int32_t recoil = OppositeDirection(
        PlayerLiftSideOutwardDirection(lift));
    g_mandatory_objects[lift_object] = 1;
    g_moving_objects[lift_object] = 1;
    g_object_direction[lift_object] = static_cast<uint8_t>(recoil);
    g_mandatory_objects[support_object] = 1;
    g_moving_objects[support_object] = 1;
    g_object_direction[support_object] = static_cast<uint8_t>(recoil);
  }

  // Fixtures attached to either recoiling body inherit that body's proposal.
  // This is a transitive closure so buttons and future surface mechanisms do
  // not detach merely because the lift event has more than one direction.
  bool added_fixture = true;
  while (added_fixture) {
    added_fixture = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_mandatory_objects[object] != 0 ||
          g_object_kind[object] != kMechanismObject) {
        continue;
      }
      const int32_t attachment = MechanismAttachmentVoxel(
          voxels, object, width, height);
      const int32_t support_object = attachment >= 0
          ? g_voxel_object[attachment]
          : -1;
      if (support_object < 0 || g_mandatory_objects[support_object] == 0) {
        continue;
      }
      g_mandatory_objects[object] = 1;
      g_moving_objects[object] = 1;
      g_object_direction[object] = g_object_direction[support_object];
      added_fixture = true;
    }
  }

  // Raised state participates in collision validation. Voxel indices remain
  // stable during the transaction, so a rejected proposal can restore every
  // participating lift without a scene copy.
  for (int32_t index = 0; index < count; ++index) {
    Voxel& lift = voxels[index];
    if (lift.role == kPlayerLiftRole && !PlayerLiftIsRaised(lift) &&
        lift.x == player.x && lift.y == player.y && lift.z == player.z) {
      ++lift.generic_id;
    }
  }
  bool player_was_pushed = false;
  const bool moved = TranslateSlopeMomentumObjects(
      voxels,
      count,
      primary_player_index,
      width,
      height,
      true,
      false,
      false,
      false,
      player_was_pushed);
  if (moved) return true;
  for (int32_t index = 0; index < count; ++index) {
    Voxel& lift = voxels[index];
    if (lift.role == kPlayerLiftRole && PlayerLiftIsRaised(lift) &&
        lift.x == player.x && lift.y == player.y && lift.z == player.z) {
      --lift.generic_id;
    }
  }
  return false;
}

bool PlayerLiftCanToggleOnEntry(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t from_x,
    int32_t from_y,
    int32_t width,
    int32_t height) {
  if (IsPreparedScene(voxels, count, width, height) &&
      !ActiveWorkspace().prepared_has_player_lifts) return false;
  const Voxel& player = voxels[player_index];
  if (player.x == from_x && player.y == from_y) return false;
  const int32_t lift_count = PlayerLiftCountAtPlayer(
      voxels, count, player_index, width, height);
  if (lift_count > 1) {
    return OverlappingPlayerLiftsCanRecoil(
        voxels, count, player_index, width, height);
  }
  bool raise = false;
  const int32_t lift_index = PlayerLiftAtPlayer(
      voxels, count, player_index, width, height, raise);
  if (lift_index < 0) return false;
  if (!raise) return true;
  const Voxel& lift = voxels[lift_index];
  if (PlayerLiftSideOutwardDirection(lift) >= 0) {
    const int32_t direction = PlayerLiftSideOutwardDirection(lift);
    constexpr int32_t kLiftDx[] = {0, 1, 0, -1};
    constexpr int32_t kLiftDy[] = {-1, 0, 1, 0};
    return IsInsideRoom(
        lift.x + kLiftDx[direction],
        lift.y + kLiftDy[direction],
        width,
        height);
  }
  return player.z != INT32_MAX;
}

bool RaiseVacatedPlayerLift(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t from_x,
    int32_t from_y,
    int32_t from_z) {
  if (ActiveWorkspace().prepared_voxels == voxels &&
      ActiveWorkspace().prepared_count == count &&
      !ActiveWorkspace().prepared_has_player_lifts) return false;
  const Voxel& player = voxels[player_index];
  if (player.x == from_x && player.y == from_y && player.z == from_z) {
    return false;
  }
  int32_t lowered_lifts = 0;
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& lift = voxels[index];
    lowered_lifts += lift.role == kPlayerLiftRole && lift.generic_id >= 0 &&
        lift.generic_id <= 9 && lift.generic_id % 2 == 0 &&
        lift.x == from_x && lift.y == from_y && lift.z == from_z
        ? 1
        : 0;
  }
  if (lowered_lifts > 1) return false;
  for (int32_t index = 0; index < count; ++index) {
    Voxel& lift = voxels[index];
    if (lift.role == kPlayerLiftRole && lift.generic_id >= 0 &&
        lift.generic_id <= 9 && lift.generic_id % 2 == 0 &&
        lift.x == from_x && lift.y == from_y && lift.z == from_z) {
      // A blocked rider has left this fixture. Retry on the following tick;
      // the empty lift raises at its anchor without pushing its outward cell.
      if (lift.generic_id <= 1) {
        for (int32_t button_index = 0; button_index < count; ++button_index) {
          Voxel& button = voxels[button_index];
          if (!OrangeButtonTracksPlayerLift(button, lift)) continue;
          if (button.z != INT32_MAX) ++button.z;
          if (button.generic_id >= 0) button.generic_id &= ~1;
        }
      }
      ++lift.generic_id;
      return true;
    }
  }
  return false;
}

void QueueVacatedPlayerLiftRetry(
    MotionState* state, Voxel* voxels,
    int32_t from_x, int32_t from_y, int32_t from_z) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    const int32_t index = g_object_head[object];
    const Voxel& lift = voxels[index];
    if (lift.role == kPlayerLiftRole && lift.x == from_x &&
        lift.y == from_y && lift.z == from_z) {
      state->gravity_armed[index] |= kVacatedLiftRetryPending;
    }
  }
}

bool HasPendingVacatedPlayerLifts(const MotionState* state, Voxel* voxels) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    const int32_t index = g_object_head[object];
    if (voxels[index].role == kPlayerLiftRole &&
        (state->gravity_armed[index] & kVacatedLiftRetryPending) != 0) return true;
  }
  return false;
}

bool AdvanceVacatedPlayerLifts(
    MotionState* state, Voxel* voxels, int32_t count, int32_t player_index) {
  bool advanced = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    const int32_t index = g_object_head[object];
    const Voxel& lift = voxels[index];
    if (lift.role != kPlayerLiftRole ||
        (state->gravity_armed[index] & kVacatedLiftRetryPending) == 0) continue;
    state->gravity_armed[index] &= static_cast<uint8_t>(~kVacatedLiftRetryPending);
    advanced |= RaiseVacatedPlayerLift(
        voxels, count, player_index, lift.x, lift.y, lift.z);
  }
  return advanced;
}

bool VacatedPlayerLiftNeedsRetry(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  if (IsPreparedScene(voxels, count, width, height) &&
      !ActiveWorkspace().prepared_has_player_lifts) return false;
  const Voxel& player = voxels[player_index];
  int32_t lift_index = -1;
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& lift = voxels[index];
    if (lift.role != kPlayerLiftRole || lift.generic_id < 0 ||
        lift.generic_id > 9 || PlayerLiftIsRaised(lift) ||
        lift.x != player.x || lift.y != player.y || lift.z != player.z) {
      continue;
    }
    if (lift_index >= 0) return false;
    lift_index = index;
  }
  if (lift_index < 0) return false;
  const int32_t outward = PlayerLiftSideOutwardDirection(voxels[lift_index]);
  constexpr int32_t kLiftDx[] = {0, 1, 0, -1};
  constexpr int32_t kLiftDy[] = {-1, 0, 1, 0};
  if (outward < 0 && player.z == INT32_MAX) return false;
  const int32_t dx = outward >= 0 ? kLiftDx[outward] : 0;
  const int32_t dy = outward >= 0 ? kLiftDy[outward] : 0;
  if (!IsInsideRoom(player.x + dx, player.y + dy, width, height)) return false;

  // Probe the lift transaction without committing it. A lowered lift which
  // could have raised its rider is an authored stable state and stays down
  // after departure. Only a lift whose attempted rise was obstructed earns a
  // one-tick retry after the rider has moved clear.
  return !TranslatePlayerLiftPayload(
      voxels,
      count,
      player_index,
      lift_index,
      player.x,
      player.y,
      player.z,
      dx,
      dy,
      outward < 0 ? 1 : 0,
      width,
      height,
      false);
}

bool TogglePlayerLiftAtPlayer(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height,
    int32_t primary_player_index = -1,
    const uint8_t* selected_lifts = nullptr) {
  if (primary_player_index < 0) primary_player_index = player_index;
  Voxel& player = voxels[player_index];
  if (PlayerLiftCountAtPlayer(
          voxels, count, player_index, width, height) > 1) {
    return RecoilOverlappingPlayerLifts(
        voxels, count, player_index, width, height, primary_player_index);
  }
  bool raise = false;
  const int32_t lift_index = PlayerLiftAtPlayer(
      voxels, count, player_index, width, height, raise);
  if (lift_index < 0) return false;

  if (raise) {
    const int32_t outward = PlayerLiftSideOutwardDirection(
        voxels[lift_index]);
    if (outward >= 0) {
      constexpr int32_t kLiftDx[] = {0, 1, 0, -1};
      constexpr int32_t kLiftDy[] = {-1, 0, 1, 0};
      const int32_t target_x = player.x + kLiftDx[outward];
      const int32_t target_y = player.y + kLiftDy[outward];
      if (!IsInsideRoom(target_x, target_y, width, height) ||
          !TranslatePlayerLiftPayload(
              voxels,
              count,
              primary_player_index,
              lift_index,
              player.x,
              player.y,
              player.z,
              kLiftDx[outward],
              kLiftDy[outward],
              0,
              width,
              height,
              true,
              player_index,
              selected_lifts)) {
        return false;
      }
      ++voxels[lift_index].generic_id;
      if (g_voxel_object[player_index] < 0) {
        player.x = target_x;
        player.y = target_y;
      }
      return true;
    }
    if (player.z == INT32_MAX ||
        !TranslatePlayerLiftPayload(
            voxels,
            count,
            primary_player_index,
            lift_index,
            player.x,
            player.y,
            player.z,
            0,
            0,
            1,
            width,
            height,
            true,
            player_index,
            selected_lifts)) {
      return false;
    }
    ++voxels[lift_index].generic_id;
    if (g_voxel_object[player_index] < 0) ++player.z;
  } else {
    if (!TranslatePlayerLiftPayload(
            voxels,
            count,
            primary_player_index,
            lift_index,
            player.x,
            player.y,
            player.z,
            0,
            0,
            -1,
            width,
            height,
            true,
            player_index,
            selected_lifts)) {
      return false;
    }
    --voxels[lift_index].generic_id;
    if (g_voxel_object[player_index] < 0) --player.z;
  }
  return true;
}
