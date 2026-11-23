import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from '../v1/integrity.mjs';
import { safeReadFile } from '../v1/safe-files.mjs';
import { buildBenchmarkPrompt } from '../v1/supervisor.mjs';

export const POLICY = 'prime-inference-direct-v1';
export const TOOLS = ['maze_observe', 'maze_action', 'maze_sequence'];
export const isDirect = run => run?.provider === 'prime-agent' && run?.harness === POLICY;
export const isDirectSpec = spec => spec?.provider === 'prime-agent' && (spec.coding_mode === 'off' || spec.tools_enabled === false);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const directPrompt = (base, options) => buildBenchmarkPrompt(base, { ...options, toolsEnabled: false });
export async function runtimeHashes(root) {
  const files = ['benchmarking/prime/policy.mjs'];
  for (const name of (await readdir(path.join(root, 'benchmarking/prime-direct'))).sort())
    if (name.endsWith('.mjs')) files.push('benchmarking/prime-direct/' + name);
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, digest(await readFile(path.join(root, file)))])));
}
export async function verifyIntegrity(root, directory, metadata) {
  if (existsSync(path.join(directory, 'integrity-violation.json'))) throw new Error('Prime direct run was invalidated.');
  const manifest = await verifyRunIntegrity(root, directory, metadata.integrity);
  assertRunConfiguration(metadata, manifest);
  const frozen = manifest.configuration;
  for (const key of ['provider', 'harness', 'coding_mode', 'sampling', 'parallel_tool_calls', 'world', 'observation_mode', 'context_window', 'compaction_threshold', 'prime_direct_runtime'])
    if (JSON.stringify(metadata[key]) !== JSON.stringify(frozen[key])) throw new Error('Prime direct configuration changed: ' + key);
  if (!isDirect(frozen) || frozen.coding_mode !== 'off' || frozen.tools_enabled !== false || frozen.world !== 'main-world' || frozen.observation_mode !== 'ascii')
    throw new Error('Prime direct requires the signed coding-off condition.');
  if (JSON.stringify(await runtimeHashes(root)) !== JSON.stringify(frozen.prime_direct_runtime)) throw new Error('Prime direct runtime changed; start a new run.');
  if (digest(safeReadFile(directory, 'prompt.md')) !== frozen.effective_prompt_sha256) throw new Error('Benchmark prompt changed.');
  verifyCheckpoint(directory);
  return frozen;
}
