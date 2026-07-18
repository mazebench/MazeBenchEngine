from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "environments" / "mazebench" / "mazebench" / "auto_quit.py"
SPEC = importlib.util.spec_from_file_location("mazebench_auto_quit_test_target", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load {MODULE_PATH}")
auto_quit = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = auto_quit
SPEC.loader.exec_module(auto_quit)


def actions(*hashes: str) -> list[dict[str, object]]:
    return [{"status": {"board_state_hash": state_hash}} for state_hash in hashes]


class AutoQuitParityTests(unittest.TestCase):
    def test_defaults_use_a_100_move_rolling_window(self) -> None:
        self.assertEqual(
            auto_quit.normalize_auto_quit_config(enabled=True),
            {
                "enabled": True,
                "threshold": 10.0,
                "mode": "rolling",
                "window": 100,
                "warning_moves": 10,
            },
        )

    def test_cumulative_matches_engine_threshold(self) -> None:
        config = {
            "enabled": True,
            "threshold": 10,
            "mode": "cumulative",
        }
        self.assertIsNone(
            auto_quit.evaluate_auto_quit("A", actions(*(["A"] * 8)), **config)
        )
        result = auto_quit.evaluate_auto_quit(
            "A",
            actions(*(["A"] * 9)),
            **config,
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["novel_states"], 1)
        self.assertEqual(result["observed_states"], 10)
        self.assertEqual(result["action_count"], 9)
        self.assertEqual(result["percentage"], 10.0)

    def test_cumulative_warning_is_conditional_countdown(self) -> None:
        initial_warning = auto_quit.projected_auto_quit_warning(
            "A",
            [],
            enabled=True,
            threshold=10,
            mode="cumulative",
            warning_moves=10,
        )
        self.assertIsNotNone(initial_warning)
        assert initial_warning is not None
        self.assertEqual(initial_warning["moves_remaining"], 9)

        one_move_warning = auto_quit.projected_auto_quit_warning(
            "A",
            actions(*(["A"] * 8)),
            enabled=True,
            threshold=10,
            mode="cumulative",
            warning_moves=10,
        )
        self.assertIsNotNone(one_move_warning)
        assert one_move_warning is not None
        self.assertEqual(one_move_warning["moves_remaining"], 1)

    def test_new_state_raises_cumulative_novelty(self) -> None:
        result = auto_quit.evaluate_auto_quit(
            "A",
            actions("B", *(["B"] * 8)),
            enabled=True,
            threshold=10,
            mode="cumulative",
        )
        self.assertIsNone(result)

    def test_rolling_waits_for_full_window_and_uses_global_novelty(self) -> None:
        self.assertIsNone(
            auto_quit.evaluate_auto_quit(
                "A",
                actions("B", "C"),
                enabled=True,
                threshold=100,
                mode="rolling",
                window=3,
            )
        )
        warning = auto_quit.projected_auto_quit_warning(
            "A",
            actions("B", "C", "C"),
            enabled=True,
            threshold=0,
            mode="rolling",
            window=3,
            warning_moves=10,
        )
        self.assertIsNotNone(warning)
        assert warning is not None
        self.assertEqual(warning["moves_remaining"], 2)

        result = auto_quit.evaluate_auto_quit(
            "A",
            actions("B", "C", "C", "C", "C"),
            enabled=True,
            threshold=0,
            mode="rolling",
            window=3,
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["novel_states"], 0)
        self.assertEqual(result["observed_states"], 3)

    def test_cumulative_zero_threshold_never_fires_after_known_initial_state(self) -> None:
        self.assertIsNone(
            auto_quit.evaluate_auto_quit(
                "A",
                actions(*(["A"] * 20)),
                enabled=True,
                threshold=0,
                mode="cumulative",
            )
        )

    def test_direct_hashes_invalid_actions_and_warning_copy(self) -> None:
        self.assertEqual(
            auto_quit.board_state_hash({"board_state_hash": " direct "}),
            "direct",
        )
        invalid_actions = [
            {"valid": False, "status": {"board_state_hash": "A"}}
            for _ in range(8)
        ]
        warning = auto_quit.auto_quit_warning_text(
            "A",
            invalid_actions,
            enabled=True,
            threshold=10,
            mode="cumulative",
            warning_moves=10,
        )
        self.assertIn("next 1 action", warning)
        self.assertIn("revisit previously observed board states", warning)

    def test_disabled_and_normalized_configuration(self) -> None:
        self.assertIsNone(
            auto_quit.evaluate_auto_quit(
                "A",
                actions(*(["A"] * 20)),
                enabled=False,
            )
        )
        self.assertEqual(
            auto_quit.normalize_auto_quit_config(
                enabled="yes",
                threshold=101,
                mode="ROLLING",
                window=20_000,
                warning_moves=-1,
            ),
            {
                "enabled": True,
                "threshold": 100.0,
                "mode": "rolling",
                "window": 10_000,
                "warning_moves": 0,
            },
        )

    def test_camera_rotations_do_not_fill_or_lower_novelty_window(self) -> None:
        camera_neutral_actions = [
            {"command_text": "up", "status": {"board_state_hash": "A"}},
            {"command_text": "rotate camera left", "status": {"board_state_hash": "A"}},
            {"status": {"action": "rotate_camera", "board_state_hash": "A"}},
            {"command_text": "down", "status": {"board_state_hash": "A"}},
            {"command_text": "no move", "status": {"board_state_hash": "A"}},
        ]
        self.assertTrue(auto_quit.is_camera_rotation_action(camera_neutral_actions[1]))
        self.assertTrue(auto_quit.is_camera_rotation_action(camera_neutral_actions[2]))
        self.assertFalse(auto_quit.is_camera_rotation_action(camera_neutral_actions[4]))
        self.assertIsNone(
            auto_quit.evaluate_auto_quit(
                "A",
                camera_neutral_actions[:4],
                enabled=True,
                threshold=0,
                mode="rolling",
                window=3,
            )
        )
        result = auto_quit.evaluate_auto_quit(
            "A",
            camera_neutral_actions,
            enabled=True,
            threshold=0,
            mode="rolling",
            window=3,
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(result["observed_states"], 3)
        self.assertEqual(result["action_count"], 5)


if __name__ == "__main__":
    unittest.main()
