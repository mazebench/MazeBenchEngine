# Meta Muse Code

Select **Meta Muse Code** in the benchmark launcher's Agent menu. It uses the
existing Meta subscription login and lists models from the authenticated Muse
catalog. Main World ASCII runs support the usual action limit, pause/resume,
and optional isolated Python workspace.

The verified CLI is Muse Code `1.4.7-R6101.1`, installed separately at
`~/.mazebench/muse/bin/muse-1.4.7-R6101.1`. Its official macOS arm64/x64 binary
hashes are pinned in `policy.mjs`; unverified versions cannot launch runs.
This leaves other checkouts' Muse installations unchanged.

[`muse-wonder-full-1.0`](https://dev.meta.ai/models/muse-wonder) requires Power
Usage or Maximum Usage. The launcher uses the authenticated catalog's exact model
IDs and reasoning presets. Full's High and Max presets have passed live MazeBench
smoke runs with CLI 1.4.7; ordinary Wonder is never substituted.

The private login lives at
`~/.mazebench/muse/auth/credential.json` (mode 0600). Each run receives a
private profile under `~/.mazebench/muse-runs/`, outside benchmark records.
The launcher supplies that existing credential through `META_API_KEY`, without
importing legacy auth files into Keychain. Credentials must never be committed or copied into public records. Refresh the
private login if Meta requires signing in again.

Muse's exact named toolset contains only `maze_observe`, `maze_action`,
`maze_sequence`, and, when enabled, `python_exec`. Shell, file, web, delegation,
personal context, and session messaging are unavailable. Each tool request
passes the signed run/checkpoint checks; executable, provider code, immutable
configuration, prompt, and exact model are pinned for the run. Existing runs
retain their previous providers and asset hashes.

Run `node --test tests/benchmark-muse.test.mjs` to verify configuration and
model/tool guards. When the pinned CLI is present, the tests also inspect its
actual outbound tool catalog through a local fake provider, without using
subscription credentials or making real inference requests.
