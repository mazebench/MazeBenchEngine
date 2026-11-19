import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startChatGPTSignIn } from '../benchmarking/deepseek/chatgpt-auth.mjs';
import { credentialFile, credentialRoutes } from '../benchmarking/deepseek/policy.mjs';

for (const scenario of ['success', 'wrong-nonce', 'missing-plan-scope']) test(`ChatGPT public registration: ${scenario}`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'maze-chatgpt-auth-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let authorization, exchanges = 0;
  const options = { home,
    fetcher: async (url, request) => {
      exchanges++;
      assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token');
      assert.equal(request.body.get('client_id'), 'oaiapp_fixture');
      assert.equal(request.body.get('resource'), 'https://api.openai.com/v1');
      assert.equal(request.body.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
      assert.equal(createHash('sha256').update(request.body.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
      return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id', expires_in: 3600,
        scope: scenario === 'missing-plan-scope' ? 'openid email' : 'openid email chatgpt.tokens.use.direct offline_access resource.invoke' });
    },
    verifyIdentity: async (token, audience) => {
      assert.equal(token, 'fixture-id'); assert.equal(audience, 'oaiapp_fixture');
      return { sub: 'fixture-user', email: 'user@example.test', nonce: scenario === 'wrong-nonce' ? 'wrong' : authorization.searchParams.get('nonce') };
    }
  };
  const flow = await startChatGPTSignIn(options); t.after(() => flow.close());
  const redirect = await fetch(flow.url + '/start', { redirect: 'manual' });
  authorization = new URL(redirect.headers.get('location'));
  assert.equal(authorization.origin, 'https://auth.openai.com');
  assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorization.searchParams.get('agent_name_hint'), 'MazeBench DeepSeek Harness');
  assert.match(authorization.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ code: 'fixture-code', client_id: 'oaiapp_fixture', state: 'wrong' });
  assert.equal((await fetch(callback)).status, 400); assert.equal(exchanges, 0);
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  const response = await fetch(callback);
  if (scenario !== 'success') {
    assert.equal(response.status, 400); await assert.rejects(flow.done, /verification failed|plan usage was not enabled/);
    await assert.rejects(readFile(credentialFile(home, 'openai')), { code: 'ENOENT' });
    return;
  }
  assert.equal(response.status, 200); assert.equal((await flow.done).sharing, true);
  assert.deepEqual(credentialRoutes(home), ['openai']);
  assert.equal((await stat(credentialFile(home, 'openai'))).mode & 0o777, 0o600);
  const again = await startChatGPTSignIn(options); t.after(() => again.close());
  const next = new URL((await fetch(again.url + '/start', { redirect: 'manual' })).headers.get('location'));
  assert.equal(next.searchParams.get('client_id'), 'oaiapp_fixture');
  assert.equal(next.searchParams.get('ext_agent_host_id'), authorization.searchParams.get('ext_agent_host_id'));
  assert.equal(next.searchParams.get('id_token_hint'), 'fixture-id');
  assert.equal(next.searchParams.has('agent_name_hint'), false);
});
