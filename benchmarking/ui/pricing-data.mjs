import { pricingFor, pricingModels, primeCatalogPrice, livePrice, pricingGap } from '../token-pricing.mjs';
import { modelIdentity } from '../model-catalog/normalize.mjs';
import { modelSlug, modelSpeed } from './model-label.mjs';

const primaryProvider = model => model.startsWith('gpt-') ? 'codex' : model.startsWith('claude-') ? 'claude-code'
  : model.startsWith('gemini-') ? 'antigravity' : model.startsWith('grok-') ? 'grok-build'
    : model.startsWith('muse-') ? 'muse-code' : model.startsWith('deepseek-') ? 'deepseek-harness' : 'kimi-code';
export const configuredModels = () => pricingModels().map(id => ({ id, provider: primaryProvider(id) }));
const validRate = rate => Number.isFinite(rate) && rate >= 0;

// Keep routes separate: a Prime-hosted model must use Prime's prices, even
// when the same model has a published direct-provider price.
export function pricingRows({ models = [], runs = [], catalogs = {}, now = Date.now() } = {}) {
  const entries = new Map();
  const add = (model, speed, run = null) => {
    const provider = model.provider === 'prime' ? 'prime-agent' : model.provider || 'codex';
    const identity = modelIdentity({ ...model, provider });
    const normalized = pricingFor(identity.id, now)?.model || identity.id;
    const key = `${provider}:${normalized}:${speed}`;
    let row = entries.get(key);
    if (!row) {
      row = { key, model: identity.id, slug: modelSlug(identity.id), provider, speed, ids: new Set(), variants: [], runs: 0 };
      entries.set(key, row);
    }
    row.ids.add(model.id);
    if (run) row.runs++;
    else row.variants.push(model);
  };
  for (const model of models) {
    for (const speed of model.speed_options || [modelIdentity(model).speed]) add(model, speed);
  }
  for (const run of runs) if (run.model) add({ id: run.model, provider: run.provider }, modelSpeed(run), run);
  return [...entries.values()].map(row => {
    const candidates = row.variants.length ? row.variants : [...row.ids].map(id => ({ id }));
    const checked = catalogs[row.provider]?.updated_at;
    const prices = candidates.map(model => row.provider === 'prime-agent'
      ? livePrice(model.id, now, 'standard', 'prime') || primeCatalogPrice(model.pricing, checked ? new Date(checked).toISOString().slice(0, 10) : null)
      : pricingFor(model.id, now, modelIdentity({ ...model, provider: row.provider }).speed === 'fast' ? 'standard' : row.speed));
    const price = prices.find(Boolean) || null;
    const rates = price?.rates || [];
    const missing = [['Input', 0], ['Cached input', 1], ['Cache write', 2], ['Output', 3]].filter(([, i]) => !validRate(rates[i])).map(([label]) => label);
    const gap = !price ? [...row.ids].map(pricingGap).find(Boolean) : null;
    const status = !price ? gap ? 'unpublished' : 'missing' : missing.length || prices.some(value => !value) ? 'partial' : price.estimated ? 'estimated' : 'configured';
    return { ...row, ids: [...row.ids], variants: undefined, price, missing, status, gap,
      stale: Boolean(catalogs[row.provider]?.stale),
      reason: gap ? gap.reason : !price ? `No ${row.speed === 'fast' ? 'Fast ' : ''}rates published by the configured sources yet. Automatically rechecked.`
        : missing.length ? `${missing.join(', ')} ${missing.length === 1 ? 'rate is' : 'rates are'} not published by this source. Automatically rechecked; never assumed free.${row.provider === 'prime-agent' ? ' This does not mean caching is disabled. Runs use Prime-reported response costs when available.' : ''}`
          : prices.some(value => !value) ? 'Some model IDs in this group have no rates.' : '' };
  }).sort((a, b) => a.slug.localeCompare(b.slug, undefined, { numeric: true }) || a.provider.localeCompare(b.provider) || b.speed.localeCompare(a.speed));
}
