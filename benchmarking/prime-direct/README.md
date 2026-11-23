# Prime Inference, direct game tools

Selecting Prime and Python off runs this separately signed harness
(`prime-inference-direct-v1`). Stock Prime Agent retains its native Python
workspace in the Python and Any language conditions. Results must retain this
harness identifier: the two harnesses are not the same benchmark condition.

Models call the original MazeBench MCP tools directly through Prime's Chat
Completions endpoint. Only `maze_observe`, `maze_action`, and `maze_sequence`
are advertised and executable. No model code, files, shell, or network tools
are available. This mode needs Prime Inference credentials, not a remote VM.

The authenticated Prime catalog supplies supported effort values and context
limits. The requested reasoning configuration, output budget, compaction
threshold, and all runtime source hashes are pinned in each run's integrity
manifest. Thinking-only models use `enabled`, without inventing an effort scale.

The private conversation persists under `~/.mazebench/prime-direct/runs` and
retains provider reasoning fields and pending tool calls. Pause finishes the
current model response or tool call. Stop aborts an in-flight model request;
the provider may bill unreported tokens for that aborted request. Resume keeps
the same conversation. A process crash during a tool call requires operator
reconciliation before resume, preventing accidental duplicate actions.

At the recorded context threshold, the same model and effort summarize its
observed history. Summary requests count toward usage and cost. Compaction
events appear in telemetry. The original benchmark prompt is retained.

Run the companion with `npm run start:capabilities`; it serves API port 8083
and the existing localhost UI discovers it. Existing runs stay with their
original server owner. Never edit these runtime files while a signed run is
active; create a subsequent runtime version instead.
