#!/usr/bin/env node

// Drive MazeBench with a LOCAL coding agent (Codex CLI or Claude Code) instead
// of Prime Intellect Verifiers. The agent plays the maze by shelling out to
// scripts/codex-play.js (a stateful CLI over scripts/maze-bridge.js). When the
// agent is done we make sure a scorecard exists and then render a replay video
// via scripts/maze-export-replay.js.
//
// Usage:
//   node scripts/maze-agent-local.js --model codex [options]
//   node scripts/maze-agent-local.js model=claude moves=10 level=HxI
//
// Options accept either "--flag value" or "key=value" form:
//   model        codex | claude                              (required)
//   container    true (run inside docker, host FS isolated)  (default true)
//                | false (run on host with the CLI sandbox)
//   image        container image tag                         (default mazebench-agent)
//   docker_bin   container runtime                           (default docker)
//   codex_auth / claude_auth   host auth dir to mount read-only (subscription logins)
//   tools        false (sandboxed: maze only) | true (full)  (default false)
//   mode         text (ASCII board) | vision (rendered PNGs) (default text)
//   moves        maze action budget shown to the agent       (default 20)
//   game         game directory under games/ (default maze; draft/online
//                worlds created in Build Mode use their games/<id> dirs)
//   level        world level id, e.g. HxI or level_HxI       (default level_HxI)
//   vision_width, vision_height   PNG size in vision mode     (default 512)
//   view         top | top-diagonal | diagonal | side-diagonal | side
//   yaw          0-3 camera yaw                               (default 0)
//   gems         unique gems required for game_won            (default 100)
//   model_name   underlying LLM id (codex -m / claude --model) (agent default)
//   reasoning    reasoning effort. codex: low|medium|high|xhigh; claude:
//                low|medium|high|xhigh|max (model/agent default when unset)
//   codex_fast   codex Fast mode (priority tier)              (default false)
//   video        on | off                                     (default on)
//   out          output directory for this run's artifacts
//   session      explicit session.json path (overrides out)
//   codex_bin    codex executable                             (default codex)
//   claude_bin   claude executable                            (default claude)
//   fast|draft   forwarded to the video renderer for speed
//   width|height|fps  forwarded to the video renderer
//   dry_run      print the agent command + prompt and exit (no run)

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const HELPER = path.join(ROOT_DIR, "scripts", "codex-play.js");
const EXPORT_REPLAY = path.join(ROOT_DIR, "scripts", "maze-export-replay.js");
const VIEW_NAMES = ["top", "top-diagonal", "diagonal", "side-diagonal", "side"];

function parseArgs(argv) {
  const raw = {};
  const passthrough = [];
  let sawSeparator = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      sawSeparator = true;
      continue;
    }

    if (sawSeparator) {
      passthrough.push(arg);
      continue;
    }

    const kv = arg.match(/^(?:--)?([A-Za-z_][\w-]*)=(.*)$/);
    if (kv) {
      raw[kv[1].replace(/-/g, "_")] = kv[2];
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-/g, "_");
      const next = argv[index + 1];
      // Boolean-ish flags (video renderer passthrough) take no value.
      if (["fast", "draft", "no_video"].includes(key) || next === undefined || next.startsWith("--")) {
        raw[key] = "true";
      } else {
        raw[key] = next;
        index += 1;
      }
      continue;
    }

    passthrough.push(arg);
  }

  return { raw, passthrough };
}

function normalizeLevelId(value) {
  const match = String(value || "level_HxI").trim().match(/^(?:level_)?([A-Za-z])x([A-Za-z])$/);
  return match ? `level_${match[1].toUpperCase()}x${match[2].toUpperCase()}` : "level_HxI";
}

function normalizeGameId(value) {
  const gameId = String(value || "maze").trim();
  return /^[a-z0-9][a-z0-9_-]*$/i.test(gameId) ? gameId : "maze";
}

function isTruthy(value, fallback = false) {
  if (value === undefined) return fallback;
  return !["off", "false", "0", "no", ""].includes(String(value).toLowerCase());
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

function buildPrompt(config) {
  const visionFlags = config.mode === "vision"
    ? ` --vision --vision-width ${config.visionWidth} --vision-height ${config.visionHeight}`
    : "";
  const observation = config.mode === "vision"
    ? `This is VISION mode. Every helper command prints JSON containing a
"frame_image" field: an absolute path to a PNG of the current maze view. OPEN
and LOOK AT that image to decide your next move — there is NO ASCII board. The
JSON also carries a short text status (current_room, gem_count, player
x/y/elevation, allowed_commands). Rendering runs a headless browser, so each
command takes a few seconds.`
    : `This is TEXT mode. Every helper command prints a JSON observation with an
ASCII board in the "level" field plus a short status. Read the JSON to choose
your next move.`;
  const toolsNote = config.tools
    ? ""
    : `
You are sandboxed: you may ONLY run the maze helper commands shown below${
        config.mode === "vision" ? " and open the frame_image PNG" : ""
      }.
Reading other files, writing files, running other programs, and network access
are blocked. Do not attempt them — just play the maze.
`;

  return `You are playing MazeBench, a 3D grid maze, through a local CLI helper.
Drive the game ONLY through the helper commands below. Do NOT read or modify
source files and do NOT try to parse the board yourself.

${observation}
${toolsNote}
Repo root:    ${ROOT_DIR}
Helper:       ${HELPER}
Session file: ${config.sessionFile}

${config.resume
    ? `You are CONTINUING the SAME MazeBench game you were just playing — you already
have the full history in memory and know the helper. The session file is still
${config.sessionFile}. Do NOT run "start"; that would erase the progress.

Your FIRST shell command must re-read the current observation:

  node "${HELPER}" observe --state "${config.sessionFile}"

Then play up to ${config.moves} MORE maze action(s) from where you left off,`
    : config.seed
    ? `This maze is ALREADY IN PROGRESS: earlier moves were made and the game state
is saved in the session file. Do NOT run "start" — that would erase the progress.

Your FIRST shell command must read the current observation to see where the maze
stands right now:

  node "${HELPER}" observe --state "${config.sessionFile}"

Then continue playing up to ${config.moves} MORE maze action(s) from that state,`
    : `Your FIRST shell command must start the session (run it exactly once):

  node "${HELPER}" start --repo-root "${ROOT_DIR}" --state "${config.sessionFile}" --game "${config.gameId}" --level "${config.levelId}" --view "${config.view}" --yaw "${config.yaw}" --game-won-gem-count "${config.gems}"${visionFlags}

Then play up to ${config.moves} maze action(s),`} unless the game reaches a
terminal state earlier. Do not stop right after the first command: choose and run
at least one action while the budget is positive. After each action, read the
observation (${config.mode === "vision" ? "the frame_image PNG plus the JSON status" : "the JSON board"}) and choose the next command.

Before you run each action command, write one short sentence (as normal text,
not a comment) explaining why you are choosing that move.

Action command forms:

  node "${HELPER}" action --state "${config.sessionFile}" up        (also down / left / right)
  node "${HELPER}" action --state "${config.sessionFile}" rotate camera left
  node "${HELPER}" action --state "${config.sessionFile}" undo
  node "${HELPER}" action --state "${config.sessionFile}" reset
  node "${HELPER}" action --state "${config.sessionFile}" go to level H I

Goal: collect as many unique gems as you can within the action budget. If the
player dies, recover with undo / reset / go to level.

Before you finish, ALWAYS write the final scorecard:

  node "${HELPER}" scorecard --state "${config.sessionFile}"

Finish with a one-line summary of the path you took and how many gems you got.`;
}

function agentCommand(config, prompt) {
  const maxTurns = String(config.moves * 2 + 15);

  if (config.model === "codex") {
    // Inside our container, the container IS the sandbox, and Codex's own
    // workspace-write sandbox (bubblewrap) cannot create user namespaces under
    // Docker — so bypass it (this is the documented "externally sandboxed" case).
    // On the host, tools=false uses Codex's workspace-write sandbox instead.
    const inContainer = process.env.MAZEBENCH_IN_CONTAINER === "1";
    const bypass = config.tools || inContainer;
    // --json streams structured events (agent messages, reasoning, shell calls)
    // on stdout so we can build a per-move reasoning log. `exec resume <id>`
    // continues a prior conversation (the model keeps its full memory).
    const argv = config.resume
      ? ["exec", "resume", config.resume, "--json", "--skip-git-repo-check"]
      : ["exec", "--json", "--skip-git-repo-check", "-C", config.tools ? ROOT_DIR : config.outDir];
    if (config.resume) {
      // `resume` doesn't accept --sandbox/-C; it keeps the resumed session's
      // own sandbox policy (workspace-write scoped to the original run dir, which
      // in-place continue reuses). Only re-assert bypass for container/tools runs.
      if (bypass) {
        argv.push("--dangerously-bypass-approvals-and-sandbox");
      }
    } else if (bypass) {
      argv.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      // `codex exec` is non-interactive and has no approval flag; --sandbox
      // workspace-write confines writes to the run dir (-C) and disables network
      // by default, and exec auto-runs commands within that sandbox.
      argv.push("--sandbox", "workspace-write");
    }
    // Ask Codex for fuller reasoning summaries (it emits `reasoning` items in
    // the JSON stream). Codex only ever exposes summaries — never raw
    // chain-of-thought — but "detailed" is richer than the terse default.
    argv.push("-c", 'model_reasoning_summary="detailed"');
    if (config.modelName) {
      argv.push("-m", config.modelName);
    }
    if (config.reasoning) {
      argv.push("-c", `model_reasoning_effort="${config.reasoning}"`);
    }
    if (config.codexFast) {
      // The "priority" service tier is Codex's Fast mode (~1.5x speed).
      argv.push("-c", 'service_tier="priority"');
    }
    argv.push(prompt);
    return { bin: config.codexBin, argv };
  }

  if (config.model === "claude") {
    // stream-json (requires --verbose in -p mode) emits the structured event
    // stream we parse into the reasoning log; --include-partial-messages adds the
    // text_delta/thinking_delta chunks that carry the actual reasoning (the
    // aggregated `thinking` blocks are withheld).
    const argv = [
      "-p", prompt,
      "--output-format", "stream-json", "--verbose", "--include-partial-messages"
    ];
    // Resume the prior conversation so the model keeps its full memory.
    if (config.resume) {
      argv.push("--resume", config.resume);
    }
    if (config.tools) {
      argv.push("--permission-mode", "bypassPermissions");
    } else {
      // dontAsk auto-denies every tool not on the allowlist (no prompt, run
      // continues). Allow ONLY the maze helper — both the quoted form the
      // prompt uses and the bare form, since Bash patterns match the literal
      // command string. Claude blocks command chaining per-subcommand, so this
      // cannot be widened with `; other-cmd`. Vision also needs to read frames.
      const allow = config.claudeAllowedTools
        ? [config.claudeAllowedTools]
        : [`Bash(node "${HELPER}" *)`, `Bash(node ${HELPER} *)`];
      if (config.mode === "vision") {
        allow.push(`Read(${path.join(config.outDir, "frames")}/**)`);
      }
      argv.push("--permission-mode", "dontAsk", "--allowedTools", allow.join(","));
    }
    argv.push("--max-turns", maxTurns);
    if (config.modelName) {
      argv.push("--model", config.modelName);
    }
    // Claude Code's reasoning-effort knob (low|medium|high|xhigh|max).
    if (["low", "medium", "high", "xhigh", "max"].includes(config.reasoning)) {
      argv.push("--effort", config.reasoning);
    }
    return { bin: config.claudeBin, argv };
  }

  throw new Error(`Unknown model: ${config.model} (expected "codex" or "claude")`);
}

function ensureAgentAvailable(bin) {
  const probe = spawnSync("sh", ["-c", `command -v ${JSON.stringify(bin)}`], { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error(
      `Agent CLI not found on PATH: ${bin}\n` +
        `Install it (or pass ${bin === "codex" ? "codex_bin=" : "claude_bin="}<path>) and try again.`
    );
  }
}

function actionFromShellCommand(command) {
  let inner = String(command || "");
  const wrapped = inner.match(/-lc\s+'([\s\S]*)'\s*$/) || inner.match(/-lc\s+"([\s\S]*)"\s*$/);
  if (wrapped) inner = wrapped[1];
  const match = inner.match(/\baction\s+--state\s+(?:"[^"]*"|'[^']*'|\S+)\s+([\s\S]+?)\s*$/);
  if (!match) return null;
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function resultFromOutput(output) {
  try {
    const status = JSON.parse(String(output || "").trim());
    return {
      moved: status.moved,
      gems: status.gem_count,
      room: status.current_room,
      room_changed: Boolean(status.room_changed),
      player_dead: Boolean(status.player_dead)
    };
  } catch (_error) {
    return {};
  }
}

// Turn codex's --json event stream into a per-move reasoning log plus a
// human-readable transcript.
function distillCodexEvents(raw) {
  const entries = [];
  const transcript = [];
  let commentary = [];
  let move = 0;
  let finalMessage = "";

  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (_error) {
      continue;
    }
    if ((event.type || event.msg?.type) !== "item.completed") continue;
    const item = event.item || event.msg?.item;
    if (!item) continue;
    const kind = item.type || item.item_type;

    if (kind === "reasoning" || kind === "agent_message") {
      const text = String(item.text || "").trim();
      if (!text) continue;
      commentary.push(text);
      finalMessage = text;
      transcript.push(`${kind === "reasoning" ? "[reasoning]" : "[agent]"} ${text}`);
    } else if (kind === "command_execution") {
      const command = String(item.command || "");
      const output = String(item.aggregated_output || "");
      transcript.push(`$ ${command}`);
      const action = actionFromShellCommand(command);
      if (action) {
        move += 1;
        entries.push({
          move,
          action,
          reasoning: commentary.join("\n\n").trim(),
          ...resultFromOutput(output)
        });
        commentary = [];
      }
    }
  }

  return { entries, transcript: transcript.join("\n\n"), finalMessage };
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : String(part?.text || ""))).join("\n");
  }
  return "";
}

// Turn Claude Code's --output-format stream-json events into the same per-move
// reasoning log. Reasoning comes from `text`/`thinking` content blocks; moves
// come from `tool_use` (Bash) blocks; results are matched by tool_use_id from
// the following `tool_result`.
function distillClaudeEvents(raw) {
  const entries = [];
  const transcript = [];
  const pending = new Map();
  let commentary = "";
  let move = 0;
  let finalMessage = "";

  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (_error) {
      continue;
    }

    // Reasoning arrives as streamed text/thinking deltas (--include-partial-messages).
    if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
      const delta = event.event.delta || {};
      if (delta.type === "text_delta" && delta.text) commentary += delta.text;
      else if (delta.type === "thinking_delta" && delta.thinking) commentary += delta.thinking;
      continue;
    }

    // Moves come from the aggregated assistant message's tool_use blocks.
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type !== "tool_use") continue;
        const command = block.name === "Bash" ? String(block.input?.command || "") : "";
        transcript.push(`$ ${command || block.name}`);
        const action = actionFromShellCommand(command);
        if (action) {
          move += 1;
          const reasoning = commentary.trim();
          if (reasoning) transcript.push(`[reasoning] ${reasoning}`);
          const entry = { move, action, reasoning };
          entries.push(entry);
          if (block.id) pending.set(block.id, entry);
          commentary = "";
        }
      }
    } else if (event.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === "tool_result" && pending.has(block.tool_use_id)) {
          const output = toolResultText(block.content);
          Object.assign(pending.get(block.tool_use_id), resultFromOutput(output));
          if (output) transcript.push(output.split("\n").slice(0, 3).join("\n"));
          pending.delete(block.tool_use_id);
        }
      }
    } else if (event.type === "result" && event.result) {
      finalMessage = String(event.result).trim();
    }
  }

  return { entries, transcript: transcript.join("\n\n"), finalMessage };
}

function writeReasoningArtifacts(config, raw, distilled, options = {}) {
  try {
    // When the caller already streamed agent-events.jsonl live, don't rewrite it.
    if (!options.skipEvents) {
      fs.writeFileSync(
        path.join(config.outDir, "agent-events.jsonl"),
        raw.endsWith("\n") ? raw : `${raw}\n`
      );
    }
    const { entries, transcript, finalMessage } = distilled;
    fs.writeFileSync(path.join(config.outDir, "reasoning.json"), `${JSON.stringify(entries, null, 2)}\n`);
    fs.writeFileSync(
      path.join(config.outDir, "agent.log"),
      `${transcript}${finalMessage ? `\n\n=== final summary ===\n${finalMessage}` : ""}\n`
    );

    console.log("\n=== Agent reasoning (per move) ===");
    for (const entry of entries) {
      const gist = String(entry.reasoning || "").replace(/\s+/g, " ").trim().slice(0, 110);
      const flags = [
        entry.moved === false ? "blocked" : null,
        entry.room_changed ? `→ ${entry.room}` : null,
        entry.gems != null ? `gems ${entry.gems}` : null
      ].filter(Boolean).join(", ");
      console.log(`  ${entry.move}. ${entry.action}${flags ? ` [${flags}]` : ""}${gist ? `\n     ↳ ${gist}` : ""}`);
    }
    if (entries.length === 0) {
      console.log("  (no maze actions detected in the event stream)");
    }
    console.log(`  full log: ${path.join(config.outDir, "reasoning.json")}`);
  } catch (error) {
    console.warn(`Could not capture reasoning log: ${error instanceof Error ? error.message : error}`);
  }
}

function runAgent(config, prompt) {
  const { bin, argv } = agentCommand(config, prompt);
  ensureAgentAvailable(bin);

  console.log(`\n=== Launching local ${config.model} agent (${bin}) ===`);
  console.log(`Session: ${config.sessionFile}`);
  console.log(
    `Tools ${config.tools ? "ON (full access)" : "OFF (sandboxed to maze only)"} | ` +
      `Mode ${config.mode}${config.mode === "vision" ? ` (${config.visionWidth}x${config.visionHeight})` : ""} | ` +
      `Game ${config.gameId} | Level ${config.levelId} | view ${config.view} | yaw ${config.yaw} | budget ${config.moves} moves\n`
  );

  // Both agents emit a structured JSONL event stream on stdout (codex --json /
  // claude --output-format stream-json). Append it to agent-events.jsonl AS IT
  // ARRIVES so the web UI can distill live per-move reasoning while the agent is
  // still playing. We use synchronous appends (not a buffered WriteStream) so
  // the on-disk file the web UI tails never lags behind — important for Codex,
  // whose events are sparse (one short message per move) and would otherwise
  // sit unflushed in a stream buffer until the very end.
  const distill = config.model === "codex" ? distillCodexEvents : distillClaudeEvents;
  const eventsPath = path.join(config.outDir, "agent-events.jsonl");
  // On a resume we keep the prior run's events and append the new turns, so the
  // reasoning feed shows the whole journey. A fresh run starts the file empty.
  if (!config.resume) {
    fs.writeFileSync(eventsPath, "");
  }

  return new Promise((resolve) => {
    const child = spawn(bin, argv, { cwd: ROOT_DIR, stdio: ["ignore", "pipe", "inherit"] });
    let raw = "";

    child.stdout.on("data", (chunk) => {
      raw += chunk.toString();
      try {
        fs.appendFileSync(eventsPath, chunk);
      } catch (_error) {
        /* best effort — the final write below still captures everything */
      }
    });
    child.on("error", (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      resolve();
    });
    child.on("close", (code) => {
      // On resume, distill the whole file (prior turns + the new ones) so the
      // feed keeps the earlier moves' reasoning too.
      let full = raw;
      if (config.resume) {
        try {
          full = fs.readFileSync(eventsPath, "utf8");
        } catch (_error) {
          full = raw;
        }
      }
      if (full.trim()) writeReasoningArtifacts(config, full, distill(full), { skipEvents: true });
      if (code !== 0) {
        console.warn(`\n(agent exited with status ${code}; continuing to export whatever it played)`);
      }
      resolve();
    });
  });
}

function ensureScorecard(config) {
  if (!fs.existsSync(config.sessionFile)) {
    return false;
  }
  // Idempotent: writes scorecard.json even if the agent already did.
  const result = spawnSync(process.execPath, [HELPER, "scorecard", "--state", config.sessionFile], {
    cwd: ROOT_DIR,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    console.warn(`Could not finalize scorecard: ${(result.stderr || "").trim()}`);
    return false;
  }
  return true;
}

function exportReplay(config) {
  const argv = [EXPORT_REPLAY, config.outDir];
  if (config.video) {
    if (config.fast) argv.push("--fast");
    if (config.draft) argv.push("--draft");
    if (config.width) argv.push("--width", String(config.width));
    if (config.height) argv.push("--height", String(config.height));
    if (config.fps) argv.push("--fps", String(config.fps));
  } else {
    argv.push("--no-video");
  }

  console.log(`\n=== Exporting artifacts${config.video ? " + replay video" : ""} ===`);
  const result = spawnSync(process.execPath, argv, { cwd: ROOT_DIR, stdio: "inherit" });
  if (result.status !== 0) {
    console.warn(
      "\nReplay export failed. The session JSON is still saved; you can retry with:\n" +
        `  node scripts/maze-export-replay.js ${config.outDir}`
    );
    return false;
  }
  return true;
}

function expandTilde(value) {
  const text = String(value || "");
  return text.startsWith("~") ? path.join(process.env.HOME || "", text.slice(1)) : text;
}

// Claude Code stores a subscription login in the macOS Keychain (service
// "Claude Code-credentials"), not a file. These read it so we can mount it.
function claudeKeychainAvailable() {
  if (process.platform !== "darwin") return false;
  const probe = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
    encoding: "utf8"
  });
  return probe.status === 0;
}

function extractClaudeKeychainCredential() {
  const result = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
    encoding: "utf8"
  });
  if (result.status !== 0) return null;
  const out = String(result.stdout || "").trim();
  return out.startsWith("{") ? out : null;
}

// Read the Codex model catalog (with per-model reasoning levels + fast-tier
// availability) that the Codex app caches on the host.
function loadCodexModels() {
  try {
    const cache = JSON.parse(
      fs.readFileSync(path.join(process.env.HOME || "", ".codex", "models_cache.json"), "utf8")
    );
    return (Array.isArray(cache.models) ? cache.models : [])
      .filter((m) => m && (m.slug || m.id))
      .map((m) => ({
        slug: String(m.slug || m.id),
        displayName: String(m.display_name || m.slug || m.id),
        description: String(m.description || "").replace(/\s+/g, " ").slice(0, 56),
        defaultReasoning: String(m.default_reasoning_level || ""),
        reasoningLevels: Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels
              .filter((l) => l && l.effort)
              .map((l) => ({ effort: String(l.effort), description: String(l.description || "") }))
          : [],
        fast:
          (Array.isArray(m.additional_speed_tiers) && m.additional_speed_tiers.includes("fast")) ||
          (Array.isArray(m.service_tiers) &&
            m.service_tiers.some((t) => /fast|priority/i.test(String((t && (t.id || t.name)) || ""))))
      }));
  } catch (_error) {
    return [];
  }
}

// Re-exec this runner inside a container so the agent is fully isolated from the
// host filesystem: only the output directory is mounted, and credentials are
// passed by env. Everything else the agent could touch lives in the image.
function runInContainer(config, raw) {
  const hostOutputs = path.join(ROOT_DIR, "outputs", "maze-local");

  // Forward the meaningful options to the in-container runner. Host-specific
  // path options (out/session) are intentionally dropped; the inner run writes
  // under the mounted /app/outputs/maze-local.
  const forwardKeys = [
    "model", "moves", "mode", "tools", "game", "level", "view", "yaw", "gems",
    "video", "no_video", "fast", "draft", "width", "height", "fps",
    "vision_width", "vision_height", "model_name", "llm",
    "reasoning", "effort", "codex_fast",
    "codex_bin", "claude_bin", "claude_allowed_tools"
  ];
  const inner = ["node", "scripts/maze-agent-local.js", "container=false"];
  for (const key of forwardKeys) {
    if (raw[key] !== undefined) inner.push(`${key}=${raw[key]}`);
  }
  // An explicit out dir inside the mounted outputs tree survives the re-exec:
  // rewrite it to the container-side path so callers (e.g. the web UI) can
  // tail a run directory they chose. Out dirs elsewhere are dropped as before.
  if (raw.out) {
    const hostOut = path.resolve(raw.out);
    const relative = path.relative(hostOutputs, hostOut);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      inner.push(`out=${path.posix.join("/app/outputs/maze-local", relative.split(path.sep).join("/"))}`);
    }
  }

  const dockerArgs = [
    "run", "--rm", "-i",
    "-e", "MAZEBENCH_IN_CONTAINER=1",
    "-v", `${hostOutputs}:/app/outputs/maze-local`
  ];
  // Draft/online worlds are not baked into the image — mount the game dir
  // read-only. Its images/assets_3d symlinks resolve against the in-image
  // /app/games/maze copy.
  if (config.gameId !== "maze") {
    const gameDir = path.join(ROOT_DIR, "games", config.gameId);
    if (!fs.existsSync(gameDir)) {
      console.error(`Game directory not found: ${gameDir}`);
      return 1;
    }
    dockerArgs.push("-v", `${gameDir}:/app/games/${config.gameId}:ro`);
  }
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    if (process.env[key]) dockerArgs.push("-e", key);
  }
  // Optional: mount ONLY the credential file (read-only) for subscription
  // logins. We deliberately do NOT mount the whole ~/.codex or ~/.claude, which
  // hold history, memories, logs, etc. — that would leak personal data into the
  // container and can be gigabytes.
  let codexAutoMounted = false;
  if (raw.codex_auth) {
    const p = path.resolve(expandTilde(raw.codex_auth));
    const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, "auth.json") : p;
    dockerArgs.push("-v", `${file}:/home/pwuser/.codex/auth.json:ro`);
  } else if (config.model === "codex" && !process.env.OPENAI_API_KEY) {
    // Auto: mount the Codex subscription login (~/.codex/auth.json) read-only when
    // no explicit credential is given, so `model=codex` just works.
    const authFile = path.join(process.env.HOME || "", ".codex", "auth.json");
    if (fs.existsSync(authFile)) {
      dockerArgs.push("-v", `${authFile}:/home/pwuser/.codex/auth.json:ro`);
      codexAutoMounted = true;
    }
  }
  if (raw.claude_auth) {
    const p = path.resolve(expandTilde(raw.claude_auth));
    const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, ".credentials.json") : p;
    dockerArgs.push("-v", `${file}:/home/pwuser/.claude/.credentials.json:ro`);
  }
  // Auto: a Claude Code subscription login lives in the macOS Keychain (no file
  // to mount), so materialize just that credential into a short-lived temp file
  // when no explicit Claude credential was supplied.
  let claudeCredTemp = null;
  if (
    config.model === "claude" &&
    !raw.claude_auth &&
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
    claudeKeychainAvailable()
  ) {
    claudeCredTemp = path.join("/tmp", `mazebench-claude-cred-${process.pid}.json`);
    dockerArgs.push("-v", `${claudeCredTemp}:/home/pwuser/.claude/.credentials.json:ro`);
  }
  dockerArgs.push(config.image, ...inner);

  if (isTruthy(raw.dry_run, false)) {
    console.log(`# would run in container (${config.image}):`);
    console.log([config.dockerBin, ...dockerArgs].join(" "));
    if (claudeCredTemp) {
      console.log("# (mounts your Claude Code subscription credential from the Keychain, read-only)");
    }
    console.log(`\n# host artifacts would appear under: ${hostOutputs}`);
    return 0;
  }

  const dockerProbe = spawnSync("sh", ["-c", `command -v ${JSON.stringify(config.dockerBin)}`], {
    encoding: "utf8"
  });
  if (dockerProbe.status !== 0) {
    console.error(
      `Container runtime not found: ${config.dockerBin}\n` +
        "Install Docker (or pass docker_bin=<path>, e.g. docker_bin=podman), or run on the\n" +
        "host with the CLI sandbox via container=false."
    );
    return 1;
  }
  fs.mkdirSync(hostOutputs, { recursive: true });

  // Stage the Keychain credential just before running, and remove it after.
  if (claudeCredTemp) {
    const cred = extractClaudeKeychainCredential();
    if (!cred) {
      console.error("Could not read your Claude Code credential from the Keychain.");
      return 1;
    }
    fs.writeFileSync(claudeCredTemp, cred, { mode: 0o600 });
  }

  console.log(`\n=== Running in container: ${config.image} ===`);
  console.log(`Host FS is isolated; only ${hostOutputs} is mounted (writable).`);
  const hasCred =
    process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN || raw.codex_auth || raw.claude_auth ||
    claudeCredTemp || codexAutoMounted;
  if (!hasCred) {
    console.warn(
      "Warning: the agent inside the container has no credentials. Set OPENAI_API_KEY " +
        "/ ANTHROPIC_API_KEY, or pass codex_auth=~/.codex (Codex) / claude_auth=<file> (Claude)."
    );
  }

  const result = spawnSync(config.dockerBin, dockerArgs, { cwd: ROOT_DIR, stdio: "inherit" });
  if (claudeCredTemp) {
    try {
      fs.unlinkSync(claudeCredTemp);
    } catch (_error) {
      /* best effort */
    }
  }
  if (result.error) {
    console.error(
      `\nFailed to launch container: ${result.error.message}\n` +
        `Is the image built? Run: docker build -t ${config.image} .  (or: npm run maze:build-image)`
    );
    return 1;
  }
  if (result.status !== 0) {
    console.error(
      `\nContainer exited with status ${result.status}. If the image is missing, build it:\n` +
        `  docker build -t ${config.image} .   (or: npm run maze:build-image)`
    );
  }
  return result.status || 0;
}

// Arrow-key single-select prompt (↑/↓ + Enter). Resolves to the chosen value.
function promptSelect(title, options) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY) {
      reject(new Error("interactive setup needs a terminal (TTY)"));
      return;
    }
    let index = 0;

    function render(first) {
      if (!first) stdout.write(`[${options.length + 1}A`);
      stdout.write("[0J");
      stdout.write(`? [1m${title}[0m\n`);
      options.forEach((option, i) => {
        const selected = i === index;
        const pointer = selected ? "[36m❯[0m" : " ";
        const label = selected ? `[36m${option.label}[0m` : option.label;
        const hint = option.hint ? ` [90m— ${option.hint}[0m` : "";
        stdout.write(`${pointer} ${label}${hint}\n`);
      });
    }

    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    render(true);

    function cleanup() {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    }

    function onData(key) {
      if (key === "") {
        cleanup();
        stdout.write("\n");
        process.exit(130);
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve(options[index].value);
      } else if (key === "[A" || key === "OA" || key === "k") {
        index = (index - 1 + options.length) % options.length;
        render(false);
      } else if (key === "[B" || key === "OB" || key === "j") {
        index = (index + 1) % options.length;
        render(false);
      }
    }

    stdin.on("data", onData);
  });
}

function promptText(title, defaultValue) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    rl.question(`? [1m${title}[0m${suffix}: `, (answer) => {
      rl.close();
      resolve(String(answer || "").trim() || defaultValue || "");
    });
  });
}

async function runWizard(raw) {
  const out = { ...raw };
  console.log("\n=== MazeBench setup ===");
  console.log("↑/↓ to move, Enter to select.\n");

  out.model = await promptSelect("Which agent?", [
    { label: "Codex CLI", value: "codex", hint: "uses your OpenAI/ChatGPT login" },
    { label: "Claude Code", value: "claude", hint: "uses your Claude subscription" }
  ]);

  const topModel = await promptSelect("Which model?", [
    { label: "Default", value: "__default__", hint: out.model === "claude" ? "subscription default" : "codex default" },
    { label: "Custom…", value: "__custom__", hint: "pick from the full list" }
  ]);
  let selectedModelInfo = null;
  delete out.model_name;
  if (topModel === "__custom__") {
    let modelInfos = [];
    let listOptions;
    if (out.model === "codex") {
      modelInfos = loadCodexModels();
      listOptions = modelInfos.map((m) => ({ label: m.displayName, value: m.slug, hint: m.description }));
    } else {
      listOptions = [
        { label: "Opus", value: "opus" },
        { label: "Sonnet", value: "sonnet" },
        { label: "Haiku", value: "haiku" }
      ];
    }
    listOptions.push({ label: "Type an id manually…", value: "__type__" });
    let picked = await promptSelect("Choose a model", listOptions);
    if (picked === "__type__") {
      picked = await promptText("Model id", out.model === "claude" ? "opus" : "gpt-5.5");
    } else if (out.model === "codex") {
      selectedModelInfo = modelInfos.find((m) => m.slug === picked) || null;
    }
    if (picked) out.model_name = picked;
  }

  // Codex-specific: reasoning effort, then Fast mode.
  if (out.model === "codex") {
    const levels = (selectedModelInfo && selectedModelInfo.reasoningLevels.length)
      ? selectedModelInfo.reasoningLevels.map((l) => ({ label: l.effort, value: l.effort, hint: l.description }))
      : [
          { label: "low", value: "low" },
          { label: "medium", value: "medium" },
          { label: "high", value: "high" },
          { label: "xhigh", value: "xhigh" }
        ];
    const effort = await promptSelect("Reasoning effort?", [
      { label: "Default", value: "", hint: selectedModelInfo && selectedModelInfo.defaultReasoning ? `model default (${selectedModelInfo.defaultReasoning})` : "model default" },
      ...levels
    ]);
    if (effort) out.reasoning = effort;
    else delete out.reasoning;

    if (!selectedModelInfo || selectedModelInfo.fast) {
      out.codex_fast = await promptSelect("Fast mode? (priority tier, ~1.5x speed)", [
        { label: "No", value: "false" },
        { label: "Yes", value: "true" }
      ]);
    }
  }

  let moves = await promptSelect("Action budget (moves)?", [
    { label: "5", value: "5" },
    { label: "10", value: "10" },
    { label: "20", value: "20" },
    { label: "50", value: "50" },
    { label: "Custom…", value: "__custom__" }
  ]);
  if (moves === "__custom__") moves = await promptText("Number of moves", "10");
  out.moves = moves;

  out.mode = await promptSelect("Observation mode?", [
    { label: "Text", value: "text", hint: "ASCII board" },
    { label: "Vision", value: "vision", hint: "rendered images (slower)" }
  ]);

  out.tools = await promptSelect("Agent capabilities?", [
    { label: "Sandboxed", value: "false", hint: "maze only" },
    { label: "Full access", value: "true", hint: "write files, run code, network" }
  ]);

  out.container = await promptSelect("Run location?", [
    { label: "Container", value: "true", hint: "isolated from your files — recommended" },
    { label: "Host", value: "false", hint: "no container" }
  ]);

  out.video = await promptSelect("Render replay video?", [
    { label: "Yes", value: "on" },
    { label: "No", value: "off" }
  ]);

  console.log("\n=== Summary ===");
  console.log(
    `  model=${out.model}` +
      `${out.model_name ? ` model_name=${out.model_name}` : ""}` +
      `${out.reasoning ? ` reasoning=${out.reasoning}` : ""}` +
      `${isTruthy(out.codex_fast, false) ? " fast=on" : ""}` +
      ` moves=${out.moves} mode=${out.mode} tools=${out.tools} container=${out.container} video=${out.video}\n`
  );
  const proceed = await promptSelect("Proceed?", [
    { label: "Run it", value: "go" },
    { label: "Cancel", value: "cancel" }
  ]);
  if (proceed !== "go") {
    console.log("Cancelled.");
    process.exit(0);
  }
  console.log("");
  return out;
}

async function main() {
  const { raw: parsedRaw, passthrough } = parseArgs(process.argv.slice(2));
  let raw = parsedRaw;

  const wantWizard =
    isTruthy(raw.wizard, false) ||
    passthrough.includes("wizard") ||
    passthrough.includes("setup") ||
    (Object.keys(raw).length === 0 && passthrough.length === 0);
  if (wantWizard) {
    if (!process.stdin.isTTY) {
      console.error("The interactive setup needs a terminal. Pass parameters directly instead, e.g. model=codex moves=5.");
      process.exit(2);
    }
    raw = await runWizard(raw);
  }

  const model = String(raw.model || "").toLowerCase();

  if (!model || !["codex", "claude"].includes(model)) {
    console.error(
      "Usage: node scripts/maze-agent-local.js --model <codex|claude> [moves=N level=HxI ...]"
    );
    process.exit(2);
  }

  const view = VIEW_NAMES.includes(String(raw.view)) ? String(raw.view) : "top-diagonal";
  const outDir = raw.session
    ? path.dirname(path.resolve(raw.session))
    : path.resolve(raw.out || path.join(ROOT_DIR, "outputs", "maze-local", model, timestampSlug()));
  const sessionFile = raw.session ? path.resolve(raw.session) : path.join(outDir, "session.json");

  const config = {
    claudeBin: raw.claude_bin || "claude",
    claudeAllowedTools: raw.claude_allowed_tools || "",
    codexBin: raw.codex_bin || "codex",
    container: isTruthy(raw.container, true),
    dockerBin: raw.docker_bin || "docker",
    image: raw.image || "mazebench-agent",
    draft: isTruthy(raw.draft, false),
    fast: isTruthy(raw.fast, false),
    fps: raw.fps ? positiveInt(raw.fps, undefined) : undefined,
    gameId: normalizeGameId(raw.game),
    gems: positiveInt(raw.gems, 100),
    height: raw.height ? positiveInt(raw.height, undefined) : undefined,
    levelId: normalizeLevelId(raw.level),
    mode: String(raw.mode || raw.observation || "text").toLowerCase() === "vision" ? "vision" : "text",
    tools: isTruthy(raw.tools, false),
    model,
    modelName: raw.model_name || raw.llm || "",
    reasoning: String(raw.reasoning || raw.effort || "").toLowerCase(),
    codexFast: isTruthy(raw.codex_fast, false),
    moves: positiveInt(raw.moves, 20),
    outDir,
    // Continue a prior run. seed=true means the session.json (action history) is
    // present in outDir so we resume the maze from it instead of starting fresh.
    // resume=<conversation-id> additionally resumes the CLI conversation so the
    // model keeps its full memory (a true continue). resume implies seed.
    resume: String(raw.resume || "").trim(),
    seed: isTruthy(raw.seed, false) || Boolean(String(raw.resume || "").trim()),
    sessionFile,
    video: isTruthy(raw.video, true) && !isTruthy(raw.no_video, false),
    view,
    visionHeight: positiveInt(raw.vision_height, 512),
    visionWidth: positiveInt(raw.vision_width, 512),
    width: raw.width ? positiveInt(raw.width, undefined) : undefined,
    yaw: ((positiveInt(raw.yaw, 0) % 4) + 4) % 4
  };

  // Default: isolate the whole run inside a container. `container=false` (or the
  // in-container re-exec, flagged by MAZEBENCH_IN_CONTAINER) runs on the host.
  if (config.container && process.env.MAZEBENCH_IN_CONTAINER !== "1") {
    process.exit(runInContainer(config, raw));
  }

  fs.mkdirSync(outDir, { recursive: true });

  const prompt = buildPrompt(config);

  if (isTruthy(raw.dry_run, false)) {
    const { bin, argv } = agentCommand(config, prompt);
    const shown = argv.map((arg) => (arg === prompt ? '"<prompt>"' : arg));
    console.log(`# would launch (${config.model}):`);
    console.log([bin, ...shown].join(" "));
    console.log(`# with <prompt>:\n${prompt}`);
    console.log(`\n# artifacts would land in: ${config.outDir}`);
    return;
  }

  await runAgent(config, prompt);

  const finalized = ensureScorecard(config);
  if (!finalized) {
    console.error(
      `\nNo session was written at ${config.sessionFile}. The agent likely never ran the ` +
        "start command. Nothing to export."
    );
    process.exit(1);
  }

  // Signal the rendering phase so the web UI can show a replay progress bar
  // (maze-export-replay.js updates replay-progress.json as it works).
  if (config.video) {
    try {
      fs.writeFileSync(
        path.join(config.outDir, "replay-progress.json"),
        `${JSON.stringify({ phase: "starting", percent: 0 })}\n`
      );
    } catch (_error) {
      /* best effort */
    }
  }

  exportReplay(config);

  console.log("\n=== Done ===");
  console.log(`Run directory: ${config.outDir}`);
  console.log(`  session.json      full state + per-action replay`);
  console.log(`  actions.jsonl     per-turn action log`);
  console.log(`  scorecard.json    gems / rooms / actions`);
  console.log(`  maze_scorecard.json + maze_actions.txt`);
  console.log(`  reasoning.json    [{move, action, reasoning, ...}] per move`);
  console.log(`  agent.log         human-readable agent transcript`);
  console.log(`  agent-events.jsonl raw agent event stream`);
  if (config.video) {
    console.log(`  maze_replay.mp4   replay video`);
  }
}

module.exports = {
  actionFromShellCommand,
  distillClaudeEvents,
  distillCodexEvents,
  loadCodexModels,
  resultFromOutput
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
