"""One evaluator-owned game per rollout, exposed through standard vf.Toolset."""

import asyncio
import functools
from typing import Annotated

import verifiers.v1 as vf
from pydantic import Field

from .game import Game
from .models import MazeBenchData, MazeBenchState

Action = Annotated[str, Field(min_length=1, max_length=128)]


class MazeBenchToolset(vf.Toolset[vf.ToolsetConfig, MazeBenchState]):
    TOOL_PREFIX = "maze"

    def __init__(self, config):
        super().__init__(config)
        self.game = Game()
        self._call_lock = asyncio.Lock()
        self._latest = MazeBenchState()

    def _with_state(self, fn):
        # Verifiers state updates replace the whole state. Serialize its complete
        # pull/call/push transaction, including concurrent Prime Agent MCP calls.
        wrapped = super()._with_state(fn)

        @functools.wraps(fn)
        async def serialized(*args, **kwargs):
            async with self._call_lock:
                return await wrapped(*args, **kwargs)

        return serialized

    async def setup_task(self, task: MazeBenchData):
        self._exit_stack.push_async_callback(self.game.close)
        response = await self.game.start(task.start_room, task.max_actions)
        if not response["ok"]:
            raise RuntimeError(response["error"])
        self._latest = MazeBenchState.model_validate(response["state"])
        if self._latest.snapshot_sha256 != task.snapshot_sha256:
            raise RuntimeError("Task and installed MazeBench snapshot differ.")

    async def _call(self, method, **args):
        if self._latest.invalid:
            response = {"ok": False, "error": "Game unavailable; this rollout is invalid."}
        else:
            try:
                response = await self.game.call(method, **args)
                if response.get("state") is not None:
                    self._latest = MazeBenchState.model_validate(response["state"])
            except (TimeoutError, RuntimeError, OSError, ValueError):
                self._latest.invalid = True
                await self.game.close()
                response = {"ok": False, "error": "Game process failed; this rollout is invalid."}
        for key, value in self._latest.model_dump().items():
            setattr(self.state, key, value)
        if not response["ok"]:
            return {"error": response["error"]}
        return response["result"]

    @vf.tool
    async def observe(self, record: Annotated[str, Field(max_length=256)] | None = None) -> dict:
        """Read the current ASCII board, or a safe read-only record from its records index. Does not consume an action."""
        return await self._call("observe", record=record)

    @vf.tool
    async def action(self, action: Action) -> dict:
        """Apply up/down/left/right, undo, reset, camera up/down/left/right, or room HxI (visited rooms only). Every accepted action counts, including blocked moves."""
        return await self._call("action", action=action)

    @vf.tool
    async def sequence(
        self,
        sequence: Annotated[str, Field(min_length=1, max_length=1000)] | None = None,
        actions: Annotated[list[Action], Field(min_length=1, max_length=1000)] | None = None,
    ) -> dict:
        """Apply either a compact UDRL string or an ordered actions array (exactly one). Stops on death, victory, or the action limit. Each accepted step consumes one action."""
        if (sequence is None) == (actions is None):
            return {"error": "Supply exactly one of sequence or actions."}
        return await self._call("sequence", sequence=sequence, actions=actions)


if __name__ == "__main__":
    MazeBenchToolset.run()
