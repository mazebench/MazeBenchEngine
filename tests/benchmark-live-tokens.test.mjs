import test from 'node:test';
import assert from 'node:assert/strict';
import { createKimiTimeline, consumeKimiEvent, kimiTelemetry } from '../benchmarking/kimi-telemetry.mjs';
import { requestApiCost, estimateRequests } from '../benchmarking/token-pricing.mjs';
import { createClaudeTimeline, consumeClaudeEvent, claudeTelemetry } from '../benchmarking/claude-telemetry.mjs';
import { createAntigravityTimeline, consumeAntigravityEvent, antigravityTelemetry } from '../benchmarking/antigravity-telemetry.mjs';
import { createPrimeTimeline, consumePrimeEvent, primeTelemetry } from '../benchmarking/prime-telemetry.mjs';
test('Kimi counts authoritative native usage during a turn, including cache reads and writes exactly once', () => {
  const t = createKimiTimeline();
  const usage = { inputOther: 100, inputCacheRead: 800, inputCacheCreation: 100, output: 50 };
  consumeKimiEvent(t, { type: 'usage.record', agentId: 'main', usage, time: 1000 });
  consumeKimiEvent(t, { type: 'context.append_loop_event', agentId: 'main', event: { type: 'step.end', usage }, time: 1000 });
  consumeKimiEvent(t, { type: 'token_counting.measured', agentId: 'main', tokens: 1050, time: 1001 });
  const r = kimiTelemetry(t, { model: 'k3.1-pro', usage: { input_tokens: 999999 } });
  assert.deepEqual(r.totals, { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 100, output_tokens: 50, total_tokens: 1050 });
  assert.equal(r.current_tokens, 1050); assert.equal(r.api_estimate.request_count, 1);
  assert(Math.abs(r.api_estimate.usd - .00106) < 1e-12);
});
test('all priced harnesses distinguish cache input; long-context premiums are model specific', () => {
  const u = { input_tokens: 1000000, cached_input_tokens: 800000, cache_write_input_tokens: 100000, output_tokens: 100000 };
  for (const model of ['k3.1-pro', 'k3.1-pro-highspeed', 'gpt-6.1-sol', 'claude-sonnet-5-5', 'grok-4.7', 'gemini-4-argon-high', 'muse-spark-1.2']) {
    assert(requestApiCost(model, u) > 0, model);
    assert(requestApiCost(model, u) < requestApiCost(model, { ...u, cached_input_tokens: 0 }), model);
  }
  assert.equal(requestApiCost('k3.1-pro', u), 1.56);
  assert.equal(requestApiCost('grok-4.7', u), 2.8);
  assert.equal(estimateRequests([u], 'unknown').usd, null);
});
test('completed Claude turn costs replace active estimates without adding usage twice', () => {
  const t = createClaudeTimeline(), base = { _received_at: '2026-10-23T00:00:00Z', _turn_id: 'turn1' };
  const usage = { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 };
  const e = { ...base, type: 'assistant', message: { id: 'request1', usage } };
  consumeClaudeEvent(t, e); consumeClaudeEvent(t, e);
  assert.equal(claudeTelemetry(t, 'claude-opus-5-5').totals.input_tokens, 1000);
  assert(claudeTelemetry(t, 'claude-opus-5-5').api_estimate.usd > 0);
  consumeClaudeEvent(t, { ...base, type: 'result', usage, total_cost_usd: .123 });
  consumeClaudeEvent(t, { ...e, _turn_id: 'turn2', message: { ...e.message, id: 'request2' } });
  const r = claudeTelemetry(t, 'claude-opus-5-5');
  assert.equal(r.totals.input_tokens, 2000); assert.equal(r.totals.cached_input_tokens, 1800);
  assert(Math.abs(r.api_estimate.usd - (.123 + requestApiCost('claude-opus-5-5', { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 }))) < 1e-12);
});
test('Antigravity input already includes cache and output already includes thinking', () => {
  const t = createAntigravityTimeline(), e = { _received_at: '2026-10-23T00:00:00Z', step_update: { state: 'DONE', step_type: 'agent_response', conversation_id: 'c', step_index: 1,
    usage: { input_tokens: 4394, cache_read_tokens: 2319, output_tokens: 2664, thinking_tokens: 2209, total_tokens: 7058 } } };
  consumeAntigravityEvent(t, e); consumeAntigravityEvent(t, e);
  const r = antigravityTelemetry(t, 'gemini-4-argon-high');
  assert.equal(r.total_tokens, 7058); assert.equal(r.totals.cached_input_tokens, 2319); assert(r.api_estimate.usd > 0);
});
test('Prime cumulative snapshots and replayed usage do not inflate totals or cost', async () => {
  const t = createPrimeTimeline(), usage = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, total_tokens: 1050 };
  consumePrimeEvent(t, { type: 'turn.completed', usage }); consumePrimeEvent(t, { type: 'turn.completed', usage });
  const r = await primeTelemetry(t, { model: 'fixture/model' }, async () => ({ source: 'fixture', rates: [2, .2, 2, 10] }));
  assert.deepEqual(r.totals, usage); assert(Math.abs(r.api_estimate.usd - .00106) < 1e-12);
});
