import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { grokEnvironment } from '../grok/policy.mjs';
import { credential as kimiCredential } from '../kimi/policy.mjs';
import { inspectClaude, claudeEnvironment } from '../providers/claude-policy.mjs';
import { inspectInstallation as agyInstallation, environment as agyEnvironment, authHome as agyHome } from '../antigravity/policy.mjs';
import { modelCatalog as museCatalog, catalogModels as museModels } from '../muse/status.mjs';
import { inspectInstallation as museInstallation } from '../muse/policy.mjs';
import { credentials as primeCredentials } from '../prime/policy.mjs';
import { catalogModels as primeModels } from '../prime/status.mjs';
import { directModel } from '../prime-direct-v2/catalog.mjs';
import { detailedCatalog as deepseekCatalog } from '../deepseek/status.mjs';
import { connectedCatalog, grokConnectedModel } from '../connections/catalog.mjs';
import { kimiModels, codexModels, claudeModels, grokModels, antigravityModels } from './normalize.mjs';
import { currentCodexCommand } from '../codex-latest.mjs';
const execute = promisify(execFile);
export async function paginatedModels(endpoint, headers, fetcher = fetch) {
  const data = [], seen = new Set(); let cursor;
  for (let page = 0; page < 100; page++) {
    const url = new URL(endpoint); if (cursor) url.searchParams.set('after_id', cursor);
    const response = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}.`);
    const value = await response.json();
    if (!Array.isArray(value.data)) throw new Error('Invalid model catalog response.');
    data.push(...value.data);
    if (!value.has_more) return { data };
    cursor = value.last_id || value.data.at(-1)?.id;
    if (!cursor || seen.has(cursor)) throw new Error('Model catalog pagination did not advance.');
    seen.add(cursor);
  }
  throw new Error('Model catalog exceeded its pagination limit.');
}
// Initialize a CLI protocol and query capabilities only; never send a user turn.
export function queryCli(command, args, options, exchange, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', finished = false, bytes = 0;
    const finish = (error, result) => {
      if (finished) return; finished = true; clearTimeout(timer); child.kill('SIGTERM');
      const kill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1500); kill.unref();
      child.once('close', () => clearTimeout(kill)); error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Model catalog query timed out.')), timeout);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdin.on('error', () => {}); child.stderr.resume();
    child.on('error', () => finish(new Error('Model catalog CLI could not start.')));
    child.on('close', () => { if (!finished) finish(new Error('Model catalog CLI exited before replying.')); });
    child.stdout.on('data', chunk => {
      bytes += chunk.length; if (bytes > 8 * 1024 * 1024) return finish(new Error('Model catalog response is too large.'));
      buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        let message; try { message = JSON.parse(line); } catch { continue; }
        try { exchange(message, send, result => finish(null, result)); } catch (error) { finish(error); }
      }
    });
    try { exchange(null, send, result => finish(null, result)); } catch (error) { finish(error); }
  });
}
export function fetchCodexModels(command = currentCodexCommand()) {
  let request = 1, data = []; const cursors = new Set();
  return queryCli(command, ['app-server'], { cwd: os.tmpdir() }, (message, send, done) => {
    if (!message) return send({ id: request, method: 'initialize', params: { clientInfo: { name: 'mazebench_catalog', version: '1' }, capabilities: { experimentalApi: true } } });
    if (message.id !== request) return;
    if (message.error) throw new Error('Codex model catalog request failed.');
    if (request === 1) { send({ method: 'initialized' }); send({ id: ++request, method: 'model/list', params: { includeHidden: true, limit: 100 } }); return; }
    if (!Array.isArray(message.result?.data)) throw new Error('Invalid Codex model catalog.');
    data.push(...message.result.data);
    const cursor = message.result.nextCursor;
    if (!cursor) return done(codexModels({ data }));
    if (cursors.has(cursor) || cursors.size > 100) throw new Error('Codex catalog pagination did not advance.');
    cursors.add(cursor); send({ id: ++request, method: 'model/list', params: { includeHidden: true, limit: 100, cursor } });
  });
}
export function claudePicker(command = inspectClaude().executable) {
  return queryCli(command, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
  { cwd: os.tmpdir(), env: claudeEnvironment() }, (message, send, done) => {
    if (!message) return send({ type: 'control_request', request_id: 'catalog', request: { subtype: 'initialize' } });
    if (message.type === 'control_response' && message.response?.request_id === 'catalog') {
      if (message.response.subtype === 'error') throw new Error('Claude capability query failed.');
      const result = message.response.response;
      done({ models: result.models, fast_mode_disabled_reason: result.fast_mode_disabled_reason });
    }
  });
}
async function claudeAuth() {
  // Use exactly the account Claude Code uses. Credentials never enter the cache,
  // response, logs, process argv, or an alternate endpoint.
  let credentials;
  try {
    if (process.platform === 'darwin') credentials = JSON.parse((await execute('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 })).stdout);
    else credentials = JSON.parse(await readFile(path.join(os.homedir(), '.claude/.credentials.json'), 'utf8'));
  } catch { throw new Error('Claude Code login could not be read. Run claude auth login.'); }
  const token = credentials.claudeAiOauth?.accessToken;
  if (!token) throw new Error('Claude Code subscription login is unavailable.');
  return { Authorization: 'Bearer ' + token, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' };
}
export function catalogSources({ antigravityBin = process.env.MAZEBENCH_ANTIGRAVITY_BIN || 'agy' } = {}) {
  return {
    'deepseek-harness': options => deepseekCatalog(options),
    codex: () => fetchCodexModels(),
    'claude-code': async () => {
      // Initialization refreshes the CLI's account information before reading its
      // OAuth token; the API catalog supplies earlier versions the picker omits.
      const picker = await claudePicker();
      return claudeModels(await paginatedModels('https://api.anthropic.com/v1/models?limit=1000', await claudeAuth()), picker);
    },
    'kimi-code': async () => {
      const auth = kimiCredential();
      return kimiModels(await paginatedModels(auth.base_url + '/models', { Authorization: 'Bearer ' + auth.api_key, 'User-Agent': 'MazeBench/1.0' }));
    },
    antigravity: async () => {
      // Use the launch CLI's catalog. Another version can advertise model IDs
      // that the benchmark runner does not recognize.
      const { executable } = agyInstallation(antigravityBin);
      const result = await execute(executable, ['models'], { env: agyEnvironment(agyHome()), cwd: agyHome(), timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
      return antigravityModels(result.stdout);
    },
    'grok-build': async options => {
      const connected = await connectedCatalog(options);
      let native = [], nativeError;
      try {
        await execute(process.env.MAZEBENCH_GROK_BIN || 'grok', ['models'], { cwd: os.tmpdir(), env: grokEnvironment(path.join(os.homedir(), '.grok')), timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
        native = grokModels(JSON.parse(await readFile(path.join(os.homedir(), '.grok/models_cache.json'), 'utf8')))
          .map(m => ({ ...m, connection_id: 'grok-subscription', connection_name: 'Grok subscription' }));
      } catch { nativeError = 'Grok subscription model discovery failed.'; }
      return { models: [...native, ...connected.models.filter(m => m.api !== 'google-generative-ai').map(grokConnectedModel)],
        connections: [{ id: 'grok-subscription', name: 'Grok subscription', model_count: native.length, error: nativeError },
          ...connected.connections.filter(c => c.api !== 'google-generative-ai')] };
    },
    'muse-code': async () => museModels(await museCatalog(museInstallation().executable)),
    'prime-agent': async () => {
      const { key, team } = await primeCredentials();
      const data = await paginatedModels('https://api.pinference.ai/api/v1/models', { Authorization: 'Bearer ' + key, ...(team ? { 'X-Prime-Team-ID': team } : {}) });
      const direct = new Map(data.data.map(directModel).filter(Boolean).map(m => [m.id, m]));
      return primeModels(data).map(m => ({ ...m, direct_efforts: direct.get(m.id)?.efforts || [], default_direct_effort: direct.get(m.id)?.default_effort }));
    }
  };
}
