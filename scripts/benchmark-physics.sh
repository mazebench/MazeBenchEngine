#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_dir="$project_root/.build/physics"
mkdir -p "$build_dir"

clang++ \
  -std=c++20 \
  -O3 \
  -DNDEBUG \
  -flto \
  -march=native \
  -I"$project_root/engine/include" \
  "$project_root/engine/src/physics.cpp" \
  "$project_root/engine/benchmarks/turn_benchmark.cpp" \
  -o "$build_dir/turn_benchmark"

"$build_dir/turn_benchmark"
