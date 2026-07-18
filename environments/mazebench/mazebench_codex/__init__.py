"""Backward-compatible Codex taskset using the isolated MazeBench gateway.

The original experiment colocated a repository-backed helper with Codex.  That
made benchmark source and evaluator files visible to the harness.  Keep the old
taskset id working, but route it through the same external tool task and
Prime-sandboxed MCP adapter used by the Agent page.
"""

from __future__ import annotations

from mazebench_codex_harness import MazeBenchCodexHarness
from mazebench_tools import MazeBenchToolConfig, MazeBenchToolTaskset


class MazeBenchCodexConfig(MazeBenchToolConfig):
    id: str = "mazebench_codex"


class MazeBenchCodexTaskset(MazeBenchToolTaskset):
    config: MazeBenchCodexConfig


def load_taskset(config: MazeBenchCodexConfig) -> MazeBenchCodexTaskset:
    return MazeBenchCodexTaskset(config=config)


__all__ = ["MazeBenchCodexConfig", "MazeBenchCodexHarness", "MazeBenchCodexTaskset", "load_taskset"]
