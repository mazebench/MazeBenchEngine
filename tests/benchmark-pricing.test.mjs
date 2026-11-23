import test from 'node:test';
import assert from 'node:assert/strict';
import { pricingFor, requestApiCost, estimateRequests } from '../benchmarking/token-pricing.mjs';
import { createTokenTimeline, consumeTokenEvent, tokenBilling } from '../benchmarking/token-telemetry.mjs';
import { pricingRows } from '../benchmarking/ui/pricing-data.mjs';
import { createPlaybackServer } from '../benchmarking/playback-server.mjs';

test('Terra uses official cache, write, Fast and per-request long-context prices', () => {
  const price = pricingFor('gpt-6.1-terra');
  assert.deepEqual(price.rates, [1, .05, 1.25, 5, 2.5]);
  assert.equal(price.checked_at, '2026-10-26');
  assert.equal(price.source, 'https://developers.openai.com/api/docs/pricing');
  const usage = { input_tokens: 200000, cached_input_tokens: 100000, cache_write_input_tokens: 40000, cache_write_long_input_tokens: 10000, output_tokens: 10000 };
  // 60k regular + 100k read + 30k short write + 10k long write + 10k output.
  assert.equal(requestApiCost('gpt-6.1-terra', usage), .1775);
  assert.equal(requestApiCost('gpt-6.1-terra', usage, { service_tier: 'fast' }), .355);
  assert.equal(requestApiCost('gpt-6.1-terra', { input_tokens: 272000, output_tokens: 10000 }), .322);
  assert(Math.abs(requestApiCost('gpt-6.1-terra', { input_tokens: 300000, output_tokens: 10000 }) - .675) < 1e-12);
  assert(Math.abs(requestApiCost('gpt-6.1-terra', { input_tokens: 300000, output_tokens: 10000 }, { service_tier: 'fast' }) - 1.35) < 1e-12);
  assert.equal(pricingFor('gpt-6.1-terra', Date.now(), 'ultrafast'), null);
  assert.equal(pricingFor('unpublished-model'), null);
  assert.equal(estimateRequests([usage], 'gpt-6.1-terra', { price: null }).usd, null);
});

test('Terra speed changes and repeated compaction records never reprice earlier responses', () => {
  const timeline = createTokenTimeline();
  const usage = { input_tokens: 200000, cached_input_tokens: 100000, output_tokens: 10000 };
  const first = { response_id: 'one', usage };
  consumeTokenEvent(timeline, { type: 'token_usage_record', timestamp: '2026-10-26T10:00:00Z', payload: first });
  consumeTokenEvent(timeline, { type: 'compacted', timestamp: '2026-10-26T12:01:00Z', payload: { latest_token_usage_record: first } });
  consumeTokenEvent(timeline, { type: 'token_usage_record', timestamp: '2026-10-26T12:02:00Z', payload: { response_id: 'two', usage } });
  const result = tokenBilling(timeline, 'gpt-6.1-terra', { service_tier: 'fast', service_tier_history: [
    { at: '2026-10-26T09:00:00Z', service_tier: 'standard' }, { at: '2026-10-26T11:00:00Z', service_tier: 'fast' }
  ] });
  assert.equal(result.totals.input_tokens, 400000);
  assert.equal(result.api_estimate.request_count, 2);
  assert(Math.abs(result.api_estimate.usd - .465) < 1e-12);
  assert.deepEqual(result.api_estimate.service_tiers, ['standard', 'fast']);
});

test('pricing inventory includes unpriced and historical models, preserves route prices and flags missing cache rates', () => {
  const rows = pricingRows({ models: [
    { id: 'gpt-6.1-terra', provider: 'codex', speed_options: ['standard', 'fast'] },
    { id: 'gpt-6.1-terra', provider: 'prime-agent', pricing: { input_usd_per_mtok: 7, output_usd_per_mtok: 9 } },
    { id: 'qwen/free-cache', provider: 'prime-agent', pricing: { input_usd_per_mtok: 2, cache_read_usd_per_mtok: 0, cache_write_usd_per_mtok: 0, output_usd_per_mtok: 4 } },
    { id: 'gemini-4-argon-high', provider: 'antigravity' },
    { id: 'gemini-4-argon-medium', provider: 'antigravity' },
    { id: 'unknown', provider: 'codex' }
  ], runs: [{ model: 'retired-model', provider: 'codex' }, { model: 'gpt-6.1-terra', provider: 'codex' }] });
  assert.equal(rows.length, 7);
  const prime = rows.find(row => row.provider === 'prime-agent' && row.model === 'gpt-6.1-terra');
  assert.equal(prime.price.rates[0], 7); assert.equal(prime.status, 'partial'); assert(prime.missing.includes('Cached input'));
  assert.equal(rows.find(row => row.model === 'qwen/free-cache').status, 'configured');
  assert.equal(rows.find(row => row.model === 'retired-model').runs, 1);
  assert.equal(rows.find(row => row.model === 'retired-model').status, 'missing');
  assert.equal(rows.find(row => row.model === 'gemini-4-argon').ids.length, 2);
  assert.equal(rows.find(row => row.provider === 'codex' && row.model === 'gpt-6.1-terra' && row.speed === 'standard').runs, 1);
  const fast = rows.find(row => row.provider === 'codex' && row.speed === 'fast');
  assert.equal(fast.price.rates[0], 2); assert.equal(fast.status, 'configured');
});

test('read-only report endpoint serves new pricing without owning or mutating runs', async () => {
  const calls = [];
  const reports = { read: async (...args) => { calls.push(args); return { api_estimate: { usd: .155 } }; }, close: async () => {} };
  const pricing = { refresh: async force => ({ version: 1, entries: {}, sources: {}, force }), close() {} };
  const { server } = createPlaybackServer(process.cwd(), { port: 0, recordsRoot: '/fixtures', reports, replays: {}, pricing, runnerActive: async () => true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, id = 'run-2026-10-26T00-00-00-000Z-abcdef';
  try {
    const response = await fetch(`${origin}/api/benchmark/v1/runs/${id}/tokens`);
    assert.equal(response.status, 200); assert.equal((await response.json()).api_estimate.usd, .155);
    assert.deepEqual(calls, [[`/fixtures/${id}`, 'tokens']]);
    assert.equal((await fetch(`${origin}/api/benchmark/v1/runs/${id}/comparison`)).status, 200);
    assert.deepEqual(calls.at(-1), [`/fixtures/${id}`, 'comparison']);
    assert.equal((await fetch(`${origin}/api/benchmark/v1/runs/${id}/charts`)).status, 200);
    assert.deepEqual(calls.at(-1), [`/fixtures/${id}`, 'charts', true]);
    assert.equal((await fetch(`${origin}/api/benchmark/v1/runs/${id}/charts`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${origin}/api/benchmark/v1/runs/${id}/comparison`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${origin}/api/benchmark/v1/runs/${id}/tokens`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${origin}/api/benchmark/v1/runs/bad-id/tokens`)).status, 404);
    assert.equal((await fetch(`${origin}/api/benchmark/v1/runs/${id}/tokens`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await (await fetch(`${origin}/api/benchmark/v1/pricing?force=1`)).json()).force, true);
    assert.equal((await fetch(`${origin}/api/benchmark/v1/pricing`, { method: 'POST' })).status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
