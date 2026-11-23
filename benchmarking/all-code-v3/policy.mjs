import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildBenchmarkPrompt } from '../v1/supervisor.mjs';
import { CODE_INSTRUCTIONS } from '../code/prompt.mjs';
import { inspectCodeSandbox, preflightCodeSandbox } from '../code/sandbox.mjs';
export const POLICY = 'catalog-harness-code-v3';
export const codeTools = () => ['maze_observe', 'maze_action', 'maze_sequence', 'code_exec'];
const digest = value => createHash('sha256').update(value).digest('hex');
export async function runtimeHashes(root) {
  const files = ['benchmarking/antigravity-code-v3/response-pages.mjs', 'benchmarking/code/sandbox.mjs', 'benchmarking/code/prompt.mjs', 'benchmarking/coding-mode.mjs'];
  for (const name of (await readdir(path.join(root, 'benchmarking/all-code-v3'))).sort()) {
    if (name.endsWith('.mjs')) files.push('benchmarking/all-code-v3/' + name);
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, digest(await readFile(path.join(root, file)))])));
}
export async function prepareCode(root, directory) {
  const sandbox = await inspectCodeSandbox();
  if (!sandbox.available) throw new Error(sandbox.error);
  for (const name of ['agent-cwd', 'workspace', 'sandbox-state']) await mkdir(path.join(directory, name), { recursive: true, mode: 0o700 });
  return { coding_mode: 'any', code_policy: POLICY, code_sandbox: sandbox, code_runtime: await runtimeHashes(root) };
}
export function anyPrompt(base, options) {
  base = base.replace(/Tool Use\n[\s\S]*$/, 'Tool Use\nUse the workspace described by the benchmark harness to model observations and plan moves.');
  const prompt = buildBenchmarkPrompt(base, { ...options, toolsEnabled: true }).replace(/PYTHON WORKSPACE:[^\n]*/, CODE_INSTRUCTIONS);
  if (prompt.includes('python_exec') || prompt.includes('Python is disabled')) throw new Error('Conflicting execution instructions.');
  return prompt;
}
export const codePreflight = (directory, sandbox) => preflightCodeSandbox({ runDirectory: directory, sandbox });
export async function verifyCodeCondition(root, metadata, frozen) {
  for (const key of ['coding_mode', 'code_policy', 'code_sandbox', 'code_runtime']) {
    if (JSON.stringify(metadata[key]) !== JSON.stringify(frozen[key])) throw new Error('Any-language condition changed: ' + key);
  }
  if (frozen.coding_mode !== 'any' || frozen.code_policy !== POLICY || !frozen.tools_enabled) throw new Error('This runner requires the frozen Any language condition.');
  if (JSON.stringify(await runtimeHashes(root)) !== JSON.stringify(frozen.code_runtime)) throw new Error('Any-language runtime changed; start a new run.');
}
export async function verifyCodeIntegrity(root, directory, metadata) {
  const modules = { 'kimi-code': 'kimi-code-v3', 'muse-code': 'muse-code', 'grok-build': 'grok-code', antigravity: 'antigravity-code-v3', 'prime-agent': 'prime-code' };
  const folder = modules[metadata.provider];
  if (!folder) throw new Error('Unsupported Any language harness.');
  const policy = await import('../' + folder + '/policy.mjs');
  return (policy.verifyIntegrity || policy.verifyGrokIntegrity)(root, directory, metadata);
}

export function primePrompt(base, options) {
  return anyPrompt(base, options)
    .replace('code_exec is the only code executor.', 'code_exec is the multi-language code executor.')
    .replace('Call maze_action and maze_sequence directly. Never place MazeBench tool calls inside a program, loop, callback, batch executor, or functions.exec.', 'Call the maze game tools using Prime’s native MCP transport.')
    .replace('Native agent shell/file/web tools and subagents remain unavailable.', 'The native Prime Python workspace remains available in its remote VM for transport and planning.') +
    '\nPrime transport: discover the MCP server named maze. Its tools observe, action, sequence and code_exec expose the benchmark interface. Use maze.code_exec for the isolated multi-language toolchain.\n';
}
