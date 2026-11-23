import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BenchmarkSupervisor } from '../benchmarking/prime-direct-v2/supervisor.mjs';
import { directModel, samplingFor } from '../benchmarking/prime-direct-v2/catalog.mjs';
import { POLICY, TOOLS, verifyIntegrity } from '../benchmarking/prime-direct-v2/policy.mjs';
import { runDirect, createGameClient, primeCompletion } from '../benchmarking/prime-direct-v2/runner.mjs';
import { readCheckpointJson } from '../benchmarking/v1/checkpoint-json.mjs';
import { previewBenchmarkPrompt } from '../benchmarking/prompt-preview.mjs';
import { runCardValues } from '../benchmarking/ui/run-library.mjs';
import { createPrimeTimeline, consumePrimeEvent, primeTelemetry } from '../benchmarking/prime-telemetry.mjs';

const root = path.resolve(import.meta.dirname, '..');
const model = directModel({ id: 'fixture/model', supported_parameters: ['tools', 'reasoning', 'reasoning_effort', 'parallel_tool_calls'],
  specs: { context_window: 262144, max_output_tokens: 131072, supports_reasoning: true }, reasoning: { supported_efforts: ['low', 'max', 'high'] } });
class NoInference extends BenchmarkSupervisor { startDirect() {} }
async function fixture(t, limit = 2) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-prime-direct-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const supervisor = new NoInference(root, { recordsRoot: path.join(temp, 'records'), directStateRoot: path.join(temp, 'private'), directCatalog: async () => [model] });
  const run = await supervisor.launch({ provider: 'prime-agent', model: model.id, coding_mode: 'off', tools_enabled: false, effort: 'max', action_limit: limit });
  return { supervisor, run, root, directory: supervisor.runDirectory(run.id), home: path.join(temp, 'private', run.id) };
}
const response = (name, args = {}, extra = {}) => ({ id: 'provider-response', choices: [{ finish_reason: 'tool_calls', message: {
  role: 'assistant', reasoning_content: 'Remember this plan.', tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }], ...extra
} }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } });

test('context rejection retries preserve the conversation, tools and highest reasoning and record the effective output cap', async () => {
  const body = { model: model.id, max_tokens: 65536, reasoning: { enabled: true, effort: 'max' }, reasoning_effort: 'max',
    messages: [{ role: 'user', content: 'Preserve this context.' }], tools: [{ type: 'function', function: { name: 'maze_observe' } }] };
  const requests = [];
  const value = await primeCompletion(body, {}, async request => {
    requests.push(request);
    return requests.length === 1 ? new Response('{"error":{"code":"invalid_request"}}', { status: 400 }) : Response.json(response('maze_observe'));
  });
  assert.equal(requests.length, 2); assert.equal(requests[1].max_tokens, 32768);
  assert.deepEqual({ ...requests[1], max_tokens: 65536 }, body);
  assert.equal(value._output_budget, 32768); assert.equal(value._context_retries, 1);
  assert.deepEqual(body.max_tokens, 65536);
  let rejected = 0;
  await assert.rejects(primeCompletion(body, {}, async () => { rejected++; return new Response('', { status: 400 }); }), /HTTP 400/);
  assert.equal(rejected, 5);
  await assert.rejects(primeCompletion(body, { stopRequested: true }, async () => { throw new Error('Must not send'); }), /Run stopped/);
});

test('a server upgrade resumes v1 with its original runner, signed settings and saved conversation', { timeout: 90000 }, async t => {
  const { BenchmarkSupervisor: V1 } = await import('../benchmarking/prime-direct/supervisor.mjs');
  const { runDirect: runV1 } = await import('../benchmarking/prime-direct/runner.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'maze-prime-version-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const options = { recordsRoot: path.join(temp, 'records'), directStateRoot: path.join(temp, 'private'), directCatalog: async () => [model] };
  class PausedV1 extends V1 { startDirect() {} }
  const old = new PausedV1(root, options);
  const run = await old.launch({ provider: 'prime-agent', model: model.id, coding_mode: 'off', action_limit: 2 });
  const directory = old.runDirectory(run.id), home = path.join(options.directStateRoot, run.id), control = {};
  assert.equal(await runV1({ root, directory, home, control, complete: async () => {
    control.pauseRequested = true; return response('maze_sequence', { sequence: 'UD' });
  } }), 'paused');
  const saved = await readFile(path.join(home, 'conversation.json'), 'utf8');
  const signed = await readFile(path.join(directory, 'integrity.json'), 'utf8');
  const original = V1.prototype.startDirect; let resumed;
  V1.prototype.startDirect = function (id) { resumed = id; this.active.set(id, {}); };
  try {
    const upgraded = new BenchmarkSupervisor(root, options);
    const value = await upgraded.resume(run.id);
    assert.equal(resumed, run.id); assert.equal(value.harness, 'prime-inference-direct-v1');
    assert.equal(value.continuation_count, 1);
    assert.equal(await readFile(path.join(home, 'conversation.json'), 'utf8'), saved);
    assert.equal(await readFile(path.join(directory, 'integrity.json'), 'utf8'), signed);
  } finally { V1.prototype.startDirect = original; }
});

test('direct mode uses only advertised effort levels and preserves the native model catalog', () => {
  assert.deepEqual(model.efforts, ['low', 'high', 'max']);
  assert.equal(model.default_effort, 'max');
  assert.deepEqual(samplingFor(model).reasoning, { enabled: true, effort: 'max' });
  assert.equal(samplingFor(model).reasoning_effort, 'max');
  assert.throws(() => samplingFor(model, 'xhigh'), /not advertised/);
  const binary = directModel({ id: 'fixture/binary', supported_parameters: ['tools', 'reasoning'], specs: { supports_reasoning: true } });
  assert.deepEqual(binary.efforts, ['enabled']);
  assert.deepEqual(samplingFor(binary).reasoning, { enabled: true });
  assert.equal(samplingFor(binary).reasoning_effort, undefined);
  assert.equal(directModel({ supported_parameters: ['reasoning'] }), null);
});

test('signed Python-off condition has matching preview, label, and no Python or files in real MCP', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.run.harness, POLICY); assert.equal(f.run.tools_enabled, false);
  assert.equal(runCardValues(f.run).tools, '(tools off)');
  assert.match(runCardValues(f.run).meta, /Prime Inference/);
  const preview = await previewBenchmarkPrompt(root, { provider: 'prime-agent', coding_mode: 'off', action_limit: 2 });
  assert.equal(preview.prompt, await readFile(path.join(f.directory, 'prompt.md'), 'utf8'));
  const game = createGameClient(root, f.directory); t.after(() => game.close());
  assert.deepEqual((await game.call('tools/list')).tools.map(t => t.name), TOOLS);
  for (const name of ['python_exec', 'code_exec', 'bash']) await assert.rejects(game.call('tools/call', { name, arguments: {} }), /three MazeBench/);
  await assert.rejects(game.call('resources/read', { uri: 'file:///etc/passwd' }), /three MazeBench/);
  const metadata = JSON.parse(await readFile(path.join(f.directory, 'run.json')));
  await assert.rejects(verifyIntegrity(root, f.directory, { ...metadata, coding_mode: 'python' }), /configuration changed/);
  await assert.rejects(verifyIntegrity(root, f.directory, { ...metadata, sampling: { max_tokens: 1 } }), /configuration changed/);
  await assert.rejects(f.supervisor.validateSpec({ provider: 'prime-agent', model: model.id, coding_mode: 'any', tools_enabled: false }), /Python off/);
});

test('real game loop rejects invented executors, preserves reasoning, and counts cache usage once', { timeout: 90000 }, async t => {
  const f = await fixture(t); let calls = 0, usage;
  const result = await runDirect({ ...f, control: {}, onUsage: value => usage = { ...value }, complete: async body => {
    assert.equal(body.reasoning_effort, 'max');
    assert.deepEqual(body.tools.map(t => t.function.name), TOOLS);
    assert.equal(body.parallel_tool_calls, false);
    calls++;
    if (calls === 1) return response('python_exec', { code: 'throw Error()' });
    assert.equal(body.messages[1].reasoning_content, 'Remember this plan.');
    assert.match(body.messages[2].content, /No code executor/);
    return response('maze_sequence', { sequence: 'UD' });
  } });
  assert.equal(result, 'completed'); assert.equal(calls, 2);
  assert.equal((await readCheckpointJson(f.directory, 'summary.json')).action_count, 2);
  assert.deepEqual(usage, { input_tokens: 200, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 40, total_tokens: 240 });
  const timeline = createPrimeTimeline();
  for (const line of (await readFile(path.join(f.directory, 'agent-events.jsonl'), 'utf8')).trim().split('\n')) consumePrimeEvent(timeline, JSON.parse(line));
  const report = await primeTelemetry(timeline, f.run, async () => ({ rates: [1, 0.1, 1, 2], source: 'fixture' }));
  assert.deepEqual(report.totals, usage); assert.equal(report.api_estimate.request_count, 2);
  assert(Math.abs(report.api_estimate.usd - 0.000208) < 1e-12);
});

test('pause preserves pending tool calls and resume executes once without a repeated model request', { timeout: 90000 }, async t => {
  const f = await fixture(t); const control = {};
  assert.equal(await runDirect({ ...f, control, complete: async () => {
    control.pauseRequested = true; return response('maze_sequence', { sequence: 'UD' });
  } }), 'paused');
  assert.equal((await readCheckpointJson(f.directory, 'summary.json')).action_count, 0);
  const saved = JSON.parse(await readFile(path.join(f.home, 'conversation.json')));
  assert.equal(saved.pending.index, 0); assert.equal(saved.usage.input_tokens, 100);
  assert.equal(await runDirect({ ...f, control: {}, complete: async () => { throw new Error('Must not request again'); } }), 'completed');
  assert.equal((await readCheckpointJson(f.directory, 'summary.json')).action_count, 2);
  saved.inflight_tool = { id: 'uncertain-action' };
  await writeFile(path.join(f.home, 'conversation.json'), JSON.stringify(saved));
  await assert.rejects(runDirect({ ...f, control: {} }), /reconciliation/);
});

test('compaction retains the benchmark prompt and bills the summary with the same reasoning setting', { timeout: 90000 }, async t => {
  const f = await fixture(t); let requests = 0;
  const result = await runDirect({ ...f, control: {}, complete: async body => {
    requests++; assert.equal(body.reasoning_effort, 'max');
    if (requests === 1) {
      const value = response('maze_observe'); value.usage.prompt_tokens = 200000; return value;
    }
    if (requests === 2) {
      assert.equal(body.tools, undefined);
      assert.match(body.messages.at(-1).content, /Summarize this ongoing/);
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Observed HxI. Continue from here.' } }], usage: { prompt_tokens: 200100, completion_tokens: 30 } };
    }
    assert.equal(requests, 3); assert.equal(body.messages.length, 3);
    assert.match(body.messages[0].content, /TOOLS-OFF CONDITION/);
    assert.equal(body.messages[1].content, 'Observed HxI. Continue from here.');
    return response('maze_sequence', { sequence: 'UD' });
  } });
  assert.equal(result, 'completed');
  const state = JSON.parse(await readFile(path.join(f.home, 'conversation.json')));
  assert.equal(state.compactions, 1); assert.equal(state.usage.input_tokens, 400200);
  const timeline = createPrimeTimeline();
  for (const line of (await readFile(path.join(f.directory, 'agent-events.jsonl'), 'utf8')).trim().split('\n')) consumePrimeEvent(timeline, JSON.parse(line));
  assert.equal(timeline.requests.size, 3); assert.equal(timeline.compactions.length, 1);
  assert.equal(timeline.compactions[0].after_tokens, 120);
});
