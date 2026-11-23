struct PuncherContact {
  bool player = false;
  bool object = false;
  int32_t player_direction = -1;
};

bool PunchWasActivated(int32_t object) {
  return (g_punch_activated[object / 64] & (uint64_t{1} << (object % 64))) != 0;
}

void MarkPunchActivated(int32_t object) {
  g_punch_activated[object / 64] |= uint64_t{1} << (object % 64);
}

int32_t PuncherDirection(const Voxel& puncher) {
  return puncher.role == kPuncherRole && puncher.generic_id >= 0
      ? (puncher.generic_id / 2) & 3
      : -1;
}

bool PuncherIsSprung(const Voxel& puncher) {
  return puncher.role == kPuncherRole &&
      (puncher.generic_id & 1) != 0;
}

bool ResetSprungPunchers(Voxel* voxels) {
  bool changed = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_object_kind[object] != kMechanismObject) continue;
    const int32_t index = g_object_head[object];
    if (!PuncherIsSprung(voxels[index])) continue;
    --voxels[index].generic_id;
    changed = true;
  }
  return changed;
}

bool ObjectCanBePunched(int32_t object) {
  if (object < 0) return false;
  return g_object_kind[object] == kNormalObject ||
      g_object_kind[object] == kWeightlessObject ||
      g_object_kind[object] == kCloneObject ||
      g_object_kind[object] == kPlayerObject;
}

PuncherContact FindPuncherContacts(
    Voxel* voxels,
    int32_t player_index,
    int32_t width,
    int32_t height,
    bool include_sprung) {
  PuncherContact contact;
  const int32_t player_object = player_index >= 0
      ? g_voxel_object[player_index]
      : -1;
  // Mechanisms retain source order, including overlapping punchers. Skip
  // immutable terrain rather than rescanning every voxel on every tick.
  for (int32_t fixture = 0; fixture < g_object_count; ++fixture) {
    if (g_object_kind[fixture] != kMechanismObject) continue;
    const int32_t puncher_index = g_object_head[fixture];
    const Voxel& puncher = voxels[puncher_index];
    const int32_t punch_direction = PuncherDirection(puncher);
    if (punch_direction < 0 ||
        (!include_sprung && PuncherIsSprung(puncher)) ||
        !IsInsideRoom(puncher.x, puncher.y, width, height)) {
      continue;
    }
    if (player_index >= 0 && player_object < 0) {
      const Voxel& player = voxels[player_index];
      if (player.x == puncher.x && player.y == puncher.y &&
          player.z == puncher.z) {
        contact.player = true;
        if (contact.player_direction < 0) {
          contact.player_direction = punch_direction;
        }
      }
    }
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (!ObjectCanBePunched(object) ||
          !ObjectIsActive(voxels, object, width, height)) {
        continue;
      }
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if (voxels[member].x == puncher.x &&
            voxels[member].y == puncher.y &&
            voxels[member].z == puncher.z) {
          contact.object = true;
          break;
        }
      }
    }
  }
  return contact;
}

PuncherContact ActivatePunchers(
    MotionState* state,
    Voxel* voxels,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  PuncherContact contact;
  const int32_t player_object = player_index >= 0
      ? g_voxel_object[player_index]
      : -1;
  // Mechanisms retain source order, including overlapping punchers. Skip
  // immutable terrain rather than rescanning every voxel on every tick.
  for (int32_t fixture = 0; fixture < g_object_count; ++fixture) {
    if (g_object_kind[fixture] != kMechanismObject) continue;
    const int32_t puncher_index = g_object_head[fixture];
    Voxel& puncher = voxels[puncher_index];
    const int32_t punch_direction = PuncherDirection(puncher);
    if (punch_direction < 0 || PuncherIsSprung(puncher) ||
        !IsInsideRoom(puncher.x, puncher.y, width, height)) {
      continue;
    }
    bool triggered = false;
    if (player_index >= 0 && player_object < 0) {
      const Voxel& player = voxels[player_index];
      if (player.x == puncher.x && player.y == puncher.y &&
          player.z == puncher.z) {
        contact.player = true;
        triggered = true;
        if (contact.player_direction < 0) {
          contact.player_direction = punch_direction;
        }
      }
    }
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (!ObjectCanBePunched(object) ||
          !ObjectIsActive(voxels, object, width, height)) {
        continue;
      }
      bool overlaps = false;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        overlaps |= voxels[member].x == puncher.x &&
            voxels[member].y == puncher.y &&
            voxels[member].z == puncher.z;
      }
      if (!overlaps) continue;
      contact.object = true;
      triggered = true;
      MarkPunchActivated(object);
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        state->horizontal_momentum[member] = static_cast<uint8_t>(
            kPunchMomentumBase + punch_direction);
      }
    }
    if (triggered) ++puncher.generic_id;
  }
  return contact;
}

void SeedMovingObjectsWithPunchMomentum(
    MotionState* state,
    int32_t direction) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0 ||
        g_object_kind[object] == kMechanismObject) {
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      state->horizontal_momentum[member] = static_cast<uint8_t>(
          kPunchMomentumBase + direction);
    }
  }
}

bool HasPunchObjectMomentum(
    const MotionState* state,
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  if (g_voxel_object[state->player_index] < 0 &&
      IsPunchMomentum(state->horizontal_momentum[state->player_index])) {
    return true;
  }
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (IsPunchMomentum(ReadObjectMomentum(
            state->horizontal_momentum, object)) &&
        ObjectIsActive(voxels, object, width, height)) {
      return true;
    }
  }
  return false;
}

// Only the activation tick transmits a new impulse through an already-touching
// chain. Later collisions stop the moving body rather than starting new ones.
void PreparePunchContactProposals(
    MotionState* state, Voxel* voxels, int32_t player_index,
    int32_t width, int32_t height, int32_t& player_direction) {
  const uint8_t player_momentum = state->horizontal_momentum[player_index];
  if (g_voxel_object[player_index] < 0 && IsPunchMomentum(player_momentum)) {
    player_direction = (player_momentum - 1) & 3;
  }
  bool added = true;
  while (added) {
    added = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (!PunchWasActivated(object) || g_mandatory_objects[object] == 0) continue;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if (!VoxelDestinationIsInsideRoom(voxels[member],
                voxels[member].x + g_object_dx[object],
                voxels[member].y + g_object_dy[object], width, height)) continue;
        const int32_t occupant = FindVoxelAt(voxels,
            voxels[member].x + g_object_dx[object],
            voxels[member].y + g_object_dy[object],
            voxels[member].z + g_object_dz[object], width, height);
        if (occupant < 0) continue;
        const int32_t direction = g_object_direction[object];
        if (occupant == player_index && g_voxel_object[player_index] < 0) {
          if (player_direction < 0) {
            player_direction = direction;
            state->horizontal_momentum[player_index] = static_cast<uint8_t>(
                kPunchMomentumBase + direction);
          }
          continue;
        }
        const int32_t target = g_voxel_object[occupant];
        if (target < 0 || g_mandatory_objects[target] != 0 ||
            !DeliberatePushMayRecruit(object, target)) continue;
        g_mandatory_objects[target] = 1;
        g_moving_objects[target] = 1;
        MarkPunchActivated(target);
        g_object_direction[target] = static_cast<uint8_t>(direction);
        PrepareSlopeObjectProposal(voxels, target, width, height, false);
        for (int32_t part = g_object_head[target]; part >= 0;
             part = g_next_object_voxel[part]) {
          state->horizontal_momentum[part] = static_cast<uint8_t>(
              kPunchMomentumBase + direction);
        }
        added = true;
      }
    }
  }
}

// Resolve all proposals against the same board before committing any of them.
// A blocked leader stops the bodies behind it, while departing bodies and the
// independently punched player keep their remaining impulse.
void ResolvePunchProposals(
    MotionState* state, Voxel* voxels, int32_t player_index,
    int32_t width, int32_t height, bool player_is_vacating,
    int32_t& player_direction) {
  constexpr int32_t kDx[] = {0, 1, 0, -1};
  constexpr int32_t kDy[] = {-1, 0, 1, 0};
  const Voxel& player = voxels[player_index];
  bool changed = true;
  while (changed) {
    changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      g_component_objects[object] = 0;
    }
    bool player_blocked = false;
    const int32_t px = player.x + (player_direction >= 0 ? kDx[player_direction] : 0);
    const int32_t py = player.y + (player_direction >= 0 ? kDy[player_direction] : 0);
    if (player_direction >= 0) {
      player_blocked = !IsInsideRoom(px, py, width, height);
      const int32_t occupant = FindVoxelAt(voxels, px, py, player.z, width, height);
      if (occupant >= 0 && occupant != player_index) {
        const int32_t other = g_voxel_object[occupant];
        player_blocked |= other < 0 || g_mandatory_objects[other] == 0 ||
            !ObjectProposalVacatesCell(voxels, other, px, py, player.z);
      }
    }
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_mandatory_objects[object] == 0) continue;
      const int32_t carrier = g_carrier_parent[object];
      if (g_carried_objects[object] != 0 && carrier >= 0 &&
          g_mandatory_objects[carrier] == 0) g_component_objects[object] = 1;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const Voxel& voxel = voxels[member];
        const int32_t x = voxel.x + g_object_dx[object];
        const int32_t y = voxel.y + g_object_dy[object];
        const int32_t z = voxel.z + g_object_dz[object];
        if (!VoxelDestinationIsInsideRoom(voxel, x, y, width, height)) {
          g_component_objects[object] = 1;
          continue;
        }
        if (IsPassThroughVoxel(voxel)) continue;
        const int32_t occupant = FindVoxelAt(voxels, x, y, z, width, height);
        if (occupant == player_index && g_voxel_object[player_index] < 0) {
          if (player_direction < 0 && !player_is_vacating) g_component_objects[object] = 1;
          // Exchanging cells is a collision, even if both destinations vacate.
          if (player_direction >= 0 && px == voxel.x && py == voxel.y && player.z == voxel.z) {
            g_component_objects[object] = 1;
            player_blocked = true;
          }
        } else if (occupant >= 0 && g_voxel_object[occupant] != object) {
          const int32_t other = g_voxel_object[occupant];
          if (other < 0 || g_mandatory_objects[other] == 0 ||
              !ObjectProposalVacatesCell(voxels, other, x, y, z)) {
            g_component_objects[object] = 1;
          } else if (ObjectProposalsSwap(voxels, object, other)) {
            g_component_objects[object] = 1;
            g_component_objects[other] = 1;
          }
        }
        if (player_direction >= 0 && x == px && y == py && z == player.z) {
          g_component_objects[object] = 1;
          player_blocked = true;
        }
        for (int32_t other = object + 1; other < g_object_count; ++other) {
          if (g_mandatory_objects[other] == 0) continue;
          for (int32_t part = g_object_head[other]; part >= 0;
               part = g_next_object_voxel[part]) {
            if (!IsPassThroughVoxel(voxels[part]) &&
                x == voxels[part].x + g_object_dx[other] &&
                y == voxels[part].y + g_object_dy[other] &&
                z == voxels[part].z + g_object_dz[other]) {
              g_component_objects[object] = 1;
              g_component_objects[other] = 1;
            }
          }
        }
      }
    }
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_component_objects[object] != 0 &&
          g_object_kind[object] == kMechanismObject && g_carrier_parent[object] >= 0) {
        g_component_objects[g_carrier_parent[object]] = 1;
      }
    }
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_mandatory_objects[object] == 0 || g_component_objects[object] == 0) continue;
      g_mandatory_objects[object] = 0;
      g_moving_objects[object] = 0;
      g_inherited_support_motion[object] = 0;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) state->horizontal_momentum[member] = 0;
      changed = true;
    }
    if (player_direction >= 0 && player_blocked) {
      player_direction = -1;
      state->horizontal_momentum[player_index] = 0;
      changed = true;
    }
  }
}
