# Prime automatic recovery

The capability server enables automatic recovery when it launches or manually
resumes a Prime direct MCP run (Python off, harness v1 or v2). It checks enrolled
runs every five seconds. It never adopts unrelated historical, paused, or
completed runs. Native Prime VM sessions are not covered: their current harness
cannot reconstruct a terminated remote session.

Temporary HTTP 408/425/429/5xx failures, network timeouts, missing/malformed model
responses, incomplete context summaries, and safe MCP disconnections retry from
the saved conversation. Known HTTP 422 messages missing assistant content receive
an empty content field. Idle/output-budget failures receive a generic instruction
to continue, with their idle counter reset. Those conversation repairs retain the
original bytes in a private backup and append a recovery audit. Model settings,
reasoning effort, usage, prompt, and game checkpoints remain unchanged.

Retries wait 15, 30, 60, 120, 240, then 300 seconds. After eight retries without
another accepted game action, recovery stops and shows **Needs attention**.
There is also a ceiling of twelve retries per hour even when actions advance.
Manual Resume starts a fresh retry allowance. Authentication/configuration
errors, unrecognized request validation errors, integrity failures, and ambiguous
in-flight tool calls stop for operator review; recovery never replays an
ambiguous action or launches a replacement benchmark.

The run page and library show **Auto-resuming**, its retry number/time and reason.
Pause or Stop cancels queued recovery; Resume enables it again. Per-run control
operations serialize, including repairs and manual resumes. Completed games are
never resumed. State and audit events live beside the private conversation as
`auto-recovery.json` and `auto-recovery-events.jsonl`, so backoff, attempt counts,
and manual cancellations survive a server restart. An enrolled run interrupted
by a server restart can recover only if its saved checkpoint/conversation pass
the same safety checks.

The existing external watchdog yields to the owner's `auto_recovery.managed`
field, including blocked and manually cancelled states. It therefore cannot
override the built-in retry limit. Recovery runs while the local server and Mac
are awake; it does not itself start a stopped server or wake the machine.

Verification: `node --test tests/benchmark-prime-auto-recovery.test.mjs
tests/benchmark-capability-server.test.mjs tests/benchmark-run-watchdog.test.mjs
tests/benchmark-idle-recovery.test.mjs tests/benchmark-prime-message-recovery.test.mjs`.
