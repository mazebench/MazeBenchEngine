import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { recoverCodexResourceProbe, blockedResourceProbe, interruptedProbeCall, resourceProbeFailure } from '../benchmarking/recover-codex-resource-probe.mjs';
import { CodexVisionAutoRecovery } from '../benchmarking/codex-vision-auto-recovery.mjs';
import { createRunIntegrity } from '../benchmarking/v1/integrity.mjs';
import { writeDirectToolModelCatalog } from '../benchmarking/v1/supervisor.mjs';
import { visionRuntimeHashes, verifyVisionIntegrity } from '../benchmarking/vision/policy.mjs';
import { VisionRuntime } from '../benchmarking/vision/runtime.mjs';
const root = path.resolve(import.meta.dirname, '..'), id = 'run-2026-10-26T00-00-00-000Z-aaaaaa';
const error = 'Capability boundary violation: unexpected mcp_tool_call (list_mcp_resources). Run invalidated.';
const at = '2026-10-26T01:00:00.000Z', thread = '11111111-2222-4333-8444-555555555555';
const probe = () => ({ type: 'item.started', _received_at: at, item: { id: 'item_2', type: 'mcp_tool_call', server: 'codex', tool: 'list_mcp_resources', arguments: {}, status: 'in_progress', result: null, error: null } });
const call = () => ({ type: 'response_item', timestamp: at, payload: { type: 'function_call', name: 'list_mcp_resources', arguments: '{}', call_id: 'call_probe' } });
const hash = b => createHash('sha256').update(b).digest('hex');
const json = async p => JSON.parse(await readFile(p, 'utf8'));

test('only unfinished empty resource discovery is recoverable', () => {
  assert(blockedResourceProbe(probe())); assert(interruptedProbeCall(call(), probe())); assert(resourceProbeFailure(error));
  for (const change of [{ tool: 'read_mcp_resource' }, { tool: 'shell' }, { server: 'other' }, { arguments: { server: 'private' } }, { status: 'completed' }, { result: { resources: [] } }, { error: 'denied' }]) assert(!blockedResourceProbe({ ...probe(), item: { ...probe().item, ...change } }));
  assert(!blockedResourceProbe({ ...probe(), type: 'item.completed' }));
  assert(!interruptedProbeCall({ ...call(), timestamp: '2026-10-26T02:00:00Z' }, probe()));
  assert(!interruptedProbeCall({ ...call(), payload: { ...call().payload, name: 'read_mcp_resource' } }, probe()));
  assert(!resourceProbeFailure('Capability boundary violation: shell'));
});

async function signedFixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-probe-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = path.join(temp, id), codexHome = path.join(temp, 'codex'); await mkdir(directory); await mkdir(path.join(directory, 'agent-cwd'));
  const source = path.join(temp, 'models.json'); await writeFile(source, JSON.stringify({ models: [{ slug: 'fixture' }] }));
  const policy = { codex_executable: process.execPath, codex_sha256: hash(await readFile(process.execPath)), model_catalog: await writeDirectToolModelCatalog(directory, 'fixture', { sourcePath: source }) };
  const prompt = 'Play the vision maze.';
  const configuration = { storage_format: 'incremental-v1', world: 'main-world', observation_mode: 'vision', provider: 'codex', model: 'fixture', effort: 'max', tools_enabled: false,
    action_limit: null, start_room: 'HxI', effective_prompt_sha256: hash(prompt), vision_runtime: await visionRuntimeHashes(root), codex_policy: policy };
  const integrity = await createRunIntegrity(root, directory, configuration);
  const runtime = await VisionRuntime.create(root, directory, { incremental: true, startRoom: 'HxI' }); await runtime.apply('up');
  const metadata = { ...configuration, id, created_at: '2026-10-26T00:00:00.000Z', status: 'failed', error, codex_thread_id: thread, capability_policy: policy, integrity };
  await writeFile(path.join(directory, 'run.json'), JSON.stringify(metadata)); await writeFile(path.join(directory, 'prompt.md'), prompt);
  await writeFile(path.join(directory, 'integrity-violation.json'), JSON.stringify({ error }));
  await writeFile(path.join(directory, 'agent-events.jsonl'), JSON.stringify({ type: 'thread.started', thread_id: thread }) + '\n' + JSON.stringify(probe()) + '\n');
  const session = path.join(codexHome, 'sessions/2026/10/26', `rollout-fixture-${thread}.jsonl`); await mkdir(path.dirname(session), { recursive: true });
  const prefix = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'Original task' } }) + '\n';
  await writeFile(session, prefix + JSON.stringify(call()) + '\n');
  return { directory, codexHome, session, prefix, metadata, args: { root, directory, codexHome, apply: true, assertInactive: async () => {} } };
}

test('audited recovery truncates only the unexecuted call and preserves signed moves and history', async t => {
  const f = await signedFixture(t), files = ['integrity.json', 'checkpoint.json', 'game-state.json', 'summary.json', 'display.json', 'agent-events.jsonl', 'prompt.md'];
  const before = await Promise.all(files.map(file => readFile(path.join(f.directory, file))));
  const originalSession = await readFile(f.session);
  const dry = await recoverCodexResourceProbe({ ...f.args, apply: false }); assert.equal(dry.applied, false); assert((await readFile(f.session)).equals(originalSession));
  const result = await recoverCodexResourceProbe(f.args); assert.equal(result.applied, true); assert.equal(result.action_count, 1);
  assert.equal(await readFile(f.session, 'utf8'), f.prefix); assert((await readFile(path.join(result.backup, 'session.before.jsonl'))).equals(originalSession));
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(f.directory, file)))), before);
  const m = await json(path.join(f.directory, 'run.json')); assert.equal(m.codex_thread_id, thread); assert.equal(m.status, 'paused'); await verifyVisionIntegrity(root, f.directory, m);
  // A second occurrence may recover without silently accepting any other history.
  const second = probe(); second._received_at = '2026-10-26T02:00:00.000Z'; second.item.id = 'item_3';
  await appendFile(path.join(f.directory, 'agent-events.jsonl'), JSON.stringify(second) + '\n');
  const nextCall = call(); nextCall.timestamp = second._received_at; nextCall.payload.call_id = 'next_call'; await appendFile(f.session, JSON.stringify(nextCall) + '\n');
  await writeFile(path.join(f.directory, 'run.json'), JSON.stringify({ ...m, status: 'failed', error })); await writeFile(path.join(f.directory, 'integrity-violation.json'), JSON.stringify({ error }));
  await recoverCodexResourceProbe(f.args); assert.equal((await json(path.join(f.directory, 'run.json'))).resource_probe_recoveries.length, 2);
});

test('completed calls, changed game state and concurrent resume cannot be cleared', async t => {
  for (const kind of ['completed', 'checkpoint', 'active']) {
    const f = await signedFixture(t), original = await readFile(f.session);
    if (kind === 'completed') await appendFile(f.session, JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_probe', output: '{}' } }) + '\n');
    if (kind === 'checkpoint') await writeFile(path.join(f.directory, 'checkpoint.json'), '{}');
    const expectedSession = await readFile(f.session);
    await assert.rejects(recoverCodexResourceProbe({ ...f.args, ...(kind === 'active' ? { assertInactive: async () => { throw new Error('active'); } } : {}) }));
    assert((await readFile(f.session)).equals(expectedSession)); assert.equal((await json(path.join(f.directory, 'run.json'))).status, 'failed');
    assert.equal((await json(path.join(f.directory, 'integrity-violation.json'))).error, error); assert(original.length > 0);
  }
});

async function controllerFixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-auto-probe-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = path.join(temp, 'records', id); await mkdir(directory, { recursive: true });
  let time = Date.parse('2026-10-26T03:00:00Z'), resumes = 0, repairs = 0, runner = false;
  const metadata = { id, created_at: '2026-10-26T00:00:00Z', provider: 'codex', observation_mode: 'vision', model: 'fixture', codex_thread_id: thread, tools_enabled: false, status: 'failed', error };
  await writeFile(path.join(directory, 'run.json'), JSON.stringify(metadata)); await writeFile(path.join(directory, 'summary.json'), JSON.stringify({ action_count: 1 }));
  const update = async patch => { const m = await json(path.join(directory, 'run.json')); await writeFile(path.join(directory, 'run.json'), JSON.stringify({ ...m, ...patch })); };
  const options = { recordsRoot: path.join(temp, 'records'), stateRoot: path.join(temp, 'state'), now: () => time, delays: [10, 20],
    request: async (runId, action) => { assert.equal(runId, id); if (action === 'resume') { resumes++; runner = true; await update({ status: 'continuing', error: null }); } else if (action) { runner = false; await update({ status: action === 'pause' ? 'paused' : 'stopped' }); } return { ...await json(path.join(directory, 'run.json')), runner_active: runner }; },
    repair: async ({ assertInactive }) => { await assertInactive(await json(path.join(directory, 'run.json'))); repairs++; await update({ status: 'paused', error: null }); } };
  const c = new CodexVisionAutoRecovery(root, options); await c.ready; t.after(() => c.close());
  return { c, options, metadata, update, directory, advance: n => { time += n; }, resumes: () => resumes, repairs: () => repairs, fail: async () => { runner = false; await update({ status: 'failed', error }); } };
}

test('automatic recovery is serialized, bounded and respects operator pause across restart', async t => {
  const f = await controllerFixture(t), c = f.c;
  await c.tick(); assert.equal(c.status(id), null, 'Old failures must not be adopted.');
  await c.enroll(f.metadata); await c.tick(); assert.equal(c.status(id).state, 'waiting');
  f.advance(10); await Promise.all([c.tick(), c.tick()]); assert.equal(f.resumes(), 1); assert.equal(f.repairs(), 1);
  await f.fail(); await c.tick(); f.advance(20); await c.tick(); assert.equal(f.resumes(), 2);
  await f.fail(); await c.tick(); assert.equal(c.status(id).state, 'blocked');
  await c.command(id, 'pause'); assert.equal(c.status(id).enabled, false); await c.close();
  const restarted = new CodexVisionAutoRecovery(root, f.options); t.after(() => restarted.close()); await restarted.ready; await restarted.tick(); assert.equal(f.resumes(), 2); assert.equal(restarted.status(id).state, 'paused');
  await restarted.command(id, 'resume'); assert.equal(f.resumes(), 3);
});

test('pause cancels an in-progress recovery before an agent can start', async t => {
  const f = await controllerFixture(t); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.c.repair = async ({ assertInactive }) => { entered(); await new Promise(resolve => { release = resolve; }); await assertInactive(f.metadata); };
  await f.c.enroll(f.metadata); await f.c.tick(); f.advance(10); const tick = f.c.tick(); await ready;
  const pause = f.c.command(id, 'pause'); await Promise.resolve(); release(); await Promise.all([tick, pause]);
  assert.equal(f.resumes(), 0); assert.equal(f.c.status(id).state, 'paused'); assert.equal(f.c.status(id).enabled, false);
});
