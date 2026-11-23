import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pricingFor, requestApiCost, installPricingSnapshot } from '../benchmarking/token-pricing.mjs';
import { createTokenTimeline, consumeTokenEvent, tokenBilling } from '../benchmarking/token-telemetry.mjs';
import { configuredModels, pricingRows } from '../benchmarking/ui/pricing-data.mjs';
import { parseDeepSeek, pricingSources } from '../benchmarking/pricing-sources.mjs';
import { PricingService } from '../benchmarking/pricing-service.mjs';

// Provider table shape, including rowspan/colspan and the separate search table.
const page = `Model prices are listed in units of per 1M tokens.
<table><tr><td colspan="3">MODEL</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro</td></tr>
<tr><td rowspan="6">PRICING<sup>(2)</sup></td><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
<tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
<tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
<tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr></table>
<p>The legacy names <code>deepseek-v4-flash</code> and <code>deepseek-v4-flash-vision-exp</code> are billed at the Flash price.</p>
<p>Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays.</p>
<table><tr><th>API</th><th>Unit</th><th>Price</th></tr><tr><td>Search</td><td>1,000 requests</td><td>$0.75</td></tr></table>`;
const at = time => Date.parse(time);

test('DeepSeek refresh discovers model columns and retains cache and peak rates', () => {
  assert.equal(pricingSources.find(source => source.id === 'deepseek').parse, parseDeepSeek);
  const rows = parseDeepSeek(page);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0].price.rates, [.15, .003, .15, .6]);
  assert.deepEqual(rows[1].price.time_schedule.peak_rates, [1.32, .044, 1.32, 3.96]);
  assert.equal(parseDeepSeek(page.replaceAll('deepseek-v4-pro', 'deepseek-next'))[1].key, 'direct:deepseek-next:standard');
  for (const broken of [page.replace('CACHE HIT', 'OTHER'), page.replace('$0.15', 'Unavailable'), page.replace('01:00 - 04:00', '02:00 - 05:00'), page.replace('$0.003', '$0.003 / 1K')]) {
    assert.throws(() => parseDeepSeek(broken));
  }
});

test('Flash costs use request time, cache hits, UTC boundaries, weekends and holidays', () => {
  const usage = { input_tokens: 1e6, cached_input_tokens: 900000, output_tokens: 100000 };
  for (const time of ['2026-11-05T00:59:59Z', '2026-11-05T04:00:00Z', '2026-11-05T05:59:59Z', '2026-11-05T10:00:00Z', '2026-11-07T02:00:00Z', '2026-10-01T02:00:00Z', '2026-02-23T07:00:00Z']) {
    assert.equal(pricingFor('deepseek-flash', at(time)).price_period, 'off-peak', time);
    assert(Math.abs(requestApiCost('deepseek-flash', usage, { timestamp: at(time) }) - .0777) < 1e-12);
  }
  for (const time of ['2026-11-05T01:00:00Z', '2026-11-05T03:59:59Z', '2026-11-05T06:00:00Z', '2026-11-05T09:59:59Z']) {
    assert.equal(pricingFor('deepseek-flash', at(time)).price_period, 'peak', time);
    assert(Math.abs(requestApiCost('deepseek-flash', usage, { timestamp: at(time) }) - .1554) < 1e-12);
  }
  assert.equal(pricingFor('deepseek-flash', NaN), null);
  assert.equal(pricingFor('deepseek-flash', at('2026-11-05T02:00:00Z'), 'fast'), null);
  assert.equal(pricingFor('deepseek-unknown'), null);
  assert(pricingFor('deepseek-flash', at('2028-01-03T02:00:00Z')).estimated);
});

test('active harness telemetry and pricing inventory resolve exact DeepSeek slugs', () => {
  const timeline = createTokenTimeline();
  const event = { type: 'status', phase: 'step_end', _turn_id: 'test', turn: 1,
    usage: { inputTokens: 100000, cacheReadTokens: 900000, cacheWriteTokens: 0, outputTokens: 100000 } };
  consumeTokenEvent(timeline, { ...event, step: 1, _received_at: '2026-11-05T00:59:00Z' });
  consumeTokenEvent(timeline, { ...event, step: 2, _received_at: '2026-11-05T01:01:00Z' });
  // Repeated delivery must neither double count nor move a request across rates.
  consumeTokenEvent(timeline, { ...event, step: 1, _received_at: '2026-11-05T01:02:00Z' });
  const result = tokenBilling(timeline, 'deepseek-flash');
  assert.equal(result.totals.input_tokens, 2e6);
  assert.equal(result.api_estimate.request_count, 2);
  assert.equal(result.api_estimate.unpriced_requests, 0);
  assert.deepEqual(result.api_estimate.price_periods, ['off-peak', 'peak']);
  assert(Math.abs(result.api_estimate.usd - .2331) < 1e-12);
  const rows = pricingRows({ models: configuredModels(), runs: [{ model: 'deepseek-flash', provider: 'deepseek-harness' }], now: at('2026-11-05T00:59:00Z') });
  const flash = rows.find(row => row.model === 'deepseek-flash');
  assert.equal(flash.slug, 'deepseek-flash');
  assert.equal(flash.provider, 'deepseek-harness');
  assert.equal(flash.status, 'configured');
  assert.equal(flash.runs, 1);
});

test('peak-only updates preserve historical prices and survive offline reload', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deepseek-prices-'));
  let now = at('2026-11-05T01:00:00Z'), text = page;
  const options = { file: path.join(dir, 'prices.json'), sources: [pricingSources.find(source => source.id === 'deepseek')],
    now: () => now, fetcher: async () => new Response(text) };
  try {
    const service = new PricingService(options);
    await service.refresh();
    now += 60000; text = page.replace('$1.2', '$1.4');
    installPricingSnapshot(await service.refresh(true));
    assert.equal(pricingFor('deepseek-flash', now - 1).rates[3], 1.2);
    assert.equal(pricingFor('deepseek-flash', now).rates[3], 1.4);
    text = 'Provider page unavailable';
    const restarted = new PricingService(options);
    const snapshot = await restarted.refresh(true);
    assert(snapshot.sources.deepseek.error);
    assert.equal(snapshot.entries['direct:deepseek-flash:standard'].versions.length, 2);
    installPricingSnapshot(snapshot);
    assert.equal(pricingFor('deepseek-flash', now).rates[3], 1.4);
  } finally { installPricingSnapshot(null); await rm(dir, { recursive: true, force: true }); }
});

test('report upgrades route reads independently and fall back to the previous reader', async t => {
  const saved = { window: globalThis.window, location: globalThis.location };
  t.after(() => Object.assign(globalThis, saved));
  globalThis.location = { hostname: 'localhost' };
  const calls = []; let current = true;
  globalThis.window = { fetch: async url => {
    calls.push(url);
    if (url.includes(':8091') && !current) throw new Error('Reader offline');
    return Response.json({ ok: true });
  } };
  const { benchmarkFetch } = await import('../benchmarking/ui/benchmark-api.mjs?deepseek-pricing');
  await benchmarkFetch('/api/benchmark/v1/pricing');
  assert.deepEqual(calls, ['http://localhost:8091/api/benchmark/v1/pricing']);
  current = false; calls.length = 0;
  await benchmarkFetch('/api/benchmark/v1/runs/run-active/tokens');
  assert.deepEqual(calls, ['http://localhost:8091/api/benchmark/v1/runs/run-active/tokens', 'http://localhost:8085/api/benchmark/v1/runs/run-active/tokens']);
});
