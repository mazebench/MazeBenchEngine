import { verifyCodeCondition } from "../all-code-v3/policy.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from "../v1/integrity.mjs";
import { safeReadFile } from "../v1/safe-files.mjs";

export const POLICY = "antigravity-catalog-any-language-v3";
export const VERIFIED_VERSIONS = new Set(["1.2.13", "1.3.5"]);
export const TRANSPORT_TOOLS = ["call_mcp_tool", "list_resources", "manage_task", "read_resource"];
export const digest = value => createHash("sha256").update(value).digest("hex");
export const toolNames = enabled => ["maze_observe", "maze_action", "maze_sequence", ...(enabled ? ["code_exec"] : [])];
export const authHome = () => path.join(os.homedir(), ".mazebench", "antigravity-auth");
export const tokenPath = home => path.join(home, ".gemini/antigravity-cli/antigravity-oauth-token");
export function environment(home) {
  return { HOME: path.resolve(home), USER: os.userInfo().username, LOGNAME: os.userInfo().username,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8",
    SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 2", AGY_CLI_DISABLE_AUTO_UPDATE: "1" };
}
export function inspectInstallation(command = "agy") {
  const found = command.includes(path.sep) ? command : spawnSync("which", [command], { encoding: "utf8", timeout: 5000 }).stdout?.trim();
  if (!found) throw new Error("Antigravity CLI is not installed.");
  const executable = realpathSync(found);
  const result = spawnSync(executable, ["--version"], { env: environment(authHome()), encoding: "utf8", timeout: 5000 });
  const version = result.stdout?.trim();
  if (result.status !== 0 || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Cannot determine Antigravity CLI version.");
  return { executable, version, tested: VERIFIED_VERSIONS.has(version) };
}
export function settings(toolsEnabled) {
  return { permissions: {
    allow: toolNames(toolsEnabled).map(name => "mcp(mazebench/" + name + ")"),
    deny: ["command(*)", "unsandboxed(*)", "read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)"]
  } };
}
export function agentDefinition({ command, args, env = {}, toolsEnabled }) {
  // The empty tools list and exact boolean values are important: invalid YAML
  // can silently select the broad default agent. Freeze and verify these bytes.
  return [
    "---", "name: mazebench", "description: Restricted MazeBench evaluation agent.",
    "tools: []", "mainAgent: true", "subagent: false", "model: inherit",
    "commandExecutionPolicy: off", "inheritMcp: false", "inheritCustomizations: false",
    "excludeDefaultComponents: true", "skills: []", "plugins: []", "mcpServers:",
    "  - name: mazebench", "    command: " + JSON.stringify(command),
    "    args: " + JSON.stringify(args), "    env: " + JSON.stringify(env), "---",
    "You are the agent evaluated by MazeBench. Only direct MazeBench MCP calls are available.",
    'Use call_mcp_tool with ServerName="mazebench", ToolName and Arguments below, and short toolSummary/toolAction strings.',
    'maze_observe: Arguments={} returns the live board/state and records index; {"record":"relative/path"} reads an indexed read-only record.',
    'Large responses arrive in numbered read-only pages. Follow each response_pages/... next-page link with maze_observe({record: "the exact link"}) until End of response. Concatenate the text after each --- delimiter to reconstruct the exact response. These pages survive pause/resume. Never try to read Antigravity host files; all output is available through these pages.',
    'maze_action: Arguments={"action":"up"}; other actions are down, left, right, undo, reset, camera up/down/left/right, and room HxI (previously visited rooms only).',
    'maze_sequence: Arguments={"sequence":"UURDDL"} OR {"actions":["up","right"]}, never both. Maximum 1000 actions. Every accepted action is recorded; stops on death, victory, or action limit.',
    toolsEnabled ? 'code_exec: Arguments={"command":"node main.js","files":[{"path":"main.js","content":"console.log(1)"}],"timeout_seconds":10}. Execute Python, Node, C/C++, Rust, Go, Java, Ruby, Perl or Lua in isolated /workspace. Compilers and subprocesses are available inside the sandbox. No network or host files. Pass observations explicitly as data.' : 'Python and all other code execution and file-writing tools are unavailable.',
    "Native shell, JavaScript, file tools, web, skills, plugins, personal instructions and delegation are unavailable. MCP resources are empty; read records only with maze_observe. manage_task cannot start code and is not a gameplay tool.", ""
  ].join("\n");
}
export function argumentsFor({ model, prompt, conversationId, logFile }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(model)) throw new Error("Unsupported Antigravity model.");
  if (conversationId && !/^[a-f0-9-]{36}$/.test(conversationId)) throw new Error("Invalid Antigravity conversation ID.");
  return ["-p", prompt, "--agent", "mazebench", "--model", model, "--disable-slash-commands", "--output-format", "stream-json", "--print-timeout", "0", "--log-file", logFile,
    ...(conversationId ? ["--conversation", conversationId] : [])];
}
export function immutable(file, enabled = true) {
  if (process.platform !== "darwin") throw new Error("Antigravity's certified configuration boundary currently requires macOS.");
  const result = spawnSync("/usr/bin/chflags", [enabled ? "uchg" : "nouchg", file], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) throw new Error("Cannot protect the Antigravity configuration.");
}
function isImmutable(file) {
  const result = spawnSync("/usr/bin/stat", ["-f", "%Sf", file], { encoding: "utf8", timeout: 5000 });
  return result.status === 0 && result.stdout.trim().split(",").includes("uchg");
}
export async function runtimeHashes(root) {
  const names = await readdir(path.join(root, "benchmarking/antigravity-code-v3"), { withFileTypes: true });
  if (names.some(entry => entry.isSymbolicLink() || entry.isDirectory())) throw new Error("Unexpected Antigravity provider asset.");
  const files = names.filter(entry => entry.name.endsWith(".mjs")).map(entry => "benchmarking/antigravity-code-v3/" + entry.name).sort();
  return Object.fromEntries(await Promise.all(files.map(async name => [name, digest(await readFile(path.join(root, name)))])));
}
export async function verifyIntegrity(root, directory, metadata) {
  if (existsSync(path.join(directory, "integrity-violation.json"))) throw new Error("This run was invalidated by an integrity violation.");
  const manifest = await verifyRunIntegrity(root, directory, metadata.integrity);
  assertRunConfiguration(metadata, manifest);
  const frozen = manifest.configuration;
  await verifyCodeCondition(root, metadata, frozen);
  if (metadata.provider !== "antigravity" || frozen.provider !== "antigravity" || frozen.antigravity_policy !== POLICY) throw new Error("Antigravity provider policy changed.");
  if (frozen.world !== "main-world" || frozen.observation_mode !== "ascii") throw new Error("Unsupported Antigravity run mode.");
  if (!VERIFIED_VERSIONS.has(frozen.antigravity_version)) throw new Error("Unverified Antigravity version.");
  if (digest(readFileSync(frozen.antigravity_executable)) !== frozen.antigravity_sha256) throw new Error("Antigravity executable changed; start a new run.");
  if (JSON.stringify(await runtimeHashes(root)) !== JSON.stringify(frozen.antigravity_runtime)) throw new Error("Antigravity runtime changed; start a new run.");
  for (const [file, hash] of Object.entries(frozen.antigravity_config)) {
    if (!isImmutable(file) || digest(readFileSync(file)) !== hash) throw new Error("Antigravity immutable configuration changed.");
  }
  if (digest(safeReadFile(directory, "prompt.md")) !== frozen.effective_prompt_sha256) throw new Error("Benchmark prompt changed.");
  verifyCheckpoint(directory);
  return frozen;
}
export function boundaryValidator({ model, cwd, conversationId, toolsEnabled }) {
  let initialized = false;
  return event => {
    if (event.event === "init") {
      if (initialized || event.init?.agent !== "mazebench" || event.init.model !== model || event.init.permission_mode !== "request-review" || realpathSync(event.init.cwd) !== realpathSync(cwd)) return "Antigravity initialized an unexpected agent, model or permission policy.";
      if (conversationId && event.conversation_id !== conversationId) return "Antigravity resumed a different conversation.";
      initialized = true;
      // init.tools describes the GLOBAL registry, not this executor. The real
      // HTTP capability fixture verifies the effective four-tool schema.
      return null;
    }
    if (!initialized) return "Antigravity emitted activity before initialization.";
    const step = event.step_update;
    if (step?.tool_name) {
      if (!TRANSPORT_TOOLS.includes(step.tool_name)) return "Forbidden Antigravity tool: " + step.tool_name + ".";
      const args = step.tool_info?.parameters || {};
      if (step.tool_name === "call_mcp_tool" && (args.ServerName !== "mazebench" || !toolNames(toolsEnabled).includes(args.ToolName))) return "Antigravity called an unexpected MCP server or tool.";
      if (["read_resource", "list_resources"].includes(step.tool_name) && args.ServerName !== "mazebench") return "Antigravity requested an unexpected resource server.";
      if (step.tool_name === "manage_task" && !["list", "status", "kill"].includes(args.Action)) return "Antigravity attempted to send background-task input.";
    }
    return null;
  };
}
