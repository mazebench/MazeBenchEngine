void AdvanceUnmovedGravityOneStep(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t player_index,
    int32_t dx,
    int32_t dy,
    bool player_moves_horizontally,
    bool immediate_support_loss = false) {
  bool found_pending = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_pending_fall[object] = 0;
    if (g_moving_objects[object] != 0 ||
        (ActiveWorkspace().clone_command_tick_active &&
         g_clone_command_moved[object] != 0) ||
        (g_carrier_parent[object] == -2 &&
         g_rejected_carriers[object] == 0) ||
        !ObjectIsActive(voxels, object, width, height) ||
        g_object_gravity_armed[object] == 0) {
      continue;
    }
    if (immediate_support_loss && g_component_objects[object] != 0) {
      // The caller has already proven that this whole support component is
      // vacated by the horizontal half of the current tick. Every level of
      // the stack therefore owns a simultaneous downward proposal now; do
      // not make upper members spend an extra arming-only frame.
      g_object_falling[object] = 1;
      g_pending_fall[object] = 1;
      found_pending = true;
      continue;
    }
    if (ObjectHasStableDirectSupport(voxels, object, width, height)) {
      g_object_falling[object] = 0;
      continue;
    }
    if (g_object_falling[object] == 0) {
      // Support loss starts a fall. Its first one-voxel displacement is
      // proposed on the next synchronized movement tick.
      g_object_falling[object] = 1;
      continue;
    }
    g_pending_fall[object] = 1;
    found_pending = true;
  }
  if (!found_pending) return;

  // Falling bodies form simultaneous vertical proposals. A body may enter a
  // cell vacated by another falling body, but never one retained this tick.
  bool changed = true;
  while (changed) {
    changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_pending_fall[object] == 0) continue;
      bool blocked = false;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        if (voxels[member].z == INT32_MIN) {
          blocked = true;
          break;
        }
        const int32_t target_x = voxels[member].x;
        const int32_t target_y = voxels[member].y;
        const int32_t target_z = voxels[member].z - 1;
        const int32_t horizontal_source = FindVoxelAt(
            voxels,
            target_x - dx,
            target_y - dy,
            target_z,
            width,
            height);
        if ((horizontal_source >= 0 &&
             g_voxel_object[horizontal_source] >= 0 &&
             g_moving_objects[g_voxel_object[horizontal_source]] != 0) ||
            (player_moves_horizontally && player_index >= 0 &&
             voxels[player_index].x + dx == target_x &&
             voxels[player_index].y + dy == target_y &&
             voxels[player_index].z == target_z)) {
          // Horizontal motion wins a same-cell race. The descending body
          // remains above the incoming support and is caught this tick.
          blocked = true;
          break;
        }
        const int32_t occupant = FindVoxelAt(
            voxels,
            target_x,
            target_y,
            target_z,
            width,
            height);
        if (occupant < 0) continue;
        const int32_t other = g_voxel_object[occupant];
        if (other == object ||
            (other >= 0 &&
             (g_pending_fall[other] != 0 ||
              g_moving_objects[other] != 0)) ||
            (occupant == player_index && player_moves_horizontally)) {
          continue;
        }
        blocked = true;
        break;
      }
      if (blocked) {
        g_pending_fall[object] = 0;
        g_object_falling[object] = 0;
        changed = true;
      }
    }
  }

  bool moved = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_pending_fall[object] == 0) continue;
    bool has_lower_support = false;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      if (FindNearestVoxelBelow(
              voxels,
              count,
              voxels[member].x,
              voxels[member].y,
              voxels[member].z,
              object,
              width) >= 0) {
        has_lower_support = true;
        break;
      }
    }
    const bool disappears = !has_lower_support &&
        ObjectHasPassedEverythingElse(voxels, count, object, width, height);
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      --voxels[member].z;
      if (disappears) voxels[member].x = -1;
    }
    if (disappears) g_object_falling[object] = 0;
    moved = true;
  }
  if (!moved) return;
  BuildSpatialIndex(voxels, count, width, height);
  // Clear momentum for bodies that landed on support which will remain after
  // the horizontal half of this tick. Propagate from the bottom upward so a
  // newly stable body can support another descending body in the same frame.
  bool settled = true;
  while (settled) {
    settled = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_pending_fall[object] == 0) continue;
      bool has_stationary_support = false;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const Voxel& voxel = voxels[member];
        const int32_t support = FindVoxelAt(
            voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
        if (support < 0 || g_voxel_object[support] == object) continue;
        if (support == player_index && player_moves_horizontally) continue;
        const int32_t support_object = g_voxel_object[support];
        if (support_object >= 0 &&
            (g_moving_objects[support_object] != 0 ||
             g_pending_fall[support_object] != 0)) {
          continue;
        }
        has_stationary_support = true;
        break;
      }
      if (has_stationary_support) {
        g_pending_fall[object] = 0;
        g_object_falling[object] = 0;
        settled = true;
      }
    }
  }
}

void MarkObjectsForDeferredGravity(
    Voxel* voxels,
    int32_t width,
    int32_t height,
    bool moving_only) {
  if (g_object_count == 1) {
    g_component_objects[0] = 0;
    if (!ObjectIsActive(voxels, 0, width, height) ||
        g_object_gravity_armed[0] == 0 ||
        (moving_only && g_moving_objects[0] == 0)) {
      return;
    }
    g_object_falling[0] =
        ObjectHasDirectSupport(voxels, 0, width, height) ? 0 : 1;
    return;
  }

  // Horizontal translation and gravity are separate ticks. First find which
  // translated bodies are connected to stationary support, including through
  // another translated body. Unsupported cycles remain ungrounded.
  auto eligible = [&](int32_t object) {
    return ObjectIsActive(voxels, object, width, height) &&
        g_object_gravity_armed[object] != 0 &&
        (!moving_only || g_moving_objects[object] != 0);
  };
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_component_objects[object] = 0;
    if (!eligible(object)) continue;
    bool attached_fixture_is_grounded = false;
    for (int32_t lift_object = 0; lift_object < g_object_count &&
         !attached_fixture_is_grounded; ++lift_object) {
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
        if (support < 0 || support == g_ignored_support_voxel) continue;
        const int32_t support_object = g_voxel_object[support];
        if (support_object != object && support_object != lift_object &&
            (support_object < 0 || !eligible(support_object))) {
          attached_fixture_is_grounded = true;
          break;
        }
      }
    }
    if (attached_fixture_is_grounded) {
      g_component_objects[object] = 1;
      continue;
    }
    const int32_t attachment_member = g_object_head[object];
    const int32_t attachment = attachment_member >= 0 &&
            voxels[attachment_member].role == kPuncherRole
        ? MechanismAttachmentVoxel(voxels, object, width, height)
        : PlayerLiftSideAttachmentVoxel(voxels, object, width, height);
    if (attachment >= 0) {
      const int32_t support_object = g_voxel_object[attachment];
      if (support_object != object &&
          (support_object < 0 || !eligible(support_object))) {
        g_component_objects[object] = 1;
        continue;
      }
    }
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const Voxel& voxel = voxels[member];
      if (voxel.z == INT32_MIN) continue;
      const int32_t support = FindVoxelAt(
          voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
      if (support < 0 || support == g_ignored_support_voxel) continue;
      const int32_t support_object = g_voxel_object[support];
      if (support_object != object &&
          (support_object < 0 || !eligible(support_object))) {
        g_component_objects[object] = 1;
        break;
      }
    }
  }

  bool changed = true;
  while (changed) {
    changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (!eligible(object) || g_component_objects[object] != 0) {
        continue;
      }
      bool supported_by_attached_fixture = false;
      for (int32_t lift_object = 0; lift_object < g_object_count;
           ++lift_object) {
        const int32_t fixture = g_object_head[lift_object];
        if (fixture >= 0 && voxels[fixture].role == kOrangeButtonRole) {
          continue;
        }
        if (g_component_objects[lift_object] != 0 &&
            PlayerLiftIsAttachedToObject(
                voxels, lift_object, object, width, height)) {
          supported_by_attached_fixture = true;
          break;
        }
      }
      if (supported_by_attached_fixture) {
        g_component_objects[object] = 1;
        changed = true;
        continue;
      }
      const int32_t attachment_member = g_object_head[object];
      const int32_t attachment = attachment_member >= 0 &&
              voxels[attachment_member].role == kPuncherRole
          ? MechanismAttachmentVoxel(voxels, object, width, height)
          : PlayerLiftSideAttachmentVoxel(voxels, object, width, height);
      if (attachment >= 0) {
        const int32_t support_object = g_voxel_object[attachment];
        if (support_object >= 0 && support_object != object &&
            g_component_objects[support_object] != 0) {
          g_component_objects[object] = 1;
          changed = true;
          continue;
        }
      }
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        const Voxel& voxel = voxels[member];
        if (voxel.z == INT32_MIN) continue;
        const int32_t support = FindVoxelAt(
            voxels, voxel.x, voxel.y, voxel.z - 1, width, height);
        if (support < 0 || support == g_ignored_support_voxel) continue;
        const int32_t support_object = g_voxel_object[support];
        if (support_object >= 0 && support_object != object &&
            g_component_objects[support_object] != 0) {
          g_component_objects[object] = 1;
          changed = true;
          break;
        }
      }
    }
  }

  for (int32_t object = 0; object < g_object_count; ++object) {
    if (!eligible(object)) continue;
    g_object_falling[object] = g_component_objects[object] == 0 ? 1 : 0;
  }
}
