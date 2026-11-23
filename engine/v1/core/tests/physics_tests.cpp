#include "voxelbench/physics.hpp"
#include "voxelbench/search.hpp"

#include <algorithm>
#include <vector>
#include <cstring>
#include <cstdlib>
#include <iostream>
#include <memory>

namespace {

int failures = 0;
int tests_run = 0;
const char* current_test = "";

void Run(void (*test)(), const char* name) {
  current_test = name;
  ++tests_run;
  test();
}

void Check(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL [" << current_test << "]: " << message << '\n';
    ++failures;
  }
}

uint32_t Role(const char* value) {
  int32_t length = 0;
  while (value[length] != '\0') ++length;
  return voxelbench::hash_role(reinterpret_cast<const uint8_t*>(value), length);
}

struct ObserverTrace {
  int32_t calls = 0;
  int32_t ticks[4]{};
  int32_t goal_x[4]{};
};

void CaptureObserverFrame(
    const voxelbench::Voxel* voxels,
    int32_t count,
    const voxelbench::MotionState* state,
    void* context) {
  ObserverTrace* trace = static_cast<ObserverTrace*>(context);
  if (trace->calls >= 4) return;
  const int32_t frame = trace->calls++;
  trace->ticks[frame] = state->tick;
  trace->goal_x[frame] = -1;
  for (int32_t index = 0; index < count; ++index) {
    if (voxels[index].role == Role("goal")) {
      trace->goal_x[frame] = voxels[index].x;
      break;
    }
  }
}

void TestSimplePush() {
  voxelbench::Voxel voxels[] = {
      {2, 2, -7, Role("player"), -1},
      {2, 1, -7, Role("pushable"), -1},
      {2, 2, -8, Role("floor"), -1},
      {2, 1, -8, Role("floor"), -1},
      {2, 0, -8, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 5, 5, 5, 0) == 0, "push command should run");
  Check(voxels[0].x == 2 && voxels[0].y == 1 && voxels[0].z == -7,
        "player should enter the pushed voxel's old cell without changing Z");
  Check(voxels[1].x == 2 && voxels[1].y == 0 && voxels[1].z == -7,
        "pushable should move one cell without changing Z");
}

void TestWrappingPushMovesPlayerSupport() {
  for (const bool remote_slope : {false, true}) {
    for (const bool wrapped : {false, true}) {
      std::vector<voxelbench::Voxel> voxels = {
          {2, 3, 2, Role("player"), -1},
          {2, 3, 1, Role("weightless-pushable"), 53},
          {1, 2, 1, Role("weightless-pushable"), 17},
          {1, 3, 1, Role("weightless-pushable"), 17},
          {1, 4, 1, Role("weightless-pushable"), 17},
          {2, 2, 1, Role("weightless-pushable"), 17},
          {2, 2, 2, Role("weightless-pushable"), 17},
      };
      if (wrapped) voxels.push_back({2, 4, 1, Role("weightless-pushable"), 17});
      const size_t dynamic_count = voxels.size();
      for (int32_t y = 0; y < 6; ++y) {
        for (int32_t x = 0; x < 6; ++x) {
          voxels.push_back({x, y, 0,
              Role(remote_slope && x == 5 && y == 5 ? "ice-slope-up" : "floor"), -1});
        }
      }
      const auto initial = voxels;
      Check(voxelbench::simulate_turn(
                voxels.data(), static_cast<int32_t>(voxels.size()), 6, 6, 0) == 0,
            "wrapping push command should complete");
      for (size_t i = 0; i < voxels.size(); ++i) {
        Check(voxels[i].x == initial[i].x && voxels[i].z == initial[i].z &&
                  voxels[i].y == initial[i].y - (wrapped && i < dynamic_count ? 1 : 0),
              "player and both bodies move together only when the support joins the push");
      }
    }
  }
}

void TestPlayerGateRisesWhenPlayerApproaches() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {0, 5, 1, Role("player"), -1},
      {0, 3, 1, Role("player-gate"), 0},
      {0, 3, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 5, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 6, 6, 0) ==
            voxelbench::TickResult::kMore,
        "player-gate approach should schedule a mechanism tick");
  Check(voxels[0].y == 4,
        "player should approach a lowered player gate");
  Check(voxels[1].generic_id == 0,
        "player gate should remain lowered in the movement frame");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 6, 6, 0) ==
            voxelbench::TickResult::kComplete,
        "player-gate mechanism tick should complete the command");
  Check(voxels[1].generic_id == 1,
        "player gate should become a raised cube one tick later");
}

void TestPlayerGateBlockedByEveryPushableFamily() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::reset_workspace(&workspace);
  for (const char* role : {"pushable", "weightless-pushable", "floating-floor"}) {
    voxelbench::Voxel voxels[] = {
        {2, 4, 1, Role("player"), -1},
        {2, 3, 1, Role(role), Role(role) == Role("weightless-pushable") ? 47 : -1},
        {2, 2, 1, Role("player-gate"), 0},
        {2, 0, 0, Role("floor"), -1},
        {2, 1, 0, Role("floor"), -1},
        {2, 2, 0, Role("floor"), -1},
        {2, 3, 0, Role("floor"), -1},
        {2, 4, 0, Role("floor"), -1},
        {2, 5, 0, Role("floor"), -1},
    };
    for (int32_t command = 1; command <= 3; ++command) {
      Check(voxelbench::simulate_command(
                &workspace, &state, voxels, 9, 6, 6, 0) == 0,
            "pushing a body through a lowered gate should run");
      Check(state.tick == (command == 3 ? 2 : 1),
            "an occupied gate must not schedule a spurious raising tick");
      Check(voxels[0].y == 4 - command && voxels[0].z == 1 &&
                voxels[1].y == 3 - command && voxels[1].z == 1 &&
                voxels[1].role == Role(role),
            "the pushable body and player should cross the gate without changing height");
      Check(voxels[2].x == 2 && voxels[2].y == 2 && voxels[2].z == 1 &&
                voxels[2].generic_id == (command == 3 ? 1 : 0),
            "the gate should stay down while occupied, then raise after the player leaves");
    }
  }
}

void TestPlayerIceSlide() {
  voxelbench::Voxel voxels[] = {
      {2, 4, 1, Role("player"), -1},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("ice"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 0, Role("ice"), -1},
      {2, 0, 0, Role("solid"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 6, 5, 5, 0) == 0, "ice command should run");
  Check(voxels[0].x == 2 && voxels[0].y == 0,
        "player should cross the Ice strip and stop on normal floor");
}

void TestApproachingIceFromWallDoesNotStartSlidingEarly() {
  voxelbench::Voxel voxels[] = {
      {2, 5, 2, Role("player"), -1},
      {2, 5, 1, Role("solid"), -1},
      {2, 4, 1, Role("solid"), -1},
      {2, 3, 1, Role("ice"), -1},
      {2, 2, 1, Role("ice"), -1},
      {2, 1, 1, Role("ice"), -1},
      {2, 0, 1, Role("solid"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 7, 6, 6, 0) == 0,
        "approaching Ice across a wall top should run");
  Check(voxels[0].y == 4 && voxels[0].z == 2,
        "the command should stop before the player actually enters Ice");
}

void TestSlidingMomentumEntersRampSide() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (int32_t side = 0; side < 2; ++side) {
    voxelbench::Voxel voxels[] = {
        {2, 5, 2, Role("player"), -1},
        {2, 5, 1, Role("ice"), -1},
        {2, 4, 1, Role("ice"), -1},
        {2, 3, 1, Role("ice"), -1},
        {2, 2, 1, Role(side == 0 ? "ice-slope-left" : "ice-slope-right"), -1},
        {1, 2, 0, Role("floor"), -1},
        {3, 2, 0, Role("floor"), -1},
    };
    voxelbench::Voxel final_only[7];
    std::memcpy(final_only, voxels, sizeof(voxels));
    const int32_t exit_x = side == 0 ? 3 : 1;
    voxelbench::reset_workspace(&workspace);
    voxelbench::reset_motion_state(&state);
    for (int32_t tick = 1; tick <= 4; ++tick) {
      const auto result = voxelbench::step_tick(
          &workspace, &state, voxels, 7, 6, 6, 0);
      Check(result != voxelbench::TickResult::kInvalid,
            "side-entry slide should advance successfully");
      Check(state.tick == tick &&
                voxels[0].x == (tick < 4 ? 2 : exit_x) &&
                voxels[0].y == (tick < 4 ? 5 - tick : 2) &&
                voxels[0].z == (tick < 4 ? 2 : 1),
            "slide should enter the ramp level, then turn downhill next tick");
    }
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, 7, 6, 6, 0) ==
              voxelbench::TickResult::kComplete && state.tick == 4,
          "side-entry slide should finish after exactly four observable ticks");
    Check(voxelbench::simulate_turn(final_only, 7, 6, 6, 0) == 0 &&
              final_only[0].x == exit_x && final_only[0].y == 2 &&
              final_only[0].z == 1,
          "final-state API should agree with the side-entry tick trace");
  }
}

void TestWalkingCannotEnterRampSide() {
  for (int32_t side = 0; side < 2; ++side) {
    for (int32_t icy_support = 0; icy_support < 2; ++icy_support) {
      voxelbench::Voxel voxels[] = {
          {2, 3, 2, Role("player"), -1},
          {2, 3, 1, Role(icy_support ? "ice" : "solid"), -1},
          {2, 2, 1, Role(side == 0 ? "ice-slope-left" : "ice-slope-right"), -1},
          {1, 2, 0, Role("floor"), -1},
          {3, 2, 0, Role("floor"), -1},
      };
      Check(voxelbench::simulate_turn(voxels, 5, 6, 6, 0) == 0 &&
                voxels[0].x == 2 && voxels[0].y == 3 && voxels[0].z == 2,
            "walking onto a ramp side stays blocked even when standing on Ice");
    }
  }
}

void TestRampSideSlideStillCollidesWithSolids() {
  voxelbench::Voxel voxels[] = {
      {2, 5, 2, Role("player"), -1},
      {2, 5, 1, Role("ice"), -1},
      {2, 4, 1, Role("ice"), -1},
      {2, 3, 1, Role("ice"), -1},
      {2, 2, 1, Role("ice-slope-left"), -1},
      {2, 2, 2, Role("solid"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 6, 6, 6, 0) == 0 &&
            voxels[0].x == 2 && voxels[0].y == 3 && voxels[0].z == 2,
        "sliding momentum must not bypass a solid above the destination ramp");
}

void TestRampCrestPushesOnlyUnblockedWeightlessChains() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::reset_workspace(&workspace);
  // Crossing a 64-bit frontier boundary and reversing object storage exercise
  // both traversal orders and scratch cleanup across successive commands.
  for (const int32_t length : {1, 65}) {
    for (const bool reverse : {false, true}) {
      for (const bool blocked : {false, true}) {
        voxelbench::Voxel voxels[256];
        int32_t count = 0;
        const int32_t height = length + 5;
        voxels[count++] = {0, length + 2, 1, Role("player"), -1};
        for (int32_t index = 0; index < length; ++index) {
          const int32_t y = reverse ? index + 1 : length - index;
          voxels[count++] = {0, y, 2, Role("weightless-pushable"), 1000 + y};
        }
        for (int32_t y = 0; y < height; ++y) {
          voxels[count++] = {0, y, 0, Role("floor"), -1};
        }
        for (int32_t y = 0; y <= length; ++y) {
          voxels[count++] = {0, y, 1, Role("solid"), -1};
        }
        voxels[count++] = {0, length + 1, 1, Role("ice-slope-up"), -1};
        if (blocked) voxels[count++] = {0, 0, 2, Role("solid"), -1};
        Check(voxelbench::simulate_command(
                  &workspace, &state, voxels, count, 1, height, 0) == 0,
              "ramp-crest chain command should complete");
        Check(state.tick == 2 && voxels[0].x == 0 &&
                  voxels[0].y == (blocked ? length + 2 : length) &&
                  voxels[0].z == (blocked ? 1 : 2),
              "the crest should push a clear chain or reflect from a blocked one");
        for (int32_t index = 1; index <= length; ++index) {
          Check(voxels[index].x == 0 && voxels[index].z == 2 &&
                    voxels[index].y == voxels[index].generic_id - 1000 -
                        (blocked ? 0 : 1),
                "crest contact must move the whole chain exactly once or none of it");
        }
      }
    }
  }
}

void TestSparseStackCarryIgnoresUnrelatedSlopes() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::reset_workspace(&workspace);
  for (const bool remote_slope : {false, true}) {
    for (const bool shares_player : {false, true}) {
      for (const bool slippery_start : {false, true}) {
        voxelbench::Voxel voxels[80];
        int32_t count = 0;
        voxels[count++] = {0, 5, 2, Role("player"), -1};
        for (int32_t x = 0; x < 2; ++x) {
          for (int32_t y = 2; y <= 4; ++y) {
            if (x != 0 || y != 3) {
              voxels[count++] = {x, y, 2, Role("weightless-pushable"), 17};
            }
            voxels[count++] = {x, y, 3, Role("weightless-pushable"), 39};
          }
        }
        if (shares_player) {
          voxels[count++] = {0, 5, 3, Role("weightless-pushable"), 39};
        }
        const int32_t dynamic_count = count;
        for (int32_t x = 0; x < 6; ++x) {
          for (int32_t y = 0; y < 6; ++y) {
            voxels[count++] = {x, y, 0,
                Role(remote_slope && x == 5 && y == 5
                    ? "ice-slope-up" : "floor"), -1};
          }
        }
        for (int32_t x = 0; x < 2; ++x) {
          for (int32_t y = 1; y <= 4; ++y) {
            voxels[count++] = {x, y, 1,
                Role(slippery_start && y >= 2 ? "ice" : "solid"), -1};
          }
        }
        voxels[count++] = {0, 5, 1, Role("solid"), -1};
        voxelbench::Voxel before[80];
        std::memcpy(before, voxels, sizeof(voxelbench::Voxel) *
            static_cast<size_t>(count));
        Check(voxelbench::simulate_command(
                  &workspace, &state, voxels, count, 6, 6, 0) == 0 &&
                  state.tick == 1,
              "a sparse carried stack should stop with its grounded carrier");
        for (int32_t index = 0; index < count; ++index) {
          Check(voxels[index].x == before[index].x &&
                    voxels[index].z == before[index].z &&
                    voxels[index].y == before[index].y -
                        (index < dynamic_count ? 1 : 0),
                "the shared player/box support should carry every rider cell once");
        }
      }
    }
  }
}

void TestTallStacksFollowRampCarrierTicks() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (int32_t scenario = 0; scenario < 3; ++scenario) {
    const bool player_carrier = scenario != 0;
    const bool downhill = scenario == 2;
    for (const int32_t boxes : {2, 3}) {
      std::vector<voxelbench::Voxel> start = {
          {0, player_carrier && !downhill ? 4 : 5,
              downhill ? 4 : 1, Role("player"), -1},
      };
      for (int32_t box = 0; box < boxes; ++box) {
        for (int32_t layer = 0; layer < 2; ++layer) {
          start.push_back({0, downhill ? 5 : 4,
              (downhill ? 5 : player_carrier ? 2 : 1) + box * 2 + layer,
              Role("weightless-pushable"), box});
        }
      }
      const int32_t dynamic_count = static_cast<int32_t>(start.size());
      for (int32_t y = 0; y < 6; ++y) {
        for (int32_t x = 0; x < 6; ++x) {
          start.push_back({x, y, 0, Role("floor"), -1});
        }
      }
      for (int32_t y = downhill ? 2 : 0; y <= (downhill ? 5 : 3); ++y) {
        const int32_t top = downhill ? (y == 5 ? 3 : y - 1)
            : (y == 0 ? 3 : 4 - y);
        for (int32_t z = 1; z <= top; ++z) {
          const bool ramp = z == top && (downhill ? y < 5 : y > 0);
          start.push_back({0, y, z,
              Role(ramp ? downhill ? "ice-slope-down" : "ice-slope-up" : "wall"), -1});
        }
      }
      for (const bool reversed : {false, true}) {
        for (const bool prepared : {false, true}) {
          auto voxels = start;
          if (reversed) std::reverse(voxels.begin(), voxels.begin() + dynamic_count);
          const auto initial = voxels;
          const int32_t count = static_cast<int32_t>(voxels.size());
          voxelbench::reset_workspace(&workspace);
          voxelbench::reset_motion_state(&state);
          if (prepared) {
            Check(voxelbench::prepare_scene(
                      &workspace, voxels.data(), count, 6, 6, dynamic_count),
                  "ramp stack should prepare for search");
          }
          auto result = voxelbench::TickResult::kInvalid;
          for (int32_t tick = 1; tick <= 4; ++tick) {
            result = voxelbench::step_tick(
                &workspace, &state, voxels.data(), count, 6, 6, 0);
            Check(state.tick == tick && (tick < 4
                      ? result == voxelbench::TickResult::kMore
                      : result == voxelbench::TickResult::kComplete ||
                        result == voxelbench::TickResult::kMore),
                  "a ramp stack must expose four synchronized movement ticks");
            for (int32_t i = 0; i < count; ++i) {
              const size_t index = static_cast<size_t>(i);
              const bool player = initial[index].role == Role("player");
              const int32_t horizontal = i >= dynamic_count ? 0
                  : player && !player_carrier ? 1 : tick;
              const int32_t vertical = i >= dynamic_count || (player && !player_carrier)
                  ? 0 : downhill ? -(tick - 1) : (tick < 3 ? tick : 3);
              Check(voxels[index].x == initial[index].x &&
                        voxels[index].y == initial[index].y - horizontal &&
                        voxels[index].z == initial[index].z + vertical &&
                        voxels[index].generic_id == initial[index].generic_id,
                    "all passenger cells must follow the carrier's full ramp transform");
            }
          }
          const auto animated_final = voxels;
          if (result == voxelbench::TickResult::kMore) {
            Check(voxelbench::step_tick(
                      &workspace, &state, voxels.data(), count, 6, 6, 0) ==
                      voxelbench::TickResult::kComplete && state.tick == 4 &&
                      std::memcmp(voxels.data(), animated_final.data(),
                          voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                  "a boundary completion check must not invent a fifth movement frame");
          }
          voxels = initial;
          voxelbench::reset_workspace(&workspace);
          if (prepared) {
            Check(voxelbench::prepare_scene(
                      &workspace, voxels.data(), count, 6, 6, dynamic_count),
                  "ramp stack should reprepare for a quiescent successor");
          }
          Check(voxelbench::simulate_quiescent_turn(
                    &workspace, voxels.data(), count, 6, 6, 0) == 0,
                "search successor for a ramp stack should run");
          Check(std::memcmp(voxels.data(), animated_final.data(),
                    voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "prepared search and animated ramp stacks must finish identically");
        }
      }
    }
  }
}

void TestCloneStacksReceiveOneRampCommand() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  constexpr int32_t heights[] = {0, 1, 2, 3, 3, 2, 1};
  constexpr int32_t ids[] = {23, 7, 41, 19};
  constexpr const char* slopes[] = {
      "ice-slope-up", "ice-slope-right", "ice-slope-down", "ice-slope-left"};
  constexpr int32_t elevations[] = {2, 3, 4, 4, 3, 2, 1};
  for (const int32_t actors : {2, 3, 4}) {
    for (const int32_t layers : {1, 2}) {
      for (int32_t rotation = 0; rotation < 4; ++rotation) {
        std::vector<voxelbench::Voxel> start = {{2, 7, 1, Role("player"), -1}};
        for (int32_t actor = 0; actor < actors; ++actor) {
          for (int32_t layer = 0; layer < layers; ++layer) {
            start.push_back({5, 7, 1 + actor * layers + layer, Role("clone"), ids[actor]});
          }
        }
        const int32_t dynamic_count = static_cast<int32_t>(start.size());
        for (int32_t y = 0; y < 10; ++y) {
          for (int32_t x = 0; x < 10; ++x) {
            start.push_back({x, y, 0, Role("floor"), -1});
          }
        }
        for (int32_t y = 1; y <= 6; ++y) {
          for (int32_t z = 1; z <= heights[y]; ++z) {
            start.push_back({5, y, z,
                z == heights[y] ? Role(slopes[(rotation + (y <= 3 ? 2 : 0)) % 4])
                                : Role("wall"), -1});
          }
        }
        for (auto& voxel : start) for (int32_t turn = 0; turn < rotation; ++turn) {
          const int32_t x = voxel.x;
          voxel.x = 9 - voxel.y;
          voxel.y = x;
        }
        for (const bool reversed : {false, true}) {
          for (const bool prepared : {false, true}) {
            auto voxels = start;
            if (reversed) std::reverse(voxels.begin(), voxels.begin() + dynamic_count);
            const auto initial = voxels;
            const int32_t count = static_cast<int32_t>(voxels.size());
            voxelbench::reset_workspace(&workspace);
            voxelbench::reset_motion_state(&state);
            if (prepared) Check(voxelbench::prepare_scene(
                &workspace, voxels.data(), count, 10, 10, dynamic_count),
                "clone ramp stack should prepare for search");
            auto result = voxelbench::TickResult::kInvalid;
            for (int32_t tick = 1; tick <= 7; ++tick) {
              result = voxelbench::step_tick(
                  &workspace, &state, voxels.data(), count, 10, 10, rotation);
              Check(state.tick == tick && result != voxelbench::TickResult::kInvalid,
                  "clone stack must expose exactly one synchronized transform per tick");
              for (int32_t i = 0; i < count; ++i) {
                const size_t index = static_cast<size_t>(i);
                auto expected = initial[index];
                if (i < dynamic_count) {
                  constexpr int32_t dx[] = {0, 1, 0, -1};
                  constexpr int32_t dy[] = {-1, 0, 1, 0};
                  const bool clone = expected.role == Role("clone");
                  const int32_t distance = clone ? tick : 1;
                  expected.x += dx[rotation] * distance;
                  expected.y += dy[rotation] * distance;
                  if (clone) expected.z += elevations[tick - 1] - 1;
                }
                Check(std::memcmp(&voxels[index], &expected, sizeof(expected)) == 0,
                    "every clone passenger follows the carrier once without changing its ID");
              }
            }
            const auto final = voxels;
            if (result == voxelbench::TickResult::kMore) {
              Check(voxelbench::step_tick(
                  &workspace, &state, voxels.data(), count, 10, 10, rotation) ==
                      voxelbench::TickResult::kComplete && state.tick == 7,
                  "clone ramp stack must not add an eighth animation tick");
            }
            voxels = initial;
            voxelbench::reset_workspace(&workspace);
            if (prepared) Check(voxelbench::prepare_scene(
                &workspace, voxels.data(), count, 10, 10, dynamic_count),
                "clone stack should reprepare for a final-state successor");
            Check(voxelbench::simulate_quiescent_turn(
                &workspace, voxels.data(), count, 10, 10, rotation) == 0 &&
                std::memcmp(voxels.data(), final.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "prepared search and animated clone stacks must finish identically");
          }
        }
      }
    }
  }
}

void TestRampStackCeilingsReflectTogether() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  constexpr const char* slopes[] = {
      "ice-slope-up", "ice-slope-right", "ice-slope-down", "ice-slope-left"};
  for (const bool clones : {false, true}) {
    for (const int32_t blocked_step : {2, 3}) {
      for (int32_t rotation = 0; rotation < 4; ++rotation) {
        std::vector<voxelbench::Voxel> initial;
        for (int32_t layer = 0; layer < 3; ++layer) {
          const bool player = layer == (clones ? 2 : 0);
          initial.push_back({2, 4, layer + 1,
              Role(player ? "player" : clones ? "clone" : "weightless-pushable"),
              player ? -1 : layer == 1 ? 71 : 29});
        }
        for (int32_t y = 0; y < 6; ++y) for (int32_t x = 0; x < 6; ++x) {
          initial.push_back({x, y, 0, Role("floor"), -1});
        }
        for (int32_t step = 1; step <= blocked_step; ++step) {
          for (int32_t z = 1; z <= step; ++z) initial.push_back({2, 4 - step, z,
              Role(z == step ? slopes[rotation] : "solid"), -1});
        }
        // Step 2 hits the destination ceiling; step 3 hits the ceiling above
        // the source even though its diagonal destination is otherwise clear.
        initial.push_back({2, 2, blocked_step + 3, Role("solid"), -1});
        for (auto& voxel : initial) for (int32_t turn = 0; turn < rotation; ++turn) {
          const int32_t x = voxel.x;
          voxel.x = 5 - voxel.y;
          voxel.y = x;
        }
        for (const bool reversed : {false, true}) {
          for (const bool prepared : {false, true}) {
            auto voxels = initial;
            if (reversed) std::reverse(voxels.begin(), voxels.begin() + 3);
            const auto start = voxels;
            const int32_t count = static_cast<int32_t>(voxels.size());
            voxelbench::reset_workspace(&workspace);
            voxelbench::reset_motion_state(&state);
            if (prepared) Check(voxelbench::prepare_scene(
                &workspace, voxels.data(), count, 6, 6, 3), "ramp ceiling should prepare");
            for (int32_t tick = 1; tick <= 2 * (blocked_step - 1); ++tick) {
              const auto result = voxelbench::step_tick(
                  &workspace, &state, voxels.data(), count, 6, 6, rotation);
              Check(result != voxelbench::TickResult::kInvalid && state.tick == tick,
                  "ramp ceiling should reflect without adding idle ticks");
              const int32_t distance = tick < blocked_step ? tick : 2 * (blocked_step - 1) - tick;
              for (size_t index = 0; index < voxels.size(); ++index) {
                auto expected = start[index];
                if (index < 3) {
                  constexpr int32_t dx[] = {0, 1, 0, -1};
                  constexpr int32_t dy[] = {-1, 0, 1, 0};
                  expected.x += dx[rotation] * distance;
                  expected.y += dy[rotation] * distance;
                  expected.z += distance;
                }
                Check(std::memcmp(&voxels[index], &expected, sizeof(expected)) == 0,
                    "the complete stack must reflect before penetrating source or destination ceilings");
              }
            }
            const auto final = voxels;
            voxels = start;
            voxelbench::reset_workspace(&workspace);
            if (prepared) Check(voxelbench::prepare_scene(
                &workspace, voxels.data(), count, 6, 6, 3), "ramp ceiling should reprepare");
            Check(voxelbench::simulate_quiescent_turn(
                &workspace, voxels.data(), count, 6, 6, rotation) == 0 &&
                std::memcmp(voxels.data(), final.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "animated and prepared ceiling reflections must agree");
          }
        }
      }
    }
  }
}

void TestBlockedClonePassengerFallsAfterSupportLeaves() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  std::vector<voxelbench::Voxel> start = {
      {2, 4, 1, Role("clone"), 71}, {2, 4, 2, Role("clone"), 29},
      {2, 4, 3, Role("player"), -1}, {2, 3, 3, Role("solid"), -1}};
  for (int32_t y = 0; y < 6; ++y) for (int32_t x = 0; x < 6; ++x) {
    start.push_back({x, y, 0, Role("floor"), -1});
  }
  for (const bool prepared : {false, true}) {
    auto voxels = start;
    const int32_t count = static_cast<int32_t>(voxels.size());
    voxelbench::reset_workspace(&workspace);
    voxelbench::reset_motion_state(&state);
    if (prepared) Check(voxelbench::prepare_scene(
        &workspace, voxels.data(), count, 6, 6, 3), "blocked passenger should prepare");
    for (int32_t tick = 1; tick <= 3; ++tick) {
      const auto result = voxelbench::step_tick(
          &workspace, &state, voxels.data(), count, 6, 6, 0);
      Check(result != voxelbench::TickResult::kInvalid && state.tick == tick &&
                voxels[0].y == 3 && voxels[1].y == 3 &&
                voxels[2].y == 4 && voxels[2].z == 4 - tick,
            "a denied player carry falls one cell per following tick without moving again");
    }
  }
}

void TestRampPassengersStopWithGroundedCarrier() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (const int32_t boxes : {2, 3}) {
    for (const bool continuing_remote_slide : {false, true}) {
      std::vector<voxelbench::Voxel> start = {{0, 7, 1, Role("player"), -1}};
      for (int32_t box = 0; box < boxes; ++box) {
        for (int32_t layer = 0; layer < 2; ++layer) {
          start.push_back({0, 6, 1 + box * 2 + layer,
              Role("weightless-pushable"), box});
        }
      }
      if (continuing_remote_slide) {
        start.push_back({3, 7, 1, Role("clone"), 42});
      }
      const int32_t dynamic_count = static_cast<int32_t>(start.size());
      for (int32_t y = 0; y < 8; ++y) {
        for (int32_t x = 0; x < 8; ++x) {
          start.push_back({x, y, 0, Role(x == 3 && y >= 2 ? "ice" : "floor"), -1});
        }
      }
      for (int32_t y = 0; y <= 5; ++y) {
        const int32_t top = y < 3 ? 3 : 6 - y;
        for (int32_t z = 1; z <= top; ++z) {
          start.push_back({0, y, z,
              Role(z == top && y >= 3 ? "ice-slope-up" : "wall"), -1});
        }
      }
      start.push_back({3, 0, 1, Role("wall"), -1});
      for (const bool reversed : {false, true}) {
        for (const bool prepared : {false, true}) {
          auto voxels = start;
          if (reversed) std::reverse(voxels.begin(), voxels.begin() + dynamic_count);
          const auto initial = voxels;
          const int32_t count = static_cast<int32_t>(voxels.size());
          voxelbench::reset_workspace(&workspace);
          voxelbench::reset_motion_state(&state);
          if (prepared) {
            Check(voxelbench::prepare_scene(
                      &workspace, voxels.data(), count, 8, 8, dynamic_count),
                  "grounded ramp stack should prepare for search");
          }
          auto result = voxelbench::TickResult::kMore;
          for (int32_t calls = 0; calls < 20 && result == voxelbench::TickResult::kMore; ++calls) {
            result = voxelbench::step_tick(
                &workspace, &state, voxels.data(), count, 8, 8, 0);
            const int32_t steps = std::min(state.tick, 4);
            for (int32_t i = 0; i < dynamic_count; ++i) {
              const size_t index = static_cast<size_t>(i);
              if (initial[index].role != Role("weightless-pushable")) continue;
              Check(voxels[index].x == initial[index].x &&
                        voxels[index].y == initial[index].y - steps &&
                        voxels[index].z == initial[index].z + std::min(steps, 3),
                    "passengers must stop stacked on the first ordinary ramp landing");
            }
          }
          Check(result == voxelbench::TickResult::kComplete,
                "grounded ramp passengers must finish even while another body slides");
          const auto animated_final = voxels;
          voxels = initial;
          voxelbench::reset_workspace(&workspace);
          if (prepared) {
            Check(voxelbench::prepare_scene(
                      &workspace, voxels.data(), count, 8, 8, dynamic_count),
                  "grounded ramp stack should reprepare for search");
          }
          Check(voxelbench::simulate_quiescent_turn(
                    &workspace, voxels.data(), count, 8, 8, 0) == 0 &&
                    std::memcmp(voxels.data(), animated_final.data(),
                        voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "animated and prepared ramp landing successors must agree");
        }
      }
    }
  }
}

void TestBlockedCloneRampMomentumCompletes() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  constexpr int32_t dx[] = {0, 1, 0, -1};
  constexpr int32_t dy[] = {-1, 0, 1, 0};
  const char* slopes[] = {"ice-slope-up", "ice-slope-right",
                           "ice-slope-down", "ice-slope-left"};
  for (int32_t rotation = 0; rotation < 4; ++rotation) {
    std::vector<voxelbench::Voxel> start = {{5, 10, 1, Role("player"), -1}};
    for (int32_t x = 5; x <= 8; ++x) {
      for (int32_t y = 6; y <= 9; ++y) {
        if (x == 5 || x == 8 || y == 6 || y == 9) {
          start.push_back({x, y, 1, Role("clone"), 0});
        }
      }
    }
    const int32_t dynamic_count = static_cast<int32_t>(start.size());
    for (int32_t x = 0; x < 16; ++x) {
      for (int32_t y = 0; y < 16; ++y) {
        start.push_back({x, y, 0, Role("floor"), -1});
      }
    }
    for (int32_t x = 5; x <= 8; ++x) {
      start.push_back({x, 4, 1, Role("wall"), -1});
      start.push_back({x, 4, 2, Role("wall"), -1});
      start.push_back({x, 5, 1, Role(slopes[rotation]), -1});
    }
    for (auto& voxel : start) {
      for (int32_t turn = 0; turn < rotation; ++turn) {
        const int32_t old_x = voxel.x;
        voxel.x = 15 - voxel.y;
        voxel.y = old_x;
      }
    }
    for (const bool reversed : {false, true}) {
      for (const bool prepared : {false, true}) {
        for (const bool resumed : {false, true}) {
          auto voxels = start;
          if (reversed) std::reverse(voxels.begin(), voxels.begin() + dynamic_count);
          const auto initial = voxels;
          const int32_t count = static_cast<int32_t>(voxels.size());
          const auto prepare = [&]() {
            voxelbench::reset_workspace(&workspace);
            if (prepared) {
              Check(voxelbench::prepare_scene(
                        &workspace, voxels.data(), count, 16, 16, dynamic_count),
                    "blocked clone ramp should prepare for search or resume");
            }
          };
          prepare();
          voxelbench::reset_motion_state(&state);
          Check(voxelbench::step_command_tick(
                    &workspace, &state, voxels.data(), count, 16, 16, rotation) ==
                    voxelbench::TickResult::kMore && state.tick == 1,
                "clone and player must share the initial ramp entry tick");
          for (int32_t i = 0; i < count; ++i) {
            const size_t index = static_cast<size_t>(i);
            const bool actor = i < dynamic_count;
            Check(voxels[index].x == initial[index].x + (actor ? dx[rotation] : 0) &&
                      voxels[index].y == initial[index].y + (actor ? dy[rotation] : 0) &&
                      voxels[index].z == initial[index].z +
                          (initial[index].role == Role("clone") ? 1 : 0),
                  "the whole clone climbs once while the player steps behind it");
          }
          const auto expected = voxels;
          if (resumed) prepare();
          Check(voxelbench::step_command_tick(
                    &workspace, &state, voxels.data(), count, 16, 16, rotation) ==
                    voxelbench::TickResult::kComplete && state.tick == 1 &&
                    std::memcmp(voxels.data(), expected.data(),
                        voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "a blocked ramp reflection must complete without an idle retry loop");
          voxels = initial;
          prepare();
          Check(voxelbench::simulate_quiescent_turn(
                    &workspace, voxels.data(), count, 16, 16, rotation) == 0 &&
                    std::memcmp(voxels.data(), expected.data(),
                        voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "prepared search must settle to the same blocked clone frame");
        }
      }
    }
  }
}

void TestInterlockedPushDoesNotInventMomentum() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  const char* ramp_roles[] = {"solid", "ice-slope-up", "ice-slope-right",
                              "ice-slope-down", "ice-slope-left"};
  for (const char* ramp_role : ramp_roles) {
    for (const bool blocked : {false, true}) {
      for (const bool reverse_order : {false, true}) {
        std::vector<voxelbench::Voxel> voxels;
        for (int32_t x = 0; x < 8; ++x) {
          for (int32_t y = 0; y < 10; ++y) {
            voxels.push_back({x, y, 0, Role("floor"), -1});
          }
        }
        for (int32_t x = 1; x <= 3; ++x) {
          for (int32_t y = 2; y <= 4; ++y) {
            voxels.push_back({x, y, 1, Role("solid"), -1});
            for (int32_t z = 2; z <= 4; ++z) {
              if (y != 3 || z != 3) {
                voxels.push_back({x, y, z, Role("weightless-pushable"), 17});
              }
            }
          }
        }
        for (int32_t x = 1; x <= 5; ++x) {
          voxels.push_back({x, 3, 3, Role("weightless-pushable"), 39});
        }
        voxels.push_back({5, 3, 1, Role("solid"), -1});
        voxels.push_back({5, 4, 1, Role("solid"), -1});
        voxels.push_back({5, 3, 2, Role("weightless-pushable"), 39});
        voxels.push_back({5, 4, 2, Role("player"), -1});
        voxels.push_back({2, 3, 5, Role("weightless-pushable"), 91});
        voxels.push_back({7, 9, 1, Role(ramp_role), -1});
        if (blocked) voxels.push_back({1, 1, 4, Role("solid"), -1});
        if (reverse_order) std::reverse(voxels.begin(), voxels.end());
        const auto before = voxels;
        const int32_t count = static_cast<int32_t>(voxels.size());
        // Reuse the same workspace across changing object orders and scenes.
        Check(voxelbench::simulate_command(&workspace, &state, voxels.data(),
                  count, 8, 10, 0) == 0 && state.tick == 1,
              "interlocked bodies must finish their ordinary push in one tick");
        for (size_t i = 0; i < voxels.size(); ++i) {
          const bool dynamic = before[i].role == Role("player") ||
              before[i].role == Role("weightless-pushable");
          Check(voxels[i].x == before[i].x && voxels[i].z == before[i].z &&
                    voxels[i].y == before[i].y - (dynamic && !blocked ? 1 : 0),
                "a remote ramp cannot add translation or make the stack fall");
        }
      }
    }
  }
}

void TestCarrierMomentumCannotLeakIntoNextScene() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::reset_workspace(&workspace);
  voxelbench::Voxel stack[] = {
      {2, 5, 1, Role("player"), -1},
      {2, 4, 1, Role("weightless-pushable"), 17},
      {2, 4, 2, Role("weightless-pushable"), 39},
      {2, 5, 0, Role("floor"), -1},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("ice"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 0, Role("floor"), -1},
      {5, 5, 0, Role("ice-slope-up"), -1},
  };
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(&workspace, &state, stack, 9, 6, 6, 0) ==
            voxelbench::TickResult::kMore && stack[2].y == 3,
        "the first scene should leave a carried Ice impulse in its workspace");
  voxelbench::Voxel next[] = {
      {0, 5, 1, Role("player"), -1},
      {2, 5, 1, Role("clone"), 0},
      {3, 5, 1, Role("clone"), 1},
      {0, 5, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {2, 5, 0, Role("floor"), -1},
      {2, 4, 0, Role("floor"), -1},
      {3, 5, 0, Role("floor"), -1},
      {3, 4, 0, Role("floor"), -1},
      {3, 3, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_command(
            &workspace, &state, next, 10, 6, 6, 0) == 0 && state.tick == 1,
        "reusing an interrupted workspace must not give a new clone momentum");
  Check(next[0].y == 4 && next[1].y == 4 && next[2].y == 4,
        "all actors in the replacement scene should take only their one command step");
}

void TestBlockedPassengersDoNotAnchorTheirCarrier() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::reset_workspace(&workspace);
  for (const bool remote_slope : {false, true}) {
    for (const bool loses_support : {false, true}) {
      for (const bool stacked : {false, true}) {
        voxelbench::Voxel voxels[80];
        int32_t count = 0;
        voxels[count++] = {2, 4, 1, Role("player"), -1};
        const int32_t rider_y = loses_support ? 3 : 2;
        voxels[count++] = {2, rider_y, 4, Role("weightless-pushable"), 39};
        if (stacked) {
          voxels[count++] = {2, rider_y, 5, Role("weightless-pushable"), 63};
        }
        const int32_t carrier_begin = count;
        for (int32_t x = 1; x <= 2; ++x) {
          for (int32_t y = 2; y <= 3; ++y) {
            for (int32_t z = 1; z <= 3; ++z) {
              voxels[count++] = {x, y, z, Role("weightless-pushable"), 17};
            }
          }
        }
        const int32_t terrain_begin = count;
        voxels[count++] = {2, rider_y - 1, 4, Role("solid"), -1};
        for (int32_t x = 0; x < 6; ++x) {
          for (int32_t y = 0; y < 6; ++y) {
            voxels[count++] = {x, y, 0,
                Role(remote_slope && x == 5 && y == 5
                    ? "ice-slope-up" : "floor"), -1};
          }
        }
        voxelbench::Voxel before[80];
        std::memcpy(before, voxels, sizeof(voxelbench::Voxel) *
            static_cast<size_t>(count));
        voxelbench::reset_motion_state(&state);
        const int32_t expected_ticks = loses_support ? 3 : 1;
        bool complete = false;
        for (int32_t call = 0; call < 8; ++call) {
          const auto result = voxelbench::step_tick(
              &workspace, &state, voxels, count, 6, 6, 0);
          Check(result == voxelbench::TickResult::kMore ||
                    result == voxelbench::TickResult::kComplete,
                "blocked-passenger command should be valid");
          Check(state.tick >= 1 && state.tick <= expected_ticks,
                "the carrier push must precede exactly two falling ticks");
          const int32_t fall = loses_support ? state.tick - 1 : 0;
          for (int32_t index = 0; index < count; ++index) {
            const bool rider = index >= 1 && index < carrier_begin;
            const bool moves = index == 0 ||
                (index >= carrier_begin && index < terrain_begin);
            Check(voxels[index].x == before[index].x &&
                      voxels[index].y == before[index].y - (moves ? 1 : 0) &&
                      voxels[index].z == before[index].z - (rider ? fall : 0) &&
                      voxels[index].role == before[index].role &&
                      voxels[index].generic_id == before[index].generic_id,
                  "each frame must preserve the blocked passenger stack and terrain");
          }
          if (result == voxelbench::TickResult::kComplete) {
            complete = true;
            break;
          }
        }
        Check(complete && state.tick == expected_ticks,
              "blocked passengers should settle in the authored number of ticks");
      }
    }
  }
}

void TestPushableIceSlide() {
  voxelbench::Voxel voxels[] = {
      {2, 4, 1, Role("player"), -1},
      {2, 3, 1, Role("pushable"), 17},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("floor"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 0, Role("ice"), -1},
      {2, 0, 0, Role("solid"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 7, 5, 5, 0) == 0,
        "push onto Ice command should run");
  Check(voxels[0].y == 3, "player should enter the object's vacated cell");
  Check(voxels[1].y == 0 && voxels[1].generic_id == 17,
        "pushed object should slide off Ice while preserving its generic ID");
}

void TestPlayerAndPushedBodySlideTogetherOnIce() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {2, 4, 1, Role("player"), -1},
      {2, 3, 1, Role("weightless-pushable"), 0},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("ice"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 0, Role("ice"), -1},
      {2, 0, 0, Role("solid"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 5, 5, 0) ==
            voxelbench::TickResult::kMore,
        "pushing from Floor onto Ice should retain object momentum");
  Check(state.tick == 1 && voxels[0].y == 3 && voxels[1].y == 2,
        "the initial push should move the player and body one cell");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 5, 5, 0) ==
            voxelbench::TickResult::kMore,
        "the player and pushed body should keep sliding together");
  Check(state.tick == 2 && voxels[0].y == 2 && voxels[1].y == 1,
        "the second Ice tick should advance both horizontal proposals");
}

void TestIceStopsAtObstacle() {
  voxelbench::Voxel voxels[] = {
      {2, 4, 1, Role("player"), -1},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("ice"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 1, Role("solid"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 5, 5, 5, 0) == 0,
        "blocked Ice command should run");
  Check(voxels[0].y == 2, "player should stop on Ice immediately before an obstacle");
}

void TestUnknownRoleBlocks() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("future-role"), 912},
  };
  Check(voxelbench::simulate_turn(voxels, 2, 5, 5, 0) == 0,
        "unknown role command should run");
  Check(voxels[0].y == 2 && voxels[1].generic_id == 912,
        "unknown roles should block and preserve generic IDs");
}

void TestIndependentCloneCommands() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {1, 2, 1, Role("clone"), 0},
      {2, 2, 1, Role("clone"), 1},
      {1, 1, 1, Role("wall"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 10, 3, 3, 0) == 0,
        "clone command should run");
  Check(voxels[0].y == 1,
        "the player should move independently of a blocked clone");
  Check(voxels[1].y == 2,
        "a clone blocked by terrain should remain stationary");
  Check(voxels[2].y == 1,
        "an unblocked clone should still receive the shared command");
}

void TestPlayerAndCloneSlidesFinishIndependently() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState motion;
  for (bool ramps : {false, true}) for (bool swapped : {false, true}) {
    for (int32_t rotation = 0; rotation < 4; ++rotation) {
      for (bool reversed : {false, true}) for (bool prepared : {false, true}) {
        std::vector<voxelbench::Voxel> start = {
            {0, 5, 1, Role(swapped ? "clone" : "player"), swapped ? 71 : -1},
            {3, 5, 1, Role(swapped ? "player" : "clone"), swapped ? -1 : 71},
        };
        if (reversed) std::reverse(start.begin(), start.end());
        for (int32_t y = 0; y < 6; ++y) for (int32_t x = 0; x < 6; ++x) {
          const bool icy = !ramps &&
              ((x == 0 && (y == 3 || y == 4)) || (x == 3 && y == 4));
          start.push_back({x, y, 0, Role(icy ? "ice" : "floor"), -1});
        }
        start.push_back({3, 3, 1, Role("wall"), -1});
        if (ramps) {
          const char* directions[] = {"ice-slope-up", "ice-slope-right",
              "ice-slope-down", "ice-slope-left"};
          start.push_back({0, 4, 1, Role(directions[rotation]), -1});
          start.push_back({0, 3, 1, Role(directions[(rotation + 2) % 4]), -1});
          start.push_back({3, 4, 1, Role(directions[rotation]), -1});
        }
        for (auto& voxel : start) for (int32_t turn = 0; turn < rotation; ++turn) {
          const int32_t x = voxel.x;
          voxel.x = 5 - voxel.y;
          voxel.y = x;
        }
        const auto expected_tick = [&](int32_t tick) {
          auto expected = start;
          constexpr int32_t dx[] = {0, 1, 0, -1};
          constexpr int32_t dy[] = {-1, 0, 1, 0};
          for (size_t index = 0; index < 2; ++index) {
            const bool free_lane = (index == 0) != reversed;
            const int32_t distance = free_lane ? tick : std::min(tick, ramps ? 2 : 1);
            expected[index].x += dx[rotation] * distance;
            expected[index].y += dy[rotation] * distance;
            expected[index].z = ramps && (!free_lane || tick < 3) ? 2 : 1;
          }
          return expected;
        };
        auto voxels = start;
        const int32_t count = static_cast<int32_t>(voxels.size());
        voxelbench::reset_workspace(&workspace);
        voxelbench::reset_motion_state(&motion);
        if (prepared) Check(voxelbench::prepare_scene(
            &workspace, voxels.data(), count, 6, 6, 2), "independent slides should prepare");
        for (int32_t tick = 1; tick <= 3; ++tick) {
          Check(voxelbench::step_tick(&workspace, &motion, voxels.data(), count,
                    6, 6, rotation) == (tick < 3
                        ? voxelbench::TickResult::kMore : voxelbench::TickResult::kComplete),
                "one stopped actor must not end the other actor's slide");
          const auto expected = expected_tick(tick);
          Check(motion.tick == tick &&
                    std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "player and clone must each advance only along their own clear path");
        }
        voxels = start;
        voxelbench::reset_workspace(&workspace);
        if (prepared) Check(voxelbench::prepare_scene(
            &workspace, voxels.data(), count, 6, 6, 2), "independent slides should reprepare");
        const auto expected = expected_tick(3);
        Check(voxelbench::simulate_quiescent_turn(
                  &workspace, voxels.data(), count, 6, 6, rotation) == 0 &&
                  std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
              "search and animated play must agree on independent slide endpoints");
      }
    }
  }
}

void TestCloneCannotWalkOntoDepartingPlayerCargo() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState motion;
  for (int32_t height : {1, 2}) for (int32_t rotation = 0; rotation < 4; ++rotation) {
    for (bool reversed : {false, true}) for (bool prepared : {false, true}) {
      std::vector<voxelbench::Voxel> start = {
          {3, 3, 1, Role("player"), -1},
          {3, 3, 2, Role("weightless-pushable"), 71},
          {3, 4, height + 1, Role("clone"), 29},
      };
      if (reversed) std::reverse(start.begin(), start.end());
      for (int32_t z = 1; z <= height; ++z) start.push_back({3, 4, z, Role("wall"), -1});
      for (int32_t y = 0; y < 6; ++y) for (int32_t x = 0; x < 6; ++x) {
        start.push_back({x, y, 0, Role("floor"), -1});
      }
      for (auto& voxel : start) for (int32_t turn = 0; turn < rotation; ++turn) {
        const int32_t x = voxel.x;
        voxel.x = 5 - voxel.y;
        voxel.y = x;
      }
      auto expected = start;
      for (auto& voxel : expected) if (voxel.role == Role("player") ||
          voxel.role == Role("weightless-pushable")) {
        voxel.x += rotation == 1 ? 1 : rotation == 3 ? -1 : 0;
        voxel.y += rotation == 0 ? -1 : rotation == 2 ? 1 : 0;
      }
      auto voxels = start;
      const int32_t count = static_cast<int32_t>(voxels.size());
      voxelbench::reset_workspace(&workspace);
      voxelbench::reset_motion_state(&motion);
      if (prepared) Check(voxelbench::prepare_scene(
          &workspace, voxels.data(), count, 6, 6, 3), "departing cargo should prepare");
      Check(voxelbench::step_tick(&workspace, &motion, voxels.data(), count, 6, 6, rotation) ==
                voxelbench::TickResult::kComplete && motion.tick == 1 &&
                std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
            "a clone must stay on its wall when the destination foothold departs with the player");
      voxels = start;
      voxelbench::reset_workspace(&workspace);
      if (prepared) Check(voxelbench::prepare_scene(
          &workspace, voxels.data(), count, 6, 6, 3), "departing cargo should reprepare");
      Check(voxelbench::simulate_quiescent_turn(&workspace, voxels.data(), count, 6, 6, rotation) == 0 &&
                std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
            "search must preserve the clone's wall foothold too");
    }
  }
}

void TestCloneCarriesCargoThroughPlayerPassenger() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState motion;
  const char* slopes[] = {"ice-slope-up", "ice-slope-right", "ice-slope-down", "ice-slope-left"};
  for (bool ramp : {false, true}) for (int32_t cargo : {1, 2}) {
    for (int32_t rotation = 0; rotation < 4; ++rotation) {
      for (bool reversed : {false, true}) for (bool prepared : {false, true}) {
        std::vector<voxelbench::Voxel> start = {
            {2, 3, 1, Role("clone"), 29}, {2, 3, 2, Role("player"), -1}};
        for (int32_t i = 0; i < cargo; ++i) start.push_back(
            {2, 3, 3 + i, Role("weightless-pushable"), 71 + i});
        const int32_t dynamic_count = static_cast<int32_t>(start.size());
        if (reversed) std::reverse(start.begin(), start.end());
        for (int32_t y = 0; y < 6; ++y) for (int32_t x = 0; x < 6; ++x) {
          start.push_back({x, y, 0, Role("floor"), -1});
        }
        if (ramp) {
          start.push_back({2, 2, 1, Role(slopes[rotation]), -1});
          start.push_back({2, 1, 1, Role("wall"), -1});
        }
        for (auto& voxel : start) for (int32_t turn = 0; turn < rotation; ++turn) {
          const int32_t x = voxel.x;
          voxel.x = 5 - voxel.y;
          voxel.y = x;
        }
        const auto expected_tick = [&](int32_t tick) {
          auto expected = start;
          for (int32_t i = 0; i < dynamic_count; ++i) {
            auto& voxel = expected[static_cast<size_t>(i)];
            voxel.x += (rotation == 1 ? 1 : rotation == 3 ? -1 : 0) * tick;
            voxel.y += (rotation == 0 ? -1 : rotation == 2 ? 1 : 0) * tick;
            voxel.z += ramp ? 1 : 0;
          }
          return expected;
        };
        auto voxels = start;
        const int32_t count = static_cast<int32_t>(voxels.size());
        voxelbench::reset_workspace(&workspace);
        voxelbench::reset_motion_state(&motion);
        if (prepared) Check(voxelbench::prepare_scene(
            &workspace, voxels.data(), count, 6, 6, dynamic_count), "mixed actor stack should prepare");
        const int32_t ticks = ramp ? 2 : 1;
        for (int32_t tick = 1; tick <= ticks; ++tick) {
          const auto result = voxelbench::step_tick(
              &workspace, &motion, voxels.data(), count, 6, 6, rotation);
          const auto expected = expected_tick(tick);
          Check(result == (tick < ticks ? voxelbench::TickResult::kMore : voxelbench::TickResult::kComplete) &&
                    motion.tick == tick &&
                    std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "cargo above a player must follow the clone's complete transform once per tick");
        }
        voxels = start;
        voxelbench::reset_workspace(&workspace);
        if (prepared) Check(voxelbench::prepare_scene(
            &workspace, voxels.data(), count, 6, 6, dynamic_count), "mixed actor stack should reprepare");
        const auto expected = expected_tick(ticks);
        Check(voxelbench::simulate_quiescent_turn(&workspace, voxels.data(), count, 6, 6, rotation) == 0 &&
                  std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
              "search and animated play must carry the same mixed stack");
      }
    }
  }
}

void TestWideActorsCannotClimbWallsBesideRamps() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState motion;
  const char* slopes[] = {"ice-slope-up", "ice-slope-right", "ice-slope-down", "ice-slope-left"};
  for (bool clone : {false, true}) for (bool blocked : {false, true}) {
    for (int32_t layers : {1, 2}) for (int32_t rotation = 0; rotation < 4; ++rotation) {
      for (bool reversed : {false, true}) for (bool prepared : {false, true}) {
        std::vector<voxelbench::Voxel> start;
        if (clone) start.push_back({0, 5, 1, Role("player"), -1});
        for (int32_t z = 1; z <= layers; ++z) for (int32_t x : {2, 3}) {
          start.push_back({x, 3, z, Role(clone ? "clone" : "player"), clone ? 29 : -1});
        }
        const int32_t dynamic_count = static_cast<int32_t>(start.size());
        if (reversed) std::reverse(start.begin(), start.end());
        for (int32_t y = 0; y < 6; ++y) for (int32_t x = 0; x < 6; ++x) {
          start.push_back({x, y, 0, Role("floor"), -1});
        }
        start.push_back({2, 2, 1, Role(blocked ? "wall" : slopes[rotation]), -1});
        start.push_back({3, 2, 1, Role(slopes[rotation]), -1});
        for (int32_t x : {2, 3}) start.push_back({x, 1, 1, Role("wall"), -1});
        for (auto& voxel : start) for (int32_t turn = 0; turn < rotation; ++turn) {
          const int32_t x = voxel.x;
          voxel.x = 5 - voxel.y;
          voxel.y = x;
        }
        const auto expected_tick = [&](int32_t tick) {
          auto expected = start;
          for (int32_t i = 0; i < dynamic_count; ++i) {
            auto& voxel = expected[static_cast<size_t>(i)];
            const bool independent_player = clone && voxel.role == Role("player");
            const int32_t distance = independent_player ? 1 : blocked ? 0 : tick;
            voxel.x += (rotation == 1 ? 1 : rotation == 3 ? -1 : 0) * distance;
            voxel.y += (rotation == 0 ? -1 : rotation == 2 ? 1 : 0) * distance;
            if (!independent_player && !blocked) ++voxel.z;
          }
          return expected;
        };
        auto voxels = start;
        const int32_t count = static_cast<int32_t>(voxels.size());
        voxelbench::reset_workspace(&workspace);
        voxelbench::reset_motion_state(&motion);
        if (prepared) Check(voxelbench::prepare_scene(
            &workspace, voxels.data(), count, 6, 6, dynamic_count), "wide actor ramp entry should prepare");
        const int32_t ticks = blocked ? 1 : 2;
        for (int32_t tick = 1; tick <= ticks; ++tick) {
          const auto result = voxelbench::step_tick(
              &workspace, &motion, voxels.data(), count, 6, 6, rotation);
          const auto expected = expected_tick(tick);
          Check(result == (tick < ticks ? voxelbench::TickResult::kMore : voxelbench::TickResult::kComplete) &&
                    std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "each actor cell must clear its own ramp entry without climbing adjacent walls");
        }
        voxels = start;
        voxelbench::reset_workspace(&workspace);
        if (prepared) Check(voxelbench::prepare_scene(
            &workspace, voxels.data(), count, 6, 6, dynamic_count), "wide actor ramp entry should reprepare");
        const auto expected = expected_tick(ticks);
        Check(voxelbench::simulate_quiescent_turn(&workspace, voxels.data(), count, 6, 6, rotation) == 0 &&
                  std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
              "prepared search must obey the actor's complete swept ramp volume");
      }
    }
  }
}

void TestCloneRefillsCarriedPlayerCell() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState motion;
  const char* slopes[] = {"ice-slope-up", "ice-slope-right", "ice-slope-down", "ice-slope-left"};
  for (bool blocked : {false, true}) for (bool cargo : {false, true}) {
    for (bool remote_slope : {false, true}) for (int32_t rotation = 0; rotation < 4; ++rotation) {
      for (bool reversed : {false, true}) for (bool prepared : {false, true}) {
        std::vector<voxelbench::Voxel> start = {
            {2, 4, 1, Role("clone"), 29}, {2, 5, 1, Role("clone"), 29},
            {2, 5, 2, Role("clone"), 29}, {2, 4, 2, Role("player"), -1}};
        if (cargo) start.push_back({2, 4, 3, Role("weightless-pushable"), 71});
        const int32_t dynamic_count = static_cast<int32_t>(start.size());
        if (reversed) std::reverse(start.begin(), start.end());
        for (int32_t y = 0; y < 6; ++y) for (int32_t x = 0; x < 6; ++x) {
          start.push_back({x, y, 0, Role("floor"), -1});
        }
        if (blocked) start.push_back({2, 3, 2, Role("wall"), -1});
        if (remote_slope) start.push_back({5, 0, 1, Role(slopes[rotation]), -1});
        for (auto& voxel : start) for (int32_t turn = 0; turn < rotation; ++turn) {
          const int32_t x = voxel.x;
          voxel.x = 5 - voxel.y;
          voxel.y = x;
        }
        auto expected = start;
        if (!blocked) for (int32_t i = 0; i < dynamic_count; ++i) {
          expected[static_cast<size_t>(i)].x += rotation == 1 ? 1 : rotation == 3 ? -1 : 0;
          expected[static_cast<size_t>(i)].y += rotation == 0 ? -1 : rotation == 2 ? 1 : 0;
        }
        auto voxels = start;
        const int32_t count = static_cast<int32_t>(voxels.size());
        voxelbench::reset_workspace(&workspace);
        voxelbench::reset_motion_state(&motion);
        if (prepared) Check(voxelbench::prepare_scene(
            &workspace, voxels.data(), count, 6, 6, dynamic_count), "interlocking clone rider should prepare");
        Check(voxelbench::step_tick(&workspace, &motion, voxels.data(), count, 6, 6, rotation) ==
                  voxelbench::TickResult::kComplete && motion.tick == 1 &&
                  std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
              "a clone may refill its rider's old cell only when the rider's carried destination is clear");
        voxels = start;
        voxelbench::reset_workspace(&workspace);
        if (prepared) Check(voxelbench::prepare_scene(
            &workspace, voxels.data(), count, 6, 6, dynamic_count), "interlocking clone rider should reprepare");
        Check(voxelbench::simulate_quiescent_turn(&workspace, voxels.data(), count, 6, 6, rotation) == 0 &&
                  std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
              "prepared search must agree with animated interlocking clone carrying");
      }
    }
  }
}

void TestActorPolycubesPushThroughMountedLifts() {
  for (const bool player_body : {false, true}) {
    for (const bool remote_slope : {false, true}) {
      for (const char* box_role : {"weightless-pushable", "pushable"}) {
        for (int32_t obstruction = 0; obstruction < 5; ++obstruction) {
          std::vector<voxelbench::Voxel> start;
          if (!player_body) start.push_back({0, 3, 1, Role("player"), -1});
          const size_t actor_begin = start.size();
          const uint32_t actor_role = Role(player_body ? "player" : "clone");
          start.push_back({2, 3, 1, actor_role, 0});
          start.push_back({2, 3, 2, actor_role, 0});
          start.push_back({3, 3, 2, actor_role, 0});
          start.push_back({3, 2, 1,
              Role(obstruction == 3 ? "wall" : box_role), 0});
          start.push_back({3, 2, 2, Role("player-lift"), 1});
          const size_t moving_end = start.size();
          if (obstruction == 1) start.push_back({3, 1, 1, Role("wall"), -1});
          if (obstruction == 2) start.push_back({3, 1, 2, Role("wall"), -1});
          if (obstruction == 4) {
            start.push_back({3, 1, 1, Role("pushable"), -1});
            start.push_back({3, 0, 1, Role("pushable"), -1});
          }
          for (int32_t y = 0; y < 6; ++y) {
            for (int32_t x = 0; x < 6; ++x) {
              start.push_back({x, y, 0,
                  Role(remote_slope && x == 5 && y == 5
                      ? "ice-slope-up" : "floor"), -1});
            }
          }
          auto expected = start;
          if (!player_body) --expected[0].y;
          if (obstruction == 0) {
            for (size_t i = actor_begin; i < moving_end; ++i) --expected[i].y;
          }
          for (const bool reversed : {false, true}) {
            auto voxels = start;
            auto reference = expected;
            if (reversed) {
              std::reverse(voxels.begin(), voxels.end());
              std::reverse(reference.begin(), reference.end());
            }
            Check(voxelbench::simulate_turn(voxels.data(),
                      static_cast<int32_t>(voxels.size()), 6, 6, 0) == 0,
                  "actor contact with a mounted lift should complete");
            for (size_t i = 0; i < voxels.size(); ++i) {
              Check(voxels[i].x == reference[i].x &&
                        voxels[i].y == reference[i].y &&
                        voxels[i].z == reference[i].z &&
                        voxels[i].role == reference[i].role &&
                        voxels[i].generic_id == reference[i].generic_id,
                    "only a valid complete carrier push may move the actor, box and lift");
            }
          }
        }
      }
    }
  }
}

void TestBlueSlopeAndBoxShareTheirGenericBody() {
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 2, 1, Role("weightless-pushable"), 7},
      {2, 2, 1, Role("blue-box-slope-left"), 7},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 8, 4, 4, 0) == 0,
        "a same-ID blue cube and slope push should run");
  Check(voxels[0].y == 2 && voxels[1].y == 1 && voxels[2].y == 1,
        "a blue slope should translate as one rigid body with its same-ID box");

  voxelbench::Voxel blocked[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 2, 1, Role("weightless-pushable"), 7},
      {2, 2, 1, Role("blue-box-slope-left"), 7},
      {2, 1, 1, Role("wall"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(blocked, 9, 4, 4, 0) == 0,
        "a blocked same-ID blue cube and slope push should run");
  Check(blocked[0].y == 3 && blocked[1].y == 2 && blocked[2].y == 2,
        "blocking any blue slope voxel should block its complete same-ID body");
}

void TestYellowSlopeAndCloneShareTheirGenericBody() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {1, 2, 1, Role("clone"), 4},
      {2, 2, 1, Role("yellow-clone-slope-right"), 4},
      {1, 1, 1, Role("wall"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 10, 3, 3, 0) == 0,
        "a same-ID clone cube and yellow slope command should run");
  Check(voxels[1].y == 2 && voxels[2].y == 2,
        "blocking a clone cube should also block its same-ID yellow slope");

  voxelbench::Voxel pushing[] = {
      {0, 5, 1, Role("player"), -1},
      {2, 4, 1, Role("yellow-clone-slope-down"), 0},
      {2, 3, 1, Role("weightless-pushable"), 0},
      {2, 1, 1, Role("wall"), -1},
      {0, 5, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(pushing, 10, 6, 6, 0) == 0,
        "a yellow clone slope pushing a weightless body should run");
  Check(pushing[0].y == 4 && pushing[1].y == 3 && pushing[2].y == 2,
        "a yellow clone slope should push weightless bodies like a cube clone");
}

// PxP: a blocked wrapping body reaches around a free actor in the same
// input direction. Failure of the wrapper must not consume the free input.
void TestBlockedWrappingCloneDoesNotCancelFreeActors() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState motion;
  const char* slopes[] = {"ice-slope-up", "ice-slope-right", "ice-slope-down", "ice-slope-left"};
  for (bool player_body : {false, true}) for (bool chain : {false, true}) {
    for (bool relabel : {false, true}) for (bool remote_slope : {false, true}) {
      for (int32_t rotation = 0; rotation < 4; ++rotation) {
        for (bool reversed : {false, true}) for (bool prepared : {false, true}) {
          std::vector<voxelbench::Voxel> start;
          if (!player_body) start.push_back({0, 3, 1, Role("player"), -1});
          const int32_t blocked_id = relabel ? 71 : 29;
          const uint32_t blocked_role = Role(player_body ? "player" : "clone");
          start.push_back({2, 1, 1, blocked_role, blocked_id});
          start.push_back({2, 5, 1, blocked_role, blocked_id});
          start.push_back({2, 3, 1, Role("clone"), relabel ? 29 : 71});
          if (chain) start.push_back({2, 2, 1, Role("clone"), 81});
          const int32_t dynamic_count = static_cast<int32_t>(start.size());
          if (reversed) std::reverse(start.begin(), start.end());
          for (int32_t y = 0; y < 8; ++y) for (int32_t x = 0; x < 8; ++x) {
            start.push_back({x, y, 0, Role("floor"), -1});
          }
          start.push_back({2, 0, 1, Role("wall"), -1});
          start.push_back({2, 6, 1, Role("wall"), -1});
          if (remote_slope) start.push_back({7, 0, 1, Role(slopes[rotation]), -1});
          for (auto& voxel : start) for (int32_t turn = 0; turn < rotation; ++turn) {
            const int32_t x = voxel.x;
            voxel.x = 7 - voxel.y;
            voxel.y = x;
          }
          const int32_t dx = rotation == 1 ? 1 : rotation == 3 ? -1 : 0;
          const int32_t dy = rotation == 0 ? -1 : rotation == 2 ? 1 : 0;
          auto expected_down = start;
          for (int32_t i = 0; i < dynamic_count; ++i) {
            auto& voxel = expected_down[static_cast<size_t>(i)];
            if (voxel.role == blocked_role && voxel.generic_id == blocked_id) continue;
            voxel.x -= dx;
            voxel.y -= dy;
          }
          for (bool animated : {false, true}) {
            auto voxels = start;
            const int32_t count = static_cast<int32_t>(voxels.size());
            voxelbench::reset_workspace(&workspace);
            if (prepared) Check(voxelbench::prepare_scene(
                &workspace, voxels.data(), count, 8, 8, dynamic_count), "wrapping clone scene should prepare");
            for (int32_t command = 0; command < 2; ++command) {
              const int32_t direction = (rotation + (command == 0 ? 2 : 0)) % 4;
              if (animated) {
                voxelbench::reset_motion_state(&motion);
                Check(voxelbench::step_tick(&workspace, &motion, voxels.data(), count, 8, 8, direction) ==
                          voxelbench::TickResult::kComplete && motion.tick == 1,
                      "independent wrapping clone inputs should finish in one tick");
              } else {
                Check(voxelbench::simulate_quiescent_turn(&workspace, voxels.data(), count, 8, 8, direction) == 0,
                      "prepared search should resolve independent wrapping clone inputs");
              }
              const auto& expected = command == 0 ? expected_down : start;
              Check(std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                    "a blocked wrapper must not cancel clear actors or their return command");
            }
          }
        }
      }
    }
  }
}

void TestWrappingCloneSharesPlayerPushVacancy() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState motion;
  for (const bool swap : {false, true}) {
    for (const bool crate : {false, true}) {
      for (int32_t obstacle = 0; obstacle < 5; ++obstacle) {
        if ((crate && obstacle >= 3) || (swap && obstacle == 4)) continue;
        for (int32_t rotation = 0; rotation < 4; ++rotation) {
          for (const bool remote_ramp : {false, true}) {
            const int32_t box_y = swap ? 3 : 2;
            std::vector<voxelbench::Voxel> start = {
                {2, swap ? 2 : 3, 1, Role("player"), -1},
                {2, box_y, 1, Role(crate ? "pushable" : "weightless-pushable"), 0},
                {2, 1, 1, Role("clone"), 17},
                {2, 4, 1, Role("clone"), 17},
                {3, 1, 1, Role("clone"), 17},
                {3, 2, 1, Role("clone"), 17},
                {3, 3, 1, Role("clone"), 17},
                {3, 4, 1, Role("clone"), 17},
                {5, 4, 1, Role("clone"), 71},
            };
            if (obstacle == 1) start.push_back({3, 0, 1, Role("wall"), -1});
            if (obstacle == 2) start.push_back({5, 3, 1, Role("wall"), -1});
            if (obstacle == 3) {
              start.push_back({1, box_y, 1, Role("weightless-pushable"), 0});
              start.push_back({1, box_y - 1, 1, Role("wall"), -1});
            }
            if (obstacle == 4) {
              for (auto& voxel : start) {
                if (voxel.role != Role("clone") || voxel.generic_id != 71) voxel.z = 2;
              }
              start.push_back({1, 2, 2, Role("weightless-pushable"), 0});
              start.push_back({1, 2, 1, Role("weightless-pushable"), 0});
              for (int32_t y = 0; y < 5; ++y) {
                start.push_back({3, y, 1, Role("wall"), -1});
                if (y != 2) start.push_back({2, y, 1, Role("wall"), -1});
              }
            }
            const int32_t dynamic_count = static_cast<int32_t>(start.size());
            for (int32_t y = 0; y < 6; ++y) {
              for (int32_t x = 0; x < 6; ++x) start.push_back({x, y, 0, Role("floor"), -1});
            }
            const char* ramps[] = {"ice-slope-up", "ice-slope-right", "ice-slope-down", "ice-slope-left"};
            if (remote_ramp) start.push_back({0, 5, 1, Role(ramps[rotation]), -1});
            auto expected = start;
            for (auto& voxel : expected) {
              const bool independent = voxel.role == Role("clone") && voxel.generic_id == 71;
              const bool group = voxel.role == Role("player") ||
                  voxel.role == Role("pushable") || voxel.role == Role("weightless-pushable") ||
                  (voxel.role == Role("clone") && !independent);
              if ((independent && obstacle != 2) || (group && (obstacle == 0 || obstacle == 2))) --voxel.y;
            }
            for (auto* scene : {&start, &expected}) for (auto& voxel : *scene) {
              for (int32_t turn = 0; turn < rotation; ++turn) {
                const int32_t x = voxel.x;
                voxel.x = 5 - voxel.y;
                voxel.y = x;
              }
            }
            const int32_t count = static_cast<int32_t>(start.size());
            for (const bool prepared : {false, true}) {
              auto voxels = start;
              const auto prepare = [&]() {
                voxelbench::reset_workspace(&workspace);
                if (prepared) Check(voxelbench::prepare_scene(&workspace, voxels.data(),
                    count, 6, 6, dynamic_count), "wrapping clone push must prepare for search");
              };
              prepare();
              voxelbench::reset_motion_state(&motion);
              Check(voxelbench::step_command_tick(&workspace, &motion, voxels.data(), count,
                        6, 6, rotation) == voxelbench::TickResult::kComplete && motion.tick == 1 &&
                        std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                    "a wrapping clone and player push must share a collision-checked vacancy");
              voxels = start;
              prepare();
              Check(voxelbench::simulate_quiescent_turn(&workspace, voxels.data(), count, 6, 6, rotation) == 0 &&
                        std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                    "prepared search must preserve clone/player push atomicity and independent actors");
            }
          }
        }
      }
    }
  }
}

void TestClonePlayerChainsRequireActualVacancies() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState motion;
  // Blocked/clear pairs: one leading clone, a chain, a box push, a wrapper,
  // then a ledge, a passive clone, and a multi-voxel player.
  for (int32_t variant = 0; variant < 12; ++variant) {
    for (int32_t rotation = 0; rotation < 4; ++rotation) {
      for (const bool remote_ramp : {false, true}) {
        for (const bool reversed : {false, true}) {
          const bool wrapper = variant == 6 || variant == 7;
          const int32_t z = variant == 8 ? 2 : 1;
          std::vector<voxelbench::Voxel> start = {
              {2, 3, z, Role("player"), -1},
              {2, 2, z, Role("clone"), variant == 9 ? voxelbench::kCloneNoCommandIdFlag | 17 : 17},
              {2, 4, z, Role("clone"), wrapper ? 17 : 29},
          };
          if (variant == 2 || variant == 3) start.push_back({2, 1, 1, Role("clone"), 43});
          if (variant == 4 || variant == 5) start.push_back({2, 1, 1, Role("pushable"), -1});
          if (wrapper) for (int32_t y = 1; y <= 4; ++y) start.push_back({3, y, 1, Role("clone"), 17});
          if (variant >= 10) start.push_back({1, 3, 1, Role("player"), -1});
          const int32_t group_count = static_cast<int32_t>(start.size());
          start.push_back({6, 4, 1, Role("clone"), 71});
          const int32_t dynamic_count = static_cast<int32_t>(start.size());
          auto expected = start;
          const bool group_moves = variant < 8 ? variant % 2 == 1 : variant == 11;
          for (int32_t i = 0; i < group_count; ++i) {
            if (group_moves || (variant == 10 && i == 1)) --expected[static_cast<size_t>(i)].y;
          }
          --expected.back().y;
          if (reversed) {
            std::reverse(start.begin(), start.end());
            std::reverse(expected.begin(), expected.end());
          }
          for (int32_t y = 0; y < 8; ++y) for (int32_t x = 0; x < 8; ++x) {
            start.push_back({x, y, 0, Role("floor"), -1});
          }
          if (variant == 0) start.push_back({2, 1, 1, Role("wall"), -1});
          if (variant == 2 || variant == 4) start.push_back({2, 0, 1, Role("wall"), -1});
          if (variant == 6) start.push_back({3, 0, 1, Role("wall"), -1});
          if (variant == 10) start.push_back({1, 2, 1, Role("wall"), -1});
          if (variant == 8) for (int32_t y = 2; y <= 4; ++y) start.push_back({2, y, 1, Role("wall"), -1});
          const char* ramps[] = {"ice-slope-up", "ice-slope-right", "ice-slope-down", "ice-slope-left"};
          if (remote_ramp) start.push_back({7, 7, 1, Role(ramps[rotation]), -1});
          expected.insert(expected.end(), start.begin() + dynamic_count, start.end());
          for (auto* scene : {&start, &expected}) for (auto& voxel : *scene) {
            for (int32_t turn = 0; turn < rotation; ++turn) {
              const int32_t x = voxel.x;
              voxel.x = 7 - voxel.y;
              voxel.y = x;
            }
          }
          const int32_t count = static_cast<int32_t>(start.size());
          for (const bool prepared : {false, true}) for (const bool animated : {false, true}) {
            auto voxels = start;
            voxelbench::reset_workspace(&workspace);
            if (prepared) Check(voxelbench::prepare_scene(&workspace, voxels.data(), count,
                8, 8, dynamic_count), "actor chain must prepare for search");
            voxelbench::reset_motion_state(&motion);
            if (animated) {
              Check(voxelbench::step_command_tick(&workspace, &motion, voxels.data(), count,
                        8, 8, rotation) == voxelbench::TickResult::kComplete && motion.tick == 1,
                    "actor chain must resolve in one animation tick");
            } else {
              Check(voxelbench::simulate_quiescent_turn(&workspace, voxels.data(), count, 8, 8, rotation) == 0,
                    "actor chain search successor must resolve");
            }
            Check(std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                  "blocked actors must not promise player vacancies; independent clear actors still move");
          }
        }
      }
    }
  }
}

void TestTouchingCloneRidersKeepTheirMovingSupport() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState motion;
  for (const bool player_carrier : {false, true}) {
    for (int32_t stack = 1; stack <= 2; ++stack) {
      for (const bool blocked : {false, true}) {
        if (player_carrier && blocked) continue;
        for (int32_t rotation = 0; rotation < 4; ++rotation) {
          for (const bool remote_ramp : {false, true}) {
            for (const bool reversed : {false, true}) {
              const uint32_t carrier_role = Role(player_carrier ? "player" : "clone");
              const int32_t carrier_id = player_carrier ? -1 : 1;
              std::vector<voxelbench::Voxel> start = {
                  {2, 2, 1, carrier_role, carrier_id},
                  {3, 2, 1, carrier_role, carrier_id},
                  {4, 2, 1, carrier_role, carrier_id},
                  {4, 2, 2, carrier_role, carrier_id},
                  {4, 2, 3, carrier_role, carrier_id},
              };
              const int32_t carrier_count = static_cast<int32_t>(start.size());
              for (int32_t rider = 0; rider < stack; ++rider) {
                for (int32_t x : {2, 3}) start.push_back({x, 2, rider + 2, Role("clone"), rider + 2});
              }
              start.push_back({4, 5, 1, Role("clone"), 17});
              if (!player_carrier) start.push_back({1, 4, 1, Role("player"), -1});
              const int32_t dynamic_count = static_cast<int32_t>(start.size());
              auto expected = start;
              for (int32_t i = 0; i < dynamic_count; ++i) {
                if (i >= carrier_count || !blocked) --expected[static_cast<size_t>(i)].x;
              }
              if (reversed) {
                std::reverse(start.begin(), start.end());
                std::reverse(expected.begin(), expected.end());
              }
              for (int32_t y = 0; y < 6; ++y) for (int32_t x = 0; x < 6; ++x) {
                start.push_back({x, y, 0, Role("floor"), -1});
              }
              if (blocked) start.push_back({1, 2, 1, Role("wall"), -1});
              const char* ramps[] = {"ice-slope-up", "ice-slope-right", "ice-slope-down", "ice-slope-left"};
              if (remote_ramp) start.push_back({5, 0, 1, Role(ramps[rotation]), -1});
              expected.insert(expected.end(), start.begin() + dynamic_count, start.end());
              for (auto* scene : {&start, &expected}) for (auto& voxel : *scene) {
                for (int32_t turn = 0; turn < rotation; ++turn) {
                  const int32_t x = voxel.x;
                  voxel.x = 5 - voxel.y;
                  voxel.y = x;
                }
              }
              const int32_t count = static_cast<int32_t>(start.size());
              for (const bool prepared : {false, true}) for (const bool animated : {false, true}) {
                auto voxels = start;
                voxelbench::reset_workspace(&workspace);
                if (prepared) Check(voxelbench::prepare_scene(&workspace, voxels.data(), count,
                    6, 6, dynamic_count), "supported actor component must prepare for search");
                voxelbench::reset_motion_state(&motion);
                const int32_t direction = (3 + rotation) % 4;
                if (animated) {
                  Check(voxelbench::step_command_tick(&workspace, &motion, voxels.data(), count,
                            6, 6, direction) == voxelbench::TickResult::kComplete && motion.tick == 1,
                        "touching riders and their carrier must resolve in one command tick");
                } else {
                  Check(voxelbench::simulate_quiescent_turn(&workspace, voxels.data(), count, 6, 6, direction) == 0,
                        "supported actor component search successor must resolve");
                }
                Check(std::memcmp(voxels.data(), expected.data(), voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                      "joint actor steps retain carrier support without cancelling independent blocked-carrier riders");
              }
            }
          }
        }
      }
    }
  }
}

void TestInterlockingCloneCommandComponent() {
  voxelbench::Voxel voxels[] = {
      {0, 5, 1, Role("player"), -1},
      {1, 1, 1, Role("clone"), 0},
      {1, 3, 1, Role("clone"), 0},
      {1, 2, 1, Role("clone"), 1},
      {1, 4, 1, Role("clone"), 1},
      {0, 5, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 4, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 12, 3, 6, 0) == 0,
        "interlocking clone command should run");
  Check(voxels[1].y == 0 && voxels[2].y == 2 &&
        voxels[3].y == 1 && voxels[4].y == 3,
        "destination-linked clone polycubes should translate atomically");
}

void TestExactSearchCannotCollectGoalsThroughClones() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {2, 2, 1, Role("clone"), 0},
      {0, 1, 1, Role("wall"), -1},
      {2, 1, 1, Role("goal"), -1},
      {0, 2, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 7, 3, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kUnsolved &&
            result.solution_length == 0,
        "exact search must not solve a gem reachable only by a clone");
}

void TestPlayerPolycubeMovesAndFallsRigidly() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {1, 2, 1, Role("player"), -1},
      {1, 2, 2, Role("player"), -1},
      {0, 2, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {2, 0, 0, Role("floor"), -1},
  };
  static voxelbench::PhysicsWorkspace workspace;
  voxelbench::MotionState state{};
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 6, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "a player polycube should move into an unsupported destination");
  Check(voxels[0].y == 1 && voxels[1].y == 1 && voxels[2].y == 1,
        "every player voxel should translate atomically");
  for (int32_t tick = 0; tick < 3; ++tick) {
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, 6, 3, 3, 0) ==
              voxelbench::TickResult::kMore,
          "the complete player polycube should fall one row per tick");
  }
  Check(voxels[0].z == -2 && voxels[1].z == -2 && voxels[2].z == -1,
        "player-polycube gravity should preserve every relative offset");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 6, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the player polycube should disappear once its top passes the room");
  Check(voxels[0].x == -1 && voxels[1].x == -1 && voxels[2].x == -1,
        "abyss removal should remove the complete player polycube together");
}

void TestExactSearchTracksPlayerPolycube() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("goal"), -1},
      {0, 2, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 7, 3, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved &&
            result.moves == 1 && result.solution_length == 1 &&
            result.solution[0] == 0,
        "exact search should encode every player-polycube voxel as one actor");
}

void TestEveryBoundary() {
  constexpr int32_t positions[][3] = {{2, 0, 0}, {4, 2, 1}, {2, 4, 2}, {0, 2, 3}};
  for (const auto& value : positions) {
    voxelbench::Voxel voxels[] = {
        {value[0], value[1], 1, Role("player"), -1},
        {value[0], value[1], 0, Role("floor"), -1},
    };
    Check(voxelbench::simulate_turn(voxels, 2, 5, 5, value[2]) == 0,
          "boundary command should run");
    Check(voxels[0].x == value[0] && voxels[0].y == value[1],
          "room boundary should stop movement");
  }
}

void TestTickTraceAndWorkspaceIsolation() {
  static voxelbench::PhysicsWorkspace first_workspace;
  static voxelbench::PhysicsWorkspace second_workspace;
  static voxelbench::MotionState first_state;
  static voxelbench::MotionState second_state;
  voxelbench::Voxel first[] = {
      {2, 4, 1, Role("player"), -1},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("ice"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 0, Role("ice"), -1},
      {2, 0, 0, Role("solid"), -1},
  };
  voxelbench::Voxel second[] = {
      {1, 2, -3, Role("player"), -1},
      {1, 2, -4, Role("floor"), -1},
      {2, 2, -4, Role("solid"), -1},
  };
  voxelbench::reset_workspace(&first_workspace);
  voxelbench::reset_workspace(&second_workspace);
  voxelbench::reset_motion_state(&first_state);
  voxelbench::reset_motion_state(&second_state);

  Check(voxelbench::step_tick(
            &first_workspace, &first_state, first, 6, 5, 5, 0) ==
            voxelbench::TickResult::kMore,
        "the first Ice tick should leave horizontal momentum");
  Check(first_state.tick == 1 && first[0].y == 3,
        "step_tick should advance exactly one Ice cell");
  Check(voxelbench::step_tick(
            &second_workspace, &second_state, second, 3, 5, 5, 1) ==
            voxelbench::TickResult::kComplete,
        "an independent workspace should complete its own command");
  Check(second_state.tick == 1 && second[0].x == 2 && second[0].y == 2,
        "the second workspace should not inherit the first command");

  while (voxelbench::step_tick(
             &first_workspace, &first_state, first, 6, 5, 5, 0) ==
         voxelbench::TickResult::kMore) {
  }
  Check(first_state.tick == 4 && first[0].y == 0,
        "the resumed Ice trace should contain four committed ticks");
  Check(first_state.version == voxelbench::kMotionStateVersion,
        "motion state should carry its serializable format version");
}

void TestObserverReceivesNoMovementCompletionFrame() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("ice"), -1},
      {1, 1, 0, Role("ice"), -1},
      {1, 1, 1, Role("wall"), -1},
      {1, 2, 1, Role("goal"), -1},
  };
  ObserverTrace trace;
  voxelbench::reset_workspace(&workspace);
  Check(voxelbench::simulate_command(
            &workspace,
            &state,
            voxels,
            6,
            4,
            4,
            0,
            CaptureObserverFrame,
            &trace) == 0,
        "a blocked Ice completion should simulate successfully");
  Check(trace.calls == 2 && trace.ticks[0] == 1 && trace.ticks[1] == 1,
        "the observer should receive both the movement and no-movement final frame");
  Check(trace.goal_x[0] == 1 && trace.goal_x[1] < 0,
        "the final observer frame must include end-of-command gem collection");
}

void TestPreparedMotionStateClearsImmutableSuffix() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 1, 1, Role("player"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  Check(voxelbench::prepare_scene(&workspace, voxels, 3, 3, 3, 1),
        "the motion-state fixture should prepare its dynamic prefix");
  for (int32_t index = 0; index < 3; ++index) {
    state.horizontal_momentum[index] = 0xff;
    state.falling[index] = 0xff;
    state.gravity_armed[index] = 0xff;
  }
  Check(voxelbench::simulate_command(
            &workspace, &state, voxels, 3, 3, 3, 0) == 0,
        "the prepared motion-state command should complete");
  bool suffix_is_clear = true;
  for (int32_t index = 1; index < 3; ++index) {
    suffix_is_clear = suffix_is_clear &&
        state.horizontal_momentum[index] == 0 &&
        state.falling[index] == 0 && state.gravity_armed[index] == 0;
  }
  Check(suffix_is_clear,
        "serialized motion flags for immutable prepared voxels must be deterministic");
}

void TestPreparedSceneRejectsMovableStaticSuffix() {
  static voxelbench::PhysicsWorkspace workspace;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("weightless-pushable"), 0},
      {1, 2, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  Check(!voxelbench::prepare_scene(&workspace, voxels, 3, 4, 4, 1),
        "prepared scenes must reject movable voxels in the immutable suffix");
}

void TestPreparedIndexesDoNotLeakToDifferentSceneShape() {
  static voxelbench::PhysicsWorkspace workspace;
  voxelbench::Voxel voxels[18];
  int32_t count = 0;
  voxels[count++] = {2, 3, 1, Role("player"), -1};
  voxels[count++] = {2, 3, 0, Role("floor"), -1};
  voxels[count++] = {2, 2, 0, Role("floor"), -1};
  for (int32_t y = 0; y < 5 && count < 17; ++y) {
    for (int32_t x = 0; x < 5 && count < 17; ++x) {
      if ((x == 2 && y == 3) || (x == 2 && y == 2)) continue;
      voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  voxels[17] = {2, 2, 1, Role("solid"), -1};
  voxelbench::reset_workspace(&workspace);
  Check(voxelbench::prepare_scene(&workspace, voxels, 18, 5, 5, 1),
        "the full scene should prepare successfully");
  Check(voxelbench::simulate_turn(&workspace, voxels, 17, 5, 5, 0) == 0,
        "a differently sized scene using the same buffer should run normally");
  Check(voxels[0].x == 2 && voxels[0].y == 2,
        "an excluded stale wall must not remain in the prepared spatial index");
}

void TestInvalidQuiescentCallDoesNotLeakItsAssumption() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 2, Role("player"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  Check(voxelbench::prepare_scene(&workspace, voxels, 3, 4, 4, 1),
        "the floating-player scene should prepare successfully");
  Check(voxelbench::simulate_quiescent_turn(
            &workspace, voxels, 3, 4, 4, 9) == -1,
        "an invalid quiescent command should be rejected");
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 3, 4, 4, 0) ==
            voxelbench::TickResult::kMore,
        "the next ordinary command should begin by settling the player");
  Check(voxels[0].x == 1 && voxels[0].y == 2 && voxels[0].z == 1,
        "an invalid quiescent call must not skip initial gravity later");
}

void TestPlayerGetsVisibleRowZeroVoidFrame() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 1, 1, Role("player"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 2, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "walking off Floor should begin a visible void fall");
  Check(state.tick == 1 && voxels[0].x == 1 && voxels[0].y == 0 &&
            voxels[0].z == 1,
        "the first void frame should contain only the horizontal step");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 2, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the first gravity tick should retain the player on row zero");
  Check(state.tick == 2 && voxels[0].x == 1 && voxels[0].z == 0,
        "the first downward frame should place the player on row zero");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 2, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the first row below zero should remain a visible tick");
  Check(state.tick == 3 && voxels[0].x == 1 && voxels[0].z == -1,
        "the player should remain visible at row minus one");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 2, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the next unsupported fall should complete the command");
  Check(state.tick == 4 && voxels[0].x == -1 && voxels[0].z == -2,
        "the player should disappear after its visible row-minus-one tick");
}

void TestPushableGetsVisibleRowZeroVoidFrame() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("pushable"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "a pushable leaving support should continue through gravity ticks");
  Check(state.tick == 1 && voxels[1].x == 1 && voxels[1].y == 0 &&
            voxels[1].z == 1,
        "the pushed body's horizontal tick should not also change Z");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the first pushable gravity tick should reach row zero");
  Check(state.tick == 2 && voxels[1].x == 1 && voxels[1].z == 0,
        "the pushed body should remain visible on row zero");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the unsupported pushable should remain visible below row zero");
  Check(state.tick == 3 && voxels[1].x == 1 && voxels[1].z == -1,
        "the pushed body should have a visible row-minus-one frame");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the pushable should disappear on the following unsupported fall");
  Check(state.tick == 4 && voxels[1].x == -1 && voxels[1].z == -2,
        "the pushed body should disappear after its row-minus-one frame");
}

void TestTallPolycubeDisappearsOnlyAfterItsTopPassesRowZero() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("weightless-pushable"), 0},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the tall polycube push should start a gravity trace");
  Check(voxels[1].y == 0 && voxels[1].z == 1 && voxels[2].z == 2,
        "the horizontal polycube tick should preserve both heights");
  for (int32_t tick = 0; tick < 3; ++tick) {
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, 5, 3, 3, 0) ==
              voxelbench::TickResult::kMore,
          "the tall polycube should remain visible while any cube reaches row zero");
  }
  Check(voxels[1].x == 1 && voxels[1].z == -2 &&
            voxels[2].x == 1 && voxels[2].z == -1,
        "the whole polycube should still be visible with its top at row minus one");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the tall polycube should disappear on its following unsupported tick");
  Check(voxels[1].x == -1 && voxels[2].x == -1,
        "all members of the tall polycube should disappear together");
}

void TestPolycubeAbyssUsesLowestOtherWorldGeometry() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("weightless-pushable"), 0},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {0, 2, -5, Role("solid"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 6, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the deep-world polycube push should start a gravity trace");
  for (int32_t tick = 0; tick < 8; ++tick) {
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, 6, 3, 3, 0) ==
              voxelbench::TickResult::kMore,
          "negative world geometry should extend the visible abyss trace");
  }
  Check(voxels[1].x == 1 && voxels[1].z == -7 &&
            voxels[2].x == 1 && voxels[2].z == -6,
        "the polycube should remain visible after its top passes row minus five");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 6, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the next unsupported fall should remove the deep-world polycube");
  Check(voxels[1].x == -1 && voxels[2].x == -1,
        "the deep-world polycube should disappear as one rigid body");
}

void TestPlayerAbyssUsesLowestOtherWorldGeometry() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 1, 1, Role("player"), -1},
      {1, 1, 0, Role("floor"), -1},
      {0, 1, -3, Role("solid"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 3, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "walking into a deep world void should start a gravity trace");
  for (int32_t tick = 0; tick < 5; ++tick) {
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, 3, 3, 3, 0) ==
              voxelbench::TickResult::kMore,
          "the player should remain visible through the world's lowest row");
  }
  Check(voxels[0].x == 1 && voxels[0].z == -4,
        "the player should have a visible frame below row minus three");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 3, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the player should disappear on the following unsupported fall");
  Check(voxels[0].x == -1 && voxels[0].z == -5,
        "the player should be removed below all other world geometry");
}

void TestFallingRiderDoesNotExtendItsCarriersAbyss() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 2, Role("player"), -1},
      {1, 2, 1, Role("weightless-pushable"), 0},
      {1, 1, 1, Role("weightless-pushable"), 0},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {1, 2, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "pushing a ridden polycube off support should start its fall");
  for (int32_t tick = 0; tick < 3; ++tick) {
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, 5, 3, 3, 0) ==
              voxelbench::TickResult::kMore,
          "a ridden polycube should retain its visible void frames");
  }
  Check(voxels[0].x == 1 && voxels[0].z == -1 && voxels[3].z == -1,
        "the player and carrier should descend together below row zero");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the falling rider must not keep its carrier alive forever");
  Check(voxels[0].x < 0 && voxels[1].x < 0 && voxels[2].x < 0 &&
            voxels[3].x < 0,
        "the rider and its carrier should leave the room together");
}

void TestObjectAboveDescendingPlayerFallsInSameTick() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 1, 1, Role("player"), -1},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {1, 1, 0, Role("ice"), -1},
      {1, 0, -1, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the player and its passenger should first move horizontally together");
  Check(voxels[0].y == 0 && voxels[0].z == 1 &&
            voxels[1].y == 0 && voxels[1].z == 2,
        "horizontal passenger motion should not also change height");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the player and its passenger should complete one synchronized fall");
  Check(voxels[0].z == 0 && voxels[1].z == 1,
        "the passenger should fall with and remain above the player");
}

void TestExactSearchFindsShortestCommands() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {1, 0, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 5, 3, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved,
        "exact search should solve a supported corridor");
  Check(result.moves == 2 && result.solution_length == 2,
        "exact search should prove the two-command optimum");
  Check(result.solution[0] == 0 && result.solution[1] == 0,
        "exact search should reconstruct both Up commands");
}

void TestFlatIceSearchKeepsExactCommandSemantics() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {2, 4, 1, Role("player"), -1},
      {2, 4, 0, Role("floor"), -1},
      {2, 3, 0, Role("ice"), -1},
      {2, 2, 0, Role("ice"), -1},
      {2, 1, 0, Role("ice"), -1},
      {2, 0, 0, Role("floor"), -1},
      {2, 0, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 7, 5, 5, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 1,
        "flat Ice search should preserve a complete slide as one command");
  Check(result.solution_length == 1 && result.solution[0] == 0,
        "flat Ice search should reconstruct the exact Up slide");
}

void TestGeneralSearchSupportsBoardsWiderThanSixteen() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[22];
  int32_t count = 0;
  for (int32_t x = 0; x < 20; ++x) {
    voxels[count++] = {x, 1, 0, Role("floor"), -1};
  }
  voxels[count++] = {1, 1, 1, Role("player"), -1};
  voxels[count++] = {18, 1, 1, Role("goal"), -1};
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, count, 20, 4, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 17,
        "generalized search should support footprints wider than sixteen cells");
  Check(result.solution_length == 17,
        "wide-board search should reconstruct every exact command");
}

void TestGeneralSearchCollapsesWalkingBeforePushes() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {1, 1, 1, Role("player"), -1},
      {4, 1, 1, Role("pushable"), -1},
      {0, 1, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
      {3, 1, 0, Role("floor"), -1},
      {4, 1, 0, Role("floor"), -1},
      {5, 1, 0, Role("floor"), -1},
      {6, 1, 0, Role("floor"), -1},
      {5, 1, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 10, 7, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 4,
        "generalized search should preserve the exact walk-plus-push command cost");
  Check(result.solution_length == 4 && result.solution[0] == 1 &&
            result.solution[1] == 1 && result.solution[2] == 1 &&
            result.solution[3] == 1,
        "generalized search should reconstruct walking commands before both pushes");
  Check(result.expanded <= 3,
        "ordinary corridor walking should not occupy global search nodes");
}

void TestGeneralSearchMatchesMazeBenchEngine3LongRoom() {
  static constexpr const char* kRows[16] = {
      "################",
      "#......#...#...#",
      "#..###.#.#...#.#",
      "#.#..#.#..###..#",
      "#..##..#.#.....#",
      "##.##.#..#.##..#",
      "##..#..#.#..#..#",
      "#.#..#.#..#.@CC#",
      "#...#...#.A##C.#",
      "#..##..##AA..#.#",
      "#.##..#..AA..#.#",
      "#..##...#......#",
      "#..#####.#.B...#",
      "##..###...#BBB.#",
      "###.....#..BX..#",
      "################",
  };
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[512];
  int32_t count = 0;
  for (int32_t y = 0; y < 16; ++y) {
    for (int32_t x = 0; x < 16; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
      const char cell = kRows[y][x];
      if (cell == '#') {
        voxels[count++] = {x, y, 1, Role("solid"), -1};
      } else if (cell == '@') {
        voxels[count++] = {x, y, 1, Role("player"), -1};
      } else if (cell == 'X') {
        voxels[count++] = {x, y, 1, Role("goal"), -1};
      } else if (cell >= 'A' && cell <= 'Z') {
        voxels[count++] = {
            x, y, 1, Role("weightless-pushable"), cell - 'A'};
      }
    }
  }
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, count, 16, 16, 50000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 317,
        "generalized exact search should retain MazeBenchEngine3's 317-command optimum");
  Check(result.expanded < 1000,
        "collapsed local reachability should avoid global footstep-state explosion");
}

void TestSearchInitializesFreshWorkspace() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  std::unique_ptr<voxelbench::SearchWorkspace> search_workspace(
      new voxelbench::SearchWorkspace);
  std::memset(
      search_workspace->storage, 0x5a, sizeof(search_workspace->storage));
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {1, 0, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      search_workspace.get(), &physics_workspace, voxels, 5, 3, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 2,
        "a freshly constructed search workspace must initialize its hash stamps");
}

void TestSearchPrunesPlayerGameOverBranches() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {1, 1, 1, Role("player"), -1},
      {1, 1, 0, Role("floor"), -1},
      {0, 0, 1, Role("goal"), -1},
      {2, 2, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 4, 3, 3, 100);
  Check(result.status == voxelbench::SearchStatus::kUnsolved,
        "a room whose commands all kill the player should be unsolved");
  Check(result.expanded == 1 && result.generated == 0,
        "player disappearance must be pruned before dead states are inserted");
}

void TestPlayerCollectsGemOnlyAtCommandEnd() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 1, 1, Role("goal"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 4, 3, 3, 0) == 0,
        "walking into a gem should complete normally");
  Check(voxels[0].x == 1 && voxels[0].y == 1 && voxels[0].z == 1,
        "the gem must not block the player");
  Check(voxels[3].x < 0,
        "the gem should disappear when the player ends the command on it");
}

void TestBoxMayOverlapGemWithoutCollectingIt() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("pushable"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {1, 0, 1, Role("goal"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 6, 3, 3, 0) == 0,
        "a box should be pushable into a gem");
  Check(voxels[1].x == 1 && voxels[1].y == 0 && voxels[1].z == 1,
        "the box should overlap the non-rigid gem");
  Check(voxels[5].x == 1 && voxels[5].y == 0,
        "a box must not collect the gem");
}

void TestClonesCannotCollectGoals() {
  static voxelbench::PhysicsWorkspace workspace;
  const char* roles[] = {"clone", "yellow-clone-slope-up",
      "yellow-clone-slope-right", "yellow-clone-slope-down",
      "yellow-clone-slope-left"};
  for (const char* role : roles) {
    for (bool polycube : {false, true}) {
      for (bool reversed : {false, true}) {
        for (bool prepared : {false, true}) {
          std::vector<voxelbench::Voxel> voxels = {
              {0, 2, 1, Role("player"), -1},
              {2, 2, 1, Role(role), 71},
              {2, 1, 1, Role("goal"), -1},
              {0, 1, 1, Role("goal"), -1},
          };
          if (polycube) {
            voxels.push_back({1, 2, 1, Role("player"), -1});
            voxels.push_back({1, 1, 1, Role("goal"), -1});
          }
          const int32_t dynamic_count = static_cast<int32_t>(voxels.size());
          if (reversed) std::reverse(voxels.begin(), voxels.end());
          for (int32_t y = 0; y < 3; ++y) {
            for (int32_t x = 0; x < 3; ++x) {
              voxels.push_back({x, y, 0, Role("floor"), -1});
            }
          }
          const int32_t count = static_cast<int32_t>(voxels.size());
          voxelbench::reset_workspace(&workspace);
          if (prepared) {
            Check(voxelbench::prepare_scene(
                      &workspace, voxels.data(), count, 3, 3, dynamic_count),
                  "player-only gem scene should prepare");
          }
          const int32_t result = prepared
              ? voxelbench::simulate_quiescent_turn(
                    &workspace, voxels.data(), count, 3, 3, 0)
              : voxelbench::simulate_turn(
                    &workspace, voxels.data(), count, 3, 3, 0);
          Check(result == 0, "clone and player gem contacts should complete");
          for (int32_t index = 0; index < dynamic_count; ++index) {
            const auto& voxel = voxels[static_cast<size_t>(index)];
            if (voxel.role == Role(role) || voxel.role == Role("player")) {
              Check(voxel.y == 1 && voxel.z == 1,
                    "gem contact must not block either actor");
            } else if (voxel.role == Role("goal")) {
              Check(index == (reversed ? dynamic_count - 3 : 2)
                        ? voxel.x == 2 && voxel.y == 1 && voxel.z == 1
                        : voxel.x < 0,
                    "only player contacts, including polycube members, collect gems");
            }
          }
        }
      }
    }
  }
}

void TestSlidingAcrossGemDoesNotCollectIt() {
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("ice"), -1},
      {1, 1, 0, Role("ice"), -1},
      {1, 0, 0, Role("floor"), -1},
      {1, 2, 1, Role("goal"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 6, 4, 4, 0) == 0,
        "sliding through a gem should complete normally");
  Check(voxels[0].y == 0,
        "the player should continue past a gem encountered mid-command");
  Check(voxels[5].x == 1 && voxels[5].y == 2,
        "a gem crossed before command end must remain collectible");
}

void TestPlayerSettlesBeforeHorizontalInput() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 3, Role("player"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 3, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "a suspended player should begin settling before input");
  Check(state.tick == 1 && voxels[0].y == 2 && voxels[0].z == 2,
        "the first pre-command tick should contain gravity only");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 3, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "the player should finish settling before the command runs");
  Check(state.tick == 2 && voxels[0].y == 2 && voxels[0].z == 1,
        "the player should land without horizontal displacement");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 3, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the requested command should run after settling");
  Check(state.tick == 3 && voxels[0].y == 1 && voxels[0].z == 1,
        "horizontal movement should start only from the settled state");
}

void TestPolycubeSettlesAsOneBodyBeforeHorizontalInput() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 1, 3, Role("weightless-pushable"), 4},
      {2, 1, 3, Role("weightless-pushable"), 4},
      {1, 3, 0, Role("floor"), -1},
      {2, 3, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 4, 4, 1) ==
            voxelbench::TickResult::kMore,
        "a suspended polycube should begin settling before input");
  Check(voxels[0].x == 1 && voxels[1].z == 2 && voxels[2].z == 2,
        "the polycube should descend rigidly while the player waits");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 4, 4, 1) ==
            voxelbench::TickResult::kMore,
        "the polycube should land before horizontal input");
  Check(voxels[0].x == 1 && voxels[1].z == 1 && voxels[2].z == 1,
        "all polycube members should land in the same tick");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 4, 4, 1) ==
            voxelbench::TickResult::kComplete,
        "the command should resume once every body is settled");
  Check(voxels[0].x == 2 && voxels[0].y == 3,
        "the player should move only after the polycube lands");
}

void TestSearchRequiresACommandToCollectStartingGem() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {0, 0, 1, Role("player"), -1},
      {0, 0, 0, Role("floor"), -1},
      {0, 0, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 3, 1, 1, 100);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 1,
        "search should treat the gem as collected only after a command ends");
}

void TestPushCannotWalkPlayerOffWallSupport() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 2, Role("player"), -1},
      {1, 1, 1, Role("weightless-pushable"), 8},
      {1, 1, 2, Role("weightless-pushable"), 8},
      {1, 2, 1, Role("wall"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 6, 3, 3, 0) == 0,
        "a blocked wall-supported push should complete normally");
  Check(voxels[0].y == 2 && voxels[0].z == 2 &&
            voxels[1].y == 1 && voxels[2].y == 1,
        "pushing must not let the player walk off a non-Floor support");
}

void TestEnteringBeneathSupportedWeightlessBodyDoesNotCarryIt() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {0, 1, 2, Role("weightless-pushable"), 0},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {2, 1, 2, Role("weightless-pushable"), 0},
      {0, 1, 1, Role("wall"), -1},
      {2, 1, 1, Role("wall"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 8, 3, 3, 0) == 0,
        "walking beneath a supported weightless body should run");
  Check(voxels[0].x == 1 && voxels[0].y == 1 && voxels[0].z == 1,
        "the player should enter the empty cell beneath the body");
  Check(voxels[1].y == 1 && voxels[2].y == 1 && voxels[3].y == 1,
        "entering underneath must not acquire or translate the body");
}

void TestWalkingOnSupportedWrappingPolycube() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (const bool flat_ice_foot : {false, true}) {
    for (int32_t rotation = 0; rotation < 4; ++rotation) {
      std::vector<voxelbench::Voxel> initial = {
          {3, 3, 3, Role("player"), -1},
          {3, 4, 3, Role("weightless-pushable"), 3},
      };
      for (int32_t y = 2; y <= 4; ++y) {
        for (int32_t x = 1; x <= 3; ++x) {
          initial.push_back({x, y, 2, Role("weightless-pushable"), 3});
        }
      }
      initial.push_back({1, 2, 1, Role("ice-slope-down"), -1});
      initial.push_back({3, 3, 1, Role(flat_ice_foot ? "ice" : "wall"), -1});
      for (int32_t y = 0; y < 6; ++y) {
        for (int32_t x = 0; x < 6; ++x) {
          initial.push_back({x, y, 0, Role("floor"), -1});
        }
      }
      for (auto& voxel : initial) {
        for (int32_t turn = 0; turn < rotation; ++turn) {
          const int32_t x = voxel.x;
          voxel.x = 5 - voxel.y;
          voxel.y = x;
        }
        if (voxel.role == Role("ice-slope-down")) {
          constexpr const char* slopes[] = {
              "ice-slope-down", "ice-slope-left", "ice-slope-up", "ice-slope-right"};
          voxel.role = Role(slopes[rotation]);
        }
      }
      for (const bool reversed : {false, true}) {
        auto input = initial;
        if (reversed) std::reverse(input.begin(), input.end());
        const auto before = input;
        for (const bool prepared : {false, true}) {
          auto voxels = before;
          voxelbench::reset_workspace(&workspace);
          voxelbench::reset_motion_state(&state);
          const int32_t count = static_cast<int32_t>(voxels.size());
          if (prepared) {
            Check(voxelbench::prepare_scene(
                      &workspace, voxels.data(), count, 6, 6, count),
                  "walking regression should prepare its scene");
          }
          Check(voxelbench::step_command_tick(
                    &workspace, &state, voxels.data(), count, 6, 6, rotation) ==
                    voxelbench::TickResult::kComplete && state.tick == 1,
                "walking on the supported body should have one animation tick");
          constexpr int32_t dx[] = {0, 1, 0, -1};
          constexpr int32_t dy[] = {-1, 0, 1, 0};
          for (size_t i = 0; i < voxels.size(); ++i) {
            const bool player = before[i].role == Role("player");
            Check(voxels[i].x == before[i].x + (player ? dx[rotation] : 0) &&
                      voxels[i].y == before[i].y + (player ? dy[rotation] : 0) &&
                      voxels[i].z == before[i].z,
                  "only the player walks; a vacated cell cannot drag the stable polycube");
          }
          const auto animated_final = voxels;
          voxels = before;
          voxelbench::reset_workspace(&workspace);
          if (prepared) {
            Check(voxelbench::prepare_scene(
                      &workspace, voxels.data(), count, 6, 6, count),
                  "walking regression should reprepare for search");
          }
          Check(voxelbench::simulate_quiescent_turn(
                    &workspace, voxels.data(), count, 6, 6, rotation) == 0 &&
                    std::memcmp(voxels.data(), animated_final.data(),
                        voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "prepared search must keep the same stationary supporting body");
        }
      }
    }
  }
}

void TestConnectedRoomBodyBoundaries() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  constexpr int32_t grid_id = voxelbench::kPlayerRoomGridIdFlag |
      (6 << voxelbench::kRoomGridDimensionBits) | 6;
  for (int32_t rotation = 0; rotation < 4; ++rotation) {
    for (const bool reversed : {false, true}) {
      for (const bool prepared : {false, true}) {
        for (const char* box_role : {"pushable", "weightless-pushable", "blue-box-slope-up"}) {
          constexpr const char* slopes[] = {"blue-box-slope-up", "blue-box-slope-right",
              "blue-box-slope-down", "blue-box-slope-left"};
          const uint32_t role = Role(box_role) == Role("blue-box-slope-up")
              ? Role(slopes[rotation]) : Role(box_role);
          std::vector<voxelbench::Voxel> voxels = {
              {5, 2, 1, Role("player"), grid_id},
              {4, 4, 1, Role("clone"), 7},
              {5, 4, 1, role, 11},
              {1, 1, 1, Role("clone"), 8},
          };
          for (int32_t y = 0; y < 12; ++y) {
            for (int32_t x = 0; x < 12; ++x) {
              voxels.push_back({x, y, 0, Role("floor"), -1});
            }
          }
          for (auto& voxel : voxels) for (int32_t turn = 0; turn < rotation; ++turn) {
            const int32_t x = voxel.x;
            voxel.x = 11 - voxel.y;
            voxel.y = x;
          }
          if (reversed) {
            std::reverse(voxels.begin(), voxels.begin() + 4);
            std::reverse(voxels.begin() + 4, voxels.end());
          }
          const auto initial = voxels;
          const int32_t count = static_cast<int32_t>(voxels.size());
          voxelbench::reset_workspace(&workspace);
          if (prepared) Check(voxelbench::prepare_scene(
              &workspace, voxels.data(), count, 12, 12, 4), "room grid should prepare");
          const auto observer = [](const voxelbench::Voxel* frame, int32_t n,
              const voxelbench::MotionState*, void* context) {
            const auto& start = *static_cast<const std::vector<voxelbench::Voxel>*>(context);
            for (int32_t i = 0; i < n; ++i) {
              const auto index = static_cast<size_t>(i);
              if (frame[i].role == Role("player")) continue;
              Check(frame[i].x / 6 == start[index].x / 6 &&
                        frame[i].y / 6 == start[index].y / 6,
                    "only the player may cross a room boundary on any tick");
            }
          };
          auto observer_start = initial;
          Check(voxelbench::simulate_command(&workspace, &state, voxels.data(), count,
                    12, 12, (rotation + 1) % 4, observer, &observer_start) == 0,
                "bounded clone push should settle");
          constexpr int32_t dx[] = {1, 0, -1, 0};
          constexpr int32_t dy[] = {0, 1, 0, -1};
          for (size_t i = 0; i < voxels.size(); ++i) {
            const bool moves = initial[i].role == Role("player") || initial[i].generic_id == 8;
            Check(voxels[i].x == initial[i].x + (moves ? dx[rotation] : 0) &&
                      voxels[i].y == initial[i].y + (moves ? dy[rotation] : 0) &&
                      voxels[i].z == initial[i].z && voxels[i].generic_id == initial[i].generic_id,
                  "boundary blocks the clone and pushed body without blocking the player or local clones");
          }
          const auto animated_final = voxels;
          voxels = initial;
          voxelbench::reset_workspace(&workspace);
          if (prepared) Check(voxelbench::prepare_scene(
              &workspace, voxels.data(), count, 12, 12, 4), "room grid should reprepare");
          Check(voxelbench::simulate_quiescent_turn(&workspace, voxels.data(), count,
                    12, 12, (rotation + 1) % 4) == 0 &&
                    std::memcmp(voxels.data(), animated_final.data(),
                        voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "search and animation must apply the same body boundaries");
        }
      }
    }
  }
}

void TestCloneCommandOwnership() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (int32_t rotation = 0; rotation < 4; ++rotation) {
    for (const bool reversed : {false, true}) {
      for (const bool prepared : {false, true}) {
        for (const char* clone_role : {"clone", "yellow-clone-slope-up"}) {
          constexpr const char* slopes[] = {
              "yellow-clone-slope-up", "yellow-clone-slope-right",
              "yellow-clone-slope-down", "yellow-clone-slope-left"};
          const uint32_t role = Role(clone_role) == Role("clone")
              ? Role("clone") : Role(slopes[rotation]);
          std::vector<voxelbench::Voxel> voxels = {
              {0, 1, 1, Role("player"), -1},
              {1, 3, 1, role, 7},
              {3, 3, 1, role, voxelbench::kCloneNoCommandIdFlag | 7},
              {3, 4, 1, role, voxelbench::kCloneNoCommandIdFlag | 7},
          };
          for (int32_t y = 0; y < 6; ++y) {
            for (int32_t x = 0; x < 6; ++x) {
              voxels.push_back({x, y, 0, Role("floor"), -1});
            }
          }
          for (auto& voxel : voxels) {
            for (int32_t turn = 0; turn < rotation; ++turn) {
              const int32_t x = voxel.x;
              voxel.x = 5 - voxel.y;
              voxel.y = x;
            }
          }
          if (reversed) {
            std::reverse(voxels.begin(), voxels.begin() + 4);
            std::reverse(voxels.begin() + 4, voxels.end());
          }
          const auto initial = voxels;
          const int32_t count = static_cast<int32_t>(voxels.size());
          voxelbench::reset_workspace(&workspace);
          if (prepared) {
            Check(voxelbench::prepare_scene(
                      &workspace, voxels.data(), count, 6, 6, 4),
                  "clone ownership should prepare without changing the ABI");
          }
          Check(voxelbench::simulate_command(
                    &workspace, &state, voxels.data(), count, 6, 6,
                    (rotation + 1) % 4) == 0 && state.tick == 1,
                "the originating actors should have exactly one command tick");
          constexpr int32_t dx[] = {1, 0, -1, 0};
          constexpr int32_t dy[] = {0, 1, 0, -1};
          for (size_t i = 0; i < voxels.size(); ++i) {
            const bool active = initial[i].role == Role("player") ||
                initial[i].generic_id == 7;
            Check(voxels[i].x == initial[i].x + (active ? dx[rotation] : 0) &&
                      voxels[i].y == initial[i].y + (active ? dy[rotation] : 0) &&
                      voxels[i].z == initial[i].z &&
                      voxels[i].generic_id == initial[i].generic_id,
                  "only clones assigned to the starting room receive input");
          }
          const auto animated_final = voxels;
          voxels = initial;
          voxelbench::reset_workspace(&workspace);
          if (prepared) {
            Check(voxelbench::prepare_scene(
                      &workspace, voxels.data(), count, 6, 6, 4),
                  "clone ownership should reprepare for search");
          }
          Check(voxelbench::simulate_quiescent_turn(
                    &workspace, voxels.data(), count, 6, 6, (rotation + 1) % 4) == 0 &&
                    std::memcmp(voxels.data(), animated_final.data(),
                        voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "prepared clone commands must retain room ownership");
        }
      }
    }
  }
  voxelbench::Voxel carried[] = {
      {1, 3, 1, Role("player"), -1},
      {2, 3, 1, Role("weightless-pushable"), 17},
      {2, 3, 2, Role("clone"), voxelbench::kCloneNoCommandIdFlag | 9},
      {1, 3, 0, Role("floor"), -1},
      {2, 3, 0, Role("floor"), -1},
      {3, 3, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(carried, 6, 6, 6, 1) == 0 &&
            carried[0].x == 2 && carried[1].x == 3 && carried[2].x == 3 &&
            carried[2].z == 2,
        "input suppression must retain physical riding instead of replacing clones with walls");
}

void TestPlayerDepartureDoesNotCarryMultiplySupportedBody() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {0, 2, 2, Role("weightless-pushable"), 0},
      {1, 2, 2, Role("weightless-pushable"), 0},
      {2, 2, 2, Role("weightless-pushable"), 0},
      {2, 2, 1, Role("weightless-pushable"), 1},
      {0, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 8, 3, 3, 0) == 0,
        "walking out beneath a multiply supported body should run");
  Check(voxels[0].x == 0 && voxels[0].y == 1,
        "the player should leave its old support position");
  Check(voxels[1].y == 2 && voxels[2].y == 2 && voxels[3].y == 2,
        "a stationary movable foothold should retain the bridged body");
}

void TestSearchCollectsEveryGem() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {1, 2, 1, Role("goal"), -1},
      {1, 0, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 7, 4, 4, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 3,
        "search should retain partial collection state until every gem is gone");
  Check(result.solution_length == 3 && result.solution[0] == 0 &&
            result.solution[1] == 0 && result.solution[2] == 0,
        "the multi-gem shortest path should collect both corridor gems");
}

void TestSearchStoresLargePolycubeAsOneEntity() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[48];
  int32_t count = 0;
  voxels[count++] = {0, 2, 1, Role("player"), -1};
  voxels[count++] = {0, 2, 0, Role("floor"), -1};
  voxels[count++] = {0, 1, 0, Role("floor"), -1};
  voxels[count++] = {0, 0, 0, Role("floor"), -1};
  voxels[count++] = {0, 0, 1, Role("goal"), -1};
  for (int32_t y = 3; y <= 6; ++y) {
    for (int32_t x = 2; x <= 6; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
      voxels[count++] = {x, y, 1, Role("weightless-pushable"), 37};
    }
  }
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, count, 8, 8, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 2,
        "a polycube larger than the old moving-voxel cap should remain searchable");
}

void TestGeneralSearchChecksRaisedPolycubeCollisions() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {0, 0, 1, Role("player"), -1},
      {1, 0, 1, Role("weightless-pushable"), 4},
      {2, 0, 2, Role("weightless-pushable"), 4},
      {1, 0, 1, Role("goal"), -1},
      {3, 0, 1, Role("wall"), -1},
      {0, 0, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {2, 0, 0, Role("floor"), -1},
      {3, 0, 0, Role("floor"), -1},
      {3, 0, 2, Role("wall"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 10, 4, 1, 1000);
  Check(result.status == voxelbench::SearchStatus::kUnsolved,
        "generalized search must collide raised polycube members with raised walls");

  result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 9, 4, 1, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 1,
        "a raised polycube member may pass above a shorter wall");
}

void TestCappedSearchDoesNotClaimAnOptimalProof() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[45];
  int32_t count = 0;
  for (int32_t y = 0; y < 5; ++y) {
    for (int32_t x = 0; x < 5; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  for (int32_t x = 0; x < 5; ++x) {
    voxels[count++] = {x, 0, 1, Role("wall"), -1};
    voxels[count++] = {x, 4, 1, Role("wall"), -1};
  }
  for (int32_t y = 1; y < 4; ++y) {
    voxels[count++] = {0, y, 1, Role("wall"), -1};
    voxels[count++] = {4, y, 1, Role("wall"), -1};
  }
  voxels[count++] = {1, 2, 1, Role("weightless-pushable"), 0};
  voxels[count++] = {2, 2, 1, Role("weightless-pushable"), 0};
  voxels[count++] = {1, 3, 1, Role("player"), -1};
  voxels[count++] = {1, 1, 1, Role("goal"), -1};

  voxelbench::reset_workspace(&physics_workspace);
  const auto screened = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, count, 5, 5, 5);
  Check(screened.status == voxelbench::SearchStatus::kSolvedUnproven &&
            screened.moves == 6,
        "a route found after state pruning must be marked solved-but-unproven");

  const auto proved = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, count, 5, 5, 10000);
  Check(proved.status == voxelbench::SearchStatus::kSolved && proved.moves == 6,
        "the same route should become exact when the full frontier is retained");
}

void TestDistantPushCannotShoveBlockedSlopeBodies() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  constexpr int32_t dx[] = {0, 1, 0, -1};
  constexpr int32_t dy[] = {-1, 0, 1, 0};
  const char* ramps[] = {"ice-slope-up", "ice-slope-right",
                         "ice-slope-down", "ice-slope-left"};
  for (int32_t rotation = 0; rotation < 4; ++rotation) {
    const int32_t direction = (2 + rotation) % 4;
    for (int32_t scenario = 0; scenario < 3; ++scenario) {
      // An unrelated two-cell box rests on a ramp, blocked downhill by
      // another two-cell box on Floor. The player walks or pushes far away.
      std::vector<voxelbench::Voxel> start = {
          {5, 1, 1, Role("player"), -1},
          {2, 3, 2, Role("weightless-pushable"), 7},
          {3, 3, 2, Role("weightless-pushable"), 7},
          {2, 4, 1, Role("weightless-pushable"), 6},
          {3, 4, 1, Role("weightless-pushable"), 6},
      };
      const bool pushing = scenario != 0;
      if (pushing) start.push_back({5, 3, 1, Role("weightless-pushable"), 1});
      const int32_t dynamic_count = static_cast<int32_t>(start.size());
      if (scenario == 2) start.push_back({5, 4, 1, Role("wall"), -1});
      start.push_back({2, 3, 1, Role(ramps[rotation]), -1});
      start.push_back({3, 3, 1, Role(ramps[rotation]), -1});
      for (int32_t x = 0; x < 6; ++x) {
        for (int32_t y = 0; y < 6; ++y) start.push_back({x, y, 0, Role("floor"), -1});
      }
      for (auto& voxel : start) {
        for (int32_t turn = 0; turn < rotation; ++turn) {
          const int32_t old_x = voxel.x;
          voxel.x = 5 - voxel.y;
          voxel.y = old_x;
        }
      }
      for (const bool prepared : {false, true}) {
        auto voxels = start;
        voxelbench::reset_workspace(&workspace);
        if (prepared) {
          Check(voxelbench::prepare_scene(
                    &workspace, voxels.data(), static_cast<int32_t>(voxels.size()),
                    6, 6, dynamic_count),
                "isolated ramp assembly should prepare for search");
        }
        for (int32_t command = 0; command < 2; ++command) {
          auto expected = voxels;
          if (command == 0 || scenario != 2) {
            expected[0].x += dx[direction];
            expected[0].y += dy[direction];
          }
          if (command == 1 && scenario == 1) {
            expected[5].x += dx[direction];
            expected[5].y += dy[direction];
          }
          voxelbench::reset_motion_state(&state);
          Check(voxelbench::step_command_tick(
                    &workspace, &state, voxels.data(), static_cast<int32_t>(voxels.size()),
                    6, 6, direction) == voxelbench::TickResult::kComplete && state.tick == 1,
                "each isolated walk or push completes in one tick");
          Check(std::memcmp(voxels.data(), expected.data(),
                    voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "a local walk, push, or blocked push cannot shove a distant ramp assembly");
        }
      }
    }
  }
}

void TestSlopeCarrierMovesStationaryRider() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {1, 1, 3, Role("weightless-pushable"), 1},
      {1, 1, 1, Role("ice-slope-down"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("wall"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 8, 3, 3, 0) == 0,
        "a command matching the slope's downhill direction should run");
  Check(voxels[1].y == 0 && voxels[1].z == 1,
        "the bottom body should descend the slope");
  Check(voxels[2].y == 0 && voxels[2].z == 2,
        "a stationary body resting on the slope mover should ride with it");
}

void TestRemotePolycubeMemberCarriesPerpendicularSlopeRider() {
  voxelbench::Voxel voxels[25];
  int32_t count = 0;
  for (int32_t y = 0; y < 4; ++y) {
    for (int32_t x = 0; x < 4; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  voxels[count++] = {0, 1, 1, Role("ice"), -1};
  voxels[count++] = {0, 1, 2, Role("ice-slope-left"), -1};
  voxels[count++] = {0, 1, 3, Role("weightless-pushable"), 0};
  voxels[count++] = {1, 1, 1, Role("ice"), -1};
  voxels[count++] = {1, 1, 2, Role("weightless-pushable"), 1};
  voxels[count++] = {2, 1, 1, Role("weightless-pushable"), 1};
  voxels[count++] = {2, 1, 2, Role("weightless-pushable"), 1};
  voxels[count++] = {2, 2, 1, Role("player"), -1};
  voxels[count++] = {3, 1, 1, Role("ice"), -1};

  Check(voxelbench::simulate_turn(voxels, count, 4, 4, 0) == 0,
        "a push through a remote slope contact should run");
  Check(voxels[18].y == 0,
        "every member of the pushed polycube should transmit slope contact");
}

void TestSlopeAndFlatIceBridgeNeedsDeliberatePush() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {1, 1, 2, Role("weightless-pushable"), 0},
      {2, 1, 2, Role("weightless-pushable"), 0},
      {2, 1, 1, Role("weightless-pushable"), 0},
      {1, 1, 1, Role("ice-slope-down"), -1},
      {2, 1, 0, Role("ice"), -1},
      {1, 1, 0, Role("floor"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 9, 3, 3, 0) == 0,
        "a command beside the mixed-support polycube should run");
  Check(voxels[1].y == 1 && voxels[2].y == 1 && voxels[3].y == 1,
        "a polycube bridging slope and flat Ice should remain stable without a push");
}

void TestOpposingSlopeLandingCancelsStoredMomentum() {
  voxelbench::Voxel voxels[] = {
      {1, 5, 3, Role("player"), -1},
      {1, 4, 3, Role("weightless-pushable"), 0},
      {1, 3, 3, Role("weightless-pushable"), 0},
      {1, 4, 2, Role("wall"), -1},
      {1, 5, 2, Role("wall"), -1},
      {1, 3, 0, Role("ice-slope-down"), -1},
      {1, 2, 0, Role("ice-slope-up"), -1},
      {1, 1, 1, Role("ice-slope-up"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 8, 3, 7, 0) == 0,
        "a push that drops a body onto opposing slopes should run");
  Check(voxels[1].y == 3 && voxels[1].z == 1 &&
            voxels[2].y == 2 && voxels[2].z == 1,
        "opposing slope supports should cancel stored pre-fall momentum");
}

void TestAuthoredHoveringLiftsKeepTheirAnchors() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  constexpr int32_t dx[] = {0, 1, 0, -1};
  constexpr int32_t dy[] = {-1, 0, 1, 0};
  for (int32_t raised = 0; raised <= 1; ++raised) {
    std::vector<voxelbench::Voxel> initial = {
        {3, 4, 1, Role("player"), -1},
        {0, 0, 1, Role("player-lift"), raised},
        {0, 2, 2, Role("player-lift"), raised},
        {2, 0, 1, Role("player-lift"), raised},
        {2, 0, 2, Role("player-lift"), raised},
        {4, 0, 2, Role("player-lift"), raised},
        {4, 0, 3, Role("player-lift"), raised},
    };
    for (int32_t y = 0; y < 6; ++y) {
      for (int32_t x = 0; x < 6; ++x) {
        initial.push_back({x, y, 0, Role("floor"), -1});
      }
    }
    const int32_t count = static_cast<int32_t>(initial.size());
    for (int32_t direction = 0; direction < 4; ++direction) {
      for (bool prepared : {false, true}) {
        auto voxels = initial;
        voxelbench::reset_workspace(&workspace);
        if (prepared) {
          Check(voxelbench::prepare_scene(&workspace, voxels.data(), count, 6, 6, 7),
                "hovering lift scene should prepare for search");
          Check(voxelbench::simulate_quiescent_turn(
                    &workspace, voxels.data(), count, 6, 6, direction, true) == 0,
                "full search successor should preserve hovering lifts");
        } else {
          voxelbench::reset_motion_state(&state);
          Check(voxelbench::step_tick(
                    &workspace, &state, voxels.data(), count, 6, 6, direction) ==
                    voxelbench::TickResult::kComplete && state.tick == 1,
                "unrelated lifts must not add a gravity or animation tick");
        }
        Check(voxels[0].x == 3 + dx[direction] &&
                  voxels[0].y == 4 + dy[direction] && voxels[0].z == 1,
              "the requested walk should still complete");
        for (size_t i = 1; i < initial.size(); ++i) {
          Check(voxels[i].x == initial[i].x && voxels[i].y == initial[i].y &&
                    voxels[i].z == initial[i].z &&
                    voxels[i].generic_id == initial[i].generic_id,
                "single lifts, supported stacks and hovering stacks retain their anchors");
        }
      }
    }
  }
}

void TestTerrainLiftsDoNotAttachToActors() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  constexpr int32_t dx[] = {0, 1, 0, -1};
  constexpr int32_t dy[] = {-1, 0, 1, 0};
  for (bool clone : {false, true}) {
    for (int32_t raised = 0; raised <= 1; ++raised) {
      std::vector<voxelbench::Voxel> initial = {
          {3, 4, 1, Role("player"), -1},
      };
      const size_t actor = clone ? 1u : 0u;
      const int32_t actor_x = clone ? 1 : 3;
      if (clone) initial.push_back({actor_x, 4, 1, Role("clone"), 0});
      for (int32_t z = 2; z <= 5; ++z) {
        initial.push_back({actor_x, 4, z, Role("player-lift"), raised});
      }
      const int32_t dynamic_count = static_cast<int32_t>(initial.size());
      for (int32_t y = 0; y < 6; ++y) {
        for (int32_t x = 0; x < 6; ++x) {
          initial.push_back({x, y, 0, Role("floor"), -1});
        }
      }
      const int32_t count = static_cast<int32_t>(initial.size());
      for (int32_t direction = 0; direction < 4; ++direction) {
        for (bool prepared : {false, true}) {
          auto voxels = initial;
          voxelbench::reset_workspace(&workspace);
          if (prepared) {
            Check(voxelbench::prepare_scene(
                      &workspace, voxels.data(), count, 6, 6, dynamic_count),
                  "actor and overhead lifts should prepare for search");
            Check(voxelbench::simulate_quiescent_turn(
                      &workspace, voxels.data(), count, 6, 6, direction, true) == 0,
                  "prepared full physics should leave overhead lifts anchored");
          } else {
            voxelbench::reset_motion_state(&state);
            Check(voxelbench::step_tick(
                      &workspace, &state, voxels.data(), count, 6, 6, direction) ==
                      voxelbench::TickResult::kComplete && state.tick == 1,
                  "walking out from under lifts should need only one tick");
          }
          Check(voxels[actor].x == actor_x + dx[direction] &&
                    voxels[actor].y == 4 + dy[direction] && voxels[actor].z == 1,
                "the player or clone should walk out from under the lift stack");
          for (size_t i = actor + 1; i < static_cast<size_t>(dynamic_count); ++i) {
            Check(voxels[i].x == initial[i].x && voxels[i].y == initial[i].y &&
                      voxels[i].z == initial[i].z &&
                      voxels[i].generic_id == initial[i].generic_id,
                  "touching an actor must neither carry nor drop a lift stack");
          }
        }
      }
    }
  }
}

void TestPlayerEnteringLoweredLiftRaisesAndRides() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("player-lift"), 0},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 4, 3, 3, 0) == 0,
        "entering a lowered player lift should run");
  Check(voxels[0].x == 1 && voxels[0].y == 1 && voxels[0].z == 2,
        "the raised lift should carry its entering player up one unit");
  Check(voxels[1].generic_id == 1,
        "entering a lowered lift should store its raised state");
}

void TestPlayerEnteringRaisedLiftLowersAndRides() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 2, Role("player"), -1},
      {1, 1, 1, Role("player-lift"), 1},
      {1, 2, 1, Role("wall"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 4, 3, 3, 0) == 0,
        "entering a raised player lift should run");
  Check(voxels[0].x == 1 && voxels[0].y == 1 && voxels[0].z == 1,
        "the lowered lift should carry its entering player down one unit");
  Check(voxels[1].generic_id == 0,
        "entering a raised lift should store its lowered state");
}

void TestPlayerLiftToggleUsesItsOwnAnimationTick() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("player-lift"), 0},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 2, 2, Role("player-lift"), 1},
      {1, 2, 3, Role("player-lift"), 1},
      {1, 2, 4, Role("player-lift"), 1},
      {1, 2, 5, Role("player-lift"), 1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 8, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "entering a lift should expose the horizontal entry frame");
  Check(state.tick == 1 && voxels[0].y == 1 && voxels[0].z == 1 &&
            voxels[1].generic_id == 0,
        "the entry tick should not collapse the lift state change into movement");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 8, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the following animation tick should complete the lift toggle");
  Check(state.tick == 2 && voxels[0].z == 2 && voxels[1].generic_id == 1,
        "the second tick should raise both lift state and rider");
  for (int32_t i = 4; i < 8; ++i) {
    Check(voxels[i].x == 1 && voxels[i].y == 2 && voxels[i].z == i - 2,
          "the overhead stack must stay behind throughout entry and activation");
  }
}

void TestLeavingAuthoredLoweredLiftKeepsItLowered() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 2, 1, Role("player-lift"), 0},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 4, 3, 3, 0) == 0,
        "leaving an authored lowered lift should run");
  Check(voxels[0].y == 1 && voxels[1].generic_id == 0,
        "an ordinary lowered lift should remain lowered after departure");
}

void TestBlockedLoweredLiftRetriesAfterRiderLeaves() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 2, 1, Role("player-lift"), 0},
      {1, 2, 2, Role("wall"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "a rider should first leave its ceiling-blocked lift");
  Check(state.tick == 1 && voxels[0].y == 1 && voxels[1].generic_id == 0,
        "the departure frame should keep the blocked lift lowered");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 5, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the vacated lift should retry on its own following tick");
  Check(state.tick == 2 && voxels[1].generic_id == 1,
        "the unobstructed vacated lift should finish raised");
}

void TestBlockedSideLiftIceLaneSurvivesResumeAndSearch() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (int32_t rotation = 0; rotation < 4; ++rotation) {
    for (const bool reversed : {false, true}) {
      std::vector<voxelbench::Voxel> initial = {
          {1, 4, 2, Role("player"), -1},
          {1, 3, 2, Role("player-lift"), 4},
          {2, 3, 2, Role("player-lift"), 6},
          {3, 3, 2, Role("player-lift"), 6},
          {4, 3, 2, Role("player-lift"), 6},
      };
      constexpr int32_t dynamic_count = 5;
      for (int32_t y = 0; y < 8; ++y) {
        for (int32_t x = 0; x < 8; ++x) {
          initial.push_back({x, y, 0, Role("floor"), -1});
        }
      }
      initial.push_back({1, 4, 1, Role("wall"), -1});
      initial.push_back({1, 3, 1, Role("wall"), -1});
      initial.push_back({0, 3, 2, Role("wall"), -1});
      for (int32_t x = 2; x <= 4; ++x) {
        initial.push_back({x, 3, 1, Role("ice"), -1});
        initial.push_back({x, 4, 2, Role("wall"), -1});
      }
      // Keep original coordinates to express exact tick expectations after
      // rotations and independent permutations of bodies and terrain.
      if (reversed) {
        std::reverse(initial.begin(), initial.begin() + dynamic_count);
        std::reverse(initial.begin() + dynamic_count, initial.end());
      }
      const auto unrotated = initial;
      const auto rotate = [&](voxelbench::Voxel voxel) {
        for (int32_t turn = 0; turn < rotation; ++turn) {
          const int32_t old_x = voxel.x;
          voxel.x = 7 - voxel.y;
          voxel.y = old_x;
        }
        if (voxel.role == Role("player-lift")) {
          const int32_t outward = voxel.generic_id / 2 - 1;
          voxel.generic_id = ((outward + rotation) % 4 + 1) * 2 +
              voxel.generic_id % 2;
        }
        return voxel;
      };
      for (auto& voxel : initial) voxel = rotate(voxel);
      const int32_t count = static_cast<int32_t>(initial.size());
      for (const bool prepared : {false, true}) {
        for (const bool resumed : {false, true}) {
          auto voxels = initial;
          const auto prepare = [&]() {
            voxelbench::reset_workspace(&workspace);
            if (prepared) {
              Check(voxelbench::prepare_scene(&workspace, voxels.data(), count,
                        8, 8, dynamic_count), "Ice lift lane should prepare");
            }
          };
          prepare();
          voxelbench::reset_motion_state(&state);
          for (int32_t tick = 1; tick <= 6; ++tick) {
            if (resumed) prepare();
            const auto result = voxelbench::step_command_tick(&workspace, &state,
                voxels.data(), count, 8, 8, rotation);
            Check(state.tick == tick && result == (tick == 6
                      ? voxelbench::TickResult::kComplete
                      : voxelbench::TickResult::kMore),
                  "blocked lifts must share Ice/fall ticks without stopping the rider");
            auto expected = unrotated;
            for (auto& voxel : expected) {
              if (voxel.role == Role("player")) {
                voxel.x = tick <= 5 ? tick : 5;
                voxel.y = 3;
                voxel.z = tick == 6 ? 1 : 2;
              } else if (voxel.role == Role("player-lift")) {
                const int32_t raise_tick = voxel.x == 1 ? 2 : voxel.x + 2;
                if (tick >= raise_tick) ++voxel.generic_id;
              }
              voxel = rotate(voxel);
            }
            Check(std::memcmp(voxels.data(), expected.data(),
                      voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                  "each blocked lift must rise exactly one tick after departure");
          }
          const auto animated_final = voxels;
          voxels = initial;
          prepare();
          Check(voxelbench::simulate_quiescent_turn(&workspace, voxels.data(),
                    count, 8, 8, rotation) == 0 &&
                    std::memcmp(voxels.data(), animated_final.data(),
                        voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "prepared final-state physics must match every animated lift retry");
        }
      }
    }
  }
}

void TestSideLiftDepartureTiming() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  constexpr int32_t dx[] = {0, 1, 0, -1};
  constexpr int32_t dy[] = {-1, 0, 1, 0};
  for (int32_t rotation = 0; rotation < 4; ++rotation) {
    const int32_t outward = (rotation + 1) % 4;
    const int32_t lowered_id = (outward + 1) * 2;
    // Unobstructed, wall-blocked, and blocked through a movable box chain.
    for (int32_t obstruction = 0; obstruction < 3; ++obstruction) {
      std::vector<voxelbench::Voxel> start = {
          {3, 3, 1, Role("player"), -1},
          {3, 3, 1, Role("player-lift"), lowered_id},
          {2, 3, 1, Role("weightless-pushable"), 0},
          {1, 3, 1, Role("wall"), -1},
      };
      if (obstruction != 0) {
        start.push_back({4, 3, 1,
            Role(obstruction == 1 ? "wall" : "weightless-pushable"),
            obstruction == 1 ? -1 : 1});
      }
      if (obstruction == 2) start.push_back({5, 3, 1, Role("wall"), -1});
      const int32_t dynamic_count = static_cast<int32_t>(start.size());
      for (int32_t x = 0; x < 7; ++x) {
        for (int32_t y = 0; y < 7; ++y) {
          start.push_back({x, y, 0, Role("floor"), -1});
        }
      }
      for (auto& voxel : start) {
        for (int32_t turn = 0; turn < rotation; ++turn) {
          const int32_t old_x = voxel.x;
          voxel.x = 6 - voxel.y;
          voxel.y = old_x;
        }
      }
      const int32_t count = static_cast<int32_t>(start.size());
      auto expected = start;
      expected[0].x += dx[rotation];
      expected[0].y += dy[rotation];
      if (obstruction != 0) ++expected[1].generic_id;
      for (const bool prepared : {false, true}) {
        for (const bool resumed : {false, true}) {
          auto voxels = start;
          const auto prepare = [&]() {
            voxelbench::reset_workspace(&workspace);
            if (prepared) {
              Check(voxelbench::prepare_scene(
                        &workspace, voxels.data(), count, 7, 7, dynamic_count),
                    "side-lift departure should prepare for search or resume");
            }
          };
          prepare();
          voxelbench::reset_motion_state(&state);
          const auto result = voxelbench::step_command_tick(
              &workspace, &state, voxels.data(), count, 7, 7, rotation);
          Check(state.tick == 1 && voxels[1].generic_id == lowered_id &&
                    result == (obstruction == 0
                        ? voxelbench::TickResult::kComplete
                        : voxelbench::TickResult::kMore),
                "departure must leave a lowered side lift unchanged for one tick");
          if (obstruction != 0) {
            if (resumed) prepare();
            Check(voxelbench::step_command_tick(
                      &workspace, &state, voxels.data(), count, 7, 7, rotation) ==
                      voxelbench::TickResult::kComplete && state.tick == 2,
                  "a blocked side lift retries only after its rider leaves");
          }
          Check(std::memcmp(voxels.data(), expected.data(),
                    voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "a vacated lift must not displace its carrier or outward blockers");
          voxels = start;
          prepare();
          Check(voxelbench::simulate_quiescent_turn(
                    &workspace, voxels.data(), count, 7, 7, rotation) == 0 &&
                    std::memcmp(voxels.data(), expected.data(),
                        voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                "prepared search must preserve the same side-lift departure state");
        }
      }
    }
  }
}

void TestMountedLiftPushIgnoresRemoteRamp() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  constexpr int32_t dx[] = {0, 1, 0, -1};
  constexpr int32_t dy[] = {-1, 0, 1, 0};
  const char* ramps[] = {"ice-slope-up", "ice-slope-right",
                         "ice-slope-down", "ice-slope-left"};
  for (int32_t rotation = 0; rotation < 4; ++rotation) {
    for (const bool remote_ramp : {false, true}) {
      for (const bool raised : {false, true}) {
        for (const bool floor_blocker : {false, true}) {
          std::vector<voxelbench::Voxel> start = {
              {2, 4, 1, Role("player"), -1},
              {1, 3, 1, Role("weightless-pushable"), 12},
              {2, 3, 1, Role("weightless-pushable"), 12},
              {3, 3, 1, Role("weightless-pushable"), 12},
              {0, 3, 1, Role("player-lift"), ((3 + rotation) % 4 + 1) * 2 + raised},
              {4, 3, 1, Role("player-lift"), ((1 + rotation) % 4 + 1) * 2 + raised},
              {0, 2, 1, Role(floor_blocker ? "floor" : "wall"), -1},
              {4, 2, 1, Role(floor_blocker ? "floor" : "wall"), -1},
          };
          for (int32_t x = 0; x < 6; ++x) {
            for (int32_t y = 0; y < 6; ++y) start.push_back({x, y, 0, Role("floor"), -1});
          }
          if (remote_ramp) start.push_back({5, 5, 1, Role(ramps[rotation]), -1});
          for (auto& voxel : start) {
            for (int32_t turn = 0; turn < rotation; ++turn) {
              const int32_t old_x = voxel.x;
              voxel.x = 5 - voxel.y;
              voxel.y = old_x;
            }
          }
          auto expected = start;
          if (!raised && !floor_blocker) {
            for (size_t i = 0; i < 6; ++i) {
              expected[i].x += dx[rotation];
              expected[i].y += dy[rotation];
            }
          }
          const int32_t count = static_cast<int32_t>(start.size());
          for (const bool prepared : {false, true}) {
            auto voxels = start;
            const auto prepare = [&]() {
              voxelbench::reset_workspace(&workspace);
              if (prepared) {
                Check(voxelbench::prepare_scene(
                          &workspace, voxels.data(), count, 6, 6, 6),
                      "mounted lift push should prepare with or without remote terrain");
              }
            };
            prepare();
            voxelbench::reset_motion_state(&state);
            Check(voxelbench::step_command_tick(
                      &workspace, &state, voxels.data(), count, 6, 6, rotation) ==
                      voxelbench::TickResult::kComplete && state.tick == 1 &&
                      std::memcmp(voxels.data(), expected.data(),
                          voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                  "only raised lifts and floor overlap may anchor a mounted lift push");
            voxels = start;
            prepare();
            Check(voxelbench::simulate_quiescent_turn(
                      &workspace, voxels.data(), count, 6, 6, rotation) == 0 &&
                      std::memcmp(voxels.data(), expected.data(),
                          voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                  "prepared search must agree on lowered and raised fixture collisions");
          }
        }
      }
    }
  }
}

void TestMountedLiftTransmitsItsCarriersPush() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  constexpr int32_t dx[] = {0, 1, 0, -1};
  constexpr int32_t dy[] = {-1, 0, 1, 0};
  const char* ramps[] = {"ice-slope-up", "ice-slope-right",
                         "ice-slope-down", "ice-slope-left"};
  for (int32_t rotation = 0; rotation < 4; ++rotation) {
    for (const bool remote_ramp : {false, true}) {
      for (const bool normal_carrier : {false, true}) {
        for (int32_t obstruction = 0; obstruction < 5; ++obstruction) {
          // The player stands on an L-shaped box. On its second Up, the
          // mounted West lift contacts a separate box's mounted East lift.
          std::vector<voxelbench::Voxel> start = {
              {5, 5, normal_carrier ? 1 : 2, Role("player"), -1},
              {5, 4, 1, Role(normal_carrier ? "pushable" : "weightless-pushable"), 12},
          };
          if (!normal_carrier) {
            start.push_back({5, 4, 2, Role("weightless-pushable"), 12});
            start.push_back({5, 5, 1, Role("weightless-pushable"), 12});
          }
          start.push_back({4, 4, 1, Role("player-lift"), ((3 + rotation) % 4 + 1) * 2 + 1});
          const size_t primary_end = start.size();
          start.push_back({3, 2, 1, Role(obstruction == 2 ? "wall" :
              obstruction == 1 || obstruction == 3 ? "pushable" : "weightless-pushable"), 13});
          start.push_back({4, 2, 1, Role("player-lift"), ((1 + rotation) % 4 + 1) * 2 + 1});
          const size_t moving_end = start.size();
          if (obstruction == 3) start.push_back({3, 1, 1, Role("pushable"), 14});
          if (obstruction == 4) start.push_back({4, 1, 1, Role("wall"), -1});
          const size_t dynamic_count = start.size();
          for (int32_t x = 0; x < 8; ++x) {
            for (int32_t y = 0; y < 8; ++y) start.push_back({x, y, 0, Role("floor"), -1});
          }
          if (remote_ramp) start.push_back({7, 7, 1, Role(ramps[rotation]), -1});
          for (auto& voxel : start) {
            for (int32_t turn = 0; turn < rotation; ++turn) {
              const int32_t old_x = voxel.x;
              voxel.x = 7 - voxel.y;
              voxel.y = old_x;
            }
          }
          const bool can_push = obstruction == 0 || (obstruction == 1 && !normal_carrier);
          for (const bool prepared : {false, true}) {
            for (const bool reversed : {false, true}) {
              auto voxels = start;
              auto expected = start;
              if (reversed) std::reverse(voxels.begin(), voxels.end());
              voxelbench::reset_workspace(&workspace);
              if (prepared) {
                // Prepared scenes require a dynamic prefix; reverse each
                // section independently to vary discovery order safely.
                if (reversed) {
                  voxels = start;
                  std::reverse(voxels.begin(), voxels.begin() + dynamic_count);
                  std::reverse(voxels.begin() + dynamic_count, voxels.end());
                }
                Check(voxelbench::prepare_scene(&workspace, voxels.data(),
                          static_cast<int32_t>(voxels.size()), 8, 8,
                          static_cast<int32_t>(dynamic_count)),
                      "mounted fixture contact should prepare");
              }
              for (int32_t command = 1; command <= 2; ++command) {
                for (size_t i = 0; i < primary_end; ++i) {
                  if (command == 1 || can_push) {
                    expected[i].x += dx[rotation];
                    expected[i].y += dy[rotation];
                  }
                }
                if (command == 2 && can_push) {
                  for (size_t i = primary_end; i < moving_end; ++i) {
                    expected[i].x += dx[rotation];
                    expected[i].y += dy[rotation];
                  }
                }
                auto reference = expected;
                if (reversed) {
                  if (prepared) {
                    std::reverse(reference.begin(), reference.begin() + dynamic_count);
                    std::reverse(reference.begin() + dynamic_count, reference.end());
                  } else std::reverse(reference.begin(), reference.end());
                }
                voxelbench::reset_motion_state(&state);
                Check(voxelbench::step_command_tick(&workspace, &state, voxels.data(),
                          static_cast<int32_t>(voxels.size()), 8, 8, rotation) ==
                          voxelbench::TickResult::kComplete && state.tick == 1,
                      "mounted fixture push should settle in one tick");
                Check(std::memcmp(voxels.data(), reference.data(),
                          voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                      "mounted fixtures transmit one legal push, never bypassing terrain or weight limits");
              }
            }
          }
        }
      }
    }
  }
}

void TestCarriedFaceFixturesMayShareMovingBodyCells() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  constexpr int32_t dx[] = {0, 1, 0, -1};
  constexpr int32_t dy[] = {-1, 0, 1, 0};
  const char* ramps[] = {"ice-slope-up", "ice-slope-right",
                         "ice-slope-down", "ice-slope-left"};
  for (int32_t rotation = 0; rotation < 4; ++rotation) {
    for (const bool remote_ramp : {false, true}) {
      for (const bool raised_top : {false, true}) {
        for (int32_t blocker = 0; blocker < 4; ++blocker) {
          // A wide carrier pushes a small box with face fixtures. Its front
          // overlaps the small box's collapsed side and top lift cells.
          std::vector<voxelbench::Voxel> start = {
              {3, 4, 2, Role("player"), -1},
              {3, 3, 2, Role("weightless-pushable"), 12},
              {3, 3, 1, Role("weightless-pushable"), 12},
              {3, 4, 1, Role("weightless-pushable"), 12},
              {2, 3, 1, Role("weightless-pushable"), 12},
              {4, 3, 1, Role("weightless-pushable"), 12},
              {3, 2, 1, Role("weightless-pushable"), 13},
              {3, 2, 2, Role("player-lift"), raised_top ? 1 : 0},
              {3, 3, 1, Role("player-lift"), ((2 + rotation) % 4 + 1) * 2},
              {2, 2, 1, Role("player-lift"), ((3 + rotation) % 4 + 1) * 2},
              {4, 2, 1, Role("player-lift"), ((1 + rotation) % 4 + 1) * 2},
          };
          const size_t moving_count = start.size();
          if (blocker != 0) start.push_back({3, 1, blocker == 3 ? 1 : 2,
              Role(blocker == 2 ? "floor" : "wall"), -1});
          const size_t dynamic_count = start.size();
          const auto dynamic_end = static_cast<std::vector<voxelbench::Voxel>::difference_type>(dynamic_count);
          for (int32_t x = 0; x < 7; ++x) {
            for (int32_t y = 0; y < 7; ++y) start.push_back({x, y, 0, Role("floor"), -1});
          }
          if (remote_ramp) start.push_back({6, 6, 1, Role(ramps[rotation]), -1});
          for (auto& voxel : start) {
            for (int32_t turn = 0; turn < rotation; ++turn) {
              const int32_t old_x = voxel.x;
              voxel.x = 6 - voxel.y;
              voxel.y = old_x;
            }
          }
          auto expected = start;
          const bool can_push = blocker == 0 || (blocker == 1 && !raised_top);
          if (can_push) {
            for (size_t i = 0; i < moving_count; ++i) {
              expected[i].x += dx[rotation];
              expected[i].y += dy[rotation];
            }
          }
          for (const bool prepared : {false, true}) {
            for (const bool reversed : {false, true}) {
              auto voxels = start;
              auto reference = expected;
              if (reversed) {
                std::reverse(voxels.begin(), voxels.begin() + dynamic_end);
                std::reverse(voxels.begin() + dynamic_end, voxels.end());
                std::reverse(reference.begin(), reference.begin() + dynamic_end);
                std::reverse(reference.begin() + dynamic_end, reference.end());
              }
              const auto prepare = [&]() {
                voxelbench::reset_workspace(&workspace);
                if (prepared) Check(voxelbench::prepare_scene(&workspace,
                    voxels.data(), static_cast<int32_t>(voxels.size()), 7, 7,
                    static_cast<int32_t>(dynamic_count)), "face-fixture push should prepare");
              };
              prepare();
              voxelbench::reset_motion_state(&state);
              Check(voxelbench::step_command_tick(&workspace, &state, voxels.data(),
                        static_cast<int32_t>(voxels.size()), 7, 7, rotation) ==
                        voxelbench::TickResult::kComplete && state.tick == 1 &&
                        std::memcmp(voxels.data(), reference.data(),
                            voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                    "collapsed fixtures may overlap moving boxes; raised cubes and floors still block");
              voxels = start;
              if (reversed) {
                std::reverse(voxels.begin(), voxels.begin() + dynamic_end);
                std::reverse(voxels.begin() + dynamic_end, voxels.end());
              }
              prepare();
              Check(voxelbench::simulate_quiescent_turn(&workspace, voxels.data(),
                        static_cast<int32_t>(voxels.size()), 7, 7, rotation) == 0 &&
                        std::memcmp(voxels.data(), reference.data(),
                            voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                    "search must share the animated fixture overlap policy");
            }
          }
        }
      }
    }
  }
}

void TestLiftRidesWeightlessCarrierWithStatefulCollision() {
  voxelbench::Voxel lowered[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 2, 1, Role("weightless-pushable"), 0},
      {1, 2, 2, Role("player-lift"), 0},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(lowered, 6, 3, 5, 0) == 0,
        "a push carrying a lowered lift should run");
  Check(lowered[0].y == 2 && lowered[1].y == 1 && lowered[2].y == 1,
        "a lowered non-colliding lift should ride its weightless carrier");

  voxelbench::Voxel raised[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 2, 1, Role("weightless-pushable"), 0},
      {1, 2, 2, Role("player-lift"), 1},
      {1, 1, 2, Role("wall"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(raised, 7, 3, 5, 0) == 0,
        "a blocked raised lift carrier command should run");
  Check(raised[0].y == 3 && raised[1].y == 2 && raised[2].y == 2,
        "a raised lift caught on terrain should anchor its carrier");
}

void TestBlockedPlayerLiftRefusesToRaise() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("player-lift"), 0},
      {1, 1, 2, Role("wall"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 5, 3, 3, 0) == 0,
        "entering a headroom-blocked player lift should run");
  Check(voxels[0].y == 1 && voxels[0].z == 1 &&
            voxels[1].generic_id == 0,
        "a lift must remain lowered rather than embed its player in a blocker");
}

void TestOverlappingPlayerLiftsDoNotDependOnVoxelOrder() {
  voxelbench::Voxel entering[] = {
      {2, 2, 1, Role("player"), -1},
      {2, 1, 1, Role("player-lift"), 0},
      {2, 1, 1, Role("player-lift"), 4},
      {1, 1, 1, Role("wall"), -1},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(entering, 6, 5, 4, 0) == 0,
        "entering incompatible overlapping lifts should finish safely");
  Check(entering[0].y == 1 && entering[0].z == 1 &&
            entering[1].generic_id == 0 && entering[2].generic_id == 4,
        "overlapping lifts must cancel rather than select the first voxel");

  voxelbench::Voxel leaving[] = {
      {2, 1, 1, Role("player"), -1},
      {2, 1, 1, Role("player-lift"), 0},
      {2, 1, 1, Role("player-lift"), 4},
      {1, 1, 1, Role("wall"), -1},
      {2, 1, 0, Role("floor"), -1},
      {2, 0, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(leaving, 6, 5, 4, 0) == 0,
        "leaving incompatible overlapping lifts should finish safely");
  Check(leaving[0].y == 0 && leaving[1].generic_id == 0 &&
            leaving[2].generic_id == 4,
        "vacating an overlap must not raise an arbitrary first lift");
}

void TestOpposingPlayerLiftsRecoilMountedBodies() {
  voxelbench::Voxel voxels[] = {
      {3, 3, 1, Role("player"), -1},
      {3, 2, 1, Role("player-lift"), 4},
      {3, 2, 1, Role("player-lift"), 8},
      {2, 2, 1, Role("weightless-pushable"), 0},
      {4, 2, 1, Role("weightless-pushable"), 1},
      {3, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {3, 2, 0, Role("floor"), -1},
      {4, 2, 0, Role("floor"), -1},
      {5, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 11, 7, 5, 0) == 0,
        "opposed mounted lifts should resolve as one command");
  Check(voxels[0].x == 3 && voxels[0].y == 2 && voxels[0].z == 1,
        "balanced opposed lifts should leave their rider centered");
  Check(voxels[1].x == 2 && voxels[1].generic_id == 5 &&
            voxels[2].x == 4 && voxels[2].generic_id == 9,
        "both opposed lift fixtures should raise and recoil together");
  Check(voxels[3].x == 1 && voxels[4].x == 5,
        "each mounted body should receive its lift's recoil proposal");
}

void TestSearchTracksPlayerLiftState() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("player-lift"), 0},
      {1, 1, 2, Role("goal"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 5, 3, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved &&
            result.moves == 1 && result.solution_length == 1 &&
            result.solution[0] == 0,
        "exact search should preserve lift state while solving through a toggle");
}

void TestOrangeButtonUsesASeparateWallTick() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("orange-button"), 0},
      {2, 1, 1, Role("orange-wall"), 0},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 6, 3, 3, 0) ==
            voxelbench::TickResult::kMore,
        "entering an orange button should expose its entry frame");
  Check(state.tick == 1 && voxels[0].y == 1 &&
            voxels[1].generic_id == 0 && voxels[2].generic_id == 0,
        "the entry frame should precede the linked mechanism animation");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 6, 3, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "the linked orange-wall tick should complete the command");
  Check(state.tick == 2 && voxels[1].generic_id == 0 &&
            voxels[2].generic_id == 1,
        "button pressure should lower every wall without changing the button");
  Check(voxelbench::simulate_turn(voxels, 6, 3, 3, 2) == 0 &&
            voxels[0].y == 2 && voxels[1].generic_id == 0 &&
            voxels[2].generic_id == 0,
        "leaving an orange button should release it and raise every wall");
}

void TestOrangeWallCarriesItsMountedButtonInTheSameTick() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {0, 1, 1, Role("orange-button"), 0},
      {1, 1, 1, Role("orange-wall"), 0},
      {1, 1, 2, Role("orange-button"), 0},
      {0, 2, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 2, 3, 0) ==
            voxelbench::TickResult::kMore,
        "entering a button should precede its linked wall motion");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 7, 2, 3, 0) ==
            voxelbench::TickResult::kComplete,
        "a wall and its mounted button should share one mechanism tick");
  Check(state.tick == 2 && voxels[2].generic_id == 1 && voxels[3].z == 1,
        "a top-mounted button should descend with a wall that becomes a face");
  Check(voxelbench::simulate_turn(voxels, 7, 2, 3, 2) == 0 &&
            voxels[0].y == 2 && voxels[2].generic_id == 0 && voxels[3].z == 2,
        "the mounted button should rise with the wall after pressure is released");
}

void TestOrangeWallCarriesItsMountedLiftInTheSameTick() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 5, 1, Role("player"), -1},
      {1, 4, 1, Role("orange-button"), 0},
      {1, 1, 1, Role("orange-wall"), 0},
      {1, 1, 2, Role("orange-wall"), 0},
      // Raised east-facing lift attached to the upper wall's east face.
      {2, 1, 2, Role("player-lift"), 5},
      {1, 5, 0, Role("floor"), -1},
      {1, 4, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 9, 3, 6, 0) ==
            voxelbench::TickResult::kMore,
        "entering a button should precede attached-lift wall motion");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 9, 3, 6, 0) ==
            voxelbench::TickResult::kComplete,
        "an Orange Wall and its mounted lift should share one mechanism tick");
  Check(state.tick == 2 && voxels[2].generic_id == 1 &&
            voxels[3].generic_id == 1 && voxels[4].z == 1 &&
            voxels[4].generic_id == 5,
        "a side-mounted lift should descend with its wall and retain its state");
}

void TestLoweredWallMountedLiftMayOverlapTerrain() {
  voxelbench::Voxel voxels[] = {
      {1, 5, 1, Role("player"), -1},
      {1, 4, 1, Role("orange-button"), 0},
      {1, 1, 1, Role("orange-wall"), 0},
      {1, 1, 2, Role("orange-wall"), 0},
      {2, 1, 2, Role("player-lift"), 4},
      {2, 1, 1, Role("wall"), -1},
      {1, 5, 0, Role("floor"), -1},
      {1, 4, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 10, 3, 6, 0) == 0,
        "a lowered wall-mounted lift may enter occupied terrain");
  Check(voxels[2].generic_id == 1 && voxels[3].generic_id == 1 &&
            voxels[4].z == 1 && voxels[4].generic_id == 4,
        "a lowered lift should remain attached while overlapping a solid cube");
}

void TestWallMountedLiftCannotDescendIntoFloor() {
  voxelbench::Voxel voxels[] = {
      {1, 5, 1, Role("player"), -1},
      {1, 4, 1, Role("orange-button"), 0},
      {1, 1, 1, Role("orange-wall"), 0},
      {2, 1, 1, Role("player-lift"), 4},
      {1, 5, 0, Role("floor"), -1},
      {1, 4, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 8, 3, 6, 0) == 0,
        "a wall-mounted lift blocked by Row-0 Floor should finish safely");
  Check(voxels[2].generic_id == 0 && voxels[2].z == 1 &&
            voxels[3].z == 1,
        "Row-0 Floor should hold both the wall and its mounted lift in place");
}

void TestOrangeWallDeliversPlayerOntoMountedLift() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {2, 2, 1, Role("player"), -1},
      {2, 1, 1, Role("orange-button"), 0},
      {1, 1, 1, Role("orange-wall"), 0},
      {1, 1, 2, Role("orange-wall"), 0},
      {2, 1, 2, Role("player-lift"), 4},
      {2, 2, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {3, 1, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 9, 4, 4, 0) ==
            voxelbench::TickResult::kMore,
        "the player should first enter the wall button");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 9, 4, 4, 0) ==
            voxelbench::TickResult::kMore,
        "the wall should next lower its mounted lift onto the player");
  Check(state.tick == 2 && voxels[4].z == 1 && voxels[4].generic_id == 4,
        "the wall tick should expose the lowered side lift frame");
  const auto lift_tick = voxelbench::step_tick(
      &workspace, &state, voxels, 9, 4, 4, 0);
  if (lift_tick != voxelbench::TickResult::kComplete) {
    std::cerr << "lift delivery diagnostic: result="
              << static_cast<int32_t>(lift_tick) << " tick=" << state.tick
              << " phase=" << static_cast<int32_t>(state.phase)
              << " player=" << voxels[0].x << ',' << voxels[0].y << ','
              << voxels[0].z << " lift=" << voxels[4].z << '#'
              << voxels[4].generic_id << " wall=" << voxels[2].generic_id
              << ',' << voxels[3].generic_id << '\n';
  }
  Check(lift_tick == voxelbench::TickResult::kComplete,
        "a lift delivered onto the player should actuate on the next tick");
  Check(state.tick == 3 && voxels[0].x == 3 &&
            voxels[4].generic_id == 5,
        "the delivered side lift should raise and eject the player outward");
}

void TestOrangeButtonRidesTopLiftAndChangesVisibility() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 2, Role("player"), -1},
      {1, 1, 1, Role("player-lift"), 1},
      {2, 1, 1, Role("orange-button"), 4},
      {1, 2, 1, Role("wall"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 7, 3, 3, 0) == 0,
        "entering a raised lift with an attached button should run");
  Check(voxels[0].z == 1 && voxels[1].generic_id == 0 &&
            voxels[2].z == 0 && voxels[2].generic_id == 5,
        "the attached button should lower with the lift and become hidden");
  voxels[0].y = 2;
  voxels[3].x = -1;
  Check(voxelbench::simulate_turn(voxels, 7, 3, 3, 0) == 0,
        "re-entering the lowered lift should run");
  Check(voxels[0].z == 2 && voxels[1].generic_id == 1 &&
            voxels[2].z == 1 && voxels[2].generic_id == 4,
        "the attached button should rise with the lift and become visible");
}

void TestMovingPolycubeCarriesButtonsMountedOnEveryFace() {
  voxelbench::Voxel voxels[] = {
      {1, 5, 1, Role("player"), -1},
      {1, 4, 1, Role("weightless-pushable"), 0},
      {0, 4, 1, Role("orange-button"), 8},
      {1, 3, 1, Role("orange-button"), 2},
      {1, 5, 1, Role("orange-button"), 6},
      {2, 4, 1, Role("orange-button"), 4},
      {1, 4, 2, Role("orange-button"), 0},
      {1, 5, 0, Role("floor"), -1},
      {1, 4, 0, Role("floor"), -1},
      {1, 3, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {2, 4, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 12, 6, 6, 0) == 0,
        "pushing a button-covered polycube should run");
  Check(voxels[1].y == 3 && voxels[2].y == 3 && voxels[3].y == 2 &&
            voxels[4].y == 4 && voxels[5].y == 3 && voxels[6].y == 3,
        "buttons mounted on every face should translate with their host");
}

void TestReleasedOrangeColumnRaisesEveryVoxelAfterJoining() {
  voxelbench::Voxel voxels[46]{};
  int32_t count = 0;
  int32_t upper_wall = -1;
  int32_t lower_wall = -1;
  for (int32_t x = 0; x < 6; ++x) {
    for (int32_t y = 0; y < 6; ++y) {
      if (x == 1 && y == 3) {
        lower_wall = count;
        voxels[count++] = {x, y, 1, Role("orange-wall"), 2};
      }
      voxels[count++] = {x, y, 0, Role("floor"), -1};
      if (x == 1 && y == 2) {
        upper_wall = count;
        voxels[count++] = {x, y, 2, Role("orange-wall"), 2};
      }
      if (y != 3 || x < 1 || x > 3) continue;
      if (x == 1) {
        voxels[count++] = {x, y, 1, Role("player"), -1};
        voxels[count++] = {x, y, 2, Role("weightless-pushable"), 0};
      } else {
        voxels[count++] = {x, y, 1, Role("orange-button"), 0};
        voxels[count++] = {x, y, 1, Role("weightless-pushable"), 0};
        voxels[count++] = {x, y, 2, Role("weightless-pushable"), 0};
      }
    }
  }
  static voxelbench::PhysicsWorkspace workspace;
  voxelbench::reset_workspace(&workspace);
  Check(voxelbench::simulate_turn(&workspace, voxels, count, 6, 6, 0) == 0,
        "releasing a carried orange-wall assembly should run");
  Check(voxels[upper_wall].generic_id == 0 &&
            voxels[lower_wall].generic_id == 0 &&
            voxels[upper_wall].y == 2 && voxels[lower_wall].y == 2,
        "every voxel in the newly joined orange column should fully raise");
}

void TestHeldButtonsPreserveOrangeWallAnchors() {
  voxelbench::Voxel voxels[30]{};
  int32_t count = 0;
  for (int32_t y = 0; y < 4; ++y) {
    for (int32_t x = 0; x < 6; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  voxels[count++] = {0, 1, 1, Role("player"), -1};
  voxels[count++] = {2, 1, 1, Role("orange-button"), 0};
  voxels[count++] = {2, 2, 1, Role("orange-button"), 0};
  voxels[count++] = {2, 1, 1, Role("weightless-pushable"), 0};
  voxels[count++] = {4, 2, 1, Role("orange-wall"), 0};
  voxels[count++] = {4, 2, 2, Role("orange-wall"), 0};
  const int32_t directions[] = {1, 2, 1, 3};
  const int32_t depths[] = {1, 1, 2, 1};
  for (int32_t step = 0; step < 4; ++step) {
    Check(voxelbench::simulate_turn(voxels, count, 6, 4, directions[step]) == 0,
          "held-button orange regression command should run");
    Check(voxels[28].z == 1 && voxels[29].z == 2 &&
              voxels[28].generic_id == depths[step] &&
              voxels[29].generic_id == depths[step],
          "partially normalized orange walls must keep their raised anchors");
  }
}

void TestTallOrangeWallCarriesWideStackAcrossWorkspaceResume() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (const int32_t height : {2, 3}) {
    std::vector<voxelbench::Voxel> voxels = {
        {0, 2, 1, Role("player"), -1},
        {0, 1, 1, Role("orange-button"), 0},
        {2, 2, height + 1, Role("weightless-pushable"), 17},
        {3, 2, height + 1, Role("weightless-pushable"), 17},
        {3, 2, height + 2, Role("pushable"), -1},
    };
    for (int32_t x = 2; x <= 3; ++x) {
      for (int32_t z = 1; z <= height; ++z) {
        voxels.push_back({x, 2, z, Role("orange-wall"), 0});
      }
    }
    for (int32_t y = 0; y < 5; ++y) {
      for (int32_t x = 0; x < 7; ++x) voxels.push_back({x, y, 0, Role("floor"), -1});
    }
    for (const int32_t direction : {0, 2, 0, 2}) {
      const int32_t depth = direction == 0 ? 1 : 0;
      voxelbench::reset_motion_state(&state);
      bool complete = false;
      for (int32_t call = 0; call < 6; ++call) {
        voxelbench::reset_workspace(&workspace);
        const auto result = voxelbench::step_tick(&workspace, &state, voxels.data(),
            static_cast<int32_t>(voxels.size()), 7, 5, direction);
        Check(result == voxelbench::TickResult::kMore || result == voxelbench::TickResult::kComplete,
              "resumed orange wall movement must remain valid");
        const int32_t frame_depth = voxels[5].generic_id;
        for (int32_t i = 5; i < 5 + height * 2; ++i) {
          Check(voxels[i].generic_id == frame_depth && voxels[i].z == (i - 5) % height + 1,
                "a tall wall must move all rows together without shifting its anchors");
        }
        Check(voxels[2].z == height + 1 - frame_depth && voxels[3].z == voxels[2].z &&
                  voxels[4].z == voxels[2].z + 1,
              "the wide body and its passenger must follow the same wall tick");
        if (result == voxelbench::TickResult::kComplete) { complete = true; break; }
      }
      Check(complete && state.tick == 2 && voxels[5].generic_id == depth,
            "raising and lowering should each finish in one actuator tick after input");
    }
  }
}

void TestOrangeWallChecksPlayerHeadroomAboveCarriedBody() {
  for (const bool ceiling : {false, true}) {
    std::vector<voxelbench::Voxel> voxels = {
        {2, 2, 3, Role("player"), -1},
        {2, 2, 3, Role("orange-button"), 0},
        {2, 2, 2, Role("weightless-pushable"), 17},
        {3, 2, 2, Role("weightless-pushable"), 17},
        {2, 2, 1, Role("orange-wall"), 1},
        {2, 2, 2, Role("orange-wall"), 1},
        {3, 2, 1, Role("orange-wall"), 1},
        {3, 2, 2, Role("orange-wall"), 1},
        {5, 2, 1, Role("orange-wall"), 1},
    };
    if (ceiling) voxels.push_back({3, 2, 4, Role("solid"), -1});
    for (int32_t y = 0; y < 5; ++y) {
      for (int32_t x = 0; x < 7; ++x) voxels.push_back({x, y, 0, Role("floor"), -1});
    }
    Check(voxelbench::simulate_turn(voxels.data(), static_cast<int32_t>(voxels.size()), 7, 5, 1) == 0,
          "leaving the rider's button should finish safely");
    Check(voxels[0].x == 3 && voxels[0].z == (ceiling ? 3 : 4) &&
              voxels[2].z == (ceiling ? 2 : 3) && voxels[3].z == voxels[2].z,
          "the player's ceiling collision must hold the entire wall and carried body");
    for (int32_t i = 4; i < 8; ++i) {
      Check(voxels[i].generic_id == (ceiling ? 1 : 0),
            "a blocked wall must restore every row without a partial rise");
    }
    Check(voxels[8].generic_id == 0, "an unconnected wall must remain free to rise");
  }
}

void TestOrangeControlScopesRemainIndependent() {
  const auto scoped = [](int32_t scope, int32_t value) {
    return voxelbench::kOrangeScopedIdFlag |
        (scope << voxelbench::kOrangeScopeShift) | value;
  };
  voxelbench::Voxel voxels[31]{};
  int32_t count = 0;
  for (int32_t y = 0; y < 4; ++y) {
    for (int32_t x = 0; x < 6; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  voxels[count++] = {0, 1, 1, Role("player"), -1};
  voxels[count++] = {2, 1, 1, Role("orange-button"), scoped(1, 0)};
  voxels[count++] = {2, 2, 1, Role("orange-button"), scoped(2, 0)};
  voxels[count++] = {2, 1, 1, Role("weightless-pushable"), 0};
  voxels[count++] = {4, 2, 1, Role("orange-wall"), scoped(1, 0)};
  voxels[count++] = {5, 2, 1, Role("orange-wall"), scoped(2, 0)};
  voxels[count++] = {4, 3, 1, Role("orange-wall"), 0};
  const int32_t directions[] = {1, 2, 1, 3};
  const int32_t second_depths[] = {0, 0, 1, 0};
  for (int32_t step = 0; step < 4; ++step) {
    Check(voxelbench::simulate_turn(voxels, count, 6, 4, directions[step]) == 0,
          "independent orange scopes should simulate");
    Check(voxels[28].generic_id == scoped(1, 1) &&
              voxels[29].generic_id == scoped(2, second_depths[step]) &&
              voxels[30].generic_id == 0,
          "even touching walls must listen only to buttons in their own scope");
    Check(voxels[28].z == 1 && voxels[29].z == 1 && voxels[30].z == 1,
          "independent controls must preserve raised wall anchors");
  }
}

void TestOrangeWallsCountEveryPressedButton() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {0, 2, 0, Role("floor"), -1},
      {1, 1, 1, Role("orange-button"), 0},
      {1, 1, 1, Role("pushable"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 1, 1, Role("orange-button"), 2},
      {2, 1, 1, Role("pushable"), -1},
      {2, 1, 0, Role("floor"), -1},
      {2, 2, 1, Role("solid"), -1},
      {3, 1, 3, Role("orange-wall"), 0},
  };
  Check(voxelbench::simulate_turn(voxels, 10, 4, 3, 3) == 0,
        "a command should synchronize multiple pressed orange buttons");
  Check(voxels[2].generic_id == 0 && voxels[5].generic_id == 2,
        "button pressure should preserve the orientation-only mechanism IDs");
  Check(voxels[9].generic_id == 2,
        "two independently pressed buttons should lower a wall two units");
}

void TestFlattenedOrangeWallIsPassThroughOnFloor() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("orange-wall"), 0},
      {2, 2, 1, Role("orange-button"), 0},
      {2, 2, 1, Role("pushable"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 7, 3, 3, 0) == 0,
        "walking through a button-flattened orange wall should run");
  Check(voxels[0].x == 1 && voxels[0].y == 1 && voxels[0].z == 1,
        "a wall flattened against Floor should not block the player");
  Check(voxels[1].generic_id == 1 && voxels[2].generic_id == 0,
        "the final frame should retain wall depth without a button state");
}

void TestFloatingOrangeWallLowersAsACube() {
  voxelbench::Voxel voxels[] = {
      {0, 2, 1, Role("player"), -1},
      {0, 2, 0, Role("floor"), -1},
      {1, 1, 1, Role("orange-wall"), 0},
      {1, 1, 2, Role("pushable"), -1},
      {2, 2, 1, Role("orange-button"), 0},
      {2, 2, 1, Role("pushable"), -1},
      {2, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 7, 3, 3, 3) == 0,
        "a floating linked orange wall should finish its lowering tick");
  Check(voxels[2].generic_id == 1 && voxels[3].z == 1,
        "a wall over empty space should descend as a full cube and carry its rider");
}

void TestProjectedOrangeFaceTransitionsWithDepth() {
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      // Canonical C++ input stores the raised anchor (z=1) plus depth 1. The
      // floor at z=0 projects this record into a pass-through face at row 1.
      {1, 1, 1, Role("orange-wall"), 1},
      {2, 2, 1, Role("orange-button"), 0},
      {2, 2, 1, Role("pushable"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 7, 3, 3, 0) == 0 &&
            voxels[0].y == 1 && voxels[1].generic_id == 1,
        "a projected Orange Face should remain pass-through while its button stays pressed");
  voxels[3].x = -1;
  Check(voxelbench::simulate_turn(voxels, 7, 3, 3, 2) == 0 &&
            voxels[1].generic_id == 0,
        "a released Orange Face should return to a solid cube at depth zero");
}

void TestSearchTracksOrangeWallDepth() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("orange-wall"), 0},
      {2, 2, 1, Role("orange-button"), 0},
      {2, 2, 1, Role("pushable"), -1},
      {1, 0, 1, Role("goal"), -1},
      {1, 2, 0, Role("floor"), -1},
      {1, 1, 0, Role("floor"), -1},
      {1, 0, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 9, 3, 3, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved &&
            result.moves == 2,
        "exact search should hash linked orange-wall depth and solve through it");
}

void TestPuncherRedirectsPlayerAndResetsVisually() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 2, 1, Role("puncher"), 2},  // Right-facing, unsprung.
      {0, 2, 1, Role("wall"), -1},
      {4, 2, 1, Role("wall"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {3, 2, 0, Role("floor"), -1},
      {4, 2, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::simulate_command(
            &workspace, &state, voxels, 9, 5, 5, 0) == 0,
        "a player punch route should quiesce");
  Check(voxels[0].x == 3 && voxels[0].y == 2,
        "a puncher should redirect the player and preserve its impulse until blocked");
  Check(voxels[1].generic_id == 2,
        "a puncher should expose its sprung frame and reset before completion");
}

void TestCloneLiftActivationSurvivesWorkspaceResumeAndSearch() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (int32_t rotation = 0; rotation < 4; ++rotation) {
    for (const bool raised : {false, true}) {
      for (int32_t body_height = 1; body_height <= 2; ++body_height) {
        for (const bool blocked : {false, true}) {
          if (raised && blocked) continue;
          std::vector<voxelbench::Voxel> initial = {
              {0, 0, 1, Role("player"), -1},
              {2, 3, raised ? 2 : 1, Role("clone"), 17},
              {2, 2, 1, Role("player-lift"), raised ? 1 : 0},
          };
          if (body_height == 2) {
            initial.push_back({2, 3, raised ? 3 : 2, Role("clone"), 17});
          }
          if (raised) initial.push_back({2, 3, 1, Role("wall"), -1});
          if (blocked) initial.push_back({2, 2, body_height + 1, Role("wall"), -1});
          const int32_t dynamic_count = static_cast<int32_t>(initial.size());
          for (int32_t y = 0; y < 6; ++y) {
            for (int32_t x = 0; x < 6; ++x) {
              initial.push_back({x, y, 0, Role("floor"), -1});
            }
          }
          for (auto& voxel : initial) {
            for (int32_t turn = 0; turn < rotation; ++turn) {
              const int32_t x = voxel.x;
              voxel.x = 5 - voxel.y;
              voxel.y = x;
            }
          }
          auto entered = initial;
          constexpr int32_t dx[] = {0, 1, 0, -1};
          constexpr int32_t dy[] = {-1, 0, 1, 0};
          for (auto& voxel : entered) {
            if (voxel.role != Role("clone")) continue;
            voxel.x += dx[rotation];
            voxel.y += dy[rotation];
          }
          auto expected = entered;
          if (!blocked) {
            expected[2].generic_id ^= 1;
            for (auto& voxel : expected) {
              if (voxel.role == Role("clone")) voxel.z += raised ? -1 : 1;
            }
          }
          const int32_t count = static_cast<int32_t>(initial.size());
          for (const bool prepared : {false, true}) {
            for (const bool resumed : {false, true}) {
              auto voxels = initial;
              const auto prepare = [&]() {
                voxelbench::reset_workspace(&workspace);
                if (prepared) {
                  Check(voxelbench::prepare_scene(&workspace, voxels.data(), count,
                            6, 6, dynamic_count),
                        "clone lift scene must prepare for search or resume");
                }
              };
              prepare();
              voxelbench::reset_motion_state(&state);
              Check(voxelbench::step_command_tick(&workspace, &state, voxels.data(),
                        count, 6, 6, rotation) == voxelbench::TickResult::kMore &&
                        state.tick == 1 && std::memcmp(voxels.data(), entered.data(),
                            voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                    "clone entry must precede its lift activation frame");
              if (resumed) prepare();
              Check(voxelbench::step_command_tick(&workspace, &state, voxels.data(),
                        count, 6, 6, rotation) == voxelbench::TickResult::kComplete &&
                        state.tick == (blocked ? 1 : 2) &&
                        std::memcmp(voxels.data(), expected.data(),
                            voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                    "a resumed lift must move the whole clone or reject it atomically");
              voxels = initial;
              prepare();
              Check(voxelbench::simulate_quiescent_turn(&workspace, voxels.data(),
                        count, 6, 6, rotation, true) == 0 &&
                        std::memcmp(voxels.data(), expected.data(),
                            voxels.size() * sizeof(voxelbench::Voxel)) == 0,
                    "prepared search must match animated clone lift activation");
            }
          }
        }
      }
    }
  }
}

void TestPunchMomentumCrossesRaisedAndLoweredLifts() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (int32_t rotation = 0; rotation < 4; ++rotation) {
    const auto rotate = [rotation](voxelbench::Voxel voxel) {
      for (int32_t turn = 0; turn < rotation; ++turn) {
        const int32_t x = voxel.x;
        voxel.x = 5 - voxel.y;
        voxel.y = x;
      }
      return voxel;
    };
    for (const bool resume_workspace : {false, true}) {
      std::vector<voxelbench::Voxel> voxels = {
          {1, 4, 2, Role("player"), -1},
          {1, 3, 2, Role("puncher"), ((1 + rotation) % 4) * 2},
          {2, 3, 1, Role("player-lift"), 1},
          {3, 3, 2, Role("player-lift"), 0},
          {0, 3, 2, Role("solid"), -1},
          {5, 3, 2, Role("solid"), -1},
          {1, 4, 1, Role("solid"), -1},
      };
      for (int32_t x = 0; x < 6; ++x) {
        if (x != 2) voxels.push_back({x, 3, 1, Role("solid"), -1});
      }
      for (int32_t y = 0; y < 6; ++y) {
        for (int32_t x = 0; x < 6; ++x) {
          voxels.push_back({x, y, 0, Role("floor"), -1});
        }
      }
      for (auto& voxel : voxels) voxel = rotate(voxel);
      const auto initial = voxels;
      const int32_t count = static_cast<int32_t>(voxels.size());
      voxelbench::reset_workspace(&workspace);
      voxelbench::reset_motion_state(&state);
      bool complete = false;
      int32_t previous_tick = 0;
      for (int32_t call = 0; call < 8; ++call) {
        if (resume_workspace) voxelbench::reset_workspace(&workspace);
        const auto result = voxelbench::step_tick(
            &workspace, &state, voxels.data(), count, 6, 6, rotation);
        Check(result == voxelbench::TickResult::kMore ||
                  result == voxelbench::TickResult::kComplete,
              "punch crossing lifts must remain valid after workspace resume");
        if (state.tick != previous_tick) {
          previous_tick = state.tick;
          Check(state.tick >= 1 && state.tick <= 4,
                "crossing lifts must not insert lift animation ticks");
          const auto expected = rotate({state.tick, 3, 2, Role("player"), -1});
          Check(voxels[0].x == expected.x && voxels[0].y == expected.y &&
                    voxels[0].z == expected.z,
                "each punch tick must advance horizontally through both lifts");
          Check(voxels[2].generic_id == 1 && voxels[3].generic_id == 0,
                "punch momentum must leave raised and lowered lift states unchanged");
        }
        if (result == voxelbench::TickResult::kComplete) {
          complete = true;
          break;
        }
      }
      Check(complete && state.tick == 4 &&
                voxels[1].generic_id == ((1 + rotation) % 4) * 2,
            "the punch must stop at the wall and rearm in four frames");
      const auto expected_final = voxels;
      voxels = initial;
      voxelbench::reset_workspace(&workspace);
      Check(voxelbench::simulate_command(
                &workspace, &state, voxels.data(), count, 6, 6, rotation) == 0,
            "the final-state punch command must settle");
      Check(std::memcmp(voxels.data(), expected_final.data(),
                       voxels.size() * sizeof(voxelbench::Voxel)) == 0,
            "animated and final-state punch commands must agree across lifts");
    }
  }
}

void TestInitialPuncherContactWaitsForCommand() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  std::vector<voxelbench::Voxel> voxels = {
      {2, 1, 1, Role("weightless-pushable"), 17},
      {2, 2, 1, Role("player"), -1},
      {2, 2, 1, Role("puncher"), 4},  // Down-facing, mounted to the front box.
      {2, 3, 1, Role("weightless-pushable"), 53},
      {2, 4, 1, Role("solid"), -1},
  };
  for (int32_t y = 0; y < 6; ++y) {
    for (int32_t x = 0; x < 6; ++x) {
      voxels.push_back({x, y, 0, Role("floor"), -1});
    }
  }
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  const auto tick = [&]() {
    return voxelbench::step_tick(
        &workspace, &state, voxels.data(), static_cast<int32_t>(voxels.size()), 6, 6, 0);
  };
  Check(tick() == voxelbench::TickResult::kMore && state.tick == 1,
        "the commanded push should precede the punch");
  Check(voxels[0].y == 0 && voxels[1].y == 1 && voxels[2].y == 1 &&
            voxels[2].generic_id == 4,
        "the player, box and mounted unsprung puncher should move together");
  Check(tick() == voxelbench::TickResult::kMore && state.tick == 2 &&
            voxels[1].y == 2 && voxels[2].generic_id == 5,
        "the puncher should fire on the following tick");
  Check(tick() == voxelbench::TickResult::kComplete && state.tick == 3 &&
            voxels[1].y == 2 && voxels[2].y == 1 && voxels[2].generic_id == 4 &&
            voxels[3].y == 3,
        "the blocked punch should stop the player and reset the fixture visually");
}

void TestBlockedPunchRearmsForNextCommand() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  std::vector<voxelbench::Voxel> voxels = {
      {2, 1, 1, Role("weightless-pushable"), 17},
      {3, 2, 1, Role("player"), -1},
      {2, 2, 1, Role("puncher"), 4},
      {2, 3, 1, Role("weightless-pushable"), 53},
      {2, 4, 1, Role("solid"), -1},
  };
  for (int32_t y = 0; y < 6; ++y) {
    for (int32_t x = 0; x < 6; ++x) {
      voxels.push_back({x, y, 0, Role("floor"), -1});
    }
  }
  const auto count = static_cast<int32_t>(voxels.size());
  voxelbench::reset_workspace(&workspace);
  Check(voxelbench::simulate_command(
            &workspace, &state, voxels.data(), count, 6, 6, 3) == 0 &&
            voxels[1].x == 2 && voxels[1].y == 2 && voxels[2].generic_id == 5,
        "approaching from the side should end on a blocked sprung punch");
  voxelbench::reset_motion_state(&state);
  const auto tick = [&]() {
    return voxelbench::step_tick(&workspace, &state, voxels.data(), count, 6, 6, 0);
  };
  Check(tick() == voxelbench::TickResult::kMore && state.tick == 1 &&
            voxels[0].y == 0 && voxels[1].y == 1 && voxels[2].y == 1 &&
            voxels[2].generic_id == 4,
        "the next commanded push should rearm and carry the puncher");
  Check(tick() == voxelbench::TickResult::kMore && state.tick == 2 &&
            voxels[1].y == 2 && voxels[2].generic_id == 5,
        "a punch blocked last command must still fire after the next push");
  Check(tick() == voxelbench::TickResult::kComplete && state.tick == 3 &&
            voxels[1].y == 2 && voxels[2].generic_id == 4,
        "the new punch should finish with the fixture rearmed");
}

void TestPunchedBodyTransfersPlayerImpulseAcrossWorkspaceResume() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (const int32_t stop_y : {6, 9}) {
    std::vector<voxelbench::Voxel> voxels = {
        {3, 5, 1, Role("player"), -1},
        {3, 4, 1, Role("weightless-pushable"), 17},
        {4, 4, 1, Role("weightless-pushable"), 17},
        {5, 4, 1, Role("weightless-pushable"), 17},
        {5, 3, 1, Role("puncher"), 4},
        {5, 2, 1, Role("solid"), -1},
        {3, stop_y, 1, Role("solid"), -1},
    };
    for (int32_t y = 0; y < 10; ++y) {
      for (int32_t x = 0; x < 10; ++x) {
        voxels.push_back({x, y, 0, Role("floor"), -1});
      }
    }
    voxelbench::reset_motion_state(&state);
    bool complete = false;
    for (int32_t call = 0; call < 10; ++call) {
      // Scratch workspace contents are disposable between ticks. Only the
      // board and public MotionState may carry a transferred impulse forward.
      voxelbench::reset_workspace(&workspace);
      const auto result = voxelbench::step_tick(&workspace, &state, voxels.data(),
          static_cast<int32_t>(voxels.size()), 10, 10, 0);
      Check(result == voxelbench::TickResult::kMore ||
                result == voxelbench::TickResult::kComplete,
            "resumed punched convoy must remain valid");
      Check(voxels[0].y == voxels[1].y + 1,
            "the body and player must advance together without overlapping");
      if (state.tick == 2) {
        Check(voxels[0].y == 5 && voxels[1].y == 4 && voxels[4].generic_id == 5,
              "the initial body impulse must punch the player on the same tick");
      }
      if (result == voxelbench::TickResult::kComplete) {
        complete = true;
        break;
      }
    }
    Check(complete && voxels[0].y == stop_y - 1 && voxels[1].y == stop_y - 2 &&
              voxels[2].y == voxels[1].y && voxels[3].y == voxels[1].y &&
              voxels[4].generic_id == 4,
          "a wall behind the player must stop the complete contact chain");
  }
}

void TestPunchedPlayerPushesConvoyAcrossFloorGap() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  const char* slope_roles[] = {"blue-box-slope-up", "blue-box-slope-right",
      "blue-box-slope-down", "blue-box-slope-left"};
  for (const bool slope_box : {false, true}) {
    for (const bool remote_slope : {false, true}) {
      for (int32_t rotation = 0; rotation < 4; ++rotation) {
        std::vector<voxelbench::Voxel> initial = {
            {4, 6, 1, Role("player"), -1},
            {5, 5, 1, Role(slope_box ? slope_roles[rotation] : "weightless-pushable"), 17},
            {4, 5, 1, Role("puncher"), ((1 + rotation) % 4) * 2},
            {3, 5, 1, Role("solid"), -1},
            {14, 5, 1, Role("solid"), -1},
        };
        for (int32_t y = 0; y < 16; ++y) {
          for (int32_t x = 0; x < 16; ++x) {
            if ((x == 9 || x == 10) && y == 5) continue;
            initial.push_back({x, y, 0,
                Role(remote_slope && x == 0 && y == 0 ? "ice-slope-up" : "floor"), -1});
          }
        }
        auto rotate = [rotation](voxelbench::Voxel voxel) {
          for (int32_t turn = 0; turn < rotation; ++turn) {
            const int32_t x = voxel.x;
            voxel.x = 15 - voxel.y;
            voxel.y = x;
          }
          return voxel;
        };
        for (auto& voxel : initial) {
          if (voxel.role == Role("ice-slope-up")) {
            const char* ice_roles[] = {"ice-slope-up", "ice-slope-right",
                "ice-slope-down", "ice-slope-left"};
            voxel.role = Role(ice_roles[rotation]);
          }
          voxel = rotate(voxel);
        }
        for (int32_t mode = 0; mode < 4; ++mode) {
          auto voxels = initial;
          voxelbench::reset_workspace(&workspace);
          voxelbench::reset_motion_state(&state);
          if (mode == 2 || mode == 3) {
            Check(voxelbench::prepare_scene(&workspace, voxels.data(),
                      static_cast<int32_t>(voxels.size()), 16, 16, 3),
                  "punched gap scene should prepare");
          }
          if (mode == 3) {
            Check(voxelbench::simulate_quiescent_turn(&workspace, voxels.data(),
                      static_cast<int32_t>(voxels.size()), 16, 16, rotation) == 0,
                  "fast punched gap command should settle");
          } else {
            bool complete = false;
            for (int32_t tick = 1; tick <= 12; ++tick) {
              if (mode == 1) voxelbench::reset_workspace(&workspace);
              const auto result = voxelbench::step_tick(&workspace, &state,
                  voxels.data(), static_cast<int32_t>(voxels.size()), 16, 16, rotation);
              const auto player = rotate({state.tick == 1 ? 4 : 3 + state.tick, 5, 1, 0, 0});
              const auto box = rotate({4 + state.tick, 5, 1, 0, 0});
              Check(voxels[0].x == player.x && voxels[0].y == player.y && voxels[0].z == 1 &&
                        voxels[1].x == box.x && voxels[1].y == box.y && voxels[1].z == 1,
                    "punch impulse should carry player and box across the gap on each tick");
              if (result == voxelbench::TickResult::kComplete) {
                complete = true;
                Check(state.tick == 9, "the stop wall should end the convoy on tick nine");
                break;
              }
            }
            Check(complete, "punched gap command should settle without a cycle");
          }
          const auto player = rotate({12, 5, 1, 0, 0});
          const auto box = rotate({13, 5, 1, 0, 0});
          Check(voxels[0].x == player.x && voxels[0].y == player.y && voxels[0].z == 1 &&
                    voxels[1].x == box.x && voxels[1].y == box.y && voxels[1].z == 1 &&
                    voxels[2].generic_id == initial[2].generic_id,
                "wall collision should stop the punched convoy and leave the puncher rearmed");
        }
      }
    }
  }
}

void TestPunchedCarrierKeepsMountedFixtureAcrossGap() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  std::vector<voxelbench::Voxel> voxels = {
      {0, 5, 1, Role("player"), -1},
      {0, 4, 1, Role("weightless-pushable"), 17},
      {1, 3, 1, Role("weightless-pushable"), 53},
      {1, 4, 1, Role("puncher"), 2},
      {1, 4, 1, Role("puncher"), 4},
      {5, 3, 1, Role("solid"), -1},
  };
  for (int32_t y = 0; y < 6; ++y) {
    for (int32_t x = 0; x < 6; ++x) {
      if ((x == 3 && y == 3) || ((x == 3 || x == 4) && y == 4)) continue;
      voxels.push_back({x, y, 0, Role("floor"), -1});
    }
  }
  voxelbench::reset_workspace(&workspace);
  Check(voxelbench::simulate_command(&workspace, &state, voxels.data(),
            static_cast<int32_t>(voxels.size()), 6, 6, 0) == 0 && state.tick == 4,
        "crossing the gap must not insert a fixture-falling timeline");
  Check(voxels[2].x == 4 && voxels[2].y == 3 &&
            voxels[4].x == 4 && voxels[4].y == 4 && voxels[4].z == 1,
        "a mounted puncher must remain attached across the unsupported span");
}

void TestWallMountedPuncherRetainsHeightAcrossWorkspaceResume() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (const int32_t mount_z : {2, 3}) {
    std::vector<voxelbench::Voxel> voxels = {
        {3, 3, 1, Role("player"), -1},
        {3, 1, mount_z, Role("puncher"), 4},
        {3, 5, 1, Role("solid"), -1},
    };
    for (int32_t z = 1; z <= mount_z; ++z) {
      voxels.push_back({3, 2, z, Role("weightless-pushable"), 17});
      voxels.push_back({3, 0, z, Role("solid"), -1});
    }
    for (int32_t y = 0; y < 6; ++y) {
      for (int32_t x = 0; x < 6; ++x) {
        voxels.push_back({x, y, 0, Role("floor"), -1});
      }
    }
    voxelbench::reset_motion_state(&state);
    bool complete = false;
    for (int32_t call = 0; call < 6; ++call) {
      voxelbench::reset_workspace(&workspace);
      const auto result = voxelbench::step_tick(&workspace, &state, voxels.data(),
          static_cast<int32_t>(voxels.size()), 6, 6, 0);
      Check(result == voxelbench::TickResult::kMore ||
                result == voxelbench::TickResult::kComplete,
            "a resumed elevated punch must remain valid");
      Check(voxels[1].x == 3 && voxels[1].y == 1 && voxels[1].z == mount_z,
            "a wall-mounted puncher must not fall when the body beneath departs");
      if (state.tick == 2) {
        Check(voxels[1].generic_id == 5 && voxels[0].y == 3 && voxels[3].y == 2,
              "the elevated fixture must punch the body and player together");
      }
      if (result == voxelbench::TickResult::kComplete) {
        complete = true;
        break;
      }
    }
    Check(complete && state.tick == 3 && voxels[0].y == 4 && voxels[3].y == 3 &&
              voxels[1].generic_id == 4,
          "the elevated punch must stop and rearm without extra falling ticks");
  }
}

void TestSearchSolvesAndReplaysPuncherCommands() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  for (int32_t sprung = 0; sprung <= 1; ++sprung) {
    voxelbench::Voxel voxels[] = {
        {1, 3, 1, Role("player"), -1},
        {1, 2, 1, Role("puncher"), 2 + sprung},
        {0, 2, 1, Role("wall"), -1},
        {4, 2, 1, Role("wall"), -1},
        {1, 3, 0, Role("floor"), -1},
        {1, 2, 0, Role("floor"), -1},
        {2, 2, 0, Role("floor"), -1},
        {3, 2, 0, Role("floor"), -1},
        {4, 2, 0, Role("floor"), -1},
        {3, 2, 1, Role("goal"), -1},
    };
    voxelbench::reset_workspace(&physics_workspace);
    const auto result = voxelbench::search_shortest(
        &search_workspace, &physics_workspace, voxels, 10, 5, 5, 1000);
    Check(result.status == voxelbench::SearchStatus::kSolved &&
              result.moves == 1 && result.solution[0] == 0,
          "search should rearm a sprung puncher at the start of a new command");
    for (int32_t move = 0; move < result.solution_length; ++move) {
      Check(voxelbench::simulate_turn(voxels, 10, 5, 5, result.solution[move]) == 0,
            "a searched puncher command should replay in ordinary physics");
    }
    Check(voxels[0].x == 3 && voxels[0].y == 2 && voxels[9].x < 0 &&
              voxels[1].generic_id == 2,
          "replayed puncher solution should collect the gem with the correct fixture state");
  }
}

void TestPuncherMomentumMovesAWholeWeightlessConvoy() {
  voxelbench::Voxel voxels[] = {
      {1, 3, 1, Role("player"), -1},
      {1, 2, 1, Role("puncher"), 2},  // Right-facing, unsprung.
      {2, 2, 1, Role("weightless-pushable"), 0},
      {0, 2, 1, Role("wall"), -1},
      {5, 2, 1, Role("wall"), -1},
      {1, 3, 0, Role("floor"), -1},
      {1, 2, 0, Role("floor"), -1},
      {2, 2, 0, Role("floor"), -1},
      {3, 2, 0, Role("floor"), -1},
      {4, 2, 0, Role("floor"), -1},
      {5, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 11, 6, 5, 0) == 0,
        "a punch-driven weightless convoy should quiesce");
  Check(voxels[0].x == 3 && voxels[2].x == 4,
        "every body pushed by a punch should retain the convoy impulse");
}

void TestFloatingFloorHasOneBoxPushWeight() {
  voxelbench::Voxel one_platform[] = {
      {0, 5, 1, Role("player"), -1},
      {0, 4, 1, Role("floating-floor"), -1},
      {0, 3, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 5, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(one_platform, 5, 6, 6, 0) == 0,
        "pushing one Floating Floor should run");
  Check(one_platform[0].y == 4 && one_platform[1].y == 3,
        "one Floating Floor should push like one ordinary box");

  voxelbench::Voxel two_platforms[] = {
      {0, 5, 1, Role("player"), -1},
      {0, 4, 1, Role("floating-floor"), -1},
      {0, 3, 1, Role("floating-floor"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 3, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 5, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(two_platforms, 7, 6, 6, 0) == 0,
        "a blocked Floating Floor push should run");
  Check(two_platforms[0].y == 5 && two_platforms[1].y == 4 &&
            two_platforms[2].y == 3,
        "two Floating Floors should be too heavy to push together");
}

void TestFloatingFloorFillsHoleOnFollowingTick() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  voxelbench::Voxel voxels[] = {
      {0, 5, 1, Role("player"), -1},
      {0, 4, 1, Role("floating-floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 5, 0, Role("floor"), -1},
  };
  voxelbench::reset_workspace(&workspace);
  voxelbench::reset_motion_state(&state);
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 6, 6, 0) ==
            voxelbench::TickResult::kMore,
        "a Floating Floor over a hole should expose its horizontal frame");
  Check(state.tick == 1 && voxels[0].y == 4 && voxels[1].y == 3 &&
            voxels[1].z == 1 && voxels[1].role == Role("floating-floor"),
        "the pushed platform should remain suspended for the movement tick");
  Check(voxelbench::step_tick(
            &workspace, &state, voxels, 4, 6, 6, 0) ==
            voxelbench::TickResult::kComplete,
        "the Floating Floor hole-fill tick should complete the command");
  Check(state.tick == 2 && voxels[0].y == 4 && voxels[1].y == 3 &&
            voxels[1].z == 0 && voxels[1].role == Role("floor"),
        "the platform should become permanent Floor in the Row-0 hole");
}

void TestFloatingFloorSharesOneWeightBudgetWithWeightlessChains() {
  voxelbench::Voxel voxels[] = {
      {0, 5, 1, Role("player"), -1},
      {0, 4, 1, Role("floating-floor"), -1},
      {0, 3, 1, Role("weightless-pushable"), 0},
      {0, 2, 1, Role("weightless-pushable"), 1},
      {0, 1, 0, Role("floor"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 3, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 5, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 9, 6, 6, 0) == 0,
        "a mixed Floating Floor and weightless chain push should run");
  Check(voxels[0].y == 4 && voxels[1].y == 3 &&
            voxels[2].y == 2 && voxels[3].y == 1,
        "one weighted platform should transmit through any weightless chain");
}

void TestFloatingFloorIsNotWalkableOrPushableIntoHighVoid() {
  voxelbench::Voxel walk[] = {
      {0, 5, 2, Role("player"), -1},
      {0, 5, 1, Role("solid"), -1},
      {0, 4, 1, Role("floating-floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 5, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(walk, 5, 6, 6, 0) == 0,
        "walking toward a Floating Floor top should run");
  Check(walk[0].y == 5,
        "Floating Floor should not provide a walkable top surface");

  voxelbench::Voxel high_push[] = {
      {0, 4, 4, Role("player"), -1},
      {0, 3, 4, Role("floating-floor"), -1},
      {0, 3, 3, Role("solid"), -1},
      {0, 4, 3, Role("solid"), -1},
      {0, 2, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(high_push, 5, 6, 6, 0) == 0,
        "an unsupported high Floating Floor push should run");
  Check(high_push[0].y == 4 && high_push[1].y == 3 &&
            high_push[1].z == 4,
        "a deliberate push must not launch Floating Floor into high void");
}

void TestCloneDoesNotEnterPlayerCellWhenPlayerPushIsBlocked() {
  for (const bool remote_slope : {false, true}) {
    voxelbench::Voxel voxels[9] = {
        {0, 4, 1, Role("player"), -1},
        {0, 5, 1, Role("clone"), 0},
        {0, 3, 1, Role("floating-floor"), -1},
        {0, 2, 1, Role("floating-floor"), -1},
        {0, 2, 0, Role("floor"), -1},
        {0, 3, 0, Role("floor"), -1},
        {0, 4, 0, Role("floor"), -1},
        {0, 5, 0, Role("floor"), -1},
    };
    if (remote_slope) voxels[8] = {5, 5, 1, Role("ice-slope-right"), -1};
    Check(voxelbench::simulate_turn(voxels, remote_slope ? 9 : 8, 6, 6, 0) == 0,
          "a blocked player and trailing clone command should run");
    Check(voxels[0].y == 4 && voxels[1].y == 5 &&
              voxels[2].y == 3 && voxels[3].y == 2,
          "the clone must retain its cell when the player cannot vacate");
  }
}

void TestAuthoredFloatingFloorHoversAndSlopeJamReflectsPlayer() {
  voxelbench::Voxel voxels[] = {
      {0, 4, 1, Role("player"), -1},
      {0, 3, 2, Role("floating-floor"), -1},
      {0, 3, 1, Role("ice-slope-up"), -1},
      {0, 2, 1, Role("solid"), -1},
      {0, 1, 2, Role("floating-floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {0, 2, 0, Role("floor"), -1},
      {0, 3, 0, Role("floor"), -1},
      {0, 4, 0, Role("floor"), -1},
  };
  Check(voxelbench::simulate_turn(voxels, 9, 6, 6, 0) == 0,
        "a Floating Floor slope-jam command should run");
  Check(voxels[0].y == 4 && voxels[0].z == 1 &&
            voxels[1].y == 2 && voxels[1].z == 2 &&
            voxels[4].y == 1 && voxels[4].z == 2,
        "the authored platform should hover while the blocked slope actor recoils");
}

void TestSlopeMomentumPushesSupportedFloatingFloor() {
  static voxelbench::PhysicsWorkspace workspace;
  static voxelbench::MotionState state;
  for (int scenario = 0; scenario < 3; ++scenario) {
    const bool downhill = scenario == 2;
    const bool supported = scenario != 1;
    voxelbench::Voxel voxels[11] = {
        {0, 5, downhill ? 2 : 1, Role("player"), -1},
        {0, 3, downhill ? 1 : 2, Role("floating-floor"), -1},
        {0, 4, 1, Role(downhill ? "ice-slope-down" : "ice-slope-up"), -1},
        {0, downhill ? 5 : 3, 1, Role("solid"), -1},
    };
    int32_t count = 4;
    for (int32_t y = 0; y < 6; ++y) {
      voxels[count++] = {0, y, 0, Role("floor"), -1};
    }
    if (!downhill && supported) {
      voxels[count++] = {0, 2, 1, Role("solid"), -1};
    }
    voxelbench::reset_workspace(&workspace);
    voxelbench::reset_motion_state(&state);
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, count, 6, 6, 0) ==
              voxelbench::TickResult::kMore,
          "ramp entry must expose its intermediate frame");
    Check(state.tick == 1 && voxels[0].y == 4 && voxels[0].z == 2 &&
              voxels[1].y == 3,
          "ramp entry must not push the Floating Floor a tick early");
    Check(voxelbench::step_tick(
              &workspace, &state, voxels, count, 6, 6, 0) ==
              voxelbench::TickResult::kComplete,
          "ramp contact should resolve on the second tick");
    Check(state.tick == 2 && voxels[0].y == (supported ? 3 : 5) &&
              voxels[0].z == (downhill || !supported ? 1 : 2) &&
              voxels[1].y == (supported ? 2 : 3) &&
              voxels[1].z == (downhill ? 1 : 2) &&
              voxels[1].role == Role("floating-floor"),
          "supported ramp contact pushes; unsupported crest contact reflects");
  }
}

void TestSearchTracksFilledFloatingFloorState() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[] = {
      {0, 4, 1, Role("player"), -1},
      {0, 3, 1, Role("floating-floor"), -1},
      {0, 4, 0, Role("floor"), -1},
      {0, 3, 0, Role("floor"), -1},
      {0, 1, 0, Role("floor"), -1},
      {0, 0, 0, Role("floor"), -1},
      {0, 1, 1, Role("goal"), -1},
  };
  voxelbench::reset_workspace(&physics_workspace);
  const auto result = voxelbench::search_shortest(
      &search_workspace, &physics_workspace, voxels, 7, 3, 5, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved &&
            result.moves == 3 && result.solution_length == 3,
        "search should retain a Floating Floor after it permanently fills a hole");
  Check(result.solution[0] == 0 && result.solution[1] == 0 &&
            result.solution[2] == 0,
        "search should cross the filled hole and collect the gem");
}

void TestSearchPreservesAuthoredGateTiming() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  for (const int32_t raised : {0, 1}) {
    voxelbench::Voxel voxels[20] = {
        {1, 3, 1, Role("player"), -1},
        {1, 0, 1, Role("goal"), -1},
        {1, 2, 1, Role("player-gate"), raised},
    };
    int32_t count = 3;
    for (int32_t x = 0; x < 4; ++x) {
      for (int32_t y = 0; y < 4; ++y) {
        voxels[count++] = {x, y, 0, Role("floor"), -1};
      }
    }
    const auto result = voxelbench::search_shortest(&search_workspace,
        &physics_workspace, voxels, count, 4, 4, 1000);
    Check(result.status == voxelbench::SearchStatus::kSolved &&
              result.moves == (raised == 0 ? 3 : 5),
          "exact search must preserve authored gate state before the first input");
    for (int32_t i = 0; i < result.solution_length; ++i) {
      Check(voxelbench::simulate_turn(voxels, count, 4, 4,
                result.solution[i]) == 0, "gate solution commands must replay");
    }
    Check(voxels[1].x < 0, "the shortest gate witness must collect its gem");
  }
}

void TestSearchManyFixedGatesDoNotConsumeEntityBudget() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  std::vector<voxelbench::Voxel> voxels = {
      {0, 3, 1, Role("player"), -1},
      {0, 0, 1, Role("goal"), -1},
  };
  for (int32_t x = 0; x < 10; ++x) {
    for (int32_t y = 0; y < 10; ++y) {
      voxels.push_back({x, y, 0, Role("floor"), -1});
      if (x >= 2) voxels.push_back({x, y, 1, Role("player-gate"), (x + y) % 2});
    }
  }
  const int32_t count = static_cast<int32_t>(voxels.size());
  const auto result = voxelbench::search_shortest(&search_workspace,
      &physics_workspace, voxels.data(), count, 10, 10, 1000);
  Check(result.status == voxelbench::SearchStatus::kSolved && result.moves == 3,
        "80 fixed gates must retain their states without exhausting the entity budget");
  for (int32_t i = 0; i < result.solution_length; ++i) {
    Check(voxelbench::simulate_turn(voxels.data(), count, 10, 10,
              result.solution[i]) == 0, "many-gate witness must replay");
  }
  Check(voxels[1].x < 0, "many-gate witness must collect the gem");
}

void TestReachableEdgesWithoutGems() {
  static voxelbench::PhysicsWorkspace physics_workspace;
  static voxelbench::SearchWorkspace search_workspace;
  voxelbench::Voxel voxels[10] = {
      {1, 1, 1, Role("player"), -1},
  };
  int32_t count = 1;
  for (int32_t y = 0; y < 3; ++y) {
    for (int32_t x = 0; x < 3; ++x) {
      voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  voxelbench::reset_workspace(&physics_workspace);
  const auto edges = voxelbench::search_reachable_edges(
      &search_workspace, &physics_workspace, voxels, count, 3, 3, 1000);
  Check(edges.status == voxelbench::SearchStatus::kSolved && edges.edges == 12,
        "edge search should exhaustively retain each outward perimeter route without gems");
  for (int32_t edge = 0; edge < edges.edges; ++edge) {
    const auto route = voxelbench::search_edge_solution(
        &search_workspace, &physics_workspace, edge, count, 3, 3);
    Check(route.status == voxelbench::SearchStatus::kSolved &&
              route.solution_length >= 2 && route.solution_length == route.moves,
          "each reachable edge should reconstruct a complete shortest witness");
  }

  voxelbench::Voxel dynamic_voxels[14] = {
      {1, 2, 1, Role("player"), -1},
      {1, 1, 1, Role("pushable"), 0},
  };
  count = 2;
  for (int32_t y = 0; y < 3; ++y) {
    for (int32_t x = 0; x < 4; ++x) {
      dynamic_voxels[count++] = {x, y, 0, Role("floor"), -1};
    }
  }
  const auto dynamic_edges = voxelbench::search_reachable_edges(
      &search_workspace, &physics_workspace, dynamic_voxels, count, 4, 3, 1000);
  Check(dynamic_edges.status == voxelbench::SearchStatus::kSolved &&
            dynamic_edges.edges > 14,
        "coincident edge coordinates with different crate states should remain distinct");
}

}  // namespace

int main() {
  Run(TestSimplePush, "TestSimplePush");
  Run(TestWrappingPushMovesPlayerSupport, "TestWrappingPushMovesPlayerSupport");
  Run(TestPlayerGateRisesWhenPlayerApproaches, "TestPlayerGateRisesWhenPlayerApproaches");
  Run(TestPlayerGateBlockedByEveryPushableFamily, "TestPlayerGateBlockedByEveryPushableFamily");
  Run(TestPlayerIceSlide, "TestPlayerIceSlide");
  Run(TestApproachingIceFromWallDoesNotStartSlidingEarly, "TestApproachingIceFromWallDoesNotStartSlidingEarly");
  Run(TestSlidingMomentumEntersRampSide, "TestSlidingMomentumEntersRampSide");
  Run(TestWalkingCannotEnterRampSide, "TestWalkingCannotEnterRampSide");
  Run(TestRampSideSlideStillCollidesWithSolids, "TestRampSideSlideStillCollidesWithSolids");
  Run(TestRampCrestPushesOnlyUnblockedWeightlessChains, "TestRampCrestPushesOnlyUnblockedWeightlessChains");
  Run(TestSparseStackCarryIgnoresUnrelatedSlopes, "TestSparseStackCarryIgnoresUnrelatedSlopes");
  Run(TestTallStacksFollowRampCarrierTicks, "TestTallStacksFollowRampCarrierTicks");
  Run(TestCloneStacksReceiveOneRampCommand, "TestCloneStacksReceiveOneRampCommand");
  Run(TestRampStackCeilingsReflectTogether, "TestRampStackCeilingsReflectTogether");
  Run(TestBlockedClonePassengerFallsAfterSupportLeaves, "TestBlockedClonePassengerFallsAfterSupportLeaves");
  Run(TestRampPassengersStopWithGroundedCarrier, "TestRampPassengersStopWithGroundedCarrier");
  Run(TestBlockedCloneRampMomentumCompletes, "TestBlockedCloneRampMomentumCompletes");
  Run(TestInterlockedPushDoesNotInventMomentum, "TestInterlockedPushDoesNotInventMomentum");
  Run(TestCarrierMomentumCannotLeakIntoNextScene, "TestCarrierMomentumCannotLeakIntoNextScene");
  Run(TestBlockedPassengersDoNotAnchorTheirCarrier, "TestBlockedPassengersDoNotAnchorTheirCarrier");
  Run(TestPushableIceSlide, "TestPushableIceSlide");
  Run(TestPlayerAndPushedBodySlideTogetherOnIce, "TestPlayerAndPushedBodySlideTogetherOnIce");
  Run(TestIceStopsAtObstacle, "TestIceStopsAtObstacle");
  Run(TestUnknownRoleBlocks, "TestUnknownRoleBlocks");
  Run(TestIndependentCloneCommands, "TestIndependentCloneCommands");
  Run(TestPlayerAndCloneSlidesFinishIndependently, "TestPlayerAndCloneSlidesFinishIndependently");
  Run(TestCloneCannotWalkOntoDepartingPlayerCargo, "TestCloneCannotWalkOntoDepartingPlayerCargo");
  Run(TestCloneCarriesCargoThroughPlayerPassenger, "TestCloneCarriesCargoThroughPlayerPassenger");
  Run(TestWideActorsCannotClimbWallsBesideRamps, "TestWideActorsCannotClimbWallsBesideRamps");
  Run(TestCloneRefillsCarriedPlayerCell, "TestCloneRefillsCarriedPlayerCell");
  Run(TestActorPolycubesPushThroughMountedLifts, "TestActorPolycubesPushThroughMountedLifts");
  Run(TestBlueSlopeAndBoxShareTheirGenericBody, "TestBlueSlopeAndBoxShareTheirGenericBody");
  Run(TestYellowSlopeAndCloneShareTheirGenericBody, "TestYellowSlopeAndCloneShareTheirGenericBody");
  Run(TestBlockedWrappingCloneDoesNotCancelFreeActors, "TestBlockedWrappingCloneDoesNotCancelFreeActors");
  Run(TestInterlockingCloneCommandComponent, "TestInterlockingCloneCommandComponent");
  Run(TestWrappingCloneSharesPlayerPushVacancy, "TestWrappingCloneSharesPlayerPushVacancy");
  Run(TestClonePlayerChainsRequireActualVacancies, "TestClonePlayerChainsRequireActualVacancies");
  Run(TestTouchingCloneRidersKeepTheirMovingSupport, "TestTouchingCloneRidersKeepTheirMovingSupport");
  Run(TestExactSearchCannotCollectGoalsThroughClones, "TestExactSearchCannotCollectGoalsThroughClones");
  Run(TestPlayerPolycubeMovesAndFallsRigidly, "TestPlayerPolycubeMovesAndFallsRigidly");
  Run(TestExactSearchTracksPlayerPolycube, "TestExactSearchTracksPlayerPolycube");
  Run(TestEveryBoundary, "TestEveryBoundary");
  Run(TestTickTraceAndWorkspaceIsolation, "TestTickTraceAndWorkspaceIsolation");
  Run(TestObserverReceivesNoMovementCompletionFrame, "TestObserverReceivesNoMovementCompletionFrame");
  Run(TestPreparedMotionStateClearsImmutableSuffix, "TestPreparedMotionStateClearsImmutableSuffix");
  Run(TestPreparedSceneRejectsMovableStaticSuffix, "TestPreparedSceneRejectsMovableStaticSuffix");
  Run(TestPreparedIndexesDoNotLeakToDifferentSceneShape, "TestPreparedIndexesDoNotLeakToDifferentSceneShape");
  Run(TestInvalidQuiescentCallDoesNotLeakItsAssumption, "TestInvalidQuiescentCallDoesNotLeakItsAssumption");
  Run(TestPlayerGetsVisibleRowZeroVoidFrame, "TestPlayerGetsVisibleRowZeroVoidFrame");
  Run(TestPushableGetsVisibleRowZeroVoidFrame, "TestPushableGetsVisibleRowZeroVoidFrame");
  Run(TestTallPolycubeDisappearsOnlyAfterItsTopPassesRowZero, "TestTallPolycubeDisappearsOnlyAfterItsTopPassesRowZero");
  Run(TestPolycubeAbyssUsesLowestOtherWorldGeometry, "TestPolycubeAbyssUsesLowestOtherWorldGeometry");
  Run(TestPlayerAbyssUsesLowestOtherWorldGeometry, "TestPlayerAbyssUsesLowestOtherWorldGeometry");
  Run(TestFallingRiderDoesNotExtendItsCarriersAbyss, "TestFallingRiderDoesNotExtendItsCarriersAbyss");
  Run(TestObjectAboveDescendingPlayerFallsInSameTick, "TestObjectAboveDescendingPlayerFallsInSameTick");
  Run(TestExactSearchFindsShortestCommands, "TestExactSearchFindsShortestCommands");
  Run(TestFlatIceSearchKeepsExactCommandSemantics, "TestFlatIceSearchKeepsExactCommandSemantics");
  Run(TestGeneralSearchSupportsBoardsWiderThanSixteen, "TestGeneralSearchSupportsBoardsWiderThanSixteen");
  Run(TestGeneralSearchCollapsesWalkingBeforePushes, "TestGeneralSearchCollapsesWalkingBeforePushes");
  Run(TestGeneralSearchMatchesMazeBenchEngine3LongRoom, "TestGeneralSearchMatchesMazeBenchEngine3LongRoom");
  Run(TestSearchInitializesFreshWorkspace, "TestSearchInitializesFreshWorkspace");
  Run(TestSearchPrunesPlayerGameOverBranches, "TestSearchPrunesPlayerGameOverBranches");
  Run(TestPlayerCollectsGemOnlyAtCommandEnd, "TestPlayerCollectsGemOnlyAtCommandEnd");
  Run(TestBoxMayOverlapGemWithoutCollectingIt, "TestBoxMayOverlapGemWithoutCollectingIt");
  Run(TestClonesCannotCollectGoals, "TestClonesCannotCollectGoals");
  Run(TestSlidingAcrossGemDoesNotCollectIt, "TestSlidingAcrossGemDoesNotCollectIt");
  Run(TestPlayerSettlesBeforeHorizontalInput, "TestPlayerSettlesBeforeHorizontalInput");
  Run(TestPolycubeSettlesAsOneBodyBeforeHorizontalInput, "TestPolycubeSettlesAsOneBodyBeforeHorizontalInput");
  Run(TestSearchRequiresACommandToCollectStartingGem, "TestSearchRequiresACommandToCollectStartingGem");
  Run(TestPushCannotWalkPlayerOffWallSupport, "TestPushCannotWalkPlayerOffWallSupport");
  Run(TestEnteringBeneathSupportedWeightlessBodyDoesNotCarryIt, "TestEnteringBeneathSupportedWeightlessBodyDoesNotCarryIt");
  Run(TestPlayerDepartureDoesNotCarryMultiplySupportedBody, "TestPlayerDepartureDoesNotCarryMultiplySupportedBody");
  Run(TestWalkingOnSupportedWrappingPolycube, "TestWalkingOnSupportedWrappingPolycube");
  Run(TestCloneCommandOwnership, "TestCloneCommandOwnership");
  Run(TestConnectedRoomBodyBoundaries, "TestConnectedRoomBodyBoundaries");
  Run(TestSearchCollectsEveryGem, "TestSearchCollectsEveryGem");
  Run(TestSearchStoresLargePolycubeAsOneEntity, "TestSearchStoresLargePolycubeAsOneEntity");
  Run(TestGeneralSearchChecksRaisedPolycubeCollisions, "TestGeneralSearchChecksRaisedPolycubeCollisions");
  Run(TestCappedSearchDoesNotClaimAnOptimalProof, "TestCappedSearchDoesNotClaimAnOptimalProof");
  Run(TestDistantPushCannotShoveBlockedSlopeBodies, "TestDistantPushCannotShoveBlockedSlopeBodies");
  Run(TestSlopeCarrierMovesStationaryRider, "TestSlopeCarrierMovesStationaryRider");
  Run(TestRemotePolycubeMemberCarriesPerpendicularSlopeRider, "TestRemotePolycubeMemberCarriesPerpendicularSlopeRider");
  Run(TestSlopeAndFlatIceBridgeNeedsDeliberatePush, "TestSlopeAndFlatIceBridgeNeedsDeliberatePush");
  Run(TestOpposingSlopeLandingCancelsStoredMomentum, "TestOpposingSlopeLandingCancelsStoredMomentum");
  Run(TestAuthoredHoveringLiftsKeepTheirAnchors, "TestAuthoredHoveringLiftsKeepTheirAnchors");
  Run(TestTerrainLiftsDoNotAttachToActors, "TestTerrainLiftsDoNotAttachToActors");
  Run(TestPlayerEnteringLoweredLiftRaisesAndRides, "TestPlayerEnteringLoweredLiftRaisesAndRides");
  Run(TestPlayerEnteringRaisedLiftLowersAndRides, "TestPlayerEnteringRaisedLiftLowersAndRides");
  Run(TestPlayerLiftToggleUsesItsOwnAnimationTick, "TestPlayerLiftToggleUsesItsOwnAnimationTick");
  Run(TestLeavingAuthoredLoweredLiftKeepsItLowered, "TestLeavingAuthoredLoweredLiftKeepsItLowered");
  Run(TestBlockedLoweredLiftRetriesAfterRiderLeaves, "TestBlockedLoweredLiftRetriesAfterRiderLeaves");
  Run(TestBlockedSideLiftIceLaneSurvivesResumeAndSearch, "TestBlockedSideLiftIceLaneSurvivesResumeAndSearch");
  Run(TestSideLiftDepartureTiming, "TestSideLiftDepartureTiming");
  Run(TestMountedLiftPushIgnoresRemoteRamp, "TestMountedLiftPushIgnoresRemoteRamp");
  Run(TestMountedLiftTransmitsItsCarriersPush, "TestMountedLiftTransmitsItsCarriersPush");
  Run(TestCarriedFaceFixturesMayShareMovingBodyCells, "TestCarriedFaceFixturesMayShareMovingBodyCells");
  Run(TestLiftRidesWeightlessCarrierWithStatefulCollision, "TestLiftRidesWeightlessCarrierWithStatefulCollision");
  Run(TestBlockedPlayerLiftRefusesToRaise, "TestBlockedPlayerLiftRefusesToRaise");
  Run(TestOverlappingPlayerLiftsDoNotDependOnVoxelOrder, "TestOverlappingPlayerLiftsDoNotDependOnVoxelOrder");
  Run(TestOpposingPlayerLiftsRecoilMountedBodies, "TestOpposingPlayerLiftsRecoilMountedBodies");
  Run(TestSearchTracksPlayerLiftState, "TestSearchTracksPlayerLiftState");
  Run(TestOrangeButtonUsesASeparateWallTick, "TestOrangeButtonUsesASeparateWallTick");
  Run(TestOrangeWallCarriesItsMountedButtonInTheSameTick, "TestOrangeWallCarriesItsMountedButtonInTheSameTick");
  Run(TestOrangeWallCarriesItsMountedLiftInTheSameTick, "TestOrangeWallCarriesItsMountedLiftInTheSameTick");
  Run(TestLoweredWallMountedLiftMayOverlapTerrain, "TestLoweredWallMountedLiftMayOverlapTerrain");
  Run(TestWallMountedLiftCannotDescendIntoFloor, "TestWallMountedLiftCannotDescendIntoFloor");
  Run(TestOrangeWallDeliversPlayerOntoMountedLift, "TestOrangeWallDeliversPlayerOntoMountedLift");
  Run(TestOrangeButtonRidesTopLiftAndChangesVisibility, "TestOrangeButtonRidesTopLiftAndChangesVisibility");
  Run(TestMovingPolycubeCarriesButtonsMountedOnEveryFace, "TestMovingPolycubeCarriesButtonsMountedOnEveryFace");
  Run(TestReleasedOrangeColumnRaisesEveryVoxelAfterJoining, "TestReleasedOrangeColumnRaisesEveryVoxelAfterJoining");
  Run(TestHeldButtonsPreserveOrangeWallAnchors, "TestHeldButtonsPreserveOrangeWallAnchors");
  Run(TestTallOrangeWallCarriesWideStackAcrossWorkspaceResume, "TestTallOrangeWallCarriesWideStackAcrossWorkspaceResume");
  Run(TestOrangeWallChecksPlayerHeadroomAboveCarriedBody, "TestOrangeWallChecksPlayerHeadroomAboveCarriedBody");
  Run(TestOrangeControlScopesRemainIndependent, "TestOrangeControlScopesRemainIndependent");
  Run(TestOrangeWallsCountEveryPressedButton, "TestOrangeWallsCountEveryPressedButton");
  Run(TestFlattenedOrangeWallIsPassThroughOnFloor, "TestFlattenedOrangeWallIsPassThroughOnFloor");
  Run(TestFloatingOrangeWallLowersAsACube, "TestFloatingOrangeWallLowersAsACube");
  Run(TestProjectedOrangeFaceTransitionsWithDepth, "TestProjectedOrangeFaceTransitionsWithDepth");
  Run(TestSearchTracksOrangeWallDepth, "TestSearchTracksOrangeWallDepth");
  Run(TestPuncherRedirectsPlayerAndResetsVisually, "TestPuncherRedirectsPlayerAndResetsVisually");
  Run(TestPunchMomentumCrossesRaisedAndLoweredLifts, "TestPunchMomentumCrossesRaisedAndLoweredLifts");
  Run(TestCloneLiftActivationSurvivesWorkspaceResumeAndSearch, "TestCloneLiftActivationSurvivesWorkspaceResumeAndSearch");
  Run(TestInitialPuncherContactWaitsForCommand, "TestInitialPuncherContactWaitsForCommand");
  Run(TestBlockedPunchRearmsForNextCommand, "TestBlockedPunchRearmsForNextCommand");
  Run(TestPunchedBodyTransfersPlayerImpulseAcrossWorkspaceResume, "TestPunchedBodyTransfersPlayerImpulseAcrossWorkspaceResume");
  Run(TestPunchedPlayerPushesConvoyAcrossFloorGap, "Punched player pushes convoy across floor gap");
  Run(TestPunchedCarrierKeepsMountedFixtureAcrossGap, "TestPunchedCarrierKeepsMountedFixtureAcrossGap");
  Run(TestWallMountedPuncherRetainsHeightAcrossWorkspaceResume, "TestWallMountedPuncherRetainsHeightAcrossWorkspaceResume");
  Run(TestSearchSolvesAndReplaysPuncherCommands, "TestSearchSolvesAndReplaysPuncherCommands");
  Run(TestPuncherMomentumMovesAWholeWeightlessConvoy, "TestPuncherMomentumMovesAWholeWeightlessConvoy");
  Run(TestFloatingFloorHasOneBoxPushWeight, "TestFloatingFloorHasOneBoxPushWeight");
  Run(TestFloatingFloorFillsHoleOnFollowingTick, "TestFloatingFloorFillsHoleOnFollowingTick");
  Run(TestFloatingFloorSharesOneWeightBudgetWithWeightlessChains, "TestFloatingFloorSharesOneWeightBudgetWithWeightlessChains");
  Run(TestFloatingFloorIsNotWalkableOrPushableIntoHighVoid, "TestFloatingFloorIsNotWalkableOrPushableIntoHighVoid");
  Run(TestCloneDoesNotEnterPlayerCellWhenPlayerPushIsBlocked, "TestCloneDoesNotEnterPlayerCellWhenPlayerPushIsBlocked");
  Run(TestAuthoredFloatingFloorHoversAndSlopeJamReflectsPlayer, "TestAuthoredFloatingFloorHoversAndSlopeJamReflectsPlayer");
  Run(TestSlopeMomentumPushesSupportedFloatingFloor, "TestSlopeMomentumPushesSupportedFloatingFloor");
  Run(TestSearchTracksFilledFloatingFloorState, "TestSearchTracksFilledFloatingFloorState");
  Run(TestSearchPreservesAuthoredGateTiming, "TestSearchPreservesAuthoredGateTiming");
  Run(TestSearchManyFixedGatesDoNotConsumeEntityBudget, "TestSearchManyFixedGatesDoNotConsumeEntityBudget");
  Run(TestReachableEdgesWithoutGems, "TestReachableEdgesWithoutGems");
  if (failures != 0) {
    std::cerr << failures << " C++ physics test(s) failed\n";
    return EXIT_FAILURE;
  }
  std::cout << "all " << tests_run << " C++ physics/search tests passed\n";
  return EXIT_SUCCESS;
}
