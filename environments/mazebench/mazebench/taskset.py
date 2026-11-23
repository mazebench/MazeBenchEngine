"""Main World ASCII task data and authoritative game scoring."""

import json
from importlib.resources import files
from typing import Literal

import verifiers.v1 as vf
from pydantic import Field, model_validator

from .models import MazeBenchData, MazeBenchState
from .tools import MazeBenchToolset


class MazeBenchTaskConfig(vf.TaskConfig):
    tools: vf.ToolsetConfig = Field(default_factory=vf.ToolsetConfig)

    @model_validator(mode="after")
    def separate_game(self):
        if self.tools.colocated:
            raise ValueError("The authoritative game must run separately from the agent.")
        return self


class MazeBenchConfig(vf.TasksetConfig):
    task: MazeBenchTaskConfig = Field(default_factory=MazeBenchTaskConfig)
    condition: Literal["tools_off", "tools_on"] = "tools_on"
    start_room: str = Field(default="HxI", pattern=r"^[A-P]x[A-P]$")
    max_actions: int | None = Field(default=1000, ge=1, le=1_000_000)


class MazeBenchTask(vf.Task[MazeBenchData, MazeBenchState, MazeBenchTaskConfig]):
    NEEDS_CONTAINER = True

    @classmethod
    def toolsets(cls, config: MazeBenchTaskConfig) -> list[vf.Toolset]:
        return [MazeBenchToolset(config.tools)]

    async def setup(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        # These are upstream harnesses, not prompt-only capability restrictions.
        expected = "null" if self.data.condition == "tools_off" else "prime_agent"
        if trace.agent.config.harness.id != expected:
            raise ValueError(f"{self.data.condition} requires the stock {expected} harness.")

    @vf.stop
    async def game_over(self, trace: vf.Trace) -> bool:
        return trace.state.invalid or trace.state.summary.get("game_status") in {"won", "action-limit"}

    async def finalize(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        trace.info["mazebench"] = {
            "condition": self.data.condition,
            "snapshot_sha256": self.data.snapshot_sha256,
            "start_room": self.data.start_room,
            "summary": trace.state.summary,
            "actions": trace.state.actions,
            "invalid": trace.state.invalid,
        }
        if trace.state.invalid or not trace.state.summary:
            raise RuntimeError("No verified MazeBench game state; refusing to score this rollout.")
        if trace.state.summary and trace.state.snapshot_sha256 != self.data.snapshot_sha256:
            raise RuntimeError("MazeBench scoring snapshot differs from task data.")
        if self.data.condition == "tools_off":
            allowed = {"maze_observe", "maze_action", "maze_sequence"}
            if {tool.name for tool in trace.tools} != allowed:
                raise RuntimeError("Tools-off rollout exposed an unexpected tool catalog.")

    @vf.reward
    async def gem_score(self, trace: vf.Trace) -> float:
        if trace.state.invalid or not trace.state.summary:
            raise RuntimeError("Invalid MazeBench rollout.")
        return min(1.0, trace.state.summary.get("gems_collected", 0) / 100)

    @vf.metric
    async def gems_collected(self, trace: vf.Trace) -> float:
        return float(trace.state.summary.get("gems_collected", 0))

    @vf.metric
    async def rooms_visited(self, trace: vf.Trace) -> float:
        return float(trace.state.summary.get("rooms_visited", 1))

    @vf.metric
    async def actions_used(self, trace: vf.Trace) -> float:
        return float(trace.state.summary.get("action_count", 0))

    @vf.metric
    async def success(self, trace: vf.Trace) -> float:
        return float(trace.state.summary.get("game_status") == "won")

class MazeBenchTaskset(vf.Taskset[MazeBenchTask, MazeBenchConfig]):
    def load(self) -> list[MazeBenchTask]:
        snapshot = json.loads(files("mazebench").joinpath("runtime/snapshot.json").read_text())
        budget = "There is no game action limit." if self.config.max_actions is None else f"You have {self.config.max_actions} game actions."
        capabilities = (
            "This is tools-off: only the three game tools are available. Plan moves in your reasoning."
            if self.config.condition == "tools_off" else
            "This is tools-on: you may use Prime Agent's computation and workspace tools to model the game and plan moves."
        )
        prompt = f"""You are in MazeBench, a 3D maze with 256 connected rooms.
You are P (player). Collect all 100 G (gems).
Discover the tools on the MCP server named maze, then call its observe tool.
The server's exact tool names are observe, action, and sequence. Your harness
may display them with a prefix or provide an MCP gateway; follow its tool schemas.
The board is an ASCII view of your current room. Walking off an edge enters
the neighboring room. Movement is screen-relative to the current camera.

Use action for up, down, left, right, undo, reset, camera up/down/left/right,
or room HxI (replace HxI with any previously visited room). A room command starts
that room's fresh authored board and player position. Reset restores this visit's
entry board; undo restores the previous effective game state. Collected gems stay
collected through all of these operations. Recover from death using undo or reset.
Use sequence with a compact UDRL string or an actions array for planned moves.
Sequences stop on death, victory, or the action limit. Inspect the resulting board.
Game tools should be called in the order you intend to play them.
observe can also read the safe records listed in each observation.

{budget} Blocked moves, camera actions, undo, reset, and room commands all count.
Observations cost no game actions. The goal is to collect every gem; when the
action budget is exhausted, report your result. {capabilities}
Only the game tools' returned observations are authoritative game information.
"""
        return [MazeBenchTask(MazeBenchData(
            idx=0, name=f"Main World ASCII ({self.config.condition})", prompt=prompt,
            condition=self.config.condition,
            start_room=self.config.start_room, max_actions=self.config.max_actions,
            snapshot_sha256=snapshot["snapshot_sha256"],
        ), self.config.task)]
