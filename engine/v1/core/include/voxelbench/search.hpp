#pragma once

#include "voxelbench/physics.hpp"

#include <stdint.h>

namespace voxelbench {

// Search stores one translation per rigid moving entity rather than one state
// coordinate per voxel. A generic polycube may therefore fill the authored
// search volume without making each node larger.
constexpr int32_t kSearchVoxelCapacity = 4096;
constexpr int32_t kSearchDynamicEntityCapacity = 64;
// Coordinate storage is shared across nodes and sized independently. Rooms
// with a player plus a typical handful of moving polycubes can therefore use
// far more states without making a worst-case 64-entity scene enormous.
constexpr int32_t kSearchNodeCapacity = 180000;
constexpr int32_t kSearchCoordinateCapacity = 3200000;
constexpr int32_t kSearchSolutionCapacity = 4096;
constexpr int32_t kSearchEdgeCapacity = 8192;
constexpr int32_t kSearchWorkspaceBytes = 36 * 1024 * 1024;

struct SearchWorkspace {
  bool initialized = false;
  alignas(8) uint8_t storage[kSearchWorkspaceBytes];
};

enum class SearchStatus : int32_t {
  kInvalid = -1,
  kUnsolved = 0,
  kSolved = 1,
  kLimitHit = 2,
  // A valid route was found after the state budget discarded a competing
  // state. It is useful as evolutionary fitness, but is not a shortest-path
  // proof.
  kSolvedUnproven = 3,
};

struct SearchResult {
  SearchStatus status;
  int32_t moves;
  int32_t expanded;
  int32_t generated;
  int32_t transpositions;
  int32_t local_expanded;
  int32_t command_transitions;
  int32_t full_physics_transitions;
  int32_t solution_length;
  int32_t solution[kSearchSolutionCapacity];
};

struct EdgeSearchResult {
  SearchStatus status;
  int32_t edges;
  int32_t expanded;
  int32_t generated;
  int32_t transpositions;
  int32_t local_expanded;
  int32_t command_transitions;
  int32_t full_physics_transitions;
};

// Exact shortest-command search. This compact browser/search backend stores
// only moving entity translations; immutable terrain and each polycube's
// relative voxel geometry remain in one scene copy.
// Uniform-cost Dijkstra is equivalent to A* with h=0 over exact command costs.
SearchResult search_shortest(
    SearchWorkspace* search_workspace,
    PhysicsWorkspace* physics_workspace,
    const Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t maximum_nodes = kSearchNodeCapacity);

// Exhaustive, exact reachability search for player states on a room boundary.
// Each result retains the full dynamic board state internally; coincident
// boundary coordinates reached with different board states remain distinct.
// Call search_edge_solution before starting another search to reconstruct the
// shortest witness route for a returned edge index.
EdgeSearchResult search_reachable_edges(
    SearchWorkspace* search_workspace,
    PhysicsWorkspace* physics_workspace,
    const Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t maximum_nodes = kSearchNodeCapacity);

SearchResult search_edge_solution(
    SearchWorkspace* search_workspace,
    PhysicsWorkspace* physics_workspace,
    int32_t edge_index,
    int32_t count,
    int32_t width,
    int32_t height);

}  // namespace voxelbench
