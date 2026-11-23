int32_t CreateObject(uint8_t kind) {
  const int32_t object = g_object_count++;
  g_object_head[object] = -1;
  g_object_kind[object] = kind;
  g_object_gravity_armed[object] = 0;
  g_object_falling[object] = 0;
  g_inherited_support_motion[object] = 0;
  return object;
}

void AddVoxelToObject(int32_t voxel, int32_t object) {
  g_voxel_object[voxel] = object;
  g_next_object_voxel[voxel] = g_object_head[object];
  g_object_head[object] = voxel;
}

void BuildObjects(Voxel* voxels, int32_t count) {
  g_object_count = 0;
  g_weightless_object_count = 0;
  ActiveWorkspace().room_grid_width = 0;
  ActiveWorkspace().room_grid_height = 0;
  ActiveWorkspace().scene_has_orange_mechanisms = false;
  ActiveWorkspace().scene_has_player_gates = false;
  ResetHash();
  int32_t player_count = 0;
  for (int32_t index = 0; index < count; ++index) {
    player_count += voxels[index].role == kPlayerRole ? 1 : 0;
    const Voxel& voxel = voxels[index];
    if (voxel.role == kPlayerRole && voxel.generic_id >= 0 &&
        (voxel.generic_id & kPlayerRoomGridIdFlag) != 0) {
      const int32_t room_width = voxel.generic_id & kRoomGridDimensionMask;
      const int32_t room_height =
          (voxel.generic_id >> kRoomGridDimensionBits) & kRoomGridDimensionMask;
      if (room_width > 0 && room_height > 0) {
        ActiveWorkspace().room_grid_width = room_width;
        ActiveWorkspace().room_grid_height = room_height;
      }
    }
  }
  const int32_t player_object = player_count > 1
      ? CreateObject(kPlayerObject)
      : -1;
  for (int32_t index = 0; index < count; ++index) {
    g_voxel_object[index] = -1;
    g_next_object_voxel[index] = -1;
    if (voxels[index].role == kPlayerRole && player_object >= 0) {
      AddVoxelToObject(index, player_object);
      continue;
    }
    if (voxels[index].role == kPushableRole ||
        voxels[index].role == kFloatingFloorRole) {
      AddVoxelToObject(index, CreateObject(kNormalObject));
      continue;
    }
    if (voxels[index].role == kPlayerLiftRole ||
        voxels[index].role == kOrangeButtonRole ||
        voxels[index].role == kPuncherRole) {
      // A lift is an independently stateful fixture, but it is still a body:
      // when a moving polycube carries it, it translates and falls with that
      // support. It is not directly player-pushable.
      AddVoxelToObject(index, CreateObject(kMechanismObject));
      ActiveWorkspace().scene_has_orange_mechanisms |=
          voxels[index].role == kOrangeButtonRole;
      continue;
    }
    if (voxels[index].role == kOrangeWallRole) {
      ActiveWorkspace().scene_has_orange_mechanisms = true;
      continue;
    }
    if (voxels[index].role == kPlayerGateRole) {
      ActiveWorkspace().scene_has_player_gates = true;
      continue;
    }
    if (!IsWeightlessObjectRole(voxels[index].role) &&
        !IsCloneObjectRole(voxels[index].role)) continue;

    const bool clone = IsCloneObjectRole(voxels[index].role);
    const uint32_t family_role = clone ? kCloneRole : kWeightlessPushableRole;
    const uint64_t object_key =
        (static_cast<uint64_t>(family_role) << 32u) |
        static_cast<uint32_t>(voxels[index].generic_id);
    int32_t object = HashFind(object_key);
    if (object < 0) {
      object = CreateObject(clone ? kCloneObject : kWeightlessObject);
      if (!clone) ++g_weightless_object_count;
      HashInsert(object_key, object);
    }
    AddVoxelToObject(index, object);
  }
}

bool PlayerLiftContactIsActor(
    Voxel* voxels,
    int32_t lift_index,
    int32_t support_index) {
  // Walking underneath (or beside) terrain does not mount it onto the actor.
  // Other bodies still carry lifts fastened to their faces.
  return lift_index >= 0 && support_index >= 0 &&
      voxels[lift_index].role == kPlayerLiftRole &&
      (voxels[support_index].role == kPlayerRole ||
       IsCloneObjectRole(voxels[support_index].role));
}

// Directional lifts are fixtures mounted to one face of a supporting body.
// Their encoded orientation is the outward normal, so the attachment lies in
// the opposite direction. Top lifts continue to use ordinary support-below
// logic; this helper covers the four side-mounted pairs (IDs 2 through 9).
int32_t PlayerLiftSideAttachmentVoxel(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  if (object < 0 || g_object_kind[object] != kMechanismObject) return -1;
  const int32_t member = g_object_head[object];
  if (member < 0 ||
      (voxels[member].role != kPlayerLiftRole &&
       voxels[member].role != kOrangeButtonRole)) {
    return -1;
  }
  const Voxel& lift = voxels[member];
  const int32_t orientation = lift.generic_id >= 0
      ? lift.generic_id / 2
      : 0;
  int32_t support_x = lift.x;
  int32_t support_y = lift.y;
  if (orientation == 1) {
    ++support_y;  // North/front lift is mounted to its south face.
  } else if (orientation == 2) {
    --support_x;  // East/right lift is mounted to its west face.
  } else if (orientation == 3) {
    --support_y;  // South/back lift is mounted to its north face.
  } else if (orientation == 4) {
    ++support_x;  // West/left lift is mounted to its east face.
  } else {
    return -1;
  }
  const int32_t support = FindVoxelAt(
      voxels, support_x, support_y, lift.z, width, height);
  return support == g_ignored_support_voxel ||
      PlayerLiftContactIsActor(voxels, member, support) ? -1 : support;
}

int32_t MechanismAttachmentVoxel(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  if (object < 0 || g_object_kind[object] != kMechanismObject) return -1;
  const int32_t member = g_object_head[object];
  if (member < 0) return -1;
  const Voxel& mechanism = voxels[member];
  if (mechanism.role != kPlayerLiftRole &&
      mechanism.role != kOrangeButtonRole &&
      mechanism.role != kPuncherRole) {
    return -1;
  }
  if (mechanism.role == kPuncherRole) {
    const int32_t direction = mechanism.generic_id >= 0
        ? OrangeLocalId(mechanism) / 2
        : 0;
    int32_t support_x = mechanism.x;
    int32_t support_y = mechanism.y;
    if (direction == 0) {
      ++support_y;
    } else if (direction == 1) {
      --support_x;
    } else if (direction == 2) {
      --support_y;
    } else if (direction == 3) {
      ++support_x;
    } else {
      return -1;
    }
    const int32_t support = FindVoxelAt(
        voxels, support_x, support_y, mechanism.z, width, height);
    return support == g_ignored_support_voxel ? -1 : support;
  }
  const int32_t orientation = mechanism.generic_id >= 0
      ? OrangeLocalId(mechanism) / 2
      : 0;
  int32_t support_x = mechanism.x;
  int32_t support_y = mechanism.y;
  int32_t support_z = mechanism.z;
  if (orientation == 0) {
    --support_z;
  } else if (orientation == 1) {
    ++support_y;
  } else if (orientation == 2) {
    --support_x;
  } else if (orientation == 3) {
    --support_y;
  } else if (orientation == 4) {
    ++support_x;
  } else if (orientation == 5 && mechanism.role == kOrangeButtonRole) {
    ++support_z;
  } else {
    return -1;
  }
  const int32_t support = FindVoxelAt(
      voxels, support_x, support_y, support_z, width, height);
  return support == g_ignored_support_voxel ||
      PlayerLiftContactIsActor(voxels, member, support) ? -1 : support;
}

bool OrangeButtonIsMountedToWall(
    Voxel* voxels,
    int32_t object) {
  if (object < 0 || g_object_kind[object] != kMechanismObject) return false;
  const int32_t button_index = g_object_head[object];
  if (button_index < 0 ||
      voxels[button_index].role != kOrangeButtonRole ||
      voxels[button_index].generic_id < 0) {
    return false;
  }
  const Voxel& button = voxels[button_index];
  const int32_t orientation = OrangeLocalId(button) / 2;
  for (int32_t wall_index = 0; wall_index < g_spatial_voxel_count;
       ++wall_index) {
    const Voxel& wall = voxels[wall_index];
    if (wall.role != kOrangeWallRole) continue;
    const int64_t raised_button_z = static_cast<int64_t>(button.z) +
        OrangeWallDepth(wall);
    if (orientation == 0 && button.x == wall.x && button.y == wall.y &&
        raised_button_z == static_cast<int64_t>(wall.z) + 1) {
      return true;
    }
    const bool matching_side =
        (orientation == 1 && button.x == wall.x &&
         button.y + 1 == wall.y) ||
        (orientation == 2 && button.x - 1 == wall.x &&
         button.y == wall.y) ||
        (orientation == 3 && button.x == wall.x &&
         button.y - 1 == wall.y) ||
        (orientation == 4 && button.x + 1 == wall.x &&
         button.y == wall.y);
    if (matching_side && raised_button_z == wall.z) return true;
    if (orientation == 5 && button.x == wall.x && button.y == wall.y &&
        raised_button_z == static_cast<int64_t>(wall.z) - 1) {
      return true;
    }
  }
  return false;
}

bool PlayerLiftIsAttachedToObject(
    Voxel* voxels,
    int32_t lift_object,
    int32_t support_object,
    int32_t width,
    int32_t height) {
  if (lift_object < 0 || support_object < 0 ||
      g_object_kind[lift_object] != kMechanismObject) {
    return false;
  }
  const int32_t support = MechanismAttachmentVoxel(
      voxels, lift_object, width, height);
  return support >= 0 && g_voxel_object[support] == support_object;
}

// A top lift stores both of its states at the same authored cell. Its raised
// cube occupies that cell, while fixtures fastened to the cube ride one row
// lower when the lift is collapsed. Reconstruct the raised arrangement so an
// attached Orange Button remains identifiable after it has become hidden in
// the floor (where an ordinary spatial attachment query would find Floor
// instead of the lift).
bool OrangeButtonTracksPlayerLift(
    const Voxel& button,
    const Voxel& lift) {
  if (button.role != kOrangeButtonRole || button.generic_id < 0 ||
      lift.role != kPlayerLiftRole || lift.generic_id < 0 ||
      lift.generic_id > 1) {
    return false;
  }
  const int32_t orientation = OrangeLocalId(button) / 2;
  const int64_t raised_button_z = static_cast<int64_t>(button.z) +
      (PlayerLiftIsRaised(lift) ? 0 : 1);
  if (orientation == 0) {
    return button.x == lift.x && button.y == lift.y &&
        raised_button_z == static_cast<int64_t>(lift.z) + 1;
  }
  const bool matching_side =
      (orientation == 1 && button.x == lift.x && button.y + 1 == lift.y) ||
      (orientation == 2 && button.x - 1 == lift.x && button.y == lift.y) ||
      (orientation == 3 && button.x == lift.x && button.y - 1 == lift.y) ||
      (orientation == 4 && button.x + 1 == lift.x && button.y == lift.y);
  if (matching_side) return raised_button_z == lift.z;
  return orientation == 5 && button.x == lift.x && button.y == lift.y &&
      raised_button_z == static_cast<int64_t>(lift.z) - 1;
}

bool AttachedPlayerLiftHasDirectSupport(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height,
    bool require_stable) {
  for (int32_t lift_object = 0; lift_object < g_object_count; ++lift_object) {
    const int32_t fixture = g_object_head[lift_object];
    if (fixture >= 0 &&
        (voxels[fixture].role == kOrangeButtonRole ||
         voxels[fixture].role == kPuncherRole)) {
      // Pass-through sensors ride their mount, but do not become a rigid
      // foothold for that mount when another body occupies the sensor cell.
      continue;
    }
    if (!PlayerLiftIsAttachedToObject(
            voxels, lift_object, object, width, height)) {
      continue;
    }
    for (int32_t member = g_object_head[lift_object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (voxels[member].z == INT32_MIN) continue;
      const int32_t support = FindVoxelAt(
          voxels,
          voxels[member].x,
          voxels[member].y,
          voxels[member].z - 1,
          width,
          height);
      if (support < 0 || support == g_ignored_support_voxel) continue;
      const int32_t support_object = g_voxel_object[support];
      if (support_object == object || support_object == lift_object) continue;
      if (!require_stable || support_object < 0 ||
          g_object_falling[support_object] == 0) {
        return true;
      }
    }
  }
  return false;
}

bool AddAttachedPlayerLiftIceSupports(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height,
    bool flat_only,
    bool& found_support) {
  for (int32_t lift_object = 0; lift_object < g_object_count; ++lift_object) {
    const int32_t fixture = g_object_head[lift_object];
    if (fixture >= 0 &&
        (voxels[fixture].role == kOrangeButtonRole ||
         voxels[fixture].role == kPuncherRole)) {
      continue;
    }
    if (!PlayerLiftIsAttachedToObject(
            voxels, lift_object, object, width, height)) {
      continue;
    }
    for (int32_t member = g_object_head[lift_object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (voxels[member].z == INT32_MIN) continue;
      const int32_t support = FindVoxelAt(
          voxels,
          voxels[member].x,
          voxels[member].y,
          voxels[member].z - 1,
          width,
          height);
      if (support < 0) continue;
      const int32_t support_object = g_voxel_object[support];
      if (support_object == object || support_object == lift_object) continue;
      if (flat_only ? voxels[support].role != kIceRole
                    : !IsIceRole(voxels[support].role)) {
        return false;
      }
      found_support = true;
    }
  }
  return true;
}

void ResetObjectMotion() {
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_object_gravity_armed[object] = 0;
    g_object_falling[object] = 0;
    // This is proposal scratch, not serialized momentum. A reused search or
    // test workspace must not inherit a different command's carrier impulse.
    g_inherited_support_motion[object] = 0;
  }
}

bool ObjectIsActive(Voxel* voxels, int32_t object, int32_t width, int32_t height) {
  // Single-cell players and static supports have no rigid object (ID -1).
  // Callers may query those sentinels while resolving clone/support contacts.
  if (static_cast<uint32_t>(object) >= static_cast<uint32_t>(g_object_count)) {
    return false;
  }
  const int32_t head = g_object_head[object];
  return head >= 0 && g_voxel_object[head] == object &&
      IsInsideRoom(voxels[head].x, voxels[head].y, width, height);
}

bool ObjectIsFloatingFloor(Voxel* voxels, int32_t object) {
  const int32_t head = object >= 0 ? g_object_head[object] : -1;
  return head >= 0 && voxels[head].role == kFloatingFloorRole;
}

bool ObjectIsUnarmedPlayerLift(Voxel* voxels, int32_t object) {
  const int32_t head = object >= 0 ? g_object_head[object] : -1;
  return head >= 0 && voxels[head].role == kPlayerLiftRole &&
      g_object_gravity_armed[object] == 0;
}

int32_t FindNearestVoxelBelow(
    Voxel* voxels,
    int32_t count,
    int32_t x,
    int32_t y,
    int32_t z,
    int32_t excluded_object,
    int32_t width) {
  int32_t best = -1;
  int32_t best_z = INT32_MIN;
  const bool orange_mechanisms =
      ActiveWorkspace().scene_has_orange_mechanisms;
  if (g_dense_columns) {
    const int32_t cell = y * width + x;
    auto consider = [&](int32_t index) {
      if (index == g_ignored_support_voxel ||
          (orange_mechanisms
              ? !VoxelBlocksSpace(voxels, count, index)
              : IsOrdinaryPassThroughVoxel(voxels[index]))) return;
      if (excluded_object >= 0 && g_voxel_object[index] == excluded_object) return;
      const int32_t candidate_z = orange_mechanisms
          ? VoxelPhysicalZ(voxels, count, index)
          : voxels[index].z;
      if (candidate_z < z && candidate_z > best_z) {
        best = index;
        best_z = candidate_z;
      }
    };
    if (ActiveWorkspace().prepared_index_active) {
      const int32_t dynamic_head =
          g_dynamic_column_stamps[cell] == g_dynamic_column_generation
          ? g_dynamic_column_heads[cell]
          : -1;
      for (int32_t index = dynamic_head; index >= 0;
           index = g_next_dynamic_column_voxel[index]) {
        consider(index);
      }
      for (int32_t index = g_static_column_heads[cell]; index >= 0;
           index = g_next_static_column_voxel[index]) {
        consider(index);
      }
      return best;
    }
    for (int32_t index = g_column_heads[cell]; index >= 0;
         index = g_next_column_voxel[index]) {
      consider(index);
    }
    return best;
  }

  for (int32_t index = 0; index < count; ++index) {
    if (index == g_ignored_support_voxel ||
        (orange_mechanisms
            ? !VoxelBlocksSpace(voxels, count, index)
            : IsOrdinaryPassThroughVoxel(voxels[index]))) continue;
    if ((excluded_object >= 0 && g_voxel_object[index] == excluded_object) ||
        voxels[index].x != x ||
        voxels[index].y != y) {
      continue;
    }
    const int32_t candidate_z = orange_mechanisms
        ? VoxelPhysicalZ(voxels, count, index)
        : voxels[index].z;
    if (candidate_z < z && candidate_z > best_z) {
      best = index;
      best_z = candidate_z;
    }
  }
  return best;
}

int32_t FindNearestVoxelBelowComponent(
    Voxel* voxels,
    int32_t count,
    int32_t x,
    int32_t y,
    int32_t z,
  int32_t width) {
  int32_t best = -1;
  int32_t best_z = INT32_MIN;
  const bool orange_mechanisms =
      ActiveWorkspace().scene_has_orange_mechanisms;
  if (g_dense_columns) {
    const int32_t cell = y * width + x;
    auto consider = [&](int32_t index) {
      if (index == g_ignored_support_voxel ||
          (orange_mechanisms
              ? !VoxelBlocksSpace(voxels, count, index)
              : IsOrdinaryPassThroughVoxel(voxels[index]))) return;
      const int32_t object = g_voxel_object[index];
      if (object >= 0 && g_component_objects[object] != 0) return;
      const int32_t candidate_z = orange_mechanisms
          ? VoxelPhysicalZ(voxels, count, index)
          : voxels[index].z;
      if (candidate_z < z && candidate_z > best_z) {
        best = index;
        best_z = candidate_z;
      }
    };
    if (ActiveWorkspace().prepared_index_active) {
      const int32_t dynamic_head =
          g_dynamic_column_stamps[cell] == g_dynamic_column_generation
          ? g_dynamic_column_heads[cell]
          : -1;
      for (int32_t index = dynamic_head; index >= 0;
           index = g_next_dynamic_column_voxel[index]) {
        consider(index);
      }
      for (int32_t index = g_static_column_heads[cell]; index >= 0;
           index = g_next_static_column_voxel[index]) {
        consider(index);
      }
      return best;
    }
    for (int32_t index = g_column_heads[cell]; index >= 0;
         index = g_next_column_voxel[index]) {
      consider(index);
    }
    return best;
  }

  for (int32_t index = 0; index < count; ++index) {
    if (index == g_ignored_support_voxel ||
        (orange_mechanisms
            ? !VoxelBlocksSpace(voxels, count, index)
            : IsOrdinaryPassThroughVoxel(voxels[index])) || voxels[index].x != x ||
        voxels[index].y != y) {
      continue;
    }
    const int32_t object = g_voxel_object[index];
    if (object >= 0 && g_component_objects[object] != 0) continue;
    const int32_t candidate_z = orange_mechanisms
        ? VoxelPhysicalZ(voxels, count, index)
        : voxels[index].z;
    if (candidate_z < z && candidate_z > best_z) {
      best = index;
      best_z = candidate_z;
    }
  }
  return best;
}

bool ObjectHasDirectSupport(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  if (OrangeButtonIsMountedToWall(voxels, object)) return true;
  const int32_t attachment = MechanismAttachmentVoxel(
      voxels, object, width, height);
  if (attachment >= 0 && g_voxel_object[attachment] != object) return true;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const Voxel& voxel = voxels[member];
    if (voxel.z == INT32_MIN) continue;
    const int32_t support = FindVoxelAt(
        voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
    if (support >= 0 && support != g_ignored_support_voxel &&
        g_voxel_object[support] != object &&
        !PlayerLiftContactIsActor(voxels, member, support)) {
      return true;
    }
  }
  return AttachedPlayerLiftHasDirectSupport(
      voxels, object, width, height, false);
}

bool ObjectHasStableDirectSupport(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  if (OrangeButtonIsMountedToWall(voxels, object)) return true;
  const int32_t attachment = MechanismAttachmentVoxel(
      voxels, object, width, height);
  if (attachment >= 0) {
    const int32_t support_object = g_voxel_object[attachment];
    if (support_object != object &&
        (support_object < 0 || g_object_falling[support_object] == 0)) {
      return true;
    }
  }
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const Voxel& voxel = voxels[member];
    if (voxel.z == INT32_MIN) continue;
    const int32_t support = FindVoxelAt(
        voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
    if (support < 0 || support == g_ignored_support_voxel ||
        PlayerLiftContactIsActor(voxels, member, support)) continue;
    const int32_t support_object = g_voxel_object[support];
    if (support_object != object &&
        (support_object < 0 || g_object_falling[support_object] == 0)) {
      return true;
    }
  }
  return AttachedPlayerLiftHasDirectSupport(
      voxels, object, width, height, true);
}

bool ObjectIsFullyOnIce(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  bool found_bottom = false;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const Voxel& voxel = voxels[member];
    if (voxel.z == INT32_MIN) return false;
    const int32_t support = FindVoxelAt(
        voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
    if (support >= 0 && g_voxel_object[support] == object) continue;
    // An overhanging part of a rigid polycube contributes no friction. Ice
    // motion continues while at least one exposed cell is on Ice and every
    // other actual support is Ice too.
    if (support < 0) continue;
    if (!IsIceRole(voxels[support].role)) return false;
    found_bottom = true;
  }
  return AddAttachedPlayerLiftIceSupports(
      voxels, object, width, height, false, found_bottom) && found_bottom;
}

bool ObjectIsFullyOnFlatIce(
    Voxel* voxels,
    int32_t object,
    int32_t width,
    int32_t height) {
  bool found_bottom = false;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const Voxel& voxel = voxels[member];
    if (voxel.z == INT32_MIN) return false;
    const int32_t support = FindVoxelAt(
        voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
    if (support >= 0 && g_voxel_object[support] == object) continue;
    if (support < 0) continue;
    if (voxels[support].role != kIceRole) return false;
    found_bottom = true;
  }
  return AddAttachedPlayerLiftIceSupports(
      voxels, object, width, height, true, found_bottom) && found_bottom;
}

int32_t ObjectHighestZ(Voxel* voxels, int32_t object) {
  int32_t highest = INT32_MIN;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    if (voxels[member].z > highest) highest = voxels[member].z;
  }
  return highest;
}

int32_t LowestOtherActiveZ(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t excluded_object,
    int32_t excluded_voxel,
    bool exclude_component,
    bool exclude_falling_objects) {
  int32_t lowest = INT32_MAX;
  const bool orange_mechanisms =
      ActiveWorkspace().scene_has_orange_mechanisms;
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& voxel = voxels[index];
    if (index == excluded_voxel ||
        (orange_mechanisms
            ? !VoxelBlocksSpace(voxels, count, index)
            : IsOrdinaryPassThroughVoxel(voxel)) ||
        voxel.z == INT32_MIN ||
        !IsInsideRoom(voxel.x, voxel.y, width, height)) {
      continue;
    }
    const int32_t object = g_voxel_object[index];
    if (voxel.role == kPlayerRole && voxel.z != INT32_MIN) {
      const int32_t support = FindVoxelAt(
          voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
      const int32_t support_object =
          support >= 0 ? g_voxel_object[support] : -1;
      if (support_object >= 0 &&
          ((excluded_object >= 0 && support_object == excluded_object) ||
           (exclude_component &&
            g_component_objects[support_object] != 0) ||
           (exclude_falling_objects &&
            g_object_falling[support_object] != 0))) {
        // A rider descends as part of its supporting body's fall cohort and
        // must not make that body's abyss boundary recede forever.
        continue;
      }
    }
    if ((excluded_object >= 0 && object == excluded_object) ||
        (exclude_component && object >= 0 &&
         g_component_objects[object] != 0) ||
        (exclude_falling_objects && object >= 0 &&
         g_object_falling[object] != 0)) {
      continue;
    }
    const int32_t physical_z = orange_mechanisms
        ? VoxelPhysicalZ(voxels, count, index)
        : voxel.z;
    if (physical_z < lowest) lowest = physical_z;
  }
  // Preserve the historical row-zero abyss when a body is literally the
  // room's only remaining geometry. Otherwise the authored room determines
  // its own abyss depth, including geometry on negative rows.
  return lowest == INT32_MAX ? 0 : lowest;
}

bool ObjectHasPassedEverythingElse(
    Voxel* voxels,
    int32_t count,
    int32_t object,
    int32_t width,
    int32_t height) {
  return ObjectHighestZ(voxels, object) < LowestOtherActiveZ(
      voxels, count, width, height, object, -1, false, true);
}

bool SettleObject(
    Voxel* voxels,
    int32_t count,
    int32_t object,
    int32_t width,
    int32_t height) {
  // An authored hovering lift is terrain until a carrier moves it. A floor
  // somewhere below its anchor does not turn it into a loose falling body.
  if (ObjectIsUnarmedPlayerLift(voxels, object)) return false;
  if (!ObjectIsActive(voxels, object, width, height) ||
      ObjectHasDirectSupport(voxels, object, width, height)) {
    if (ObjectIsActive(voxels, object, width, height)) {
      g_object_gravity_armed[object] = 1;
      g_object_falling[object] = 0;
    }
    return false;
  }

  const int32_t head = g_object_head[object];
  if (head >= 0 && voxels[head].role == kFloatingFloorRole &&
      voxels[head].z == 1 &&
      FindVoxelAt(
          voxels, voxels[head].x, voxels[head].y, 0, width, height) < 0) {
    // Floating Floor is a one-cell, one-weight platform. It spends one
    // horizontal frame suspended over a Row-0 hole, then settles into that
    // hole as permanent Floor on the following gravity tick.
    voxels[head].z = 0;
    voxels[head].role = kFloorRole;
    voxels[head].generic_id = kFilledFloatingFloor;
    g_voxel_object[head] = -1;
    g_object_gravity_armed[object] = 0;
    g_object_falling[object] = 0;
    g_moving_objects_fell = true;
    g_fell_objects[object] = 1;
    return true;
  }

  int64_t drop = INT64_MAX;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const Voxel& voxel = voxels[member];
    const int32_t support = FindNearestVoxelBelow(
        voxels, count, voxel.x, voxel.y, voxel.z, object, width);
    if (support < 0) continue;
    const int64_t candidate = static_cast<int64_t>(voxel.z) - voxels[support].z - 1;
    if (candidate < drop) drop = candidate;
  }

  if (drop == INT64_MAX && g_object_gravity_armed[object] == 0) {
    // The editor permits intentionally floating constructions at any signed
    // elevation. Gravity begins once a body has support or something below
    // it to fall toward; merely loading a floating body does not delete it.
    return false;
  }
  g_moving_objects_fell = true;
  g_fell_objects[object] = 1;
  g_object_gravity_armed[object] = 1;
  if (drop == INT64_MAX) {
    const bool disappears = ObjectHasPassedEverythingElse(
        voxels, count, object, width, height);
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (voxels[member].z != INT32_MIN) --voxels[member].z;
      if (disappears) voxels[member].x = -1;
    }
    g_object_falling[object] = disappears ? 0 : 1;
    return true;
  }
  if (drop <= 0) return false;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    --voxels[member].z;
  }
  g_object_falling[object] = 1;
  return true;
}

bool ComponentContainsSupportCycle(
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  int32_t component_count = 0;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_component_objects[object] == 0) continue;
    g_component_indegree[object] = 0;
    ++component_count;
  }
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_component_objects[object] == 0) continue;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const Voxel& voxel = voxels[member];
      if (voxel.z == INT32_MIN) continue;
      const int32_t support = FindVoxelAt(
          voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
      if (support < 0) continue;
      const int32_t support_object = g_voxel_object[support];
      if (support_object >= 0 && support_object != object &&
          g_component_objects[support_object] != 0) {
        ++g_component_indegree[support_object];
      }
    }
  }

  int32_t queue_begin = 0;
  int32_t queue_end = 0;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_component_objects[object] != 0 && g_component_indegree[object] == 0) {
      g_object_queue[queue_end++] = object;
    }
  }
  int32_t removed = 0;
  while (queue_begin < queue_end) {
    const int32_t object = g_object_queue[queue_begin++];
    ++removed;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const Voxel& voxel = voxels[member];
      if (voxel.z == INT32_MIN) continue;
      const int32_t support = FindVoxelAt(
          voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
      if (support < 0) continue;
      const int32_t support_object = g_voxel_object[support];
      if (support_object >= 0 && support_object != object &&
          g_component_objects[support_object] != 0 &&
          --g_component_indegree[support_object] == 0) {
        g_object_queue[queue_end++] = support_object;
      }
    }
  }
  return removed != component_count;
}

int32_t BuildVerticalComponent(
    Voxel* voxels,
    int32_t first_object,
    int32_t width,
    int32_t height) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_component_objects[object] = 0;
  }
  int32_t queue_begin = 0;
  int32_t queue_end = 0;
  g_component_objects[first_object] = 1;
  g_object_queue[queue_end++] = first_object;
  while (queue_begin < queue_end) {
    const int32_t object = g_object_queue[queue_begin++];
    const int32_t attachment = MechanismAttachmentVoxel(
        voxels, object, width, height);
    if (attachment >= 0) {
      const int32_t other = g_voxel_object[attachment];
      if (other >= 0 && other != object &&
          g_component_objects[other] == 0) {
        g_component_objects[other] = 1;
        g_object_queue[queue_end++] = other;
      }
    }
    for (int32_t lift_object = 0; lift_object < g_object_count;
         ++lift_object) {
      if (g_component_objects[lift_object] == 0 &&
          PlayerLiftIsAttachedToObject(
              voxels, lift_object, object, width, height)) {
        g_component_objects[lift_object] = 1;
        g_object_queue[queue_end++] = lift_object;
      }
    }
    const int32_t object_fixture = g_object_head[object];
    if (object_fixture >= 0 &&
        (voxels[object_fixture].role == kOrangeButtonRole ||
         voxels[object_fixture].role == kPuncherRole)) {
      // A sensor joins a vertical fall component only through its encoded
      // face attachment. Its pass-through face may overlap or sit beside a
      // body without mechanically latching onto that body.
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const Voxel& voxel = voxels[member];
      for (int32_t dz = -1; dz <= 1; dz += 2) {
        if ((dz < 0 && voxel.z == INT32_MIN) ||
            (dz > 0 && voxel.z == INT32_MAX)) {
          continue;
        }
        const int32_t neighbor = FindVoxelAt(
            voxels, voxel.x, voxel.y, voxel.z + dz, width, height);
        if (neighbor < 0) continue;
        const int32_t other = g_voxel_object[neighbor];
        if (other >= 0 && other != object &&
            (g_object_kind[other] == kWeightlessObject ||
             g_object_kind[other] == kCloneObject ||
             g_object_kind[other] == kPlayerObject ||
             g_object_kind[other] == kMechanismObject) &&
            g_component_objects[other] == 0) {
          g_component_objects[other] = 1;
          g_object_queue[queue_end++] = other;
        }
      }
    }
  }
  return queue_end;
}

bool ComponentContainsMechanism() {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_component_objects[object] != 0 &&
        g_object_kind[object] == kMechanismObject) {
      return true;
    }
  }
  return false;
}

bool SettleSupportComponent(
    Voxel* voxels,
    int32_t count,
    int32_t first_object,
    int32_t width,
    int32_t height) {
  if (BuildVerticalComponent(voxels, first_object, width, height) <= 1 ||
      (!ComponentContainsMechanism() &&
       !ComponentContainsSupportCycle(voxels, width, height))) {
    return false;
  }

  // A hovering terrain lift anchors its entire support stack. Do not let an
  // upper lift's component pass silently arm and drop the lower fixture.
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_component_objects[object] != 0 &&
        ObjectIsUnarmedPlayerLift(voxels, object)) {
      return false;
    }
  }

  int64_t drop = INT64_MAX;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_component_objects[object] == 0) continue;
    g_object_gravity_armed[object] = 1;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const Voxel& voxel = voxels[member];
      if (voxel.role == kOrangeButtonRole || voxel.role == kPuncherRole) {
        // A pass-through sensor is attached to the falling component and
        // translates with it, but its zero-volume face cannot prop the
        // component up when it overlaps terrain below.
        continue;
      }
      const int32_t support = FindNearestVoxelBelowComponent(
          voxels, count, voxel.x, voxel.y, voxel.z, width);
      if (support < 0) continue;
      const int64_t candidate =
          static_cast<int64_t>(voxel.z) - voxels[support].z - 1;
      if (candidate < drop) drop = candidate;
    }
  }

  if (drop == INT64_MAX) {
    int32_t highest = INT32_MIN;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_component_objects[object] == 0) continue;
      const int32_t object_highest = ObjectHighestZ(voxels, object);
      if (object_highest > highest) highest = object_highest;
    }
    const bool mechanism_component = ComponentContainsMechanism();
    int32_t effective_highest_after_drop = highest - 1;
    if (mechanism_component) {
      for (int32_t object = 0; object < g_object_count; ++object) {
        if (g_component_objects[object] == 0 ||
            g_object_kind[object] != kMechanismObject) {
          continue;
        }
        for (int32_t member = g_object_head[object]; member >= 0;
             member = g_next_object_voxel[member]) {
          const int32_t state_height = PlayerLiftIsRaised(voxels[member]) ? 1 : 0;
          const int32_t top_after_drop = voxels[member].z - 1 + state_height;
          if (top_after_drop > effective_highest_after_drop) {
            effective_highest_after_drop = top_after_drop;
          }
        }
      }
    }
    const int32_t comparison_height = mechanism_component
        ? effective_highest_after_drop
        : highest;
    const bool disappears = comparison_height < LowestOtherActiveZ(
        voxels, count, width, height, -1, -1, true, true);
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_component_objects[object] == 0) continue;
      g_fell_objects[object] = 1;
      g_object_falling[object] = disappears ? 0 : 1;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if (voxels[member].z != INT32_MIN) --voxels[member].z;
        if (disappears) voxels[member].x = -1;
      }
    }
    g_moving_objects_fell = true;
    return true;
  }
  if (drop <= 0) return false;
  g_moving_objects_fell = true;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_component_objects[object] == 0) continue;
    g_fell_objects[object] = 1;
    g_object_falling[object] = 1;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      --voxels[member].z;
    }
  }
  return true;
}

void SettleFlaggedObjects(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height) {
  // A support can itself fall. Revisit the collection until the lower-to-upper
  // cascade reaches a fixed point; each pass moves or removes at least one body.
  for (int32_t pass = 0; pass <= g_object_count; ++pass) {
    bool changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_moving_objects[object] == 0 ||
          g_fell_objects[object] != 0 ||
          (g_object_kind[object] != kWeightlessObject &&
           g_object_kind[object] != kCloneObject &&
           g_object_kind[object] != kPlayerObject &&
           g_object_kind[object] != kMechanismObject) ||
          (g_object_kind[object] == kWeightlessObject &&
           g_weightless_object_count <= 1) ||
          !ObjectIsActive(voxels, object, width, height)) {
        continue;
      }
      if (SettleSupportComponent(voxels, count, object, width, height)) {
        changed = true;
        BuildSpatialIndex(voxels, count, width, height);
      }
    }
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_moving_objects[object] == 0 || g_fell_objects[object] != 0 ||
          g_carried_objects[object] != 0) {
        continue;
      }
      if (SettleObject(voxels, count, object, width, height)) {
        changed = true;
        BuildSpatialIndex(voxels, count, width, height);
      }
    }
    if (!changed) return;
  }
}
