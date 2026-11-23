# Google Antigravity — restricted subscription runner

Main World ASCII runs support Gemini 3.8 Flash Low, Medium and High, plus Gemini
4 Argon Medium and High when the authenticated model inventory includes them.
Antigravity CLI 1.2.13 and 1.3.5 have passed the capability checks. Argon requires
Google AI Ultra or an eligible Gemini Enterprise subscription; Google AI Pro
does not include it. The launcher never invents account access or substitutes
a different model.
Python is optional; action limits may be unlimited. Pause, stop and resume retain
the same Google conversation and authenticated game checkpoint. Interviews are
not implemented for this provider.

Run `node scripts/login-antigravity-benchmark.mjs` in an interactive terminal to
sign in as `mazebench@gmail.com`. Authentication is stored in the separate
`~/.mazebench/antigravity-auth` profile. Never paste codes into chat. Only its
OAuth token file is copied into each private run profile under
`~/.mazebench/antigravity-runs`; neither credentials nor provider diagnostic logs
are exposed as benchmark records. No API key or API billing is used.

## Boundary

- The custom agent has an empty native tool list, no inherited customizations,
  MCP servers, skills, plugins or subagents, and excludes default components.
- Its sole MCP server uses the existing serial MazeBench engine and Python gate.
  Records are available only through `maze_observe`. Agent-authored code is saved
  as a .py file and executed only through isolated `python_exec`, when enabled.
- Responses larger than 2,400 bytes are presented as lossless read-only pages.
  Follow the `response_pages/<sha256>/<page>.txt` links through `maze_observe`.
  Each page verifies the original response hash, rejects traversal and links,
  survives resume, and stays below Antigravity's host-file offload threshold.
  No native file reader is enabled to work around that provider behavior.
- Exact per-tool MCP permissions are granted. Shell, filesystem, web and
  browser permissions are denied. Other MCP servers are not inherited.
- Antigravity internally supplies four transport helpers: `call_mcp_tool`,
  `list_resources`, `read_resource`, and `manage_task`. None is a code executor.
  Resources are empty and never resolve host file URIs. No native/background task
  starter exists; the runner rejects background-task input.
- `init.tools` describes the GLOBAL registry, including unavailable native tools.
  Do not mistake it for the effective schema. The offline fixture intercepts the
  actual Gemini HTTP request and asserts the effective four-tool catalog.
- Settings and the exact custom-agent definition are immutable. Each record pins
  their hashes, executable hash, provider code, prompt and engine assets.
  Unexpected model/agent/tool events invalidate the run. Code or binary drift
  blocks resume; never blindly reseal an old run.

## Validation

`node --test tests/benchmark-antigravity.test.mjs` tests policy and routing.

`node scripts/check-antigravity-capabilities-v1.mjs` runs the real CLI against a
loopback fake Gemini endpoint with dummy credentials. It tests all three Flash presets,
both Python conditions, new and resumed conversations, personal instruction
isolation, effective schemas, forbidden shell/file/browser-JavaScript/notebook/
subagent calls, unknown MCP servers, and outside-file sentinels.

The offline fixture validates the Flash transport and tool boundary. Argon High
(Python off) and Medium (Python on) also passed live two-action MazeBench smoke
runs with CLI 1.3.5 and the upgraded account, including checkpoint integrity.

`node scripts/check-antigravity-live-v1.mjs` is an explicit operator-only,
subscription-consuming smoke test. It keeps separate validation records and
checks gameplay, pause/resume, stop/resume and checkpoint integrity. It does not
modify existing benchmark records. Run it only when live testing is authorized.

The first successful live smoke pair completed two actions each; the Python
condition saved and executed check.py, check2.py and parse_board.py. Subsequent
live tests exercise High effort and lifecycle transitions.

References: [custom agents](https://antigravity.google/docs/subagents/),
[permissions](https://antigravity.google/docs/permissions/),
[CLI changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md).
