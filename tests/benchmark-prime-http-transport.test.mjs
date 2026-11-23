import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Agent, fetch as undiciFetch } from 'undici';
import { createPrimeFetch, PRIME_COMPLETIONS_URL, PRIME_HTTP_TIMEOUT } from '../benchmarking/prime-http-transport.mjs';

test('only Prime inference transport changes; model settings, tools, credentials and cancellation are passed through unchanged', async () => {
  const calls = [], dispatcher = {}, signal = new AbortController().signal;
  const options = { method: 'POST', headers: { Authorization: 'Bearer fixture' }, signal,
    body: JSON.stringify({ model: 'qwen/qwen3.8-27b', reasoning_effort: 'xhigh', max_tokens: 131072, tools: [{ type: 'function' }] }) };
  const fetch = createPrimeFetch({ dispatcher, send: async (...args) => { calls.push(['prime', ...args]); return 'prime'; },
    fallback: async (...args) => { calls.push(['other', ...args]); return 'other'; } });
  assert.equal(await fetch(PRIME_COMPLETIONS_URL, options), 'prime');
  assert.deepEqual(calls[0][2], { ...options, dispatcher });
  assert.equal(calls[0][2].signal, signal);
  assert.equal(await fetch('http://127.0.0.1:8080/health', options), 'other');
  assert.equal(await fetch('https://api.pinference.ai/api/v1/models', { method: 'GET' }), 'other');
  assert.equal(await fetch(PRIME_COMPLETIONS_URL + '/other', options), 'other');
  assert(PRIME_HTTP_TIMEOUT > 20 * 60 * 1000);
});

test('dedicated HTTP agent permits delayed reasoning responses and still honors abort', async t => {
  const server = createServer((req, res) => { req.resume(); setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end('{"choices":[]}'); }, 120); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dispatcher = new Agent({ headersTimeout: PRIME_HTTP_TIMEOUT, bodyTimeout: PRIME_HTTP_TIMEOUT });
  t.after(async () => { await dispatcher.close(); server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await undiciFetch(url, { method: 'POST', body: '{}', dispatcher, signal: AbortSignal.timeout(2000) });
  assert.deepEqual(await response.json(), { choices: [] });
  await assert.rejects(undiciFetch(url, { dispatcher, signal: AbortSignal.timeout(20) }), /abort|timeout/i);
});
