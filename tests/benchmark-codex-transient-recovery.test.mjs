import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexTransientRecovery, transientCodexError } from '../benchmarking/codex-transient-recovery.mjs';

test('Codex retries only transient service failures, preserving identity and bounding repeated failures', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-transient-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'run-2026-10-26T00-00-00-000Z-abcdef', directory = path.join(root, id);
  await mkdir(directory);
  const file = path.join(directory, 'run.json');
  const initial = { id, status: 'failed', error: 'exceeded retry limit, last status: 429 Too Many Requests',
    model: 'gpt-6.1-terra', service_tier: 'fast', effort: 'max', tools_enabled: false, codex_thread_id: 'same-session' };
  await writeFile(file, JSON.stringify(initial));
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify({ action_count: 17, game_status: 'playing' }));
  let now = 0, verified = 0, resumed = 0;
  const read = async () => JSON.parse(await readFile(file, 'utf8'));
  const owner = { runDirectory: () => directory, verifyRunCapabilityBoundary: async () => { verified++; },
    resume: async () => { resumed++; const run = await read(); assert.equal(run.status, 'paused');
      assert.equal(run.codex_thread_id, initial.codex_thread_id); assert.equal(run.service_tier, 'fast');
      await writeFile(file, JSON.stringify({ ...run, status: 'running', error: null })); } };
  const recovery = new CodexTransientRecovery({ ownerRoot: root, active: new Map(), forRun: () => owner, now: () => now, delays: [10, 20] });
  await recovery.check(id); assert.equal((await read()).auto_recovery.state, 'waiting'); assert.equal(resumed, 0);
  now = 10; await recovery.check(id); assert.equal(resumed, 1); assert.equal(verified, 1);
  assert.equal((await read()).recoveries[0].action_count, 17);
  await writeFile(file, JSON.stringify({ ...await read(), status: 'failed', error: initial.error }));
  await recovery.check(id); now = 30; await recovery.check(id); assert.equal(resumed, 2);
  await writeFile(file, JSON.stringify({ ...await read(), status: 'failed', error: initial.error }));
  await recovery.check(id); assert.equal((await read()).auto_recovery.enabled, false); assert.equal(resumed, 2);
  for (const error of ['invalidated by unexpected tool', 'status: 403', 'model not found', 'authentication failed']) assert.equal(transientCodexError(error), false);
});

test('operator pauses and failed integrity checks never resume', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-transient-paused-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'run.json');
  const run = { status: 'paused', error: 'last status: 429', codex_thread_id: 'same-session', auto_recovery: { policy: 'codex-transient-service-v1', next_retry_at: new Date(0).toISOString(), last_progress: 0 } };
  await writeFile(file, JSON.stringify(run));
  await writeFile(path.join(root, 'summary.json'), JSON.stringify({ action_count: 0, game_status: 'playing' }));
  let resumed = false;
  const owner = { runDirectory: () => root, resume: async () => { resumed = true; }, verifyRunCapabilityBoundary: async () => { throw new Error('integrity mismatch'); } };
  const recovery = new CodexTransientRecovery({ ownerRoot: root, active: new Map(), forRun: () => owner });
  await recovery.check('fixture'); assert.equal(resumed, false);
  await writeFile(file, JSON.stringify({ ...run, status: 'failed' }));
  await assert.rejects(recovery.check('fixture'), /integrity mismatch/); assert.equal(resumed, false);
});
