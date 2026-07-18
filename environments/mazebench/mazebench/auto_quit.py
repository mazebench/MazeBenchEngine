"""State-novelty auto-quit logic shared by both Verifiers entrypoints.

The calculations intentionally match ``shared/auto-quit.js`` in the packaged
MazeBenchEngine runtime. A board state is novel only on its first appearance
in the whole rollout. Cumulative mode includes the initial observation, while
rolling mode considers action observations and waits for a full window.
"""

from __future__ import annotations

import math
import re
from typing import Any, Literal


AUTO_QUIT_DEFAULT_THRESHOLD = 10.0
AUTO_QUIT_DEFAULT_MODE: Literal["cumulative", "rolling"] = "rolling"
AUTO_QUIT_DEFAULT_WINDOW = 100
AUTO_QUIT_DEFAULT_WARNING_MOVES = 10
AUTO_QUIT_MAX_WINDOW = 10_000


def _boolean_value(value: object, fallback: bool = False) -> bool:
    if value is None or value == "":
        return fallback
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _number_in_range(
    value: object,
    fallback: float,
    minimum: float,
    maximum: float,
) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(number):
        return fallback
    return max(minimum, min(maximum, number))


def _integer_in_range(
    value: object,
    fallback: int,
    minimum: int,
    maximum: int,
) -> int:
    number = _number_in_range(value, float(fallback), float(minimum), float(maximum))
    # JavaScript Math.round semantics for the non-negative configuration range.
    return int(math.floor(number + 0.5))


def normalize_auto_quit_config(
    *,
    enabled: object = False,
    threshold: object = AUTO_QUIT_DEFAULT_THRESHOLD,
    mode: object = AUTO_QUIT_DEFAULT_MODE,
    window: object = AUTO_QUIT_DEFAULT_WINDOW,
    warning_moves: object = AUTO_QUIT_DEFAULT_WARNING_MOVES,
) -> dict[str, Any]:
    normalized_mode = str(mode or "").strip().lower()
    return {
        "enabled": _boolean_value(enabled),
        "threshold": _number_in_range(
            threshold,
            AUTO_QUIT_DEFAULT_THRESHOLD,
            0.0,
            100.0,
        ),
        "mode": (
            normalized_mode
            if normalized_mode in {"cumulative", "rolling"}
            else AUTO_QUIT_DEFAULT_MODE
        ),
        "window": _integer_in_range(
            window,
            AUTO_QUIT_DEFAULT_WINDOW,
            1,
            AUTO_QUIT_MAX_WINDOW,
        ),
        "warning_moves": _integer_in_range(
            warning_moves,
            AUTO_QUIT_DEFAULT_WARNING_MOVES,
            0,
            AUTO_QUIT_MAX_WINDOW,
        ),
    }


def board_state_hash(action: object) -> str:
    if not isinstance(action, dict):
        return ""
    direct = action.get("board_state_hash")
    status = action.get("status")
    nested = status.get("board_state_hash") if isinstance(status, dict) else None
    return str(direct or nested or "").strip()


def is_camera_rotation_action(action: object) -> bool:
    if not isinstance(action, dict):
        return False
    status = action.get("status")
    message = action.get("message")
    raw_command = (
        action.get("command_text")
        or action.get("command")
        or action.get("action")
        or (status.get("action") if isinstance(status, dict) else None)
        or (message.get("command") if isinstance(message, dict) else None)
        or ""
    )
    command = re.sub(r"\s+", " ", str(raw_command).strip().lower().replace("_", " "))
    return command == "rotate camera" or bool(
        re.fullmatch(r"rotate camera (?:up|down|left|right)", command)
    )


def _novelty_series(
    initial_state_hash: object,
    actions: object,
) -> tuple[str, list[str], list[int], int]:
    initial_hash = str(initial_state_hash or "").strip()
    action_list = actions if isinstance(actions, list) else []
    hashes = [
        state_hash
        for action in action_list
        if not is_camera_rotation_action(action)
        if (state_hash := board_state_hash(action))
    ]
    seen = {initial_hash} if initial_hash else set()
    novelty: list[int] = []
    for state_hash in hashes:
        is_novel = 0 if state_hash in seen else 1
        seen.add(state_hash)
        novelty.append(is_novel)
    return initial_hash, hashes, novelty, len(action_list)


def _novelty_snapshot(
    initial_hash: str,
    hashes: list[str],
    novelty: list[int],
    *,
    mode: Literal["cumulative", "rolling"],
    window: int,
    action_count: int,
) -> dict[str, Any] | None:
    if mode == "rolling":
        if len(novelty) < window:
            return None
        observed_novelty = novelty[-window:]
        novel_states = sum(observed_novelty)
        observed_states = len(observed_novelty)
    else:
        novel_states = sum(novelty) + (1 if initial_hash else 0)
        observed_states = len(novelty) + (1 if initial_hash else 0)

    if not observed_states:
        return None
    return {
        "mode": mode,
        "window": window if mode == "rolling" else None,
        "percentage": novel_states / observed_states * 100.0,
        "novel_states": novel_states,
        "observed_states": observed_states,
        "action_count": action_count,
    }


def evaluate_auto_quit(
    initial_state_hash: object,
    actions: object,
    *,
    enabled: object = False,
    threshold: object = AUTO_QUIT_DEFAULT_THRESHOLD,
    mode: object = AUTO_QUIT_DEFAULT_MODE,
    window: object = AUTO_QUIT_DEFAULT_WINDOW,
) -> dict[str, Any] | None:
    """Return stop metadata when the configured novelty threshold is reached."""

    config = normalize_auto_quit_config(
        enabled=enabled,
        threshold=threshold,
        mode=mode,
        window=window,
    )
    if not config["enabled"]:
        return None

    initial_hash, hashes, novelty, action_count = _novelty_series(initial_state_hash, actions)
    # Match the Engine monitor: no action observation means no auto-quit.
    if not hashes:
        return None
    snapshot = _novelty_snapshot(
        initial_hash,
        hashes,
        novelty,
        mode=config["mode"],
        window=config["window"],
        action_count=action_count,
    )
    if snapshot is None or snapshot["percentage"] > config["threshold"]:
        return None
    return {**snapshot, "threshold": config["threshold"]}


def projected_auto_quit_warning(
    initial_state_hash: object,
    actions: object,
    *,
    enabled: object = False,
    threshold: object = AUTO_QUIT_DEFAULT_THRESHOLD,
    mode: object = AUTO_QUIT_DEFAULT_MODE,
    window: object = AUTO_QUIT_DEFAULT_WINDOW,
    warning_moves: object = AUTO_QUIT_DEFAULT_WARNING_MOVES,
) -> dict[str, Any] | None:
    """Project a cutoff assuming each subsequent action revisits a known state."""

    config = normalize_auto_quit_config(
        enabled=enabled,
        threshold=threshold,
        mode=mode,
        window=window,
        warning_moves=warning_moves,
    )
    if not config["enabled"] or config["warning_moves"] <= 0:
        return None
    if evaluate_auto_quit(
        initial_state_hash,
        actions,
        enabled=True,
        threshold=config["threshold"],
        mode=config["mode"],
        window=config["window"],
    ) is not None:
        return None

    initial_hash, hashes, novelty, action_count = _novelty_series(initial_state_hash, actions)
    # Without an observed state there is nothing that a future action can revisit.
    if not initial_hash and not hashes:
        return None

    for moves_remaining in range(1, config["warning_moves"] + 1):
        projected_hashes = [*hashes, *([hashes[-1] if hashes else initial_hash] * moves_remaining)]
        projected_novelty = [*novelty, *([0] * moves_remaining)]
        snapshot = _novelty_snapshot(
            initial_hash,
            projected_hashes,
            projected_novelty,
            mode=config["mode"],
            window=config["window"],
            action_count=action_count + moves_remaining,
        )
        if snapshot is not None and snapshot["percentage"] <= config["threshold"]:
            return {
                **snapshot,
                "threshold": config["threshold"],
                "moves_remaining": moves_remaining,
            }
    return None


def auto_quit_warning_text(
    initial_state_hash: object,
    actions: object,
    *,
    enabled: object = False,
    threshold: object = AUTO_QUIT_DEFAULT_THRESHOLD,
    mode: object = AUTO_QUIT_DEFAULT_MODE,
    window: object = AUTO_QUIT_DEFAULT_WINDOW,
    warning_moves: object = AUTO_QUIT_DEFAULT_WARNING_MOVES,
) -> str:
    projection = projected_auto_quit_warning(
        initial_state_hash,
        actions,
        enabled=enabled,
        threshold=threshold,
        mode=mode,
        window=window,
        warning_moves=warning_moves,
    )
    if projection is None:
        return ""

    moves_remaining = int(projection["moves_remaining"])
    action_word = "action" if moves_remaining == 1 else "actions"
    return (
        "AUTO-QUIT WARNING: If the next "
        f"{moves_remaining} {action_word} revisit previously observed board states, "
        f"this rollout will stop at {projection['percentage']:.1f}% new states "
        f"(threshold: {projection['threshold']:g}%). Reach a new state to raise "
        "the novelty rate."
    )


__all__ = [
    "AUTO_QUIT_DEFAULT_MODE",
    "AUTO_QUIT_DEFAULT_THRESHOLD",
    "AUTO_QUIT_DEFAULT_WARNING_MOVES",
    "AUTO_QUIT_DEFAULT_WINDOW",
    "AUTO_QUIT_MAX_WINDOW",
    "auto_quit_warning_text",
    "board_state_hash",
    "evaluate_auto_quit",
    "is_camera_rotation_action",
    "normalize_auto_quit_config",
    "projected_auto_quit_warning",
]
