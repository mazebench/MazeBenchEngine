bool AddMandatoryObject(int32_t object, int32_t& queue_end) {
  if (object < 0 || g_mandatory_objects[object] != 0) return false;
  g_mandatory_objects[object] = 1;
  g_moving_objects[object] = 1;
  g_carried_objects[object] = 0;
  g_object_queue[queue_end++] = object;
  return true;
}

void ClearMovingObjects() {
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_moving_objects[object] = 0;
    g_mandatory_objects[object] = 0;
    g_carried_objects[object] = 0;
    g_rejected_carriers[object] = 0;
    g_fell_objects[object] = 0;
    g_carrier_parent[object] = -1;
    g_object_direction[object] = 0xff;
  }
}

bool ObjectCanTransmitDeliberatePush(int32_t object) {
  if (object < 0) return false;
  return g_object_kind[object] == kNormalObject ||
      g_object_kind[object] == kWeightlessObject ||
      g_object_kind[object] == kCloneObject ||
      g_object_kind[object] == kPlayerObject;
}

int32_t NextRaisedMountedPushPart(
    Voxel* voxels, int32_t carrier, int32_t previous,
    int32_t width, int32_t height) {
  if (!ObjectCanTransmitDeliberatePush(carrier)) return -1;
  // A raised lift is part of its carrier's rigid collision footprint. Its
  // contacts use the carrier's single push force, never a new force belonging
  // to the mechanism or to an optional passenger.
  for (int32_t object = previous == carrier ? 0 : previous + 1;
       object < g_object_count; ++object) {
    const int32_t fixture = g_object_head[object];
    if (fixture >= 0 && PlayerLiftIsRaised(voxels[fixture]) &&
        PlayerLiftIsAttachedToObject(voxels, object, carrier, width, height)) {
      return object;
    }
  }
  return -1;
}

int32_t DeliberatePushContactObject(
    Voxel* voxels, int32_t object, int32_t width, int32_t height) {
  if (object < 0 || g_object_kind[object] != kMechanismObject) return object;
  const int32_t fixture = g_object_head[object];
  if (fixture < 0 || voxels[fixture].role != kPlayerLiftRole ||
      !PlayerLiftIsRaised(voxels[fixture])) {
    return object;
  }
  // A raised mounted lift transmits contact to its box, rather than becoming
  // independently pushable. Recruit the carrier into the ordinary push closure
  // so its weight and every obstruction still validate before anything moves.
  const int32_t attachment = MechanismAttachmentVoxel(
      voxels, object, width, height);
  const int32_t carrier = attachment >= 0 ? g_voxel_object[attachment] : -1;
  return carrier >= 0 &&
          (g_object_kind[carrier] == kNormalObject ||
           g_object_kind[carrier] == kWeightlessObject)
      ? carrier : object;
}

bool DeliberatePushMayRecruit(int32_t source, int32_t target) {
  if (!ObjectCanTransmitDeliberatePush(source) || target < 0) return false;
  if (g_object_kind[target] == kWeightlessObject) return true;
  if (g_object_kind[target] != kNormalObject) return false;
  // The command supplies one unit of push force. Weightless polycubes can
  // occur anywhere in the contact closure, but only one ordinary box or
  // Floating Floor may participate in the complete transaction.
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] != 0 &&
        g_object_kind[object] == kNormalObject) {
      return false;
    }
  }
  return true;
}

bool ObjectAcceptsSlopeContactPush(Voxel* voxels, int32_t object) {
  // Floating Floors can be nudged by ramp momentum, but unlike weightless
  // boxes their destination must retain support (or fill a Row-0 hole).
  return object >= 0 && (g_object_kind[object] == kWeightlessObject ||
      ObjectIsFloatingFloor(voxels, object));
}

bool FloatingFloorDestinationIsSupportedOrFillable(
    Voxel* voxels,
    int32_t object,
    int32_t dx,
    int32_t dy,
    int32_t dz,
    int32_t width,
    int32_t height) {
  if (!ObjectIsFloatingFloor(voxels, object)) return true;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const Voxel& voxel = voxels[member];
    const int32_t target_z = voxel.z + dz;
    const int32_t support = target_z == INT32_MIN ? -1 : FindVoxelAt(
        voxels,
        voxel.x + dx,
        voxel.y + dy,
        target_z - 1,
        width,
        height);
    // Row 1 is the one deliberate unsupported exception: entering a Row-0
    // hole schedules the authored visible-hover frame followed by Floor fill.
    if (support < 0 && target_z != 1) return false;
  }
  return true;
}

void ArmTranslatedHoveringObjects(Voxel* voxels) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_moving_objects[object] != 0 &&
        (ObjectIsFloatingFloor(voxels, object) ||
         ObjectIsUnarmedPlayerLift(voxels, object))) {
      g_object_gravity_armed[object] = 1;
    }
  }
}

// A compressed Orange Wall voxel is non-colliding, but its raised anchor can
// be embedded in a movable polycube (or immediately beneath that polycube's
// bottom voxel). In that authored arrangement it is a fixture of the rigid
// body and translates with the body's deliberate proposal. The wall keeps its
// depth; only its stable raised anchor moves in X/Y/Z.
void TranslateHiddenOrangeWallsWithProposals(
    Voxel* voxels,
    int32_t count,
    bool uniform,
    int32_t uniform_dx,
    int32_t uniform_dy,
    int32_t uniform_dz,
    bool include_carried) {
  if (!ActiveWorkspace().scene_has_orange_mechanisms ||
      (uniform && uniform_dx == 0 && uniform_dy == 0)) {
    return;
  }
  for (int32_t wall_index = 0; wall_index < count; ++wall_index) {
    Voxel& wall = voxels[wall_index];
    if (wall.role != kOrangeWallRole ||
        !OrangeWallIsHiddenForDepth(
            voxels, count, wall_index, OrangeWallDepth(wall))) {
      continue;
    }
    for (int32_t object = 0; object < g_object_count; ++object) {
      if ((g_mandatory_objects[object] == 0 &&
           (!include_carried || g_carried_objects[object] == 0 ||
            g_carrier_parent[object] != -2)) ||
          g_rejected_carriers[object] != 0 ||
          g_object_kind[object] == kMechanismObject) {
        continue;
      }
      bool attached = false;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        attached = voxels[member].x == wall.x &&
            voxels[member].y == wall.y &&
            (voxels[member].z == wall.z ||
             (wall.z != INT32_MAX && voxels[member].z == wall.z + 1));
        if (attached) break;
      }
      if (!attached) continue;
      const int32_t dx = uniform ? uniform_dx : g_object_dx[object];
      const int32_t dy = uniform ? uniform_dy : g_object_dy[object];
      if (!VoxelStaysInRoomGrid(wall, wall.x + dx, wall.y + dy)) break;
      wall.x += dx;
      wall.y += dy;
      wall.z += uniform ? uniform_dz : g_object_dz[object];
      break;
    }
  }
}

bool OrangeButtonSharesCellWith(
    Voxel* voxels,
    const Voxel& voxel) {
  if (!ActiveWorkspace().scene_has_orange_mechanisms) return false;
  for (int32_t index = 0; index < g_spatial_voxel_count; ++index) {
    if (voxels[index].role == kOrangeButtonRole &&
        voxels[index].x == voxel.x && voxels[index].y == voxel.y &&
        voxels[index].z == voxel.z) {
      return true;
    }
  }
  return false;
}

// A singleton player has no rigid-object record. Bridge its top contact to
// its moving support so cargo can inherit the same proposal through it.
// A blocked player stays behind, and cannot transmit that carry.
int32_t MovingPlayerCarrier(
    Voxel* voxels, int32_t player_index, int32_t width, int32_t height) {
  if (player_index < 0 || g_voxel_object[player_index] >= 0 ||
      voxels[player_index].z == INT32_MIN) return -1;
  const Voxel& player = voxels[player_index];
  const int32_t support = FindVoxelAt(
      voxels, player.x, player.y, player.z - 1, width, height);
  const int32_t carrier = support >= 0 ? g_voxel_object[support] : -1;
  if (carrier < 0 || g_moving_objects[carrier] == 0) return -1;
  const int32_t x = player.x + g_object_dx[carrier];
  const int32_t y = player.y + g_object_dy[carrier];
  const int32_t z = player.z + g_object_dz[carrier];
  if (!IsInsideRoom(x, y, width, height)) return -1;
  const int32_t occupant = FindVoxelAt(voxels, x, y, z, width, height);
  if (occupant >= 0 && occupant != player_index) {
    const int32_t other = g_voxel_object[occupant];
    if (other < 0 || g_moving_objects[other] == 0) return -1;
    for (int32_t member = g_object_head[other]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (voxels[member].x + g_object_dx[other] == x &&
          voxels[member].y + g_object_dy[other] == y &&
          voxels[member].z + g_object_dz[other] == z) return -1;
    }
  }
  return carrier;
}

int32_t MovingSupportBelowObject(
    Voxel* voxels,
    int32_t object,
    int32_t player_index,
    bool carry_from_player,
    int32_t width,
    int32_t height,
    bool player_is_vacating = false,
    const uint64_t* moving_objects = nullptr,
    int32_t player_carrier = -1) {
  const auto support_moves = [&](int32_t support) {
    return moving_objects == nullptr ? g_moving_objects[support] != 0
        : (moving_objects[support / 64] & (uint64_t{1} << (support % 64))) != 0;
  };
  // A mounted fixture participates in the carrier footprint of its complete
  // rigid assembly. If that fixture is resting on a moving body, the mount
  // transmits the carry even when another part of the assembly also has a
  // stationary foothold.
  for (int32_t lift_object = 0; lift_object < g_object_count; ++lift_object) {
    const int32_t fixture = g_object_head[lift_object];
    if (fixture >= 0 && voxels[fixture].role == kOrangeButtonRole) {
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
      const int32_t support_object = support >= 0
          ? g_voxel_object[support]
          : -1;
      if (support_object >= 0 && support_object != object &&
          support_object != lift_object &&
          support_moves(support_object)) {
        return support_object;
      }
    }
  }
  const int32_t fixture = g_object_head[object];
  const int32_t attachment = fixture >= 0 &&
          voxels[fixture].role == kPuncherRole
      ? MechanismAttachmentVoxel(voxels, object, width, height)
      : PlayerLiftSideAttachmentVoxel(voxels, object, width, height);
  if (attachment >= 0) {
    const int32_t support_object = g_voxel_object[attachment];
    if (support_object >= 0 && support_object != object &&
        support_moves(support_object)) {
      return support_object;
    }
    return -1;
  }
  int32_t moving_support = -1;
  bool has_stationary_pedestal = false;
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const Voxel& voxel = voxels[member];
    if (voxel.z == INT32_MIN) continue;
    const int32_t support = FindVoxelAt(
        voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
    if (support < 0) continue;
    if (PlayerLiftContactIsActor(voxels, member, support)) continue;
    if (g_voxel_object[support] == object) continue;
    if (!carry_from_player && support == player_index &&
        player_carrier >= 0 && player_carrier != object) {
      moving_support = player_carrier;
      continue;
    }
    if (support == player_index && player_is_vacating && !carry_from_player) {
      // The player's old cell is not a stationary foothold during a shared
      // motion tick. A moving box beneath another foot may carry this rider.
      continue;
    }
    if (carry_from_player && support == player_index) {
      moving_support = -2;
      continue;
    }
    const int32_t support_object = g_voxel_object[support];
    if (support_object >= 0 && support_object != object &&
        support_moves(support_object)) {
      if (moving_support == -1) moving_support = support_object;
      continue;
    }
    if (carry_from_player && support_object >= 0 &&
        support_object != object) {
      bool support_is_terrain_anchored = false;
      bool support_rests_on_rider = false;
      for (int32_t support_member = g_object_head[support_object];
           support_member >= 0;
           support_member = g_next_object_voxel[support_member]) {
        const Voxel& supported = voxels[support_member];
        if (supported.z == INT32_MIN) continue;
        const int32_t anchor = FindVoxelAt(
            voxels,
            supported.x,
            supported.y,
            supported.z - 1,
            width,
            height);
        if (anchor >= 0 && g_voxel_object[anchor] < 0 &&
            !IsIceRole(voxels[anchor].role)) {
          support_is_terrain_anchored = true;
        }
        support_rests_on_rider |=
            anchor >= 0 && g_voxel_object[anchor] == object;
      }
      // Mutual support is an interlocking assembly, not an independent
      // pedestal. Keep that contact in the ordinary carrier/collision graph.
      has_stationary_pedestal |=
          support_is_terrain_anchored && !support_rests_on_rider;
    }
    // Ordinary terrain provides an immovable foothold, so one moving contact
    // cannot carry the body. Ice has no such anchoring friction, and contact
    // with a different movable object is resolved by the support graph.
    if (support_object < 0 && !IsIceRole(voxels[support].role)) {
      // A pressed surface button is a yielding contact, not an anchoring
      // foothold. If another part of this body rests on the moving player,
      // the player carries the complete rigid group off those buttons.
      if (carry_from_player && OrangeButtonSharesCellWith(voxels, voxel)) {
        continue;
      }
      return -1;
    }
  }
  // A departing player cannot drag a body off an independent grounded
  // pedestal. A moving box can still transmit its already-established carry
  // through a stack; only the player's direct top contact has this restriction.
  return moving_support == -2 && has_stationary_pedestal ? -1 : moving_support;
}

void BuildCarriedObjects(
    Voxel* voxels,
    int32_t player_index,
    bool carry_from_player,
    int32_t width,
    int32_t height,
    bool player_is_vacating = false,
    bool bridge_player_rider = false) {
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_moving_objects[object] = g_mandatory_objects[object];
    g_carried_objects[object] = 0;
  }
  bool changed = true;
  while (changed) {
    changed = false;
    const int32_t player_carrier = bridge_player_rider
        ? MovingPlayerCarrier(voxels, player_index, width, height) : -1;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_moving_objects[object] != 0 || g_rejected_carriers[object] != 0 ||
          (carry_from_player &&
           ActiveWorkspace().clone_command_tick_active &&
           (g_object_kind[object] == kCloneObject ||
            g_object_kind[object] == kPlayerObject) &&
           g_clone_command_moved[object] != 0) ||
          !ObjectIsActive(voxels, object, width, height)) {
        continue;
      }
      const int32_t carrier = MovingSupportBelowObject(
          voxels, object, player_index, carry_from_player, width, height,
          player_is_vacating, nullptr, player_carrier);
      if (carrier != -1) {
        g_moving_objects[object] = 1;
        g_carried_objects[object] = 1;
        g_carrier_parent[object] = carrier;
        changed = true;
      }
    }
  }
}

bool ResolveCarriedCollisions(
    Voxel* voxels,
    int32_t player_index,
    int32_t dx,
    int32_t dy,
    int32_t dz,
    int32_t width,
    int32_t height,
    bool allow_push,
    bool& added_mandatory) {
  bool changed = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_carried_objects[object] == 0) continue;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const Voxel& voxel = voxels[member];
      const int32_t next_x = voxel.x + dx;
      const int32_t next_y = voxel.y + dy;
      if (!VoxelDestinationIsInsideRoom(voxel, next_x, next_y, width, height)) {
        g_rejected_carriers[object] = 1;
        changed = true;
        break;
      }
      const int32_t occupant = FindVoxelAt(
          voxels, next_x, next_y, voxel.z + dz, width, height);
      if (occupant < 0 || occupant == player_index ||
          g_voxel_object[occupant] == object) {
        continue;
      }
      if (g_object_kind[object] == kMechanismObject &&
          MovingFixtureIgnoresOccupant(voxel, &voxels[occupant])) {
        continue;
      }
      const int32_t other = g_voxel_object[occupant];
      if (other >= 0 && g_moving_objects[other] != 0) continue;
      if (other >= 0 && g_object_falling[other] != 0) {
        // A falling occupant vacates this source cell in the synchronized
        // vertical part of the tick.
        continue;
      }
      if (allow_push && g_object_kind[object] == kWeightlessObject &&
          other >= 0 && g_object_kind[other] == kWeightlessObject &&
          ObjectIsFullyOnIce(voxels, other, width, height)) {
        g_mandatory_objects[other] = 1;
        g_moving_objects[other] = 1;
        g_carried_objects[other] = 0;
        added_mandatory = true;
        changed = true;
        continue;
      }
      g_rejected_carriers[object] = 1;
      changed = true;
      break;
    }
  }
  return changed;
}

bool ObjectHasCarrierBelow(
    Voxel* voxels,
    int32_t object,
    int32_t carrier,
    int32_t width,
    int32_t height) {
  if (carrier < 0) return false;
  const int32_t attachment = MechanismAttachmentVoxel(
      voxels, object, width, height);
  if (attachment >= 0 && g_voxel_object[attachment] == carrier) {
    return true;
  }
  for (int32_t member = g_object_head[object]; member >= 0;
       member = g_next_object_voxel[member]) {
    const Voxel& voxel = voxels[member];
    for (int32_t support = g_object_head[carrier]; support >= 0;
         support = g_next_object_voxel[support]) {
      if (voxels[support].x == voxel.x && voxels[support].y == voxel.y &&
          voxels[support].z < voxel.z) {
        return true;
      }
    }
  }
  return false;
}
bool FallingObjectRefillsCell(
    Voxel* voxels,
    int32_t x,
    int32_t y,
    int32_t z,
    int32_t width,
    int32_t height) {
  if (z == INT32_MAX) return false;
  const int32_t above = FindVoxelAt(
      voxels, x, y, z + 1, width, height);
  if (above < 0) return false;
  const int32_t object = g_voxel_object[above];
  return object >= 0 && g_object_falling[object] != 0 &&
      g_moving_objects[object] == 0;
}

void TranslateObjectsCarriedByPlayerOneStep(
    Voxel* voxels,
    int32_t player_index,
    int32_t dx,
    int32_t dy,
    int32_t width,
    int32_t height) {
  ClearMovingObjects();
  for (;;) {
    BuildCarriedObjects(
        voxels, player_index, true, width, height);
    bool added_mandatory = false;
    if (!ResolveCarriedCollisions(
            voxels,
            player_index,
            dx,
            dy,
            0,
            width,
            height,
            false,
            added_mandatory)) {
      break;
    }
  }
  TranslateHiddenOrangeWallsWithProposals(
      voxels, g_spatial_voxel_count, true, dx, dy, 0, true);
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_carried_objects[object] == 0 ||
        g_rejected_carriers[object] != 0) {
      continue;
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      voxels[member].x += dx;
      voxels[member].y += dy;
    }
  }
}
