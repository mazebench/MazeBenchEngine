import { estimateRequests, primeCatalogPrice, livePrice } from './token-pricing.mjs';
let catalog = new Map(), expires = 0, pending, checkedAt = null;
export async function primePrice(model) {
  const synced = livePrice(model, Date.now(), 'standard', 'prime');
  if (synced) return synced;
  if (Date.now() > expires) {
    pending ||= (async () => {
      try {
        const response = await fetch('https://api.pinference.ai/api/v1/models', { signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw new Error('Catalog unavailable');
        catalog = new Map((await response.json()).data.map(m => [m.id, m.pricing]));
        checkedAt = new Date().toISOString().slice(0, 10);
        expires = Date.now() + 3600000;
      } catch { expires = Date.now() + 60000; }
    })().finally(() => { pending = null; });
    await pending;
  }
  const p = catalog.get(model);
  return primeCatalogPrice(p, checkedAt);
}
export const createPrimeTimeline = () => ({ requests: new Map(), totals: null, samples: [], compactions: [] });
export function consumePrimeEvent(timeline, event) {
  if (event.type === 'context_compacted') timeline.compactions.push({ timestamp: Date.parse(event._received_at), before_tokens: timeline.samples.at(-1)?.tokens ?? null, after_tokens: null });
  if (event.type === 'turn.completed' && Number.isFinite(event.usage?.input_tokens) && Number.isFinite(event.usage?.output_tokens)) timeline.totals = event.usage;
  if (event.type !== 'request_usage' || !event.response_id || !Number.isFinite(event.usage?.input_tokens) || !Number.isFinite(event.usage?.output_tokens)) return;
  const timestamp = Date.parse(event._received_at);
  timeline.requests.set(event.response_id, { timestamp, model: event.model, usage: event.usage });
  const compaction = timeline.compactions.at(-1);
  if (compaction && compaction.after_tokens === null && timestamp >= compaction.timestamp) compaction.after_tokens = event.usage.input_tokens + event.usage.output_tokens;
  if (Number.isFinite(timestamp) && timeline.samples.at(-1)?.response_id !== event.response_id)
    timeline.samples.push({ timestamp, tokens: event.usage.input_tokens + event.usage.output_tokens, response_id: event.response_id });
}
export async function primeTelemetry(timeline, metadata, getPrice = primePrice) {
  const totals = timeline.totals || metadata.usage || null;
  const price = await getPrice(metadata.model);
  // Old Prime streams report cumulative snapshots. Price that inclusive total
  // once using the selected Prime route's flat catalog rates, never sum polls.
  const requests = [...timeline.requests.values()];
  const sum = key => requests.reduce((n, r) => n + (r.usage[key] || 0), 0);
  const complete = requests.length && sum('input_tokens') === totals?.input_tokens && sum('output_tokens') === totals?.output_tokens;
  const api_estimate = estimateRequests(complete ? requests : totals ? [totals] : [], metadata.model, { price,
    ...(complete ? { priceFor: (model, timestamp) => livePrice(model, timestamp, 'standard', 'prime') || price } : {}) });
  const reported = complete && requests.every(r => Number.isFinite(r.usage.cost_usd) && r.usage.cost_usd >= 0);
  if (reported) { api_estimate.usd = sum('cost_usd'); api_estimate.unpriced_requests = 0; }
  api_estimate.request_count = timeline.requests.size || null;
  api_estimate.basis = `Prime Inference catalog token estimate, including reported cache reads. ${complete ? 'Recorded responses use observed price history' : 'Cumulative usage is priced once at current catalog rates'}; remote VM fees and unreported usage are excluded.`;
  if (reported) api_estimate.basis = 'Prime reported inference cost for all recorded model responses. Remote VM fees are excluded.';
  else if (api_estimate.usd === null && totals) api_estimate.basis += ' A verified rate for this route or its cache usage is unavailable.';
  const latest = timeline.samples.at(-1);
  if (['prime-inference-direct-v1', 'prime-inference-direct-v2'].includes(metadata.harness)) api_estimate.basis = api_estimate.basis.replace('remote VM fees and unreported usage are excluded', 'unreported usage is excluded').replace(' Remote VM fees are excluded.', '');
  return { available: Boolean(latest), totals, samples: timeline.samples, compactions: timeline.compactions,
    current_tokens: latest?.tokens ?? null, updated_at: latest?.timestamp ?? null,
    context_window: metadata.context_window || null, compaction_threshold: metadata.compaction_threshold || null, api_estimate,
    reason: 'Prime reports cumulative token usage. Context samples require per-response usage from the new runner.' };
}
