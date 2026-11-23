import { normalizePricingModel, primeCatalogPrice } from './token-pricing.mjs';
import { deepseekScheduleNote } from './pricing-schedule.mjs';

const dollars = cell => { const match = String(cell).match(/\$([\d.]+)/); return match ? Number(match[1]) : null; };
const clean = text => text.replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp);/g, ' ').replace(/\s+/g, ' ').trim();
const mdRows = text => text.split('\n').filter(line => line.startsWith('|')).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
const section = (text, start, end) => text.split(start)[1]?.split(end)[0] || '';
const htmlRows = text => [...text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(row => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(cell => clean(cell[1])));
const valid = value => Number.isFinite(value) && value >= 0;
export function validPrice(price) {
  return Array.isArray(price?.rates) && valid(price.rates[0]) && valid(price.rates[3]) &&
    price.rates.every(value => value == null || valid(value)) &&
    (price.context_tiers || []).every(tier => valid(tier.threshold) && validPrice({ rates: tier.rates })) &&
    (!price.time_schedule || price.time_schedule.kind === 'deepseek-utc-v1' && validPrice({ rates: price.time_schedule.peak_rates }));
}
function entry(model, rates, extra = {}, tier = 'standard', route = 'direct') {
  return { key: `${route}:${route === 'direct' ? normalizePricingModel(model) : model}:${tier}`, price: { rates, ...extra } };
}

export function parseOpenAI(text) {
  const entries = [];
  if (!text.includes('Long context: >272K input tokens.')) throw new Error('OpenAI context boundary changed; retaining last verified rates.');
  for (const tier of ['Standard', 'Fast']) {
    const block = section(text, `### ${tier} pricing data`, '###');
    if (!block.includes('| Model | Short context input |')) throw new Error(`${tier} pricing table missing`);
    for (const cells of mdRows(block)) {
      const model = cells[0].match(/^((?:gpt-|o\d)[\w.-]+)/)?.[1];
      if (!model || ![4, 11].includes(cells.length)) continue;
      const [, input, output, read, write, extended, longIn, longOut, longRead, longWrite, longExtended] = cells.map((cell, i) => i ? dollars(cell) : cell);
      const price = entry(model, [input, read, write ?? null, output, extended ?? null], {}, tier.toLowerCase());
      if (longIn != null && longOut != null) price.price.context_tiers = [{ threshold: 272000, rates: [longIn, longRead, longWrite, longOut, longExtended] }];
      if (validPrice(price.price)) entries.push(price);
    }
  }
  return entries;
}

export function parseClaude(text) {
  const entries = [], byModel = new Map();
  const block = section(text, '## Model pricing', '## Cloud platform pricing');
  if (!block.includes('5m cache writes') || !block.includes('1h cache writes')) throw new Error('Claude table schema changed');
  for (const cells of mdRows(block)) {
    const name = cells[0].match(/^Claude ([A-Za-z]+) (\d+(?:\.\d+)?)/);
    if (!name || cells.length !== 6) continue;
    const id = `claude-${name[1].toLowerCase()}-${name[2]}`, rates = [1, 4, 2, 5, 3].map(i => dollars(cells[i]));
    if (/prompts over/.test(cells[0])) {
      const threshold = Number(cells[0].match(/over ([\d,]+)/)?.[1].replaceAll(',', ''));
      if (byModel.has(id) && valid(threshold)) byModel.get(id).price.context_tiers = [{ threshold, rates }];
    } else if (validPrice({ rates })) { const value = entry(id, rates); entries.push(value); byModel.set(id, value); }
  }
  const fast = section(text, '### Fast mode pricing', '###');
  if (!fast.includes('multipliers')) throw new Error('Claude Fast caching policy changed');
  for (const cells of mdRows(fast)) {
    for (const name of cells[0].matchAll(/Claude ([A-Za-z]+) (\d+(?:\.\d+)?)/g)) {
      const id = `claude-${name[1].toLowerCase()}-${name[2]}`, base = byModel.get(id)?.price;
      const input = dollars(cells[1]), output = dollars(cells[2]);
      if (base && valid(input) && valid(output)) entries.push(entry(id, base.rates.map((rate, i) => i === 3 ? output : rate * input / base.rates[0]), {}, 'fast'));
    }
  }
  return entries;
}

export function parseGrok(text) {
  const entries = [], models = new Map();
  const block = section(text, '### Text API Pricing', '### Imagine Pricing');
  if (!block.includes('Cached input / 1M tokens')) throw new Error('Grok pricing columns changed');
  for (const cells of mdRows(block)) {
    const id = cells[0].match(/^(grok-[\w.-]+)/)?.[1];
    if (!id || cells.length !== 5) continue;
    const rates = [dollars(cells[2]), dollars(cells[3]), dollars(cells[2]), dollars(cells[4])];
    if (cells[0].includes('≥')) {
      const threshold = Number(cells[0].match(/≥ (\d+)k/)?.[1]) * 1000 - 1;
      if (models.has(id) && valid(threshold)) models.get(id).price.context_tiers = [{ threshold, rates }];
    } else if (validPrice({ rates })) { const value = entry(id, rates); entries.push(value); models.set(id, value); }
  }
  for (const match of text.matchAll(/## Grok ([\d.]+) Fast pricing[^\n]*\n([\s\S]*?)(?=\n## |$)/g)) {
    const rows = mdRows(match[2]).filter(row => /^(Below|Above) \d+k$/.test(row[0]));
    if (rows.length !== 2 || !match[2].includes('exceeds')) continue;
    const rates = row => [dollars(row[1]), dollars(row[2]), dollars(row[1]), dollars(row[3])];
    entries.push(entry(`grok-${match[1]}-build-fast`, rates(rows[0]), {
      context_tiers: [{ threshold: Number(rows[0][0].match(/\d+/)[0]) * 1000, rates: rates(rows[1]) }]
    }));
  }
  return entries;
}

export function parseMeta(text) {
  const entries = [];
  if (!text.includes('No long-context premium')) throw new Error('Meta context policy changed');
  for (const block of section(text, '## Model pricing', '## Rate limits').split('\n### ')) {
    const rows = mdRows(block), input = rows.find(row => row[0] === 'Input'), output = rows.find(row => row[0] === 'Output'), read = rows.find(row => row[0] === 'Cached input');
    if (!input || !output || !read || !rows[0]?.[1]?.startsWith('Standard mode')) continue;
    const ids = [...block.matchAll(/`(muse-[\w.-]+)`/g)].map(match => match[1]);
    for (const id of new Set(ids)) {
      const col = id.endsWith('-contributor') ? 2 : 1, i = dollars(input[col]);
      const value = entry(id, [i, dollars(read[col]), i, dollars(output[col])]);
      if (validPrice(value.price)) entries.push(value);
    }
  }
  return entries;
}

export function parseKimi(text) {
  // Kimi's Markdown omits its dynamic tables. Read literal table data embedded
  // in the HTML instead; never evaluate the embedded JavaScript.
  const entries = [];
  for (const table of text.matchAll(/columns:\[([\s\S]*?)\],rows:\[([\s\S]*?)\]\]\}\)/g)) {
    const headers = [...table[1].matchAll(/(?:title|children):`(Model|Input|Output|Cached Input|5m writes|1h writes)`/g)].map(m => m[1]);
    if (!['Model,Input,Output,Cached Input', 'Model,Input,Output,Cached Input,5m writes,1h writes'].includes(headers.join(','))) throw new Error('Kimi pricing column order changed');
    for (const row of table[2].matchAll(/children:`(kimi-[\w.-]+)`\}\),((?:`\$[\d.]+ \/ MTok`,?)+)/g)) {
      const values = [...row[2].matchAll(/\$([\d.]+)/g)].map(m => Number(m[1]));
      if (values.length !== headers.length - 1) throw new Error('Kimi pricing row changed');
      const [input, output, read, write = null, extended = null] = values;
      entries.push(entry(row[1], [input, read, write, output, extended]));
    }
  }
  return entries;
}

export function parseGoogle(text) {
  const entries = [];
  // Read only the first (Standard, paid) table in each model section. Never
  // mistake Free, Batch, Flex, Priority or storage prices for token prices.
  // AI Studio now serves Markdoc at the former Gemini pricing URL.
  const markdoc = text.includes('{% tab title="Standard" %}');
  for (const block of text.split(markdoc ? /^##\s+/m : /<h2\b/).slice(1)) {
    const id = markdoc ? block.match(/\[`(gemini-[\w.-]+)`\]/)?.[1]
      : block.match(/<code[^>]*>(gemini-[\w.-]+)<\/code>/)?.[1];
    if (!id || /(?:image|audio|tts|live|embedding)/.test(id)) continue;
    const standard = markdoc ? block.match(/\{% tab title="Standard" %\}([\s\S]*?)\{% \/tab %\}/)?.[1] || '' : block;
    const table = markdoc ? standard.match(/\{% table %\}([\s\S]*?)\{% \/table %\}/)?.[1]
      : standard.match(/<table\b[^>]*>([\s\S]*?)<\/table>/)?.[1];
    if (!table) continue;
    const rows = markdoc ? table.split(/^\s*---\s*$/m).map(row => row.split(/^\s*\*\s+/m).slice(1).map(clean)) : htmlRows(table);
    if (!rows[0]?.[2]?.includes('Paid Tier, per 1M tokens in USD')) continue;
    const values = [/^Input price/, /^Context caching price/, /^Output price/].map(re => rows.find(row => re.test(row[0]))?.[2]);
    if (values.some(cell => !cell) || values.some(cell => /(?:200[ ,]?000|200k|per image|per second)/i.test(cell))) continue;
    const [input, read, output] = values.map(dollars);
    const value = entry(id, [input, read, input, output]);
    if (!validPrice(value.price)) continue;
    const dates = values.map(cell => [...cell.matchAll(/\$([\d.]+) starting ([A-Za-z]+ \d+, \d{4})/g)]);
    if (dates.some(d => d.length)) {
      if (!dates.every(d => d.length === 1 && d[0][2] === dates[0][0][2])) continue;
      const [i, c, o] = dates.map(d => Number(d[0][1]));
      value.price.changes = [{ at: Date.parse(dates[0][0][2] + ' UTC'), rates: [i, c, i, o] }];
    } else if (values.some(cell => (cell.match(/\$/g) || []).length > 1)) continue;
    if (values[1].includes('Implicit caching only')) value.price.note = 'Implicit caching only; explicit caching is not supported. Cache creation is counted at the ordinary input rate. Output includes thinking tokens.';
    entries.push(value);
  }
  return entries;
}

export function parseDeepSeek(text) {
  const content = clean(text);
  if (!content.includes('per 1M tokens') || !content.includes('Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays.')) {
    throw new Error('DeepSeek units or peak schedule changed; retaining last verified rates.');
  }
  const table = [...text.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)]
    .map(match => htmlRows(match[1])).find(rows => rows[0]?.[0] === 'MODEL');
  if (!table) throw new Error('DeepSeek model table missing');
  const models = table[0].slice(1).map(cell => cell.match(/^(deepseek-[\w.-]+)(?:\s*\(\d+\))?$/)?.[1]);
  if (!models.length || models.some(id => !id)) throw new Error('DeepSeek model columns changed');
  const priceRows = table.filter(row => row.includes('OFF-PEAK') || row.includes('PEAK'));
  const labels = ['CACHE HIT', null, 'CACHE MISS', null, 'OUTPUT TOKENS', null];
  if (priceRows.length !== 6 || priceRows.some((row, i) =>
    row.at(-models.length - 1) !== (i % 2 ? 'PEAK' : 'OFF-PEAK') ||
    labels[i] && !row.join(' ').includes(labels[i]) ||
    row.slice(-models.length).some(cell => !/^\$\d+(?:\.\d+)?$/.test(cell)))) {
    throw new Error('DeepSeek price rows changed; retaining last verified rates.');
  }
  const entries = models.map((model, col) => {
    const rates = offset => [2, 0, 2, 4].map(i => dollars(priceRows[i + offset].at(-models.length + col)));
    return entry(model, rates(0), { time_schedule: { kind: 'deepseek-utc-v1', peak_rates: rates(1) }, note: deepseekScheduleNote });
  });
  // Only map aliases the provider explicitly says are served at Flash prices.
  if (content.includes('legacy names') && content.includes('billed at the Flash price')) {
    const flash = entries.find(value => value.key === 'direct:deepseek-flash:standard');
    if (flash) for (const alias of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      if (content.includes(alias)) entries.push(entry(alias, flash.price.rates, { ...flash.price }));
    }
  }
  return entries;
}

export function parseModelCatalog(text) {
  const data = JSON.parse(text), entries = [];
  for (const provider of ['openai', 'anthropic', 'google', 'moonshotai', 'meta', 'xai']) {
    if (!data[provider]?.models) throw new Error(`Model catalog missing ${provider}`);
    for (const [id, model] of Object.entries(data[provider].models)) {
      const cost = model.cost;
      // All-zero subscription placeholders and unsupported modalities are not prices.
      if (!cost || !(cost.input > 0 || cost.output > 0) || !model.modalities?.output?.includes('text')) continue;
      const rates = c => [c.input, c.cache_read ?? null, c.cache_write ?? null, c.output, null];
      const value = entry(id, rates(cost), { catalog_updated_at: model.last_updated, provider_source: data[provider].doc,
        note: 'Maintained models.dev catalog; official provider rates take precedence.' });
      const tiers = cost.tiers || (cost.context_over_200k ? [{ ...cost.context_over_200k, tier: { type: 'context', size: 200000 } }] : []);
      if (tiers.some(tier => tier.tier?.type !== 'context' || !valid(tier.tier.size))) continue;
      if (tiers.length) value.price.context_tiers = tiers.map(tier => ({ threshold: tier.tier.size, rates: rates(tier) })).sort((a,b) => a.threshold - b.threshold);
      if (validPrice(value.price)) entries.push(value);
    }
  }
  return entries;
}

export function parsePrime(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.data)) throw new Error('Prime catalog schema changed');
  return data.data.flatMap(model => { const price = primeCatalogPrice(model.pricing); return price ? [entry(model.id, price.rates, { effective_at: price.effective_at }, 'standard', 'prime')] : []; });
}

export const pricingSources = [
  { id: 'deepseek', url: 'https://api-docs.deepseek.com/quick_start/pricing', parse: parseDeepSeek },
  { id: 'openai', url: 'https://developers.openai.com/api/docs/pricing.md', parse: parseOpenAI },
  { id: 'claude', url: 'https://platform.claude.com/docs/en/about-claude/pricing.md', parse: parseClaude },
  { id: 'grok', url: 'https://docs.x.ai/developers/pricing.md', parse: parseGrok },
  { id: 'meta', url: 'https://dev.meta.ai/docs/pricing-rate-limits.md', parse: parseMeta },
  { id: 'kimi', url: 'https://platform.kimi.ai/docs/pricing/chat', parse: parseKimi },
  { id: 'google', url: 'https://ai.google.dev/gemini-api/docs/pricing?hl=en', parse: parseGoogle },
  { id: 'prime', url: 'https://api.pinference.ai/api/v1/models', parse: parsePrime },
  { id: 'modelsdev', url: 'https://models.dev/api.json', parse: parseModelCatalog, priority: 1 }
];
