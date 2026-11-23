import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CurrentVersions } from '../benchmarking/current-version.mjs';
import { readVersionRegistry, updateVersionRegistry } from '../benchmarking/version-store.mjs';
import { sha256 } from '../benchmarking/version-catalogue.mjs';
import { versionPresentation, registerPresentationVersions } from '../benchmarking/run-version-label.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maze-live-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, value) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), value); };
  await put('registry.mjs', 'export const versions = [];\nexport const manifestVersions = {};\n');
  const file = path.join(root, 'registry.mjs');
  const files = { 'engine/current/voxel_physics.wasm': 'compiled', 'engine/current/adapter.mjs': 'adapter',
    'play/current/session.mjs': 'current', 'engine/v1/engine.mjs': 'frozen', 'play/v1/session.mjs': 'frozen play',
    'engine/src/physics.cpp': 'physics source', 'engine/include/physics.h': 'header',
    'level-data/v2/main-world/world.json': '{}', 'level-data/v2/main-world/room.json': '{"wall":1}' };
  for (const [name, value] of Object.entries(files)) await put(name, value);
  const build = { wasm: { sha256: sha256('compiled') }, files: ['engine/src/physics.cpp', 'engine/include/physics.h'].map(name => ({ path: name, sha256: sha256(files[name]) })) };
  await put('engine/current/build-info.json', JSON.stringify(build));
  return { root, file, put, build, service: new CurrentVersions(root, { file }) };
}
test('edits register automatically, no-ops and restart preserve labels, and UI changes are excluded', async t => {
  const { root, file, put, service } = await fixture(t);
  const first = service.read(), original = await readFile(file, 'utf8');
  assert.deepEqual(service.read(), first);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.deepEqual(new CurrentVersions(root, { file }).read(), first);
  await put('ui/unrelated.mjs', 'new toolbar');
  assert.deepEqual(service.read(), first);
  await put('level-data/v2/main-world/room.json', '{"wall":2}');
  const edited = service.read();
  assert.notEqual(edited.current.version, first.current.version);
  assert.notEqual(edited.benchmark.version, first.benchmark.version);
  assert.deepEqual(edited.versions.slice(0, first.versions.length), first.versions);
  await put('engine/current/adapter.mjs', 'new adapter');
  const engine = service.read();
  assert.notEqual(engine.current.version, edited.current.version);
  assert.equal(engine.benchmark.version, edited.benchmark.version);
  await put('engine/current/adapter.mjs', 'adapter');
  await put('level-data/v2/main-world/room.json', '{"wall":1}');
  assert.equal(service.read().current.version, first.current.version);
});
test('unbuilt C++ edits stay pending; a completed engine build gets a new version', async t => {
  const { put, build, service } = await fixture(t);
  const first = service.read();
  await put('engine/src/physics.cpp', 'new physics');
  const pending = service.read();
  assert.equal(pending.current.version, first.current.version);
  assert.equal(pending.current.engine_build_pending, true);
  await put('engine/current/voxel_physics.wasm', 'new binary');
  assert.throws(() => service.read(), /build is in progress/);
  build.wasm.sha256 = sha256('new binary'); build.files[0].sha256 = sha256('new physics');
  await put('engine/current/build-info.json', JSON.stringify(build));
  const built = service.read();
  assert.notEqual(built.current.version, first.current.version);
  assert.equal(built.current.engine_build_pending, false);
  assert.equal(built.benchmark.version, first.benchmark.version);
  await put('engine/src/extra.cpp', 'new file');
  assert.equal(service.read().current.engine_build_pending, true);
});
test('observed run snapshots are registered without changing older world or engine identities', async t => {
  const { service } = await fixture(t);
  const version = { evidence: 'manifest', manifest_sha256: sha256('manifest'), engine: { runtime_sha256: sha256('historical engine') }, world: { sha256: sha256('old world') } };
  const first = service.registerRun(version);
  assert.match(first.label, /^v1\.1\.\d+$/);
  const edited = service.registerRun({ ...version, world: { ...version.world, available_sha256: sha256('new world') } });
  assert.notEqual(edited.label, first.label);
  assert.equal(service.registerRun(version).label, first.label);
  assert.equal(version.label, undefined);
  const unavailable = { evidence: 'unavailable' };
  assert.equal(service.registerRun(unavailable), unavailable);
});
test('concurrent writers append unique numbers and never lose registered snapshots', async t => {
  const { file } = await fixture(t);
  const module = pathToFileURL(path.resolve('benchmarking/version-store.mjs')).href;
  await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const code = `import {updateVersionRegistry} from ${JSON.stringify(module)}; updateVersionRegistry([{generation:'1.1',engine:${JSON.stringify(sha256('engine'+i))},world:${JSON.stringify(sha256('world'))}}],{file:${JSON.stringify(file)}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code]); let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; }); child.on('error', reject);
    child.on('close', status => status === 0 ? resolve() : reject(new Error(errors)));
  })));
  const result = readVersionRegistry(file);
  assert.equal(result.versions.length, 8);
  assert.equal(new Set(result.versions.map(v => v.version)).size, 8);
  const existing = result.versions[0];
  assert.deepEqual(updateVersionRegistry([existing], { file }), result);
});
test('browser presentation accepts refreshed registrations without a page reload', () => {
  const row = { generation: '1.1', version: '1.1.999999', engine: sha256('browser engine fixture'), world: sha256('browser world fixture') };
  const value = { engine: { runtime_sha256: row.engine }, world: { sha256: row.world } };
  assert.equal(versionPresentation(value).label, 'v1.1.?');
  registerPresentationVersions([row]);
  assert.equal(versionPresentation(value).label, 'v1.1.999999');
  assert.throws(() => registerPresentationVersions([{ ...row, version: '1.1.999998' }]), /Conflicting/);
});

test('background registration notices a saved world edit without a request', async t => {
  const { service, file, put } = await fixture(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  service.start();
  t.after(() => service.close());
  const before = readVersionRegistry(file).versions.length;
  await put('level-data/v2/main-world/room.json', '{"wall":3}');
  t.mock.timers.tick(5000);
  assert.equal(readVersionRegistry(file).versions.length, before + 2);
  t.mock.timers.tick(5000);
  assert.equal(readVersionRegistry(file).versions.length, before + 2);
});

test('numbered worlds have independent versions using their own engine and level data', async t => {
  const { service, put } = await fixture(t);
  await put('ice-maze/v1/engine.mjs', 'ice'); await put('level-data/ice-maze/v1/world.json', '{}');
  await put('slotski/v1/engine.mjs', 'slots'); await put('level-data/slotski/v1/world.json', '{}');
  const first = service.read();
  assert.notEqual(first.benchmarks['ice-maze'].label, first.benchmarks.slotski.label);
  await put('level-data/ice-maze/v1/world.json', '{"levels":[]}');
  const edited = service.read();
  assert.notEqual(edited.benchmarks['ice-maze'].label, first.benchmarks['ice-maze'].label);
  assert.equal(edited.benchmarks.slotski.label, first.benchmarks.slotski.label);
  assert.equal(edited.current.label, first.current.label);
});
