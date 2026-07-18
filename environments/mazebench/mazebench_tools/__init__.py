"""MazeBench taskset for untrusted harnesses using isolated MCP game controls.

The harness runs in its own Prime sandbox. The game session and authoritative
artifacts stay in this per-rollout tool-server process on the trusted evaluator
host. Nothing from the MazeBench runtime is copied into the harness runtime.
"""

from __future__ import annotations

import atexit
import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import verifiers.v1 as vf
from pydantic import Field

from mazebench.mazebench import (
    MazeBenchConfig,
    MazeBenchState,
    MazeBenchTask,
    MazeBenchTaskset,
    MazeSession,
    apply_quit_policy,
    evaluate_auto_quit,
    find_bridge_root,
    load_prime_resume_checkpoint,
    parse_text_action,
    record_maze_action,
    run_blocking,
    slim_status,
    write_live_actions,
)


class MazeBenchToolsetConfig(vf.ToolsetConfig):
    """Private evaluator-owned paths supplied when a rollout tool server starts."""

    snapshot_path: str = ""
    resume_checkpoint_path: str = ""


class MazeBenchToolConfig(MazeBenchConfig):
    id: str = "mazebench-tools"
    tools: MazeBenchToolsetConfig = Field(default_factory=MazeBenchToolsetConfig)


class MazeBenchToolTraceState(vf.State):
    """Deliberately empty while the harness is alive.

    A CLI harness knows its interception bearer, so it can reach Verifiers'
    state endpoint. Keeping this schema empty prevents it from reading or
    forging authoritative game fields. Finalize replaces it after the harness
    exits with the evaluator-owned MazeBenchState snapshot.
    """


def _atomic_json(path: str, value: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)


def _public_observation(status: dict[str, Any], mode: str) -> dict[str, Any]:
    """Return only the observation fields intended for the model."""

    common = {
        key: status[key]
        for key in (
            "action_count",
            "allowed_commands",
            "current_room",
            "current_view",
            "game_lost",
            "game_won",
            "gem_count",
            "moved",
            "player_dead",
            "quit",
            "room_changed",
            "solved",
            "visited_levels",
            "yaw",
        )
        if key in status
    }
    if mode == "json":
        common["json_observation"] = status.get("json_observation") or {}
    else:
        common["level"] = str(status.get("level") or "")
    return common


def _tool_prompt(task: MazeBenchTask) -> str:
    budget = (
        "There is no action limit; continue until the game is won or the run is stopped."
        if task.max_actions is None
        else f"You may use at most {int(task.max_actions)} game actions."
    )
    quit_policy = (
        "You may use quit when no useful move remains."
        if task.allow_quit
        else "Quit is disabled; recover with undo or reset after a death and keep playing."
    )
    mode = "structured JSON" if task.observation_mode == "json" else "ASCII"
    return f"""Play the hidden 3D grid game using only the supplied game controls.

Call `game_start` exactly once first. Inspect its sanitized {mode} observation, then call
`game_action` with one action at a time. Use `game_observe` only when you need to inspect the
current state without consuming an action. Valid actions include up, down, left, right,
rotate camera left, rotate camera right, undo, reset, and go to level X Y.

Collect {int(task.target_gems)} gems and explore as many rooms as possible. {budget} {quit_policy}
When the returned result says `ended: true`, finish with a short route summary.

The game implementation, session, checkpoints, and scoring are evaluator-only. Do not try to
locate or access them. Do not claim moves or scores that were not returned by the game controls."""


class MazeBenchToolset(vf.Toolset[MazeBenchToolsetConfig]):
    """Three narrow controls backed by evaluator-owned MazeBench state."""

    TOOL_PREFIX = "game"

    async def setup_task(self, task: MazeBenchTask) -> None:
        self.task = task
        self._lock = asyncio.Lock()
        self._closed = False
        self._actions: list[dict[str, Any]] = []
        self._auto_quit: dict[str, Any] = {}
        self._scorecard: dict[str, Any] = {}
        self._status_error = ""
        self._session = MazeSession(
            game_won_gem_count=task.game_won_gem_count,
            level_id=task.level_id,
            observation_mode=task.observation_mode,
            omniscient=task.omniscient,
            hide_names=task.hide_names,
            hide_names_seed=task.hide_names_seed,
            node_bin=task.node_bin,
            repo_root=str(find_bridge_root()),
            timeout_seconds=task.timeout_seconds,
            view=task.view,
            yaw=task.yaw,
        )
        initial = apply_quit_policy(
            await run_blocking(self._session.request, "observe"),
            task.allow_quit,
        )
        self._initial = initial
        self._status = initial
        self._initial_hash = str(initial.get("board_state_hash") or "")
        self._atexit_callback = self.close_session
        atexit.register(self._atexit_callback)
        if self.config.resume_checkpoint_path:
            await self._restore_checkpoint(self.config.resume_checkpoint_path)
        self._write_snapshot()

    def close_session(self) -> None:
        session = getattr(self, "_session", None)
        if isinstance(session, MazeSession):
            session.close()
            self._session = None
        callback = getattr(self, "_atexit_callback", None)
        if callback is not None:
            atexit.unregister(callback)
            self._atexit_callback = None

    async def _restore_checkpoint(self, checkpoint_path: str) -> None:
        checkpoint = load_prime_resume_checkpoint(checkpoint_path)
        expected_initial_hash = str(checkpoint.get("initial_board_state_hash") or "")
        if not expected_initial_hash or self._initial_hash != expected_initial_hash:
            raise ValueError("Prime checkpoint initial state does not match this MazeBench runtime")

        status = self._initial
        restored: dict[str, Any] = {"maze_actions": []}
        for index, saved in enumerate(checkpoint.get("actions") or [], start=1):
            if int(saved.get("turn") or 0) != index:
                raise ValueError(f"Prime checkpoint is missing action {index}")
            raw_response = str(saved.get("command_text") or "")
            if saved.get("valid", True) is False or saved.get("error"):
                status = apply_quit_policy(
                    await run_blocking(self._session.request, "observe"),
                    self.task.allow_quit,
                )
                record_maze_action(
                    restored,
                    error=str(saved.get("error") or "invalid response"),
                    raw_response=raw_response,
                    status=status,
                )
            else:
                command, action_args = parse_text_action(raw_response)
                status = apply_quit_policy(
                    await run_blocking(self._session.request, command, **action_args),
                    self.task.allow_quit,
                )
                record_maze_action(
                    restored,
                    action_args=action_args,
                    command=command,
                    raw_response=raw_response,
                    status=status,
                )
            expected_hash = str(saved.get("status", {}).get("board_state_hash") or "")
            if not expected_hash or str(status.get("board_state_hash") or "") != expected_hash:
                raise ValueError(f"Prime checkpoint diverged while replaying action {index}")

        final_hash = str(checkpoint.get("final_board_state_hash") or "")
        if str(status.get("board_state_hash") or "") != final_hash:
            raise ValueError("Prime checkpoint replay did not reach its saved final state")
        self._actions = list(restored["maze_actions"])
        self._status = status

    def _terminal(self) -> bool:
        task = self.task
        status = self._status or {}
        return bool(
            self._closed
            or status.get("game_lost")
            or status.get("game_won")
            or status.get("quit")
            or self._auto_quit
            or (task.max_actions is not None and len(self._actions) >= int(task.max_actions))
        )

    def _state_payload(self) -> dict[str, Any]:
        status = self._status or {}
        replay = {
            "game_id": self.task.game_id,
            "game_won_gem_count": int(self.task.game_won_gem_count),
            "initial": slim_status(self._initial),
            "start_level_id": self.task.level_id,
            "target_gems": int(self.task.target_gems),
            "actions": self._actions,
            "scorecard": self._scorecard or None,
        }
        state = MazeBenchState(
            game_lost=bool(status.get("game_lost") or status.get("quit")),
            game_won=bool(
                status.get("game_won")
                or int(status.get("gem_count") or 0) >= int(self.task.game_won_gem_count)
            ),
            maze_auto_quit=self._auto_quit,
            maze_actions=self._actions,
            maze_initial_board_state_hash=self._initial_hash,
            maze_replay=replay,
            maze_scorecard=self._scorecard,
            maze_status=status,
            maze_status_error=self._status_error,
        )
        return state.model_dump()

    def _write_snapshot(self) -> None:
        if self.config.snapshot_path:
            _atomic_json(
                self.config.snapshot_path,
                {"version": 1, "state": self._state_payload()},
            )
        write_live_actions(list(self._actions))

    async def _finish_if_needed(self) -> None:
        if not self._terminal() or self._scorecard:
            return
        try:
            status = apply_quit_policy(
                await run_blocking(self._session.request, "scorecard"),
                self.task.allow_quit,
            )
            self._status = status
            scorecard = status.get("scorecard")
            if isinstance(scorecard, dict):
                self._scorecard = scorecard
        except Exception as error:  # evaluator detail stays out of the tool result
            self._status_error = str(error)
        finally:
            await run_blocking(self.close_session)

    def _result(self, *, error: str = "") -> dict[str, Any]:
        result = {
            "observation": _public_observation(self._status or {}, self.task.observation_mode),
            "actions_used": len(self._actions),
            "actions_remaining": (
                None
                if self.task.max_actions is None
                else max(0, int(self.task.max_actions) - len(self._actions))
            ),
            "ended": self._terminal(),
        }
        if error:
            result["error"] = error
        if self._auto_quit:
            result["auto_quit"] = {
                "percentage": float(self._auto_quit.get("percentage") or 0),
                "mode": self._auto_quit.get("mode"),
            }
        return result

    @vf.tool
    async def start(self) -> dict[str, Any]:
        """Start the game and return the current sanitized observation. This is idempotent."""

        async with self._lock:
            return self._result()

    @vf.tool
    async def observe(self) -> dict[str, Any]:
        """Return the current sanitized observation without consuming an action."""

        async with self._lock:
            return self._result()

    @vf.tool
    async def action(self, action: str) -> dict[str, Any]:
        """Apply one allowed game action, such as up, down, left, right, undo, reset, or rotate camera left."""

        async with self._lock:
            if self._terminal():
                return self._result(error="The run has ended; no further action is available.")

            raw = str(action or "").strip()
            blocked_quit = False
            try:
                command, action_args = parse_text_action(raw)
                if command == "quit" and not self.task.allow_quit:
                    blocked_quit = True
                    raise ValueError("Quit is disabled for this run.")
                status = apply_quit_policy(
                    await run_blocking(self._session.request, command, **action_args),
                    self.task.allow_quit,
                )
                self._status = status
                state = {"maze_actions": self._actions}
                record_maze_action(
                    state,
                    action_args=action_args,
                    command=command,
                    raw_response=raw,
                    status=status,
                )
                self._actions = list(state["maze_actions"])
                error = ""
            except Exception as exception:
                error = str(exception).splitlines()[0][:300]
                self._status_error = error
                try:
                    self._status = apply_quit_policy(
                        await run_blocking(self._session.request, "observe"),
                        self.task.allow_quit,
                    )
                except Exception:
                    pass
                if not blocked_quit:
                    state = {"maze_actions": self._actions}
                    record_maze_action(
                        state,
                        error=error,
                        raw_response=raw,
                        status=self._status,
                    )
                    self._actions = list(state["maze_actions"])

            if not self._terminal():
                evaluation = evaluate_auto_quit(
                    self._initial_hash,
                    self._actions,
                    enabled=self.task.auto_quit,
                    threshold=self.task.auto_quit_threshold,
                    mode=self.task.auto_quit_mode,
                    window=self.task.auto_quit_window,
                )
                if evaluation is not None:
                    self._auto_quit = evaluation
            await self._finish_if_needed()
            self._write_snapshot()
            return self._result(error=error)


class MazeBenchToolTaskset(
    MazeBenchTaskset,
    vf.Taskset[MazeBenchTask, MazeBenchToolConfig, MazeBenchToolTraceState],
):
    """MazeBench scoring with no user simulator and a trusted MCP tool server."""

    # Verifiers checks method identity when deciding whether a taskset defines a
    # user simulator. Rebind the base no-op exactly; inheriting MazeBenchUser here
    # would make CLI harness pairings invalid and would duplicate game state.
    user = vf.Taskset.user

    def __init__(self, config: MazeBenchToolConfig) -> None:
        super().__init__(config)
        self._snapshot_paths: dict[int, str] = {}

    def load_tasks(self) -> list[MazeBenchTask]:
        tasks = super().load_tasks()
        live_actions_path = os.environ.get("MAZEBENCH_LIVE_ACTIONS_PATH", "").strip()
        if live_actions_path and len(tasks) == 1:
            base = Path(live_actions_path).resolve().parent
        else:
            base = Path(tempfile.mkdtemp(prefix="mazebench-tools-"))
        base.mkdir(parents=True, exist_ok=True)

        sanitized: list[MazeBenchTask] = []
        for task in tasks:
            self._snapshot_paths[int(task.idx)] = str(base / f"trusted-tool-state-{task.idx}.json")
            sanitized.append(
                task.model_copy(
                    update={
                        # These evaluator paths must not be serialized through the
                        # task channel that the harness can authenticate to.
                        "repo_root": "",
                        "resume_checkpoint_path": "",
                        "observation": "",
                        "prompt": _tool_prompt(task),
                        "system_prompt": "Use only the supplied game controls for game interaction. Treat their results as authoritative.",
                    }
                )
            )
        return sanitized

    def tools(self, task: MazeBenchTask) -> list[vf.Toolset]:
        config = self.config.tools.model_copy(
            update={
                "snapshot_path": self._snapshot_paths[int(task.idx)],
                "resume_checkpoint_path": str(self.config.resume_checkpoint_path or ""),
                # Never upload this server beside an untrusted harness.
                "colocated": False,
                "shared": False,
                "fork": False,
            }
        )
        return [MazeBenchToolset(config)]

    @vf.stop
    async def game_over(self, trace: vf.Trace) -> bool:
        del trace
        return False

    @vf.stop
    async def low_state_novelty(self, trace: vf.Trace) -> bool:
        del trace
        return False

    async def finalize(self, task: MazeBenchTask, trace: vf.Trace, runtime: vf.Runtime) -> None:
        path = self._snapshot_paths.get(int(task.idx), "")
        try:
            payload = json.loads(Path(path).read_text(encoding="utf-8"))
            trusted_state = MazeBenchState.model_validate(payload["state"])
        except Exception as error:
            trusted_state = MazeBenchState(
                game_lost=True,
                maze_status_error=f"trusted game state unavailable: {error}",
            )

        # The harness knows the interception bearer and could forge /state.
        # Replace it unconditionally with evaluator-owned data before scoring.
        trace.state = trusted_state
        await super().finalize(task, trace, runtime)


def load_taskset(config: MazeBenchToolConfig) -> MazeBenchToolTaskset:
    return MazeBenchToolTaskset(config=config)


__all__ = ["MazeBenchToolTaskset"]


if __name__ == "__main__":
    MazeBenchToolset.run()
