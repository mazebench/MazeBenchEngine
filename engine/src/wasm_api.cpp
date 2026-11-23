#include "voxelbench/physics.hpp"
#include "voxelbench/search.hpp"

namespace {

voxelbench::Voxel g_voxels[voxelbench::kVoxelCapacity];
voxelbench::PhysicsWorkspace g_workspace;
voxelbench::MotionState g_motion_state;
voxelbench::SearchWorkspace g_search_workspace;
voxelbench::SearchResult g_search_result;
voxelbench::EdgeSearchResult g_edge_search_result;
uint8_t g_role_buffer[voxelbench::kRoleBufferCapacity];
bool g_initialized = false;

void EnsureInitialized() {
  if (g_initialized) return;
  voxelbench::reset_workspace(&g_workspace);
  voxelbench::reset_motion_state(&g_motion_state);
  g_initialized = true;
}

}  // namespace

extern "C" {

int32_t physics_abi_version() {
  return voxelbench::kPhysicsAbiVersion;
}

int32_t voxel_stride() {
  return static_cast<int32_t>(sizeof(voxelbench::Voxel) / sizeof(int32_t));
}

int32_t voxel_capacity() {
  return voxelbench::kVoxelCapacity;
}

voxelbench::Voxel* voxel_buffer() {
  return g_voxels;
}

int32_t role_buffer_capacity() {
  return voxelbench::kRoleBufferCapacity;
}

uint8_t* role_buffer() {
  return g_role_buffer;
}

uint8_t* motion_state_buffer() {
  EnsureInitialized();
  return reinterpret_cast<uint8_t*>(&g_motion_state);
}

int32_t motion_state_size() {
  return static_cast<int32_t>(sizeof(g_motion_state));
}

void reset_command() {
  EnsureInitialized();
  voxelbench::reset_motion_state(&g_motion_state);
}

int32_t step_command_tick(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction) {
  EnsureInitialized();
  return static_cast<int32_t>(voxelbench::step_command_tick(
      &g_workspace,
      &g_motion_state,
      g_voxels,
      count,
      width,
      height,
      direction));
}

int32_t command_tick() {
  EnsureInitialized();
  return g_motion_state.tick;
}

int32_t command_cycle_detected() {
  EnsureInitialized();
  return g_motion_state.cycle_start_tick >= 0 ? 1 : 0;
}

int32_t command_cycle_start_tick() {
  EnsureInitialized();
  return g_motion_state.cycle_start_tick;
}

int32_t command_cycle_repeat_tick() {
  EnsureInitialized();
  return g_motion_state.cycle_repeat_tick;
}

uint32_t role_code(int32_t length) {
  if (length < 0 || length > voxelbench::kRoleBufferCapacity) return 0;
  return voxelbench::hash_role(g_role_buffer, length);
}

int32_t simulate_turn(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction) {
  EnsureInitialized();
  return voxelbench::simulate_turn(
      &g_workspace, g_voxels, count, width, height, direction);
}

int32_t search_prepare_scene(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_voxel_count) {
  EnsureInitialized();
  return voxelbench::prepare_scene(
      &g_workspace,
      g_voxels,
      count,
      width,
      height,
      dynamic_voxel_count) ? 1 : 0;
}

int32_t search_prepare_quiescent_snapshot(
    int32_t count,
    int32_t width,
    int32_t height) {
  EnsureInitialized();
  return voxelbench::prepare_quiescent_snapshot(
      &g_workspace, g_voxels, count, width, height) ? 1 : 0;
}

int32_t search_try_passive_quiescent_turn(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction) {
  EnsureInitialized();
  return voxelbench::try_simulate_passive_quiescent_turn(
      &g_workspace, g_voxels, count, width, height, direction);
}

int32_t search_node_capacity() {
  return voxelbench::kSearchNodeCapacity;
}

int32_t search_voxel_capacity() {
  return voxelbench::kSearchVoxelCapacity;
}

int32_t search_solve(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t maximum_nodes) {
  EnsureInitialized();
  g_search_result = voxelbench::search_shortest(
      &g_search_workspace,
      &g_workspace,
      g_voxels,
      count,
      width,
      height,
      maximum_nodes);
  return static_cast<int32_t>(g_search_result.status);
}

int32_t search_edges(
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t maximum_nodes) {
  EnsureInitialized();
  g_edge_search_result = voxelbench::search_reachable_edges(
      &g_search_workspace,
      &g_workspace,
      g_voxels,
      count,
      width,
      height,
      maximum_nodes);
  g_search_result = {};
  g_search_result.status = g_edge_search_result.status;
  g_search_result.expanded = g_edge_search_result.expanded;
  g_search_result.generated = g_edge_search_result.generated;
  g_search_result.transpositions = g_edge_search_result.transpositions;
  g_search_result.local_expanded = g_edge_search_result.local_expanded;
  g_search_result.command_transitions =
      g_edge_search_result.command_transitions;
  g_search_result.full_physics_transitions =
      g_edge_search_result.full_physics_transitions;
  return static_cast<int32_t>(g_edge_search_result.status);
}

int32_t search_edge_count() {
  return g_edge_search_result.edges;
}

int32_t search_edge_solution(
    int32_t index,
    int32_t count,
    int32_t width,
    int32_t height) {
  EnsureInitialized();
  g_search_result = voxelbench::search_edge_solution(
      &g_search_workspace,
      &g_workspace,
      index,
      count,
      width,
      height);
  return static_cast<int32_t>(g_search_result.status);
}

int32_t search_moves() {
  return g_search_result.moves;
}

int32_t search_expanded() {
  return g_search_result.expanded;
}

int32_t search_generated() {
  return g_search_result.generated;
}

int32_t search_transpositions() {
  return g_search_result.transpositions;
}

int32_t search_local_expanded() {
  return g_search_result.local_expanded;
}

int32_t search_command_transitions() {
  return g_search_result.command_transitions;
}

int32_t search_full_physics_transitions() {
  return g_search_result.full_physics_transitions;
}

int32_t search_solution_length() {
  return g_search_result.solution_length;
}

int32_t search_solution_step(int32_t index) {
  if (index < 0 || index >= g_search_result.solution_length) return -1;
  return g_search_result.solution[index];
}

}  // extern "C"
