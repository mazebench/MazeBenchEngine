import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { codexReleaseAsset } from '../benchmarking/codex-latest.mjs';
import { CatalogSupervisor } from '../benchmarking/model-catalog/supervisor.mjs';

test('stable release selection requires the matching platform package and official checksum URL', () => {
  const name = 'codex-package-aarch64-apple-darwin.tar.gz';
  const release = { tag_name: 'rust-v0.169.0', assets: [{ name, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: `https://releases.openai.com/codex/releases/0.169.0/${name}` }] };
  assert.equal(codexReleaseAsset(release, 'darwin', 'arm64').version, '0.169.0');
  for (const change of [r => r.tag_name = 'nightly', r => r.assets[0].digest = 'unverified', r => r.assets[0].browser_download_url = 'https://example.com/package', r => r.assets[0].name = 'codex-package-x86_64-apple-darwin.tar.gz']) {
    const value = structuredClone(release); change(value); assert.throws(() => codexReleaseAsset(value, 'darwin', 'arm64'));
  }
});

test('new launches resolve latest every time; existing runs retain their exact executable', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'maze-latest-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const bins = [];
  for (const version of ['0.159.2', '0.164.0']) {
    const file = path.join(temporary, 'codex-' + version);
    await writeFile(file, `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`); await chmod(file, 0o700); bins.push(await realpath(file));
  }
  let selection = 0, starts = 0;
  const catalog = { selection: async () => ({}), all: async () => ({ models: [] }) };
  const supervisor = new CatalogSupervisor(process.cwd(), { catalog, recordsRoot: path.join(temporary, 'records'), ownerRoot: path.join(temporary, 'owners'),
    codexBin: path.join(temporary, 'removed-release'), latestCodex: async () => ({ executable: bins[selection++] }) });
  const first = await supervisor.codexRuntime(bins[0]), second = await supervisor.codexRuntime(bins[1]);
  assert.notEqual(first, second);
  assert.equal(first.active, supervisor.active); assert.equal(second.active, supervisor.active);
  for (const [index, runtime] of [first, second].entries()) runtime.launch = async spec => {
    starts++; const id = `run-2026-11-13T00-00-00-000Z-${index ? 'bbbbbb' : 'aaaaaa'}`;
    const directory = runtime.runDirectory(id); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'run.json'), JSON.stringify({ ...spec, capability_policy: { codex_executable: runtime.codexBin } }));
    return { id };
  };
  const oldRun = await supervisor.launch({ model: 'gpt-6-astra', provider: 'codex', coding_mode: 'off' });
  const newRun = await supervisor.launch({ model: 'gpt-6-astra', provider: 'codex', coding_mode: 'off' });
  assert.equal(selection, 2); assert.equal(starts, 2);
  assert.equal((await supervisor.forRun(oldRun.id)).codexBin, bins[0]);
  assert.equal((await supervisor.forRun(newRun.id)).codexBin, bins[1]);
  assert.equal(selection, 2, 'Reading/resuming a pinned run must not select a new release.');
});
