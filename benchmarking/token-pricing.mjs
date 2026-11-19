// Dashboard-only API-equivalent estimates. Input is inclusive of cache reads/writes.
// Each entry records when its rates were checked; never used to bill or configure an agent.
import { scheduledPrice, deepseekScheduleNote } from './pricing-schedule.mjs';
const sources = {
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing',
  openai: 'https://developers.openai.com/api/docs/pricing',
  kimi: 'https://platform.kimi.ai/docs/pricing/chat',
  claude: 'https://platform.claude.com/docs/en/about-claude/pricing',
  gemini: 'https://ai.google.dev/gemini-api/docs/pricing',
  grok: 'https://docs.x.ai/developers/pricing',
  muse: 'https://dev.meta.ai/docs/pricing-rate-limits'
};
const catalog = new Map();
function add(ids, source, rates, extra = {}) {
  for (const id of ids.split(',')) catalog.set(id, { source: sources[source], checked_at: '2026-10-23', rates, ...extra });
}
const openaiLong = { threshold: 272000, input_multiplier: 2, output_multiplier: 1.5 };
add('gpt-6-astra', 'openai', [10, 1, 12.5, 50, 25], { long: openaiLong });
add('gpt-6.1-sol', 'openai', [2, .1, 2.5, 10, 5], { long: openaiLong });
add('gpt-6.1-terra', 'openai', [1, .05, 1.25, 5, 2.5], { long: openaiLong, checked_at: '2026-10-26' });
add('gpt-6-sol', 'openai', [2, .2, 2.5, 10, 5], { long: openaiLong });
add('gpt-6-luna', 'openai', [.1, .01, .125, .5, .25], { long: openaiLong });
add('gpt-5.6,gpt-5.6-sol', 'openai', [4, .4, 5, 20, 10], { long: openaiLong });
add('gpt-5.6-terra', 'openai', [2, .2, 2.5, 12, 5], { long: openaiLong });
add('gpt-5.6-luna', 'openai', [.2, .02, .25, 1.2, .5], { long: openaiLong });
add('k3.1-pro,kimi-k3.1-pro', 'kimi', [2, .2, 2, 10, 4]);
add('k3.1-pro-highspeed,kimi-k3.1-pro-highspeed', 'kimi', [4, .2, 4, 20, 8]);
add('kimi-k3', 'kimi', [3, .3, 3, 15, 6]);
add('kimi-k2.7-code', 'kimi', [.95, .19, null, 4], { source: 'https://models.dev/api.json', checked_at: '2026-10-26' });
add('kimi-k2.7-code-highspeed', 'kimi', [1.9, .38, null, 8], { source: 'https://models.dev/api.json', checked_at: '2026-10-26' });
add('claude-fable-5.1,claude-mythos-5.1', 'claude', [10, .25, 12.5, 50, 20]);
add('claude-fable-5,claude-mythos-5', 'claude', [10, 1, 12.5, 50, 20]);
add('claude-opus-5.5', 'claude', [4, .2, 5, 20, 8]);
add('claude-sonnet-5', 'claude', [2, .2, 2.5, 10, 4]);
add('claude-haiku-5.5', 'claude', [.1, .01, .125, .5, .2], { long: { threshold: 100000, input_multiplier: 5, output_multiplier: 5 } });
add('claude-sonnet-5.5', 'claude', [2, .1, 2.5, 10, 4]);
add('claude-opus-5,claude-opus-4.8,claude-opus-4.7,claude-opus-4.6,claude-opus-4.5', 'claude', [5, .5, 6.25, 25, 10]);
add('claude-sonnet-4.5,claude-sonnet-4.6', 'claude', [3, .3, 3.75, 15, 6], { checked_at: '2026-10-26' });
add('claude-haiku-4.5', 'claude', [1, .1, 1.25, 5, 2], { checked_at: '2026-10-26' });
for (const id of ['claude-opus-5.5', 'claude-opus-5', 'claude-opus-4.8']) {
  const price = catalog.get(id);
  price.fast_rates = price.rates.map(rate => rate * 2);
  price.fast_checked_at = '2026-10-26';
}
add('gemini-4-argon', 'gemini', [2, .1, 2, 10], { changes: [{ at: Date.parse('2026-12-01'), rates: [4, .2, 4, 20] }] });
add('gemini-4-neon', 'gemini', [3, .15, 3, 15], {
  source: 'https://aistudio.google.com/docs/pricing#gemini-4-neon', checked_at: '2026-11-18',
  note: 'Implicit caching only. Input that creates a cache is charged at the ordinary input rate. Output includes thinking tokens.'
});
add('gemini-4-carbon', 'gemini', [2, .1, 2, 10], {
  source: 'https://aistudio.google.com/docs/pricing#gemini-4-carbon', checked_at: '2026-11-10',
  changes: [{ at: Date.parse('2026-12-01T00:00:00Z'), rates: [4, .2, 4, 20] }],
  note: 'Introductory rates through November 30, 2026; input, cached input and output rates double December 1. Implicit caching only; cache creation uses the ordinary input rate. Output includes thinking tokens.'
});
add('gemini-3.8-flash', 'gemini', [.75, .075, .75, 3.75], { changes: [{ at: Date.parse('2027-01-01'), rates: [1.5, .15, 1.5, 7.5] }] });
add('grok-4.7,grok-4.6', 'grok', [2, .5, 2, 6], { long: { threshold: 199999, input_multiplier: 2, output_multiplier: 2 } });
add('grok-4.5', 'grok', [2, .3, 2, 6], { long: { threshold: 199999, input_multiplier: 2, output_multiplier: 2 }, checked_at: '2026-10-26' });
add('grok-4.7-build-fast', 'grok', [4, 1, 4, 12], { long: { threshold: 200000, input_multiplier: 1.5, output_multiplier: 1.5 }, checked_at: '2026-10-26' });
add('muse-spark-1.1,muse-spark-1.2,muse-spark-1.3', 'muse', [1.25, .15, 1.25, 4.25]);
add('muse-spark-1.2-contributor,muse-spark-1.3-contributor', 'muse', [.1, .002, .1, .2]);
add('muse-wonder-1.0', 'muse', [4, .2, 4, 20]);
add('deepseek-flash,deepseek-v4-flash,deepseek-v4-flash-vision-exp', 'deepseek', [.15, .003, .15, .6], {
  checked_at: '2026-11-05', time_schedule: { kind: 'deepseek-utc-v1', peak_rates: [.3, .006, .3, 1.2] }, note: deepseekScheduleNote
});
add('deepseek-v4-pro', 'deepseek', [.66, .022, .66, 1.98], {
  checked_at: '2026-11-05', time_schedule: { kind: 'deepseek-utc-v1', peak_rates: [1.32, .044, 1.32, 3.96] }, note: deepseekScheduleNote
});

// Official OpenAI Standard/Fast tables checked 2026-10-26. Never assume
// that another provider's Fast mode uses the same multiplier.
for (const price of catalog.values()) if (price.source === sources.openai) {
  price.fast_rates = price.rates.map(rate => rate * 2);
  price.fast_checked_at = '2026-10-26';
}

export const pricingModels = () => [...catalog.keys()];
// Live catalogs are installed in both the pricing page and the report worker.
// Versions retain observed change boundaries rather than repricing old responses.
let live = {};
export function installPricingSnapshot(snapshot) { live = snapshot?.entries || {}; }
export function normalizePricingModel(model) {
  const dated = { 'claude-opus-4-5-20251101': 'claude-opus-4-5', 'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001': 'claude-haiku-4-5' };
  const id = String(dated[model] || model || '').replace(/^(claude-.*|gemini-.*)-(low|medium|high|max|xhigh)$/, '$1')
    .replace(/^(claude-[a-z]+-)(\d+)-(\d+)$/, '$1$2.$3');
  return ({ k3: 'kimi-k3', 'k3-256k': 'kimi-k3', 'k3.1-pro': 'kimi-k3.1-pro',
    'k3.1-pro-highspeed': 'kimi-k3.1-pro-highspeed', 'kimi-for-coding-highspeed': 'kimi-k2.7-code-highspeed' })[id] || id;
}
export function livePrice(model, timestamp = Date.now(), tier = 'standard', route = 'direct') {
  const versions = live[`${route}:${route === 'direct' ? normalizePricingModel(model) : model}:${tier}`]?.versions;
  if (!versions?.length) return null;
  const price = [...versions].reverse().find(version => version.from == null || timestamp >= version.from)?.price;
  if (!price) return null;
  let rates = price.rates;
  for (const change of price.changes || []) if (timestamp >= change.at) rates = change.rates;
  return scheduledPrice({ ...price, rates }, timestamp);
}
export function pricingGap(model) {
  if (/^muse-wonder-.*(?:full|contributor)|^muse-wonder-full/.test(model)) return { source: 'https://dev.meta.ai/models/muse-wonder', checked_at: '2026-10-26', reason: 'Meta lists Muse Wonder Full as subscription-only, with no API input, cached input or output rate. Standard Muse Wonder is a different model.' };
  if (model === 'kimi-for-coding') return { source: 'https://www.kimi.com/en/help/kimi-code/models', checked_at: '2026-10-26', reason: 'K2.8 Preview is a Kimi Code subscription model; no public API token price is published.' };
  if (/^(gpt-reserve|codex-auto-review)$/.test(model)) return { source: sources.openai, checked_at: '2026-10-26', reason: 'No public API price is listed for this internal Codex model ID.' };
  if (/^gpt-oss-120b/.test(model)) return { source: 'https://ai.google.dev/gemini-api/docs/pricing', checked_at: '2026-10-26', reason: 'No API price is published for this Antigravity route. Other hosts have different prices.' };
  return null;
}
export function primeCatalogPrice(pricing, checkedAt) {
  if (!Number.isFinite(pricing?.input_usd_per_mtok) || !Number.isFinite(pricing?.output_usd_per_mtok)) return null;
  return { rates: [pricing.input_usd_per_mtok, pricing.cache_read_usd_per_mtok ?? null,
    pricing.cache_write_usd_per_mtok ?? null, pricing.output_usd_per_mtok],
    source: 'https://api.pinference.ai/api/v1/models', effective_at: pricing.effective_at,
    checked_at: checkedAt || null };
}

export function pricingFor(model, timestamp = Date.now(), serviceTier = 'standard') {
  const id = normalizePricingModel(model);
  const tier = serviceTier === 'priority' ? 'fast' : serviceTier === 'default' ? 'standard' : serviceTier || 'standard';
  const synced = livePrice(id, timestamp, tier);
  if (synced) return { ...synced, model: id, service_tier: tier };
  const value = catalog.get(id);
  if (!value) return null;
  let rates = value.rates;
  for (const change of value.changes || []) if (timestamp >= change.at) rates = change.rates;
  if (tier === 'fast') {
    if (!value.fast_rates) return null;
    rates = value.fast_rates;
  } else if (!['standard', 'default'].includes(tier)) return null;
  return scheduledPrice({ ...value, rates, model: id, service_tier: tier === 'default' ? 'standard' : tier,
    checked_at: tier === 'fast' ? value.fast_checked_at : value.checked_at }, timestamp);
}
const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
export function requestApiCost(model, usage, options = {}) {
  if (usage?.input_tokens === 0 && usage.output_tokens === 0) return 0;
  const price = options.priceFor ? options.priceFor(model, options.timestamp, options.service_tier)
    : options.price !== undefined ? options.price : pricingFor(model, options.timestamp, options.service_tier);
  if (!price || !Number.isFinite(usage?.input_tokens) || !Number.isFinite(usage?.output_tokens)) return null;
  for (const context of [...(price.context_tiers || [])].reverse()) if (usage.input_tokens > context.threshold) {
    return requestApiCost(model, usage, { price: { ...price, rates: context.rates, context_tiers: [], long: null } });
  }
  const [input, cachedRate, writeRate, output, longWriteRate = writeRate] = price.rates;
  const cached = Math.min(usage.input_tokens, count(usage.cached_input_tokens));
  const writes = Math.min(usage.input_tokens - cached, count(usage.cache_write_input_tokens));
  const longWrites = Math.min(writes, count(usage.cache_write_long_input_tokens));
  if (![input, output].every(value => Number.isFinite(value) && value >= 0) || cached && cachedRate == null || writes && writeRate == null || longWrites && longWriteRate == null) return null;
  const long = price.long && usage.input_tokens > price.long.threshold;
  return ((usage.input_tokens - cached - writes) * input + cached * (cachedRate || 0) +
    (writes - longWrites) * (writeRate || 0) + longWrites * (longWriteRate || 0)) * (long ? price.long.input_multiplier : 1) / 1e6 +
    usage.output_tokens * output * (long ? price.long.output_multiplier : 1) / 1e6;
}
export function estimateRequests(records, model, options = {}) {
  const rows = [...records], price = options.price !== undefined ? options.price : pricingFor(model, options.timestamp, options.service_tier);
  let usd = rows.length ? 0 : null, unpriced = 0;
  const tiers = new Set(), periods = new Set(), warnings = new Set();
  for (const record of rows) {
    const tier = record.service_tier || options.service_tier || 'standard';
    tiers.add(tier);
    const id = record.model || model, timestamp = record.timestamp ?? options.timestamp;
    const selected = options.priceFor ? options.priceFor(id, timestamp, tier)
      : options.price !== undefined ? options.price : pricingFor(id, timestamp, tier);
    if (selected?.price_period) periods.add(selected.price_period);
    if (selected?.estimated) warnings.add(selected.estimated);
    const cost = requestApiCost(id, record.usage || record, { price: selected });
    if (cost === null) unpriced++; else usd += cost;
  }
  const rates = price?.rates;
  return { usd: unpriced ? null : usd, currency: 'USD', model, pricing_date: price?.checked_at || null,
    service_tiers: [...tiers],
    price_periods: [...periods],
    estimated: [...warnings],
    source: price?.source || null, request_count: rows.length, unpriced_requests: unpriced,
    rates_per_million: rates ? { input: rates[0], cached_input: rates[1], cache_writes: rates[2], output: rates[3], long_cache_writes: rates.length > 4 ? rates[4] : rates[2] } : null,
    long_context: price?.long || null,
    context_tiers: price?.context_tiers || [],
    basis: `${tiers.size > 1 ? 'Mixed-speed' : tiers.has('fast') || tiers.has('priority') ? 'Fast' : 'Standard'} API-equivalent token estimate, including reported cache reads and writes. Subscription charges, sandbox fees and unreported usage are excluded.` +
      (periods.size ? ' Peak/off-peak rates are selected per recorded request timestamp.' : '') +
      (warnings.size ? ' ' + [...warnings].join(' ') : '') +
      (unpriced ? ' A verified price is missing for some usage; no complete dollar estimate is available.' : '') };
}
