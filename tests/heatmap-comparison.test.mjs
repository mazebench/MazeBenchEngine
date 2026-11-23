import test from "node:test";
import assert from "node:assert/strict";
import { prepareHeatmap, comparisonReport, comparisonBounds, comparisonScale, visitValue, heatColor, mapLayout, tileAt, roomAt, defaultComparison } from "../benchmarking/ui/heatmap-comparison.mjs";

test("vision movement histories and aggregated text reports produce identical comparison maps", () => {
  const vision = comparisonReport({ observation_mode: "vision", action_count: 2,
    positions: [{ worldX: 116, worldY: 140 }, { worldX: 117, worldY: 140 }, { worldX: 116, worldY: 140 }],
    actions: [{ traversedPositions: [{ worldX: 118, worldY: 140 }] }, {}] });
  const text = comparisonReport({ action_count: 2, heatmap: { trackedActions: 1, points: [
    { worldX: 116, worldY: 140, count: 2 }, { worldX: 117, worldY: 140, count: 1 }, { worldX: 118, worldY: 140, count: 1 }
  ] } });
  assert.deepEqual(vision, text);
  assert.equal(vision.map.total, 4);
  assert.throws(() => comparisonReport({ positions: [], history_delta: true }), /Complete visit history/);
  assert.throws(() => comparisonReport({}), /Complete visit history/);
  assert.equal(comparisonReport({ positions: [], actions: [] }).map.total, 0);
});

test("comparison retains aggregated visits and ignores invalid world coordinates", () => {
  const map = prepareHeatmap({ points: [
    { worldX: 116, worldY: 140, count: 2 }, { worldX: 116, worldY: 140, count: 3 },
    { worldX: 117, worldY: 140, count: 1 }, { worldX: -1, worldY: 0, count: 4 },
    { worldX: 256, worldY: 0, count: 4 }, { worldX: 1.5, worldY: 0, count: 4 },
    { worldX: 2, worldY: 0, count: 0 }, null
  ], trackedActions: 4 });
  assert.equal(map.total, 6);
  assert.equal(map.counts.get("116,140"), 5);
  assert.equal(map.points.length, 2);
  assert.equal(map.trackedActions, 4);
  assert.equal(prepareHeatmap().total, 0);
});

test("maps share room-aligned bounds even with disjoint exploration, including world corners", () => {
  const a = prepareHeatmap({ points: [{ worldX: 113, worldY: 116, count: 1 }] });
  const b = prepareHeatmap({ points: [{ worldX: 140, worldY: 143, count: 1 }] });
  assert.deepEqual(comparisonBounds([a, b]), { minX: 112, minY: 112, columns: 32, rows: 32 });
  const whole = { minX: 0, minY: 0, columns: 256, rows: 256 };
  assert.deepEqual(comparisonBounds([a, b], true), whole);
  assert.deepEqual(comparisonBounds([null, prepareHeatmap()]), whole);
  const corners = prepareHeatmap({ points: [{ worldX: 0, worldY: 0, count: 1 }, { worldX: 255, worldY: 255, count: 1 }] });
  assert.deepEqual(comparisonBounds([corners]), whole);
});

test("equal visit counts have equal colors across runs; share scale normalizes run length", () => {
  const map = values => prepareHeatmap({ points: values.map((count, worldX) => ({ worldX, worldY: 0, count })) });
  const a = map([1, 10]), b = map([10, 100]);
  const absolute = comparisonScale([a, b]);
  assert.deepEqual(absolute, { minimum: 1, maximum: 100 });
  assert.equal(heatColor(a.points[1].count, absolute), heatColor(b.points[0].count, absolute));
  const relative = comparisonScale([a, b], "share");
  assert.equal(heatColor(visitValue(1, a.total, "share"), relative), heatColor(visitValue(10, b.total, "share"), relative));
  assert.equal(visitValue(0, 0, "share"), 0);
  assert.deepEqual(comparisonScale([]), { minimum: 0, maximum: 0 });
  assert.equal(heatColor(1, { minimum: 1, maximum: 1 }), "rgb(255,213,87)");
});

test("pointer coordinates identify the same world tile on different canvas sizes", () => {
  const bounds = { minX: 112, minY: 112, columns: 32, rows: 48 };
  for (const size of [300, 640]) {
    const layout = mapLayout(bounds, size);
    const position = tileAt(layout, layout.left + 4.5 * layout.cell, layout.top + 28.5 * layout.cell);
    assert.deepEqual(position, { x: 116, y: 140 });
    assert.equal(roomAt(position), "H×I");
    assert.equal(tileAt(layout, layout.left - .1, layout.top), null);
    assert.equal(tileAt(layout, layout.left + layout.columns * layout.cell, layout.top), null);
  }
});

test("default comparison matches Luna and Haiku tool conditions and respects explicit run links", () => {
  const runs = [
    { id: "haiku-on", model: "claude-haiku-5-5", tools_enabled: true },
    { id: "haiku-off", model: "claude-haiku-5-5", tools_enabled: false },
    { id: "luna", model: "gpt-6-luna", tools_enabled: false }
  ];
  assert.deepEqual(defaultComparison(runs), ["luna", "haiku-off"]);
  assert.deepEqual(defaultComparison(runs, "haiku-on", "luna"), ["haiku-on", "luna"]);
  assert.deepEqual(defaultComparison(runs, "deleted"), ["luna", "haiku-off"]);
  assert.deepEqual(defaultComparison([runs[0]]), ["haiku-on", ""]);
  assert.deepEqual(defaultComparison([]), ["", ""]);
});
