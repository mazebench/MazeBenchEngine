// One append-only catalogue shared by builders, editors, and report servers.
// Only public engine/world fingerprints are written; run records stay untouched.
import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync, openSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { registerVersions } from './version-catalogue.mjs';

export const registryFile = new URL('./version-registry.mjs', import.meta.url);
const caches = new Map();
export function readVersionRegistry(file = registryFile) {
  const key = String(file), stat = statSync(file), signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = caches.get(key);
  if (cached?.signature === signature) return cached.value;
  const text = readFileSync(file, 'utf8');
  const versions = text.match(/export const versions = ([\s\S]*?);\s*export const manifestVersions =/);
  const manifests = text.match(/export const manifestVersions = ([\s\S]*?);\s*$/);
  if (!versions || !manifests) throw new Error('Invalid version registry format');
  const value = { versions: JSON.parse(versions[1]), manifestVersions: JSON.parse(manifests[1]) };
  registerVersions(value.versions, []); // Reject conflicting or renumbered identities.
  caches.set(key, { signature, value });
  return value;
}
function lock(file) {
  const name = file instanceof URL ? new URL(`${file}.lock`) : `${file}.lock`;
  const until = Date.now() + 2500;
  while (true) {
    try {
      const fd = openSync(name, 'wx');
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return () => unlinkSync(name);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = Number(readFileSync(name, 'utf8'));
        if (owner > 0) {
          try { process.kill(owner, 0); } catch (e) { if (e.code === 'ESRCH') { unlinkSync(name); continue; } }
        } else if (Date.now() - statSync(name).mtimeMs > 30000) { unlinkSync(name); continue; }
      } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (Date.now() >= until) throw new Error('Version registry is busy; retry shortly');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
export function updateVersionRegistry(snapshots, { file = registryFile, manifests = {} } = {}) {
  // Resolve before locking for the overwhelmingly common no-change read.
  const initial = readVersionRegistry(file);
  const next = registerVersions(initial.versions, snapshots);
  if (next.length === initial.versions.length && Object.entries(manifests).every(([hash, version]) => initial.manifestVersions[hash] === version)) return initial;
  const release = lock(file);
  const temporary = file instanceof URL ? new URL(`${file}.${randomUUID()}.tmp`) : `${file}.${randomUUID()}.tmp`;
  try {
    const current = readVersionRegistry(file);
    const versions = registerVersions(current.versions, snapshots);
    const manifestVersions = { ...current.manifestVersions };
    for (const [hash, version] of Object.entries(manifests)) {
      if (manifestVersions[hash] && manifestVersions[hash] !== version) throw new Error('An existing manifest version cannot be changed');
      if (!versions.some(row => row.version === version)) throw new Error('Manifest refers to an unknown version');
      manifestVersions[hash] = version;
    }
    const source = '// Append-only snapshot IDs, shared by automatic registration and the historical catalogue. No run records.\n' +
      '// The 1.0 entries are research IDs; public legacy releases are in legacy-version-registry.mjs.\n' +
      `export const versions = ${JSON.stringify(versions, null, 2)};\nexport const manifestVersions = ${JSON.stringify(manifestVersions, null, 2)};\n`;
    writeFileSync(temporary, source, { flag: 'wx' });
    renameSync(temporary, file);
    caches.delete(String(file));
    return readVersionRegistry(file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    release();
  }
}
