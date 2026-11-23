import test from "node:test";
import assert from "node:assert/strict";
import { gemSeries, gemsAt, gemLinePath, axisExtent, layoutEndLabels, limitGemSeries } from "../benchmarking/ui/gem-comparison-data.mjs";

test("comparison preserves collection moves, decreases and the actual run endpoint", () => {
  const series = gemSeries({ available: true, moves: 100, points: [{ move: 0, gems: 0 }, { move: 20, gems: 2 }, { move: 50, gems: 1 }] });
  assert.equal(gemsAt(series, 19), 0);
  assert.equal(gemsAt(series, 20), 2);
  assert.equal(gemsAt(series, 50), 1);
  assert.equal(gemsAt(series, 100), 1);
  assert.equal(gemsAt(series, 101), null);
  assert.equal(gemLinePath(series.points, x => x, y => y), "M0,0L20,2L50,1L100,1");
});
test("endpoint labels separate tied scores without moving endpoints or clipping", () => {
  const labels = Array.from({ length: 8 }, (_, id) => ({ id, x: 100 + id, y: 240, width: 200 }));
  const placed = layoutEndLabels(labels, 40, 260);
  for (const label of placed) {
    assert.equal(label.x, labels[label.id].x);
    assert.equal(label.y, labels[label.id].y);
    assert.ok(label.labelY >= 40 && label.labelY <= 260);
    for (const other of placed) if (label !== other) assert.ok(Math.abs(label.labelY - other.labelY) >= 24);
  }
});
test("empty, missing and out-of-order histories do not become fabricated lines", () => {
  assert.equal(gemSeries({ available: false, moves: 100, collected: 10 }), null);
  assert.equal(gemSeries({ available: true, points: [] }), null);
  assert.equal(gemSeries({ available: true, points: [{ move: 3, gems: 1 }, { move: 1, gems: 2 }] }), null);
  assert.equal(gemsAt(gemSeries({ available: true, points: [{ move: 30, gems: 2 }] }), 20), null);
});
test("axes include the endpoint and keep gem ticks integral, including zero-move runs", () => {
  for (const value of [0, 1, 7, 100, 43001, 1000000]) {
    const { max, step } = axisExtent(value);
    assert.ok(max >= value && max > 0);
    assert.ok(Number.isInteger(step) && step >= 1);
    assert.ok(Math.round(max / step) <= 6);
  }
});
test("a move cap excludes later gems and trims tails without altering the source", () => {
  const full = gemSeries({ available: true, total: 100, moves: 1000, points: [{ move: 0, gems: 0 }, { move: 100, gems: 1 }, { move: 500, gems: 5 }] });
  const before = structuredClone(full);
  assert.deepEqual(limitGemSeries(full, 250).points, [{ move: 0, gems: 0 }, { move: 100, gems: 1 }, { move: 250, gems: 1 }]);
  assert.equal(limitGemSeries(full, 250).collected, 1);
  assert.equal(limitGemSeries(full, 500).collected, 5);
  assert.equal(limitGemSeries(full, 800).moves, 800);
  assert.equal(limitGemSeries(full, 2000), full);
  assert.equal(limitGemSeries(full, null), full);
  assert.deepEqual(full, before);
  assert.equal(limitGemSeries(gemSeries({ available: true, points: [{ move: 30, gems: 2 }] }), 10), null);
});
