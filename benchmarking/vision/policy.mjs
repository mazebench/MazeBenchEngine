import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { digest, providerRuntimeHashes, verifyClaudeIntegrity, buildClaudeArguments } from '../providers/claude-policy.mjs';
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from '../v1/integrity.mjs';
import { safeReadFile } from '../v1/safe-files.mjs';
import { buildCodexArguments, assertHardenedCodexArguments, verifyDirectToolModelCatalog } from '../v1/supervisor.mjs';
export async function visionRuntimeHashes(root){
  const files=[];
  async function walk(relative){for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){
    if(entry.isSymbolicLink())throw new Error('Vision runtime cannot contain symbolic links.');
    const file=relative+'/'+entry.name;if(entry.isDirectory())await walk(file);else if(/\.(mjs|js|glb|html|md)$/.test(file))files.push(file);
  }}
  for(const dir of ['benchmarking/vision','render/vendor','render/v1/assets_3d'])await walk(dir);
  return {...await providerRuntimeHashes(root),...Object.fromEntries(await Promise.all(files.sort().map(async f=>[f,digest(await readFile(path.join(root,f)))])))};
}
export async function verifyVisionIntegrity(root,directory,metadata){
  if(existsSync(path.join(directory,'integrity-violation.json')))throw new Error('This vision run was invalidated and cannot resume.');
  const manifest=await verifyRunIntegrity(root,directory,metadata.integrity),frozen=manifest.configuration;
  assertRunConfiguration(metadata,manifest);
  if(metadata.observation_mode!=='vision'||frozen.observation_mode!=='vision'||metadata.world!=='main-world'||metadata.provider!==frozen.provider||!['codex','claude-code'].includes(metadata.provider))throw new Error('Vision observation mode or provider changed.');
  if(JSON.stringify(await visionRuntimeHashes(root))!==JSON.stringify(frozen.vision_runtime))throw new Error('Vision runtime changed; start a new run.');
  if(digest(safeReadFile(directory,'prompt.md'))!==frozen.effective_prompt_sha256)throw new Error('Vision prompt changed.');
  if(frozen.provider==='claude-code')await verifyClaudeIntegrity(root,directory,metadata);
  else{
    if(JSON.stringify(metadata.capability_policy)!==JSON.stringify(frozen.codex_policy))throw new Error('Codex capability policy changed.');
    if(digest(await readFile(frozen.codex_policy.codex_executable))!==frozen.codex_policy.codex_sha256)throw new Error('Codex executable changed.');
    await verifyDirectToolModelCatalog(directory,metadata.model,frozen.codex_policy.model_catalog);
  }
  verifyCheckpoint(directory);return manifest;
}
export function buildVisionCodexArguments(options){
  const args=buildCodexArguments(options),expected=`mcp_servers.mazebench.args=[${JSON.stringify(path.join(options.projectRoot,'benchmarking/v1/mcp-server.mjs'))}]`;
  const index=args.indexOf(expected);if(index<1||args[index-1]!=='-c')throw new Error('Unexpected Codex MCP launch shape.');
  args[index]=`mcp_servers.mazebench.args=[${JSON.stringify(path.join(options.projectRoot,'benchmarking/vision/mcp-server.mjs'))}]`;
  assertHardenedCodexArguments(args,options);return args;
}
export function buildVisionClaudeArguments(options){
  const args=buildClaudeArguments(options),index=args.indexOf('--mcp-config')+1,config=JSON.parse(args[index]);
  if(config.mcpServers.mazebench.args[0]!==path.join(options.projectRoot,'benchmarking/providers/claude-mcp.mjs'))throw new Error('Unexpected Claude MCP launch shape.');
  config.mcpServers.mazebench.args[0]=path.join(options.projectRoot,'benchmarking/vision/mcp-server.mjs');
  args[index]=JSON.stringify(config);return args;
}
