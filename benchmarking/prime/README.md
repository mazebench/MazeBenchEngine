# Prime Agent

Choose **Prime Agent** on `/benchmarking/v1/`. It runs the stock Prime Agent
0.9.5 harness through Verifiers 0.3.2.dev121 in a fresh Prime sandbox. Models
come from your live Prime Inference catalog; inference and sandbox usage are
billed to your Prime account. Reasoning uses each model's provider default.

One-time setup (Python 3.13 and `uv`):

```sh
uv venv --python 3.13 ~/.mazebench/prime/venv
uv pip install --python ~/.mazebench/prime/venv/bin/python -r benchmarking/prime/requirements.txt
prime login
node server.mjs
```

Main World ASCII is supported. Prime Agent's native Python workspace is always
enabled, so the restricted Python toggle and matched-pair option do not apply.
The agent has no host mounts or repository access. Runtime network access is
restricted to framework inference and the three evaluator-owned MazeBench tools:
observe, action and sequence. The current engine, prompt and run checkpoints
remain verified by the same integrity checks as other local benchmark runs.

**Pause** takes effect at the next model/game-tool boundary and keeps the remote
sandbox alive (sandbox charges can continue). **Resume** continues that same
live conversation and workspace. **Stop**, closing the server, or a failed agent
ends the session; there is no restart-from-checkpoint resume. Run records and
replays remain available. Workspace files stay in the remote sandbox and are
not copied to the local run viewer.

Private evaluator diagnostics and the full framework trace live in
`~/.mazebench/prime/runs/<run-id>/`; only model text, token usage and game
progress enter the public run record. Existing Prime credentials are read from
`~/.prime/config.json` and never copied into the repository or agent VM.

The separately published environment under `environments/mazebench/` remains
independent. This local launcher plays against this checkout's current world.
