// Directional slope motion is transactional at the object level. Each rigid
// polycube owns its direction and vertical ramp delta; only a head-on contact
// with a reflected body propagates that reflection through a touching convoy.
// This keeps separated bodies independent while preventing them from swapping
// through one another when the lead body bounces off a ramp obstruction.
void PreparePunchContactProposals(
    MotionState* state, Voxel* voxels, int32_t player_index,
    int32_t width, int32_t height, int32_t& player_direction);
void ResolvePunchProposals(
    MotionState* state, Voxel* voxels, int32_t player_index,
    int32_t width, int32_t height, bool player_is_vacating,
    int32_t& player_direction);

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
    int32_t required_player_carrier,
    MotionState* punch_state) {
  player_was_pushed = false;
  int32_t punched_player_direction = -1;
  g_moving_objects_fell = false;
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_fell_objects[object] = 0;
    g_object_redirected[object] = 0;
    g_inherited_support_motion[object] = 0;
    g_component_objects[object] = 0;
    // This scratch array is not needed for component topology until the
    // later gravity pass, so retain each proposal's pre-slope direction here.
    g_component_indegree[object] = g_object_direction[object];
    if (g_deferred_slope_objects[object] != 0) {
      g_mandatory_objects[object] = 0;
      g_moving_objects[object] = 0;
    } else if (g_mandatory_objects[object] != 0) {
      g_moving_objects[object] = 1;
      if (allow_downhill_contact_push) {
        for (int32_t member = g_object_head[object]; member >= 0;
             member = g_next_object_voxel[member]) {
          if (SlopeSupportingVoxel(
                  voxels, voxels[member], width, height) >= 0) {
            g_component_objects[object] = 1;
            break;
          }
        }
      }
    }
  }

  // A deliberate push discovers the whole touching weightless chain using
  // each body's own slope-adjusted destination.
  bool added = true;
  while (added) {
    added = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_mandatory_objects[object] == 0 ||
          !ObjectIsActive(voxels, object, width, height)) {
        continue;
      }
      PrepareSlopeObjectProposal(
          voxels, object, width, height, !allow_push, allow_push);
      if (allow_downhill_contact_push && g_object_dz[object] == 0) {
        for (int32_t member = g_object_head[object]; member >= 0;
             member = g_next_object_voxel[member]) {
          const int32_t support = SlopeSupportingVoxel(
              voxels, voxels[member], width, height);
          if (support >= 0 && IceSlopeDirection(voxels[support].role) ==
                  g_object_direction[object]) {
            g_component_objects[object] |= 2;
          }
        }
      }
      for (int32_t part = object; part >= 0; part = allow_push
          ? NextRaisedMountedPushPart(voxels, object, part, width, height) : -1) {
        for (int32_t member = g_object_head[part]; member >= 0;
             member = g_next_object_voxel[member]) {
          const int32_t next_x = voxels[member].x + g_object_dx[object];
          const int32_t next_y = voxels[member].y + g_object_dy[object];
          const int32_t next_z = voxels[member].z + g_object_dz[object];
          if (!VoxelDestinationIsInsideRoom(voxels[member], next_x, next_y, width, height)) continue;
          const int32_t occupant = FindVoxelAt(
              voxels, next_x, next_y, next_z, width, height);
          if (occupant < 0 || occupant == player_index) continue;
          const int32_t other = allow_push
              ? DeliberatePushContactObject(
                    voxels, g_voxel_object[occupant], width, height)
              : g_voxel_object[occupant];
          if (other < 0 || other == object ||
              g_mandatory_objects[other] != 0) {
            continue;
          }
          if (g_object_falling[other] != 0) {
            // A falling body vacates its source vertically; it must not be
            // recruited into the horizontal push closure.
            continue;
          }
          // A deliberate shove always recruits a touching weightless body.
          // Ramp momentum also transmits a push through a crest's weightless
          // chain. A free flat-Ice slide still stops at a stationary body.
          bool source_is_movable_ramp = false;
          for (int32_t source_member = g_object_head[object];
               source_member >= 0;
               source_member = g_next_object_voxel[source_member]) {
            source_is_movable_ramp |=
                IsBlueBoxSlopeRole(voxels[source_member].role) ||
                IsYellowCloneSlopeRole(voxels[source_member].role);
          }
          const bool slope_derived_contact = source_is_movable_ramp &&
              ObjectDownhillSlopeDirection(
                  voxels, object, width, height) >= 0;
          const bool deliberate_contact_push = allow_push &&
              ((!pushed_targets_require_ice && !slope_derived_contact) ||
               ObjectIsFullyOnIce(voxels, other, width, height));
          const bool downhill_ice_contact_push =
              allow_downhill_contact_push && g_component_objects[object] != 0 &&
              (ObjectIsFullyOnIce(voxels, other, width, height) ||
               ObjectIsFloatingFloor(voxels, other));
          const bool crest_contact_push = allow_downhill_contact_push &&
              (g_component_objects[object] & 2) != 0;
          const bool recruit_deliberate = deliberate_contact_push &&
              DeliberatePushMayRecruit(object, other);
          const bool recruit_downhill =
              (downhill_ice_contact_push || crest_contact_push) &&
              (g_object_kind[object] == kWeightlessObject ||
               g_object_kind[object] == kCloneObject ||
               g_object_kind[object] == kPlayerObject ||
               ObjectIsFloatingFloor(voxels, object)) &&
              ObjectAcceptsSlopeContactPush(voxels, other) &&
              DeliberatePushMayRecruit(object, other) &&
              (!ObjectIsFloatingFloor(voxels, other) ||
               FloatingFloorDestinationIsSupportedOrFillable(
                  voxels, other, g_object_dx[object], g_object_dy[object],
                  ObjectSlopeVerticalDelta(
                      voxels, other, g_object_direction[object], width, height,
                      false),
                  width, height));
          if (recruit_deliberate || recruit_downhill) {
            g_mandatory_objects[other] = 1;
            g_moving_objects[other] = 1;
            g_object_direction[other] = g_object_direction[object];
            g_component_objects[other] = g_component_objects[object];
            added = true;
          }
        }
      }
    }
  }

  // Rebuild carried ramp and Ice-momentum proposals after contact closure.
  // Discover every rider before demoting any carrier, so a tall stack does
  // not depend on which body's records appear first in voxel storage.
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_carried_objects[object] = 0;
    if (g_mandatory_objects[object] == 0) continue;
    bool rider_is_movable_ramp = false;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      rider_is_movable_ramp |=
          IsBlueBoxSlopeRole(voxels[member].role) ||
          IsYellowCloneSlopeRole(voxels[member].role);
    }
    if (!rider_is_movable_ramp && allow_push) continue;
    const int32_t carrier = MovingSupportBelowObject(
        voxels, object, player_index, false, width, height, false, nullptr,
        MovingPlayerCarrier(voxels, player_index, width, height));
    if (carrier < 0) continue;
    // Serialized Ice momentum also belongs to ordinary carried boxes. Without
    // rebuilding that relationship they propose a level move while their
    // ramp-supported carrier climbs, and the stack collides with itself.
    // An uphill reflection reverses the stack together; a sideways ramp turn
    // still lets independently arriving momentum continue on its own axis.
    const bool follows_carrier = !allow_push &&
        g_object_falling[object] == 0 &&
        !ObjectIsFullyOnIce(voxels, object, width, height) &&
        g_component_indegree[object] <= 3 &&
        g_component_indegree[object] == g_component_indegree[carrier] &&
        (g_object_direction[carrier] == g_component_indegree[carrier] ||
         g_object_direction[carrier] == OppositeDirection(g_component_indegree[carrier]));
    if (!rider_is_movable_ramp && !follows_carrier) continue;
    g_carried_objects[object] = follows_carrier ? 2 : 1;
  }
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_carried_objects[object] == 0) continue;
    g_mandatory_objects[object] = 0;
    g_moving_objects[object] = 0;
    // Let the carry pass copy the parent's 3D transform instead of treating
    // this inherited heading as the rider's own latent momentum.
    if (g_carried_objects[object] == 2) g_object_direction[object] = 0xff;
  }

  // A slope reflection propagates through exact head-on contacts. Recompute
  // after every propagation because adjacent bodies can be on different ramp
  // elevations even though their horizontal speed is identical.
  bool propagated = true;
  while (propagated) {
    propagated = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_mandatory_objects[object] != 0) {
        PrepareSlopeObjectProposal(
            voxels, object, width, height, !allow_push, allow_push);
      }
    }
    for (int32_t first = 0; first < g_object_count; ++first) {
      if (g_mandatory_objects[first] == 0 ||
          g_object_redirected[first] == 0) {
        continue;
      }
      for (int32_t second = 0; second < g_object_count; ++second) {
        if (first == second || g_mandatory_objects[second] == 0 ||
            g_object_direction[first] == g_object_direction[second] ||
            !ObjectProposalsSwap(voxels, first, second)) {
          continue;
        }
        g_object_direction[second] = g_object_direction[first];
        g_object_redirected[second] = 1;
        PrepareSlopeObjectProposal(
            voxels, second, width, height, false, allow_push);
        propagated = true;
      }
    }
  }
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_deferred_slope_objects[object] != 0) {
      g_mandatory_objects[object] = 0;
      g_moving_objects[object] = 0;
      continue;
    }
    if (g_mandatory_objects[object] != 0) {
      PrepareSlopeObjectProposal(
          voxels, object, width, height, false, allow_push);
    }
  }

  ConvertTrappedBodiesToMovableSlopeLifts(
      voxels,
      player_index,
      width,
      height,
      player_moves_horizontally);

  if (punch_state != nullptr) {
    PreparePunchContactProposals(
        punch_state, voxels, player_index, width, height,
        punched_player_direction);
  }

  // Slope proposals can have a different vertical delta per object, so the
  // ordinary uniform-delta carrier path cannot be used directly. Discover
  // the same support graph, then copy each carrier's exact 3D proposal to its
  // riders before validating the transaction.
  AddSlopeCarriedObjects(
      voxels, player_index, width, height, !allow_push,
      player_moves_horizontally || punched_player_direction >= 0);
  if (punch_state != nullptr) {
    ResolvePunchProposals(
        punch_state, voxels, player_index, width, height,
        player_moves_horizontally, punched_player_direction);
    player_moves_horizontally |= punched_player_direction >= 0;
  } else if (!ResolveSlopeCarriedCollisions(
          voxels, player_index, width, height, player_moves_horizontally)) {
    return false;
  }

  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0 ||
        !ObjectIsActive(voxels, object, width, height)) {
      continue;
    }
    if (allow_push &&
        !FloatingFloorDestinationIsSupportedOrFillable(
            voxels,
            object,
            g_object_dx[object],
            g_object_dy[object],
            g_object_dz[object],
            width,
            height)) {
      return false;
    }
    if (punch_state == nullptr && !SlopeObjectDestinationIsClear(
            voxels, object, player_index, width, height,
            player_moves_horizontally,
            allow_push && g_carried_objects[object] == 0 &&
                (g_object_kind[object] == kCloneObject ||
                 g_object_kind[object] == kPlayerObject))) {
      return false;
    }
  }

  // Punch proposals already resolved shared destinations independently.
  // Other slope transactions still reject the complete conflicting move.
  for (int32_t first = 0; punch_state == nullptr && first < g_object_count; ++first) {
    if (g_mandatory_objects[first] == 0) continue;
    for (int32_t second = first + 1; second < g_object_count; ++second) {
      if (g_mandatory_objects[second] == 0) continue;
      for (int32_t first_member = g_object_head[first]; first_member >= 0;
           first_member = g_next_object_voxel[first_member]) {
        for (int32_t second_member = g_object_head[second]; second_member >= 0;
             second_member = g_next_object_voxel[second_member]) {
          if (voxels[first_member].x + g_object_dx[first] ==
                  voxels[second_member].x + g_object_dx[second] &&
              voxels[first_member].y + g_object_dy[first] ==
                  voxels[second_member].y + g_object_dy[second] &&
              voxels[first_member].z + g_object_dz[first] ==
                  voxels[second_member].z + g_object_dz[second]) {
            // A shared logical cell is legal for a collapsed face fixture,
            // just as in uniform translations. Raised cubes still collide,
            // and the lowered-lift policy still forbids overlap with Floor.
            if (MovingFixtureIgnoresOccupant(
                    voxels[first_member], &voxels[second_member]) ||
                MovingFixtureIgnoresOccupant(
                    voxels[second_member], &voxels[first_member])) {
              continue;
            }
            return false;
          }
        }
      }
    }
  }

  int32_t representative_dx = 0;
  int32_t representative_dy = 0;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0) continue;
    representative_dx = g_object_dx[object];
    representative_dy = g_object_dy[object];
    break;
  }

  // If a turning body slides sideways out from under a stationary stack, the
  // unsupported stack's downward proposal belongs to this same synchronized
  // tick. Propagate support loss upward before the gravity resolver so every
  // member of the stack descends one cell while its former carrier departs.
  for (int32_t object = 0; object < g_object_count; ++object) {
    g_component_objects[object] = 0;
  }
  bool support_loss_changed = true;
  while (support_loss_changed) {
    support_loss_changed = false;
    for (int32_t object = 0; object < g_object_count; ++object) {
      // A passenger denied its carry was supported at the start of this
      // tick. Arm its fall after the carrier commits, for the following tick.
      if (g_component_objects[object] != 0 ||
          g_rejected_carriers[object] != 0 ||
          !ObjectIsActive(voxels, object, width, height)) {
        continue;
      }
      const int32_t synchronized_carrier = g_carrier_parent[object];
      if (synchronized_carrier >= 0 &&
          g_mandatory_objects[synchronized_carrier] != 0 &&
          g_object_dx[object] == g_object_dx[synchronized_carrier] &&
          g_object_dy[object] == g_object_dy[synchronized_carrier] &&
          g_object_dz[object] == g_object_dz[synchronized_carrier]) {
        // The carrier vacates the old support cell but refills the rider's
        // translated support cell with the same rigid transform.
        continue;
      }
      bool had_departing_support = false;
      bool has_stable_support = false;
      const auto consider_support = [&](int32_t support, int32_t support_z) {
        if (support < 0) return;
        const int32_t support_object = g_voxel_object[support];
        if (support_object == object) return;
        if (support_object >= 0 && g_mandatory_objects[support_object] != 0 &&
            ObjectProposalVacatesCell(
                voxels,
                support_object,
                voxels[support].x,
                voxels[support].y,
                support_z)) {
          if (g_mandatory_objects[object] != 0 &&
              g_object_dx[object] == g_object_dx[support_object] &&
              g_object_dy[object] == g_object_dy[support_object] &&
              g_object_dz[object] == g_object_dz[support_object]) {
            // Both bodies apply the same transform, so the support remains
            // directly beneath the rider at the destination even if the
            // carrier-parent marker was cleared after momentum resolution.
            has_stable_support = true;
            return;
          }
          had_departing_support = true;
          return;
        }
        if (support_object >= 0 &&
            g_component_objects[support_object] != 0) {
          had_departing_support = true;
          return;
        }
        has_stable_support = true;
      };
      // A face fixture remains supported by its mount when a different body
      // leaves the cell beneath it. Apply the same departure rules to both
      // kinds of support before scheduling an immediate fall.
      const int32_t attachment = MechanismAttachmentVoxel(voxels, object, width, height);
      if (attachment >= 0) {
        consider_support(attachment, VoxelPhysicalZ(voxels, count, attachment));
      }
      for (int32_t member = g_object_head[object];
           member >= 0 && !has_stable_support;
           member = g_next_object_voxel[member]) {
        const Voxel& voxel = voxels[member];
        if (voxel.z == INT32_MIN) continue;
        consider_support(FindVoxelAt(
            voxels, voxel.x, voxel.y, voxel.z - 1, width, height), voxel.z - 1);
      }
      if (had_departing_support && !has_stable_support) {
        // A horizontal proposal cannot remain suspended above a support
        // component that is falling during this same tick. Gravity wins for
        // the rider too, so a whole vertical stack descends together instead
        // of its upper member skating sideways through the air.
        g_mandatory_objects[object] = 0;
        g_moving_objects[object] = 0;
        g_component_objects[object] = 1;
        g_object_falling[object] = 1;
        support_loss_changed = true;
      }
    }
  }
  // Do not allow a ledge push unless its original player support survived
  // contact closure, carry validation, and support-loss resolution as a mover.
  if (required_player_carrier >= 0 &&
      (g_mandatory_objects[required_player_carrier] == 0 ||
       (g_object_dx[required_player_carrier] == 0 &&
        g_object_dy[required_player_carrier] == 0))) {
    return false;
  }
  AdvanceUnmovedGravityOneStep(
      voxels,
      count,
      width,
      height,
      player_index,
      representative_dx,
      representative_dy,
      player_moves_horizontally,
      true);

  // A body can enter the space immediately above a source cell another body
  // vacates in this tick. It inherits that slippery support's direction on
  // the next tick instead of falling or retaining an unrelated ramp heading.
  // Capture the relation while the spatial index still represents all source
  // coordinates; the translation commit below then moves both bodies.
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0) continue;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      const int32_t target_x = voxels[member].x + g_object_dx[object];
      const int32_t target_y = voxels[member].y + g_object_dy[object];
      const int32_t target_z = voxels[member].z + g_object_dz[object];
      if (target_z == INT32_MIN) continue;
      const int32_t departing_support = FindVoxelAt(
          voxels, target_x, target_y, target_z - 1, width, height);
      const int32_t support_object = departing_support >= 0
          ? g_voxel_object[departing_support]
          : -1;
      if (support_object < 0 || support_object == object ||
          g_mandatory_objects[support_object] == 0 ||
          !ObjectIsFullyOnIce(voxels, support_object, width, height) ||
          !ObjectProposalVacatesCell(
              voxels,
              support_object,
              target_x,
              target_y,
              target_z - 1)) {
        continue;
      }
      // A mandatory proposal only means "move this tick". Ordinary pushed
      // interlocked bodies must not manufacture continuing momentum for one
      // another merely because an unrelated ramp selected this code path.
      // Actual carried stacks are resolved after both proposals commit.
      g_inherited_support_motion[object] = static_cast<uint8_t>(
          g_object_direction[support_object] + 1);
      break;
    }
  }

  bool moved = punched_player_direction >= 0;
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0) continue;
    moved = true;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      voxels[member].x += g_object_dx[object];
      voxels[member].y += g_object_dy[object];
      voxels[member].z += g_object_dz[object];
    }
    if (g_inherited_support_motion[object] != 0) {
      g_object_direction[object] = static_cast<uint8_t>(
          g_inherited_support_motion[object] - 1);
    }
  }
  if (punched_player_direction >= 0) {
    constexpr int32_t kDx[] = {0, 1, 0, -1};
    constexpr int32_t kDy[] = {-1, 0, 1, 0};
    voxels[player_index].x += kDx[punched_player_direction];
    voxels[player_index].y += kDy[punched_player_direction];
    player_was_pushed = true;
  }
  if (!moved) {
    // A latent-momentum body may have advanced only along gravity and landed
    // on a lower slope. Report that synchronized movement to the caller so it
    // can promote the saved direction back to active Ice momentum instead of
    // completing the command on the landing frame.
    for (int32_t object = 0; object < g_object_count; ++object) {
      if (g_fell_objects[object] != 0) return true;
    }
    return false;
  }
  ArmTranslatedHoveringObjects(voxels);
  BuildSpatialIndex(voxels, count, width, height);
  PreserveSlopeCarriedMomentum(voxels, width, height);
  PreserveMovableSlopeRiderMomentum(voxels, width, height);
  MarkObjectsForDeferredGravity(voxels, width, height, false);
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_object_redirected[object] == 2) {
      // The lifted body moved vertically because its horizontal proposal was
      // blocked. It must not inherit the ramp body's horizontal command as a
      // new Ice-momentum tick.
      g_moving_objects[object] = 0;
      bool lifted_body_is_movable_ramp = false;
      for (int32_t member = g_object_head[object]; member >= 0;
           member = g_next_object_voxel[member]) {
        lifted_body_is_movable_ramp |=
            IsBlueBoxSlopeRole(voxels[member].role) ||
            IsYellowCloneSlopeRole(voxels[member].role);
      }
      if (lifted_body_is_movable_ramp &&
          !DeferredSlopeProposalIsClear(
              voxels, object, player_index, width, height)) {
        g_mandatory_objects[object] = 0;
      }
      g_object_redirected[object] = 0;
    }
  }
  // A lifted ramp stack may leave several members marked mandatory even
  // though only the exposed top member has a clear downhill continuation.
  // Prune each blocked ramp now so one stale proposal cannot cancel an
  // otherwise independent free ramp on the following tick.
  for (int32_t object = 0; object < g_object_count; ++object) {
    if (g_mandatory_objects[object] == 0 &&
        g_inherited_support_motion[object] == 0) {
      continue;
    }
    bool object_is_movable_ramp = false;
    for (int32_t member = g_object_head[object]; member >= 0;
         member = g_next_object_voxel[member]) {
      object_is_movable_ramp |=
          IsBlueBoxSlopeRole(voxels[member].role) ||
          IsYellowCloneSlopeRole(voxels[member].role);
    }
    if (object_is_movable_ramp &&
        !DeferredSlopeProposalIsClear(
            voxels, object, player_index, width, height)) {
      g_mandatory_objects[object] = 0;
      g_moving_objects[object] = 0;
      g_inherited_support_motion[object] = 0;
    }
  }
  return true;
}
