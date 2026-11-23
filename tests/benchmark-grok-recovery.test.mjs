import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createGrokBoundaryValidator } from '../benchmarking/grok-vision-resume-policy.mjs';
import { GrokVisionAutoRecovery, grokRetryResult } from '../benchmarking/grok-vision-auto-recovery.mjs';
import { adoptGrokVisionResume, GROK_CATALOG_ERROR } from '../benchmarking/grok-vision-resume.mjs';
import { createRunIntegrity } from '../benchmarking/v1/integrity.mjs';
import { VisionRuntime } from '../benchmarking/vision/runtime.mjs';
import { POLICY, providerVisionHashes, verifyProviderVisionIntegrity } from '../benchmarking/vision-providers/policy.mjs';
import { digest, grokModelsPolicyDigest, grokSettingsPolicyDigest, setGrokConfigImmutable } from '../benchmarking/grok/policy.mjs';
const root = path.resolve(import.meta.dirname, '..'), id = 'run-2026-10-26T00-00-00-000Z-cccccc';
const parent = '11111111-2222-4333-8444-555555555555';
const init = cwd => ({ type: 'system', subtype: 'init', tools: ['search_tool', 'use_tool', 'mazebench__maze_observe', 'mazebench__maze_action', 'mazebench__maze_sequence'],
  session_id: randomUUID(), model: 'grok-4.7', apiKeySource: 'oauth', permissionMode: 'dontAsk', cwd, slash_commands: [], skills: [], mcp_servers: [{ name: 'mazebench', status: 'connected' }], _received_at: '2026-10-26T01:00:00Z' });
const failure = (session = parent, code = 400) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session,
  errors: ['Internal error: ' + JSON.stringify({ http_status: code, message: `API error (status ${code} Bad Request): Request failed (HTTP ${code}).` })] });
const json = async file => JSON.parse(await readFile(file, 'utf8'));

test('Grok resumed catalog permits only existing maze keys and retains all invocation checks', () => {
  const event = init(root), validate = createGrokBoundaryValidator({ model: 'grok-4.7', toolsEnabled: false, cwd: root, resuming: true });
  const original = structuredClone(event); assert.equal(validate(event), null); assert.deepEqual(event, original);
  for (const extra of ['run_terminal_command', 'web_search', 'mazebench__python_exec', 'personal__read']) {
    const check = createGrokBoundaryValidator({ model: 'grok-4.7', toolsEnabled: false, cwd: root, resuming: true });
    assert(check({ ...event, tools: [...event.tools, extra] }));
  }
  const call = name => ({ type: 'assistant', session_id: event.session_id, message: { model: 'grok-4.7', role: 'assistant', content: [{ type: 'tool_use', id: 'call1', name, input: {} }] } });
  assert.match(validate(call('mazebench__maze_action')), /forbidden tool/);
  assert.match(validate(call('run_terminal_command')), /forbidden tool/);
  const check = createGrokBoundaryValidator({ model: 'grok-4.7', toolsEnabled: false, cwd: root, resuming: true });
  assert.match(check({ ...event, model: 'other' }), /model routing changed/);
});

test('Grok execution retries require the matching provider result and a bounded HTTP error', () => {
  assert(grokRetryResult(failure(), parent));
  for (const code of [401, 403, 404]) assert(!grokRetryResult(failure(parent, code), parent));
  assert(!grokRetryResult(failure('different'), parent));
  assert(!grokRetryResult({ ...failure(), errors: ['Permission denied'] }, parent));
  assert(!grokRetryResult({ ...failure(), errors: ['Internal error: {"http_status":400,"message":"Blocked by policy"}'] }, parent));
});

test('Grok recovery preserves the run across forked CLI sessions, bounds retries and persists pause', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-grok-retry-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = path.join(temp, 'runs', id); await mkdir(directory, { recursive: true });
  let time = Date.parse('2026-10-26T03:00:00Z'), resumes = 0, runner = false;
  let run = { id, provider: 'grok-build', world: 'main-world', observation_mode: 'vision', tools_enabled: false, coding_mode: 'off', model: 'grok-4.7', effort: 'xhigh', grok_session_id: parent, status: 'failed', error: 'error_during_execution', created_at: '2026-10-26T00:00:00Z' };
  const save = async () => writeFile(path.join(directory, 'run.json'), JSON.stringify(run)); await save();
  await writeFile(path.join(directory, 'summary.json'), '{"action_count":4405,"game_status":"playing"}');
  const fail = async () => { runner = false; run.status = 'failed'; run.error = 'error_during_execution'; await save(); await writeFile(path.join(directory, 'grok-events.jsonl'), JSON.stringify(failure(run.grok_session_id)) + '\n'); }; await fail();
  const options = { recordsRoot: path.join(temp, 'runs'), stateRoot: path.join(temp, 'state'), now: () => time, delays: [10, 20], owner: { active: new Map() },
    adopt: async ({ assertInactive }) => { await assertInactive(run); run.status = 'paused'; await save(); },
    request: async (_id, action) => { if (action === 'resume') { resumes++; runner = true; run.grok_session_id = randomUUID(); run.status = 'continuing'; run.error = null; await save(); }
      return { ...run, runner_active: runner }; } };
  const c = new GrokVisionAutoRecovery(root, options); await c.ready; t.after(() => c.close());
  await c.command(id, 'resume'); assert.equal(resumes, 1);
  c.owner.active.set(id, {});
  assert.equal(c.decorate({ id, status: 'interrupted', runner_active: false }).runner_active, true);
  assert.equal(c.decorate({ id, status: 'interrupted', runner_active: false }).status, 'continuing');
  c.owner.active.delete(id);
  await c.tick(); assert.equal(c.status(id).state, 'watching', 'A recorded conversation fork must not disable recovery.');
  for (const delay of [10, 20]) { await fail(); await c.tick(); time += delay; await Promise.all([c.tick(), c.tick()]); }
  assert.equal(resumes, 3); await fail(); await c.tick(); assert.equal(c.status(id).state, 'blocked');
  await c.command(id, 'pause'); await c.close();
  const next = new GrokVisionAutoRecovery(root, options); await next.ready; t.after(() => next.close()); await next.tick();
  assert.equal(next.status(id).enabled, false); assert.equal(resumes, 3);
});

test('Grok audited compatibility adoption keeps the checkpoint and every original runtime hash', { skip: process.platform !== 'darwin' }, async t => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maze-grok-adopt-')));
  const directory = path.join(temp, id), home = path.join(temp, 'grok'); await mkdir(path.join(directory, 'agent-cwd'), { recursive: true }); await mkdir(home);
  const config = path.join(home, 'config.toml'); await writeFile(config, '# immutable fixture\n'); setGrokConfigImmutable(config);
  t.after(async () => { setGrokConfigImmutable(config, false); await rm(temp, { recursive: true, force: true }); });
  const catalog = path.join(home, 'sessions', encodeURIComponent(path.join(directory, 'agent-cwd')), parent, 'tool_definitions.json'); await mkdir(path.dirname(catalog), { recursive: true });
  await writeFile(catalog, JSON.stringify(['search_tool', 'use_tool'].map(name => ({ function: { name } }))));
  const models = '{}', settings = '{"payload":"{}"}'; await writeFile(path.join(home, 'models_cache.json'), models); await writeFile(path.join(home, 'settings_cache.json'), settings);
  const prompt = 'Play the vision maze.', capability = { name: POLICY, version: 4, tools: 'maze-only' };
  const configuration = { storage_format: 'incremental-v1', world: 'main-world', observation_mode: 'vision', provider: 'grok-build', model: 'grok-4.7', effort: 'xhigh', tools_enabled: false, coding_mode: 'off', start_room: 'HxI', action_limit: null,
    capability_policy: capability, effective_prompt_sha256: digest(prompt), vision_provider_policy: POLICY, vision_provider_runtime: await providerVisionHashes(root), grok_version: '1.0.41', grok_executable: process.execPath, grok_sha256: digest(await readFile(process.execPath)),
    grok_home: home, immutable_config: { [config]: digest(await readFile(config)) }, grok_models_policy_sha256: grokModelsPolicyDigest(models), grok_settings_policy_sha256: grokSettingsPolicyDigest(settings) };
  const integrity = await createRunIntegrity(root, directory, configuration); await VisionRuntime.create(root, directory, { startRoom: 'HxI', incremental: true });
  const metadata = { ...configuration, id, integrity, grok_session_id: parent, status: 'failed', error: GROK_CATALOG_ERROR };
  await writeFile(path.join(directory, 'run.json'), JSON.stringify(metadata)); await writeFile(path.join(directory, 'prompt.md'), prompt);
  const event = init(path.join(directory, 'agent-cwd')); await writeFile(path.join(directory, 'grok-events.jsonl'), JSON.stringify(event) + '\n');
  await writeFile(path.join(directory, 'integrity-violation.json'), JSON.stringify({ error: GROK_CATALOG_ERROR, at: event._received_at }));
  const checkpoint = await readFile(path.join(directory, 'checkpoint.json')), manifest = await json(path.join(directory, 'integrity.json'));
  await adoptGrokVisionResume({ root, directory, assertInactive: async () => {} });
  const result = await json(path.join(directory, 'run.json')), updated = await json(path.join(directory, 'integrity.json'));
  assert.deepEqual(await readFile(path.join(directory, 'checkpoint.json')), checkpoint); assert.deepEqual(updated.files, manifest.files);
  assert.deepEqual(updated.configuration.vision_provider_runtime, manifest.configuration.vision_provider_runtime);
  assert.equal(result.grok_session_id, parent); assert.equal(result.runtime_repairs.length, 1);
  await verifyProviderVisionIntegrity(root, directory, result);
});
