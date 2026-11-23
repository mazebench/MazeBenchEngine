# Benchmark integrity

The evaluated model is untrusted. The localhost supervisor, MCP implementation,
Codex authentication client, macOS kernel, installed Python runtime, and the
human who controls this machine are trusted. These controls prevent the model
from obtaining hidden world/solver data or changing scores through the known
tool and filesystem escape paths; they are not protection against a malicious
host administrator or an OS vulnerability.

Claude Code's authentication client is likewise trusted. The Claude provider
uses the same game, score, records and mandatory Python OS boundary below.
Grok Build's OAuth client is also trusted. Its provider uses an isolated Grok
home and the same shared MCP, game, records, score, and Python boundary.

## Conditions

| Mode | Permitted activity |
| --- | --- |
| Tools off | Direct `maze_observe`, `maze_action`, `maze_sequence` calls |
| Python on | Same maze tools plus `python_exec` in the run's workspace |
| Resume / continuation | Same frozen model, condition, prompt, binary and runtime; checkpoint verified first |
| Interview / follow-up | A separate Codex fork with no model-visible tools |

Codex advertises its three generic MCP resource helpers whenever a server is
configured. MazeBench returns empty resource and template lists and rejects
all resource reads. `maze_observe` alone reads allowlisted observation records;
it cannot open raw engine state, world files, arbitrary paths, or solver code.
Other MCP servers, personal instructions, skills, memories, connectors, native
shell/patch/JavaScript tools, web, and delegation are disabled. The single-model
catalog also removes metadata that would otherwise override feature flags.

## Move animation records

New actions in both worlds write `records/move_history/move_N/index.json`
and `frame_0000.txt`, `frame_0001.txt`, etc. beneath that move's directory.
Frame 0 is the pre-action board; the last is the final board. MazeBench uses
the actual engine animation frames with their projected active room and saved
camera. Ice Maze advances all players one cell along their recorded paths per
frame. Blocked and non-movement actions have before/after frames. Legacy final
snapshots remain available; old animations are not reconstructed with newer
engines or authored levels.

Action responses and sequence steps advertise only the frame count and index
path. The index lists exact frame paths, rooms and content hashes. Its hash is
stored in the action history authenticated by the existing checkpoint HMAC.
`maze_observe` and the HTTP record reader verify the index/frame hashes and
require the move to belong to the current action prefix. Stale files remaining
after rollback are inaccessible; a replacement or legacy action without an
animation descriptor cannot expose them. Safe file reads still reject links
and traversal. No raw engine objects, unentered rooms or solver data are
published. These reads cost no actions and do not contribute to novelty.

Both runtimes stage frames and checkpoint files before publication, publishing
the checkpoint signature last. A failed preparation preserves the old saved
checkpoint and prevents further use of the unsaved in-memory action.

## Python boundary

The trusted bootstrap installs a deny-by-default Seatbelt profile before
reading or running the agent's saved script. Python may read its runtime/system
libraries and read/write its workspace. Process creation, exec, network, IPC,
and private file access are denied by the kernel, including through `ctypes`.
The Python audit hook is an additional usability guard, not the security boundary.
The startup preflight deliberately removes that hook and tests the OS boundary.
Other OS backends fail closed until separately implemented and tested.

The trusted writer rejects symlink directories, symlink files, hardlinks, and
special files, and atomically installs a fresh script inode. Previous Python
execution has exited before another script is written; child processes cannot
remain behind to race the writer. Inventory walks skip links and are bounded.
Python gets a sanitized environment and no inherited host file descriptors.
Execution has time/output limits. Wall time is measured by the parent process;
agent-authored CPU timing markers are not trusted (`cpu_time_ms` is unavailable).

## Provenance and scores

The per-run manifest hashes executable runtime files, the canonical engine
binary, and all world data. Its frozen configuration binds the model, effort,
condition, action budget, starting room and prompt. Codex's binary and model
catalog are also hashed. Checkpoints authenticate engine state and summary
with a run-specific HMAC key outside the Python workspace. MCP checks integrity
before tools; the supervisor checks before continuation and before accepting
completion. A detected violation stops the run and prevents resumption.

The localhost server rejects foreign Host/Origin headers and cross-site browser
requests. Operator edits to hashed runtime or world assets require a new run.
Historical records predating policy v4 are not relabeled as validated results.

## CLI upgrades and regression checks

The version indicator reads OpenAI's `https://releases.openai.com/codex/channels/latest`
endpoint, with a 15-minute cache and a manual refresh. A failed/offline lookup is
shown as unknown, never as up to date. Updating is an explicit operator action
using `codex update`; it does not automatically expand the tested-version list.

Additional reviewed CLI releases are registered by the operator-side
`benchmarking/codex-releases.mjs`, outside the frozen runtime asset trees.
This preserves historical run manifests and pinned binaries; it does not
change tool permissions or auto-approve future versions. Before admitting
another release, run:

```sh
node --test tests/*.test.mjs
node scripts/check-benchmark-capabilities-v1.mjs
node scripts/sync-engine-v1.mjs --check
```

The capability script uses the actual CLI and an unauthenticated loopback
Responses fixture to inspect the emitted model/tool catalog. It tests Astra,
GPT-6.1 Sol at Max, GPT-6 Sol, GPT-6 Luna, and Terra with Python on/off, initial and resumed turns,
and interview forks and follow-ups. It uses a temporary Codex home, never sends credentials or prompts
to an external service, and removes its fixtures afterward. Also perform a
bounded live model smoke test in separate validation records after an upgrade.

Security regressions cover audit-hook replacement, native filesystem/fork
calls, subprocess/re-exec, localhost access, symbolic and hard links, workspace
substitution, unknown tool events, state/score/configuration/manifest tampering,
and cross-origin requests. Keep these tests when changing the boundary.
# Compaction and audited recovery

Codex uses the current authenticated compaction transport in both benchmark
conditions and interviews. This is a Responses transport behavior, not an MCP
tool or an agent executor. Codex 0.153.3 requires the `remote_compaction_v2`
switch to avoid the legacy `/responses/compact` endpoint; Codex 0.155.0 removed
the switch after making the current protocol unconditional.

The offline capability test forces compaction as well as ordinary turns and
checks that the tool catalog stays restricted before and after compaction.
Recoverable compaction failures can resume the same Codex conversation only
after the ordinary integrity checks pass.

For the affected September 4 build, the operator-only
`scripts/repair-benchmark-compaction-v1.mjs <run-id>` accepts exactly the reviewed
before/after hashes for the supervisor and Resume UI. It verifies all other
assets, the original prompt and configuration, Codex binary and catalog, and
the signed game checkpoint before making any change. It preserves the original
manifest and run metadata in `repairs/remote-compaction-v2/`, records the repair,
and leaves game state, score, history, prompt and Codex thread intact. This is
not a general bypass for runtime changes and is not available through MCP.

## Claude Code

The Claude adapter lives in `benchmarking/providers/`. Its source inventory,
policy, versioned model ID, effort, Python condition, exact native CLI binary,
and prompt are frozen in the run manifest in addition to the shared runtime.
A serial MCP gate checks this extra provenance before forwarding each request
to the unchanged shared MCP. The gate translates the sequence tool's top-level
`oneOf` discovery schema for Claude compatibility; the shared server still
validates exactly one of `sequence` or `actions` on every invocation.

Claude starts with `--restricted`, an empty built-in `--tools` list, empty
`--setting-sources`, `--strict-mcp-config`, `--disable-slash-commands`,
`--no-chrome`, and `dontAsk` permissions. Only exact MazeBench tool names are
preapproved. CLAUDE.md, memory, background tasks, IDE connection, tool search,
personal hooks and plugins are disabled. No inherited API keys, alternate
endpoint/model settings, SDK sockets, or Node options enter the child process.
The OS account name is passed because Claude's native keychain lookup needs it;
credentials remain in the trusted authentication client, outside Python.
Administrator-managed policy and the authentication client are part of the
trusted host boundary, not defenses against a hostile machine administrator.

Every initialization must report the exact model, tool catalog, connected
MazeBench server and permission mode. Streamed tool calls, full responses and
reported model usage are checked for unexpected tools or model fallback.
Violations write a permanent invalidation marker and prohibit resume. Claude
uses an explicit session ID for pause/resume/continuation; it cannot choose a
different session through a tool. Claude interviews are currently unavailable.

Run `node scripts/check-claude-capabilities-v1.mjs` and the full test suite before
admitting another Claude version. The CLI check uses an unauthenticated local
Anthropic fixture, a temporary home with hostile personal/project instructions,
and an extra project MCP configuration. It checks discovery, resume, real maze
and Python calls, native private-file/network denial after removing Python's
audit hook, and attempted shell/file/web/delegation/disabled-Python calls.
Live smoke records belong in `~/records/mazebench-validation/claude-code/`,
separate from benchmark results.

## Grok Build

The Grok adapter lives in `benchmarking/grok/`, outside the frozen Codex,
Claude, Ice Maze, and Slotski source inventories. Version 1.0.40 is pinned to
the `grok-4.7` model and grok.com OAuth. This first adapter supports Main World
ASCII observations only. Its source, effective prompt, native executable,
isolated `config.toml`, and frozen local model catalog are hashed into every
run and checked before every MCP request.

Each run gets a private `$GROK_HOME` under `~/.mazebench/grok-build/`, outside
`~/records`. The operator's OAuth file is copied there with owner-only
permissions so credentials never become a benchmark record or Python-readable
workspace file. Deleting the run also deletes this private state. The child
environment omits inherited API keys, endpoint/config overrides, and Node
options. Configuration disables compatibility imports, personal/project
plugins, skills, hooks, memory, managed configuration, remote tool catalogs,
web/media tools, filesystem writing, shell environment loading, and subagents.
The isolated configuration also carries a tightening allowlist for only the
`mazebench` MCP server.

Grok Build presents MCP through the always-on `search_tool` and `use_tool`
gateways. A non-empty built-in allowlist leaves exactly those two tools; the
runner verifies that exact initialization catalog, OAuth source, selected model,
working directory, permission mode, empty skills, fixed command surface, and
single MazeBench server. It then checks every discovery result, qualified MCP
name, inline argument object, tool result, session ID, response model, reported
usage model, and server-side web counter. File-backed MCP arguments, another
server or tool, fallback, delegation, and unknown event types invalidate the
record and prohibit resume. The MCP gate independently rechecks the frozen run
and authenticated checkpoint before discovery or execution.

Grok Build 1.0.40's built-in macOS sandbox cannot initialize on the current host
because `/var/run/docker.sock` resolves through a symlink. The adapter therefore
uses `--sandbox off` and treats the exact gateway-only model catalog as the Grok
CLI capability boundary. This does not weaken `python_exec`: agent programs are
still materialized only as `.py` files in `/workspace` and run under the same
mandatory, preflighted macOS Seatbelt profile described above. The model has no
Grok shell, JavaScript, file read/write, grep, web, media, or task tool with
which to access the unsandboxed client process.

Before admitting a different Grok Build release, run the full test suite and a
bounded live OAuth smoke for tools off and on. Verify the initialization event
still contains exactly `search_tool` and `use_tool`, discovery publishes only
the condition's MazeBench tools, `modelUsage` reports the reviewed 4.7 backing
model, pause/resume preserves conversation history (via the explicit continuation
fork workaround in `grok/policy.mjs`), and all adversarial boundary tests
fail closed. Validation records should use a separate records root.

The 2026-09-28 upgrade admitted Codex 0.158.0, Claude Code 2.1.284 (including
`claude-sonnet-5-5`), and stable Grok Build 1.0.41 after real-client capability
checks, bounded live checks in both Python conditions, and the regression
suite. Claude's built-in `agents-md@builtin` plugin is explicitly disabled;
do not weaken the empty-plugin event check to admit it. Existing frozen records
are not resealed or migrated by a CLI upgrade.

Antigravity runs are outside these older frozen provider inventories. The
1.2.13 custom agent has no native tools or inherited customizations. Real-client
wire tests verify the effective MCP-only catalog (the startup registry is not
the effective catalog), rejected native execution, both Python conditions and
conversation resume. Large responses use lossless, content-addressed read-only
pages through maze_observe, never an Antigravity host-file reader. See
`benchmarking/antigravity/README.md` for isolation and validation details.

The current dashboard modules live under `benchmarking/ui/`; the original
v1 dashboard modules remain unchanged to preserve the existing Codex run's
frozen runtime inventory. UI and read-only telemetry code are not agent tools.
