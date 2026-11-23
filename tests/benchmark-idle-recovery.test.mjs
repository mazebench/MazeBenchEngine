import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BenchmarkSupervisor } from '../benchmarking/prime-direct/supervisor.mjs';
import { runDirect } from '../benchmarking/prime-direct/runner.mjs';
import { recoverIdleContinuation } from '../benchmarking/recover-idle-continuation.mjs';
const root = path.resolve(import.meta.dirname, '..');

test('idle recovery preserves signed game state, all conversation messages and usage, with backup and audit', { timeout: 90000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-idle-recovery-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  class NoInference extends BenchmarkSupervisor { startDirect() {} }
  const supervisor = new NoInference(root, { recordsRoot: path.join(temp, 'records'), directStateRoot: path.join(temp, 'private'),
    directCatalog: async () => [{ id: 'fixture/model', efforts: ['max'], default_effort: 'max', context_window: 1000000,
      max_output_tokens: 131072, parameters: ['tools', 'reasoning_effort'] }] });
  const run = await supervisor.launch({ provider: 'prime-agent', model: 'fixture/model', effort: 'max', coding_mode: 'off', action_limit: 1 });
  const directory = supervisor.runDirectory(run.id), home = path.join(temp, 'private', run.id);
  await assert.rejects(runDirect({ root, directory, home, control: {}, complete: async () => ({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'I am finished.' } }], usage: { prompt_tokens: 100, completion_tokens: 20 }
  }) }), /three responses/);
  const file = path.join(home, 'conversation.json'), beforeBytes = await readFile(file), before = JSON.parse(beforeBytes);
  const metadataFile = path.join(directory, 'run.json'), metadata = JSON.parse(await readFile(metadataFile));
  metadata.status = 'failed'; metadata.error = 'Prime returned three responses without a game tool call.';
  await writeFile(metadataFile, JSON.stringify(metadata));
  const checkpoint = await readFile(path.join(directory, 'checkpoint.json'));
  const integrity = await readFile(path.join(directory, 'integrity.json'));
  const args = { root, directory, home, assertInactive: async () => {} };
  await assert.rejects(recoverIdleContinuation({ ...args, assertInactive: async () => { throw new Error('Run became active'); } }), /became active/);
  assert((await readFile(file)).equals(beforeBytes));
  const recovery = await recoverIdleContinuation(args), after = JSON.parse(await readFile(file));
  assert.equal(after.idle_turns, 0); assert.equal(before.idle_turns, 3);
  assert.deepEqual(after.messages.slice(0, -1), before.messages);
  assert.deepEqual(after.usage, before.usage);
  assert.equal(after.messages.at(-1).role, 'user');
  assert.match(after.messages.at(-1).content, /operator requested.*resume/i);
  assert((await readFile(path.join(directory, 'checkpoint.json'))).equals(checkpoint));
  assert((await readFile(path.join(directory, 'integrity.json'))).equals(integrity));
  assert.equal((await readdir(path.join(home, 'operator-recovery-backups'))).length, 1);
  assert((await readFile(path.join(home, 'operator-recovery-backups', recovery.id + '.json'))).equals(beforeBytes));
  const audit = (await readFile(path.join(home, 'operator-recovery.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(audit.map(a => a.phase), ['prepared', 'applied']);
  assert.equal(await recoverIdleContinuation(args), null);
  // The output-budget variant uses the same audited continuation, retaining
  // the large reasoning response and its billed usage instead of deleting it.
  await writeFile(file, beforeBytes);
  metadata.error = 'Prime exhausted its output budget without a game tool call.';
  await writeFile(metadataFile, JSON.stringify(metadata));
  assert(await recoverIdleContinuation(args));
  const budget = JSON.parse(await readFile(file));
  assert.equal(budget.idle_turns, 0); assert.deepEqual(budget.usage, before.usage);
  assert.deepEqual(budget.messages.slice(0, -1), before.messages);
});
