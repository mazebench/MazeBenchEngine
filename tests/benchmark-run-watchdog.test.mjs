import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS, INTERVAL_MS, decide, checkRuns } from '../benchmarking/run-watchdog.mjs';
const run = (target, overrides = {}) => ({ id: target.id, provider: target.provider, model: target.model,
  effort: target.effort, tools_enabled: false, status: 'running', runner_active: true, game_status: 'playing', action_count: 10, ...overrides });
const now = Date.parse('2026-10-23T22:45:00Z');

test('external watchdog yields to built-in backoff, pause and retry limits', async () => {
  const target = TARGETS[0];
  for (const state of ['waiting', 'retrying', 'paused', 'blocked']) {
    const value = run(target, { status: 'failed', runner_active: false, auto_recovery: { managed: true, enabled: ['waiting', 'retrying'].includes(state), state, reason: 'Retry limit reached' } });
    const report = await checkRuns({ targets: [target], now, get: async () => value,
      resume: async () => assert.fail('The owning server controls recovery'), recover: async () => assert.fail('No external conversation edits') });
    assert.equal(report.runs[target.id].outcome, state === 'blocked' ? 'needs-attention' : state === 'paused' ? 'operator-paused' : 'recovering');
  }
});

test('watch list is the three remaining Python-off runs and Kimi is gated until 4:40 PM Boise', async () => {
  assert.equal(INTERVAL_MS, 900000); assert.equal(TARGETS.length, 3);
  assert.deepEqual(TARGETS.map(t => t.model), ['deepseek/deepseek-v4.1-flash-1017', 'qwen/qwen3.8-27b', 'k3.1-pro']);
  assert(!TARGETS.some(t => /nemotron|nvidia|muse-spark/.test(JSON.stringify(t))));
  const seen = [];
  const report = await checkRuns({ now: Date.parse('2026-10-23T22:39:59Z'), get: async id => {
    seen.push(id); return run(TARGETS.find(t => t.id === id));
  }, resume: async () => assert.fail('No failed runs') });
  assert.equal(seen.length, 2); assert.equal(report.runs[TARGETS[2].id].outcome, 'waiting');
  assert.equal(decide(TARGETS[2], run(TARGETS[2], { status: 'failed', runner_active: false }), Date.parse('2026-10-23T22:40:00Z')), 'resume');
});

test('failed runs resume once through their owner while finished and intentionally paused runs are untouched', async () => {
  const states = new Map(TARGETS.map((t, i) => [t.id, run(t, i === 0 ? { status: 'failed', runner_active: false }
    : i === 1 ? { status: 'completed', runner_active: false, game_status: 'won' }
    : i === 2 ? { status: 'paused', runner_active: false } : {})]));
  const resumed = [], requested = [];
  const report = await checkRuns({ now, get: async id => { requested.push(id); return states.get(id); }, resume: async id => {
    resumed.push(id); states.set(id, { ...states.get(id), status: 'running', runner_active: true });
  }, wait: async () => {} });
  assert.deepEqual(resumed, [TARGETS[0].id]);
  assert.equal(report.runs[TARGETS[0].id].outcome, 'running');
  assert.equal(report.runs[TARGETS[1].id].outcome, 'finished');
  assert.equal(report.runs[TARGETS[2].id].outcome, 'operator-paused');
  assert.deepEqual(report.events.map(e => e.kind), ['resumed', 'finished']);
  requested.length = 0;
  const next = await checkRuns({ now: now + INTERVAL_MS, previous: report.runs,
    get: async id => { requested.push(id); return states.get(id); }, resume: async () => assert.fail('No retry needed') });
  assert(!requested.includes(TARGETS[1].id)); assert.equal(next.events.length, 0);
});

test('conditions cannot be silently changed and each failed check is isolated', async () => {
  let resumes = 0;
  const get = async id => {
    const t = TARGETS.find(t => t.id === id);
    if (id === TARGETS[0].id) throw new Error('Local server unavailable');
    if (id === TARGETS[1].id) return run(t, { tools_enabled: true, status: 'failed', runner_active: false });
    return run(t);
  };
  const first = await checkRuns({ now, get, resume: async () => resumes++ });
  assert.equal(first.events.length, 2); assert.equal(resumes, 0);
  assert.match(first.runs[TARGETS[1].id].error, /condition differs/);
  const next = await checkRuns({ now: now + INTERVAL_MS, previous: first.runs, get, resume: async () => resumes++ });
  assert.equal(next.events.length, 0); assert.equal(resumes, 0);
});

test('an immediately recurring failure is reported and retried on the next check without rewriting the conversation', async () => {
  const target = TARGETS[0]; let attempts = 0;
  const get = async () => run(target, { status: 'failed', runner_active: false, error: 'Malformed provider response' });
  const options = { targets: [target], now, get, resume: async () => attempts++, wait: async () => {} };
  const first = await checkRuns(options);
  assert.equal(attempts, 1); assert.equal(first.runs[target.id].outcome, 'needs-attention');
  assert.equal(first.events[0].kind, 'needs-attention');
  const next = await checkRuns({ ...options, now: now + INTERVAL_MS, previous: first.runs });
  assert.equal(attempts, 2); assert.equal(next.runs[target.id].attempts, 2); assert.equal(next.events.length, 0);
});
