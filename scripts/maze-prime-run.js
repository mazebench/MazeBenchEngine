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
//     --max-turns <n> [--vision] [--no-video]

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const EXPORT_REPLAY = path.join(ROOT_DIR, "scripts", "maze-export-replay.js");

function parseArgs(argv) {
  const opts = { envDir: "", outDir: "", model: "", maxTurns: 20, vision: false, reasoning: "", video: true };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[(index += 1)];

    if (arg === "--env-dir") opts.envDir = next();
    else if (arg === "--out") opts.outDir = next();
    else if (arg === "--model") opts.model = next();
    else if (arg === "--max-turns") opts.maxTurns = Math.max(1, Math.min(500, Number(next()) || 20));
    else if (arg === "--vision") opts.vision = true;
    else if (arg === "--reasoning") opts.reasoning = String(next() || "").trim();
    else if (arg === "--no-video") opts.video = false;
  }

  if (!opts.envDir || !opts.outDir) {
    throw new Error("maze-prime-run.js requires --env-dir and --out");
  }

  return opts;
}

// mazebench is a Verifiers v1 taskset, run via `uv run eval` (NOT `prime eval
// run`, the legacy env-module loader). --max-turns is the per-rollout move
// budget; we fix examples/rollouts at 1 (one maze, one attempt) so the run is
// simply "make N moves and stop". -o keeps results inside the run dir.
function runEval(opts) {
  const evalOutDir = path.join(opts.outDir, "eval-output");
  const argv = ["run", "--project", opts.envDir, "eval", "mazebench"];

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
  }

  // Ask the model for reasoning tokens. OpenAI reasoning models and Claude
  // (extended thinking) emit reasoning_content when this is set; models that
  // don't support it ignore the knob. Without it, Claude returns no reasoning.
  if (opts.reasoning) {
    argv.push("--sampling.reasoning-effort", opts.reasoning);
  }

  console.log(`[mazebench] uv ${argv.join(" ")}`);

  return new Promise((resolve) => {
    const child = spawn("uv", argv, { cwd: opts.envDir, stdio: ["ignore", "inherit", "inherit"] });
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

    actionLines.push(JSON.stringify({ turn: action.turn, command_text: commandText, status }));

    if (detail.reasoning) {
      reasoning.push({
        move: action.turn,
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
