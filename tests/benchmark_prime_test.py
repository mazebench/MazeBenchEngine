"""Run with ~/.mazebench/prime/venv/bin/python -m unittest discover -s tests -p benchmark_prime_test.py."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarking/prime"))
from maze_tools import GameConfig, GameState, GameTools, pause_boundary
from agent_runner import installation


class PrimeToolsTests(unittest.IsolatedAsyncioTestCase):
    def test_pinned_installation(self):
        self.assertEqual(installation()["version"], "0.3.2.dev121")

    def test_game_cannot_be_colocated(self):
        args = dict(root="/fixture", directory="/record", node="/node", control_file="/control")
        for change in ({"colocated": True}, {"runtime": {"type": "prime"}}, {"url": "https://other.test"}):
            with self.assertRaises(ValueError):
                GameConfig(**args, **change)

    async def test_pause_waits_until_operator_resumes(self):
        with tempfile.TemporaryDirectory() as temp:
            control = Path(temp) / "control.json"
            control.write_text(json.dumps({"paused": True}))
            waiting = asyncio.create_task(pause_boundary(str(control)))
            await asyncio.sleep(0.05)
            self.assertFalse(waiting.done())
            self.assertTrue(control.with_suffix(".ack").exists())
            control.write_text(json.dumps({"paused": False}))
            await asyncio.wait_for(waiting, 1)

    async def test_sequence_updates_terminal_state(self):
        # Exercise the response conversion without a framework state server.
        class Fixture:
            state = GameState()

            async def rpc(self, method, params):
                return {"content": [{"type": "text", "text": json.dumps({
                    "completed_count": 2, "final_observation": {"game_status": "action-limit", "action_count": 2}
                })}]}
        fixture = Fixture()
        await GameTools.call(fixture, "maze_sequence", {"sequence": "UU"})
        self.assertEqual(fixture.state.game_status, "action-limit")
        self.assertEqual(fixture.state.action_count, 2)
