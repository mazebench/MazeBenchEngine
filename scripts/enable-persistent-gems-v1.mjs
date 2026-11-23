// Operator-only, exact-hash runtime upgrade. Never rewrites game checkpoints.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {cp, mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertRunConfiguration, verifyCheckpoint, verifyRunIntegrity} from '../benchmarking/v1/integrity.mjs';
import {readCheckpointJson} from '../benchmarking/v1/checkpoint-json.mjs';
import {verifyClaudeIntegrity} from '../benchmarking/providers/claude-policy.mjs';

const runtimeFile = 'benchmarking/v1/runtime.mjs';
export const persistentGemHashes = Object.freeze({
  before: 'cca05ef626880f907ca23ef7b23640fcc5fb0c21d99109c643d7f0208459bf65',
  after: '4df6576d0a4f3af3a16d86b3232c9eca4effe79ebd52ba3a1a0779901705b181'
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function atomic(file, bytes) {
  const temp = `${file}.persistent-gems-tmp`;
  await writeFile(temp, bytes, {flag: 'wx', mode: 0o600});
  await rename(temp, file);
}

export async function enablePersistentGems(root, directory, {backupDirectory, assertInactive}) {
  assert.equal(typeof assertInactive, 'function', 'An operator must confirm no active runner.');
  await assertInactive();
  const originalRun = await readFile(path.join(directory, 'run.json'));
  const originalManifest = await readFile(path.join(directory, 'integrity.json'));
  const checkpoint = await readFile(path.join(directory, 'checkpoint.json'));
  const metadata = JSON.parse(originalRun), manifest = JSON.parse(originalManifest);
  assert(['paused', 'stopped'].includes(metadata.status), 'Pause the run first.');
  assert(!metadata.world || metadata.world === 'main-world', 'Only MazeBench runs are supported.');
  assert.equal(metadata.provider, 'claude-code', 'This operator migration is validated for Claude runs only.');
  assert(!existsSync(path.join(directory, 'integrity-violation.json')), 'Cannot upgrade an invalidated run.');
  assert.equal(sha(originalManifest), metadata.integrity.manifest_sha256);
  assertRunConfiguration(metadata, manifest);
  verifyCheckpoint(directory);
  const before = await readCheckpointJson(directory);
  assert.equal(manifest.files[runtimeFile], persistentGemHashes.before, 'Unexpected original runtime.');
  assert.equal(sha(await readFile(path.join(root, runtimeFile))), persistentGemHashes.after, 'Unexpected replacement runtime.');
  manifest.files[runtimeFile] = persistentGemHashes.after;
  const encoded = JSON.stringify(manifest) + '\n';
  metadata.integrity = {...metadata.integrity, manifest_sha256: sha(encoded)};
  metadata.runtime_repairs = [...(metadata.runtime_repairs || []), {
    kind: 'operator-persistent-gems-update', at: new Date().toISOString(),
    action_count: before.actionCount,
    reason: 'Collected gems stay absent on fresh room entry, undo and reset. Preserve all existing game history and settings.',
    files: {[runtimeFile]: persistentGemHashes},
    previous_manifest_sha256: sha(originalManifest), manifest_sha256: sha(encoded),
    checkpoint_sha256: sha(checkpoint), backup: backupDirectory
  }];
  // Test the candidate against production checks before touching the real run.
  // Full copies retain every authenticated journal generation and room revision.
  const staging = await mkdtemp(path.join(os.tmpdir(), 'mazebench-persistent-gems-'));
  try {
    const candidate = path.join(staging, 'run');
    await cp(directory, candidate, {recursive: true});
    await writeFile(path.join(candidate, 'integrity.json'), encoded);
    await verifyClaudeIntegrity(root, candidate, metadata);
    assert.deepEqual(await readCheckpointJson(candidate), before);
    await assertInactive();
    assert((await readFile(path.join(directory, 'run.json'))).equals(originalRun), 'Run changed during preparation.');
    assert((await readFile(path.join(directory, 'checkpoint.json'))).equals(checkpoint), 'Checkpoint changed during preparation.');
    await mkdir(backupDirectory, {recursive: true, mode: 0o700});
    await writeFile(path.join(backupDirectory, 'run.json'), originalRun, {flag: 'wx', mode: 0o600});
    await writeFile(path.join(backupDirectory, 'integrity.json'), originalManifest, {flag: 'wx', mode: 0o600});
    try {
      await atomic(path.join(directory, 'integrity.json'), encoded);
      await atomic(path.join(directory, 'run.json'), JSON.stringify(metadata) + '\n');
      await verifyRunIntegrity(root, directory, metadata.integrity);
      await verifyClaudeIntegrity(root, directory, metadata);
      assert((await readFile(path.join(directory, 'checkpoint.json'))).equals(checkpoint));
      assert.deepEqual(await readCheckpointJson(directory), before);
    } catch (error) {
      await atomic(path.join(directory, 'integrity.json'), originalManifest);
      await atomic(path.join(directory, 'run.json'), originalRun);
      throw error;
    }
    return {id: metadata.id, action_count: before.actionCount, game_unchanged: true, backup: backupDirectory};
  } finally {
    await rm(staging, {recursive: true, force: true});
  }
}
