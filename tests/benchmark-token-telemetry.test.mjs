import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { modelTokenLimits, createTokenTimeline, consumeTokenEvent, TokenTelemetry, requestApiCost, tokenBilling } from "../benchmarking/token-telemetry.mjs";
import { comparisonSeries } from "../benchmarking/comparison-report.mjs";

const sample = (tokens, timestamp = "2026-09-04T19:30:00Z") => ({ timestamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: tokens }, total_token_usage: { total_tokens: 9_000_000 }, model_context_window: 258400 } } });

test("Claude resume reports price each request once across live updates and cold reads", async t => {
  const run = await mkdtemp(path.join(os.tmpdir(), "mazebench-resume-cost-"));
  t.after(() => rm(run, {recursive:true, force:true}));
  const model = "claude-sonnet-5";
  const metadata = {model, provider:"claude-code"};
  await writeFile(path.join(run, "run.json"), JSON.stringify(metadata));
  const file = path.join(run, "claude-events.jsonl");
  const append = (turn, event) => appendFile(file, JSON.stringify({...event, session_id:"same-session",
    _turn_id:turn, _received_at:"2026-11-09T12:00:00Z"}) + "\n");
  const message = (id, usage) => ({type:"assistant", message:{id, model, usage}});
  const result = (usage, cost) => ({type:"result", usage, total_cost_usd:cost});
  const usage = {input_tokens:1000, cache_read_input_tokens:300, cache_creation_input_tokens:100,
    cache_creation:{ephemeral_1h_input_tokens:100}, output_tokens:50};
  const zero = {input_tokens:0, output_tokens:0};
  const requestCost = requestApiCost(model, {input_tokens:1400, cached_input_tokens:300,
    cache_write_input_tokens:100, cache_write_long_input_tokens:100, output_tokens:50});
  await append("first", message("a", usage));
  await append("first", result(usage, 414.55));
  const reader = new TokenTelemetry();
  assert.equal((await reader.read(run)).api_estimate.usd, 414.55);

  await append("resume", message("b", usage));
  await append("resume", result({...usage, output_tokens:60}, 415));
  const check = async (reader, responses, expectedCost, tokens) => {
    const {records, telemetry} = await reader.comparisonUsage(run);
    const end = comparisonSeries({actions:[]}, records, metadata).performance.at(-1);
    assert.ok(Math.abs(telemetry.api_estimate.usd - expectedCost) < 1e-12);
    assert.equal(end.cost_usd, telemetry.api_estimate.usd);
    assert.equal(end.total_tokens, tokens);
    assert.equal(telemetry.total_tokens, tokens);
    assert.equal(end.responses, responses);
    assert.equal(telemetry.api_estimate.request_count, responses);
  };
  const cost = 2 * requestCost + requestApiCost(model, {input_tokens:0, output_tokens:10});
  await check(reader, 2, cost, 2910);
  await append("retry", message("c", zero));
  await append("retry", result(zero, 415));
  await append("retry", result(zero, 415));
  await append("active", message("d", usage));
  await check(reader, 4, cost + requestCost, 4360);
  await append("active", {type:"result", is_error:true, total_cost_usd:415});
  await check(new TokenTelemetry(), 4, cost + requestCost, 4360);
});

test("a retry with zero tokens costs zero even before its model has published rates", async t => {
  const run = await mkdtemp(path.join(os.tmpdir(), "mazebench-zero-retry-"));
  t.after(() => rm(run, {recursive:true, force:true}));
  const metadata = {model:"unpriced-claude-fixture", provider:"claude-code"};
  await writeFile(path.join(run, "run.json"), JSON.stringify(metadata));
  const result = {type:"result", _turn_id:"retry", _received_at:"2026-11-09T12:00:00Z",
    total_cost_usd:414.55, usage:{input_tokens:0, output_tokens:0}};
  await writeFile(path.join(run, "claude-events.jsonl"), JSON.stringify(result) + "\n");
  const {records, telemetry} = await new TokenTelemetry().comparisonUsage(run);
  const end = comparisonSeries({actions:[]}, records, metadata).performance.at(-1);
  assert.equal(telemetry.api_estimate.usd, 0);
  assert.equal(telemetry.api_estimate.unpriced_requests, 0);
  assert.equal(end.cost_usd, 0);
  assert.equal(end.responses, 0);
});

test("rollout discovery skips absent date folders and still rejects directory links", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mazebench-rollout-test-"));
  try {
    const metadata = { codex_thread_id: "01a06de5-cf11-7883-9f85-b1197dd668f5", created_at: "2026-09-04T01:00:00Z" };
    const telemetry = new TokenTelemetry({ codexHome: home });
    assert.equal(await telemetry.findRollout(metadata), null);
    const previous = path.join(home, "sessions/2026/09/03");
    await mkdir(previous, { recursive: true });
    const file = path.join(previous, `rollout-local-${metadata.codex_thread_id}.jsonl`);
    await writeFile(file, "");
    assert.equal(await telemetry.findRollout(metadata), await realpath(file));
    await symlink(previous, path.join(home, "sessions/2026/09/04"), "dir");
    await assert.rejects(telemetry.findRollout(metadata), /symbolic links/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("API estimates count cached tokens once, price each request's context tier and include compaction once", () => {
  const usage = { input_tokens: 200000, cached_input_tokens: 150000, output_tokens: 10000, reasoning_output_tokens: 8000 };
  assert(Math.abs(requestApiCost("gpt-6-astra", usage) - 1.15) < 1e-9);
  assert(Math.abs(requestApiCost("gpt-6-astra", { input_tokens: 1e6, cached_input_tokens: 600000, cache_write_input_tokens: 100000, output_tokens: 20000 }) - 11.2) < 1e-9);
  assert.equal(requestApiCost("unknown-model", usage), null);
  const timeline = createTokenTimeline();
  const payload = { response_id: "one", usage };
  consumeTokenEvent(timeline, { type: "token_usage_record", timestamp: "2026-09-04T19:30:00Z", payload });
  consumeTokenEvent(timeline, { type: "compacted", timestamp: "2026-09-04T19:31:00Z", payload: { latest_token_usage_record: payload } });
  consumeTokenEvent(timeline, { type: "token_usage_record", timestamp: "2026-09-04T19:32:00Z", payload: { response_id: "two", usage } });
  const billing = tokenBilling(timeline, "gpt-6-astra");
  assert.equal(billing.totals.input_tokens, 400000);
  assert.equal(billing.totals.cached_input_tokens, 300000);
  assert.equal(billing.totals.output_tokens, 20000);
  assert.equal(billing.totals.total_tokens, 420000);
  assert.equal(billing.api_estimate.request_count, 2);
  assert(Math.abs(billing.api_estimate.usd - 2.3) < 1e-9); // Combined input must not trigger the long tier.
});

test("context chart uses the last model context and Codex's actual compaction threshold", () => {
  assert.deepEqual(modelTokenLimits({ context_window: 272000, effective_context_window_percent: 95 }), { compaction_threshold: 244800, context_window: 258400 });
  assert.equal(modelTokenLimits({ context_window: 272000, auto_compact_token_limit: 100000 }).compaction_threshold, 100000);
  assert.equal(modelTokenLimits({ context_window: 272000, auto_compact_token_limit: 999999 }).compaction_threshold, 244800);
  assert.deepEqual(modelTokenLimits(), { compaction_threshold: null, context_window: null });
  const timeline = createTokenTimeline();
  consumeTokenEvent(timeline, sample(253433));
  consumeTokenEvent(timeline, { timestamp: "2026-09-04T19:31:00Z", type: "compacted", payload: { replacement_history: [{ secret: "never expose" }] } });
  consumeTokenEvent(timeline, sample(9749, "2026-09-04T19:31:01Z"));
  assert.deepEqual(timeline.samples.map(value => value.tokens), [253433, 9749]);
  assert.equal(timeline.compactions[0].before_tokens, 253433);
  assert.equal(timeline.compactions[0].after_tokens, 9749);
  assert(!JSON.stringify(timeline).includes("secret"));
});

test("live token telemetry reads appended events once, tolerates partial lines and never returns transcript content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mazebench-token-test-"));
  try {
    const run = path.join(root, "run");
    const home = path.join(root, "codex");
    const id = "01a06de5-cf11-7883-9f85-b1197dd668f5";
    const sessions = path.join(home, "sessions/2026/09/04");
    await mkdir(sessions, { recursive: true });
    await mkdir(path.join(run, "sandbox-state"), { recursive: true });
    await writeFile(path.join(run, "run.json"), JSON.stringify({ model: "gpt-6-astra", codex_thread_id: id, created_at: "2026-09-04T19:29:31Z" }));
    await writeFile(path.join(run, "sandbox-state/direct-model-catalog.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra", context_window: 272000 }] }));
    const file = path.join(sessions, `rollout-2026-09-04T13-29-32-${id}.jsonl`);
    const second = JSON.stringify(sample(200, "2026-09-04T19:31:00Z"));
    await writeFile(file, `${JSON.stringify(sample(100))}\n${second.slice(0, 50)}`);
    const telemetry = new TokenTelemetry({ codexHome: home });
    const first = await telemetry.read(run);
    assert.equal(first.current_tokens, 100);
    assert.equal(first.compaction_threshold, 244800);
    await appendFile(file, `${second.slice(50)}\n${JSON.stringify({ timestamp: "2026-09-04T19:32:00Z", type: "response_item", payload: { text: "private-transcript" } })}\n`);
    const results = await Promise.all([telemetry.read(run), telemetry.read(run)]);
    for (const result of results) {
      assert.equal(result.current_tokens, 200);
      assert.equal(result.samples.length, 2);
      assert(!JSON.stringify(result).includes("private-transcript"));
    }
    await writeFile(file, `${JSON.stringify(sample(50))}\n`);
    assert.equal((await telemetry.read(run)).samples.length, 1);
    assert.equal((await telemetry.read(run)).current_tokens, 50);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Codex usage survives live-to-zstd rotation, archive relocation, and a new reader', async () => {
  const {zstdCompressSync}=await import('node:zlib');
  const {rename,unlink}=await import('node:fs/promises');
  const root=await mkdtemp(path.join(os.tmpdir(),'mazebench-compressed-usage-'));
  try {
    const home=path.join(root,'codex'),run=path.join(root,'run');
    const id='01a06de5-cf11-7883-9f85-b1197dd668f5', sessions=path.join(home,'sessions/2026/09/04');
    await mkdir(sessions,{recursive:true}); await mkdir(run);
    await writeFile(path.join(run,'run.json'),JSON.stringify({id:'run-test',model:'gpt-6-astra',codex_thread_id:id,created_at:'2026-09-04T19:29:31Z'}));
    const event=(response,timestamp)=>({type:'token_usage_record',timestamp,payload:{response_id:response,usage:{input_tokens:100,cached_input_tokens:80,output_tokens:10}}});
    const first=event('one','2026-09-04T19:30:00Z'),second=event('two','2026-09-04T19:31:00Z');
    const plain=path.join(sessions,`rollout-local-${id}.jsonl`),compressed=plain+'.zst';
    await writeFile(plain,JSON.stringify(first)+'\n');
    const reader=new TokenTelemetry({codexHome:home});
    assert.equal((await reader.comparisonUsage(run)).records.length,1);
    // Include a large irrelevant line, Unicode split across decode buffers,
    // repeated accounting evidence, and a valid last line without a newline.
    const secret={type:'response_item',payload:{text:'private λ '.repeat(220000)}};
    const archive=[first,secret,first,second,sample(110)].map(JSON.stringify).join('\n');
    await writeFile(compressed,zstdCompressSync(Buffer.from(archive))); await unlink(plain);
    for (const value of await Promise.all([reader.comparisonUsage(run),reader.comparisonUsage(run)])) {
      assert.equal(value.records.length,2);assert.equal(value.telemetry.totals.input_tokens,200);
      assert.equal(value.telemetry.totals.cached_input_tokens,160);assert.equal(value.telemetry.totals.output_tokens,20);
      assert(!JSON.stringify(value).includes('private λ'));
    }
    await mkdir(path.join(home,'archived_sessions'));
    await rename(compressed,path.join(home,'archived_sessions',path.basename(compressed)));
    assert.equal((await reader.comparisonUsage(run)).records.length,2);
    assert.equal((await new TokenTelemetry({codexHome:home}).comparisonUsage(run)).records.length,2);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('corrupt compressed logs fail visibly and replacement archives can be read', async () => {
  const {zstdCompressSync}=await import('node:zlib');
  const root=await mkdtemp(path.join(os.tmpdir(),'mazebench-corrupt-usage-'));
  try {
    const id='01a06de5-cf11-7883-9f85-b1197dd668f5',run=path.join(root,'run'),folder=path.join(root,'sessions/2026/09/04');
    await mkdir(run);await mkdir(folder,{recursive:true});
    await writeFile(path.join(run,'run.json'),JSON.stringify({model:'gpt-6-astra',codex_thread_id:id,created_at:'2026-09-04T19:29:31Z'}));
    const file=path.join(folder,`rollout-test-${id}.jsonl.zst`);await writeFile(file,'corrupt archive');
    const reader=new TokenTelemetry({codexHome:root});await assert.rejects(reader.read(run));
    await writeFile(file,zstdCompressSync(Buffer.from(JSON.stringify(sample(100))+'\n')));
    assert.equal((await reader.read(run)).current_tokens,100);
  } finally {await rm(root,{recursive:true,force:true});}
});
