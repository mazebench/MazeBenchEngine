// Rolling catalog/runtime upgrade: existing owners on 8080/8083 keep running.
import path from 'node:path';
import './codex-releases.mjs';
import { createCapabilityServer } from './capability-server.mjs';
import { CatalogSupervisor } from './model-catalog/supervisor.mjs';
export function createCatalogServer(root, options = {}) {
  const supervisor = options.supervisor || new CatalogSupervisor(root, options);
  return createCapabilityServer(root, { ...options, port: options.port ?? 8084,
    upstreamPort: options.upstreamPort || 8083, autoRecovery: false, supervisor,
    catalog: supervisor.catalog, ownsRun: directory => supervisor.owns(directory) });
}
if (process.argv[1] === import.meta.filename) {
  const port = Number(process.env.MAZEBENCH_CATALOG_PORT || 8084);
  const { server } = createCatalogServer(path.resolve(import.meta.dirname, '..'), { port,
    mainPort: Number(process.env.MAZEBENCH_BENCHMARK_PORT || 8080), upstreamPort: Number(process.env.MAZEBENCH_CAPABILITY_PORT || 8083) });
  server.listen(port, '127.0.0.1', () => console.log(`MazeBench model catalogs at http://localhost:${port}`));
}
