import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { digest, providerRuntimeHashes, verifyClaudeIntegrity, buildClaudeArguments } from "../providers/claude-policy.mjs";
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from "../v1/integrity.mjs";
import { safeReadFile } from "../v1/safe-files.mjs";
import { buildCodexArguments, assertHardenedCodexArguments, verifyDirectToolModelCatalog } from "../v1/supervisor.mjs";

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
  for (const name of ["ice-maze/v1", "benchmarking/worlds", "level-data/ice-maze/v1"]) await walk(name);
  return { ...await providerRuntimeHashes(root), ...Object.fromEntries(await Promise.all(files.sort().map(async file => [file, digest(await readFile(path.join(root, file)))]))) };
}
export async function verifyIceIntegrity(root, directory, metadata) {
  if (existsSync(path.join(directory, "integrity-violation.json"))) throw new Error("This run was invalidated and cannot resume.");
  const manifest = await verifyRunIntegrity(root, directory, metadata.integrity), frozen = manifest.configuration;
  assertRunConfiguration(metadata, manifest);
  if (metadata.world !== "ice-maze" || frozen.world !== "ice-maze" || metadata.provider !== frozen.provider || !["codex", "claude-code"].includes(frozen.provider)) throw new Error("World or provider routing changed.");
  if (JSON.stringify(await worldRuntimeHashes(root)) !== JSON.stringify(frozen.world_runtime)) throw new Error("Ice Maze runtime or levels changed; start a new run.");
  if (digest(safeReadFile(directory, "prompt.md")) !== frozen.effective_prompt_sha256) throw new Error("The run prompt changed.");
  if (frozen.provider === "claude-code") await verifyClaudeIntegrity(root, directory, metadata);
  else {
    if (JSON.stringify(metadata.capability_policy) !== JSON.stringify(frozen.codex_policy)) throw new Error("Codex capability policy changed.");
    if (digest(await readFile(frozen.codex_policy.codex_executable)) !== frozen.codex_policy.codex_sha256) throw new Error("Codex executable changed.");
    await verifyDirectToolModelCatalog(directory, metadata.model, frozen.codex_policy.model_catalog);
  }
  verifyCheckpoint(directory); return frozen;
}
export function buildIceCodexArguments(options) {
  const args = buildCodexArguments(options);
  const expected = `mcp_servers.mazebench.args=[${JSON.stringify(path.join(options.projectRoot, "benchmarking/v1/mcp-server.mjs"))}]`;
  const index = args.indexOf(expected);
  if (index < 1 || args[index - 1] !== "-c") throw new Error("Unexpected Codex MCP launch shape.");
  args[index] = `mcp_servers.mazebench.args=[${JSON.stringify(path.join(options.projectRoot, "benchmarking/worlds/mcp-server.mjs"))}]`;
  assertHardenedCodexArguments(args, options); return args;
}
export function buildIceClaudeArguments(options) {
  const args = buildClaudeArguments(options), index = args.indexOf("--mcp-config") + 1;
  const config = JSON.parse(args[index]);
  if (config.mcpServers.mazebench.args[0] !== path.join(options.projectRoot, "benchmarking/providers/claude-mcp.mjs")) throw new Error("Unexpected Claude MCP launch shape.");
  config.mcpServers.mazebench.args[0] = path.join(options.projectRoot, "benchmarking/worlds/mcp-server.mjs");
  args[index] = JSON.stringify(config); return args;
}
