#include "voxelbench/search.hpp"

#include <limits.h>

namespace voxelbench {
namespace {

constexpr uint32_t HashRoleLiteral(const char* value, uint32_t hash = 2166136261u) {
  return *value == '\0'
      ? hash
      : HashRoleLiteral(
            value + 1,
            (hash ^ static_cast<uint8_t>(*value)) * 16777619u);
}

constexpr uint32_t kPlayerRole = HashRoleLiteral("player");
constexpr uint32_t kCloneRole = HashRoleLiteral("clone");
constexpr uint32_t kPushableRole = HashRoleLiteral("pushable");
constexpr uint32_t kWeightlessPushableRole =
    HashRoleLiteral("weightless-pushable");
constexpr uint32_t kBlueBoxSlopeUpRole = HashRoleLiteral("blue-box-slope-up");
constexpr uint32_t kBlueBoxSlopeRightRole =
    HashRoleLiteral("blue-box-slope-right");
constexpr uint32_t kBlueBoxSlopeDownRole =
    HashRoleLiteral("blue-box-slope-down");
constexpr uint32_t kBlueBoxSlopeLeftRole =
    HashRoleLiteral("blue-box-slope-left");
constexpr uint32_t kYellowCloneSlopeUpRole =
    HashRoleLiteral("yellow-clone-slope-up");
constexpr uint32_t kYellowCloneSlopeRightRole =
    HashRoleLiteral("yellow-clone-slope-right");
constexpr uint32_t kYellowCloneSlopeDownRole =
    HashRoleLiteral("yellow-clone-slope-down");
constexpr uint32_t kYellowCloneSlopeLeftRole =
    HashRoleLiteral("yellow-clone-slope-left");
constexpr uint32_t kGoalRole = HashRoleLiteral("goal");
constexpr uint32_t kFloorRole = HashRoleLiteral("floor");
constexpr uint32_t kPlayerLiftRole = HashRoleLiteral("player-lift");
constexpr uint32_t kPlayerGateRole = HashRoleLiteral("player-gate");
constexpr uint32_t kPuncherRole = HashRoleLiteral("puncher");
constexpr uint32_t kOrangeButtonRole = HashRoleLiteral("orange-button");
constexpr uint32_t kOrangeWallRole = HashRoleLiteral("orange-wall");
constexpr uint32_t kFloatingFloorRole = HashRoleLiteral("floating-floor");
constexpr int32_t kFilledFloatingFloor = 1;

int32_t SearchOrangeWallDepth(int32_t value) {
  if (value <= -2) {
    return value == INT32_MIN ? INT32_MAX - 1 : -value - 2;
  }
  return value > 0 ? value : 0;
}

int32_t SearchOrangeWallValueForDepth(int32_t current, int32_t depth) {
  if (depth < 0) depth = 0;
  if (current <= -2) {
    const int32_t capped = depth > INT32_MAX - 2 ? INT32_MAX - 2 : depth;
    return -2 - capped;
  }
  return depth;
}
constexpr int32_t kHashCapacity = 262144;
constexpr int32_t kHashMask = kHashCapacity - 1;
constexpr int16_t kInactiveCoordinate = INT16_MIN;
constexpr int32_t kSearchGoalCapacity = 64;
constexpr int32_t kLocalStateCapacity = kSearchVoxelCapacity;
constexpr int32_t kLocalHashCapacity = kLocalStateCapacity * 2;
constexpr int32_t kLocalHashMask = kLocalHashCapacity - 1;

struct SearchNode {
  int16_t (*coordinates)[3];
  uint64_t collected_goals;
  uint64_t lift_states;
  uint32_t parent;
  uint16_t cost;
  // Occupies the two bytes that were padding in the original 40-byte node;
  // orange mechanics must not make every non-orange search node less cacheable.
  uint16_t orange_depth;
  int16_t approach_coordinates[3];
  uint8_t direction;
  // Uses the existing padding byte; settled gates are derived from positions.
  bool authored_gates;
};

struct SearchEdge {
  uint32_t parent;
  int16_t player_coordinates[3];
  uint8_t direction;
};

struct SearchData {
  SearchNode nodes[kSearchNodeCapacity];
  // A search with E moving entities packs node N at N * E. This retains the
  // maximum 64-entity capacity without imposing a 384-byte coordinate stride
  // on the much smaller states used by most evolutionary candidates.
  int16_t node_coordinates[kSearchCoordinateCapacity][3];
  uint64_t hash_keys[kHashCapacity];
  int32_t hash_nodes[kHashCapacity];
  uint32_t hash_stamps[kHashCapacity];
  uint32_t hash_generation;
  Voxel scene[kSearchVoxelCapacity];
  int16_t candidate[kSearchDynamicEntityCapacity][3];
  int32_t base_offsets[kSearchVoxelCapacity][3];
  int16_t voxel_entities[kSearchVoxelCapacity];
  int32_t entity_anchors[kSearchDynamicEntityCapacity];
  uint32_t entity_roles[kSearchDynamicEntityCapacity];
  int32_t entity_generic_ids[kSearchDynamicEntityCapacity];
  int32_t count;
  int32_t dynamic_voxel_count;
  int32_t entity_count;
  int32_t player_index;
  int32_t player_entity;
  int32_t goal_indices[kSearchGoalCapacity];
  int32_t goal_coordinates[kSearchGoalCapacity][3];
  int32_t goal_count;
  uint64_t candidate_collected_goals;
  uint64_t candidate_lift_states;
  uint16_t candidate_orange_depth;
  bool candidate_authored_gates;
  int32_t gate_count;
  int32_t gate_indices[kSearchVoxelCapacity];
  int32_t heap_nodes[kSearchNodeCapacity];
  int32_t heap_positions[kSearchNodeCapacity];
  int32_t heap_size;
  uint8_t closed[kSearchNodeCapacity];
  int16_t local_coordinates[kLocalStateCapacity][3];
  int16_t local_parents[kLocalStateCapacity];
  uint16_t local_distances[kLocalStateCapacity];
  uint8_t local_directions[kLocalStateCapacity];
  uint64_t local_hash_keys[kLocalHashCapacity];
  uint32_t local_hash_stamps[kLocalHashCapacity];
  uint32_t local_hash_generation;
  bool root_is_quiescent;
  int32_t reconstruct_nodes[kSearchSolutionCapacity];
  uint8_t reconstruct_directions[kLocalStateCapacity];
  SearchEdge edges[kSearchEdgeCapacity];
  int32_t edge_count;
  int32_t search_width;
  int32_t search_height;
};

static_assert(sizeof(SearchData) <= kSearchWorkspaceBytes);

SearchData* Data(SearchWorkspace* workspace) {
  return reinterpret_cast<SearchData*>(workspace->storage);
}

uint64_t Mix64(uint64_t value) {
  value ^= value >> 30u;
  value *= 0xbf58476d1ce4e5b9ULL;
  value ^= value >> 27u;
  value *= 0x94d049bb133111ebULL;
  return value ^ (value >> 31u);
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

uint32_t DynamicFamilyRole(uint32_t role) {
  if (IsWeightlessObjectRole(role)) return kWeightlessPushableRole;
  if (IsCloneObjectRole(role)) return kCloneRole;
  return role;
}

bool IsDynamic(uint32_t role) {
  return role == kPlayerRole || IsCloneObjectRole(role) ||
      role == kPushableRole || IsWeightlessObjectRole(role) ||
      role == kPlayerLiftRole || role == kPuncherRole ||
      role == kOrangeButtonRole || role == kFloatingFloorRole;
}

bool SearchGateShouldBeRaised(const SearchData* data, int32_t gate_index) {
  const Voxel& gate = data->scene[gate_index];
  const auto active = [&](const Voxel& voxel) {
    return voxel.x >= 0 && voxel.x < data->search_width &&
        voxel.y >= 0 && voxel.y < data->search_height && voxel.z != INT32_MIN;
  };
  bool same_level_block = false;
  for (int32_t index = 0; index < data->dynamic_voxel_count; ++index) {
    const Voxel& candidate = data->scene[index];
    if (!active(candidate) || (candidate.role != kPushableRole &&
        candidate.role != kFloatingFloorRole &&
        !IsWeightlessObjectRole(candidate.role))) continue;
    same_level_block |= candidate.x == gate.x && candidate.y == gate.y &&
        candidate.z == gate.z;
  }
  for (int32_t index = 0; index < data->dynamic_voxel_count; ++index) {
    const Voxel& actor = data->scene[index];
    if (!active(actor) || (actor.role != kPlayerRole &&
        !IsCloneObjectRole(actor.role))) continue;
    const int64_t delta_x = static_cast<int64_t>(actor.x) - gate.x;
    const int64_t delta_y = static_cast<int64_t>(actor.y) - gate.y;
    const int64_t distance = (delta_x < 0 ? -delta_x : delta_x) +
        (delta_y < 0 ? -delta_y : delta_y);
    const int64_t height = static_cast<int64_t>(actor.z) - gate.z;
    if (distance <= 1 && height >= 0 && height <= 1 &&
        !(distance == 0 && height == 0) &&
        (height != 0 || !same_level_block)) return true;
  }
  return false;
}

void RestoreSearchPlayerGates(SearchData* data, bool authored) {
  for (int32_t i = 0; i < data->gate_count; ++i) {
    const int32_t index = data->gate_indices[i];
    data->scene[index].generic_id = authored
        ? data->base_offsets[index][0]
        : (SearchGateShouldBeRaised(data, index) ? 1 : 0);
  }
}

bool EncodeCoordinate(int32_t value, int16_t* output) {
  if (value == INT32_MIN) {
    *output = kInactiveCoordinate;
    return true;
  }
  if (value <= INT16_MIN || value > INT16_MAX) return false;
  *output = static_cast<int16_t>(value);
  return true;
}

int32_t DecodeCoordinate(int16_t value) {
  return value == kInactiveCoordinate ? INT32_MIN : value;
}

uint64_t HashState(
    const int16_t coordinates[kSearchDynamicEntityCapacity][3],
    int32_t entity_count,
    uint64_t collected_goals,
    uint64_t lift_states,
    uint16_t orange_depth,
    bool authored_gates) {
  uint64_t hash = 0xcbf29ce484222325ULL;
  for (int32_t entity = 0; entity < entity_count; ++entity) {
    for (int32_t axis = 0; axis < 3; ++axis) {
      hash ^= static_cast<uint16_t>(coordinates[entity][axis]);
      hash *= 0x100000001b3ULL;
    }
  }
  hash ^= collected_goals;
  hash *= 0x100000001b3ULL;
  hash ^= lift_states;
  hash *= 0x100000001b3ULL;
  // Preserve the common depth-zero hash path exactly. Equality still compares
  // the field, while active orange states receive a distinct mixed suffix.
  if (orange_depth != 0) {
    hash ^= orange_depth;
    hash *= 0x100000001b3ULL;
  }
  if (authored_gates) {
    hash ^= 0xa17e6a7eULL;
    hash *= 0x100000001b3ULL;
  }
  return Mix64(hash);
}

bool CoordinatesEqual(
    const SearchNode& node,
    const int16_t coordinates[kSearchDynamicEntityCapacity][3],
    int32_t entity_count,
    uint64_t collected_goals,
    uint64_t lift_states,
    uint16_t orange_depth,
    bool authored_gates) {
  if (node.collected_goals != collected_goals ||
      node.lift_states != lift_states ||
      node.orange_depth != orange_depth ||
      node.authored_gates != authored_gates) return false;
  for (int32_t entity = 0; entity < entity_count; ++entity) {
    for (int32_t axis = 0; axis < 3; ++axis) {
      if (node.coordinates[entity][axis] != coordinates[entity][axis]) {
        return false;
      }
    }
  }
  return true;
}

void StartHashGeneration(SearchData* data) {
  ++data->hash_generation;
  if (data->hash_generation != 0) return;
  for (int32_t slot = 0; slot < kHashCapacity; ++slot) {
    data->hash_stamps[slot] = 0;
  }
  data->hash_generation = 1;
}

int32_t FindState(
    SearchData* data,
    uint64_t hash,
    const int16_t coordinates[kSearchDynamicEntityCapacity][3],
    uint64_t collected_goals,
    uint64_t lift_states,
    uint16_t orange_depth,
    bool authored_gates) {
  int32_t slot = static_cast<int32_t>(hash) & kHashMask;
  for (;;) {
    if (data->hash_stamps[slot] != data->hash_generation) return -1;
    const int32_t node = data->hash_nodes[slot];
    if (data->hash_keys[slot] == hash &&
        CoordinatesEqual(
            data->nodes[node],
            coordinates,
            data->entity_count,
            collected_goals,
            lift_states,
            orange_depth,
            authored_gates)) {
      return node;
    }
    slot = (slot + 1) & kHashMask;
  }
}

void InsertState(SearchData* data, uint64_t hash, int32_t node) {
  int32_t slot = static_cast<int32_t>(hash) & kHashMask;
  while (data->hash_stamps[slot] == data->hash_generation) {
    slot = (slot + 1) & kHashMask;
  }
  data->hash_stamps[slot] = data->hash_generation;
  data->hash_keys[slot] = hash;
  data->hash_nodes[slot] = node;
}

void StoreNodeCoordinates(
    SearchNode* node,
    const int16_t coordinates[kSearchDynamicEntityCapacity][3],
    int32_t entity_count,
    uint64_t collected_goals,
    uint64_t lift_states,
    uint16_t orange_depth,
    bool authored_gates) {
  for (int32_t entity = 0; entity < entity_count; ++entity) {
    for (int32_t axis = 0; axis < 3; ++axis) {
      node->coordinates[entity][axis] = coordinates[entity][axis];
    }
  }
  node->collected_goals = collected_goals;
  node->lift_states = lift_states;
  node->orange_depth = orange_depth;
  node->authored_gates = authored_gates;
}

uint64_t LocalCoordinateKey(const int16_t coordinates[3]) {
  return (static_cast<uint64_t>(static_cast<uint16_t>(coordinates[0])) << 32u) |
      (static_cast<uint64_t>(static_cast<uint16_t>(coordinates[1])) << 16u) |
      static_cast<uint16_t>(coordinates[2]);
}

void StartLocalHashGeneration(SearchData* data) {
  ++data->local_hash_generation;
  if (data->local_hash_generation != 0) return;
  for (int32_t slot = 0; slot < kLocalHashCapacity; ++slot) {
    data->local_hash_stamps[slot] = 0;
  }
  data->local_hash_generation = 1;
}

bool InsertLocalStateIfAbsent(
    SearchData* data,
    uint64_t key) {
  int32_t slot = static_cast<int32_t>(Mix64(key)) & kLocalHashMask;
  while (data->local_hash_stamps[slot] == data->local_hash_generation) {
    if (data->local_hash_keys[slot] == key) return false;
    slot = (slot + 1) & kLocalHashMask;
  }
  data->local_hash_stamps[slot] = data->local_hash_generation;
  data->local_hash_keys[slot] = key;
  return true;
}

bool HeapLess(const SearchData* data, int32_t left, int32_t right) {
  return data->nodes[left].cost < data->nodes[right].cost;
}

void HeapSwap(SearchData* data, int32_t left, int32_t right) {
  const int32_t temporary = data->heap_nodes[left];
  data->heap_nodes[left] = data->heap_nodes[right];
  data->heap_nodes[right] = temporary;
  data->heap_positions[data->heap_nodes[left]] = left;
  data->heap_positions[data->heap_nodes[right]] = right;
}

void HeapRaise(SearchData* data, int32_t position) {
  while (position > 0) {
    const int32_t parent = (position - 1) / 2;
    if (!HeapLess(
            data, data->heap_nodes[position], data->heap_nodes[parent])) break;
    HeapSwap(data, position, parent);
    position = parent;
  }
}

void HeapPush(SearchData* data, int32_t node) {
  const int32_t position = data->heap_size++;
  data->heap_nodes[position] = node;
  data->heap_positions[node] = position;
  HeapRaise(data, position);
}

int32_t HeapPop(SearchData* data) {
  const int32_t result = data->heap_nodes[0];
  --data->heap_size;
  data->heap_positions[result] = -1;
  if (data->heap_size <= 0) return result;
  data->heap_nodes[0] = data->heap_nodes[data->heap_size];
  data->heap_positions[data->heap_nodes[0]] = 0;
  int32_t position = 0;
  for (;;) {
    const int32_t left = position * 2 + 1;
    if (left >= data->heap_size) break;
    const int32_t right = left + 1;
    const int32_t child = right < data->heap_size && HeapLess(
        data, data->heap_nodes[right], data->heap_nodes[left]) ? right : left;
    if (!HeapLess(data, data->heap_nodes[child], data->heap_nodes[position])) break;
    HeapSwap(data, position, child);
    position = child;
  }
  return result;
}

void HeapDecrease(SearchData* data, int32_t node) {
  const int32_t position = data->heap_positions[node];
  if (position >= 0) HeapRaise(data, position);
}

void LoadNode(SearchData* data, const SearchNode& node) {
  for (int32_t dynamic = 0; dynamic < data->dynamic_voxel_count; ++dynamic) {
    const int32_t entity = data->voxel_entities[dynamic];
    if (entity < 0) {
      if (data->scene[dynamic].role == kOrangeWallRole) {
        data->scene[dynamic].generic_id = SearchOrangeWallValueForDepth(
            data->scene[dynamic].generic_id, node.orange_depth);
      }
      continue;
    }
    const int32_t anchor_x = DecodeCoordinate(node.coordinates[entity][0]);
    if (anchor_x < 0) {
      data->scene[dynamic].x = -1;
      continue;
    }
    data->scene[dynamic].x = anchor_x + data->base_offsets[dynamic][0];
    data->scene[dynamic].y =
        DecodeCoordinate(node.coordinates[entity][1]) +
        data->base_offsets[dynamic][1];
    data->scene[dynamic].z =
        DecodeCoordinate(node.coordinates[entity][2]) +
        data->base_offsets[dynamic][2];
    if (data->entity_roles[entity] == kFloatingFloorRole) {
      const bool filled =
          (node.lift_states & (uint64_t{1} << entity)) != 0;
      data->scene[dynamic].role = filled
          ? kFloorRole
          : kFloatingFloorRole;
      data->scene[dynamic].generic_id = filled
          ? kFilledFloatingFloor
          : data->entity_generic_ids[entity];
    } else if (data->scene[dynamic].role == kPlayerLiftRole ||
               data->scene[dynamic].role == kPuncherRole) {
      // Both fixtures encode orientation plus one mutable state bit. Restore
      // it from this node so sibling simulations cannot share mechanism state.
      const int32_t authored_id = data->entity_generic_ids[entity];
      const int32_t orientation_base = authored_id >= 0
          ? authored_id - authored_id % 2
          : 0;
      data->scene[dynamic].generic_id =
          orientation_base +
          ((node.lift_states & (uint64_t{1} << entity)) != 0 ? 1 : 0);
    } else if (data->scene[dynamic].role == kOrangeButtonRole) {
      const int32_t authored_id = data->entity_generic_ids[entity];
      data->scene[dynamic].generic_id = authored_id >= 0
          ? authored_id - authored_id % 2
          : 0;
    }
  }
  for (int32_t goal = 0; goal < data->goal_count; ++goal) {
    Voxel& voxel = data->scene[data->goal_indices[goal]];
    voxel.x = (node.collected_goals & (uint64_t{1} << goal)) != 0
        ? -1
        : data->goal_coordinates[goal][0];
    voxel.y = data->goal_coordinates[goal][1];
    voxel.z = data->goal_coordinates[goal][2];
  }
}

bool CaptureCandidate(SearchData* data) {
  data->candidate_lift_states = 0;
  data->candidate_orange_depth = 0;
  data->candidate_authored_gates = false;
  for (int32_t i = 0; i < data->gate_count; ++i) {
    const int32_t index = data->gate_indices[i];
    if (data->scene[index].generic_id !=
        (SearchGateShouldBeRaised(data, index) ? 1 : 0)) {
      data->candidate_authored_gates = true;
    }
  }
  // Completed commands settle all gates; only an authored root (or its cycle
  // rollback) can retain a non-equilibrium gate state. Keep that state exact
  // without charging every fixed gate against the moving-entity limit.
  if (data->candidate_authored_gates) {
    for (int32_t i = 0; i < data->gate_count; ++i) {
      const int32_t index = data->gate_indices[i];
      if (data->scene[index].generic_id != data->base_offsets[index][0]) return false;
    }
  }
  for (int32_t entity = 0; entity < data->entity_count; ++entity) {
    const Voxel& anchor = data->scene[data->entity_anchors[entity]];
    if ((anchor.role == kPlayerLiftRole || anchor.role == kPuncherRole) &&
        anchor.generic_id >= 0 &&
        anchor.generic_id % 2 != 0) {
      data->candidate_lift_states |= uint64_t{1} << entity;
    }
    if (data->entity_roles[entity] == kFloatingFloorRole &&
        anchor.role == kFloorRole &&
        anchor.generic_id == kFilledFloatingFloor) {
      data->candidate_lift_states |= uint64_t{1} << entity;
    }
    const int32_t x = anchor.x < 0 ? -1 : anchor.x;
    const int32_t y = anchor.x < 0 ? 0 : anchor.y;
    const int32_t z = anchor.x < 0 ? 0 : anchor.z;
    if (!EncodeCoordinate(x, &data->candidate[entity][0]) ||
        !EncodeCoordinate(y, &data->candidate[entity][1]) ||
        !EncodeCoordinate(z, &data->candidate[entity][2])) {
      return false;
    }
  }
  for (int32_t index = 0; index < data->dynamic_voxel_count; ++index) {
    if (data->scene[index].role == kOrangeWallRole) {
      data->candidate_orange_depth = static_cast<uint16_t>(
          SearchOrangeWallDepth(data->scene[index].generic_id) > UINT16_MAX
                ? UINT16_MAX
                : SearchOrangeWallDepth(data->scene[index].generic_id));
      break;
    }
  }
  data->candidate_collected_goals = 0;
  for (int32_t goal = 0; goal < data->goal_count; ++goal) {
    if (data->scene[data->goal_indices[goal]].x < 0) {
      data->candidate_collected_goals |= uint64_t{1} << goal;
    }
  }
  return true;
}

bool CapturePassivePlayer(
    SearchData* data,
    int16_t coordinates[3],
    uint64_t* collected_goals) {
  const Voxel& player = data->scene[data->player_index];
  if (!EncodeCoordinate(player.x < 0 ? -1 : player.x, &coordinates[0]) ||
      !EncodeCoordinate(player.x < 0 ? 0 : player.y, &coordinates[1]) ||
      !EncodeCoordinate(player.x < 0 ? 0 : player.z, &coordinates[2])) {
    return false;
  }
  *collected_goals = 0;
  for (int32_t goal = 0; goal < data->goal_count; ++goal) {
    if (data->scene[data->goal_indices[goal]].x < 0) {
      *collected_goals |= uint64_t{1} << goal;
    }
  }
  return true;
}

void BuildPassiveCandidate(
    SearchData* data,
    const SearchNode& parent,
    const int16_t player_coordinates[3],
    uint64_t collected_goals) {
  for (int32_t entity = 0; entity < data->entity_count; ++entity) {
    for (int32_t axis = 0; axis < 3; ++axis) {
      data->candidate[entity][axis] = parent.coordinates[entity][axis];
    }
  }
  data->candidate[data->player_entity][0] = player_coordinates[0];
  data->candidate[data->player_entity][1] = player_coordinates[1];
  data->candidate[data->player_entity][2] = player_coordinates[2];
  data->candidate_collected_goals = collected_goals;
  data->candidate_lift_states = parent.lift_states;
  data->candidate_orange_depth = parent.orange_depth;
  data->candidate_authored_gates = parent.authored_gates;
}

bool CandidatePlayerIsActive(
    const SearchData* data,
    int32_t width,
    int32_t height) {
  if (data->player_entity < 0) return false;
  const int32_t x = DecodeCoordinate(data->candidate[data->player_entity][0]);
  const int32_t y = DecodeCoordinate(data->candidate[data->player_entity][1]);
  return x >= 0 && x < width && y >= 0 && y < height;
}

bool IsGoal(const SearchData* data) {
  if (data->goal_count <= 0) return false;
  const uint64_t all_goals = data->goal_count == kSearchGoalCapacity
      ? UINT64_MAX
      : (uint64_t{1} << data->goal_count) - 1;
  return data->candidate_collected_goals == all_goals;
}

bool NodeIsGoal(const SearchData* data, const SearchNode& node) {
  if (data->goal_count <= 0) return false;
  const uint64_t all_goals = data->goal_count == kSearchGoalCapacity
      ? UINT64_MAX
      : (uint64_t{1} << data->goal_count) - 1;
  return node.collected_goals == all_goals;
}

SearchResult InvalidResult() {
  SearchResult result{};
  result.status = SearchStatus::kInvalid;
  return result;
}

bool SceneIsSettled(const SearchData* data, int32_t width, int32_t height) {
  for (int32_t entity = 0; entity < data->entity_count; ++entity) {
    if (data->entity_roles[entity] == kFloatingFloorRole) {
      const Voxel& anchor = data->scene[data->entity_anchors[entity]];
      if (anchor.role == kFloorRole &&
          anchor.generic_id == kFilledFloatingFloor) {
        continue;
      }
    }
    bool supported = false;
    for (int32_t member = 0;
         member < data->dynamic_voxel_count && !supported; ++member) {
      if (data->voxel_entities[member] != entity) continue;
      const Voxel& voxel = data->scene[member];
      if (voxel.x < 0 || voxel.x >= width || voxel.y < 0 || voxel.y >= height) {
        continue;
      }
      for (int32_t other = 0; other < data->count; ++other) {
        if (data->scene[other].role == kGoalRole ||
            (other < data->dynamic_voxel_count &&
             data->voxel_entities[other] == entity)) {
          continue;
        }
        if (data->scene[other].x == voxel.x &&
            data->scene[other].y == voxel.y &&
            data->scene[other].z == voxel.z - 1) {
          supported = true;
          break;
        }
      }
    }
    if (!supported) return false;
  }
  return true;
}

bool DynamicObjectsChangedExceptPlayer(
    const SearchData* data,
    const SearchNode& parent) {
  if (data->candidate_authored_gates != parent.authored_gates) return true;
  if (data->candidate_lift_states != parent.lift_states) return true;
  if (data->candidate_orange_depth != parent.orange_depth) return true;
  for (int32_t entity = 0; entity < data->entity_count; ++entity) {
    if (entity == data->player_entity) continue;
    for (int32_t axis = 0; axis < 3; ++axis) {
      if (data->candidate[entity][axis] != parent.coordinates[entity][axis]) {
        return true;
      }
    }
  }
  return false;
}

bool AddGeneralNode(
    SearchData* data,
    int32_t parent,
    uint16_t cost,
    const int16_t approach[3],
    uint8_t direction,
    int32_t maximum_nodes,
    int32_t* node_count,
    bool* limit_reached,
    int32_t* generated,
    int32_t* transpositions) {
  ++*generated;
  const uint64_t hash = HashState(
      data->candidate,
      data->entity_count,
      data->candidate_collected_goals,
      data->candidate_lift_states,
      data->candidate_orange_depth,
      data->candidate_authored_gates);
  const int32_t existing = FindState(
      data,
      hash,
      data->candidate,
      data->candidate_collected_goals,
      data->candidate_lift_states,
      data->candidate_orange_depth,
      data->candidate_authored_gates);
  if (existing >= 0) {
    ++*transpositions;
    SearchNode& node = data->nodes[existing];
    if (cost < node.cost && data->closed[existing] == 0) {
      node.parent = static_cast<uint32_t>(parent);
      node.cost = cost;
      node.approach_coordinates[0] = approach[0];
      node.approach_coordinates[1] = approach[1];
      node.approach_coordinates[2] = approach[2];
      node.direction = direction;
      HeapDecrease(data, existing);
    }
    return false;
  }
  if (*node_count >= maximum_nodes) {
    *limit_reached = true;
    return false;
  }
  const int32_t index = (*node_count)++;
  SearchNode& child = data->nodes[index];
  child.coordinates = data->node_coordinates + index * data->entity_count;
  StoreNodeCoordinates(
      &child,
      data->candidate,
      data->entity_count,
      data->candidate_collected_goals,
      data->candidate_lift_states,
      data->candidate_orange_depth,
      data->candidate_authored_gates);
  child.parent = static_cast<uint32_t>(parent);
  child.cost = cost;
  child.approach_coordinates[0] = approach[0];
  child.approach_coordinates[1] = approach[1];
  child.approach_coordinates[2] = approach[2];
  child.direction = direction;
  data->closed[index] = 0;
  data->heap_positions[index] = -1;
  InsertState(data, hash, index);
  HeapPush(data, index);
  return true;
}

int32_t BeginLocalSearch(SearchData* data, const SearchNode& parent) {
  StartLocalHashGeneration(data);
  for (int32_t axis = 0; axis < 3; ++axis) {
    data->local_coordinates[0][axis] =
        parent.coordinates[data->player_entity][axis];
  }
  data->local_parents[0] = -1;
  data->local_distances[0] = 0;
  data->local_directions[0] = 0;
  InsertLocalStateIfAbsent(
      data, LocalCoordinateKey(data->local_coordinates[0]));
  return 1;
}

bool CandidateIsPurePlayerMove(
    const SearchData* data,
    const SearchNode& parent) {
  return data->candidate_collected_goals == parent.collected_goals &&
      !DynamicObjectsChangedExceptPlayer(data, parent);
}

bool LoadLocalCommandSource(
    SearchData* data,
    const SearchNode& parent,
    int32_t local_state) {
  LoadNode(data, parent);
  Voxel& player = data->scene[data->player_index];
  player.x = DecodeCoordinate(data->local_coordinates[local_state][0]);
  player.y = DecodeCoordinate(data->local_coordinates[local_state][1]);
  player.z = DecodeCoordinate(data->local_coordinates[local_state][2]);
  // Derive settled gates only after restoring this local player coordinate.
  RestoreSearchPlayerGates(data, parent.authored_gates);
  return player.x >= 0;
}

bool RestorePassiveLocalCommandSource(
    SearchData* data,
    const SearchNode& parent,
    int32_t local_state) {
  Voxel& player = data->scene[data->player_index];
  player.x = DecodeCoordinate(data->local_coordinates[local_state][0]);
  player.y = DecodeCoordinate(data->local_coordinates[local_state][1]);
  player.z = DecodeCoordinate(data->local_coordinates[local_state][2]);
  for (int32_t goal = 0; goal < data->goal_count; ++goal) {
    Voxel& voxel = data->scene[data->goal_indices[goal]];
    voxel.x = (parent.collected_goals & (uint64_t{1} << goal)) != 0
        ? -1
        : data->goal_coordinates[goal][0];
    // Passive collection changes only x; y/z were restored with the parent
    // snapshot and remain invariant throughout this local reachability pass.
  }
  return player.x >= 0;
}

int32_t SimulateSearchTurn(
    SearchData* data,
    PhysicsWorkspace* physics_workspace,
    const SearchNode& parent,
    int32_t local_state,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction,
    bool* passive_snapshot_valid) {
  const bool quiescent = &parent != &data->nodes[0] ||
      data->root_is_quiescent || local_state > 0;
  if (!quiescent) {
    *passive_snapshot_valid = false;
    if (!LoadLocalCommandSource(data, parent, local_state)) return -2;
    return simulate_turn(
        physics_workspace, data->scene, count, width, height, direction);
  }
  if (!*passive_snapshot_valid) {
    if (!LoadLocalCommandSource(data, parent, local_state) ||
        !prepare_quiescent_snapshot(
            physics_workspace, data->scene, count, width, height)) {
      return -1;
    }
    *passive_snapshot_valid = true;
  } else if (!RestorePassiveLocalCommandSource(data, parent, local_state)) {
    return -2;
  }
  const int32_t passive = try_simulate_passive_quiescent_turn(
      physics_workspace,
      data->scene,
      count,
      width,
      height,
      direction);
  if (passive > 0) return 1;
  if (passive < 0) return passive;

  // A passive decline is transactional: it has not written player/body/goal
  // coordinates. The scene therefore already is the requested local source;
  // avoid reloading every voxel before the full general kernel takes over.
  *passive_snapshot_valid = false;
  return simulate_quiescent_turn(
      physics_workspace,
      data->scene,
      count,
      width,
      height,
      direction,
      true);
}

bool AppendGeneralLocalPath(
    SearchData* data,
    PhysicsWorkspace* physics_workspace,
    const SearchNode& parent,
    const int16_t target[3],
    int32_t count,
    int32_t width,
    int32_t height,
    SearchResult* result) {
  int32_t local_count = BeginLocalSearch(data, parent);
  const uint64_t target_key = LocalCoordinateKey(target);
  int32_t target_state = LocalCoordinateKey(data->local_coordinates[0]) ==
          target_key
      ? 0
      : -1;
  bool passive_snapshot_valid = false;
  for (int32_t head = 0; head < local_count && target_state < 0; ++head) {
    ++result->local_expanded;
    const uint64_t source_key =
        LocalCoordinateKey(data->local_coordinates[head]);
    for (int32_t direction = 0; direction < 4; ++direction) {
      ++result->command_transitions;
      const int32_t simulation = SimulateSearchTurn(
              data,
              physics_workspace,
              parent,
              head,
              count,
              width,
              height,
              direction,
              &passive_snapshot_valid);
      if (simulation == 0) ++result->full_physics_transitions;
      int16_t coordinates[3];
      uint64_t collected_goals = 0;
      if (simulation < 0 ||
          (simulation > 0 && !CapturePassivePlayer(
              data, coordinates, &collected_goals)) ||
          (simulation == 0 &&
           (!CaptureCandidate(data) ||
            !CandidatePlayerIsActive(data, width, height) ||
            !CandidateIsPurePlayerMove(data, parent)))) {
        continue;
      }
      if (simulation > 0) {
        if (DecodeCoordinate(coordinates[0]) < 0 ||
            DecodeCoordinate(coordinates[0]) >= width ||
            DecodeCoordinate(coordinates[1]) < 0 ||
            DecodeCoordinate(coordinates[1]) >= height ||
            collected_goals != parent.collected_goals) {
          continue;
        }
      } else {
        for (int32_t axis = 0; axis < 3; ++axis) {
          coordinates[axis] = data->candidate[data->player_entity][axis];
        }
      }
      const uint64_t key = LocalCoordinateKey(coordinates);
      if (key == source_key) continue;
      if (!InsertLocalStateIfAbsent(data, key)) continue;
      if (local_count >= kLocalStateCapacity) return false;
      const int32_t next = local_count++;
      for (int32_t axis = 0; axis < 3; ++axis) {
        data->local_coordinates[next][axis] = coordinates[axis];
      }
      data->local_parents[next] = static_cast<int16_t>(head);
      data->local_distances[next] = static_cast<uint16_t>(
          data->local_distances[head] + 1);
      data->local_directions[next] = static_cast<uint8_t>(direction);
      if (key == target_key) {
        target_state = next;
        break;
      }
    }
  }
  if (target_state < 0) return false;
  int32_t path_length = 0;
  for (int32_t cursor = target_state; data->local_parents[cursor] >= 0;
       cursor = data->local_parents[cursor]) {
    if (path_length >= kLocalStateCapacity) return false;
    data->reconstruct_directions[path_length++] = data->local_directions[cursor];
  }
  if (result->solution_length + path_length > kSearchSolutionCapacity) {
    return false;
  }
  while (path_length > 0) {
    result->solution[result->solution_length++] =
        data->reconstruct_directions[--path_length];
  }
  return true;
}

bool ReconstructGeneralSolution(
    SearchData* data,
    PhysicsWorkspace* physics_workspace,
    int32_t node,
    int32_t count,
    int32_t width,
    int32_t height,
    SearchResult* result) {
  int32_t edge_count = 0;
  for (int32_t cursor = node; cursor != 0;
       cursor = static_cast<int32_t>(data->nodes[cursor].parent)) {
    if (edge_count >= kSearchSolutionCapacity) return false;
    data->reconstruct_nodes[edge_count++] = cursor;
  }
  result->solution_length = 0;
  while (edge_count > 0) {
    const int32_t child_index = data->reconstruct_nodes[--edge_count];
    const SearchNode& child = data->nodes[child_index];
    const SearchNode& parent = data->nodes[child.parent];
    if (!AppendGeneralLocalPath(
            data,
            physics_workspace,
            parent,
            child.approach_coordinates,
            count,
            width,
            height,
            result)) {
      return false;
    }
    if (result->solution_length >= kSearchSolutionCapacity) return false;
    result->solution[result->solution_length++] = child.direction;
  }
  result->moves = result->solution_length;
  return result->moves == data->nodes[node].cost;
}

void RecordBoundaryEdges(
    SearchData* data,
    int32_t parent,
    const int16_t player_coordinates[3],
    int32_t width,
    int32_t height,
    bool* limit_reached) {
  const int32_t x = DecodeCoordinate(player_coordinates[0]);
  const int32_t y = DecodeCoordinate(player_coordinates[1]);
  const bool boundary[4] = {
      y == 0,
      x == width - 1,
      y == height - 1,
      x == 0,
  };
  for (int32_t direction = 0; direction < 4; ++direction) {
    if (!boundary[direction]) continue;
    if (data->edge_count >= kSearchEdgeCapacity) {
      *limit_reached = true;
      continue;
    }
    SearchEdge& edge = data->edges[data->edge_count++];
    edge.parent = static_cast<uint32_t>(parent);
    edge.player_coordinates[0] = player_coordinates[0];
    edge.player_coordinates[1] = player_coordinates[1];
    edge.player_coordinates[2] = player_coordinates[2];
    edge.direction = static_cast<uint8_t>(direction);
  }
}

SearchResult SearchGeneralized(
    SearchData* data,
    PhysicsWorkspace* physics_workspace,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t maximum_nodes,
    int32_t node_count,
    bool collect_edges) {
  SearchResult result{};
  data->heap_size = 0;
  data->heap_positions[0] = -1;
  data->closed[0] = 0;
  HeapPush(data, 0);
  bool limit_reached = false;
  while (data->heap_size > 0) {
    const int32_t head = HeapPop(data);
    if (data->closed[head] != 0) continue;
    data->closed[head] = 1;
    const SearchNode& parent = data->nodes[head];
    if (!collect_edges && NodeIsGoal(data, parent)) {
      result.status = limit_reached
          ? SearchStatus::kSolvedUnproven
          : SearchStatus::kSolved;
      if (!ReconstructGeneralSolution(
              data,
              physics_workspace,
              head,
              count,
              width,
              height,
              &result)) {
        return InvalidResult();
      }
      return result;
    }
    if (parent.cost >= kSearchSolutionCapacity) continue;
    ++result.expanded;
    int32_t local_count = BeginLocalSearch(data, parent);
    bool passive_snapshot_valid = false;
    for (int32_t local_head = 0; local_head < local_count; ++local_head) {
      ++result.local_expanded;
      if (collect_edges && static_cast<uint32_t>(parent.cost) +
              data->local_distances[local_head] < kSearchSolutionCapacity) {
        RecordBoundaryEdges(
            data,
            head,
            data->local_coordinates[local_head],
            width,
            height,
            &limit_reached);
      }
      const uint64_t source_key =
          LocalCoordinateKey(data->local_coordinates[local_head]);
      for (int32_t direction = 0; direction < 4; ++direction) {
        ++result.command_transitions;
        const int32_t simulation = SimulateSearchTurn(
                data,
                physics_workspace,
                parent,
                local_head,
                count,
                width,
                height,
                direction,
                &passive_snapshot_valid);
        if (simulation == 0) ++result.full_physics_transitions;
        int16_t player_coordinates[3];
        uint64_t collected_goals = 0;
        if (simulation < 0 ||
            (simulation > 0 && !CapturePassivePlayer(
                data, player_coordinates, &collected_goals)) ||
            (simulation == 0 &&
             (!CaptureCandidate(data) ||
              !CandidatePlayerIsActive(data, width, height)))) {
          continue;
        }
        if (simulation > 0) {
          const int32_t player_x = DecodeCoordinate(player_coordinates[0]);
          const int32_t player_y = DecodeCoordinate(player_coordinates[1]);
          if (player_x < 0 || player_x >= width ||
              player_y < 0 || player_y >= height) {
            continue;
          }
        } else {
          for (int32_t axis = 0; axis < 3; ++axis) {
            player_coordinates[axis] =
                data->candidate[data->player_entity][axis];
          }
          collected_goals = data->candidate_collected_goals;
        }
        const bool pure_player = simulation > 0
            ? collected_goals == parent.collected_goals
            : CandidateIsPurePlayerMove(data, parent);
        if (pure_player) {
          const uint64_t key = LocalCoordinateKey(player_coordinates);
          if (key == source_key) {
            continue;
          }
          if (!InsertLocalStateIfAbsent(data, key)) continue;
          if (local_count >= kLocalStateCapacity) {
            limit_reached = true;
            continue;
          }
          const int32_t next = local_count++;
          for (int32_t axis = 0; axis < 3; ++axis) {
            data->local_coordinates[next][axis] = player_coordinates[axis];
          }
          data->local_parents[next] = static_cast<int16_t>(local_head);
          data->local_distances[next] = static_cast<uint16_t>(
              data->local_distances[local_head] + 1);
          data->local_directions[next] = static_cast<uint8_t>(direction);
          continue;
        }
        if (simulation > 0) {
          BuildPassiveCandidate(
              data, parent, player_coordinates, collected_goals);
        }
        const uint32_t edge_cost =
            static_cast<uint32_t>(data->local_distances[local_head]) + 1;
        if (static_cast<uint32_t>(parent.cost) + edge_cost >=
            kSearchSolutionCapacity) {
          continue;
        }
        AddGeneralNode(
            data,
            head,
            static_cast<uint16_t>(parent.cost + edge_cost),
            data->local_coordinates[local_head],
            static_cast<uint8_t>(direction),
            maximum_nodes,
            &node_count,
            &limit_reached,
            &result.generated,
            &result.transpositions);
      }
    }
  }
  result.status = limit_reached
      ? SearchStatus::kLimitHit
      : (collect_edges ? SearchStatus::kSolved : SearchStatus::kUnsolved);
  return result;
}

bool InitializeSearch(
    SearchWorkspace* search_workspace,
    PhysicsWorkspace* physics_workspace,
    const Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t* maximum_nodes,
    bool require_goals) {
  if (search_workspace == nullptr || physics_workspace == nullptr ||
      voxels == nullptr || count <= 0 || count > kSearchVoxelCapacity ||
      width <= 0 || height <= 0 || maximum_nodes == nullptr ||
      *maximum_nodes <= 0) {
    return false;
  }
  if (*maximum_nodes > kSearchNodeCapacity) {
    *maximum_nodes = kSearchNodeCapacity;
  }
  // Search stores one room-wide orange depth. Transient connected-world
  // scopes belong to command simulation and cannot be collapsed into it.
  for (int32_t index = 0; index < count; ++index) {
    if ((voxels[index].role == kOrangeButtonRole || voxels[index].role == kOrangeWallRole) &&
        voxels[index].generic_id >= 0 && (voxels[index].generic_id & kOrangeScopedIdFlag) != 0) {
      return false;
    }
  }

  SearchData* data = Data(search_workspace);
  if (!search_workspace->initialized) {
    for (int32_t slot = 0; slot < kHashCapacity; ++slot) {
      data->hash_stamps[slot] = 0;
    }
    for (int32_t slot = 0; slot < kLocalHashCapacity; ++slot) {
      data->local_hash_stamps[slot] = 0;
    }
    data->hash_generation = 0;
    data->local_hash_generation = 0;
    search_workspace->initialized = true;
  }
  data->count = count;
  data->search_width = width;
  data->search_height = height;
  data->edge_count = 0;
  data->dynamic_voxel_count = 0;
  data->entity_count = 0;
  data->player_index = -1;
  data->player_entity = -1;
  data->goal_count = 0;
  data->gate_count = 0;
  int32_t static_count = 0;

  // Dynamic entities first enables the physics engine's compact hot paths.
  for (int32_t source = 0; source < count; ++source) {
    if (!IsDynamic(voxels[source].role)) continue;
    const int32_t target = data->dynamic_voxel_count++;
    data->scene[target] = voxels[source];
    int32_t entity = -1;
    const uint32_t family_role = DynamicFamilyRole(voxels[source].role);
    if (IsWeightlessObjectRole(voxels[source].role) ||
        IsCloneObjectRole(voxels[source].role) ||
        voxels[source].role == kPlayerRole) {
      for (int32_t candidate = 0; candidate < data->entity_count; ++candidate) {
        if (data->entity_roles[candidate] == family_role &&
            data->entity_generic_ids[candidate] == voxels[source].generic_id) {
          entity = candidate;
          break;
        }
      }
    }
    if (entity < 0) {
      if (data->entity_count >= kSearchDynamicEntityCapacity) return false;
      entity = data->entity_count++;
      data->entity_anchors[entity] = target;
      data->entity_roles[entity] = family_role;
      data->entity_generic_ids[entity] = voxels[source].generic_id;
    }
    data->voxel_entities[target] = static_cast<int16_t>(entity);
    const Voxel& anchor = data->scene[data->entity_anchors[entity]];
    data->base_offsets[target][0] = voxels[source].x - anchor.x;
    data->base_offsets[target][1] = voxels[source].y - anchor.y;
    data->base_offsets[target][2] = voxels[source].z - anchor.z;
    if (voxels[source].role == kPlayerRole && data->player_index < 0) {
      data->player_index = target;
      data->player_entity = entity;
    }
  }
  // Orange-wall anchors and player gates never translate, but their mechanism
  // values are mutable. Keep them in physics' rebuilt prefix without spending
  // a search coordinate entity for each fixed fixture.
  for (int32_t source = 0; source < count; ++source) {
    if (voxels[source].role != kOrangeWallRole &&
        voxels[source].role != kPlayerGateRole) continue;
    const int32_t target = data->dynamic_voxel_count++;
    data->scene[target] = voxels[source];
    data->voxel_entities[target] = -1;
    if (voxels[source].role == kPlayerGateRole) {
      data->gate_indices[data->gate_count++] = target;
      data->base_offsets[target][0] = voxels[source].generic_id;
    }
  }
  static_count = data->dynamic_voxel_count;
  for (int32_t source = 0; source < count; ++source) {
    if (IsDynamic(voxels[source].role) ||
        voxels[source].role == kOrangeWallRole ||
        voxels[source].role == kPlayerGateRole) continue;
    const int32_t target = static_count++;
    data->scene[target] = voxels[source];
    if (voxels[source].role == kGoalRole) {
      if (data->goal_count >= kSearchGoalCapacity) return false;
      const int32_t goal = data->goal_count++;
      data->goal_indices[goal] = target;
      data->goal_coordinates[goal][0] = voxels[source].x;
      data->goal_coordinates[goal][1] = voxels[source].y;
      data->goal_coordinates[goal][2] = voxels[source].z;
    }
  }
  if (data->player_index < 0 || data->entity_count <= 0 ||
      (require_goals && data->goal_count <= 0)) {
    return false;
  }
  const int32_t coordinate_limited_nodes =
      kSearchCoordinateCapacity / data->entity_count;
  if (*maximum_nodes > coordinate_limited_nodes) {
    *maximum_nodes = coordinate_limited_nodes;
  }
  if (!prepare_scene(
          physics_workspace,
          data->scene,
          count,
          width,
          height,
          data->dynamic_voxel_count)) {
    return false;
  }
  data->root_is_quiescent = SceneIsSettled(data, width, height);
  if (!CaptureCandidate(data) ||
      !CandidatePlayerIsActive(data, width, height)) return false;
  SearchNode& root = data->nodes[0];
  root.coordinates = data->node_coordinates;
  StoreNodeCoordinates(
      &root,
      data->candidate,
      data->entity_count,
      data->candidate_collected_goals,
      data->candidate_lift_states,
      data->candidate_orange_depth,
      data->candidate_authored_gates);
  root.parent = 0;
  root.cost = 0;
  root.approach_coordinates[0] = root.coordinates[data->player_entity][0];
  root.approach_coordinates[1] = root.coordinates[data->player_entity][1];
  root.approach_coordinates[2] = root.coordinates[data->player_entity][2];
  root.direction = 0;
  StartHashGeneration(data);
  InsertState(data, HashState(
      root.coordinates,
      data->entity_count,
      root.collected_goals,
      root.lift_states,
      root.orange_depth,
      root.authored_gates), 0);
  return true;
}

}  // namespace

SearchResult search_shortest(
    SearchWorkspace* search_workspace,
    PhysicsWorkspace* physics_workspace,
    const Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t maximum_nodes) {
  if (!InitializeSearch(
          search_workspace,
          physics_workspace,
          voxels,
          count,
          width,
          height,
          &maximum_nodes,
          true)) return InvalidResult();

  SearchData* data = Data(search_workspace);
  SearchResult result{};
  if (IsGoal(data)) {
    result.status = SearchStatus::kSolved;
    return result;
  }
  return SearchGeneralized(
      data,
      physics_workspace,
      count,
      width,
      height,
      maximum_nodes,
      1,
      false);
}

EdgeSearchResult search_reachable_edges(
    SearchWorkspace* search_workspace,
    PhysicsWorkspace* physics_workspace,
    const Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t maximum_nodes) {
  EdgeSearchResult result{};
  if (!InitializeSearch(
          search_workspace,
          physics_workspace,
          voxels,
          count,
          width,
          height,
          &maximum_nodes,
          false)) {
    result.status = SearchStatus::kInvalid;
    return result;
  }
  SearchData* data = Data(search_workspace);
  const SearchResult search = SearchGeneralized(
      data,
      physics_workspace,
      count,
      width,
      height,
      maximum_nodes,
      1,
      true);
  result.status = search.status;
  result.edges = data->edge_count;
  result.expanded = search.expanded;
  result.generated = search.generated;
  result.transpositions = search.transpositions;
  result.local_expanded = search.local_expanded;
  result.command_transitions = search.command_transitions;
  result.full_physics_transitions = search.full_physics_transitions;
  return result;
}

SearchResult search_edge_solution(
    SearchWorkspace* search_workspace,
    PhysicsWorkspace* physics_workspace,
    int32_t edge_index,
    int32_t count,
    int32_t width,
    int32_t height) {
  if (search_workspace == nullptr || physics_workspace == nullptr ||
      !search_workspace->initialized) return InvalidResult();
  SearchData* data = Data(search_workspace);
  if (edge_index < 0 || edge_index >= data->edge_count ||
      count != data->count || width != data->search_width ||
      height != data->search_height) return InvalidResult();
  const SearchEdge edge = data->edges[edge_index];
  SearchResult result{};
  if (!ReconstructGeneralSolution(
          data,
          physics_workspace,
          static_cast<int32_t>(edge.parent),
          count,
          width,
          height,
          &result) ||
      !AppendGeneralLocalPath(
          data,
          physics_workspace,
          data->nodes[edge.parent],
          edge.player_coordinates,
          count,
          width,
          height,
          &result) ||
      result.solution_length >= kSearchSolutionCapacity) {
    return InvalidResult();
  }
  result.solution[result.solution_length++] = edge.direction;
  result.moves = result.solution_length;
  result.status = SearchStatus::kSolved;
  return result;
}

}  // namespace voxelbench
