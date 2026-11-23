import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { digest, providerRuntimeHashes, buildClaudeArguments, createClaudeBoundaryValidator, CLAUDE_POLICY, VERIFIED_CLAUDE_VERSIONS } from "../providers/claude-policy.mjs";
import { buildCodexArguments, assertHardenedCodexArguments, eventBoundaryViolation, verifyDirectToolModelCatalog } from "../v1/supervisor.mjs";
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from "../v1/integrity.mjs";
import { safeReadFile } from "../v1/safe-files.mjs";
import { worldRuntimeHashes as iceHashes } from "../worlds/policy.mjs";
import { worldRuntimeHashes as slotskiHashes } from "../slotski/policy.mjs";
import { supportsAnyLanguage } from "../coding-mode.mjs";

export const CODE_POLICY = "isolated-any-language-v1";
export const codeTools = (options = {}) => ["maze_observe", "maze_action", ...(options.sequenceEnabled === false ? [] : ["maze_sequence"]), "code_exec"];
export async function codeRuntimeHashes(root) {
  const files = ["benchmarking/coding-mode.mjs"];
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Code runtime assets cannot be symbolic links.");
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(file); else if (entry.name !== "README.md") files.push(file);
    }
  }
  await walk("benchmarking/code");
  return { ...await providerRuntimeHashes(root), ...Object.fromEntries(await Promise.all(files.sort().map(async file => [file, digest(await readFile(path.join(root, file)))]))) };
}
export async function verifyCodeIntegrity(root, directory, metadata) {
  if (existsSync(path.join(directory, "integrity-violation.json"))) throw new Error("This run was invalidated and cannot resume.");
  const manifest = await verifyRunIntegrity(root, directory, metadata.integrity);
  assertRunConfiguration(metadata, manifest);
  const frozen = manifest.configuration;
  if (metadata.coding_mode !== "any" || frozen.coding_mode !== "any" || frozen.code_policy !== CODE_POLICY ||
      metadata.code_policy !== CODE_POLICY || !metadata.tools_enabled || !supportsAnyLanguage(metadata)) throw new Error("Any-language coding policy changed.");
  for (const key of ["provider", "world", "observation_mode", "sequence_enabled"]) {
    if (metadata[key] !== frozen[key]) throw new Error(`Any-language run configuration changed (${key}).`);
  }
  if (JSON.stringify(metadata.code_sandbox) !== JSON.stringify(frozen.code_sandbox)) throw new Error("Code sandbox configuration changed.");
  if (JSON.stringify(await codeRuntimeHashes(root)) !== JSON.stringify(frozen.code_runtime)) throw new Error("Any-language runtime changed; start a new run.");
  if (frozen.world !== "main-world" && JSON.stringify(await (frozen.world === "slotski" ? slotskiHashes : iceHashes)(root)) !== JSON.stringify(frozen.world_runtime)) throw new Error("World runtime changed; start a new run.");
  if (digest(safeReadFile(directory, "prompt.md")) !== frozen.effective_prompt_sha256) throw new Error("Benchmark prompt changed.");
  if (metadata.provider === "codex") {
    if (JSON.stringify(metadata.capability_policy) !== JSON.stringify(frozen.codex_policy)) throw new Error("Codex capability policy changed.");
    if (digest(await readFile(frozen.codex_policy.codex_executable)) !== frozen.codex_policy.codex_sha256) throw new Error("Codex executable changed.");
    await verifyDirectToolModelCatalog(directory, metadata.model, frozen.codex_policy.model_catalog);
  } else {
    if (frozen.claude_policy !== CLAUDE_POLICY || !VERIFIED_CLAUDE_VERSIONS.has(frozen.claude_version)) throw new Error("Unverified Claude policy.");
    if (digest(await readFile(frozen.claude_executable)) !== frozen.claude_sha256) throw new Error("Claude executable changed.");
  }
  verifyCheckpoint(directory);
  return frozen;
}
export function buildCodeCodexArguments(options) {
  const args = buildCodexArguments({ ...options, toolsEnabled: true });
  const index = args.findIndex(value => value.startsWith("mcp_servers.mazebench.args="));
  args[index] = `mcp_servers.mazebench.args=[${JSON.stringify(path.join(options.projectRoot, "benchmarking/code/mcp-server.mjs"))}]`;
  const tools = args.findIndex(value => value.startsWith("mcp_servers.mazebench.enabled_tools="));
  args[tools] = `mcp_servers.mazebench.enabled_tools=${JSON.stringify(codeTools(options))}`;
  assertCodeCodexArguments(args, options);
  return args;
}
export function assertCodeCodexArguments(args, options) {
  const prefix = "mcp_servers.mazebench.enabled_tools=";
  const indices = args.flatMap((value, i) => value.startsWith(prefix) ? [i] : []);
  if (indices.length !== 1 || args[indices[0] - 1] !== "-c" || args[indices[0]] !== prefix + JSON.stringify(codeTools(options))) throw new Error("Unexpected any-language tool catalog.");
  const server = `mcp_servers.mazebench.args=[${JSON.stringify(path.join(options.projectRoot, "benchmarking/code/mcp-server.mjs"))}]`;
  if (!args.includes(server)) throw new Error("Unexpected any-language MCP server.");
  const shared = [...args];
  shared[indices[0]] = prefix + JSON.stringify(["maze_observe", "maze_action", "maze_sequence", "python_exec"]);
  assertHardenedCodexArguments(shared, { ...options, toolsEnabled: true });
}
export function buildCodeClaudeArguments(options) {
  const args = buildClaudeArguments({ ...options, toolsEnabled: true });
  const index = args.indexOf("--mcp-config") + 1, config = JSON.parse(args[index]);
  config.mcpServers.mazebench.args = [path.join(options.projectRoot, "benchmarking/code/mcp-server.mjs")];
  args[index] = JSON.stringify(config);
  const allowed = codeTools(options).map(name => `mcp__mazebench__${name}`);
  const settingsIndex = args.indexOf("--settings") + 1, settings = JSON.parse(args[settingsIndex]);
  settings.permissions.allow = allowed;
  settings.permissions.deny.push("mcp__mazebench__python_exec");
  if (options.sequenceEnabled === false) settings.permissions.deny.push("mcp__mazebench__maze_sequence");
  args[settingsIndex] = JSON.stringify(settings);
  args[args.indexOf("--allowedTools") + 1] = allowed.join(",");
  return args;
}
export function codeCodexBoundaryViolation(event, options = {}) {
  const item = event.item || event.msg?.item;
  if (item?.type === "mcp_tool_call" || item?.item_type === "mcp_tool_call") {
    if (item.server !== "mazebench" || !codeTools(options).includes(item.tool)) return "Unexpected any-language tool call.";
    if (item.tool === "code_exec") {
      const copy = structuredClone(event), target = copy.item || copy.msg.item;
      target.tool = "python_exec";
      return eventBoundaryViolation(copy, { toolsEnabled: true });
    }
  }
  return eventBoundaryViolation(event, { toolsEnabled: false });
}
export function createCodeClaudeValidator(options) {
  // Reuse every existing model/session/delegation check after validating the
  // exact new tool names. Only the validated executor name is translated.
  const validate = createClaudeBoundaryValidator({ ...options, toolsEnabled: true });
  const allowed = codeTools(options).map(name => `mcp__mazebench__${name}`);
  return event => {
    const copy = structuredClone(event);
    const translate = name => {
      if (!allowed.includes(name)) throw new Error(`Unexpected any-language tool ${name}.`);
      return name === "mcp__mazebench__code_exec" ? "mcp__mazebench__python_exec" : name;
    };
    try {
      if (copy.type === "system" && copy.subtype === "init") {
        if (JSON.stringify([...(copy.tools || [])].sort()) !== JSON.stringify([...allowed].sort())) return "Unexpected any-language Claude tool catalog.";
        copy.tools = copy.tools.map(translate);
        // The shared validator expects sequence, including for single-move Slotski.
        if (options.sequenceEnabled === false) copy.tools.push("mcp__mazebench__maze_sequence");
      }
      if (copy.type === "tool_progress") copy.tool_name = translate(copy.tool_name);
      if (copy.event?.content_block?.type === "tool_use") copy.event.content_block.name = translate(copy.event.content_block.name);
      for (const block of copy.message?.content || []) if (block.type === "tool_use") block.name = translate(block.name);
      return validate(copy);
    } catch (error) { return error.message; }
  };
}
