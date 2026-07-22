const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  agentCommand,
  buildMcpPrompt,
  claudeSandboxSettings,
  codexMcpConfigArgs,
  distillKimiEvents,
  kimiMcpConfig,
  migrateSeedSessionObservation,
  needsPrivateMcpServer,
  sanitizeKimiConfig
} = require("../scripts/maze-agent-local");

const root = path.resolve(__dirname, "..");
const localAgentSource = fs.readFileSync(path.join(root, "scripts", "maze-agent-local.js"), "utf8");
const workspace = path.join(os.tmpdir(), "game-only-agent-test");
const baseConfig = {
  agentSwarmWorkspaceDir: path.join(workspace, "swarm-workspaces"),
  agentWorkspaceDir: workspace,
  agentCodexRuntimeDir: path.join(workspace, "codex-runtime"),
  allowQuit: false,
  claudeBin: "claude",
  codexBin: "codex",
  kimiBin: "kimi",
  kimiRuntimeDir: path.join(workspace, "kimi-home"),
  kimiSkillsDir: path.join(workspace, "kimi-home", "empty-skills"),
  agentKimiRuntimeDir: path.join(workspace, "kimi-home"),
  agentKimiSkillsDir: path.join(workspace, "kimi-home", "empty-skills"),
  codexFast: false,
  gameId: "maze",
  gems: 100,
  hideNames: true,
  hostAccess: false,
  inContainer: false,
  levelId: "level_HxI",
  maxSwarmWorkers: 8,
  mcpEnabled: true,
  mcpUrl: "http://127.0.0.1:1234/private",
  mode: "text",
  modelName: "gpt-test",
  moves: 2,
  omniscient: false,
  outDir: workspace,
  codexRuntimeDir: path.join(workspace, "codex-runtime"),
  pythonBin: "",
  pythonSandboxStateDir: path.join(workspace, "python-sandbox"),
  reasoning: "low",
  resume: "",
  seed: false,
  sessionFile: path.join(workspace, "session.json"),
  swarm: false,
  swarmDir: path.join(workspace, "swarm"),
  swarmWorkspaceDir: path.join(workspace, "swarm-workspaces"),
  toolUse: "read-only",
  unlimited: false,
  view: "top-diagonal",
  visionHeight: 512,
  visionView: "",
  visionWidth: 512,
  workspaceDir: workspace,
  yaw: 0
};

for (const mode of ["text", "json", "vision"]) {
  const config = {
    ...baseConfig,
    mode,
    hideNames: mode !== "vision",
    omniscient: mode === "json"
  };
  const prompt = buildMcpPrompt(config);
  assert.doesNotMatch(prompt, /MazeBench/i, `${mode} game-only prompt must not reveal the benchmark name`);
  assert.doesNotMatch(prompt, /ice_slope|puncher|player_lift|orange_wall/i);
  assert.match(prompt, /game_start/);
  assert.match(prompt, /TOOLS-OFF mode/);
  assert.match(prompt, /Do not search the web/);
  assert.match(prompt, /do not read any\s+files/);
  assert.match(prompt, /do not spawn any sub-agents/);
  assert.doesNotMatch(prompt, /(?:game|maze)_scorecard/);
  assert.match(prompt, /do not report whether a movement was\s+blocked/i);
  if (mode === "text") {
    assert.match(prompt, /current room's ASCII[\s\S]*complete visited_levels list/);
    assert.doesNotMatch(prompt, /ASCII board in the level\s+field plus the current status/);
  }
  if (mode !== "json") assert.doesNotMatch(prompt, /player position|x\/y\/elevation/i);
}

const toolsOnConfig = {
  ...baseConfig,
  hostAccess: true,
  model: "codex",
  swarm: false,
  toolUse: "offline",
  tools: true
};
const toolsOnPrompt = buildMcpPrompt(toolsOnConfig);
assert.match(toolsOnPrompt, /TOOLS mode/);
assert.match(toolsOnPrompt, /python_exec/);
assert.match(toolsOnPrompt, /cannot read MazeBench source, repositories/);
assert.match(toolsOnPrompt, /Shell, file-browser, editor, web, app, and connector tools are disabled/);
assert.doesNotMatch(toolsOnPrompt, /tool availability is not guaranteed/);
assert.doesNotMatch(toolsOnPrompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(toolsOnPrompt, /TOOLS-OFF mode/);
assert.doesNotMatch(toolsOnPrompt, /maze_scorecard/);

const swarmPrompt = buildMcpPrompt({ ...toolsOnConfig, swarm: true });
assert.match(swarmPrompt, /SWARM IS ENABLED/);
assert.match(swarmPrompt, /spawn at most\s+8 workers/i);
assert.match(swarmPrompt, /exactly one private maze instance/i);
assert.match(swarmPrompt, /delegation is optional/);
assert.doesNotMatch(swarmPrompt, /Spawn at least one worker/);
assert.doesNotMatch(swarmPrompt, /maze_clone|clone_id/i);

assert.deepEqual(
  codexMcpConfigArgs(toolsOnConfig).filter((value) => value.includes("enabled_tools")),
  ['mcp_servers.mazebench.enabled_tools=["maze_start","maze_observe","maze_action","python_exec"]']
);
assert.deepEqual(
  codexMcpConfigArgs({ ...toolsOnConfig, swarm: true }).filter((value) => value.includes("enabled_tools")),
  ['mcp_servers.mazebench.enabled_tools=["maze_start","maze_observe","maze_action","maze_workers","python_exec"]']
);

const codexConfig = { ...baseConfig, model: "codex" };
const codex = agentCommand(codexConfig, buildMcpPrompt(codexConfig));
const codexArgs = codex.argv.join("\n");
assert.match(codexArgs, /mcp_servers\.game/);
assert.doesNotMatch(codexArgs, /mcp_servers\.mazebench/);
assert.match(codexArgs, /skills\.include_instructions=false/);
assert.match(codexArgs, /skills\.bundled\.enabled=false/);
assert.match(codexArgs, /web_search="disabled"/);
assert.match(codexArgs, /hooks\.PreToolUse/);
for (const feature of ["apps", "plugins", "memories", "multi_agent", "tool_search", "shell_tool", "computer_use"]) {
  const index = codex.argv.indexOf(feature);
  assert(index > 0 && codex.argv[index - 1] === "--disable", `${feature} must be disabled`);
}
assert.match(codexArgs, /default_permissions="mazebench_agent"/);
assert.match(codexArgs, /permissions\.mazebench_agent\.network\.enabled=false/);
assert.match(codexArgs, new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*deny`));
assert.equal(codex.argv.includes("--sandbox"), false, "permission profiles must not be mixed with legacy sandbox mode");
assert.equal(codex.argv.includes("--add-dir"), false, "the repository must never be added to the agent workspace");
assert.doesNotMatch(codexArgs, /sandbox_mode|sandbox_workspace_write/);
assert.deepEqual(
  codexMcpConfigArgs(codexConfig).filter((value) => value.includes("enabled_tools")),
  ['mcp_servers.game.enabled_tools=["game_start","game_observe","game_action"]']
);
assert(codex.argv.includes('model_reasoning_summary="detailed"'));

const codexSparkConfig = {
  ...codexConfig,
  modelName: "gpt-5.3-codex-spark",
  reasoning: "xhigh"
};
const codexSpark = agentCommand(codexSparkConfig, buildMcpPrompt(codexSparkConfig));
assert.equal(
  codexSpark.argv.some((value) => value.includes("model_reasoning_summary")),
  false,
  "Codex Spark rejects reasoning.summary"
);
assert(codexSpark.argv.includes('model_reasoning_effort="xhigh"'));

const claudeConfig = { ...baseConfig, model: "claude", modelName: "claude-test" };
const claude = agentCommand(claudeConfig, buildMcpPrompt(claudeConfig));
const valueAfter = (flag) => claude.argv[claude.argv.indexOf(flag) + 1];
assert.equal(valueAfter("--tools"), "default", "Claude needs its default registry enabled to discover MCP tools");
assert.equal(claude.argv.includes("--setting-sources"), false, "overriding setting sources races Claude MCP startup");
assert.equal(claude.argv.includes("--system-prompt"), false, "replacing Claude's base prompt races MCP startup");
assert.equal(valueAfter("--append-system-prompt").includes("only the explicitly configured game controls"), true);
assert.deepEqual(
  new Set(valueAfter("--allowedTools").split(",")),
  new Set([
    "mcp__game__game_start",
    "mcp__game__game_observe",
    "mcp__game__game_action"
  ])
);
for (const denied of [
  "Bash", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "ToolSearch",
  "CronCreate", "DesignSync", "EnterWorktree", "Monitor", "PushNotification", "RemoteTrigger",
  "ReportFindings", "ScheduleWakeup", "SendMessage", "TaskCreate", "TaskUpdate", "Workflow"
]) {
  assert(valueAfter("--disallowedTools").split(",").includes(denied), `${denied} must be denied`);
}
const claudeSettings = JSON.parse(claudeSandboxSettings(claudeConfig));
assert.deepEqual(claudeSettings.sandbox.network.allowedDomains, []);
assert.equal(claudeSettings.sandbox.failIfUnavailable, true);
assert.deepEqual(claudeSettings.sandbox.filesystem.allowWrite, []);
assert.deepEqual(
  new Set(claudeSettings.permissions.allow),
  new Set([
    "mcp__game__game_start",
    "mcp__game__game_observe",
    "mcp__game__game_action"
  ])
);
assert.equal(needsPrivateMcpServer(claudeConfig), true, "host Claude runs need a prestarted MCP service");
assert.equal(needsPrivateMcpServer({ ...baseConfig, model: "kimi" }), true, "host Kimi runs need a private MCP service");
assert.equal(needsPrivateMcpServer(codexConfig), false, "host Codex can use its synchronous stdio MCP startup");
assert.equal(needsPrivateMcpServer({ ...codexConfig, inContainer: true }), true);

const claudeToolsOn = agentCommand(
  { ...toolsOnConfig, model: "claude", modelName: "claude-test" },
  toolsOnPrompt
);
const claudeToolsOnAllowed = new Set(
  claudeToolsOn.argv[claudeToolsOn.argv.indexOf("--allowedTools") + 1].split(",")
);
assert.deepEqual(claudeToolsOnAllowed, new Set([
  "mcp__mazebench__maze_start",
  "mcp__mazebench__maze_observe",
  "mcp__mazebench__maze_action",
  "mcp__mazebench__python_exec"
]));
for (const builtin of ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"]) {
  assert(
    claudeToolsOn.argv[claudeToolsOn.argv.indexOf("--disallowedTools") + 1].split(",").includes(builtin),
    `${builtin} must remain unavailable in tools mode`
  );
}
assert.equal(claudeToolsOn.argv.includes("--add-dir"), false);

const kimiConfig = { ...baseConfig, model: "kimi", modelName: "kimi/k3", reasoning: "high" };
assert.match(localAgentSource, /SUPPORTED_KIMI_CODE_VERSIONS = new Set\(\["0\.28\.1"\]\)/);
assert.match(localAgentSource, /if \(config\.model === "kimi"\) verifyKimiCliCompatibility\(config\)/);
const kimi = agentCommand(kimiConfig, buildMcpPrompt(kimiConfig));
assert.equal(kimi.bin, "kimi");
assert.equal(kimi.argv[kimi.argv.indexOf("--model") + 1], "kimi/k3");
assert.equal(kimi.argv[kimi.argv.indexOf("--output-format") + 1], "stream-json");
assert.equal(kimi.argv[kimi.argv.indexOf("--skills-dir") + 1], kimiConfig.agentKimiSkillsDir);
assert.equal(kimi.argv.includes("--yolo"), false);
assert.equal(kimi.argv.includes("--auto"), false);
assert.equal(kimi.argv.includes("--add-dir"), false);
assert.equal(kimi.env.KIMI_CODE_HOME, kimiConfig.agentKimiRuntimeDir);
assert.equal(kimi.env.KIMI_DISABLE_TELEMETRY, "1");
assert.equal(kimi.env.KIMI_CODE_NO_AUTO_UPDATE, "1");
assert.equal(kimi.env.KIMI_DISABLE_CRON, "1");
assert.equal(kimi.env.KIMI_MODEL_THINKING_EFFORT, "high");

const unsafeKimiConfig = `
default_model = "kimi/k3"
default_permission_mode = "yolo"
telemetry = true

[providers.kimi]
type = "kimi"
api_key = "test-secret"
base_url = "https://api.kimi.invalid"

[models."kimi/k3"]
provider = "kimi"
model = "k3"
max_context_size = 1000
capabilities = ["thinking", "tool_use"]

[services.moonshot_search]
base_url = "https://search.invalid"

[[permission.rules]]
decision = "allow"
pattern = "Read"

[[hooks]]
event = "PreToolUse"
command = "unsafe-hook"
`;
const safeKimiConfig = sanitizeKimiConfig(unsafeKimiConfig, kimiConfig);
assert.match(safeKimiConfig, /api_key = "test-secret"/, "the private runtime must retain provider authentication");
assert.match(safeKimiConfig, /default_permission_mode = "auto"/);
assert.match(safeKimiConfig, /merge_all_available_skills = false/);
assert.match(safeKimiConfig, /telemetry = false/);
assert.doesNotMatch(safeKimiConfig, /search\.invalid|unsafe-hook/);
assert.doesNotMatch(safeKimiConfig, /decision = "allow"\s+pattern = "Read"/);
for (const tool of [
  "mcp__game__game_start",
  "mcp__game__game_observe",
  "mcp__game__game_action"
]) {
  assert.match(safeKimiConfig, new RegExp(`decision = "allow"\\s+pattern = "${tool}"`));
}
for (const builtin of [
  "Bash", "Read", "Write", "Grep", "Glob", "WebSearch", "FetchURL", "Agent", "Skill",
  "CreateGoal", "GetGoal", "SetGoalBudget", "UpdateGoal"
]) {
  assert.match(safeKimiConfig, new RegExp(`decision = "deny"\\s+pattern = "${builtin}"`));
}
assert.doesNotMatch(safeKimiConfig, /pattern = "\*\*"/);

const kimiOfflineMcp = JSON.parse(kimiMcpConfig({ ...toolsOnConfig, model: "kimi" }));
assert.deepEqual(
  kimiOfflineMcp.mcpServers.mazebench.enabledTools,
  ["maze_start", "maze_observe", "maze_action", "python_exec"]
);
assert.deepEqual(Object.keys(kimiOfflineMcp.mcpServers), ["mazebench"]);

const kimiEvents = [
  { role: "assistant", content: "Move right.", tool_calls: [{ id: "call-1", type: "function", function: { name: "mcp__game__game_action", arguments: JSON.stringify({ action: "right" }) } }] },
  { role: "tool", tool_call_id: "call-1", content: JSON.stringify({ moved: true, gem_count: 1, current_room: "HxI" }) },
  { role: "assistant", content: "Done." },
  { role: "meta", type: "session.resume_hint", session_id: "session-test" }
].map(JSON.stringify).join("\n");
assert.deepEqual(distillKimiEvents(kimiEvents).entries, [{
  move: 1,
  action: "right",
  reasoning: "Move right.",
  timestamp: null,
  moved: true,
  gems: 1,
  room: "HxI",
  room_changed: false,
  player_dead: false
}]);

const guard = path.join(root, "scripts", "maze-codex-tool-guard.js");
const blocked = spawnSync(process.execPath, [guard], {
  input: JSON.stringify({ tool_name: "exec" }),
  encoding: "utf8"
});
assert.equal(blocked.status, 2);
assert.match(blocked.stderr, /External tools are disabled/);
const directGame = spawnSync(process.execPath, [guard], {
  input: JSON.stringify({ tool_name: "mcp__game__game_action" }),
  encoding: "utf8"
});
assert.equal(directGame.status, 0);

{
  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-resume-policy-"));
  const sessionFile = path.join(resumeDir, "session.json");
  const session = {
    actions: [{ turn: 1, status: { level: "P..", moved: true, board_state_hash: "state-1", player: { x: 4, y: 15, elevation: 0 }, scorecard: { secret: true } } }],
    bridgeCheckpoint: { player: { x: 4, y: 15, elevation: 0 } },
    initial: { level: "P..", board_state_hash: "state-0", player: { x: 4, y: 15, elevation: 0 } },
    lastStatus: { level: ".P.", moved: true, board_state_hash: "state-1", player: { x: 5, y: 15, elevation: 0 } },
    scorecard: { current_position: { x: 5, y: 15, elevation: 0 } }
  };
  fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`);
  fs.writeFileSync(path.join(resumeDir, "scorecard.json"), "{}\n");
  fs.writeFileSync(path.join(resumeDir, "maze_scorecard.json"), "{}\n");
  fs.writeFileSync(path.join(resumeDir, "current-render-state.json"), "{}\n");
  migrateSeedSessionObservation({
    ...baseConfig,
    hideNamesSeed: "resume-seed",
    mode: "text",
    outDir: resumeDir,
    seed: true,
    sessionFile
  });
  const sanitized = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(sanitized.maxActions, 3, "a finite continuation adds its selected moves to existing actions");
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, "scorecard"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, "bridgeCheckpoint"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized.initial, "player"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized.lastStatus, "player"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized.actions[0].status, "scorecard"), false);
  assert.equal(sanitized.initial.board_state_hash, "state-0");
  assert.equal(sanitized.lastStatus.board_state_hash, "state-1");
  assert.equal(sanitized.lastStatus.moved, true);
  assert.equal(sanitized.actions[0].status.board_state_hash, "state-1");
  assert.equal(fs.existsSync(path.join(resumeDir, "scorecard.json")), false);
  assert.equal(fs.existsSync(path.join(resumeDir, "maze_scorecard.json")), false);
  assert.equal(fs.existsSync(path.join(resumeDir, "current-render-state.json")), false);
  migrateSeedSessionObservation({
    ...baseConfig,
    hideNamesSeed: "resume-seed",
    mode: "text",
    outDir: resumeDir,
    seed: true,
    sessionFile,
    unlimited: true
  });
  assert.equal(
    JSON.parse(fs.readFileSync(sessionFile, "utf8")).maxActions,
    null,
    "an unlimited continuation clears an older finite helper cap"
  );
  fs.rmSync(resumeDir, { recursive: true, force: true });
}

console.log("agent tool isolation tests passed");
