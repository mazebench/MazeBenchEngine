import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { consumeThinkingEvent, createThinkingTimeline, gemTimeline, thinkingReport, RunTelemetry, weightedThinkingDuration } from "../benchmarking/run-telemetry.mjs";

const at = seconds => new Date(Date.UTC(2026, 8, 6) + seconds * 1000).toISOString();
const event = (seconds, type, item) => ({ _received_at: at(seconds), type, ...(item ? { item } : {}) });
const call = (id, tool = "maze_sequence") => ({ id, tool, type: "mcp_tool_call" });
const report = (timeline, extra = {}) => thinkingReport(timeline, {
  metadata: { status: "running" }, runnerActive: true, summary: { actions: [] }, now: Date.parse(at(100)), ...extra
});

test("Fast thinking receives 2× weighting only during its recorded service interval", () => {
  const metadata = { service_tier: "fast", service_tier_history: [
    { at: at(0), service_tier: "standard" }, { at: at(10), service_tier: "fast" }
  ] };
  const weigh = (start, end, meta = metadata) => weightedThinkingDuration(Date.parse(at(start)), Date.parse(at(end)), meta);
  assert.equal(weigh(0, 5).weighted_duration_ms, 5000);
  assert.equal(weigh(15, 20).weighted_duration_ms, 10000);
  assert.equal(weigh(5, 15).weighted_duration_ms, 15000);
  assert.equal(weigh(0, 5, { service_tier: "fast" }).weighted_duration_ms, 10000);
  assert.equal(weigh(0, 5, {}).weighted_duration_ms, 5000);
  const timeline = createThinkingTimeline();
  for (const e of [event(0, "turn.started"), event(5, "item.started", call("a")),
    event(15, "item.completed", call("a")), event(20, "item.started", call("b"))]) consumeThinkingEvent(timeline, e);
  const result = report(timeline, { metadata: { ...metadata, status: "running" } });
  assert.deepEqual(result.episodes.map(e => e.duration_ms), [5000, 5000]);
  assert.deepEqual(result.episodes.map(e => e.weighted_duration_ms), [5000, 10000]);
  assert.equal(result.weighted_median_ms, 7500);
  assert.equal(result.weighted_longest_ms, 10000);
});

test("thinking groups reasoning updates and excludes parallel tool execution and repeated results", () => {
  const timeline = createThinkingTimeline();
  for (const e of [event(0, "turn.started"), event(2, "item.completed", { type: "reasoning", text: "private reasoning" }),
    event(4, "item.completed", { type: "reasoning" }), event(5, "item.started", call("a")),
    event(6, "item.started", call("b")), event(10, "item.completed", call("a")),
    event(20, "item.completed", call("b")), event(22, "item.completed", call("b")),
    event(30, "item.started", call("c")), event(40, "item.completed", call("c")),
    event(45, "item.completed", { type: "agent_message" }), event(46, "turn.completed")]) consumeThinkingEvent(timeline, e);
  const result = report(timeline);
  assert.deepEqual(result.episodes.map(e => e.duration_ms), [5000, 10000, 5000]);
  assert.equal(result.current, null);
  assert.equal(result.median_ms, 5000);
  assert.equal(JSON.stringify(result).includes("private reasoning"), false);
});

test("pauses, missing turn ends, retries and failed turns never become long thinking episodes", () => {
  const timeline = createThinkingTimeline();
  consumeThinkingEvent(timeline, event(0, "turn.started"));
  assert.equal(report(timeline, { metadata: { status: "paused" } }).current, null);
  assert.equal(report(timeline, { runnerActive: false }).current, null);
  consumeThinkingEvent(timeline, event(3600, "turn.started"));
  consumeThinkingEvent(timeline, event(3602, "error"));
  consumeThinkingEvent(timeline, event(7200, "item.started", call("a")));
  consumeThinkingEvent(timeline, event(7201, "item.completed", call("a")));
  consumeThinkingEvent(timeline, event(7204, "item.started", call("b")));
  consumeThinkingEvent(timeline, event(7205, "item.completed", call("b")));
  consumeThinkingEvent(timeline, event(7208, "turn.failed"));
  assert.deepEqual(timeline.episodes.map(e => e.duration_ms), [3000]);
  assert.equal(report(timeline).current, null);
  assert.equal(timeline.interruptions, 3);
});

test("compaction is flagged and omitted from duration statistics; action context comes from completed tools", () => {
  const timeline = createThinkingTimeline();
  for (const e of [event(0, "turn.started"), event(10, "item.started", call("a")),
    event(12, "item.completed", call("a")), event(40, "item.started", call("b"))]) consumeThinkingEvent(timeline, e);
  const result = report(timeline, {
    compactions: [{ timestamp: Date.parse(at(20)) }],
    summary: { actions: [{ index: 8, at: at(11), roomAfter: "NxB" }] },
    activity: [{ at: Date.parse(at(11.9)), action_count: 8 }]
  });
  assert.equal(result.episodes[1].compaction, true);
  assert.equal(result.episodes[1].action_count, 8);
  assert.equal(result.episodes[1].room, "NxB");
  assert.equal(result.longest_ms, 10000);
});

test("Claude streaming and repeated assistant blocks count each tool once; results end tool time", () => {
  const timeline = createThinkingTimeline();
  const consume = (seconds, value) => consumeThinkingEvent(timeline, { _received_at: at(seconds), ...value }, "claude-code");
  consume(0, { type: "system", subtype: "init" });
  const tool = { type: "tool_use", id: "a", name: "maze_sequence" };
  consume(4, { type: "stream_event", event: { type: "content_block_start", content_block: tool } });
  consume(5, { type: "assistant", message: { content: [tool] } });
  consume(10, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a" }] } });
  consume(20, { type: "assistant", message: { content: [{ type: "text", text: "Done" }] } });
  consume(21, { type: "result", is_error: false });
  assert.deepEqual(timeline.episodes.map(e => e.duration_ms), [4000, 10000]);
  assert.equal(report(timeline).current, null);
});

test("gem steps preserve exact collecting moves, decreases, initial counts and rollback prefixes", () => {
  const summary = { action_count: 5, gems_collected: 2, gems_total: 100, actions: [
    { index: 1, totalGems: 1, gemsCollected: 0 }, { index: 2, totalGems: 2, gemsCollected: 1 },
    { index: 3, totalGems: 2, gemsCollected: 0 }, { index: 4, totalGems: 1, gemsCollected: 0 },
    { index: 5, totalGems: 2, gemsCollected: 1 }
  ] };
  assert.deepEqual(gemTimeline(summary).points, [{ move: 0, gems: 1 }, { move: 2, gems: 2 }, { move: 4, gems: 1 }, { move: 5, gems: 2 }]);
  assert.deepEqual(gemTimeline({ ...summary, action_count: 3, actions: summary.actions.slice(0, 3) }).points,
    [{ move: 0, gems: 1 }, { move: 2, gems: 2 }, { move: 3, gems: 2 }]);
  assert.deepEqual(gemTimeline({ action_count: 0, gems_collected: 0 }).points, [{ move: 0, gems: 0 }]);
});

test("cached telemetry handles concurrent polls, partial JSON, log replacement and a rolled-back summary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maze-run-chart-"));
  try {
    await writeFile(path.join(root, "run.json"), JSON.stringify({ status: "paused" }));
    const summary = { action_count: 2, gems_collected: 1, gems_total: 100, actions: [
      { index: 1, at: at(1), totalGems: 0, gemsCollected: 0 }, { index: 2, at: at(2), totalGems: 1, gemsCollected: 1 }
    ] };
    await writeFile(path.join(root, "summary.json"), JSON.stringify(summary));
    const second = JSON.stringify(event(5, "item.started", call("a")));
    const file = path.join(root, "agent-events.jsonl");
    await writeFile(file, JSON.stringify(event(0, "turn.started")) + "\n" + second.slice(0, 20));
    const telemetry = new RunTelemetry();
    assert.equal((await telemetry.read(root)).thinking.count, 0);
    await appendFile(file, second.slice(20) + "\n");
    const polls = await Promise.all([telemetry.read(root), telemetry.read(root)]);
    assert.deepEqual(polls.map(p => p.thinking.count), [1, 1]);
    assert.equal(polls[0].thinking.current, null);
    await writeFile(path.join(root, "replacement"), JSON.stringify(event(1, "turn.started")) + "\n");
    await rename(path.join(root, "replacement"), file);
    await writeFile(path.join(root, "summary.json"), JSON.stringify({ ...summary, action_count: 1, gems_collected: 0, actions: summary.actions.slice(0, 1) }));
    const rolledBack = await telemetry.read(root);
    assert.equal(rolledBack.thinking.count, 0);
    assert.deepEqual(rolledBack.gems.points, [{ move: 0, gems: 0 }, { move: 1, gems: 0 }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
