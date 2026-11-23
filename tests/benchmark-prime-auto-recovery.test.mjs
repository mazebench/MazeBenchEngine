import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PrimeAutoRecovery, primeFailureKind, RETRY_DELAYS } from '../benchmarking/prime-auto-recovery.mjs';
import { recoveryPresentation } from '../benchmarking/ui/auto-recovery.mjs';
import { runCardValues } from '../benchmarking/ui/run-library.mjs';

const id = 'run-2026-10-23T00-00-00-000Z-aaaaaa';
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maze-auto-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'records', id), home = path.join(root, 'private', id);
  await mkdir(directory, { recursive: true }); await mkdir(home, { recursive: true });
  let time = 1000000, resumes = 0, verifications = 0;
  const read = async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
  const update = async (name, patch) => writeFile(path.join(directory, name), JSON.stringify({ ...await read(name), ...patch }));
  await writeFile(path.join(directory, 'run.json'), JSON.stringify({ id, status: 'failed', error: 'fetch failed', provider: 'prime-agent',
    harness: 'prime-inference-direct-v1', model: 'fixture/model', effort: 'max', tools_enabled: false }));
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify({ game_status: 'playing', action_count: 10 }));
  await writeFile(path.join(directory, 'prompt.md'), 'The original prompt.');
  const conversation = { run_id: id, messages: [{ role: 'user', content: 'The original prompt.' }], usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 }, pending: null, inflight_tool: null };
  await writeFile(path.join(home, 'conversation.json'), JSON.stringify(conversation));
  const supervisor = { projectRoot: root, directStateRoot: path.join(root, 'private'), active: new Map(),
    runDirectory: value => { assert.equal(value, id); return directory; },
    verifyRunCapabilityBoundary: async () => { verifications++; },
    get: async () => ({ ...await read('run.json'), ...await read('summary.json'), runner_active: supervisor.active.has(id) }),
    resume: async () => { resumes++; supervisor.active.set(id, {}); await update('run.json', { status: 'running', error: null }); return supervisor.get(); },
    pause: async () => { supervisor.active.delete(id); await update('run.json', { status: 'paused' }); return supervisor.get(); },
    stop: async () => { supervisor.active.delete(id); await update('run.json', { status: 'stopped' }); return supervisor.get(); },
    delete: async () => { supervisor.active.delete(id); await rm(home, { recursive: true }); return { deleted: id }; } };
  const controller = new PrimeAutoRecovery(supervisor, { now: () => time, delays: [10, 20, 30], ...options });
  t.after(() => controller.close()); await controller.ready;
  return { root, directory, home, read, update, supervisor, controller, advance: ms => { time += ms; },
    resumes: () => resumes, verifications: () => verifications,
    fail: async (error = 'fetch failed') => { supervisor.active.delete(id); await update('run.json', { status: 'failed', error }); } };
}

test('only enrolled runs retry, with backoff and an intact conversation/checkpoint', async t => {
  const f = await fixture(t), c = f.controller;
  const bytes = await readFile(path.join(f.home, 'conversation.json'));
  await c.tick(); assert.equal(f.resumes(), 0); assert.equal(c.status(id), null);
  await c.enroll(id); await c.tick();
  assert.equal(c.status(id).state, 'waiting'); assert.equal(f.resumes(), 0);
  f.advance(9); await c.tick(); assert.equal(f.resumes(), 0);
  f.advance(1); await Promise.all([c.tick(), c.tick(), c.tick()]);
  assert.equal(f.resumes(), 1); assert.equal(f.verifications(), 1); assert.equal(c.status(id).attempts, 1);
  assert((await readFile(path.join(f.home, 'conversation.json'))).equals(bytes));
  assert.equal((await f.read('summary.json')).action_count, 10);
  await f.fail('Prime inference returned HTTP 503.'); await c.tick();
  f.advance(19); await c.tick(); assert.equal(f.resumes(), 1);
  f.advance(1); await c.tick(); assert.equal(f.resumes(), 2);
  await f.update('summary.json', { action_count: 11 }); await c.tick(); assert.equal(c.status(id).attempts, 0);
  assert.equal(c.status(id).total_retries, 2);
});

test('retries stop without progress and also have an hourly ceiling despite progress', async t => {
  for (const maxPerHour of [12, 2]) {
    const f = await fixture(t, { maxPerHour }), c = f.controller;
    await c.enroll(id);
    for (let n = 0; n < 3; n++) {
      if (maxPerHour === 2) await f.update('summary.json', { action_count: 11 + n });
      await f.fail(); await c.tick(); f.advance(30); await c.tick();
    }
    await f.fail(); await c.tick();
    assert.equal(c.status(id).state, 'blocked'); assert.equal(c.status(id).enabled, false);
    assert.equal(f.resumes(), maxPerHour === 2 ? 2 : 3);
    f.advance(100000); await c.tick(); assert.equal(f.resumes(), maxPerHour === 2 ? 2 : 3);
  }
});

test('manual pause/stop cancels scheduled recovery; resume re-enables it; delete removes it', async t => {
  for (const action of ['pause', 'stop']) {
    const f = await fixture(t), c = f.controller;
    await c.enroll(id); await c.tick(); await c.command(id, action);
    f.advance(100); await c.tick(); assert.equal(f.resumes(), 0); assert.equal(c.status(id).enabled, false);
    assert.equal((await f.read('run.json')).status, action === 'pause' ? 'paused' : 'stopped');
    await c.command(id, 'resume'); assert.equal(f.resumes(), 1); assert.equal(c.status(id).enabled, true);
    await c.command(id, 'stop'); await c.command(id, 'delete');
    assert.equal(c.status(id), null); await c.tick(); assert.equal(f.resumes(), 1);
  }
});

test('pause during verification cancels recovery before it starts a runner', async t => {
  const f = await fixture(t), c = f.controller;
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.supervisor.verifyRunCapabilityBoundary = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  await c.enroll(id); await c.tick(); f.advance(10);
  const tick = c.tick(); await started;
  const pause = c.command(id, 'pause'); await Promise.resolve(); release();
  await Promise.all([tick, pause]); assert.equal(f.resumes(), 0); assert.equal(c.status(id).enabled, false);
  assert.equal((await f.read('run.json')).status, 'paused');
});

test('restart preserves retry deadlines, limits and intentional pauses', async t => {
  const f = await fixture(t), c = f.controller;
  await c.enroll(id); await c.tick(); const before = c.status(id); await c.close();
  const restart = new PrimeAutoRecovery(f.supervisor, { now: () => 1000005, delays: [10, 20, 30] });
  t.after(() => restart.close()); await restart.ready; await restart.tick();
  assert.deepEqual(restart.status(id), before); assert.equal(f.resumes(), 0);
  await restart.command(id, 'pause'); await restart.close();
  const paused = new PrimeAutoRecovery(f.supervisor, { now: () => 2000000 });
  t.after(() => paused.close()); await paused.ready; await paused.tick();
  assert.equal(paused.status(id).enabled, false); assert.equal(f.resumes(), 0);
});

test('terminal games, changed conditions, auth errors, unknown 422s and ambiguous tools never restart', async t => {
  for (const problem of ['terminal', 'identity', 'auth', 'unknown-422', 'inflight', 'integrity', 'prompt']) {
    const f = await fixture(t), c = f.controller;
    await c.enroll(id);
    if (problem === 'terminal') await f.update('summary.json', { game_status: 'won' });
    if (problem === 'identity') await f.update('run.json', { effort: 'low' });
    if (problem === 'auth') await f.fail('Prime inference returned HTTP 401.');
    if (problem === 'unknown-422') await f.fail('Prime inference returned HTTP 422.');
    if (problem === 'integrity') f.supervisor.verifyRunCapabilityBoundary = async () => { throw new Error('Integrity changed'); };
    if (problem === 'prompt') await writeFile(path.join(f.directory, 'prompt.md'), 'Changed prompt');
    if (problem === 'inflight') {
      const file = path.join(f.home, 'conversation.json'), state = JSON.parse(await readFile(file));
      state.inflight_tool = { id: 'ambiguous' }; await writeFile(file, JSON.stringify(state));
    }
    await c.tick(); f.advance(100); await c.tick();
    assert.equal(f.resumes(), 0, problem); assert.equal(c.status(id).enabled, false, problem);
    assert.equal(c.status(id).state, problem === 'terminal' ? 'completed' : 'blocked', problem);
  }
});

test('interrupted owners recover only from saved enrolled sessions and manual resumes serialize', async t => {
  const f = await fixture(t), c = f.controller;
  await c.enroll(id); await f.update('run.json', { status: 'running', error: null });
  await c.tick(); f.advance(10); await c.tick(); assert.equal(f.resumes(), 1);
  await c.command(id, 'pause');
  const results = await Promise.allSettled([c.command(id, 'resume'), c.command(id, 'resume')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.resumes(), 2);
});

test('failure classification and UI expose recovery without treating permanent errors as transient', () => {
  assert.equal(RETRY_DELAYS.length, 8);
  for (const error of ['Prime inference returned HTTP 429 (output budget 8000).', 'Prime inference returned HTTP 503.', 'fetch failed', 'The operation was aborted due to timeout']) assert.equal(primeFailureKind(error), 'transient');
  assert.equal(primeFailureKind('Prime exhausted its output budget without a game tool call.'), 'idle');
  assert.equal(primeFailureKind('Prime inference returned HTTP 422 (output budget 8000).'), 'message-content');
  for (const error of ['Prime inference returned HTTP 400.', 'Prime inference returned HTTP 403.', 'Run stopped.', 'Invalid checkpoint']) assert.equal(primeFailureKind(error), null);
  const run = { id, model: 'qwen/qwen3.8-27b', status: 'failed', provider: 'prime-agent', auto_recovery: { managed: true, enabled: true, state: 'waiting', attempts: 2, max_attempts: 8, next_retry_at: '2026-10-24T04:00:00Z', reason: 'fetch failed' } };
  assert.match(recoveryPresentation(run).detail, /retry 3 of 8/);
  assert.equal(runCardValues(run).status, 'Auto-resuming'); assert.equal(runCardValues(run).statusTone, 'yellow');
});
