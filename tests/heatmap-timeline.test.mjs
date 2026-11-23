import assert from "node:assert/strict";
import test from "node:test";
import { heatmapTimeline, timelineState, advanceTimeline, animationExtent } from "../benchmarking/ui/heatmap-timeline.mjs";
import { heatmapVisits } from "../benchmarking/ui/heatmap.mjs";
import { prepareHeatmap } from "../benchmarking/ui/heatmap-comparison.mjs";

const p = (worldX, worldY = 0) => ({ worldX, worldY });
const run = {
  created_at: "2026-10-15T00:00:00Z", action_count: 4,
  positions: [p(0), p(8), p(11), null, p(0)],
  actions: [
    { at: "2026-10-15T00:00:01Z" },
    { at: "2026-10-15T00:00:02Z", traversedPositions: [p(9), p(10), p(9)] },
    { at: "2026-10-15T00:00:03Z", traversedPositions: [p(11)] },
    { at: "2026-10-15T00:01:00Z", traversedPositions: [] },
  ],
};

test("animation counts initial, repeated, intermediate and terminal visits exactly once, without filling teleports", () => {
  const t = heatmapTimeline(run), state = timelineState();
  advanceTimeline(state, t, "moves", -1); assert.equal(state.total, 0);
  advanceTimeline(state, t, "moves", 0); assert.deepEqual([...state.counts], [[0, 1]]);
  advanceTimeline(state, t, "moves", 1.9); assert.deepEqual([...state.counts], [[0, 1], [8, 1]]);
  advanceTimeline(state, t, "moves", 2); assert.equal(state.counts.get(9), 2); assert.equal(state.counts.has(1), false);
  advanceTimeline(state, t, "moves", 100);
  const actual = prepareHeatmap({ points: [...state.counts].map(([tile, count]) => ({ worldX: tile % 256, worldY: Math.floor(tile / 256), count })) });
  const expected = prepareHeatmap({ points: heatmapVisits(run).positions.filter(Boolean).map(p => ({ ...p, count: 1 })) });
  assert.deepEqual(actual.counts, expected.counts);
  assert.deepEqual(t.finalMap.counts, expected.counts); assert.equal(t.finalMap.trackedActions, 3);
  assert.equal(state.move, 4); assert.equal(state.total, expected.total);
  advanceTimeline(state, t, "moves", 1000); assert.equal(state.total, expected.total);
});

test("elapsed time aligns run starts, retains real pauses, and shorter runs hold their final state", () => {
  const t = heatmapTimeline(run), state = timelineState();
  assert.equal(animationExtent([t, { ...t, elapsedMs: 90000 }], "elapsed"), 90000);
  advanceTimeline(state, t, "elapsed", 0); assert.equal(state.move, 0);
  advanceTimeline(state, t, "elapsed", 30000); assert.equal(state.move, 3);
  advanceTimeline(state, t, "elapsed", 90000); assert.equal(state.move, 4); assert.equal(state.total, t.finalMap.total);
});

test("missing or out-of-order timestamps require move mode instead of inventing chronology", () => {
  for (const at of [undefined, "invalid", "2026-10-14T00:00:00Z"]) {
    const t = heatmapTimeline({ ...run, actions: [{ at }, ...run.actions.slice(1)] });
    assert.equal(t.times, null); assert.equal(animationExtent([t], "moves"), 4);
    assert.throws(() => animationExtent([t], "elapsed"), /incomplete timestamps/);
    assert.throws(() => advanceTimeline(timelineState(), t, "elapsed", 0), /incomplete timestamps/);
  }
});

test("incomplete histories are refused and imports cannot supply invented visit order", () => {
  for (const change of [{ history_delta: {} }, { positions: [] }, { actions: [] }, { action_count: 8 }]) {
    assert.throws(() => heatmapTimeline({ ...run, ...change }), /Complete movement history/);
  }
  const snapshot = { snapshot: true, moveCount: 90000 };
  assert.throws(() => animationExtent([snapshot], "moves"), /final snapshots only/);
  assert.equal(animationExtent([snapshot, heatmapTimeline(run)], "moves"), 4);
});

test("empty and zero-action histories work, and invalid coordinates never create visits", () => {
  const empty = heatmapTimeline({ created_at: run.created_at, actions: [], positions: [] });
  assert.equal(empty.finalMap.total, 0); assert.equal(animationExtent([empty], "moves"), 0);
  const start = heatmapTimeline({ created_at: run.created_at, actions: [], positions: [p(255, 255)] });
  const state = advanceTimeline(timelineState(), start, "moves", 0);
  assert.equal(state.counts.get(65535), 1);
  const invalid = heatmapTimeline({ created_at: run.created_at, actions: [{ traversedPositions: [p(-1), p(256), p(.5), null] }], positions: [null, p(2, 256)] });
  assert.equal(invalid.finalMap.total, 0);
});
