# MazeBench monorepo agent instructions

## Canonical source and layout

- MazeBenchBenchmarking is the single development repository. The former
  MazeBenchEngineUnitTest app, C++ source, native/WASM tests, benchmarks, and
  authored project data now live here at their original relative paths.
- Edit engine/include and engine/src for physics/search. Build with
  npm run build:physics. The test lab and browser engine/current load the same
  apps/web/public/physics/voxel_physics.wasm file; engine/current's WASM path is
  an in-repository symbolic link, never another release copy.
- apps/web is the test lab (port 3001); project-data contains all authored
  test fixtures. The main site remains node server.mjs (port 8080).
- The main site's Unit tests link opens /unit-tests/ on the same origin.
  npm start builds that page from apps/web/site using the existing VoxelBench
  component; npm run build:unit-tests refreshes it after UI edits. Its generated
  unit-tests directory is ignored. Public renderer/worker/WASM files are served
  directly from apps/web/public, and the shared /api/local-project handler saves
  to project-data with revision checks. Port 3001 is optional standalone lab
  development, never a hard-coded main-site navigation target.
- engine/current contains the live storage-v2 adapter and browser engine API.
  play/current contains the live command playback and connected-room adapter.
  The lab retains its format adapter in apps/web/app/physicsEngine.ts. Test
  adapter parity with npm run test:parity.
- World Solver/editor/Solutions accelerators build from this same engine/src
  using root node_modules. Their extra search exports remain project-owned
  under world-solver/v1/native and must not enter the canonical physics ABI.
- No build or test may require a sibling checkout. Do not restore external
  sync defaults or create a second editable copy of the rendering kernel.

## Build and verification

Run npm ci once. npm run dev:lab serves the test lab on port 3001; npm start
serves the main site on port 8080. npm run build builds the lab, canonical
engine, and browser solver accelerators. npm test runs native engine tests,
builds the lab and accelerators, and runs all lab, engine/WASM, and site tests.
Also use npm run lint, npm run typecheck, and npm run test:parity for changes
to the combined applications. Rebuild accelerators with npm run build:solvers
following any C++ change. Do not hand-edit engine/current/build-info files;
the physics build records source-file hashes and the actual WASM SHA-256.

## Historical benchmark snapshots

engine/v1, play/v1, render/v1, render-ascii/v1, and benchmarking/v1 are signed
historical runtime assets. Preserve their JavaScript, WASM, and provenance
bytes. engine/v1/core is a frozen release snapshot, not editable source.
Existing benchmark runs continue to use their pinned engine; they are not
silently upgraded or resealed by a repository consolidation. A new signed
benchmark runtime/version is a separate explicit release operation.

scripts/sync-engine-v1.mjs --check verifies that frozen snapshot locally.
The old cross-repository import command is retired. Live browser work belongs
in ui, engine/current, play/current, apps/web, and the project-owned solver
modules. When changing an adapter, check coordinate conventions, role/shape
encoding, mechanism state, command/tick playback, and camera-relative input;
a shared binary alone does not establish adapter or lighting parity.

## Model collision volume

Solid models occupy a vertical wall column of `visual.height` unit voxels.
The Benchmarking engine adapter appends their upper collision cells after the
authored objects; readback keeps only the authored template. Use the `count`
returned by `engine.writeState()` for every native physics/search upload, not
`state.objects.length`, and include the expanded count in capacity checks.
These extra cells must never enter room saves, rendered objects, or gem IDs.

## Play animation timing

The browser Play entry point is `ui/play-main.mjs`. Make browser-only Play UI
changes there. `play/v1/main.mjs` is retained unchanged because its bytes are
included in historical benchmark runtime manifests; it is no longer loaded by
the Play page. Live session and connected-room behavior lives in `play/current/`.
Browser ASCII projection lives under `render-ascii/v2/`; its room bounds include
empty tiles at every pitch. Keep `render-ascii/v1/` JavaScript unchanged for
signed benchmark observations.

Human 3D Play opts into `animations/v1/`: the connected adapter supplies a
read-only, unprojected trace with stable object indices, and the presentation
layer compiles independent motion and mechanism tracks. Single-cell movements
ease in/out; uninterrupted collinear multi-cell motion is linear. Disappearing
moving actors continue one cell along their last motion and fade. Mechanism
geometry interpolates between the canonical closed/open shapes; room changes
tween the camera. Build geometry once per command, then update transforms and
small mechanism buffers at display cadence. Never rebuild the world per tween
frame, mutate physics snapshots, or send fractional coordinates to the engine.
Ordinary level player moves reuse the current scenery and a separate player
group; settling and undo must not rebuild an unchanged room. Rebuild when other
objects, room context, or the cut height changes.
Room crossings reuse unchanged cached destination scenery and tween camera and
brightness without rebuilding that scenery. Keep separately moving players out
of stationary room-border contours so entry tiles never retain their outlines.
Do not draw the hidden ASCII board during 3D moves; synchronize it when switching
views. Truncated command scenes retain filled cross-section buffers and joined
contours. Clip original
edges below the cut plane so hidden upper-layer bottoms cannot flicker through.
Truncated authored 3D models have filled top sections in each model part's own
surface color. Reuse cached local-space sections across identical models and
fixed layers; fractional tween cuts update retained buffers. Keep model caps
out of upper-layer ghosts and preserve the original model geometry.
Orange-wall outlines include their exposed intersections with floors and solid
supports, even when the wall continues underneath. Use the shared surface
intersection kernel at rest and during tweens, updating retained outline buffers.
Treat supporting tiles as a joined volume when finding those intersections:
internal floor sides must not draw a grid across a flush lowered orange surface.
Keep its outer contact contour and partial ledges. Joined orange surfaces use
the lab's small polygon depth offset to avoid fighting a coplanar floor.
Object fades use one screen-space coverage mask shared by surfaces and outlines,
keeping opaque surfaces depth-writing so rear faces and internal edges cannot
show through. Do not turn solid actors into alpha-blended shells during fades.

Play's default-on Tweens toggle lives under Playback settings and persists on
this device. Single steps take 100 ms, slides take 40 ms per tile, and room camera
and brightness transitions take 250 ms. Consecutive room transitions retarget
from the displayed state without stopping the actor at each seam. Turning tweens
off renders only the final state. Reduced-motion preferences also bypass 3D
tweens. Human ASCII retains discrete engine-tick frames on the same presentation
clock as 3D (including slides and room transitions), so controller pacing is
identical. Skip unchanged ticks and hidden 3D geometry rebuilds; synchronize the
3D scene when switching back. Signed benchmark ASCII observations stay unchanged.
Human Play gems gently bob and rotate continuously on the same display clock,
including cached rooms and command scenes. Update only gem transforms, keep their
phase across rebuilds, and honor the Tweens/reduced-motion settings. Do not run
the idle 3D animation loop while viewing ASCII or a hidden tab.
Room resets ease objects and mechanisms back over 250 ms. On leaving a room,
restore its authored non-player objects before revealing the cached background;
Reset restores the current visit's entry state, including collected objects.
Interrupting motion with Reset starts at the displayed pose. Presentation identity
is a WeakMap sidecar in play/current/presentation-identity.mjs, propagated through
projection and history; never add animation IDs to engine objects or room saves.
Undo/reset/room selection must cancel presentation immediately, including undo
of the first in-flight move, without allowing stale completions to overwrite the
replacement state. AI vision observations and all signed benchmark renderers
must never import or enable the human animation layer.

Play history records only commands that change the canonical engine state or
move the player to another room. A blocked or otherwise ineffective command
must not create an undo snapshot or increment the move counter.
The Play sidebar's Room moves panel records those commands as world-direction
UDLR for the current visit, independently of the capped undo history. Reset and
room selection clear it; entering another room starts a fresh sequence at that
entry state. Undo restores the sequence alongside the room/state snapshot,
including across room crossings. A slide or punch remains one input character.

Play controller input lives in ui/play-gamepad.mjs and uses the browser's standard
gamepad mapping. Left stick/D-pad moves are camera-relative and repeat only when
the current command finishes; never queue held input behind animations or a move
sequence. Stick holds wait 195 ms before the second move; D-pad holds wait
260 ms. Both then repeat every 130 ms, so the stick gets half the D-pad's extra
first-hold pause. Left-stick diagonals choose
one cardinal direction, retaining it until the other axis is clearly stronger;
never alternate commands between axes. Right stick turns use the same cardinal camera as keyboard controls;
tilt and ZL/ZR zoom share smooth camera motion without taking ownership of keyboard
or pointer holds. ZL zooms in, ZR zooms out; each press of any of the four right-side
face buttons undoes once in Play. Flyover shares controller polling and mapping,
with left stick/D-pad panning and continuous right-stick camera rotation.
Controller activity hides the surrounding UI in Play and Flyover; mouse or keyboard
input restores it, and a still-held controller must not immediately hide it again.
Suspend input while editing text or when the page loses focus, and release controller
input on disconnect. Preserve signed play/v1 JavaScript.

## Replays

Human replay movies live in replays/v1, linked between Solutions and Unit tests.
Import plain UDLR, text room commands, and Solutions JSON; use its declared
start or H×I. Compile with the current connected-room engine in a cancellable
worker, keeping collected gems permanent across room commands. Reuse the human
animation curves, with shared stationary tracks instead of retaining every
physics frame. Seeking must sample those curves directly in either direction,
including fractional moves, mechanisms and room-camera/brightness transitions.
Paused playback freezes the presentation clock (including gems) while leaving
camera controls live; seeking must preserve the user's orbit, zoom and pan.
Never alter Solutions saves or import these effects into signed AI observations.
Compiled replay caches are disposable and bounded (three movies, 128 MiB estimated
serialized data). Hash the transitive compiler sources, engine build metadata,
full world definitions/objects, input and start; cache failure must fall back to
compilation. Retain bounded scene reuse separately from the persistent movie cache.

## Connected-world Play transitions

World topology and reset-on-leave policy belong to Play Mode, not the vendored
C++ source. `play/current/connected-world-session.mjs` begins every command with only
the current room. An outward command from an edge, or an intermediate engine
frame reaching an edge with Ice or punch momentum, adds only that neighboring
room and reruns the same command from its original state. Inspect contacts in
time order: a temporary boundary can reflect a slope slide back into the room
or cause a cycle before the command ends. Ignore the cycle's rollback frame as
movement. Skip already attached rooms; if the neighboring geometry prevents
entry, retain the original trace and continue checking later edge contacts.
Repeat this so one command may traverse a straight or L-shaped chain of rooms
without loading unrelated rooms.

Rooms attached during a command start from immutable authored data with their
authored player removed; the incoming player is the only player carried across
the seam. At completion, retain only the room containing the player and discard
all rooms that were left. Re-entering a discarded room therefore restores its
original objects. Connected-world animation frames may name different rooms;
`PlaySessionV1` must switch its active room before publishing each such frame
and must preserve the room identity, state, and room-scoped reset state in each
undo snapshot. Undoing a transition switches back to the previous room and
restores its exact pre-command state; ordinary forward re-entry still starts
from immutable authored room data.

Visitation and authored-start unlocks count only the room where a directional
command finishes with a living player. A fatal first entry leaves the destination
locked, including for an immediate room command. A later fatal entry preserves
any previously earned access. Intermediate rooms traversed during an Ice slide or punch
remain unvisited unless an earlier command settled there. Keep their animation
frames and path telemetry, but do not create entrances, room proofs, or room
command access for them. Solutions replay/import and new-room searches must
apply the same rule; the Random Agent's reached-room list uses settled outcomes.

Orange buttons control only the orange walls in their own room, including every
intermediate tick of a crossing. Combining room geometry must never combine its
control circuits. Settling a destination after projection is insufficient: a
neighboring button must not lower its walls even for one animation frame.
Orange walls and their slope variants are anchored terrain: raising/lowering
changes only mechanism depth. Their fully raised X/Y/Z anchors must never
translate with pushed, sliding, or carried bodies, even while compressed and
overlapping a body's coordinates.

Clone directional input belongs to the room where the command began. Every
attached destination room suppresses clone input for that whole command,
including multi-room slides and punches; the following command selects its
starting room anew. Temporary layouts namespace clone and weightless rigid-body
IDs by room and encode the canonical `kCloneNoCommandIdFlag` for non-origin
clones. Project authored IDs back and remove every transient body property
before returning room state. Keep ordinary clone collision and passive physics
behavior.

Only the player may cross a room seam. Encode the uniform room dimensions on
the temporary player's generic ID with `kPlayerRoomGridIdFlag`. The canonical
movement validators keep every non-player body, passenger, and fixture in its
own room during pushes, Ice/ramp slides, punches, and carrying. Reject the move
before committing any crossing voxel, including part of a polycube; do not
filter transported objects out after simulation. Strip the temporary room-grid
properties on projection so saves and undo retain authored player metadata.

The C++ engine accepts a rectangle, so an L-shaped temporary region represents
unvisited holes with synthetic solid boundary columns. These columns must never
be projected into room state or rendered. Do not eagerly combine a complete
row, column, or world: a room is attached only after the trace expresses intent
to cross its shared edge.

## Edge Finder and World Solver v1

The canonical engine exposes an exact reachability API through
`search_edges`, `search_edge_count`, and `search_edge_solution`. It enumerates
boundary-reachable states without requiring a gem and preserves distinct
dynamic board states even when the player coordinates coincide. Keep ordinary
gem solving on `search_solve`. The editor no longer exposes Edge Finder;
retain the reachability API for its other consumers and tests.

`world-solver/v1/` is deliberately a simple random walk across the complete
256×256 pixel world, rooted at authored room H×I. It chooses only Up, Right,
Down, and Left. It retains exactly one reusable pre-action snapshot and invokes
undo only when that action kills the player. Every 10,000 directional moves it
teleports to a randomly selected reached room, using that room's latest visited
player coordinate and fresh authored room state, so a softlock cannot trap the
run forever.

The page-owned `native/random-agent-wasm.cpp` includes the synced canonical
`wasm_api.cpp` in its own translation unit and adds batching/world coordination
there. The resulting `random-agent.wasm` is separate from
`engine/v1/voxel_physics.wasm`; the canonical binary and all copied engine
source must remain byte-identical to UnitTesting. Ordinary floor-to-floor room
crossings, visit pixels, reached-room bits, gem identity, death rollback, and
teleports stay in the native batch. Complex Ice/punch/mechanism seams may stop
the batch and use `ConnectedWorldSessionV1` as the exact fallback.

The editor's gem solver also uses this project-owned wrapper so it can expose a
chunked search without changing the imported engine. Fast A* uses weighted
goal-distance ordering and an adjustable physics-interaction bias. Bias 0 is
off; a positive value explores commands that move non-player bodies or change
mechanisms sooner, with at most three interaction credits per command. Because
that bias and the weighted heuristic affect ordering, its returned route is
explicitly not a shortest-route proof. BFS (the exact-shortest preset) always forces both
weights to zero and retains uniform-cost shortest-command semantics. The editor
reports global board states/sec and attempted engine command simulations/sec
live for both modes.

The Random Agent UI displays the full 256×256 grid. Reached room backgrounds are green,
every visited `(x,y)` pixel (dropping z) is yellow, and the most recent 50
distinct player positions fade from yellow toward red with the current pixel
red. It reports live actions/sec, directional actions, reached rooms, unique
gems, death undos, softlock teleports, and the current room. There is no saved
route graph, invalidation tree, or playback UI in World Solver v1.

Exact BFS, DFS Meta, Super A*, and Row A* are the deterministic World Solver modes. They start at H×I and use the
canonical search engine's compact dynamic-entity representation with a
project-owned reachability loop. Exact BFS, DFS Meta, and Super A* collapse
ordinary player reachability into a local BFS for each global board
configuration. The UI paints reachable
player `(x,y)` pixels yellow on the full 256×256 world and boundary exits cyan.
An open or actively searched room uses the yellow map palette. The same room
changes atomically to orange when its search completes or its exact frontier is
exhausted, and its red current-position marker is removed. A closed orange room
must never receive another red marker unless a future search phase genuinely
reopens it and first changes its status back to yellow.
Throughput must report attempted engine commands per second separately from
local state visits per second.

Exact BFS finishes the current room before dequeuing another reached room. DFS
Meta instead stops the native room loop when a new boundary entrance is exposed,
copies only the compact room BFS frontier into page-owned storage, immediately
searches the new room, and rebuilds/resumes the exact parent frontier during
backtracking. It must not discard a partial room search, restart it from its
authored root, or modify the canonical engine to support this orchestration.

Super A* retains the local player BFS but orders global dynamic-board states by
weighted `f = g + 3h`, where `h` is Manhattan distance to the nearest remaining
gem or boundary leading to an undiscovered room. Its page-owned global
portfolio allocates bounded search slices across room-entry jobs, favoring
shallower jobs and rooms with remaining authored gems without letting one hard
room monopolize the worker. A new outlet adds its reset neighboring room to the
portfolio immediately; a collected gem reprioritizes continuation states in the
same exact room graph. Deduplicate room jobs by first entrance and board states
by the native compact-state hash. Super A* is a discovery-throughput heuristic,
not a shortest-route proof.

Row A* is deliberately gem- and exit-agnostic. For each vertical player row it
actually reaches, it uses the original project-owned weighted A* search to
cover every unvisited standable `(x,y)` surface derived from immutable
floor, solid wall, Ice, and Ice-slope geometry;
an immutable surface covered by another immutable block is not a target. Room
edges create neighboring-room work only when encountered incidentally. Gems are
still counted when incidental traversal collects them but never affect the
heuristic. Floating floors do not trigger a BFS fallback: every position they
occupy in an encountered dynamic board state extends the Row A* target
landscape. A room job finishes when all targets on its discovered rows have been
visited or when its exact command-state frontier is exhausted. Every boundary
candidate must run the outward command against the connected neighboring room
before it counts as an entrance. Deduplicate the resulting neighbor state, not
just its player coordinate or room name; boundary states already covered by
that room are duplicates. A distinct alternate entry reopens an orange room,
turns it yellow, and starts another room job; a duplicate leaves it closed. Do
not replace this search with the editor Fast A* wrapper or add editor
physics-bias controls to World Solver.

The connected-room test command and native Row A* share one physics workspace.
After every connected edge simulation, call the project-owned Row A* workspace
restore export before continuing its frontier. Otherwise the next search slice
uses the temporary multi-room terrain cache and can falsely report exhaustion;
G×F is the regression fixture for this failure.

Exact BFS, DFS Meta, and Super A* still use the first room entrance until their
orchestration is migrated to the same alternate-entry queue. Do not silently
describe those legacy modes as having Row A*'s re-entry closure.

## ASCII overlap and face-fixture contract

The ASCII renderer resolves ordinary objects by exact `(x, y, z)` occupancy.
When multiple ordinary objects occupy one voxel, render only the deterministic
highest-priority object. A full occupant such as the player, a clone, a crate,
or a weightless body hides a button, gem, or other face fixture at that voxel,
but a floor or Ice surface remains rendered beneath the occupant at pitched
camera angles. Do not use source-array order as a visibility rule.

Buttons, lowered lifts, and lowered gates are face fixtures rather than full cubes:

- an exposed Orange Button is light orange (`#ffb347`) and occupies a centered
  2x2 region of the 4x4 ASCII face;
- fixtures sharing a voxel remain independent when their orientations identify
  different faces; render each only when its mounted face is visible;
- a full occupant in the fixture's logical voxel hides every fixture there;
- a lowered lift renders on its mounted top or side face, while a raised lift
  remains a full cube; and
- a button can render over a lowered lift on the same face.

Lowered gates render as flat plates on their mounted faces, yield to occupants,
and allow a button on the same face to remain visible. Raised gates render as
full cubes. A top-down gate uses `y` when lowered and `Y` when raised; raised
side faces use `y`. This retains the existing hidden-name glyph mapping.

Objects marked `engineHidden`, hidden Orange Button states, and invisible
Orange Wall volumes never render. When an Orange Wall retracts completely under
a floor surface or into another solid, omit it so the covering surface is
exposed. Coincident visible Orange Wall records resolve deterministically.

Gate and puncher physics are implemented upstream. Gate ASCII rendering now
reflects lowered/raised states. Puncher ASCII face-fixture rules remain pending
at the user's request; do not extend this contract to punchers until requested.

## Shared editor UI

The level editor and test lab share ui/editor-shell.css, ui/editor-controls.css,
and the camera-button definitions in ui/editor-camera-pad.mjs. Update those
shared sources for common editor appearance; keep test timeline, metadata, and
project-format behavior in apps/web. The full rotated test suite runs in one
worker using the same runner as individual tests; terminate it on project revision
changes and discard stale results. Release its WASM memory after each run. Toolbox thumbnails use each editor's
scene adapter, with one renderer per batch rather than per tile. The lab keeps
that renderer between palette variants and caches cropped thumbnails in memory;
camera and tool changes must not reapply unchanged room geometry. Project
decode/encode runs in the lab's project-codec worker, with only changed tests
sent after the initial save. Preserve snapshot ordering, revision checks,
superseded-save cancellation, and the existing compact file format.

## 3D room context

The canonical cube/slope geometry, mounted-number visibility, and camera-depth
kernel is apps/web/public/mazebench-runtime/joined-voxel-surface.mjs in this
repository. ui/joined-voxel-surface.mjs re-exports those very same functions.
Both browser renderers use this implementation, with format-specific scene
adapters and camera controls. npm run test:parity checks module identity and
live engine adapter equivalence. No renderer file copying is necessary.
Ground floor slabs meet elevation zero, where walls, slopes and actors rest;
never recess the surface and expose a strip of the supporting tile beneath them.
The live ui/voxel-scene.mjs adapter keeps floor geometry, picking, grids, and
animated contact outlines aligned without changing the signed scene adapter.

Keep the shared distance-aware perspective near plane in both browser renderers.
A fixed tiny near plane makes lowered gates/lifts fight their supporting surface
at world-map zoom. Close editor views retain their original near clipping plane;
update distant depth precision after camera positioning, including cached scenes.

Browser 3D views share `ui/joined-maze-renderer.mjs`: matching cube/slope
families form connected surfaces with internal faces and coplanar seams removed.
Keep material and numbered-body boundaries separate. Human full-world brightness
is sampled in world space, independently of edge materials and geometry. The world
map's browser entry point is `ui/world-main.mjs`; historical `render/v1/` modules
remain unchanged for signed benchmark observations.
Flyover uses ui/flyover-renderer.mjs for continuous drag and A/D rotation, with
the same grain overlay and visual-effects stylesheet as Edit and Play. Its free
yaw must not change the cardinal camera used for camera-relative Play moves.
Flyover uses a thin one-pixel outline at the reference room-view distance;
Play and the editor use three pixels there. All outlines scale inversely with
each endpoint's view depth, with subpixel coverage to avoid distant flicker.
Close-up thickness is capped at twice the reference width (six pixels in Play/
Edit, two in Flyover). Wide outlines use antialiased round caps and depth clearance matched to their
world-space radius so close-up faces cannot slice gaps into the strokes. Keep
near-plane trimming valid and retain a single draw per outline mesh. Compute
fragment depth along the projected edge centreline, not the expanded stroke
triangles; their cap extensions otherwise produce sawtooth gaps at grazing angles.

Browser Play and the editor render all 256 rooms, with the active room at full
brightness and the rest dimmed. `ui/world-context-renderer.mjs` caches full
background meshes and rebuilds only the active room during engine frames or
edits. Room brightness uses a shared small GPU texture; transitions must not
rebuild meshes. Active and background outlines use the same black,
depth-scaled outline style, drawn in one pass so the full world
does not need five outline passes. Matching cube/slope borders use the same
shared surface kernel in cached rooms and temporary tween scenes; never reveal
a room perimeter just because a command is animating. Truncate updates shared GPU clipping planes and cached cut surfaces;
height and opacity changes must not rebuild the world. Batch compatible immutable
background surfaces and outlines per room and cull room groups before mesh
traversal. Keep moving gems and camera-facing markers independent; model cross
sections retain their original local geometry and transforms outside the batches. Prepare new cut surfaces
immediately for visible rooms; prepare offscreen rooms in
short idle batches, and finish their caps before a camera move reveals them.
Initial background rooms load in short batches ordered by distance from the
active room; preserve live
picking, transforms, and Truncate settings between batches. Invalidate changed authored room snapshots and their immediate shared-border
neighbors, or replace the cache when new models finish loading. Keep
precise cut geometry, picking, numbered labels, and shadows in the active room.
Play suppresses background players so only the live player appears. Background
rooms never participate in physics; connected-room loading remains lazy. Keep
the camera centered on the active room across transitions, with enough zoom
range to view the entire world. Preserve historical `render/v1/` JavaScript.
Solutions keeps its 3x3 context. Dimmed rooms are not paintable or selectable;
ASCII Mode remains room-local.
Browser startup uses `ui/browser-world.mjs` to preload models before mesh
construction, avoiding a second full rebuild. The map prepares its connected
surfaces in `ui/world-surface-worker.mjs` using the shared geometry kernel and
assembles assets in short batches. Its loading bar accounts for room data,
models, geometry, and the first draw; never complete it after downloads alone.
Mouse-wheel and trackpad scrolling must not zoom any 3D view; zoom remains
available through Q/E and the explicit map zoom buttons.

## Scope and Git safety

When asked to update the engine, build and verify the canonical engine here
and rebuild its project-owned accelerators. Do not commit, push, migrate signed
runs, or edit the retired sibling checkout unless the user requests it.

## Benchmark checkpoint storage

New and migrated benchmark runs use authenticated incremental checkpoints.
`game-state.json`, `summary.json`, and `display.json` may be format markers.
Read them with `readCheckpointJson` from `benchmarking/v1/checkpoint-json.mjs`,
not raw `JSON.parse(readFile(...))`. The atomic signed checkpoint and its journal
are authoritative; keep complete journal generations with any copied run.

Before a bulk rollback or engine/level repair, follow
`benchmarking/storage/README.md`. Historical one-off repair scripts predate this
format and must be adapted before use on migrated runs. Do not overwrite marker
files or authorize unrelated asset changes while resealing a run. Preserve its
model, tool condition, prompt, conversation identity, and game history.

## Live authored-room updates

New MazeBench ASCII and vision runs use `next-entry-v1`. The editor's validated
PUT route publishes signed per-run room revisions under `world-updates/`.
Unvisited rooms use the latest published revision; previously visited rooms do
so on fresh physical entry or an explicit room command. The active board, reset
state, and undo snapshots retain their original authored version until then.
A room command always creates the room's authored starting board and player
position, including when targeting the current room. Never use a saved physical
entry position as the spawn. Reject rooms without an authored player rather than
inventing a fallback spawn. Reset restores the current visit's entry state, and
undo restores the exact previous board and entry state.

Room files edited outside the editor are not published automatically. Open and
save the room in the editor to publish it. Engine code, block definitions and
world topology remain frozen. Never bypass those checks or expose revision
files, signing keys, or the publishing interface to benchmark agents. Historical
ASCII/vision frames remain immutable. Room edits and the authored revisions used
by actions are audited; moving or removing an existing gem preserves its identity.

Benchmark gem collection is permanent. Fresh room entry, room commands, reset,
and undo must omit gems already in the run's collected-gem ledger, using the
pinned room revision's stable gem identities. Other objects keep the entry/reset
semantics above. Apply this before connected-room physics as well as rendering;
never rewrite historical replay frames to reflect later gem collection.

Existing runs require the exact-hash, paused operator migration in
`scripts/enable-live-world-updates.mjs`. Preserve all preexisting game state and
settings. Do not silently reseal unrelated prior engine or level drift.

## Automatic engine/world versioning

New Main World launches use the versioned owner on port 8090, started with
`npm run start:releases` or by the main server. It creates content-addressed
private runtime/world installations; never edit an installation after a run
has used it. The canonical ASCII source is `render-ascii/v2`, installed under
the old import paths only inside a new private release. Main World benchmark
gameplay comes from `benchmarking/v2/runtime.mjs`, installed in the same way.
Both hash markers enter the release engine inventory. The historical source trees remain unchanged.
Old requests still go to their original owners. Release records live outside
Git, and report/replay readers resolve each run's recorded installation.

The user requested existing worlds stay pinned. `scripts/pin-existing-worlds.mjs`
detaches their editor publication via an appended authenticated world revision,
without rewriting checkpoints or history. Inactive runs keep the last observed
revision; active runs keep the already-published head because an in-flight move
may be using it. Never undo recorded actions to disguise an edit already used.
New release worlds are private snapshots and receive no live editor publication.

The tracked `benchmarking/version-registry.mjs` is append-only. Its `v1.1.N`
labels identify engine/Play-adapter plus world inventories. Never renumber an
existing fingerprint or choose N manually. Use `updateVersionRegistry` from
`benchmarking/version-store.mjs`; it serializes concurrent writers and atomically
merges new identities. The historical catalogue uses this same writer.

`benchmarking/current-version.mjs` registers the live Play and frozen benchmark
inventories independently. Site/report-server startup and five-second checks
notice authored-world and adapter edits; editor saves register after publishing.
The physics build registers its completed binary and compiled C++ source hashes.
Unbuilt C++ edits are reported as pending, never claimed as active physics.
Identical rebuilds and reverting to known content reuse the existing number.
UI, harness, model, effort, and speed edits do not create engine/world versions.

DeepSeek model selectors and run labels must show the exact provider model slug,
not just Flash or Pro. The selector may also show the catalog's display name.
Preserve the selected slug in signed run records; never infer a versioned ID
from an alias or display name.

The main and Benchmark header badges use `/api/versions/current` and refresh
without reloading. Both display the AI benchmark engine/world version, not the
manual Play version. The main page shows Main World; the Benchmark page follows
the selected world. Run labels resolve recorded manifests and observed room revisions;
never relabel a paused run from the current authored world or modify/reseal a run
just to update its label. Commit the run-free registry with engine/world changes.
