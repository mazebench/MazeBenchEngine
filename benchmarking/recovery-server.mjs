// Recovery is additive: the original signed supervisors still own every agent.
import { createServer } from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { CodexVisionAutoRecovery } from './codex-vision-auto-recovery.mjs';
import { GeminiAsciiAutoRecovery, GeminiVisionAutoRecovery } from './gemini-vision-auto-recovery.mjs';
import { GrokVisionAutoRecovery } from './grok-vision-auto-recovery.mjs';
import { trustedVisionRequest } from './vision/server.mjs';
export function createVisionRecovery(root, options = {}) {
  const codex = new CodexVisionAutoRecovery(root, options);
  const gemini = new GeminiVisionAutoRecovery(root, { recordsRoot: options.recordsRoot, providerVisionPort: options.providerVisionPort });
  const grok = new GrokVisionAutoRecovery(root, { recordsRoot: options.recordsRoot, providerVisionPort: options.providerVisionPort });
  const byProvider = { codex, antigravity: gemini, 'grok-build': grok };
  const ascii = new GeminiAsciiAutoRecovery(root, { recordsRoot: options.asciiRecordsRoot, providerVisionPort: options.providerVisionPort });
  const controllers = [...Object.values(byProvider), ascii];
  const metadataAt = (controller, id) => readFile(path.join(controller.directory(id), 'run.json'), 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return {
    ready: Promise.all(controllers.map(controller => controller.ready)),
    decorate: run => controllers.reduce((value, controller) => controller.decorate(value), run),
    start: () => controllers.forEach(controller => controller.start()),
    close: () => Promise.all(controllers.map(controller => controller.close())),
    async controllerFor(id) {
      const vision = await metadataAt(codex, id);
      if (vision?.observation_mode === 'vision') return byProvider[vision.provider];
      const run = await metadataAt(ascii, id);
      return ascii.policy.eligible(run) ? ascii : null;
    },
  };
}
export function createRecoveryServer(root, options = {}) {
  const port = options.port ?? 8087, mainPort = options.mainPort || 8080;
  const recovery = options.recovery || createVisionRecovery(root, options);
  let upstream = 8086, checkedAt = 0;
  const upstreamPort = async () => {
    if (options.upstreamPort) return options.upstreamPort;
    if (Date.now() - checkedAt < 15000) return upstream;
    for (const [candidate, route] of [[8086, '/api/benchmark/vision-providers/status'], [8084, '/api/benchmark/capabilities/status'], [8082, '/api/benchmark/vision/status']]) {
      try { if ((await fetch(`http://127.0.0.1:${candidate}${route}`, { signal: AbortSignal.timeout(700) })).ok) { upstream = candidate; checkedAt = Date.now(); return candidate; } } catch { /* Existing owners may start independently. */ }
    }
    throw new Error('Benchmark owner is unavailable.');
  };
  const reply = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)); };
  const server = createServer(async (req, res) => {
    if (!trustedVisionRequest(req, server.address()?.port || port, mainPort)) return reply(res, 403, { error: 'Only trusted localhost requests are accepted.' });
    if (req.headers.origin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); return reply(res, 204, ''); }
    const url = new URL(req.url, 'http://' + req.headers.host), prefix = '/api/benchmark/v1';
    if (!url.pathname.startsWith('/api/benchmark/')) return reply(res, 404, { error: 'Unknown route.' });
    try {
      await recovery.ready;
      if (url.pathname === '/api/benchmark/recovery/status') return reply(res, 200, { available: true, version: 1, policy: 'blocked-codex-resource-probe-v1', policies: ['blocked-codex-resource-probe-v1', 'gemini-vision-normal-resume-v1', 'gemini-ascii-normal-resume-v1', 'grok-vision-normal-resume-v1'] });
      let body;
      if (['POST', 'DELETE'].includes(req.method)) { let length = 0; const chunks = []; for await (const chunk of req) { length += chunk.length; if (length > 32768) throw new Error('Request too large.'); chunks.push(chunk); } body = Buffer.concat(chunks); }
      const match = new RegExp('^' + prefix + '/runs/(run-[\\dTZ-]+-[a-f0-9]{6})(?:/(pause|stop|resume))?$').exec(url.pathname);
      if (match && (req.method === 'POST' && match[2] || req.method === 'DELETE' && !match[2])) {
        const controller = await recovery.controllerFor(match[1]);
        if (controller) return reply(res, 200, await controller.command(match[1], req.method === 'DELETE' ? 'delete' : match[2]));
      }
      const response = await fetch(`http://127.0.0.1:${await upstreamPort()}${url.pathname}${url.search}`, { method: req.method, headers: body?.length ? { 'Content-Type': 'application/json' } : {}, ...(body?.length ? { body } : {}) });
      if (response.ok && ((req.method === 'GET' && (url.pathname === prefix + '/runs' || match)) || req.method === 'POST' && [prefix + '/runs', prefix + '/pairs'].includes(url.pathname))) {
        const value = await response.json();
        if (value.runs) value.runs = value.runs.map(run => recovery.decorate(run));
        return reply(res, response.status, value.id ? recovery.decorate(value) : value);
      }
      reply(res, response.status, Buffer.from(await response.arrayBuffer()), response.headers.get('content-type') || 'application/json');
    } catch (error) { reply(res, 400, { error: error.message }); }
  });
  server.on('listening', () => recovery.start()); server.on('close', () => void recovery.close());
  return { server, recovery };
}
if (process.argv[1] === import.meta.filename) {
  const port = Number(process.env.MAZEBENCH_RECOVERY_PORT || 8087), { server, recovery } = createRecoveryServer(path.resolve(import.meta.dirname, '..'), { port });
  server.listen(port, '127.0.0.1', () => console.log(`MazeBench blocked-call recovery on localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await recovery.close(); server.close(); server.closeAllConnections(); });
}
