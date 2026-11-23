import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMuseTimeline, consumeMuseEvent, findMuseSession, museTelemetry } from "../benchmarking/muse-telemetry.mjs";
import { TokenTelemetry } from "../benchmarking/token-telemetry.mjs";
import { createThinkingTimeline, consumeThinkingEvent, thinkingReport, RunTelemetry } from "../benchmarking/run-telemetry.mjs";

const start = Date.parse("2026-10-14T05:10:00Z");
const event = (seconds, id, detail) => ({ id: `session-${id}`, recorded_at: (start + seconds * 1000) * 1000,
  payload: { kind: "run", run_id: "run-1", source_run_record_id: id, event: detail } });
const completed = (seconds, id, input = 1000, output = 200) => event(seconds, id, { kind: "model_completed", duration_ms: 4000,
  usage: { input_tokens: input, output_tokens: output, cached_tokens: 800, cache_read_tokens: 800, cache_write_tokens: 20, reasoning_tokens: 150 } });

test("Muse counts each response once without adding cached input or reasoning output twice", () => {
  const timeline = createMuseTimeline(), first = completed(5, "a");
  consumeMuseEvent(timeline, first);
  consumeMuseEvent(timeline, { ...first, id: "replayed-session-record" });
  consumeMuseEvent(timeline, event(6, "attribution", { kind: "goal_usage_attribution", record: { quantity: first.payload.event.usage } }));
  consumeMuseEvent(timeline, completed(10, "b", 2000, 300));
  consumeMuseEvent(timeline, event(11, "bad", { kind: "model_completed", usage: { input_tokens: "100", output_tokens: 1 } }));
  const value = museTelemetry(timeline);
  assert.equal(value.samples.length, 2);
  assert.deepEqual(value.totals, { input_tokens: 3000, output_tokens: 500, cached_input_tokens: 1600,
    cache_write_input_tokens: 40, reasoning_output_tokens: 300, total_tokens: 3500 });
  assert.equal(value.current_tokens, 2300);
  assert.equal(value.api_estimate.usd, null);
});

test("Muse compaction usage is included once; context after compaction waits for a real response", () => {
  const timeline = createMuseTimeline();
  consumeMuseEvent(timeline, completed(5, "a"));
  consumeMuseEvent(timeline, event(6, "candidate", { kind: "context_compaction_candidate", strategy: { soft_threshold_tokens: 384000 } }));
  const installed = event(7, "installed", { kind: "context_compaction_installed", budget_before: { estimated_prompt_tokens: 390000 },
    budget_after: { estimated_prompt_tokens: 50000, estimate_source: "heuristic_estimate" }, summarizer_usage: { input_tokens: 300000, output_tokens: 2000 } });
  consumeMuseEvent(timeline, installed); consumeMuseEvent(timeline, installed);
  assert.equal(museTelemetry(timeline).compactions[0].after_tokens, null);
  consumeMuseEvent(timeline, completed(10, "b", 60000, 100));
  const value = museTelemetry(timeline);
  assert.equal(value.compaction_threshold, 384000);
  assert.equal(value.compactions.length, 1);
  assert.equal(value.compactions[0].after_tokens, 60000);
  assert.equal(value.totals.total_tokens, 363300);
  assert.equal(value.api_estimate.request_count, 3);
});

test("Muse durations use the model clock, deduplicate resume replay and exclude tools and failures", () => {
  const timeline = createThinkingTimeline();
  const consume = e => consumeThinkingEvent(timeline, e, "muse-code");
  consume(event(0, "start", { kind: "provider_request_options_configured" }));
  consume(completed(5, "a")); consume(completed(5, "a"));
  consume(event(5, "tool", { kind: "side_effect_intent", task_id: "t", operation: "tool:mcp__mazebench__python_exec" }));
  consume(event(100, "tool-done", { kind: "completed", task_id: "t" }));
  consume(event(101, "request", { kind: "provider_request_options_configured" }));
  consume(event(102, "failure", { kind: "model_failure_terminal_intent" }));
  consume(event(3600, "resume", { kind: "provider_request_options_configured" }));
  consume(completed(3605, "b"));
  consume(event(3606, "active", { kind: "provider_request_options_configured" }));
  const options = { metadata: { status: "continuing" }, summary: { actions: [] }, runnerActive: true, now: start + 3610000 };
  const value = thinkingReport(timeline, options);
  assert.deepEqual(value.episodes.map(e => e.duration_ms), [4000, 4000]);
  assert.equal(value.current.duration_ms, 4000);
  assert.equal(thinkingReport(timeline, { ...options, runnerActive: false }).current, null);
});

test("Muse dashboard backfills private session logs and handles appends, concurrent polls and replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maze-muse-telemetry-"));
  const homes = path.join(root, "homes"), run = path.join(root, "run");
  const metadata = { id: "run-example", provider: "muse-code", status: "continuing", created_at: new Date(start).toISOString(),
    muse_session_id: "01234567-89ab-cdef-0123-456789abcdef" };
  const directory = path.join(homes, metadata.id, ".local/share/muse/sessions/2026/10/13", metadata.muse_session_id);
  const file = path.join(directory, "session.jsonl");
  try {
    await mkdir(directory, { recursive: true }); await mkdir(run);
    await writeFile(path.join(run, "run.json"), JSON.stringify(metadata));
    await writeFile(path.join(run, "summary.json"), JSON.stringify({ actions: [], action_count: 0 }));
    const tokens = new TokenTelemetry({ museHomes: homes }), charts = new RunTelemetry({ museHomes: homes });
    const second = JSON.stringify(completed(10, "b"));
    await writeFile(file, JSON.stringify(completed(5, "a")) + "\n" + second.slice(0, 20));
    assert.equal((await tokens.read(run)).totals.total_tokens, 1200);
    assert.equal((await charts.read(run)).thinking.count, 1);
    await appendFile(file, second.slice(20) + "\n");
    const results = await Promise.all([tokens.read(run), tokens.read(run)]);
    assert.deepEqual(results.map(value => value.totals.total_tokens), [2400, 2400]);
    assert.equal((await charts.read(run)).thinking.count, 2);
    await writeFile(path.join(directory, "replacement"), JSON.stringify(completed(20, "c")) + "\n");
    await rename(path.join(directory, "replacement"), file);
    assert.equal((await tokens.read(run)).totals.total_tokens, 1200);
    assert.equal((await charts.read(run)).thinking.count, 1);
    assert.equal(await findMuseSession({ ...metadata, id: "../escape" }, homes), null);
    await rename(directory, directory + "-original");
    await symlink(directory + "-original", directory);
    await assert.rejects(findMuseSession(metadata, homes), /symbolic links/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
