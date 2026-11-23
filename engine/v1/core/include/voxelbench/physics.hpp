#pragma once

#include <stdint.h>

namespace voxelbench {

constexpr int32_t kPhysicsAbiVersion = 4;
constexpr int32_t kVoxelCapacity = 65536;
constexpr int32_t kRoleBufferCapacity = 256;
constexpr uint32_t kMotionStateVersion = 4;
// Optional Orange Button/Wall control scope in the existing generic_id field.
// Unflagged values retain their original meaning. A flagged value packs a
// 13-bit scope and a 17-bit local value (wall depth or button orientation/state).
// Hosts may combine independent scenes without sharing button pressure. These
// tags must travel with the voxel for the duration of the command. Search uses
// room-local, unscoped data and rejects scoped scenes.
constexpr int32_t kOrangeScopedIdFlag = 1 << 30;
constexpr int32_t kOrangeScopeShift = 17;
constexpr int32_t kOrangeValueMask = (1 << kOrangeScopeShift) - 1;
constexpr int32_t kOrangeScopeCount = 1 << 13;
// A host combining rooms may suppress a clone body's initial directional
// command by tagging its generic_id. The lower 30 bits still identify the
// body; it retains clone collision, carrying, gravity and punch behavior.
// Clear this transient tag when starting a command in that clone's own room.
constexpr int32_t kCloneNoCommandIdFlag = 1 << 30;
// Optional uniform room grid for a host's temporary connected layout. Tag the
// player's generic_id with flag | (room_height << 15) | room_width. Positive
// dimensions use 15 bits each. Only player voxels may cross these cell borders;
// every other voxel's horizontal proposal must stay in its current grid cell.
// Hosts remove the tag on projection. No topology or save state is stored here.
constexpr int32_t kPlayerRoomGridIdFlag = 1 << 30;
constexpr int32_t kRoomGridDimensionBits = 15;
constexpr int32_t kRoomGridDimensionMask = (1 << kRoomGridDimensionBits) - 1;
constexpr int32_t kPhysicsWorkspaceBytes = 8 * 1024 * 1024;

struct PhysicsWorkspace {
  alignas(8) uint8_t storage[kPhysicsWorkspaceBytes];
};

struct Voxel {
  int32_t x;
  int32_t y;
  int32_t z;
  uint32_t role;
  int32_t generic_id;
};

// Serializable continuation state for a command that spans several animation
// ticks. The per-voxel flags deliberately use voxel indices: voxel storage
// order is stable during a command, while rigid-body indices are rebuilt in a
// workspace and are not part of the save format.
struct MotionState {
  uint32_t version;
  int32_t phase;
  int32_t direction;
  int32_t tick;
  int32_t voxel_count;
  int32_t player_index;
  uint8_t player_gravity_armed;
  uint8_t player_falling;
  uint8_t reserved[2];
  int32_t cycle_start_tick;
  int32_t cycle_repeat_tick;
  // Zero means stationary; 1..4 encode active Ice direction 0..3, 5..8 encode
  // latent Ice direction, 9..12 encode active punch direction, and 13..16
  // encode latent punch direction. Keeping direction with each voxel lets
  // independent polycubes traverse and turn on different paths.
  uint8_t horizontal_momentum[kVoxelCapacity];
  uint8_t falling[kVoxelCapacity];
  // Bit 0 arms gravity. Bit 7 queues an actor's horizontal lift entry for the
  // next tick. Bit 5 queues a vacated blocked lift's next-tick retry. These
  // are continuation state, never authored room properties.
  uint8_t gravity_armed[kVoxelCapacity];
};

enum class TickResult : int32_t {
  kNoPlayer = -2,
  kInvalid = -1,
  kComplete = 0,
  kMore = 1,
};

uint32_t hash_role(const uint8_t* bytes, int32_t length);

void reset_motion_state(MotionState* state);
void reset_workspace(PhysicsWorkspace* workspace);

// Compiles invariant object membership and immutable terrain once for repeated
// command simulation. The first dynamic_voxel_count entries may move; later
// entries remain immutable (except collectible goals may become inactive).
// Roles and entry order must not change until prepare_scene is called again.
// Static-suffix generic IDs and coordinates are immutable; dynamic-prefix
// coordinates and supported mechanism state (such as a player lift's generic
// 0/1 state) may change. Search uses this single indexed representation for
// every supported combination of Ice, holes, gravity, walls, and polycubes.
bool prepare_scene(
    PhysicsWorkspace* workspace,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t dynamic_voxel_count);

// Advances at most one animation tick. Direction is read only when starting a
// new command; subsequent calls resume the command stored in `state`.
TickResult step_tick(
    PhysicsWorkspace* workspace,
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction);

// Public command-step wrapper. It advances the same kernel as step_tick, but
// also recognizes an exact repeated whole-level state. The repeated frame is
// returned as kMore; the next call restores the command's starting frame and
// returns kComplete. MotionState records the repeated interval.
TickResult step_command_tick(
    PhysicsWorkspace* workspace,
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction);

using TickObserver = void (*)(
    const Voxel* voxels,
    int32_t count,
    const MotionState* state,
    void* context);

// Repeatedly calls step_tick until the command is quiescent. The observer is
// optional and receives every post-tick frame, including the final frame.
int32_t simulate_command(
    PhysicsWorkspace* workspace,
    MotionState* state,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction,
    TickObserver observer = nullptr,
    void* context = nullptr);

// Direction codes: 0 = up, 1 = right, 2 = down, 3 = left.
// Returns 0 after a valid command, -1 for invalid input, and -2 when no player
// exists. A command may contain several unit movements when Ice is involved.
int32_t simulate_turn(
    PhysicsWorkspace* workspace,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction);

// Same generalized command kernel, with the additional invariant that the
// supplied state is a prior quiescent command result. This avoids re-proving
// initial support for every successor of an exact search node. The final flag
// is for search's internal fallthrough only: true is valid exclusively after
// try_simulate_passive_quiescent_turn returned 0 without mutating the scene.
int32_t simulate_quiescent_turn(
    PhysicsWorkspace* workspace,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction,
    bool passive_already_declined = false);

// Low-level batch interface used by graph search. A snapshot indexes one
// quiescent arrangement of all non-player bodies. The passive evaluator may
// then be called from many player coordinates without rebuilding that index.
// It returns 1 when exact player-only physics handled the command, 0 when the
// full kernel is required, and a negative simulation error for invalid input.
bool prepare_quiescent_snapshot(
    PhysicsWorkspace* workspace,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height);
int32_t try_simulate_passive_quiescent_turn(
    PhysicsWorkspace* workspace,
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction);

// Compatibility convenience API. Search workers should use the overload that
// accepts their own PhysicsWorkspace.
int32_t simulate_turn(
    Voxel* voxels,
    int32_t count,
    int32_t width,
    int32_t height,
    int32_t direction);

}  // namespace voxelbench
