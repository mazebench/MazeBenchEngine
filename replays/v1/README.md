# Replays

Open `/replays/v1/` from the home navigation. Import a `.txt` or `.json` file,
drop one onto the page, or paste commands. Plain sequences default to H×I;
the start-room field changes that default. A declared file start takes priority.

Text accepts compact `UDLR`, direction names, whitespace/commas/semicolons,
`room LxO`, and an optional `Start room: HxI` header. JSON accepts the canonical
`mazebench-full-solution-v1` command list, `fullSolution` within a Solutions
export, and verbose `commands`/`actions` records with directions or room targets.
Route-only `mazebench-solutions-v1` exports are verified and compiled using the
existing Solutions importer. Partial solutions are identified in the UI.

The worker compiles current physics once, with connected-room behavior and a
permanent gem ledger. It stores shared stationary layouts and small per-command
motion curves rather than every engine frame. The viewer samples the same
`animations/v1` curves as Play, including slides, mechanisms, fades, resets on
leaving a room, and camera/room lighting. Seeking does not rerun the engine.
Imports do not write to Solutions storage or change authored rooms.
The top-row 3D / ASCII switch keeps the current time and playback state. ASCII
uses the canonical browser glyphs and exact physics ticks on the same timeline,
including room crossings and mechanisms. WASD rotates/tilts the text view;
Q/E and the zoom buttons resize it explicitly. Camera rotation never changes
the character size. The 3D orbit is preserved when switching back.
During import, a live minutes:seconds estimate tracks the current step using its
observed throughput. It recalculates between loading, route verification,
replay preparation and drawing, and stays cancellable throughout.

Space or K plays/pauses. Left/right or J/L seeks five seconds; hold Shift for
100 ms. Comma/period steps between actions. The focused timeline's native arrow
keys seek one millisecond. Home/End jumps to either end. Drag to orbit; WASD turns
the camera, Q/E zooms, and slash recenters. Pausing and seeking preserve camera
adjustments. Speed controls and fullscreen are available below the timeline.

The folded Truncate panel in the top-right corner shares Play's layer height,
player-follow and upper-layer visibility controls (0% by default). Timeline
markers default to None. Choose Gems or New rooms to show clickable timestamp ticks. Gem ticks
match the collection tween; room ticks mark first settled visits, including the
starting room at zero. Passing through a room during a slide does not count as
a visit. Closely spaced ticks open a short timestamp list so each remains
selectable. Jumping to a marker pauses the movie and preserves camera settings.

Run `node --test tests/replays.test.mjs` plus the repository application checks.
