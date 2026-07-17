from __future__ import annotations

import json
import logging
import shlex
from pathlib import Path
from typing import Any

from pydantic import Field

import verifiers.v1 as vf

from mazebench.mazebench import (
    DEFAULT_GAME_ID,
    DEFAULT_NODE_BIN,
    DEFAULT_START_LEVEL_ID,
    DEFAULT_TARGET_GEMS,
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_VIEW,
    DEFAULT_YAW,
    GAME_WON_GEM_COUNT,
    MazeBenchTask,
    ROOM_EXPLORATION_REWARD_WEIGHT,
    build_rows,
    canonical_command_text,
    find_bridge_root,
    parse_level_ids,
    parse_text_action,
    scorecard_text,
    slim_status,
    target_text_for_row,
)
from verifiers.v1.clients import RolloutContext
from verifiers.v1.dialects.responses import ResponsesDialect
from verifiers.v1.runtimes import ProgramResult, Runtime
from verifiers.v1.trace import Trace

logger = logging.getLogger(__name__)

PROVIDER = "intercept"
KEY_VAR = "CODEX_INTERCEPT_KEY"
ARTIFACT_ROOT = "outputs/maze-codex-v1"


def patch_prime_codex_responses_overrides() -> None:
    if getattr(ResponsesDialect, "_mazebench_codex_patched", False):
        return

    original_apply_overrides = ResponsesDialect.apply_overrides

    def apply_overrides_without_codex_summary(
        self: ResponsesDialect,
        body: dict,
        model: str,
        sampling: vf.SamplingConfig,
    ) -> dict:
        patched = original_apply_overrides(self, body, model, sampling)
        if model.startswith("openai/") and "codex" in model.rsplit("/", 1)[-1]:
            reasoning = dict(patched.get("reasoning") or {})
            if reasoning.get("summary") == "auto":
                reasoning.pop("summary", None)
            if reasoning:
                patched["reasoning"] = reasoning
            else:
                patched.pop("reasoning", None)
        return patched

    ResponsesDialect.apply_overrides = apply_overrides_without_codex_summary
    ResponsesDialect._mazebench_codex_patched = True


patch_prime_codex_responses_overrides()


HELPER_JS = r"""#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const directions = new Set(["up", "down", "left", "right"]);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeLevelId(value) {
  const raw = String(value || "level_HxI").trim();
  const match = raw.match(/^(?:level_)?([A-Z])x([A-Z])$/i);
  return match ? `level_${match[1].toUpperCase()}x${match[2].toUpperCase()}` : raw;
}

function normalizeYaw(value) {
  const number = Number(value);
  const integer = Number.isInteger(number) ? number : 0;
  return ((integer % 4) + 4) % 4;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function parseArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || "";
    if (arg === "--repo-root") options.repoRoot = path.resolve(next());
    else if (arg === "--state") options.state = path.resolve(next());
    else if (arg === "--level") options.level = next();
    else if (arg === "--view") options.view = next();
    else if (arg === "--yaw") options.yaw = next();
    else if (arg === "--game-won-gem-count") options.gameWonGemCount = next();
    else if (arg === "--node-bin") options.nodeBin = next();
    else options.positional.push(arg);
  }
  return options;
}

function usage() {
  console.log(`Usage:
  node codex-play.js start --repo-root <path> --state <session.json> [options]
  node codex-play.js observe --state <session.json>
  node codex-play.js action --state <session.json> <command words...>`);
}

function bridgeArgs(session) {
  return [
    path.join(session.repoRoot, "scripts", "maze-bridge.js"),
    "--game", session.gameId || "maze",
    "--level", normalizeLevelId(session.levelId),
    "--view", session.view || "top-diagonal",
    "--yaw", String(normalizeYaw(session.yaw)),
    "--game-won-gem-count", String(positiveInt(session.gameWonGemCount, 100))
  ];
}

function runBridge(session, message) {
  const replay = (session.actions || [])
    .filter((action) => action && action.message && action.replay !== false)
    .map((action) => action.message);
  const messages = [...replay, message, { command: "close" }];
  const result = spawnSync(session.nodeBin || process.execPath, bridgeArgs(session), {
    cwd: session.repoRoot,
    encoding: "utf8",
    input: `${messages.map((item) => JSON.stringify(item)).join("\n")}\n`,
    maxBuffer: 80 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "").trim() || `maze bridge exited ${result.status}`);
  }
  const responses = String(result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const previousFailure = responses.slice(0, replay.length).find((response) => !response.ok);
  if (previousFailure) {
    throw new Error(`Replay failed before requested command: ${previousFailure.error || "unknown error"}`);
  }
  const response = responses[replay.length];
  if (!response) throw new Error("maze bridge returned no response");
  if (!response.ok) throw new Error(response.error || "maze bridge command failed");
  return response;
}

function normalizeAction(words) {
  const text = words.join(" ").trim().toLowerCase();
  if (directions.has(text)) return { command: "move", direction: text };
  const move = text.match(/^move\s+(up|down|left|right)$/);
  if (move) return { command: "move", direction: move[1] };
  const rotate = text.match(/^rotate(?:\s+camera)?\s+(up|down|left|right)$/);
  if (rotate) return { command: "rotate_camera", direction: rotate[1] };
  if (text === "undo") return { command: "undo" };
  if (text === "reset" || text === "reset level") return { command: "reset_level" };
  if (text === "quit") return { command: "quit" };
  const goto = text.match(/^(?:go\s+to\s+level|goto)\s+([a-z])\s+([a-z])$/i);
  if (goto) return { command: "goto_level", x: goto[1].toUpperCase(), y: goto[2].toUpperCase() };
  throw new Error(`Unknown action: ${text}`);
}

function printStatus(response) {
  const value = redactAgentStatus(response.status || response);
  console.log(JSON.stringify(value, null, 2));
}

function redactAgentStatus(value) {
  if (Array.isArray(value)) return value.map(redactAgentStatus);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        const normalized = String(key).toLowerCase();
        return !normalized.includes("scorecard") &&
          normalized !== "_render_state" &&
          normalized !== "json_observation" &&
          !["current_position", "player", "player_elevation", "player_x", "player_y"].includes(normalized);
      })
      .map(([key, nested]) => [key, redactAgentStatus(nested)])
  );
}

function main() {
  const command = process.argv[2] || "help";
  const options = parseArgs(process.argv.slice(3));
  if (command === "help" || !options.state) {
    usage();
    process.exit(command === "help" ? 0 : 2);
  }

  if (command === "start") {
    const session = {
      actions: [],
      createdAt: new Date().toISOString(),
      gameId: "maze",
      gameWonGemCount: positiveInt(options.gameWonGemCount, 100),
      levelId: normalizeLevelId(options.level),
      nodeBin: options.nodeBin || process.execPath,
      repoRoot: options.repoRoot,
      view: options.view || "top-diagonal",
      yaw: normalizeYaw(Number(options.yaw))
    };
    const response = runBridge(session, { command: "observe" });
    session.initial = redactAgentStatus(response.status || response);
    session.lastStatus = session.initial;
    writeJson(options.state, session);
    printStatus(response);
    return;
  }

  const session = readJson(options.state, null);
  if (!session) throw new Error(`No session found at ${options.state}`);

  if (command === "observe") {
    printStatus(runBridge(session, { command: "observe" }));
    return;
  }

  if (command === "scorecard") {
    throw new Error("Scorecards are evaluator-only and are not available to game agents.");
  }

  if (command === "finalize") {
    if (process.env.MAZEBENCH_TRUSTED_FINALIZE !== "1") throw new Error("Unknown command: finalize");
    const response = runBridge(session, { command: "scorecard" });
    session.scorecard = (response.status || response).scorecard || response.scorecard || response.status || response;
    session.lastStatus = redactAgentStatus(response.status || response);
    writeJson(options.state, session);
    writeJson(path.join(path.dirname(options.state), "scorecard.json"), session.scorecard);
    console.log(JSON.stringify({ ok: true, finalized: true }, null, 2));
    return;
  }

  if (command === "action") {
    const message = normalizeAction(options.positional);
    const response = runBridge(session, message);
    const status = redactAgentStatus(response.status || response);
    const record = {
      turn: session.actions.length + 1,
      command_text: options.positional.join(" ").trim(),
      message,
      status
    };
    session.actions.push(record);
    session.lastStatus = status;
    writeJson(options.state, session);
    fs.appendFileSync(path.join(path.dirname(options.state), "actions.jsonl"), `${JSON.stringify(record)}\n`);
    printStatus(response);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
"""


CODEX_PROMPT = """You are controlling a 3D grid game through the local Codex CLI inside a Verifiers v1 rollout.

Use shell commands to interact with the maze. Do not modify source files or try
to parse the embedded observation manually. Your first shell command must start
the helper session. Use the helper paths below exactly:

- Helper: `{helper}`
- Session file: `{session_file}`
- Artifact directory: `{artifact_dir}`
- Repo root: `{repo_root}`

Start the session:

```bash
node "{helper}" start --repo-root "{repo_root}" --state "{session_file}" --level "{level_id}" --view "{view}" --yaw "{yaw}" --game-won-gem-count "{game_won_gem_count}" --node-bin "{node_bin}"
```

Then play {max_turns} maze action(s), unless the game reaches a terminal state earlier.
Do not stop immediately after `start`; choose and run at least one action when the
budget is positive. After each action, inspect the JSON observation and choose the next command.

Action command forms:

```bash
node "{helper}" action --state "{session_file}" up
node "{helper}" action --state "{session_file}" down
node "{helper}" action --state "{session_file}" left
node "{helper}" action --state "{session_file}" right
node "{helper}" action --state "{session_file}" rotate camera left
node "{helper}" action --state "{session_file}" undo
node "{helper}" action --state "{session_file}" reset
node "{helper}" action --state "{session_file}" go to level H I
```

Goal: {target_text}

Scoring is evaluator-only. Do not attempt to access a scorecard. Finish with a
short summary of the path you tried and how many gems were collected.
"""


class MazeBenchCodexConfig(vf.TasksetConfig):
    id: vf.EnvId = "mazebench_codex"
    num_examples: int = 1
    level_ids: str | list[str] | None = None
    start_level_id: str = DEFAULT_START_LEVEL_ID
    view: str = DEFAULT_VIEW
    yaw: int = DEFAULT_YAW
    game_won_gem_count: int = GAME_WON_GEM_COUNT
    node_bin: str = DEFAULT_NODE_BIN
    repo_root: str | None = None
    target_gems: int = DEFAULT_TARGET_GEMS
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    max_actions: int = 100


class MazeBenchCodexHarnessConfig(vf.HarnessConfig):
    id: vf.EnvId = "mazebench_codex"
    codex_bin: str = "codex"
    codex_model: str | None = None
    dangerously_bypass_approvals_and_sandbox: bool = True
    ephemeral: bool = True
    sandbox: str | None = None


class MazeBenchCodexHarness(vf.Harness[MazeBenchCodexHarnessConfig]):
    APPENDS_SYSTEM_PROMPT = False
    SUPPORTS_MCP = False

    async def setup(self, runtime: Runtime) -> None:
        result = await runtime.run(["sh", "-c", f"command -v {shlex.quote(self.config.codex_bin)}"], {})
        if result.exit_code != 0:
            raise RuntimeError(f"Codex CLI not found: {self.config.codex_bin!r}")

    async def launch(
        self,
        ctx: RolloutContext,
        trace: Trace,
        runtime: Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
    ) -> ProgramResult:
        del mcp_urls
        task = trace.task
        repo_root = Path(getattr(task, "repo_root", "") or find_bridge_root()).resolve()
        artifact_dir = repo_root / ARTIFACT_ROOT / trace.id
        artifact_dir.mkdir(parents=True, exist_ok=True)
        helper = artifact_dir / "codex-play.js"
        helper.write_text(HELPER_JS, encoding="utf8")
        helper.chmod(0o755)

        prompt = CODEX_PROMPT.format(
            artifact_dir=str(artifact_dir),
            game_won_gem_count=getattr(task, "game_won_gem_count", GAME_WON_GEM_COUNT),
            helper=str(helper),
            level_id=getattr(task, "level_id", DEFAULT_START_LEVEL_ID),
            max_turns=getattr(task, "max_actions", 100),
            node_bin=getattr(task, "node_bin", DEFAULT_NODE_BIN),
            repo_root=str(repo_root),
            session_file=str(artifact_dir / "session.json"),
            target_text=target_text_for_row(task.model_dump()),
            view=getattr(task, "view", DEFAULT_VIEW),
            yaw=getattr(task, "yaw", DEFAULT_YAW),
        )
        env = {**self.config.env, KEY_VAR: secret}
        tool_config = [
            arg
            for tool in self.config.disabled_tools or []
            for arg in ("--disable", tool)
        ]
        codex_model = self.config.codex_model or str(ctx.model).removeprefix("openai/")
        argv = [
            self.config.codex_bin,
            "exec",
            "--skip-git-repo-check",
            "-C",
            str(repo_root),
            "-m",
            codex_model,
            "-c",
            f"model_provider={PROVIDER}",
            "-c",
            f"model_providers.{PROVIDER}.name={PROVIDER}",
            "-c",
            f"model_providers.{PROVIDER}.base_url={endpoint}",
            "-c",
            f"model_providers.{PROVIDER}.env_key={KEY_VAR}",
            "-c",
            f"model_providers.{PROVIDER}.wire_api=responses",
            "-c",
            f"model_providers.{PROVIDER}.requires_openai_auth=false",
        ]
        if self.config.dangerously_bypass_approvals_and_sandbox:
            argv.append("--dangerously-bypass-approvals-and-sandbox")
        elif self.config.sandbox:
            argv.extend(["--sandbox", self.config.sandbox])
        if self.config.ephemeral:
            argv.append("--ephemeral")
        argv.extend(tool_config)
        argv.append(prompt)
        trace.info["maze_codex_artifact_dir"] = str(artifact_dir)
        return await runtime.run_program(argv, env)


class MazeBenchCodexTask(MazeBenchTask):
    artifact_root: str = ARTIFACT_ROOT
    max_actions: int = 100


class MazeBenchCodexTaskset(
    vf.Taskset[MazeBenchCodexTask, MazeBenchCodexConfig, vf.State]
):
    def load_tasks(self) -> list[MazeBenchCodexTask]:
        resolved_repo_root = find_bridge_root(self.config.repo_root)
        normalized_level_ids = parse_level_ids(
            self.config.level_ids,
            self.config.start_level_id,
        )
        rows = build_rows(
            count=self.config.num_examples,
            game_won_gem_count=int(self.config.game_won_gem_count),
            level_ids=normalized_level_ids,
            node_bin=self.config.node_bin,
            repo_root=resolved_repo_root,
            target_gems=int(self.config.target_gems),
            timeout_seconds=int(self.config.timeout_seconds),
            view=self.config.view,
            yaw=int(self.config.yaw),
        )
        return [
            MazeBenchCodexTask(
                idx=index,
                name=f"codex:{row['game_id']}:{row['level_id']}#{index}",
                prompt="Grid-game Codex CLI task. The harness will render the concrete run prompt.",
                system_prompt=None,
                artifact_root=ARTIFACT_ROOT,
                example_id=int(row["example_id"]),
                game_id=str(row["game_id"]),
                game_won_gem_count=int(row["game_won_gem_count"]),
                level_id=str(row["level_id"]),
                max_actions=int(self.config.max_actions),
                node_bin=str(row["node_bin"]),
                observation=str(row["observation"]),
                repo_root=str(row["repo_root"]),
                target_gems=int(row["target_gems"]),
                timeout_seconds=int(row["timeout_seconds"]),
                view=str(row["view"]),
                yaw=int(row["yaw"]),
            )
            for index, row in enumerate(rows)
        ]

    async def finalize(
        self,
        task: MazeBenchCodexTask,
        trace: vf.Trace,
        runtime: vf.Runtime,
    ) -> None:
        artifact_dir = Path(task.repo_root) / task.artifact_root / trace.id
        session = read_json_file(artifact_dir / "session.json", {})
        if session:
            await runtime.run(
                [
                    task.node_bin,
                    str(artifact_dir / "codex-play.js"),
                    "finalize",
                    "--state",
                    str(artifact_dir / "session.json"),
                ],
                {"MAZEBENCH_TRUSTED_FINALIZE": "1"},
            )
            session = read_json_file(artifact_dir / "session.json", session)
        scorecard = read_json_file(artifact_dir / "scorecard.json", {})
        actions = normalize_codex_actions(session.get("actions") or [])

        trace.info["maze_actions"] = actions
        trace.info["maze_scorecard"] = scorecard
        trace.info["maze_replay"] = {
            "game_id": task.game_id,
            "game_won_gem_count": int(task.game_won_gem_count),
            "initial": slim_status(session.get("initial") or {}),
            "start_level_id": task.level_id,
            "target_gems": int(task.target_gems),
            "actions": actions,
            "scorecard": scorecard,
        }
        trace.info["maze_codex_artifact_dir"] = str(artifact_dir)
        trace.info["maze_status"] = slim_status(session.get("lastStatus") or {})

    @vf.reward(weight=1.0)
    async def gem_score(self, task: MazeBenchCodexTask, trace: vf.Trace) -> float:
        scorecard = trace.info.get("maze_scorecard") or {}
        collected = scorecard.get("collected_gems") or scorecard.get("gem_count") or 0
        target = int(task.target_gems or 0)
        if target <= 0:
            return float(collected or 0)
        return min(1.0, float(collected or 0) / target)

    @vf.reward(weight=ROOM_EXPLORATION_REWARD_WEIGHT)
    async def room_exploration_score(self, trace: vf.Trace) -> float:
        status = trace.info.get("maze_status") or {}
        return float(max(0, len(status.get("visited_levels") or []) - 1))

    @vf.metric
    async def collected_gems(self, trace: vf.Trace) -> float:
        scorecard = trace.info.get("maze_scorecard") or {}
        return float(scorecard.get("collected_gems") or scorecard.get("gem_count") or 0)

    @vf.metric
    async def action_count(self, trace: vf.Trace) -> float:
        return float(len(trace.info.get("maze_actions") or []))


def read_json_file(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf8"))
    except Exception:
        return fallback


def normalize_codex_actions(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for index, action in enumerate(actions, start=1):
        message = action.get("message") or {}
        status = action.get("status") or {}
        command = str(message.get("command") or "")
        args = {key: value for key, value in message.items() if key != "command"}
        try:
            parsed_command, parsed_args = parse_text_action(
                action.get("command_text") or canonical_command_text(command, args)
            )
            command = parsed_command
            args = parsed_args
        except Exception:
            pass
        normalized.append(
            {
                "turn": index,
                "valid": True,
                "raw_response": str(action.get("command_text") or ""),
                "command": canonical_command_text(command, args),
                "normalized_action": command,
                "args": args,
                "error": None,
                "status": slim_status(status),
            }
        )
    return normalized


__all__ = ["MazeBenchCodexTaskset", "MazeBenchCodexHarness"]
