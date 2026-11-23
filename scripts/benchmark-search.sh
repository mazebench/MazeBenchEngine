#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_dir="$project_root/.build/search"
mkdir -p "$build_dir"

clang++ \
  -std=c++20 \
  -O3 \
  -DNDEBUG \
  -flto \
  -march=native \
  -I"$project_root/engine/include" \
  "$project_root/engine/src/physics.cpp" \
  "$project_root/engine/src/search.cpp" \
  "$project_root/engine/benchmarks/search_benchmark.cpp" \
  -o "$build_dir/search_benchmark"

"$build_dir/search_benchmark" \
  "$project_root/engine/benchmarks/fixtures/mixed_3d_427.csv"
