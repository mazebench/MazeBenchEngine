import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotIdentity, registerVersions, engineFilesAt } from '../benchmarking/version-catalogue.mjs';
import { versionPresentation } from '../benchmarking/run-version-label.mjs';
import { legacyVersions } from '../benchmarking/legacy-version-registry.mjs';
import { versions } from '../benchmarking/version-registry.mjs';
const hash = c => c.repeat(64);
const files = { 'engine/v1/voxel_physics.wasm': hash('a'), 'play/v1/adapter.mjs': hash('b'),
  'level-data/v2/main-world/world.json': hash('c'), 'level-data/v2/main-world/hxi.json': hash('d') };
test('version identities are stable across ordering, and separate engine from world edits', () => {
  const a = snapshotIdentity(files), b = snapshotIdentity(Object.fromEntries(Object.entries(files).reverse()));
  assert.equal(a.engine, b.engine); assert.equal(a.world, b.world);
  const edited = snapshotIdentity(files, { 'hxi.json': { sha256: hash('e') } });
  assert.equal(a.engine, edited.engine); assert.notEqual(a.world, edited.world);
  const provider = snapshotIdentity({ ...files, 'benchmarking/provider.mjs': hash('f') });
  assert.equal(a.engine, provider.engine); assert.equal(a.world, provider.world); assert.notEqual(a.inventory, provider.inventory);
});
test('discovering older evidence never renumbers a registered version', () => {
  const a = { generation: '1.1', ...snapshotIdentity(files), first_seen: '2026-10-01' };
  const first = registerVersions([], [a]);
  const b = { ...a, world: hash('f'), first_seen: '2026-01-01' };
  const next = registerVersions(first, [b, a]);
  assert.equal(next[0].version, '1.1.0'); assert.equal(next[1].version, '1.1.1');
  assert.deepEqual(registerVersions(next, [a, b]), next);
  assert.equal(registerVersions(next, [{ ...b, generation: '1.0' }]).at(-1).version, '1.0.0');
  assert.throws(() => registerVersions([...first, ...first], []), /Conflicting/);
});
test('numbered worlds use their own pinned JS engine and level data, not unused Main World assets', () => {
  const configuration = { world: 'slotski', world_runtime: {
    'slotski/v1/engine.mjs': hash('1'), 'level-data/slotski/v1/world.json': hash('2'),
    'ice-maze/v1/engine.mjs': hash('3'), 'level-data/ice-maze/v1/world.json': hash('4') } };
  const identity = snapshotIdentity(files, null, configuration);
  assert.equal(identity.wasm, null);
  assert.deepEqual(Object.keys(identity.engine_files), ['slotski/v1/engine.mjs']);
  assert.deepEqual(Object.keys(identity.world_files), ['level-data/slotski/v1/world.json']);
  assert.notEqual(identity.engine, snapshotIdentity(files).engine);
});
test('world histories before a repair keep the engine that was running then', () => {
  const file = 'engine/v1/voxel_physics.wasm';
  const changes = [{ at: '2026-10-02', files: { [file]: { before: hash('1'), after: hash('2') } } },
    { at: '2026-10-03', files: { [file]: { before: hash('2'), after: hash('a') } } }];
  assert.equal(engineFilesAt(files, changes, '2026-10-01')[file], hash('1'));
  assert.equal(engineFilesAt(files, changes, '2026-10-02T01:00Z')[file], hash('2'));
  assert.equal(engineFilesAt(files, changes, '2026-10-04')[file], hash('a'));
  assert.throws(() => engineFilesAt({ ...files, [file]: hash('9') }, changes, '2026-10-01'), /Incomplete/);
});
test('registered snapshots display exact N; unknown and legacy evidence never borrows a version', () => {
  const entry = versions.find(v => v.generation === '1.1');
  assert(entry);
  const value = { benchmark_release: '1.1', engine: { runtime_sha256: entry.engine }, world: { sha256: entry.world } };
  assert.equal(versionPresentation(value).label, `v${entry.version}`);
  assert.equal(versionPresentation({ ...value, world: { sha256: entry.world, available_sha256: hash('9') } }).label, 'v1.1.?');
  assert.equal(versionPresentation({ evidence: 'legacy-archive', label: 'v1.0.99' }).label, 'v1.0.?');
});
test('authorized chronological legacy assignments display concrete releases with honest provenance', () => {
  const entry = legacyVersions[0];
  const value = { benchmark_release: '1.0', evidence: 'legacy-git-timeline', assigned_version: entry.version,
    engine: { runtime_sha256: entry.engine }, world: { sha256: hash('1') },
    assignment: { policy: 'git-run-chronology-v1', version: entry.version, method: 'git-date',
      commit: 'a'.repeat(40), commit_at: '2026-07-01', run_started_at: '2026-07-02', notes: ['Assigned from Git history and the run date.'] } };
  const result = versionPresentation(value);
  assert.equal(result.label, 'v1.0.0'); assert.equal(result.exact_version, null);
  assert.equal(result.assigned_version, entry.version); assert.match(result.detail, /reconstructed/);
  assert.equal(versionPresentation({ ...value, engine: { runtime_sha256: hash('9') } }).label, 'v1.0.?');
});
