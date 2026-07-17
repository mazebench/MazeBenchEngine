# MazeBench Agent

Harness-neutral Verifiers v1 taskset for running MazeBench through a coding-agent
harness. The taskset supplies the maze runtime and a shell command contract; the
harness is selected separately by Verifiers.

```bash
uv run eval mazebench-agent \
  -m openai/gpt-5.4 \
  --harness.id codex \
  --harness.runtime.type prime \
  --harness.runtime.image node:24-bookworm-slim \
  -n 1 -r 1 --no-rich --no-push
```

Claude Code uses the same taskset by changing only `--harness.id` to
`claude-code`.
