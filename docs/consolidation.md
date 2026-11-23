# Repository consolidation

MazeBenchBenchmarking now owns the engine, browser applications, rendering
geometry, and tests. The former MazeBenchEngineUnitTest checkout is retained
as a historical copy; it is no longer a build dependency or development target.

The import preserves all 898 tracked source files from UnitTesting commit
`7e9c0a6e8f20422318e3929d556068e9028fcb38`. Its README is now
`docs/test-lab.md`; the identical `.gitattributes` is shared and `.gitignore`
rules were merged. The Benchmarking checkout started at
`b14f24de449a54993442440309882c4fd42b8a75`. No Git history, authored rooms,
saved tests, or benchmark records were deleted, committed, or pushed as part
of the working-tree import. The original branch's complete Git ancestry is
also available locally inside this repository at
`refs/archive/mazebench-engine-unit-test` (`git log` accepts that ref). This
archival ref is local; publishing it would require an explicit Git push.

## Development paths

| Component | Canonical location |
| --- | --- |
| C++ physics/search | `engine/include`, `engine/src` |
| Native and WASM tests | `engine/tests` |
| Visual test editor | `apps/web` |
| Authored tests and metadata | `project-data` |
| Rendering geometry/labels/depth | `apps/web/public/mazebench-runtime/joined-voxel-surface.mjs` |
| Main-site rendering | `ui/joined-maze-renderer.mjs` and its scene adapter |
| Live site engine/format adapter | `engine/current` |
| Live playback/connected rooms | `play/current` |
| Solver acceleration wrappers | `world-solver/v1/native` |

`ui/joined-voxel-surface.mjs` is a re-export, not a renderer copy. The lab and
world view therefore use identical surface, edge, label-mask, and depth math.
Their interfaces still have distinct cameras and scene adapters; this import
does not claim that all UI, lighting, or data formats are identical.

`engine/current/voxel_physics.wasm` links to the lab's canonical build output.
Build it once with `npm run build:physics`, then rebuild all browser solver
wrappers with `npm run build:solvers`. Both builds use local dependencies and
the same C++ source. `engine/current/build-info.json` records the actual source
hashes and binary hash, independently of whether edits have been committed.

## Commands

Run `npm ci` once. `npm start` builds the test editor and runs the site on port
8080, including `/unit-tests/`. Its library, editor, and search workspace all
use the existing `apps/web` source. `npm run build:unit-tests` refreshes that
page after UI edits; runtime renderer assets and WASM load directly from their
canonical files, without a second copy. `npm run dev:lab` remains an optional
standalone development server on port 3001. Both entry points save to this repository's
`project-data`. `npm run build` builds all current browser assets and engines.
`npm test` runs the native, lab, WASM, and site suites. `npm run test:lab` and
`npm run test:site` run those groups separately; lint, typecheck, and parity
checks are also available as npm scripts.

## Recorded benchmarks

Existing signed runtime files remain byte-identical. `engine/v1` (including its
old source snapshot), `play/v1`, `render/v1`, `render-ascii/v1`, and
`benchmarking/v1` are historical versioned artifacts, not competing editable
sources. The signed v1 benchmark runner still uses its pinned engine. Switching
new signed evaluations to the current engine requires an explicit new runtime
release; existing runs must never be silently migrated or resealed.

`node scripts/sync-engine-v1.mjs --check` now verifies the frozen snapshot from
its recorded hashes without looking for another checkout. The old syncing
command refuses writes. `node scripts/sync-rendering.mjs --check` verifies that
both browser adapters resolve the same rendering implementation; it copies
nothing. Original source history is retained in the local archival ref and
in the retired checkout.
