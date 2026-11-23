// Operator/HTTP projection only. Never mutate or reseal a run to add a label.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { safeReadFile } from './v1/safe-files.mjs';
import { readLiveWorld, readWorldRevision } from './storage/live-world.mjs';
import { repositoryRunVersion } from './run-version-label.mjs';
import { readVersionRegistry } from './version-store.mjs';
import { snapshotIdentity } from './version-catalogue.mjs';
const releases = JSON.parse(readFileSync(new URL('./benchmark-releases.json', import.meta.url), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const worldPrefix = 'level-data/v2/main-world/';
export const inventoryHash = files => hash(JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
const worldFiles = files => Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith(worldPrefix)));
function withRooms(files, revision) {
  return { ...files, ...Object.fromEntries(Object.entries(revision.rooms).map(([name, room]) => [worldPrefix + name, room.sha256])) };
}
export function readRunVersion(directory, metadata, summary = {}) {
  try {
    const encoded = safeReadFile(directory, 'integrity.json');
    if (!metadata.integrity?.manifest_sha256 || hash(encoded) !== metadata.integrity.manifest_sha256) throw new Error('Recorded integrity manifest does not match its pinned hash.');
    const manifest = JSON.parse(encoded), files = manifest.files, config = manifest.configuration;
    if (!files || !config) throw new Error('Recorded version manifest is incomplete.');
    const artifacts = Object.entries(files).filter(([name]) => /^engine\/.+\.wasm$/.test(name));
    const wasm = artifacts.length === 1 ? artifacts[0][1] : null;
    const engineRelease = releases.engines[wasm];
    const engine = { version: engineRelease?.version ?? null, sha256: wasm,
      source_commit: engineRelease?.source_commit ?? null,
      runtime_sha256: inventoryHash(Object.fromEntries(Object.entries(files).filter(([name]) => /^(engine|play)\//.test(name)))) };
    const history = (metadata.runtime_repairs || []).flatMap(repair => {
      const change = repair.files?.['engine/v1/voxel_physics.wasm'];
      return change && /^[a-f0-9]{64}$/.test(change.before) && /^[a-f0-9]{64}$/.test(change.after)
        && change.before !== change.after && repair.action_count > 0 && repair.action_count <= (summary.action_count ?? Infinity)
        ? [{ action: repair.action_count, before_sha256: change.before, after_sha256: change.after }] : [];
    });
    if (history.length) engine.history = history;
    const kind = config.world || metadata.world || 'main-world';
    const world = { name: { 'main-world': 'Main World', 'ice-maze': 'Ice Maze', slotski: 'Slotski' }[kind] || kind,
      version: null, sha256: null, policy: config.world_updates || 'frozen', edited: false };
    if (kind === 'main-world') {
      let baseFiles = worldFiles(files), availableFiles = baseFiles;
      if (!Object.keys(baseFiles).length) throw new Error('World inventory is missing.');
      if (config.world_updates === 'next-entry-v1') {
        const { base, head } = readLiveWorld(directory, config.world_base_sha256);
        baseFiles = withRooms(baseFiles, base);
        const revision = Number.isSafeInteger(summary.world_revision) ? summary.world_revision : null;
        world.observed_revision = revision;
        // A paused run must never be relabeled from edits published after it stopped.
        if (revision !== null) {
          if (revision > head.revision || revision < 0) throw new Error('Recorded world revision is unavailable.');
          availableFiles = withRooms(baseFiles, revision === 0 ? base : readWorldRevision(directory, revision));
        } else availableFiles = null;
      }
      world.sha256 = inventoryHash(baseFiles);
      world.available_sha256 = availableFiles ? inventoryHash(availableFiles) : null;
      const release = releases.worlds[world.sha256];
      world.version = release?.version ?? null;
      world.edited = release?.edited || Boolean(world.available_sha256 && world.available_sha256 !== world.sha256);
      world.parent_sha256 = release?.parent_sha256 ?? null;
    }
    if (kind !== 'main-world') {
      const identity = snapshotIdentity(files, null, { ...config, world: kind });
      engine.version = null; engine.sha256 = null; engine.runtime_sha256 = identity.engine; engine.source_commit = null; delete engine.history;
      world.sha256 = identity.world; world.available_sha256 = identity.world;
    }
    const result = { schema_version: 1, evidence: 'manifest', manifest_sha256: hash(encoded), engine, world };
    return repositoryRunVersion(result, 'current', readVersionRegistry().versions);
  } catch (error) {
    // Bad or absent provenance must stay visible without hiding the run itself.
    return repositoryRunVersion({ evidence: 'unavailable' });
  }
}
