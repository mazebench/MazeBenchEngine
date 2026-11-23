# October engine and test-library audit

## Fixed behavior

### O×O interlocked bodies

The 58-command reproduction from MazeBenchBenchmarking was:

```
U Rx3 D Rx9 Ux4 R U Lx7 D L U Rx4 Dx4 L Ux3 R U Lx4 D Lx2 Ux2 Rx5
```

On the final Right, two interlocked blue bodies received continuing momentum
from an ordinary, mandatory push. Three distant ramps selected the slope
movement path. That path mistook a departing, non-Ice supporting body for a
momentum source. The bodies moved three cells right and fell one level, while
the player moved only one cell. Replacing just the remote ramps with walls
made the bug disappear. The user's smaller `test-556` did not contain ramps;
adding one distant ramp reproduced the same defect there.

Departing-support momentum now requires a slippery supporting body. Ordinary
one-tick pushes no longer manufacture continuing movement. The exact O×O
pre-push state, the no-ramp control, and `test-556` with a remote ramp are
visible regression cases. Their expected result is one horizontal cell with
no fall, independently checked against the authored starting positions.

### Clone collision on boards containing ramps

A seeded terrain-isolation audit found that any ramp anywhere made the clone
logic assume the player would vacate its cell. A clone could then push a crate
into a stationary player when a wall or the one-crate push budget blocked the
player. The vacancy check now validates the player's local ramp entry, target
height, and actual obstruction. Real ascent still works; a ceiling blocks it.

### Exact search and gates

A separate exhaustive BFS using full physics found a three-command gate route
that optimized search incorrectly reported as five. Search normalized the
authored gate state before the first command. It also restored settled gates
before placing the player at the current local search coordinate, and its
duplicate gate rule omitted Floating Floor blockers.

Search now distinguishes the authored gate configuration from settled gates,
restores gates after the local player coordinate, and includes Floating Floor
occupancy. One flag keeps authored/rollback states exact without consuming one
moving-entity slot per fixed gate. A native regression covers 80 gates. The
public engine ABI, voxel stride, and required exports remain unchanged.

## Coverage added

- 23 visible cases: three exact reproductions/controls, eight independent
  interlocked-body cases, and twelve clone vacancy cases.
- Interlocked tests vary four rotations, three voxel orders, three object-ID
  pairings, four ramp orientations or no ramp, blocked/clear destinations, and
  carried passengers. Checks include every tick, final-state API parity, and
  absence of an invented cycle.
- Clone vacancy tests cover walls, two crates, two Floating Floors, open lanes,
  ramp ascent, and ramp ceilings, with and without a remote ramp, in four
  rotations and two voxel orders.
- 256 deterministic ordinary 3D scenes execute four commands each. Adding a
  sealed-off ramp must preserve every frame and cycle marker.
- An independent, unoptimized full-physics BFS checks shortest search results
  for 15 small puzzle families in four rotations and two orders (120 searches).
  Families include crates, polycubes, clones, Ice, gates, lifts, punchers,
  Floating Floors, and an unreachable goal. Every returned route is replayed.
- Native assertions now identify the failing test and count tests dynamically.
- Sorting tests verify natural order, status priority, stable manual order,
  and preservation of test data. Browser cycle comparison now checks metadata
  as well as visible frames, with missing/unexpected/incorrect-cycle tests.

All 556 preexisting cases, including the user's uncommitted `test-556`, retain
every field except explicitly improved names/descriptions. All authored
frames, identifiers, tags, and hidden choices were compared against the
original checkout/backup. Block definitions and roles are unchanged. Sixteen
placeholder names were replaced; the [catalogue](TEST_CATALOG.md) records them.

## Test-library and application cleanup

The library uses neutral dark surfaces, system-blue actions, compact cards,
collapsible expected behavior, and an overflow menu for secondary actions.
Group names are consistent. Sort by group/name, name, case ID, timeline length,
attention needed, or the preserved manual order. Reordering is enabled only
in Manual order. Pagination and limited related previews bound rendering work.

Run suite yields between batches and rejects stale results if tests or block
definitions change during execution. Group summaries report their own scope;
the progress bar clearly labels the entire suite. Import/export live in the
Project menu. Existing toolbox artwork remains intact.

The audit also repaired 16 existing TypeScript errors, restored the missing
search benchmark rate field during normalization, and allowed retry after a
failed WASM load. `npm run typecheck` is now a documented verification command.

## Verification

- Native C++ physics/search: **102 passed**.
- AddressSanitizer and UndefinedBehaviorSanitizer: **102 passed**.
- Full `npm test`, including production build: **853 passed, 12 skipped,
  zero failed** across 865 JavaScript/WASM tests.
- Browser Run suite: **567/567 active cases passed**, each in four rotations
  (2,268 checks); the existing **12 author-hidden cases remain ignored**.
- ESLint and TypeScript: passed.
- Desktop browser: checked suite execution, search, sorting, overflow actions,
  disabled reordering outside Manual order, and the empty failing filter.

On the same machine, the existing mixed 3D search benchmark retained its
435-command optimum and identical state/transition counts. Five-sample median
throughput was 46 native solves/s both before and after; WASM measured 33
before and 35 after (ordinary timing variation, not a claimed speedup).
The final physics microbenchmark measured about 1.1 million tiny Ice-push
commands/s. These are local checks, not a guarantee for every puzzle.

The audit focuses on momentum/support, actor collisions, search equivalence,
and application consistency. It does not claim exhaustive proof of arbitrary
3D configurations; hidden authored tests were not silently re-enabled or
rewritten to match engine output.
