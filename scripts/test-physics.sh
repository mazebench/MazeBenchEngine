#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_dir="$project_root/.build/physics"
mkdir -p "$build_dir"

clang++ \
  -std=c++20 \
  -O3 \
  -Wall \
  -Wextra \
  -Wpedantic \
  -Wconversion \
  -Wshadow \
  -I"$project_root/engine/include" \
  "$project_root/engine/src/physics.cpp" \
  "$project_root/engine/src/search.cpp" \
  "$project_root/engine/tests/physics_tests.cpp" \
  -o "$build_dir/physics_tests"

"$build_dir/physics_tests"

clang++ -std=c++20 -O3 -Wall -Wextra -Wpedantic \
  -I"$project_root/engine/include" \
  "$project_root/engine/tests/orange_support_index_tests.cpp" \
  -o "$build_dir/orange_support_index_tests"
"$build_dir/orange_support_index_tests"
