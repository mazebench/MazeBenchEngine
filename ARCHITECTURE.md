# Repository architecture

```text
apps/
  web/       Browser editor and MazeBench renderer integration
  apple/     Reserved for the shared iOS/macOS client
engine/      Platform-independent C++ physics, tests, and benchmarks
scripts/     Repository build, test, and benchmark entry points
ui/          Main-site renderer and browser entry points
play/current/ Live command playback and connected-room orchestration
engine/current/ Live storage-v2 adapter and shared WASM link
engine/v1/   Frozen, provenance-checked historical benchmark snapshot
project-data/ Repo-backed authored physics tests
tests/       Main-site integration and monorepo parity tests
```

The dependency direction is one-way: platform apps consume `engine`; the C++
engine never imports web or Apple code. Project JSON is the portable scene and
test format shared by every client.

The current engine and rendering kernel are owned by this repository. Browser
adapters share the same WASM output and geometry implementation; they translate
their own scene formats. Historical signed runtime directories remain frozen.
See `docs/consolidation.md` for import provenance and verification commands.
