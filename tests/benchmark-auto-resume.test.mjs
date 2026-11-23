import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AutoResume } from '../benchmarking/auto-resume.mjs';
import { failurePolicy } from '../benchmarking/auto-resume-policy.mjs';
import { prepareNormalResume } from '../benchmarking/auto-resume-owner.mjs';
import { recoveryPresentation } from '../benchmarking/ui/auto-recovery.mjs';
import { REJECTED_MCP_REPAIR, REJECTED_MCP_ERROR } from '../benchmarking/recover-antigravity-rejected-call.mjs';
import { STARTUP_REPAIR, STARTUP_ERROR } from '../benchmarking/recover-antigravity-startup.mjs';
const id = 'run-2026-11-05T00-00-00-000Z-aaaaaa';
const network = 'error: There was a network issue connecting to the server, please try again.\nAGY_ERROR: {"short_error":"read: operation timed out","retryable":true}';
async function fixture(t, override = {}) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'maze-auto-resume-')); t.after(() => rm(stateRoot, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-05T00:00:00Z');
  const run = { id, provider: 'deepseek-harness', model: 'gpt-6.1-terra', world: 'main-world', observation_mode: 'ascii', coding_mode: 'off', tools_enabled: false,
    status: 'running', runner_active: true, action_count: 10, capability_boundary_verified: true, created_at: new Date(clock).toISOString(), ...override };
  const calls = [];
  const options = { stateRoot, list: async () => [structuredClone(run)], get: async () => structuredClone(run), now: () => clock,
    delays: [10, 20, 30], orphanGrace: 10, maxPerHour: 100,
    command: async (runId, action) => { calls.push([runId, action]); Object.assign(run, { status: action === 'resume' ? 'running' : action === 'pause' ? 'paused' : 'stopped', runner_active: action === 'resume', error: null }); return structuredClone(run); } };
  const recovery = new AutoResume(options); await recovery.ready; t.after(() => recovery.close());
  return { recovery, run, calls, options, advance: (ms = 50) => { clock += ms; }, fail: (error = network) => Object.assign(run, { status: 'failed', runner_active: false, error }) };
}
test('transient classification recognizes provider-neutral errors and respects hard failures/reset times', () => {
  for (const error of [network, 'HTTP 429', 'Error code: 503', 'Selected model is at capacity. Please try a different model.', 'fetch failed', 'socket hang up', 'DeepSeek Harness provider turn failed.', 'stream ended before response.completed', 'rate_limit_exceeded']) assert.equal(failurePolicy(error).kind, 'transient', error);
  for (const error of ['invalid API key', 'HTTP 401', 'HTTP 403', 'insufficient_quota', 'credit balance is too low', 'integrity violation', 'No resumable session.', 'unsupported model', 'HTTP 400 invalid request']) assert.equal(failurePolicy(error).kind, 'blocked', error);
  const now = Date.parse('2026-11-05T00:00:00Z');
  assert.equal(failurePolicy('HTTP 429 retry-after: 30', now).retryAt, now + 30000);
  assert.equal(failurePolicy('Usage limit reached. Resets at 2026-11-05T01:00:00Z', now).retryAt, now + 3600000);
});
test('all agent types and observation/coding conditions receive normal resume', async t => {
  const f = await fixture(t);
  for (const provider of ['codex', 'claude-code', 'antigravity', 'deepseek-harness', 'grok-build', 'kimi-code', 'muse-code', 'prime-agent', 'future-agent']) {
    for (const observation_mode of ['ascii', 'vision']) for (const coding_mode of ['off', 'python', 'any']) {
      Object.assign(f.run, { provider, observation_mode, coding_mode, tools_enabled: coding_mode !== 'off', status: 'running', runner_active: true });
      await f.recovery.enroll(f.run, { explicit: true }); f.fail();
      await f.recovery.tick(); assert.equal(f.recovery.status(id).state, 'waiting');
      f.advance(); await f.recovery.tick(); assert.equal(f.calls.at(-1)[1], 'resume'); assert.equal(f.run.status, 'running');
    }
  }
  assert.equal(f.calls.length, 54);
});
test('transient outages keep backing off beyond the old retry ceiling and persist across supervisor restart', async t => {
  const f = await fixture(t); await f.recovery.tick();
  for (let n = 0; n < 9; n++) { f.fail('HTTP 503 temporarily unavailable'); await f.recovery.tick(); f.advance(); await f.recovery.tick(); }
  assert.equal(f.calls.length, 9); assert.equal(f.recovery.status(id).enabled, true);
  f.fail(); await f.recovery.tick(); const scheduled = f.recovery.status(id).next_retry_at; await f.recovery.close();
  const restarted = new AutoResume(f.options); t.after(() => restarted.close()); await restarted.ready;
  assert.equal(restarted.status(id).next_retry_at, scheduled); await restarted.tick(); assert.equal(f.calls.length, 9);
  f.advance(); await restarted.tick(); assert.equal(f.calls.length, 10);
});
test('newly discovered provider reset postpones a pending retry without extending relative retry-after forever', async t => {
  const f = await fixture(t, { provider: 'claude-code' }); await f.recovery.tick();
  f.fail('Claude reported usage for a different model.'); await f.recovery.tick();
  f.run.recovery_error = 'Claude usage limit reached; resets at 2026-11-05T01:00:00Z.';
  f.advance(); await f.recovery.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.recovery.status(id).next_retry_at, '2026-11-05T01:00:00.000Z');
  f.advance(3600000); await f.recovery.tick(); assert.equal(f.calls.length, 1);
  delete f.run.recovery_error; f.fail('HTTP 429 retry-after: 30'); await f.recovery.tick();
  const retry = f.recovery.status(id).next_retry_at;
  f.advance(15000); await f.recovery.tick(); assert.equal(f.recovery.status(id).next_retry_at, retry);
  f.advance(15000); await f.recovery.tick(); assert.equal(f.calls.length, 2);
});
test('intentional pause/stop/delete, completed runs, and old failures are never automatically restarted', async t => {
  const f = await fixture(t); await f.recovery.tick(); f.fail(); await f.recovery.tick();
  await f.recovery.command(id, 'pause'); f.advance(); await f.recovery.tick(); assert.deepEqual(f.calls.map(x => x[1]), ['pause']); assert.equal(f.recovery.decorate(f.run).status, 'paused');
  await f.recovery.command(id, 'resume'); assert.equal(f.run.runner_active, true);
  await f.recovery.command(id, 'stop'); f.advance(); await f.recovery.tick(); assert.equal(f.calls.length, 3);
  await f.recovery.command(id, 'resume'); f.run.status = 'completed'; f.run.runner_active = false; await f.recovery.tick(); assert.equal(f.recovery.status(id).state, 'completed');
  const old = await fixture(t, { status: 'failed', runner_active: false, created_at: '2025-01-01T00:00:00Z', error: network }); await old.recovery.tick(); assert.equal(old.recovery.records.size, 0);
});
test('pause racing an automatic resume cancels future retries and pauses the newly started runner', async t => {
  const f = await fixture(t); await f.recovery.tick(); f.fail(); await f.recovery.tick(); f.advance();
  let entered, release; const pending = new Promise(r => { entered = r; }); const finish = new Promise(r => { release = r; });
  const dispatch = f.recovery.dispatch; f.recovery.dispatch = async (...args) => { if (args[1] === 'resume') { entered(); await finish; } return dispatch(...args); };
  const ticking = f.recovery.tick(); await pending; const pausing = f.recovery.command(id, 'pause'); release(); await Promise.all([ticking, pausing]);
  assert.deepEqual(f.calls.map(x => x[1]), ['resume', 'pause']); assert.equal(f.run.status, 'paused'); assert.equal(f.recovery.status(id).enabled, false);
});
test('unrecognized failures stop after three no-progress attempts; credentials and integrity fail closed', async t => {
  const f = await fixture(t); await f.recovery.tick();
  for (let n = 0; n < 3; n++) { f.fail('Unexpected opaque provider failure'); await f.recovery.tick(); f.advance(); await f.recovery.tick(); }
  f.fail('Unexpected opaque provider failure'); await f.recovery.tick(); assert.equal(f.recovery.status(id).state, 'blocked'); assert.equal(f.calls.length, 3);
  await f.recovery.enroll(f.run, { explicit: true }); f.fail('Invalid API key'); await f.recovery.tick(); assert.equal(f.recovery.status(id).state, 'blocked');
  await f.recovery.enroll(f.run, { explicit: true }); f.fail(); f.run.capability_boundary_verified = false; await f.recovery.tick(); assert.equal(f.calls.length, 3);
});
test('audited rejected-call candidates recover automatically but stop after three attempts without progress', async t => {
  const f = await fixture(t, { provider: 'antigravity', model: 'gemini-4-argon-high' }); await f.recovery.tick();
  let repaired = 0;
  f.recovery.prepare = async run => { assert.equal(run.recovery_repair, REJECTED_MCP_REPAIR); repaired++; };
  for (let n = 0; n < 3; n++) {
    f.fail(REJECTED_MCP_ERROR); Object.assign(f.run, { capability_boundary_verified: false, recovery_repair: REJECTED_MCP_REPAIR,
      recovery_error: 'Antigravity rejected a misplaced MCP routing field before execution; audited same-session recovery is available.' });
    await f.recovery.tick(); assert.equal(f.recovery.status(id).state, 'waiting'); f.advance(); await f.recovery.tick();
  }
  f.fail(REJECTED_MCP_ERROR); await f.recovery.tick();
  assert.equal(repaired, 3); assert.equal(f.calls.length, 3); assert.equal(f.recovery.status(id).state, 'blocked');
});
test('zero-work startup failures use audited recovery and bound ambiguous authentication retries', async t => {
  const f = await fixture(t, { provider: 'antigravity', model: 'gemini-4-carbon-high' }); await f.recovery.tick();
  let repairs = 0;
  f.recovery.prepare = async run => { assert.equal(run.recovery_repair, STARTUP_REPAIR); repairs++; };
  for (let n = 0; n < 3; n++) {
    f.fail(STARTUP_ERROR); Object.assign(f.run, { capability_boundary_verified: false, recovery_repair: STARTUP_REPAIR,
      recovery_error: 'Provider startup failed before initialization; no model or tool activity occurred.' });
    await f.recovery.tick(); assert.equal(f.recovery.status(id).state, 'waiting'); f.advance(); await f.recovery.tick();
  }
  f.fail(STARTUP_ERROR); await f.recovery.tick();
  assert.equal(repairs, 3); assert.equal(f.calls.length, 3); assert.equal(f.recovery.status(id).state, 'blocked');
});
test('a failed rejected-call audit cannot dispatch resume or downgrade another integrity error', async t => {
  const f = await fixture(t, { provider: 'antigravity' }); await f.recovery.tick(); f.fail(REJECTED_MCP_ERROR);
  Object.assign(f.run, { capability_boundary_verified: false, recovery_repair: REJECTED_MCP_REPAIR, recovery_error: 'Rejected routing fields before execution.' });
  f.recovery.prepare = async () => { throw new Error('Integrity recovery refused: previous forbidden tool'); };
  await f.recovery.tick(); f.advance(); await f.recovery.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.recovery.status(id).state, 'blocked');
  await f.recovery.enroll(f.run, { explicit: true }); f.fail('Forbidden Antigravity tool: run_command.');
  await f.recovery.tick(); assert.equal(f.recovery.status(id).state, 'blocked'); assert.equal(f.calls.length, 0);
});
test('operator pause during explicit repair prevents resume dispatch', async t => {
  const f = await fixture(t); await f.recovery.tick(); f.fail();
  let entered, release; const pending = new Promise(r => { entered = r; }); const finish = new Promise(r => { release = r; });
  f.recovery.prepare = async () => { entered(); await finish; };
  const resuming = f.recovery.command(id, 'resume'); await pending;
  const pausing = f.recovery.command(id, 'pause'); release(); await Promise.all([resuming, pausing]);
  assert.deepEqual(f.calls.map(c => c[1]), ['pause']); assert.equal(f.recovery.status(id).enabled, false);
});
test('orphan grace, persisted intent, progress reset, and specialized repairs coexist', async t => {
  const f = await fixture(t); await f.recovery.tick(); f.run.runner_active = false; f.run.status = 'interrupted';
  await f.recovery.tick(); assert.equal(f.calls.length, 0); f.advance(); await f.recovery.tick(); f.advance(); await f.recovery.tick(); assert.equal(f.calls.length, 1);
  f.run.action_count++; await f.recovery.tick(); assert.equal(f.recovery.status(id).attempts, 0);
  f.fail(); f.run.auto_recovery = { enabled: true, state: 'retrying' }; await f.recovery.tick(); f.advance(); await f.recovery.tick(); assert.equal(f.calls.length, 1);
  f.run.auto_recovery = { enabled: false, state: 'blocked', reason: network }; await f.recovery.tick(); f.advance(); await f.recovery.tick(); assert.equal(f.calls.length, 2);
});
test('one slow owner does not prevent another provider from resuming', async t => {
  const f = await fixture(t); const other = { ...f.run, id: id.replace('aaaaaa', 'bbbbbb'), provider: 'claude-code' };
  f.recovery.list = async () => [f.run, other]; f.recovery.get = async key => structuredClone(key === id ? f.run : other);
  await f.recovery.tick(); f.fail(); Object.assign(other, { status: 'failed', runner_active: false, error: network }); await f.recovery.tick(); f.advance();
  let release; const blocked = new Promise(r => { release = r; }); const calls = [];
  f.recovery.dispatch = async key => { calls.push(key); if (key === id) await blocked; return key === id ? f.run : other; };
  const task = f.recovery.tick(); while (calls.length < 2) await new Promise(r => setImmediate(r)); assert(calls.includes(other.id)); release(); await task;
});
test('legacy lifecycle adapter preserves session/settings/checkpoint and refuses active/changed runs', async t => {
  const f = await fixture(t, { provider: 'codex', status: 'failed', runner_active: false, codex_thread_id: 'original-thread', error: network });
  const directory = path.join(f.options.stateRoot, 'record'); await mkdir(directory);
  await writeFile(path.join(directory, 'run.json'), JSON.stringify(f.run)); const checkpoint = JSON.stringify({ action_count: 10, game_status: 'playing' }); await writeFile(path.join(directory, 'summary.json'), checkpoint);
  assert.equal(await prepareNormalResume(f.run, { directory, get: f.options.get, allowed: () => true }), true);
  const changed = JSON.parse(await readFile(path.join(directory, 'run.json'))); assert.equal(changed.status, 'paused'); assert.equal(changed.codex_thread_id, 'original-thread'); assert.equal(changed.model, f.run.model); assert.equal(changed.recoveries[0].previous_error, network); assert.equal(await readFile(path.join(directory, 'summary.json'), 'utf8'), checkpoint);
  await writeFile(path.join(directory, 'run.json'), JSON.stringify(f.run)); f.run.runner_active = true;
  await assert.rejects(prepareNormalResume(f.run, { directory, get: f.options.get, allowed: () => true }), /active/);
});
test('unbounded transient retries display a real attempt number rather than of null', () => {
  const p = recoveryPresentation({ auto_recovery: { enabled: true, state: 'waiting', attempts: 12, max_attempts: null } });
  assert.match(p.detail, /Automatic retry 13/); assert.doesNotMatch(p.detail, /of null|of 0/);
});
test('orphan recovery never starts a duplicate while the previous model or MCP child is alive', async t => {
  const f = await fixture(t, { status: 'interrupted', runner_active: false });
  const directory = path.join(f.options.stateRoot, 'orphan'); await mkdir(directory);
  const metadata = JSON.stringify({ ...f.run, status: 'running', deepseek_session_id: 'saved-dsh-session' });
  await writeFile(path.join(directory, 'run.json'), metadata); await writeFile(path.join(directory, 'summary.json'), JSON.stringify({ action_count: 10, game_status: 'playing' }));
  await assert.rejects(prepareNormalResume(f.run, { directory, get: f.options.get, allowed: () => true, processes: async () => `123 node mcp --run ${id}` }), /original runner is still alive/);
  assert.equal(await readFile(path.join(directory, 'run.json'), 'utf8'), metadata);
  assert.equal(await prepareNormalResume(f.run, { directory, get: f.options.get, allowed: () => true, processes: async () => '' }), true);
});
test('progress made between polls resets the retry streak even if the next snapshot is already failed', async t => {
  const f = await fixture(t); await f.recovery.tick();
  for (let n = 0; n < 5; n++) {
    f.fail('Opaque provider error'); f.run.action_count++; await f.recovery.tick(); f.advance(); await f.recovery.tick();
  }
  assert.equal(f.calls.length, 5); assert.equal(f.recovery.status(id).enabled, true);
});

test('Claude usage recovery preserves progress and tracks subsequent actions', async t => {
  const f = await fixture(t, { provider: 'claude-code', model: 'claude-fable-5-2' });
  await f.recovery.tick();
  f.run.action_count = 100; await f.recovery.tick();
  f.fail('Claude reported usage for a different model.'); f.run.capability_boundary_verified = false;
  let repairs = 0;
  f.recovery.prepare = async () => { repairs++; f.run.capability_boundary_verified = true; };
  await f.recovery.tick(); f.advance(); await f.recovery.tick();
  assert.equal(repairs, 1); assert.equal(f.recovery.records.get(id).last_progress, 100);
  f.run.action_count = 101; await f.recovery.tick();
  assert.equal(f.recovery.records.get(id).attempts, 0);
});
