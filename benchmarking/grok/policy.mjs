import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from "../v1/integrity.mjs";
import { safeReadFile } from "../v1/safe-files.mjs";

export const GROK_PROVIDER = "grok-build";
export const GROK_POLICY = "grok-build-mcp-only-v1";
export const VERIFIED_GROK_VERSIONS = new Set(["1.0.40", "1.0.41"]);
export const GROK_MODELS = [{
  id: "grok-4.7",
  name: "Grok 4.7",
  provider: GROK_PROVIDER,
  default_effort: "xhigh",
  efforts: ["low", "medium", "high", "xhigh"]
}];
export const GROK_SLASH_COMMANDS = ["compact", "always-approve", "context", "session-info", "goal"];
export const digest = value => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function grokModelsPolicyDigest(value) {
  const catalog = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
  delete catalog.fetched_at;
  delete catalog.renewed_at;
  return digest(canonical(catalog));
}
export function grokSettingsPolicyDigest(value) {
  const envelope = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
  const payload = JSON.parse(envelope.payload);
  delete payload.fetched_at;
  return digest(canonical(payload));
}
export const mazeToolNames = enabled => ["maze_observe", "maze_action", "maze_sequence", ...(enabled ? ["python_exec"] : [])];
export const grokMazeTools = enabled => mazeToolNames(enabled).map(name => `mazebench__${name}`);

export function inspectGrok(command = "grok") {
  const found = command.includes(path.sep) ? command : spawnSync("which", [command], { encoding: "utf8", timeout: 5000 }).stdout?.trim();
  if (!found) throw new Error("Grok Build is not installed. Install it, then run grok login.");
  const executable = realpathSync(found);
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5000 });
  const match = result.stdout?.trim().match(/^grok (\d+\.\d+\.\d+) \(([a-f0-9]+)\) \[([^\]]+)\]$/);
  if (result.status !== 0 || !match) throw new Error("Cannot determine the Grok Build version.");
  return { executable, version: match[1], revision: match[2], channel: match[3], tested: VERIFIED_GROK_VERSIONS.has(match[1]) };
}

function baseEnvironment() {
  return {
    HOME: os.homedir(),
    USER: os.userInfo().username,
    PATH: process.env.PATH || "/usr/bin:/bin",
    TMPDIR: os.tmpdir(),
    LANG: "en_US.UTF-8",
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_AGENT_DASHBOARD: "0"
  };
}

export function grokEnvironment(grokHome) {
  return { ...baseEnvironment(), GROK_HOME: path.resolve(grokHome) };
}

export function setGrokConfigImmutable(file, immutable = true) {
  if (process.platform !== "darwin") throw new Error("Grok Build's immutable configuration boundary currently requires macOS.");
  const result = spawnSync("/usr/bin/chflags", [immutable ? "uchg" : "nouchg", path.resolve(file)], {
    env: baseEnvironment(), encoding: "utf8", timeout: 5000
  });
  if (result.status !== 0) throw new Error(`Could not ${immutable ? "lock" : "unlock"} the Grok Build configuration: ${(result.stderr || result.stdout || "unknown error").trim()}`);
}

export function grokConfigIsImmutable(file) {
  if (process.platform !== "darwin") return false;
  const result = spawnSync("/usr/bin/stat", ["-f", "%Sf", path.resolve(file)], {
    env: baseEnvironment(), encoding: "utf8", timeout: 5000
  });
  return result.status === 0 && result.stdout.trim().split(",").includes("uchg");
}

export function grokInstallationStatus(command = "grok") {
  try {
    const installation = inspectGrok(command);
    const result = spawnSync(installation.executable, ["models"], {
      env: baseEnvironment(), encoding: "utf8", timeout: 20_000
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const authenticated = result.status === 0 && /logged in with grok\.com/i.test(output);
    const modelAvailable = /\bgrok-4\.7\b/.test(output);
    return {
      ...installation,
      available: true,
      authenticated,
      model_available: modelAvailable,
      auth_method: authenticated ? "grok.com subscription" : null,
      error: !installation.tested
        ? "This Grok Build version needs benchmark validation."
        : !authenticated
          ? "Run grok login using your grok.com subscription."
          : !modelAvailable
            ? "Grok 4.7 is not available to this Grok Build account."
            : null
    };
  } catch (error) {
    return { available: false, tested: false, authenticated: false, model_available: false, error: error.message };
  }
}

export function buildGrokArguments({ model, effort, toolsEnabled, prompt, resumeSessionId, sessionId }) {
  const args = [
    "-p", prompt,
    "--output-format", "streaming-messages-json",
    // An empty Grok allowlist means the default catalog. A non-empty, exact
    // gateway list removes shell/filesystem/media tools while retaining MCP.
    "--tools", "search_tool,use_tool",
    "--disallowed-tools", "Agent,run_terminal_cmd,run_terminal_command,read_file,write_file,search_replace,list_dir,grep,web_search,web_fetch",
    "--no-subagents",
    "--disable-web-search",
    "--no-plan",
    "--permission-mode", "dontAsk",
    "--allow", "MCPTool(mazebench__*)",
    // Grok 1.0.40's native macOS profile fails to initialize because
    // /var/run/docker.sock is a symlink. The catalog is therefore the primary
    // CLI boundary; python_exec remains separately OS-sandboxed by MazeBench.
    "--sandbox", "off",
    "--system-prompt-override", "You are the agent evaluated by MazeBench. Use only search_tool and use_tool, solely to discover and call the MazeBench tools on the mazebench MCP server. These two gateway tools are transport, not code executors. No other tools, files, shell, web, plugins, skills, memory, or subagents are available.",
    "--verbatim",
    "--no-auto-update"
  ];
  // Grok 1.0.40 restores the frozen model and reasoning effort from a resumed
  // session. Re-supplying -m after restore incorrectly rejects Grok 4.7 as an
  // unknown model even though the session and init event both identify 4.7.
  if (!resumeSessionId) args.splice(2, 0, "-m", model, "--reasoning-effort", effort);
  // Grok 1.0.40 restores an interrupted session with an empty advertised tool
  // catalog. Forking preserves its conversation while rebuilding the exact
  // headless allowlist and MCP gateway for the continuation.
  if (resumeSessionId) args.push("--resume", resumeSessionId, "--fork-session", "--session-id", sessionId);
  else if (sessionId) args.push("--session-id", sessionId);
  assertHardenedGrokArguments(args, { model, effort, toolsEnabled, resumeSessionId, sessionId });
  return args;
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

export function assertHardenedGrokArguments(args, options) {
  for (const flag of ["-p", "--output-format", "--tools", "--disallowed-tools", "--no-subagents", "--disable-web-search", "--no-plan", "--permission-mode", "--allow", "--sandbox", "--system-prompt-override", "--verbatim", "--no-auto-update"]) {
    if (!args.includes(flag)) throw new Error(`Unsafe Grok launch: missing ${flag}.`);
  }
  if (options.resumeSessionId) {
    if (args.includes("-m") || args.includes("--reasoning-effort")) throw new Error("Unsafe Grok resume: model overrides must come from the frozen session.");
  } else if (valueAfter(args, "-m") !== options.model || valueAfter(args, "--reasoning-effort") !== options.effort) throw new Error("Unsafe Grok launch: model routing changed.");
  if (valueAfter(args, "--output-format") !== "streaming-messages-json") throw new Error("Unsafe Grok launch: event stream validation is disabled.");
  if (valueAfter(args, "--tools") !== "search_tool,use_tool") throw new Error("Unsafe Grok launch: built-in tools are not restricted.");
  if (valueAfter(args, "--permission-mode") !== "dontAsk" || valueAfter(args, "--allow") !== "MCPTool(mazebench__*)") throw new Error("Unsafe Grok launch: MCP permissions changed.");
  if (valueAfter(args, "--sandbox") !== "off") throw new Error("Unexpected Grok sandbox configuration.");
  const denied = new Set(String(valueAfter(args, "--disallowed-tools") || "").split(","));
  for (const tool of ["Agent", "run_terminal_cmd", "run_terminal_command", "read_file", "write_file", "search_replace", "list_dir", "grep", "web_search", "web_fetch"]) {
    if (!denied.has(tool)) throw new Error(`Unsafe Grok launch: ${tool} was not denied.`);
  }
  if (options.resumeSessionId) {
    if (valueAfter(args, "--resume") !== options.resumeSessionId || !args.includes("--fork-session") || valueAfter(args, "--session-id") !== options.sessionId) throw new Error("Unsafe Grok resume identity.");
  } else if (valueAfter(args, "--session-id") !== options.sessionId || args.includes("--resume")) {
    throw new Error("Unsafe Grok session identity.");
  }
  return true;
}

export async function grokRuntimeHashes(projectRoot) {
  const base = path.join(projectRoot, "benchmarking/grok");
  const files = [];
  async function walk(relative) {
    for (const entry of await readdir(path.join(projectRoot, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Grok provider code cannot be a symbolic link.");
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(name);
    }
  }
  await walk(path.relative(projectRoot, base));
  files.sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(path.join(projectRoot, file)))])));
}

export async function verifyGrokIntegrity(projectRoot, runDirectory, metadata) {
  const manifest = await verifyRunIntegrity(projectRoot, runDirectory, metadata.integrity);
  assertRunConfiguration(metadata, manifest);
  const frozen = manifest.configuration;
  if (metadata.provider !== GROK_PROVIDER || frozen.provider !== GROK_PROVIDER || frozen.grok_policy !== GROK_POLICY) throw new Error("Grok provider policy changed.");
  if ((metadata.world || "main-world") !== "main-world" || frozen.world !== "main-world" || (metadata.observation_mode || "ascii") !== "ascii" || frozen.observation_mode !== "ascii") throw new Error("Grok run mode changed.");
  if (JSON.stringify(await grokRuntimeHashes(projectRoot)) !== JSON.stringify(frozen.grok_runtime)) throw new Error("Grok provider runtime changed; start a new run.");
  if (digest(safeReadFile(runDirectory, "prompt.md")) !== frozen.effective_prompt_sha256) throw new Error("The run prompt changed.");
  if (!VERIFIED_GROK_VERSIONS.has(frozen.grok_version)) throw new Error("Unverified Grok Build version.");
  if (digest(readFileSync(frozen.grok_executable)) !== frozen.grok_sha256) throw new Error("Grok Build executable changed; start a new run.");
  if (!grokConfigIsImmutable(frozen.grok_config)) throw new Error("Grok Build isolated configuration is not immutable; refusing execution.");
  if (path.resolve(frozen.grok_config) !== path.join(path.resolve(frozen.grok_home), "config.toml") || digest(readFileSync(frozen.grok_config)) !== frozen.grok_config_sha256) throw new Error("Grok Build isolated configuration changed; start a new run.");
  const models = path.join(path.resolve(frozen.grok_home), "models_cache.json");
  if (grokModelsPolicyDigest(readFileSync(models)) !== frozen.grok_models_policy_sha256) throw new Error("Grok Build model catalog policy changed; start a new run.");
  const settings = path.join(path.resolve(frozen.grok_home), "settings_cache.json");
  if (grokSettingsPolicyDigest(readFileSync(settings)) !== frozen.grok_settings_policy_sha256) throw new Error("Grok Build signed settings policy changed; start a new run.");
  verifyCheckpoint(runDirectory);
  return frozen;
}

export function verifyStoredGrokToolCatalog(grokHome, cwd, sessionId) {
  const relative = path.join("sessions", encodeURIComponent(canonicalPath(cwd)), sessionId, "tool_definitions.json");
  const definitions = JSON.parse(safeReadFile(grokHome, relative));
  const names = definitions.map(entry => entry?.function?.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(["search_tool", "use_tool"])) {
    throw new Error(`Unsafe stored Grok tool catalog: ${names.filter(Boolean).join(", ")}.`);
  }
  return true;
}

function parseSearchResult(content, allowed) {
  const outer = JSON.parse(content);
  if (outer.type !== "SearchTool" || typeof outer.content !== "string") return "Grok returned an unrecognized MCP discovery result.";
  const inner = JSON.parse(outer.content);
  for (const result of inner.results || []) {
    if (result.server !== "mazebench") return "Grok discovered an unexpected MCP server.";
    for (const tool of result.tools || []) if (!allowed.has(tool.tool_name)) return `Grok discovered forbidden MCP tool ${tool.tool_name}.`;
  }
  return null;
}

function parseUseResult(content, allowedRaw) {
  const value = JSON.parse(content);
  if (value.type !== "MCP" || value.server_name !== "mazebench" || !allowedRaw.has(value.tool_name)) return "Grok returned a result from an unexpected MCP tool.";
  return null;
}

function canonicalPath(value) {
  try { return realpathSync(String(value || "")); }
  catch { return path.resolve(String(value || "")); }
}

export function createGrokBoundaryValidator({ model, toolsEnabled = false, cwd, resuming = false }) {
  const allowed = new Set(grokMazeTools(toolsEnabled));
  const allowedRaw = new Set(mazeToolNames(toolsEnabled));
  const calls = new Map();
  let initialized = false;
  let sessionId = null;
  return event => {
    if (!event || typeof event !== "object") return "Grok emitted an invalid event.";
    if (event.type === "error") return null;
    if (event.parent_tool_use_id) return "Grok attempted a delegated agent response.";
    if (initialized && event.session_id && event.session_id !== sessionId) return "Grok session identity changed.";
    if (event.type === "system" && event.subtype === "init") {
      if (initialized) return "Grok initialized more than once in one turn.";
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(event.session_id || "")) return "Grok did not report a valid session identity.";
      if (event.model !== model) return `Grok model routing changed: expected ${model}, received ${event.model}.`;
      if (event.apiKeySource !== "oauth") return "Grok did not use the subscription OAuth session.";
      if (event.permissionMode !== "dontAsk") return "Grok permission mode changed.";
      if (canonicalPath(event.cwd) !== canonicalPath(cwd)) return "Grok working directory changed.";
      const tools = [...(event.tools || [])].sort();
      // Grok 1.0.40 sometimes emits init before its exact headless allowlist is
      // attached, reporting an empty catalog. Empty is a safe, smaller surface;
      // argv/config are frozen and every later tool request is still checked.
      if (JSON.stringify(tools) !== JSON.stringify(["search_tool", "use_tool"]) && tools.length !== 0) return `Unexpected Grok tool catalog: ${tools.join(", ")}.`;
      const slashCommands = event.slash_commands || [];
      if (JSON.stringify(slashCommands) !== JSON.stringify(GROK_SLASH_COMMANDS) && slashCommands.length !== 0) return "Grok slash-command surface changed.";
      if (event.skills?.length) return "Grok loaded external skills.";
      const servers = event.mcp_servers || [];
      if (servers.length !== 1 || servers[0].name !== "mazebench" || !["pending", "connected"].includes(servers[0].status)) return "Grok MCP server boundary mismatch.";
      initialized = true;
      sessionId = event.session_id;
      return null;
    }
    if (!initialized) return "Grok responded before validating its tool catalog.";
    if (event.type === "system" && event.subtype === "compact_boundary") {
      const metadata = event.compact_metadata;
      if (!metadata || metadata.trigger !== "auto" || !Number.isInteger(metadata.pre_tokens) || metadata.pre_tokens < 1) {
        return "Grok emitted an invalid compaction boundary.";
      }
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(event.uuid || "")) {
        return "Grok emitted an invalid compaction identity.";
      }
      return null;
    }
    if (event.type === "assistant") {
      if (event.message?.model !== model || event.message?.role !== "assistant") return "Grok changed model or response role.";
      for (const block of event.message?.content || []) {
        if (["thinking", "text"].includes(block.type)) continue;
        if (block.type !== "tool_use" || !["search_tool", "use_tool"].includes(block.name) || typeof block.id !== "string") return `Grok attempted forbidden tool ${block.name || block.type}.`;
        const input = block.input || {};
        if (block.name === "search_tool") {
          if (Object.keys(input).some(key => !["query", "limit"].includes(key)) || typeof input.query !== "string" || input.query.length > 500 || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100))) return "Grok attempted an unsafe MCP discovery request.";
        } else if (Object.keys(input).some(key => !["tool_name", "tool_input"].includes(key)) || !allowed.has(input.tool_name) || !input.tool_input || typeof input.tool_input !== "object" || Array.isArray(input.tool_input)) {
          return `Grok attempted forbidden MCP tool ${input.tool_name || "unknown"}.`;
        }
        calls.set(block.id, { name: block.name, input });
      }
      return null;
    }
    if (event.type === "user") {
      for (const block of event.message?.content || []) {
        if (block.type !== "tool_result" || typeof block.content !== "string") return "Grok emitted an unrecognized tool result.";
        const call = calls.get(block.tool_use_id);
        if (!call) return "Grok emitted a tool result without a validated request.";
        try {
          const violation = call.name === "search_tool" ? parseSearchResult(block.content, allowed) : parseUseResult(block.content, allowedRaw);
          if (violation) return violation;
        } catch { return "Grok emitted an unrecognized MCP tool result."; }
        calls.delete(block.tool_use_id);
      }
      return null;
    }
    if (event.type === "result") {
      if (Object.keys(event.modelUsage || {}).some(name => name !== "grok-4.7-build")) return "Grok reported usage for a different model.";
      if ((event.usage?.server_tool_use?.web_search_requests || 0) !== 0) return "Grok used server-side web search.";
      return null;
    }
    return `Grok emitted unexpected event type ${event.type || "unknown"}.`;
  };
}
