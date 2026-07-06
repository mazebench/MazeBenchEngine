# MazeBench

The MazeBench env can run in the browser, in the terminal, driven by a local
coding agent (Codex CLI or Claude Code), and through Prime Intellect Verifiers
v1. The Verifiers integration includes both normal multi-turn chat-model runs
and Codex CLI runs.

## The `mazebench` command

There is a small `mazebench` CLI that wraps every workflow. It is a launcher:
it shells out to the repo's Node scripts (game engine, local-agent runner,
replay/video) and, for the Prime path, to the `prime`/`uv` CLIs. Node.js is a
prerequisite for all runs.

Install it from a checkout (recommended — the CLI needs the repo's Node
scripts at runtime):

```bash
# with uv (this repo already uses a uv-managed .venv)
uv pip install -e .

# or with plain pip
pip install -e .

# add the Prime Intellect Verifiers integration
uv pip install -e ".[prime]"
```

Local agent runs execute **inside a container by default** so the agent is
isolated from your filesystem. Build the image once (needs Docker):

```bash
mazebench build          # or: npm run maze:build-image  /  docker build -t mazebench-agent .
```

Then, without Prime, drive the maze with your own local agent and get a replay
video out the other end (credentials are read from `OPENAI_API_KEY` /
`ANTHROPIC_API_KEY` in your environment):

```bash
mazebench model=codex moves=10
mazebench model=claude moves=10 level=HxI
```

See [Run with a local coding agent](#run-with-a-local-coding-agent-no-prime)
for details, and [docs/packaging.md](docs/packaging.md) for publishing to PyPI.

## Run with a local coding agent (no Prime)

This path uses **your** Codex or Claude Code auth. There is no Prime intercept
server and no reward scoring — the agent just plays the game by shelling out to
`scripts/codex-play.js` (a stateful CLI over `scripts/maze-bridge.js`), and the
runner then renders a replay video from the session.

Prefer not to remember the flags? Run the **interactive setup** and pick each
option with the arrow keys:

```bash
mazebench wizard            # or: npm run maze:wizard
```

The wizard's "Custom…" model choice lists your actual Codex models (read from
`~/.codex/models_cache.json`), then — for Codex — lets you pick the reasoning
effort (`low`/`medium`/`high`/`xhigh`) and toggle Fast mode. You can also set
these directly:

```bash
mazebench model=codex model_name=gpt-5.5 reasoning=xhigh codex_fast=true moves=10
mazebench model=claude model_name=opus moves=10
```

`model_name` is forwarded to `codex -m` / `claude --model`; `reasoning` maps to
`codex -c model_reasoning_effort` and `codex_fast=true` to the `priority`
service tier.

One-liners:

```bash
# via the mazebench CLI
mazebench model=codex moves=10
mazebench model=claude moves=10

# equivalently, via npm
npm run maze:codex-local -- moves=10
npm run maze:claude-local -- moves=10
```

Common options (all accept `key=value` or `--key value`):

| key | meaning | default |
| --- | --- | --- |
| `model` | `codex` or `claude` | required |
| `container` | `true` (run in Docker, host FS isolated) or `false` (host) | `true` |
| `tools` | `false` (sandboxed to the maze) or `true` (full access) | `false` |
| `mode` | `text` (ASCII board) or `vision` (rendered PNGs) | `text` |
| `moves` | maze action budget shown to the agent | `20` |
| `level` | world level id, e.g. `HxI` or `level_HxI` | `level_HxI` |
| `view` | `top` … `side` camera pitch | `top-diagonal` |
| `yaw` | `0`–`3` camera yaw | `0` |
| `gems` | unique gems required for `game_won` | `100` |
| `vision_width`, `vision_height` | PNG size in vision mode | `512` |
| `model_name` | underlying LLM id (`codex -m` / `claude --model`) | agent default |
| `reasoning` | Codex reasoning effort: `low` / `medium` / `high` / `xhigh` | model default |
| `codex_fast` | Codex Fast mode (priority tier, ~1.5× speed) | `false` |
| `video` | `on` / `off` | `on` |
| `fast`, `draft` | faster/cheaper video capture | off |
| `dry_run` | print the agent command + prompt and exit | off |

Use `dry_run=on` to preview exactly what will run (the container/agent command
and the full play prompt) without spending any tokens or needing Docker.

### Isolation: runs happen in a container by default

Every local agent run executes inside a container (`container=true`, the
default), so the agent **cannot touch your filesystem** — only an output
directory is mounted, and API credentials are passed via environment variables.
This is the strong, OS-level guarantee; it does not depend on the agent CLI
behaving.

- One-time build: `mazebench build` (or `npm run maze:build-image`). The image
  bundles Node, the maze runtime, a headless Chromium + ffmpeg (for vision and
  video), and the `codex` / `claude` CLIs. See the [Dockerfile](Dockerfile).
- Credentials (forwarded into the container as env, or mounted):
  - **Codex:** `model=codex` **auto-mounts your Codex subscription login**
    (`~/.codex/auth.json`, read-only) when it exists — no setup needed.
    Otherwise set `OPENAI_API_KEY`, or pass `codex_auth=<path>`.
  - **Claude:** on macOS, `model=claude` **auto-detects your Claude Code
    subscription login from the Keychain** and mounts just that credential (a
    short-lived, read-only temp file, deleted after the run) — no setup needed.
    Otherwise set `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, or pass
    `claude_auth=<path>` to a `.credentials.json`.
  - Only the single credential is exposed — never your whole `~/.codex` or
    `~/.claude` (which hold history, memories and logs).
- What's mounted: only `outputs/maze-local` (writable, for artifacts). Nothing
  else on your disk is visible to the container. The network stays on because
  the agent needs to reach the model API.
- Escape hatch: `container=false` runs on the host instead, protected only by
  the per-CLI `tools` sandbox below (weaker — see the Codex read caveat).
- `docker_bin=podman` and `image=<tag>` override the runtime and image tag.

### Sandboxing (`tools`)

Inside the container (or on the host with `container=false`), `tools` is a
second layer. With `tools=false` (default) the agent is meant to only drive the
maze helper; how strictly that is enforced depends on the agent (below).
`tools=true` removes the guardrails (write files, run any command, use the
network) — inside the container that is still safe for your host.

- **Codex** — On the **host** (`container=false`, `tools=false`), Codex runs under
  `codex exec --sandbox workspace-write`: writes confined to the run folder,
  network disabled by default. Caveat: Codex's OS sandbox does **not restrict
  reads**, so a determined agent could still read files it knows the path to.
  **Inside the container**, Codex's sandbox (bubblewrap) can't create user
  namespaces under Docker, so Codex runs with
  `--dangerously-bypass-approvals-and-sandbox` — the container itself is the
  sandbox. So for Codex-in-container, `tools=false` is a prompt-level instruction
  ("only play the maze"), not an OS guarantee; host isolation comes from the
  container. `tools=true` always uses `--dangerously-bypass-approvals-and-sandbox`.
- **Claude Code** (`tools=false`): runs under `--permission-mode dontAsk` with an
  allowlist of **only** the maze helper command (`Bash(node <helper> *)`), so
  every other tool — Read, Write, WebFetch, other Bash — is auto-denied. Claude
  also blocks command chaining per-subcommand, so the allowlist can't be widened
  with `; other-cmd`. This is a true "maze-only" lockdown at the agent level.
  `tools=true` uses `--permission-mode bypassPermissions`.

Notes:

- In vision mode with `tools=false`, Claude is additionally allowed to read the
  rendered frames (`Read(<run>/frames/**)`) so it can see the maze. Under Codex's
  sandbox the headless-browser render may be blocked; if a frame fails, the
  helper falls back to the ASCII board for that turn (`frame_error`).
- These are the best guardrails each CLI offers; neither replaces running
  untrusted agents in a real VM/container if that is your threat model.

### Text vs vision observations

By default the agent plays from the ASCII board (`mode=text`). In `mode=vision`
the helper renders a perspective PNG of the current room each turn (via the same
`scripts/maze-render-frame.js` renderer the Verifiers vision taskset uses),
drops the ASCII board, and prints a `frame_image` path in the JSON. The agent —
Codex CLI and Claude Code are both multimodal — opens that PNG to decide its
move. Frames are saved under `<run>/frames/`.

```bash
mazebench model=codex moves=10 mode=vision
mazebench model=claude moves=10 mode=vision vision_width=768 vision_height=768
npm run maze:codex-local -- moves=10 mode=vision
```

Vision mode boots a headless browser to render each frame, so it is noticeably
slower than text mode and needs a Chromium-family browser (the same dependency
as the replay video). If a frame fails to render, the helper falls back to the
ASCII board for that turn and reports `frame_error`.

Each run writes a timestamped directory under `outputs/maze-local/<model>/`:

- `session.json` — full state and per-action replay
- `actions.jsonl` — per-turn action log
- `scorecard.json`, `maze_scorecard.json`, `maze_actions.txt`
- `maze_replay.mp4` — the replay video (unless `video=off`)
- `reasoning.json`, `agent.log`, `agent-events.jsonl` — the agent's reasoning
  (see below)

### Reasoning logs

For **both** `model=codex` and `model=claude`, the runner captures the agent's
structured event stream (`codex exec --json` / `claude -p --output-format
stream-json`) and distills a per-move reasoning log. `reasoning.json` is exactly
what you'd want to skim:

```json
[
  { "move": 1, "action": "right", "reasoning": "The exit is east, so...",
    "moved": true, "gems": 0, "room": "level_HxI" }
]
```

The `reasoning` for each move is the agent's commentary (Codex `agent_message` /
Claude `text` blocks, plus Claude `thinking` blocks if extended thinking is on)
since its previous action. `agent.log` is the same trace in human-readable form,
`agent-events.jsonl` is the raw event stream, and the runner prints a per-move
summary to the terminal at the end of the run.

Prerequisites: Node.js, plus `ffmpeg` and a Chromium-family browser for the
video (already used by `npm run maze:replay`). The agent binary must be on your
PATH — `codex` for `model=codex`, `claude` for `model=claude` — or pass
`codex_bin=`/`claude_bin=` with an explicit path.

To (re)build a video from any finished run or Prime eval directory:

```bash
mazebench replay outputs/maze-local/codex/<run-dir>/
# or
npm run maze:replay -- outputs/maze-local/codex/<run-dir>/
```

## 1. Set up the web app with Node

Install dependencies, run tests, then start the local server:

```bash
npm install
npm test
npm run dev
```

Open the app at:

```text
http://localhost:3000
```

## 2. Run the game in the terminal, see the scorecard, and save video

Start an interactive terminal game:

```bash
npm run maze:terminal
```

Controls:

- Arrow keys: move
- `i` / `k`: rotate camera up / down
- `j` / `l`: rotate camera left / right
- `z` or `u`: undo
- `r`: reset
- `q`: quit and print the scorecard

Interactive runs write replay files under `outputs/maze-terminal/<timestamp>/`.
When the run ends, answer the video prompt to save `maze_replay.mp4`.

For a non-interactive run that saves the scorecard and video:

```bash
npm run maze:terminal -- --moves UDLR --once --record-replay --video --fast --draft --fps 20 --width 400 --height 400
```

The output folder contains:

- `maze_scorecard.json`
- `maze_actions.txt`
- `maze_replay.json`
- `results.jsonl`
- `maze_replay.mp4` when video is enabled

## 3. Run with Prime Intellect Verifiers and see results

The `mazebench prime` subcommands wrap the steps below (they print the exact
underlying command before running it):

```bash
mazebench prime install                                   # prime env install mazebench
mazebench prime eval   model=openai/gpt-5-nano n=1 r=1    # normal chat-model eval
mazebench prime codex  model=openai/gpt-5-codex           # Codex CLI via Verifiers (section 4)
mazebench prime vision model=openai/gpt-4.1-mini          # vision observations (section 5)
```

Install `uv` if you do not already have it:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

On macOS, Homebrew also works:

```bash
brew install uv
```

Install the local environment from `./environments/mazebench`:

```bash
prime env install mazebench
```

Run a small eval:

```bash
prime eval run mazebench -m openai/gpt-5-nano -n 1 -r 1 -s --max-turns 8 -d
```

Use your own configured model after `-m`, or omit `-m` to use your Prime
default. The terminal prints the run summary. MazeBench v1 stores replay
artifacts under `info.maze_actions`, `info.maze_scorecard`, and
`info.maze_replay` in `results.jsonl`.

View saved evals:

```bash
prime eval view
```

Export scorecard files and a replay video from a saved eval directory:

```bash
npm run maze:replay -- environments/mazebench/outputs/evals/<model>/<run-id>
```

## 4. Run Codex through Verifiers v1

MazeBench includes a `mazebench_codex` v1 plugin. It uses your local `codex`
CLI as the harness, routes Codex model calls through the Verifiers v1
interception server, and writes replay artifacts under `outputs/maze-codex-v1/`.

```bash
cd environments/mazebench
uv run eval mazebench_codex \
  -m openai/gpt-5-codex \
  -n 1 -r 1 \
  --taskset.max-actions 100 \
  --max-turns 40 \
  --rich false
```

`--taskset.max-actions` is the maze action budget. `--max-turns` is still useful
because Verifiers counts Codex's internal model/tool-call turns while the CLI is
working. The harness strips the `openai/` prefix before invoking `codex exec` so
Codex can use its local model metadata, while Verifiers still routes/bills the
Prime model.

Export the saved v1 trace to scorecard files and video the same way as normal
MazeBench evals:

```bash
npm run maze:replay -- environments/mazebench/outputs/evals/<model>/<run-id>
```

## 5. Run vision observations

The normal `mazebench` taskset can send perspective PNG observations instead of
ASCII boards:

```bash
cd environments/mazebench
uv run eval mazebench \
  -m openai/gpt-4.1-mini \
  -n 1 -r 1 \
  --taskset.observation-mode vision \
  --taskset.vision-width 512 \
  --taskset.vision-height 512 \
  --max-turns 8 \
  --rich false
```

Vision mode keeps the same JS game state, allowed commands, terminal conditions,
and reward functions as ASCII mode. It sends a short text status plus a
perspective image of the current room, with no ASCII board.

## License

MIT. See [LICENSE](LICENSE).
