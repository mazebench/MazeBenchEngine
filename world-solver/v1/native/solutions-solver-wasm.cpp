// Reuse the editor's compact command-state A*, including its passive-physics
// fast path. Only the goal predicate differs. Canonical sources are untouched.
#define MAZEBENCH_SOLUTIONS_SOLVER
#include "editor-solver-wasm.cpp"

namespace {
int32_t g_solution_kind = 0;
int32_t g_solution_x = 0, g_solution_y = 0, g_solution_z = 0;
bool g_solution_any_z = true;
uint64_t g_solution_goal_mask = 0;
int32_t g_solution_source = -1, g_solution_offered = 0;
int32_t g_solution_direction = -1;

uint32_t SolutionsHeuristic(const int16_t (*coordinates)[3], uint64_t collected) {
  const auto* player = coordinates[g_editor_data->player_entity];
  const int32_t x = voxelbench::DecodeCoordinate(player[0]);
  const int32_t y = voxelbench::DecodeCoordinate(player[1]);
  const int32_t z = voxelbench::DecodeCoordinate(player[2]);
  uint32_t best = UINT32_MAX;
  if (g_solution_kind == 1) {
    best = __builtin_abs(x - g_solution_x) + __builtin_abs(y - g_solution_y) +
        (g_solution_any_z ? 0 : __builtin_abs(z - g_solution_z));
  } else if (g_solution_kind == 2) {
    if (collected & g_solution_goal_mask) return 0;
    for (int32_t i = 0; i < g_editor_data->goal_count; ++i) {
      if (!(g_solution_goal_mask & (uint64_t{1} << i))) continue;
      const auto* goal = g_editor_data->goal_coordinates[i];
      const uint32_t distance = __builtin_abs(x - goal[0]) +
          __builtin_abs(y - goal[1]) + __builtin_abs(z - goal[2]);
      if (distance < best) best = distance;
    }
  }
  const int32_t distances[4] = {y, g_editor_width - 1 - x, g_editor_height - 1 - y, x};
  for (int32_t d = 0; d < 4; ++d) {
    if ((g_editor_boundary_mask & (1 << d)) && static_cast<uint32_t>(distances[d]) < best) best = distances[d];
  }
  return best == UINT32_MAX ? 0 : best;
}

bool SolutionsTarget(int32_t source, const voxelbench::SearchNode& node) {
  if (g_solution_source != source) {g_solution_source = source; g_solution_offered = 0;}
  const auto* player = node.coordinates[g_editor_data->player_entity];
  const int32_t x = voxelbench::DecodeCoordinate(player[0]);
  const int32_t y = voxelbench::DecodeCoordinate(player[1]);
  const int32_t z = voxelbench::DecodeCoordinate(player[2]);
  const bool target = g_solution_kind == 1 ?
      x == g_solution_x && y == g_solution_y && (g_solution_any_z || z == g_solution_z) :
      g_solution_kind == 2 && (node.collected_goals & g_solution_goal_mask);
  g_solution_direction = -1;
  if (target && !(g_solution_offered & 16)) {g_solution_offered |= 16; return true;}
  const bool edges[4] = {y == 0, x == g_editor_width - 1, y == g_editor_height - 1, x == 0};
  for (int32_t d = 0; d < 4; ++d) {
    const int32_t bit = 1 << d;
    if (edges[d] && (g_editor_boundary_mask & bit) && !(g_solution_offered & bit)) {
      g_solution_offered |= bit; g_solution_direction = d; return true;
    }
  }
  return false;
}
} // namespace

extern "C" {
int32_t solutions_solver_begin(int32_t count, int32_t width, int32_t height,
    int32_t kind, int32_t x, int32_t y, int32_t z, int32_t any_z,
    uint32_t goal_low, uint32_t goal_high, int32_t boundary_mask, int32_t weight) {
  g_solution_kind = kind; g_solution_x = x; g_solution_y = y; g_solution_z = z;
  g_solution_any_z = any_z != 0;
  g_solution_goal_mask = uint64_t{goal_low} | (uint64_t{goal_high} << 32);
  g_solution_source = -1; g_solution_offered = 0; g_solution_direction = -1;
  return editor_solver_begin(count, width, height, weight, 0, 0, boundary_mask);
}

int32_t solutions_solver_continue() {
  if (g_editor_status != 1 && g_editor_status != 3) return 0;
  // Resume the SAME frontier after JavaScript has checked a candidate against
  // connected physics. Another entrance at the same tile may have a different
  // dynamic board state; never deduplicate these candidates by coordinate.
  voxelbench::SearchNode node{};
  EditorLoadNode(g_solution_source, &node);
  const uint32_t priority = EditorPriority(EditorNodeCost(g_solution_source),
      EditorNodeReward(g_solution_source), node.coordinates, node.collected_goals);
  // Return this node first so corners retain both untested outgoing directions.
  EditorSetNodePriorityNext(g_solution_source, g_editor_priority_heads[priority]);
  if (g_editor_priority_heads[priority] == kNoNode) g_editor_priority_tails[priority] = g_solution_source;
  g_editor_priority_heads[priority] = g_solution_source;
  g_editor_min_priority = priority;
  ++g_editor_open_count;
  g_editor_status = 0; g_search_result.solution_length = 0;
  return 1;
}

int32_t solutions_solver_direction() {return g_solution_direction;}
}
