# MazeBench vision mode

Open `/benchmarking/v1/?mode=vision` and select **Vision · 3D images**.
The main world supports Codex and Claude Code with Python off or on, including
paired launches. Vision is separate from the ASCII condition.

Keep the ordinary server running on port 8080, then start:

```sh
node benchmarking/vision/server.mjs
```

The companion listens on localhost port 8082. It owns vision runs in
`~/records/mazebench-vision` and forwards existing ASCII run operations to the
ordinary server. This allows vision to be added without restarting active
ASCII runners. Launch fails if the companion is unavailable.

Each observation contains status text and a native MCP PNG image, rendered at
1024 × 1024 by the existing Three.js renderer from the canonical engine state.
Only the current room is rendered. Camera and game actions retain the usual
semantics. The launcher preview takes no benchmark actions.

Move history stores the actual engine tick frames, including room crossings.
`maze_observe` reads a move's `animation.index_record` and the PNG paths it lists.
PNGs are rendered on demand from authenticated, private frame snapshots, so
agents can inspect the animation without receiving its object data or ASCII.

The prompt is [EVAL-PROMPT.md](./EVAL-PROMPT.md). The usual tool restrictions,
optional isolated Python workspace, checkpoint verification, provider checks,
and executable hashes also apply. Vision additionally freezes its renderer,
3D assets, prompt, and observation mode. Image responses intentionally omit
`structuredContent`: Codex otherwise prioritizes that field and drops the PNG.

Rendering requires Playwright and Chrome. The local defaults use the bundled
Codex Playwright runtime and `/Applications/Google Chrome.app`. Override with
`MAZEBENCH_PLAYWRIGHT_MODULE` and `MAZEBENCH_CHROME_BIN` if needed.

Run `node --test tests/vision-*.test.mjs` for native MCP/history and real CLI
transport checks. Transport fixtures use local mock model endpoints; they do
not send paid inference requests.
