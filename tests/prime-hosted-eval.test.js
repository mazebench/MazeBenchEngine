const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  conversationTurns,
  hostedEvalArgs,
  hostedRolloutError,
  hostedSampleToResultRow,
  localRolloutError,
  parseArgs,
  providerReasoningText,
  replayExportArgs,
  writeHostedLiveArtifacts,
  writeHostedResults
} = require("../scripts/maze-prime-run");

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-hosted-eval-"));

try {
  for (const modelFacingSource of [
    path.join(__dirname, "..", "scripts", "maze-agent-local.js"),
    path.join(__dirname, "..", "environments", "mazebench", "mazebench_codex", "__init__.py")
  ]) {
    assert.doesNotMatch(
      fs.readFileSync(modelFacingSource, "utf8"),
      /You are playing MazeBench/i,
      `${path.basename(modelFacingSource)} must not use the benchmark-identifying prompt`
    );
  }
  for (const promptName of ["multiturn_system.txt", "multiturn_user.txt"]) {
    const prompt = fs.readFileSync(
      path.join(__dirname, "..", "environments", "mazebench", "mazebench", "prompts", promptName),
      "utf8"
    );
    assert.doesNotMatch(prompt, /MazeBench/i, `${promptName} must not disclose the benchmark name`);
  }
  const primeLiveEvalSource = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "maze-prime-live-eval.py"),
    "utf8"
  );
  assert.match(
    primeLiveEvalSource,
    /getattr\(message, "thinking_blocks", None\)/,
    "Prime live telemetry must tolerate responses without thinking_blocks"
  );
  assert.match(
    primeLiveEvalSource,
    /getattr\(message, "provider_state", None\)/,
    "Prime live telemetry must recover readable provider-state reasoning"
  );
  assert.match(
    primeLiveEvalSource,
    /except Exception as error:/,
    "Prime live telemetry failures must not fail the model request"
  );
  const mazeHarnessSource = fs.readFileSync(
    path.join(__dirname, "..", "environments", "mazebench", "mazebench", "harness.py"),
    "utf8"
  );
  assert.match(mazeHarnessSource, /client\.responses\.create\(/);
  assert.match(mazeHarnessSource, /reasoning=\{"summary": "auto"\}/);
  assert.match(mazeHarnessSource, /include=\["reasoning\.encrypted_content"\]/);
  assert.match(mazeHarnessSource, /and model_name\.startswith\(\("gpt-5", "o1", "o3", "o4"\)\)/);
  assert.match(mazeHarnessSource, /client\.chat\.completions\.create\(/);

  assert.equal(
    providerReasoningText([
      { type: "reasoning", summary: [{ type: "summary_text", text: "Readable summary" }], encrypted_content: "secret" },
      { type: "reasoning.encrypted", text: "must not surface" }
    ]),
    "Readable summary"
  );
  assert.equal(providerReasoningText([{ content: "not reasoning" }]), "");
  assert.equal(
    conversationTurns({
      nodes: [
        { message: { role: "user", content: "```text\nP.G\n```" } },
        {
          message: {
            role: "assistant",
            content: "right",
            provider_state: [{ type: "reasoning.summary", summary: "Provider fallback" }]
          }
        }
      ]
    })[0].reasoning,
    "Provider fallback"
  );

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
    auto_quit: false,
    auto_quit_threshold: 10,
    auto_quit_mode: "cumulative",
    auto_quit_window: 100,
    auto_quit_warning_moves: 10,
    observation_mode: "ascii"
  });
  const sampling = JSON.parse(argv[argv.indexOf("-S") + 1]);
  assert.deepEqual(sampling, { max_tokens: 512, reasoning_effort: "low" });

  const autoQuitOptions = parseArgs([
    "--hosted",
    "--out", outDir,
    "--auto-quit",
    "--auto-quit-threshold", "7.5",
    "--auto-quit-mode", "rolling",
    "--auto-quit-window", "80",
    "--auto-quit-warning-moves", "10"
  ]);
  const autoQuitArgv = hostedEvalArgs(autoQuitOptions);
  const autoQuitEnvArgs = JSON.parse(autoQuitArgv[autoQuitArgv.indexOf("-a") + 1]);
  assert.equal(autoQuitEnvArgs.auto_quit, true);
  assert.equal(autoQuitEnvArgs.auto_quit_threshold, 7.5);
  assert.equal(autoQuitEnvArgs.auto_quit_mode, "rolling");
  assert.equal(autoQuitEnvArgs.auto_quit_window, 80);
  assert.equal(autoQuitEnvArgs.auto_quit_warning_moves, 10);
  assert(autoQuitArgv[autoQuitArgv.indexOf("--state-columns") + 1].includes("maze_auto_quit"));

  const hiddenAsciiOptions = parseArgs([
    "--hosted",
    "--out", outDir,
    "--observation-mode", "ascii",
    "--hide-names",
    "--hide-names-seed", "repeatable-ascii-seed"
  ]);
  const hiddenAsciiArgv = hostedEvalArgs(hiddenAsciiOptions);
  const hiddenAsciiEnvArgs = JSON.parse(hiddenAsciiArgv[hiddenAsciiArgv.indexOf("-a") + 1]);
  assert.equal(hiddenAsciiEnvArgs.observation_mode, "ascii");
  assert.equal(hiddenAsciiEnvArgs.hide_names, true);
  assert.equal(hiddenAsciiEnvArgs.hide_names_seed, "repeatable-ascii-seed");
  const hiddenAsciiReplayArgs = replayExportArgs("results.jsonl", outDir, hiddenAsciiOptions);
  assert(hiddenAsciiReplayArgs.includes("--ascii-side-by-side"));
  assert.equal(hiddenAsciiReplayArgs[hiddenAsciiReplayArgs.indexOf("--width") + 1], "1280");
  assert.equal(hiddenAsciiReplayArgs[hiddenAsciiReplayArgs.indexOf("--height") + 1], "720");

  const jsonOptions = parseArgs([
    "--hosted",
    "--out", outDir,
    "--observation-mode", "json",
    "--omniscient",
    "--hide-names",
    "--hide-names-seed", "repeatable-json-seed"
  ]);
  const jsonArgv = hostedEvalArgs(jsonOptions);
  const jsonEnvArgs = JSON.parse(jsonArgv[jsonArgv.indexOf("-a") + 1]);
  assert.equal(jsonOptions.observationMode, "json");
  assert.equal(jsonEnvArgs.observation_mode, "json");
  assert.equal(jsonEnvArgs.omniscient, true);
  assert.equal(jsonEnvArgs.hide_names, true);
  assert.equal(jsonEnvArgs.hide_names_seed, "repeatable-json-seed");
  assert.equal(replayExportArgs("results.jsonl", outDir, jsonOptions).includes("--ascii-side-by-side"), false);

  const sample = {
    reward: 1.25,
    prompt: [{ role: "user", content: "start" }],
    completion: [{ role: "user", content: "after\n```text\nBOARD-AFTER\n```" }],
    info: {
      metrics: { gem_score: 1 },
      token_usage: { input_tokens: 100, output_tokens: 4 }
    },
    state: {
      maze_auto_quit: { percentage: 10, novel_states: 1, observed_states: 10 },
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
  assert.equal(row.info.maze_auto_quit.percentage, 10);
  assert.equal(row.info.maze_scorecard.gems.collected, 1);

  const resultsPath = writeHostedResults(options, { evaluation_id: "eval-1", samples: [sample] });
  assert.equal(fs.existsSync(resultsPath), true);
  const savedRow = JSON.parse(fs.readFileSync(resultsPath, "utf8").trim());
  assert.equal(savedRow.info.maze_actions.length, 1);
  const usage = JSON.parse(fs.readFileSync(path.join(outDir, "prime-usage.jsonl"), "utf8").trim());
  assert.equal(usage.turn, 1);
  assert.equal(usage.total_tokens, 104);

  const live = writeHostedLiveArtifacts(options, { evaluation_id: "eval-1", samples: [sample] });
  assert.equal(live.moves, 1);
  const liveAction = JSON.parse(fs.readFileSync(path.join(outDir, "actions.jsonl"), "utf8").trim());
  assert.equal(liveAction.command_text, "up");
  assert.equal(liveAction.valid, true);
  assert.equal(liveAction.status.level, "BOARD-AFTER");

  assert.equal(hostedRolloutError({ samples: [sample] }), "");
  assert.equal(hostedRolloutError({
    samples: [{ info: { stop_condition: "has_error", error: { error_chain_str: "ModelError -> HTTP 422" } } }]
  }), "ModelError -> HTTP 422");

  const failedResults = path.join(outDir, "failed-results.jsonl");
  fs.writeFileSync(failedResults, `${JSON.stringify({
    stop_condition: "error",
    errors: [{
      type: "ExceptionGroup",
      message: "wrapped",
      traceback: "openai.InternalServerError: 500 Internal Server Error\nServer got itself in trouble"
    }]
  })}\n`);
  assert.equal(localRolloutError(failedResults), "InternalServerError: 500 Internal Server Error");
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log("prime hosted eval tests passed");
