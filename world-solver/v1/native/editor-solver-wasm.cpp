// Benchmark-owned command-state A* wrapper. The imported engine stays
// byte-for-byte unchanged; this translation unit only consumes its internals.
#include "../../../engine/src/search.cpp"
#include "../../../engine/src/wasm_api.cpp"

namespace {

constexpr int32_t kEditorHashBits = 22;
constexpr int32_t kEditorHashCapacity = 1 << kEditorHashBits;
constexpr int32_t kEditorHashMask = kEditorHashCapacity - 1;
constexpr int32_t kEditorPriorityCapacity = 65536;
constexpr int32_t kEditorGrowthPages = 256;
constexpr int32_t kEditorMaximumWeight = 1000;
constexpr uint32_t kEditorInteractionCap = 3;
constexpr uint32_t kNoNode = UINT32_MAX;
constexpr uint16_t kSuperseded = 1;
constexpr uint16_t kClosed = 2;
constexpr uint16_t kAuthoredGates = 4;
constexpr int32_t kEditorEdgeCapacity = voxelbench::kSearchVoxelCapacity * 4;

extern "C" uint8_t __heap_base;

uint32_t g_editor_hash_heads[kEditorHashCapacity];
uint32_t g_editor_priority_heads[kEditorPriorityCapacity];
uint32_t g_editor_priority_tails[kEditorPriorityCapacity];
uint8_t* g_editor_nodes = nullptr;
voxelbench::SearchData* g_editor_data = nullptr;
int32_t g_editor_state_words = 0;
int32_t g_editor_count = 0;
int32_t g_editor_width = 0;
int32_t g_editor_height = 0;
int32_t g_editor_heuristic_weight = 0;
int32_t g_editor_interaction_weight = 0;
int32_t g_editor_status = 0;
int32_t g_editor_node_count = 0;
int32_t g_editor_node_capacity = 0;
int32_t g_editor_open_count = 0;
int32_t g_editor_min_priority = kEditorPriorityCapacity;
int32_t g_editor_expanded = 0;
int32_t g_editor_generated = 0;
int32_t g_editor_transpositions = 0;
int32_t g_editor_command_transitions = 0;
int32_t g_editor_full_physics_transitions = 0;
int32_t g_editor_solution_interactions = 0;
uint8_t g_editor_reverse_solution[voxelbench::kSearchSolutionCapacity];
bool g_editor_stop_on_goals = true;
int32_t g_editor_boundary_mask = 0;
uint64_t g_editor_collected_goal_mask = 0;
uint32_t g_editor_visited[voxelbench::kSearchVoxelCapacity / 32];
uint8_t g_editor_edge_seen[kEditorEdgeCapacity];
int16_t g_editor_edge_cells[kEditorEdgeCapacity];
int16_t g_editor_edge_z[kEditorEdgeCapacity];
uint8_t g_editor_edge_directions[kEditorEdgeCapacity];
int32_t g_editor_edge_count = 0;
int32_t g_editor_latest_cell = -1;

int32_t EditorGoalsOffset() { return g_editor_data->entity_count * 3; }
int32_t EditorLiftsOffset() { return EditorGoalsOffset() + 4; }
int32_t EditorOrangeOffset() { return EditorLiftsOffset() + 4; }
int32_t EditorParentOffset() { return EditorOrangeOffset() + 1; }
int32_t EditorHashNextOffset() { return EditorParentOffset() + 2; }
int32_t EditorCostOffset() { return EditorHashNextOffset() + 2; }
int32_t EditorRewardOffset() { return EditorCostOffset() + 2; }
int32_t EditorPriorityNextOffset() { return EditorRewardOffset() + 2; }
int32_t EditorHashOffset() { return EditorPriorityNextOffset() + 2; }
int32_t EditorActionOffset() { return EditorHashOffset() + 4; }
int32_t EditorFlagsOffset() { return EditorActionOffset() + 1; }

void EditorWrite32(uint16_t* target, uint32_t value) {
  target[0] = static_cast<uint16_t>(value);
  target[1] = static_cast<uint16_t>(value >> 16);
}

uint32_t EditorRead32(const uint16_t* source) {
  return static_cast<uint32_t>(source[0]) |
      (static_cast<uint32_t>(source[1]) << 16);
}

void EditorWrite64(uint16_t* target, uint64_t value) {
  for (int32_t word = 0; word < 4; ++word) {
    target[word] = static_cast<uint16_t>(value >> (word * 16));
  }
}

uint64_t EditorRead64(const uint16_t* source) {
  uint64_t value = 0;
  for (int32_t word = 0; word < 4; ++word) {
    value |= static_cast<uint64_t>(source[word]) << (word * 16);
  }
  return value;
}

uint16_t* EditorNode(int32_t index) {
  return reinterpret_cast<uint16_t*>(g_editor_nodes) +
      static_cast<int64_t>(index) * g_editor_state_words;
}

uint32_t EditorNodeParent(int32_t index) {
  return EditorRead32(EditorNode(index) + EditorParentOffset());
}

uint32_t EditorNodeHashNext(int32_t index) {
  return EditorRead32(EditorNode(index) + EditorHashNextOffset());
}

uint32_t EditorNodeCost(int32_t index) {
  return EditorRead32(EditorNode(index) + EditorCostOffset());
}

uint32_t EditorNodeReward(int32_t index) {
  return EditorRead32(EditorNode(index) + EditorRewardOffset());
}

uint32_t EditorNodePriorityNext(int32_t index) {
  return EditorRead32(EditorNode(index) + EditorPriorityNextOffset());
}

void EditorSetNodePriorityNext(int32_t index, uint32_t next) {
  EditorWrite32(EditorNode(index) + EditorPriorityNextOffset(), next);
}

uint64_t EditorNodeHash(int32_t index) {
  return EditorRead64(EditorNode(index) + EditorHashOffset());
}

bool EditorEnsureNodeCapacity(int32_t wanted) {
  if (wanted <= g_editor_node_capacity) return true;
  const int64_t record_bytes = static_cast<int64_t>(g_editor_state_words) * 2;
  const int64_t base = reinterpret_cast<uintptr_t>(g_editor_nodes);
  const int64_t required = base + static_cast<int64_t>(wanted) * record_bytes;
  const int64_t current_pages = __builtin_wasm_memory_size(0);
  const int64_t current_bytes = current_pages * 65536;
  if (required > current_bytes) {
    const int64_t required_pages = (required + 65535) / 65536;
    const int64_t target_pages = required_pages + kEditorGrowthPages;
    if (target_pages > INT32_MAX || __builtin_wasm_memory_grow(
        0, static_cast<int32_t>(target_pages - current_pages)) < 0) {
      return false;
    }
  }
  const int64_t available =
      static_cast<int64_t>(__builtin_wasm_memory_size(0)) * 65536 - base;
  const int64_t capacity = available / record_bytes;
  g_editor_node_capacity = static_cast<int32_t>(
      capacity > INT32_MAX ? INT32_MAX : capacity);
  return wanted <= g_editor_node_capacity;
}

void EditorLoadNode(int32_t index, voxelbench::SearchNode* node) {
  uint16_t* source = EditorNode(index);
  node->coordinates = reinterpret_cast<int16_t (*)[3]>(source);
  node->collected_goals = EditorRead64(source + EditorGoalsOffset());
  node->lift_states = EditorRead64(source + EditorLiftsOffset());
  node->orange_depth = source[EditorOrangeOffset()];
  node->authored_gates = (source[EditorFlagsOffset()] & kAuthoredGates) != 0;
  node->parent = 0;
  node->cost = static_cast<uint16_t>(EditorNodeCost(index));
  node->direction = source[EditorActionOffset()];
}

bool EditorCandidateEquals(int32_t index) {
  const uint16_t* source = EditorNode(index);
  int32_t cursor = 0;
  for (int32_t entity = 0; entity < g_editor_data->entity_count; ++entity) {
    for (int32_t axis = 0; axis < 3; ++axis) {
      if (source[cursor++] != static_cast<uint16_t>(
          g_editor_data->candidate[entity][axis])) return false;
    }
  }
  if (EditorRead64(source + EditorGoalsOffset()) !=
      g_editor_data->candidate_collected_goals) return false;
  if (EditorRead64(source + EditorLiftsOffset()) !=
      g_editor_data->candidate_lift_states) return false;
  return source[EditorOrangeOffset()] ==
      g_editor_data->candidate_orange_depth &&
      ((source[EditorFlagsOffset()] & kAuthoredGates) != 0) ==
          g_editor_data->candidate_authored_gates;
}

#ifdef MAZEBENCH_SOLUTIONS_SOLVER
uint32_t SolutionsHeuristic(const int16_t (*coordinates)[3], uint64_t collected);
bool SolutionsTarget(int32_t source, const voxelbench::SearchNode& node);
#endif

uint32_t EditorHeuristic(
    const int16_t (*coordinates)[3],
    uint64_t collected_goals) {
#ifdef MAZEBENCH_SOLUTIONS_SOLVER
  return SolutionsHeuristic(coordinates, collected_goals);
#endif
  if (g_editor_heuristic_weight <= 0 || g_editor_data->player_entity < 0) {
    return 0;
  }
  const int32_t player_x = voxelbench::DecodeCoordinate(
      coordinates[g_editor_data->player_entity][0]);
  const int32_t player_y = voxelbench::DecodeCoordinate(
      coordinates[g_editor_data->player_entity][1]);
  const int32_t player_z = voxelbench::DecodeCoordinate(
      coordinates[g_editor_data->player_entity][2]);
  uint32_t best = UINT32_MAX;
  for (int32_t goal = 0; goal < g_editor_data->goal_count; ++goal) {
    if ((collected_goals & (uint64_t{1} << goal)) != 0) continue;
    const uint32_t distance = static_cast<uint32_t>(
        __builtin_abs(player_x - g_editor_data->goal_coordinates[goal][0]) +
        __builtin_abs(player_y - g_editor_data->goal_coordinates[goal][1]) +
        __builtin_abs(player_z - g_editor_data->goal_coordinates[goal][2]));
    if (distance < best) best = distance;
  }
  if ((g_editor_boundary_mask & 1) != 0) {
    const uint32_t distance = static_cast<uint32_t>(player_y);
    if (distance < best) best = distance;
  }
  if ((g_editor_boundary_mask & 2) != 0) {
    const uint32_t distance = static_cast<uint32_t>(
        g_editor_width - 1 - player_x);
    if (distance < best) best = distance;
  }
  if ((g_editor_boundary_mask & 4) != 0) {
    const uint32_t distance = static_cast<uint32_t>(
        g_editor_height - 1 - player_y);
    if (distance < best) best = distance;
  }
  if ((g_editor_boundary_mask & 8) != 0) {
    const uint32_t distance = static_cast<uint32_t>(player_x);
    if (distance < best) best = distance;
  }
  return best == UINT32_MAX ? 0 : best;
}

uint32_t EditorPriority(
    uint32_t cost,
    uint32_t reward,
    const int16_t (*coordinates)[3],
    uint64_t collected_goals) {
  const int64_t value = static_cast<int64_t>(cost) +
      static_cast<int64_t>(g_editor_heuristic_weight) *
          EditorHeuristic(coordinates, collected_goals) -
      static_cast<int64_t>(g_editor_interaction_weight) * reward;
  if (value <= 0) return 0;
  return value >= kEditorPriorityCapacity
      ? kEditorPriorityCapacity - 1
      : static_cast<uint32_t>(value);
}

void EditorPush(int32_t index, uint32_t priority) {
  EditorSetNodePriorityNext(index, kNoNode);
  if (g_editor_priority_heads[priority] == kNoNode) {
    g_editor_priority_heads[priority] = static_cast<uint32_t>(index);
  } else {
    EditorSetNodePriorityNext(
        static_cast<int32_t>(g_editor_priority_tails[priority]),
        static_cast<uint32_t>(index));
  }
  g_editor_priority_tails[priority] = static_cast<uint32_t>(index);
  if (static_cast<int32_t>(priority) < g_editor_min_priority) {
    g_editor_min_priority = static_cast<int32_t>(priority);
  }
  ++g_editor_open_count;
}

int32_t EditorPop() {
  while (g_editor_min_priority < kEditorPriorityCapacity &&
      g_editor_priority_heads[g_editor_min_priority] == kNoNode) {
    ++g_editor_min_priority;
  }
  if (g_editor_min_priority >= kEditorPriorityCapacity) return -1;
  const int32_t result = static_cast<int32_t>(
      g_editor_priority_heads[g_editor_min_priority]);
  g_editor_priority_heads[g_editor_min_priority] =
      EditorNodePriorityNext(result);
  if (g_editor_priority_heads[g_editor_min_priority] == kNoNode) {
    g_editor_priority_tails[g_editor_min_priority] = kNoNode;
  }
  --g_editor_open_count;
  return result;
}

uint32_t EditorInteractionCount(const voxelbench::SearchNode& parent) {
  uint32_t moved = 0;
  for (int32_t entity = 0; entity < g_editor_data->entity_count; ++entity) {
    if (entity == g_editor_data->player_entity) continue;
    bool changed = false;
    for (int32_t axis = 0; axis < 3; ++axis) {
      changed = changed || g_editor_data->candidate[entity][axis] !=
          parent.coordinates[entity][axis];
    }
    if (changed && ++moved >= kEditorInteractionCap) return moved;
  }
  if ((g_editor_data->candidate_lift_states != parent.lift_states ||
       g_editor_data->candidate_authored_gates != parent.authored_gates ||
       g_editor_data->candidate_orange_depth != parent.orange_depth) &&
      moved < kEditorInteractionCap) {
    ++moved;
  }
  return moved;
}

int32_t EditorFindCandidate(uint64_t hash) {
  uint32_t cursor = g_editor_hash_heads[static_cast<uint32_t>(hash) &
      kEditorHashMask];
  while (cursor != kNoNode) {
    const int32_t index = static_cast<int32_t>(cursor);
    if (EditorNodeHash(index) == hash && EditorCandidateEquals(index)) {
      return index;
    }
    cursor = EditorNodeHashNext(index);
  }
  return -1;
}

int32_t EditorStoreCandidate(
    uint64_t hash,
    uint32_t parent,
    uint32_t cost,
    uint32_t reward,
    uint8_t action) {
  const int32_t existing = EditorFindCandidate(hash);
  if (existing >= 0) {
    ++g_editor_transpositions;
    if (EditorNodeCost(existing) <= cost) return 0;
    EditorNode(existing)[EditorFlagsOffset()] |= kSuperseded;
  }
  if (!EditorEnsureNodeCapacity(g_editor_node_count + 1)) return -1;
  const int32_t index = g_editor_node_count++;
  uint16_t* target = EditorNode(index);
  int32_t cursor = 0;
  for (int32_t entity = 0; entity < g_editor_data->entity_count; ++entity) {
    for (int32_t axis = 0; axis < 3; ++axis) {
      target[cursor++] = static_cast<uint16_t>(
          g_editor_data->candidate[entity][axis]);
    }
  }
  EditorWrite64(target + EditorGoalsOffset(),
      g_editor_data->candidate_collected_goals);
  EditorWrite64(target + EditorLiftsOffset(),
      g_editor_data->candidate_lift_states);
  target[EditorOrangeOffset()] = g_editor_data->candidate_orange_depth;
  EditorWrite32(target + EditorParentOffset(), parent);
  const uint32_t bucket = static_cast<uint32_t>(hash) & kEditorHashMask;
  EditorWrite32(target + EditorHashNextOffset(), g_editor_hash_heads[bucket]);
  EditorWrite32(target + EditorCostOffset(), cost);
  EditorWrite32(target + EditorRewardOffset(), reward);
  EditorWrite64(target + EditorHashOffset(), hash);
  target[EditorActionOffset()] = action;
  target[EditorFlagsOffset()] = g_editor_data->candidate_authored_gates ? kAuthoredGates : 0;
  g_editor_hash_heads[bucket] = static_cast<uint32_t>(index);
  g_editor_collected_goal_mask |=
      g_editor_data->candidate_collected_goals;
  const auto* coordinates = reinterpret_cast<int16_t (*)[3]>(target);
  EditorPush(index, EditorPriority(
      cost,
      reward,
      coordinates,
      g_editor_data->candidate_collected_goals));
  return 1;
}

void EditorRecordPlayer(const voxelbench::SearchNode& node) {
  const int32_t x = voxelbench::DecodeCoordinate(
      node.coordinates[g_editor_data->player_entity][0]);
  const int32_t y = voxelbench::DecodeCoordinate(
      node.coordinates[g_editor_data->player_entity][1]);
  const int32_t z = voxelbench::DecodeCoordinate(
      node.coordinates[g_editor_data->player_entity][2]);
  if (x < 0 || x >= g_editor_width || y < 0 || y >= g_editor_height) return;
  const int32_t cell = y * g_editor_width + x;
  g_editor_latest_cell = cell;
  g_editor_visited[cell / 32] |= uint32_t{1} << (cell % 32);
  const bool boundary[4] = {
    y == 0,
    x == g_editor_width - 1,
    y == g_editor_height - 1,
    x == 0
  };
  for (int32_t direction = 0; direction < 4; ++direction) {
    if (!boundary[direction]) continue;
    const int32_t key = cell * 4 + direction;
    if (key < 0 || key >= kEditorEdgeCapacity || g_editor_edge_seen[key]) {
      continue;
    }
    g_editor_edge_seen[key] = 1;
    const int32_t edge = g_editor_edge_count++;
    g_editor_edge_cells[edge] = static_cast<int16_t>(cell);
    g_editor_edge_z[edge] = static_cast<int16_t>(z);
    g_editor_edge_directions[edge] = static_cast<uint8_t>(direction);
  }
}

int32_t EditorFinishSolution(int32_t node) {
  int32_t length = 0;
  uint32_t cursor = static_cast<uint32_t>(node);
  while (cursor != kNoNode) {
    const uint32_t parent = EditorNodeParent(static_cast<int32_t>(cursor));
    if (parent == kNoNode) break;
    if (length >= voxelbench::kSearchSolutionCapacity) {
      g_editor_status = -1;
      return -1;
    }
    g_editor_reverse_solution[length++] = static_cast<uint8_t>(
        EditorNode(static_cast<int32_t>(cursor))[EditorActionOffset()]);
    cursor = parent;
  }
  g_search_result = {};
  g_search_result.status = g_editor_heuristic_weight == 0 &&
      g_editor_interaction_weight == 0
      ? voxelbench::SearchStatus::kSolved
      : voxelbench::SearchStatus::kSolvedUnproven;
  g_search_result.moves = length;
  g_search_result.solution_length = length;
  for (int32_t index = 0; index < length; ++index) {
    g_search_result.solution[index] = g_editor_reverse_solution[length - index - 1];
  }
  g_editor_solution_interactions = static_cast<int32_t>(EditorNodeReward(node));
  g_editor_status = g_search_result.status == voxelbench::SearchStatus::kSolved
      ? 1
      : 3;
  return g_editor_status;
}

}  // namespace

extern "C" {

int32_t editor_solver_begin(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t heuristic_weight,
    int32_t interaction_weight,
    int32_t stop_on_goals,
    int32_t boundary_mask) {
  EnsureInitialized();
  if (count < 1 || count > voxelbench::kSearchVoxelCapacity ||
      width < 1 || height < 1) return 0;
  int32_t ignored_maximum = voxelbench::kSearchNodeCapacity;
  if (!voxelbench::InitializeSearch(
      &g_search_workspace,
      &g_workspace,
      g_voxels,
      count,
      width,
      height,
      &ignored_maximum,
      stop_on_goals != 0)) {
    return 0;
  }
  g_editor_data = voxelbench::Data(&g_search_workspace);
  g_editor_state_words = g_editor_data->entity_count * 3 + 25;
  g_editor_nodes = reinterpret_cast<uint8_t*>(
      (reinterpret_cast<uintptr_t>(&__heap_base) + 7u) & ~uintptr_t{7u});
  g_editor_count = count;
  g_editor_width = width;
  g_editor_height = height;
  g_editor_heuristic_weight = heuristic_weight < 0
      ? 0
      : heuristic_weight > kEditorMaximumWeight
          ? kEditorMaximumWeight
          : heuristic_weight;
  g_editor_interaction_weight = interaction_weight < 0
      ? 0
      : interaction_weight > kEditorMaximumWeight
          ? kEditorMaximumWeight
          : interaction_weight;
  g_editor_stop_on_goals = stop_on_goals != 0;
  g_editor_boundary_mask = boundary_mask & 15;
  g_editor_status = 0;
  g_editor_node_count = 0;
  g_editor_node_capacity = 0;
  g_editor_open_count = 0;
  g_editor_min_priority = kEditorPriorityCapacity;
  g_editor_expanded = 0;
  g_editor_generated = 0;
  g_editor_transpositions = 0;
  g_editor_command_transitions = 0;
  g_editor_full_physics_transitions = 0;
  g_editor_solution_interactions = 0;
  g_editor_collected_goal_mask = 0;
  g_editor_edge_count = 0;
  g_editor_latest_cell = -1;
  g_search_result = {};
  for (int32_t bucket = 0; bucket < kEditorHashCapacity; ++bucket) {
    g_editor_hash_heads[bucket] = kNoNode;
  }
  for (int32_t priority = 0; priority < kEditorPriorityCapacity; ++priority) {
    g_editor_priority_heads[priority] = kNoNode;
    g_editor_priority_tails[priority] = kNoNode;
  }
  for (int32_t word = 0;
       word < voxelbench::kSearchVoxelCapacity / 32;
       ++word) {
    g_editor_visited[word] = 0;
  }
  for (int32_t edge = 0; edge < kEditorEdgeCapacity; ++edge) {
    g_editor_edge_seen[edge] = 0;
  }
  const voxelbench::SearchNode& root = g_editor_data->nodes[0];
  for (int32_t entity = 0; entity < g_editor_data->entity_count; ++entity) {
    for (int32_t axis = 0; axis < 3; ++axis) {
      g_editor_data->candidate[entity][axis] = root.coordinates[entity][axis];
    }
  }
  g_editor_data->candidate_collected_goals = root.collected_goals;
  g_editor_data->candidate_lift_states = root.lift_states;
  g_editor_data->candidate_orange_depth = root.orange_depth;
  g_editor_data->candidate_authored_gates = root.authored_gates;
  const uint64_t hash = voxelbench::HashState(
      g_editor_data->candidate,
      g_editor_data->entity_count,
      root.collected_goals,
      root.lift_states,
      root.orange_depth,
      root.authored_gates);
  return EditorStoreCandidate(hash, kNoNode, 0, 0, 0) == 1 ? 1 : 0;
}

// 0 searching, 1 exact solved, 2 physical memory exhausted,
// 3 heuristic route found, 4 exhaustively unsolved, -1 invalid.
int32_t editor_solver_run(int32_t maximum_expansions) {
  if (maximum_expansions < 1 || g_editor_data == nullptr ||
      g_editor_node_count < 1) return -1;
  if (g_editor_status != 0) return g_editor_status;
  int32_t chunk_expanded = 0;
  while (chunk_expanded < maximum_expansions) {
    const int32_t source = EditorPop();
    if (source < 0) {
      g_editor_status = 4;
      return g_editor_status;
    }
    uint16_t* stored = EditorNode(source);
    if ((stored[EditorFlagsOffset()] & kSuperseded) != 0) continue;
    stored[EditorFlagsOffset()] |= kClosed;
    voxelbench::SearchNode parent{};
    EditorLoadNode(source, &parent);
    EditorRecordPlayer(parent);
#ifdef MAZEBENCH_SOLUTIONS_SOLVER
    if (SolutionsTarget(source, parent)) return EditorFinishSolution(source);
#endif
    if (g_editor_stop_on_goals &&
        voxelbench::NodeIsGoal(g_editor_data, parent)) {
      return EditorFinishSolution(source);
    }
    const uint32_t parent_cost = EditorNodeCost(source);
    const uint32_t parent_reward = EditorNodeReward(source);
    if (parent_cost >= voxelbench::kSearchSolutionCapacity) continue;
    ++g_editor_expanded;
    ++chunk_expanded;
    for (int32_t axis = 0; axis < 3; ++axis) {
      g_editor_data->local_coordinates[0][axis] =
          parent.coordinates[g_editor_data->player_entity][axis];
    }
    bool passive_snapshot_valid = false;
    for (int32_t direction = 0; direction < 4; ++direction) {
      ++g_editor_command_transitions;
      const int32_t simulation = voxelbench::SimulateSearchTurn(
          g_editor_data,
          &g_workspace,
          source == 0 ? g_editor_data->nodes[0] : parent,
          0,
          g_editor_count,
          g_editor_width,
          g_editor_height,
          direction,
          &passive_snapshot_valid);
      if (simulation == 0) ++g_editor_full_physics_transitions;
      int16_t player_coordinates[3];
      uint64_t collected_goals = 0;
      if (simulation < 0 ||
          (simulation > 0 && !voxelbench::CapturePassivePlayer(
              g_editor_data, player_coordinates, &collected_goals)) ||
          (simulation == 0 &&
           (!voxelbench::CaptureCandidate(g_editor_data) ||
            !voxelbench::CandidatePlayerIsActive(
                g_editor_data, g_editor_width, g_editor_height)))) {
        continue;
      }
      if (simulation > 0) {
        voxelbench::BuildPassiveCandidate(
            g_editor_data, parent, player_coordinates, collected_goals);
        // Passive walking can also fall out of the room. Apply the same
        // survivor check used for full physics before queuing an A* node.
        if (!voxelbench::CandidatePlayerIsActive(
                g_editor_data, g_editor_width, g_editor_height)) continue;
      }
      ++g_editor_generated;
      const uint32_t interaction_delta = simulation > 0
          ? 0
          : EditorInteractionCount(parent);
      const uint32_t reward = parent_reward >
              UINT32_MAX - interaction_delta
          ? UINT32_MAX
          : parent_reward + interaction_delta;
      const uint64_t hash = voxelbench::HashState(
          g_editor_data->candidate,
          g_editor_data->entity_count,
          g_editor_data->candidate_collected_goals,
          g_editor_data->candidate_lift_states,
          g_editor_data->candidate_orange_depth,
          g_editor_data->candidate_authored_gates);
      const int32_t inserted = EditorStoreCandidate(
          hash,
          static_cast<uint32_t>(source),
          parent_cost + 1,
          reward,
          static_cast<uint8_t>(direction));
      if (inserted < 0) {
        g_editor_status = 2;
        return g_editor_status;
      }
    }
  }
  return 0;
}

int32_t editor_solver_status() { return g_editor_status; }
int32_t editor_solver_expanded() { return g_editor_expanded; }
int32_t editor_solver_generated() { return g_editor_generated; }
int32_t editor_solver_transpositions() { return g_editor_transpositions; }
int32_t editor_solver_local_expanded() { return 0; }
int32_t editor_solver_command_transitions() {
  return g_editor_command_transitions;
}
int32_t editor_solver_full_physics_transitions() {
  return g_editor_full_physics_transitions;
}
int32_t editor_solver_open_states() { return g_editor_open_count; }
int32_t editor_solver_best_priority() {
  int32_t priority = g_editor_min_priority;
  while (priority < kEditorPriorityCapacity &&
      g_editor_priority_heads[priority] == kNoNode) {
    ++priority;
  }
  return priority < kEditorPriorityCapacity ? priority : -1;
}
int32_t editor_solver_node_count() { return g_editor_node_count; }
int32_t editor_solver_maximum_nodes() { return 0; }
int32_t editor_solver_node_capacity() { return g_editor_node_capacity; }
uint32_t editor_solver_visited_word(int32_t index) {
  return index >= 0 && index < voxelbench::kSearchVoxelCapacity / 32
      ? g_editor_visited[index]
      : 0;
}
int32_t editor_solver_latest_cell() { return g_editor_latest_cell; }
int32_t editor_solver_edge_count() { return g_editor_edge_count; }
int32_t editor_solver_edge_cell(int32_t index) {
  return index >= 0 && index < g_editor_edge_count
      ? g_editor_edge_cells[index]
      : -1;
}
int32_t editor_solver_edge_direction(int32_t index) {
  return index >= 0 && index < g_editor_edge_count
      ? g_editor_edge_directions[index]
      : -1;
}
int32_t editor_solver_edge_z(int32_t index) {
  return index >= 0 && index < g_editor_edge_count
      ? g_editor_edge_z[index]
      : 0;
}
int32_t editor_solver_collected_goals() {
  return __builtin_popcountll(g_editor_collected_goal_mask);
}
int32_t editor_solver_solution_interactions() {
  return g_editor_solution_interactions;
}
int32_t editor_solver_solution_length() {
  return g_search_result.solution_length;
}
int32_t editor_solver_solution_step(int32_t index) {
  return index >= 0 && index < g_search_result.solution_length
      ? g_search_result.solution[index]
      : -1;
}

}  // extern "C"
