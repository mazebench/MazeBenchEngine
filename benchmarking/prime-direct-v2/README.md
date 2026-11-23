# Prime Inference direct tools, v2

This is a separate signed release of `prime-direct-v1`. Its three game tools,
saved conversation, reasoning controls, pause/resume, and usage accounting are
unchanged. See ../prime-direct/README.md for the common contract.

V2 starts compaction at half the advertised context window (or earlier when
the reserved output requires it). It leaves space for large game observations.
For a generic HTTP 400, Prime's response to input plus output exceeding context,
it retries with half the output budget, at most four times, never below 4,096.
Every successful response records its effective output budget and retry count.
Messages, tool availability, and reasoning effort stay unchanged. Other 400s
still fail after this bounded retry; no rejected request executes game actions.

V1 runs keep their original runtime bytes and configuration, including on
resume. New runs use v2. Never migrate or reseal an existing run silently.
