import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fetchConnectionModels, describeModel, connectedCatalog, grokConnectedModel } from '../benchmarking/connections/catalog.mjs';
import { validateConnection } from '../benchmarking/connections/credentials.mjs';
import { ModelCatalog } from '../benchmarking/model-catalog/service.mjs';
import { groupModels } from '../benchmarking/model-catalog/normalize.mjs';
import { connectedModelConfig } from '../benchmarking/grok-connected/supervisor.mjs';
import { chatgptRequest, startChatGPTTransport } from '../benchmarking/grok-connected/chatgpt-transport.mjs';

const connection = { id: 'example', name: 'Example', api: 'openai-responses', auth: 'api-key', base_url: 'https://example.com/v1', key_ref: 'EXAMPLE_KEY' };
test('discovery follows account pagination and respects public ChatGPT visibility', async () => {
  const urls = [];
  const models = await fetchConnectionModels(connection, { token: 'fixture-only', fetcher: async (url, options) => {
    urls.push(url); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer fixture-only');
    return { ok: true, json: async () => urls.length === 1 ? { data: [{ id: 'new-one' }], has_more: true, last_id: 'new-one' } : { data: [{ id: 'new-two' }], has_more: false } };
  } });
  assert.deepEqual(models.map(m => m.id), ['new-one', 'new-two']); assert.match(urls[1], /after_id=new-one/);
  const plan = await fetchConnectionModels({ ...connection, auth: 'chatgpt' }, { token: 'fixture-only', fetcher: async () => ({ ok: true,
    json: async () => ({ models: [{ slug: 'shown', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] }) }) });
  assert.deepEqual(plan.map(m => m.slug), ['shown']);
  await assert.rejects(fetchConnectionModels(connection, { token: 'fixture', fetcher: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
});

test('new provider models keep exact slugs and conservative capabilities', () => {
  const discovered = describeModel({ id: 'vendor/future-model', context_length: 100000 }, connection);
  assert.equal(discovered.id, 'vendor/future-model'); assert.deepEqual(discovered.efforts, ['default']);
  assert.equal(discovered.model_profile.contextWindow, 100000);
  for (const id of ['text-embedding-3-small', 'gpt-image-1', 'whisper-1']) assert.equal(describeModel({ id }, connection), null);
  assert.equal(describeModel({ id: 'retired', lifecycle: 'retired' }, connection), null);
  const gpt = describeModel({ slug: 'future-reasoner', supported_reasoning_levels: ['low', 'high', 'ultra'] }, connection);
  assert.deepEqual(gpt.efforts, ['low', 'high']);
  const claude = describeModel({ id: 'claude-future', capabilities: { thinking: { types: { adaptive: { supported: true } } }, effort: { high: { supported: true }, max: { supported: true } } } },
    { ...connection, api: 'anthropic-messages' });
  assert.equal(claude.model_profile.compat.forceAdaptiveThinking, true);
  assert.deepEqual(grokConnectedModel(claude).efforts, ['high', 'max']);
  const oldClaude = grokConnectedModel({ ...claude, provider_capabilities: { thinking: { types: { adaptive: { supported: false } } } } });
  assert.deepEqual(oldClaude.efforts, ['default']);
  assert.match(connectedModelConfig({ projectRoot: '/fixture', runDirectory: '/run', selected: oldClaude }), /supports_reasoning_effort = false/);
});

test('Google AI Studio discovers Gemini endpoints with native pagination and API key headers', async () => {
  const google = validateConnection({ ...connection, api: 'google-generative-ai', base_url: 'https://generativelanguage.googleapis.com/v1beta' });
  assert.equal(google.catalog_provider, 'google');
  const urls = [];
  const rows = await fetchConnectionModels(google, { token: 'fixture-only', fetcher: async (url, options) => {
    urls.push(url);
    assert.deepEqual(options.headers, { 'x-goog-api-key': 'fixture-only' });
    assert.equal(options.redirect, 'error');
    const result = urls.length === 1
      ? { models: [{ name: 'models/gemini-4-neon', displayName: 'Gemini 4 Neon', supportedGenerationMethods: ['generateContent'],
        inputTokenLimit: 1048576, outputTokenLimit: 65536 }], nextPageToken: 'second' }
      : { models: [{ name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] }] };
    return { ok: true, json: async () => result };
  } });
  assert.equal(urls[0], google.base_url + '/models');
  assert.equal(new URL(urls[1]).searchParams.get('pageToken'), 'second');
  const models = rows.map(row => describeModel(row, google)).filter(Boolean);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'gemini-4-neon');
  assert.equal(models[0].model_profile.maxTokens, 65536);
  assert.deepEqual(models[0].efforts, ['default']);
});

test('same model on two billing connections is explicit and cannot be silently rerouted', async () => {
  const models = ['api', 'plan'].map(id => ({ ...describeModel({ id: 'same-model' }, { ...connection, id }), provider: 'grok-build' }));
  const catalog = new ModelCatalog({ cacheFile: null, sources: { 'grok-build': async () => ({ models, connections: [] }) } });
  assert.equal(groupModels(models).length, 2);
  await assert.rejects(catalog.selection({ provider: 'grok-build', model: 'same-model' }), /billing connection/);
  assert.equal((await catalog.selection({ provider: 'grok-build', model: 'same-model', connection_id: 'plan' })).connection_id, 'plan');
  models[1].connection_stale = true; models[1].connection_error = 'Plan expired';
  await assert.rejects(catalog.selection({ provider: 'grok-build', model: 'same-model', connection_id: 'plan' }), /Plan expired/);
  assert.equal((await catalog.selection({ provider: 'grok-build', model: 'same-model', connection_id: 'api' })).connection_id, 'api');
});

test('generic setup saves keys privately, discovers future additions and isolates catalog outages', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-connections-')); t.after(() => rm(temp, { recursive: true, force: true }));
  let rows = [{ id: 'vendor/model-one' }], broken = false;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-only');
    res.writeHead(broken ? 401 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: rows }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const registry = path.join(temp, 'connections.json');
  const result = await promisify(execFile)(process.execPath, ['scripts/setup-model-connection.mjs', '--id', 'fixture', '--api', 'openai-completions',
    '--base-url', `http://127.0.0.1:${server.address().port}/v1`, '--key-env', 'FIXTURE_SETUP_KEY'], {
    cwd: process.cwd(), env: { ...process.env, MAZEBENCH_DEEPSEEK_AUTH_HOME: temp, MAZEBENCH_CONNECTIONS_FILE: registry, FIXTURE_SETUP_KEY: 'fixture-only' }
  });
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-only/);
  const bytes = await readFile(registry, 'utf8'); assert.doesNotMatch(bytes, /fixture-only/);
  const configured = JSON.parse(bytes).connections;
  assert.equal((await stat(configured[0].credential_file)).mode & 0o777, 0o600);
  const first = await connectedCatalog({ configured, force: true }); assert.equal(first.models.length, 1);
  rows.push({ id: 'vendor/model-added-later' });
  const refreshed = await connectedCatalog({ configured, force: true }); assert.equal(refreshed.models.length, 2);
  assert.doesNotMatch(JSON.stringify(refreshed), /fixture-only/);
  broken = true;
  const stale = await connectedCatalog({ configured, force: true });
  assert.equal(stale.models.length, 2); assert.ok(stale.models.every(m => m.connection_stale)); assert.match(stale.connections[0].error, /401/);
});

test('credentials cannot be embedded in URLs or ChatGPT routed to other endpoints', () => {
  assert.throws(() => validateConnection({ ...connection, base_url: 'https://key@example.com' }));
  assert.throws(() => validateConnection({ ...connection, base_url: 'http://example.com' }));
  assert.throws(() => validateConnection({ ...connection, auth: 'chatgpt' }), /public OpenAI/);
  assert.equal(validateConnection({ ...connection, base_url: 'http://127.0.0.1:9090/v1' }).api, connection.api);
});

test('ChatGPT normalization preserves instructions and tools and requires authenticated local transport', async t => {
  const input = [{ role: 'system', content: [{ type: 'input_text', text: 'Exact original instructions.' }] }, { role: 'user', content: 'Play.' }];
  const tools = [{ type: 'function', name: 'use_tool', parameters: { type: 'object' } }];
  const body = chatgptRequest({ model: 'fixture', input, tools, store: true, stream: false, temperature: 0.2, max_output_tokens: 1000 }, 'fixture');
  assert.equal(body.input[0].role, 'developer'); assert.deepEqual(body.input[0].content, input[0].content);
  assert.equal(input[0].role, 'system'); assert.deepEqual(body.tools, tools);
  assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.temperature, undefined); assert.equal(body.max_output_tokens, undefined);
  assert.throws(() => chatgptRequest({ model: 'different', input }, 'fixture'));
  let requests = 0;
  const bridge = await startChatGPTTransport({ port: 0, connection: { ...connection, auth: 'chatgpt', base_url: 'https://api.openai.com/v1' }, model: 'fixture',
    fetcher: () => { requests++; throw new Error('Must not send inference.'); }, token: async () => 'fixture-only' });
  t.after(() => bridge.close());
  const base = `http://127.0.0.1:${bridge.port}`;
  assert.equal((await fetch(base + '/v1/models')).status, 403);
  const headers = { Authorization: 'Bearer ' + bridge.secret };
  assert.equal((await fetch(base + '/v1/models', { headers })).status, 200);
  assert.equal((await fetch(base + '/v1/models', { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + '/v1/chat/completions', { method: 'POST', headers })).status, 404);
  assert.equal(requests, 0);
});
