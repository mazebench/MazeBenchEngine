const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRunService } = require("../server/agent-runs");
const { createPrimeEvaluation } = require("../scripts/prime-create-evaluation");

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-prime-sync-"));
const binDir = path.join(rootDir, "bin");
const runId = "prime-sync-test";
const runDir = path.join(rootDir, "outputs", "maze-local", "site", runId);
const evalDir = path.join(runDir, "eval-output");
const syncDir = path.join(runDir, ".prime-eval-sync");
const argsPath = path.join(rootDir, "prime-args.txt");
const creatorArgsPath = path.join(rootDir, "creator-args.txt");
const callsPath = path.join(rootDir, "prime-calls.txt");
const originalPath = process.env.PATH;

fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(evalDir, { recursive: true });
fs.writeFileSync(
  path.join(binDir, "prime-create"),
  `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(creatorArgsPath)}
printf '{"evaluation_id":"evalsync123"}\n'
`,
  { mode: 0o755 }
);
fs.writeFileSync(
  path.join(binDir, "prime"),
  `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(argsPath)}
printf 'called\n' >> ${JSON.stringify(callsPath)}
printf '{"evaluation_id":"evalsync123"}\n'
`,
  { mode: 0o755 }
);
fs.writeFileSync(
  path.join(runDir, "run.json"),
  `${JSON.stringify({
    id: runId,
    kind: "prime",
    status: "finished",
    created_at: new Date().toISOString(),
    model: "prime",
    model_name: "openai/gpt-5.6-sol",
    harness: "codex",
    harness_label: "Codex",
    prime_execution: "local",
    game_id: "maze",
    level_id: "level_HxI",
    mode: "vision",
    gem_total: 70,
    room_total: 256
  }, null, 2)}\n`
);
fs.writeFileSync(
  path.join(evalDir, "results.jsonl"),
  `${JSON.stringify({ id: "sample-1", rewards: { score: 0.5 }, info: { stop_condition: "max_turns" } })}\n`
);

process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;

const game = { id: "maze", name: "Maze", worldMap: { levels: [{ id: "level_HxI" }] } };
const service = createAgentRunService({
  agentEnvironment: () => ({ codex: true, claude: true, docker: false, docker_installed: false }),
  buildWorlds: { countWorldGems: () => 70 },
  ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  getGame: () => game,
  loadJson,
  primeEvaluationCreator: { bin: path.join(binDir, "prime-create"), args: [] },
  rootDir,
  syncPrimeEvaluations: true,
  worldMaps: { defaultLevelIdForGame: () => "level_HxI", isMazeWorldLevelId: () => true }
});

(async () => {
  try {
    const directCalls = [];
    const direct = await createPrimeEvaluation(
      {
        environment: "personal-owner/mazebench",
        name: "Direct helper test",
        model: "openai/gpt-5.6-sol",
        metadata: path.join(evalDir, "helper-metadata.json")
      },
      {
        config: { apiKey: "test-key", baseUrl: "https://prime.test", teamId: "" },
        fetchImpl: async (url, init) => {
          directCalls.push({ url, init });
          const payload = directCalls.length === 1
            ? { data: { id: "environment-database-id" } }
            : { evaluation_id: "direct-eval-id" };
          return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(payload) };
        }
      }
    );
    assert.equal(direct.evaluation_id, "direct-eval-id");
    assert.match(directCalls[0].url, /environmentshub\/personal-owner\/mazebench\/@latest$/);
    const directPayload = JSON.parse(directCalls[1].init.body);
    assert.deepEqual(directPayload.environments, [{ id: "environment-database-id" }]);
    assert.equal(directPayload.model_name, "openai/gpt-5.6-sol");

    const started = service.syncPrimeEvaluation(runId);
    assert.equal(started.prime_evaluation_sync_status, "syncing");

    const deadline = Date.now() + 5000;
    let state = null;
    while (Date.now() < deadline) {
      state = loadJson(path.join(runDir, "prime-evaluation.json"), null);
      if (state?.sync_status === "synced") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(state?.evaluation_id, "evalsync123");
    assert.equal(state?.status, "COMPLETED");
    assert.equal(state?.viewer_url, "https://app.primeintellect.ai/dashboard/evaluations/evalsync123");
    const metadata = loadJson(path.join(syncDir, "metadata.json"), null);
    assert.equal(metadata.env_id, "mazebench/mazebench");
    assert.equal(metadata.model, "openai/gpt-5.6-sol");
    assert.equal(metadata.mazebench_harness, "codex");
    assert.equal(metadata.mazebench_observation_mode, "vision");
    const normalized = JSON.parse(fs.readFileSync(path.join(syncDir, "results.jsonl"), "utf8").trim());
    assert.equal(normalized.reward, 0.5);
    const args = fs.readFileSync(argsPath, "utf8");
    assert.match(args, /eval\npush\n/);
    assert.match(args, /--eval\nevalsync123/);
    const creatorArgs = fs.readFileSync(creatorArgsPath, "utf8");
    assert.match(creatorArgs, /--environment\nmazebench\/mazebench/);
    const summary = service.summarizeRun(runId);
    assert.equal(summary.prime_evaluation_sync_status, "synced");
    assert.equal(summary.prime_evaluation_id, "evalsync123");
    service.syncPrimeEvaluation(runId, { force: true });
    assert.equal(fs.readFileSync(callsPath, "utf8").trim().split(/\r?\n/).length, 1);

    fs.writeFileSync(
      path.join(runDir, "prime-evaluation.json"),
      `${JSON.stringify({ status: "UPLOADING", sync_status: "syncing" }, null, 2)}\n`
    );
    const interrupted = service.summarizeRun(runId);
    assert.equal(interrupted.prime_evaluation_sync_status, "failed");
    assert.match(interrupted.prime_evaluation_sync_error, /server restarted/i);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
  console.log("prime eval sync tests passed");
})().catch((error) => {
  process.env.PATH = originalPath;
  fs.rmSync(rootDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
