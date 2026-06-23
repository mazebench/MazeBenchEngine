# MazeBench (`mazebench`)

### Overview
- **Environment ID**: `mazebench`
- **Short description**: JS-backed ASCII maze navigation benchmark for multi-turn language models.
- **Tags**: maze, game, ascii, reasoning, train, eval

### Datasets
- **Primary dataset(s)**: local world-map levels from the MazeBench maze game.
- **Default starter level**: `level_HxI`.
- **Source links**: `games/maze/levels`, `games/maze/world_map.json`, `scripts/maze-terminal.js`, and `scripts/maze-bridge.js`.
- **Task count**: configurable; defaults to 1 generated task.

### Task
- **Default type**: Verifiers v1 `Taskset` with a framework-driven `User` simulator backed by the real JS maze runtime.
- **Default commands**: `up`, `down`, `left`, `right`, `rotate camera <direction>`, `undo`, `reset`, `go to level X Y`, `quit`.
- **Goal**: collect `game_won_gem_count` unique gems across the run. Not every room has a gem, and some rooms have multiple gems.
- **Terminal states**: `game_won` fires when the run has collected `game_won_gem_count` unique gems. `game_lost` fires when the model types `quit`. Both terminal states end the loop and return a final scorecard.
- **Scorecard result**: includes `won` and `percent`. `percent` is `100 * collected_gems / game_won_gem_count`.
- **Reward overview**: default reward is only the number of unique gems collected. If `target_gems > 0`, the gem reward is normalized to that target, but the semantic win condition remains `game_won_gem_count`.

Each assistant response should be exactly one text command. The v1 user simulator then replies as the next `user` message with the current ASCII room layout, metadata, and the allowed commands. Framework-level v1 limits such as `max_turns`, token caps, and timeouts are configured on the eval environment, while MazeBench-specific task generation lives under the taskset config.

### Quickstart
Run an evaluation with default settings:

```bash
prime eval run mazebench
```

Configure model and sampling:

```bash
prime eval run mazebench \
  -m openai/gpt-4.1-mini \
  -n 1 -r 3 \
  --sampling.max-tokens 512 \
  --sampling.temperature 0.2
```

Save replay data and the JS scorecard:

```bash
prime eval run mazebench \
  -m openai/gpt-5-nano \
  -n 1 -r 1 \
  --max-turns 8 \
  -d
```

For Prime-routed GPT-5 models, avoid small `--sampling.max-tokens` caps. Hidden
reasoning tokens count against the cap and can produce an empty assistant message
before a command is emitted.

The saved v1 `results.jsonl` trace includes `info.maze_actions` as the normalized
action list, `info.maze_scorecard` as the final JS scorecard, and
`info.maze_replay` as a compact replay payload with initial state, actions, and scorecard.

Run MazeBench through the local Codex CLI and Verifiers v1:

```bash
uv run eval mazebench_codex \
  -m openai/gpt-5-codex \
  -n 1 -r 1 \
  --taskset.max-actions 100 \
  --max-turns 40 \
  --rich false
```

The `mazebench_codex` plugin bundles a local host harness for `codex exec`
instead of using Prime's stock Linux Codex harness. It still routes all Codex
model calls through the v1 interception server, then finalizes from
`outputs/maze-codex-v1/<trace-id>/session.json` and `scorecard.json`.
By default, the harness removes the `openai/` provider prefix for the local
Codex CLI invocation, while the v1 relay keeps the full Prime model id upstream.

Export standalone replay artifacts from a saved eval directory:

```bash
npm run maze:replay -- environments/mazebench/outputs/evals/<model>/<run-id>
```

This writes `maze_scorecard.json`, `maze_actions.txt` (one action per line),
and `maze_replay.mp4` (perspective Three.js H.264 from the native square maze canvas)
beside `results.jsonl`.
The default video is 60 FPS; movement actions run at 5x replay speed and
camera actions run at 2x replay speed.
Use `--no-video` to write only the JSON/TXT sidecars. The exporter supports both
v1 `info.maze_actions` traces and older top-level `maze_actions` rows; if neither
is present, it falls back to recovering actions from saved assistant turns and
replaying them through the JS bridge to rebuild the scorecard.
Use `--move-speed`, `--camera-speed`, or `--speed` to tune replay timing.
Use `--tail-seconds 0` to remove the short final hold after the last action.

Preview the exact default multi-turn prompt/action surface locally:

```bash
npm run maze:model -- --level level_HxI --view top-diagonal --target-gems 1
```

Notes:
- Local runs prefer the live MazeBench repo when you run from its root. Built wheels also include the required JS runtime files so clean installs can load without a background server.
- Set `MAZEBENCH_REPO_ROOT=/path/to/MazeBench` when you want an installed package to use a specific checkout instead of its bundled runtime.
- The JS bridge tracks visited rooms and globally unique collected gem IDs. `go to level X Y` is only allowed for rooms already present in `visited_levels`.

### Command Contract
| Command | Arguments | Description |
| ---- | --------- | ----------- |
| `up`, `down`, `left`, `right` | none | Move one screen-relative step. |
| `rotate camera up`, `rotate camera down`, `rotate camera left`, `rotate camera right` | none | Change camera pitch or yaw. |
| `undo` | none | Undo the most recent movement action. Gem score remains monotonic. |
| `reset` | none | Reset the current room to its entry state. Gem score remains monotonic. |
| `go to level X Y` | world column and row letters | Spawn at a previously visited room, preserving camera and run score. |
| `quit` | none | End the rollout as `game_lost` and return the final scorecard. |

Accepted text forms include `up`, `rotate camera left`, `undo`, `reset`, `go to level H I`, and `quit`.

### Environment Arguments
| Arg | Type | Default | Description |
| --- | ---- | ------- | ----------- |
| `num_examples` | int | `1` | Number of v1 tasks to build. |
| `start_level_id` | str | `level_HxI` | Starter level used when `level_ids` is not provided. |
| `level_ids` | str/list | `None` | Optional comma/space-separated level IDs. Accepts `HxI` or `level_HxI`. |
| `view` | str | `top-diagonal` | Initial ASCII camera view. |
| `yaw` | int | `0` | Initial camera yaw. Movement actions are screen-relative. |
| `game_won_gem_count` | int | package default | Unique gems required for `game_won`. This value is also passed into the JS bridge/scorecard. |
| `target_gems` | int | `0` | Optional gem-reward/prompt target for smoke runs. `0` uses the `game_won_gem_count` objective. The semantic `game_won` condition remains `game_won_gem_count`. |
| `repo_root` | str/null | `None` | MazeBench repo root. Falls back to `MAZEBENCH_REPO_ROOT` or current working directory. |
| `node_bin` | str | `node` | Node executable used to run the JS benchmark bridge. |
| `timeout_seconds` | int | `20` | Subprocess timeout for JS observation/scoring calls. |
| `system_prompt` | str | built in | Optional instruction override. |

For `mazebench_codex`, `max_actions` controls the maze action budget shown to
Codex. The framework `max_turns` caps Codex's internal model/tool-call turns, so
keep it comfortably above the desired action count.

Framework controls such as `max_turns`, token caps, sampling, rollout count, and
timeouts are v1 eval/harness settings, not MazeBench taskset arguments.

### Metrics
| Metric | Meaning |
| ------ | ------- |
| `gem_score` | Reward: raw unique gems collected, or normalized if `target_gems > 0`. |
| `collected_gems` | Number of unique gem IDs collected across the run. |
| `current_level_solved` | Whether the current room's JS solved condition is true. |
| `visited_level_count` | Number of rooms visited during the rollout. |
