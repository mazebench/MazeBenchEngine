# Browser ASCII projection v2

Play uses this projection to retain empty room cells at every camera angle.
Angled views include the whole projected ground footprint, and every view
retains the full room width. Only off-room vertical padding is trimmed.

The scene compositor is forked from v1 because saved benchmark manifests pin
the v1 module bytes and observation layout. V2 has its own glyph contract:
top faces use the room's dynamic catalogue, every tree variant has a reserved
pair, and missing allocations fail instead of emitting shared fallback symbols.
Greek and Latin lookalikes remain distinct Unicode characters. Exit's E/e stay
reserved even though Exit is retired from the Object Lab picker.

New main-world benchmarks run from content-addressed private installations made
by `benchmarking/runtime-release-store.mjs`. The release installs this renderer
under the frozen runtime's expected import path and binds its hashes into the
engine inventory. Existing signed source directories are never overwritten.
Each run resumes through its recorded installation, and world edits apply to
new installations. The Object Lab uses the same V2 symbols directly.

Run `node --test tests/ascii-room-bounds.test.mjs` for the G×E regression,
rectangular rooms, empty rooms, negative heights, and seeded views.
