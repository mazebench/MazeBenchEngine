#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir="$project_root/apps/web/public/physics"
zig_cache_dir="$project_root/.zig-cache"
zig_global_cache_dir="$project_root/.zig-global-cache"
mkdir -p "$output_dir" "$zig_cache_dir" "$zig_global_cache_dir"

ZIG_LOCAL_CACHE_DIR="$zig_cache_dir" \
ZIG_GLOBAL_CACHE_DIR="$zig_global_cache_dir" \
"$project_root/node_modules/.bin/zig" c++ \
  -target wasm32-freestanding \
  -std=c++20 \
  -O3 \
  -DNDEBUG \
  -flto \
  -nostdlib \
  -Wl,--no-entry \
  -Wl,--export=physics_abi_version \
  -Wl,--export=voxel_stride \
  -Wl,--export=voxel_capacity \
  -Wl,--export=voxel_buffer \
  -Wl,--export=role_buffer_capacity \
  -Wl,--export=role_buffer \
  -Wl,--export=role_code \
  -Wl,--export=motion_state_buffer \
  -Wl,--export=motion_state_size \
  -Wl,--export=reset_command \
  -Wl,--export=step_command_tick \
  -Wl,--export=command_tick \
  -Wl,--export=command_cycle_detected \
  -Wl,--export=command_cycle_start_tick \
  -Wl,--export=command_cycle_repeat_tick \
  -Wl,--export=simulate_turn \
  -Wl,--export=search_prepare_scene \
  -Wl,--export=search_prepare_quiescent_snapshot \
  -Wl,--export=search_try_passive_quiescent_turn \
  -Wl,--export=search_node_capacity \
  -Wl,--export=search_voxel_capacity \
  -Wl,--export=search_solve \
  -Wl,--export=search_edges \
  -Wl,--export=search_edge_count \
  -Wl,--export=search_edge_solution \
  -Wl,--export=search_moves \
  -Wl,--export=search_expanded \
  -Wl,--export=search_generated \
  -Wl,--export=search_transpositions \
  -Wl,--export=search_local_expanded \
  -Wl,--export=search_command_transitions \
  -Wl,--export=search_full_physics_transitions \
  -Wl,--export=search_solution_length \
  -Wl,--export=search_solution_step \
  -Wl,--export-memory \
  -Wl,--initial-memory=100663296 \
  -Wl,--max-memory=100663296 \
  -o "$output_dir/voxel_physics.wasm" \
  -I"$project_root/engine/include" \
  "$project_root/engine/src/physics.cpp" \
  "$project_root/engine/src/search.cpp" \
  "$project_root/engine/src/wasm_api.cpp"

node "$project_root/scripts/write-engine-build-info.mjs"
