import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { catalogModels } from '../benchmarking/prime/status.mjs';
import { allowedRequest, TOOLS, verifyIntegrity } from '../benchmarking/prime/policy.mjs';
import { BenchmarkSupervisor } from '../benchmarking/prime/supervisor.mjs';
import { readJson } from '../benchmarking/providers/claude-runner.mjs';
import { providerName, runCompany } from '../benchmarking/ui/run-library.mjs';
import { RunDashboard } from '../benchmarking/run-dashboard.mjs';
import { TokenTelemetry } from '../benchmarking/token-telemetry.mjs';

const root = path.resolve(import.meta.dirname, '..');
const status = async () => ({ launch_ready: true, fingerprint: 'fixture', models: catalogModels({ data: [
  { id: 'openai/gpt-4.1-mini' }, { id: 'anthropic/claude-haiku-4.5' }
] }) });

test('Prime uses live catalog IDs and provider defaults without inventing effort values', () => {
  const models = catalogModels({ data: [{ id: 'openai/gpt-4.1-mini' }, { id: 'bad model' }, {}] });
  assert.equal(models.length, 1);
  assert.equal(models[0].provider, 'prime-agent');
  assert.deepEqual(models[0].efforts, ['default']);
  assert.equal(providerName('prime-agent'), 'Prime Agent');
  assert.equal(runCompany({ provider: 'prime-agent', model: models[0].id }), 'OpenAI');
  assert.equal(runCompany({ provider: 'prime-agent', model: 'anthropic/claude-haiku-4.5' }), 'Anthropic (Claude)');
});

test('Prime validates native workspace, model, world, effort and matched-pair semantics', async () => {
  const supervisor = new BenchmarkSupervisor(root, { primeStatus: status });
  const spec = await supervisor.validateSpec({ provider: 'prime-agent', action_limit: null });
  assert.equal(spec.actionLimit, null);
  assert.equal(spec.startRoom, 'HxI');
  for (const value of [{ world: 'slotski' }, { observation_mode: 'vision' }, { tools_enabled: false },
    { effort: 'high' }, { model: 'invented' }, { service_tier: 'fast' }, { start_room: '../../secret' }])
    await assert.rejects(supervisor.validateSpec({ provider: 'prime-agent', ...value }));
  await assert.rejects(supervisor.launchPair({ provider: 'prime-agent' }), /no tools-off/);
});

test('Prime gateway permits only the three game tools, no host Python/files/resources', () => {
  for (const name of TOOLS) assert(allowedRequest({ method: 'tools/call', params: { name } }));
  for (const name of ['python_exec', 'bash', 'read_file', 'write_file', 'mcp__other__maze_action'])
    assert(!allowedRequest({ method: 'tools/call', params: { name } }));
  for (const method of ['resources/read', 'resources/list', 'prompts/get', 'sampling/createMessage'])
    assert(!allowedRequest({ method }));
});

test('real Prime game gateway records actions, enforces limit, rejects Python, and detects changed prompt', { timeout: 90000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-prime-gate-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  class NoAgentSupervisor extends BenchmarkSupervisor { startPrime() {} }
  const supervisor = new NoAgentSupervisor(root, { primeStatus: status, recordsRoot: path.join(temp, 'records'), primeStateRoot: path.join(temp, 'private') });
  const run = await supervisor.launch({ provider: 'prime-agent', action_limit: 2 });
  const directory = supervisor.runDirectory(run.id);
  const child = spawn(process.execPath, [path.join(root, 'benchmarking/prime/mcp.mjs')], {
    env: { PATH: '/usr/bin:/bin', MAZEBENCH_PROJECT_ROOT: root, MAZEBENCH_RUN_DIRECTORY: directory }, stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGTERM'));
  let sequence = 0;
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const result = JSON.parse(line); pending.get(result.id)?.(result); pending.delete(result.id); });
  child.stderr.resume();
  const call = (method, params = {}) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const catalog = await call('tools/list');
  assert.deepEqual(catalog.result.tools.map(tool => tool.name), TOOLS);
  assert(catalog.result.tools.every(tool => !tool.description.includes('Never call or orchestrate')));
  assert((await call('tools/call', { name: 'python_exec', arguments: { code: 'raise Exception()' } })).error);
  const response = await call('tools/call', { name: 'maze_sequence', arguments: { sequence: 'UDLR' } });
  const value = JSON.parse(response.result.content[0].text);
  assert.equal(value.completed_count, 2);
  assert.equal(value.final_observation.game_status, 'action-limit');
  const summary = await readJson(path.join(directory, 'summary.json'));
  assert.equal(summary.action_count, 2);
  const overview = await new RunDashboard().overview(supervisor, run.id);
  assert(overview.capability_boundary_verified);
  assert.equal(overview.compaction_recoverable, false);
  const config = JSON.parse(await readFile(path.join(temp, 'private', run.id, 'runner.json')));
  assert.equal(config.game.directory, directory);
  assert(!JSON.stringify(config).includes('api_key'));
  await writeFile(path.join(directory, 'prompt.md'), 'tampered');
  await assert.rejects(verifyIntegrity(root, directory, await readJson(path.join(directory, 'run.json'))), /prompt changed/);
});

test('Prime resume refuses to silently create a new conversation', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-prime-resume-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const supervisor = new BenchmarkSupervisor(root, { recordsRoot: temp });
  const id = 'run-2026-10-12T00-00-00-000Z-abcdef';
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(temp, id));
  await writeFile(path.join(temp, id, 'run.json'), JSON.stringify({ id, provider: 'prime-agent', status: 'stopped' }));
  await assert.rejects(supervisor.resume(id), /only a live paused session/);
  assert.equal(supervisor.active.size, 0);
});

test('Prime token totals are displayed without inventing context or billing data', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-prime-tokens-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const usage = { input_tokens: 200, cached_input_tokens: 50, output_tokens: 20, total_tokens: 220 };
  await writeFile(path.join(temp, 'run.json'), JSON.stringify({ provider: 'prime-agent', usage }));
  const telemetry = await new TokenTelemetry().read(temp);
  assert.deepEqual(telemetry.totals, usage);
  assert.equal(telemetry.current_tokens, null);
  assert.equal(telemetry.compaction_threshold, null);
  assert.equal(telemetry.api_estimate.usd, null);
});
