// Shared operator supervisor in front of all immutable agent owners. This can
// be hot-added without restarting any model process or upgrading its runtime.
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { AutoResume } from './auto-resume.mjs';
import { recoveryFailure } from './auto-resume-failure.mjs';
import { prepareNormalResume, cancelLegacyRecovery } from './auto-resume-owner.mjs';
import { trustedVisionRequest } from './vision/server.mjs';
export function createAutoResumeServer({ port = 8092, mainPort = 8080, upstreamPort = 8090, stateRoot = path.join(os.homedir(), '.mazebench/auto-resume'), recoveryOptions = {}, prepare = prepareNormalResume } = {}) {
  const origin = `http://127.0.0.1:${upstreamPort}`, prefix = '/api/benchmark/v1';
  const request = async (url, options = {}) => {
    const response = await fetch(origin + url, { signal: AbortSignal.timeout(120000), ...options });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || `Owner returned HTTP ${response.status}.`); return value;
  };
  const get = async id => recoveryFailure(await request(`${prefix}/runs/${id}?view=overview`));
  const recovery = new AutoResume({ stateRoot, list: async () => (await request(prefix + '/runs?view=library')).runs, get,
    command: (id, action, payload) => request(`${prefix}/runs/${id}${action === 'delete' ? '' : '/' + action}`, {
      method: action === 'delete' ? 'DELETE' : 'POST', headers: { 'content-type': 'application/json' }, body: payload || '{}' }),
    prepare: (run, allowed) => prepare(run, { get, allowed }), cancel: run => cancelLegacyRecovery(run, { get }), ...recoveryOptions });
  const reply = (res, code, value, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    if (!trustedVisionRequest(req, server.address()?.port || port, mainPort)) return reply(res, 403, { error: 'Only trusted localhost requests are accepted.' });
    if (req.headers.origin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); return reply(res, 204, ''); }
    const url = new URL(req.url, 'http://' + req.headers.host);
    if (!url.pathname.startsWith('/api/benchmark/')) return reply(res, 404, { error: 'Unknown route.' });
    try {
      await recovery.ready;
      if (req.method === 'GET' && url.pathname === '/api/benchmark/auto-resume/status') return reply(res, 200, { available: true, version: 1, policy: 'all-agents-normal-resume-v1', provider_scope: 'all', runs: [...recovery.records.keys()].map(id => ({ id, ...recovery.status(id) })) });
      let body;
      if (['POST', 'DELETE'].includes(req.method)) { const chunks = []; let length = 0; for await (const chunk of req) { length += chunk.length; if (length > 32768) throw new Error('Request too large.'); chunks.push(chunk); } body = Buffer.concat(chunks); }
      const match = /^\/api\/benchmark\/v1\/runs\/(run-[\dTZ-]+-[a-f0-9]{6})(?:\/(pause|stop|resume))?$/.exec(url.pathname);
      if (match && (req.method === 'POST' && match[2] || req.method === 'DELETE' && !match[2])) return reply(res, 200, await recovery.command(match[1], req.method === 'DELETE' ? 'delete' : match[2], body));
      const response = await fetch(origin + url.pathname + url.search, { method: req.method, signal: AbortSignal.timeout(120000),
        ...(body?.length ? { headers: { 'content-type': 'application/json' }, body } : {}) });
      if (response.ok && (req.method === 'GET' && (url.pathname === prefix + '/runs' || match) || req.method === 'POST' && [prefix + '/runs', prefix + '/pairs'].includes(url.pathname))) {
        const value = await response.json();
        const runs = value.runs || (value.id ? [value] : []);
        if (req.method === 'POST') for (const run of runs) await recovery.enroll(await get(run.id));
        if (value.runs) value.runs = value.runs.map(run => recovery.decorate(run));
        return reply(res, response.status, value.id ? recovery.decorate(value) : value);
      }
      return reply(res, response.status, Buffer.from(await response.arrayBuffer()), response.headers.get('content-type') || 'application/json');
    } catch (error) { return reply(res, 400, { error: error.message }); }
  });
  server.on('listening', () => recovery.start()); server.on('close', () => void recovery.close());
  return { server, recovery };
}
if (process.argv[1] === import.meta.filename) {
  const { server, recovery } = createAutoResumeServer();
  server.listen(8092, '127.0.0.1', () => console.log('All-agent auto-resume on localhost:8092'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await recovery.close(); server.close(); server.closeAllConnections(); });
}
