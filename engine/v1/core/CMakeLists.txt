cmake_minimum_required(VERSION 3.22)
project(voxelbench_physics VERSION 0.1.0 LANGUAGES CXX)

add_library(voxelbench_physics src/physics.cpp src/search.cpp)
target_include_directories(voxelbench_physics PUBLIC include)
target_compile_features(voxelbench_physics PUBLIC cxx_std_20)
target_compile_options(voxelbench_physics PRIVATE
  $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-Wall;-Wextra;-Wpedantic;-Wconversion;-Wshadow>
)

include(CTest)
if(BUILD_TESTING)
  add_executable(voxelbench_physics_tests tests/physics_tests.cpp)
  target_link_libraries(voxelbench_physics_tests PRIVATE voxelbench_physics)
  add_test(NAME voxelbench_physics_tests COMMAND voxelbench_physics_tests)
endif()

add_executable(voxelbench_turn_benchmark benchmarks/turn_benchmark.cpp)
target_link_libraries(voxelbench_turn_benchmark PRIVATE voxelbench_physics)

add_executable(voxelbench_search_benchmark benchmarks/search_benchmark.cpp)
target_link_libraries(voxelbench_search_benchmark PRIVATE voxelbench_physics)
