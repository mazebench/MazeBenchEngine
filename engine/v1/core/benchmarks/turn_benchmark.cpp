#include "voxelbench/physics.hpp"

#include <chrono>
#include <cstdint>
#include <iostream>

namespace {

uint32_t Role(const char* value) {
  int32_t length = 0;
  while (value[length] != '\0') ++length;
  return voxelbench::hash_role(reinterpret_cast<const uint8_t*>(value), length);
}

}  // namespace

int main() {
  // Compact Sokoban workload: restore two dynamic voxels in one prepared
  // eight-voxel scene, push through an Ice lane, and consume the result.
  constexpr std::uint64_t kIterations = 1000000;
  voxelbench::Voxel voxels[] = {
      {1, 6, 1, Role("player"), -1},
      {1, 5, 1, Role("pushable"), 0},
      {1, 6, 0, Role("floor"), -1},
      {1, 5, 0, Role("floor"), -1},
      {1, 4, 0, Role("ice"), -1},
      {1, 3, 0, Role("ice"), -1},
      {1, 2, 0, Role("ice"), -1},
      {1, 1, 0, Role("solid"), -1},
  };
  static voxelbench::PhysicsWorkspace workspace;
  voxelbench::reset_workspace(&workspace);
  if (!voxelbench::prepare_scene(&workspace, voxels, 8, 8, 8, 2)) return 1;
  volatile std::int64_t checksum = 0;
  const auto started = std::chrono::steady_clock::now();
  for (std::uint64_t iteration = 0; iteration < kIterations; ++iteration) {
    voxels[0].x = 1;
    voxels[0].y = 6;
    voxels[0].z = 1;
    voxels[1].x = 1;
    voxels[1].y = 5;
    voxels[1].z = 1;
    voxelbench::simulate_turn(&workspace, voxels, 8, 8, 8, 0);
    checksum = checksum + voxels[0].y + voxels[1].y;
  }
  const auto elapsed = std::chrono::duration<double>(
      std::chrono::steady_clock::now() - started).count();
  const double commands_per_second = static_cast<double>(kIterations) / elapsed;
  std::cout << "workload=flat_single_push_ice_lane"
            << " iterations=" << kIterations
            << " physics_turns_per_second="
            << static_cast<std::uint64_t>(commands_per_second)
            << " elapsed_seconds=" << elapsed << " checksum=" << checksum << '\n';

  voxelbench::Voxel walking[] = {
      {3, 3, 1, Role("player"), -1},
      {3, 3, 0, Role("floor"), -1},
      {3, 2, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  if (!voxelbench::prepare_scene(&workspace, walking, 3, 8, 8, 1) ||
      !voxelbench::prepare_quiescent_snapshot(
          &workspace, walking, 3, 8, 8)) return 1;
  checksum = 0;
  const auto passive_started = std::chrono::steady_clock::now();
  for (std::uint64_t iteration = 0; iteration < kIterations; ++iteration) {
    walking[0].x = 3;
    walking[0].y = 3;
    walking[0].z = 1;
    const int32_t result = voxelbench::try_simulate_passive_quiescent_turn(
        &workspace, walking, 3, 8, 8, 0);
    checksum = checksum + result + walking[0].y;
  }
  const auto passive_elapsed = std::chrono::duration<double>(
      std::chrono::steady_clock::now() - passive_started).count();
  std::cout << "workload=prepared_passive_floor_step"
            << " iterations=" << kIterations
            << " passive_evaluations_per_second="
            << static_cast<std::uint64_t>(kIterations / passive_elapsed)
            << " elapsed_seconds=" << passive_elapsed
            << " checksum=" << checksum << '\n';
}
