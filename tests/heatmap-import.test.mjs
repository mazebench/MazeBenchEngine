import test from "node:test";
import assert from "node:assert/strict";
import { importLeaderboardHeatmap, comparisonCondition } from "../benchmarking/ui/heatmap-import.mjs";
import { defaultComparison, displayModelName } from "../benchmarking/ui/heatmap-comparison.mjs";

const options = { origin: "http://localhost:3000", sourceKey: "source", importedAt: "2026-10-08T00:00:00Z" };
const fixture = () => ({ run: { id: "old-run", model_name: "claude-haiku-4-5-20251001", provider: "claude",
  level_id: "level_HxI", url: "/agent/runs/old-run", tool_use: "read-only", mode: "text", turns: 5, room_count: 1, gem_count: 0 },
  heatmap: { room_size: 16, cells: [[113, 137, 2], [113, 137, 1], [114, 138, 3]], total_visits: 6, unique_cells: 2 } });

test("import preserves exact world coordinates, counts, model identity and source tool condition", () => {
  const { metadata, report } = importLeaderboardHeatmap(fixture(), options);
  assert.deepEqual(report.heatmap.points, [{ worldX: 113, worldY: 137, count: 3 }, { worldX: 114, worldY: 138, count: 3 }]);
  assert.equal(report.action_count, 5);
  assert.equal(metadata.id, "import-source-old-run");
  assert.equal(metadata.model, "claude-haiku-4-5-20251001");
  assert.equal(metadata.source.url, "http://localhost:3000/agent/runs/old-run");
  assert.equal(comparisonCondition(metadata), "Tools: read-only");
  assert.equal(metadata.tools_enabled, undefined);
  assert.equal(displayModelName(metadata.model), "Haiku 4.5");
});

test("import rejects incompatible coordinates and inconsistent totals instead of silently losing visits", () => {
  for (const mutate of [
    value => value.heatmap.cells[0][0] = 256,
    value => value.heatmap.cells[0][2] = -1,
    value => value.heatmap.room_size = 8,
    value => value.heatmap.total_visits = 7,
    value => value.heatmap.unique_cells = 3,
    value => value.run.url = "javascript:alert(1)"
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => importLeaderboardHeatmap(value, options));
  }
});

test("three-model links preserve all requested runs including an imported model", () => {
  const old = importLeaderboardHeatmap(fixture(), options).metadata;
  const runs = [old, { id: "sol", model: "gpt-6-sol", tools_enabled: true }, { id: "new", model: "claude-haiku-5-5", tools_enabled: true }];
  assert.deepEqual(defaultComparison(runs, old.id, "sol", "new", 3), [old.id, "sol", "new"]);
});
