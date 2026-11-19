<div align="center">

<img src="favicon.svg" width="64" height="64" alt="">

# MazeBench

**An open-world puzzle benchmark for AI agents.**<br>
256 connected rooms · 100 gems · one long episode, played only through game tools.

<img src="docs/media/world-map.gif" width="760" alt="A slow flight over the full 16 × 16 room MazeBench world">

[Quick start](#quick-start) ·
[Play](#play-it-yourself) ·
[Replays](#watch-a-solution-replay) ·
[What agents see](#what-agents-see) ·
[Run a benchmark](#run-a-benchmark) ·
[Watch runs](#watch-and-compare-runs) ·
[Versions](#versions-and-integrity) ·
[Develop](#develop-the-engine)

</div>

---

## What is MazeBench?

MazeBench drops an agent into one connected world: a 16 × 16 grid of rooms, each
16 × 16 tiles, holding 100 gems. The agent sees only the room it is standing in.
Walking off an edge enters the neighbouring room, and every room is a small physics
puzzle: ice that keeps you sliding, slopes, crates, buttons that lower orange walls,
lifts, punchers, clones and pits.

Agents are told the controls and little else. They must learn the mechanics by
playing, remember what they found across hundreds of rooms, and keep a plan going
for tens of thousands of moves. A verified 100-gem route takes about 40,500 commands.

|                  |                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------- |
| **Goal**         | Collect all 100 gems. Gems are tracked by identity and never respawn.                   |
| **Start**        | Room H×I                                                                                |
| **Actions**      | `up` `down` `left` `right`, UDLR sequences, `undo`, `reset`, `camera …`, `room X×Y`     |
| **Observations** | The current room as ASCII text, or as a rendered PNG in Vision mode                     |
| **Conditions**   | Coding off, Python only, or Any language (sandboxed)                                    |
| **Telemetry**    | Gems, rooms visited, distinct cells, novelty, tokens and API-equivalent cost            |

## Quick start

You need [Node.js](https://nodejs.org) 22.13 or newer.

```bash
node server.mjs
```

Open **http://localhost:8080**. The site itself needs no install or build step. Keep
the terminal open, and press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop.

`npm start` does the same and also builds the Unit tests page. Run `npm ci` once
before using Vision runs, the Any-language sandbox, or the development tools.

Every tool is one click from the world map:

| Page           | Path                   | What it's for                                         |
| -------------- | ---------------------- | ----------------------------------------------------- |
| **World map**  | `/`                    | Fly over all 256 rooms and pick one to play or edit   |
| **Play**       | `/play/v1/?room=HxI`   | Play the world yourself, in 3D or ASCII               |
| **Benchmark**  | `/benchmarking/v1/`    | Launch agent runs and follow them live                |
| **Replays**    | `/replays/v1/`         | Watch a solution file as a movie                      |
| **Solutions**  | `/solutions/v1/`       | Search for and store routes through the world         |
| **Editor**     | `/editor/v1/?room=HxI` | Build and adjust rooms                                |
| **Object lab** | `/object-lab/`         | Preview individual blocks and objects in 3D           |
| **Unit tests** | `/unit-tests/`         | Step through the physics test suite                   |

## Play it yourself

<img src="docs/media/play-3d.gif" width="760" alt="The player walks through the start room, pushes a box aside and crosses into the room to the north">

Start at **Play from beginning**. Arrow keys move relative to the camera, so "up"
always means away from you.

| Action                  | Keyboard                       | Controller          |
| ----------------------- | ------------------------------ | ------------------- |
| Move                    | <kbd>←</kbd> <kbd>↑</kbd> <kbd>→</kbd> <kbd>↓</kbd> | Left stick or D-pad |
| Rotate / tilt camera    | <kbd>A</kbd> <kbd>D</kbd> / <kbd>W</kbd> <kbd>S</kbd> | Right stick         |
| Zoom                    | <kbd>Q</kbd> / <kbd>E</kbd>    | ZL / ZR             |
| Switch 3D ↔ ASCII       | <kbd>M</kbd>                   |                     |
| Undo                    | <kbd>Z</kbd>                   | Any right face button |
| Reset the room          | <kbd>R</kbd>                   |                     |

A few rules worth knowing:

- **Edges are doors.** Walk off a room's edge to enter its neighbour. Rooms you leave
  are restored when you come back.
- **Death is undoable.** Falling into a pit or getting crushed can always be undone.
- **Reset** restores the room as it was when you entered it.
- **Sequences.** Paste a UDLR string such as `RRUULD` into *Move sequence* to play it
  back. The *Room moves* panel records your moves in the same format.
- **Tweens** (smooth motion) can be switched off under *Playback settings*.

## Watch a solution replay

<img align="right" src="docs/media/replay-import.png" width="300" alt="The Import a replay dialog: choose a file or paste moves, starting in room H×I">

Got a solution file, such as the full 100-gem route? **Replays** turns it into a movie
you can pause, scrub and watch from any angle.

1. On the world map, click **Replays**.
2. Click **Choose a file** and pick your solution, or drop it onto the page. You can
   also paste moves and press **Create replay**.
3. Wait while the movie is built. The progress bar shows a time estimate, and the
   full 100-gem solution takes about a minute.
4. Press <kbd>Space</kbd> to play.

Plain text with one move per line (`up`, `left`, …), `UDLR` strings, `room X×Y` jumps
and Solutions JSON exports all work. Replays start in H×I unless the file names
another start room.

<br clear="right">
<br>

<img src="docs/media/replay-camera.gif" width="760" alt="A short sample route replaying at half speed while the camera orbits, zooms in and zooms out">

The camera stays yours while the movie plays, and pausing or seeking keeps your view.

| Action                       | Keyboard and mouse                                     |
| ---------------------------- | ------------------------------------------------------ |
| Play / pause                 | <kbd>Space</kbd> or <kbd>K</kbd>                       |
| Orbit                        | Drag the view                                          |
| Rotate / tilt                | <kbd>A</kbd> <kbd>D</kbd> / <kbd>W</kbd> <kbd>S</kbd>  |
| Zoom                         | <kbd>Q</kbd> / <kbd>E</kbd>                            |
| Center camera                | <kbd>/</kbd>                                           |
| Seek 5 s (0.1 s with Shift)  | <kbd>←</kbd> <kbd>→</kbd> or <kbd>J</kbd> <kbd>L</kbd> |
| Previous / next action       | <kbd>,</kbd> / <kbd>.</kbd>                            |

- **Speed** runs from 0.25× to 10×. The full solution lasts about 78 minutes at 1×,
  or under 8 minutes at 10×.
- **Gems** and **New rooms** add clickable ticks to the timeline, so you can jump
  straight to each gem or first visit.
- **3D / ASCII** switches views without losing your place.
- Importing never changes your saved solutions or the rooms.

## What agents see

<img align="right" src="docs/media/play-ascii.gif" width="360" alt="The same walk rendered as ASCII text">

In ASCII mode, each tile is a 4 × 4 block of characters, so a room is at most
64 × 64 characters. Upper-case letters are top faces. Lower-case letters are the
sides you see when the camera is tilted.

Agents are told only that `P` is the player and `G` is a gem. Everything else must
be worked out by playing. For humans, here is the key to the common glyphs:

| Glyph | Meaning      | Glyph | Meaning          |
| :---: | ------------ | :---: | ---------------- |
| `P`   | Player       | `B`   | Crate            |
| `G`   | Gem          | `U`   | Weightless box   |
| `A`   | Floor        | `O`   | Orange wall      |
| `W`   | Wall         | `8`   | Orange button    |
| `I`   | Ice          | blank | Drop / pit       |

<br clear="right">

Agents act through a small MCP tool set:

| Tool            | What it does                                                                 |
| --------------- | ---------------------------------------------------------------------------- |
| `maze_observe`  | Returns the board and game state, or reads an earlier move's frames. Free.   |
| `maze_action`   | Applies one action, including `undo`, `reset`, `camera …` and `room X×Y`.    |
| `maze_sequence` | Applies a UDLR string or an explicit list. Each step counts as one action.   |
| `python_exec`   | *Python only:* runs code in an isolated, network-free workspace.             |
| `code_exec`     | *Any language:* runs code in a Docker sandbox.                               |

Every action records its full animation. Agents can read those frames at no cost,
which matters when one press sends the player sliding across a room of ice.

In **Vision** mode the board is a PNG of the 3D render instead, with no ASCII, object
list or coordinates. See [the vision setup](benchmarking/vision/README.md).

The exact prompts live in [`benchmarking/v1/EVAL-PROMPT.md`](benchmarking/v1/EVAL-PROMPT.md)
and [`benchmarking/vision/EVAL-PROMPT.md`](benchmarking/vision/EVAL-PROMPT.md).

## Run a benchmark

<img src="docs/media/benchmark-launcher.png" width="760" alt="The New run panel: agent, model, reasoning, view, coding tools and speed">

1. Install and sign in to the agent CLI you want to evaluate (see the table below).
2. Open **Benchmark** and choose the agent, model, reasoning effort, view (ASCII or
   Vision), coding tools and speed.
3. Under **Options**, pick the world (Main World, Ice Maze or Slotski) and an action
   limit. The default is unlimited.
4. Press **Launch run**. A live card appears; open it to watch.

| Agent              | Runs models through                    | Setup                                                    |
| ------------------ | -------------------------------------- | -------------------------------------------------------- |
| **Codex**          | OpenAI Codex CLI                       | Signed-in `codex`. A Fast speed tier is optional.        |
| **Claude Code**    | Anthropic Claude Code                  | `claude auth login`                                      |
| **Grok Build**     | Grok subscription or connected model APIs | grok.com sign-in or `npm run setup:connection`          |
| **Antigravity**    | Google Antigravity (Gemini)            | [Antigravity notes](benchmarking/antigravity/README.md)  |
| **Meta Muse Code** | Muse Code                              | [Muse notes](benchmarking/muse/README.md)                |
| **Kimi Code**      | Kimi Code                              | `npm run setup:kimi` · [Kimi notes](benchmarking/kimi/README.md) |
| **Prime Agent**    | Prime Intellect inference (open models) | [Prime notes](benchmarking/prime/README.md)             |
| **DeepSeek Harness** | Official DeepSeek Harness CLI | `npm run setup:deepseek` · Sign in or add an API key in DeepSeek Harness Settings → Models |

DeepSeek Harness and connected Grok Build models support Main World ASCII with coding Off or Python Only.
`npm run check:deepseek` validates its tool configuration and conversation resume
against local mock APIs. Both harnesses discover language models from connected
accounts, without a chosen-model allowlist. New account models appear on **Refresh models**.
Choose **Agent → Connection → Model** to select the harness independently from the
provider and billing account. A model available through multiple accounts keeps
separate connection choices. `DEEPSEEK_API_KEY` is also supported when starting the server.
`npm run setup:deepseek-anthropic` connects a Claude API key using a hidden Terminal
prompt and a separate private credential file. All compatible Claude models listed
by that key are available through both harnesses' stock Anthropic adapters.
`npm run setup:deepseek-chatgpt` provides a local **Continue with ChatGPT** page for
eligible ChatGPT plan usage and credits. It registers MazeBench under its own
stable host identity, verifies the returned identity and granted scope, and uses
the public Responses API with the stock harness adapter. It never copies Codex
credentials. All visible models returned by that account, including GPT-6.1 Terra,
are offered. Grok uses its native Responses adapter through a private loopback
transport that translates system messages to developer messages, removes unsupported
API options, and shares the stock refresh-token lock with DeepSeek. Its prompt,
agent loop, tools, and conversation remain in Grok. The transport omits the new
account-metadata SSE event and reconstructs empty terminal output arrays from the
exact completed stream items for Grok's older Responses schema. Quota failures and interrupted
streams fail the turn; only `response.completed` counts as completed inference.
Manage plan usage at https://chatgpt.com/settings/usage. API-equivalent prices in
run reports are estimates, not a conversion of ChatGPT credits into API dollars.
The selector shows the exact API model slug alongside its display name; run
records retain that slug. Provider aliases are never replaced with inferred
versioned IDs.

To add or rotate an API connection, run `npm run setup:connection -- openai`
(also `anthropic`, `deepseek`, `xai`, or `openrouter`). Enter the key at the hidden
prompt. For Google AI Studio, run `npm run setup:connection -- google` with a
Gemini API key from a paid project for Gemini 4 Neon. Select **DeepSeek Harness →
Google AI Studio** after refreshing models. This connection uses the native
Gemini protocol and its own API billing. Run `npm run check:deepseek` if the
installation needs to verify the Gemini transport.

Other compatible providers use:

```sh
npm run setup:connection -- --id my-provider --name "My provider" --api openai-completions --base-url https://provider.example/v1
```

Supported protocols are `anthropic-messages`, `openai-responses`, and
`openai-completions`. Setup verifies `/models`, keeps credentials in private files
outside Git, and registers the connection in `~/.mazebench/connections.json`.
`npm run setup:connection -- --list` lists connections without credentials.
Connection entries can supply a `catalog_provider` for installed transport metadata
and `models` overrides (`id`, `contextWindow`, `maxTokens`, `reasoningEfforts`,
`compat`) for gateway-specific capabilities. Embedding, media-only, and retired
models are excluded. Unknown language models use provider defaults; they must
support tool calling. Unsupported reasoning levels are not offered. Grok supports
adaptive Claude thinking; older Claude models that require thinking budgets use
provider defaults there. DeepSeek retains its stock budget support.
Catalog failures retain stale entries but block launching through that connection;
other working connections remain available. Run records freeze the exact model,
connection, protocol, and billing source. Existing runs retain their original runtime.
`node --test tests/benchmark-grok-connected-wire.test.mjs` validates all three Grok
transports, ChatGPT authentication, session continuation, and tool restrictions locally.

**Coding tools.** *Any language* needs Docker. Build its pinned toolchain once with
`npm run setup:code-sandbox`. *Python only* is the older, restricted Python condition.

**Isolation.** Every harness is locked down to the MazeBench tools. Shell, file access,
web, plugins, memory, personal settings and sub-agents are switched off, and any other
tool call invalidates the run. The prompt, model, effort, CLI binary hash and every
runtime file are pinned in a signed manifest that is re-verified throughout the run.
The full threat model is in [`benchmarking/v1/SECURITY.md`](benchmarking/v1/SECURITY.md).

<details>
<summary><b>Background services and ports</b></summary>

<br>

Most of these start with the site. Use the script to add one to a site that is
already running, without interrupting active runs.

| Port | Service                                          | Script                           |
| ---- | ------------------------------------------------ | -------------------------------- |
| 8080 | Main site and benchmark owner                    | `node server.mjs`                |
| 8082 | Vision runner (Codex, Claude Code)               | `npm run start:vision`           |
| 8083 | Capability service (Any language, newer modes)   | `npm run start:capabilities`     |
| 8084 | Model catalogs                                   | `npm run start:catalogs`         |
| 8085 | Read-only playback and reports                   | `npm run start:playback`         |
| 8091 | Current pricing and token reports (independent of live agents) | `npm run start:reports` |
| 8086 | Vision runner (Gemini, Grok, Kimi, Muse)         | `npm run start:vision-providers` |
| 8087 | Recovery companion                               | `npm run start:recovery`         |
| 8090 | Versioned runtime releases (new Main World runs) | `npm run start:releases`         |
| 8092 | Shared automatic resume for every agent type    | `npm run start:auto-resume`      |
| 3001 | Physics test lab (optional)                      | `npm run dev:lab`                |

Vision launches need the vision runner and fail if it is offline; they never fall
back to ASCII. Image rendering uses Playwright with your local Chrome. Do not stop the
capability service while it owns an active Any-language run.

The shared auto-resume service starts with the site and can be added to an
already-running site independently. It discovers active runs across all agents,
models, coding modes, and observation modes. Network failures, rate limits,
capacity errors, and interrupted owners retry the same saved run with persistent
backoff. Transient outages continue retrying at intervals up to 30 minutes;
provider reset times and an hourly retry budget can extend the wait. Explicit
Pause/Stop/Delete cancels recovery. Historical paused/failed runs stay inactive
until explicitly resumed. Invalid credentials, exhausted paid credits, integrity
failures, and repeated unknown errors surface as **Needs attention**.

The browser sends controls through port 8092 when available. Recovery delegates
to each run's original owner and preserves its runtime, model, conversation,
prompt, and game history. Existing provider-specific audited repairs remain in
place. Durable intent and retry audits live in `~/.mazebench/auto-resume/`;
`/api/benchmark/auto-resume/status` reports enrollment and retry times. See
`benchmarking/auto-resume.mjs` and its policy/owner/server modules.

</details>

<details>
<summary><b>Automatic recovery</b></summary>

<br>

Some provider failures are retried without touching game state. Every attempt is
audited, retries are capped, and **Pause** or **Stop** always cancels a pending retry.

- **Codex:** transient 429/5xx failures resume the same conversation after
  15 s, 30 s, 1 min, 2 min, then 5 min. Vision runs also recover from unfinished
  `list_mcp_resources` calls.
- **Gemini ASCII (coding off, Python, or Any language) and vision (coding off):** "blocked by Gemini's filters" responses resume after 15 s,
  1 min, then 3 min. Retries stop after three attempts without new moves, or eight in
  an hour. The recovery companion logs attempts in
  `~/.mazebench/gemini-ascii-recovery/retry-audit.jsonl` or
  `~/.mazebench/gemini-vision-recovery/retry-audit.jsonl`. Versioned runs keep the
  same audit file in their release’s recovery directory.
- **Grok vision:** matching-session HTTP errors resume with the same limits. Attempts
  are logged to `~/.mazebench/grok-vision-recovery/retry-audit.jsonl`.

The dashboard shows **Auto-resuming** while a retry is waiting and **Needs attention**
once retries are exhausted. Integrity violations always need a human review.

</details>

## Watch and compare runs

<img src="docs/media/benchmark-replay.gif" width="760" alt="A recorded agent run replayed in 3D with the scrubber advancing">

Open any run card to follow it.

- **Overview** replays the run in 3D or ASCII, independent of the view the agent
  played in. The **Agent** label shows what it actually received. Scrub, step, and play at
  0.5×–10×. **Live** follows a running agent move by move.
- **Download** exports the replay as a GIF or video, in 3D or ASCII.
- **Analysis** charts tokens, API-equivalent cost and novelty over the run.
- **Activity** shows the agent's messages and tool calls.
- **Compare heatmaps** sets runs side by side. Gem curves can be plotted against
  moves, tokens or estimated cost.
- **Pricing** lists the per-token rates behind cost estimates. **Older runs** opens
  the archive of earlier recordings.

> [!TIP]
> Compare runs that share a version label and coding condition. Runs on different
> world versions can contain different gems and room layouts.

## Versions and integrity

The badge in the header (for example `v1.1.86`) names the exact engine, play adapter
and world inventory that new AI benchmark runs use.

- **`v1.1.N`** labels come from the append-only registry in
  [`benchmarking/version-registry.mjs`](benchmarking/version-registry.mjs). Identical
  content always gets the same number. Run cards show the version each run recorded.
- **`v1.0.N`** labels group legacy runs, reconstructed from Git history and run dates.
- **Checkpoints** are authenticated and incremental. Read them with `readCheckpointJson`
  from [`benchmarking/v1/checkpoint-json.mjs`](benchmarking/v1/checkpoint-json.mjs). Read
  [`benchmarking/storage/README.md`](benchmarking/storage/README.md) before any rollback or repair.
- **Pinned worlds.** New Main World runs get a private snapshot of the engine and world,
  and existing runs stay pinned to their recorded revisions. Editor saves no longer
  reach a run in progress.

<details>
<summary><b>Rebuilding the version catalogue</b></summary>

<br>

Refresh the read-only inventory and register newly discovered snapshots:

```bash
node scripts/catalogue-run-versions.mjs \
  "$HOME/records/mazebench-benchmark" outputs/version-audit/catalogue.json \
  "$HOME/records/mazebench-vision" \
  --legacy-repo /path/to/MazeBenchEngine --register
```

Then open `/outputs/version-audit/catalogue.html` on the local site. To match legacy
runs to historical engines and assign release numbers:

```bash
node scripts/match-legacy-run-versions.mjs outputs/version-audit/catalogue.json /path/to/MazeBenchEngine
node scripts/assign-legacy-run-versions.mjs
```

These commands never launch an agent and never modify, reseal, pause or resume a run.
Reports stay in the ignored `outputs/` folder.

</details>

## Develop the engine

The canonical C++ physics engine, the visual physics test lab, and every authored test
live in this repository.

```bash
npm ci                  # once
npm run dev:lab         # physics test lab on http://localhost:3001
npm run build           # lab, engine (WASM) and solver accelerators
npm test                # native engine, lab/WASM and site tests
npm run test:quick      # fast checks against the current built engine
npm run test:parity     # shared renderer identity and engine adapter equivalence
npm run lint && npm run typecheck
```

After any C++ change, rebuild the solver accelerators with `npm run build:solvers`.

```text
engine/          C++ physics (engine/src, engine/include), tests and benchmarks
engine/current/  Live browser engine API and the shared WASM link
play/current/    Command playback and connected-room orchestration
ui/              Main-site renderers and browser entry points
apps/web/        Physics test lab (editor + timeline)
project-data/    Authored physics test fixtures
level-data/      The authored world: 256 rooms
benchmarking/    Harnesses, MCP server, run storage, dashboard
replays/  solutions/  world-solver/   Replay movies, route search, world solvers
engine/v1/  play/v1/  render/v1/  render-ascii/v1/  benchmarking/v1/
                 Frozen, signed runtimes used by historical benchmark runs
```

More detail lives in [`ARCHITECTURE.md`](ARCHITECTURE.md),
[the test-lab guide](docs/test-lab.md), [the test catalog](docs/TEST_CATALOG.md) and
[the consolidation notes](docs/consolidation.md).

## License

[MIT](LICENSE) © 2026 Jonathan Pappas and David Pappas
