"""Safe model loop with bounded Prime transport and blank-response retries."""

from __future__ import annotations

import json

from verifiers.v1.clients import ModelContext
from verifiers.v1.dialects.chat import message_to_wire
from verifiers.v1.harnesses.null.harness import (
    NullHarness,
    PROGRAM_SOURCE as NULL_PROGRAM_SOURCE,
)
from verifiers.v1.runtimes import ProgramResult, Runtime
from verifiers.v1.trace import Trace


_OLD_IMPORT = "from openai import AsyncOpenAI"
_NEW_IMPORT = """from openai import (
    APIConnectionError,
    APITimeoutError,
    AsyncOpenAI,
    InternalServerError,
    RateLimitError,
)


TRANSIENT_MODEL_ERRORS = (
    APIConnectionError,
    APITimeoutError,
    InternalServerError,
    RateLimitError,
)
"""
_OLD_CHAT = """async def chat(
    client: AsyncOpenAI, model: str, messages: list[dict], tools: list[dict]
):
    completion = await client.chat.completions.create(
        model=model, messages=messages, tools=tools or None
    )
    return completion.choices[0].message
"""
_NEW_CHAT = """async def chat(
    client: AsyncOpenAI, model: str, messages: list[dict], tools: list[dict]
):
    empty_attempts = 0
    for attempt in range(1, 7):
        try:
            completion = await client.chat.completions.create(
                model=model, messages=messages, tools=tools or None
            )
            message = completion.choices[0].message
            content = message.content
            has_content = bool(content.strip()) if isinstance(content, str) else bool(content)
            if has_content or message.tool_calls or getattr(message, "refusal", None):
                return message
            empty_attempts += 1
            if empty_attempts >= 3:
                raise RuntimeError(
                    "Prime returned an empty assistant response three times; "
                    "the turn was not sent to the environment."
                )
            await asyncio.sleep(empty_attempts)
        except TRANSIENT_MODEL_ERRORS:
            if attempt >= 6:
                raise
            await asyncio.sleep(min(8, 2 ** (attempt - 1)))
"""

if _OLD_IMPORT not in NULL_PROGRAM_SOURCE or _OLD_CHAT not in NULL_PROGRAM_SOURCE:
    raise RuntimeError(
        "The pinned Verifiers null harness changed; update MazeBench's retry patch."
    )

PROGRAM_SOURCE = NULL_PROGRAM_SOURCE.replace(_OLD_IMPORT, _NEW_IMPORT).replace(
    _OLD_CHAT, _NEW_CHAT
)


class MazeBenchHarness(NullHarness):
    """Prime model/user loop without a shell or evaluator filesystem access."""

    async def setup(self, runtime: Runtime) -> None:
        await runtime.prepare_uv_script(PROGRAM_SOURCE, self.config.resolved_env)

    async def launch(
        self,
        ctx: ModelContext,
        trace: Trace,
        runtime: Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
    ) -> ProgramResult:
        system_prompt, prompt = self.resolve_prompt(trace.task.data)
        args = [
            f"--base-url={endpoint}",
            f"--api-key={secret}",
            f"--model={ctx.model}",
        ]
        if system_prompt:
            args.append(f"--system-prompt={system_prompt}")
        if mcp_urls:
            args.append(
                "--mcp-config="
                + json.dumps(
                    {
                        "mcpServers": {
                            name: {"url": url} for name, url in mcp_urls.items()
                        }
                    }
                )
            )
        if isinstance(prompt, str):
            args.append(f"--prompt={prompt}")
        elif prompt is not None:
            path = f".vf-initial-messages-{trace.id}.json"
            await runtime.write(
                path,
                json.dumps([message_to_wire(message) for message in prompt]).encode(),
            )
            args.append(f"--initial-messages-file={path}")
        program = await runtime.prepare_uv_script(
            PROGRAM_SOURCE, self.config.resolved_env
        )
        return await runtime.run_program(
            [*program, *args], self.config.resolved_env
        )


__all__ = ["MazeBenchHarness", "PROGRAM_SOURCE"]
