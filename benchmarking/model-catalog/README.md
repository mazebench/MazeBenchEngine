# Model catalogs and launch options

The launcher uses the authenticated model inventory for each harness, including
older versions still offered to that account. Retired/unlisted models remain in
historical run records; they are not fabricated as launch options.

`ModelCatalog` refreshes each provider every five minutes while the launcher is
visible, on returning to an expired page, and on demand with **Refresh models**.
A launch revalidates the selected backend ID, effort, and speed against a fresh
catalog. Concurrent requests share one refresh. Pagination is exhaustive and
non-advancing cursors fail. Failed refreshes keep the last successful list with
its original timestamp and a visible stale/error state; stale catalogs cannot
start new runs. The private disk cache contains public model metadata only.
Existing CLI release/capability checks remain separate. No refresh upgrades a CLI
or changes a running benchmark.

Sources:

- Codex: app-server `model/list`, including hidden entries and all pages.
- Claude Code: CLI initialization capabilities plus the authenticated Anthropic
  Models API, using the same Claude Code subscription login (macOS Keychain or
  the CLI's Linux credential file). Credentials never enter logs or the cache.
- Kimi Code: the subscription `/models` endpoint, including all pages.
- Antigravity: the installed CLI's `models` inventory, including every preset.
- Grok Build: `grok models` and its refreshed, account-scoped CLI catalog. Only
  public model fields are extracted; credential and custom-header fields are not.
- Muse Code: its native authenticated MSP `model/list` operation.
- Prime: its authenticated inference catalog. Direct tool efforts and native
  workspace defaults remain distinct conditions.

The API retains exact backend model IDs. Browser groups only documented preset
suffixes into **Model**, **Reasoning**, and **Speed**. Flash, Pro, Max, Full and
Contributor remain part of actual model identities. Kimi's `kimi-for-coding`
(K2.8 Preview) and `kimi-for-coding-highspeed` (K2.7 Code) are different models,
so they never become two speeds of the same model. Speed defaults to Standard
when offered. Background refreshes preserve chosen options, including a visible
unavailable selection when the provider withdraws one.

## Runtime release and live rollout

`catalog-server.mjs` listens on localhost:8084 and forwards existing run controls
and Prime launches to the existing owner on 8083. Its private ownership markers
are under `~/.mazebench/catalog-owner`. The main server starts both companions
when free and never replaces an already-running owner. Launch manually with
`node benchmarking/catalog-server.mjs`. No current run must be paused for this
upgrade. The browser discovers 8084 first, then the previous companion.

Earlier signed provider directories remain byte-for-byte untouched. New Kimi
and Antigravity launches use `kimi-v2` / `antigravity-v2`; their Any language
releases use `kimi-code-v3` / `antigravity-code-v3` and `all-code-v3`. Kimi pins
its selected model capabilities in the signed manifest and reconstructs the
immutable configuration on every integrity check. Unsupported effort controls
are omitted for K2.7 instead of inventing a reasoning scale.

Claude's new `providers-v2`, `worlds-v2`, `slotski-v2`, and `code-v2` releases
pin speed alongside model and effort. Per-run settings explicitly enable or
disable `fastMode`. Models without an effort scale receive no `--effort` flag.
The existing exact model, tools, session, checkpoint and runtime integrity checks
remain enforced. Codex and Grok already support their catalog's native speed
mechanism and keep the existing signed transport.

These are new signed runtime releases, not permission to edit historical ones.
Once a run uses one of these runtime directories, preserve that release too.

## Verification

- `node --test tests/benchmark-model-catalog.test.mjs tests/benchmark-catalog-server.test.mjs`
- `node --test tests/benchmark-catalog-kimi-wire.test.mjs` — actual pinned Kimi
  CLI, local fake inference, resume, exact tools, and blocked escapes.
- `node scripts/check-claude-catalog-capabilities.mjs` — actual Claude CLI with
  fake local inference; standard/fast request fields, resume, compaction,
  MCP round trips and confinement. Never uses a paid inference endpoint.
- `node --test tests/benchmark-catalog-launch.test.mjs` — signed launches with
  agent turns disabled and real integrity-checking MCP gateways. Any language
  cases require the local Docker sandbox.

No model turn or billed inference is used by catalog discovery.
