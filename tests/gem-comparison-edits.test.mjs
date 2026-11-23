import test from "node:test";
import assert from "node:assert/strict";
import { gemSeries, gemsAt, limitGemSeries } from "../benchmarking/ui/gem-comparison-data.mjs";
import { comparisonGemCount, correctedGemSeries, editedGemSeries, moveGemPoint } from "../benchmarking/ui/gem-comparison-edits.mjs";

const astraId = "run-2026-09-04T19-29-31-992Z-772688";
const recordedAstra = () => gemSeries({ available: true, total: 100, moves: 21219,
  points: [{ move: 0, gems: 0 }, { move: 5390, gems: 7 }, { move: 7368, gems: 8 }, { move: 8799, gems: 9 }, { move: 20044, gems: 17 }] });

test("Astra's verified DxH exclusion adjusts only its later comparison scores", () => {
  const recorded = recordedAstra(), before = structuredClone(recorded);
  const result = correctedGemSeries(recorded, astraId);
  assert.equal(result.collected / result.total * 100, 16);
  assert.equal(gemsAt(result, 7367), 7);
  assert.equal(gemsAt(result, 7368), 7);
  assert.equal(gemsAt(result, 8799), 8);
  assert.equal(limitGemSeries(result, 20044).collected, 16);
  assert.ok(!result.points.some(point => point.move === 7368));
  assert.deepEqual(recorded, before);
  assert.equal(correctedGemSeries(recorded, "another-astra-run"), recorded);
  assert.equal(comparisonGemCount({ id: astraId, action_count: 21219, gems_collected: 17 }), 16);
  assert.equal(comparisonGemCount({ id: "another-astra-run", action_count: 21219, gems_collected: 24 }), 24);
});

test("the exclusion needs its verified milestone and retains an excluded endpoint", () => {
  const earlier = gemSeries({ available: true, moves: 6000, points: [{ move: 0, gems: 0 }, { move: 5390, gems: 7 }] });
  assert.equal(correctedGemSeries(earlier, astraId), earlier);
  const atCollection = gemSeries({ available: true, points: [{ move: 0, gems: 0 }, { move: 5390, gems: 7 }, { move: 7368, gems: 8 }] });
  assert.deepEqual(correctedGemSeries(atCollection, astraId).points.at(-1), { move: 7368, gems: 7 });
});

test("saved edits round-trip, update cutoff scores and leave the corrected source untouched", () => {
  const source = correctedGemSeries(recordedAstra(), astraId), before = structuredClone(source);
  const saved = JSON.parse(JSON.stringify({ "8799:8": { move: 8500, gems: 10 }, "21219:16": { move: 22000, gems: 18 } }));
  const result = editedGemSeries(source, saved);
  assert.equal(gemsAt(result, 8499), 7);
  assert.equal(limitGemSeries(result, 8500).collected, 10);
  assert.equal(result.moves, 22000);
  assert.equal(result.collected, 18);
  assert.equal(result.edited, true);
  assert.equal(editedGemSeries(source, {}).collected, 16);
  assert.equal(editedGemSeries(source, {}).edited, false);
  assert.deepEqual(source, before);
});

test("point moves snap to whole units, stay between neighboring moves and preserve the origin", () => {
  const series = editedGemSeries(recordedAstra());
  assert.deepEqual(moveGemPoint(series, "7368:8", { move: 9000, gems: 101 }), { move: 8799, gems: 100 });
  assert.deepEqual(moveGemPoint(series, "7368:8", { move: 100, gems: -5 }), { move: 5390, gems: 0 });
  assert.deepEqual(moveGemPoint(series, "7368:8", { move: 7500.4, gems: 10.6 }), { move: 7500, gems: 11 });
  assert.equal(moveGemPoint(series, "0:0", { move: 100, gems: 1 }), null);
  assert.equal(moveGemPoint(series, "missing", { move: 100, gems: 1 }), null);
});

test("invalid edits and old endpoint edits cannot corrupt refreshed histories", () => {
  const source = recordedAstra();
  const invalid = editedGemSeries(source, { "7368:8": { move: 999999, gems: 8 } });
  assert.equal(invalid.edited, false);
  assert.equal(editedGemSeries(source, { "7368:8": { move: 7368, gems: -1 } }).edited, false);
  assert.equal(editedGemSeries(source, { "7368:8": { move: "7368", gems: 2 } }).edited, false);
  const refreshed = gemSeries({ available: true, total: 100, moves: 23000,
    points: source.points.slice(0, -1).concat({ move: 22000, gems: 18 }) });
  assert.equal(editedGemSeries(refreshed, { "21219:17": { move: 21000, gems: 1 } }).collected, 18);
});
