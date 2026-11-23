import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PricingService } from '../benchmarking/pricing-service.mjs';
import { parseOpenAI, parseClaude, parseGrok, parseMeta, parseGoogle, parseKimi, parseModelCatalog, parsePrime } from '../benchmarking/pricing-sources.mjs';
import { installPricingSnapshot, pricingFor, requestApiCost, livePrice } from '../benchmarking/token-pricing.mjs';

test('official table adapters distinguish Standard, Fast, context and cache prices', () => {
  const openai = parseOpenAI(`### Standard pricing data
| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| gpt-next | $1 | $5 | $0.05 | $1.25 | $2.50 | $2 | $7.50 | $0.10 | $2.50 | $5 |
### Batch pricing data
| gpt-next | $0.50 | $2.50 | $0.025 |
### Fast pricing data
| Model | Short context input | Short context output |
| gpt-next | $2 | $10 | $0.10 | $2.50 | $5 | $4 | $15 | $0.20 | $5 | $10 |
### Other
Long context: >272K input tokens.`);
  assert.equal(openai.length, 2); assert.deepEqual(openai[0].price.rates, [1, .05, 1.25, 5, 2.5]);
  assert.equal(requestApiCost('unused', { input_tokens: 300000, output_tokens: 10000 }, { price: openai[1].price }), 1.3499999999999999);
  assert.throws(() => parseOpenAI('Changed provider format'));
  const claude = parseClaude(`## Model pricing
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| Claude Opus 9 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |
## Cloud platform pricing
### Fast mode pricing
| Claude Opus 9 | $8 / MTok | $40 / MTok |
Prompt caching multipliers apply on top of fast mode pricing.
### Batch pricing`);
  assert.deepEqual(claude[1].price.rates, [8, .4, 10, 40, 16]);
  const grok = parseGrok(`### Text API Pricing
| Model | Context | Input / 1M tokens | Cached input / 1M tokens | Output / 1M tokens |
| grok-9 (< 200k prompt tokens) | 500k | $2 | $0.50 | $6 |
| grok-9 (≥ 200k prompt tokens) | 500k | $4 | $1 | $12 |
### Imagine Pricing`);
  assert.equal(grok[0].price.context_tiers[0].threshold, 199999);
  assert.equal(requestApiCost('grok-9', { input_tokens: 200000, cached_input_tokens: 100000, output_tokens: 10000 }, { price: grok[0].price }), .62);
});

test('Meta Contributor, Google scheduled prices and Kimi embedded data stay distinct', () => {
  const meta = parseMeta(`## Model pricing
### Muse Example
Models: \`muse-example-1.0\` and \`muse-example-1.0-contributor\`.
| Usage | Standard mode (per 1M tokens) | Contributor mode (per 1M tokens) |
| Input | $4 | Not available |
| Cached input | $0.2 | Not available |
| Output | $20 | Not available |
No long-context premium
## Rate limits`);
  assert.equal(meta.length, 1);
  const google = parseGoogle(`<h2><code>gemini-next</code></h2><table>
<tr><th></th><th>Free Tier</th><th>Paid Tier, per 1M tokens in USD</th></tr>
<tr><td>Input price</td><td>Free</td><td>$2 through November 30, 2026. $4 starting December 1, 2026.</td></tr>
<tr><td>Output price</td><td>Free</td><td>$10 through November 30, 2026. $20 starting December 1, 2026.</td></tr>
<tr><td>Context caching price</td><td>Free</td><td>$0.1 through November 30, 2026. $0.2 starting December 1, 2026.</td></tr></table>`);
  assert.equal(google[0].price.rates[0], 2); assert.deepEqual(google[0].price.changes[0].rates, [4,.2,4,20]);
  const kimi = parseKimi('columns:[{title:`Model`},{title:`Input`},{title:`Output`},{children:`Cached Input`},{children:`5m writes`},{children:`1h writes`}],rows:[[_jsx(a,{children:`kimi-next`}),`$2.00 / MTok`,`$10.00 / MTok`,`$0.20 / MTok`,`$2.00 / MTok`,`$4.00 / MTok`]]})');
  assert.deepEqual(kimi[0].price.rates, [2, .2, 2, 10, 4]);
});

test('structured catalogs never invent cache prices or use subscription zero placeholders', () => {
  const providers = Object.fromEntries(['openai','anthropic','google','moonshotai','meta','xai'].map(id => [id,{models:{}}]));
  providers.openai.models['new-model'] = { modalities: { output: ['text'] }, cost: { input: 2, output: 4, cache_read: 0 } };
  providers.openai.models['subscription-model'] = { modalities: { output: ['text'] }, cost: { input: 0, output: 0 } };
  const values = parseModelCatalog(JSON.stringify(providers));
  assert.equal(values.length, 1); assert.deepEqual(values[0].price.rates, [2,0,null,4,null]);
  assert.equal(requestApiCost('new-model', { input_tokens: 10, output_tokens: 1, cache_write_input_tokens: 2 }, { price: values[0].price }), null);
  const prime = parsePrime(JSON.stringify({data:[{id:'vendor/model',pricing:{input_usd_per_mtok:2,output_usd_per_mtok:4,cache_read_usd_per_mtok:null}}]}));
  assert.equal(prime[0].key, 'prime:vendor/model:standard'); assert.equal(prime[0].price.rates[1], null);
});

test('refresh persists future models, preserves history, retries failures and survives offline restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mazebench-prices-')), file = path.join(dir, 'catalog.json');
  let now = 2000, input = 2, calls = 0, fail = false;
  const source = { id: 'fixture', url: 'https://provider.example/prices', parse: JSON.parse };
  const fetcher = async () => { calls++; if (fail) throw new Error('offline'); return new Response(JSON.stringify([
    {key:'direct:future-model:standard',price:{rates:[input,.1,1,4]}},
    {key:'prime:future-model:standard',price:{rates:[9,null,null,20]}}
  ])); };
  try {
    const service = new PricingService({file,sources:[source],fetcher,now:()=>now});
    await Promise.all([service.refresh(),service.refresh()]); assert.equal(calls, 1);
    now = 3000; input = 3; await service.refresh(true);
    const snapshot = JSON.parse(await readFile(file, 'utf8')); installPricingSnapshot(snapshot);
    assert.equal(pricingFor('future-model',2500).rates[0], 2);
    assert.equal(pricingFor('future-model',3500).rates[0], 3);
    assert.equal(livePrice('future-model',3500,'standard','prime').rates[0], 9);
    assert.equal(snapshot.entries['direct:future-model:standard'].versions.length, 2);
    now = 4000; fail = true; await service.refresh(true);
    assert.equal(service.snapshot.sources.fixture.error, 'offline'); assert.equal(service.snapshot.sources.fixture.checked_at, new Date(3000).toISOString());
    const restarted = new PricingService({file,sources:[source],fetcher,now:()=>now}); await restarted.ready;
    assert.equal(restarted.snapshot.entries['direct:future-model:standard'].versions.at(-1).price.rates[0], 3);
    await restarted.refresh(); assert.equal(calls, 3, 'retry backoff survives restart');
  } finally { installPricingSnapshot(null); await rm(dir, { recursive: true, force: true }); }
});

test('official prices beat fallback and malformed updates keep the last working rates', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mazebench-prices-'));
  let corrupt = false;
  const sources = [{id:'fallback',url:'https://fallback.example',parse:JSON.parse,priority:1},{id:'official',url:'https://provider.example',parse:JSON.parse}];
  const fetcher = async url => new Response(JSON.stringify([{key:'direct:next:standard',price:{rates:[url.includes('provider') ? corrupt ? -1 : 3 : 99,.1,1,4]}}]));
  try {
    const service = new PricingService({file:path.join(dir,'prices.json'),sources,fetcher});
    await service.refresh(); assert.equal(service.snapshot.entries['direct:next:standard'].versions.at(-1).price.rates[0],3);
    corrupt = true; await service.refresh(true);
    assert(service.snapshot.sources.official.error); assert.equal(service.snapshot.entries['direct:next:standard'].versions.at(-1).price.rates[0],3);
  } finally { await rm(dir, {recursive:true,force:true}); }
});

test('known harness aliases resolve without dropping model identity or inventing Fast rates', () => {
  assert.equal(pricingFor('claude-opus-4-5-20251101').rates[0],5);
  assert.equal(pricingFor('claude-opus-5-5-high').rates[0],4);
  assert.equal(pricingFor('claude-opus-5-5-high',Date.now(),'fast').rates[0],8);
  assert.equal(pricingFor('k3-256k').rates[0],3);
  assert.equal(pricingFor('kimi-for-coding-highspeed').rates[0],1.9);
  assert.equal(pricingFor('kimi-for-coding'),null);
  assert.equal(pricingFor('gpt-unknown',Date.now(),'fast'),null);
});
