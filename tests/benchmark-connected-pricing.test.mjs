import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeTimeline, consumeClaudeEvent, claudeTelemetry } from '../benchmarking/claude-telemetry.mjs';
import { requestApiCost } from '../benchmarking/token-pricing.mjs';

test('connected Grok models use token prices instead of zero placeholders, including repeated response IDs after resume', () => {
  const timeline = createClaudeTimeline();
  const model = 'gpt-6.1-terra';
  for (const turn of ['first', 'resumed']) {
    const base = { _turn_id: turn, _received_at: '2026-11-05T00:00:00Z' };
    consumeClaudeEvent(timeline, { ...base, type: 'assistant', message: { id: 'msg_0', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500 } } });
    consumeClaudeEvent(timeline, { ...base, type: 'result', total_cost_usd: 0, usage: { input_tokens: 1200, output_tokens: 120, cache_read_input_tokens: 500 } });
  }
  const result = claudeTelemetry(timeline, model, { trustReportedCost: false });
  const expected = requestApiCost(model, { input_tokens: 1700, cached_input_tokens: 500, output_tokens: 120 }) * 2;
  assert.equal(timeline.requests.size, 2);
  assert.ok(Math.abs(result.api_estimate.usd - expected) < 1e-12);
  assert.ok(result.api_estimate.usd > 0);
  assert.equal(result.totals.total_tokens, 3640);
  assert.equal(claudeTelemetry(timeline, model).api_estimate.usd, 0, 'Preserve legitimate native reported costs.');
  assert.equal(claudeTelemetry(timeline, 'unpriced-future-model', { trustReportedCost: false }).api_estimate.usd, null);
});
