import test from "node:test";
import assert from "node:assert/strict";
import { iceLevelTimings, formatLevelDuration } from "../benchmarking/ui/ice-level-timings.mjs";

const epoch = Date.parse("2026-09-04T21:00:00Z");
const at = seconds => new Date(epoch + seconds * 1000).toISOString();
const action = (index, name, level, seconds, levelsSolved = 0) => ({ index, action: name, level, at: at(seconds), levelsSolved });
const run = overrides => ({ world: "ice-maze", levels_total: 30, level_number: 1, levels_solved: 0, created_at: at(0), status: "running", runner_active: true, actions: [], ...overrides });

test("level times include thinking/startup and stop at the solving action, excluding transition waits", () => {
  const rows = iceLevelTimings(run({ level_number: 2, levels_solved: 2, actions: [
    action(1, "up", 1, 20), action(2, "undo", 1, 30), action(3, "reset", 1, 40), action(4, "right", 1, 90, 1),
    action(5, "next", 2, 120, 1), action(6, "up", 2, 135, 2)
  ] }), epoch + 200_000);
  assert.equal(rows[0].elapsed_ms, 90_000); assert.equal(rows[0].actions, 4); assert.equal(rows[0].solve_action, 4);
  assert.equal(rows[1].elapsed_ms, 15_000); assert.equal(rows[1].actions, 1); assert.equal(rows[1].status, "solved");
  assert.equal(rows[2].status, "pending"); assert.equal(rows[2].elapsed_ms, null);
  assert.equal(rows.length, 30);
});

test("long sequences use their recorded completion time while the current level keeps timing", () => {
  const fixture = run({ level_number: 2, levels_solved: 1, actions: [
    ...["up", "left", "down", "right"].map((name, i) => action(i + 1, name, 1, 15, i === 3 ? 1 : 0)),
    action(5, "next", 2, 20, 1), action(6, "up", 2, 25, 1)
  ] });
  const first = iceLevelTimings(fixture, epoch + 30_000), later = iceLevelTimings(fixture, epoch + 70_000);
  assert.equal(first[0].elapsed_ms, 15_000); assert.equal(later[0].elapsed_ms, 15_000);
  assert.equal(first[1].elapsed_ms, 10_000); assert.equal(later[1].elapsed_ms, 50_000);
  assert.equal(later[1].status, "playing"); assert.equal(later[1].actions, 1);
});

test("unfinished levels freeze when paused, stopped or failed and resume with elapsed wall time", () => {
  for (const [status, endpoint, label] of [["paused", "paused_at", "paused"], ["stopped", "stopped_at", "unsolved"], ["failed", "completed_at", "unsolved"], ["completed", "completed_at", "unsolved"]]) {
    const rows = iceLevelTimings(run({ status, runner_active: false, [endpoint]: at(40), updated_at: at(25) }), epoch + 90_000);
    assert.equal(rows[0].elapsed_ms, 40_000); assert.equal(rows[0].status, label);
  }
  const resumed = iceLevelTimings(run({ paused_at: at(40), resumed_at: at(80) }), epoch + 90_000);
  assert.equal(resumed[0].elapsed_ms, 90_000);
});

test("missing or invalid timestamps never fabricate zero-second solves", () => {
  const missing = iceLevelTimings(run({ created_at: undefined, levels_solved: 1, actions: [action(1, "up", 1, 10, 1)] }));
  assert.equal(missing[0].status, "solved"); assert.equal(missing[0].elapsed_ms, null);
  const invalid = iceLevelTimings(run({ levels_solved: 1, actions: [{ ...action(1, "up", 1, 10, 1), at: "invalid" }] }));
  assert.equal(invalid[0].elapsed_ms, null);
  const backwards = iceLevelTimings(run({ created_at: at(100), actions: [action(1, "up", 1, 10, 1)] }));
  assert.equal(backwards[0].elapsed_ms, null);
  assert.deepEqual(iceLevelTimings({ world: "main-world" }), []);
});

test("durations distinguish unknown values, seconds, minutes and hours", () => {
  assert.equal(formatLevelDuration(null), "—"); assert.equal(formatLevelDuration(NaN), "—");
  assert.equal(formatLevelDuration(0), "0.0s"); assert.equal(formatLevelDuration(15_429), "15.4s");
  assert.equal(formatLevelDuration(90_000), "1m 30s"); assert.equal(formatLevelDuration(3_665_000), "1h 01m 05s");
});
