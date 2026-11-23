# Solutions

Open [Solutions](http://localhost:8080/solutions/v1/) from the main navigation.
Start the site with `node server.mjs` from the repository root if needed.

- A new solution opens the starting-room picker automatically. Choose H×I or
  another room's authored player position. Picking a room with saved progress
  resumes that room's local solution. Reloading an existing solution opens the
  last selected starting room without showing the picker again. Move
  with the arrow keys or the movement pad. A solution started outside H×I
  proves reachability from its chosen room, not from the usual game start.
- The starting-room picker shows the world grid, a room-layout preview, player
  start and gem count. Search by coordinates such as `HxI`, use the game-start
  or current-room shortcuts, or filter to saved solutions. Saved run and move
  counts appear before opening a room; browsing the picker does not replay them.
- **Undo** (Z or ⌘/Ctrl+Z) removes one move, including moves in generated
  routes and room crossings. It restores the exact board and gem ledger and
  works after reload. It deletes the last command from the active draft or
  newest saved route, along with any checkpoint/proof created only by that
  command. Undo never adds a move or a separate saved route. Existing older
  branches remain intact; resuming one starts a new editing session.
- **Remove solution & restart** in the top row asks for confirmation, then
  immediately stops ongoing verification, removes the entire solution for the
  selected starting room, and reopens the starting-room picker. It remains
  available while saved routes are being verified. Cancel keeps the solution.
  Solutions belonging to other starting rooms stay saved.
- **Find next gem** combines native room A* with connected-room route search.
- Tap a tile in the 3D view to immediately run A*, follow the route, and save
  its moves. Dragging still controls the camera. **Adjust target** lets you
  refine X/Y/height and search again; an empty height accepts any height.
- **Search time** beside the search buttons defaults to one minute, with
  options for 30 minutes, one hour, and **No time limit** for harder puzzles.
  The live status separates board states from attempted command simulations
  and reports both rates. Cancel stops the search without changing your moves.
  A time or memory limit is not an unreachable result; the native solver can
  still exhaust available memory even when there is no time limit.
- Green on the map means **visited**: a move must finish in that room.
  Sliding or being punched through a room does not visit it or unlock its
  starting position. Unvisited rooms cannot be selected.
  Gold diamonds mark remaining gems; white dots mark collected gems. A room
  with both has some gems left. Hover for exact counts or select a visited
  room to see its collected/remaining total.
- **Spawn points** contains authored room starts and automatic room entrances
  only. Visit a room to unlock its start. Selecting either type restores the
  original blocks and mechanisms, places the player at that spawn, and keeps
  all gems collected across the collection removed.
- Routes save automatically upon reaching a gem or crossing a room boundary.
  A* also saves completed routes. These run endpoints are not spawn points.
  There is no manual Save spot action. View/copy moves or replay a run from
  **Saved runs**.
- **Setup** beside a saved spawn shows the sequence that recreates it. A setup
  starts at the game start or an authored room start, then stacks the move
  sequences of the preceding spawns. It never teleports to arbitrary coordinates.
- **Full solution** combines the runs into one replayed command sequence from
  the chosen starting room. Its only commands are `up`, `down`, `left`, `right`, and `room HxI`
  (substituting the destination label). A room command requires an earlier
  physical visit and uses the authored player start, matching the benchmark.
  Branch changes expand their spawn setup after a room command when needed.
  Gems remain collected across the entire assembled solution. Runs whose
  starting rooms have not been discovered wait until discovery; any runs that
  still cannot be included are listed separately, not reported as solved.
- **Import JSON** reads the file's starting room and opens that room's solution
  automatically, even when another starting room has saved runs. If the target
  room already has saved moves, review the replacement prompt before importing.
  Older files without a starting-room field use H×I. If rooms were edited or the engine was
  updated, choose **Import and recheck** to check compatibility by replaying
  the moves with the current engine and rooms. Entrances must still reach
  their saved positions. Gem IDs and
  progress are rebuilt from that replay. A failed replay leaves the current
  solution unchanged. A different engine version is allowed when the replay
  succeeds. The imported collection saves automatically under the current
  world and future exports record the current engine; the original file
  and saves belonging to older worlds remain intact.
- Progress is stored per starting room in this browser using IndexedDB; the
  existing H×I storage key remains compatible. **Export routes** names the JSON
  after its starting room and saves the
  the run collection, spawn setups, existing reachability witnesses, and a
  replay-validated `fullSolution` with commands and reached rooms/gems.
  `fullSolution.complete` means all saved runs were included, not that every
  room or gem in the world has been solved. Existing v1 saves load normally;
  setup dependencies are reconstructed from their verified move sequences.

## Verification and search

Search and replay run in a worker. The canonical engine and
`ConnectedWorldSessionV1` decide every move, including slopes, Ice, punchers,
room-local orange circuits, and reset-on-entry room geometry. Collected gems
stay removed when selecting starts or entrances and when re-entering rooms.
Recorded runs retain their exact source state/reset mode and gem ledger for
replay, reload, and undo. The internal run endpoints used to join move sequences
are never offered as selectable spawns.

A crossing records its entrance coordinate and its settled player position.
Spawn selection resets the authored room at that settled position; intermediate
rooms passed through during one continuous slide or punch stay unvisited and
locked. Only the room where the command finishes gets an entrance and an
unlocked authored start. Full solution always replays and checks entrance setups;
a setup that cannot reproduce the reset board is reported as blocked.
Rooms without an authored player have no fabricated default start.

A* uses the editor's compact native command-state search for all three target
types: gems, clicked coordinates (with optional height), and room boundaries.
The board is uploaded once per room search; candidate expansion does not copy
room objects or construct JavaScript animation frames. Only proposed routes
are replayed with connected physics. Boundary candidates resume the same
native frontier after blocked exits, preserving alternative board states.
Room jobs are keyed by exact entrance state and gem ledger. A bounded
connected-state fallback handles unsupported rooms and unusual seams.

A* uses a weighted Manhattan priority, so routes are not certified shortest.
A budget limit is reported separately from exhausting a search. Native room
solver proposals are replayed with connected-room physics before acceptance.
Stored routes are also replayed on load; stored verification flags are never
trusted. A world/engine fingerprint keeps different world revisions separate.

Build the separate Solutions accelerator with
`sh scripts/build-editor-solver-v1.sh solutions`. Engine sync rebuilds it too.
This reuses the editor search source; it does not alter the canonical WASM or
the editor's compiled solver. A native room search retains its frontier for
the selected time instead of abandoning it after two seconds. It uses the
editor's growing compact-state storage up to the native memory limit, with
no fixed 500,000-state cutoff. The connected-physics fallback retains its
smaller JavaScript state budget and at most one second of reserved time.

Run focused checks with:

```sh
node --test tests/solutions-v1.test.mjs tests/connected-world-slopes.test.mjs tests/room-context.test.mjs tests/engine-v1.test.mjs
```
