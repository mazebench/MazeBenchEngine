"""mazebench: one command to run the MazeBench game locally or through Prime.

This is a thin launcher. The maze engine, the local-agent runner, and the
replay/video renderer are all Node scripts in the repo; the Prime Intellect
path shells out to the `prime` / `uv` CLIs. The CLI's job is to find the repo
root, translate friendly `key=value` arguments, and exec the right tool.

Examples
--------
    mazebench model=codex moves=10
    mazebench model=claude moves=10 level=HxI video=off
    mazebench codex moves=10            # shorthand for model=codex
    mazebench replay outputs/maze-local/codex/<run>/    # (re)make the video
    mazebench play                      # interactive human REPL
    mazebench prime install             # prime env install mazebench
    mazebench prime eval model=openai/gpt-5-nano n=1 r=1
    mazebench prime codex model=openai/gpt-5-codex max_actions=100
    mazebench prime vision model=openai/gpt-4.1-mini
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

__version__ = "0.2.1"

USAGE = """mazebench — run the MazeBench maze game

Launch the website (Play / Build / Agent modes in your browser):
  mazebench launch [port=3000 host=127.0.0.1 open=true]

Interactive setup (pick options with arrow keys):
  mazebench wizard

Local coding agent (uses YOUR Codex/Claude auth, no Prime):
  mazebench model=codex moves=10 [tools=false mode=text|vision level=HxI gems=100 video=on]
  mazebench model=claude moves=10 [tools=true mode=vision vision_width=512 model_name=<llm>]
  mazebench codex moves=10                 shorthand for model=codex
  mazebench claude moves=10 mode=vision    shorthand for model=claude

  tools=false (default) sandboxes the agent to the maze only — no reading your
  files, no writing, no network. tools=true grants full file/command/network access.

  Local runs execute inside a container by default (host filesystem isolated;
  only the output dir is mounted). Build the image once with `mazebench build`.
  Use container=false to run on the host with just the CLI sandbox.

Build the container image (one-time):
  mazebench build [image=mazebench-agent]

Replay / video from a finished run or a Prime eval dir:
  mazebench replay <session-dir | session.json | results.jsonl> [video=on fast=on]

Interactive human REPL:
  mazebench play [level=HxI view=top-diagonal]

Prime Intellect Verifiers:
  mazebench prime install
  mazebench prime eval   [model=openai/gpt-5-nano n=1 r=1 max_turns=8]
  mazebench prime codex  [model=openai/gpt-5-codex n=1 r=1 max_actions=100 max_turns=40]
  mazebench prime vision [model=openai/gpt-4.1-mini width=512 height=512 max_turns=8]

Pass dry_run=on to any local run to print the command without executing it.
Repo root is auto-detected; override with MAZEBENCH_REPO_ROOT.
"""


class CliError(RuntimeError):
    pass


def _is_repo_root(path: Path) -> bool:
    return (path / "package.json").is_file() and (path / "scripts" / "maze-bridge.js").is_file()


def find_repo_root() -> Path:
    env = os.environ.get("MAZEBENCH_REPO_ROOT")
    if env:
        candidate = Path(env).expanduser().resolve()
        if _is_repo_root(candidate):
            return candidate
        raise CliError(f"MAZEBENCH_REPO_ROOT={env!r} is not a MazeBench checkout")

    for start in (Path.cwd(), Path(__file__).resolve().parent):
        current = start
        while True:
            if _is_repo_root(current):
                return current
            if current.parent == current:
                break
            current = current.parent

    raise CliError(
        "Could not locate the MazeBench repo (looked for package.json + "
        "scripts/maze-bridge.js).\nRun from inside the checkout or set "
        "MAZEBENCH_REPO_ROOT=/path/to/PixelGameTest."
    )


def _packaged_runtime() -> Path | None:
    """The Node runtime bundled into the wheel (mazebench_cli/_runtime)."""
    candidate = Path(__file__).resolve().parent / "_runtime"
    return candidate if _is_repo_root(candidate) else None


def _workspace_dir() -> Path:
    return Path(os.environ.get("MAZEBENCH_HOME", "~/.mazebench")).expanduser() / "site"


def _materialize_workspace(runtime: Path) -> Path:
    """Copy the packaged runtime into a writable workspace (~/.mazebench/site).

    The site writes next to its root (draft worlds under games/, run artifacts
    under outputs/, account state under data/), so it cannot run from
    site-packages. Runtime code is refreshed whenever the packaged version
    changes; user content (games/draft-*, outputs/, data/, and any master-world
    edits) is left alone.
    """
    workspace = _workspace_dir()
    version_file = workspace / ".runtime-version"
    packaged_version = (runtime / ".runtime-version").read_text().strip() if (runtime / ".runtime-version").is_file() else __version__
    current_version = version_file.read_text().strip() if version_file.is_file() else ""

    if current_version != packaged_version or not _is_repo_root(workspace):
        workspace.mkdir(parents=True, exist_ok=True)
        for name in ("server", "public", "scripts", "vendor"):
            source = runtime / name
            if source.is_dir():
                shutil.copytree(source, workspace / name, dirs_exist_ok=True)
        for name in ("server.js", "package.json"):
            shutil.copy2(runtime / name, workspace / name)
        # The master world is seeded once and then owned by the user (it is
        # editable in Build Mode); draft worlds are never touched.
        if not (workspace / "games" / "maze").is_dir():
            shutil.copytree(runtime / "games" / "maze", workspace / "games" / "maze")
        version_file.write_text(f"{packaged_version}\n")
        print(f"mazebench: workspace ready at {workspace}", file=sys.stderr)

    return workspace


def resolve_root() -> Path:
    """A repo checkout if we are in one, else the pip-installed workspace."""
    try:
        return find_repo_root()
    except CliError:
        runtime = _packaged_runtime()
        if runtime is None:
            raise
        return _materialize_workspace(runtime)


def parse_args(argv: list[str]) -> tuple[list[str], dict[str, str], list[str]]:
    """Split argv into leading barewords, key=value pairs, and leftover flags."""
    words: list[str] = []
    pairs: dict[str, str] = {}
    flags: list[str] = []
    only_flags = False

    for token in argv:
        if "=" in token and not token.startswith("-"):
            key, value = token.split("=", 1)
            pairs[key.replace("-", "_")] = value
            only_flags = True
        elif token.startswith("-"):
            flags.append(token)
            only_flags = True
        elif only_flags:
            flags.append(token)
        else:
            words.append(token)

    return words, pairs, flags


def _node_bin() -> str:
    return os.environ.get("MAZEBENCH_NODE", "node")


def _require(binary: str, hint: str) -> None:
    if shutil.which(binary) is None:
        raise CliError(f"`{binary}` was not found on PATH. {hint}")


def _run(cmd: list[str], cwd: Path) -> int:
    printable = " ".join(str(part) for part in cmd)
    print(f"$ {printable}", file=sys.stderr)
    return subprocess.call(cmd, cwd=str(cwd))


def _pairs_to_kv(pairs: dict[str, str]) -> list[str]:
    return [f"{key}={value}" for key, value in pairs.items()]


def run_local(root: Path, model: str, pairs: dict[str, str], flags: list[str]) -> int:
    _require(_node_bin(), "Install Node.js (the maze engine runs on Node).")
    pairs = {"model": model, **{k: v for k, v in pairs.items() if k != "model"}}
    cmd = [_node_bin(), str(root / "scripts" / "maze-agent-local.js"), *_pairs_to_kv(pairs), *flags]
    return _run(cmd, root)


def run_replay(root: Path, words: list[str], pairs: dict[str, str], flags: list[str]) -> int:
    _require(_node_bin(), "Install Node.js.")
    target = words[0] if words else pairs.get("path") or pairs.get("dir")
    if not target:
        raise CliError("replay needs a path: mazebench replay <session-dir|results.jsonl>")
    cmd = [_node_bin(), str(root / "scripts" / "maze-export-replay.js"), target]
    if pairs.get("video", "on").lower() in ("off", "false", "0", "no"):
        cmd.append("--no-video")
    for boolean in ("fast", "draft"):
        if pairs.get(boolean, "").lower() in ("on", "true", "1", "yes"):
            cmd.append(f"--{boolean}")
    for numeric in ("width", "height", "fps"):
        if numeric in pairs:
            cmd.extend([f"--{numeric}", pairs[numeric]])
    cmd.extend(flags)
    return _run(cmd, root)


def run_play(root: Path, pairs: dict[str, str], flags: list[str]) -> int:
    _require(_node_bin(), "Install Node.js.")
    cmd = [_node_bin(), str(root / "scripts" / "maze-model-repl.js")]
    if "level" in pairs:
        cmd.extend(["--level", pairs["level"]])
    if "view" in pairs:
        cmd.extend(["--view", pairs["view"]])
    cmd.extend(flags)
    return _run(cmd, root)


def run_launch(root: Path, pairs: dict[str, str], flags: list[str]) -> int:
    """Serve the website (Play / Build / Agent modes) from `root`."""
    _require(_node_bin(), "Install Node.js (the site and maze engine run on Node).")
    port = pairs.get("port", "3000")
    host = pairs.get("host", "127.0.0.1")
    url = f"http://{'localhost' if host in ('0.0.0.0', '::') else host}:{port}"

    env = dict(os.environ, PORT=str(port), HOST=host)
    open_browser = pairs.get("open", "true").lower() not in ("off", "false", "0", "no")

    if open_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    print(f"mazebench: serving {url}  (Ctrl-C to stop)", file=sys.stderr)
    cmd = [_node_bin(), str(root / "server.js"), *flags]
    print(f"$ {' '.join(cmd)}", file=sys.stderr)

    try:
        return subprocess.call(cmd, cwd=str(root), env=env)
    except KeyboardInterrupt:
        return 0


def run_wizard(root: Path) -> int:
    _require(_node_bin(), "Install Node.js (the maze engine runs on Node).")
    return _run([_node_bin(), str(root / "scripts" / "maze-agent-local.js"), "wizard"], root)


def run_build(root: Path, pairs: dict[str, str], flags: list[str]) -> int:
    docker = pairs.get("docker_bin", "docker")
    _require(docker, "Install Docker: https://docs.docker.com/get-docker/")
    image = pairs.get("image", "mazebench-agent")
    return _run([docker, "build", "-t", image, ".", *flags], root)


def run_prime(root: Path, words: list[str], pairs: dict[str, str], flags: list[str]) -> int:
    action = (words[0] if words else pairs.get("action") or "help").lower()
    env_dir = root / "environments" / "mazebench"

    if action == "install":
        _require("prime", "Install the Prime CLI: https://docs.primeintellect.ai")
        return _run(["prime", "env", "install", "mazebench"], root)

    if action == "eval":
        # mazebench is a Verifiers v1 taskset — run it with the v1 `eval` CLI via
        # uv (not `prime eval run`, the legacy env-module loader, which cannot
        # load a v1 taskset). `--max-turns` is the per-rollout move budget.
        _require("uv", "Install uv: https://docs.astral.sh/uv/")
        model = pairs.get("model", "openai/gpt-5-nano")
        cmd = [
            "uv", "run", "eval", "mazebench",
            "-m", model,
            "-n", pairs.get("n", "1"),
            "-r", pairs.get("r", "1"),
            "--max-turns", pairs.get("max_turns", "20"),
            "--rich", "false",
            *flags,
        ]
        return _run(cmd, env_dir)

    if action == "codex":
        _require("uv", "Install uv: https://docs.astral.sh/uv/")
        model = pairs.get("model", "openai/gpt-5-codex")
        cmd = [
            "uv", "run", "eval", "mazebench_codex",
            "-m", model,
            "-n", pairs.get("n", "1"),
            "-r", pairs.get("r", "1"),
            "--taskset.max-actions", pairs.get("max_actions", "100"),
            "--max-turns", pairs.get("max_turns", "40"),
            "--rich", "false",
            *flags,
        ]
        return _run(cmd, env_dir)

    if action == "vision":
        _require("uv", "Install uv: https://docs.astral.sh/uv/")
        model = pairs.get("model", "openai/gpt-4.1-mini")
        cmd = [
            "uv", "run", "eval", "mazebench",
            "-m", model,
            "-n", pairs.get("n", "1"),
            "-r", pairs.get("r", "1"),
            "--taskset.observation-mode", "vision",
            "--taskset.vision-width", pairs.get("width", "512"),
            "--taskset.vision-height", pairs.get("height", "512"),
            "--max-turns", pairs.get("max_turns", "8"),
            "--rich", "false",
            *flags,
        ]
        return _run(cmd, env_dir)

    print(
        "mazebench prime <install|eval|codex|vision> [key=value ...]\n\n"
        "  install   prime env install mazebench\n"
        "  eval      normal multi-turn chat-model eval\n"
        "  codex     Codex CLI harness through Verifiers v1\n"
        "  vision    perspective-image observations",
        file=sys.stderr,
    )
    return 0 if action == "help" else 2


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    words, pairs, flags = parse_args(argv)

    if not words and not pairs and not flags:
        print(USAGE)
        return 0

    try:
        root = resolve_root()
        command = words[0].lower() if words else ""

        if command in ("help", "-h", "--help"):
            print(USAGE)
            return 0
        if command in ("launch", "serve", "site", "web"):
            return run_launch(root, pairs, flags)
        if command in ("wizard", "setup"):
            return run_wizard(root)
        if command == "build":
            return run_build(root, pairs, flags)
        if command == "prime":
            return run_prime(root, words[1:], pairs, flags)
        if command == "replay":
            return run_replay(root, words[1:], pairs, flags)
        if command == "play":
            return run_play(root, pairs, flags)
        if command in ("codex", "claude"):
            return run_local(root, command, pairs, flags)
        if command in ("local", "run", ""):
            model = pairs.get("model", "").lower()
            if model not in ("codex", "claude"):
                raise CliError(
                    "Specify which local agent: model=codex or model=claude "
                    "(e.g. `mazebench model=codex moves=10`)."
                )
            return run_local(root, model, pairs, flags)

        raise CliError(f"Unknown command: {command!r}. Run `mazebench help`.")
    except CliError as error:
        print(f"mazebench: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
