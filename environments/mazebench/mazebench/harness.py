"""Maze harness with resilient Prime calls and live per-turn telemetry."""

from __future__ import annotations

import json
import os
from pathlib import Path

from verifiers.v1.clients import RolloutContext
from verifiers.v1.dialects.chat import message_to_wire
from verifiers.v1.harnesses.default.harness import (
    DefaultHarness,
    PROGRAM_SOURCE as DEFAULT_PROGRAM_SOURCE,
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

if _OLD_IMPORT not in DEFAULT_PROGRAM_SOURCE or _OLD_CHAT not in DEFAULT_PROGRAM_SOURCE:
    raise RuntimeError("The pinned Verifiers default harness changed; update the maze retry patch.")

PROGRAM_SOURCE = DEFAULT_PROGRAM_SOURCE.replace(_OLD_IMPORT, _NEW_IMPORT).replace(
    _OLD_CHAT, _NEW_CHAT
)
_OLD_INITIAL_MESSAGES = 'initial = json.loads(os.environ.get("INITIAL_MESSAGES", "[]"))'
_NEW_INITIAL_MESSAGES = '''initial_path = os.environ.get("INITIAL_MESSAGES_PATH", "")
        initial = (
            json.loads(Path(initial_path).read_text(encoding="utf8"))
            if initial_path
            else json.loads(os.environ.get("INITIAL_MESSAGES", "[]"))
        )'''
if _OLD_INITIAL_MESSAGES not in PROGRAM_SOURCE:
    raise RuntimeError("The pinned Verifiers initial-message loader changed; update the maze resume patch.")
PROGRAM_SOURCE = PROGRAM_SOURCE.replace("import os\n", "import os\nfrom pathlib import Path\n").replace(
    _OLD_INITIAL_MESSAGES, _NEW_INITIAL_MESSAGES
)


class MazeBenchHarness(DefaultHarness):
    """Prime chat-completions harness with bounded transport/blank retries."""

    async def setup(self, runtime: Runtime) -> None:
        await runtime.prepare_uv_script(PROGRAM_SOURCE, self.config.env)

    async def launch(
        self,
        ctx: RolloutContext,
        trace: Trace,
        runtime: Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
    ) -> ProgramResult:
        system_prompt, prompt = self.resolve_prompt(trace.task)
        env = {**self.config.env}
        for name in (
            "MAZEBENCH_LIVE_USAGE_PATH",
            "MAZEBENCH_LIVE_REASONING_PATH",
        ):
            if value := os.environ.get(name):
                env[name] = value
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
            initial_messages = json.dumps(
                [message_to_wire(message) for message in prompt]
            )
            checkpoint_path = str(
                getattr(trace.task, "resume_checkpoint_path", "") or ""
            )
            if checkpoint_path:
                messages_path = Path(checkpoint_path).with_name(
                    "prime-resume-messages.json"
                )
                messages_path.write_text(initial_messages, encoding="utf8")
                env["INITIAL_MESSAGES_PATH"] = str(messages_path)
            else:
                env["INITIAL_MESSAGES"] = initial_messages
        program = await runtime.prepare_uv_script(PROGRAM_SOURCE, self.config.env)
        return await runtime.run_program([*program, *args], env)


__all__ = ["MazeBenchHarness"]
