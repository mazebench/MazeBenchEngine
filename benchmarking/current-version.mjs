import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { inventoryHash, sha256 } from './version-catalogue.mjs';
import { repositoryRunVersion } from './run-version-label.mjs';
import { updateVersionRegistry, registryFile } from './version-store.mjs';
import { asciiReleaseMarker, gameplayMarker, gameplayMarkerPath, gameplaySource } from './runtime-release-store.mjs';

export class CurrentVersions {
  constructor(root, { file = registryFile } = {}) { this.root = root; this.file = file; this.cache = new Map(); }
  hash(relative) {
    const file = path.join(this.root, relative), stat = statSync(file);
    const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (this.cache.get(relative)?.signature !== signature) {
      const bytes = readFileSync(file);
      if (relative.startsWith('level-data/') && relative.endsWith('.json')) JSON.parse(bytes);
      this.cache.set(relative, { signature, hash: sha256(bytes) });
    }
    return this.cache.get(relative).hash;
  }
  inventory(roots, { current = false, numbered = false } = {}) {
    const files = {};
    const walk = relative => {
      for (const entry of readdirSync(path.join(this.root, relative), { withFileTypes: true })) {
        const name = `${relative}/${entry.name}`;
        if (name === 'engine/v1/core' || (current && /^engine\/current\/build-info\./.test(name))) continue;
        if (entry.isDirectory()) walk(name);
        else if ((numbered ? /\.(mjs|json|md)$/ : /\.(mjs|wasm|json|py)$/).test(name)) files[name] = this.hash(name);
      }
    };
    for (const root of roots) walk(root);
    return files;
  }
  registerRun(value) {
    if (value?.evidence !== 'manifest' || !/^[a-f0-9]{64}$/.test(value.manifest_sha256 || '')) return value;
    const engine = value.engine?.runtime_sha256, world = value.world?.available_sha256 || value.world?.sha256;
    if (![engine, world].every(hash => /^[a-f0-9]{64}$/.test(hash || ''))) return value;
    const registry = updateVersionRegistry([{ generation: '1.1', engine, world }], { file: this.file });
    return repositoryRunVersion(value, 'current', registry.versions);
  }
  read() {
    const world = inventoryHash(this.inventory(['level-data/v2/main-world']));
    const compiled = JSON.parse(readFileSync(path.join(this.root, 'engine/current/build-info.json'), 'utf8'));
    const current = this.inventory(['engine/current', 'play/current'], { current: true });
    // Source edits are pending until compiled. Never label an old WASM as the new engine.
    if (current['engine/current/voxel_physics.wasm'] !== compiled.wasm.sha256) throw new Error('Engine build is in progress');
    for (const source of compiled.files) current[source.path] = source.sha256;
    const sourceNames = [];
    const scan = directory => { for (const entry of readdirSync(path.join(this.root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`; if (entry.isDirectory()) scan(file); else if (entry.isFile()) sourceNames.push(file);
    } };
    scan('engine/include'); scan('engine/src');
    const pending = sourceNames.length !== compiled.files.length || compiled.files.some(source => !sourceNames.includes(source.path) || this.hash(source.path) !== source.sha256);
    const benchmark = this.inventory(['engine/v1', 'play/v1']);
    if (existsSync(path.join(this.root, 'benchmarking/active-ascii-release.json'))) benchmark['engine/v1/ascii-v2.json'] = sha256(asciiReleaseMarker(this.root));
    if (existsSync(path.join(this.root, gameplaySource))) benchmark[gameplayMarkerPath] = sha256(gameplayMarker(this.hash(gameplaySource)));
    const snapshots = [
      { generation: '1.1', engine: inventoryHash(current), world },
      { generation: '1.1', engine: inventoryHash(benchmark), world }
    ];
    const numbered = ['ice-maze', 'slotski'].filter(kind => existsSync(path.join(this.root, kind, 'v1'))).map(kind => ({
      kind, generation: '1.1', engine: inventoryHash(this.inventory([`${kind}/v1`], { numbered: true })),
      world: inventoryHash(this.inventory([`level-data/${kind}/v1`], { numbered: true }))
    }));
    const registry = updateVersionRegistry([...snapshots, ...numbered], { file: this.file });
    const describe = snapshot => {
      const version = registry.versions.find(row => row.generation === snapshot.generation && row.engine === snapshot.engine && row.world === snapshot.world).version;
      return { version, label: `v${version}`, engine: snapshot.engine, world };
    };
    return { current: { ...describe(snapshots[0]), engine_build_pending: pending },
      benchmark: describe(snapshots[1]), benchmarks: { 'main-world': describe(snapshots[1]), ...Object.fromEntries(numbered.map(row => [row.kind, describe(row)])) }, versions: registry.versions.filter(row => row.generation === '1.1') };
  }
  start() {
    const refresh = () => { try { this.read(); } catch (error) { console.error(`Version registration: ${error.message}`); } };
    refresh(); this.timer = setInterval(refresh, 5000); this.timer.unref();
  }
  close() { clearInterval(this.timer); }
}
