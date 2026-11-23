bool TranslateMovingObjects(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t dx,
    int32_t dy,
    int32_t dz,
    int32_t width,
    int32_t height,
    bool carry_from_player,
    bool allow_push,
    bool player_moves_horizontally,
    bool advance_unmoved_gravity = true,
    bool commit_translation = true,
    int32_t required_player_carrier = -1) {
  g_moving_objects_fell = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_fell_objects[object] = 0;
    g_object_dx[object] = static_cast<int8_t>(dx);
    g_object_dy[object] = static_cast<int8_t>(dy);
    g_object_dz[object] = static_cast<int8_t>(dz);
  }

  if (commit_translation && required_player_carrier < 0 && g_object_count == 1 &&
      g_mandatory_objects[0] != 0 &&
      ObjectIsActive(voxels, 0, width, height)) {
    // The overwhelmingly common Sokoban push has no carrier graph, object
    // closure, or inter-body race to resolve. Preserve the exact general-path
    // collision rules while avoiding several redundant graph passes per Ice
    // cell. Complex scenes continue through the solver below.
    if (allow_push &&
        !FloatingFloorDestinationIsSupportedOrFillable(
            voxels, 0, dx, dy, dz, width, height)) {
      return false;
    }
    for (int32_t member = g_object_head[0]; member >= 0;
         member = g_next_object_voxel[member]) {
      const Voxel& voxel = voxels[member];
      const int32_t next_x = voxel.x + dx;
      const int32_t next_y = voxel.y + dy;
      if (!VoxelDestinationIsInsideRoom(voxel, next_x, next_y, width, height)) return false;
      const int32_t occupant = FindVoxelAt(
          voxels, next_x, next_y, voxel.z + dz, width, height);
      if (g_object_kind[0] == kMechanismObject &&
          MovingFixtureIgnoresOccupant(
              voxel, occupant >= 0 ? &voxels[occupant] : nullptr)) {
        continue;
      }
      if (occupant >= 0) {
        if (occupant == player_index) {
          if (!player_moves_horizontally) return false;
        } else if (g_voxel_object[occupant] != 0) {
          return false;
        }
      }
    }
    g_moving_objects[0] = 1;
    g_carried_objects[0] = 0;
    g_rejected_carriers[0] = 0;
    g_carrier_parent[0] = -1;
    for (int32_t member = g_object_head[0]; member >= 0;
         member = g_next_object_voxel[member]) {
      voxels[member].x += dx;
      voxels[member].y += dy;
      voxels[member].z += dz;
    }
    ArmTranslatedHoveringObjects(voxels);
    BuildSpatialIndex(voxels, count, width, height);
    MarkObjectsForDeferredGravity(voxels, width, height, false);
    return true;
  }

  int32_t queue_begin = 0;
  int32_t queue_end = 0;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] != 0 &&
        ObjectIsActive(voxels, object, width, height)) {
      g_object_queue[queue_end++] = object;
    }
  }
  while (queue_begin < queue_end) {
    const int32_t object = g_object_queue[queue_begin++];
    for (int32_t part = object; part >= 0; part = allow_push
        ? NextRaisedMountedPushPart(voxels, object, part, width, height) : -1) {
      for (int32_t member = g_object_head[part]; member >= 0;
           member = g_next_object_voxel[member]) {
        const Voxel& voxel = voxels[member];
        const int32_t next_x = voxel.x + dx;
        const int32_t next_y = voxel.y + dy;
        if (!VoxelDestinationIsInsideRoom(voxel, next_x, next_y, width, height)) return false;
        const int32_t occupant = FindVoxelAt(
            voxels, next_x, next_y, voxel.z + dz, width, height);
        if (g_object_kind[object] == kMechanismObject &&
            MovingFixtureIgnoresOccupant(
                voxel, occupant >= 0 ? &voxels[occupant] : nullptr)) {
          continue;
        }
        if (occupant < 0) continue;
        if (occupant == player_index) {
          if (player_moves_horizontally) continue;
          return false;
        }
        const int32_t other_object = g_voxel_object[occupant];
        if (other_object == object ||
            (other_object >= 0 && g_mandatory_objects[other_object] != 0) ||
            PlayerLiftIsAttachedToObject(
                voxels, other_object, object, width, height)) {
          continue;
        }
        if (other_object >= 0 && g_object_falling[other_object] != 0 &&
            g_moving_objects[other_object] == 0) {
          // The occupant's synchronized downward proposal vacates this cell.
          // A vertical stack can refill it in the same tick, however, in which
          // case the trailing horizontal body must stop before gravity commits.
          if (FallingObjectRefillsCell(
                  voxels, next_x, next_y, voxel.z, width, height)) {
            return false;
          }
          continue;
        }
        const int32_t push_target = allow_push
            ? DeliberatePushContactObject(voxels, other_object, width, height)
            : other_object;
        if (allow_push && push_target >= 0 &&
            (g_mandatory_objects[push_target] != 0 ||
             DeliberatePushMayRecruit(object, push_target))) {
          AddMandatoryObject(push_target, queue_end);
          continue;
        }
        return false;
      }
    }
  }

  for (;;) {
    BuildCarriedObjects(
        voxels, player_index, carry_from_player, width, height,
        player_moves_horizontally, !carry_from_player);
    bool added_mandatory = false;
    const bool changed = ResolveCarriedCollisions(
        voxels,
        player_index,
        dx,
        dy,
        dz,
        width,
        height,
        allow_push,
        added_mandatory);
    if (!changed) break;
    if (added_mandatory) {
      // Newly pushed passengers must receive the same collision closure as
      // the original deliberate push before the substep can commit.
      queue_begin = 0;
      queue_end = 0;
      for (int32_t object = 0; object < g_object_count; ++object) {
        if (g_mandatory_objects[object] != 0 &&
            ObjectIsActive(voxels, object, width, height)) {
          g_object_queue[queue_end++] = object;
        }
      }
      while (queue_begin < queue_end) {
        const int32_t object = g_object_queue[queue_begin++];
        for (int32_t part = object; part >= 0; part = allow_push
            ? NextRaisedMountedPushPart(voxels, object, part, width, height) : -1) {
          for (int32_t member = g_object_head[part]; member >= 0;
               member = g_next_object_voxel[member]) {
            const Voxel& voxel = voxels[member];
            const int32_t next_x = voxel.x + dx;
            const int32_t next_y = voxel.y + dy;
            if (!VoxelDestinationIsInsideRoom(voxel, next_x, next_y, width, height)) return false;
            const int32_t occupant = FindVoxelAt(
                voxels, next_x, next_y, voxel.z + dz, width, height);
            if (g_object_kind[object] == kMechanismObject &&
                MovingFixtureIgnoresOccupant(
                    voxel, occupant >= 0 ? &voxels[occupant] : nullptr)) {
              continue;
            }
            if (occupant < 0 || occupant == player_index) continue;
            const int32_t other = g_voxel_object[occupant];
            if (other == object ||
                (other >= 0 && g_mandatory_objects[other] != 0)) {
              continue;
            }
            const int32_t push_target = allow_push
                ? DeliberatePushContactObject(voxels, other, width, height)
                : other;
            if (allow_push && push_target >= 0 &&
                (g_mandatory_objects[push_target] != 0 ||
                 DeliberatePushMayRecruit(object, push_target))) {
              AddMandatoryObject(push_target, queue_end);
              continue;
            }
            return false;
          }
        }
      }
    }
  }

  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_object_kind[object] == kMechanismObject &&
        g_carrier_parent[object] >= 0 &&
        g_rejected_carriers[object] != 0) {
      // A raised fixture caught against terrain anchors the carrier beneath
      // it. Nothing has translated yet, so the complete proposal can abort
      // transactionally.
      return false;
    }
    if (allow_push && g_mandatory_objects[object] != 0 &&
        !FloatingFloorDestinationIsSupportedOrFillable(
            voxels, object, dx, dy, dz, width, height)) {
      return false;
    }
  }

  // A player pushing from another body may stay aboard only if the complete
  // collision closure also pushes that support. Check before any scene change
  // so an unrelated stationary pedestal cannot bypass the ledge rule.
  if (required_player_carrier >= 0 &&
      g_mandatory_objects[required_player_carrier] == 0) {
    return false;
  }

  bool found_moving = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    found_moving |= g_moving_objects[object] != 0;
  }
  if (!commit_translation) return true;
  if (!found_moving) {
    if (advance_unmoved_gravity) {
      AdvanceUnmovedGravityOneStep(
          voxels,
          count,
          width,
          height,
          player_index,
          dx,
          dy,
          player_moves_horizontally);
    }
    return true;
  }

  // Commit already-armed vertical proposals before horizontal translation.
  // Collision validation above treats those source cells as vacating, while
  // the gravity resolver cancels any destination contested by a horizontal
  // proposal. Both axes therefore advance once in the same animation tick.
  if (advance_unmoved_gravity) {
    AdvanceUnmovedGravityOneStep(
        voxels,
        count,
        width,
        height,
        player_index,
        dx,
        dy,
        player_moves_horizontally);
  }

  TranslateHiddenOrangeWallsWithProposals(
      voxels, count, true, dx, dy, dz, carry_from_player);
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_moving_objects[object] == 0) continue;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      voxels[member].x += dx;
      voxels[member].y += dy;
      voxels[member].z += dz;
    }
  }
  ArmTranslatedHoveringObjects(voxels);
  BuildSpatialIndex(voxels, count, width, height);
  // A stationary body can lose support when a different body translates out
  // from beneath it. Mark every armed body here so that its downward proposal
  // participates in the next synchronized tick, just like a translated body
  // which leaves the edge of its own support.
  MarkObjectsForDeferredGravity(voxels, width, height, false);

  bool changed = true;
  while (changed) {
    changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_carried_objects[object] == 0 || g_rejected_carriers[object] != 0) {
        continue;
      }
      const int32_t carrier = g_carrier_parent[object];
      if (carrier >= 0 && g_fell_objects[carrier] == 0 &&
          g_rejected_carriers[carrier] == 0) {
        continue;
      }
      if (carrier == -2) continue;
      if (!ObjectHasCarrierBelow(
              voxels, object, carrier, width, height)) {
        g_rejected_carriers[object] = 1;
        for (int32_t member = g_object_head[object]; member >= 0;
             member = g_next_object_voxel[member]) {
          voxels[member].x -= dx;
          voxels[member].y -= dy;
          voxels[member].z -= dz;
        }
      }
      g_carried_objects[object] = 0;
      g_moving_objects[object] = g_mandatory_objects[object];
      BuildSpatialIndex(voxels, count, width, height);
      changed = true;
    }
  }
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_fell_objects[object] != 0) g_mandatory_objects[object] = 0;
  }
  MarkObjectsForDeferredGravity(voxels, width, height, false);
  return true;
}

bool MovingObjectsAreFullyOnIce(
    Voxel* voxels,
    int32_t width,
    int32_t height) {
  bool found_active = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0 ||
        !ObjectIsActive(voxels, object, width, height)) {
      continue;
    }
    found_active = true;
    if (!ObjectIsFullyOnIce(voxels, object, width, height)) return false;
  }
  return found_active;
}
