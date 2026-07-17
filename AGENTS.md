# Codex Repository Instructions

These instructions apply to the entire MazeBenchEngine repository.

## Branch-first development

- Do not commit or push ordinary work directly to `main` unless the user explicitly overrides this rule.
- Start work from the current `origin/main` on a focused `codex/<task>` branch.
- Commit and push the branch, run the relevant tests, and open a pull request for the user to review.
- Do not merge the pull request until the user says the branch is approved. After approval, merge it and verify `main` CI.
- A branch push, pull request, or merge does not by itself authorize a package release.

## Explicit release gate

After an approved change is merged to `main` and CI is green, explicitly ask whether the user wants a new PyPI release. Include the proposed next version in the question and briefly state why the change warrants that version bump.

Do not create a release tag, publish a GitHub Release, manually dispatch the PyPI workflow, or upload to PyPI until the user answers yes.

When the user approves the proposed release, that approval authorizes Codex to complete the release workflow without asking at every intermediate step:

1. Create a focused `codex/release-<version>` branch from current `origin/main`.
2. Update every root-package version source, including `[project].version` in `pyproject.toml` and `mazebench_cli.__version__`, and check for any other synchronized version references.
3. Build the packaged runtime, wheel, and source distribution; run the Node tests and supported Python wheel smoke tests.
4. Push the release branch, merge it after its checks pass, and verify `main` is green.
5. Create the repository's customary GitHub tag/release for that version. Unless the user requests a stable release, follow the existing alpha prerelease convention.
6. Monitor the `Publish to PyPI` workflow through completion and verify that the exact version is available from PyPI.

PyPI versions are immutable. If publishing partially succeeds, inspect PyPI before retrying and never attempt to upload different artifacts under the same version.

## Prime Environment Hub releases

The Prime environment under `environments/mazebench` has its own version and release lifecycle; it is not tied automatically to the root PyPI package version.

- Propose a Prime environment version bump only when the environment package, bundled runtime, behavior, packaging, or dependencies changed. Dependency-only changes count.
- Documentation-only or root-CLI-only changes do not require a Prime environment bump.
- When a Prime bump is warranted, include it in the post-merge release question alongside the PyPI proposal.
- After approval, update the environment package version and the version pin in `configs/rl/mazebench.toml`, push the environment, monitor the Hub action, and verify it reaches `SUCCESS`.

## MazeJam promotion

MazeJam consumes MazeBenchEngine assets but deploys independently through Cloudflare Pages. If an approved engine change alters assets consumed by MazeJam, mention that in the post-merge handoff and ask whether to synchronize and deploy MazeJam. Do not assume that a PyPI or Prime release also authorizes a site deployment.
