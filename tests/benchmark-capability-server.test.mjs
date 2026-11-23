import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCapabilityServer } from '../benchmarking/capability-server.mjs';
import { POLICY } from '../benchmarking/all-code/policy.mjs';
import { POLICY as DIRECT_POLICY } from '../benchmarking/prime-direct/policy.mjs';
import { BenchmarkSupervisor } from '../benchmarking/prime-direct-v2/supervisor.mjs';
test('companion preserves existing run owner and dispatches new Any language runs separately', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maze-capabilities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const existing = 'run-2026-10-23T00-00-00-000Z-aaaaaa', added = 'run-2026-10-23T00-00-00-000Z-bbbbbb', direct = 'run-2026-10-23T00-00-00-000Z-cccccc';
  const calls = [], launches = [], stops = [];
  for (const [id, policy] of [[existing, 'old'], [added, POLICY], [direct, DIRECT_POLICY]]) {
    await mkdir(path.join(root, id));
    await writeFile(path.join(root, id, 'integrity.json'), JSON.stringify({ configuration: policy === DIRECT_POLICY ? { harness: policy } : { code_policy: policy } }));
    await writeFile(path.join(root, id, 'run.json'), JSON.stringify({ id, status: 'running', harness: policy === DIRECT_POLICY ? policy : undefined, coding_mode: policy === POLICY ? 'any' : 'off' }));
  }
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, method: req.method, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.startsWith('/api/benchmark/v1/runs?') ? { runs: [
      { id: existing, status: 'running', runner_active: true, action_count: 42 },
      { id: added, status: 'interrupted', runner_active: false, action_count: 9 },
      { id: direct, status: 'interrupted', runner_active: false, action_count: 12 }
    ] } : { owner: 'original', body: body ? JSON.parse(body) : null }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const supervisor = { active: new Map([[added, {}], [direct, {}]]), runDirectory: id => path.join(root, id),
    launch: async spec => { launches.push(spec); return { owner: 'new', ...spec }; },
    stop: async id => { stops.push(id); return { owner: 'new' }; } };
  const { server, reports } = createCapabilityServer(process.cwd(), { port: 0, mainPort: upstream.address().port, upstreamPort: upstream.address().port, supervisor, autoRecovery: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); server.close(); await reports.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, prefix = '/api/benchmark/v1';
  const get = async url => { const r = await fetch(base + url); assert.equal(r.status, 200); return r.json(); };
  const post = async (url, body = {}) => { const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert(r.ok); return r.json(); };
  const list = await get(prefix + '/runs?view=library');
  assert.equal(list.runs[0].runner_active, true); assert.equal(list.runs[0].action_count, 42);
  assert.equal(list.runs[1].runner_active, true); assert.equal(list.runs[1].status, 'running');
  assert.equal(list.runs[2].harness, DIRECT_POLICY); assert.equal(list.runs[2].runner_active, true);
  assert.equal((await post(prefix + '/runs', { provider: 'kimi-code', coding_mode: 'any' })).owner, 'new');
  assert.equal((await post(prefix + '/runs', { provider: 'kimi-code', coding_mode: 'python' })).owner, 'original');
  assert.equal((await post(prefix + '/runs', { provider: 'codex', coding_mode: 'any' })).owner, 'original');
  assert.equal((await post(prefix + '/runs', { provider: 'prime-agent', coding_mode: 'off', tools_enabled: false, effort: 'max' })).owner, 'new');
  assert.equal((await post(prefix + '/runs', { provider: 'prime-agent', coding_mode: 'python' })).owner, 'original');
  await post(prefix + '/runs/' + existing + '/stop'); await post(prefix + '/runs/' + added + '/stop');
  await post(prefix + '/runs/' + direct + '/stop');
  assert.deepEqual(stops, [added, direct]); assert.equal(launches.length, 2);
  assert(calls.some(c => c.path === prefix + '/runs/' + existing + '/stop'));
  assert(!calls.some(c => c.path === prefix + '/runs/' + added + '/stop'));
  assert.equal((await fetch(base + '/api/benchmark/capabilities/status', { headers: { origin: 'https://other.example' } })).status, 403);
});

test('HTTP launch, overview, library and controls use built-in recovery with a real signed checkpoint', { timeout: 90000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-recovery-api-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  class OfflineSupervisor extends BenchmarkSupervisor {
    startDirect(id, directory, home) {
      const file = path.join(directory, 'run.json'), metadata = JSON.parse(readFileSync(file));
      writeFileSync(file, JSON.stringify({ ...metadata, status: 'running' }));
      if (!existsSync(path.join(home, 'conversation.json'))) writeFileSync(path.join(home, 'conversation.json'), JSON.stringify({
        run_id: id, messages: [{ role: 'user', content: readFileSync(path.join(directory, 'prompt.md'), 'utf8') }], pending: null, inflight_tool: null }));
      this.active.set(id, {});
    }
  }
  const root = path.resolve(import.meta.dirname, '..');
  const supervisor = new OfflineSupervisor(root, { recordsRoot: path.join(temp, 'records'), directStateRoot: path.join(temp, 'private'),
    directCatalog: async () => [{ id: 'fixture/model', efforts: ['max'], default_effort: 'max', context_window: 1000000,
      max_output_tokens: 131072, parameters: ['tools', 'reasoning_effort'] }] });
  let launched, clock = 100000;
  const upstream = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ runs: launched ? [launched] : [] })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const { server, reports, recovery } = createCapabilityServer(root, { port: 0, mainPort: upstream.address().port, upstreamPort: upstream.address().port, supervisor, recoveryOptions: { interval: 60000, now: () => clock, delays: [10] } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await recovery.close(); server.closeAllConnections(); server.close(); await reports.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/benchmark/v1`;
  const capability = await (await fetch(`http://127.0.0.1:${server.address().port}/api/benchmark/capabilities/status`)).json();
  assert.equal(capability.version, 2, 'Additive recovery features preserve the browser route protocol');
  assert.equal(capability.prime_auto_recovery, true);
  const request = async (suffix, body) => {
    const r = await fetch(base + suffix, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result = await r.json(); assert(r.ok, result.error); return result;
  };
  launched = await request('/runs', { provider: 'prime-agent', model: 'fixture/model', effort: 'max', coding_mode: 'off', action_limit: 100 });
  assert.equal(launched.auto_recovery.enabled, true);
  const file = path.join(supervisor.runDirectory(launched.id), 'run.json');
  const metadata = JSON.parse(await readFile(file));
  supervisor.active.delete(launched.id);
  await writeFile(file, JSON.stringify({ ...metadata, status: 'failed', error: 'fetch failed' }));
  await recovery.tick();
  const overview = await request('/runs/' + launched.id + '?view=overview');
  assert.equal(overview.auto_recovery.state, 'waiting'); assert.equal(overview.action_count, 0);
  const library = await request('/runs?view=library'); assert.equal(library.runs[0].auto_recovery.state, 'waiting');
  const paused = await request('/runs/' + launched.id + '/pause', {});
  assert.equal(paused.auto_recovery.enabled, false); assert.equal(paused.status, 'paused');
  const resumed = await request('/runs/' + launched.id + '/resume', {});
  assert.equal(resumed.auto_recovery.enabled, true); assert.equal(resumed.runner_active, true);
  assert.equal(resumed.id, launched.id); assert.equal(resumed.effort, 'max'); assert.equal(resumed.tools_enabled, false);
  supervisor.active.delete(launched.id);
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file)), status: 'failed', error: 'Prime inference returned HTTP 422 (output budget 8000).' }));
  await recovery.tick(); clock += 10; await recovery.tick();
  assert.equal(recovery.status(launched.id).state, 'blocked');
  assert.match(recovery.status(launched.id).reason, /no known message-content repair applies/);
});

test('vision launch requests never fall back to ASCII through capability or catalog routes', async t => {
  const asciiCalls = [], imageCalls = [];
  let healthy = true;
  const ascii = createServer((req, res) => {
    asciiCalls.push(req.url); res.end(JSON.stringify({ observation_mode: 'ascii' }));
  });
  const vision = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/benchmark/vision/status') {
      res.end(JSON.stringify({ observation_mode: healthy ? 'vision' : 'ascii' })); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    imageCalls.push({ path: req.url, spec: JSON.parse(body) });
    res.writeHead(202); res.end(JSON.stringify({ observation_mode: 'vision' }));
  });
  await new Promise(resolve => ascii.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => vision.listen(0, '127.0.0.1', resolve));
  const visionPort = vision.address().port;
  t.after(() => { for (const server of [ascii, vision]) { server.closeAllConnections(); server.close(); } });
  for (const catalog of [undefined, { selection: () => assert.fail('Vision goes to its dedicated supervisor') }]) {
    const { server, reports } = createCapabilityServer(process.cwd(), {
      port: 0, upstreamPort: ascii.address().port, visionPort,
      autoRecovery: false, supervisor: {}, catalog
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); server.close(); await reports.close(); });
    for (const suffix of ['runs', 'pairs']) {
      const url = `http://127.0.0.1:${server.address().port}/api/benchmark/v1/${suffix}`;
      const spec = { provider: 'codex', observation_mode: 'vision', tools_enabled: false };
      const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) };
      healthy = false;
      const unavailable = await fetch(url, options);
      assert.equal(unavailable.status, 503);
      assert.match((await unavailable.json()).error, /no run was launched/);
      healthy = true;
      const ready = await fetch(url, options);
      assert.equal(ready.status, 202);
      assert.equal((await ready.json()).observation_mode, 'vision');
      assert.deepEqual(imageCalls.at(-1), { path: `/api/benchmark/v1/${suffix}`, spec });
    }
  }
  assert.equal(imageCalls.length, 4);
  assert.deepEqual(asciiCalls, [], 'Neither successful nor rejected vision launches reach ASCII');
});
