# Engine and test-library audit

The subsequent [October 2026 audit](docs/ENGINE_AUDIT_2026-10-05.md) covers the
O×O momentum fix, clone collision and gate search fixes, added coverage, and
the refreshed test library. The report below records the September audit.

## Work checklist

- [x] Run the unchanged native, browser, and authored suites.
- [x] Record native command and exact-search performance baselines.
- [x] Diagnose the two new failures against related authored cases.
- [x] Replace brittle geometry assumptions with shared support/contact rules.
- [x] Split the large movement module into focused, documented components.
- [x] Add independent regression cases and invariance checks.
- [x] Audit identical starting states for contradictory expected timelines.
- [x] Give every existing case a useful title and evidence-based description.
- [x] Preserve all existing IDs, frames, coordinates, tags, and hidden flags.
- [x] Refresh the test-library/editor design and verify it locally.
- [x] Run the complete suite, production build, and performance comparisons.

## Baseline, 2026-09-05

There are 518 authored tests: 504 pass, two fail, and 12 are hidden by the
author. The combined JavaScript/WASM suite reports 658 passing, two failing,
and 12 skipped; the 89 native C++ tests pass. Of the authored cases, 345 have
placeholder titles and 491 have no description.

The failures are `test-517` (a tall, wide box pushed up consecutive ice slopes)
and `test-518` (the player leaves beneath a box also supported by a stationary
polycube). Existing expected frames are the specification; this audit must not
replace them with generated engine output.

## Root causes and changes

1. **Tall/wide slope ascent (`test-517`).** Flat support beneath another foot
   could veto an uphill contact for a tall polycube. Contact collection now
   resolves one whole-body slope proposal, independently of member order.
   A remote ceiling still rejects the entire transaction; it cannot split a box.
2. **Independent pedestal (`test-518`).** Carry rejection was restricted to a
   one-voxel pedestal. Independently grounded, non-Ice support now has the same
   meaning for any pedestal size. Mutual/interlocking support is distinguished
   from a pedestal; moving-box carriers retain their stack-carrying behavior.
3. **Player carrying itself.** Permuted storage exposed a multi-cell player
   treating its own lower cell as a carrier and translating twice. Internal
   members of the same rigid player cannot be separate carriers.
4. **Overlapping orange volume.** Insertion order could hide an ordinary solid
   behind an orange wall at the same coordinate. Orange-scene indexes now
   preserve the ordinary obstacle. Non-orange hash insertion is unchanged.
5. **Extra blank settling tick.** A single pass over support flags could leave
   upper bodies falling after their support had landed. The quiescence query
   propagates settling to a fixed point; mutual support cycles still go through
   component gravity, rather than being falsely marked stable.
6. **Invalid rigid-object sentinel.** Address/undefined-behavior sanitizers
   found clone movement querying `ObjectIsActive(-1)` for a single-cube player,
   then reading array elements at index -1. The common object query now rejects
   invalid IDs before indexing. The new `npm run test:physics:sanitize` command
   fails immediately on sanitizer violations, rather than printing warnings
   followed by a misleading successful exit.

The former 3,200-line movement file is an include-only facade over focused
support, gravity, translation, lift, and slope modules. Orange mechanisms and
prepared passive evaluation are also separated from command-state management.
The same C++ translation unit and public APIs serve native builds and WASM.
This is a tested structural cleanup, not a claim that every future interaction
is already covered or that all large orchestration modules have disappeared.

## Tests and preservation

- **536 visual cases: 524 pass, 12 intentionally hidden.** Every active case
  checks all four rotations, exact intermediate frames, frame count, and cycle
  markers where specified. The browser independently shows 524/524 passing.
- **`npm test`: 703 passed, zero failed, 12 skipped** (715 JavaScript/WASM
  checks), plus **89 native C++ physics/search tests passed**. Production build
  and `npm run lint` pass.
- **AddressSanitizer + UndefinedBehaviorSanitizer:** all 89 native checks pass
  with no diagnostics after fixing the invalid-object access.
- Added **18 visible Engine regressions** with independent expected frames:
  six width/height combinations, each with free ascent and a remote ceiling;
  three pedestal widths, each on Floor and Ice.
- Added reversed and interleaved voxel-storage checks across every active
  authored timeline. These discovered the three additional order-sensitive
  bugs above; they do not replace any authored expectations.
- Every original case has a title and a frame-derived description. Meaningful
  names and author notes were retained where applicable; old titles remain
  searchable in [the catalogue](docs/TEST_CATALOG.md).
- All **518 original compact case files** were compared before/after excluding
  only `name` and `description`: palettes, delta frames, IDs, coordinates,
  orientations, mechanism metadata, locks, tags and hidden flags are identical.
  No case was deleted and no expected frame was changed to make a test pass.

## Contradictions and metadata caveats

No conflicting expectations were found among identical normalized engine
inputs, including hidden cases. This checks dimensions, starting objects and
states, command, complete expected timeline, and cycle interval. It does not
prove that every pair of merely similar scenes expresses the same intended
rule.

One exact duplicate pair is preserved:

- [`test-284-copy-copy-copy-copy-4`](project-data/tests/test-284-copy-copy-copy-copy-4.json)
- [`test-284-copy-copy-copy-copy-copy`](project-data/tests/test-284-copy-copy-copy-copy-copy.json)

Both expect the same six-tick lift trajectory. Three `test-132` copies retained
the old note “falling on a gem collects it” even though none contains a gem:
`test-132-copy-copy`, `test-132-copy-copy-copy`, and
`test-132-copy-copy-copy-copy`. Their descriptions now describe the actual
rigid-player movement/fall. Their geometry and timelines are untouched.

## Performance

Native release builds use the existing `-O3 -flto -march=native` benchmark
scripts. The exact-search fixture and its work counts were not changed.

| Same workload | Before | After |
| --- | ---: | ---: |
| Eight-voxel Ice push, complete public command (paired-run median) | 1.126M turns/s | 1.120M turns/s |
| Prepared passive Floor evaluation (paired-run median) | 43.09M evaluations/s | 43.02M evaluations/s |
| Mixed 3D exact search: global dynamic states | 61,834/s | 63,764/s |
| Mixed 3D exact search: attempted commands | 5.005M/s | 5.161M/s |
| Mixed 3D exact solves | 45/s | 46/s |

Five pairs of command samples were run alternating an archived HEAD build and
the final changed build on the same machine, after other compilation and type
checking finished. Median command throughput differs by less than 0.5%; the
passive evaluator differs by less than 0.2%. Mixed-search throughput is about
3% higher in this sample, within normal run variation rather than a claimed
algorithmic speedup. These are workload measurements, not universal
nodes/second promises.

The search fixture is `mixed_3d_427`, hash `ab2b3428d9df8632`, 110 voxels,
optimal solution **435 moves**. Before and after each solve visits 1,371 global
dynamic states, attempts 2,908 dynamic successors and 110,975 total commands,
visits 27,755 local player states, and performs 14,705 full physics transitions.
An attempted command, a local walking state, and a complete A* node are not
interchangeable units.

## Editor and saving

- Graphite panels, readable system typography (no external font downloads),
  less glow/visual noise, multiline titles, orange locked icons and clear
  preview controls. The Three.js renderer and stable replay camera are retained.
- The main library mounts **24 cards per page**, instead of all 536. ID search
  joins title/description/tag search. Related subtag combinations remain visible.
- Verified desktop and narrow layouts, page switching, ID search, frame paging,
  running the suite and an empty browser error log.
- Repository GETs return a content revision. Queued browser saves must match
  that revision; a stale tab cannot overwrite newer tests. A conflict pauses
  saving and offers draft export/reload. Automated temporary-directory tests
  cover stale/new/missing revisions and metadata changes. A browser smoke test
  confirmed the warning and that the repository case was not overwritten.
- The correct repository-backed development server is on **localhost:3001**.
  Changes are in the local repository; this audit did not commit or push them
  to GitHub.

## Separate pre-existing type-check debt

`npm test` (including the production build) and ESLint are green. An additional
standalone `npx tsc --noEmit -p apps/web/tsconfig.json` still reports 16 existing
web typing/declaration issues: JavaScript helper signatures inferred too
narrowly, visual/cycle literal types, a missing saved-search metric, and absent
Cloudflare worker type declarations. New revision-save typing errors found
during this check were fixed. The remaining errors are not C++ test failures
and were not suppressed or excluded to produce the passing suite counts above.
