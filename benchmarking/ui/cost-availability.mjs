import { pricingGap } from '../token-pricing.mjs';

export function costAvailability(value) {
  const price = value.api_estimate;
  if (Number.isFinite(price?.usd)) return { label: `≈ $${price.usd.toFixed(2)}`, reason: null, source: price.source };
  if (!value.totals) return { label: 'Usage unavailable', source: price?.source,
    reason: 'Input/output token records are unavailable for this run. Imported prices alone cannot produce a cost estimate.' };
  const gap = pricingGap(price?.model || value.model || '');
  if (gap && !price?.rates_per_million) return { label: 'No API rate', reason: gap.reason, source: gap.source };
  return { label: 'Estimate unavailable', source: price?.source,
    reason: price?.unpriced_requests ? `${price.unpriced_requests.toLocaleString()} reported responses lack complete pricing or usage. The total is unavailable rather than treating them as free.`
      : 'A complete estimate needs both recorded token usage and matching API rates for the model and speed used.' };
}
