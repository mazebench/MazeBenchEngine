"""Evaluator-owned game tools, outside the Prime Agent VM."""
import asyncio
import functools
import json
import os
from pathlib import Path
from typing import Annotated

import verifiers.v1 as vf
from pydantic import Field, model_validator


async def pause_boundary(control_file):
    control = Path(control_file)
    while json.loads(control.read_text()).get("paused"):
        control.with_suffix(".ack").touch(mode=0o600)
        await asyncio.sleep(0.2)


class GameState(vf.State):
    game_status: str = "playing"
    action_count: int = 0


class GameConfig(vf.ToolsetConfig):
    root: str
    directory: str
    node: str
    control_file: str

    @model_validator(mode="after")
    def evaluator_only(self):
        if self.colocated or self.runtime.type != "subprocess" or self.url:
            raise ValueError("Game tools must stay in the trusted local evaluator.")
        return self


class GameTools(vf.Toolset[GameConfig, GameState]):
    TOOL_PREFIX = "maze"

    def __init__(self, config):
        super().__init__(config)
        self._lock = asyncio.Lock()
        self._request_id = 0

    def _with_state(self, fn):
        wrapped = super()._with_state(fn)

        @functools.wraps(fn)
        async def serialized(*args, **kwargs):
            async with self._lock:
                await pause_boundary(self.config.control_file)
                return await wrapped(*args, **kwargs)
        return serialized

    async def setup_task(self, task):
        self.process = await asyncio.create_subprocess_exec(
            self.config.node, str(Path(self.config.root) / "benchmarking/prime/mcp.mjs"),
            env={"PATH": "/usr/bin:/bin", "MAZEBENCH_PROJECT_ROOT": self.config.root,
                 "MAZEBENCH_RUN_DIRECTORY": self.config.directory},
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            limit=16 * 1024 * 1024,
        )
        self._exit_stack.push_async_callback(self.close)
        await self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                      "clientInfo": {"name": "prime-evaluator", "version": "1"}})

    async def close(self):
        if self.process.returncode is None:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()

    async def rpc(self, method, params):
        self._request_id += 1
        request = {"jsonrpc": "2.0", "id": self._request_id, "method": method, "params": params}
        self.process.stdin.write((json.dumps(request) + "\n").encode())
        await self.process.stdin.drain()
        async with asyncio.timeout(180):
            while True:
                line = await self.process.stdout.readline()
                if not line:
                    raise RuntimeError("MazeBench game gateway stopped.")
                response = json.loads(line)
                if response.get("id") == self._request_id:
                    break
        if "error" in response:
            raise RuntimeError(response["error"]["message"])
        return response["result"]

    async def call(self, name, arguments):
        response = await self.rpc("tools/call", {"name": name, "arguments": arguments})
        text = "\n".join(item["text"] for item in response.get("content", []) if item.get("type") == "text")
        try:
            value = json.loads(text)
        except ValueError:
            return {"error" if response.get("isError") else "result": text}
        observation = value.get("final_observation", value.get("observation", value))
        if "game_status" in observation:
            self.state.game_status = observation["game_status"]
            self.state.action_count = observation["action_count"]
        return value

    @vf.tool
    async def observe(self, record: Annotated[str, Field(max_length=256)] | None = None) -> dict:
        """Read the current ASCII board, or one safe read-only record from its records index. No action cost."""
        return await self.call("maze_observe", {} if record is None else {"record": record})

    @vf.tool
    async def action(self, action: Annotated[str, Field(min_length=1, max_length=128)]) -> dict:
        """Apply up/down/left/right, undo, reset, camera up/down/left/right, or room HxI (visited rooms only). Each accepted action counts, including blocked moves."""
        return await self.call("maze_action", {"action": action})

    @vf.tool
    async def sequence(self, sequence: Annotated[str, Field(min_length=1, max_length=1000)] | None = None,
                       actions: Annotated[list[str], Field(min_length=1, max_length=1000)] | None = None) -> dict:
        """Apply a compact UDRL string OR an ordered actions array. Stops on death, victory or action limit. Each accepted step costs one action."""
        if (sequence is None) == (actions is None):
            return {"error": "Supply exactly one of sequence or actions."}
        return await self.call("maze_sequence", {"sequence": sequence} if sequence is not None else {"actions": actions})


if __name__ == "__main__":
    GameTools.run()
