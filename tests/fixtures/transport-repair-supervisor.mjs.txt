import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { preflightPythonSandbox, workspaceInventory } from "./python-sandbox.mjs";
import { BenchmarkGameRuntime, DEFAULT_START_ROOM } from "./runtime.mjs";
import { inspectCodex, codexBinaryDigest, codexInstallationStatus, VERIFIED_CODEX_VERSIONS } from "./codex-installation.mjs";
import { CAPABILITY_POLICY_VERSION, CAPABILITY_POLICY_NAME, createRunIntegrity, verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from "./integrity.mjs";
import { safeDirectory, safeReadFile } from "./safe-files.mjs";

const DEFAULT_MODEL = "gpt-5.6-terra";
const DEFAULT_EFFORT = "medium";
const MAZEBENCH_TOOL_NAMESPACE = "mcp__mazebench";
const DIRECT_MODEL_CATALOG_FILE = "direct-model-catalog.json";
const REQUIRED_CODEX_FEATURES = ["code_mode", "code_mode_host", "shell_tool", "unified_exec"];
// This changes the compaction transport, not the agent's tool capabilities.
// Disabling it sends ChatGPT-authenticated runs to the obsolete /responses/compact.
const REQUIRED_RUNTIME_FEATURES = ["remote_compaction_v2"];
const BASELINE_DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "code_mode",
  "code_mode_host",
  "code_mode_only",
  "computer_use",
  "enable_mcp_apps",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "plugin_sharing",
  "remote_plugin",
  "shell_tool",
  "skill_search",
  "standalone_web_search",
  "tool_search",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "workspace_dependencies"
];
const RUN_ID_PATTERN = /^run-[0-9TZ-]+-[a-f0-9]{6}$/;
const CHAT_ID_PATTERN = /^chat-(?:legacy-[a-f0-9]{6}|[0-9TZ-]+-[a-f0-9]{6})$/;
const INTERVIEW_RETRY_BASE_MS = 30_000;
const INTERVIEW_RETRY_MAX_MS = 5 * 60_000;

function now() {
  return new Date().toISOString();
}

function runId() {
  return `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

function chatId() {
  return `chat-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readJsonLines(filePath, maximum = 500) {
  try {
    const lines = (await readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean);
    return lines.slice(-maximum).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function initialThreadId(filePath) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started") return event.thread_id || event.threadId || null;
        if (event.msg?.type === "thread.started") return event.msg.thread_id || event.msg.threadId || null;
      } catch {
        // Ignore a partial final line in the bounded prefix.
      }
    }
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
  return null;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function inlineStringTable(entries) {
  return `{ ${Object.entries(entries)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ")} }`;
}

function inlinePermissionTable(entries) {
  return `{${Object.entries(entries)
    .map(([entry, access]) => `${tomlString(entry)}=${tomlString(access)}`)
    .join(",")}}`;
}

export function parseCodexFeatureInventory(output) {
  const features = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^([a-z][a-z0-9_]*)\s+(.+?)\s+(true|false)$/);
    if (!match || ["deprecated", "removed"].includes(match[2].trim())) continue;
    features.push(match[1]);
  }
  return [...new Set(features)].sort();
}

function directModelCatalogPath(runDirectory) {
  return path.join(path.resolve(runDirectory), "sandbox-state", DIRECT_MODEL_CATALOG_FILE);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function writeDirectToolModelCatalog(runDirectory, model, options = {}) {
  const sourcePath = path.resolve(
    options.sourcePath || path.join(os.homedir(), ".codex", "models_cache.json")
  );
  const sourceBytes = await readFile(sourcePath, "utf8");
  let source;
  try {
    source = JSON.parse(sourceBytes);
  } catch {
    throw new Error(`Cannot parse the local Codex model catalog at ${sourcePath}.`);
  }
  const selected = source.models?.find((entry) => entry.slug === model);
  if (!selected) throw new Error(`Codex model ${model} is missing from the local model catalog.`);
  const catalog = {
    ...source,
    // A one-model catalog prevents a session from switching back to an entry
    // whose metadata silently requires the JavaScript code-mode executor.
    models: [{
      ...selected,
      tool_mode: "direct",
      shell_type: "disabled",
      apply_patch_tool_type: null,
      experimental_supported_tools: [],
      supports_search_tool: false,
      multi_agent_version: null,
      // Codex's Responses backend suppresses an MCP tool literally named
      // `python_exec` when this metadata bit is true. JavaScript is disabled
      // by direct tool mode plus the two fail-closed host controls below.
      node_repl_disabled: false
    }]
  };
  const encoded = `${JSON.stringify(catalog, null, 2)}\n`;
  const outputPath = directModelCatalogPath(runDirectory);
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporary, encoded, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, outputPath);
  return {
    file: path.relative(path.resolve(runDirectory), outputPath),
    sha256: sha256(encoded),
    source_sha256: sha256(sourceBytes),
    model,
    tool_mode: "direct",
    node_repl_disabled: false,
    javascript_host: "disabled"
  };
}

export async function verifyDirectToolModelCatalog(runDirectory, model, expected = null) {
  const catalogPath = directModelCatalogPath(runDirectory);
  const encoded = await readFile(catalogPath, "utf8").catch(() => null);
  if (!encoded) throw new Error("The run's direct-tool model catalog is missing; refusing to start Codex.");
  let catalog;
  try {
    catalog = JSON.parse(encoded);
  } catch {
    throw new Error("The run's direct-tool model catalog is invalid; refusing to start Codex.");
  }
  const entries = Array.isArray(catalog.models) ? catalog.models : [];
  const selected = entries.length === 1 ? entries[0] : null;
  if (selected?.slug !== model || selected.tool_mode !== "direct" || selected.node_repl_disabled !== false ||
      selected.shell_type !== "disabled" || selected.apply_patch_tool_type !== null ||
      selected.supports_search_tool !== false || selected.multi_agent_version !== null ||
      !Array.isArray(selected.experimental_supported_tools) || selected.experimental_supported_tools.length) {
    throw new Error("The run's model catalog does not enforce the verified direct-tool metadata.");
  }
  const digest = sha256(encoded);
  if (expected?.sha256 && expected.sha256 !== digest) {
    throw new Error("The run's direct-tool model catalog changed after launch; refusing to start Codex.");
  }
  return { path: catalogPath, sha256: digest };
}

export function discoverCodexCapabilityPolicy(codexBin = "codex") {
  const installation = inspectCodex(codexBin);
  codexBin = installation.executable;
  const inventory = spawnSync(codexBin, ["features", "list"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024
  });
  if (inventory.status !== 0) {
    throw new Error(`Cannot verify the Codex feature inventory: ${String(inventory.stderr || inventory.error || "unknown error").trim()}`);
  }
  const featureInventory = parseCodexFeatureInventory(inventory.stdout);
  const disabledFeatures = featureInventory.filter(feature => !REQUIRED_RUNTIME_FEATURES.includes(feature));
  const missing = [...REQUIRED_CODEX_FEATURES, ...REQUIRED_RUNTIME_FEATURES].filter((feature) => !featureInventory.includes(feature));
  if (missing.length) {
    throw new Error(`This Codex build cannot prove the benchmark execution boundary; missing features: ${missing.join(", ")}.`);
  }
  const version = spawnSync(codexBin, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024
  });
  const codexVersion = String(version.stdout || "").trim();
  if (version.status !== 0 || !codexVersion) {
    throw new Error("Cannot verify the Codex version for the benchmark execution boundary.");
  }
  if (!VERIFIED_CODEX_VERSIONS.has(codexVersion)) {
    throw new Error(`Codex ${codexVersion} has not been security-tested for MazeBench. Refusing to launch until its tool boundary is revalidated.`);
  }
  return {
    version: CAPABILITY_POLICY_VERSION,
    verified_at: now(),
    codex_version: codexVersion,
    codex_executable: codexBin,
    codex_sha256: codexBinaryDigest(codexBin),
    disabled_features: disabledFeatures,
    enabled_features: [...REQUIRED_RUNTIME_FEATURES],
    direct_only_namespaces: [MAZEBENCH_TOOL_NAMESPACE],
    model_tool_mode: "direct",
    javascript_host: "disabled",
    code_execution: "python_exec-only",
    writable_root: "/workspace"
  };
}

function appendDisabledFeatureArguments(args, featureNames = BASELINE_DISABLED_FEATURES) {
  for (const feature of [...new Set([...BASELINE_DISABLED_FEATURES, ...featureNames])].sort()) {
    if (REQUIRED_RUNTIME_FEATURES.includes(feature)) continue;
    args.push("--disable", feature);
  }
  for (const feature of REQUIRED_RUNTIME_FEATURES) args.push("-c", `features.${feature}=true`);
  // Terra's model catalog currently forces code_mode_only. These table-form
  // overrides are deliberately applied after every --disable so the namespace
  // routing survives while both JavaScript hosts remain fail-closed.
  args.push(
    "-c", "features.code_mode.enabled=false",
    "-c", `features.code_mode.direct_only_tool_namespaces=[${tomlString(MAZEBENCH_TOOL_NAMESPACE)}]`,
    "-c", `features.code_mode.excluded_tool_namespaces=[${tomlString(MAZEBENCH_TOOL_NAMESPACE)}]`,
    "-c", "features.code_mode_host.enabled=false",
    "-c", "features.code_mode_host.disable_in_process_fallback=true"
  );
}

function hasArgumentPair(args, flag, value) {
  return args.some((entry, index) => entry === flag && args[index + 1] === value);
}

export function assertHardenedCodexArguments(args, options = {}) {
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--strict-config"]) {
    if (!args.includes(flag)) throw new Error(`Unsafe Codex launch: missing ${flag}.`);
  }
  if (args.includes("--enable") || args.includes("--dangerously-bypass-approvals-and-sandbox")) {
    throw new Error("Unsafe Codex launch: capability overrides are forbidden.");
  }
  const overrides = new Map();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "-c") continue;
    const value = args[i + 1] || "";
    const separator = value.indexOf("=");
    const key = value.slice(0, separator);
    if (separator < 0 || overrides.has(key)) throw new Error(`Unsafe duplicate or invalid Codex override: ${key}.`);
    if (key.startsWith("mcp_servers.") && !key.startsWith("mcp_servers.mazebench.")) throw new Error("Unexpected MCP server.");
    overrides.set(key, value.slice(separator + 1));
  }
  for (const [key, expected] of Object.entries({
    model_provider: '"openai"', approval_policy: '"never"', sandbox_mode: '"read-only"',
    web_search: '"disabled"', "tools.web_search": "false", project_doc_max_bytes: "0",
    "skills.include_instructions": "false", "skills.bundled.enabled": "false",
    "apps._default.enabled": "false", "memories.use_memories": "false", mcp_servers: "{}",
    "tools.experimental_request_user_input.enabled": "false", "tools.update_plan.enabled": "false"
  })) {
    if (overrides.get(key) !== expected) throw new Error(`Unsafe Codex launch: ${key} must equal ${expected}.`);
  }
  const mode = overrides.get("default_permissions");
  const permissionName = mode === '"mazebench_interview"' ? "mazebench_interview" : "mazebench_agent";
  if (overrides.get(`permissions.${permissionName}.network.enabled`) !== "false") throw new Error("Network must be disabled.");
  if (permissionName === "mazebench_interview") {
    if (overrides.get("mcp_servers.mazebench.enabled") !== "false") throw new Error("Interview tools must be disabled.");
  } else {
    const toolList = overrides.get("mcp_servers.mazebench.enabled_tools");
    const off = '["maze_observe","maze_action","maze_sequence"]';
    const on = '["maze_observe","maze_action","maze_sequence","python_exec"]';
    if (![off, on].includes(toolList) || (options.toolsEnabled === false && toolList !== off) ||
        (options.toolsEnabled === true && toolList !== on)) throw new Error("Unexpected benchmark tool catalog.");
    if (overrides.get("mcp_servers.mazebench.required") !== "true") throw new Error("Benchmark MCP must be required.");
  }
  const disabledFeatures = [...new Set([
    ...BASELINE_DISABLED_FEATURES,
    ...(options.disabledFeatures || [])
  ])].filter(feature => !REQUIRED_RUNTIME_FEATURES.includes(feature));
  for (const feature of REQUIRED_RUNTIME_FEATURES) {
    if (hasArgumentPair(args, "--disable", feature) || overrides.get(`features.${feature}`) !== "true") {
      throw new Error(`Unsafe Codex launch: required runtime feature ${feature} must be enabled.`);
    }
  }
  for (const feature of disabledFeatures) {
    if (!hasArgumentPair(args, "--disable", feature)) {
      throw new Error(`Unsafe Codex launch: feature ${feature} was not disabled.`);
    }
  }
  for (const override of [
    "features.code_mode.enabled=false",
    `features.code_mode.direct_only_tool_namespaces=[${tomlString(MAZEBENCH_TOOL_NAMESPACE)}]`,
    `features.code_mode.excluded_tool_namespaces=[${tomlString(MAZEBENCH_TOOL_NAMESPACE)}]`,
    "features.code_mode_host.enabled=false",
    "features.code_mode_host.disable_in_process_fallback=true"
  ]) {
    if (!hasArgumentPair(args, "-c", override)) {
      throw new Error(`Unsafe Codex launch: missing ${override}.`);
    }
  }
  if (!options.modelCatalogPath ||
      !hasArgumentPair(args, "-c", `model_catalog_json=${tomlString(options.modelCatalogPath)}`)) {
    throw new Error("Unsafe Codex launch: the direct-tool model catalog was not configured.");
  }
  return true;
}

function hardenedCodexEnvironment(runDirectory) {
  return {
    HOME: os.homedir(),
    PATH: process.env.PATH || "/usr/bin:/bin",
    TMPDIR: os.tmpdir(),
    LANG: "en_US.UTF-8",
    // Do not inherit endpoint overrides, hooks, plugin settings, API keys or
    // desktop control sockets. Authentication comes from Codex's auth store.
    // Even if a future Codex release ignores the feature override, there is no
    // executable host to run. In-process fallback is disabled separately.
    CODEX_CODE_MODE_HOST_PATH: path.join(runDirectory, "sandbox-state", "code-mode-host-disabled")
  };
}

function safeRunId(value) {
  const id = String(value || "");
  if (!RUN_ID_PATTERN.test(id)) throw new Error("Invalid benchmark run id.");
  return id;
}

function safeChatId(value) {
  const id = String(value || "");
  if (!CHAT_ID_PATTERN.test(id)) throw new Error("Invalid interview chat id.");
  return id;
}

function publicInterviewError(value) {
  const message = String(value || "Interview failed.").trim();
  if (/404 Not Found[\s\S]*(?:codex\/responses|codex\/models)/i.test(message)) {
    return "The Codex service returned 404 while answering. The interview fork is saved; retry this question without affecting the benchmark.";
  }
  return message.length > 600 ? `${message.slice(0, 597)}…` : message;
}

export function publicRunError(value) {
  const source = String(value || "Benchmark execution failed.").trim();
  try {
    const parsed = JSON.parse(source);
    if (parsed.error?.message) return String(parsed.error.message);
  } catch { /* stderr may contain a log prefix */ }
  const modelError = source.match(/The '[^']+' model requires a newer version of Codex\.[^"\n]*/);
  if (modelError) return modelError[0].replaceAll("\\", "");
  return source.length > 1200 ? `${source.slice(0, 1197)}…` : source;
}

// Codex emits this passive recovery notice as an error item before retrying
// over HTTPS. It grants no tool capability and must not terminate the retry.
export function isCodexTransportNotice(event) {
  const type = event?.type || event?.msg?.type;
  const item = event?.item || event?.msg?.item || {};
  return type === "item.completed" && (item.type || item.item_type) === "error" &&
    typeof item.id === "string" && typeof item.message === "string" &&
    /^Falling back from WebSockets to HTTPS transport\.(?:[ \t][^\r\n]*)?$/.test(item.message) &&
    Object.keys(item).every(key => ["id", "type", "item_type", "message"].includes(key));
}

export function eventBoundaryViolation(event, { toolsEnabled = false, interview = false } = {}) {
  const type = event.type || event.msg?.type || "";
  if (!type.startsWith("item.")) return null;
  const item = event.item || event.msg?.item || {};
  const itemType = item.type || item.item_type;
  if (isCodexTransportNotice(event)) return null;
  if (["reasoning", "agent_message"].includes(itemType)) return null;
  const allowed = ["maze_observe", "maze_action", "maze_sequence", ...(toolsEnabled ? ["python_exec"] : [])];
  if (!interview && itemType === "mcp_tool_call" && item.server === "mazebench" && allowed.includes(item.tool)) return null;
  return `Capability boundary violation: unexpected ${itemType || "unknown item"}${item.tool ? ` (${item.tool})` : ""}. Run invalidated.`;
}

export function isTransientInterviewError(value) {
  const message = String(value || "");
  return /Codex service returned 404/i.test(message) ||
    /(?:404 Not Found|status (?:429|5\d\d))[^\n]*(?:codex\/responses|codex\/models)/i.test(message) ||
    /(?:codex\/responses|codex\/models)[^\n]*(?:404 Not Found|status (?:429|5\d\d))/i.test(message);
}

export function isRecoverableCompactionError(value) {
  const message = String(value || "");
  return /Error running remote compact task:/i.test(message) &&
    /404 Not Found/i.test(message) && /codex\/responses\/compact(?:[\s,]|$)/i.test(message);
}

function interviewRetryDelay(attempt) {
  return Math.min(
    INTERVIEW_RETRY_MAX_MS,
    INTERVIEW_RETRY_BASE_MS * (2 ** Math.max(0, Math.min(4, Number(attempt || 1) - 1)))
  );
}

export function buildBenchmarkPrompt(basePrompt, options) {
  const toolsText = options.toolsEnabled
    ? `PYTHON WORKSPACE: python_exec is the only code executor. Every agent-authored program it executes is first saved as a relative .py file in the persistent isolated /workspace. All agent-authored writes must stay in /workspace. Python cannot read the read-only MazeBench records, the host, repositories, credentials, benchmark results, or prior runs, cannot use the network, and cannot launch subprocesses. Transfer any observations you need into your own Python code or data explicitly. Never use JavaScript, functions.exec, shell, or any other code executor.`
    : `TOOLS-OFF CONDITION: Python, JavaScript, functions.exec, shell, writable files, web, apps, connectors, and subagents are unavailable. The base prompt's general file/Python suggestion does not apply in this condition. Use only direct calls to maze_observe, maze_action, and maze_sequence.`;
  return `${basePrompt.trim()}

Benchmark harness
This run starts in room ${options.startRoom} and ends after exactly ${options.actionLimit ?? "unlimited"} accepted actions or after all 100 unique gems are collected. Do not stop while playable action budget remains.

maze_observe is the only read interface for the run's read-only records. Call it directly with no arguments for the current board, state, recent history, and records index. Call it directly with a listed relative record path to read that immutable record. maze_observe never consumes an action.

Call maze_action and maze_sequence directly. Never place MazeBench tool calls inside a program, loop, callback, batch executor, or functions.exec. maze_action applies one action. maze_sequence applies either a compact UDRL string or an explicit ordered action list. Every accepted step—including blocked movement and camera actions—counts separately. Inspect the returned observation after acting. If the player dies, recover with undo, reset, or a previously visited room.

${toolsText}

Call maze_observe now, then keep playing until the harness reports won or action-limit. The game state can only be changed through maze_action and maze_sequence.`;
}

export function buildCodexArguments(options) {
  const mcpServer = path.join(options.projectRoot, "benchmarking", "v1", "mcp-server.mjs");
  const enabledTools = ["maze_observe", "maze_action", "maze_sequence"];
  if (options.toolsEnabled) enabledTools.push("python_exec");
  const permissions = {
    ":minimal": "read",
    [os.homedir()]: "deny",
    [options.projectRoot]: "deny",
    [options.runDirectory]: "deny"
  };
  const modelCatalogPath = path.resolve(String(options.modelCatalogPath || ""));
  if (modelCatalogPath !== directModelCatalogPath(options.runDirectory)) {
    throw new Error("Unsafe Codex launch: model catalog must be the run-scoped hardened catalog.");
  }
  const args = options.resumeThreadId
    ? ["exec", "resume", options.resumeThreadId, "--json", "--skip-git-repo-check"]
    : ["exec", "--json", "--skip-git-repo-check", "-C", options.agentDirectory];
  args.push(
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "-c", 'model_provider="openai"',
    "-c", 'approval_policy="never"',
    "-c", 'sandbox_mode="read-only"',
    "-c", 'web_search="disabled"',
    "-c", "tools.web_search=false",
    "-c", "tools.experimental_request_user_input.enabled=false",
    "-c", "tools.update_plan.enabled=false",
    "-c", "agents.max_depth=1",
    "-c", "project_doc_max_bytes=0",
    "-c", "memories.use_memories=false",
    "-c", "memories.generate_memories=false",
    "-c", "apps._default.enabled=false",
    "-c", "skills.include_instructions=false",
    "-c", "skills.bundled.enabled=false",
    "-c", "include_apps_instructions=false",
    "-c", "include_collaboration_mode_instructions=false",
    "-c", "include_environment_context=false",
    "-c", `model_catalog_json=${tomlString(modelCatalogPath)}`,
    "-c", "mcp_servers={}",
    "-c", 'default_permissions="mazebench_agent"',
    "-c", `permissions.mazebench_agent.filesystem=${inlinePermissionTable(permissions)}`,
    "-c", "permissions.mazebench_agent.network.enabled=false",
    "-c", `mcp_servers.mazebench.command=${tomlString(process.execPath)}`,
    "-c", `mcp_servers.mazebench.args=[${tomlString(mcpServer)}]`,
    "-c", "mcp_servers.mazebench.enabled=true",
    "-c", "mcp_servers.mazebench.required=true",
    "-c", `mcp_servers.mazebench.enabled_tools=${JSON.stringify(enabledTools)}`,
    "-c", 'mcp_servers.mazebench.default_tools_approval_mode="approve"',
    "-c", "mcp_servers.mazebench.startup_timeout_sec=20",
    "-c", "mcp_servers.mazebench.tool_timeout_sec=300",
    "-c", `mcp_servers.mazebench.env=${inlineStringTable({
      MAZEBENCH_PROJECT_ROOT: options.projectRoot,
      MAZEBENCH_RUN_DIRECTORY: options.runDirectory,
      MAZEBENCH_PYTHON_ENABLED: options.toolsEnabled ? "1" : "0",
      MAZEBENCH_CAPABILITY_POLICY: CAPABILITY_POLICY_NAME
    })}`
  );
  appendDisabledFeatureArguments(args, options.disabledFeatures);
  args.push(
    "-c", 'model_reasoning_summary="detailed"',
    "-m", options.model,
    "-c", `model_reasoning_effort=${tomlString(options.effort)}`,
    "-o", path.join(options.runDirectory, "last-message.txt"),
    options.prompt
  );
  assertHardenedCodexArguments(args, {
    disabledFeatures: options.disabledFeatures,
    modelCatalogPath,
    toolsEnabled: options.toolsEnabled
  });
  return args;
}

export function buildInterviewPrompt(question, options = {}) {
  const action = Number.isFinite(options.branchedAtAction)
    ? ` after action ${options.branchedAtAction}`
    : "";
  return `MAZEBENCH INTERVIEW

This is an isolated fork of your MazeBench benchmark thread captured${action}. The original benchmark thread and its resumable game state must remain untouched and may still be running. You have no tools in this interview and cannot make more maze moves.

Answer from the strategy, observations, and decisions present in your original transcript. Be candid and specific. Distinguish remembered facts from retrospective inference; do not invent hidden reasoning that is not available to you.

Question: ${String(question).trim()}`;
}

function appendInterviewIsolationArguments(args, options) {
  const permissions = {
    ":minimal": "read",
    [os.homedir()]: "deny",
    [options.projectRoot]: "deny",
    [options.runDirectory]: "deny"
  };
  const modelCatalogPath = path.resolve(String(options.modelCatalogPath || ""));
  if (modelCatalogPath !== directModelCatalogPath(options.runDirectory)) {
    throw new Error("Unsafe Codex interview: model catalog must be the run-scoped hardened catalog.");
  }
  args.push(
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "-c", 'model_provider="openai"',
    "-c", 'approval_policy="never"',
    "-c", 'sandbox_mode="read-only"',
    "-c", 'web_search="disabled"',
    "-c", "tools.web_search=false",
    "-c", "tools.experimental_request_user_input.enabled=false",
    "-c", "tools.update_plan.enabled=false",
    "-c", "project_doc_max_bytes=0",
    "-c", "memories.use_memories=false",
    "-c", "memories.generate_memories=false",
    "-c", "apps._default.enabled=false",
    "-c", "skills.include_instructions=false",
    "-c", "skills.bundled.enabled=false",
    "-c", "include_apps_instructions=false",
    "-c", "include_collaboration_mode_instructions=false",
    "-c", "include_environment_context=false",
    "-c", `model_catalog_json=${tomlString(modelCatalogPath)}`,
    "-c", "mcp_servers={}",
    "-c", `mcp_servers.mazebench.command=${tomlString(process.execPath)}`,
    "-c", 'mcp_servers.mazebench.args=["--version"]',
    "-c", "mcp_servers.mazebench.enabled=false",
    "-c", 'default_permissions="mazebench_interview"',
    "-c", `permissions.mazebench_interview.filesystem=${inlinePermissionTable(permissions)}`,
    "-c", "permissions.mazebench_interview.network.enabled=false"
  );
  appendDisabledFeatureArguments(args, options.disabledFeatures);
  args.push(
    "-c", 'model_reasoning_summary="detailed"',
    "-m", options.model,
    "-c", `model_reasoning_effort=${tomlString(options.effort)}`
  );
  assertHardenedCodexArguments(args, {
    disabledFeatures: options.disabledFeatures,
    modelCatalogPath
  });
  return args;
}

export function buildInterviewForkArguments(options) {
  return appendInterviewIsolationArguments(
    ["exec", "fork", options.parentThreadId],
    options
  );
}

export function buildInterviewArguments(options) {
  const args = appendInterviewIsolationArguments(
    options.forkThreadId
      ? ["exec", "resume", options.forkThreadId]
      : ["exec", "fork", options.parentThreadId],
    options
  );
  args.push(
    "-o", options.outputFile,
    buildInterviewPrompt(options.question, { branchedAtAction: options.branchedAtAction })
  );
  return args;
}

function publicModel(model) {
  return {
    id: model.slug,
    name: model.display_name || model.slug,
    description: model.description || "",
    default_effort: model.default_reasoning_level || DEFAULT_EFFORT,
    efforts: (model.supported_reasoning_levels || []).map((entry) => entry.effort)
  };
}

async function codexModels() {
  const cache = await readJson(path.join(os.homedir(), ".codex", "models_cache.json"), { models: [] });
  return (cache.models || [])
    .filter((model) => model.visibility !== "hide")
    .map(publicModel);
}

function eventFeed(events) {
  return events.flatMap((event) => {
    if ((event.type || event.msg?.type) !== "item.completed") return [];
    const item = event.item || event.msg?.item || {};
    const type = item.type || item.item_type;
    if (type === "reasoning" || type === "agent_message") {
      const text = String(item.text || "").trim();
      return text ? [{ type, text, at: event._received_at || event.timestamp || null }] : [];
    }
    if (type === "mcp_tool_call") {
      return [{
        type: "tool",
        tool: item.tool || item.name || item.tool_name || "mcp",
        arguments: item.arguments || item.input || {},
        status: item.status || (item.error ? "failed" : "completed"),
        at: event._received_at || event.timestamp || null
      }];
    }
    return [];
  });
}

function usageFromEvents(events) {
  let usage = null;
  for (const event of events) {
    if (event.type === "turn.completed" && event.usage) usage = event.usage;
    if (event.msg?.type === "turn.completed" && event.msg.usage) usage = event.msg.usage;
  }
  return usage;
}

export class BenchmarkSupervisor {
  constructor(projectRoot, options = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.recordsRoot = path.resolve(
      options.recordsRoot ||
      process.env.MAZEBENCH_RECORDS_ROOT ||
      path.join(os.homedir(), "records", "mazebench-benchmark")
    );
    this.codexBin = options.codexBin || process.env.MAZEBENCH_CODEX_BIN || "codex";
    this.active = new Map();
    this.displayBackfills = new Map();
    this.interviewActive = new Map();
    this.interviewRetryTimers = new Map();
  }

  async initialize() {
    await mkdir(this.recordsRoot, { recursive: true, mode: 0o700 });
  }

  codexCapabilityPolicy() {
    return discoverCodexCapabilityPolicy(this.codexBin);
  }

  async verifyRunCapabilityBoundary(metadata, directory) {
    if (metadata.capability_policy?.version !== CAPABILITY_POLICY_VERSION) {
      throw new Error("This run predates the direct-tool Python-only capability boundary and cannot execute another benchmark turn.");
    }
    if (existsSync(path.join(directory, "integrity-violation.json"))) {
      throw new Error("This run was invalidated by an integrity violation and cannot resume.");
    }
    if (metadata.integrity?.version !== CAPABILITY_POLICY_VERSION || !/^[a-f0-9]{64}$/.test(metadata.integrity.manifest_sha256 || "")) {
      throw new Error("Run integrity attestation is missing; refusing execution.");
    }
    const capabilityPolicy = this.codexCapabilityPolicy();
    const modelCatalog = await verifyDirectToolModelCatalog(
      directory,
      metadata.model,
      metadata.capability_policy.model_catalog
    );
    if (capabilityPolicy.codex_sha256 !== metadata.capability_policy.codex_sha256) {
      throw new Error("The Codex executable changed since this run started; start a new run.");
    }
    const manifest = await verifyRunIntegrity(this.projectRoot, directory, metadata.integrity);
    assertRunConfiguration(metadata, manifest);
    if (sha256(safeReadFile(directory, "prompt.md")) !== metadata.effective_prompt_sha256) {
      throw new Error("The run prompt changed; refusing execution.");
    }
    verifyCheckpoint(directory);
    if (metadata.tools_enabled) {
      preflightPythonSandbox({ workspace: path.join(directory, "workspace"), stateDirectory: path.join(directory, "sandbox-state"), projectRoot: this.projectRoot, runDirectory: directory });
    }
    return { capabilityPolicy, modelCatalog };
  }

  async ensureInterviewModelCatalog(metadata, directory) {
    try {
      return await verifyDirectToolModelCatalog(
        directory,
        metadata.model,
        metadata.capability_policy?.version === CAPABILITY_POLICY_VERSION
          ? metadata.capability_policy.model_catalog
          : null
      );
    } catch (error) {
      if (metadata.capability_policy?.version === CAPABILITY_POLICY_VERSION) throw error;
      await writeDirectToolModelCatalog(directory, metadata.model);
      return verifyDirectToolModelCatalog(directory, metadata.model);
    }
  }

  async status(options = {}) {
    return codexInstallationStatus(this.codexBin, options);
  }

  async models() {
    const models = await codexModels();
    return {
      codex_available: models.length > 0,
      default_model: models.some((model) => model.id === DEFAULT_MODEL) ? DEFAULT_MODEL : models[0]?.id || "",
      models
    };
  }

  runDirectory(id) {
    return path.join(this.recordsRoot, safeRunId(id));
  }

  async recoverThreadId(directory, metadata) {
    if (!metadata || metadata.codex_thread_id) return metadata;
    const recovered = await initialThreadId(path.join(directory, "agent-events.jsonl"));
    if (!recovered) return metadata;
    const current = await readJson(path.join(directory, "run.json"), metadata);
    if (!current.codex_thread_id) {
      current.codex_thread_id = recovered;
      current.thread_id_recovered_at = now();
      current.updated_at = now();
      await atomicJson(path.join(directory, "run.json"), current);
    }
    return current;
  }

  async validateSpec(spec = {}) {
    const catalog = await this.models();
    const model = String(spec.model || catalog.default_model || DEFAULT_MODEL);
    const selected = catalog.models.find((entry) => entry.id === model);
    if (!selected) throw new Error(`Codex model ${model} is not available locally.`);
    const effort = String(spec.effort || selected.default_effort || DEFAULT_EFFORT);
    if (!selected.efforts.includes(effort)) {
      throw new Error(`${model} does not support reasoning effort ${effort}.`);
    }
    const actionLimit = spec.action_limit === null || String(spec.action_limit).toLowerCase() === "unlimited"
      ? null
      : Math.max(1, Math.min(1_000_000, Math.floor(Number(spec.action_limit) || 100)));
    return {
      model,
      effort,
      toolsEnabled: Boolean(spec.tools_enabled),
      actionLimit,
      startRoom: String(spec.start_room || DEFAULT_START_ROOM),
      pairId: spec.pair_id ? String(spec.pair_id).slice(0, 100) : null
    };
  }

  async launch(spec = {}) {
    await this.initialize();
    const options = await this.validateSpec(spec);
    const capabilityPolicy = this.codexCapabilityPolicy();
    const id = runId();
    const directory = this.runDirectory(id);
    const agentDirectory = path.join(directory, "agent-cwd");
    const stateDirectory = path.join(directory, "sandbox-state");
    await Promise.all([
      mkdir(directory, { recursive: true, mode: 0o700 }),
      mkdir(agentDirectory, { recursive: true, mode: 0o700 }),
      mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    ]);
    const modelCatalog = await writeDirectToolModelCatalog(directory, options.model);
    capabilityPolicy.model_catalog = modelCatalog;
    const basePrompt = await readFile(path.join(this.projectRoot, "benchmarking", "v1", "EVAL-PROMPT.md"), "utf8");
    const prompt = buildBenchmarkPrompt(basePrompt, options);
    const createdAt = now();
    const metadata = {
      schema_version: 1,
      id,
      pair_id: options.pairId,
      created_at: createdAt,
      updated_at: createdAt,
      status: "preparing",
      model: options.model,
      effort: options.effort,
      tools_enabled: options.toolsEnabled,
      action_limit: options.actionLimit,
      start_room: options.startRoom,
      prompt_sha256: createHash("sha256").update(basePrompt).digest("hex"),
      effective_prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
      codex_thread_id: null,
      continuation_count: 0,
      error: null,
      stopped_at: null,
      completed_at: null,
      capability_policy: capabilityPolicy,
      isolation: options.toolsEnabled ? { verified: false } : { mode: "no-python" }
    };
    metadata.integrity = await createRunIntegrity(this.projectRoot, directory, {
      model: metadata.model, effort: metadata.effort, tools_enabled: metadata.tools_enabled,
      action_limit: metadata.action_limit, start_room: metadata.start_room,
      effective_prompt_sha256: metadata.effective_prompt_sha256
    });
    await Promise.all([
      writeFile(path.join(directory, "prompt.md"), prompt, "utf8"),
      atomicJson(path.join(directory, "run.json"), metadata),
      BenchmarkGameRuntime.create(this.projectRoot, directory, {
        startRoom: options.startRoom,
        actionLimit: options.actionLimit
      })
    ]);
    if (options.toolsEnabled) {
      try {
        const isolation = preflightPythonSandbox({
          workspace: path.join(directory, "workspace"),
          stateDirectory,
          projectRoot: this.projectRoot,
          runDirectory: directory,
          codexBin: this.codexBin
        });
        metadata.isolation = isolation;
        await atomicJson(path.join(directory, "sandbox-preflight.json"), isolation);
      } catch (error) {
        metadata.status = "failed";
        metadata.error = String(error?.message || error);
        metadata.updated_at = now();
        await atomicJson(path.join(directory, "run.json"), metadata);
        throw error;
      }
    }
    metadata.status = "queued";
    metadata.updated_at = now();
    await atomicJson(path.join(directory, "run.json"), metadata);
    const control = { child: null, stopRequested: false, pauseRequested: false, threadId: null };
    this.active.set(id, control);
    this.runLoop(id, directory, agentDirectory, prompt, control).catch(async (error) => {
      const current = await readJson(path.join(directory, "run.json"), metadata);
      if (!control.stopRequested && !control.pauseRequested) {
        current.status = "failed";
        current.error = String(error?.message || error);
        current.updated_at = now();
        current.completed_at = now();
        await atomicJson(path.join(directory, "run.json"), current);
      }
      this.active.delete(id);
    });
    return this.get(id);
  }

  async launchPair(spec = {}) {
    const pairId = `pair-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
    const base = { ...spec, pair_id: pairId };
    const withoutTools = await this.launch({ ...base, tools_enabled: false });
    try {
      const withTools = await this.launch({ ...base, tools_enabled: true });
      return { pair_id: pairId, runs: [withoutTools, withTools] };
    } catch (error) {
      await this.stop(withoutTools.id).catch(() => {});
      throw error;
    }
  }

  async runLoop(id, directory, agentDirectory, initialPrompt, control) {
    let metadata = await readJson(path.join(directory, "run.json"));
    let threadId = metadata.codex_thread_id;
    let prompt = initialPrompt;
    while (!control.stopRequested && !control.pauseRequested) {
      metadata = await readJson(path.join(directory, "run.json"), metadata);
      metadata.status = threadId ? "continuing" : "running";
      metadata.updated_at = now();
      await atomicJson(path.join(directory, "run.json"), metadata);
      if (control.stopRequested || control.pauseRequested) break;
      const actionCountBefore = (await readJson(path.join(directory, "summary.json"), {})).action_count || 0;
      const turn = await this.runCodexTurn({
        metadata,
        directory,
        agentDirectory,
        prompt,
        resumeThreadId: threadId,
        control
      });
      threadId = turn.threadId || threadId;
      metadata = await readJson(path.join(directory, "run.json"), metadata);
      metadata.codex_thread_id = threadId;
      metadata.updated_at = now();
      if (turn.usage) metadata.usage = turn.usage;
      if (turn.boundaryError) throw new Error(turn.boundaryError);
      verifyCheckpoint(directory);
      const summary = await readJson(path.join(directory, "summary.json"), {});
      if (["won", "action-limit"].includes(summary.game_status)) {
        metadata.status = "completed";
        metadata.completed_at = now();
        await atomicJson(path.join(directory, "run.json"), metadata);
        this.active.delete(id);
        return;
      }
      if (control.pauseRequested) {
        metadata.status = "paused";
        metadata.paused_at = now();
        metadata.updated_at = now();
        await atomicJson(path.join(directory, "run.json"), metadata);
        this.active.delete(id);
        return;
      }
      if (control.stopRequested) break;
      if (turn.code !== 0) {
        metadata.status = "failed";
        metadata.error = publicRunError(turn.reportedError || turn.stderrTail || `Codex exited with status ${turn.code}.`);
        metadata.completed_at = now();
        await atomicJson(path.join(directory, "run.json"), metadata);
        this.active.delete(id);
        return;
      }
      if (!threadId) throw new Error("Codex completed without reporting a resumable thread id.");
      metadata.continuation_count += 1;
      metadata.last_turn_actions = Math.max(0, (summary.action_count || 0) - actionCountBefore);
      await atomicJson(path.join(directory, "run.json"), metadata);
      prompt = `Continue the same MazeBench benchmark. Call maze_observe to re-anchor, then keep acting. Do not stop until the tool reports won or action-limit. You currently have ${summary.action_count || 0} accepted actions recorded.`;
    }
    metadata = await readJson(path.join(directory, "run.json"), metadata);
    metadata.status = control.pauseRequested ? "paused" : "stopped";
    if (control.pauseRequested) metadata.paused_at = now();
    else metadata.stopped_at = now();
    metadata.updated_at = now();
    await atomicJson(path.join(directory, "run.json"), metadata);
    this.active.delete(id);
  }

  async runCodexTurn({ metadata, directory, agentDirectory, prompt, resumeThreadId, control }) {
    const { capabilityPolicy, modelCatalog } = await this.verifyRunCapabilityBoundary(metadata, directory);
    return new Promise((resolve, reject) => {
      const args = buildCodexArguments({
        projectRoot: this.projectRoot,
        runDirectory: directory,
        agentDirectory,
        model: metadata.model,
        effort: metadata.effort,
        toolsEnabled: metadata.tools_enabled,
        disabledFeatures: capabilityPolicy.disabled_features,
        modelCatalogPath: modelCatalog.path,
        prompt,
        resumeThreadId
      });
      const child = spawn(capabilityPolicy.codex_executable, args, {
        cwd: agentDirectory,
        env: hardenedCodexEnvironment(directory),
        stdio: ["ignore", "pipe", "pipe"]
      });
      control.child = child;
      const eventStream = createWriteStream(path.join(directory, "agent-events.jsonl"), { flags: "a" });
      const stderrStream = createWriteStream(path.join(directory, "agent-stderr.log"), { flags: "a" });
      let stdoutBuffer = "";
      let stderrTail = "";
      let threadId = resumeThreadId || null;
      let persistedThreadId = resumeThreadId || null;
      let threadPersistence = Promise.resolve();
      let usage = null;
      let reportedError = "";
      let boundaryError = null;
      const integrityMonitor = setInterval(() => {
        const file = path.join(directory, "integrity-violation.json");
        if (!existsSync(file)) return;
        try { boundaryError = `Run invalidated: ${JSON.parse(readFileSync(file, "utf8")).error}`; }
        catch { boundaryError = "Run invalidated by an integrity violation."; }
        child.kill("SIGKILL");
      }, 500);

      const captureThreadId = (candidate) => {
        if (!candidate) return;
        threadId = candidate;
        control.threadId = candidate;
        if (candidate === persistedThreadId) return;
        persistedThreadId = candidate;
        threadPersistence = threadPersistence.then(async () => {
          const current = await readJson(path.join(directory, "run.json"), metadata);
          if (current.codex_thread_id === candidate) return;
          current.codex_thread_id = candidate;
          current.updated_at = now();
          await atomicJson(path.join(directory, "run.json"), current);
        });
      };

      const receiveLine = (line) => {
        const source = line.trim();
        if (!source) return;
        let event;
        try {
          event = JSON.parse(source);
        } catch {
          return;
        }
        event._received_at = now();
        eventStream.write(`${JSON.stringify(event)}\n`);
        const violation = eventBoundaryViolation(event, { toolsEnabled: metadata.tools_enabled });
        if (violation) { boundaryError = violation; child.kill("SIGKILL"); }
        if (event.type === "turn.failed") reportedError = String(event.error?.message || "");
        if (event.type === "error" && !/^Reconnecting/i.test(String(event.message || ""))) reportedError = String(event.message || "");
        if (event.type === "thread.started") captureThreadId(event.thread_id || event.threadId);
        if (event.msg?.type === "thread.started") captureThreadId(event.msg.thread_id || event.msg.threadId);
        if (event.type === "turn.completed" && event.usage) usage = event.usage;
        if (event.msg?.type === "turn.completed" && event.msg.usage) usage = event.msg.usage;
      };

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        lines.forEach(receiveLine);
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stderrStream.write(text);
        stderrTail = `${stderrTail}${text}`.slice(-8_000);
      });
      child.on("error", (error) => {
        clearInterval(integrityMonitor);
        eventStream.end();
        stderrStream.end();
        reject(error);
      });
      child.on("close", async (code, signal) => {
        clearInterval(integrityMonitor);
        if (stdoutBuffer.trim()) receiveLine(stdoutBuffer);
        eventStream.end();
        stderrStream.end();
        control.child = null;
        await threadPersistence.catch(() => {});
        resolve({ code: code ?? (signal ? 1 : 0), signal, threadId, usage, boundaryError, reportedError, stderrTail: stderrTail.trim() });
      });
    });
  }

  async stop(idValue) {
    const id = safeRunId(idValue);
    const directory = this.runDirectory(id);
    const metadata = await readJson(path.join(directory, "run.json"));
    if (!metadata) throw new Error("Benchmark run not found.");
    const control = this.active.get(id);
    if (control) {
      control.stopRequested = true;
      control.child?.kill("SIGINT");
    } else if (!["completed", "failed", "stopped"].includes(metadata.status)) {
      metadata.status = "stopped";
      metadata.stopped_at = now();
      metadata.updated_at = now();
      await atomicJson(path.join(directory, "run.json"), metadata);
    }
    return this.get(id);
  }

  async delete(idValue) {
    const id = safeRunId(idValue);
    const directory = this.runDirectory(id);
    const metadata = await readJson(path.join(directory, "run.json"));
    if (!metadata) throw new Error("Benchmark run not found.");
    if (this.active.has(id)) {
      throw new Error("Stop or pause this benchmark before deleting it.");
    }
    if (this.displayBackfills.has(id)) {
      throw new Error("Wait for move-history processing to finish before deleting this benchmark.");
    }
    const prefix = `${id}:`;
    if ([...this.interviewActive.keys()].some((key) => key.startsWith(prefix))) {
      throw new Error("Wait for the active interview answer to finish before deleting this benchmark.");
    }
    for (const [key, timer] of this.interviewRetryTimers) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.interviewRetryTimers.delete(key);
    }
    await rm(directory, { recursive: true, force: false });
    return { id, deleted: true };
  }

  async pause(idValue) {
    const id = safeRunId(idValue);
    const directory = this.runDirectory(id);
    const metadata = await readJson(path.join(directory, "run.json"));
    if (!metadata) throw new Error("Benchmark run not found.");
    const control = this.active.get(id);
    if (!control) {
      if (metadata.status === "paused") return this.get(id);
      throw new Error("Only an active benchmark can be paused.");
    }
    control.pauseRequested = true;
    metadata.status = "pausing";
    metadata.updated_at = now();
    await atomicJson(path.join(directory, "run.json"), metadata);
    control.child?.kill("SIGINT");
    return this.get(id);
  }

  async resume(idValue) {
    const id = safeRunId(idValue);
    const directory = this.runDirectory(id);
    const agentDirectory = path.join(directory, "agent-cwd");
    let metadata = await readJson(path.join(directory, "run.json"));
    if (!metadata) throw new Error("Benchmark run not found.");
    metadata = await this.recoverThreadId(directory, metadata);
    if (this.active.has(id)) throw new Error("This benchmark is already running.");
    const recoverCompaction = metadata.status === "failed" && isRecoverableCompactionError(metadata.error);
    if (!["paused", "stopped"].includes(metadata.status) && !recoverCompaction) {
      throw new Error("Only a paused, stopped, or recoverable compaction-failed benchmark can be resumed.");
    }
    if (metadata.capability_policy?.version !== CAPABILITY_POLICY_VERSION) {
      throw new Error("This legacy run used the unsafe Codex tool boundary and cannot be resumed. Its record and interview forks remain available.");
    }
    // Re-discover the current CLI inventory before resuming. A newly added
    // feature is disabled automatically, and an incompatible Codex build fails
    // here instead of starting with an unknown capability surface.
    await this.verifyRunCapabilityBoundary(metadata, directory);
    if (!metadata.codex_thread_id) throw new Error("The benchmark has no resumable Codex thread.");
    const summary = await readJson(path.join(directory, "summary.json"), {});
    if (["won", "action-limit"].includes(summary.game_status)) {
      throw new Error("This benchmark has already reached its terminal game state.");
    }
    metadata.status = "queued";
    if (recoverCompaction) {
      metadata.recoveries = [...(metadata.recoveries || []), {
        at: now(), reason: "remote-compaction-v2", previous_error: metadata.error,
        action_count: summary.action_count, codex_thread_id: metadata.codex_thread_id
      }];
    }
    metadata.error = null;
    metadata.paused_at = null;
    metadata.stopped_at = null;
    metadata.completed_at = null;
    metadata.resumed_at = now();
    metadata.updated_at = now();
    await atomicJson(path.join(directory, "run.json"), metadata);
    const control = {
      child: null,
      stopRequested: false,
      pauseRequested: false,
      threadId: metadata.codex_thread_id
    };
    this.active.set(id, control);
    const prompt = `Resume the same MazeBench benchmark from its saved state. Call maze_observe to re-anchor, then keep acting. Do not stop until the tool reports won or action-limit. You currently have ${summary.action_count || 0} accepted actions recorded.`;
    this.runLoop(id, directory, agentDirectory, prompt, control).catch(async (error) => {
      const current = await readJson(path.join(directory, "run.json"), metadata);
      if (!control.stopRequested && !control.pauseRequested) {
        current.status = "failed";
        current.error = String(error?.message || error);
        current.updated_at = now();
        current.completed_at = now();
        await atomicJson(path.join(directory, "run.json"), current);
      }
      this.active.delete(id);
    });
    return this.get(id);
  }

  async record(idValue, recordValue) {
    const id = safeRunId(idValue);
    const record = String(recordValue || "").replaceAll("\\", "/");
    const allowed = ["current_board.txt", "current_state.json", "moves.txt", "history.jsonl"].includes(record) ||
      /^move_history\/move_(?:0|[1-9]\d*)\.txt$/.test(record);
    if (!allowed || record.includes("..") || path.isAbsolute(record)) {
      throw new Error("Unknown benchmark record.");
    }
    const recordsDirectory = path.join(this.runDirectory(id), "records");
    const filePath = path.resolve(recordsDirectory, record);
    if (!filePath.startsWith(`${recordsDirectory}${path.sep}`)) throw new Error("Invalid benchmark record path.");
    safeDirectory(this.runDirectory(id), "records");
    return safeReadFile(recordsDirectory, record);
  }

  async backfillDisplayHistory(id, directory) {
    if (this.displayBackfills.has(id)) return this.displayBackfills.get(id);
    const backfill = (async () => {
      const [metadata, state] = await Promise.all([
        readJson(path.join(directory, "run.json")),
        readJson(path.join(directory, "game-state.json"))
      ]);
      if (!metadata || !state) throw new Error("Benchmark run state is unavailable.");
      const temporary = await mkdtemp(path.join(os.tmpdir(), "mazebench-display-history-"));
      try {
        const replay = await BenchmarkGameRuntime.create(this.projectRoot, temporary, {
          startRoom: metadata.start_room,
          actionLimit: metadata.action_limit
        });
        for (const action of state.actions || []) await replay.apply(action.action);
        const generatedDirectory = path.join(temporary, "display-history");
        const generatedFrames = await readdir(generatedDirectory);
        for (const fileName of generatedFrames.filter((name) => /^move_\d+\.json$/.test(name))) {
          const frame = await readJson(path.join(generatedDirectory, fileName));
          const textName = fileName.replace(/\.json$/, ".txt");
          const source = await readFile(path.join(directory, "records", "move_history", textName), "utf8");
          const lines = source.replace(/\r/g, "").split("\n");
          lines.shift();
          if (lines.at(-1) === "") lines.pop();
          if (lines.join("\n") !== frame?.level) {
            throw new Error(`Engine replay does not match ${textName}.`);
          }
        }
        const destination = path.join(directory, "display-history");
        await mkdir(destination, { recursive: true, mode: 0o700 });
        await cp(generatedDirectory, destination, {
          recursive: true,
          force: true
        });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    })();
    this.displayBackfills.set(id, backfill);
    try {
      await backfill;
    } finally {
      this.displayBackfills.delete(id);
    }
  }

  async displayFrame(idValue, indexValue) {
    const id = safeRunId(idValue);
    const indexText = String(indexValue ?? "");
    if (!/^(?:0|[1-9]\d*)$/.test(indexText)) throw new Error("Invalid display frame index.");
    const index = Number(indexText);
    const directory = this.runDirectory(id);
    const summary = await readJson(path.join(directory, "summary.json"));
    if (!summary) throw new Error("Benchmark run not found.");
    if (index > summary.action_count) throw new Error("Display frame is outside the recorded move history.");
    const filePath = path.join(directory, "display-history", `move_${index}.json`);
    let frame = await readJson(filePath);
    if (!frame) {
      await this.backfillDisplayHistory(id, directory);
      frame = await readJson(filePath);
    }
    if (!frame) throw new Error(`Display frame ${index} is unavailable.`);
    return {
      ...frame,
      source_record: `records/move_history/move_${index}.txt`
    };
  }

  interviewDirectory(runDirectory, chatValue) {
    return path.join(runDirectory, "interviews", safeChatId(chatValue));
  }

  interviewKey(id, chat) {
    return `${id}:${chat}`;
  }

  async migrateLegacyInterview(id, directory) {
    const legacy = await readJson(path.join(directory, "interview", "chat.json"));
    if (!legacy) return;
    const legacyId = `chat-legacy-${id.slice(-6)}`;
    const destination = this.interviewDirectory(directory, legacyId);
    const filePath = path.join(destination, "chat.json");
    if (await readJson(filePath)) return;
    const summary = await readJson(path.join(directory, "summary.json"), {});
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const state = {
      ...legacy,
      schema_version: 2,
      id: legacyId,
      title: "Chat 1",
      branched_at_action: summary.action_count || 0,
      run_status_at_branch: "completed",
      ended_at: null
    };
    await atomicJson(filePath, state);
    for (const name of ["events.jsonl", "stderr.log", "last-message.txt"]) {
      await cp(path.join(directory, "interview", name), path.join(destination, name), {
        force: false,
        errorOnExist: false
      }).catch(() => {});
    }
  }

  async listInterviews(idValue) {
    const id = safeRunId(idValue);
    const directory = this.runDirectory(id);
    let [metadata, summary] = await Promise.all([
      readJson(path.join(directory, "run.json")),
      readJson(path.join(directory, "summary.json"), {})
    ]);
    if (!metadata) throw new Error("Benchmark run not found.");
    metadata = await this.recoverThreadId(directory, metadata);
    await this.migrateLegacyInterview(id, directory);
    const root = path.join(directory, "interviews");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const chats = (await Promise.all(entries
      .filter((entry) => entry.isDirectory() && CHAT_ID_PATTERN.test(entry.name))
      .map((entry) => this.getInterviewChat(id, entry.name).catch(() => null))))
      .filter(Boolean)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    return {
      schema_version: 2,
      run_id: id,
      run_status: metadata.status,
      action_count: summary.action_count || 0,
      parent_thread_id: metadata.codex_thread_id || null,
      available: Boolean(metadata.codex_thread_id),
      chats: chats.map((chat) => ({
        id: chat.id,
        title: chat.title,
        status: chat.status,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
        ended_at: chat.ended_at,
        branched_at_action: chat.branched_at_action,
        run_status_at_branch: chat.run_status_at_branch,
        fork_thread_id: chat.fork_thread_id,
        message_count: chat.messages.length,
        last_message: chat.messages.at(-1)?.content?.slice(0, 140) || "No questions yet."
      }))
    };
  }

  async getInterviewChat(idValue, chatValue) {
    const id = safeRunId(idValue);
    const chat = safeChatId(chatValue);
    const directory = this.runDirectory(id);
    const metadata = await readJson(path.join(directory, "run.json"));
    if (!metadata) throw new Error("Benchmark run not found.");
    const interviewDirectory = this.interviewDirectory(directory, chat);
    const filePath = path.join(interviewDirectory, "chat.json");
    const saved = await readJson(filePath);
    if (!saved) throw new Error("Interview chat not found.");
    const pendingMessage = saved.messages?.at(-1)?.role === "user"
      ? saved.messages.at(-1).content
      : null;
    if (saved.status === "failed" && pendingMessage && isTransientInterviewError(saved.error)) {
      saved.status = "queued";
      saved.error = null;
      saved.last_service_error = "Codex is temporarily unavailable.";
      saved.pending_question = pendingMessage;
      saved.retry_attempt = Math.max(1, Number(saved.retry_attempt) || 1);
      saved.next_retry_at = now();
      saved.updated_at = now();
      await atomicJson(filePath, saved);
    }
    if (saved.status === "queued" && saved.pending_question) {
      this.scheduleInterviewRetry(id, chat, saved.pending_question, saved.next_retry_at);
    }
    const key = this.interviewKey(id, chat);
    return {
      schema_version: 2,
      id: chat,
      run_id: id,
      title: saved.title || "Interview chat",
      parent_thread_id: saved.parent_thread_id || metadata.codex_thread_id || null,
      fork_thread_id: saved.fork_thread_id || null,
      branched_at_action: Number(saved.branched_at_action) || 0,
      run_status_at_branch: saved.run_status_at_branch || null,
      created_at: saved.created_at || null,
      updated_at: saved.updated_at || null,
      ended_at: saved.ended_at || null,
      status: this.interviewActive.has(key) ? saved.status === "forking" ? "forking" : "running" : saved.status,
      error: saved.status === "failed" && saved.error ? publicInterviewError(saved.error) : null,
      notice: saved.status === "queued"
        ? "Codex is temporarily unavailable. Your question is saved and will retry automatically."
        : null,
      next_retry_at: saved.status === "queued" ? saved.next_retry_at || null : null,
      retry_attempt: saved.status === "queued" ? Number(saved.retry_attempt) || 1 : 0,
      messages: saved.messages || [],
      available: Boolean(saved.fork_thread_id) && saved.status !== "ended",
      original_untouched: true
    };
  }

  scheduleInterviewRetry(id, chat, question, retryAt) {
    const key = this.interviewKey(id, chat);
    if (this.interviewRetryTimers.has(key)) return;
    const delay = Math.max(250, new Date(retryAt || 0).getTime() - Date.now());
    const timer = setTimeout(async () => {
      this.interviewRetryTimers.delete(key);
      try {
        await this.askInterview(id, chat, question, { automatic: true });
      } catch {
        // askInterview persists terminal failures for the record page to show.
      }
    }, delay);
    timer.unref?.();
    this.interviewRetryTimers.set(key, timer);
  }

  async runInterviewFork({ metadata, directory, interviewDirectory }) {
    const capabilityPolicy = this.codexCapabilityPolicy();
    const modelCatalog = await this.ensureInterviewModelCatalog(metadata, directory);
    return new Promise((resolve, reject) => {
      const args = buildInterviewForkArguments({
        projectRoot: this.projectRoot,
        runDirectory: directory,
        parentThreadId: metadata.codex_thread_id,
        model: metadata.model,
        effort: metadata.effort,
        disabledFeatures: capabilityPolicy.disabled_features,
        modelCatalogPath: modelCatalog.path
      });
      const child = spawn(capabilityPolicy.codex_executable, args, {
        cwd: path.join(directory, "agent-cwd"),
        env: hardenedCodexEnvironment(directory),
        stdio: ["ignore", "pipe", "pipe"]
      });
      const eventStream = createWriteStream(path.join(interviewDirectory, "events.jsonl"), { flags: "a" });
      const stderrStream = createWriteStream(path.join(interviewDirectory, "stderr.log"), { flags: "a" });
      let stdoutBuffer = "";
      let stderrTail = "";
      let forkThreadId = null;
      let boundaryError = null;
      const receiveLine = (line) => {
        const source = line.trim();
        if (!source) return;
        let event;
        try {
          event = JSON.parse(source);
        } catch {
          return;
        }
        event._received_at = now();
        eventStream.write(`${JSON.stringify(event)}\n`);
        const violation = eventBoundaryViolation(event, { interview: true });
        if (violation) { boundaryError = violation; child.kill("SIGKILL"); }
        if (event.type === "thread.started") forkThreadId = event.thread_id || event.threadId || forkThreadId;
        if (event.msg?.type === "thread.started") {
          forkThreadId = event.msg.thread_id || event.msg.threadId || forkThreadId;
        }
      };
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        lines.forEach(receiveLine);
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stderrStream.write(text);
        stderrTail = `${stderrTail}${text}`.slice(-8_000);
      });
      child.on("error", (error) => {
        eventStream.end();
        stderrStream.end();
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (stdoutBuffer.trim()) receiveLine(stdoutBuffer);
        eventStream.end();
        stderrStream.end();
        resolve({ code: boundaryError ? 1 : code ?? (signal ? 1 : 0), forkThreadId, stderrTail: boundaryError || stderrTail.trim() });
      });
    });
  }

  async createInterview(idValue) {
    const id = safeRunId(idValue);
    const directory = this.runDirectory(id);
    let [metadata, summary, library] = await Promise.all([
      readJson(path.join(directory, "run.json")),
      readJson(path.join(directory, "summary.json"), {}),
      this.listInterviews(id)
    ]);
    if (!metadata) throw new Error("Benchmark run not found.");
    metadata = await this.recoverThreadId(directory, metadata);
    if (!metadata.codex_thread_id) {
      throw new Error("The benchmark thread is still starting. Try again as soon as its first model event appears.");
    }
    const chat = chatId();
    const interviewDirectory = this.interviewDirectory(directory, chat);
    await mkdir(interviewDirectory, { recursive: true, mode: 0o700 });
    const timestamp = now();
    const state = {
      schema_version: 2,
      id: chat,
      run_id: id,
      title: `Chat ${library.chats.length + 1}`,
      parent_thread_id: metadata.codex_thread_id,
      fork_thread_id: null,
      branched_at_action: summary.action_count || 0,
      run_status_at_branch: metadata.status,
      created_at: timestamp,
      updated_at: timestamp,
      ended_at: null,
      status: "forking",
      error: null,
      messages: []
    };
    const filePath = path.join(interviewDirectory, "chat.json");
    await atomicJson(filePath, state);
    const key = this.interviewKey(id, chat);
    this.interviewActive.set(key, true);
    try {
      const result = await this.runInterviewFork({ metadata, directory, interviewDirectory });
      if (result.code !== 0 || !result.forkThreadId) {
        throw new Error(result.stderrTail || "Codex did not report the new interview fork id.");
      }
      state.fork_thread_id = result.forkThreadId;
      state.status = "ready";
      state.updated_at = now();
      await atomicJson(filePath, state);
    } catch (error) {
      state.status = "failed";
      state.error = publicInterviewError(error?.message || error);
      state.updated_at = now();
      await atomicJson(filePath, state);
      throw error;
    } finally {
      this.interviewActive.delete(key);
    }
    return this.getInterviewChat(id, chat);
  }

  async runInterviewTurn({ metadata, directory, interviewDirectory, state, question }) {
    const outputFile = path.join(interviewDirectory, "last-message.txt");
    await writeFile(outputFile, "", "utf8");
    const capabilityPolicy = this.codexCapabilityPolicy();
    const modelCatalog = await this.ensureInterviewModelCatalog(metadata, directory);
    return new Promise((resolve, reject) => {
      const args = buildInterviewArguments({
        projectRoot: this.projectRoot,
        runDirectory: directory,
        parentThreadId: metadata.codex_thread_id,
        forkThreadId: state.fork_thread_id,
        model: metadata.model,
        effort: metadata.effort,
        disabledFeatures: capabilityPolicy.disabled_features,
        modelCatalogPath: modelCatalog.path,
        outputFile,
        branchedAtAction: state.branched_at_action,
        question
      });
      const child = spawn(capabilityPolicy.codex_executable, args, {
        cwd: path.join(directory, "agent-cwd"),
        env: hardenedCodexEnvironment(directory),
        stdio: ["ignore", "pipe", "pipe"]
      });
      const eventStream = createWriteStream(path.join(interviewDirectory, "events.jsonl"), { flags: "a" });
      const stderrStream = createWriteStream(path.join(interviewDirectory, "stderr.log"), { flags: "a" });
      let stdoutBuffer = "";
      let stderrTail = "";
      let forkThreadId = state.fork_thread_id || null;
      let lastAgentMessage = "";
      let reportedError = "";
      let boundaryError = null;

      const receiveLine = (line) => {
        const source = line.trim();
        if (!source) return;
        let event;
        try {
          event = JSON.parse(source);
        } catch {
          return;
        }
        event._received_at = now();
        eventStream.write(`${JSON.stringify(event)}\n`);
        const violation = eventBoundaryViolation(event, { interview: true });
        if (violation) { boundaryError = violation; child.kill("SIGKILL"); }
        if (event.type === "thread.started") forkThreadId = event.thread_id || event.threadId || forkThreadId;
        if (event.msg?.type === "thread.started") {
          forkThreadId = event.msg.thread_id || event.msg.threadId || forkThreadId;
        }
        if ((event.type || event.msg?.type) === "item.completed") {
          const item = event.item || event.msg?.item || {};
          if ((item.type || item.item_type) === "agent_message" && String(item.text || "").trim()) {
            lastAgentMessage = String(item.text).trim();
          }
        }
        if (event.type === "turn.failed") reportedError = String(event.error?.message || "").trim();
        else if (event.type === "error" && !/^Reconnecting/i.test(String(event.message || ""))) {
          reportedError = String(event.message || "").trim();
        }
      };

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        lines.forEach(receiveLine);
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stderrStream.write(text);
        stderrTail = `${stderrTail}${text}`.slice(-8_000);
      });
      child.on("error", (error) => {
        eventStream.end();
        stderrStream.end();
        reject(error);
      });
      child.on("close", async (code, signal) => {
        if (stdoutBuffer.trim()) receiveLine(stdoutBuffer);
        eventStream.end();
        stderrStream.end();
        const savedMessage = await readFile(outputFile, "utf8").catch(() => "");
        resolve({
          code: boundaryError ? 1 : code ?? (signal ? 1 : 0),
          signal,
          forkThreadId,
          answer: savedMessage.trim() || lastAgentMessage,
          reportedError: boundaryError || reportedError,
          stderrTail: stderrTail.trim()
        });
      });
    });
  }

  async askInterview(idValue, chatValue, questionValue, options = {}) {
    const id = safeRunId(idValue);
    const chat = safeChatId(chatValue);
    const question = String(questionValue || "").trim();
    if (!question) throw new Error("Interview question must not be empty.");
    if (question.length > 12_000) throw new Error("Interview question is too long.");
    const key = this.interviewKey(id, chat);
    if (this.interviewActive.has(key)) {
      if (options.automatic) return this.getInterviewChat(id, chat);
      throw new Error("The model is already answering a question.");
    }
    const directory = this.runDirectory(id);
    const metadata = await readJson(path.join(directory, "run.json"));
    if (!metadata) throw new Error("Benchmark run not found.");
    const interviewDirectory = this.interviewDirectory(directory, chat);
    const filePath = path.join(interviewDirectory, "chat.json");
    const saved = await readJson(filePath);
    if (!saved) throw new Error("Interview chat not found.");
    if (saved.status === "ended") throw new Error("This interview chat has ended. Start a new chat to branch from the benchmark again.");
    if (!saved.fork_thread_id) throw new Error("This interview chat does not have a usable fork.");
    const timestamp = now();
    const state = saved;
    if (state.status === "queued" && state.pending_question && !options.automatic) {
      if (state.pending_question !== question) {
        throw new Error("Wait for the queued interview question to finish before asking another.");
      }
      return this.getInterviewChat(id, chat);
    }
    state.messages = state.messages.filter((message, index, messages) => !(
      message.role === "user" &&
      messages[index - 1]?.role === "user" &&
      messages[index - 1]?.content === message.content
    ));
    const retryingPendingQuestion = ["failed", "queued"].includes(state.status) &&
      state.messages.at(-1)?.role === "user" &&
      state.messages.at(-1)?.content === question;
    if (!retryingPendingQuestion) {
      state.messages.push({ role: "user", content: question, at: timestamp });
    }
    state.status = "running";
    state.error = null;
    state.pending_question = question;
    state.next_retry_at = null;
    state.updated_at = timestamp;
    await atomicJson(filePath, state);
    this.interviewActive.set(key, true);
    let queuedForRetry = false;
    try {
      const result = await this.runInterviewTurn({ metadata, directory, interviewDirectory, state, question });
      if (result.forkThreadId) state.fork_thread_id = result.forkThreadId;
      if (result.code !== 0) {
        const detail = result.reportedError || result.stderrTail ||
          `Codex interview exited with status ${result.code}.`;
        if (!isTransientInterviewError(detail)) throw new Error(publicInterviewError(detail));
        state.status = "queued";
        state.error = null;
        state.last_service_error = publicInterviewError(detail);
        state.pending_question = question;
        state.retry_attempt = Math.max(1, Number(state.retry_attempt) + 1 || 1);
        const delay = interviewRetryDelay(state.retry_attempt);
        state.next_retry_at = new Date(Date.now() + delay).toISOString();
        state.updated_at = now();
        await atomicJson(filePath, state);
        this.scheduleInterviewRetry(id, chat, question, state.next_retry_at);
        queuedForRetry = true;
      }
      if (!queuedForRetry) {
        if (!state.fork_thread_id) throw new Error("Codex did not report the forked interview thread id.");
        if (!result.answer) throw new Error("The model returned an empty interview response.");
        state.messages.push({ role: "assistant", content: result.answer, at: now() });
        state.status = "ready";
        state.error = null;
        state.last_service_error = null;
        state.pending_question = null;
        state.retry_attempt = 0;
        state.next_retry_at = null;
        state.updated_at = now();
        await atomicJson(filePath, state);
      }
    } catch (error) {
      state.status = "failed";
      state.error = publicInterviewError(error?.message || error);
      state.updated_at = now();
      await atomicJson(filePath, state);
      throw error;
    } finally {
      this.interviewActive.delete(key);
    }
    return this.getInterviewChat(id, chat);
  }

  async endInterview(idValue, chatValue) {
    const id = safeRunId(idValue);
    const chat = safeChatId(chatValue);
    const key = this.interviewKey(id, chat);
    if (this.interviewActive.has(key)) throw new Error("Wait for the current answer to finish before ending this chat.");
    const directory = this.runDirectory(id);
    const filePath = path.join(this.interviewDirectory(directory, chat), "chat.json");
    const state = await readJson(filePath);
    if (!state) throw new Error("Interview chat not found.");
    const retryTimer = this.interviewRetryTimers.get(key);
    if (retryTimer) clearTimeout(retryTimer);
    this.interviewRetryTimers.delete(key);
    state.status = "ended";
    state.ended_at = state.ended_at || now();
    state.pending_question = null;
    state.next_retry_at = null;
    state.updated_at = now();
    await atomicJson(filePath, state);
    return this.getInterviewChat(id, chat);
  }

  async list() {
    await this.initialize();
    const entries = await readdir(this.recordsRoot, { withFileTypes: true });
    const runs = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .map((entry) => this.get(entry.name, { details: false }).catch(() => null)));
    return runs.filter(Boolean).sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  async get(idValue, { details = true } = {}) {
    const id = safeRunId(idValue);
    const directory = this.runDirectory(id);
    const [metadata, summary] = await Promise.all([
      readJson(path.join(directory, "run.json")),
      readJson(path.join(directory, "summary.json"), {})
    ]);
    if (!metadata) throw new Error("Benchmark run not found.");
    const publicRun = {
      ...metadata,
      ...summary,
      id: metadata.id,
      status: metadata.status,
      error: metadata.error ? publicRunError(metadata.error) : null,
      runner_active: this.active.has(id),
      compaction_recoverable: metadata.status === "failed" && isRecoverableCompactionError(metadata.error),
      capability_boundary_verified: metadata.capability_policy?.version === CAPABILITY_POLICY_VERSION &&
        metadata.capability_policy?.model_catalog?.tool_mode === "direct" &&
        metadata.capability_policy?.model_catalog?.javascript_host === "disabled" &&
        metadata.integrity?.version === CAPABILITY_POLICY_VERSION
    };
    if (!details) {
      delete publicRun.actions;
      delete publicRun.positions;
      delete publicRun.novelty;
      return publicRun;
    }
    let display = await readJson(path.join(directory, "display.json"));
    if (!display) {
      const runtime = await BenchmarkGameRuntime.open(this.projectRoot, directory);
      const observation = await runtime.renderObservation({ includeColor: true });
      display = {
        observation_revision: observation.observation_revision,
        room: observation.room,
        level: observation.level,
        colored_level: observation.colored_level,
        ascii_legend: observation.ascii_legend
      };
      await atomicJson(path.join(directory, "display.json"), display);
    }
    const [events, activity, finalMessage] = await Promise.all([
      readJsonLines(path.join(directory, "agent-events.jsonl"), 800),
      readJsonLines(path.join(directory, "tool-activity.jsonl"), 500),
      readFile(path.join(directory, "last-message.txt"), "utf8").catch(() => "")
    ]);
    return {
      ...publicRun,
      feed: eventFeed(events).slice(-250),
      tool_activity: activity.filter((entry) => entry.status !== "running").slice(-250),
      usage: metadata.usage || usageFromEvents(events),
      final_message: finalMessage.trim(),
      display,
      workspace_files: metadata.tools_enabled
        ? workspaceInventory(path.join(directory, "workspace"))
        : []
    };
  }
}
