import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile, mkdir, cp, rename, rm, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { currentRuntimeHashes } from './v1/integrity.mjs';
import { inventoryHash } from './version-catalogue.mjs';
import { registryFile, updateVersionRegistry } from './version-store.mjs';

export const releaseHome = path.join(os.homedir(), '.mazebench/runtime-releases');
export const releaseOwners = path.join(os.homedir(), '.mazebench/runtime-owners');
const digest = value => createHash('sha256').update(value).digest('hex');
const idPattern = /^run-[\dTZ-]+-[a-f0-9]{6}$/;
export function canonicalAsciiAssets(root) {
  return {
    'render-ascii/v1/glyph-contract.mjs': readFileSync(path.join(root, 'render-ascii/v2/glyph-contract.mjs'), 'utf8'),
    'render-ascii/v1/ascii-scene.mjs': readFileSync(path.join(root, 'render-ascii/v2/ascii-scene.mjs'), 'utf8').replaceAll('renderAsciiFrameV2', 'renderAsciiFrameV1')
  };
}
export function asciiReleaseMarker(root) {
  return JSON.stringify({ ascii_renderer: 2, files: Object.fromEntries(Object.entries(canonicalAsciiAssets(root)).map(([file, bytes]) => [file, digest(bytes)])) }) + '\n';
}
export const gameplaySource = 'benchmarking/v2/runtime.mjs';
export const gameplayMarkerPath = 'engine/v1/benchmark-gameplay.json';
export function gameplayMarker(runtimeHash) {
  return JSON.stringify({ benchmark_runtime_sha256: runtimeHash }) + '\n';
}
export function mainWorldReleaseAssets(root) {
  const runtime = readFileSync(path.join(root, gameplaySource));
  return {
    ...canonicalAsciiAssets(root),
    'engine/v1/ascii-v2.json': asciiReleaseMarker(root),
    'benchmarking/v1/runtime.mjs': runtime,
    [gameplayMarkerPath]: gameplayMarker(digest(runtime))
  };
}
export function releaseOwner(id) {
  if (!idPattern.test(id)) return null;
  try { return JSON.parse(readFileSync(path.join(releaseOwners, `${id}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function releaseRecordRoots() {
  if (!existsSync(releaseOwners)) return [];
  return [...new Set(readdirSync(releaseOwners).filter(name => name.endsWith('.json')).flatMap(name => {
    const owner = releaseOwner(name.slice(0, -5)); return owner ? [path.dirname(owner.directory)] : [];
  }))];
}
export async function saveReleaseOwner(id, owner) {
  if (!idPattern.test(id)) throw new Error('Invalid run ID.');
  await mkdir(releaseOwners, { recursive: true, mode: 0o700 });
  const file = path.join(releaseOwners, `${id}.json`);
  try { await writeFile(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || readFileSync(file, 'utf8') !== JSON.stringify(owner)) throw error; }
}
let preparing;
export async function prepareRuntimeRelease(root) {
  if (preparing) return preparing;
  preparing = buildRuntimeRelease(root);
  try { return await preparing; } finally { preparing = null; }
}
export async function buildRuntimeRelease(root, { installRoot = releaseHome, registryPath = registryFile } = {}) {
  const original = await currentRuntimeHashes(root), assets = mainWorldReleaseAssets(root);
  const hashes = { ...original, ...Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, digest(bytes)])) };
  // Harness changes get a new immutable installation, even when engine/world
  // version labels stay the same.
  const extra = {};
  async function scan(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await scan(file);
      else if (/\.(mjs|json|py|md)$/.test(file) && !file.includes('version-registry')) extra[file] = digest(await readFile(path.join(root, file)));
    }
  }
  await scan('benchmarking');
  const key = inventoryHash({ ...hashes, ...Object.fromEntries(Object.entries(extra).map(([file, hash]) => [`source:${file}`, hash])) });
  const releaseRoot = path.join(installRoot, key);
  if (!existsSync(path.join(releaseRoot, 'release.json'))) {
    const stage = `${releaseRoot}.${process.pid}.tmp`;
    await mkdir(stage, { recursive: true, mode: 0o700 });
    try {
      for (const name of ['benchmarking', 'engine/v1', 'play/v1', 'render', 'render-ascii/v1', 'level-data', 'ice-maze', 'slotski']) {
        if (existsSync(path.join(root, name))) await cp(path.join(root, name), path.join(stage, name), { recursive: true });
      }
      await writeFile(path.join(stage, 'package.json'), '{"type":"module"}\n');
      await symlink(path.join(root, 'node_modules'), path.join(stage, 'node_modules'));
      for (const [name, bytes] of Object.entries(assets)) await writeFile(path.join(stage, name), bytes);
      if (JSON.stringify(await currentRuntimeHashes(root)) !== JSON.stringify(original)) throw new Error('World/runtime changed while preparing release; retry.');
      const actual = await currentRuntimeHashes(stage);
      if (inventoryHash(actual) !== inventoryHash(hashes)) throw new Error('Release inventory does not match source.');
      await writeFile(path.join(stage, 'release.json'), JSON.stringify({ key, files: hashes }));
      await rename(stage, releaseRoot);
    } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  }
  const engine = inventoryHash(Object.fromEntries(Object.entries(hashes).filter(([name]) => /^(engine|play)\//.test(name))));
  const world = inventoryHash(Object.fromEntries(Object.entries(hashes).filter(([name]) => name.startsWith('level-data/v2/main-world/'))));
  const registry = updateVersionRegistry([{ generation: '1.1', engine, world }], { file: registryPath });
  const version = registry.versions.find(row => row.engine === engine && row.world === world && row.generation === '1.1').version;
  return { key, root: releaseRoot, version, engine, world };
}
