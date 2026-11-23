import test from 'node:test';
import assert from 'node:assert/strict';
import { costAvailability } from '../benchmarking/ui/cost-availability.mjs';
import { pricingFor, installPricingSnapshot } from '../benchmarking/token-pricing.mjs';
test('missing usage is distinct from a missing price, and zero dollars is valid', () => {
  assert(pricingFor('gpt-6-sol'));
  assert.equal(costAvailability({ api_estimate: { model: 'gpt-6-sol' } }).label, 'Usage unavailable');
  assert.equal(costAvailability({ api_estimate: { usd: 0 } }).label, '≈ $0.00');
});
test('Wonder Full uses its actual publication gap, not standard Wonder rates', () => {
  const value = { totals: { input_tokens: 1000, output_tokens: 100 }, api_estimate: { model: 'muse-wonder-full-1.0', usd: null } };
  assert.equal(pricingFor(value.api_estimate.model), null);
  assert.equal(costAvailability(value).label, 'No API rate');
  assert.match(costAvailability(value).source, /models\/muse-wonder$/);
  assert.equal(costAvailability({ ...value, api_estimate: { ...value.api_estimate, usd: .01 } }).label, '≈ $0.01');
});
test('a future published exact-model price overrides the current publication gap', () => {
  installPricingSnapshot({ entries: { 'direct:muse-wonder-full-1.0:standard': { versions: [{ from: null, price: { rates: [8, .4, 8, 40] } }] } } });
  try { assert.deepEqual(pricingFor('muse-wonder-full-1.0').rates, [8, .4, 8, 40]); }
  finally { installPricingSnapshot(null); }
});
