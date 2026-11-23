import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDeepSeekTimeline, consumeDeepSeekEvent, deepseekTelemetry, findDeepSeekSession } from '../benchmarking/deepseek-telemetry.mjs';
import { TokenTelemetry, tokenBilling } from '../benchmarking/token-telemetry.mjs';
import { RunTelemetry, createThinkingTimeline, consumeThinkingEvent, thinkingReport } from '../benchmarking/run-telemetry.mjs';
import { createActivityClock, consumeActivityEvent, activeTimeReport } from '../benchmarking/active-run-time.mjs';

const native = (seq, type, data, time = seq * 1000) => ({ seq, time, type, data });
const usage = (inputTokens = 100, outputTokens = 20, cacheReadTokens = 300) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 50 });
const response = (seq, u = usage()) => native(seq, 'assistant/message', { message: { id: `m${seq}`, content: 'private response' }, usage: u });
const raw = (at, type, extra = {}) => ({ type, _received_at: new Date(at).toISOString(), _turn_id: 'one', ...extra });
const lines = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';

test('native context is per response, cache inclusive, and model agnostic; compaction usage is billed once without becoming context', () => {
  const timeline = createDeepSeekTimeline();
  const events = [native(1, 'request/context', { model: 'deepseek-flash', contextWindow: 1048576 }), response(2),
    native(3, 'compaction/start', { compactionId: 'a' }),
    native(4, 'compaction/summary', { compactionId: 'a', usage: usage(800, 50, 0), shadowedTokenCount: 900, summary: 'private summary' }),
    native(5, 'compaction/end', { compactionId: 'a' }), response(6, usage(10, 5, 0))];
  for (const event of events) { consumeDeepSeekEvent(timeline, event); consumeDeepSeekEvent(timeline, event); }
  const value = deepseekTelemetry(timeline, tokenBilling(timeline, 'deepseek-flash'), true);
  assert.equal(value.context_window, 1048576);
  assert.equal(value.compaction_threshold, null, 'Do not substitute a Codex or guessed threshold');
  assert.deepEqual(value.samples.map(s => s.tokens), [470, 65]);
  assert.deepEqual(value.compactions, [{ timestamp: 3000, ended_at: 5000, before_tokens: 470, after_tokens: 65 }]);
  assert.equal(value.totals.input_tokens, 1360);
  assert.equal(value.totals.cached_input_tokens, 300);
  assert.equal(value.totals.output_tokens, 75);
  assert.equal(timeline.usage_records.size, 3);
  assert(!JSON.stringify(value).includes('private'));
  consumeDeepSeekEvent(timeline, native(7, 'request/context', { model: 'claude-sonnet-5-5', contextWindow: 1000000 }));
  assert.equal(timeline.context_window, 1000000);
  consumeDeepSeekEvent(timeline, native(8, 'request/context', { model: 'gpt-6.1-terra', contextWindow: 500000 }));
  assert.equal(timeline.context_window, 500000);
  consumeDeepSeekEvent(timeline, native(9, 'request/context', { contextWindow: -1 }));
  assert.equal(timeline.context_window, 500000);
});

test('failed and unfinished compactions are not successful compactions; missing post-compaction context is unknown', () => {
  const timeline = createDeepSeekTimeline();
  for (const event of [response(1), native(2, 'compaction/start', { compactionId: 'failed' }),
    native(3, 'compaction/summary', { compactionId: 'failed', usage: usage() }),
    native(4, 'compaction/end', { compactionId: 'failed', error: 'failure' }),
    native(5, 'compaction/start', { compactionId: 'ok' }), native(6, 'compaction/end', { compactionId: 'ok' }),
    native(7, 'compaction/start', { compactionId: 'pending' })]) consumeDeepSeekEvent(timeline, event);
  assert.equal(timeline.compactions.length, 1);
  assert.equal(timeline.compactions[0].after_tokens, null);
  assert.equal(timeline.usage_records.size, 2, 'Failed compaction can still have billable usage');
});

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maze-deepseek-telemetry-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'run-2026-11-04T23-48-00-120Z-17e4dd', session = 'session-1e7f2c23-6fa6-4b44-9f8b-4cd7bc6c5170';
  const directory = path.join(root, id), homes = path.join(root, 'homes');
  const parent = path.join(homes, id, 'sessions', '--project--', session), file = path.join(parent, 'session.v4.jsonl');
  await mkdir(parent, { recursive: true }); await mkdir(path.join(directory, 'agent-cwd'), { recursive: true });
  const metadata = { id, provider: 'deepseek-harness', model: 'deepseek-flash', deepseek_session_id: session, status: 'paused' };
  await writeFile(path.join(directory, 'run.json'), JSON.stringify(metadata));
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify({ action_count: 0, actions: [] }));
  const header = { type: 'session', version: 4, id: session, cwd: path.join(directory, 'agent-cwd'), delegationDepth: 0 };
  return { directory, homes, file, header, metadata };
}

test('reader prefers native records, handles partial append/replacement, and falls back without double counting or inventing compactions', async t => {
  const f = await fixture(t), reader = new TokenTelemetry({ deepseekHomes: f.homes });
  const rawFile = path.join(f.directory, 'deepseek-events.jsonl');
  await writeFile(rawFile, lines([raw(2000, 'status', { phase: 'step_end', turn: 1, step: 1, usage: usage() })]));
  let value = await reader.read(f.directory);
  assert.equal(value.telemetry_source, 'deepseek-headless'); assert.equal(value.current_tokens, 470);
  assert.equal(value.compactions_available, false); assert.equal(value.context_window, null);
  const partial = JSON.stringify(response(3, usage(200)));
  await writeFile(f.file, lines([f.header, native(1, 'request/context', { contextWindow: 1048576 }), response(2)]) + partial.slice(0, 30));
  value = await reader.read(f.directory);
  assert.equal(value.telemetry_source, 'deepseek-session-v4'); assert.equal(value.totals.input_tokens, 450);
  assert.equal(value.samples.length, 1);
  await appendFile(f.file, partial.slice(30) + '\n');
  for (const result of await Promise.all([reader.read(f.directory), reader.read(f.directory)])) {
    assert.equal(result.samples.length, 2); assert.equal(result.current_tokens, 570);
    assert.equal(result.totals.input_tokens, 1000);
    assert(!JSON.stringify(result).includes('private response'));
  }
  await writeFile(f.file + '.new', lines([f.header, response(1, usage(10, 1, 0))]));
  await rename(f.file + '.new', f.file);
  assert.equal((await reader.read(f.directory)).current_tokens, 61);
  await rm(f.file);
  value = await reader.read(f.directory);
  assert.equal(value.current_tokens, 470); assert.equal(value.compactions_available, false);
});

test('session lookup validates cwd, identity, version, root session and rejects linked files', async t => {
  const f = await fixture(t);
  for (const change of [{ cwd: '/another-run' }, { id: 'another-session' }, { version: 99 }, { delegationDepth: 1 }]) {
    await writeFile(f.file, lines([{ ...f.header, ...change }, response(1)]));
    assert.equal(await findDeepSeekSession(f.metadata, f.directory, f.homes), null);
  }
  await writeFile(f.file, lines([f.header, response(1)]));
  assert.equal(await findDeepSeekSession(f.metadata, f.directory, f.homes), f.file);
  await rename(f.file, f.file + '.actual'); await symlink(f.file + '.actual', f.file);
  await assert.rejects(findDeepSeekSession(f.metadata, f.directory, f.homes), /ELOOP/);
});

test('DeepSeek thinking excludes parallel tool execution, failed turns, duplicate final text, and pauses', async t => {
  const events = [raw(0, 'session'), raw(100, 'status', { phase: 'turn_start' }),
    raw(1100, 'thinking', { text: 'private thought' }), raw(2100, 'tool_call', { callId: 'a', tool: 'maze_sequence' }),
    raw(2101, 'tool_call', { callId: 'b', tool: 'maze_observe' }), raw(3100, 'tool_result', { callId: 'a' }),
    raw(4100, 'tool_result', { callId: 'b' }), raw(4200, 'tool_result', { callId: 'b' }),
    raw(7100, 'text', { text: 'private response' }), raw(7200, 'status', { phase: 'turn_end', reason: { kind: 'completed' } }),
    raw(7300, 'final'), raw(20000, 'session', { _turn_id: 'two' }),
    raw(20100, 'status', { _turn_id: 'two', phase: 'turn_start' }),
    raw(25000, 'status', { _turn_id: 'two', phase: 'turn_end', reason: { kind: 'error', error: { message: 'quota' } } }),
    raw(25100, 'final', { _turn_id: 'two' })];
  const timeline = createThinkingTimeline();
  for (const e of events) consumeThinkingEvent(timeline, e, 'deepseek-harness');
  assert.deepEqual(timeline.episodes.map(e => e.duration_ms), [2000, 3000]);
  assert.equal(timeline.interruptions, 1);
  const report = thinkingReport(timeline, { metadata: { status: 'failed' }, runnerActive: true, summary: {}, compactions: [{ timestamp: 3500, ended_at: 5000 }] });
  assert.equal(report.current, null); assert.equal(report.episodes[1].compaction, true);
  assert.equal(report.median_ms, 2000); assert(!JSON.stringify(report).includes('private'));
  const f = await fixture(t); await writeFile(path.join(f.directory, 'deepseek-events.jsonl'), lines(events));
  assert.equal((await new RunTelemetry().read(f.directory)).thinking.count, 2, 'Uses the raw harness file, not agent-events');
  const clock = createActivityClock();
  for (const e of events) consumeActivityEvent(clock, e, { provider: 'deepseek-harness' });
  const active = activeTimeReport({ samples: [{ timestamp: 100, tokens: 1 }, { timestamp: 25000, tokens: 2 }] }, [clock]);
  assert.equal(active.time_axis.excluded_ms, 12800);
});
