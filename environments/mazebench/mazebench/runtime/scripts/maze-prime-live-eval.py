#!/usr/bin/env python3
"""Run the Verifiers v1 eval while exporting live usage and maze actions.

The stock eval runner keeps its Trace in process and writes results.jsonl only
after a rollout is finalized. MazeBench's site runs one rollout at a time, so a
small pair of hooks exposes provider usage and each resolved maze action without
changing Verifiers or the final saved eval output.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from verifiers.v1.graph import PendingTurn


LIVE_USAGE_PATH = os.environ.get("MAZEBENCH_LIVE_USAGE_PATH", "").strip()
LIVE_ACTIONS_PATH = os.environ.get("MAZEBENCH_LIVE_ACTIONS_PATH", "").strip()
LIVE_REASONING_PATH = os.environ.get("MAZEBENCH_LIVE_REASONING_PATH", "").strip()
_write_lock = threading.Lock()
_original_commit = PendingTurn.commit
_exported_action_counts: dict[str, int] = {}


def _append_jsonl(path: str, record: dict) -> None:
    if not path:
        return
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with _write_lock:
        with target.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, separators=(",", ":")) + "\n")
            stream.flush()


def _export_synchronized_actions(trace) -> None:
    if not LIVE_ACTIONS_PATH:
        return

    state = trace.state
    actions = state.get("maze_actions", []) if isinstance(state, dict) else getattr(state, "maze_actions", [])
    start = _exported_action_counts.get(trace.id, 0)
    for action in list(actions or [])[start:]:
        _append_jsonl(
            LIVE_ACTIONS_PATH,
            {
                "turn": action.get("turn"),
                "command_text": action.get("command") or action.get("raw_response") or "",
                "status": action.get("status") or {},
            },
        )
    _exported_action_counts[trace.id] = len(actions or [])


def _content_text(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return "" if content is None else str(content)
    parts: list[str] = []
    for part in content:
        if isinstance(part, str):
            parts.append(part)
            continue
        if hasattr(part, "model_dump"):
            part = part.model_dump()
        if isinstance(part, dict):
            text = part.get("text") or part.get("content") or ""
            if text:
                parts.append(str(text))
    return "\n".join(parts)


def _response_reasoning(response) -> str:
    reasoning = str(response.message.reasoning_content or "").strip()
    if reasoning:
        return reasoning
    parts: list[str] = []
    for block in response.message.thinking_blocks or []:
        if hasattr(block, "model_dump"):
            block = block.model_dump()
        if isinstance(block, dict):
            text = block.get("thinking") or block.get("text") or ""
        else:
            text = getattr(block, "thinking", "") or getattr(block, "text", "")
        if text:
            parts.append(str(text))
    return "\n".join(parts).strip()


def _commit_with_live_usage(self: PendingTurn, response) -> None:
    _original_commit(self, response)
    _export_synchronized_actions(self.trace)
    reasoning = _response_reasoning(response)
    if LIVE_REASONING_PATH and reasoning:
        _append_jsonl(
            LIVE_REASONING_PATH,
            {
                "move": self.trace.num_turns,
                "action": _content_text(response.message.content).strip(),
                "reasoning": reasoning,
                "recorded_at": time.time(),
            },
        )
    usage = response.usage
    if not LIVE_USAGE_PATH or usage is None:
        return

    record = {
        "trace_id": self.trace.id,
        "turn": self.trace.num_turns,
        "prompt_tokens": int(usage.prompt_tokens or 0),
        "cached_input_tokens": int(usage.cached_input_tokens or 0),
        "completion_tokens": int(usage.completion_tokens or 0),
        "reasoning_tokens": int(usage.reasoning_tokens or 0),
        "input_tokens": int(usage.input_tokens),
        "total_tokens": int(usage.total_tokens),
        "recorded_at": time.time(),
    }
    _append_jsonl(LIVE_USAGE_PATH, record)


PendingTurn.commit = _commit_with_live_usage


if __name__ == "__main__":
    from verifiers.v1.cli.eval.main import main

    main()
