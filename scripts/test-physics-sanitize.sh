#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_dir="$project_root/.build/physics"
mkdir -p "$build_dir"

clang++ \
  -std=c++20 -O1 -g \
  -fsanitize=address,undefined -fno-omit-frame-pointer \
  -I"$project_root/engine/include" \
  "$project_root/engine/src/physics.cpp" \
  "$project_root/engine/src/search.cpp" \
  "$project_root/engine/tests/physics_tests.cpp" \
  -o "$build_dir/physics_tests_sanitized"

# Fail on the first violation: UBSan otherwise reports an error but can leave
# the process exit status successful and misleadingly print "all tests passed".
UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
ASAN_OPTIONS=halt_on_error=1 \
  "$build_dir/physics_tests_sanitized"
