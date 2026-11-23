# Codex launch versions

New catalog ASCII and vision launches check OpenAI's stable release channel.
`codex-latest.mjs` downloads the matching platform package, verifies its published
SHA-256, and keeps a separate installation under `~/.mazebench/codex-releases`.
It runs the real offline CLI wire, resume, compaction, tool-boundary, adversarial,
speed and vision checks before admitting that binary. Validation records include
the executable hash and test-source hashes. Package installation never deletes
earlier versions.

Each run records its resolved executable and hash. Existing ASCII owners select
the recorded binary per run; vision admission also uses its recorded binary.
Refreshing the launch version must not change a running or resumable record.

A failed release check or validation stops before a run is created. Long update
work continues independently, while the launch request returns a clear retry
message within 20 seconds. Completion of that background preparation never
starts a benchmark by itself. The operator may prepare the current release
without creating a run by calling `ensureLatestCodex(projectRoot)`.
