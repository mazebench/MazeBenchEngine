// Public Sign in with ChatGPT registration. Tokens are stored in the stock
// pi-ai credential format so its locked refresh path owns subsequent rotation.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { authHome, runtimeHome, cliPath, credentialFile } from './policy.mjs';

const issuer = 'https://auth.openai.com', resource = 'https://api.openai.com/v1';
const scopes = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const secret = () => randomBytes(32).toString('base64url');
const read = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } };
async function save(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

export async function startChatGPTSignIn({ home = authHome(), installation = runtimeHome(), fetcher = fetch, verifyIdentity } = {}) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const hostFile = path.join(home, 'mazebench-chatgpt-host.json');
  try { await writeFile(hostFile, JSON.stringify({ id: 'urn:uuid:' + randomUUID() }), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const host = await read(hostFile);
  if (!/^urn:uuid:[a-f0-9-]{36}$/.test(host.id)) throw new Error('Invalid saved ChatGPT host identity.');
  const registrationFile = path.join(home, 'mazebench-chatgpt-registration.json');
  const registered = await read(registrationFile), state = secret(), nonce = secret(), verifier = secret();
  const clientId = registered.client_id || 'dynamic_agent_client';
  const require = createRequire(cliPath(installation));
  const { createRemoteJWKSet, jwtVerify } = await import(pathToFileURL(require.resolve('jose')).href);
  const keys = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'));
  verifyIdentity ||= async (token, audience) => (await jwtVerify(token, keys, { issuer, audience })).payload;
  let resolve, reject, used = false, redirectUri, authorization, result, signInError;
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  // The caller can attach its result handler after presenting the local URL.
  done.catch(() => {});
  const server = createServer(async (req, res) => {
    const reply = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' }); res.end(text); };
    if (req.method !== 'GET' || req.headers.host !== new URL(redirectUri).host) return reply(403, 'Local sign-in only.');
    const url = new URL(req.url, redirectUri);
    if (url.pathname === '/connected' && result) {
      reply(200, '<title>MazeBench connected</title><h1>ChatGPT plan usage connected</h1><p>You can return to MazeBench. Tokens were saved privately on this computer.</p>');
      resolve(result); clearTimeout(timer); server.close(); server.closeIdleConnections(); return;
    }
    if (url.pathname === '/failed' && signInError) {
      reply(400, '<title>Connection incomplete</title><h1>Connection incomplete</h1><p>Return to MazeBench for details. No usable connection was saved.</p>');
      reject(signInError); clearTimeout(timer); server.close(); server.closeIdleConnections(); return;
    }
    if (url.pathname === '/') return reply(200, '<title>MazeBench — ChatGPT connection</title><main style="font:18px system-ui;max-width:640px;margin:80px auto"><h1>MazeBench DeepSeek Harness</h1><p>Connect your ChatGPT account to use eligible plan usage and credits for benchmark runs. This does not grant access to your ChatGPT conversations.</p><a href="/start" data-oai-siwc-button>Continue with ChatGPT</a><p><a href="https://chatgpt.com/settings/usage">Manage ChatGPT usage</a></p></main>');
    if (url.pathname === '/start' && !used) { res.writeHead(302, { Location: authorization, 'Cache-Control': 'no-store' }); return res.end(); }
    if (url.pathname !== '/auth/callback') return reply(404, 'Not found.');
    if (used || url.searchParams.get('state') !== state) return reply(400, 'Invalid or expired sign-in state.');
    used = true;
    try {
      if (url.searchParams.has('error')) throw new Error('ChatGPT sign-in was declined.');
      const issued = url.searchParams.get('client_id') || (clientId !== 'dynamic_agent_client' ? clientId : null);
      const code = url.searchParams.get('code');
      if (!issued?.startsWith('oaiapp_') || !code || clientId !== 'dynamic_agent_client' && issued !== clientId) throw new Error('ChatGPT registration did not return the expected client.');
      // Keep the issued registration if a one-time authorization code expires.
      await save(registrationFile, { ...registered, client_id: issued });
      const response = await fetcher(issuer + '/api/accounts/oauth/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: issued,
          code, code_verifier: verifier, redirect_uri: redirectUri, resource }) });
      if (!response.ok) throw new Error(`ChatGPT authorization exchange returned HTTP ${response.status}. Run setup again.`);
      const token = await response.json(), granted = String(token.scope || '').split(/\s+/);
      if (!token.access_token || !token.refresh_token || !token.id_token || !(token.expires_in > 0)) throw new Error('ChatGPT returned incomplete credentials.');
      const identity = await verifyIdentity(token.id_token, issued);
      if (identity.nonce !== nonce || !identity.sub || registered.subject && identity.sub !== registered.subject) throw new Error('ChatGPT identity verification failed.');
      if (!granted.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan usage was not enabled. Run setup again and enable plan usage.');
      await save(registrationFile, { client_id: issued, subject: identity.sub, email: identity.email, id_token: token.id_token });
      await save(credentialFile(home, 'openai'), { version: 1, records: { 'llm-pi-ai/openai': { kind: 'grant', payload: {
        type: 'oauth', access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000 - 30000, clientId: issued, scopes: granted
      } } } });
      result = { connected: true, sharing: true, email: identity.email };
      // Drop the redeemed authorization code from the visible address bar.
      res.writeHead(303, { Location: '/connected', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end();
    } catch (error) {
      signInError = error;
      res.writeHead(303, { Location: '/failed', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  redirectUri = origin + '/auth/callback';
  const params = new URLSearchParams({ client_id: clientId, ext_agent_host_id: host.id,
    ...(clientId === 'dynamic_agent_client' ? { agent_name_hint: 'MazeBench DeepSeek Harness' } : {}),
    ...(registered.id_token ? { id_token_hint: registered.id_token } : {}),
    response_type: 'code', redirect_uri: redirectUri, scope: scopes.join(' '), resource, state, nonce,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  authorization = issuer + '/api/accounts/authorize?' + params;
  const timer = setTimeout(() => { server.close(); server.closeAllConnections(); reject(new Error('ChatGPT sign-in expired. Run setup again.')); }, 10 * 60000);
  return { url: origin, done, close() { clearTimeout(timer); server.close(); server.closeAllConnections(); } };
}
