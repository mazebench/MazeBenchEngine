import { versions, manifestVersions } from './version-registry.mjs';
import { legacyVersions } from './legacy-version-registry.mjs';

const exact = new Map(versions.map(v => [`${v.generation}:${v.engine}:${v.world}`, v.version]));
export function registerPresentationVersions(rows) {
  for (const row of rows) {
    if (row.generation !== '1.1' || !/^1\.1\.\d+$/.test(row.version) || ![row.engine, row.world].every(hash => /^[a-f0-9]{64}$/.test(hash))) continue;
    const key = `${row.generation}:${row.engine}:${row.world}`;
    if (exact.has(key) && exact.get(key) !== row.version) throw new Error('Conflicting version identity');
    exact.set(key, row.version);
  }
}
const legacy = new Map(legacyVersions.map(v => [v.version, v.engine]));
// Current versions use pinned inventories. Historical releases use the owner's
// explicit Git/date reconstruction policy, with that provenance retained.
export function versionPresentation(value = {}, registry = null) {
  const known = registry ? new Map(registry.map(row => [`${row.generation}:${row.engine}:${row.world}`, row.version])) : exact;
  const release = String(value?.benchmark_release || (value?.evidence === 'legacy-archive' ? '1.0' : '1.1')).split('.').slice(0, 2).join('.');
  const engine = value?.engine?.runtime_sha256;
  const world = value?.world?.available_sha256 || value?.world?.sha256;
  const assignment = value?.assignment;
  if (release === '1.0' && value?.evidence === 'legacy-git-timeline' && assignment?.policy === 'git-run-chronology-v1' &&
      legacy.has(value.assigned_version) && legacy.get(value.assigned_version) === engine && assignment.version === value.assigned_version) {
    const detail = [`Benchmark v${value.assigned_version}`, 'Historical release reconstructed from Git history and run dates.',
      ...(assignment.notes || []), `Run started: ${assignment.run_started_at}`, `Git commit: ${assignment.commit}`,
      `Commit date: ${assignment.commit_at}`, `Engine inventory SHA-256: ${engine}`, `World inventory SHA-256: ${world}`].join('\n');
    return { label: `v${value.assigned_version}`, detail, assigned_version: value.assigned_version, exact_version: null };
  }
  const version = (release !== '1.0' && known.get(`${release}:${engine}:${world}`)) ||
    (!engine && value.evidence === 'manifest' ? manifestVersions[value.manifest_sha256] : null) || null;
  const detail = [
    `Benchmark v${version || release + '.?'}`,
    release === '1.0' ? 'Prior run from an earlier repository.' : 'Run created in MazeBenchBenchmarking.',
    version ? 'Exact recorded engine + play adapter and world inventory. Catalogue numbers never change.' : 'This snapshot has not yet been catalogued or assigned a historical release.',
    value?.world?.policy === 'next-entry-v1' && 'Rooms adopt edits on entry; earlier actions and retained rooms may use earlier revisions.',
    value?.engine?.history?.length && 'This run has recorded engine changes; its latest snapshot does not describe the entire run.',
    value?.engine?.sha256 && `Recorded engine SHA-256: ${value.engine.sha256}`,
    engine && `Engine and adapter inventory SHA-256: ${engine}`,
    world && `Recorded world inventory SHA-256: ${world}`
  ].filter(Boolean).join('\n');
  return { label: `v${version || release + '.?'}`, detail, exact_version: version };
}

export function repositoryRunVersion(value = {}, origin = 'current', registry = null) {
  const result = { ...value, schema_version: 1, benchmark_release: origin === 'legacy' ? '1.0' : '1.1' };
  const presentation = versionPresentation(result, registry);
  return { ...result, ...presentation, classification: presentation.assigned_version ? 'historical-reconstruction' : presentation.exact_version ? 'catalogued-snapshot' : 'uncatalogued-snapshot' };
}

export function legacyRunVersion() {
  return repositoryRunVersion({ evidence: 'legacy-archive' }, 'legacy');
}
