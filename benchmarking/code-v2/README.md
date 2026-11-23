# Any-language coding condition

The launcher offers **Off**, **Python only**, and **Any language**. The third
condition supports Codex and Claude Code with ASCII observations in Main World,
Ice Maze, and Slotski. Other providers, vision, and interviews retain their
existing capabilities. Unsupported combinations are rejected rather than
silently converted into Python runs.

Start Docker Desktop, then build the operator-owned toolchain once:

```sh
npm run setup:code-sandbox
npm start
```

The image contains Python, Node.js, GCC/G++, Rust/Cargo, Go, Java, Ruby, Perl,
Lua, and shell/build utilities. The tier permits any language the installed
toolchain can execute; it does not promise every language or network package
installation. `MAZEBENCH_CODE_IMAGE` can select a different locally built image.
It must provide the advertised tools, `/usr/bin/env`, and GNU `timeout`.
Restart the site server to load the new supervisor; do not interrupt existing
benchmark processes just to refresh the launcher.

New API launches use `coding_mode: "off" | "python" | "any"`. The legacy
`tools_enabled` boolean still works, and old records infer off/Python from it.
An any-language run freezes `coding_mode`, the policy, executable runtime hashes,
the effective prompt, and the immutable Docker image ID. Changing the tag later
does not change a resumed run. A matched pair compares off with Python by default,
or off with any language when that tier is selected.

## Model-visible tool

`code_exec` accepts a shell `command`, optional `files: [{path, content}]`, and
`timeout_seconds` from 1 to 60. For example:

```json
{
  "files": [{"path": "solver.cpp", "content": "#include <iostream>\nint main() { std::cout << 42; }"}],
  "command": "g++ solver.cpp -O2 -o solver && ./solver",
  "timeout_seconds": 20
}
```

Files and commands are saved in the run workspace. The model gets the three
usual maze tools plus `code_exec` (Slotski can still disable sequences). It
does not get `python_exec` or the provider's native host shell/file tools.
Game observations must be supplied explicitly as data; programs cannot invoke
game tools or inspect the repository, raw state, scores, credentials, or records.

## Isolation and provenance

Each call starts a fresh, non-root Linux container with no network, a read-only
image, no capabilities, no-new-privileges, and only the run workspace mounted.
The container has 1 GiB memory, two CPUs, 64 processes, a 32 MiB per-file size
limit, a 64 MiB temporary filesystem, a 256 KB source/input limit, and a 256 KB
combined output limit. The parent enforces the wall timeout and removes the
entire container, including detached descendants. An independent in-container
deadline remains in force if the parent dies; an interrupted container is
removed before another execution. Aggregate workspace disk usage is not quota
limited. Docker and the operator-built toolchain are trusted host components.

Launch/resume preflight checks workspace writes, private path exclusion, absent
host socket, read-only root, network routing, dropped capabilities, and execution
of installed language tools. Runtime integrity is rechecked before every MCP
request and after each model turn. The serial gateway delegates only game calls
to the existing signed runtimes; it intercepts code execution. Historical
JavaScript, WASM, manifests, game state, and result records are not resealed.

Implementation follows the Docker [container runtime controls](https://docs.docker.com/engine/containers/run/).

## Verification

```sh
node --test tests/benchmark-code.test.mjs
npm run test:code-sandbox
node scripts/check-code-capabilities.mjs
```

The Docker tests exercise all advertised languages, persistent files, host and
link denial, detached-process cleanup, output and time limits, and real MCP
round trips in all three worlds. The capability script uses actual installed
CLIs against unauthenticated loopback fixtures; it makes no paid model calls.
