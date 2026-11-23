import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { digest, verifyClaudeIntegrity, buildClaudeArguments } from "../providers/claude-policy.mjs";
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from "../v1/integrity.mjs";
import { safeReadFile } from "../v1/safe-files.mjs";
import { buildCodexArguments, assertHardenedCodexArguments, verifyDirectToolModelCatalog } from "../v1/supervisor.mjs";

import { worldRuntimeHashes as existingWorldRuntimeHashes } from "../worlds/policy.mjs";
import { sequenceEnabled, slotskiTools } from "./action-policy.mjs";

export async function worldRuntimeHashes(root) {
  const files = [];
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("World runtime cannot use symbolic links.");
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(file);
      else if (/\.(mjs|json|md)$/.test(file)) files.push(file);
    }
  }
  for (const name of ["slotski/v1", "benchmarking/slotski", "level-data/slotski/v1"]) await walk(name);
  return { ...await existingWorldRuntimeHashes(root), ...Object.fromEntries(await Promise.all(files.sort().map(async file => [file, digest(await readFile(path.join(root, file)))]))) };
}
export async function verifySlotskiIntegrity(root, directory, metadata) {
  if (existsSync(path.join(directory, "integrity-violation.json"))) throw new Error("This run was invalidated and cannot resume.");
  const manifest = await verifyRunIntegrity(root, directory, metadata.integrity), frozen = manifest.configuration;
  assertRunConfiguration(metadata, manifest);
  if (sequenceEnabled(metadata.sequence_enabled) !== sequenceEnabled(frozen.sequence_enabled)) throw new Error("Run configuration changed (sequence_enabled); start a new run.");
  if (metadata.world !== "slotski" || frozen.world !== "slotski" || metadata.provider !== frozen.provider || !["codex", "claude-code"].includes(frozen.provider)) throw new Error("World or provider routing changed.");
  if (JSON.stringify(await worldRuntimeHashes(root)) !== JSON.stringify(frozen.world_runtime)) throw new Error("Slotski runtime or levels changed; start a new run.");
  if (digest(safeReadFile(directory, "prompt.md")) !== frozen.effective_prompt_sha256) throw new Error("The run prompt changed.");
  if (frozen.provider === "claude-code") await verifyClaudeIntegrity(root, directory, metadata);
  else {
    if (JSON.stringify(metadata.capability_policy) !== JSON.stringify(frozen.codex_policy)) throw new Error("Codex capability policy changed.");
    if (digest(await readFile(frozen.codex_policy.codex_executable)) !== frozen.codex_policy.codex_sha256) throw new Error("Codex executable changed.");
    await verifyDirectToolModelCatalog(directory, metadata.model, frozen.codex_policy.model_catalog);
  }
  verifyCheckpoint(directory); return frozen;
}
export function buildSlotskiCodexArguments(options) {
  const args = buildCodexArguments(options);
  const expected = `mcp_servers.mazebench.args=[${JSON.stringify(path.join(options.projectRoot, "benchmarking/v1/mcp-server.mjs"))}]`;
  const index = args.indexOf(expected);
  if (index < 1 || args[index - 1] !== "-c") throw new Error("Unexpected Codex MCP launch shape.");
  args[index] = `mcp_servers.mazebench.args=[${JSON.stringify(path.join(options.projectRoot, "benchmarking/slotski/mcp-server.mjs"))}]`;
  assertHardenedCodexArguments(args, options);
  const toolIndex = args.findIndex(value => value.startsWith("mcp_servers.mazebench.enabled_tools="));
  args[toolIndex] = `mcp_servers.mazebench.enabled_tools=${JSON.stringify(slotskiTools(options))}`;
  assertSlotskiCodexArguments(args, options); return args;
}
export function assertSlotskiCodexArguments(args, options) {
  const prefix = "mcp_servers.mazebench.enabled_tools=";
  const indices = args.flatMap((value, index) => value.startsWith(prefix) ? [index] : []);
  if (indices.length !== 1 || args[indices[0] - 1] !== "-c" ||
      args[indices[0]] !== `${prefix}${JSON.stringify(slotskiTools(options))}`)
    throw new Error("Unexpected Slotski tool catalog.");
  const shared = [...args];
  // Validate the exact narrower list above, then use the shared validator for
  // every other capability. No changes to existing worlds' frozen policies.
  shared[indices[0]] = `${prefix}${JSON.stringify(slotskiTools({ ...options, sequenceEnabled: true }))}`;
  assertHardenedCodexArguments(shared, options);
}
export function buildSlotskiClaudeArguments(options) {
  const args = buildClaudeArguments(options), index = args.indexOf("--mcp-config") + 1;
  const config = JSON.parse(args[index]);
  if (config.mcpServers.mazebench.args[0] !== path.join(options.projectRoot, "benchmarking/providers/claude-mcp.mjs")) throw new Error("Unexpected Claude MCP launch shape.");
  config.mcpServers.mazebench.args[0] = path.join(options.projectRoot, "benchmarking/slotski/mcp-server.mjs");
  args[index] = JSON.stringify(config);
  if (options.sequenceEnabled === false) {
    const allowed = slotskiTools(options).map(name => `mcp__mazebench__${name}`);
    const settingsIndex = args.indexOf("--settings") + 1, settings = JSON.parse(args[settingsIndex]);
    settings.permissions.allow = allowed;
    settings.permissions.deny.push("mcp__mazebench__maze_sequence");
    args[settingsIndex] = JSON.stringify(settings);
    args[args.indexOf("--allowedTools") + 1] = allowed.join(",");
  }
  return args;
}
