const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createAgentRunService,
  runReviewCommand,
  runReviewPrompt
} = require("../server/agent-runs");

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-run-review-"));
const binDir = path.join(rootDir, "bin");
const runId = "review-test-run";
const runDir = path.join(rootDir, "outputs", "maze-local", "site", runId);
const originalPath = process.env.PATH;
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(
  path.join(binDir, "codex"),
  `#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    output="$1"
  fi
  shift
done
printf '# Overall verdict\n\nThe agent had a useful idea at **action 1**, but should improve its route.' > "$output"
`,
  { mode: 0o755 }
);
fs.writeFileSync(
  path.join(runDir, "run.json"),
  `${JSON.stringify({
    id: runId,
    kind: "local",
    status: "finished",
    created_at: new Date().toISOString(),
    model: "codex",
    model_name: "gpt-5.6-sol",
    game_id: "maze",
    level_id: "level_HxI",
    mode: "text",
    gem_total: 70,
    room_total: 256
  }, null, 2)}\n`
);
fs.writeFileSync(
  path.join(runDir, "actions.jsonl"),
  `${JSON.stringify({ turn: 1, command_text: "up", valid: true, status: { current_room: "level_HxI", gem_count: 0 } })}\n`
);
fs.writeFileSync(
  path.join(runDir, "reasoning.json"),
  `${JSON.stringify([{ move: 1, reasoning: "I should explore upward.", action: "up" }], null, 2)}\n`
);

process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
const game = { id: "maze", name: "Maze", worldMap: { levels: [{ id: "level_HxI" }] } };
const service = createAgentRunService({
  agentEnvironment: () => ({ codex: true, claude: true, docker: false, docker_installed: false }),
  buildWorlds: { countWorldGems: () => 70 },
  ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  getGame: () => game,
  loadJson,
  reviewBins: { codex: path.join(binDir, "codex") },
  rootDir,
  worldMaps: { defaultLevelIdForGame: () => "level_HxI", isMazeWorldLevelId: () => true }
});

(async () => {
  try {
    const prompt = runReviewPrompt(runId, runDir, rootDir);
    assert.match(prompt, /full run/i);
    assert.match(prompt, /valid:false/);
    assert.match(prompt, /specific action numbers/i);
    const command = runReviewCommand({
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "max",
      runDir,
      rootDir,
      outputPath: path.join(runDir, "review.md"),
      prompt
    });
    assert.equal(command.bin, "codex");
    assert(command.argv.includes("read-only"));
    assert(command.argv.includes("gpt-5.6-sol"));
    assert(command.argv.some((value) => /model_reasoning_effort="max"/.test(value)));

    const started = service.generateRunReview(runId, {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning: "max"
    });
    assert.equal(started.status, "running");

    const deadline = Date.now() + 5000;
    let review = null;
    while (Date.now() < deadline) {
      review = service.getRunReview(runId);
      if (review.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(review?.status, "completed");
    assert.match(review?.review || "", /Overall verdict/);
    assert.match(review?.review || "", /action 1/);
    const summary = service.summarizeRun(runId);
    assert.equal(summary.review_ready, true);
    assert.equal(summary.review_model, "gpt-5.6-sol");

    fs.writeFileSync(
      path.join(runDir, "run-review.json"),
      `${JSON.stringify({
        schema_version: 1,
        generation_id: "interrupted-review",
        status: "running",
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoning: "ultra",
        started_at: new Date().toISOString(),
        review: "",
        error: ""
      }, null, 2)}\n`
    );
    const interrupted = service.getRunReview(runId);
    assert.equal(interrupted.status, "failed");
    assert.match(interrupted.error, /server restarted/i);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
  console.log("agent run review tests passed");
})().catch((error) => {
  process.env.PATH = originalPath;
  fs.rmSync(rootDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
