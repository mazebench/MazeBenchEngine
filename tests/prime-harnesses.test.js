const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  agenticConversationTurns,
  parseArgs,
  writeMoveArtifacts
} = require("../scripts/maze-prime-run");
const {
  createAgentRunService,
  filterPrimeCatalogForHarness,
  primeReasoningLevels,
  primeHarnessModelCompatible,
  primeSandboxIdsFromText
} = require("../server/agent-runs");
const { findPrimeResultsFile } = require("../server/token-usage");

const root = path.join(__dirname, "..");
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-prime-harness-"));
const statePath = path.join(runDir, "session.json");

try {
  const agentSource = fs.readFileSync(path.join(root, "public", "agent.js"), "utf8");
  const runSource = fs.readFileSync(path.join(root, "scripts", "maze-prime-run.js"), "utf8");
  const liveSource = fs.readFileSync(path.join(root, "scripts", "maze-prime-live-eval.py"), "utf8");
  const tasksetSource = fs.readFileSync(
    path.join(root, "environments", "mazebench_agent", "mazebench_agent", "__init__.py"),
    "utf8"
  );
  const project = fs.readFileSync(path.join(root, "environments", "mazebench_agent", "pyproject.toml"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "server", "app.js"), "utf8");
  const runsSource = fs.readFileSync(path.join(root, "server", "agent-runs.js"), "utf8");
  const pagesSource = fs.readFileSync(path.join(root, "server", "pages.js"), "utf8");
  const siteTheme = fs.readFileSync(path.join(root, "public", "local-site.css"), "utf8");

  assert.match(agentSource, /id: "none",\s*name: "Prime Intellect",\s*logo: '<img src="\/logos\/prime\.png"/);
  assert.doesNotMatch(agentSource, /<circle cx=\"24\" cy=\"24\" r=\"17\.5\"><\/circle><path d=\"M12\.5 35\.5 35\.5 12\.5\"><\/path>/);
  assert.match(agentSource, /id: "codex",\s*name: "Codex"/);
  assert.match(agentSource, /id: "claude-code",\s*name: "Claude Code"/);
  assert.match(agentSource, /harness: state\.harness/);
  assert.match(agentSource, /kind: "local",\s*subscription: true/);
  assert.match(agentSource, /query\.set\("harness", harnessId\)/);
  assert.match(agentSource, /const allowCustomModel = state\.execution === "local" \|\| state\.harness === "none"/);
  assert.doesNotMatch(agentSource, /harnessSupportsVision/);
  assert.match(agentSource, /function setExecution\(value\)/);
  assert.match(agentSource, /blockedPrimeAgentHarness/);
  assert.match(agentSource, /Codex and Claude Code via Prime are disabled/);
  assert.match(agentSource, /state\.execution = harnessId === "none" \? "prime" : "local"/);
  assert.match(agentSource, /async function checkLocalAvailability\(harnessId = state\.harness\)/);
  assert.match(agentSource, /state\.localAvailability = "checking";[\s\S]*?await refreshEnvironment\(\)/);
  assert.match(agentSource, /state\.localAvailability = "active"/);
  assert.match(agentSource, /if \(localProviderId\(harnessId\)\) checkLocalAvailability\(harnessId\)/);
  assert.match(agentSource, /if \(option\.dataset\.execution === "local"\) selectLocalRun\(\)/);
  assert.doesNotMatch(agentSource, /provider-card__avail/);
  assert.doesNotMatch(agentSource, /refreshEnvironment\(\)\.catch/);
  assert.ok(
    pagesSource.indexOf('id="provider-picker"') < pagesSource.indexOf('id="harness-execution"'),
    "the contextual Run through picker must render below the harness choices"
  );
  assert.match(pagesSource, /data-execution="prime"[\s\S]*?src="\/logos\/prime\.png"/);
  assert.match(pagesSource, /data-execution="local"[\s\S]*?<strong>Local Run<\/strong>/);
  assert.match(pagesSource, /id="local-run-status"[^>]*hidden/);
  assert.match(siteTheme, /\.execution-option__status\.is-active/);
  assert.match(siteTheme, /\.execution-option__spinner[\s\S]*?animation: executionStatusSpin/);
  assert.match(agentSource, /renderSelectionSlider\(host, "\.provider-card\.is-selected", selectionFrom, "provider"\)/);
  assert.match(siteTheme, /\.selection-slider--provider \{\s*border-radius: 12px;/);
  assert.match(agentSource, /tweenVisibility\(wrapper, supportsLocal, 420\)/);
  assert.match(agentSource, /const collapsedFrame = \{[\s\S]*?marginBottom: "0px",[\s\S]*?marginTop: "0px"/);
  assert.match(appSource, /allowLegacyLocalLaunch: true/);
  assert.match(appSource, /codex.*\["login", "status"\]/s);
  assert.match(appSource, /claude.*\["auth", "status", "--json"\]/s);
  assert.match(appSource, /logged in using chatgpt/i);
  assert.match(runsSource, /Subscription-backed local Codex and Claude Code launches are disabled/);
  assert.match(runsSource, /built-in coding-agent harness exposes benchmark internals/);
  assert.match(runsSource, /localLaunchEnvironment/);
  assert.match(runsSource, /delete environment\[key\]/);
  assert.doesNotMatch(runsSource, /const shouldWait = model === "claude"/);

  assert.match(runSource, /"--harness\.runtime\.type",\s*"prime"/);
  assert.match(runSource, /built-in coding-agent harness exposes the benchmark runtime and hidden state/);
  assert.match(runSource, /TEXT_RUNTIME_IMAGE = "node:24-bookworm-slim"/);
  assert.match(runSource, /VISION_RUNTIME_IMAGE = "mcr\.microsoft\.com\/playwright:v1\.60\.0-noble"/);
  assert.match(runSource, /opts\.vision \? VISION_RUNTIME_IMAGE : TEXT_RUNTIME_IMAGE/);
  assert.match(runSource, /const taskset = agentic \? "mazebench-agent" : "mazebench"/);
  assert.doesNotMatch(runSource, /Math\.min\(500/);
  assert.doesNotMatch(runsSource, /Math\.min\(500/);
  assert.match(liveSource, /MAZEBENCH_EVENT_V1/);
  assert.match(liveSource, /_patch_prime_codex_reasoning_summary/);
  assert.match(liveSource, /PRIME_HARNESS == "codex"/);
  assert.match(liveSource, /reasoning\.get\("summary"\) == "auto"/);
  assert.match(runSource, /MAZEBENCH_PRIME_HARNESS: opts\.harness/);
  assert.match(liveSource, /_patch_prime_usage_schema/);
  assert.match(liveSource, /cache_write_tokens/);

  assert.match(project, /verifiers @ git\+https:\/\/github\.com\/PrimeIntellect-ai\/verifiers\.git@df9c5aa58c28db717cfeb1150c1d0c751f4570a6/);
  assert.match(tasksetSource, /__all__ = \["MazeBenchAgentTaskset"\]/);
  assert.match(tasksetSource, /raise RuntimeError\(UNSAFE_HARNESS_MESSAGE\)/);
  assert.doesNotMatch(tasksetSource, /class \w*Harness/);
  assert.match(tasksetSource, /extra_instructions: str = ""/);
  assert.match(tasksetSource, /`view_image` in\s+Codex; `Read` in Claude Code/);
  assert.match(tasksetSource, /playwright-core@\{PLAYWRIGHT_CORE_VERSION\}/);
  assert.match(tasksetSource, /max_actions: int \| None = 20/);
  assert.match(tasksetSource, /"unlimited" if unlimited else str\(data\.max_actions\)/);
  assert.match(runSource, /\["--taskset\.max-actions", "None", "--max-turns", "None"\]/);
  assert.doesNotMatch(tasksetSource, /node \{HELPER\} scorecard/);
  assert.match(tasksetSource, /Scoring is evaluator-only/);

  assert.equal(primeHarnessModelCompatible("openai/gpt-5-codex", "codex"), true);
  assert.equal(primeHarnessModelCompatible("openai/gpt-4.1", "codex"), true);
  assert.equal(primeHarnessModelCompatible("openai/gpt-oss-120b", "codex"), false);
  assert.equal(primeHarnessModelCompatible("anthropic/claude-sonnet-5", "codex"), false);
  assert.equal(primeHarnessModelCompatible("anthropic/claude-sonnet-5", "claude-code"), true);
  assert.equal(primeHarnessModelCompatible("openai/gpt-5.4", "claude-code"), false);
  assert.deepEqual(
    primeSandboxIdsFromText([
      "PrimeRuntime: sandbox azquf017rdi59jhwqoiu43z0 up",
      "pod sandbox-job-azquf017rdi59jhwqoiu43z0",
      "PrimeRuntime: sandbox bbcdef2345678901 up"
    ].join("\n")),
    ["azquf017rdi59jhwqoiu43z0", "bbcdef2345678901"]
  );
  const sampleCatalog = {
    models: [
      { id: "openai/gpt-5-codex" },
      { id: "anthropic/claude-sonnet-5" },
      { id: "google/gemini-3.5-flash" }
    ]
  };
  assert.deepEqual(
    filterPrimeCatalogForHarness(sampleCatalog, "codex").models.map((model) => model.id),
    ["openai/gpt-5-codex"]
  );
  assert.deepEqual(
    filterPrimeCatalogForHarness(sampleCatalog, "claude-code").models.map((model) => model.id),
    ["anthropic/claude-sonnet-5"]
  );
  for (const modelId of [
    "openai/gpt-5.6-sol",
    "openai/gpt-5-chat",
    "anthropic/claude-fable-5",
    "google/gemini-3.5-flash",
    "x-ai/grok-4.20-multi-agent",
    "Qwen/Qwen3.5-0.8B"
  ]) {
    assert.deepEqual(primeReasoningLevels(modelId), ["low", "medium", "high"]);
  }
  assert.match(agentSource, /state\.execution === "prime"[\s\S]{0,100}return \["low", "medium", "high"\]/);

  const primeOnlyService = createAgentRunService({
    agentEnvironment: () => ({}),
    allowLegacyLocalLaunch: false,
    ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
    getGame: () => null,
    buildWorlds: { countWorldGems: () => 0 },
    loadJson: () => null,
    rootDir: runDir,
    worldMaps: {}
  });
  assert.throws(
    () => primeOnlyService.launchRuns({ kind: "local", model: "codex" }),
    /Subscription-backed local Codex and Claude Code launches are disabled/
  );

  const inactiveLocalService = createAgentRunService({
    agentEnvironment: () => ({ codex: false, claude: false }),
    allowLegacyLocalLaunch: true,
    ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
    getGame: () => null,
    buildWorlds: { countWorldGems: () => 0 },
    loadJson: () => null,
    rootDir: path.join(runDir, "inactive-local"),
    worldMaps: {}
  });
  assert.throws(
    () => inactiveLocalService.launchRuns({ kind: "local", model: "codex", subscription: true }),
    /active local subscription session/
  );

  assert.throws(
    () => parseArgs([
      "--env-dir", path.join(root, "environments", "mazebench_agent"),
      "--out", runDir,
      "--harness", "codex"
    ]),
    /built-in coding-agent harness exposes the benchmark runtime/
  );
  assert.throws(
    () => parseArgs([
      "--env-dir", path.join(root, "environments", "mazebench_agent"),
      "--out", runDir,
      "--harness", "claude"
    ]),
    /built-in coding-agent harness exposes the benchmark runtime/
  );
  assert.throws(
    () => parseArgs(["--env-dir", root, "--out", runDir, "--harness", "unknown"]),
    /Unknown Prime harness/
  );
  assert.throws(
    () => parseArgs([
      "--env-dir", root,
      "--out", runDir,
      "--harness", "codex",
      "--vision"
    ]),
    /built-in coding-agent harness exposes the benchmark runtime/
  );

  const start = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "maze-play.js"),
      "start",
      "--repo-root", root,
      "--state", statePath,
      "--level", "level_HxI",
      "--game-won-gem-count", "69",
      "--max-actions", "1"
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  assert.equal(start.status, 0, start.stderr);
  const startStatus = JSON.parse(start.stdout);
  assert.equal(Object.prototype.hasOwnProperty.call(startStatus, "player"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(startStatus, "scorecard"), false);
  assert.match(startStatus.level, /P|p/);

  const action = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "maze-play.js"), "action", "--state", statePath, "up"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  assert.equal(action.status, 0, action.stderr);
  const marker = action.stdout.match(/MAZEBENCH_EVENT_V1:([A-Za-z0-9_-]+)/);
  assert(marker, "provider-neutral helper must emit a live telemetry marker");
  const event = JSON.parse(Buffer.from(marker[1], "base64url").toString("utf8"));
  assert.equal(event.turn, 1);
  assert.equal(event.command_text, "up");
  assert.equal(event.valid, true);
  assert.equal(Object.prototype.hasOwnProperty.call(event.status, "player"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event.status, "scorecard"), false);
  assert.equal(fs.existsSync(path.join(runDir, "current-render-state.json")), false);
  const traced = agenticConversationTurns({
    nodes: [
      { message: { role: "assistant", content: "", reasoning_content: "reasoned move" } },
      { message: { role: "tool", content: `status\n${marker[0]}`, tool_call_id: "shell-1" } }
    ]
  });
  assert.equal(traced.length, 1);
  assert.equal(traced[0].reasoning, "reasoned move");
  assert.equal(traced[0].action, "up");

  const artifactTrace = path.join(runDir, "artifact-traces.jsonl");
  fs.writeFileSync(
    artifactTrace,
    `${JSON.stringify({
      nodes: [
        { message: { role: "assistant", content: "", reasoning_content: "reasoned move" } },
        { message: { role: "tool", content: `status\n${marker[0]}`, tool_call_id: "shell-1" } }
      ],
      info: {
        maze_actions: [{
          turn: 1,
          command: "up",
          valid: true,
          error: null,
          status: { current_room: "level_HxI", gem_count: 0, moved: true }
        }]
      }
    })}\n`
  );
  assert.equal(writeMoveArtifacts(artifactTrace, runDir), 1);
  const actionArtifact = JSON.parse(fs.readFileSync(path.join(runDir, "actions.jsonl"), "utf8"));
  assert.equal(actionArtifact.command_text, "up");
  assert.equal(actionArtifact.status.level, event.status.level);
  const reasoningArtifact = JSON.parse(fs.readFileSync(path.join(runDir, "reasoning.json"), "utf8"));
  assert.equal(reasoningArtifact[0].reasoning, "reasoned move");

  const overBudget = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "maze-play.js"), "action", "--state", statePath, "right"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  assert.notEqual(overBudget.status, 0);
  assert.match(overBudget.stderr, /action budget exhausted \(1\/1\)/i);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).actions.length, 1);

  const traceDir = path.join(runDir, "eval-output", "current-v1");
  fs.mkdirSync(traceDir, { recursive: true });
  const tracesPath = path.join(traceDir, "traces.jsonl");
  fs.writeFileSync(tracesPath, `${JSON.stringify({ nodes: [], info: {} })}\n`);
  assert.equal(findPrimeResultsFile(runDir), tracesPath);
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}

console.log("prime harness tests passed");
