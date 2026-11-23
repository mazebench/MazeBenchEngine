#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
zig="$project_root/node_modules/.bin/zig"
output="$project_root/world-solver/v1/random-agent.wasm"

if [ ! -x "$zig" ]; then
  echo "Missing Zig compiler at $zig" >&2
  echo "Run npm ci in this repository to install the build tools." >&2
  exit 1
fi

mkdir -p "$project_root/.zig-cache" "$project_root/.zig-global-cache"

ZIG_LOCAL_CACHE_DIR="$project_root/.zig-cache" \
ZIG_GLOBAL_CACHE_DIR="$project_root/.zig-global-cache" \
"$zig" c++ \
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
  -Wl,--export=room_bfs_begin \
  -Wl,--export=room_bfs_run \
  -Wl,--export=room_bfs_run_until_edge \
  -Wl,--export=super_astar_begin \
  -Wl,--export=super_astar_run \
  -Wl,--export=row_astar_begin \
  -Wl,--export=row_astar_run \
  -Wl,--export=row_astar_target_count \
  -Wl,--export=row_astar_active_targets \
  -Wl,--export=row_astar_visited_targets \
  -Wl,--export=row_astar_row_count \
  -Wl,--export=row_astar_coverage_complete \
  -Wl,--export=row_astar_target_x \
  -Wl,--export=row_astar_target_y \
  -Wl,--export=row_astar_target_z \
  -Wl,--export=row_astar_target_visited \
  -Wl,--export=row_astar_row \
  -Wl,--export=row_astar_restore_reset \
  -Wl,--export=row_astar_restore_target \
  -Wl,--export=row_astar_restore_row \
  -Wl,--export=room_bfs_states \
  -Wl,--export=room_bfs_state_capacity \
  -Wl,--export=room_bfs_expanded \
  -Wl,--export=room_bfs_transitions \
  -Wl,--export=room_bfs_global_states \
  -Wl,--export=room_bfs_full_physics_transitions \
  -Wl,--export=room_bfs_state_words \
  -Wl,--export=room_bfs_state_buffer \
  -Wl,--export=room_bfs_head \
  -Wl,--export=room_bfs_generated \
  -Wl,--export=room_bfs_transpositions \
  -Wl,--export=room_bfs_collected_goals_low \
  -Wl,--export=room_bfs_collected_goals_high \
  -Wl,--export=room_bfs_restore \
  -Wl,--export=room_bfs_restore_visited_word \
  -Wl,--export=room_bfs_restore_edge \
  -Wl,--export=room_bfs_edge_count \
  -Wl,--export=room_bfs_edge_cell \
  -Wl,--export=room_bfs_edge_direction \
  -Wl,--export=room_bfs_edge_z \
  -Wl,--export=room_bfs_edge_node \
  -Wl,--export=room_bfs_edge_player_axis \
  -Wl,--export=row_astar_edge_load_state \
  -Wl,--export=row_astar_restore_physics_workspace \
  -Wl,--export=room_bfs_visited_word \
  -Wl,--export=room_bfs_latest_cell \
  -Wl,--export=room_bfs_collected_goals \
  -Wl,--export=random_agent_begin \
  -Wl,--export=random_agent_run \
  -Wl,--export=random_agent_actions \
  -Wl,--export=random_agent_death_undos \
  -Wl,--export=random_agent_exit_direction \
  -Wl,--export=random_agent_exit_kind \
  -Wl,--export=random_agent_seed \
  -Wl,--export=random_agent_visited_word \
  -Wl,--export=random_agent_trail_count \
  -Wl,--export=random_agent_trail_cell \
  -Wl,--export=random_agent_current_room \
  -Wl,--export=random_agent_reached_room_word \
  -Wl,--export=random_agent_collected_goal_word \
  -Wl,--export=random_agent_collected_goal_count \
  -Wl,--export=random_agent_teleports \
  -Wl,--export=random_agent_note_external_action \
  -Wl,--export=random_agent_mark_goal_collected \
  -Wl,--export=random_world_reset \
  -Wl,--export=random_world_add_room \
  -Wl,--export=random_world_start \
  -Wl,--export=random_world_resume \
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
  -Wl,--max-memory=536870912 \
  -o "$output" \
  -I"$project_root/engine/include" \
  "$project_root/engine/src/physics.cpp" \
  "$project_root/world-solver/v1/native/random-agent-wasm.cpp"

echo "Built $output"
