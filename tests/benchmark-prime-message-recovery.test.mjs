import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BenchmarkSupervisor } from '../benchmarking/prime-direct/supervisor.mjs';
import { recoverPrimeMessageContent, missingContentMessages } from '../benchmarking/recover-prime-message-content.mjs';
const root = path.resolve(import.meta.dirname, '..');

test('422 repair preserves reasoning, tool messages, usage and signed checkpoints, with backup and audit', { timeout: 90000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-message-recovery-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  class NoInference extends BenchmarkSupervisor { startDirect() {} }
  const supervisor = new NoInference(root, { recordsRoot: path.join(temp, 'records'), directStateRoot: path.join(temp, 'private'),
    directCatalog: async () => [{ id: 'fixture/model', efforts: ['max'], default_effort: 'max', context_window: 1000000,
      max_output_tokens: 131072, parameters: ['tools', 'reasoning_effort'] }] });
  const run = await supervisor.launch({ provider: 'prime-agent', model: 'fixture/model', effort: 'max', coding_mode: 'off', action_limit: 1 });
  const directory = supervisor.runDirectory(run.id), home = path.join(temp, 'private', run.id);
  const prompt = await readFile(path.join(directory, 'prompt.md'), 'utf8');
  const state = { run_id: run.id, messages: [{ role: 'user', content: prompt },
    { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'maze_observe', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: '{}' },
    { role: 'assistant', reasoning: 'Preserve all reasoning.', reasoning_details: [{ text: 'Preserve these details too.' }] },
    { role: 'user', content: 'Continue.' }], usage: { input_tokens: 100, output_tokens: 20 }, pending: null, inflight_tool: null, idle_turns: 1 };
  const file = path.join(home, 'conversation.json');
  await writeFile(file, JSON.stringify(state));
  const before = await readFile(file);
  const metadataFile = path.join(directory, 'run.json'), metadata = JSON.parse(await readFile(metadataFile));
  metadata.status = 'failed'; metadata.error = 'Prime inference returned HTTP 422.';
  await writeFile(metadataFile, JSON.stringify(metadata));
  const checkpoint = await readFile(path.join(directory, 'checkpoint.json')), integrity = await readFile(path.join(directory, 'integrity.json'));
  const args = { root, directory, home, assertInactive: async () => {} };
  await assert.rejects(recoverPrimeMessageContent({ ...args, assertInactive: async () => { throw new Error('Run became active'); } }), /became active/);
  assert((await readFile(file)).equals(before));
  const repair = await recoverPrimeMessageContent(args);
  const expected = structuredClone(state); expected.messages[3].content = '';
  assert.deepEqual(JSON.parse(await readFile(file)), expected);
  assert.deepEqual(repair.message_indices, [3]);
  assert((await readFile(path.join(home, 'operator-recovery-backups', repair.id + '.json'))).equals(before));
  assert((await readFile(path.join(directory, 'checkpoint.json'))).equals(checkpoint));
  assert((await readFile(path.join(directory, 'integrity.json'))).equals(integrity));
  const audit = (await readFile(path.join(home, 'operator-recovery.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(audit.map(a => a.phase), ['prepared', 'applied']);
  assert.deepEqual(missingContentMessages(expected.messages), []);
  assert.equal(await recoverPrimeMessageContent(args), null);
});
