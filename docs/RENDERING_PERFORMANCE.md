# Editor and preview rendering

The suite keeps one WebGL renderer alive while processing visible cards, frame
changes and WASD camera updates. An idle queue retains its last job so the
renderer is not repeatedly destroyed. Camera generations reject outdated
results; effect cleanup cancels pending renders and model-loading completions.
Images remain visible until their replacements arrive.

Scene preparation now indexes voxels into XY columns once, preserving stable
height ordering and overlapping objects. React memoizes the converted scene;
camera-only changes reuse geometry. Pointer hover picking and drag orbit updates
are coalesced to display frames. Resizing no longer invalidates scene geometry.

Rendering uses the displayed viewport dimensions, instead of allocating 64
render pixels per room tile. Suite captures use a 256 × 204 viewport and retain
its aspect ratio. The editor fits its available canvas and has a dedicated
palette area, unobstructed camera controls, a frame menu and Test/Tool inspectors.
Tool icons and their 45 px slots with 6 px gaps are preserved.

## Verification

- 171 app tests pass, including overlap/order parity, bounded coordinate reads,
  stale preview generations, and retention of the idle renderer job.
- Production build, lint and typecheck pass.
- Browser checks: Start/Expected, inspector tabs, zoom, rotation, rapid WASD
  preview changes, scene switching and the existing test runner.
- Browser diagnostics expose `data-renderer-session` and the last scene render's
  CPU duration on the canvas. Multiple completed preview jobs and camera
  generations retain the same session. This is not a GPU frame-time measurement.
- A local synthetic 64 × 64 scene with 12,288 voxels took a median 90.01 ms for
  the previous per-cell filtering, versus 0.52 ms for indexed columns (seven
  warm runs). This measures column preparation only, not whole-page speed.

No engine behavior, authored test geometry or saved expected frames changed.
