from __future__ import annotations

import json
import os
import re
import select
import signal
import shlex
import subprocess
import atexit
from importlib.resources import files
from pathlib import Path
from string import Template
from typing import Any, Literal

from pydantic import Field

import verifiers.v1 as vf


DEFAULT_GAME_ID = "maze"
DEFAULT_START_LEVEL_ID = "level_HxI"
DEFAULT_VIEW = "top-diagonal"
DEFAULT_YAW = 0
DEFAULT_NODE_BIN = "node"
DEFAULT_TIMEOUT_SECONDS = 20
DEFAULT_MAX_TURNS = 40
DEFAULT_TARGET_GEMS = 0
DEFAULT_OBSERVATION_MODE = "ascii"
DEFAULT_VISION_HEIGHT = 512
DEFAULT_VISION_WIDTH = 512
GAME_WON_GEM_COUNT = 100
REPO_ROOT_ENV = "MAZEBENCH_REPO_ROOT"
INFO_KEY = "mazebench"

DEATH_MESSAGE = "The player died, you must now undo or reset or go to a level."
ALIVE_ALLOWED_COMMANDS = (
    "up",
    "down",
    "left",
    "right",
    "rotate camera up",
    "rotate camera down",
    "rotate camera left",
    "rotate camera right",
    "undo",
    "reset",
    "go to level X Y",
    "quit",
)
DEAD_ALLOWED_COMMANDS = (
    "undo",
    "reset",
    "go to level X Y",
)

PROMPT_DIR = "prompts"
MULTITURN_SYSTEM_PROMPT_FILE = "multiturn_system.txt"
MULTITURN_USER_PROMPT_FILE = "multiturn_user.txt"
INFO_ROW_FIELD_NAMES = {
    "game_won_gem_count",
    "level_id",
    "node_bin",
    "repo_root",
    "target_gems",
    "timeout_seconds",
    "view",
    "yaw",
}
def read_prompt_file(filename: str) -> str:
    return (
        files(__package__ or "mazebench")
        .joinpath(PROMPT_DIR, filename)
        .read_text(encoding="utf8")
        .rstrip()
    )


def render_prompt_file(filename: str, **values: object) -> str:
    return Template(read_prompt_file(filename)).substitute(
        {key: str(value) for key, value in values.items()}
    )


MULTITURN_SYSTEM_PROMPT = read_prompt_file(MULTITURN_SYSTEM_PROMPT_FILE)

LEVEL_ID_PATTERN = re.compile(r"^(?:level_)?([A-Z])x([A-Z])$")


def normalize_level_id(value: str | None) -> str:
    level_id = str(value or DEFAULT_START_LEVEL_ID).strip()
    match = LEVEL_ID_PATTERN.fullmatch(level_id)

    if not match:
        return level_id

    return f"level_{match.group(1)}x{match.group(2)}"


def parse_level_ids(
    level_ids: str | list[str] | tuple[str, ...] | None,
    start_level_id: str,
) -> list[str]:
    if level_ids is None:
        return [normalize_level_id(start_level_id)]

    if isinstance(level_ids, str):
        values = [
            part.strip()
            for part in re.split(r"[,\\s]+", level_ids)
            if part.strip()
        ]
    else:
        values = [str(part).strip() for part in level_ids if str(part).strip()]

    return [normalize_level_id(value) for value in values] or [
        normalize_level_id(start_level_id)
    ]


def has_terminal_runner(root: Path) -> bool:
    return (root / "scripts" / "maze-terminal.js").is_file()


def has_bridge_runner(root: Path) -> bool:
    return (root / "scripts" / "maze-bridge.js").is_file()


def find_repo_root(configured_root: str | None = None) -> Path:
    candidates: list[Path] = []

    if configured_root:
        candidates.append(Path(configured_root).expanduser())

    env_root = os.environ.get(REPO_ROOT_ENV)
    if env_root:
        candidates.append(Path(env_root).expanduser())

    candidates.append(Path.cwd())
    candidates.append(Path(__file__).resolve().parent / "runtime")
    candidates.extend(Path(__file__).resolve().parents)

    for candidate in candidates:
        resolved = candidate.resolve()
        for root in (resolved, *resolved.parents):
            if has_terminal_runner(root):
                return root

    raise RuntimeError(
        "Could not locate scripts/maze-terminal.js. Run from the MazeBench repo "
        f"or set {REPO_ROOT_ENV}=/path/to/MazeBench."
    )


def find_bridge_root(configured_root: str | None = None) -> Path:
    root = find_repo_root(configured_root)

    if has_bridge_runner(root):
        return root

    raise RuntimeError(
        "Could not locate scripts/maze-bridge.js. Run from the MazeBench repo "
        f"or set {REPO_ROOT_ENV}=/path/to/MazeBench."
    )


def run_terminal_json(
    *,
    level_id: str,
    node_bin: str,
    repo_root: Path,
    timeout_seconds: int,
    view: str,
    yaw: int,
) -> dict[str, Any]:
    script_path = repo_root / "scripts" / "maze-terminal.js"
    command = [
        node_bin,
        str(script_path),
        "--level",
        normalize_level_id(level_id),
        "--view",
        view,
        "--yaw",
        str(int(yaw)),
        "--json",
    ]

    result = subprocess.run(
        command,
        cwd=repo_root,
        capture_output=True,
        check=False,
        encoding="utf8",
        timeout=timeout_seconds,
    )

    if result.returncode != 0:
        raise RuntimeError(
            "maze-terminal.js failed with exit code "
            f"{result.returncode}: {(result.stderr or result.stdout).strip()}"
        )

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"maze-terminal.js returned invalid JSON: {result.stdout[:500]}"
        ) from error


def target_text_for_row(row: dict[str, Any]) -> str:
    target_gems = int(row.get("target_gems") or 0)
    if target_gems > 0:
        return (
            f"Collect at least {target_gems} unique gem"
            f"{'' if target_gems == 1 else 's'}."
        )

    game_won_gem_count = int(row.get("game_won_gem_count") or GAME_WON_GEM_COUNT)
    return (
        f"Collect {game_won_gem_count} unique gem"
        f"{'' if game_won_gem_count == 1 else 's'} to win."
    )


def player_fields(player: dict[str, Any] | None) -> dict[str, object]:
    player = player or {}
    return {
        "player_elevation": player.get("elevation", "?"),
        "player_x": player.get("x", "?"),
        "player_y": player.get("y", "?"),
    }


def status_player_dead(status: dict[str, Any]) -> bool:
    return bool(status.get("player_dead"))


def allowed_commands_for_status(status: dict[str, Any]) -> tuple[str, ...]:
    raw_commands = status.get("allowed_commands")
    if isinstance(raw_commands, list) and raw_commands:
        return tuple(str(command) for command in raw_commands)
    return DEAD_ALLOWED_COMMANDS if status_player_dead(status) else ALIVE_ALLOWED_COMMANDS


def allowed_commands_text(status: dict[str, Any]) -> str:
    return "\n".join(f"- {command}" for command in allowed_commands_for_status(status))


def death_text(status: dict[str, Any]) -> str:
    return DEATH_MESSAGE if status_player_dead(status) else ""


def terminal_note_text(status: dict[str, Any]) -> str:
    return "" if status_player_dead(status) else "Typing quit ends the run as a loss."


def response_instruction(status: dict[str, Any]) -> str:
    if status_player_dead(status):
        return "Respond with exactly one command line: `undo`, `reset`, or `go to level H I`."
    return (
        "Respond with exactly one command line, such as `up`, `down`, "
        "`rotate camera left`, `go to level H I`, or `quit`."
    )


def render_multiturn_user_prompt(
    *,
    status: dict[str, Any],
    target_text: str,
    result_text: str,
) -> str:
    visited_rooms = status.get("visited_levels") or []
    return render_prompt_file(
        MULTITURN_USER_PROMPT_FILE,
        allowed_commands=allowed_commands_text(status),
        current_room=status.get("current_room") or status.get("level_id") or "?",
        current_view=status.get("current_view") or status.get("view") or "?",
        death_text=death_text(status),
        gem_count=status.get("gem_count", 0),
        level=status.get("level") or status.get("observation") or "",
        response_instruction=response_instruction(status),
        result_text=result_text,
        target_text=target_text,
        terminal_note=terminal_note_text(status),
        visited_rooms=", ".join(str(room) for room in visited_rooms) or "(none)",
        yaw=status.get("yaw", 0),
        **player_fields(status.get("player")),
    )


def render_vision_user_prompt(
    *,
    status: dict[str, Any],
    target_text: str,
    result_text: str,
) -> str:
    visited_rooms = status.get("visited_levels") or []
    current_room = status.get("current_room") or status.get("level_id") or "?"
    current_view = status.get("current_view") or status.get("view") or "?"
    fields = player_fields(status.get("player"))
    lines = [
        result_text,
        "",
        f"Objective: {target_text}",
        "",
        f"Current room: `{current_room}`",
        f"Current view: {current_view}",
        f"Yaw: {status.get('yaw', 0)}",
        (
            "Player: "
            f"x={fields['player_x']} "
            f"y={fields['player_y']} "
            f"elevation={fields['player_elevation']}"
        ),
        f"Gems collected: {status.get('gem_count', 0)}",
        "Visited rooms: " + (", ".join(str(room) for room in visited_rooms) or "(none)"),
    ]
    death = death_text(status)
    if death:
        lines.append(death)
    lines.extend(
        [
            "",
            "The current maze view is attached as a perspective image. Do not rely on an ASCII board.",
            "",
            "Allowed commands:",
            allowed_commands_text(status),
            "",
            terminal_note_text(status),
            response_instruction(status),
        ]
    )
    return "\n".join(line for line in lines if line is not None)


def valid_action_commands(actions: list[dict[str, Any]]) -> list[str]:
    return [
        str(action.get("command") or "").strip()
        for action in actions
        if action and action.get("valid") is not False and action.get("command")
    ]


def render_vision_frame_data_url(
    *,
    actions: list[str],
    task: "MazeBenchTask",
) -> str:
    payload = {
        "actions": actions,
        "draft": True,
        "fast": True,
        "gameId": task.game_id,
        "height": int(task.vision_height),
        "levelId": task.level_id,
        "width": int(task.vision_width),
        "yaw": int(task.yaw),
    }
    result = subprocess.run(
        [
            task.node_bin,
            str(Path(task.repo_root) / "scripts" / "maze-render-frame.js"),
        ],
        input=json.dumps(payload),
        capture_output=True,
        cwd=task.repo_root,
        encoding="utf8",
        timeout=max(30, int(task.timeout_seconds)),
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "maze-render-frame.js failed: "
            + (result.stderr.strip() or result.stdout.strip() or "unknown error")
        )
    try:
        response = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"maze-render-frame.js returned invalid JSON: {result.stdout[:500]}"
        ) from error
    data_url = str(response.get("data_url") or "")
    if not data_url.startswith("data:image/png;base64,"):
        raise RuntimeError("maze-render-frame.js did not return a PNG data URL")
    return data_url


def make_row(
    *,
    example_id: int,
    game_won_gem_count: int,
    level_id: str,
    node_bin: str,
    repo_root: Path,
    target_gems: int,
    timeout_seconds: int,
    view: str,
    yaw: int,
) -> dict[str, Any]:
    payload = run_terminal_json(
        level_id=level_id,
        node_bin=node_bin,
        repo_root=repo_root,
        timeout_seconds=timeout_seconds,
        view=view,
        yaw=yaw,
    )
    row = {
        "example_id": example_id,
        "game_id": DEFAULT_GAME_ID,
        "game_won_gem_count": int(game_won_gem_count),
        "level_id": str(payload["levelId"]),
        "node_bin": node_bin,
        "observation": str(payload["observation"]),
        "repo_root": str(repo_root),
        "target_gems": int(target_gems),
        "timeout_seconds": int(timeout_seconds),
        "view": str(payload["view"]),
        "yaw": int(payload["yaw"]),
    }
    row["info"] = json.dumps(
        {
            INFO_KEY: {
                field: row[field]
                for field in INFO_ROW_FIELD_NAMES
                if field in row
            }
        }
    )
    return row


def build_rows(
    *,
    count: int,
    game_won_gem_count: int,
    level_ids: list[str],
    node_bin: str,
    repo_root: Path,
    target_gems: int,
    timeout_seconds: int,
    view: str,
    yaw: int,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    safe_count = max(0, int(count))

    for index in range(safe_count):
        level_id = level_ids[index % len(level_ids)]
        rows.append(
            make_row(
                example_id=index,
                game_won_gem_count=game_won_gem_count,
                level_id=level_id,
                node_bin=node_bin,
                repo_root=repo_root,
                target_gems=target_gems,
                timeout_seconds=timeout_seconds,
                view=view,
                yaw=yaw,
            )
        )

    return rows


class MazeSession:
    def __init__(
        self,
        *,
        game_won_gem_count: int,
        level_id: str,
        node_bin: str,
        repo_root: str,
        timeout_seconds: int,
        view: str,
        yaw: int,
    ) -> None:
        self.repo_root = Path(repo_root)
        self.timeout_seconds = int(timeout_seconds)
        self.process = subprocess.Popen(
            [
                node_bin,
                str(self.repo_root / "scripts" / "maze-bridge.js"),
                "--game-won-gem-count",
                str(int(game_won_gem_count)),
                "--level",
                normalize_level_id(level_id),
                "--view",
                view,
                "--yaw",
                str(int(yaw)),
            ],
            cwd=self.repo_root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf8",
        )

    def request(self, command: str, **kwargs: Any) -> dict[str, Any]:
        if self.process.poll() is not None:
            raise RuntimeError("maze bridge process is not running")

        if self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("maze bridge pipes are unavailable")

        payload = {"command": command, **kwargs}
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()

        ready, _, _ = select.select(
            [self.process.stdout], [], [], self.timeout_seconds
        )
        if not ready:
            self.close(kill=True)
            raise TimeoutError(f"maze bridge timed out waiting for {command!r}")

        line = self.process.stdout.readline()
        if not line:
            stderr = self.process.stderr.read() if self.process.stderr else ""
            raise RuntimeError(f"maze bridge closed unexpectedly: {stderr.strip()}")

        result = json.loads(line)
        if not result.get("ok"):
            raise RuntimeError(str(result.get("error") or "maze bridge command failed"))

        return result

    def close(self, kill: bool = False) -> None:
        if self.process.poll() is not None:
            return

        try:
            if kill:
                self.process.send_signal(signal.SIGTERM)
            else:
                try:
                    self.request("close")
                except Exception:
                    self.process.terminate()
        finally:
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()


COMMAND_ALIASES = {
    "close": "quit",
    "go_to_level": "goto_level",
    "goto": "goto_level",
    "goto_level": "goto_level",
    "move": "move",
    "quit": "quit",
    "reset": "reset_level",
    "reset_level": "reset_level",
    "rotate": "rotate_camera",
    "rotate_camera": "rotate_camera",
    "undo": "undo",
}
DIRECTIONS = {"up", "down", "left", "right"}


def strip_code_fence(text: str) -> str:
    stripped = text.strip()
    fence = re.fullmatch(r"```(?:\w+)?\s*(.*?)\s*```", stripped, re.DOTALL)
    return fence.group(1).strip() if fence else stripped


def parse_json_action(value: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    if "command" in value:
        return normalize_action(str(value["command"]), value)

    function_value = value.get("function") or value.get("function_call") or {}
    name = value.get("name") or value.get("tool") or function_value.get("name")
    raw_args = value.get("arguments") or value.get("args") or function_value.get("arguments") or {}

    if isinstance(raw_args, str):
        raw_args = json.loads(raw_args) if raw_args.strip().startswith("{") else {}

    if not isinstance(raw_args, dict):
        raw_args = {}

    return normalize_action(str(name or ""), raw_args)


def parse_key_value_args(text: str) -> dict[str, str]:
    args: dict[str, str] = {}
    positional: list[str] = []

    for part in [part.strip() for part in text.split(",") if part.strip()]:
        key, separator, value = part.partition("=")
        if not separator:
            key, separator, value = part.partition(":")

        if separator:
            args[key.strip()] = value.strip().strip("\"'")
        else:
            positional.extend(shlex.split(part))

    if positional:
        args["_positional"] = positional

    return args


def normalize_action(command: str, args: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    raw_command = str(command or "").strip().lower().replace(" ", "_")
    if raw_command in DIRECTIONS:
        return "move", {"direction": raw_command}

    normalized = COMMAND_ALIASES.get(raw_command)
    positional = list(args.get("_positional") or [])

    if not normalized:
        raise ValueError(f"unknown command: {command}")

    if normalized in {"move", "rotate_camera"}:
        direction = str(args.get("direction") or (positional[0] if positional else "")).lower()
        if direction not in DIRECTIONS:
            raise ValueError(
                f"{normalized} requires direction: up, down, left, or right"
            )
        return normalized, {"direction": direction}

    if normalized in {"undo", "reset_level", "quit"}:
        return normalized, {}

    x = str(args.get("x") or (positional[0] if len(positional) >= 1 else "")).upper()
    y = str(args.get("y") or (positional[1] if len(positional) >= 2 else "")).upper()
    if not re.fullmatch(r"[A-Z]", x) or not re.fullmatch(r"[A-Z]", y):
        raise ValueError("go to level requires two world coordinate letters, e.g. go to level H I")

    return normalized, {"x": x, "y": y}


def parse_text_action(text: str) -> tuple[str, dict[str, Any]]:
    cleaned = strip_code_fence(text)
    first_line = next((line.strip() for line in cleaned.splitlines() if line.strip()), "")

    if not first_line:
        raise ValueError("empty response")

    if first_line.startswith("{"):
        parsed = json.loads(first_line)
        if not isinstance(parsed, dict):
            raise ValueError("JSON action must be an object")
        return parse_json_action(parsed)

    function_match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)", first_line)
    if function_match:
        return normalize_action(function_match.group(1), parse_key_value_args(function_match.group(2)))

    tokens = shlex.split(first_line)
    if not tokens:
        raise ValueError("empty response")

    lowered = [token.lower() for token in tokens]
    if len(tokens) == 1 and lowered[0] in DIRECTIONS:
        return "move", {"direction": lowered[0]}

    if len(tokens) >= 3 and lowered[:2] == ["rotate", "camera"]:
        return normalize_action("rotate_camera", {"_positional": tokens[2:]})

    if len(tokens) >= 5 and lowered[:3] == ["go", "to", "level"]:
        return normalize_action("goto_level", {"_positional": tokens[3:]})

    args: dict[str, Any] = {}
    positional: list[str] = []
    for token in tokens[1:]:
        key, separator, value = token.partition("=")
        if separator:
            args[key] = value.strip("\"'")
        else:
            positional.append(token.strip("\"'"))

    if positional:
        args["_positional"] = positional

    return normalize_action(tokens[0], args)


def scorecard_text(status: dict[str, Any]) -> str:
    return json.dumps(status.get("scorecard") or {}, indent=2)


def action_result_text(
    *,
    command: str | None = None,
    error: str | None = None,
    status: dict[str, Any] | None = None,
) -> str:
    if error:
        return f"Previous response was invalid: {error}"

    status = status or {}
    action = status.get("action") or command or "action"
    details = [f"Previous action: {action}."]

    if "direction" in status:
        details.append(f"Direction: {status['direction']}.")
    if "moved" in status:
        details.append(f"Moved: {str(bool(status['moved'])).lower()}.")
    if status.get("room_changed"):
        details.append(f"Entered room: {status.get('current_room')}.")
    if status.get("destination_room"):
        details.append(f"Jumped to room: {status.get('destination_room')}.")
    if status.get("collected_this_action"):
        details.append(
            "Collected gems: "
            + ", ".join(str(gem) for gem in status["collected_this_action"])
            + "."
        )
    if status_player_dead(status):
        details.append(DEATH_MESSAGE)
    is_terminal = status.get("quit") or status.get("game_lost") or status.get("game_won")
    if is_terminal and status.get("scorecard"):
        details.append("Final scorecard:\n" + scorecard_text(status))

    return " ".join(details)


def canonical_command_text(command: str, args: dict[str, Any]) -> str:
    if command == "move":
        return str(args.get("direction") or "")
    if command == "rotate_camera":
        return f"rotate camera {args.get('direction') or ''}".strip()
    if command == "goto_level":
        return f"go to level {args.get('x') or ''} {args.get('y') or ''}".strip()
    if command == "reset_level":
        return "reset"
    if command in {"undo", "quit"}:
        return command
    return command


def slim_status(status: dict[str, Any] | None) -> dict[str, Any]:
    status = status or {}
    keys = (
        "action",
        "action_count",
        "allowed_commands",
        "collected_gems",
        "collected_this_action",
        "current_room",
        "current_view",
        "death_message",
        "destination_room",
        "game_lost",
        "game_won",
        "gem_count",
        "moved",
        "player",
        "player_dead",
        "quit",
        "room_changed",
        "solved",
        "visited_levels",
        "yaw",
    )
    return {key: status[key] for key in keys if key in status}


def record_maze_action(
    state: vf.State,
    *,
    action_args: dict[str, Any] | None = None,
    command: str | None = None,
    error: str | None = None,
    raw_response: str = "",
    status: dict[str, Any] | None = None,
) -> None:
    action_args = action_args or {}
    current_actions = (
        state.get("maze_actions", [])
        if isinstance(state, dict)
        else getattr(state, "maze_actions", [])
    )
    record = {
        "turn": len(current_actions or []) + 1,
        "valid": error is None,
        "raw_response": raw_response.strip(),
        "command": (
            canonical_command_text(command, action_args)
            if command is not None and error is None
            else None
        ),
        "normalized_action": command,
        "args": action_args,
        "error": error,
        "status": slim_status(status),
    }
    if isinstance(state, dict):
        state.setdefault("maze_actions", []).append(record)
    else:
        actions = list(current_actions or [])
        actions.append(record)
        state.maze_actions = actions


def set_maze_scorecard(state: vf.State, scorecard: dict[str, Any] | None) -> None:
    if not isinstance(scorecard, dict):
        return

    if isinstance(state, dict):
        state["maze_scorecard"] = scorecard
        replay = state.get("maze_replay")
    else:
        state.maze_scorecard = scorecard
        replay = getattr(state, "maze_replay", None)
    if isinstance(replay, dict):
        replay["scorecard"] = scorecard
        if not isinstance(state, dict):
            state.maze_replay = replay


class MazeBenchTask(vf.Task):
    example_id: int
    game_id: str = DEFAULT_GAME_ID
    game_won_gem_count: int = GAME_WON_GEM_COUNT
    level_id: str = DEFAULT_START_LEVEL_ID
    node_bin: str = DEFAULT_NODE_BIN
    observation: str = ""
    observation_mode: Literal["ascii", "vision"] = DEFAULT_OBSERVATION_MODE
    repo_root: str = ""
    target_gems: int = DEFAULT_TARGET_GEMS
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    view: str = DEFAULT_VIEW
    vision_height: int = DEFAULT_VISION_HEIGHT
    vision_width: int = DEFAULT_VISION_WIDTH
    yaw: int = DEFAULT_YAW


class MazeBenchConfig(vf.TasksetConfig):
    id: vf.EnvId = "mazebench"
    num_examples: int = 1
    level_ids: str | list[str] | None = None
    start_level_id: str = DEFAULT_START_LEVEL_ID
    view: str = DEFAULT_VIEW
    yaw: int = DEFAULT_YAW
    game_won_gem_count: int = GAME_WON_GEM_COUNT
    node_bin: str = DEFAULT_NODE_BIN
    observation_mode: Literal["ascii", "vision"] = DEFAULT_OBSERVATION_MODE
    repo_root: str | None = None
    target_gems: int = DEFAULT_TARGET_GEMS
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    vision_height: int = DEFAULT_VISION_HEIGHT
    vision_width: int = DEFAULT_VISION_WIDTH
    system_prompt: str = MULTITURN_SYSTEM_PROMPT
    user: vf.UserConfig = Field(default_factory=vf.UserConfig)


class MazeBenchState(vf.State):
    game_lost: bool = False
    game_won: bool = False
    maze_actions: list[dict[str, Any]] = Field(default_factory=list)
    maze_replay: dict[str, Any] = Field(default_factory=dict)
    maze_scorecard: dict[str, Any] = Field(default_factory=dict)
    maze_status: dict[str, Any] = Field(default_factory=dict)
    maze_status_error: str = ""


class MazeBenchUser(vf.User[vf.UserConfig, MazeBenchState]):
    async def setup_task(self, task: MazeBenchTask) -> None:
        self.task = task
        self.session = MazeSession(
            game_won_gem_count=task.game_won_gem_count,
            level_id=task.level_id,
            node_bin=task.node_bin,
            repo_root=task.repo_root or str(find_bridge_root()),
            timeout_seconds=task.timeout_seconds,
            view=task.view,
            yaw=task.yaw,
        )
        atexit.register(self.close_session)

    def build_user_message(self, status: dict[str, Any], result_text: str) -> vf.Messages:
        task = self.task
        target_text = target_text_for_row(task.model_dump())
        if task.observation_mode != "vision":
            return [
                {
                    "role": "user",
                    "content": render_multiturn_user_prompt(
                        status=status,
                        target_text=target_text,
                        result_text=result_text,
                    ),
                }
            ]

        data_url = render_vision_frame_data_url(
            actions=valid_action_commands(self.state.maze_actions),
            task=task,
        )
        return [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": render_vision_user_prompt(
                            status=status,
                            target_text=target_text,
                            result_text=result_text,
                        ),
                    },
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ]

    def close_session(self) -> None:
        session = getattr(self, "session", None)
        if isinstance(session, MazeSession):
            session.close()
            self.session = None

    def initialize_state(self, status: dict[str, Any]) -> None:
        task = self.task
        self.state.maze_actions = []
        self.state.maze_scorecard = {}
        self.state.maze_status = status
        self.state.maze_status_error = ""
        self.state.game_lost = False
        self.state.game_won = False
        self.state.maze_replay = {
            "game_id": task.game_id,
            "game_won_gem_count": int(task.game_won_gem_count),
            "initial": slim_status(status),
            "start_level_id": task.level_id,
            "target_gems": int(task.target_gems),
            "actions": self.state.maze_actions,
            "scorecard": None,
        }

    def update_terminal_flags(self, status: dict[str, Any]) -> None:
        task = self.task
        self.state.game_lost = bool(status.get("game_lost") or status.get("quit"))
        self.state.game_won = bool(
            status.get("game_won")
            or int(status.get("gem_count") or 0) == int(task.game_won_gem_count)
        )

    def record_scorecard(self, status: dict[str, Any]) -> None:
        scorecard = status.get("scorecard")
        if not isinstance(scorecard, dict):
            return
        self.state.maze_scorecard = scorecard
        replay = dict(self.state.maze_replay or {})
        replay["scorecard"] = scorecard
        self.state.maze_replay = replay

    async def respond(self, message: str) -> vf.Messages:
        session = getattr(self, "session", None)
        task = self.task

        if not isinstance(session, MazeSession):
            self.state.maze_status_error = "maze session is not available"
            self.state.game_lost = True
            return [{"role": "user", "content": "Maze session is not available."}]

        if not self.state.maze_status:
            status = session.request("observe")
            self.initialize_state(status)
            return self.build_user_message(status, "Start of run.")

        raw_response = str(message or "")
        result_text = ""
        try:
            command, action_args = parse_text_action(raw_response)
            status = session.request(command, **action_args)
            self.state.maze_status = status
            record_maze_action(
                self.state,
                action_args=action_args,
                command=command,
                raw_response=raw_response,
                status=status,
            )
            result_text = action_result_text(command=command, status=status)
        except Exception as error:
            self.state.maze_status_error = str(error)
            try:
                status = session.request("observe")
                self.state.maze_status = status
            except Exception:
                status = self.state.maze_status or {}
            record_maze_action(
                self.state,
                error=str(error),
                raw_response=raw_response,
                status=status,
            )
            result_text = action_result_text(error=str(error))

        self.update_terminal_flags(status)
        if (self.state.game_lost or self.state.game_won) and not status.get("scorecard"):
            status = session.request("scorecard")
            self.state.maze_status = status
        self.record_scorecard(status)

        if self.state.game_lost or self.state.game_won:
            self.close_session()
            return [
                {
                    "role": "user",
                    "content": "Final scorecard:\n```json\n"
                    + scorecard_text(status)
                    + "\n```",
                }
            ]

        return self.build_user_message(status, result_text)


class MazeBenchTaskset(vf.Taskset[MazeBenchTask, MazeBenchConfig, MazeBenchState]):
    def load_tasks(self) -> list[MazeBenchTask]:
        resolved_repo_root = find_bridge_root(self.config.repo_root)
        normalized_level_ids = parse_level_ids(
            self.config.level_ids,
            self.config.start_level_id,
        )
        rows = build_rows(
            count=self.config.num_examples,
            game_won_gem_count=int(self.config.game_won_gem_count),
            level_ids=normalized_level_ids,
            node_bin=self.config.node_bin,
            repo_root=resolved_repo_root,
            target_gems=int(self.config.target_gems),
            timeout_seconds=int(self.config.timeout_seconds),
            view=self.config.view,
            yaw=int(self.config.yaw),
        )
        return [
            MazeBenchTask(
                idx=index,
                name=f"{row['game_id']}:{row['level_id']}#{index}",
                prompt=None,
                system_prompt=self.config.system_prompt,
                example_id=int(row["example_id"]),
                game_id=str(row["game_id"]),
                game_won_gem_count=int(row["game_won_gem_count"]),
                level_id=str(row["level_id"]),
                node_bin=str(row["node_bin"]),
                observation=str(row["observation"]),
                observation_mode=self.config.observation_mode,
                repo_root=str(row["repo_root"]),
                target_gems=int(row["target_gems"]),
                timeout_seconds=int(row["timeout_seconds"]),
                view=str(row["view"]),
                vision_height=int(self.config.vision_height),
                vision_width=int(self.config.vision_width),
                yaw=int(row["yaw"]),
            )
            for index, row in enumerate(rows)
        ]

    def user(self, task: MazeBenchTask) -> vf.User:
        return MazeBenchUser(self.config.user)

    async def finalize(
        self,
        task: MazeBenchTask,
        trace: vf.Trace,
        runtime: vf.Runtime,
    ) -> None:
        del task, runtime
        trace.info["maze_actions"] = trace.state.maze_actions
        trace.info["maze_scorecard"] = trace.state.maze_scorecard
        trace.info["maze_replay"] = trace.state.maze_replay
        trace.info["maze_status"] = slim_status(trace.state.maze_status)

    @vf.stop
    async def game_over(self, trace: vf.Trace) -> bool:
        return bool(trace.state.game_lost or trace.state.game_won)

    @vf.reward(weight=1.0)
    async def gem_score(self, task: MazeBenchTask, trace: vf.Trace) -> float:
        status = trace.state.maze_status or {}
        gem_count = int(status.get("gem_count") or 0)
        target = int(task.target_gems or 0)
        if target <= 0:
            return float(gem_count)
        return min(1.0, gem_count / target)

    @vf.metric
    async def collected_gems(self, trace: vf.Trace) -> float:
        status = trace.state.maze_status or {}
        return float(status.get("gem_count") or 0)

    @vf.metric
    async def current_level_solved(self, trace: vf.Trace) -> float:
        status = trace.state.maze_status or {}
        return 1.0 if status.get("solved") else 0.0

    @vf.metric
    async def visited_level_count(self, trace: vf.Trace) -> float:
        status = trace.state.maze_status or {}
        return float(len(status.get("visited_levels") or []))


def load_taskset(config: MazeBenchConfig) -> MazeBenchTaskset:
    return MazeBenchTaskset(config=config)


def load_environment(config: vf.EnvConfig) -> vf.Environment:
    """Load the JS-backed ASCII maze benchmark as a Verifiers v1 environment."""
    if not config.taskset.id:
        taskset_config = MazeBenchConfig.model_validate(config.taskset.model_dump())
        config = config.model_copy(update={"taskset": taskset_config})
    return vf.Environment(config=config)


__all__ = ["MazeBenchTaskset"]


if __name__ == "__main__":
    MazeBenchUser.run()
