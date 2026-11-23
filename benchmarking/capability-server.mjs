// Hot-add new harness capabilities without stopping the process that owns live
// runs. All mutations are dispatched to the owner; telemetry is read-only.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { BenchmarkSupervisor } from './prime-direct-v2/supervisor.mjs';
import { POLICY as DIRECT_POLICY, isDirectSpec } from './prime-direct-v2/policy.mjs';
import { POLICY as PREVIOUS_DIRECT_POLICY } from './prime-direct/policy.mjs';
import { POLICY } from './all-code/policy.mjs';
import { inspectCodeSandbox } from './code/sandbox.mjs';
import { safeReadFile } from './v1/safe-files.mjs';
import { trustedVisionRequest } from './vision/server.mjs';
import { ReportReader } from './report-reader.mjs';
import { readRunVersion } from './run-version.mjs';
import { RunLibrary } from './run-library.mjs';
import { RunDashboard } from './run-dashboard.mjs';
import { previewBenchmarkPrompt } from './prompt-preview.mjs';
import { resumeExclusively } from './storage/resume-lock.mjs';
import { installPrimeHttpTransport } from './prime-http-transport.mjs';
import { PrimeAutoRecovery } from './prime-auto-recovery.mjs';

export function createCapabilityServer(root, options = {}) {
  installPrimeHttpTransport();
  const port = options.port ?? 8083, mainPort = options.mainPort || 8080;
  const supervisor = options.supervisor || new BenchmarkSupervisor(root, options);
  const recovery = options.autoRecovery === false ? null : new PrimeAutoRecovery(supervisor, options.recoveryOptions);
  const reports = new ReportReader(), library = new RunLibrary({ markInterrupted: true }), dashboard = new RunDashboard();
  async function decorateVersion(run, directory) {
    if (run.benchmark_version || !existsSync(path.join(directory, 'run.json'))) return run;
    const metadata = JSON.parse(safeReadFile(directory, 'run.json'));
    run.benchmark_version = readRunVersion(directory, metadata, (await library.snapshot(directory)).summary);
    return run;
  }
  const visionDirectory = id => path.join(options.visionRecordsRoot || process.env.MAZEBENCH_VISION_RECORDS_ROOT || path.join(os.homedir(), 'records/mazebench-vision'), id);
  let sandbox, sandboxAt = 0, visionAt = 0, vision = false;
  const getSandbox = async () => {
    if (Date.now() - sandboxAt > 15000) { sandbox = await inspectCodeSandbox(); sandboxAt = Date.now(); }
    return sandbox;
  };
  const upstreamPort = async () => {
    if (options.upstreamPort) return typeof options.upstreamPort === 'function' ? options.upstreamPort() : options.upstreamPort;
    if (Date.now() - visionAt > 15000) {
      try { const r = await fetch('http://127.0.0.1:8082/api/benchmark/vision/status', { signal: AbortSignal.timeout(500) }); vision = r.ok; }
      catch { vision = false; }
      visionAt = Date.now();
    }
    return vision ? 8082 : mainPort;
  };
  function owned(directory) {
    if (options.ownsRun) return options.ownsRun(directory);
    if (!existsSync(path.join(directory, 'run.json')) || !existsSync(path.join(directory, 'integrity.json'))) return false;
    // Consult the signed configuration as well, so changing metadata cannot
    // downgrade a new execution condition to a legacy resume handler.
    const configuration = JSON.parse(safeReadFile(directory, 'integrity.json')).configuration;
    return configuration?.code_policy === POLICY || [DIRECT_POLICY, PREVIOUS_DIRECT_POLICY].includes(configuration?.harness);
  }
  const reply = (res, status, value, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    if (!trustedVisionRequest(req, server.address()?.port || port, mainPort)) return reply(res, 403, { error: 'Only trusted localhost requests are accepted.' });
    if (req.headers.origin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); return reply(res, 204, '');
    }
    const url = new URL(req.url, 'http://' + req.headers.host), prefix = '/api/benchmark/v1';
    if (!url.pathname.startsWith('/api/benchmark/')) return reply(res, 404, { error: 'Unknown capability route.' });
    try {
      await recovery?.ready;
      // Additive features retain the existing route protocol version.
      if (url.pathname === '/api/benchmark/capabilities/status') return reply(res, 200, { available: true, version: 2, prime_auto_recovery: Boolean(recovery), model_catalog: Boolean(options.catalog), current_codex_owner: options.currentCodexOwner === true });
      let body;
      if (['POST', 'DELETE'].includes(req.method)) {
        let length = 0; const chunks = [];
        for await (const chunk of req) { length += chunk.length; if (length > 32768) throw new Error('Request too large.'); chunks.push(chunk); }
        body = Buffer.concat(chunks);
      }
      const forward = async (pathname = url.pathname + url.search, method = req.method, payload = body) => fetch(
        `http://127.0.0.1:${await upstreamPort()}${pathname}`, { method, headers: payload?.length ? { 'Content-Type': 'application/json' } : {}, ...(payload?.length ? { body: payload } : {}) });
      if (req.method === 'GET' && url.pathname === prefix + '/prompt') return reply(res, 200, await previewBenchmarkPrompt(root, Object.fromEntries(url.searchParams)));
      if (req.method === 'GET' && url.pathname === prefix + '/providers') {
        const upstream = await forward(); if (!upstream.ok) return reply(res, upstream.status, await upstream.text());
        const values = await upstream.json(), code = await getSandbox();
        if (supervisor.runtimes?.deepseek) values['deepseek-harness'] = await supervisor.runtimes.deepseek.inspectDeepSeek({ force: url.searchParams.get('force') === '1' });
        if (options.codexStatus) values.codex = { ...values.codex, ...await options.codexStatus() };
        if (options.catalog) {
          const catalog = await options.catalog.all({ force: url.searchParams.get('force') === '1' });
          return reply(res, 200, Object.fromEntries(Object.entries(values).map(([name, value]) => {
            const state = catalog.catalogs[name];
            return [name, { ...value, catalog: state, models: catalog.models.filter(m => m.provider === name), code_sandbox: code,
              ...(state && !state.stale && name === 'kimi-code' ? { authenticated: true, launch_ready: value.tested, error: value.tested ? null : value.error } : {}),
              ...(state && !state.stale && name !== 'kimi-code' && value.tested && value.authenticated ? { launch_ready: true, error: null } : {}) }];
          })));
        }
        const direct = await supervisor.inspectDirect({ force: url.searchParams.get('force') === '1' });
        return reply(res, 200, Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { ...value,
          coding_modes: ['off', 'python', 'any'], ...(name === 'prime-agent' ? { direct } : {}), code_sandbox: code }])));
      }
      if (req.method === 'GET' && url.pathname === prefix + '/models') {
        if (options.catalog) return reply(res, 200, await options.catalog.all({ force: url.searchParams.get('force') === '1' }));
        const upstream = await forward(); if (!upstream.ok) return reply(res, upstream.status, await upstream.text());
        const value = await upstream.json(), direct = await supervisor.inspectDirect();
        const catalog = new Map(direct.models.map(model => [model.id, model]));
        for (const model of value.models || []) if (model.provider === 'prime-agent') {
          const supported = catalog.get(model.id);
          Object.assign(model, { direct_efforts: supported?.efforts || [], default_direct_effort: supported?.default_effort });
          catalog.delete(model.id);
        }
        for (const model of catalog.values()) value.models.push({ id: model.id, name: model.name, provider: 'prime-agent',
          efforts: ['default'], default_effort: 'default', direct_efforts: model.efforts, default_direct_effort: model.default_effort });
        return reply(res, 200, value);
      }
      if (req.method === 'GET' && url.pathname === prefix + '/runs') {
        const upstream = await forward(); if (!upstream.ok) return reply(res, upstream.status, await upstream.text());
        const value = await upstream.json();
        // These runs share the editor's publication root, but have a separate
        // owner. Replace only their transient status/activity projection.
        for (const run of value.runs || []) if (owned(supervisor.runDirectory(run.id))) {
          const metadata = JSON.parse(safeReadFile(supervisor.runDirectory(run.id), 'run.json'));
          run.runner_active = supervisor.active.has(run.id);
          run.status = metadata.status; run.coding_mode = metadata.coding_mode; run.harness = metadata.harness;
          if (metadata.auto_recovery) run.auto_recovery = metadata.auto_recovery;
          if (!run.runner_active && ['preparing', 'queued', 'running', 'continuing', 'pausing'].includes(run.status)) run.status = 'interrupted';
          if (recovery?.status(run.id)) run.auto_recovery = recovery.status(run.id);
        }
        for (const run of value.runs || []) {
          const directory = supervisor.runDirectory(run.id);
          await decorateVersion(run, existsSync(path.join(directory, 'run.json')) ? directory : visionDirectory(run.id));
        }
        return reply(res, 200, value);
      }
      if (req.method === 'POST' && [prefix + '/runs', prefix + '/pairs'].includes(url.pathname)) {
        const spec = JSON.parse(body || '{}');
        if (spec.observation_mode === 'vision') {
          // Never use upstreamPort() here: its offline fallback is ASCII.
          // This also protects stale launcher tabs and direct API clients.
          const visionOrigin = `http://127.0.0.1:${options.visionPort || 8082}`;
          try {
            const health = await fetch(visionOrigin + '/api/benchmark/vision/status', { signal: AbortSignal.timeout(1200) });
            if (!health.ok || (await health.json()).observation_mode !== 'vision') throw new Error('Vision runner is unavailable.');
          } catch {
            return reply(res, 503, { error: 'Vision runner is unavailable. Start npm run start:vision; no run was launched.' });
          }
          const upstream = await fetch(visionOrigin + url.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
          return reply(res, upstream.status, await upstream.text());
        }
        if (options.catalog) {
          await options.catalog.selection(spec, { force: true });
          if (spec.provider === 'prime-agent') {
            const upstream = await forward(); return reply(res, upstream.status, await upstream.text());
          }
          if (url.pathname.endsWith('/runs')) return reply(res, 202, await supervisor.launch(spec));
          const pair_id = 'pair-' + randomBytes(8).toString('hex');
          const mode = spec.coding_mode === 'any' ? 'any' : 'python';
          const on = { ...spec, pair_id, coding_mode: mode, tools_enabled: true };
          await supervisor.validateSpec(on);
          if (mode === 'any') { const code = await getSandbox(); if (!code.available) throw new Error(code.error); }
          const off = await supervisor.launch({ ...spec, pair_id, coding_mode: 'off', tools_enabled: false });
          try { return reply(res, 202, { pair_id, runs: [off, await supervisor.launch(on)] }); }
          catch (error) { await supervisor.stop(off.id); throw error; }
        }
        if (isDirectSpec(spec)) {
          if (url.pathname.endsWith('/pairs')) throw new Error('Prime direct and native are separate harnesses. Start a single run.');
          const run = await supervisor.launch(spec);
          if (recovery) await recovery.enroll(run.id);
          return reply(res, 202, recovery ? recovery.decorate(run) : run);
        }
        if (spec.coding_mode === 'any' && !['codex', 'claude-code'].includes(spec.provider || 'codex')) {
          if (url.pathname.endsWith('/runs')) return reply(res, 202, await supervisor.launch(spec));
          if (spec.provider === 'prime-agent') throw new Error('Prime direct and native are separate harnesses. Start a single run.');
          const code = await getSandbox(); if (!code.available) throw new Error(code.error);
          await supervisor.validateSpec(spec);
          const pair_id = 'pair-' + randomBytes(8).toString('hex');
          const off = await forward(prefix + '/runs', 'POST', Buffer.from(JSON.stringify({ ...spec, pair_id, coding_mode: 'off', tools_enabled: false })));
          if (!off.ok) return reply(res, off.status, await off.text());
          const first = await off.json();
          try { return reply(res, 202, { pair_id, runs: [first, await supervisor.launch({ ...spec, pair_id })] }); }
          catch (error) { await forward(prefix + '/runs/' + encodeURIComponent(first.id) + '/stop', 'POST'); throw error; }
        }
      }
      const match = new RegExp('^' + prefix + '/runs/([^/]+)(?:/(.*))?$').exec(url.pathname);
      if (match) {
        const id = decodeURIComponent(match[1]), suffix = match[2] || '', directory = supervisor.runDirectory(id);
        const ours = owned(directory);
        const telemetryDirectory = existsSync(path.join(directory, 'run.json')) ? directory :
          path.join(options.visionRecordsRoot || process.env.MAZEBENCH_VISION_RECORDS_ROOT || path.join(os.homedir(), 'records/mazebench-vision'), id);
        if (req.method === 'GET' && suffix === 'tokens' && existsSync(path.join(telemetryDirectory, 'run.json')))
          return reply(res, 200, await reports.read(telemetryDirectory, 'tokens'));
        if (ours) {
          if (req.method === 'GET' && !suffix) {
            const view = url.searchParams.get('view');
            if (view === 'analysis') return reply(res, 200, await reports.read(directory, 'analysis', supervisor.active.has(id)));
            if (view === 'activity') return reply(res, 200, await dashboard.activity(supervisor, id));
            const run = view === 'overview' ? await dashboard.overview(supervisor, id)
              : await supervisor.get(id, { historyCursor: url.searchParams.get('history_cursor') });
            if (view === 'overview') {
              const metadata = JSON.parse(safeReadFile(directory, 'run.json'));
              if (metadata.auto_recovery) run.auto_recovery = metadata.auto_recovery;
              run.capability_boundary_verified = metadata.integrity?.version === metadata.capability_policy?.version && !existsSync(path.join(directory, 'integrity-violation.json'));
              run.compaction_recoverable = run.status === 'failed' && run.capability_boundary_verified && run.provider !== 'prime-agent';
            }
            const tokens = await reports.read(directory, 'tokens').catch(() => null); if (tokens?.totals) run.usage = tokens.totals;
            await decorateVersion(run, directory);
            return reply(res, 200, options.decorateRun ? await options.decorateRun(run) : recovery ? recovery.decorate(run) : run);
          }
          if (req.method === 'DELETE' && !suffix) return reply(res, 200, await (recovery ? recovery.command(id, 'delete') : supervisor.delete(id)));
          if (req.method === 'POST' && ['pause', 'stop', 'resume'].includes(suffix)) return reply(res, 200, await (recovery ? recovery.command(id, suffix) : suffix === 'resume' ? resumeExclusively(supervisor, id) : supervisor[suffix](id)));
          if (req.method === 'GET' && suffix === 'charts') return reply(res, 200, await reports.read(directory, 'charts', supervisor.active.has(id)));
          if (req.method === 'GET' && suffix === 'interviews') return reply(res, 200, await supervisor.listInterviews(id));
          if (req.method === 'GET' && /^display\/(0|[1-9]\d*)$/.test(suffix)) return reply(res, 200, await dashboard.frame(supervisor, id, suffix.split('/')[1]));
          if (req.method === 'GET' && suffix.startsWith('record/')) return reply(res, 200, await supervisor.record(id, decodeURIComponent(suffix.slice(7))), 'text/plain; charset=utf-8');
          return reply(res, 404, { error: 'Unsupported harness operation.' });
        }
        if (req.method === 'GET' && !suffix && existsSync(path.join(telemetryDirectory, 'run.json'))) {
          const upstream = await forward(); if (!upstream.ok) return reply(res, upstream.status, await upstream.text());
          const run = await upstream.json(), tokens = await reports.read(telemetryDirectory, 'tokens').catch(() => null);
          if (tokens?.totals) run.usage = tokens.totals;
          if (run.id === id) await decorateVersion(run, telemetryDirectory);
          return reply(res, 200, run);
        }
      }
      const upstream = await forward();
      reply(res, upstream.status, Buffer.from(await upstream.arrayBuffer()), upstream.headers.get('content-type') || 'application/octet-stream');
    } catch (error) { reply(res, 400, { error: String(error.message || error) }); }
  });
  server.on('listening', () => recovery?.start());
  server.on('close', () => { void recovery?.close(); void reports.close(); });
  return { server, supervisor, reports, library, recovery };
}
if (process.argv[1] === import.meta.filename) {
  const port = Number(process.env.MAZEBENCH_CAPABILITY_PORT || 8083);
  const { server } = createCapabilityServer(path.resolve(import.meta.dirname, '..'), { port, mainPort: Number(process.env.MAZEBENCH_BENCHMARK_PORT || 8080) });
  server.listen(port, '127.0.0.1', () => console.log(`MazeBench capabilities at http://localhost:${port}`));
}
