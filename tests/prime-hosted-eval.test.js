const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  hostedEvalArgs,
  hostedSampleToResultRow,
  parseArgs,
  writeHostedResults
} = require("../scripts/maze-prime-run");

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-hosted-eval-"));

try {
  const options = parseArgs([
    "--hosted",
    "--out",
    outDir,
    "--run-id",
    "site-run-1",
    "--model",
    "Qwen/Qwen3.5-0.8B",
    "--max-turns",
    "5",
    "--level",
    "level_HxI",
    "--game-won-gem-count",
    "69",
    "--reasoning",
    "low",
    "--no-quit",
    "--no-video"
  ]);
  assert.equal(options.hosted, true);
  assert.equal(options.allowQuit, false);
  assert.equal(options.video, false);

  const argv = hostedEvalArgs(options);
  assert.deepEqual(argv.slice(0, 4), ["eval", "run", "mazebench/mazebench", "--hosted"]);
  assert(argv.includes("--follow"));
  assert(argv.includes("--state-columns"));
  const envArgs = JSON.parse(argv[argv.indexOf("-a") + 1]);
  assert.deepEqual(envArgs, {
    num_train_examples: 1,
    num_eval_examples: 1,
    start_level_id: "level_HxI",
    game_won_gem_count: 69,
    max_actions: 5,
    allow_quit: false,
    observation_mode: "ascii"
  });
  const sampling = JSON.parse(argv[argv.indexOf("-S") + 1]);
  assert.deepEqual(sampling, { max_tokens: 64, reasoning_effort: "low" });

  const sample = {
    reward: 1.25,
    prompt: [{ role: "user", content: "start" }],
    completion: [{ role: "user", content: "after\n```text\nBOARD-AFTER\n```" }],
    info: {
      metrics: { gem_score: 1 },
      token_usage: { input_tokens: 100, output_tokens: 4 }
    },
    state: {
      maze_actions: [
        {
          turn: 1,
          command: "up",
          status: { current_room: "level_HxI", gem_count: 1, moved: true }
        }
      ],
      maze_scorecard: { gems: { collected: 1, total: 69 } },
      maze_replay: { start_level_id: "level_HxI", actions: ["up"] }
    }
  };
  const row = hostedSampleToResultRow(sample);
  assert.equal(row.reward, 1.25);
  assert.equal(row.info.maze_actions[0].command, "up");
  assert.equal(row.info.maze_actions[0].status.level, "BOARD-AFTER");
  assert.equal(row.info.maze_scorecard.gems.collected, 1);

  const resultsPath = writeHostedResults(options, { evaluation_id: "eval-1", samples: [sample] });
  assert.equal(fs.existsSync(resultsPath), true);
  const savedRow = JSON.parse(fs.readFileSync(resultsPath, "utf8").trim());
  assert.equal(savedRow.info.maze_actions.length, 1);
  const usage = JSON.parse(fs.readFileSync(path.join(outDir, "prime-usage.jsonl"), "utf8").trim());
  assert.equal(usage.turn, 1);
  assert.equal(usage.total_tokens, 104);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log("prime hosted eval tests passed");
