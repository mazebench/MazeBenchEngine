# MazeBench — Main World ASCII

The win condition remains **100 gems**, by design. The current immutable authored
world contains 87 gems; collecting all of them scores 0.87 and does not declare a
win. This release preserves the benchmark target and authored world unchanged.

Version 0.2 uses the C++/WebAssembly engine, connected-room logic, ASCII renderer,
and game runtime from [MazeBenchBenchmarking](https://github.com/mazebench/MazeBenchBenchmarking).
One task starts in H×I and aims to collect all 100 gems across 256 rooms.

This is a standard **Verifiers v1 taskset and Toolset**. Select the built-in
`prime_agent` harness to use Prime Agent. Verifiers owns its installation, MCP
connection, sandbox, model transport, trace, and lifecycle. MazeBench ships no
custom harness, custom sandbox image, agent installer, Python executor, model
client, or server that you need to operate separately. The game and its records
run in a separate evaluator-owned tool process. Node and all game assets are
included as package dependencies/data; no checkout or browser is needed.

## Install and evaluate

Install from the existing Hub environment:

```sh
prime env install mazebench/mazebench@0.2.0
```

Use the Verifiers v1 evaluator in the Python environment where you installed it:

```sh
vf-eval mazebench -m openai/gpt-4.1-mini -n 1 -r 1 \
  --env.agent.harness.id prime_agent \
  --env.agent.runtime.type prime \
  --env.taskset.max-actions 1000 \
  --env.agent.max-turns 2000 \
  --no-push
```

From this directory, the equivalent checked-in configuration is:

```sh
uv run --no-editable vf-eval @ configs/tools-on.toml
uv run --no-editable vf-eval @ configs/tools-off.toml
```

For a short smoke run, override `--env.taskset.max-actions 10`
and `--env.agent.max-turns 30`. Change `-m` to your desired inference model.
`--no-push` keeps evaluation results local; it does not make inference or sandboxes
free. Use Prime login or `PRIME_API_KEY` for Prime Inference and Sandboxes. MazeBench
itself requires no API keys or environment variables. For other model endpoints,
use Verifiers' normal client configuration.

**Version compatibility:** the package pins the official PyPI prerelease
`verifiers==0.3.2.dev121`, which includes stock Prime Agent. Stable `0.3.1` does
not include that harness. This is an explicit upstream dependency, with no local
patches or replacement implementation. Prime's v1 command is `vf-eval`; the old
`verifiers.load_environment()` / legacy `prime eval run` evaluator is not this
release's API. Upstream is migrating evaluation to prime-rl's `uv run eval`;
`vf-eval` is the still-supported entrypoint bundled with this pinned package.

## Tools-off and tools-on

Both conditions ship in this environment and use the same game, action budget,
and scoring. The selected condition is part of task identity and recorded results.

| Condition | Standard harness | Available capabilities |
| --- | --- | --- |
| `tools_off` | `null` | Only `maze_observe`, `maze_action`, and `maze_sequence`; no code executor. |
| `tools_on` (default) | `prime_agent` | The same game controls, plus stock Prime Agent's Python and workspace capabilities. |

Select the matching preset above, or pass both `--env.taskset.condition tools_off`
and `--env.agent.harness.id null`. A mismatched harness is rejected during setup;
tools-off also verifies that the model-visible catalog contains only the three
game tools before scoring. Stock Prime Agent 0.9.5 always uses its Python executor
to access MCP and has no supported per-tool disable flag, so it cannot represent
tools-off. Neither condition uses a custom MazeBench agent harness.

Tools-on here uses Prime Agent's standard capabilities; it is not the local
desktop benchmark's Python-only restricted executor. Compare results within the
same environment version, condition, and harness. The standard Verifiers traces
record the complete harness and runtime configuration.

Run agents in an
isolated `prime` or `docker` runtime; a local shell agent shares the evaluator's
filesystem and does not provide benchmark isolation. The game package is not
installed into the agent sandbox. Runtime network policy and available agent tools
are configured through Verifiers, and remain properties of the chosen harness.
The default game Toolset uses `subprocess` on the evaluator; Verifiers supplies
the remote connection. Its standard placement config is exposed under
`env.taskset.task.tools`. Keep it separate from the agent (`colocated = false`).
Prime VM runtimes cannot expose a separate tool service port; use the default
evaluator process or a supported service runtime such as Docker for the tools.

## Game API

The MCP server `maze` exposes `observe`, `action`, and `sequence` (some harnesses
display them as `maze_observe`, `maze_action`, and `maze_sequence`).

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `observe` | optional `record` from the returned index | Current ASCII observation or a safe read-only game record; no action cost. |
| `action` | `action` | One move, camera action, undo/reset, or visited-room command. |
| `sequence` | either `sequence="UURDDL"` or `actions=[...]` | Ordered actions, stopping on death, victory, or action limit. |

Actions: `up`, `right`, `down`, `left`, `camera up/right/down/left`, `undo`,
`reset`, and `room HxI` (substitute any visited room). Movement is camera-relative.
Blocked moves and camera/recovery/room commands count toward the budget. Invalid
commands do not. Sequences accept at most 1,000 actions. A failed step preserves
the accepted prefix in authoritative scoring state.

Room geometry resets when entered. Reset restores the current visit's entry
state; room commands create the room's authored start; undo restores the previous
effective state. Gems stay permanently collected. Each rollout uses an immutable
packaged world, so edits in a running local editor do not change a Hub evaluation.
The observations and records use the new repository's existing ASCII contract.

The default action budget is 1,000. Set `--env.taskset.max-actions null` for an
unlimited game budget and bound the run with Verifiers' turn/token/time limits.
`--env.taskset.start-room HxI` changes the starting room. Use `-r` for independent
rollouts of the same task.

## Scoring and records

`gem_score` is unique gems collected divided by 100, in [0, 1]. Metrics include
`gems_collected`, `rooms_visited`, `actions_used`, and `success` (all 100 gems).
Rooms and repeated moves do not add reward. Scoring reads evaluator-owned state,
never model claims or files in the agent workspace. A broken game process
invalidates scoring rather than returning a partial score as a valid run.

Verifiers saves its normal traces. `trace.info.mazebench` contains the condition, exact asset
snapshot hash, initial room, authoritative final summary, and ordered accepted
actions for deterministic replay with the same package. Task data includes the
snapshot hash, so changing the game also changes task identity. Temporary game
records are removed when the tool process shuts down.

## Develop, verify, and publish

Release 0.2.0 passed 21 automated environment tests, including real WASM gameplay,
persistent gem collection, isolation between runs, failure handling, concurrent
MCP calls, and condition enforcement. Its built wheel also passed four live
Prime Sandbox smoke evaluations:

| Model | Tools-on: stock Prime Agent | Tools-off: stock MCP chat |
| --- | --- | --- |
| `openai/gpt-4.1-mini` | 10 actions, passed | 10 actions, passed |
| `anthropic/claude-haiku-4.5` | 10 actions, passed | 10 actions, passed |

Every run ended at the action limit with verified game state and no terminal
errors. These short checks validate integration, not solving performance (each
scored zero gems). Sanitized evidence, tool catalogs, actions, and module hashes
are in `validation/release-smoke.json` in the source archive.

From the repository root:

```sh
node scripts/package-prime-environment.mjs
node scripts/package-prime-environment.mjs --check
cd environments/mazebench
uv sync
uv run pytest
uv build
```

The packaging command copies the exact transitive game modules, the canonical
WASM, and the 256 authored rooms; `runtime/snapshot.json` records every file hash.
It excludes launchers, local runs, credentials, UI, and project solver code. The
prepared runtime is ignored in Git but included in wheels and source archives.
Source archives can be rebuilt without the repository. A build without the
prepared snapshot fails explicitly.

After testing the built wheel in a fresh environment, publish with the standard
CLI while authenticated as a writer for `mazebench/mazebench`:

```sh
prime env push --path . --owner mazebench --visibility PUBLIC
```

This release is public. It is a new version of the existing
environment; older 0.1.x versions remain available for historical evaluations.

## Migration from 0.1.x

The previous release used the old JavaScript engine, custom agent integration,
and different reward signals. Version 0.2 intentionally changes the engine and
scoring; do not combine scores across these versions. Main World ASCII is the
supported surface for this release. Use the `mazebench` taskset with a stock
harness; old `mazebench-tools` and `mazebench-prime-agent` IDs are retired.

API references: [tasksets](https://docs.primeintellect.ai/verifiers/v1/tasksets),
[harnesses](https://docs.primeintellect.ai/verifiers/v1/harnesses), and
[evaluation](https://docs.primeintellect.ai/verifiers/v1/evaluation).
