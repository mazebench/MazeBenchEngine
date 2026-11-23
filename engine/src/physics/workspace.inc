constexpr uint32_t HashRoleLiteral(const char* value, uint32_t hash = 2166136261u) {
  return *value == '\0'
      ? hash
      : HashRoleLiteral(value + 1, (hash ^ static_cast<uint8_t>(*value)) * 16777619u);
}

constexpr uint32_t kPlayerRole = HashRoleLiteral("player");
constexpr uint32_t kCloneRole = HashRoleLiteral("clone");
constexpr uint32_t kPushableRole = HashRoleLiteral("pushable");
constexpr uint32_t kWeightlessPushableRole = HashRoleLiteral("weightless-pushable");
constexpr uint32_t kIceRole = HashRoleLiteral("ice");
constexpr uint32_t kIceSlopeUpRole = HashRoleLiteral("ice-slope-up");
constexpr uint32_t kIceSlopeRightRole = HashRoleLiteral("ice-slope-right");
constexpr uint32_t kIceSlopeDownRole = HashRoleLiteral("ice-slope-down");
constexpr uint32_t kIceSlopeLeftRole = HashRoleLiteral("ice-slope-left");
constexpr uint32_t kBlueBoxSlopeUpRole = HashRoleLiteral("blue-box-slope-up");
constexpr uint32_t kBlueBoxSlopeRightRole = HashRoleLiteral("blue-box-slope-right");
constexpr uint32_t kBlueBoxSlopeDownRole = HashRoleLiteral("blue-box-slope-down");
constexpr uint32_t kBlueBoxSlopeLeftRole = HashRoleLiteral("blue-box-slope-left");
constexpr uint32_t kYellowCloneSlopeUpRole =
    HashRoleLiteral("yellow-clone-slope-up");
constexpr uint32_t kYellowCloneSlopeRightRole =
    HashRoleLiteral("yellow-clone-slope-right");
constexpr uint32_t kYellowCloneSlopeDownRole =
    HashRoleLiteral("yellow-clone-slope-down");
constexpr uint32_t kYellowCloneSlopeLeftRole =
    HashRoleLiteral("yellow-clone-slope-left");
constexpr uint32_t kFloorRole = HashRoleLiteral("floor");
constexpr uint32_t kGoalRole = HashRoleLiteral("goal");
constexpr uint32_t kPlayerLiftRole = HashRoleLiteral("player-lift");
constexpr uint32_t kPlayerGateRole = HashRoleLiteral("player-gate");
constexpr uint32_t kOrangeButtonRole = HashRoleLiteral("orange-button");
constexpr uint32_t kOrangeWallRole = HashRoleLiteral("orange-wall");
constexpr uint32_t kOrangeWallSlopeUpRole = HashRoleLiteral("orange-wall-slope-up");
constexpr uint32_t kOrangeWallSlopeRightRole = HashRoleLiteral("orange-wall-slope-right");
constexpr uint32_t kOrangeWallSlopeDownRole = HashRoleLiteral("orange-wall-slope-down");
constexpr uint32_t kOrangeWallSlopeLeftRole = HashRoleLiteral("orange-wall-slope-left");
constexpr uint32_t kPuncherRole = HashRoleLiteral("puncher");
constexpr uint32_t kFloatingFloorRole = HashRoleLiteral("floating-floor");
constexpr int32_t kFilledFloatingFloor = 1;

// Spatial and rigid-object indexes contain at most kVoxelCapacity entries.
// The 2x backing table preserves a <= 0.5 load factor at maximum scene size.
constexpr int32_t kHashCapacity = kVoxelCapacity * 2;
constexpr int32_t kHashMask = kHashCapacity - 1;
constexpr int32_t kDenseColumnCapacity = 4096;
constexpr int32_t kLinearSpatialThreshold = 16;
constexpr uint8_t kNormalObject = 0;
constexpr uint8_t kWeightlessObject = 1;
constexpr uint8_t kMechanismObject = 2;
constexpr uint8_t kCloneObject = 3;
constexpr uint8_t kPlayerObject = 4;
// Internal continuation bits share the existing per-voxel gravity byte. Bit 0
// remains the gravity flag; lift entry survives workspace rebuilds without
// changing the public MotionState layout or the WebAssembly ABI.
constexpr uint8_t kActorLiftEntryPending = 0x80;
constexpr uint8_t kActorLiftSelected = 0x40;
constexpr uint8_t kVacatedLiftRetryPending = 0x20;
constexpr uint8_t kLiftContinuationMask =
    kActorLiftEntryPending | kVacatedLiftRetryPending;

bool IsOrangeWallSlopeRole(uint32_t role) {
  return role == kOrangeWallSlopeUpRole || role == kOrangeWallSlopeRightRole ||
      role == kOrangeWallSlopeDownRole || role == kOrangeWallSlopeLeftRole;
}

bool IsOrangeWallRole(uint32_t role) {
  return role == kOrangeWallRole || IsOrangeWallSlopeRole(role);
}

bool IsTerrainIceSlopeRole(uint32_t role) {
  return role == kIceSlopeUpRole || role == kIceSlopeRightRole ||
      role == kIceSlopeDownRole || role == kIceSlopeLeftRole;
}

bool IsBlueBoxSlopeRole(uint32_t role) {
  return role == kBlueBoxSlopeUpRole || role == kBlueBoxSlopeRightRole ||
      role == kBlueBoxSlopeDownRole || role == kBlueBoxSlopeLeftRole;
}

bool IsYellowCloneSlopeRole(uint32_t role) {
  return role == kYellowCloneSlopeUpRole ||
      role == kYellowCloneSlopeRightRole ||
      role == kYellowCloneSlopeDownRole ||
      role == kYellowCloneSlopeLeftRole;
}

bool IsWeightlessObjectRole(uint32_t role) {
  return role == kWeightlessPushableRole || IsBlueBoxSlopeRole(role);
}

bool IsCloneObjectRole(uint32_t role) {
  return role == kCloneRole || IsYellowCloneSlopeRole(role);
}

bool IsIceSlopeRole(uint32_t role) {
  return IsTerrainIceSlopeRole(role) || IsBlueBoxSlopeRole(role) ||
      IsYellowCloneSlopeRole(role) || IsOrangeWallSlopeRole(role);
}

bool IsIceRole(uint32_t role) {
  return role == kIceRole || IsIceSlopeRole(role);
}

bool PlayerLiftIsRaised(const Voxel& voxel) {
  return voxel.role == kPlayerLiftRole && voxel.generic_id >= 0 &&
      voxel.generic_id % 2 != 0;
}

bool IsLoweredPlayerLift(const Voxel& voxel) {
  return voxel.role == kPlayerLiftRole && !PlayerLiftIsRaised(voxel);
}

bool IsLoweredPlayerGate(const Voxel& voxel) {
  return voxel.role == kPlayerGateRole && voxel.generic_id != 1;
}

bool IsOrdinaryPassThroughVoxel(const Voxel& voxel) {
  return voxel.role == kGoalRole || voxel.role == kPuncherRole ||
      IsLoweredPlayerLift(voxel) || IsLoweredPlayerGate(voxel);
}

bool IsPassThroughVoxel(const Voxel& voxel) {
  return IsOrdinaryPassThroughVoxel(voxel) ||
      voxel.role == kOrangeButtonRole;
}

// Use the same fixture collision policy for uniform and slope proposals.
// Retracted mechanisms and face sensors may overlap occupied cells, but a
// lowered lift must stay above floor geometry.
bool MovingFixtureIgnoresOccupant(const Voxel& fixture, const Voxel* occupant) {
  return IsPassThroughVoxel(fixture) &&
      !(IsLoweredPlayerLift(fixture) && occupant != nullptr &&
        occupant->role == kFloorRole);
}

bool HasOrangeScope(const Voxel& voxel) {
  return (voxel.role == kOrangeButtonRole || IsOrangeWallRole(voxel.role)) &&
      voxel.generic_id >= 0 && (voxel.generic_id & kOrangeScopedIdFlag) != 0;
}

int32_t OrangeScope(const Voxel& voxel) {
  return HasOrangeScope(voxel)
      ? (voxel.generic_id >> kOrangeScopeShift) & (kOrangeScopeCount - 1)
      : 0;
}

int32_t OrangeLocalId(const Voxel& voxel) {
  return HasOrangeScope(voxel) ? voxel.generic_id & kOrangeValueMask
                               : voxel.generic_id;
}

int32_t OrangeWallDepth(const Voxel& voxel) {
  if (!IsOrangeWallRole(voxel.role)) return 0;
  // Negative values are accepted only for compatibility with the former
  // dedicated-face ABI. New callers encode every Orange Wall form with the
  // same nonnegative depth; form is derived from anchor, depth, and support.
  if (voxel.generic_id <= -2) {
    return voxel.generic_id == INT32_MIN
        ? INT32_MAX - 1
        : -voxel.generic_id - 2;
  }
  const int32_t local_id = OrangeLocalId(voxel);
  return local_id > 0 ? local_id : 0;
}

void SetOrangeWallDepth(Voxel* voxel, int32_t depth) {
  if (voxel == nullptr || !IsOrangeWallRole(voxel->role)) return;
  if (depth < 0) depth = 0;
  voxel->generic_id = HasOrangeScope(*voxel)
      ? (voxel->generic_id & ~kOrangeValueMask) | (depth & kOrangeValueMask)
      : depth;
}

// Orange walls retain their fully-raised anchor coordinate. Their deterministic
// state is the number of active buttons. At anchor-depth they are a cube above
// support, a zero-thickness face exactly on the support plane, or a hidden,
// pass-through volume below it.
int32_t OrangeWallSupportZ(Voxel* voxels, int32_t count, int32_t wall_index);

int32_t OrangeWallPhysicalZForDepth(
    Voxel* voxels,
    int32_t count,
    int32_t wall_index,
    int32_t depth) {
  const Voxel& wall = voxels[wall_index];
  const int64_t desired = static_cast<int64_t>(wall.z) - depth;
  const int32_t support_z = OrangeWallSupportZ(voxels, count, wall_index);
  if (support_z != INT32_MIN && desired == support_z) {
    return support_z == INT32_MAX ? INT32_MAX : support_z + 1;
  }
  if (desired < INT32_MIN) return INT32_MIN;
  return static_cast<int32_t>(desired);
}

bool OrangeWallIsFlatForDepth(
    Voxel* voxels,
    int32_t count,
    int32_t wall_index,
    int32_t depth) {
  const int32_t support_z = OrangeWallSupportZ(voxels, count, wall_index);
  return support_z != INT32_MIN &&
      static_cast<int64_t>(voxels[wall_index].z) - depth == support_z;
}

bool OrangeWallIsHiddenForDepth(
    Voxel* voxels,
    int32_t count,
    int32_t wall_index,
    int32_t depth) {
  const int32_t support_z = OrangeWallSupportZ(voxels, count, wall_index);
  return support_z != INT32_MIN &&
      static_cast<int64_t>(voxels[wall_index].z) - depth < support_z;
}

int32_t OrangeWallPhysicalZ(
    Voxel* voxels,
    int32_t count,
    int32_t wall_index) {
  return OrangeWallPhysicalZForDepth(
      voxels, count, wall_index, OrangeWallDepth(voxels[wall_index]));
}

// Every Orange Wall record represents exactly one voxel of the raised
// polycube. Compression may turn it into a face or hidden volume, but never
// creates inferred collision cells between authored voxels.
bool OrangeWallOccupiesZ(
    Voxel* voxels,
    int32_t count,
    int32_t wall_index,
    int32_t z) {
  if (!IsOrangeWallRole(voxels[wall_index].role) ||
      OrangeWallIsFlatForDepth(
          voxels, count, wall_index, OrangeWallDepth(voxels[wall_index])) ||
      OrangeWallIsHiddenForDepth(
          voxels, count, wall_index, OrangeWallDepth(voxels[wall_index]))) {
    return false;
  }
  const int32_t top = OrangeWallPhysicalZ(voxels, count, wall_index);
  return z == top;
}

int32_t OrangeWallSurfaceZForDepth(
    Voxel* voxels,
    int32_t count,
    int32_t wall_index,
    int32_t depth) {
  const int32_t physical = OrangeWallPhysicalZForDepth(
      voxels, count, wall_index, depth);
  if (OrangeWallIsHiddenForDepth(voxels, count, wall_index, depth)) {
    return INT32_MIN;
  }
  return OrangeWallIsFlatForDepth(voxels, count, wall_index, depth)
      ? physical
      : physical == INT32_MAX ? INT32_MAX : physical + 1;
}

int32_t VoxelPhysicalZ(Voxel* voxels, int32_t count, int32_t index) {
  return IsOrangeWallRole(voxels[index].role)
      ? OrangeWallPhysicalZ(voxels, count, index)
      : voxels[index].z;
}

bool VoxelBlocksSpace(Voxel* voxels, int32_t count, int32_t index) {
  if (IsPassThroughVoxel(voxels[index])) return false;
  return !IsOrangeWallRole(voxels[index].role) ||
      (!OrangeWallIsFlatForDepth(
           voxels, count, index, OrangeWallDepth(voxels[index])) &&
       !OrangeWallIsHiddenForDepth(
           voxels, count, index, OrangeWallDepth(voxels[index])));
}

int32_t IceSlopeDirection(uint32_t role) {
  if (role == kIceSlopeUpRole || role == kBlueBoxSlopeUpRole ||
      role == kYellowCloneSlopeUpRole || role == kOrangeWallSlopeUpRole) return 0;
  if (role == kIceSlopeRightRole || role == kBlueBoxSlopeRightRole ||
      role == kYellowCloneSlopeRightRole || role == kOrangeWallSlopeRightRole) return 1;
  if (role == kIceSlopeDownRole || role == kBlueBoxSlopeDownRole ||
      role == kYellowCloneSlopeDownRole || role == kOrangeWallSlopeDownRole) return 2;
  if (role == kIceSlopeLeftRole || role == kBlueBoxSlopeLeftRole ||
      role == kYellowCloneSlopeLeftRole || role == kOrangeWallSlopeLeftRole) return 3;
  return -1;
}

int32_t OppositeDirection(int32_t direction) {
  return (direction + 2) & 3;
}

struct HashEntry {
  uint64_t key;
  int32_t value;
  uint32_t stamp;
};

// These fixed workspaces keep the freestanding WebAssembly ABI allocation-free.
// Stamps make rebuilding the spatial index O(voxel count), without clearing its
// 131k slots between the many unit translations in an Ice move.
struct WorkspaceData {
  HashEntry hash_entries[kHashCapacity];
  uint32_t hash_generation;
  HashEntry static_hash_entries[kHashCapacity];
  uint32_t static_hash_generation;
  int32_t voxel_object[kVoxelCapacity];
  int32_t next_object_voxel[kVoxelCapacity];
  int32_t object_head[kVoxelCapacity];
  uint8_t object_kind[kVoxelCapacity];
  uint8_t moving_objects[kVoxelCapacity];
  uint8_t mandatory_objects[kVoxelCapacity];
  uint8_t object_direction[kVoxelCapacity];
  int8_t object_dx[kVoxelCapacity];
  int8_t object_dy[kVoxelCapacity];
  int8_t object_dz[kVoxelCapacity];
  uint8_t object_redirected[kVoxelCapacity];
  uint64_t punch_activated[kVoxelCapacity / 64];
  uint8_t deferred_slope_objects[kVoxelCapacity];
  uint8_t inherited_support_motion[kVoxelCapacity];
  uint8_t carried_objects[kVoxelCapacity];
  uint8_t rejected_carriers[kVoxelCapacity];
  uint8_t fell_objects[kVoxelCapacity];
  uint8_t object_falling[kVoxelCapacity];
  uint8_t pending_fall[kVoxelCapacity];
  uint8_t clone_command_moved[kVoxelCapacity];
  uint8_t clone_command_processed[kVoxelCapacity];
  uint8_t blocked_orange_walls[kVoxelCapacity];
  uint8_t orange_component_walls[kVoxelCapacity];
  int8_t orange_component_shifts[kVoxelCapacity];
  int32_t carrier_parent[kVoxelCapacity];
  uint8_t object_gravity_armed[kVoxelCapacity];
  uint8_t component_objects[kVoxelCapacity];
  int32_t component_indegree[kVoxelCapacity];
  int32_t object_queue[kVoxelCapacity];
  uint64_t slope_push_seen[kVoxelCapacity / 64];
  uint64_t slope_push_pending[kVoxelCapacity / 64];
  uint64_t slope_ascent_objects[kVoxelCapacity / 64];
  int32_t column_heads[kDenseColumnCapacity];
  int32_t next_column_voxel[kVoxelCapacity];
  int32_t static_column_heads[kDenseColumnCapacity];
  int32_t dynamic_column_heads[kDenseColumnCapacity];
  uint32_t dynamic_column_stamps[kDenseColumnCapacity];
  uint32_t dynamic_column_generation;
  int32_t next_static_column_voxel[kVoxelCapacity];
  int32_t next_dynamic_column_voxel[kVoxelCapacity];
  int32_t object_count;
  int32_t weightless_object_count;
  int32_t room_grid_width;
  int32_t room_grid_height;
  bool dense_columns;
  bool linear_spatial;
  int32_t spatial_voxel_count;
  bool moving_objects_fell;
  int32_t ignored_support_voxel;
  MotionState* continuation_state;
  Voxel* continuation_voxels;
  int32_t continuation_tick;
  Voxel* prepared_voxels;
  int32_t prepared_count;
  int32_t prepared_width;
  int32_t prepared_height;
  int32_t prepared_dynamic_voxel_count;
  int32_t prepared_player_index;
  int32_t prepared_goal_indices[kVoxelCapacity];
  int32_t prepared_goal_count;
  bool prepared_dense_columns;
  bool prepared_has_ice_slopes;
  bool prepared_has_player_lifts;
  bool prepared_has_orange_mechanisms;
  bool prepared_has_punchers;
  bool prepared_has_floating_floors;
  bool prepared_has_clones;
  bool prepared_has_player_polycube;
  bool scene_has_orange_mechanisms;
  bool scene_has_player_gates;
  bool clone_command_tick_active;
  bool assume_quiescent_start;
  int32_t motion_voxel_count;
  bool prepared_index_active;
  // Raw anchored columns include hidden walls and lowered gates. Movable
  // supports are kept separately and read live, even between spatial rebuilds.
  Voxel* orange_support_voxels;
  int32_t orange_support_count;
  int32_t orange_column_heads[1024];
  int32_t next_orange_support[4096];
  int32_t orange_moving_support_head;
};

static_assert(sizeof(WorkspaceData) <= kPhysicsWorkspaceBytes);

#if defined(__wasm__)
WorkspaceData* g_active_workspace = nullptr;
#elif (defined(__GNUC__) || defined(__clang__)) && !defined(_WIN32)
// The native engine is linked into its host rather than loaded as a late TLS
// plugin, so the initial-exec model avoids a resolver call in every hot
// collision helper while retaining one independent workspace pointer/thread.
thread_local __attribute__((tls_model("initial-exec")))
    WorkspaceData* g_active_workspace = nullptr;
#else
thread_local WorkspaceData* g_active_workspace = nullptr;
#endif

WorkspaceData& ActiveWorkspace() {
  return *g_active_workspace;
}

int32_t ScanOrangeWallSupportZ(
    Voxel* voxels,
    int32_t count,
    int32_t wall_index) {
  const Voxel& wall = voxels[wall_index];
  // Every record in one vertical Orange Wall column is a voxel of the same
  // fully-raised polycube. Collapse is measured from the terrain beneath the
  // column's lowest raised anchor. Static geometry among/above those anchors
  // is an obstruction to later raising, not a new floor that changes the
  // meaning of already-authored face and hidden states.
  int32_t lowest_anchor_z = wall.z;
  for (int32_t index = 0; index < count; ++index) {
    if (IsOrangeWallRole(voxels[index].role) &&
        OrangeScope(voxels[index]) == OrangeScope(wall) &&
        voxels[index].x == wall.x && voxels[index].y == wall.y &&
        voxels[index].z < lowest_anchor_z) {
      lowest_anchor_z = voxels[index].z;
    }
  }
  int32_t support_z = INT32_MIN;
  for (int32_t index = 0; index < count; ++index) {
    if (index == wall_index || voxels[index].x != wall.x ||
        voxels[index].y != wall.y || IsOrangeWallRole(voxels[index].role) ||
        voxels[index].role == kPlayerRole ||
        voxels[index].role == kPushableRole ||
        IsWeightlessObjectRole(voxels[index].role) ||
        voxels[index].role == kPlayerLiftRole ||
        voxels[index].role == kOrangeButtonRole ||
        IsPassThroughVoxel(voxels[index]) ||
        voxels[index].z >= lowest_anchor_z ||
        voxels[index].z == INT32_MIN) {
      continue;
    }
    if (voxels[index].z > support_z) support_z = voxels[index].z;
  }
  return support_z;
}


uint32_t OrangeColumnBucket(int32_t x, int32_t y) {
  return ((static_cast<uint32_t>(x) * 73856093u) ^
      (static_cast<uint32_t>(y) * 19349663u)) & 1023u;
}

void BuildOrangeSupportIndex(Voxel* voxels, int32_t count) {
  WorkspaceData& data = ActiveWorkspace();
  for (int32_t bucket = 0; bucket < 1024; ++bucket) data.orange_column_heads[bucket] = -1;
  data.orange_moving_support_head = -1;
  for (int32_t index = 0; index < count; ++index) {
    const Voxel& voxel = voxels[index];
    const uint32_t role = voxel.role;
    if (role == kPlayerRole || role == kPushableRole || IsWeightlessObjectRole(role) ||
        role == kPlayerLiftRole || role == kOrangeButtonRole ||
        role == kGoalRole || role == kPuncherRole) continue;
    int32_t& head = (IsCloneObjectRole(role) || role == kFloatingFloorRole)
        ? data.orange_moving_support_head
        : data.orange_column_heads[OrangeColumnBucket(voxel.x, voxel.y)];
    data.next_orange_support[index] = head;
    head = index;
  }
  data.orange_support_voxels = voxels;
  data.orange_support_count = count;
}

int32_t OrangeWallSupportZ(Voxel* voxels, int32_t count, int32_t wall_index) {
  // Keep the public 8 MiB workspace ABI unchanged. Very large connected
  // scenes retain the exact scan; ordinary rooms fit this bounded index.
  if (count > 4096) return ScanOrangeWallSupportZ(voxels, count, wall_index);
  WorkspaceData& data = ActiveWorkspace();
  if (data.orange_support_voxels != voxels || data.orange_support_count != count) {
    BuildOrangeSupportIndex(voxels, count);
  }
  const Voxel& wall = voxels[wall_index];
  const int32_t head = data.orange_column_heads[OrangeColumnBucket(wall.x, wall.y)];
  // Read anchors and gate state live: mechanism updates may precede a rebuild.
  int32_t lowest_anchor_z = wall.z;
  for (int32_t index = head; index >= 0; index = data.next_orange_support[index]) {
    const Voxel& candidate = voxels[index];
    if (IsOrangeWallRole(candidate.role) && OrangeScope(candidate) == OrangeScope(wall) &&
        candidate.x == wall.x && candidate.y == wall.y && candidate.z < lowest_anchor_z) {
      lowest_anchor_z = candidate.z;
    }
  }
  int32_t support_z = INT32_MIN;
  for (int32_t pass = 0; pass < 2; ++pass) {
    for (int32_t index = pass == 0 ? head : data.orange_moving_support_head;
        index >= 0; index = data.next_orange_support[index]) {
      const Voxel& candidate = voxels[index];
      if (candidate.x == wall.x && candidate.y == wall.y &&
          !IsOrangeWallRole(candidate.role) && !IsPassThroughVoxel(candidate) &&
          candidate.z < lowest_anchor_z && candidate.z > support_z) {
        support_z = candidate.z;
      }
    }
  }
  return support_z;
}

#define g_hash_entries ActiveWorkspace().hash_entries
#define g_hash_generation ActiveWorkspace().hash_generation
#define g_static_hash_entries ActiveWorkspace().static_hash_entries
#define g_static_hash_generation ActiveWorkspace().static_hash_generation
#define g_voxel_object ActiveWorkspace().voxel_object
#define g_next_object_voxel ActiveWorkspace().next_object_voxel
#define g_object_head ActiveWorkspace().object_head
#define g_object_kind ActiveWorkspace().object_kind
#define g_moving_objects ActiveWorkspace().moving_objects
#define g_mandatory_objects ActiveWorkspace().mandatory_objects
#define g_object_direction ActiveWorkspace().object_direction
#define g_object_dx ActiveWorkspace().object_dx
#define g_object_dy ActiveWorkspace().object_dy
#define g_object_dz ActiveWorkspace().object_dz
#define g_object_redirected ActiveWorkspace().object_redirected
#define g_punch_activated ActiveWorkspace().punch_activated
#define g_deferred_slope_objects ActiveWorkspace().deferred_slope_objects
#define g_inherited_support_motion ActiveWorkspace().inherited_support_motion
#define g_carried_objects ActiveWorkspace().carried_objects
#define g_rejected_carriers ActiveWorkspace().rejected_carriers
#define g_fell_objects ActiveWorkspace().fell_objects
#define g_object_falling ActiveWorkspace().object_falling
#define g_pending_fall ActiveWorkspace().pending_fall
#define g_clone_command_moved ActiveWorkspace().clone_command_moved
#define g_clone_command_processed ActiveWorkspace().clone_command_processed
#define g_blocked_orange_walls ActiveWorkspace().blocked_orange_walls
#define g_orange_component_walls ActiveWorkspace().orange_component_walls
#define g_orange_component_shifts ActiveWorkspace().orange_component_shifts
#define g_carrier_parent ActiveWorkspace().carrier_parent
#define g_object_gravity_armed ActiveWorkspace().object_gravity_armed
#define g_component_objects ActiveWorkspace().component_objects
#define g_component_indegree ActiveWorkspace().component_indegree
#define g_object_queue ActiveWorkspace().object_queue
#define g_column_heads ActiveWorkspace().column_heads
#define g_next_column_voxel ActiveWorkspace().next_column_voxel
#define g_static_column_heads ActiveWorkspace().static_column_heads
#define g_dynamic_column_heads ActiveWorkspace().dynamic_column_heads
#define g_dynamic_column_stamps ActiveWorkspace().dynamic_column_stamps
#define g_dynamic_column_generation ActiveWorkspace().dynamic_column_generation
#define g_next_static_column_voxel ActiveWorkspace().next_static_column_voxel
#define g_next_dynamic_column_voxel ActiveWorkspace().next_dynamic_column_voxel
#define g_object_count ActiveWorkspace().object_count
#define g_weightless_object_count ActiveWorkspace().weightless_object_count
#define g_dense_columns ActiveWorkspace().dense_columns
#define g_linear_spatial ActiveWorkspace().linear_spatial
#define g_spatial_voxel_count ActiveWorkspace().spatial_voxel_count
#define g_moving_objects_fell ActiveWorkspace().moving_objects_fell
#define g_ignored_support_voxel ActiveWorkspace().ignored_support_voxel

WorkspaceData* WorkspaceStorage(PhysicsWorkspace* workspace) {
  return reinterpret_cast<WorkspaceData*>(workspace->storage);
}

struct WorkspaceScope {
  explicit WorkspaceScope(PhysicsWorkspace* workspace)
      : previous(g_active_workspace) {
    g_active_workspace = WorkspaceStorage(workspace);
  }
  ~WorkspaceScope() { g_active_workspace = previous; }
  WorkspaceData* previous;
};

bool IsInsideRoom(int32_t x, int32_t y, int32_t width, int32_t height) {
  return x >= 0 && x < width && y >= 0 && y < height;
}

bool VoxelStaysInRoomGrid(const Voxel& voxel, int32_t x, int32_t y) {
  const WorkspaceData& data = ActiveWorkspace();
  return voxel.role == kPlayerRole || data.room_grid_width == 0 ||
      (x >= 0 && y >= 0 &&
       voxel.x / data.room_grid_width == x / data.room_grid_width &&
       voxel.y / data.room_grid_height == y / data.room_grid_height);
}

bool VoxelDestinationIsInsideRoom(
    const Voxel& voxel, int32_t x, int32_t y,
    int32_t width, int32_t height) {
  return IsInsideRoom(x, y, width, height) && VoxelStaysInRoomGrid(voxel, x, y);
}

int32_t HashSlot(uint64_t key) {
  // Spatial keys carry z in the upper half and x/y in the lower half. Fold
  // both halves before one odd 64-bit multiply; the table's low load factor
  // supplies exact open-addressed lookup without requiring a two-round mixer.
  uint64_t hash = (key ^ (key >> 32u)) * UINT64_C(0x9e3779b185ebca87);
  hash ^= hash >> 32u;
  return static_cast<int32_t>(hash & static_cast<uint64_t>(kHashMask));
}

void ResetHash() {
  ++g_hash_generation;
  if (g_hash_generation != 0) return;
  for (int32_t index = 0; index < kHashCapacity; ++index) {
    g_hash_entries[index].stamp = 0;
  }
  g_hash_generation = 1;
}

int32_t HashFind(uint64_t key) {
  int32_t slot = HashSlot(key);
  for (;;) {
    const HashEntry& entry = g_hash_entries[slot];
    if (entry.stamp != g_hash_generation) return -1;
    if (entry.key == key) return entry.value;
    slot = (slot + 1) & kHashMask;
  }
}

void HashInsert(uint64_t key, int32_t value) {
  int32_t slot = HashSlot(key);
  while (g_hash_entries[slot].stamp == g_hash_generation &&
         g_hash_entries[slot].key != key) {
    slot = (slot + 1) & kHashMask;
  }
  g_hash_entries[slot] = {key, value, g_hash_generation};
}

// Orange volume may overlap another solid while an actuator proposal is
// checked. Keep the obstacle visible to collision queries regardless of which
// voxel was inserted last. Ordinary non-overlapping scenes use HashInsert.
void HashInsertOrangeScene(uint64_t key, int32_t value, const Voxel* voxels) {
  int32_t slot = HashSlot(key);
  while (g_hash_entries[slot].stamp == g_hash_generation &&
         g_hash_entries[slot].key != key) {
    slot = (slot + 1) & kHashMask;
  }
  const HashEntry& previous = g_hash_entries[slot];
  if (previous.stamp == g_hash_generation &&
      IsOrangeWallRole(voxels[value].role) &&
      !IsOrangeWallRole(voxels[previous.value].role)) return;
  g_hash_entries[slot] = {key, value, g_hash_generation};
}

void ResetStaticHash() {
  ++g_static_hash_generation;
  if (g_static_hash_generation != 0) return;
  for (int32_t index = 0; index < kHashCapacity; ++index) {
    g_static_hash_entries[index].stamp = 0;
  }
  g_static_hash_generation = 1;
}

int32_t StaticHashFind(uint64_t key) {
  int32_t slot = HashSlot(key);
  for (;;) {
    const HashEntry& entry = g_static_hash_entries[slot];
    if (entry.stamp != g_static_hash_generation) return -1;
    if (entry.key == key) return entry.value;
    slot = (slot + 1) & kHashMask;
  }
}

bool StaticHashInsert(uint64_t key, int32_t value) {
  int32_t slot = HashSlot(key);
  while (g_static_hash_entries[slot].stamp == g_static_hash_generation &&
         g_static_hash_entries[slot].key != key) {
    slot = (slot + 1) & kHashMask;
  }
  if (g_static_hash_entries[slot].stamp == g_static_hash_generation) {
    return false;
  }
  g_static_hash_entries[slot] = {key, value, g_static_hash_generation};
  return true;
}

uint64_t SpatialKey(int32_t x, int32_t y, int32_t z, int32_t width) {
  const uint64_t cell = static_cast<uint64_t>(static_cast<uint32_t>(y)) *
                            static_cast<uint64_t>(static_cast<uint32_t>(width)) +
                        static_cast<uint32_t>(x);
  return (static_cast<uint64_t>(static_cast<uint32_t>(z)) << 32u) |
         static_cast<uint32_t>(cell);
}

bool IsPreparedScene(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height) {
  const WorkspaceData& workspace = ActiveWorkspace();
  return workspace.prepared_voxels == voxels &&
      workspace.prepared_count == count &&
      workspace.prepared_width == width &&
      workspace.prepared_height == height &&
      workspace.prepared_dynamic_voxel_count >= 0 &&
      workspace.prepared_dynamic_voxel_count <= count;
}

int32_t MotionVoxelCount(int32_t count) {
  const int32_t motion_count = ActiveWorkspace().motion_voxel_count;
  return motion_count >= 0 && motion_count <= count ? motion_count : count;
}

void BuildSpatialIndex(Voxel* voxels, int32_t count, int32_t width, int32_t height) {
  g_spatial_voxel_count = count;
  ActiveWorkspace().orange_support_voxels = nullptr;
  if (IsPreparedScene(voxels, count, width, height)) {
    ActiveWorkspace().prepared_index_active = true;
    g_linear_spatial = false;
    const int32_t dynamic_count =
        ActiveWorkspace().prepared_dynamic_voxel_count;
    ResetHash();
    ActiveWorkspace().motion_voxel_count = dynamic_count;
    g_dense_columns = ActiveWorkspace().prepared_dense_columns;
    if (g_dense_columns) {
      ++g_dynamic_column_generation;
      if (g_dynamic_column_generation == 0) {
        for (int32_t cell = 0; cell < kDenseColumnCapacity; ++cell) {
          g_dynamic_column_stamps[cell] = 0;
        }
        g_dynamic_column_generation = 1;
      }
    }
    if (!ActiveWorkspace().scene_has_orange_mechanisms) {
      for (int32_t index = 0; index < dynamic_count; ++index) {
        g_next_dynamic_column_voxel[index] = -1;
        const Voxel& voxel = voxels[index];
        if (IsOrdinaryPassThroughVoxel(voxel) ||
            !IsInsideRoom(voxel.x, voxel.y, width, height)) continue;
        if (g_dense_columns) {
          const int32_t cell = voxel.y * width + voxel.x;
          if (g_dynamic_column_stamps[cell] != g_dynamic_column_generation) {
            g_dynamic_column_stamps[cell] = g_dynamic_column_generation;
            g_dynamic_column_heads[cell] = -1;
          }
          g_next_dynamic_column_voxel[index] = g_dynamic_column_heads[cell];
          g_dynamic_column_heads[cell] = index;
        }
        HashInsert(SpatialKey(voxel.x, voxel.y, voxel.z, width), index);
      }
      return;
    }
    for (int32_t index = 0; index < dynamic_count; ++index) {
      g_next_dynamic_column_voxel[index] = -1;
      const Voxel& voxel = voxels[index];
      if (!VoxelBlocksSpace(voxels, count, index) ||
          !IsInsideRoom(voxel.x, voxel.y, width, height)) continue;
      if (g_dense_columns) {
        const int32_t cell = voxel.y * width + voxel.x;
        if (g_dynamic_column_stamps[cell] != g_dynamic_column_generation) {
          g_dynamic_column_stamps[cell] = g_dynamic_column_generation;
          g_dynamic_column_heads[cell] = -1;
        }
        g_next_dynamic_column_voxel[index] = g_dynamic_column_heads[cell];
        g_dynamic_column_heads[cell] = index;
      }
      HashInsertOrangeScene(
          SpatialKey(voxel.x, voxel.y, VoxelPhysicalZ(voxels, count, index), width),
          index, voxels);
    }
    return;
  }
  ActiveWorkspace().prepared_index_active = false;
  ActiveWorkspace().motion_voxel_count = count;
  g_linear_spatial = count <= kLinearSpatialThreshold;
  if (g_linear_spatial) {
    g_dense_columns = false;
    return;
  }
  ResetHash();
  const int64_t cell_count = static_cast<int64_t>(width) * height;
  g_dense_columns = cell_count > 0 && cell_count <= kDenseColumnCapacity;
  if (g_dense_columns) {
    for (int32_t cell = 0; cell < static_cast<int32_t>(cell_count); ++cell) {
      g_column_heads[cell] = -1;
    }
  }
  if (!ActiveWorkspace().scene_has_orange_mechanisms) {
    for (int32_t index = 0; index < count; ++index) {
      g_next_column_voxel[index] = -1;
      const Voxel& voxel = voxels[index];
      if (IsOrdinaryPassThroughVoxel(voxel) ||
          !IsInsideRoom(voxel.x, voxel.y, width, height)) continue;
      if (g_dense_columns) {
        const int32_t cell = voxel.y * width + voxel.x;
        g_next_column_voxel[index] = g_column_heads[cell];
        g_column_heads[cell] = index;
      }
      HashInsert(SpatialKey(voxel.x, voxel.y, voxel.z, width), index);
    }
    return;
  }
  for (int32_t index = 0; index < count; ++index) {
    g_next_column_voxel[index] = -1;
    const Voxel& voxel = voxels[index];
    if (!VoxelBlocksSpace(voxels, count, index) ||
        !IsInsideRoom(voxel.x, voxel.y, width, height)) continue;
    if (g_dense_columns) {
      const int32_t cell = voxel.y * width + voxel.x;
      g_next_column_voxel[index] = g_column_heads[cell];
      g_column_heads[cell] = index;
    }
    HashInsertOrangeScene(
        SpatialKey(voxel.x, voxel.y, VoxelPhysicalZ(voxels, count, index), width),
        index, voxels);
  }
}

int32_t FindVoxelAt(
    Voxel* voxels,
    int32_t x,
    int32_t y,
    int32_t z,
    int32_t width,
    int32_t height) {
  if (!IsInsideRoom(x, y, width, height)) return -1;
  if (g_linear_spatial) {
    int32_t orange_occupant = -1;
    for (int32_t index = 0; index < g_spatial_voxel_count; ++index) {
      if (VoxelBlocksSpace(voxels, g_spatial_voxel_count, index) &&
          voxels[index].x == x && voxels[index].y == y &&
          (IsOrangeWallRole(voxels[index].role)
              ? OrangeWallOccupiesZ(
                    voxels, g_spatial_voxel_count, index, z)
              : voxels[index].z == z)) {
        if (!IsOrangeWallRole(voxels[index].role)) return index;
        orange_occupant = index;
      }
    }
    return orange_occupant;
  }
  const uint64_t key = SpatialKey(x, y, z, width);
  const int32_t dynamic = HashFind(key);
  if (dynamic >= 0) return dynamic;
  const int32_t immutable = ActiveWorkspace().prepared_index_active
      ? StaticHashFind(key)
      : -1;
  if (immutable >= 0) return immutable;
  if (ActiveWorkspace().scene_has_orange_mechanisms) {
    // Hash the column top for the common lookup, then resolve lower cells of
    // an extended supported wall only on a miss. Orange-wall counts are tiny
    // in authored rooms and this keeps the general spatial table compact.
    for (int32_t index = 0; index < g_spatial_voxel_count; ++index) {
      if (IsOrangeWallRole(voxels[index].role) && voxels[index].x == x &&
          voxels[index].y == y && OrangeWallOccupiesZ(
              voxels, g_spatial_voxel_count, index, z)) {
        return index;
      }
    }
  }
  return -1;
}
