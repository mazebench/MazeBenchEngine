// Rolling release owner. Old requests continue to their original processes;
// new runs execute from private, immutable runtime/world installations.
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import './codex-releases.mjs';
import { prepareRuntimeRelease, releaseOwner, releaseOwners } from './runtime-release-store.mjs';
import { createCapabilityServer } from './capability-server.mjs';
import { ModelCatalog } from './model-catalog/service.mjs';
import { trustedVisionRequest } from './vision/server.mjs';
import { CodexTransientRecovery } from './codex-transient-recovery.mjs';
import { PrimeAutoRecovery } from './prime-auto-recovery.mjs';
import { installPrimeHttpTransport } from './prime-http-transport.mjs';
import { readRunVersion } from './run-version.mjs';
import { CodexVisionAutoRecovery } from './codex-vision-auto-recovery.mjs';
import { GeminiAsciiAutoRecovery, GeminiVisionAutoRecovery } from './gemini-vision-auto-recovery.mjs';
import { GrokVisionAutoRecovery } from './grok-vision-auto-recovery.mjs';
import { resumeExclusively } from './storage/resume-lock.mjs';
import { installClaudeOutputLimit } from './claude-output-limit.mjs';
import { RunLibrary } from './run-library.mjs';
import { currentCodexCommand } from './codex-latest.mjs';

export function createRuntimeReleaseServer(root, { port = 8090, upstreamPort } = {}) {
  const bundles = new Map(), active = new Map(), catalog = new ModelCatalog(), launching = new AsyncLocalStorage();
  const library = new RunLibrary({ markInterrupted: true });
  let checkedAt = 0, upstream = 8087;
  const upstreamFor = async () => {
    if (upstreamPort) return upstreamPort;
    if (Date.now() - checkedAt > 15000) {
      try { upstream = (await fetch('http://127.0.0.1:8088/api/benchmark/capabilities/status', { signal: AbortSignal.timeout(700) })).ok ? 8088 : 8087; }
      catch { upstream = 8087; }
      checkedAt = Date.now();
    }
    return upstream;
  };
  const importAt = (releaseRoot, name) => import(pathToFileURL(path.join(releaseRoot, name)).href);
  async function bundle(releaseRoot) {
    if (bundles.has(releaseRoot)) return bundles.get(releaseRoot);
    const pending = (async () => {
      await importAt(releaseRoot, 'benchmarking/codex-releases.mjs');
      const [{ CatalogSupervisor }, { VisionSupervisor }, { ProviderVisionSupervisor }, { BenchmarkSupervisor: Prime }, { VisionRenderer }] = await Promise.all([
        'benchmarking/model-catalog/supervisor.mjs', 'benchmarking/vision/supervisor.mjs', 'benchmarking/vision-providers/supervisor.mjs',
        'benchmarking/prime-direct-v2/supervisor.mjs', 'benchmarking/vision/renderer.mjs'
      ].map(name => importAt(releaseRoot, name)));
      const records = path.join(os.homedir(), 'records/mazebench-releases', path.basename(releaseRoot));
      const options = { codexBin: currentCodexCommand(),
        ownerRoot: path.join(records, 'owners'), recordsRoot: path.join(records, 'ascii'), catalog };
      const transientOwners = path.join(records, 'transient-owners');
      const ascii = new CatalogSupervisor(releaseRoot, options);
      const visionOptions = { ...options, recordsRoot: path.join(records, 'vision') };
      const vision = new VisionSupervisor(releaseRoot, visionOptions), providers = new ProviderVisionSupervisor(releaseRoot, visionOptions);
      const prime = new Prime(releaseRoot, { ...options, directStateRoot: path.join(records, 'prime-state') });
      installPrimeHttpTransport(prime);
      const children = [...Object.values(ascii.runtimes), ascii, vision, providers, prime];
      for (const owner of children) {
        installClaudeOutputLimit(owner);
        owner.active = active;
        owner.models = () => catalog.all();
        const directory = owner.runDirectory.bind(owner);
        owner.runDirectory = id => {
          const value = directory(id);
          if (launching.getStore() && !existsSync(path.join(value, 'run.json')) && !releaseOwner(id)) {
            mkdirSync(releaseOwners, { recursive: true, mode: 0o700 });
            writeFileSync(path.join(releaseOwners, `${id}.json`), JSON.stringify({ root: releaseRoot, directory: value }), { flag: 'wx', mode: 0o600 });
            mkdirSync(transientOwners, { recursive: true, mode: 0o700 });
            writeFileSync(path.join(transientOwners, `${id}.json`), '{}', { flag: 'wx', mode: 0o600 });
          }
          return value;
        };
      }
      const choose = spec => spec.observation_mode === 'vision' ? ['codex', 'claude-code'].includes(spec.provider || 'codex') ? vision : providers
        : spec.provider === 'prime-agent' ? prime : ascii;
      const recovery = new PrimeAutoRecovery(prime); recovery.start();
      const controllers = [
        [CodexVisionAutoRecovery, visionOptions, 'vision-recovery-0'],
        [GeminiVisionAutoRecovery, visionOptions, 'vision-recovery-1'],
        [GrokVisionAutoRecovery, visionOptions, 'vision-recovery-2'],
        [GeminiAsciiAutoRecovery, options, 'gemini-ascii-recovery'],
      ].map(([Recovery, ownerOptions, folder]) => {
        const controller = new Recovery(releaseRoot, { ...ownerOptions, stateRoot: path.join(records, folder),
          request: async (id, action) => {
            const spec = JSON.parse(readFileSync(path.join(ownerOptions.recordsRoot, id, 'run.json'), 'utf8'));
            const owner = choose(spec);
            return action === 'resume' ? resumeExclusively(owner, id) : action ? owner[action](id) : owner.get(id);
          } });
        if (controller.owner) controller.owner.active = active;
        controller.start(); return controller;
      });
      const transient = new CodexTransientRecovery({ ownerRoot: transientOwners, active, forRun: id => {
        const record = releaseOwner(id), spec = JSON.parse(readFileSync(path.join(record.directory, 'run.json'), 'utf8'));
        return choose(spec);
      } });
      transient.start();
      const renderer = new VisionRenderer(releaseRoot);
      return { choose, ascii, vision, providers, prime, recovery, transient, controllers, renderer };
    })();
    bundles.set(releaseRoot, pending);
    try { return await pending; } catch (error) { bundles.delete(releaseRoot); throw error; }
  }
  async function ownerFor(id) {
    const record = releaseOwner(id); if (!record) throw new Error('Unknown release run.');
    const spec = JSON.parse(readFileSync(path.join(record.directory, 'run.json'), 'utf8'));
    return (await bundle(record.root)).choose(spec);
  }
  const supervisor = { projectRoot: root, recordsRoot: path.join(os.homedir(), 'records/mazebench-releases'), active,
    runDirectory: id => releaseOwner(id)?.directory || path.join(os.homedir(), 'records/mazebench-benchmark', id) };
  for (const method of ['get', 'pause', 'stop', 'resume', 'delete', 'record', 'displayFrame', 'listInterviews', 'createInterview']) {
    supervisor[method] = async (id, ...args) => {
      const record = releaseOwner(id), owners = await bundle(record.root);
      const spec = JSON.parse(readFileSync(path.join(record.directory, 'run.json'), 'utf8'));
      const controller = owners.controllers.find(value => value.policy.eligible(spec));
      if (controller && ['pause', 'stop', 'resume', 'delete'].includes(method)) return controller.command(id, method);
      if (spec.provider === 'prime-agent' && ['pause', 'stop', 'resume', 'delete'].includes(method)) return owners.recovery.command(id, method);
      return (await ownerFor(id))[method](id, ...args);
    };
  }
  async function decorateRun(run) {
    const { controllers } = await bundle(releaseOwner(run.id).root);
    const controller = controllers.find(value => value.records.has(run.id));
    return controller ? controller.decorate(run) : run;
  }
  const get = supervisor.get;
  supervisor.get = async (id, ...args) => {
    const run = await get(id, ...args), directory = supervisor.runDirectory(id);
    run.benchmark_version = readRunVersion(directory, JSON.parse(readFileSync(path.join(directory, 'run.json'), 'utf8')), run);
    return run;
  };
  const api = createCapabilityServer(root, { port, upstreamPort: upstreamFor, supervisor, catalog, autoRecovery: false, decorateRun, ownsRun: directory => Boolean(releaseOwner(path.basename(directory))) });
  const handle = api.server.listeners('request')[0]; api.server.removeListener('request', handle);
  const reply = (res, status, value, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)); };
  api.server.on('request', async (req, res) => {
    if (!trustedVisionRequest(req, api.server.address()?.port || port, 8080)) return reply(res, 403, { error: 'Only trusted localhost requests are accepted.' });
    if (req.headers.origin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
    const url = new URL(req.url, 'http://' + req.headers.host), prefix = '/api/benchmark/v1/runs';
    try {
      if (req.method === 'GET' && url.pathname === '/api/benchmark/release/status') return reply(res, 200, { available: true, ascii_renderer: 2 });
      if (req.method === 'POST' && url.pathname === prefix) {
        let bytes = ''; for await (const chunk of req) { bytes += chunk; if (bytes.length > 32768) throw new Error('Request too large.'); }
        const spec = JSON.parse(bytes);
        if (spec.world && spec.world !== 'main-world') {
          const upstream = await fetch(`http://127.0.0.1:${await upstreamFor()}${prefix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bytes });
          return reply(res, upstream.status, await upstream.text());
        }
        const release = await prepareRuntimeRelease(root), owners = await bundle(release.root);
        await catalog.selection(spec, { force: true });
        const run = await launching.run(true, () => owners.choose(spec).launch(spec));
        if (spec.provider === 'prime-agent') await owners.recovery.enroll(run.id);
        return reply(res, 202, run);
      }
      if (req.method === 'GET' && url.pathname === prefix) {
        const upstream = await fetch(`http://127.0.0.1:${await upstreamFor()}${url.pathname}${url.search}`);
        const value = await upstream.json(); if (!upstream.ok) return reply(res, upstream.status, value);
        const runs = new Map((value.runs || []).map(run => [run.id, run]));
        for (const file of existsSync(releaseOwners) ? readdirSync(releaseOwners) : []) {
          const id = file.replace(/\.json$/, '');
          if (!/^run-[\dTZ-]+-[a-f0-9]{6}$/.test(id)) continue;
          try {
            // Frequent library/recovery polls only need signed scalar counters.
            // Immutable owners reconstruct and cache complete histories even
            // with details:false; doing that for every release exhausts heap.
            const run = url.searchParams.get('view') === 'library'
              ? await library.card(releaseOwner(id).directory, active.has(id))
              : await supervisor.get(id, { details: false });
            runs.set(id, await decorateRun(run));
          } catch { /* An incomplete launch may lack a checkpoint. */ }
        }
        return reply(res, 200, { ...value, runs: [...runs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)) });
      }
      const match = /^\/api\/benchmark\/v1\/runs\/(run-[\dTZ-]+-[a-f0-9]{6})\/record\/(.+)$/.exec(url.pathname);
      if (match && releaseOwner(match[1])) {
        const record = releaseOwner(match[1]), metadata = JSON.parse(readFileSync(path.join(record.directory, 'run.json'), 'utf8'));
        if (metadata.observation_mode === 'vision') {
          const owners = await bundle(record.root);
          await owners.choose(metadata).verifyRunCapabilityBoundary(metadata, record.directory);
          const { VisionRuntime } = await importAt(record.root, 'benchmarking/vision/runtime.mjs');
          const value = await (await VisionRuntime.open(record.root, record.directory)).readRecord(decodeURIComponent(match[2]));
          return value.frame ? reply(res, 200, await owners.renderer.render(value.frame), 'image/png') : reply(res, 200, value.content, 'text/plain');
        }
      }
      return handle(req, res);
    } catch (error) { return reply(res, 400, { error: error.message }); }
  });
  // Preload recorded owners so resume always uses its original installation.
  const ready = Promise.all([...new Set((existsSync(releaseOwners) ? readdirSync(releaseOwners) : []).map(file => releaseOwner(file.replace(/\.json$/, ''))?.root).filter(Boolean))].map(bundle));
  const shutdown = async () => {
    for (const pending of bundles.values()) {
      const value = await pending; value.transient.close(); await value.recovery.close();
      await Promise.allSettled(value.controllers.map(controller => controller.close()));
    }
    await Promise.allSettled([...active.keys()].map(id => supervisor.pause(id)));
    api.server.close(); api.server.closeAllConnections();
    await Promise.allSettled([...bundles.values()].map(async pending => (await pending).renderer.close()));
  };
  return { server: api.server, ready, supervisor, bundle, shutdown };
}

if (process.argv[1] === import.meta.filename) {
  const owner = createRuntimeReleaseServer(path.resolve(import.meta.dirname, '..'));
  await owner.ready;
  owner.server.listen(8090, '127.0.0.1', () => console.log('Versioned benchmark launches on localhost:8090'));
  process.once('SIGTERM', () => void owner.shutdown()); process.once('SIGINT', () => void owner.shutdown());
}
