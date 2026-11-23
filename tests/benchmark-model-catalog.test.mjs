import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelCatalog } from '../benchmarking/model-catalog/service.mjs';
import { paginatedModels } from '../benchmarking/model-catalog/sources.mjs';
import { kimiModels, claudeModels, antigravityModels, grokModels, groupModels, resolveSelection } from '../benchmarking/model-catalog/normalize.mjs';
import { settings } from '../benchmarking/kimi-v2/policy.mjs';
import { argumentsFor } from '../benchmarking/antigravity-v2/policy.mjs';
import { buildClaudeArguments, createClaudeBoundaryValidator } from '../benchmarking/providers-v2/claude-policy.mjs';
import { buildCodeClaudeArguments } from '../benchmarking/code-v2/policy.mjs';
import { modelLabel, modelSlug, modelSpeed } from '../benchmarking/ui/model-label.mjs';
const entry = (id = 'k3') => ({ id, name: id, provider: 'kimi-code', efforts: ['low', 'high', 'max'], default_effort: 'high', context_limit: 1048576 });

test('catalog refresh coalesces requests, preserves last good data, persists it and rejects stale launches', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'model-catalog-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1000, calls = 0, fail = false, entries = [entry()];
  const options = { cacheFile: path.join(directory, 'cache.json'), now: () => now, ttl: 100, sources: { 'kimi-code': async () => { calls++; await new Promise(r => setTimeout(r, 10)); if (fail) throw new Error('offline'); return entries; } } };
  const catalog = new ModelCatalog(options);
  await Promise.all([catalog.all({ force: true }), catalog.all({ force: true })]); assert.equal(calls, 1);
  await catalog.all(); assert.equal(calls, 1);
  const spec = { provider: 'kimi-code', model: 'k3', effort: 'max' }; await catalog.selection(spec);
  fail = true; now += 101;
  const stale = await catalog.all(); assert(stale.catalogs['kimi-code'].stale); assert.equal(stale.models[0].id, 'k3');
  await assert.rejects(catalog.selection(spec), /offline/);
  const restored = new ModelCatalog(options); assert.equal((await restored.all()).models[0].id, 'k3');
  fail = false; entries = [entry('k3.1-pro')];
  const fresh = await restored.all({ force: true }); assert.equal(fresh.models[0].id, 'k3.1-pro'); assert.equal(fresh.catalogs['kimi-code'].stale, false);
  await assert.rejects(restored.selection(spec), /no longer available/);
  await assert.rejects(restored.selection({ ...spec, model: 'k3.1-pro', effort: 'ultracode' }), /reasoning/);
  await assert.rejects(restored.selection({ ...spec, model: 'k3.1-pro', service_tier: 'fast' }), /speed/);
});
test('all model pages load; broken pagination fails instead of claiming a complete catalog', async () => {
  const calls = [];
  const fetcher = async url => { calls.push(String(url)); return Response.json(url.searchParams.has('after_id') ? { data: [{ id: 'old-version' }], has_more: false } : { data: [{ id: 'new-version' }], has_more: true, last_id: 'new-version' }); };
  assert.deepEqual((await paginatedModels('https://example.com/models', {}, fetcher)).data.map(m => m.id), ['new-version', 'old-version']);
  assert.match(calls[1], /after_id=new-version/);
  await assert.rejects(paginatedModels('https://example.com/models', {}, async () => Response.json({ data: [{ id: 'same' }], has_more: true })), /did not advance/);
});
test('Kimi keeps earlier versions, separates fast, and never merges different models sharing an alias prefix', () => {
  const models = kimiModels({ data: ['k3', 'k3-256k', 'k3.1-pro', 'k3.1-pro-highspeed', 'kimi-for-coding', 'kimi-for-coding-highspeed'].map(id => ({ id, display_name: id === 'kimi-for-coding' ? 'K2.8 Preview' : id === 'kimi-for-coding-highspeed' ? 'K2.7 Code Highspeed' : id,
    context_length: 262144, ...(id.endsWith('coding-highspeed') ? {} : { reasoning: { effort: { valid: ['low', 'high', 'max'], default: 'high' } } }) } )) });
  assert.equal(models.length, 6); const groups = groupModels(models); assert.equal(groups.length, 5);
  const pro = groups.find(m => m.id === 'k3.1-pro');
  assert.equal(resolveSelection(pro, { speed: 'fast', effort: 'max' }).id, 'k3.1-pro-highspeed');
  assert.equal(resolveSelection(pro, { speed: 'standard', effort: 'high' }).id, 'k3.1-pro');
  assert.equal(resolveSelection(pro, { speed: 'fast', effort: 'medium' }), null);
  assert.equal(groups.find(m => m.id === 'kimi-for-coding').name, 'Kimi K2.8 Preview');
  assert.equal(groups.find(m => m.id === 'kimi-k2.7-code').name, 'Kimi K2.7 Code');
  assert.equal(models.at(-1).default_effort, 'default');
  const config = settings({ model: 'kimi-for-coding-highspeed', effort: 'default', efforts: ['default'], contextLimit: 262144 });
  assert(!/^effort\s*=/m.test(config)); assert.match(config, /enabled = true/);
});
test('Antigravity groups all effort presets, including non-Gemini models, without altering real Flash/Pro/Max names', () => {
  const models = antigravityModels('gemini-4-argon-low\tGemini 4 Argon (Low)\ngemini-4-argon-high\tGemini 4 Argon (High)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)');
  const groups = groupModels(models); assert.equal(groups.length, 3); assert.equal(groups[0].name, 'Gemini 4 Argon');
  const selected = resolveSelection(groups[0], { effort: 'high' }); assert.equal(selected.id, 'gemini-4-argon-high');
  const args = argumentsFor({ model: selected.id, prompt: 'test', logFile: '/tmp/log' }); assert.equal(args[args.indexOf('--model') + 1], selected.id);
  const prime = groupModels([{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'prime-agent', efforts: ['default'], direct_efforts: ['max'], default_effort: 'default' }])[0];
  assert.equal(prime.name, 'DeepSeek V4.1 Flash'); assert(resolveSelection(prime, { effort: 'max' })); assert.equal(resolveSelection(prime, { effort: 'max', coding_mode: 'python' }), null);
  assert.equal(modelLabel('gemini-3.8-flash-high'), 'gemini-3.8-flash');
  assert.equal(modelLabel('grok-4.7-build-fast'), 'grok-4.7'); assert.equal(modelSpeed({ model: 'grok-4.7-build-fast' }), 'fast');
  for (const [id, label] of [
    ['meta/muse-spark-open', 'muse-spark-open'], ['qwen/Qwen3.8-27B', 'qwen3.8-27b'],
    ['nvidia/nemotron-3.5-lightning', 'nemotron-3.5-lightning'], ['deepseek/deepseek-v4.1-flash', 'deepseek-v4.1-flash'],
    ['k3.1-pro', 'kimi-k3.1-pro'], ['k3.1-pro-highspeed', 'kimi-k3.1-pro'], ['moonshotai/kimi-k3', 'kimi-k3'],
    ['kimi-for-coding', 'kimi-k2.8-preview'], ['kimi-for-coding-highspeed', 'kimi-k2.7-code'],
    ['Meta Muse Spark 1.3', 'meta-muse-spark-1.3']
  ]) assert.equal(modelSlug(id), label);
  assert.equal(modelSlug('gpt-6.1-terra', 'GPT 6.1 Terra'), 'gpt-6.1-terra');
});
test('Grok uses cache capabilities and combines its documented fast routing variant', () => {
  const models = grokModels({ models: Object.fromEntries(['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6'].map(id => [id, { info: { id, name: id, reasoning_effort: 'high', reasoning_efforts: [{ id: 'high' }, { id: 'xhigh' }] }, api_key: 'must-not-escape' }])) });
  assert.equal(groupModels(models).length, 2); assert.deepEqual(models[0].efforts, ['high', 'xhigh']); assert(!JSON.stringify(models).includes('must-not-escape'));
});
test('Claude older versions use their own capabilities and speed is an explicit per-run setting', () => {
  const catalog = claudeModels({ data: [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', capabilities: { effort: { supported: true, high: { supported: true }, max: { supported: true } } } }, { id: 'claude-haiku-4-5-20251001', capabilities: {} }] });
  assert.deepEqual(catalog[0].speed_options, ['standard', 'fast']); assert.deepEqual(catalog[1].efforts, ['default']);
  for (const builder of [buildClaudeArguments, buildCodeClaudeArguments]) for (const speed of [null, 'fast']) {
    const args = builder({ projectRoot: process.cwd(), runDirectory: '/tmp/test', model: 'claude-opus-4-8', effort: 'max', serviceTier: speed, prompt: 'test' });
    assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).fastMode, speed === 'fast');
    assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-4-8'); assert.equal(args[args.indexOf('--effort') + 1], 'max');
    assert.equal(args[args.indexOf('--tools') + 1], ''); assert(args.includes('--restricted'));
  }
  assert(!buildClaudeArguments({ projectRoot: '/', runDirectory: '/tmp', model: catalog[1].id, effort: 'default', prompt: 'test' }).includes('--effort'));
  const guard = createClaudeBoundaryValidator({ model: 'claude-opus-4-8' }); assert(guard({ type: 'assistant', message: { model: 'claude-opus-5-5' } }));
});
