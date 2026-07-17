# Feature spec: device attachments on movable carriers + colored ice slopes + Box N / Clone N (2026-07-16, owner request)

## Owner's words, decomposed

1. Lift (lowered/raised), orange button, player gate, and puncher "attached on top of" a
   weightless box tile / clone / orange wall move WITH the carrier.
   (Owner notes the puncher-on-lowering-orange-wall case "would be weird" — see Status.)
2. Colored ice slopes as NEW terrain types (owner explicitly retracted merge/tint-on-stack):
   - 5 blue slopes matching the 5 weightless box colors (and by extension box id N),
   - 3 yellow slopes matching the 3 clone colors,
   - 1 ORANGE slope that raises and lowers (orange-wall behavior tied to buttons),
   - 1 BLACK slope styled like the wall (`#`) decoration.
   Mechanically identical to ice_slope (except orange raises/lowers); visual variants only.
3. Toolbox: "Box N" button that prompts for an arbitrary numeric id (token M<N>); same
   "Clone N" (c<N>). Blue and yellow slope entries also prompt for the id instead of taking
   up 5/3 slots each. KEEP the existing Box 0-4 and Clone 0-2 buttons unchanged.

## Status of part 1 (attachment rides) — mostly landed already by the rewrite

| Attachment | on weightless box | on clone | on orange wall |
|---|---|---|---|
| orange button | RIDES (legacy attachment sync) | RIDES (rewrite fix, canActorCarrySurfaceAttachment) | RIDES vertically (rewrite RIDES_DEVICE sync; walls never move horizontally) |
| puncher | RIDES (legacy sticky-carrier) | **TODO this round: extend sticky-carrier to clone groups** | RIDES vertically (rewrite RIDES_DEVICE sync) — incl. the owner's "weird" case: wall lowers, puncher descends with it and fires at ground level; documented behavior |
| lift | **Phase 2 (attached_lift actor)** | Phase 2 | Phase 2 |
| player gate | **Phase 2 (attached_gate actor)** | Phase 2 | Phase 2 |

Phase 2 design sketch (deliberately deferred — new actor archetype):
- Author stack "carrier + l/L/g" converts at parse/build time into an ATTACHMENT ACTOR
  (attached_lift / attached_gate) resting on the carrier top; plain terrain placement is
  unchanged.
- attached_lift: NON_BLOCKING flush-support actor (registry gains surfaceDelta prop: its
  standing surface is AT its elevation, not elevation+1). Raised state is encoded purely in
  elevation (+1 vs its carrier-top base). Player move ending on its surface toggles it
  (elevation ±1) and rides — mirrors the terrain lift branch in the travel loop.
- attached_gate: same flush model; raised = +1 elevation driven by the per-move proximity
  set. Blocking-when-raised needs occupancy participation keyed to raised state — the open
  design question; candidate: raised gate contributes an occupancy entry at (cell, base).
- Both ride carriers through the existing surface-attachment sync + device-surface sync.
- Renderer: actor-type → lift/gate models (same assets as terrain versions).

## Part 2 design — colored slopes

Tokens (level_parsing.json gains pattern support):
- Arbitrary boxes/clones: `M<digits>` / `c<digits>` (M0-M4, c0-c2 keep their explicit
  toolbox buttons; parsing accepts any N; groupId = the token, color = palette[N % family]).
- Blue slopes:  `S<r|l|u|d>M<digits>`  → type ice_slope, direction from 2nd char,
  styleKey "M<digits>" (renderer tints slope with the box-N color).
- Yellow slopes: `S<r|l|u|d>c<digits>` → styleKey "c<digits>".
- Black slope:  `S<r|l|u|d>#`          → styleKey "wall".
- Orange slope: `S<r|l|u|d>O`          → NEW terrain type orange_ice_slope, styleKey "orange".

orange_ice_slope engine semantics (buttons pressed = global AND, same clock as orange walls):
- buttons UNPRESSED (walls raised): behaves exactly like orange wall — blocks its layer
  elevation, surface at elevation+1, NO slope traversal.
- buttons PRESSED (walls lowered): behaves exactly like ice_slope (traversal both ways,
  blocks elevation..elevation+1, surface elevation+1).
- Participates in slopeCellMask (it can be a slope sometimes) and in the orange capability
  gate for the R1 device clock. Search == play (same snapshot rules).

styleKey plumbing: parsing/build attaches `styleKey` to the terrain layer object; engine
ignores it (except orange_ice_slope type); play data carries layers through untouched;
renderer picks material tint by styleKey using the SAME palette function as box/clone
group colors (single source of truth).

## Part 3 design — toolbox prompts

- toolbox.json gains entries: "Box N", "Clone N", "Blue Ice Slope N", "Yellow Ice Slope N"
  (plus plain "Orange Ice Slope", "Black Ice Slope"). Prompt-style entries carry a
  `promptForId` marker; author.js asks for the number (numeric input, default 5 for boxes /
  3 for clones — the next free family id) and forms the concrete token before placement.
- Editor palette accepts pattern tokens so painted cells with M7/c5/SrM7 round-trip through
  author-play-data buildPlayData.

## Verification plan
- Engine tests: orange_ice_slope traversal in both button states (walk + push + search
  parity); arbitrary-id boxes push/merge like M0-M4; puncher rides a clone.
- author-play-data test: pattern tokens build correct actors/layers with styleKey.
- Toolbox catalog test additions per its schema; author interactions unaffected.
- Browser: paint M7 + SrM7, play, verify tint match and slope behavior; orange slope
  toggles with a button.


## Status (2026-07-16, end of round)
LANDED (full suite green, runtime mirror synced, editor + engine browser-verified):
- Puncher rides: side-mounted on clones + standing on any carrier top (buttons already rode).
- orange_ice_slope: engine (raised=orange-wall block / pressed=ice slope; R1 clock; search
  parity; undo exact), parsing tokens S{r,l,u,d}O, renderer (orange tint, slope model,
  transition-twin math), toolbox entry + demo.
- Colored slopes: S<d>M<N> / S<d>c<N> / S<d># with styleKey through server + client +
  renderer. COLOR RULE (owner, final): family-flat colors — every box slope is the box blue
  #315991, every clone slope the clone yellow #b59a2a, black = wall color, orange = orange
  wall color. No per-id shades anywhere; ids differentiate via editor number labels only.
- Open-ended ids: M<N>/c<N> resolve across editor save, adapter, engine, solver via
  public/maze-token-patterns.js (UMD; served via PUBLIC_FILE_ROUTES; mirrored).
- Toolbox: Box N / Clone N / Blue Ice Slope N / Yellow Ice Slope N prompt entries with a
  numeric modal (window.prompt fallback); slope families collapse to one button each;
  Box 0-4 / Clone 0-2 untouched.
DEFERRED (designed above): attached_lift / attached_gate riding on movable carriers.

## Status (2026-07-17, attachment fix round after owner playtest)
Owner reported three failures; all diagnosed and fixed:
1. "Painted lifts/gates look weird" — the improvised slab/panel actor meshes were
   replaced with the terrain twins' construction: full-tile device plate
   (playerLiftPlateThickness/Offset) + the lift arrow marker via
   addPlayerLiftTriangle; a raised 'L' keeps the full raised block (actor.raised
   now flows server + adapter -> play-core cloneActorState -> renderer).
2. "In play they still interact with the carrier" — root cause was primarily a
   STALE SERVER PROCESS: node caches server modules at startup, so a server
   started before the buildCellStack conversion kept serving terrain
   lifts/gates. The conversion itself was correct in both builders. Verified in
   live play (draft level_AxA): lift/gate ride pushed M1 train, raised lift
   rides the M4 blob, zero liftToggles, no gating.
3. "Orange button doesn't lower with its wall" — REAL engine gap: the dynamic
   device-ride sync (syncDynamicActorElevationsAndFalls) changed fixture
   elevations journal-only; play mode replays MOVE RECORDS onto runtime actors,
   so riders visually stayed put. Fixed with an end-of-sync net-elevation diff
   pass that emits/merges records via ensureDynamicMove (no-op-safe: only real
   net changes, so `moved` and search parity are untouched). Regression test at
   the tail of tests/maze-engine.test.js (ride records both directions).
Debug affordance: play-core exposes window.__MAZEBENCH_APP__ for headless
runtime-state inspection.
NOTE for the owner: restart any long-running `node server.js` after pulling
these changes — server-side parse code is loaded once at process start.

## Status (2026-07-17, functional round — owner: "they do nothing" + clone slopes)
Attached devices are now WORKING devices (that still ride their carriers and
still ignore the carrier itself):
- attached_lift: raised bit lives in the journaled per-cell liftRaised buffer
  (actor elevation ALWAYS = carrier top, so every ride sync is untouched;
  hash/undo/search come free). Surface = elevation + bit (flush rule).
  A player ending a move on the surface toggles it and rides (travel-loop +
  punched-endpoint twins of the terrain branches; toggle applied at the same
  R1 point; riders carried with records; liftToggles output shared, so play
  animates and updates actor.raised via play-core setPlayerLiftRaised).
  Raised lift blocks the band it rose out of (attachedDeviceBlocksElevation
  inside terrainBlocksElevation) and supports standing at its surface (scan
  support fns only — NOT buildActorSupportTopGrid: sharing the box-top slot
  there corrupted push-cluster ownership and broke carrier pushes).
  Raised bit rides horizontal pushes (bit relocates cell→cell unless the
  source cell owns a terrain lift). 'L' authors raised (bit seeded at load).
- attached_gate: raised state DERIVED per move from the terrain-gate
  proximity rule (players incl. clones within manhattan 1, not standing on
  it, same-level-block exception) — engine computeRaisedPlayerGateSet and the
  play-core twin both add attached-gate cells to the shared raised set;
  raised gate blocks its band; renderer draws the full block when
  app.liveRaisedPlayerGates has the cell.
- Parity notes: players cannot walk off a raised lift surface (terrain lifts
  refuse the same drop); clones do not toggle lifts (clones bypass the travel
  endpoint — same as terrain); standing ON a raised attached gate is not
  supported (terrain gates allow it; documented gap).
Clone slope traversal (owner: "clones slide up ice slopes of any type"):
- Terrain slopes (plain/black/orange-pressed) already worked; the gap was
  slope-shaped ACTORS. Cluster machinery now treats a slope actor at a step
  target as a slope when it is NOT part of the moving cluster
  (foreignSlopeActorAtCell): gates extended in collectWeightlessPushCluster
  (interior fast path, targetHasSlope, transit start), weightlessClusterStep,
  and weightlessClusterBlockedSlopeBounceOffsets. Own wedges still ride with
  their group. Clones (and pushed box groups) climb foreign box/clone wedges
  uphill and descend them downhill; verified live.
Regression tests: maze-engine.test.js tail (lift cycle, authored 'L', raised
block, bit rides pushes, gate blocks, clone climbs box/clone wedges); the old
"walks through attached gate" pin was rewritten for the new semantics.
