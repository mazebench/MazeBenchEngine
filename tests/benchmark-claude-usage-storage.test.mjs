import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRunIntegrity } from '../benchmarking/v1/integrity.mjs';
import { BenchmarkGameRuntime } from '../benchmarking/v1/runtime.mjs';
import { readCheckpointJson } from '../benchmarking/v1/checkpoint-json.mjs';
import { CLAUDE_POLICY, digest, claudeTools, providerRuntimeHashes } from '../benchmarking/providers-v3/claude-policy.mjs';
const root = path.resolve(import.meta.dirname, '..'), model = 'claude-fable-5-2', sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const lines = values => values.map(v => JSON.stringify(v));
async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-claude-tail-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = path.join(temp, 'record'), claudeHome = path.join(temp, 'claude'); await mkdir(directory);
  const executable = path.join(temp, 'binary'); await writeFile(executable, 'fixture');
  const config = { storage_format: 'incremental-v1', world_updates: 'next-entry-v1', provider: 'claude-code', claude_policy: CLAUDE_POLICY,
    claude_executable: executable, claude_version: '2.1.293', claude_sha256: digest('fixture'), provider_runtime: await providerRuntimeHashes(root),
    model, effort: 'max', tools_enabled: false, action_limit: null, start_room: 'HxI', effective_prompt_sha256: digest('play') };
  const metadata = { ...config, id: 'run-2026-01-01T00-00-00-000Z-aaaaaa', claude_session_id: sessionId, status: 'failed', error: 'Claude reported usage for a different model.',
    integrity: await createRunIntegrity(root, directory, config) };
  await writeFile(path.join(directory, 'prompt.md'), 'play');
  const runtime = await BenchmarkGameRuntime.create(root, directory, { incremental: true, actionLimit: null });
  await runtime.apply('camera left'); const before = structuredClone(runtime.internal), at = before.updatedAt;
  await runtime.apply('camera right'); const after = structuredClone(runtime.internal), later = after.updatedAt;
  assert(Date.parse(later) > Date.parse(at));
  const events = [{ type: 'system', subtype: 'init', model, permissionMode: 'dontAsk', tools: claudeTools(false), mcp_servers: [{ name: 'mazebench', status: 'connected' }], session_id: sessionId, _turn_id: 'one', _received_at: at },
    { type: 'result', modelUsage: { [model]: {}, another: {} }, session_id: sessionId, _turn_id: 'one', _received_at: later }];
  const session = path.join(claudeHome, 'projects', 'fixture', sessionId + '.jsonl'); await mkdir(path.dirname(session), { recursive: true });
  await writeFile(session, lines([{ type: 'assistant', sessionId, timestamp: at, message: { model } }, { type: 'cost-state', sessionId, modelUsage: { [model]: {} } },
    { type: 'assistant', sessionId, timestamp: later, message: { model: 'another' } }, { type: 'cost-state', sessionId, modelUsage: { [model]: {}, another: {} } }]).join('\n') + '\n');
  const activities = [at, later].flatMap((time, i) => ['running', 'completed'].map(status => ({ id: String(i), at: time, status, action_count_after: i + 1 })));
  for (const [file, bytes] of Object.entries({ 'run.json': JSON.stringify(metadata), 'integrity-violation.json': JSON.stringify({ error: metadata.error, at: later }),
    'claude-events.jsonl': lines(events).join('\n') + '\n', 'agent-events.jsonl': '', 'tool-activity.jsonl': lines(activities).join('\n') + '\n' })) await writeFile(path.join(directory, file), bytes);
  return { root, directory, claudeHome, session, before, after, metadata, assertInactive: async () => {} };
}
test('usage-only recovery preserves every action and the exact signed checkpoint', async t => {
  const { recoverClaudeUsageReport } = await import('../benchmarking/recover-claude-usage-report.mjs');
  const f = await fixture(t), checkpoint = await readFile(path.join(f.directory, 'checkpoint.json'));
  const rawPath = path.join(f.directory, 'claude-events.jsonl'), rows = (await readFile(rawPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const final = rows.at(-1); final._received_at = new Date(Date.parse(final._received_at) + 100).toISOString(); final.is_error = true; final.api_error = 'rate_limit';
  rows.splice(1, 0, { type: 'assistant', _turn_id: 'one', message: { model, content: [{ type: 'text', text: 'play' }] } });
  await writeFile(rawPath, rows.map(JSON.stringify).join('\n') + '\n');
  await writeFile(path.join(f.directory, 'integrity-violation.json'), JSON.stringify({ error: f.metadata.error, at: final._received_at }));
  const session = (await readFile(f.session, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const e of session) if (e.type === 'assistant') e.message.model = model;
  session.push({ type: 'assistant', sessionId, timestamp: final._received_at, isApiErrorMessage: true, apiError: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: 'rate limit' }] } });
  await writeFile(f.session, session.map(JSON.stringify).join('\n') + '\n');
  const audit = await recoverClaudeUsageReport({ ...f, apply: true });
  assert.equal(audit.removed_actions, 0); assert.equal(audit.removed_error_messages, 1);
  assert.deepEqual(await readFile(path.join(f.directory, 'checkpoint.json')), checkpoint);
  assert.deepEqual(await readCheckpointJson(f.directory), f.after);
  assert.match(await readFile(f.session, 'utf8'), /another/); // Historical cost data stays visible.
  assert.doesNotMatch(await readFile(f.session, 'utf8'), /<synthetic>/);
});
