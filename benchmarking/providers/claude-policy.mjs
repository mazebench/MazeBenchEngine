import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from "../v1/integrity.mjs";
import { safeReadFile } from "../v1/safe-files.mjs";

export const CLAUDE_PROVIDER = "claude-code";
export const CLAUDE_POLICY = "claude-mcp-only-v1";
// Admission requires the real-CLI wire tests and the shared adversarial suite.
export const VERIFIED_CLAUDE_VERSIONS = new Set(["2.1.258", "2.1.280", "2.1.284", "2.1.293"]);
export const CLAUDE_MODELS = [
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-haiku-5-5", "Claude Haiku 5.5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-fable-5-1", "Claude Fable 5.1"],
  ["claude-fable-5", "Claude Fable 5"],
].map(([id, name]) => ({ id, name, provider: CLAUDE_PROVIDER, default_effort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] }));
export const digest = value => createHash("sha256").update(value).digest("hex");
export const mazeTools = enabled => ["maze_observe", "maze_action", "maze_sequence", ...(enabled ? ["python_exec"] : [])];
export const claudeTools = enabled => mazeTools(enabled).map(name => `mcp__mazebench__${name}`);

export function inspectClaude(command = "claude") {
  const found = command.includes(path.sep) ? command : spawnSync("which", [command], { encoding: "utf8", timeout: 5000 }).stdout?.trim();
  if (!found) throw new Error("Claude Code is not installed. Install it and run claude auth login.");
  const executable = realpathSync(found);
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5000 });
  const version = result.stdout?.trim().match(/^(\d+\.\d+\.\d+) \(Claude Code\)$/)?.[1];
  if (result.status !== 0 || !version) throw new Error("Cannot determine the Claude Code version.");
  return { executable, version, tested: VERIFIED_CLAUDE_VERSIONS.has(version) };
}

export function claudeEnvironment() {
  // Authentication uses Claude Code's existing login. No inherited endpoints,
  // API keys, SDK sockets, plugin toggles or alternate providers are forwarded.
  return {
    HOME: os.homedir(), USER: os.userInfo().username, PATH: process.env.PATH || "/usr/bin:/bin", TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_AUTO_CONNECT_IDE: "0", CLAUDE_CODE_ENABLE_TASKS: "false",
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0", ENABLE_TOOL_SEARCH: "false", DISABLE_AUTOUPDATER: "1"
  };
}

export function claudeInstallationStatus(command = "claude") {
  try {
    const installation = inspectClaude(command);
    const result = spawnSync(installation.executable, ["auth", "status"], { env: claudeEnvironment(), encoding: "utf8", timeout: 10000 });
    const auth = JSON.parse(result.stdout || "{}");
    const authenticated = result.status === 0 && auth.loggedIn === true && auth.apiProvider === "firstParty";
    return { ...installation, available: true, authenticated, auth_method: auth.authMethod || null,
      error: !installation.tested ? "This Claude Code version needs benchmark validation." : !authenticated ? "Run claude auth login using your Anthropic account." : null };
  } catch (error) { return { available: false, tested: false, authenticated: false, error: error.message }; }
}

export function buildClaudeArguments({ projectRoot, runDirectory, model, effort, toolsEnabled, prompt, resumeSessionId, sessionId, interview = false, fork = false }) {
  const allowed = interview ? [] : claudeTools(toolsEnabled);
  const settings = {
    disableAllHooks: true, autoMemoryEnabled: false, includeGitInstructions: false,
    enabledPlugins: { "agents-md@builtin": false, "cc-plugin-plugin-authoring@builtin": false }, disableBundledSkills: true, fallbackModel: [], autoConnectIde: false,
    permissions: { defaultMode: "dontAsk", allow: allowed, deny: ["Bash", "PowerShell", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task", "Skill", "NotebookEdit", "ToolSearch"] }
  };
  const mcp = interview ? {} : { mazebench: { type: "stdio", command: process.execPath,
    args: [path.join(projectRoot, "benchmarking/providers/claude-mcp.mjs")],
    env: { MAZEBENCH_PROJECT_ROOT: projectRoot, MAZEBENCH_RUN_DIRECTORY: runDirectory,
      MAZEBENCH_PYTHON_ENABLED: toolsEnabled ? "1" : "0", MAZEBENCH_CAPABILITY_POLICY: "os-isolated-v4" } } };
  const args = ["--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages", "--restricted",
    "--setting-sources", "", "--settings", JSON.stringify(settings), "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: mcp }),
    "--tools", "", "--disable-slash-commands", "--no-chrome", "--permission-mode", "dontAsk",
    "--model", model, "--effort", effort, "--system-prompt", "You are the agent evaluated by MazeBench. Follow the benchmark instructions and use only the tools explicitly provided for this condition."];
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  else if (sessionId) args.push("--session-id", sessionId);
  if (fork) args.push("--fork-session");
  args.push("--", prompt);
  return args;
}

export async function providerRuntimeHashes(projectRoot) {
  const files = (await readdir(path.join(projectRoot, "benchmarking/providers"), { withFileTypes: true }))
    .filter(entry => { if (entry.isSymbolicLink()) throw new Error("Provider code cannot be a symbolic link."); return entry.isFile() && entry.name.endsWith(".mjs"); })
    .map(entry => `benchmarking/providers/${entry.name}`).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(path.join(projectRoot, file)))])));
}

export async function verifyClaudeIntegrity(projectRoot, runDirectory, metadata) {
  const manifest = await verifyRunIntegrity(projectRoot, runDirectory, metadata.integrity);
  assertRunConfiguration(metadata, manifest);
  const frozen = manifest.configuration;
  if (metadata.provider !== CLAUDE_PROVIDER || frozen.provider !== CLAUDE_PROVIDER || frozen.claude_policy !== CLAUDE_POLICY) throw new Error("Claude provider policy changed.");
  if (JSON.stringify(await providerRuntimeHashes(projectRoot)) !== JSON.stringify(frozen.provider_runtime)) throw new Error("Claude provider runtime changed; start a new run.");
  if (digest(safeReadFile(runDirectory, "prompt.md")) !== frozen.effective_prompt_sha256) throw new Error("The run prompt changed.");
  if (digest(readFileSync(frozen.claude_executable)) !== frozen.claude_sha256) throw new Error("Claude Code executable changed; start a new run.");
  if (!VERIFIED_CLAUDE_VERSIONS.has(frozen.claude_version)) throw new Error("Unverified Claude Code version.");
  verifyCheckpoint(runDirectory);
  return frozen;
}

const HEARTBEAT_FIELDS = new Set(["type", "tool_use_id", "tool_name", "parent_tool_use_id", "elapsed_time_seconds", "heartbeat", "session_id", "uuid", "_received_at", "_turn_id"]);

function permittedToolHeartbeat(event, allowed, rootToolCalls) {
  const parent = event.parent_tool_use_id;
  const call = rootToolCalls?.get(parent);
  return event.heartbeat === true && typeof parent === "string" && parent.length > 0 &&
    typeof event.tool_use_id === "string" && event.tool_use_id.startsWith(`${parent}-heartbeat-`) &&
    /^\d+$/.test(event.tool_use_id.slice(parent.length + "-heartbeat-".length)) &&
    Number.isFinite(event.elapsed_time_seconds) && event.elapsed_time_seconds >= 0 &&
    typeof event.session_id === "string" && call?.sessionId === event.session_id &&
    call.name === event.tool_name && allowed.includes(event.tool_name) &&
    Object.keys(event).every(key => HEARTBEAT_FIELDS.has(key));
}

export function claudeBoundaryViolation(event, { model, toolsEnabled = false, interview = false, rootToolCalls } = {}) {
  const allowed = interview ? [] : claudeTools(toolsEnabled);
  // Claude Code uses parent_tool_use_id for long-running root-tool heartbeats
  // as well as agent responses. Admit only progress tied to a validated call.
  if (event.type === "tool_progress") return permittedToolHeartbeat(event, allowed, rootToolCalls)
    ? null : "Claude emitted unverified tool progress.";
  if (event.parent_tool_use_id) return "Claude attempted a delegated agent response.";
  if (event.type === "stream_event") {
    const inner = event.event || {};
    if (inner.type === "message_start" && inner.message?.model !== model) return "Claude streamed a response from a different model.";
    if (inner.content_block?.type === "tool_use" && !allowed.includes(inner.content_block.name)) return `Claude attempted forbidden tool ${inner.content_block.name}.`;
    if (inner.content_block?.type === "server_tool_use") return "Claude attempted a server-side tool.";
  }
  if (event.type === "system" && event.subtype === "init") {
    if (event.model !== model) return `Claude model routing changed: expected ${model}, received ${event.model}.`;
    if (event.permissionMode !== "dontAsk") return "Claude permission mode changed.";
    if (JSON.stringify([...(event.tools || [])].sort()) !== JSON.stringify([...allowed].sort())) return `Unexpected Claude tool catalog: ${(event.tools || []).join(", ")}.`;
    const servers = event.mcp_servers || [];
    if (interview ? servers.length : servers.length !== 1 || servers[0].name !== "mazebench" || servers[0].status !== "connected") return "Claude MCP server boundary mismatch.";
    if (event.plugins?.length || event.slash_commands?.length || event.skills?.length) return "Claude loaded external plugins, commands or skills.";
  }
  if (event.type === "assistant") {
    if (event.message?.model && event.message.model !== model && event.message.model !== "<synthetic>") return `Claude changed model to ${event.message.model}.`;
    for (const block of event.message?.content || []) {
      if (block.type === "tool_use" && !allowed.includes(block.name)) return `Claude attempted forbidden tool ${block.name}.`;
      if (block.type === "server_tool_use") return "Claude attempted a server-side tool.";
    }
  }
  if (event.type === "result" && Object.keys(event.modelUsage || {}).some(name => name !== model)) return "Claude reported usage for a different model.";
  return null;
}

export function createClaudeBoundaryValidator(options) {
  const rootToolCalls = new Map();
  let sessionId = null;
  return event => {
    const violation = claudeBoundaryViolation(event, { ...options, rootToolCalls });
    if (violation) return violation;
    if (event.type === "system" && event.subtype === "init") {
      sessionId = event.session_id;
      rootToolCalls.clear();
    }
    if (event.type === "assistant" && sessionId && event.session_id === sessionId) {
      for (const block of event.message?.content || []) {
        if (block.type === "tool_use" && typeof block.id === "string" && block.id)
          rootToolCalls.set(block.id, { name: block.name, sessionId });
      }
    }
    if (event.type === "user" && event.session_id === sessionId) {
      for (const block of event.message?.content || [])
        if (block.type === "tool_result") rootToolCalls.delete(block.tool_use_id);
    }
    return null;
  };
}
