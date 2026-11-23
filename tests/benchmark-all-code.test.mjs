import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { supportsAnyLanguage, codingLabel } from '../benchmarking/all-code/capabilities.mjs';
import { anyPrompt, verifyCodeCondition } from '../benchmarking/all-code/policy.mjs';
import { BenchmarkSupervisor } from '../benchmarking/all-code/supervisor.mjs';
import { previewBenchmarkPrompt } from '../benchmarking/prompt-preview.mjs';
import { toolNames as kimiTools } from '../benchmarking/kimi-code/policy.mjs';
import { toolNames as museTools } from '../benchmarking/muse-code/policy.mjs';
import { toolNames as agyTools } from '../benchmarking/antigravity-code/policy.mjs';
import { mazeToolNames as grokTools } from '../benchmarking/grok-code/policy.mjs';
import { TOOLS as primeTools, verifyIntegrity } from '../benchmarking/prime-code/policy.mjs';
import { readCheckpointJson } from '../benchmarking/v1/checkpoint-json.mjs';
const root = path.resolve(import.meta.dirname, '..');
test('every harness exposes Any language in its supported ASCII worlds', async () => {
  const base = await readFile(path.join(root, 'benchmarking/v1/EVAL-PROMPT.md'), 'utf8');
  for (const provider of ['codex', 'claude-code', 'grok-build', 'antigravity', 'muse-code', 'kimi-code', 'prime-agent']) {
    const spec = { provider, coding_mode: 'any', action_limit: 3 };
    assert(supportsAnyLanguage(spec));
    assert.equal(codingLabel(spec), 'Any language');
    assert(!supportsAnyLanguage({ ...spec, observation_mode: 'vision' }));
    const preview = await previewBenchmarkPrompt(root, spec);
    assert.match(preview.prompt, /code_exec/);
    assert.doesNotMatch(preview.prompt, /python_exec|cannot launch subprocesses/);
    if (!['codex', 'claude-code', 'prime-agent'].includes(provider)) assert.equal(preview.prompt, anyPrompt(base, { actionLimit: 3, startRoom: "HxI" }));
  }
  for (const tools of [kimiTools(true), museTools(true), agyTools(true), grokTools(true), primeTools])
    assert.deepEqual(tools, ['maze_observe', 'maze_action', 'maze_sequence', 'code_exec']);
  await assert.rejects(new BenchmarkSupervisor(root).launch({ provider: 'kimi-code', coding_mode: 'off' }), /Any language/);
});

test('new signed gateway executes real code, preserves game counts, denies Python and condition tampering', { timeout: 90000, skip: process.env.MAZEBENCH_TEST_CODE_SANDBOX !== '1' }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-all-code-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  class NoInference extends BenchmarkSupervisor { startPrime() {} }
  const supervisor = new NoInference(root, { recordsRoot: path.join(temp, 'records'), primeStateRoot: path.join(temp, 'private'),
    primeStatus: async () => ({ launch_ready: true, fingerprint: 'fixture', models: [{ id: 'fixture/model' }] }) });
  const run = await supervisor.launch({ provider: 'prime-agent', model: 'fixture/model', coding_mode: 'any', action_limit: 2 });
  assert.equal(run.coding_mode, 'any');
  const directory = supervisor.runDirectory(run.id);
  const metadata = JSON.parse(await readFile(path.join(directory, 'run.json')));
  const frozen = await verifyIntegrity(root, directory, metadata);
  await assert.rejects(verifyCodeCondition(root, { ...metadata, coding_mode: 'python' }, frozen), /condition changed/);
  await assert.rejects(verifyCodeCondition(root, { ...metadata, code_sandbox: { ...metadata.code_sandbox, image: 'latest' } }, frozen), /condition changed/);
  const child = spawn(process.execPath, [path.join(root, 'benchmarking/all-code/mcp.mjs')], {
    env: { PATH: '/usr/bin:/bin', MAZEBENCH_PROJECT_ROOT: root, MAZEBENCH_RUN_DIRECTORY: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let sequence = 0, errors = ''; const pending = new Map();
  child.stderr.on('data', data => errors += data);
  child.on('exit', () => { for (const p of pending.values()) p.reject(new Error(errors || 'Gateway stopped')); pending.clear(); });
  readline.createInterface({ input: child.stdout }).on('line', line => { const r = JSON.parse(line); pending.get(r.id)?.resolve(r); pending.delete(r.id); });
  const call = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tools = await call('tools/list'); assert.deepEqual(tools.result.tools.map(t => t.name), primeTools);
  assert.deepEqual((await call('resources/list')).result, { resources: [] });
  assert.deepEqual((await call('resources/templates/list')).result, { resourceTemplates: [] });
  assert.equal((await call('resources/read', { uri: 'file://' + path.join(directory, 'run.json') })).error.code, -32602);
  const before = (await readCheckpointJson(directory, 'summary.json')).action_count;
  const response = await call('tools/call', { name: 'code_exec', arguments: { command: 'node main.js && g++ main.cpp -o main && ./main',
    files: [{ path: 'main.js', content: 'console.log(42)' }, { path: 'main.cpp', content: '#include <iostream>\nint main(){std::cout << 43 << std::endl;}' }] } });
  assert.equal(response.result.isError, false, JSON.stringify(response));
  const result = JSON.parse(response.result.content[0].text); assert.equal(result.exit_code, 0); assert.match(result.stdout, /42\s+43/);
  assert.equal((await readCheckpointJson(directory, 'summary.json')).action_count, before);
  const denied = await call('tools/call', { name: 'python_exec', arguments: { code: 'print(1)' } }); assert(denied.result.isError);
  const move = await call('tools/call', { name: 'maze_sequence', arguments: { sequence: 'UDLR' } });
  assert.equal(JSON.parse(move.result.content[0].text).final_observation.game_status, 'action-limit');
  await writeFile(path.join(directory, 'prompt.md'), 'tampered');
  await assert.rejects(verifyIntegrity(root, directory, metadata), /prompt changed/);
});
