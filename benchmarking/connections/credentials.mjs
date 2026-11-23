import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const installation = () => process.env.MAZEBENCH_DEEPSEEK_RUNTIME || path.join(os.homedir(), '.mazebench/deepseek-runtime');
export const authHome = () => process.env.MAZEBENCH_DEEPSEEK_AUTH_HOME || path.join(os.homedir(), '.dsh');
export const registryFile = () => process.env.MAZEBENCH_CONNECTIONS_FILE || path.join(os.homedir(), '.mazebench/connections.json');
const moduleAt = name => import(pathToFileURL(path.join(installation(), 'node_modules', name)).href);
export function credentialDocument(file) {
  if (!file || !existsSync(file)) return {};
  const bytes = readFileSync(file, 'utf8');
  try { return JSON.parse(bytes); } catch { /* The native DeepSeek store also accepts YAML. */ }
  const require = createRequire(path.join(installation(), 'package.json'));
  return require('yaml').parse(bytes) || {};
}
export function hasCredential(connection) {
  const doc = credentialDocument(connection.credential_file);
  return connection.auth === 'chatgpt' ? doc.records?.['llm-pi-ai/openai']?.payload?.scopes?.includes('chatgpt.tokens.use.direct') === true
    : Boolean(doc.refs?.[connection.key_ref] || process.env[connection.key_ref]);
}
export async function connectionToken(connection) {
  if (connection.auth !== 'chatgpt') {
    const key = credentialDocument(connection.credential_file).refs?.[connection.key_ref] || process.env[connection.key_ref];
    if (!key) throw new Error(`Connect ${connection.name} before launching.`);
    return key;
  }
  // The very same stock file lock used by DeepSeek inference serializes rotating
  // refresh tokens across catalogs, both harnesses, and all active runs.
  const [{ Context }, { LocalCredentialProvider }, { openaiProvider }] = await Promise.all([
    moduleAt('@deepseek-ai/cordis/lib/index.js'), moduleAt('@deepseek-ai/dsh-credentials-local/lib/index.js'),
    moduleAt('@earendil-works/pi-ai/dist/providers/openai.js')
  ]);
  const ctx = new Context(), fiber = await ctx.plugin(LocalCredentialProvider, { path: connection.credential_file, watch: false });
  try {
    const record = await ctx.credentials.modifyRecord('llm-pi-ai/openai', async current => {
      if (current?.kind !== 'grant' || !current.payload?.scopes?.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan access is not connected.');
      if (current.payload.expires > Date.now() + 60000) return current;
      return { kind: 'grant', payload: await openaiProvider().auth.oauth.refresh(current.payload, AbortSignal.timeout(20000)) };
    });
    return record.payload.access;
  } finally { await fiber.dispose(); }
}
export function validateConnection(value) {
  const connection = { ...value };
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(connection.id || '')) throw new Error('Invalid connection ID.');
  if (!['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai'].includes(connection.api)) throw new Error('Unsupported connection protocol.');
  if (connection.api === 'google-generative-ai') {
    connection.catalog_provider ||= 'google';
    if (connection.catalog_provider !== 'google') throw new Error('The Gemini API requires the Google transport.');
  }
  const url = new URL(connection.base_url);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Connections require HTTPS or a local endpoint, without URL credentials.');
  connection.base_url = url.href.replace(/\/$/, '');
  connection.name ||= connection.id;
  connection.auth ||= 'api-key';
  if (!['api-key', 'chatgpt'].includes(connection.auth)) throw new Error('Unsupported authentication method.');
  if (connection.auth === 'chatgpt' && (connection.base_url !== 'https://api.openai.com/v1' || connection.api !== 'openai-responses')) throw new Error('ChatGPT plan access requires the public OpenAI Responses API.');
  if (connection.auth !== 'chatgpt' && !/^[A-Z][A-Z0-9_]+$/.test(connection.key_ref || '')) throw new Error('Invalid API key reference.');
  if (connection.credential_file && !path.isAbsolute(connection.credential_file)) throw new Error('Credential paths must be absolute.');
  if (connection.catalog_provider && !/^[a-z][a-z0-9-]+$/.test(connection.catalog_provider)) throw new Error('Invalid catalog provider.');
  return connection;
}
export function connections() {
  const home = authHome();
  const defaults = [
    { id: 'anthropic-api', name: 'Anthropic API', catalog_provider: 'anthropic', api: 'anthropic-messages', base_url: 'https://api.anthropic.com', key_ref: 'ANTHROPIC_API_KEY', credential_file: path.join(home, 'mazebench-anthropic.credentials.json') },
    { id: 'chatgpt-plan', name: 'ChatGPT plan', catalog_provider: 'openai', api: 'openai-responses', base_url: 'https://api.openai.com/v1', auth: 'chatgpt', credential_file: path.join(home, 'mazebench-chatgpt.credentials.json') },
    { id: 'openai-api', name: 'OpenAI API', catalog_provider: 'openai', api: 'openai-responses', base_url: 'https://api.openai.com/v1', key_ref: 'OPENAI_API_KEY', credential_file: path.join(home, 'mazebench-openai.credentials.json') },
    { id: 'deepseek-api', name: 'DeepSeek API', catalog_provider: 'deepseek', api: 'openai-completions', base_url: 'https://api.deepseek.com', key_ref: 'DEEPSEEK_API_KEY', credential_file: path.join(home, '.credentials.yaml') },
    { id: 'xai-api', name: 'xAI API', catalog_provider: 'xai', api: 'openai-completions', base_url: 'https://api.x.ai/v1', key_ref: 'XAI_API_KEY', credential_file: path.join(home, 'mazebench-xai.credentials.json') },
    { id: 'openrouter-api', name: 'OpenRouter API', catalog_provider: 'openrouter', api: 'openai-completions', base_url: 'https://openrouter.ai/api/v1', key_ref: 'OPENROUTER_API_KEY', credential_file: path.join(home, 'mazebench-openrouter.credentials.json') }
  ];
  const saved = existsSync(registryFile()) ? JSON.parse(readFileSync(registryFile(), 'utf8')) : { version: 1, connections: [] };
  if (saved.version !== 1 || !Array.isArray(saved.connections)) throw new Error('Invalid provider connection registry.');
  const byId = new Map(defaults.map(c => [c.id, c]));
  for (const c of saved.connections) byId.set(c.id, c);
  return [...byId.values()].map(validateConnection).filter(c => c.enabled !== false && hasCredential(c));
}
export function publicConnection(connection) {
  return { id: connection.id, name: connection.name, api: connection.api, billing_source: connection.auth === 'chatgpt' ? 'chatgpt-plan' : connection.id };
}
export async function providerModels(provider) {
  if (!provider) return [];
  try {
    const module = await moduleAt(`@earendil-works/pi-ai/dist/providers/${provider}.js`);
    const factory = Object.entries(module).find(([name, value]) => name.endsWith('Provider') && typeof value === 'function')?.[1];
    return factory ? factory().getModels() : [];
  } catch { return []; }
}
