#!/usr/bin/env node

// Provider-neutral entrypoint for the MazeBench shell contract. Keep the
// legacy filename as the implementation so existing local run artifacts and
// tests remain replayable while new Prime harnesses use this stable name.
require("./codex-play.js");
