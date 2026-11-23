import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { CatalogSupervisor } from '../benchmarking/model-catalog/supervisor.mjs';
import { PROVIDER, cliPath, toolNames, verifyIntegrity, environment } from '../benchmarking/deepseek/policy.mjs';
import { previewBenchmarkPrompt } from '../benchmarking/prompt-preview.mjs';
import { providerName, runCompany } from '../benchmarking/ui/run-library.mjs';

const model = { id: 'deepseek-flash', provider: PROVIDER, efforts: ['none', 'low', 'high', 'max'], default_effort: 'high', deepseek_route: 'deepseek-official' };

test('DeepSeek launcher identity and prompt use the normal maze condition', async () => {
  const spec = { provider: PROVIDER, model: model.id, coding_mode: 'off', action_limit: 1 };
  const actual = await previewBenchmarkPrompt(process.cwd(), spec);
  const base = await previewBenchmarkPrompt(process.cwd(), { ...spec, provider: 'codex' });
  assert.equal(actual.prompt, base.prompt);
  assert.equal(providerName(PROVIDER), 'DeepSeek Harness');
  assert.equal(runCompany({ provider: PROVIDER }), 'DeepSeek');
  await assert.rejects(previewBenchmarkPrompt(process.cwd(), { ...spec, coding_mode: 'any' }), /Python only/);
  assert.equal(environment('/private/fixture').NODE_OPTIONS, undefined);
});

test('DeepSeek signed launch, MCP tools, resume and profile verification', { skip: !existsSync(cliPath()), timeout: 90000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-deepseek-launch-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const owner = new CatalogSupervisor(process.cwd(), { recordsRoot: path.join(temp, 'records'), ownerRoot: path.join(temp, 'owners'), deepseekStateRoot: path.join(temp, 'profiles'),
    deepseekAuthHome: path.join(temp, 'auth'), catalog: { selection: async () => model } });
  const supervisor = owner.runtimes.deepseek;
  supervisor.inspectDeepSeek = async () => ({ launch_ready: true });
  let launched;
  supervisor.startDeepSeek = (...args) => { launched = args; };
  const spec = { provider: PROVIDER, model: model.id, effort: 'high', action_limit: 3, coding_mode: 'off' };
  for (const invalid of [{ world: 'slotski' }, { observation_mode: 'vision' }, { coding_mode: 'any' }, { effort: 'ultra' }]) {
    await assert.rejects(supervisor.validateSpec({ ...spec, ...invalid }));
  }
  const run = await owner.launch(spec);
  assert.equal(run.provider, PROVIDER); assert.equal(run.capability_boundary_verified, true);
  const directory = launched[1], file = path.join(directory, 'run.json');
  assert.equal(owner.owns(directory), true);
  assert.equal(await owner.forRun(run.id), supervisor);
  let metadata = JSON.parse(await readFile(file, 'utf8'));
  const frozen = await verifyIntegrity(process.cwd(), directory, metadata);
  const child = spawn(process.execPath, ['benchmarking/deepseek/mcp.mjs'], { cwd: process.cwd(),
    env: { PATH: '/usr/bin:/bin', MAZEBENCH_PROJECT_ROOT: process.cwd(), MAZEBENCH_RUN_DIRECTORY: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n' +
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'maze_observe', arguments: {} } }) + '\n');
  assert.equal(await new Promise(resolve => child.on('close', resolve)), 0, errors);
  const replies = output.trim().split('\n').map(JSON.parse);
  assert.deepEqual(replies[0].result.tools.map(tool => tool.name), toolNames(false));
  assert(replies[1].result.content.length);
  const checkpoint = await readFile(path.join(directory, 'checkpoint.json'));
  Object.assign(metadata, { status: 'paused', deepseek_session_id: 'session-00000000-0000-0000-0000-000000000000' });
  await writeFile(file, JSON.stringify(metadata));
  await owner.resume(run.id);
  assert.match(launched[2], /Continue the same MazeBench run/);
  metadata = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(metadata.deepseek_session_id, 'session-00000000-0000-0000-0000-000000000000');
  assert.deepEqual(await readFile(path.join(directory, 'checkpoint.json')), checkpoint);
  const profile = path.join(frozen.deepseek_home, 'profiles/headless/cordis.patch.yml');
  await chmod(profile, 0o600); await writeFile(profile, '[]');
  await assert.rejects(verifyIntegrity(process.cwd(), directory, metadata), /profile changed/);
});
