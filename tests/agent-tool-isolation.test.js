const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const {
  agentCommand,
  buildMcpPrompt,
  claudeSandboxSettings,
  codexMcpConfigArgs
} = require("../scripts/maze-agent-local");

const root = path.resolve(__dirname, "..");
const workspace = path.join(os.tmpdir(), "game-only-agent-test");
const baseConfig = {
  agentSwarmWorkspaceDir: path.join(workspace, "swarm-workspaces"),
  agentWorkspaceDir: workspace,
  allowQuit: false,
  claudeBin: "claude",
  codexBin: "codex",
  codexFast: false,
  gameId: "maze",
  gems: 100,
  hideNames: true,
  hostAccess: false,
  inContainer: false,
  levelId: "level_HxI",
  mcpEnabled: true,
  mcpUrl: "http://127.0.0.1:1234/private",
  mode: "text",
  modelName: "gpt-test",
  moves: 2,
  omniscient: false,
  outDir: workspace,
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
assert.match(toolsOnPrompt, /TOOLS-ON mode/);
assert.match(toolsOnPrompt, /tool availability is not guaranteed/);
assert.doesNotMatch(toolsOnPrompt, /TOOLS-OFF mode/);

const swarmPrompt = buildMcpPrompt({ ...toolsOnConfig, swarm: true });
assert.match(swarmPrompt, /SWARM IS ENABLED/);
assert.match(swarmPrompt, /Spawn as many sub-agents as\s+you like/);
assert.match(swarmPrompt, /delegation is optional/);
assert.doesNotMatch(swarmPrompt, /Spawn at least one worker/);

const codexConfig = { ...baseConfig, model: "codex" };
const codex = agentCommand(codexConfig, buildMcpPrompt(codexConfig));
const codexArgs = codex.argv.join("\n");
assert.match(codexArgs, /mcp_servers\.game/);
assert.doesNotMatch(codexArgs, /mcp_servers\.mazebench/);
assert.match(codexArgs, /skills\.include_instructions=false/);
assert.match(codexArgs, /skills\.bundled\.enabled=false/);
assert.match(codexArgs, /web_search="disabled"/);
assert.match(codexArgs, /hooks\.PreToolUse/);
for (const feature of ["apps", "plugins", "memories", "multi_agent", "tool_search"]) {
  const index = codex.argv.indexOf(feature);
  assert(index > 0 && codex.argv[index - 1] === "--disable", `${feature} must be disabled`);
}
assert.deepEqual(
  codexMcpConfigArgs(codexConfig).filter((value) => value.includes("enabled_tools")),
  ['mcp_servers.game.enabled_tools=["game_start","game_observe","game_action","game_scorecard"]']
);

const claudeConfig = { ...baseConfig, model: "claude", modelName: "claude-test" };
const claude = agentCommand(claudeConfig, buildMcpPrompt(claudeConfig));
const valueAfter = (flag) => claude.argv[claude.argv.indexOf(flag) + 1];
assert.equal(valueAfter("--tools"), "");
assert.deepEqual(
  new Set(valueAfter("--allowedTools").split(",")),
  new Set([
    "mcp__game__game_start",
    "mcp__game__game_observe",
    "mcp__game__game_action",
    "mcp__game__game_scorecard"
  ])
);
for (const denied of ["Bash", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "ToolSearch"]) {
  assert(valueAfter("--disallowedTools").split(",").includes(denied), `${denied} must be denied`);
}
const claudeSettings = JSON.parse(claudeSandboxSettings(claudeConfig));
assert.deepEqual(claudeSettings.sandbox.network.allowedDomains, []);
assert.equal(claudeSettings.sandbox.failIfUnavailable, true);

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

console.log("agent tool isolation tests passed");
