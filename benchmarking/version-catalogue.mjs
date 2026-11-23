// Read-only version identities. Model, effort, speed, and harness versions are
// separate dimensions: they must not create a new engine/world release number.
import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const inventoryHash = files => sha256(JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
export const WORLD_PREFIX = 'level-data/v2/main-world/';
export function snapshotIdentity(files, rooms = null, configuration = {}) {
  const kind = configuration.world || 'main-world', main = kind === 'main-world';
  const source = main ? files : configuration.world_runtime || {};
  const engineFiles = Object.fromEntries(Object.entries(source).filter(([name]) => main ? /^(engine|play)\//.test(name) : name.startsWith(`${kind}/`)));
  const worldFiles = Object.fromEntries(Object.entries(source).filter(([name]) => name.startsWith(main ? WORLD_PREFIX : `level-data/${kind}/`)));
  if (rooms) for (const [file, room] of Object.entries(rooms)) worldFiles[WORLD_PREFIX + file] = room.sha256;
  if (!Object.keys(engineFiles).length || !Object.keys(worldFiles).length) throw new Error('Missing engine/world inventory');
  return { engine: inventoryHash(engineFiles), world: inventoryHash(worldFiles),
    wasm: main ? files['engine/v1/voxel_physics.wasm'] || null : null, world_name: kind,
    inventory: inventoryHash(files), engine_files: engineFiles, world_files: worldFiles };
}

// Walk audited engine changes backward. A world revision seen before a repair
// must be paired with the old engine, never retroactively with today's binary.
export function engineFilesAt(files, repairs, at) {
  const result = { ...files };
  const later = repairs.filter(r => Date.parse(r.at) > Date.parse(at)).sort((a,b) => Date.parse(b.at) - Date.parse(a.at));
  for (const repair of later) for (const [file, change] of Object.entries(repair.files || repair.plan?.files || {})) {
    if (!/^(engine|play)\//.test(file)) continue;
    if (result[file] !== change.after || !/^[a-f0-9]{64}$/.test(change.before)) throw new Error(`Incomplete engine change history for ${file}`);
    result[file] = change.before;
  }
  return result;
}

// Append only. Finding an older archive later must never renumber an existing
// version. N is a catalogue ID, not an inferred semantic compatibility level.
export function registerVersions(previous, snapshots) {
  const entries = previous.map(value => ({ ...value }));
  const seen = new Map(), numbers = new Set();
  for (const entry of entries) {
    const key = `${entry.generation}:${entry.engine}:${entry.world}`;
    if (seen.has(key) || numbers.has(entry.version) || !new RegExp(`^${entry.generation.replaceAll('.', '\\.')}\\.\\d+$`).test(entry.version)) throw new Error('Conflicting version registry');
    seen.set(key, entry); numbers.add(entry.version);
  }
  for (const item of [...snapshots].sort((a, b) => String(a.first_seen || '').localeCompare(String(b.first_seen || '')) || `${a.engine}:${a.world}`.localeCompare(`${b.engine}:${b.world}`))) {
    if (!['1.0', '1.1'].includes(item.generation) || ![item.engine, item.world].every(v => /^[a-f0-9]{64}$/.test(v))) throw new Error('Invalid version fingerprint');
    const key = `${item.generation}:${item.engine}:${item.world}`;
    if (seen.has(key)) continue;
    const next = Math.max(-1, ...entries.filter(v => v.generation === item.generation).map(v => Number(v.version.split('.').at(-1)))) + 1;
    const entry = { version: `${item.generation}.${next}`, generation: item.generation, engine: item.engine, world: item.world };
    entries.push(entry); seen.set(key, entry);
  }
  return entries;
}
