// Benchmark-owned extension. The canonical engine stays byte-for-byte synced;
// this translation unit wraps it and adds World BFS plus random-agent APIs.
#include "../../../engine/src/search.cpp"
#include "../../../engine/src/wasm_api.cpp"

namespace {

constexpr uint32_t AgentHashRole(const char* value) {
  uint32_t hash = 2166136261u;
  for (int32_t index = 0; value[index] != '\0'; ++index) {
    hash = (hash ^ static_cast<uint8_t>(value[index])) * 16777619u;
  }
  return hash;
}

constexpr uint32_t kAgentPlayerRole = AgentHashRole("player");
constexpr uint32_t kAgentGoalRole = AgentHashRole("goal");
constexpr uint32_t kAgentFloorRole = AgentHashRole("floor");
constexpr uint32_t kAgentSolidRole = AgentHashRole("solid");
constexpr uint32_t kAgentIceRole = AgentHashRole("ice");
constexpr uint32_t kAgentIceSlopeUpRole = AgentHashRole("ice-slope-up");
constexpr uint32_t kAgentIceSlopeRightRole = AgentHashRole("ice-slope-right");
constexpr uint32_t kAgentIceSlopeDownRole = AgentHashRole("ice-slope-down");
constexpr uint32_t kAgentIceSlopeLeftRole = AgentHashRole("ice-slope-left");
constexpr uint32_t kAgentFloatingFloorRole = AgentHashRole("floating-floor");
constexpr int32_t kAgentTrailCapacity = 50;
constexpr int32_t kAgentVisitedWords = 2048;
constexpr int32_t kAgentRoomWords = 8;
constexpr int32_t kAgentWorldRoomCapacity = 256;
constexpr int32_t kAgentWorldVoxelCapacity = voxelbench::kVoxelCapacity * 2;
constexpr int32_t kRoomBfsHashCapacity = 8 * 1024 * 1024;
constexpr int32_t kRoomBfsHashMask = kRoomBfsHashCapacity - 1;
constexpr int32_t kRoomBfsEdgeCapacity = 4 * 256;
constexpr int32_t kRoomBfsTargetPages = 8192;
constexpr int32_t kSuperAStarBucketCapacity = 65536;
constexpr int32_t kSuperAStarClosed = -2;
constexpr int32_t kRowAStarTargetCapacity = voxelbench::kSearchVoxelCapacity;
constexpr int32_t kRowAStarTargetHashCapacity = 8192;
constexpr int32_t kRowAStarTargetHashMask = kRowAStarTargetHashCapacity - 1;
constexpr int32_t kRowAStarRowCapacity = 64;

extern "C" uint8_t __heap_base;

struct AgentWorldRoom {
  int32_t offset = 0;
  int32_t count = 0;
  int32_t width = 0;
  int32_t height = 0;
  int32_t dynamic_count = 0;
  int32_t player_index = -1;
  bool loaded = false;
};

voxelbench::Voxel g_agent_undo_dynamic[voxelbench::kVoxelCapacity];
voxelbench::Voxel g_agent_undo_goals[voxelbench::kVoxelCapacity];
int32_t g_agent_count = 0;
int32_t g_agent_width = 0;
int32_t g_agent_height = 0;
int32_t g_agent_dynamic_count = 0;
int32_t g_agent_player_index = -1;
int32_t g_agent_goal_count = 0;
int32_t g_agent_goal_indices[voxelbench::kVoxelCapacity];
int32_t g_agent_goal_ids[voxelbench::kVoxelCapacity];
uint32_t g_agent_seed = 1;
uint32_t g_agent_visited[kAgentVisitedWords];
int32_t g_agent_trail[kAgentTrailCapacity];
int32_t g_agent_trail_count = 0;
int32_t g_agent_trail_next = 0;
int32_t g_agent_actions = 0;
int32_t g_agent_undos = 0;
int32_t g_agent_exit_direction = -1;
int32_t g_agent_exit_kind = 0;
voxelbench::Voxel g_agent_world_voxels[kAgentWorldVoxelCapacity];
AgentWorldRoom g_agent_world_rooms[kAgentWorldRoomCapacity];
int32_t g_agent_world_voxel_count = 0;
int32_t g_agent_world_columns = 0;
int32_t g_agent_world_rows = 0;
int32_t g_agent_current_room = -1;
uint32_t g_agent_reached_rooms[kAgentRoomWords];
uint32_t g_agent_collected_goals[kAgentVisitedWords];
int32_t g_agent_collected_goal_count = 0;
int32_t g_agent_moves_since_teleport = 0;
int32_t g_agent_teleports = 0;
int32_t g_agent_last_player_x[kAgentWorldRoomCapacity];
int32_t g_agent_last_player_y[kAgentWorldRoomCapacity];

voxelbench::SearchData* g_bfs_data = nullptr;
uint8_t* g_bfs_arena = nullptr;
int32_t g_bfs_arena_bytes = 0;
int32_t g_bfs_state_words = 0;
int32_t g_bfs_state_capacity = 0;
int32_t g_bfs_state_count = 0;
int32_t g_bfs_head = 0;
int32_t g_bfs_expanded = 0;
int32_t g_bfs_local_states = 0;
int32_t g_bfs_transitions = 0;
int32_t g_bfs_full_physics_transitions = 0;
int32_t g_bfs_generated = 0;
int32_t g_bfs_transpositions = 0;
int32_t g_bfs_edge_count = 0;
int32_t g_bfs_edge_cells[kRoomBfsEdgeCapacity];
int32_t g_bfs_edge_directions[kRoomBfsEdgeCapacity];
int32_t g_bfs_edge_z[kRoomBfsEdgeCapacity];
int32_t g_bfs_edge_nodes[kRoomBfsEdgeCapacity];
int16_t g_bfs_edge_player[kRoomBfsEdgeCapacity][3];
uint8_t g_bfs_edge_seen[kRoomBfsEdgeCapacity];
int16_t g_bfs_original_to_scene[voxelbench::kSearchVoxelCapacity];
uint32_t g_bfs_visited[8];
int32_t g_bfs_latest_cell = -1;
uint64_t g_bfs_collected_goal_mask = 0;
bool g_bfs_super_astar = false;
bool g_bfs_row_astar = false;
int32_t g_super_astar_boundary_mask = 0;
int32_t g_super_astar_weight = 3;
int32_t g_super_astar_bucket_heads[kSuperAStarBucketCapacity];
int32_t g_super_astar_min_priority = kSuperAStarBucketCapacity;
int16_t g_row_astar_target_x[kRowAStarTargetCapacity];
int16_t g_row_astar_target_y[kRowAStarTargetCapacity];
int16_t g_row_astar_target_z[kRowAStarTargetCapacity];
uint8_t g_row_astar_target_visited[kRowAStarTargetCapacity];
int32_t g_row_astar_target_count = 0;
uint64_t g_row_astar_target_keys[kRowAStarTargetHashCapacity];
int16_t g_row_astar_target_indices[kRowAStarTargetHashCapacity];
int16_t g_row_astar_rows[kRowAStarRowCapacity];
int32_t g_row_astar_row_count = 0;
int32_t g_row_astar_active_targets = 0;
int32_t g_row_astar_visited_targets = 0;

uint32_t* RoomBfsHashes() {
  return reinterpret_cast<uint32_t*>(g_bfs_arena);
}

int32_t* RoomBfsSlots() {
  return reinterpret_cast<int32_t*>(RoomBfsHashes() + kRoomBfsHashCapacity);
}

uint16_t* RoomBfsStates() {
  return reinterpret_cast<uint16_t*>(RoomBfsSlots() + kRoomBfsHashCapacity);
}

uint16_t* RoomBfsState(int32_t index) {
  return RoomBfsStates() + static_cast<int64_t>(index) * g_bfs_state_words;
}

void RoomBfsWrite64(uint16_t* target, uint64_t value) {
  for (int32_t word = 0; word < 4; ++word) {
    target[word] = static_cast<uint16_t>(value >> (word * 16));
  }
}

uint64_t RoomBfsRead64(const uint16_t* source) {
  uint64_t value = 0;
  for (int32_t word = 0; word < 4; ++word) {
    value |= static_cast<uint64_t>(source[word]) << (word * 16);
  }
  return value;
}

void RoomBfsWrite32(uint16_t* target, uint32_t value) {
  target[0] = static_cast<uint16_t>(value);
  target[1] = static_cast<uint16_t>(value >> 16);
}

uint32_t RoomBfsRead32(const uint16_t* source) {
  return static_cast<uint32_t>(source[0]) |
      (static_cast<uint32_t>(source[1]) << 16);
}

int32_t RoomBfsMetadataOffset() {
  return g_bfs_data->entity_count * 3 + 10;
}

uint32_t RoomBfsStateCost(int32_t index) {
  return RoomBfsRead32(RoomBfsState(index) + RoomBfsMetadataOffset());
}

uint32_t RoomBfsStatePriority(int32_t index) {
  return RoomBfsRead32(RoomBfsState(index) + RoomBfsMetadataOffset() + 2);
}

int32_t RoomBfsStateNext(int32_t index) {
  return static_cast<int32_t>(RoomBfsRead32(
      RoomBfsState(index) + RoomBfsMetadataOffset() + 4));
}

void RoomBfsSetStateCost(int32_t index, uint32_t value) {
  RoomBfsWrite32(RoomBfsState(index) + RoomBfsMetadataOffset(), value);
}

void RoomBfsSetStatePriority(int32_t index, uint32_t value) {
  RoomBfsWrite32(RoomBfsState(index) + RoomBfsMetadataOffset() + 2, value);
}

void RoomBfsSetStateNext(int32_t index, int32_t value) {
  RoomBfsWrite32(
      RoomBfsState(index) + RoomBfsMetadataOffset() + 4,
      static_cast<uint32_t>(value));
}

bool RoomBfsEnsureArena() {
  if (g_bfs_arena != nullptr) return true;
  const int32_t current_pages = __builtin_wasm_memory_size(0);
  if (current_pages < kRoomBfsTargetPages &&
      __builtin_wasm_memory_grow(0, kRoomBfsTargetPages - current_pages) < 0) {
    return false;
  }
  const uintptr_t base =
      (reinterpret_cast<uintptr_t>(&__heap_base) + 7u) & ~uintptr_t{7u};
  const int64_t end = static_cast<int64_t>(kRoomBfsTargetPages) * 65536;
  if (base >= static_cast<uintptr_t>(end)) return false;
  g_bfs_arena = reinterpret_cast<uint8_t*>(base);
  g_bfs_arena_bytes = static_cast<int32_t>(end - base);
  return true;
}

uint64_t RowAStarTargetKey(int32_t x, int32_t y, int32_t z) {
  return (static_cast<uint64_t>(static_cast<uint16_t>(z)) << 32) |
      (static_cast<uint64_t>(static_cast<uint16_t>(y)) << 16) |
      static_cast<uint16_t>(x);
}

int32_t RowAStarFindTarget(int32_t x, int32_t y, int32_t z) {
  const uint64_t key = RowAStarTargetKey(x, y, z);
  int32_t slot = static_cast<int32_t>(voxelbench::Mix64(key)) &
      kRowAStarTargetHashMask;
  for (int32_t probe = 0; probe < kRowAStarTargetHashCapacity; ++probe) {
    const int32_t index = g_row_astar_target_indices[slot];
    if (index < 0) return -1;
    if (g_row_astar_target_keys[slot] == key) return index;
    slot = (slot + 1) & kRowAStarTargetHashMask;
  }
  return -1;
}

bool RowAStarHasRow(int32_t z) {
  for (int32_t index = 0; index < g_row_astar_row_count; ++index) {
    if (g_row_astar_rows[index] == z) return true;
  }
  return false;
}

bool RowAStarAddTarget(int32_t x, int32_t y, int32_t z, bool visited = false) {
  if (x < 0 || x >= g_bfs_data->search_width ||
      y < 0 || y >= g_bfs_data->search_height ||
      z <= INT16_MIN || z > INT16_MAX) {
    return false;
  }
  int32_t existing = RowAStarFindTarget(x, y, z);
  if (existing >= 0) {
    if (visited && g_row_astar_target_visited[existing] == 0) {
      g_row_astar_target_visited[existing] = 1;
      if (RowAStarHasRow(z)) ++g_row_astar_visited_targets;
    }
    return true;
  }
  if (g_row_astar_target_count >= kRowAStarTargetCapacity) return false;
  const int32_t index = g_row_astar_target_count++;
  g_row_astar_target_x[index] = static_cast<int16_t>(x);
  g_row_astar_target_y[index] = static_cast<int16_t>(y);
  g_row_astar_target_z[index] = static_cast<int16_t>(z);
  g_row_astar_target_visited[index] = visited ? 1 : 0;
  const uint64_t key = RowAStarTargetKey(x, y, z);
  int32_t slot = static_cast<int32_t>(voxelbench::Mix64(key)) &
      kRowAStarTargetHashMask;
  while (g_row_astar_target_indices[slot] >= 0) {
    slot = (slot + 1) & kRowAStarTargetHashMask;
  }
  g_row_astar_target_keys[slot] = key;
  g_row_astar_target_indices[slot] = static_cast<int16_t>(index);
  if (RowAStarHasRow(z)) {
    ++g_row_astar_active_targets;
    if (visited) ++g_row_astar_visited_targets;
  }
  return true;
}

bool RowAStarDiscoverRow(int32_t z) {
  if (z <= INT16_MIN || z > INT16_MAX || RowAStarHasRow(z)) return true;
  if (g_row_astar_row_count >= kRowAStarRowCapacity) return false;
  g_row_astar_rows[g_row_astar_row_count++] = static_cast<int16_t>(z);
  for (int32_t target = 0; target < g_row_astar_target_count; ++target) {
    if (g_row_astar_target_z[target] != z) continue;
    ++g_row_astar_active_targets;
    if (g_row_astar_target_visited[target] != 0) {
      ++g_row_astar_visited_targets;
    }
  }
  return true;
}

void RowAStarResetTargets() {
  g_row_astar_target_count = 0;
  g_row_astar_row_count = 0;
  g_row_astar_active_targets = 0;
  g_row_astar_visited_targets = 0;
  for (int32_t slot = 0; slot < kRowAStarTargetHashCapacity; ++slot) {
    g_row_astar_target_indices[slot] = -1;
  }
}

bool RowAStarStaticRole(uint32_t role) {
  return role == kAgentFloorRole || role == kAgentSolidRole ||
      role == kAgentIceRole || role == kAgentIceSlopeUpRole ||
      role == kAgentIceSlopeRightRole || role == kAgentIceSlopeDownRole ||
      role == kAgentIceSlopeLeftRole;
}

bool RowAStarAddAuthoredTargets() {
  for (int32_t index = 0; index < g_bfs_data->count; ++index) {
    const voxelbench::Voxel& voxel = g_bfs_data->scene[index];
    if (!RowAStarStaticRole(voxel.role)) continue;
    bool covered = false;
    for (int32_t other = 0; other < g_bfs_data->count; ++other) {
      if (other == index) continue;
      const voxelbench::Voxel& above = g_bfs_data->scene[other];
      if (RowAStarStaticRole(above.role) && above.x == voxel.x &&
          above.y == voxel.y && above.z == voxel.z + 1) {
        covered = true;
        break;
      }
    }
    if (!covered && !RowAStarAddTarget(voxel.x, voxel.y, voxel.z)) {
      return false;
    }
  }
  return true;
}

bool RowAStarAddFloatingTargets(const voxelbench::SearchNode& node) {
  for (int32_t entity = 0; entity < g_bfs_data->entity_count; ++entity) {
    if (g_bfs_data->entity_roles[entity] != kAgentFloatingFloorRole) continue;
    const int32_t x = voxelbench::DecodeCoordinate(node.coordinates[entity][0]);
    if (x < 0) continue;
    const int32_t y = voxelbench::DecodeCoordinate(node.coordinates[entity][1]);
    const int32_t z = voxelbench::DecodeCoordinate(node.coordinates[entity][2]);
    if (!RowAStarAddTarget(x, y, z)) return false;
  }
  return true;
}

bool RowAStarAddFloatingCandidateTargets() {
  for (int32_t entity = 0; entity < g_bfs_data->entity_count; ++entity) {
    if (g_bfs_data->entity_roles[entity] != kAgentFloatingFloorRole) continue;
    const int32_t x = voxelbench::DecodeCoordinate(
        g_bfs_data->candidate[entity][0]);
    if (x < 0) continue;
    const int32_t y = voxelbench::DecodeCoordinate(
        g_bfs_data->candidate[entity][1]);
    const int32_t z = voxelbench::DecodeCoordinate(
        g_bfs_data->candidate[entity][2]);
    if (!RowAStarAddTarget(x, y, z)) return false;
  }
  return true;
}

bool RowAStarCoverageComplete() {
  return g_row_astar_row_count > 0 &&
      g_row_astar_visited_targets >= g_row_astar_active_targets;
}

uint32_t RowAStarHeuristic(const int16_t coordinates[][3]) {
  const int32_t player_x = voxelbench::DecodeCoordinate(
      coordinates[g_bfs_data->player_entity][0]);
  const int32_t player_y = voxelbench::DecodeCoordinate(
      coordinates[g_bfs_data->player_entity][1]);
  const int32_t player_row = voxelbench::DecodeCoordinate(
      coordinates[g_bfs_data->player_entity][2]) - 1;
  uint32_t best = UINT32_MAX;
  for (int32_t target = 0; target < g_row_astar_target_count; ++target) {
    if (g_row_astar_target_visited[target] != 0 ||
        g_row_astar_target_z[target] != player_row) {
      continue;
    }
    int32_t dx = player_x - g_row_astar_target_x[target];
    int32_t dy = player_y - g_row_astar_target_y[target];
    if (dx < 0) dx = -dx;
    if (dy < 0) dy = -dy;
    const uint32_t distance = static_cast<uint32_t>(dx + dy);
    if (distance < best) best = distance;
  }
  return best == UINT32_MAX ? 0 : best;
}

uint32_t SuperAStarHeuristic(
    const int16_t coordinates[][3],
    uint64_t collected_goals) {
  const int32_t player_x = voxelbench::DecodeCoordinate(
      coordinates[g_bfs_data->player_entity][0]);
  const int32_t player_y = voxelbench::DecodeCoordinate(
      coordinates[g_bfs_data->player_entity][1]);
  uint32_t best = UINT32_MAX;
  for (int32_t goal = 0; goal < g_bfs_data->goal_count; ++goal) {
    if ((collected_goals & (uint64_t{1} << goal)) != 0) continue;
    int32_t dx = player_x - g_bfs_data->goal_coordinates[goal][0];
    int32_t dy = player_y - g_bfs_data->goal_coordinates[goal][1];
    if (dx < 0) dx = -dx;
    if (dy < 0) dy = -dy;
    const uint32_t distance = static_cast<uint32_t>(dx + dy);
    if (distance < best) best = distance;
  }
  if ((g_super_astar_boundary_mask & 1) != 0) {
    const uint32_t distance = static_cast<uint32_t>(player_y);
    if (distance < best) best = distance;
  }
  if ((g_super_astar_boundary_mask & 2) != 0) {
    const uint32_t distance = static_cast<uint32_t>(
        g_bfs_data->search_width - 1 - player_x);
    if (distance < best) best = distance;
  }
  if ((g_super_astar_boundary_mask & 4) != 0) {
    const uint32_t distance = static_cast<uint32_t>(
        g_bfs_data->search_height - 1 - player_y);
    if (distance < best) best = distance;
  }
  if ((g_super_astar_boundary_mask & 8) != 0) {
    const uint32_t distance = static_cast<uint32_t>(player_x);
    if (distance < best) best = distance;
  }
  return best == UINT32_MAX ? 0 : best;
}

uint32_t SuperAStarPriority(
    const int16_t coordinates[][3],
    uint64_t collected_goals,
    uint32_t cost) {
  const uint32_t heuristic = g_bfs_row_astar
      ? RowAStarHeuristic(coordinates)
      : SuperAStarHeuristic(coordinates, collected_goals);
  const uint64_t priority = static_cast<uint64_t>(cost) +
      static_cast<uint64_t>(g_super_astar_weight) *
          heuristic;
  return priority >= kSuperAStarBucketCapacity
      ? kSuperAStarBucketCapacity - 1
      : static_cast<uint32_t>(priority);
}

void SuperAStarResetBuckets() {
  for (int32_t bucket = 0; bucket < kSuperAStarBucketCapacity; ++bucket) {
    g_super_astar_bucket_heads[bucket] = -1;
  }
  g_super_astar_min_priority = kSuperAStarBucketCapacity;
}

void SuperAStarPush(int32_t index, uint32_t priority) {
  if (priority >= kSuperAStarBucketCapacity) {
    priority = kSuperAStarBucketCapacity - 1;
  }
  RoomBfsSetStatePriority(index, priority);
  RoomBfsSetStateNext(index, g_super_astar_bucket_heads[priority]);
  g_super_astar_bucket_heads[priority] = index;
  if (static_cast<int32_t>(priority) < g_super_astar_min_priority) {
    g_super_astar_min_priority = static_cast<int32_t>(priority);
  }
}

void SuperAStarRemove(int32_t index) {
  const uint32_t priority = RoomBfsStatePriority(index);
  int32_t previous = -1;
  int32_t cursor = g_super_astar_bucket_heads[priority];
  while (cursor >= 0) {
    if (cursor == index) {
      const int32_t next = RoomBfsStateNext(index);
      if (previous < 0) g_super_astar_bucket_heads[priority] = next;
      else RoomBfsSetStateNext(previous, next);
      return;
    }
    previous = cursor;
    cursor = RoomBfsStateNext(cursor);
  }
}

int32_t SuperAStarPop() {
  while (g_super_astar_min_priority < kSuperAStarBucketCapacity &&
      g_super_astar_bucket_heads[g_super_astar_min_priority] < 0) {
    ++g_super_astar_min_priority;
  }
  if (g_super_astar_min_priority >= kSuperAStarBucketCapacity) return -1;
  const int32_t index = g_super_astar_bucket_heads[g_super_astar_min_priority];
  g_super_astar_bucket_heads[g_super_astar_min_priority] =
      RoomBfsStateNext(index);
  RoomBfsSetStateNext(index, kSuperAStarClosed);
  return index;
}

bool SuperAStarHasPending() {
  while (g_super_astar_min_priority < kSuperAStarBucketCapacity &&
      g_super_astar_bucket_heads[g_super_astar_min_priority] < 0) {
    ++g_super_astar_min_priority;
  }
  return g_super_astar_min_priority < kSuperAStarBucketCapacity;
}

void RoomBfsStoreCandidate(int32_t index, uint32_t cost) {
  uint16_t* target = RoomBfsState(index);
  int32_t cursor = 0;
  for (int32_t entity = 0; entity < g_bfs_data->entity_count; ++entity) {
    for (int32_t axis = 0; axis < 3; ++axis) {
      target[cursor++] = static_cast<uint16_t>(g_bfs_data->candidate[entity][axis]);
    }
  }
  RoomBfsWrite64(target + cursor, g_bfs_data->candidate_collected_goals);
  cursor += 4;
  RoomBfsWrite64(target + cursor, g_bfs_data->candidate_lift_states);
  cursor += 4;
  target[cursor++] = g_bfs_data->candidate_orange_depth;
  target[cursor++] = g_bfs_data->candidate_authored_gates ? 1 : 0;
  RoomBfsWrite32(target + cursor, cost);
  cursor += 2;
  RoomBfsWrite32(target + cursor, 0);
  cursor += 2;
  RoomBfsWrite32(target + cursor, static_cast<uint32_t>(-1));
}

void RoomBfsLoadNode(int32_t index, voxelbench::SearchNode* node) {
  uint16_t* source = RoomBfsState(index);
  node->coordinates = reinterpret_cast<int16_t (*)[3]>(source);
  int32_t cursor = g_bfs_data->entity_count * 3;
  node->collected_goals = RoomBfsRead64(source + cursor);
  cursor += 4;
  node->lift_states = RoomBfsRead64(source + cursor);
  cursor += 4;
  node->orange_depth = source[cursor++];
  node->authored_gates = source[cursor] != 0;
}

bool RoomBfsCandidateEquals(int32_t index) {
  const uint16_t* source = RoomBfsState(index);
  int32_t cursor = 0;
  for (int32_t entity = 0; entity < g_bfs_data->entity_count; ++entity) {
    for (int32_t axis = 0; axis < 3; ++axis) {
      if (source[cursor++] != static_cast<uint16_t>(
          g_bfs_data->candidate[entity][axis])) return false;
    }
  }
  if (RoomBfsRead64(source + cursor) !=
      g_bfs_data->candidate_collected_goals) return false;
  cursor += 4;
  if (RoomBfsRead64(source + cursor) !=
      g_bfs_data->candidate_lift_states) return false;
  cursor += 4;
  return source[cursor] == g_bfs_data->candidate_orange_depth &&
      (source[cursor + 1] != 0) == g_bfs_data->candidate_authored_gates;
}

// Returns 1 for a new global board state, 0 for a transposition, and -1 at
// the dynamically calculated arena capacity.
int32_t RoomBfsInsertCandidate(uint32_t cost = 0) {
  ++g_bfs_generated;
  if (g_bfs_row_astar && !RowAStarAddFloatingCandidateTargets()) return -1;
  const uint64_t hash = voxelbench::HashState(
      g_bfs_data->candidate,
      g_bfs_data->entity_count,
      g_bfs_data->candidate_collected_goals,
      g_bfs_data->candidate_lift_states,
      g_bfs_data->candidate_orange_depth,
      g_bfs_data->candidate_authored_gates);
  const uint32_t fingerprint = static_cast<uint32_t>(hash);
  int32_t slot = static_cast<int32_t>(hash) & kRoomBfsHashMask;
  for (int32_t probe = 0; probe < kRoomBfsHashCapacity; ++probe) {
    const int32_t existing = RoomBfsSlots()[slot];
    if (existing < 0) {
      if (g_bfs_state_count >= g_bfs_state_capacity) return -1;
      const int32_t inserted = g_bfs_state_count++;
      RoomBfsStoreCandidate(inserted, cost);
      RoomBfsHashes()[slot] = fingerprint;
      RoomBfsSlots()[slot] = inserted;
      g_bfs_collected_goal_mask |= g_bfs_data->candidate_collected_goals;
      if (g_bfs_super_astar) {
        SuperAStarPush(inserted, SuperAStarPriority(
            g_bfs_data->candidate,
            g_bfs_data->candidate_collected_goals,
            cost));
      }
      return 1;
    }
    if (RoomBfsHashes()[slot] == fingerprint &&
        RoomBfsCandidateEquals(existing)) {
      ++g_bfs_transpositions;
      g_bfs_collected_goal_mask |= g_bfs_data->candidate_collected_goals;
      if (g_bfs_super_astar &&
          RoomBfsStateNext(existing) != kSuperAStarClosed &&
          cost < RoomBfsStateCost(existing)) {
        SuperAStarRemove(existing);
        RoomBfsSetStateCost(existing, cost);
        SuperAStarPush(existing, SuperAStarPriority(
            g_bfs_data->candidate,
            g_bfs_data->candidate_collected_goals,
            cost));
      }
      return 0;
    }
    slot = (slot + 1) & kRoomBfsHashMask;
  }
  return -1;
}

void RoomBfsRecordLocalState(
    const int16_t coordinates[3],
    int32_t source_node) {
  const int32_t x = voxelbench::DecodeCoordinate(coordinates[0]);
  const int32_t y = voxelbench::DecodeCoordinate(coordinates[1]);
  const int32_t z = voxelbench::DecodeCoordinate(coordinates[2]);
  if (x < 0 || x >= g_bfs_data->search_width ||
      y < 0 || y >= g_bfs_data->search_height) return;
  if (g_bfs_row_astar) {
    const int32_t row = z - 1;
    RowAStarAddTarget(x, y, row);
    RowAStarDiscoverRow(row);
    RowAStarAddTarget(x, y, row, true);
  }
  const int32_t cell = y * g_bfs_data->search_width + x;
  g_bfs_visited[cell / 32] |= uint32_t{1} << (cell % 32);
  g_bfs_latest_cell = cell;
  const bool boundary[4] = {
    y == 0,
    x == g_bfs_data->search_width - 1,
    y == g_bfs_data->search_height - 1,
    x == 0
  };
  for (int32_t direction = 0; direction < 4; ++direction) {
    if (!boundary[direction]) continue;
    const int32_t key = cell * 4 + direction;
    if (g_bfs_edge_seen[key] != 0) continue;
    g_bfs_edge_seen[key] = 1;
    g_bfs_edge_cells[g_bfs_edge_count] = cell;
    g_bfs_edge_directions[g_bfs_edge_count] = direction;
    g_bfs_edge_z[g_bfs_edge_count] = z;
    g_bfs_edge_nodes[g_bfs_edge_count] = source_node;
    for (int32_t axis = 0; axis < 3; ++axis) {
      g_bfs_edge_player[g_bfs_edge_count][axis] = coordinates[axis];
    }
    ++g_bfs_edge_count;
  }
}

bool AgentObjectIsActive(const voxelbench::Voxel& voxel) {
  return voxel.x >= 0 && voxel.y >= 0 && voxel.x < g_agent_width &&
      voxel.y < g_agent_height && voxel.z != INT32_MIN;
}

void SaveAgentUndo() {
  for (int32_t index = 0; index < g_agent_dynamic_count; ++index) {
    g_agent_undo_dynamic[index] = g_voxels[index];
  }
  for (int32_t goal = 0; goal < g_agent_goal_count; ++goal) {
    g_agent_undo_goals[goal] = g_voxels[g_agent_goal_indices[goal]];
  }
}

void SaveAgentGoalUndo() {
  for (int32_t goal = 0; goal < g_agent_goal_count; ++goal) {
    g_agent_undo_goals[goal] = g_voxels[g_agent_goal_indices[goal]];
  }
}

void RestoreAgentGoalUndo() {
  for (int32_t goal = 0; goal < g_agent_goal_count; ++goal) {
    g_voxels[g_agent_goal_indices[goal]] = g_agent_undo_goals[goal];
  }
}

void RestoreAgentUndo() {
  for (int32_t index = 0; index < g_agent_dynamic_count; ++index) {
    g_voxels[index] = g_agent_undo_dynamic[index];
  }
  for (int32_t goal = 0; goal < g_agent_goal_count; ++goal) {
    g_voxels[g_agent_goal_indices[goal]] = g_agent_undo_goals[goal];
  }
}

uint32_t NextAgentRandomValue() {
  uint32_t value = g_agent_seed;
  value ^= value << 13u;
  value ^= value >> 17u;
  value ^= value << 5u;
  g_agent_seed = value == 0 ? 0x9e3779b9u : value;
  return g_agent_seed;
}

void RecordAgentVisit() {
  const voxelbench::Voxel& player = g_voxels[g_agent_player_index];
  if (!AgentObjectIsActive(player)) return;
  int32_t cell = player.y * g_agent_width + player.x;
  if (g_agent_current_room >= 0 && g_agent_world_columns > 0) {
    const int32_t room_column = g_agent_current_room % g_agent_world_columns;
    const int32_t room_row = g_agent_current_room / g_agent_world_columns;
    const int32_t world_width = g_agent_world_columns * g_agent_width;
    cell = (room_row * g_agent_height + player.y) * world_width +
        room_column * g_agent_width + player.x;
  }
  if (cell >= 0 && cell < kAgentVisitedWords * 32) {
    g_agent_visited[cell / 32] |= uint32_t{1} << (cell % 32);
  }
  if (g_agent_current_room >= 0) {
    g_agent_last_player_x[g_agent_current_room] = player.x;
    g_agent_last_player_y[g_agent_current_room] = player.y;
  }
  g_agent_trail[g_agent_trail_next] = cell;
  g_agent_trail_next = (g_agent_trail_next + 1) % kAgentTrailCapacity;
  if (g_agent_trail_count < kAgentTrailCapacity) ++g_agent_trail_count;
}

void RecordAgentCollectedGoals() {
  for (int32_t goal = 0; goal < g_agent_goal_count; ++goal) {
    const int32_t id = g_agent_goal_ids[goal];
    if (id < 0 || id >= kAgentVisitedWords * 32 ||
        AgentObjectIsActive(g_voxels[g_agent_goal_indices[goal]])) {
      continue;
    }
    const uint32_t mask = uint32_t{1} << (id % 32);
    uint32_t& word = g_agent_collected_goals[id / 32];
    if ((word & mask) == 0) {
      word |= mask;
      ++g_agent_collected_goal_count;
    }
  }
}

bool PrepareAgentScene(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_count) {
  g_agent_count = count;
  g_agent_width = width;
  g_agent_height = height;
  g_agent_dynamic_count = dynamic_count;
  g_agent_player_index = -1;
  g_agent_goal_count = 0;
  for (int32_t index = 0; index < count; ++index) {
    if (g_voxels[index].role == kAgentPlayerRole && g_agent_player_index < 0) {
      g_agent_player_index = index;
    }
    if (g_voxels[index].role == kAgentGoalRole) {
      g_agent_goal_indices[g_agent_goal_count] = index;
      g_agent_goal_ids[g_agent_goal_count] = g_voxels[index].generic_id;
      ++g_agent_goal_count;
    }
  }
  return g_agent_player_index >= 0 && g_agent_player_index < dynamic_count &&
      voxelbench::prepare_scene(
          &g_workspace, g_voxels, count, width, height, dynamic_count) &&
      voxelbench::prepare_quiescent_snapshot(
          &g_workspace, g_voxels, count, width, height);
}

void MarkAgentRoomReached(int32_t room_index) {
  if (room_index < 0 || room_index >= kAgentWorldRoomCapacity) return;
  g_agent_reached_rooms[room_index / 32] |= uint32_t{1} << (room_index % 32);
}

bool LoadAgentWorldRoom(
    int32_t room_index,
    const voxelbench::Voxel* carried_player = nullptr,
    int32_t player_x = 0,
    int32_t player_y = 0) {
  if (room_index < 0 || room_index >= kAgentWorldRoomCapacity) return false;
  const AgentWorldRoom& room = g_agent_world_rooms[room_index];
  if (!room.loaded || room.count < 1 || room.player_index < 0) return false;
  for (int32_t index = 0; index < room.count; ++index) {
    g_voxels[index] = g_agent_world_voxels[room.offset + index];
  }
  if (carried_player != nullptr) {
    g_voxels[room.player_index] = *carried_player;
    g_voxels[room.player_index].x = player_x;
    g_voxels[room.player_index].y = player_y;
  }
  g_agent_current_room = room_index;
  if (!PrepareAgentScene(
      room.count, room.width, room.height, room.dynamic_count)) {
    return false;
  }
  MarkAgentRoomReached(room_index);
  return true;
}

int32_t AgentReachedRoomCount() {
  int32_t count = 0;
  for (int32_t word = 0; word < kAgentRoomWords; ++word) {
    count += __builtin_popcount(g_agent_reached_rooms[word]);
  }
  return count;
}

bool TeleportAgentToReachedRoom() {
  const int32_t count = AgentReachedRoomCount();
  if (count < 1) return false;
  int32_t selected = static_cast<int32_t>(NextAgentRandomValue() % count);
  for (int32_t room = 0; room < kAgentWorldRoomCapacity; ++room) {
    const uint32_t mask = uint32_t{1} << (room % 32);
    if ((g_agent_reached_rooms[room / 32] & mask) == 0) continue;
    if (selected-- == 0) {
      const voxelbench::Voxel player = g_voxels[g_agent_player_index];
      return LoadAgentWorldRoom(
          room,
          &player,
          g_agent_last_player_x[room],
          g_agent_last_player_y[room]);
    }
  }
  return false;
}

// 0 needs the exact connected-world fallback, 1 is a blocked/no-op edge,
// and 2 is a simple walk onto ordinary floor in the neighboring room.
int32_t AgentSimpleWorldEdge(
    const voxelbench::Voxel& player,
    int32_t direction,
    int32_t* next_room,
    int32_t* next_x,
    int32_t* next_y) {
  if (g_agent_current_room < 0 || g_agent_world_columns < 1 ||
      g_agent_world_rows < 1) return 0;
  const int32_t column = g_agent_current_room % g_agent_world_columns;
  const int32_t row = g_agent_current_room / g_agent_world_columns;
  int32_t next_column = column;
  int32_t next_row = row;
  if (direction == 0) --next_row;
  else if (direction == 1) ++next_column;
  else if (direction == 2) ++next_row;
  else if (direction == 3) --next_column;
  if (next_column < 0 || next_column >= g_agent_world_columns ||
      next_row < 0 || next_row >= g_agent_world_rows) return 1;

  *next_room = next_row * g_agent_world_columns + next_column;
  const AgentWorldRoom& room = g_agent_world_rooms[*next_room];
  if (!room.loaded) return 1;
  *next_x = direction == 1 ? 0 : direction == 3 ? room.width - 1 : player.x;
  *next_y = direction == 2 ? 0 : direction == 0 ? room.height - 1 : player.y;
  bool floor = false;
  bool complex = false;
  for (int32_t index = 0; index < room.count; ++index) {
    const voxelbench::Voxel& voxel = g_agent_world_voxels[room.offset + index];
    if (voxel.role == kAgentPlayerRole || voxel.x != *next_x || voxel.y != *next_y) {
      continue;
    }
    if (voxel.role == kAgentFloorRole && voxel.z == player.z - 1) {
      if (floor) complex = true;
      floor = true;
    } else if (voxel.role == kAgentSolidRole && voxel.z == player.z) {
      return 1;
    } else if (voxel.z == player.z || voxel.z == player.z - 1) {
      complex = true;
    }
  }
  return floor && !complex ? 2 : 0;
}

bool AgentPlayerIsOnIce(const voxelbench::Voxel& player) {
  for (int32_t index = 0; index < g_agent_count; ++index) {
    if (index == g_agent_player_index) continue;
    const voxelbench::Voxel& voxel = g_voxels[index];
    const bool ice = voxel.role == kAgentIceRole ||
        voxel.role == kAgentIceSlopeUpRole ||
        voxel.role == kAgentIceSlopeRightRole ||
        voxel.role == kAgentIceSlopeDownRole ||
        voxel.role == kAgentIceSlopeLeftRole;
    if (ice && voxel.x == player.x && voxel.y == player.y &&
        (voxel.z == player.z || voxel.z == player.z - 1)) {
      return true;
    }
  }
  return false;
}

int32_t AgentExitKind(
    const voxelbench::Voxel& before,
    const voxelbench::Voxel& after,
    int32_t direction) {
  if (!AgentObjectIsActive(after)) return 0;
  const int32_t dx = after.x - before.x;
  const int32_t dy = after.y - before.y;
  const bool stationary = dx == 0 && dy == 0;
  if (stationary) {
    if ((direction == 0 && after.y == 0) ||
        (direction == 1 && after.x == g_agent_width - 1) ||
        (direction == 2 && after.y == g_agent_height - 1) ||
        (direction == 3 && after.x == 0)) {
      return 1;
    }
    return 0;
  }
  const bool reached_edge =
      (after.y == 0 && dx == 0 && dy < 0) ||
      (after.x == g_agent_width - 1 && dx > 0 && dy == 0) ||
      (after.y == g_agent_height - 1 && dx == 0 && dy > 0) ||
      (after.x == 0 && dx < 0 && dy == 0);
  if (!reached_edge) return 0;
  return AgentPlayerIsOnIce(after) || dx < -1 || dx > 1 || dy < -1 || dy > 1
      ? 2
      : 0;
}

}  // namespace

extern "C" {

int32_t BeginRoomSearch(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_voxel_count,
    bool super_astar,
    bool row_astar,
    int32_t boundary_mask,
    int32_t heuristic_weight) {
  EnsureInitialized();
  if (count < 1 || count > voxelbench::kSearchVoxelCapacity || width < 1 ||
      height < 1 || static_cast<int64_t>(width) * height > 256 ||
      dynamic_voxel_count < 1 || dynamic_voxel_count > count) {
    return 0;
  }
  if (!RoomBfsEnsureArena()) return 0;
  int32_t ignored_maximum = voxelbench::kSearchNodeCapacity;
  if (!voxelbench::InitializeSearch(
      &g_search_workspace,
      &g_workspace,
      g_voxels,
      count,
      width,
      height,
      &ignored_maximum,
      false)) {
    return 0;
  }
  int32_t scene_index = 0;
  for (int32_t source = 0; source < count; ++source) {
    if (!voxelbench::IsDynamic(g_voxels[source].role)) continue;
    g_bfs_original_to_scene[source] = static_cast<int16_t>(scene_index++);
  }
  for (int32_t source = 0; source < count; ++source) {
    if (g_voxels[source].role != voxelbench::kOrangeWallRole &&
        g_voxels[source].role != voxelbench::kPlayerGateRole) continue;
    g_bfs_original_to_scene[source] = static_cast<int16_t>(scene_index++);
  }
  for (int32_t source = 0; source < count; ++source) {
    if (voxelbench::IsDynamic(g_voxels[source].role) ||
        g_voxels[source].role == voxelbench::kOrangeWallRole ||
        g_voxels[source].role == voxelbench::kPlayerGateRole) continue;
    g_bfs_original_to_scene[source] = static_cast<int16_t>(scene_index++);
  }
  g_bfs_data = voxelbench::Data(&g_search_workspace);
  g_bfs_super_astar = super_astar;
  g_bfs_row_astar = row_astar;
  g_super_astar_boundary_mask = boundary_mask & 15;
  g_super_astar_weight = heuristic_weight < 1
      ? 1
      : heuristic_weight > 16 ? 16 : heuristic_weight;
  g_bfs_state_words = g_bfs_data->entity_count * 3 + 16;
  const int64_t table_bytes = static_cast<int64_t>(kRoomBfsHashCapacity) * 8;
  const int64_t state_bytes = g_bfs_arena_bytes - table_bytes;
  if (g_bfs_state_words < 1 || state_bytes <= 0) return 0;
  const int64_t storage_capacity =
      state_bytes / (g_bfs_state_words * static_cast<int32_t>(sizeof(uint16_t)));
  const int64_t hash_capacity =
      static_cast<int64_t>(kRoomBfsHashCapacity) * 3 / 4;
  const int64_t capacity = storage_capacity < hash_capacity
      ? storage_capacity
      : hash_capacity;
  g_bfs_state_capacity = static_cast<int32_t>(
      capacity > INT32_MAX ? INT32_MAX : capacity);
  g_bfs_state_count = 0;
  g_bfs_head = 0;
  g_bfs_expanded = 0;
  g_bfs_local_states = 0;
  g_bfs_transitions = 0;
  g_bfs_full_physics_transitions = 0;
  g_bfs_generated = 0;
  g_bfs_transpositions = 0;
  g_bfs_edge_count = 0;
  g_bfs_latest_cell = -1;
  g_bfs_collected_goal_mask = 0;
  for (int32_t word = 0; word < 8; ++word) g_bfs_visited[word] = 0;
  for (int32_t edge = 0; edge < kRoomBfsEdgeCapacity; ++edge) {
    g_bfs_edge_seen[edge] = 0;
  }
  for (int32_t slot = 0; slot < kRoomBfsHashCapacity; ++slot) {
    RoomBfsSlots()[slot] = -1;
  }
  if (g_bfs_row_astar) {
    RowAStarResetTargets();
    if (!RowAStarAddAuthoredTargets()) return 0;
  }
  if (g_bfs_super_astar) SuperAStarResetBuckets();
  return RoomBfsInsertCandidate() == 1 ? 1 : 0;
}

int32_t room_bfs_begin(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_voxel_count) {
  return BeginRoomSearch(
      count, width, height, dynamic_voxel_count, false, false, 0, 1);
}

int32_t super_astar_begin(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_voxel_count,
    int32_t boundary_mask,
    int32_t heuristic_weight) {
  return BeginRoomSearch(
      count,
      width,
      height,
      dynamic_voxel_count,
      true,
      false,
      boundary_mask,
      heuristic_weight);
}

int32_t row_astar_begin(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_voxel_count,
    int32_t heuristic_weight) {
  return BeginRoomSearch(
      count,
      width,
      height,
      dynamic_voxel_count,
      true,
      true,
      0,
      heuristic_weight);
}

// 0 = still running, 1 = complete and locked, 2 = arena/local capacity hit,
// 3 = a new boundary edge was exposed and the depth-first meta loop may yield.
int32_t RoomBfsRun(int32_t maximum_expansions, bool stop_at_new_edge) {
  EnsureInitialized();
  if (maximum_expansions < 0 || g_bfs_data == nullptr ||
      g_bfs_state_count < 1) {
    return -1;
  }
  const auto has_pending = []() {
    return g_bfs_super_astar
        ? SuperAStarHasPending()
        : g_bfs_head < g_bfs_state_count;
  };
  if (!has_pending()) return 1;

  int32_t chunk_expanded = 0;
  while (has_pending() && chunk_expanded < maximum_expansions) {
    const int32_t edge_count_before = g_bfs_edge_count;
    const uint64_t collected_goals_before = g_bfs_collected_goal_mask;
    const int32_t source = g_bfs_super_astar
        ? SuperAStarPop()
        : g_bfs_head++;
    if (source < 0) break;
    const uint32_t parent_cost = g_bfs_super_astar
        ? RoomBfsStateCost(source)
        : 0;
    voxelbench::SearchNode stored_parent{};
    RoomBfsLoadNode(source, &stored_parent);
    const voxelbench::SearchNode& parent = source == 0
        ? g_bfs_data->nodes[0]
        : stored_parent;
    if (g_bfs_row_astar && !RowAStarAddFloatingTargets(parent)) return 2;
    int32_t local_count = voxelbench::BeginLocalSearch(g_bfs_data, parent);
    bool passive_snapshot_valid = false;
    for (int32_t local_head = 0; local_head < local_count; ++local_head) {
      ++g_bfs_local_states;
      RoomBfsRecordLocalState(
          g_bfs_data->local_coordinates[local_head], source);
      const uint64_t source_key = voxelbench::LocalCoordinateKey(
          g_bfs_data->local_coordinates[local_head]);
      for (int32_t direction = 0; direction < 4; ++direction) {
        ++g_bfs_transitions;
        const int32_t simulation = voxelbench::SimulateSearchTurn(
            g_bfs_data,
            &g_workspace,
            parent,
            local_head,
            g_bfs_data->count,
            g_bfs_data->search_width,
            g_bfs_data->search_height,
            direction,
            &passive_snapshot_valid);
        if (simulation == 0) ++g_bfs_full_physics_transitions;
        int16_t player_coordinates[3];
        uint64_t collected_goals = 0;
        if (simulation < 0 ||
            (simulation > 0 && !voxelbench::CapturePassivePlayer(
                g_bfs_data, player_coordinates, &collected_goals)) ||
            (simulation == 0 &&
             (!voxelbench::CaptureCandidate(g_bfs_data) ||
              !voxelbench::CandidatePlayerIsActive(
                  g_bfs_data,
                  g_bfs_data->search_width,
                  g_bfs_data->search_height)))) {
          continue;
        }
        if (simulation > 0) {
          const int32_t player_x = voxelbench::DecodeCoordinate(
              player_coordinates[0]);
          const int32_t player_y = voxelbench::DecodeCoordinate(
              player_coordinates[1]);
          if (player_x < 0 || player_x >= g_bfs_data->search_width ||
              player_y < 0 || player_y >= g_bfs_data->search_height) {
            continue;
          }
        } else {
          for (int32_t axis = 0; axis < 3; ++axis) {
            player_coordinates[axis] =
                g_bfs_data->candidate[g_bfs_data->player_entity][axis];
          }
          collected_goals = g_bfs_data->candidate_collected_goals;
        }
        const bool pure_player = simulation > 0
            ? collected_goals == parent.collected_goals
            : voxelbench::CandidateIsPurePlayerMove(g_bfs_data, parent);
        if (pure_player) {
          const uint64_t key = voxelbench::LocalCoordinateKey(player_coordinates);
          if (key == source_key ||
              !voxelbench::InsertLocalStateIfAbsent(g_bfs_data, key)) {
            continue;
          }
          if (local_count >= voxelbench::kLocalStateCapacity) return 2;
          const int32_t next = local_count++;
          for (int32_t axis = 0; axis < 3; ++axis) {
            g_bfs_data->local_coordinates[next][axis] = player_coordinates[axis];
          }
          continue;
        }
        if (simulation > 0) {
          voxelbench::BuildPassiveCandidate(
              g_bfs_data, parent, player_coordinates, collected_goals);
        }
        const uint32_t edge_cost = static_cast<uint32_t>(
            g_bfs_data->local_distances[local_head]) + 1;
        const uint32_t child_cost = parent_cost > UINT32_MAX - edge_cost
            ? UINT32_MAX
            : parent_cost + edge_cost;
        if (RoomBfsInsertCandidate(child_cost) < 0) return 2;
      }
    }
    ++g_bfs_expanded;
    ++chunk_expanded;
    if (g_bfs_row_astar && RowAStarCoverageComplete()) return 4;
    if (stop_at_new_edge &&
        (g_bfs_edge_count > edge_count_before ||
         (g_bfs_super_astar && !g_bfs_row_astar &&
          g_bfs_collected_goal_mask != collected_goals_before))) {
      return 3;
    }
  }
  return has_pending() ? 0 : 1;
}

int32_t room_bfs_run(int32_t maximum_expansions) {
  return RoomBfsRun(maximum_expansions, false);
}

int32_t room_bfs_run_until_edge(int32_t maximum_expansions) {
  return RoomBfsRun(maximum_expansions, true);
}

int32_t super_astar_run(int32_t maximum_expansions) {
  if (!g_bfs_super_astar || g_bfs_row_astar) return -1;
  return RoomBfsRun(maximum_expansions, true);
}

int32_t row_astar_run(int32_t maximum_expansions) {
  if (!g_bfs_row_astar) return -1;
  return RoomBfsRun(maximum_expansions, true);
}

int32_t room_bfs_states() { return g_bfs_local_states; }
int32_t room_bfs_state_capacity() { return g_bfs_state_capacity; }
int32_t room_bfs_expanded() { return g_bfs_expanded; }
int32_t room_bfs_transitions() { return g_bfs_transitions; }
int32_t room_bfs_global_states() { return g_bfs_state_count; }
int32_t room_bfs_full_physics_transitions() {
  return g_bfs_full_physics_transitions;
}
int32_t room_bfs_state_words() { return g_bfs_state_words; }
int32_t room_bfs_state_buffer() {
  return static_cast<int32_t>(reinterpret_cast<uintptr_t>(RoomBfsStates()));
}
int32_t room_bfs_head() { return g_bfs_head; }
int32_t room_bfs_generated() { return g_bfs_generated; }
int32_t room_bfs_transpositions() { return g_bfs_transpositions; }
int32_t room_bfs_collected_goals_low() {
  return static_cast<int32_t>(g_bfs_collected_goal_mask);
}
int32_t room_bfs_collected_goals_high() {
  return static_cast<int32_t>(g_bfs_collected_goal_mask >> 32);
}

// Restore a BFS only between room_bfs_run chunks. JavaScript owns the compact
// state copy while another room is active; the canonical search scratch space
// remains single-instance and is rebuilt for the resumed authored room.
int32_t room_bfs_restore(
    int32_t state_count,
    int32_t head,
    int32_t expanded,
    int32_t local_states,
    int32_t transitions,
    int32_t full_physics_transitions,
    int32_t generated,
    int32_t transpositions,
    int32_t latest_cell,
    int32_t collected_goals_low,
    int32_t collected_goals_high) {
  if (g_bfs_data == nullptr || state_count < 1 ||
      state_count > g_bfs_state_capacity || head < 0 || head > state_count ||
      expanded < 0 || local_states < 0 || transitions < 0 ||
      full_physics_transitions < 0 || generated < 0 || transpositions < 0) {
    return 0;
  }
  for (int32_t slot = 0; slot < kRoomBfsHashCapacity; ++slot) {
    RoomBfsSlots()[slot] = -1;
  }
  if (g_bfs_super_astar) SuperAStarResetBuckets();
  for (int32_t index = 0; index < state_count; ++index) {
    voxelbench::SearchNode node{};
    RoomBfsLoadNode(index, &node);
    const uint64_t hash = voxelbench::HashState(
        node.coordinates,
        g_bfs_data->entity_count,
        node.collected_goals,
        node.lift_states,
        node.orange_depth,
        node.authored_gates);
    int32_t slot = static_cast<int32_t>(hash) & kRoomBfsHashMask;
    for (int32_t probe = 0; probe < kRoomBfsHashCapacity; ++probe) {
      if (RoomBfsSlots()[slot] < 0) {
        RoomBfsHashes()[slot] = static_cast<uint32_t>(hash);
        RoomBfsSlots()[slot] = index;
        break;
      }
      slot = (slot + 1) & kRoomBfsHashMask;
      if (probe == kRoomBfsHashCapacity - 1) return 0;
    }
    if (g_bfs_super_astar && RoomBfsStateNext(index) != kSuperAStarClosed) {
      SuperAStarPush(index, SuperAStarPriority(
          node.coordinates,
          node.collected_goals,
          RoomBfsStateCost(index)));
    }
  }
  g_bfs_state_count = state_count;
  g_bfs_head = head;
  g_bfs_expanded = expanded;
  g_bfs_local_states = local_states;
  g_bfs_transitions = transitions;
  g_bfs_full_physics_transitions = full_physics_transitions;
  g_bfs_generated = generated;
  g_bfs_transpositions = transpositions;
  g_bfs_edge_count = 0;
  g_bfs_latest_cell = latest_cell;
  g_bfs_collected_goal_mask =
      static_cast<uint32_t>(collected_goals_low) |
      (static_cast<uint64_t>(static_cast<uint32_t>(collected_goals_high)) << 32);
  for (int32_t word = 0; word < 8; ++word) g_bfs_visited[word] = 0;
  for (int32_t edge = 0; edge < kRoomBfsEdgeCapacity; ++edge) {
    g_bfs_edge_seen[edge] = 0;
  }
  return 1;
}

int32_t room_bfs_restore_visited_word(int32_t index, int32_t value) {
  if (index < 0 || index >= 8) return 0;
  g_bfs_visited[index] = static_cast<uint32_t>(value);
  return 1;
}

int32_t room_bfs_restore_edge(
    int32_t cell,
    int32_t direction,
    int32_t z,
    int32_t source_node,
    int32_t player_x,
    int32_t player_y,
    int32_t player_z) {
  if (cell < 0 || cell >= 256 || direction < 0 || direction >= 4 ||
      source_node < 0 || source_node >= g_bfs_state_count ||
      player_x < INT16_MIN || player_x > INT16_MAX ||
      player_y < INT16_MIN || player_y > INT16_MAX ||
      player_z < INT16_MIN || player_z > INT16_MAX ||
      g_bfs_edge_count >= kRoomBfsEdgeCapacity) {
    return 0;
  }
  const int32_t key = cell * 4 + direction;
  if (g_bfs_edge_seen[key] != 0) return 1;
  g_bfs_edge_seen[key] = 1;
  g_bfs_edge_cells[g_bfs_edge_count] = cell;
  g_bfs_edge_directions[g_bfs_edge_count] = direction;
  g_bfs_edge_z[g_bfs_edge_count] = z;
  g_bfs_edge_nodes[g_bfs_edge_count] = source_node;
  g_bfs_edge_player[g_bfs_edge_count][0] =
      static_cast<int16_t>(player_x);
  g_bfs_edge_player[g_bfs_edge_count][1] =
      static_cast<int16_t>(player_y);
  g_bfs_edge_player[g_bfs_edge_count][2] =
      static_cast<int16_t>(player_z);
  ++g_bfs_edge_count;
  return 1;
}
int32_t room_bfs_edge_count() { return g_bfs_edge_count; }
int32_t room_bfs_latest_cell() { return g_bfs_latest_cell; }
int32_t room_bfs_collected_goals() {
  return __builtin_popcountll(g_bfs_collected_goal_mask);
}

int32_t row_astar_target_count() { return g_row_astar_target_count; }
int32_t row_astar_active_targets() { return g_row_astar_active_targets; }
int32_t row_astar_visited_targets() { return g_row_astar_visited_targets; }
int32_t row_astar_row_count() { return g_row_astar_row_count; }
int32_t row_astar_coverage_complete() {
  return g_bfs_row_astar && RowAStarCoverageComplete() ? 1 : 0;
}
int32_t row_astar_target_x(int32_t index) {
  return index >= 0 && index < g_row_astar_target_count
      ? g_row_astar_target_x[index]
      : INT32_MIN;
}
int32_t row_astar_target_y(int32_t index) {
  return index >= 0 && index < g_row_astar_target_count
      ? g_row_astar_target_y[index]
      : INT32_MIN;
}
int32_t row_astar_target_z(int32_t index) {
  return index >= 0 && index < g_row_astar_target_count
      ? g_row_astar_target_z[index]
      : INT32_MIN;
}
int32_t row_astar_target_visited(int32_t index) {
  return index >= 0 && index < g_row_astar_target_count
      ? g_row_astar_target_visited[index]
      : 0;
}
int32_t row_astar_row(int32_t index) {
  return index >= 0 && index < g_row_astar_row_count
      ? g_row_astar_rows[index]
      : INT32_MIN;
}
int32_t row_astar_restore_reset() {
  if (!g_bfs_row_astar) return 0;
  RowAStarResetTargets();
  return 1;
}
int32_t row_astar_restore_target(
    int32_t x,
    int32_t y,
    int32_t z,
    int32_t visited) {
  return g_bfs_row_astar && RowAStarAddTarget(x, y, z, visited != 0) ? 1 : 0;
}
int32_t row_astar_restore_row(int32_t z) {
  return g_bfs_row_astar && RowAStarDiscoverRow(z) ? 1 : 0;
}

uint32_t room_bfs_visited_word(int32_t index) {
  if (index < 0 || index >= 8) return 0;
  return g_bfs_visited[index];
}

int32_t room_bfs_edge_cell(int32_t index) {
  if (index < 0 || index >= g_bfs_edge_count) return -1;
  return g_bfs_edge_cells[index];
}

int32_t room_bfs_edge_direction(int32_t index) {
  if (index < 0 || index >= g_bfs_edge_count) return -1;
  return g_bfs_edge_directions[index];
}

int32_t room_bfs_edge_z(int32_t index) {
  if (index < 0 || index >= g_bfs_edge_count) return INT32_MIN;
  return g_bfs_edge_z[index];
}

int32_t room_bfs_edge_node(int32_t index) {
  if (index < 0 || index >= g_bfs_edge_count) return -1;
  return g_bfs_edge_nodes[index];
}

int32_t room_bfs_edge_player_axis(int32_t index, int32_t axis) {
  if (index < 0 || index >= g_bfs_edge_count || axis < 0 || axis >= 3) {
    return INT32_MIN;
  }
  return voxelbench::DecodeCoordinate(g_bfs_edge_player[index][axis]);
}

int32_t row_astar_edge_load_state(int32_t index) {
  if (!g_bfs_row_astar || g_bfs_data == nullptr || index < 0 ||
      index >= g_bfs_edge_count) {
    return 0;
  }
  voxelbench::SearchNode node{};
  RoomBfsLoadNode(g_bfs_edge_nodes[index], &node);
  voxelbench::LoadNode(g_bfs_data, node);
  voxelbench::Voxel& player = g_bfs_data->scene[g_bfs_data->player_index];
  player.x = voxelbench::DecodeCoordinate(g_bfs_edge_player[index][0]);
  player.y = voxelbench::DecodeCoordinate(g_bfs_edge_player[index][1]);
  player.z = voxelbench::DecodeCoordinate(g_bfs_edge_player[index][2]);
  voxelbench::RestoreSearchPlayerGates(g_bfs_data, node.authored_gates);
  if (player.x < 0) return 0;
  for (int32_t source = 0; source < g_bfs_data->count; ++source) {
    const int32_t scene = g_bfs_original_to_scene[source];
    if (scene < 0 || scene >= g_bfs_data->count) return 0;
    g_voxels[source] = g_bfs_data->scene[scene];
  }
  return g_bfs_data->count;
}

int32_t row_astar_restore_physics_workspace() {
  if (!g_bfs_row_astar || g_bfs_data == nullptr) return 0;
  return voxelbench::prepare_scene(
      &g_workspace,
      g_bfs_data->scene,
      g_bfs_data->count,
      g_bfs_data->search_width,
      g_bfs_data->search_height,
      g_bfs_data->dynamic_voxel_count) ? 1 : 0;
}

int32_t random_world_reset(int32_t columns, int32_t rows) {
  EnsureInitialized();
  if (columns < 1 || rows < 1 || columns * rows > kAgentWorldRoomCapacity) return 0;
  g_agent_world_columns = columns;
  g_agent_world_rows = rows;
  g_agent_world_voxel_count = 0;
  g_agent_current_room = -1;
  g_agent_moves_since_teleport = 0;
  g_agent_teleports = 0;
  g_agent_collected_goal_count = 0;
  for (int32_t room = 0; room < kAgentWorldRoomCapacity; ++room) {
    g_agent_world_rooms[room] = {};
    g_agent_last_player_x[room] = 0;
    g_agent_last_player_y[room] = 0;
  }
  for (int32_t word = 0; word < kAgentRoomWords; ++word) {
    g_agent_reached_rooms[word] = 0;
  }
  for (int32_t word = 0; word < kAgentVisitedWords; ++word) {
    g_agent_collected_goals[word] = 0;
  }
  return 1;
}

int32_t random_world_add_room(
    int32_t room_index,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_count,
    int32_t player_index) {
  if (room_index < 0 || room_index >= g_agent_world_columns * g_agent_world_rows ||
      count < 1 || count > voxelbench::kVoxelCapacity || width < 1 || height < 1 ||
      static_cast<int64_t>(width) * height > 256 || dynamic_count < 1 ||
      dynamic_count > count || player_index < 0 || player_index >= dynamic_count ||
      g_agent_world_voxel_count + count > kAgentWorldVoxelCapacity) {
    return 0;
  }
  AgentWorldRoom& room = g_agent_world_rooms[room_index];
  if (room.loaded) return 0;
  room = {
    g_agent_world_voxel_count,
    count,
    width,
    height,
    dynamic_count,
    player_index,
    true
  };
  for (int32_t index = 0; index < count; ++index) {
    g_agent_world_voxels[g_agent_world_voxel_count + index] = g_voxels[index];
  }
  g_agent_world_voxel_count += count;
  return 1;
}

int32_t random_world_start(int32_t room_index, uint32_t seed) {
  g_agent_seed = seed == 0 ? 0x9e3779b9u : seed;
  if (!LoadAgentWorldRoom(room_index)) return 0;
  RecordAgentVisit();
  return 1;
}

int32_t random_world_resume(
    int32_t room_index,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_count,
    uint32_t seed) {
  if (room_index < 0 || room_index >= g_agent_world_columns * g_agent_world_rows) return 0;
  g_agent_current_room = room_index;
  g_agent_seed = seed == 0 ? 0x9e3779b9u : seed;
  if (!PrepareAgentScene(count, width, height, dynamic_count)) return 0;
  MarkAgentRoomReached(room_index);
  return 1;
}

int32_t random_agent_begin(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_voxel_count,
    uint32_t seed) {
  EnsureInitialized();
  if (count < 1 || count > voxelbench::kVoxelCapacity || width < 1 ||
      height < 1 || static_cast<int64_t>(width) * height > 256 ||
      dynamic_voxel_count < 1 || dynamic_voxel_count > count) {
    return 0;
  }
  g_agent_current_room = -1;
  if (!PrepareAgentScene(count, width, height, dynamic_voxel_count)) return 0;
  g_agent_seed = seed == 0 ? 0x9e3779b9u : seed;
  return 1;
}

int32_t random_agent_run(int32_t maximum_actions) {
  EnsureInitialized();
  if (maximum_actions < 0 || g_agent_player_index < 0) return -1;
  for (int32_t word = 0; word < kAgentVisitedWords; ++word) g_agent_visited[word] = 0;
  g_agent_trail_count = 0;
  g_agent_trail_next = 0;
  g_agent_actions = 0;
  g_agent_undos = 0;
  g_agent_exit_direction = -1;
  g_agent_exit_kind = 0;
  RecordAgentVisit();

  for (int32_t action = 0; action < maximum_actions; ++action) {
    if (g_agent_current_room >= 0 && g_agent_moves_since_teleport >= 10'000) {
      if (!TeleportAgentToReachedRoom()) return -1;
      g_agent_moves_since_teleport = 0;
      ++g_agent_teleports;
      RecordAgentVisit();
    }
    const voxelbench::Voxel before = g_voxels[g_agent_player_index];
    SaveAgentGoalUndo();
    const int32_t direction = static_cast<int32_t>(NextAgentRandomValue() & 3u);
    int32_t result = voxelbench::try_simulate_passive_quiescent_turn(
        &g_workspace,
        g_voxels,
        g_agent_count,
        g_agent_width,
        g_agent_height,
        direction);
    bool full_undo = false;
    if (result == 0) {
      // A passive decline is transactional, so the full snapshot is only
      // needed for the uncommon command that enters the general kernel.
      SaveAgentUndo();
      full_undo = true;
      result = voxelbench::simulate_quiescent_turn(
          &g_workspace,
          g_voxels,
          g_agent_count,
          g_agent_width,
          g_agent_height,
          direction,
          true);
    }
    if (result < 0) return result;

    const voxelbench::Voxel& player = g_voxels[g_agent_player_index];
    if (!AgentObjectIsActive(player)) {
      if (full_undo) {
        RestoreAgentUndo();
      } else {
        g_voxels[g_agent_player_index] = before;
        RestoreAgentGoalUndo();
      }
      ++g_agent_actions;
      ++g_agent_undos;
      ++g_agent_moves_since_teleport;
      if (full_undo && !voxelbench::prepare_quiescent_snapshot(
          &g_workspace, g_voxels, g_agent_count, g_agent_width, g_agent_height)) {
        return -1;
      }
      continue;
    }
    const int32_t exit_kind = AgentExitKind(before, player, direction);
    if (exit_kind != 0) {
      if (full_undo) {
        RestoreAgentUndo();
      } else {
        g_voxels[g_agent_player_index] = before;
        RestoreAgentGoalUndo();
      }
      if (exit_kind == 1 && g_agent_current_room >= 0) {
        int32_t next_room = -1;
        int32_t next_x = 0;
        int32_t next_y = 0;
        const int32_t simple = AgentSimpleWorldEdge(
            before, direction, &next_room, &next_x, &next_y);
        if (simple == 1) {
          if (full_undo && !voxelbench::prepare_quiescent_snapshot(
              &g_workspace, g_voxels, g_agent_count, g_agent_width, g_agent_height)) {
            return -1;
          }
          ++g_agent_actions;
          ++g_agent_moves_since_teleport;
          continue;
        }
        if (simple == 2 && LoadAgentWorldRoom(next_room, &before, next_x, next_y)) {
          ++g_agent_actions;
          ++g_agent_moves_since_teleport;
          RecordAgentVisit();
          continue;
        }
      }
      g_agent_exit_direction = direction;
      g_agent_exit_kind = exit_kind;
      if (full_undo && !voxelbench::prepare_quiescent_snapshot(
          &g_workspace, g_voxels, g_agent_count, g_agent_width, g_agent_height)) {
        return -1;
      }
      return 1;
    }
    RecordAgentCollectedGoals();
    if (full_undo && !voxelbench::prepare_quiescent_snapshot(
        &g_workspace, g_voxels, g_agent_count, g_agent_width, g_agent_height)) {
      return -1;
    }
    ++g_agent_actions;
    ++g_agent_moves_since_teleport;
    if (player.x != before.x || player.y != before.y || player.z != before.z) {
      RecordAgentVisit();
    }
  }
  return 0;
}

int32_t random_agent_actions() { return g_agent_actions; }
int32_t random_agent_death_undos() { return g_agent_undos; }
int32_t random_agent_exit_direction() { return g_agent_exit_direction; }
int32_t random_agent_exit_kind() { return g_agent_exit_kind; }
uint32_t random_agent_seed() { return g_agent_seed; }

uint32_t random_agent_visited_word(int32_t index) {
  if (index < 0 || index >= kAgentVisitedWords) return 0;
  return g_agent_visited[index];
}

int32_t random_agent_trail_count() { return g_agent_trail_count; }

int32_t random_agent_trail_cell(int32_t index) {
  if (index < 0 || index >= g_agent_trail_count) return -1;
  const int32_t start = g_agent_trail_count < kAgentTrailCapacity
      ? 0
      : g_agent_trail_next;
  return g_agent_trail[(start + index) % kAgentTrailCapacity];
}

int32_t random_agent_current_room() { return g_agent_current_room; }

uint32_t random_agent_reached_room_word(int32_t index) {
  if (index < 0 || index >= kAgentRoomWords) return 0;
  return g_agent_reached_rooms[index];
}

uint32_t random_agent_collected_goal_word(int32_t index) {
  if (index < 0 || index >= kAgentVisitedWords) return 0;
  return g_agent_collected_goals[index];
}

int32_t random_agent_collected_goal_count() { return g_agent_collected_goal_count; }
int32_t random_agent_teleports() { return g_agent_teleports; }

void random_agent_note_external_action() {
  ++g_agent_moves_since_teleport;
}

void random_agent_mark_goal_collected(int32_t id) {
  if (id < 0 || id >= kAgentVisitedWords * 32) return;
  const uint32_t mask = uint32_t{1} << (id % 32);
  uint32_t& word = g_agent_collected_goals[id / 32];
  if ((word & mask) == 0) {
    word |= mask;
    ++g_agent_collected_goal_count;
  }
}

}  // extern "C"
