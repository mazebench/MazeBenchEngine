"""Async lifecycle for the packaged engine; no local repo or service required."""

import asyncio
import json
import os
from importlib.resources import files


class Game:
    def __init__(self):
        self.process = None
        self.lock = asyncio.Lock()

    async def start(self, start_room: str, max_actions: int | None):
        node = files("nodejs_wheel").joinpath("bin", "node.exe" if os.name == "nt" else "node")
        self.process = await asyncio.create_subprocess_exec(
            str(node), str(files("mazebench").joinpath("bridge.mjs")),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, limit=32 * 1024 * 1024,
            # Game code does not need model, provider, tunnel, or host secrets.
            env={key: value for key, value in os.environ.items() if key in {"PATH", "TMPDIR", "TEMP", "SystemRoot"}},
        )
        return await self.call("initialize", start_room=start_room, max_actions=max_actions)

    async def call(self, method: str, **args):
        async with self.lock:
            if self.process is None or self.process.returncode is not None:
                raise RuntimeError("MazeBench game process is unavailable.")
            async with asyncio.timeout(120):
                self.process.stdin.write((json.dumps({"method": method, "args": args}) + "\n").encode())
                await self.process.stdin.drain()
                line = await self.process.stdout.readline()
                if not line:
                    raise RuntimeError("MazeBench game process stopped unexpectedly.")
                return json.loads(line)

    async def close(self):
        if self.process is None:
            return
        process, self.process = self.process, None
        if process.returncode is None:
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 10)
            except TimeoutError:
                process.kill()
                await process.wait()
