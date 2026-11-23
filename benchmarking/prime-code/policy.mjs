import { verifyCodeCondition } from "../all-code/policy.mjs";
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from '../v1/integrity.mjs';
import { safeReadFile } from '../v1/safe-files.mjs';

export const PROVIDER = 'prime-agent';
export const POLICY = 'prime-agent-any-language-v2';
export const VERSION = '0.9.5';
export const VERIFIERS_VERSION = '0.3.2.dev121';
export const TOOLS = ['maze_observe', 'maze_action', 'maze_sequence', 'code_exec'];
export const digest = value => createHash('sha256').update(value).digest('hex');
export const pythonPath = () => process.env.MAZEBENCH_PRIME_PYTHON || path.join(os.homedir(), '.mazebench/prime/venv/bin/python');
export const stateRoot = () => path.join(os.homedir(), '.mazebench/prime/runs');

export async function credentials() {
  const config = JSON.parse(await readFile(path.join(os.homedir(), '.prime/config.json'), 'utf8'));
  const key = process.env.PRIME_API_KEY || config.api_key;
  if (typeof key !== 'string' || !key.trim()) throw new Error('Sign in with prime login first.');
  return { key, team: config.team_id || null };
}

// This is the trusted evaluator's environment. Verifiers provisions a fresh
// remote agent VM and passes only its scoped inference/MCP proxy credentials.
export async function evaluatorEnvironment(root, home) {
  const { key, team } = await credentials();
  return { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: os.tmpdir(),
    LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: path.join(root, 'benchmarking/prime-code'), PRIME_API_KEY: key,
    ...(team ? { PRIME_TEAM_ID: team } : {}) };
}

export async function runtimeHashes(root) {
  const files = (await readdir(path.join(root, 'benchmarking/prime-code')))
    .filter(name => /\.(mjs|py|txt)$/.test(name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async name => {
    const file = 'benchmarking/prime-code/' + name;
    return [file, digest(await readFile(path.join(root, file)))];
  })));
}

export async function verifyIntegrity(root, directory, metadata) {
  if (existsSync(path.join(directory, 'integrity-violation.json'))) throw new Error('Prime run was invalidated.');
  const manifest = await verifyRunIntegrity(root, directory, metadata.integrity);
  assertRunConfiguration(metadata, manifest);
  const frozen = manifest.configuration;
  await verifyCodeCondition(root, metadata, frozen);
  if (metadata.provider !== PROVIDER || frozen.provider !== PROVIDER || frozen.prime_policy !== POLICY ||
      frozen.prime_version !== VERSION || frozen.world !== 'main-world' || frozen.observation_mode !== 'ascii' || !frozen.tools_enabled)
    throw new Error('Prime Agent capability configuration changed.');
  if (JSON.stringify(await runtimeHashes(root)) !== JSON.stringify(frozen.prime_runtime)) throw new Error('Prime provider code changed; start a new run.');
  if (digest(safeReadFile(directory, 'prompt.md')) !== frozen.effective_prompt_sha256) throw new Error('Benchmark prompt changed.');
  verifyCheckpoint(directory);
  return frozen;
}

export function allowedRequest(request) {
  if (request.method === 'tools/call') return TOOLS.includes(request.params?.name);
  return ['initialize', 'notifications/initialized', 'notifications/cancelled', 'ping', 'tools/list'].includes(request.method);
}
