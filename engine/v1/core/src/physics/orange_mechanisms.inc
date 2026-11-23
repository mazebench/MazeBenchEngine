bool OrangeFixtureRidesWallSurface(
    const Voxel& fixture,
    const Voxel& wall,
    int32_t wall_surface_z);

bool OrangeFixtureTracksWall(
    const Voxel& fixture,
    const Voxel& wall,
    int32_t wall_surface_z);

bool OrangeButtonIsHidden(const Voxel& button) {
  return button.role == kOrangeButtonRole &&
      button.generic_id >= 0 && (button.generic_id & 1) != 0;
}

bool RefreshOrangeButtonVisibility(
    Voxel* voxels,
    int32_t count) {
  bool changed = false;
  for (int32_t button_index = 0; button_index < count; ++button_index) {
    Voxel& button = voxels[button_index];
    if (button.role != kOrangeButtonRole || button.generic_id < 0) continue;
    bool rides_wall = false;
    bool folded_into_support = false;
    for (int32_t wall_index = 0; wall_index < count; ++wall_index) {
      if (voxels[wall_index].role != kOrangeWallRole) continue;
      const int32_t surface = OrangeWallSurfaceZForDepth(
          voxels, count, wall_index, OrangeWallDepth(voxels[wall_index]));
      if (!OrangeFixtureTracksWall(
              button, voxels[wall_index], surface)) {
        continue;
      }
      rides_wall = true;
      const int32_t support = OrangeWallSupportZ(voxels, count, wall_index);
      folded_into_support |= support != INT32_MIN && button.z <= support;
    }
    bool rides_lift = false;
    for (int32_t lift_index = 0; lift_index < count; ++lift_index) {
      if (!OrangeButtonTracksPlayerLift(button, voxels[lift_index])) continue;
      rides_lift = true;
      folded_into_support |= !PlayerLiftIsRaised(voxels[lift_index]);
    }
    if (!rides_wall && !rides_lift) continue;
    const int32_t next_id = (button.generic_id & ~1) |
        (folded_into_support ? 1 : 0);
    if (button.generic_id != next_id) {
      button.generic_id = next_id;
      changed = true;
    }
  }
  return changed;
}

bool OrangeButtonShouldBePressed(
    Voxel* voxels,
    int32_t button_index,
    int32_t width,
    int32_t height) {
  const Voxel& button = voxels[button_index];
  if (button.role != kOrangeButtonRole ||
      OrangeButtonIsHidden(button) ||
      !IsInsideRoom(button.x, button.y, width, height) ||
      button.z == INT32_MIN) {
    return false;
  }
  const int32_t occupant = FindVoxelAt(
      voxels, button.x, button.y, button.z, width, height);
  if (occupant < 0) return false;
  if (voxels[occupant].role == kPlayerRole) return true;
  const int32_t object = g_voxel_object[occupant];
  if (object < 0) {
    // Static geometry can press a button which its movable carrier drives
    // into that geometry. The exception is a wall-mounted sensor currently
    // folded into terrain by the Orange Wall itself; that face is invisible,
    // and therefore contributes no pressure.
    for (int32_t index = 0; index < g_spatial_voxel_count; ++index) {
      if (voxels[index].role != kOrangeWallRole) continue;
      const int32_t surface = OrangeWallSurfaceZForDepth(
          voxels, g_spatial_voxel_count, index,
          OrangeWallDepth(voxels[index]));
      const int32_t support = OrangeWallSupportZ(
          voxels, g_spatial_voxel_count, index);
      if (OrangeFixtureTracksWall(button, voxels[index], surface) &&
          support != INT32_MIN && button.z <= support) {
        return false;
      }
    }
    return true;
  }
  // Static terrain and the mechanism's own mount do not press a sensor when
  // the face is folded into them. Only an actor or movable rigid body applies
  // pressure; other mechanism fixtures remain freely overlappable.
  if (g_object_kind[object] == kMechanismObject) {
    const int32_t fixture = g_object_head[object];
    return fixture >= 0 && voxels[fixture].role == kPlayerLiftRole &&
        PlayerLiftIsRaised(voxels[fixture]);
  }
  return g_object_kind[object] == kNormalObject ||
      g_object_kind[object] == kWeightlessObject ||
      g_object_kind[object] == kCloneObject ||
      g_object_kind[object] == kPlayerObject;
}

void CountPressedOrangeButtons(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t* pressed) {
  for (int32_t scope = 0; scope < kOrangeScopeCount; ++scope) pressed[scope] = 0;
  for (int32_t index = 0; index < count; ++index) {
    if (voxels[index].role == kOrangeButtonRole &&
        OrangeButtonShouldBePressed(
            voxels, index, width, height)) {
      ++pressed[OrangeScope(voxels[index])];
    }
  }
}

bool NormalizeInitialOrangeWallAnchors(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height) {
  if (!ActiveWorkspace().scene_has_orange_mechanisms) return false;
  bool changed = RefreshOrangeButtonVisibility(voxels, count);
  int32_t pressed_by_scope[kOrangeScopeCount];
  CountPressedOrangeButtons(voxels, count, width, height, pressed_by_scope);
  for (int32_t index = 0; index < count; ++index) {
    Voxel& wall = voxels[index];
    if (wall.role != kOrangeWallRole) continue;
    const int32_t pressed = pressed_by_scope[OrangeScope(wall)];
    const int32_t depth = OrangeWallDepth(wall);
    if (depth >= pressed) continue;
    // A frame imported while its buttons are already held may still carry the
    // old zero-depth cube value. Canonicalize only states whose pressed
    // projection is non-solid, so input collision agrees with the visible
    // face/hidden starting frame. Ordinary cubes still animate normally.
    if (OrangeWallIsFlatForDepth(voxels, count, index, pressed) ||
        OrangeWallIsHiddenForDepth(voxels, count, index, pressed)) {
      SetOrangeWallDepth(&wall, pressed);
      changed = true;
    }
  }
  return changed;
}

bool OrangeMechanismsNeedTick(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height) {
  if (!ActiveWorkspace().scene_has_orange_mechanisms) return false;
  int32_t pressed_by_scope[kOrangeScopeCount];
  CountPressedOrangeButtons(voxels, count, width, height, pressed_by_scope);
  for (int32_t index = 0; index < count; ++index) {
    if (voxels[index].role == kOrangeWallRole &&
        g_blocked_orange_walls[index] == 0 &&
        OrangeWallDepth(voxels[index]) != pressed_by_scope[OrangeScope(voxels[index])]) {
      return true;
    }
  }
  return false;
}

bool OrangeFixtureRidesWallSurface(
    const Voxel& fixture,
    const Voxel& wall,
    int32_t wall_surface_z) {
  if ((fixture.role != kOrangeButtonRole &&
       fixture.role != kPlayerLiftRole) ||
      fixture.generic_id < 0) {
    return false;
  }
  const int32_t orientation = OrangeLocalId(fixture) / 2;
  if (orientation == 0) {
    return fixture.x == wall.x && fixture.y == wall.y &&
        fixture.z == wall_surface_z;
  }
  if (orientation == 1) {
    return fixture.x == wall.x && fixture.y + 1 == wall.y &&
        fixture.z + 1 == wall_surface_z;
  }
  if (orientation == 2) {
    return fixture.x - 1 == wall.x && fixture.y == wall.y &&
        fixture.z + 1 == wall_surface_z;
  }
  if (orientation == 3) {
    return fixture.x == wall.x && fixture.y - 1 == wall.y &&
        fixture.z + 1 == wall_surface_z;
  }
  if (orientation == 4) {
    return fixture.x + 1 == wall.x && fixture.y == wall.y &&
        fixture.z + 1 == wall_surface_z;
  }
  return fixture.role == kOrangeButtonRole && orientation == 5 &&
      fixture.x == wall.x && fixture.y == wall.y &&
      fixture.z + 2 == wall_surface_z;
}

// Once an Orange Wall is below its support plane it deliberately has no
// physical surface. A mounted fixture nevertheless remains attached to the
// same authored raised-anchor face and must continue travelling with it.
// Reconstructing the fixture's raised coordinate from the wall depth preserves
// that relationship without an attachment identifier or per-fixture hidden
// block type. Rendering may occlude the unchanged fixture when it is buried.
bool OrangeFixtureTracksWall(
    const Voxel& fixture,
    const Voxel& wall,
    int32_t wall_surface_z) {
  if (OrangeFixtureRidesWallSurface(fixture, wall, wall_surface_z)) return true;
  if ((fixture.role != kOrangeButtonRole &&
       fixture.role != kPlayerLiftRole) ||
      wall.role != kOrangeWallRole || fixture.generic_id < 0) {
    return false;
  }
  const int32_t orientation = OrangeLocalId(fixture) / 2;
  const int64_t raised_fixture_z = static_cast<int64_t>(fixture.z) +
      OrangeWallDepth(wall);
  if (orientation == 0) {
    return fixture.x == wall.x && fixture.y == wall.y &&
        raised_fixture_z == static_cast<int64_t>(wall.z) + 1;
  }
  const bool matching_side =
      (orientation == 1 && fixture.x == wall.x && fixture.y + 1 == wall.y) ||
      (orientation == 2 && fixture.x - 1 == wall.x && fixture.y == wall.y) ||
      (orientation == 3 && fixture.x == wall.x && fixture.y - 1 == wall.y) ||
      (orientation == 4 && fixture.x + 1 == wall.x && fixture.y == wall.y);
  if (matching_side) return raised_fixture_z == wall.z;
  return fixture.role == kOrangeButtonRole && orientation == 5 &&
      fixture.x == wall.x && fixture.y == wall.y &&
      raised_fixture_z == static_cast<int64_t>(wall.z) - 1;
}

bool OrangeWallsShareFace(const Voxel& left, const Voxel& right) {
  if (left.role != kOrangeWallRole || right.role != kOrangeWallRole) {
    return false;
  }
  if (OrangeScope(left) != OrangeScope(right)) return false;
  const int64_t dx = static_cast<int64_t>(left.x) - right.x;
  const int64_t dy = static_cast<int64_t>(left.y) - right.y;
  const int64_t dz = static_cast<int64_t>(left.z) - right.z;
  const int64_t distance = (dx < 0 ? -dx : dx) +
      (dy < 0 ? -dy : dy) + (dz < 0 ? -dz : dz);
  return distance == 1;
}

// Move each face-connected wall and its riders as one transaction. Every wall
// destination must be present during collision checks: testing individual wall
// records makes a wide rider collide with a neighboring wall's old top cell.
bool AdvanceOrangeWallComponents(
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height,
    const int32_t* target_depths) {
  for (int32_t index = 0; index < count; ++index) {
    g_orange_component_walls[index] = 0;
    g_orange_component_shifts[index] = 0;
  }
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_clone_command_processed[object] = 0;
  }
  bool changed = false;
  bool player_moved = false;
  for (int32_t seed = 0; seed < count; ++seed) {
    if (voxels[seed].role != kOrangeWallRole ||
        g_orange_component_walls[seed] != 0) continue;
    const int32_t target_depth = target_depths[OrangeScope(voxels[seed])];
    int32_t queue_begin = 0;
    int32_t queue_end = 0;
    g_object_queue[queue_end++] = seed;
    g_orange_component_walls[seed] = 2;
    while (queue_begin < queue_end) {
      const int32_t member = g_object_queue[queue_begin++];
      for (int32_t candidate = 0; candidate < count; ++candidate) {
        if (g_orange_component_walls[candidate] == 0 &&
            OrangeWallsShareFace(voxels[member], voxels[candidate])) {
          g_orange_component_walls[candidate] = 2;
          g_object_queue[queue_end++] = candidate;
        }
      }
    }

    bool needs_transition = false;
    bool blocked = false;
    int32_t component_delta = 0;
    int32_t fixture_delta = 0;
    ClearMovingObjects();
    for (int32_t index = 0; index < count; ++index) {
      if (g_orange_component_walls[index] != 2) continue;
      const Voxel& wall = voxels[index];
      const int32_t old_depth = OrangeWallDepth(wall);
      g_component_indegree[index] = old_depth;
      blocked |= g_blocked_orange_walls[index] != 0;
      if (old_depth == target_depth) continue;
      needs_transition = true;
      const int32_t new_depth = old_depth + (old_depth < target_depth ? 1 : -1);
      fixture_delta = old_depth - new_depth;
      const int32_t old_surface = OrangeWallSurfaceZForDepth(voxels, count, index, old_depth);
      const int32_t new_surface = OrangeWallSurfaceZForDepth(voxels, count, index, new_depth);
      const int32_t delta = old_surface == INT32_MIN || new_surface == INT32_MIN
          ? 0 : new_surface - old_surface;
      if (delta != 0) {
        blocked |= component_delta != 0 && component_delta != delta;
        component_delta = delta;
      }
    }

    bool player_rides_wall = false;
    const RiderSnapshot player_rider = CapturePlayerRider(voxels, player_index, width, height);
    const int32_t player_start_z = voxels[player_index].z;
    if (needs_transition && !blocked) {
      // Discover every rider against the unchanged source geometry, including
      // fixtures which cross between face and hidden states during this tick.
      for (int32_t index = 0; index < count; ++index) {
        if (g_orange_component_walls[index] != 2) continue;
        const Voxel& wall = voxels[index];
        const int32_t old_depth = g_component_indegree[index];
        if (old_depth == target_depth) {
          if (target_depth != 0 || component_delta <= 0) continue;
          // A just-joined raised voxel rides the rising polycube. Members
          // normalized to a nonzero depth retain their authored anchors.
          g_orange_component_shifts[index] = static_cast<int8_t>(component_delta);
        }
        const int32_t new_depth = old_depth == target_depth ? old_depth
            : old_depth + (old_depth < target_depth ? 1 : -1);
        const int32_t old_surface = OrangeWallSurfaceZForDepth(voxels, count, index, old_depth);
        const int32_t new_surface = OrangeWallSurfaceZForDepth(voxels, count, index, new_depth);
        const bool carries_body = old_surface != INT32_MIN && new_surface != INT32_MIN &&
            (old_surface != new_surface || g_orange_component_shifts[index] != 0);
        const Voxel& player = voxels[player_index];
        player_rides_wall |= carries_body && !player_moved && player.x == wall.x &&
            player.y == wall.y && player.z == old_surface;
        for (int32_t object = 0; object < g_object_count; ++object) {
          if (g_clone_command_processed[object] != 0) continue;
          const int32_t fixture = g_object_head[object];
          if (g_object_kind[object] == kMechanismObject) {
            if (OrangeFixtureTracksWall(voxels[fixture], wall, old_surface)) {
              g_mandatory_objects[object] = 1;
              g_moving_objects[object] = 1;
            }
          } else if (carries_body) {
            for (int32_t member = fixture; member >= 0; member = g_next_object_voxel[member]) {
              if (voxels[member].x == wall.x && voxels[member].y == wall.y &&
                  voxels[member].z == old_surface) {
                g_mandatory_objects[object] = 1;
                g_moving_objects[object] = 1;
                break;
              }
            }
          }
        }
      }

      for (int32_t index = 0; index < count; ++index) {
        if (g_orange_component_walls[index] != 2) continue;
        const int32_t old_depth = g_component_indegree[index];
        SetOrangeWallDepth(&voxels[index], old_depth == target_depth ? old_depth
            : old_depth + (old_depth < target_depth ? 1 : -1));
        voxels[index].z += g_orange_component_shifts[index];
      }
      BuildSpatialIndex(voxels, count, width, height);

      for (int32_t index = 0; index < count && !blocked; ++index) {
        if (g_orange_component_walls[index] != 2 ||
            !VoxelBlocksSpace(voxels, count, index)) continue;
        const Voxel& wall = voxels[index];
        const int32_t occupant = FindVoxelAt(voxels, wall.x, wall.y,
            OrangeWallPhysicalZ(voxels, count, index), width, height);
        if (occupant < 0 || occupant == index ||
            (voxels[occupant].role == kOrangeWallRole &&
             g_orange_component_walls[occupant] == 2)) continue;
        if (occupant == player_index && player_rides_wall) continue;
        const int32_t other = g_voxel_object[occupant];
        // Retraction may fold authored wall voxels into fixed terrain between
        // their raised anchors. Such terrain still obstructs extension, but
        // must not stop the entire connected structure from lowering. Actors
        // and movable bodies retain the usual collision/carrier checks.
        if (other < 0 && occupant != player_index &&
            voxels[occupant].role != kOrangeWallRole &&
            OrangeWallDepth(wall) > g_component_indegree[index]) {
          continue;
        }
        blocked = other < 0 || g_mandatory_objects[other] == 0;
      }

      const int32_t movement_delta = component_delta != 0 ? component_delta : fixture_delta;
      // Expand the complete carried stack before checking the player's head
      // room. The player may ride a box several levels above the wall itself.
      if (!blocked && movement_delta != 0) {
        blocked = !TranslateMovingObjects(voxels, count, player_index,
            0, 0, movement_delta, width, height, player_rides_wall, true,
            true, false, false);
      }
      bool carries_player = player_rides_wall || (!player_moved &&
          player_rider.object >= 0 && g_moving_objects[player_rider.object] != 0);
      if (!blocked && carries_player && movement_delta != 0) {
        const Voxel& player = voxels[player_index];
        const int32_t occupant = FindVoxelAt(voxels, player.x, player.y,
            player.z + movement_delta, width, height);
        if (occupant >= 0 && occupant != player_index) {
          const int32_t other = g_voxel_object[occupant];
          if (other < 0) {
            blocked = true;
          } else {
            g_mandatory_objects[other] = 1;
            g_moving_objects[other] = 1;
          }
        }
      }
      if (!blocked && movement_delta != 0) {
        blocked = !TranslateMovingObjects(voxels, count, player_index,
            0, 0, movement_delta, width, height, carries_player, true,
            carries_player, false);
      }
      if (blocked) {
        // No rider has committed on failure. Restore all wall geometry as a
        // unit, so blocked upper rows cannot leave lower rows retracted.
        for (int32_t index = 0; index < count; ++index) {
          if (g_orange_component_walls[index] != 2) continue;
          voxels[index].z -= g_orange_component_shifts[index];
          SetOrangeWallDepth(&voxels[index], g_component_indegree[index]);
        }
      } else {
        if (carries_player && voxels[player_index].z == player_start_z) {
          voxels[player_index].z += movement_delta;
        }
        player_moved |= carries_player;
        for (int32_t object = 0; object < g_object_count; ++object) {
          if (g_moving_objects[object] != 0) g_clone_command_processed[object] = 1;
        }
        changed = true;
      }
      BuildSpatialIndex(voxels, count, width, height);
    }
    for (int32_t index = 0; index < count; ++index) {
      if (g_orange_component_walls[index] != 2) continue;
      if (blocked) g_blocked_orange_walls[index] = 1;
      g_orange_component_walls[index] = 1;
    }
  }
  return changed;
}

bool AdvanceOrangeMechanismsOneTick(
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t player_index,
    int32_t width,
    int32_t height) {
  int32_t target_depths[kOrangeScopeCount];
  CountPressedOrangeButtons(voxels, count, width, height, target_depths);
  bool changed = AdvanceOrangeWallComponents(
      voxels, count, player_index, width, height, target_depths);

  changed |= RefreshOrangeButtonVisibility(voxels, count);
  if (!changed) return false;
  BuildSpatialIndex(voxels, count, width, height);
  MarkObjectsForDeferredGravity(voxels, width, height, false);
  state->player_gravity_armed = 1;
  return true;
}

// Exact accelerator for a quiescent command whose only possible moving body is
// the player. It deliberately declines pushes and carried-body interactions;
// those continue through the same full command kernel. Keeping this decision
// in physics (rather than in search) gives every caller identical semantics for
// walking, elevated supports, Ice, gravity, abyss removal, and collectibles.
