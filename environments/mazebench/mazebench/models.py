from typing import Any, Literal

import verifiers.v1 as vf
from pydantic import Field


class MazeBenchData(vf.TaskData):
    condition: Literal["tools_off", "tools_on"] = "tools_on"
    start_room: str = "HxI"
    max_actions: int | None = 1000
    snapshot_sha256: str


class MazeBenchState(vf.State):
    summary: dict[str, Any] = Field(default_factory=dict)
    actions: list[str] = Field(default_factory=list)
    snapshot_sha256: str = ""
    invalid: bool = False
