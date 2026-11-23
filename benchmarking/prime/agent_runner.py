"""Stock Prime Agent harness; this process is the trusted evaluator, never the agent."""
import asyncio
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import sys

EXPECTED_VERSION = "0.3.2.dev121"


def installation():
    version = importlib.metadata.version("verifiers")
    if version != EXPECTED_VERSION:
        raise RuntimeError(f"Expected verifiers {EXPECTED_VERSION}; found {version}.")
    checks = Path(__file__).with_name("requirements.txt").read_text().splitlines()
    for entry in checks:
        name, expected = entry.split("==", 1)
        if importlib.metadata.version(name) != expected:
            raise RuntimeError(f"Prime dependency changed: {name}. Reinstall the pinned runtime.")
    distribution = importlib.metadata.distribution("verifiers")
    fingerprint = hashlib.sha256()
    for file in sorted(distribution.files, key=str):
        if str(file).endswith(".py"):
            fingerprint.update(str(file).encode())
            fingerprint.update(distribution.locate_file(file).read_bytes())
    return {"version": version, "fingerprint": fingerprint.hexdigest()}


def emit(event):
    print(json.dumps(event), flush=True)


async def run(config):
    import verifiers.v1 as vf
    from verifiers.v1.types import Request
    from maze_tools import GameConfig, GameTools, GameState, pause_boundary

    class TaskConfig(vf.TaskConfig):
        tools: GameConfig

    class MazeTask(vf.Task[vf.TaskData, GameState, TaskConfig]):
        NEEDS_CONTAINER = True

        @classmethod
        def toolsets(cls, config):
            return [GameTools(config.tools)]

        @vf.intercept
        async def before_model(self, request: Request):
            await pause_boundary(self.config.tools.control_file)

        @vf.stop
        async def game_over(self, trace: vf.Trace) -> bool:
            return trace.state.game_status in {"won", "action-limit"}

    if installation()["fingerprint"] != config["fingerprint"]:
        raise RuntimeError("Prime evaluator installation changed after launch.")
    agent_config = vf.AgentConfig(
        model=config["model"], harness={"id": "prime_agent"},
        runtime={"type": "prime", "cpu": 2, "memory": 4, "disk": 10, "allow": [], "block": ["*"]},
        client={"type": "eval", "base_url": "https://api.pinference.ai/api/v1", "api_key_var": "PRIME_API_KEY"},
        timeout={"setup": 1800, "rollout": 0}, retries={"max_retries": 0},
    )
    task = MazeTask(vf.TaskData(prompt=config["prompt"], network_allow=[], network_block=["*"]),
                    TaskConfig(tools=GameConfig(**config["game"])))
    current = asyncio.current_task()
    parent_pid = os.getppid()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, current.cancel)
    trace = None
    node_index = 0
    last_usage = None
    paused = False

    def publish():
        nonlocal node_index, last_usage, paused
        if trace is None:
            return
        while node_index < len(trace.nodes):
            node = trace.nodes[node_index]
            node_index += 1
            message = node.message
            if node.sampled and message.role == "assistant":
                if getattr(message, "reasoning", None):
                    emit({"type": "item", "item": {"type": "reasoning", "text": message.reasoning}})
                if message.content:
                    emit({"type": "item", "item": {"type": "agent_message", "text": message.content}})
                for call in message.tool_calls or []:
                    emit({"type": "item", "item": {"type": "mcp_tool_call", "server": "prime-agent", "tool": call.name,
                                                   "arguments": call.arguments, "status": "requested"}})
        usage = trace.usage
        if usage:
            normalized = {"input_tokens": usage.input_tokens, "cached_input_tokens": usage.cached_input_tokens or 0,
                          "output_tokens": usage.completion_tokens, "total_tokens": usage.total_tokens}
            if normalized != last_usage:
                emit({"type": "usage", "usage": normalized})
                last_usage = normalized
        control = Path(config["game"]["control_file"])
        is_paused = control.with_suffix(".ack").exists() and json.loads(control.read_text()).get("paused", False)
        if paused != is_paused:
            paused = is_paused
            emit({"type": "status", "status": "paused" if paused else "running"})

    async def monitor():
        while True:
            if os.getppid() != parent_pid:
                current.cancel()  # HTTP owner disappeared; tear down the VM/tunnels.
                return
            publish()
            await asyncio.sleep(0.5)

    def on_trace(value):
        nonlocal trace
        trace = value
        emit({"type": "session", "id": value.id})

    monitor_task = asyncio.create_task(monitor())
    try:
        async with vf.Agent(agent_config) as agent:
            async with agent.interaction(task, on_trace=on_trace) as interaction:
                segment = await interaction.turn()
                while not segment.terminated:
                    await pause_boundary(config["game"]["control_file"])
                    emit({"type": "continuation"})
                    segment = await interaction.turn("Continue this same MazeBench game. Observe, then act. Keep playing until victory or the action limit.")
            publish()
            if not trace.ok:
                raise RuntimeError(trace.last_error.message if trace.last_error else "Prime Agent rollout failed.")
            emit({"type": "complete", "message": trace.last_reply, "stop_condition": trace.stop_condition})
    finally:
        publish()
        monitor_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await monitor_task
        # The trace is private: framework connection metadata is never published.
        if trace is not None:
            Path(config["trace_file"]).write_text(json.dumps(trace.to_record()))


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        print(json.dumps(installation()))
    else:
        import logging
        logging.basicConfig(level=logging.INFO)
        try:
            asyncio.run(run(json.loads(Path(sys.argv[1]).read_text())))
        except asyncio.CancelledError:
            emit({"type": "stopped"})
        except Exception:
            # Diagnostics may contain credentials/URLs: stderr is private.
            import traceback
            traceback.print_exc(file=sys.stderr)
            emit({"type": "failed", "error": "Prime Agent failed. Check the private runner log in ~/.mazebench/prime/runs/<run-id>/stderr.log."})
            sys.exit(1)
