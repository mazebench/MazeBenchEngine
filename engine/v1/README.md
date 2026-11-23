# Engine v1

This directory contains an unchanged copy of the generalized C++ engine from
the `MazeBenchEngineUnitTest` repository. The exact source commit, source-tree
hash, and WebAssembly hash are recorded in `upstream.json` and exported to the
browser by `upstream.mjs`.

- `core/` is the copied C++ source, public headers, tests, and benchmarks. No
  engine-core file is rewritten here.
- `voxel_physics.wasm` is the byte-identical upstream release build. It contains
  the arbitrary-3D physics kernel, resumable per-tick command API, cycle
  handling, exact shortest-command gem solver, and exact reachable-edge search.
- `adapter.mjs` maps this repository's storage-v2 objects and surface-floor
  coordinates to the five-int C++ ABI.
- `engine.mjs` is the public versioned API for play, replay, and search.
- `solver-worker.mjs` keeps exact editor searches off the UI thread.

No React code, UnitTest dashboard, worker pool, package manager, or build
runtime is included here.

## Updating from UnitTesting

From this repository, run:

```sh
node scripts/sync-engine-v1.mjs
```

The source defaults to the sibling `MazeBenchEngineUnitTest` checkout. Override
it with `--source /path/to/MazeBenchEngineUnitTest` or the
`MAZEBENCH_UNIT_TEST_REPO` environment variable. The source must be committed
and clean. The command rebuilds the WASM, runs UnitTesting's native and WASM
engine suites, copies only Git-tracked `engine/` files and the built WASM,
checks ABI v4/stride 5, writes provenance, and runs the target integration
tests. It refuses to overwrite locally modified vendored files.

For a fast read-only drift check, run:

```sh
node scripts/sync-engine-v1.mjs --check
```

If the ABI version or voxel stride changes, create a new versioned adapter
instead of forcing the update into v1.
