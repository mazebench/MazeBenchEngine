# Kimi Code

Choose **Kimi Code → Kimi K3.1 Pro** in the MazeBench launcher at
`http://localhost:8080/benchmarking/v1/`. Main World ASCII supports coding
**Off** or **Python only**, matched pairs, and pause/resume of the same native
Kimi conversation. Thinking is always enabled: Low, High, or Max (default).
K3.1 Pro Highspeed is also available when the authenticated catalog lists it.
Other worlds, vision, any-language coding, and interviews are not supported.

## Subscription and setup

Buy membership through [Kimi's pricing page](https://www.kimi.com/membership/pricing),
using the same account as your [Kimi Code Console](https://www.kimi.com/code/console).
As documented on October 23, 2026, **Plus** is the minimum new plan for K3.1 Pro;
**Pro** unlocks its full 1M context and Highspeed. Confirm current prices and
benefits at checkout. Highspeed uses about twice the quota of regular Pro.
See the official [model and plan matrix](https://www.kimi.com/code/docs/en/kimi-code/models.html).

Create a **Kimi Code** API key in the Console. This draws on membership quota;
the separate Moonshot Open Platform uses pay-as-you-go billing.

```sh
npm run setup:kimi
npm run check:kimi
npm start
```

Setup securely prompts for the key in the terminal. To import the already saved
Kimi Code API key from `~/.kimi-code/config.toml`, run
`npm run setup:kimi -- --import-existing`. To replace a key, use `--replace-key`.
Keys stay in `~/.mazebench/kimi/auth/credential.json`, with private permissions,
outside Git and benchmark records. No keys are printed. Catalog checking makes
no inference requests; a listed model does **not** prove paid entitlement or
remaining quota. Kimi enforces those when the run makes its first model call.
Refresh **Check installation** after changing the key or subscription.

## Verified runtime

MazeBench installs official native Kimi Code CLI **2.3.1** separately at
`~/.mazebench/kimi/bin/kimi-2.3.1`, verifying its official SHA-256. The existing
personal installation and profile are preserved. This verified integration
currently supports Apple Silicon macOS. Automatic updates are disabled for
benchmark processes; a different executable cannot silently resume a run.

Each run gets a private profile under `~/.mazebench/kimi-runs/<run-id>/`.
Its protected configuration contains exactly the three MazeBench MCP tools and,
when selected, `python_exec`. Native shell, file, web, delegation, and skill
tools are excluded. MCP requests check the signed runtime/checkpoint and private
configuration. Native session traces additionally verify the exact model and
thinking effort; credentials and diagnostic traces stay private. The model's
reply and tool stream appear in the ordinary run viewer. Cumulative token totals
are saved after turns; context/compaction charts and dollar estimates are not
reported for this provider.

```sh
node --test tests/benchmark-kimi.test.mjs
```

These tests use the actual pinned CLI against loopback inference fixtures to
verify model/effort, tool filtering, Python on/off, and same-session continuation.
They also exercise the signed game MCP and configuration-tamper rejection.
They make no paid inference calls. Existing signed runtimes and saved runs are
unchanged. Restart the site server to load the new provider when no benchmark
processes are active.
