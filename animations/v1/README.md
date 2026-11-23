# Human motion

`animations/v1` is the shared presentation layer for human 3D Play. It does not
simulate moves or change saved, benchmark, or undo states.

- `timeline.mjs` compiles exact engine ticks into independent actor, mechanism,
  disappearance, and room-camera tracks. One-cell segments use quadratic
  ease-in/out; consecutive collinear segments of two or more cells use linear
  motion. Turns and pauses retain their timing. Identical empty ticks are skipped.
- `scene.mjs` reuses the canonical cube/slope and special-piece builders, joins
  bodies that move together, and builds temporary geometry once per command.
  Temporary terrain uses the same room-border edge joins as settled terrain.
  Display frames update transforms and mechanism vertex buffers, including
  punchers, top/side lifts, gates, and moving orange walls. Truncate uses GPU
  clipping during movement; the settled renderer restores its precise cut faces.
- `player.mjs` runs the timeline on a cancellable display-clock loop.
- `gems.mjs` slowly spins gems once per 12 seconds and bobs them by 0.06 tiles
  over a 3.2-second cycle. Active rooms, cached rooms, and command scenes share
  the same clock; only gem transforms change. Motion follows the Tweens toggle
  and reduced-motion preference and stops drawing while ASCII or the tab is hidden.

`PlayWorldRenderer.animateCommand` opts in from `ui/play-main.mjs` only. The
connected adapter's optional `presentation` trace retains stable source indices
across room projection and object removal, without adding IDs to engine objects.
The default-on Playback settings toggle uses 100 ms single steps, 40 ms per
sliding tile, and 250 ms camera/room-brightness transitions. Rapid crossings
retarget from the current camera and lighting values. Turning the toggle off
finishes immediately. Reduced-motion preferences skip tweens. ASCII keeps discrete ticks. Camera/zoom controls remain independent.
Undo, reset, or opening a room aborts the current animation synchronously.

Benchmark observations, signed v1 runtimes, and headless simulation do not use
this layer. A visual frame is never an authoritative state.

Run `node --test tests/human-animations.test.mjs` for timelines, cancellation,
geometry, and real-engine room-crossing coverage.
