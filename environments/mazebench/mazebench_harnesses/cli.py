"""Generic CLI bridge for Prime command harnesses without native MCP clients."""

from __future__ import annotations

import json
import pkgutil
from typing import Any

import verifiers.v1.harnesses as builtin_harnesses
from verifiers.v1.clients import ModelContext
from verifiers.v1.harness import Harness, HarnessConfig
from verifiers.v1.loaders import harness_class, harness_config_type
from verifiers.v1.runtimes import ProgramResult, Runtime
from verifiers.v1.trace import Trace
from verifiers.v1.types import UserMessage

from .common import cli_instructions, cli_source


BUILTIN_HARNESS_IDS = frozenset(
    module.name for module in pkgutil.iter_modules(builtin_harnesses.__path__)
)


class MazeBenchCLIHarnessConfig(HarnessConfig):
    # Verifiers narrows a dynamic CLI config by first constructing it with only
    # the harness id, before applying command-line overrides. Keep a harmless
    # default so the generic adapter remains discoverable; launch validation
    # still requires a real Prime built-in id.
    upstream_id: str = "mini_swe_agent"
    upstream_config_json: str = "{}"


class MazeBenchCLIHarness(Harness[MazeBenchCLIHarnessConfig]):
    """Delegate to a Prime harness after adding a capability-scoped game CLI."""

    SUPPORTS_MCP = True
    SUPPORTS_MESSAGE_PROMPT = True

    def _load_delegate(self) -> Harness:
        upstream_id = self.config.upstream_id.strip()
        if upstream_id not in BUILTIN_HARNESS_IDS:
            raise ValueError(
                "CLI adapter accepts only harnesses bundled in the pinned Verifiers package"
            )
        raw: dict[str, Any] = json.loads(self.config.upstream_config_json or "{}")
        if not isinstance(raw, dict):
            raise ValueError("upstream harness config must be a JSON object")
        config_type = harness_config_type(upstream_id)
        config = config_type.model_validate(
            {
                **raw,
                "id": upstream_id,
                "runtime": self.config.runtime.model_dump(),
                "env": {**self.config.env, **dict(raw.get("env") or {})},
                "forward_env": list(
                    dict.fromkeys(
                        [*self.config.forward_env, *(raw.get("forward_env") or [])]
                    )
                ),
                "disabled_tools": self.config.disabled_tools,
            }
        )
        return harness_class(upstream_id)(config)

    async def setup(self, runtime: Runtime) -> None:
        self._delegate = self._load_delegate()
        await self._delegate.setup(runtime)

    async def launch(
        self,
        ctx: ModelContext,
        trace: Trace,
        runtime: Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
    ) -> ProgramResult:
        if not mcp_urls:
            raise ValueError("MazeBench CLI adapter received no game gateway")
        if len(mcp_urls) != 1:
            raise ValueError("MazeBench CLI adapter requires exactly one game gateway")
        path = f"/tmp/mazebench-game-{trace.id}.js"
        await runtime.write(path, cli_source(next(iter(mcp_urls.values()))))
        chmod = await runtime.run(["chmod", "0700", path], {})
        if chmod.exit_code != 0:
            raise RuntimeError(f"could not install MazeBench CLI: {chmod.stderr}")

        delegate = getattr(self, "_delegate", None) or self._load_delegate()
        original_resolve = delegate.resolve_prompt
        instructions = cli_instructions(path)

        def resolve_prompt(task):
            system, prompt = original_resolve(task)
            if prompt is None:
                prompt = instructions
            elif isinstance(prompt, str):
                prompt = f"{prompt}\n\n{instructions}"
            else:
                prompt = [*prompt, UserMessage(content=instructions)]
            return system, prompt

        delegate.resolve_prompt = resolve_prompt
        try:
            return await delegate.launch(ctx, trace, runtime, endpoint, secret, mcp_urls)
        finally:
            delegate.resolve_prompt = original_resolve

    async def score(self, trace: Trace, runtime: Runtime) -> None:
        delegate = getattr(self, "_delegate", None)
        if delegate is not None:
            await delegate.score(trace, runtime)


__all__ = ["MazeBenchCLIHarness"]
