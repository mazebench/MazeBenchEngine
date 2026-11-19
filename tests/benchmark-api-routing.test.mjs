import test from 'node:test';
import assert from 'node:assert/strict';
import { runCardValues } from '../benchmarking/ui/run-library.mjs';

test('context and thinking charts use independently upgradeable report readers with owner fallback', async t => {
  const previousWindow = globalThis.window, previousLocation = globalThis.location;
  t.after(() => { globalThis.window = previousWindow; globalThis.location = previousLocation; });
  globalThis.location = { hostname: 'localhost' };
  for (const reportOnline of [true, false]) {
    const calls = [];
    globalThis.window = { fetch: async url => {
      calls.push(url);
      if (url.startsWith('http://localhost:8091/')) return Response.json({}, { status: reportOnline ? 200 : 404 });
      if (url.startsWith('http://localhost:8085/')) return Response.json({}, { status: 404 });
      assert(url.startsWith('http://localhost:8092/'));
      return Response.json(url.endsWith('/status') ? { provider_scope: 'all' } : {});
    } };
    const { benchmarkFetch } = await import(`../benchmarking/ui/benchmark-api.mjs?reports=${reportOnline}`);
    for (const kind of ['tokens', 'charts', 'comparison']) {
      const route = `/api/benchmark/v1/runs/run-example/${kind}`;
      assert.equal((await benchmarkFetch(route)).status, 200);
      assert.equal(calls.at(-1), `http://localhost:${reportOnline ? 8091 : 8092}${route}`);
    }
  }
});

test('replay chunks use the report reader when the playback reader is offline', async t => {
  const previousWindow = globalThis.window, previousLocation = globalThis.location;
  t.after(() => { globalThis.window = previousWindow; globalThis.location = previousLocation; });
  globalThis.location = { hostname: 'localhost' };
  const calls = [];
  let playbackOnline = true, reportOnline = true;
  globalThis.window = { fetch: async url => {
    calls.push(url);
    const { port } = new URL(url);
    if (port === '8085' && playbackOnline || port === '8091' && reportOnline) return Response.json({ port });
    throw new TypeError('Connection refused');
  } };
  const { benchmarkFetch } = await import('../benchmarking/ui/benchmark-api.mjs?replay-routing');
  const path = '/api/benchmark/playback/runs/run-example/chunk?after=31&epoch=one&limit=256';
  assert.deepEqual(await (await benchmarkFetch(path)).json(), { port: '8085' });
  assert.deepEqual(calls.splice(0), [`http://localhost:8085${path}`]);
  playbackOnline = false;
  assert.deepEqual(await (await benchmarkFetch(path)).json(), { port: '8091' });
  assert.deepEqual(calls.splice(0), [`http://localhost:8085${path}`, `http://localhost:8091${path}`]);
  reportOnline = false;
  await assert.rejects(benchmarkFetch(path), /Replay service is temporarily unavailable/);
  assert.deepEqual(calls, [`http://localhost:8085${path}`, `http://localhost:8091${path}`]);
});

test('the all-agent gateway receives launches and controls without dropping mode or speed', async t => {
  const previousWindow = globalThis.window, previousLocation = globalThis.location;
  t.after(() => { globalThis.window = previousWindow; globalThis.location = previousLocation; });
  const calls = [];
  globalThis.location = { hostname: 'localhost' };
  globalThis.window = { fetch: async (url, options) => {
    calls.push({ url, options });
    assert(url.startsWith('http://localhost:8092/'));
    return Response.json(url.endsWith('/status') ? { version: 1, provider_scope: 'all' } : { ok: true });
  } };
  const { benchmarkFetch } = await import('../benchmarking/ui/benchmark-api.mjs?current-codex-routing');
  for (const observation_mode of ['ascii', 'vision']) for (const tools_enabled of [false, true]) {
    const options = { method: 'POST', body: JSON.stringify({ provider: 'codex', model: 'gpt-6.1-terra', observation_mode, tools_enabled, service_tier: 'fast' }) };
    await benchmarkFetch('/api/benchmark/v1/runs', options);
    assert.equal(calls.at(-1).options, options);
  }
  await benchmarkFetch('/api/benchmark/v1/runs/run-existing/pause', { method: 'POST' });
  assert.equal(calls.at(-1).url, 'http://localhost:8092/api/benchmark/v1/runs/run-existing/pause');
  assert.equal(calls.filter(c => c.url.endsWith('/status')).length, 1);
});

test('vision run launches require a versioned owner and never fall through to legacy ASCII', async t => {
  const previousWindow = globalThis.window, previousLocation = globalThis.location;
  t.after(() => { globalThis.window = previousWindow; globalThis.location = previousLocation; });
  for (const online of [false, true]) {
    const calls = [];
    globalThis.location = { hostname: 'localhost' };
    globalThis.window = { fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === 'http://localhost:8090/api/benchmark/release/status') {
        if (!online) throw new Error('Connection refused');
        return Response.json({ ascii_renderer: 2 });
      }
      if (url.includes('/capabilities/status')) return Response.json({ version: 2 });
      assert(url.startsWith('http://localhost:8090/'), 'No launch may reach the ASCII or generic capability owner');
      return Response.json({ observation_mode: 'vision' });
    } };
    const { benchmarkFetch } = await import(`../benchmarking/ui/benchmark-api.mjs?vision-routing-test=${online}`);
    for (const suffix of ['runs']) {
      const options = { method: 'POST', body: JSON.stringify({ observation_mode: 'vision', tools_enabled: false }) };
      if (online) {
        const response = await benchmarkFetch('/api/benchmark/v1/' + suffix, options);
        assert.equal((await response.json()).observation_mode, 'vision');
        assert.equal(calls.at(-1).options, options);
      } else {
        await assert.rejects(() => benchmarkFetch('/api/benchmark/v1/' + suffix, options), /Versioned benchmark runner is unavailable/);
        assert.equal(calls.filter(call => call.options?.method === 'POST').length, 0);
      }
    }
  }
});

test('browser routes reads and controls to the owning companion across recovery upgrades', async t => {
  const previousWindow = globalThis.window, previousLocation = globalThis.location;
  t.after(() => { globalThis.window = previousWindow; globalThis.location = previousLocation; });
  for (const version of [2, 3]) {
    const calls = [];
    const run = { id: 'run-fixture', model: 'deepseek/deepseek-v4.1-flash-1017', provider: 'prime-agent',
      status: 'running', runner_active: true, harness: 'prime-inference-direct-v1', coding_mode: 'off', tools_enabled: false,
      auto_recovery: { managed: true, enabled: true, state: 'watching' } };
    globalThis.location = { hostname: 'localhost' };
    globalThis.window = { fetch: async (url, options) => {
      calls.push({ url, options });
      if(url.startsWith('http://localhost:8084/'))throw new Error('Catalog upgrade not installed');
      assert(url.startsWith('http://localhost:8083/'), 'Do not silently query the non-owning server');
      return Response.json(url.endsWith('/status') ? { available: true, version, prime_auto_recovery: true } : { runs: [run] });
    } };
    const { benchmarkFetch } = await import(`../benchmarking/ui/benchmark-api.mjs?routing-test=${version}`);
    const response = await benchmarkFetch('/api/benchmark/v1/runs?view=library');
    const [result] = (await response.json()).runs, card = runCardValues(result);
    assert.equal(card.statusTone, 'green'); assert.equal(card.tools, 'Coding off');
    const options = { method: 'POST', body: '{}' };
    await benchmarkFetch('/api/benchmark/v1/runs/run-fixture/pause', options);
    const probes = calls.filter(call => call.url.endsWith('/status'));
    assert.equal(new Set(probes.map(call => call.url)).size, probes.length, 'Availability probes are shared by reads and controls');
    assert.equal(calls.at(-1).url, 'http://localhost:8083/api/benchmark/v1/runs/run-fixture/pause');
    assert.equal(calls.at(-1).options, options);
  }
});
