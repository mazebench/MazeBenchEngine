#include "voxelbench/physics.hpp"
#include "voxelbench/search.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr uint64_t kExpectedFixtureHash = UINT64_C(0xab2b3428d9df8632);
constexpr int32_t kSampleCount = 5;
constexpr double kTargetSampleSeconds = 0.50;

struct Fixture {
  std::string name;
  int32_t width = 0;
  int32_t height = 0;
  int32_t expected_moves = 0;
  int32_t expected_voxels = 0;
  uint64_t hash = 0;
  std::vector<voxelbench::Voxel> voxels;
};

struct Sample {
  double seconds = 0.0;
  uint64_t solves = 0;
  uint64_t expanded = 0;
  uint64_t generated = 0;
  uint64_t transpositions = 0;
  uint64_t local_expanded = 0;
  uint64_t command_transitions = 0;
  uint64_t full_physics_transitions = 0;
};

uint32_t Role(const std::string& value) {
  return voxelbench::hash_role(
      reinterpret_cast<const uint8_t*>(value.data()),
      static_cast<int32_t>(value.size()));
}

uint64_t Fnv1a64(const std::string& value) {
  uint64_t hash = UINT64_C(0xcbf29ce484222325);
  for (const char byte : value) {
    hash ^= static_cast<uint64_t>(static_cast<uint8_t>(byte));
    hash *= UINT64_C(0x100000001b3);
  }
  return hash;
}

std::array<std::string, 5> ParseVoxelFields(const std::string& line) {
  std::array<std::string, 5> fields;
  std::istringstream stream(line);
  for (std::size_t field = 0; field < fields.size(); ++field) {
    if (!std::getline(stream, fields[field], ',')) {
      throw std::runtime_error("invalid fixture voxel row: " + line);
    }
  }
  std::string extra;
  if (std::getline(stream, extra, ',')) {
    throw std::runtime_error("too many fixture voxel fields: " + line);
  }
  return fields;
}

Fixture LoadFixture(const std::string& path) {
  std::ifstream input(path);
  if (!input) throw std::runtime_error("cannot open benchmark fixture: " + path);

  Fixture fixture;
  std::vector<std::string> voxel_rows;
  std::string line;
  while (std::getline(input, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) continue;
    if (line.front() == '#') {
      const std::size_t equals = line.find('=');
      if (equals == std::string::npos) continue;
      const std::string key = line.substr(2, equals - 2);
      const std::string value = line.substr(equals + 1);
      if (key == "fixture") fixture.name = value;
      if (key == "width") fixture.width = std::stoi(value);
      if (key == "height") fixture.height = std::stoi(value);
      if (key == "expected_moves") fixture.expected_moves = std::stoi(value);
      if (key == "expected_voxels") fixture.expected_voxels = std::stoi(value);
      continue;
    }
    if (line == "x,y,z,role,generic_id") continue;

    const auto fields = ParseVoxelFields(line);
    fixture.voxels.push_back({
        std::stoi(fields[0]),
        std::stoi(fields[1]),
        std::stoi(fields[2]),
        Role(fields[3]),
        std::stoi(fields[4]),
    });
    voxel_rows.push_back(
        std::to_string(std::stoi(fields[0])) + "," +
        std::to_string(std::stoi(fields[1])) + "," +
        std::to_string(std::stoi(fields[2])) + "," + fields[3] + "," +
        std::to_string(std::stoi(fields[4])));
  }

  if (fixture.name.empty() || fixture.width <= 0 || fixture.height <= 0 ||
      fixture.expected_moves <= 0 || fixture.expected_voxels <= 0 ||
      static_cast<int32_t>(fixture.voxels.size()) != fixture.expected_voxels) {
    throw std::runtime_error("incomplete or inconsistent benchmark fixture");
  }
  std::string canonical = fixture.name + "|" + std::to_string(fixture.width) +
      "|" + std::to_string(fixture.height) + "|" +
      std::to_string(fixture.expected_moves) + "|" +
      std::to_string(fixture.expected_voxels) + "\n";
  for (const std::string& row : voxel_rows) canonical += row + "\n";
  fixture.hash = Fnv1a64(canonical);
  if (fixture.hash != kExpectedFixtureHash) {
    throw std::runtime_error("benchmark fixture hash does not match its frozen value");
  }
  return fixture;
}

void CheckSolved(
    const Fixture& fixture,
    const voxelbench::SearchResult& result) {
  if (result.status != voxelbench::SearchStatus::kSolved ||
      result.moves != fixture.expected_moves ||
      result.solution_length != fixture.expected_moves) {
    throw std::runtime_error(
        "exact-search correctness failure: expected " +
        std::to_string(fixture.expected_moves) + " moves, got status " +
        std::to_string(static_cast<int32_t>(result.status)) + " and " +
        std::to_string(result.moves) + " moves");
  }
}

voxelbench::SearchResult Solve(
    const Fixture& fixture,
    voxelbench::SearchWorkspace* search_workspace,
    voxelbench::PhysicsWorkspace* physics_workspace) {
  const auto result = voxelbench::search_shortest(
      search_workspace,
      physics_workspace,
      fixture.voxels.data(),
      static_cast<int32_t>(fixture.voxels.size()),
      fixture.width,
      fixture.height,
      voxelbench::kSearchNodeCapacity);
  CheckSolved(fixture, result);
  return result;
}

void CheckReplay(
    const Fixture& fixture,
    const voxelbench::SearchResult& result,
    voxelbench::PhysicsWorkspace* physics_workspace) {
  std::vector<voxelbench::Voxel> replay = fixture.voxels;
  voxelbench::reset_workspace(physics_workspace);
  for (int32_t step = 0; step < result.solution_length; ++step) {
    if (voxelbench::simulate_turn(
            physics_workspace,
            replay.data(),
            static_cast<int32_t>(replay.size()),
            fixture.width,
            fixture.height,
            result.solution[step]) != 0) {
      throw std::runtime_error("solution replay rejected a command");
    }
  }
  bool player_active = false;
  bool goal_active = false;
  const uint32_t player_role = Role("player");
  const uint32_t goal_role = Role("goal");
  for (const auto& voxel : replay) {
    if (voxel.role == player_role && voxel.x >= 0 && voxel.y >= 0) {
      player_active = true;
    }
    if (voxel.role == goal_role && voxel.x >= 0 && voxel.y >= 0) {
      goal_active = true;
    }
  }
  if (!player_active || goal_active) {
    throw std::runtime_error(
        "solution replay did not leave an active player with every gem collected");
  }
}

int Run(const std::string& fixture_path) {
  const Fixture fixture = LoadFixture(fixture_path);
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::reset_workspace(&physics_workspace);

  const auto warmup = Solve(fixture, &search_workspace, &physics_workspace);
  CheckReplay(fixture, warmup, &physics_workspace);

  std::array<Sample, kSampleCount> samples;
  for (Sample& sample : samples) {
    do {
      const auto started = std::chrono::steady_clock::now();
      const auto result = voxelbench::search_shortest(
          &search_workspace,
          &physics_workspace,
          fixture.voxels.data(),
          static_cast<int32_t>(fixture.voxels.size()),
          fixture.width,
          fixture.height,
          voxelbench::kSearchNodeCapacity);
      sample.seconds += std::chrono::duration<double>(
          std::chrono::steady_clock::now() - started).count();
      CheckSolved(fixture, result);
      ++sample.solves;
      sample.expanded += static_cast<uint64_t>(result.expanded);
      sample.generated += static_cast<uint64_t>(result.generated);
      sample.transpositions += static_cast<uint64_t>(result.transpositions);
      sample.local_expanded += static_cast<uint64_t>(result.local_expanded);
      sample.command_transitions +=
          static_cast<uint64_t>(result.command_transitions);
      sample.full_physics_transitions +=
          static_cast<uint64_t>(result.full_physics_transitions);
    } while (sample.seconds < kTargetSampleSeconds);
  }
  std::sort(samples.begin(), samples.end(), [](const Sample& left, const Sample& right) {
    return static_cast<double>(left.solves) / left.seconds <
        static_cast<double>(right.solves) / right.seconds;
  });
  const Sample& median = samples[kSampleCount / 2];
  const double solves = static_cast<double>(median.solves);

  std::cout << "workload=" << fixture.name
            << " fixture_hash=" << std::hex << std::setw(16)
            << std::setfill('0') << fixture.hash << std::dec
            << " voxels=" << fixture.voxels.size()
            << " expected_moves=" << fixture.expected_moves
            << " samples=" << kSampleCount
            << " median_sample_solves=" << median.solves
            << " median_exact_solves_per_second="
            << static_cast<uint64_t>(solves / median.seconds)
            << " median_global_dynamic_states_per_second="
            << static_cast<uint64_t>(median.expanded / median.seconds)
            << " median_attempted_dynamic_successors_per_second="
            << static_cast<uint64_t>(median.generated / median.seconds)
            << " median_local_player_states_per_second="
            << static_cast<uint64_t>(median.local_expanded / median.seconds)
            << " median_attempted_command_simulations_per_second="
            << static_cast<uint64_t>(median.command_transitions / median.seconds)
            << " global_dynamic_states_per_solve="
            << median.expanded / median.solves
            << " attempted_dynamic_successors_per_solve="
            << median.generated / median.solves
            << " transpositions_per_solve="
            << median.transpositions / median.solves
            << " local_player_states_per_solve="
            << median.local_expanded / median.solves
            << " attempted_command_simulations_per_solve="
            << median.command_transitions / median.solves
            << " full_physics_transitions_per_solve="
            << median.full_physics_transitions / median.solves
            << " median_sample_seconds=" << median.seconds << '\n';
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const std::string path = argc > 1
        ? argv[1]
        : "engine/benchmarks/fixtures/mixed_3d_427.csv";
    return Run(path);
  } catch (const std::exception& error) {
    std::cerr << "search benchmark failed: " << error.what() << '\n';
    return 1;
  }
}
