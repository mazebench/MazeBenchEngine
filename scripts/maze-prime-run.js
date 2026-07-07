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
  const opts = { envDir: "", outDir: "", model: "", maxTurns: 20, vision: false, video: true };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[(index += 1)];

    if (arg === "--env-dir") opts.envDir = next();
    else if (arg === "--out") opts.outDir = next();
    else if (arg === "--model") opts.model = next();
    else if (arg === "--max-turns") opts.maxTurns = Math.max(1, Math.min(500, Number(next()) || 20));
    else if (arg === "--vision") opts.vision = true;
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

// Reshape the eval's info.maze_actions into the actions.jsonl the run page reads
// (turn, command_text, status), so the Moves feed populates for a Prime run.
function writeActionsJsonl(resultsPath, outDir) {
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
  const mazeActions = Array.isArray(info.maze_actions) ? info.maze_actions : [];
  const lines = mazeActions
    .filter((action) => action && action.turn != null)
    .map((action) =>
      JSON.stringify({
        turn: action.turn,
        command_text: String(action.command || action.raw_response || "").trim(),
        status: action.status || {}
      })
    );

  fs.writeFileSync(path.join(outDir, "actions.jsonl"), lines.length ? `${lines.join("\n")}\n` : "");
  return lines.length;
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
    const moves = writeActionsJsonl(resultsPath, opts.outDir);
    console.log(`[mazebench] wrote ${moves} move${moves === 1 ? "" : "s"} to actions.jsonl`);
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
