import asyncio
import json
from contextlib import asynccontextmanager
from importlib.resources import files
from types import SimpleNamespace

import pytest
import verifiers.v1 as vf
from aiohttp import web
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
from pydantic import ValidationError
from verifiers.v1.mcp import serve
from verifiers.v1.utils.loaders import harness_class, load_taskset, taskset_config_type

from mazebench.game import Game
from mazebench.models import MazeBenchState
from mazebench.taskset import MazeBenchConfig, MazeBenchTaskset
from mazebench.tools import MazeBenchToolset


@asynccontextmanager
async def game(max_actions=30, start_room="HxI"):
    instance = Game()
    try:
        initial = await instance.start(start_room, max_actions)
        assert initial["ok"], initial
        yield instance, initial
    finally:
        await instance.close()


def test_standard_loader_and_stock_harness():
    taskset = load_taskset(taskset_config_type("mazebench")(id="mazebench"))
    assert isinstance(taskset, MazeBenchTaskset)
    task, = list(taskset)
    assert task.data.start_room == "HxI"
    assert len(task.data.snapshot_sha256) == 64
    assert task.toolsets(task.config)[0].config.colocated is False
    assert harness_class("prime_agent").__module__.startswith("verifiers.")


@pytest.mark.asyncio
async def test_conditions_enforce_stock_harness_and_distinct_task_identity():
    tasks = []
    for condition, harness in [("tools_on", "prime_agent"), ("tools_off", "null")]:
        task, = MazeBenchTaskset(MazeBenchConfig(condition=condition)).load()
        tasks.append(task)
        trace = SimpleNamespace(agent=SimpleNamespace(config=SimpleNamespace(harness=SimpleNamespace(id=harness))))
        await task.setup(trace, None)
        trace.agent.config.harness.id = "bash"
        with pytest.raises(ValueError, match="requires the stock"):
            await task.setup(trace, None)
    assert tasks[0].hash != tasks[1].hash
    assert not harness_class("null").EXECUTES_CODE
    assert harness_class("null").SUPPORTS_MCP
    assert harness_class("prime_agent").EXECUTES_CODE


@pytest.mark.asyncio
async def test_tools_off_rejects_extra_tool_catalog():
    task, = MazeBenchTaskset(MazeBenchConfig(condition="tools_off")).load()
    trace = SimpleNamespace(
        state=MazeBenchState(summary={"gems_collected": 0}, snapshot_sha256=task.data.snapshot_sha256),
        info={}, tools=[SimpleNamespace(name=name) for name in ["maze_observe", "maze_action", "maze_sequence"]],
    )
    await task.finalize(trace, None)
    trace.tools.append(SimpleNamespace(name="ipython"))
    with pytest.raises(RuntimeError, match="unexpected tool"):
        await task.finalize(trace, None)


@pytest.mark.parametrize("kwargs", [
    {"start_room": "../private"}, {"max_actions": 0}, {"max_actions": -1},
    {"max_actions": 1_000_001}, {"unexpected": True},
    {"condition": "unknown"}, {"task": {"tools": {"colocated": True}}},
])
def test_config_rejects_invalid_values(kwargs):
    with pytest.raises(ValidationError):
        MazeBenchConfig(**kwargs)


@pytest.mark.asyncio
async def test_engine_moves_limits_and_read_only_observation():
    async with game(4) as (g, initial):
        assert initial["result"]["room"] == "HxI"
        assert initial["result"]["level"]
        read = await g.call("observe")
        assert read["state"]["summary"]["action_count"] == 0
        result = await g.call("sequence", sequence="UDRLUU")
        assert result["result"]["completed_count"] == 4
        assert result["state"]["summary"]["game_status"] == "action-limit"
        assert result["state"]["actions"] == ["up", "down", "right", "left"]
        refused = await g.call("action", action="up")
        assert not refused["ok"]
        assert refused["state"]["summary"]["action_count"] == 4


@pytest.mark.asyncio
async def test_invalid_actions_and_partial_sequence_preserve_authoritative_state():
    async with game() as (g, initial):
        bad = await g.call("action", action="read /etc/passwd")
        assert not bad["ok"]
        assert bad["state"]["summary"]["action_count"] == 0
        # The second action is syntactically valid but its room is unvisited.
        partial = await g.call("sequence", actions=["up", "room AxA", "down"])
        assert not partial["ok"]
        assert partial["state"]["actions"] == ["up"]
        assert partial["state"]["summary"]["action_count"] == 1
        recovery = await g.call("action", action="undo")
        assert recovery["result"]["observation"]["level"] == initial["result"]["level"]


@pytest.mark.asyncio
async def test_room_commands_camera_and_reset_use_new_runtime():
    async with game() as (g, initial):
        moved = await g.call("action", action="up")
        assert moved["result"]["observation"]["player"] != initial["result"]["player"]
        reset = await g.call("action", action="reset")
        assert reset["result"]["observation"]["level"] == initial["result"]["level"]
        await g.call("action", action="up")
        room = await g.call("action", action="room HxI")
        assert room["result"]["observation"]["player"] == initial["result"]["player"]
        camera = await g.call("action", action="camera right")
        assert camera["result"]["observation"]["camera"]["yaw"] == 1


@pytest.mark.asyncio
async def test_real_gem_collection_is_permanent_across_recovery():
    # Exact canonical-engine route for this authored room, independently found
    # with its native shortest-path solver. Replaying it must not farm gems.
    route = "RRRRRDDRUURRRRULLLULLLLDDDDDRDRRDDR"
    async with game(100, "ExM") as (g, initial):
        result = await g.call("sequence", sequence=route)
        assert result["ok"]
        assert result["state"]["summary"]["gems_collected"] == 1
        for action in ["undo", "reset", "room ExM"]:
            result = await g.call("action", action=action)
            assert result["ok"]
            assert result["state"]["summary"]["gems_collected"] == 1
        repeated = await g.call("sequence", sequence=route)
        assert repeated["state"]["summary"]["gems_collected"] == 1


@pytest.mark.asyncio
async def test_records_are_allowlisted_and_cannot_read_game_assets():
    async with game() as (g, initial):
        current = await g.call("observe", record="current_board.txt")
        assert current["ok"]
        for record in ["../../etc/passwd", "/etc/passwd", "../game-state.json", "game-state.json", "sandbox-state/integrity-key"]:
            result = await g.call("observe", record=record)
            assert not result["ok"], record
        assert (await g.call("observe"))["state"]["summary"]["action_count"] == 0


@pytest.mark.asyncio
async def test_independent_rollouts_and_process_cleanup():
    async with game() as (one, first), game() as (two, second):
        await one.call("action", action="up")
        unchanged = await two.call("observe")
        assert unchanged["result"]["player"] == second["result"]["player"]
        assert unchanged["state"]["actions"] == []
        processes = [one.process, two.process]
    assert all(process.returncode == 0 for process in processes)


@pytest.mark.asyncio
async def test_rewards_use_game_state_and_fail_closed():
    task, = MazeBenchTaskset(MazeBenchConfig()).load()
    state = MazeBenchState(summary={"gems_collected": 7, "game_status": "playing"}, snapshot_sha256=task.data.snapshot_sha256)
    trace = SimpleNamespace(state=state, info={}, last_reply="I collected all 100 gems.")
    assert await task.gem_score(trace) == 0.07
    assert await task.success(trace) == 0
    assert not await task.game_over(trace)
    await task.finalize(trace, None)
    assert trace.info["mazebench"]["summary"]["gems_collected"] == 7
    state.summary = {"gems_collected": 87, "game_status": "playing", "gems_total": 100}
    assert await task.gem_score(trace) == 0.87
    assert await task.success(trace) == 0
    assert not await task.game_over(trace)
    state.summary = {"gems_collected": 100, "game_status": "won"}
    assert await task.gem_score(trace) == 1
    assert await task.game_over(trace)
    state.invalid = True
    with pytest.raises(RuntimeError):
        await task.gem_score(trace)
    with pytest.raises(RuntimeError):
        await task.finalize(trace, None)


@pytest.mark.asyncio
async def test_process_failure_invalidates_rollout():
    task, = MazeBenchTaskset(MazeBenchConfig()).load()
    tools = MazeBenchToolset(vf.ToolsetConfig())
    async with tools._exit_stack:
        await tools.setup_task(task.data)
        tools.game.process.kill()
        await tools.game.process.wait()
        result = await tools.observe()
        assert "invalid" in result["error"]
        assert tools.state.invalid


@pytest.mark.asyncio
async def test_no_verified_game_state_cannot_be_scored_as_a_successful_run():
    task, = MazeBenchTaskset(MazeBenchConfig()).load()
    trace = SimpleNamespace(state=MazeBenchState(), info={})
    with pytest.raises(RuntimeError, match="No verified"):
        await task.finalize(trace, None)
    with pytest.raises(RuntimeError):
        await task.gem_score(trace)


def test_snapshot_covers_exact_engine_and_only_game_dependencies():
    root = files("mazebench").joinpath("runtime")
    manifest = json.loads(root.joinpath("snapshot.json").read_text())
    import hashlib
    for name, digest in manifest["files"].items():
        assert hashlib.sha256(root.joinpath(name).read_bytes()).hexdigest() == digest
        assert "supervisor" not in name
        assert "python-sandbox" not in name
        assert "world-solver" not in name
    upstream = json.loads(root.joinpath("engine/v1/upstream.json").read_text())
    assert upstream
    assert len(json.loads(root.joinpath("level-data/v2/main-world/world.json").read_text())["rooms"]) == 256


@pytest.mark.asyncio
async def test_real_framework_mcp_launch_state_sync_and_concurrent_calls():
    """Launch the actual vf.Toolset subprocess and exercise the HTTP MCP contract."""
    task, = MazeBenchTaskset(MazeBenchConfig(max_actions=12)).load()
    state = MazeBenchState()
    secret = "test-private-state-channel"

    async def get_task(request):
        assert request.headers["Authorization"] == f"Bearer {secret}"
        return web.json_response({"cls": "mazebench.models:MazeBenchData", "task": task.data.model_dump_json()})

    async def get_state(request):
        assert request.headers["Authorization"] == f"Bearer {secret}"
        return web.json_response(state.model_dump())

    async def put_state(request):
        nonlocal state
        assert request.headers["Authorization"] == f"Bearer {secret}"
        value = await request.json()
        # Force stale-write races if serialization covers only the game action.
        if value["summary"].get("action_count") == 1:
            await asyncio.sleep(0.1)
        state = MazeBenchState.model_validate(value)
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_get("/task", get_task)
    app.router.add_get("/state", get_state)
    app.router.add_put("/state", put_state)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        toolset = task.toolsets(task.config)[0]
        async with serve(toolset, state_secret=secret, state_base=f"http://127.0.0.1:{port}") as url:
            async with streamable_http_client(url) as streams:
                async with ClientSession(*streams[:2]) as client:
                    await client.initialize()
                    catalog = await client.list_tools()
                    assert {tool.name for tool in catalog.tools} == {"observe", "action", "sequence"}
                    result = await client.call_tool("observe", {})
                    assert not result.is_error
                    assert state.summary["room"] == "HxI"
                    assert state.summary["action_count"] == 0
                    await asyncio.gather(*[client.call_tool("action", {"action": "camera right"}) for _ in range(4)])
                    assert state.summary["action_count"] == 4
                    assert state.actions == ["camera right"] * 4
                    result = await client.call_tool("sequence", {"sequence": "UDRLUDRLUDRL"})
                    assert not result.is_error
                    assert state.summary["action_count"] == 12
                    assert state.summary["game_status"] == "action-limit"
    finally:
        await runner.cleanup()
