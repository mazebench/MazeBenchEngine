#!/usr/bin/env node
"use strict";

// Prime Verifiers run wrapper (Agent Mode).
//
// Runs the mazebench Verifiers v1 taskset via `uv run eval`, then builds the
// same replay artifacts the local Codex/Claude runner produces — maze_replay.mp4,
// maze_scorecard.json, and a per-move actions.jsonl — from the eval's
// results.jsonl. That lets the web run page show renderings + a video for Prime
// runs, not just the log. Spawned detached by server/agent-runs.js with its
// stdout/stderr wired to the run's launcher.log.
//
// Usage:
//   node maze-prime-run.js --env-dir <dir> --out <runDir> [--model <id>]
//     --max-turns <n> [--observation-mode <ascii|json|vision>] [--no-video]

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const EXPORT_REPLAY = path.join(ROOT_DIR, "scripts", "maze-export-replay.js");
const LIVE_EVAL = path.join(ROOT_DIR, "scripts", "maze-prime-live-eval.py");
const TERMINAL = path.join(ROOT_DIR, "scripts", "maze-terminal.js");
const HOSTED_STATE_FILE = "prime-evaluation.json";
const HOSTED_SAMPLES_FILE = "prime-evaluation-samples.json";

function parseArgs(argv) {
  const opts = {
    envDir: "",
    environment: "mazebench/mazebench",
    gameWonGemCount: 69,
    hosted: false,
    levelId: "level_HxI",
    maxTurns: 20,
    model: "",
    observationMode: "ascii",
    omniscient: false,
    hideNames: false,
    outDir: "",
    reasoning: "",
    runId: "",
    vision: false,
    allowQuit: true,
    video: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[(index += 1)];

    if (arg === "--env-dir") opts.envDir = next();
    else if (arg === "--environment") opts.environment = String(next() || opts.environment);
    else if (arg === "--out") opts.outDir = next();
    else if (arg === "--model") opts.model = next();
    else if (arg === "--run-id") opts.runId = String(next() || "");
    else if (arg === "--level") opts.levelId = String(next() || opts.levelId);
    else if (arg === "--game-won-gem-count") opts.gameWonGemCount = Math.max(1, Number(next()) || 69);
    else if (arg === "--max-turns") opts.maxTurns = Math.max(1, Math.min(500, Number(next()) || 20));
    else if (arg === "--hosted") opts.hosted = true;
    else if (arg === "--vision") {
      opts.vision = true;
      opts.observationMode = "vision";
    }
    else if (arg === "--observation-mode") {
      const mode = String(next() || "ascii").toLowerCase();
      opts.observationMode = ["json", "vision"].includes(mode) ? mode : "ascii";
      opts.vision = opts.observationMode === "vision";
    }
    else if (arg === "--omniscient") opts.omniscient = true;
    else if (arg === "--hide-names") opts.hideNames = true;
    else if (arg === "--reasoning") opts.reasoning = String(next() || "").trim();
    else if (arg === "--no-quit") opts.allowQuit = false;
    else if (arg === "--no-video") opts.video = false;
  }

  if (!opts.outDir || (!opts.hosted && !opts.envDir)) {
    throw new Error("maze-prime-run.js requires --out and, for local evaluations, --env-dir");
  }

  return opts;
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function parseJsonOutput(value) {
  const text = stripAnsi(value);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error(text);
  }
}

function hostedStatePath(opts) {
  return path.join(opts.outDir, HOSTED_STATE_FILE);
}

function updateHostedState(opts, patch) {
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(hostedStatePath(opts), "utf8"));
  } catch (_error) {
    /* first update */
  }
  writeJsonAtomic(hostedStatePath(opts), { ...previous, ...patch, updated_at: new Date().toISOString() });
}

function writeInitialStatus(opts) {
  const result = spawnSync(
    process.execPath,
    [
      TERMINAL,
      "--json",
      "--once",
      "--level",
      opts.levelId,
      "--game-won-gem-count",
      String(opts.gameWonGemCount)
    ],
    { cwd: ROOT_DIR, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (result.status !== 0) return;
  try {
    const payload = JSON.parse(result.stdout);
    writeJsonAtomic(path.join(opts.outDir, "initial-status.json"), {
      allowed_commands: payload.allowedCommands || [],
      current_room: payload.levelId || opts.levelId,
      current_view: payload.view || "top-diagonal",
      gem_count: 0,
      level: payload.observation || "",
      player: payload.player || null,
      player_dead: Boolean(payload.playerDead),
      solved: Boolean(payload.solved),
      visited_levels: [payload.levelId || opts.levelId],
      yaw: Number(payload.yaw) || 0
    });
  } catch (_error) {
    /* the hosted evaluation can still run without the local move-zero preview */
  }
}

function hostedEvalArgs(opts) {
  const envArgs = {
    num_train_examples: 1,
    num_eval_examples: 1,
    start_level_id: opts.levelId,
    game_won_gem_count: opts.gameWonGemCount,
    max_actions: opts.maxTurns,
    allow_quit: opts.allowQuit,
    observation_mode: opts.observationMode
  };
  if (opts.observationMode === "json") {
    envArgs.omniscient = opts.omniscient;
    envArgs.hide_names = opts.hideNames;
  }
  const samplingArgs = { max_tokens: 64 };
  if (opts.reasoning) samplingArgs.reasoning_effort = opts.reasoning;
  const evalName = `MazeBench Agent ${opts.runId || path.basename(opts.outDir)}`;
  const args = [
    "eval",
    "run",
    opts.environment,
    "--hosted",
    "--follow",
    "--eval-name",
    evalName,
    "-n",
    "1",
    "-r",
    "1",
    "-c",
    "1",
    "-S",
    JSON.stringify(samplingArgs),
    "-a",
    JSON.stringify(envArgs),
    "--state-columns",
    "maze_actions,maze_scorecard,maze_replay,maze_status",
    "--timeout-minutes",
    "60",
    "--poll-interval",
    "2"
  ];
  if (opts.model) args.push("-m", opts.model);
  return args;
}

function primeJson(args) {
  const result = spawnSync("prime", [...args, "--output", "json", "--plain"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000
  });
  if (result.status !== 0) {
    throw new Error(stripAnsi(result.stderr || result.stdout) || `prime ${args.join(" ")} failed`);
  }
  return parseJsonOutput(result.stdout);
}

function nestedField(value, key, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const [name, child] of Object.entries(value)) {
    if (["prompt", "completion", "logs"].includes(name)) continue;
    const found = nestedField(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function hostedSampleToResultRow(sample) {
  const mazeActions = nestedField(sample, "maze_actions") || [];
  const mazeScorecard = nestedField(sample, "maze_scorecard") || {};
  const mazeReplay = nestedField(sample, "maze_replay") || {};
  const observations = (Array.isArray(sample.completion) ? sample.completion : [])
    .filter((message) => message?.role === "user")
    .map((message) => extractBoard(messageText(message.content)));
  const hydratedActions = (Array.isArray(mazeActions) ? mazeActions : []).map((action, index) => {
    const board = observations[index] || "";
    return board
      ? { ...action, status: { ...(action.status || {}), level: board } }
      : action;
  });
  return {
    prompt: sample.prompt || [],
    completion: sample.completion || [],
    reward: Number(sample.reward ?? sample.score ?? 0),
    info: {
      ...(sample.info || {}),
      maze_actions: hydratedActions,
      maze_scorecard: mazeScorecard && typeof mazeScorecard === "object" ? mazeScorecard : {},
      maze_replay: mazeReplay && typeof mazeReplay === "object" ? mazeReplay : {}
    },
    metrics: sample.info?.metrics || {},
    nodes: []
  };
}

function writeHostedResults(opts, samplesPayload) {
  const samples = Array.isArray(samplesPayload?.samples) ? samplesPayload.samples : [];
  const outputDir = path.join(opts.outDir, "eval-output", "hosted");
  fs.mkdirSync(outputDir, { recursive: true });
  writeJsonAtomic(path.join(opts.outDir, HOSTED_SAMPLES_FILE), samplesPayload || { samples: [] });
  const rows = samples.map(hostedSampleToResultRow);
  const resultsPath = path.join(outputDir, "results.jsonl");
  fs.writeFileSync(resultsPath, rows.length ? `${rows.map(JSON.stringify).join("\n")}\n` : "", "utf8");

  const sample = samples[0] || {};
  const tokenUsage = sample.info?.token_usage || {};
  const actions = rows[0]?.info?.maze_actions || [];
  if (Number(tokenUsage.input_tokens || tokenUsage.final_input_tokens) > 0) {
    fs.writeFileSync(
      path.join(opts.outDir, "prime-usage.jsonl"),
      `${JSON.stringify({
        turn: Math.max(1, actions.length),
        input_tokens: Number(tokenUsage.input_tokens || tokenUsage.final_input_tokens) || 0,
        completion_tokens: Number(tokenUsage.output_tokens || tokenUsage.final_output_tokens) || 0,
        total_tokens:
          (Number(tokenUsage.input_tokens || tokenUsage.final_input_tokens) || 0) +
          (Number(tokenUsage.output_tokens || tokenUsage.final_output_tokens) || 0),
        recorded_at: Date.now() / 1000
      })}\n`,
      "utf8"
    );
  }
  return resultsPath;
}

function runHostedEval(opts) {
  writeInitialStatus(opts);
  const argv = hostedEvalArgs(opts);
  console.log(`[mazebench] prime ${argv.join(" ")}`);
  updateHostedState(opts, { status: "STARTING", environment: opts.environment, model: opts.model || null });

  return new Promise((resolve) => {
    const child = spawn("prime", argv, { cwd: ROOT_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let combined = "";
    let evaluationId = "";
    const consume = (chunk, stream) => {
      const text = chunk.toString();
      stream.write(text);
      combined = `${combined}${text}`.slice(-32 * 1024);
      if (!evaluationId) {
        const match = stripAnsi(combined).match(/Evaluation ID:\s*([a-z0-9]+)/i);
        if (match) {
          evaluationId = match[1];
          updateHostedState(opts, {
            evaluation_id: evaluationId,
            status: "RUNNING",
            viewer_url: `https://app.primeintellect.ai/dashboard/evaluations/${evaluationId}`
          });
        }
      }
    };
    child.stdout.on("data", (chunk) => consume(chunk, process.stdout));
    child.stderr.on("data", (chunk) => consume(chunk, process.stderr));
    child.on("error", (error) => {
      updateHostedState(opts, { status: "FAILED", error: error.message });
      resolve(127);
    });
    child.on("close", (code) => {
      if (!evaluationId) {
        updateHostedState(opts, {
          status: code === 0 ? "COMPLETED" : "FAILED",
          error: code === 0 ? null : `Prime evaluation launcher exited with status ${code ?? "unknown"}.`
        });
        resolve(code == null ? 1 : code);
        return;
      }
      try {
        const evaluation = primeJson(["eval", "get", evaluationId]);
        const samples = primeJson(["eval", "samples", evaluationId]);
        writeHostedResults(opts, samples);
        updateHostedState(opts, {
          ...evaluation,
          evaluation_id: evaluationId,
          status: evaluation.status || (code === 0 ? "COMPLETED" : "FAILED"),
          viewer_url: evaluation.viewer_url || `https://app.primeintellect.ai/dashboard/evaluations/${evaluationId}`
        });
        resolve(String(evaluation.status || "").toUpperCase() === "COMPLETED" ? 0 : code == null ? 1 : code);
      } catch (error) {
        updateHostedState(opts, { status: "FAILED", error: error.message });
        console.error(`[mazebench] could not import hosted evaluation ${evaluationId}: ${error.message}`);
        resolve(code == null ? 1 : code || 1);
      }
    });
  });
}

// mazebench is a Verifiers v1 taskset, run via `uv run eval` (NOT `prime eval
// run`, the legacy env-module loader). --max-turns is the per-rollout move
// budget; we fix examples/rollouts at 1 (one maze, one attempt) so the run is
// simply "make N moves and stop". -o keeps results inside the run dir.
function runEval(opts) {
  if (opts.hosted) return runHostedEval(opts);
  const evalOutDir = path.join(opts.outDir, "eval-output");
  const liveUsagePath = path.join(opts.outDir, "prime-usage.jsonl");
  const liveActionsPath = path.join(opts.outDir, "actions.jsonl");
  const liveReasoningPath = path.join(opts.outDir, "prime-reasoning.jsonl");
  const argv = ["run", "--project", opts.envDir, "python", LIVE_EVAL, "mazebench"];

  // The live exporter appends after every model turn. Start each run clean so
  // polling clients never mix usage from an earlier attempt.
  fs.writeFileSync(liveUsagePath, "");
  fs.writeFileSync(liveActionsPath, "");
  fs.writeFileSync(liveReasoningPath, "");

  if (opts.model) {
    argv.push("-m", opts.model);
  }

  argv.push(
    "-r",
    "1",
    "--taskset.num-examples",
    "1",
    "--max-turns",
    String(opts.maxTurns),
    "--rich",
    "False",
    "-o",
    evalOutDir
  );

  if (opts.vision) {
    argv.push("--taskset.observation-mode", "vision");
  } else if (opts.observationMode === "json") {
    argv.push("--taskset.observation-mode", "json");
    if (opts.omniscient) argv.push("--taskset.omniscient", "True");
    if (opts.hideNames) argv.push("--taskset.hide-names", "True");
  }

  if (!opts.allowQuit) {
    argv.push("--taskset.allow-quit", "False");
  }

  // Ask the model for reasoning tokens. OpenAI reasoning models and Claude
  // (extended thinking) emit reasoning_content when this is set; models that
  // don't support it ignore the knob. Without it, Claude returns no reasoning.
  if (opts.reasoning) {
    argv.push("--sampling.reasoning-effort", opts.reasoning);
  }

  console.log(`[mazebench] uv ${argv.join(" ")}`);

  return new Promise((resolve) => {
    const child = spawn("uv", argv, {
      cwd: opts.envDir,
      env: {
        ...process.env,
        MAZEBENCH_LIVE_USAGE_PATH: liveUsagePath,
        MAZEBENCH_LIVE_ACTIONS_PATH: liveActionsPath,
        MAZEBENCH_LIVE_REASONING_PATH: liveReasoningPath
      },
      stdio: ["ignore", "inherit", "inherit"]
    });
    child.on("error", (error) => {
      console.error(`[mazebench] could not start uv: ${error.message}`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code == null ? 1 : code));
  });
}

function findResults(dir, depth = 0) {
  if (depth > 5 || !fs.existsSync(dir)) {
    return null;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name === "results.jsonl") {
      return path.join(dir, entry.name);
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findResults(path.join(dir, entry.name), depth + 1);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

// Flatten an OpenAI-style message content (string, or a list of text/image
// parts) into plain text, dropping image parts.
function messageText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") return part.text || "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return content == null ? "" : String(content);
}

// The observation embeds the ASCII maze in a ```text … ``` fence; pull it out so
// the run page can show exactly the board the model read. In vision mode there
// is no fence (the board is an image), so this returns "".
function extractBoard(observation) {
  const match = String(observation || "").match(/```(?:text)?\r?\n([\s\S]*?)```/);
  return match ? match[1].replace(/\s+$/, "") : "";
}

// Walk the rollout's conversation once, pairing each assistant turn with the
// user observation that preceded it. Assistant turns carry reasoning_content
// (the reasoning tokens) and the chosen action; the user turn carries the board.
function conversationTurns(row) {
  const nodes = Array.isArray(row.nodes) ? row.nodes : [];
  const turns = [];
  let lastObservation = "";

  for (const node of nodes) {
    const message = node && node.message;
    if (!message || typeof message !== "object") {
      continue;
    }

    if (message.role === "user") {
      lastObservation = messageText(message.content);
    } else if (message.role === "assistant") {
      turns.push({
        board: extractBoard(lastObservation),
        reasoning: String(messageText(message.reasoning_content) || "").trim(),
        action: String(messageText(message.content) || "").trim()
      });
    }
  }

  return turns;
}

// Build the per-move artifacts the run page reads: actions.jsonl (turn,
// command_text, status incl. the text board) drives the board + move list, and
// reasoning.json drives the per-move reasoning shown alongside each move.
function writeMoveArtifacts(resultsPath, outDir) {
  const firstLine = fs
    .readFileSync(resultsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return 0;
  }

  const row = JSON.parse(firstLine);
  const info = row.info || {};
  const mazeActions = (Array.isArray(info.maze_actions) ? info.maze_actions : []).filter(
    (action) => action && action.turn != null
  );
  const turns = conversationTurns(row);

  const actionLines = [];
  const reasoning = [];

  mazeActions.forEach((action, index) => {
    const detail = turns[index] || {};
    const status = { ...(action.status || {}) };

    // Surface the board the model saw as status.level (what the run page reads
    // for the ASCII board panel in text mode).
    if (detail.board) {
      status.level = detail.board;
    }

    const commandText = String(action.command || action.raw_response || detail.action || "").trim();

    const timestamp = action.timestamp || action.created_at || detail.timestamp || null;
    actionLines.push(JSON.stringify({ turn: action.turn, timestamp, command_text: commandText, status }));

    if (detail.reasoning) {
      reasoning.push({
        move: action.turn,
        timestamp,
        reasoning: detail.reasoning,
        action: commandText,
        room: status.current_room || "",
        gems: status.gem_count ?? 0,
        moved: status.moved,
        player_dead: Boolean(status.player_dead)
      });
    }
  });

  fs.writeFileSync(path.join(outDir, "actions.jsonl"), actionLines.length ? `${actionLines.join("\n")}\n` : "");

  if (reasoning.length) {
    fs.writeFileSync(path.join(outDir, "reasoning.json"), `${JSON.stringify(reasoning, null, 2)}\n`);
  }

  return actionLines.length;
}

function runReplayExport(resultsPath, outDir, opts) {
  const argv = [EXPORT_REPLAY, resultsPath, "--out-dir", outDir, "--draft", "--width", "640", "--height", "640"];

  if (!opts.video) {
    argv.push("--no-video");
  }

  console.log("[mazebench] node scripts/maze-export-replay.js <results> --out-dir <run> --draft");

  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT_DIR, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (error) => {
      console.error(`[mazebench] replay export could not start: ${error.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code == null ? 1 : code));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const code = await runEval(opts);

  if (code !== 0) {
    console.error(`[mazebench] eval exited with status ${code}; skipping replay.`);
    process.exit(code);
  }

  const resultsPath = findResults(path.join(opts.outDir, "eval-output"));

  if (!resultsPath) {
    console.error("[mazebench] eval finished but no results.jsonl was found; skipping replay.");
    process.exit(0);
  }

  try {
    const moves = writeMoveArtifacts(resultsPath, opts.outDir);
    console.log(`[mazebench] wrote ${moves} move${moves === 1 ? "" : "s"} (board + reasoning) from the eval`);
  } catch (error) {
    console.error(`[mazebench] could not build the move feed: ${error.message}`);
  }

  console.log("\n=== Rendering replay video from the eval ===");
  const replayCode = await runReplayExport(resultsPath, opts.outDir, opts);

  if (replayCode !== 0) {
    // The eval itself succeeded; a missing video should not fail the whole run.
    console.error(`[mazebench] replay export exited ${replayCode}; the eval results are still saved.`);
  }

  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  hostedEvalArgs,
  hostedSampleToResultRow,
  parseArgs,
  writeHostedResults
};
