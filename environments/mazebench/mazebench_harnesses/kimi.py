"""Kimi Code harness with explicit vision capability for image observations."""

from __future__ import annotations

import json

from verifiers.v1.clients import ModelContext
from verifiers.v1.harnesses.kimi_code.harness import (
    BINARY,
    KIMI_HOME,
    KimiCodeHarness,
)
from verifiers.v1.runtimes import ProgramResult, Runtime
from verifiers.v1.trace import Trace


class MazeBenchKimiCodeHarness(KimiCodeHarness):
    """Preserve upstream Kimi Code behavior while enabling MCP image results."""

    async def launch(
        self,
        ctx: ModelContext,
        trace: Trace,
        runtime: Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
    ) -> ProgramResult:
        _, prompt = self.resolve_prompt(trace.task.data)
        capabilities = ["tool_use"]
        if trace.task.data.observation_mode == "vision":
            capabilities.append("image_in")
        env = {
            **self.config.resolved_env,
            "KIMI_CODE_HOME": KIMI_HOME,
            "KIMI_MODEL_NAME": ctx.model,
            "KIMI_MODEL_API_KEY": secret,
            "KIMI_MODEL_PROVIDER_TYPE": "openai",
            "KIMI_MODEL_BASE_URL": endpoint,
            "KIMI_MODEL_CAPABILITIES": ",".join(capabilities),
            "KIMI_DISABLE_TELEMETRY": "1",
            "KIMI_CODE_NO_AUTO_UPDATE": "1",
        }

        mcp = {"mcpServers": {name: {"url": url} for name, url in mcp_urls.items()}}
        permission_rules = "\n".join(
            "\n".join(
                (
                    "[[permission.rules]]",
                    'decision = "deny"',
                    'scope = "user"',
                    f"pattern = {json.dumps(tool)}",
                    'reason = "Disabled by Verifiers harness configuration."',
                )
            )
            for tool in self.config.disabled_tools or []
        )
        if permission_rules:
            await runtime.write(f"{KIMI_HOME}/config.toml", permission_rules.encode())
        await runtime.write(f"{KIMI_HOME}/mcp.json", json.dumps(mcp).encode())
        return await runtime.run_program([BINARY, "--prompt", prompt], env)


__all__ = ["MazeBenchKimiCodeHarness"]
