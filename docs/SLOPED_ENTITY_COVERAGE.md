# Sloped-entity coverage and compact test library

Added 46 independently specified visual cases: 23 for blue box slopes and 23
for yellow clone slopes. They live in **Box slopes** and **Clone slopes**, each
with four new folders:

| Folder | Cases per family | Behavior |
| --- | ---: | --- |
| Rigid bodies | 6 | Mixed cube/slope bodies, collision at a remote slope or raised member, independent IDs, separate blue/yellow families, distant ramps |
| Riders and Ice | 3 | Flat-crown passengers, full Ice support, mixed Ice/floor support |
| Pushes and gems | 5 | One-crate pushes, blocked two-crate chains, Floating Floors, gem contact at cube and slope members |
| Ramp contacts | 9 | Low/high faces, ceiling-blocked ascent, wedging under cargo, riders descending onto floor/Ice, cargo climbing, opposing slopes |

The hand-authored builders in
[`sloped-entity-fixtures.mjs`](../engine/tests/helpers/sloped-entity-fixtures.mjs)
do not call the engine. Expected ticks are checked independently against both
the tick-stream and final-state WASM APIs. Fixtures reject unknown block IDs.

The test matrix checks four whole-room rotations, IDs 0 and 1007, and three
voxel input orders. Mixed-body cases additionally check all four relative slope
orientations. This produces **3,120 command configurations**, each checked
through both APIs. Moving slopes retain their existing distinct semantics:
yellow slopes receive directional commands, while blue slopes are pushed.
Both leave gems intact; only the player can collect gems.

The existing fixed Ice-slope catalog remains part of the complete suite. These
additions focus on moving slopes and their interactions; they do not claim an
exhaustive proof for every possible multi-mechanism room. No engine behavior or
WASM binary was changed in this update.

Run `node scripts/add-sloped-entity-tests.mjs` to register any missing new cases.
The script is idempotent and never overwrites existing authored tests. All 579
previous test records, expected frames, hidden flags, and existing tags are
preserved.

The suite UI uses full-width 204 px previews with a single-line title and a
small action row. Tags, counts, and expected behavior are available in Details;
the preview is the dominant part of each card. Folder search preserves ancestor paths; folders expand independently
and collapse-all clears the search. Rename/create/delete actions use a compact
menu, redundant sole Default rows are hidden, and counts include combination
memberships consistently with status indicators. Folder expansion is local UI
state, not a project-file edit.

In the suite, **A/D** rotate every preview by 90 degrees and **W/S** tilt by
15 degrees per step. Holding W/S repeats at a bounded rate. Typing in search,
titles, descriptions, and other text fields does not move the camera. The
camera reset button restores the initial view. Only visible/nearby frames are
queued through the shared renderer; the previous picture stays visible until
its replacement arrives. Camera generations reject stale in-flight results
and retain only one image per test/frame, rather than an angle history.
The camera update passes 168 app tests, production build, lint, and typecheck,
plus browser checks for all four keys, rapid changes, text entry, and timelines.

Validation:

- `npm test`: 102 native C++ tests passed; production build passed; 949
  JavaScript/WASM tests passed, 12 existing hidden cases skipped, no failures.
- `npm run typecheck` and `npm run lint`: passed.
- Browser Run suite: 613/613 active cases, all four rotations (2,452 checks).
- Browser checks: folder search, filtered expansion/collapse, collapse-all,
  rename cancellation, guarded deletion, and preview timeline controls.
- Compact layout checked at desktop and narrow widths; no horizontal overflow
  at the narrow breakpoint.
