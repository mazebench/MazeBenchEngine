# Packaging the `mazebench` CLI

The `mazebench` command is defined by the repo-root [`pyproject.toml`](../pyproject.toml):

```toml
[project.scripts]
mazebench = "mazebench_cli:main"

[project.optional-dependencies]
prime = ["verifiers @ git+https://github.com/PrimeIntellect-ai/verifiers.git@main"]
```

The Python package (`mazebench_cli/`) is intentionally tiny — it has **no hard
Python dependencies**. It is a launcher that:

1. finds the repo root (`package.json` + `scripts/maze-bridge.js`, or
   `MAZEBENCH_REPO_ROOT`),
2. translates `key=value` arguments, and
3. execs the right tool: the repo's Node scripts for local play / replay, or
   `prime` / `uv` for the Prime Intellect path.

That design keeps `pip install` light, but it has one consequence worth stating
up front: **the CLI needs the repo's Node runtime present at run time.** Node.js
is required for every run; `ffmpeg` + a Chromium-family browser are required for
replay video.

## Mode A — install from a checkout (recommended, works today)

This is the fully-working path. Clone the repo, then editable-install:

```bash
uv pip install -e .            # or: pip install -e .
uv pip install -e ".[prime]"   # add the Verifiers integration
```

`mazebench` is now on your PATH and locates the checkout via the module's
location (or `MAZEBENCH_REPO_ROOT`), so it can find the Node scripts. This is
the right distribution mode for a dev tool like this.

To let teammates install straight from Git without cloning first:

```bash
pip install "maze-bench @ git+https://github.com/<you>/PixelGameTest.git"
```

Even then, set `MAZEBENCH_REPO_ROOT` (or run from a checkout) so the CLI can
reach the Node runtime — a bare Git install of just the Python package does not
ship `scripts/`, `server/`, or `public/`.

## Mode B — build and publish to PyPI

You can build and upload wheels/sdists today:

```bash
uv build                       # writes dist/*.whl and dist/*.tar.gz
# or: python -m build

uv publish                     # or: twine upload dist/*
```

Before publishing, decide on a few things:

- **Distribution name.** The `[project].name` is currently `maze-bench`. Check
  availability on PyPI (`maze-bench`, `mazebench`, etc. may be taken) and pick a
  unique one. The *command* stays `mazebench` regardless of the dist name.
- **The `prime` extra uses a direct Git URL.** PyPI rejects direct-reference
  URLs in `[project.dependencies]`, and `allow-direct-references` only helps for
  local builds. If you publish, either drop `verifiers` from the extra (and tell
  users to `pip install verifiers` / `prime lab setup` themselves) or depend on
  a released `verifiers` version once one exists on PyPI.
- **Trusted publishing.** The modern path is a PyPI "trusted publisher" (OIDC)
  wired to a GitHub Actions workflow, so no API token is stored. Otherwise
  create a PyPI API token and `twine upload -u __token__`.

### Making a published wheel self-contained (bigger lift)

A plain `pip install mazebench` from PyPI installs only `mazebench_cli/`, so the
Node scripts are missing and the CLI will error with "Could not locate the
MazeBench repo." To make the *local play* + *replay* features work from a PyPI
install alone, you would need to:

1. Ship the Node runtime as package data. A curated subset already exists at
   `environments/mazebench/mazebench/runtime/` (kept in sync by
   `npm run sync-runtime`); include the equivalent of `scripts/`, `server/`,
   `public/`, and `games/maze/` in the wheel via `[tool.hatch.build]`.
2. Teach `find_repo_root()` to fall back to that packaged runtime dir when no
   checkout is found (e.g. `importlib.resources`).
3. Document the remaining external prerequisites the wheel cannot bundle:
   **Node.js**, **ffmpeg**, and a **browser** for video, plus the `codex` /
   `claude` CLIs for local agent runs.

Even fully bundled, the replay-video feature depends on Node + ffmpeg + a
browser being installed on the user's machine, so a "pure `pip install` and it
just works everywhere" experience is not achievable for the video path. For a
benchmark/dev tool, Mode A (checkout + editable install) is the pragmatic and
honest recommendation; publish to PyPI mainly as a convenience alias.

## Note on the two `mazebench` packages

Don't confuse these:

- `mazebench_cli` (repo root) — the `mazebench` **command** described here.
- `environments/mazebench/` — the **Verifiers environment package** (also named
  `mazebench`) that `prime env install` / `uv run eval` consume. It has its own
  `pyproject.toml` and is published to the Prime Environments Hub, not PyPI.
