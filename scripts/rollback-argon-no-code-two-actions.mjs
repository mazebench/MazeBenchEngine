// Operator-only, user-authorized recovery of the 12% no-code Argon run.
// Reconstruct an authenticated journal prefix; preserve the original generation,
// model, prompt, conversation, logs, world and every earlier action.
import assert from 'node:assert/strict';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { readCheckpointJson } from '../benchmarking/v1/checkpoint-json.mjs';
import { createJournal, verifyJournal } from '../benchmarking/storage/journal.mjs';
import { BenchmarkGameRuntime, loadBenchmarkAssets } from '../benchmarking/v1/runtime.mjs';
import { verifyIntegrity } from '../benchmarking/antigravity/policy.mjs';
import { originalStateHash } from './recalculate-gem-free-novelty-v1.mjs';

const root = path.resolve(import.meta.dirname, '..');
const id = 'run-2026-10-14T05-04-44-815Z-49c674';
const directory = '/Users/jpappas/records/mazebench-benchmark/' + id;
const receiptFile = '/tmp/mazebench-argon-no-code-rollback.json';
const from = 12434, to = 12432;
const changed = ['game-state.json', 'summary.json', 'display.json', 'run.json', 'checkpoint.json'];
const protectedFiles = ['integrity.json', 'prompt.md', 'antigravity-events.jsonl', 'agent-events.jsonl', 'tool-activity.jsonl'];
const encode = value => JSON.stringify(value, null, 2) + '\n';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function clone(source, destination) {
  const info = await stat(source);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const name of await readdir(source)) await clone(path.join(source, name), path.join(destination, name));
  } else {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination, constants.COPYFILE_FICLONE);
  }
}
async function publishFile(source, destination) {
  const temp = destination + '.operator-' + process.pid;
  await copyFile(source, temp, constants.COPYFILE_FICLONE);
  await rename(temp, destination);
}
function delta(value, change) {
  for (const key of change.remove || []) delete value[key];
  for (const [key, item] of Object.entries(change.set || {})) value[key] = item;
  for (const [key, array] of Object.entries(change.arrays || {})) {
    assert(Array.isArray(value[key]) && array.keep >= 0 && array.keep <= value[key].length);
    value[key].length = array.keep;
    for (const item of array.append) value[key].push(item);
  }
  for (const [key, map] of Object.entries(change.maps || {})) {
    for (const name of map.remove) delete value[key][name];
    for (const [name, item] of Object.entries(map.set)) value[key][name] = item;
  }
}
async function inactive() {
  const response = await fetch(`http://127.0.0.1:8092/api/benchmark/v1/runs/${id}?view=overview`, { signal: AbortSignal.timeout(30000) });
  assert(response.ok); const run = await response.json();
  assert.equal(run.runner_active, false); assert.equal(run.tools_enabled, false);
  assert.equal(run.action_count, from); assert.equal(run.gems_collected, 12);
  assert(['failed', 'paused'].includes(run.status));
  assert.notEqual(run.auto_recovery?.enabled, true, 'Disable automatic resume before publishing.');
}
async function original() {
  const metadata = await json(directory + '/run.json');
  assert.equal(metadata.id, id); assert.equal(metadata.model, 'gemini-4-argon-high');
  assert.equal(metadata.tools_enabled, false); assert.equal(metadata.effort, 'high');
  assert.equal(metadata.antigravity_session_id, '2436df67-c36b-44b1-bb32-458292c8c257');
  assert(['failed', 'paused'].includes(metadata.status));
  await verifyIntegrity(root, directory, metadata);
  const head = verifyJournal(directory, { full: true });
  assert.equal(head.summary.action_count, from); assert.equal(head.summary.gems_collected, 12);
  return { metadata, head };
}
async function prepare() {
  const { metadata, head } = await original();
  const hashes = {};
  for (const file of [...changed, ...protectedFiles]) hashes[file] = await hash(directory + '/' + file);
  const base = `journal/${head.generation}`;
  const state = await readCheckpointJson(directory, base + '/base-state.json');
  const summary = await readCheckpointJson(directory, base + '/base-summary.json');
  assert(state.actionCount <= to);
  const suffix = []; let revision = 0;
  const lines = createInterface({ input: createReadStream(directory + '/' + base + '/entries.jsonl', { end: head.bytes - 1 }), crlfDelay: Infinity });
  for await (const line of lines) {
    const entry = JSON.parse(line); assert.equal(entry.revision, ++revision);
    const count = entry.state.set?.actionCount;
    assert.equal(count, revision, 'This audited repair requires one action per revision.');
    if (count <= to) { delta(state, entry.state); delta(summary, entry.summary); }
    else suffix.push(...entry.state.arrays.actions.append);
  }
  assert.equal(revision, head.revision); assert.equal(state.actionCount, to);
  assert.equal(state.actions.length, to); assert.equal(summary.action_count, to);
  assert.equal(state.gemsCollected.length, 12); assert.equal(summary.gems_collected, 12);
  assert.equal(summary.room, 'JxE'); assert.equal(summary.rooms_visited, 83);
  assert.equal(originalStateHash(state, state.gemsCollected), state.stateHashes.at(-1));
  assert.deepEqual(suffix.map(action => [action.index, action.action]), [[12433, 'up'], [12434, 'up']]);
  const staging = await mkdtemp(path.join(directory, '.operator-rollback-'));
  for (const file of ['integrity.json', 'prompt.md', 'sandbox-state/integrity-key', 'world-updates']) await clone(directory + '/' + file, staging + '/' + file);
  const runtime = new BenchmarkGameRuntime(root, staging, await loadBenchmarkAssets(root, staging), state);
  assert.deepEqual(runtime.summary(), summary);
  const observation = await runtime.renderObservation({ includeColor: true });
  const display = await json(directory + `/display-history/move_${to}.json`);
  assert.equal(observation.level, display.level); assert.equal(observation.state_hash, state.stateHashes.at(-1));
  await createJournal(staging, state, summary, display, { ...observation, level: undefined, colored_level: undefined, records: undefined });
  const at = new Date().toISOString();
  const repair = { kind: 'operator-action-rollback', at, previous_action_count: from, action_count: to, removed_actions: 2,
    reason: 'User requested a one- or two-action rollback of the 12% no-code Argon run, then same-conversation resume.',
    gems_before: 12, gems_after: 12, original_generation: head.generation, original_checkpoint_sha256: hashes['checkpoint.json'],
    model_preserved: true, prompt_preserved: true, conversation_preserved: true, runtime_preserved: true, provider_logs_preserved: true };
  const next = { ...metadata, status: 'paused', error: null, completed_at: null, stopped_at: null, paused_at: at, updated_at: at,
    runtime_repairs: [...metadata.runtime_repairs || [], repair] };
  await writeFile(staging + '/run.json', encode(next), { mode: 0o600 });
  await verifyIntegrity(root, staging, next); verifyJournal(staging, { full: true });
  // Replay the two archived moves in memory. The original authenticated state
  // hashes must reproduce exactly; no replay writes are permitted.
  runtime.persist = async () => {};
  for (const action of suffix) {
    await runtime.apply(action.action);
    assert.equal(runtime.internal.stateHashes.at(-1), action.stateHash);
    assert.equal(runtime.internal.gemsCollected.length, action.totalGems);
  }
  for (const [file, digest] of Object.entries(hashes)) assert.equal(await hash(directory + '/' + file), digest, 'Original changed during preparation: ' + file);
  const future = suffix.flatMap(action => [`display-history/move_${action.index}.json`, `records/move_history/move_${action.index}.txt`, `records/move_history/move_${action.index}`]);
  const backup = directory + '/repairs/no-code-two-action-rollback-' + at.replaceAll(':', '-');
  await writeFile(receiptFile, encode({ id, from, to, staging, backup, hashes, future, repair, generation: verifyJournal(staging).generation }), { mode: 0o600 });
  console.log(encode({ prepared: true, id, from, to, score: '12%', replay_verified: true, staging, backup }));
}
async function apply() {
  const receipt = await json(receiptFile); assert.equal(receipt.id, id); assert.equal(receipt.to, to);
  await inactive(); await original();
  for (const [file, digest] of Object.entries(receipt.hashes)) assert.equal(await hash(directory + '/' + file), digest, 'Original changed: ' + file);
  const metadata = await json(receipt.staging + '/run.json'); await verifyIntegrity(root, receipt.staging, metadata);
  await mkdir(path.dirname(receipt.backup), { recursive: true, mode: 0o700 });
  await mkdir(receipt.backup, { mode: 0o700 });
  for (const file of [...changed, ...protectedFiles, 'journal', ...receipt.future]) await clone(directory + '/' + file, receipt.backup + '/' + file);
  await writeFile(receipt.backup + '/audit.json', encode({ ...receipt.repair, phase: 'prepared' }), { mode: 0o600 });
  await inactive(); assert.equal(await hash(directory + '/checkpoint.json'), receipt.hashes['checkpoint.json']);
  const newGeneration = 'journal/' + receipt.generation;
  await clone(receipt.staging + '/' + newGeneration, directory + '/' + newGeneration);
  try {
    for (const file of changed.filter(file => file !== 'checkpoint.json')) await publishFile(receipt.staging + '/' + file, directory + '/' + file);
    for (const file of receipt.future) await rm(directory + '/' + file, { recursive: true });
    await publishFile(receipt.staging + '/checkpoint.json', directory + '/checkpoint.json');
    await verifyIntegrity(root, directory, metadata); verifyJournal(directory, { full: true });
    const runtime = await BenchmarkGameRuntime.open(root, directory);
    assert.equal(runtime.internal.actionCount, to); assert.equal(runtime.internal.gemsCollected.length, 12);
    assert.equal(originalStateHash(runtime.internal, runtime.internal.gemsCollected), runtime.internal.stateHashes.at(-1));
    await assert.rejects(() => runtime.readRecord('move_history/move_12433.txt'));
    for (const file of protectedFiles) assert.equal(await hash(directory + '/' + file), receipt.hashes[file], 'Protected file changed: ' + file);
    await writeFile(receipt.backup + '/audit.json', encode({ ...receipt.repair, phase: 'applied', new_generation: receipt.generation }), { mode: 0o600 });
    console.log(encode({ applied: true, id, action_count: to, gems: 12, backup: receipt.backup }));
  } catch (error) {
    for (const file of changed) await publishFile(receipt.backup + '/' + file, directory + '/' + file);
    for (const file of receipt.future) { await rm(directory + '/' + file, { force: true, recursive: true }); await clone(receipt.backup + '/' + file, directory + '/' + file); }
    throw error;
  }
}
if (process.argv[2] === '--prepare') await prepare();
else if (process.argv[2] === '--apply') await apply();
else throw new Error('Use --prepare, review the result, then --apply.');
