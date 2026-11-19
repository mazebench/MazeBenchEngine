// A separate owner upgrades new Codex runs without replacing a pinned binary
// or restarting any existing benchmark process.
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import './codex-releases.mjs';
import { createCapabilityServer } from './capability-server.mjs';
import { CatalogSupervisor } from './model-catalog/supervisor.mjs';
import { VisionSupervisor } from './vision/supervisor.mjs';
import { createVisionServer } from './vision/server.mjs';
import { CodexTransientRecovery } from './codex-transient-recovery.mjs';
import { currentCodexCommand, admitCodexInstallation } from './codex-latest.mjs';

export function createCurrentCodexServers(root, options = {}) {
  const port = options.port ?? 8088, visionPort = options.visionPort ?? 8089;
  const upstreamPort = options.upstreamPort ?? 8087;
  const codexBin = options.codexBin || currentCodexCommand();
  admitCodexInstallation(codexBin);
  const ownerRoot = options.ownerRoot || path.join(os.homedir(), '.mazebench/current-codex-owner');
  const ascii = options.ascii || new CatalogSupervisor(root, { ...options, codexBin, ownerRoot });
  const vision = options.vision || new VisionSupervisor(root, { ...options, recordsRoot: options.visionRecordsRoot, codexBin, catalog: ascii.catalog });
  vision.active = ascii.active;
  vision.models = () => ascii.catalog.all();
  const marker = id => path.join(ownerRoot, id + '.json');
  const owns = directory => existsSync(marker(path.basename(directory)));
  const forRun = id => existsSync(path.join(vision.runDirectory(id), 'run.json')) ? vision : ascii;
  const remoteLaunch = async spec => {
    const response = await fetch(`http://127.0.0.1:${upstreamPort}/api/benchmark/v1/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Existing benchmark owner rejected launch.');
    return value;
  };
  const launchVision = vision.launch.bind(vision);
  vision.launch = async spec => {
    if ((spec.provider || 'codex') !== 'codex') return remoteLaunch(spec);
    await ascii.catalog.selection(spec, { force: true });
    const run = await launchVision(spec);
    await mkdir(ownerRoot, { recursive: true, mode: 0o700 });
    await writeFile(marker(run.id), JSON.stringify({ version: 1, id: run.id, observation_mode: 'vision' }), { flag: 'wx', mode: 0o600 });
    return run;
  };
  const supervisor = {
    projectRoot: root, recordsRoot: ascii.recordsRoot, active: ascii.active,
    runDirectory: id => forRun(id).runDirectory(id),
    validateSpec: spec => ascii.validateSpec(spec),
    launch: spec => (spec.provider || 'codex') === 'codex' ? ascii.launch(spec) : remoteLaunch(spec),
  };
  for (const method of ['get', 'pause', 'stop', 'resume', 'delete', 'record', 'displayFrame', 'listInterviews', 'createInterview']) {
    supervisor[method] = (id, ...args) => forRun(id)[method](id, ...args);
  }
  const imageOwner = createVisionServer(root, { port: visionPort, mainPort: options.mainPort || 8080, supervisor: vision });
  const api = createCapabilityServer(root, {
    ...options, port, visionPort, upstreamPort, autoRecovery: false, supervisor,
    catalog: ascii.catalog, ownsRun: owns, codexStatus: () => ascii.base.status(), currentCodexOwner: true,
  });
  const recovery = new CodexTransientRecovery({ ownerRoot, active: supervisor.active, forRun });
  api.server.on('listening', () => recovery.start());
  api.server.on('close', () => recovery.close());
  // PNG record routes use the same signed renderer as the original vision API.
  const handle = api.server.listeners('request')[0];
  api.server.removeListener('request', handle);
  api.server.on('request', (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const match = /^\/api\/benchmark\/v1\/runs\/(run-[\dTZ-]+-[a-f0-9]{6})\/record\//.exec(url.pathname);
    if (!match || !owns(vision.runDirectory(match[1])) || forRun(match[1]) !== vision) return handle(request, response);
    // Let the public handler perform the normal host/origin checks before any
    // read. The internal image server accepts only a rewritten local host.
    return import('./vision/server.mjs').then(({ trustedVisionRequest }) => {
      if (!trustedVisionRequest(request, api.server.address()?.port || port, options.mainPort || 8080)) {
        response.writeHead(403); response.end('Only trusted localhost requests are accepted.'); return;
      }
      request.headers.host = `127.0.0.1:${visionPort}`;
      imageOwner.server.emit('request', request, response);
    }).catch(error => { response.writeHead(500); response.end(error.message); });
  });
  return { server: api.server, visionServer: imageOwner.server, supervisor, ascii, vision, renderer: imageOwner.renderer, recovery };
}

if (process.argv[1] === import.meta.filename) {
  const owner = createCurrentCodexServers(path.resolve(import.meta.dirname, '..'));
  owner.visionServer.listen(8089, '127.0.0.1');
  owner.server.listen(8088, '127.0.0.1', () => console.log('Current Codex owner on localhost:8088'));
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    owner.recovery.close();
    await Promise.allSettled([...owner.supervisor.active.keys()].map(id => owner.supervisor.pause(id)));
    owner.server.close(); owner.visionServer.close();
    owner.server.closeAllConnections(); owner.visionServer.closeAllConnections();
    await owner.renderer.close();
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
