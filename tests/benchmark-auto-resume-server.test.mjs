import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAutoResumeServer } from '../benchmarking/auto-resume-server.mjs';
const id = 'run-2026-11-05T00-00-00-000Z-bbbbbb';
test('all-agent HTTP gateway enrolls launches, recovers a retryable outage, forwards pause to older controllers, and preserves request bodies', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'maze-auto-api-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now(); const calls = [];
  const run = { id, provider: 'antigravity', model: 'gemini-4-argon-high', status: 'running', runner_active: true, action_count: 12, created_at: new Date(now).toISOString(), capability_boundary_verified: true };
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; calls.push({ url: req.url, method: req.method, body });
    if (req.url.endsWith('/resume')) Object.assign(run, { status: 'running', runner_active: true, error: null });
    if (req.url.endsWith('/pause')) Object.assign(run, { status: 'paused', runner_active: false, auto_recovery: { enabled: false, state: 'paused' } });
    res.writeHead(req.method === 'POST' && req.url.endsWith('/runs') ? 202 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('view=library') ? { runs: [run] } : run));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r)); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const { server, recovery } = createAutoResumeServer({ port: 0, upstreamPort: upstream.address().port, stateRoot: directory,
    prepare: async () => false, recoveryOptions: { now: () => now, delays: [10], interval: 100000, cancel: async () => {} } });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(async () => { await recovery.close(); server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/benchmark/v1/runs`;
  const body = JSON.stringify({ provider: 'antigravity', model: 'gemini-4-argon-high', coding_mode: 'python', service_tier: 'standard' });
  const launch = await fetch(url, { method: 'POST', body }); assert.equal(launch.status, 202); assert.equal((await launch.json()).auto_recovery.policy, 'all-agents-normal-resume-v1');
  assert.equal(calls.find(c => c.method === 'POST').body, body);
  // The listening handler starts an immediate background scan. Let that scan
  // finish before injecting a failure and requesting the next explicit tick.
  const startupDeadline = Date.now() + 5000;
  while (recovery.ticking && Date.now() < startupDeadline) await new Promise(setImmediate);
  assert.equal(recovery.ticking, false);
  Object.assign(run, { status: 'failed', runner_active: false, error: 'network issue: operation timed out', auto_recovery: { enabled: false, state: 'blocked' } });
  await recovery.tick(); assert.equal(recovery.status(id).state, 'waiting'); now += 20; await recovery.tick(); assert.equal(run.runner_active, true);
  Object.assign(run, { status: 'failed', runner_active: false, auto_recovery: { enabled: true, state: 'waiting' } });
  const paused = await fetch(url + '/' + id + '/pause', { method: 'POST' }); assert.equal((await paused.json()).status, 'paused');
  assert.equal(calls.at(-1).url.endsWith('/pause'), true); now += 50; await recovery.tick(); assert.equal(run.runner_active, false);
  assert.equal((await fetch(url, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await (await fetch(url + '?view=library')).json()).runs[0].auto_recovery.enabled, false);
});
