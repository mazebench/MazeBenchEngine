# Prime Verifiers Integration Notes

## What Prime Expects

Prime Intellect Verifiers environments are installable Python packages. Each environment package needs a `pyproject.toml`, a README, and an importable `load_environment()` function that returns a Verifiers environment.

The repo-level `uv add verifiers && prime lab setup --skip-install` command failed because `uv add` only works inside a Python project. For a repo without `pyproject.toml`, use either:

```bash
prime lab setup
```

or the explicit two-step version:

```bash
uv init
uv add verifiers
prime lab setup --skip-install
```

In this repo, `prime lab setup` successfully initialized the Python project and installed `verifiers`, then hit a Prime-side 404 while downloading some starter config files. The important local pieces are now present: `pyproject.toml`, `uv.lock`, `.venv`, `.prime/skills`, `configs/endpoints.toml`, and `environments/mazebench`.

## Current Project Shape

The web game is Node/browser-first. The canonical rules surface appears to be:

- `public/maze-engine.js`: movement, collision, solved-state, elevation, push, ice, holes, gates, lifts.
- `public/maze-solver.js`: A* solver over the JS engine.
- `server/maze-levels.js`: converts text level files and parser metadata into browser play data.
- `games/maze/levels/*.txt`: current level corpus.
- `games/maze/level_parsing.json` and `games/maze/world_parsing.json`: token and world-size metadata.

The Python `games/maze/player.py` implementation is useful but currently behind the web engine: it does not model every newer browser token/type. Treat the JS engine as canonical until a shared runtime is extracted.

## Recommended Benchmark Architecture

1. Extract a shared maze core contract:
   - Level spec: text grid plus parser metadata.
   - State spec: terrain layers, actors, elevation, collected gems, level/world position.
   - Action spec: screen-relative `up`, `down`, `left`, `right` movement plus camera, undo, and reset tools.
   - Observation spec: ASCII renderer first, image renderer later.

2. Build `mazebench` in stages:
   - `mazebench-ascii-single`: one-shot prompt asks for `<moves>...</moves>`, reward simulates the path. Initial ASCII state comes from the canonical `scripts/maze-bridge.js` observation path.
   - `mazebench-ascii-tools`: stateful/tool environment exposes `move(direction)`, `rotate_camera(direction)`, `undo()`, `reset_level()`, and `goto_level(x, y)`. This is now the default `mazebench` mode, with `level_HxI` as the starter task.
   - `mazebench-open-world`: multi-level/world-map navigation once the open world is converted to ASCII.
   - `mazebench-vlm`: visual observations from the browser/isometric renderer for VLM evaluation.

3. Keep web compatibility by keeping level files and parser metadata as the source of truth. The web renderer can stay JS/Three. With OpenEnv, the verifier can also keep the JS engine as the source of truth by running Node inside the environment process and exposing movement/camera actions as tools. That avoids a Python rules port.

4. Before publishing to the Environments Hub:
   - Ensure `environments/mazebench/pyproject.toml` includes all package files and data.
   - Run `prime env install mazebench`.
   - Run a local smoke eval, for example `prime eval run mazebench -n 1 -r 1 --skip-upload`.
   - Update the package version.
   - Push with `prime env push --path ./environments/mazebench --visibility PUBLIC` or `PRIVATE`.

## Publication Checklist

- `README.md` explains task format, arguments, metrics, and dataset source.
- `load_environment()` is cheap to import and all expensive loading happens lazily.
- Dependencies are listed in `[project.dependencies]`; do not rely on `[tool.uv.sources]` for Hub installs.
- Rewards accept alternate valid paths, not only the solver's reference path.
- Terminal runner and verifier share the same ASCII renderer.
- JS and Python/OpenEnv simulators have parity tests for each token class before large-scale evals.

## OpenEnv Direction

OpenEnv is the preferred path for the full game benchmark because the environment can wrap a process that already knows how to simulate the game. The Prime/Verifiers package can be Python at the boundary while the actual game runtime stays Node.

The likely OpenEnv action/tool surface:

- `move(direction)`: `Up`, `Down`, `Left`, `Right`.
- `rotate_camera(direction)`: `Up`, `Down`, `Left`, `Right`.
- `undo()`: undo the most recent movement action.
- `reset_level()`: reset the current room to its entry state.
- `goto_level(x, y)`: spawn back at a world room that has already been visited during the rollout.
- Later: `list_levels()` and maybe `inspect_tile(x, y)` for tool-using agents.

For the first isometric ASCII pass, each visible tile is a 4x4 character block. Camera pitch has five positions:

```text
top:          4 top rows, 0 side rows
top-diagonal: 3 top rows, 1 side row
diagonal:     2 top rows, 2 side rows
side-diagonal:1 top row,  3 side rows
side:         0 top rows, 4 side rows
```

Objects use explicit `top/side` glyph pairs, so the ASCII renderer can keep
every visible object distinct even when the set is larger than the alphabet.
The repo-local terminal runner and packaged mazebench runtime use the same
glyph contract.
Player lifts use `>` on top when lowered, `L` on top when raised, and `l` on
their sides. Orange walls use `O` on top and `o` on their sides, where `o` is a
face character rather than a lowered-state sprite. Orange buttons are top-only
surface attachments rendered as `8`, with no side face. Pressing a button moves
the wall geometry down one elevation, with only the top face remaining visible
when the lowered volume overlaps supporting terrain.
For example, floor uses `A/a` and renders from top-down through side view as:

```text
AAAA
AAAA
AAAA
AAAA

AAAA
AAAA
AAAA
aaaa

AAAA
AAAA
aaaa
aaaa

AAAA
aaaa
aaaa
aaaa

aaaa
aaaa
aaaa
aaaa
```

The terminal prototype at `scripts/maze-terminal.js` is a local testbed for rendering and one-shot replay. Its `--json` output uses the same structured, model-facing observation contract as agent runners; `--solve` can explicitly add a JS solver reference. Initial ASCII state and the stateful Verifiers tool contract are backed by `scripts/maze-bridge.js`, a JSON-lines Node process that keeps room state, camera state, visited rooms, and monotonic unique gem IDs alive for the rollout.

## Sources

- Prime Verifiers README: https://github.com/PrimeIntellect-ai/verifiers
- Verifiers environments guide: https://docs.primeintellect.ai/verifiers/environments
- BYO Harness guide: https://docs.primeintellect.ai/verifiers/byo-harness
- Environments Hub create/upload guide: https://docs.primeintellect.ai/tutorials-environments/create
- Evaluation guide: https://docs.primeintellect.ai/tutorials-environments/evaluating
