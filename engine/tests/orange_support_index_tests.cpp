// Differential coverage of the private support accelerator against its exact
// scan fallback. Include the implementation so no test-only exports enter WASM.
#include "../src/physics.cpp"
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <vector>

int main() {
  using namespace voxelbench;
  auto workspace = std::make_unique<PhysicsWorkspace>();
  reset_workspace(workspace.get());
  WorkspaceScope scope(workspace.get());
  uint32_t seed = 0x5a17u;
  auto random = [&]() { seed = seed * 1664525u + 1013904223u; return seed; };
  const uint32_t roles[] = { HashRoleLiteral("solid"), kFloorRole, kIceRole, kPlayerGateRole,
    kCloneRole, kYellowCloneSlopeUpRole, kFloatingFloorRole, kPushableRole,
    kWeightlessPushableRole, kPlayerLiftRole, kOrangeButtonRole, kPlayerRole, kGoalRole, kPuncherRole };
  int checks = 0;
  for (int scene = 0; scene < 80; ++scene) {
    const int32_t count = scene == 79 ? 4097 : 512;
    std::vector<Voxel> voxels(static_cast<size_t>(count));
    for (int32_t i = 0; i < count; ++i) {
      voxels[static_cast<size_t>(i)] = { static_cast<int32_t>(random() % 18) - 1,
        static_cast<int32_t>(random() % 18) - 1, static_cast<int32_t>(random() % 9) - 3,
        i < 80 ? kOrangeWallRole : roles[random() % 14], static_cast<int32_t>(random() % 2) };
    }
    // Coincident wall columns in distinct room circuits and integer extremes.
    voxels[0] = { 1, 1, 3, kOrangeWallRole, 0 };
    voxels[1] = { 1, 1, -2, kOrangeWallRole, kOrangeScopedIdFlag | (1 << kOrangeScopeShift) };
    voxels[2] = { 1, 1, INT32_MIN, kOrangeWallRole, 0 };
    BuildObjects(voxels.data(), count);
    for (int iteration = 0; iteration < 40; ++iteration) {
      for (int32_t i = 0; i < 80; ++i) {
        const int32_t actual = OrangeWallSupportZ(voxels.data(), count, i);
        const int32_t expected = ScanOrangeWallSupportZ(voxels.data(), count, i);
        if (actual != expected) { std::fprintf(stderr, "Orange support mismatch: scene %d tick %d wall %d: %d != %d\n", scene, iteration, i, actual, expected); return 1; }
        ++checks;
      }
      // Mutations can happen between support queries, before spatial rebuild.
      for (auto& voxel : voxels) {
        if (IsCloneObjectRole(voxel.role) || voxel.role == kFloatingFloorRole) {
          voxel.x = static_cast<int32_t>(random() % 18) - 1;
          voxel.y = static_cast<int32_t>(random() % 18) - 1;
          voxel.z = static_cast<int32_t>(random() % 9) - 3;
        } else if (voxel.role == kPlayerGateRole) voxel.generic_id ^= 1;
      }
      voxels[0].z = static_cast<int32_t>(random() % 9);
      if (iteration % 8 == 0) BuildSpatialIndex(voxels.data(), count, 16, 16);
    }
  }
  std::printf("all %d indexed Orange Wall support comparisons passed\n", checks);
}
