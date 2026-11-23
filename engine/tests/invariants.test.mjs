import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOrangeWallFrame } from "../../apps/web/app/orangeWalls.mjs";
import { rotateVoxelsClockwise } from "../../apps/web/app/worldBounds.mjs";
import { project, blocksById, simulateFrames, frameDifference } from "./helpers/project-engine.mjs";

// These use the author's frames as the oracle. Reordering storage must never
// change a simultaneous contact graph, mechanism priority, or cycle interval.
for (const arrangement of ["reversed", "interleaved"]) {
  test(`every active authored timeline is invariant under ${arrangement} voxel storage`, () => {
    const failures = [];
    for (const fixture of project.tests.filter(t => !t.hidden)) {
      const normalize = frame => normalizeOrangeWallFrame({
        voxels: rotateVoxelsClockwise(frame.voxels, fixture.world, 0),
      }, blocksById).voxels;
      const start = normalize(fixture.start);
      const reordered = arrangement === "reversed" ? [...start].reverse()
        : [...start.filter((_, i) => i % 2), ...start.filter((_, i) => i % 2 === 0)];
      const actual = simulateFrames(reordered, 0, fixture.world);
      const expected = [...(fixture.intermediate ?? []), fixture.expected];
      let mismatch = actual.length !== expected.length
        ? `expected ${expected.length} ticks, got ${actual.length}` : "";
      for (let i = 0; !mismatch && i < expected.length; ++i) {
        const difference = frameDifference(
          normalize(expected[i]), actual[i], fixture.world);
        if (difference.missing.length || difference.unexpected.length) {
          mismatch = `tick ${i + 1}: ${difference.missing.length} missing, ${difference.unexpected.length} unexpected`;
        }
      }
      if (!mismatch && ((actual.cycle?.startTick ?? null) !== (fixture.cycle?.startTick ?? null) ||
          (actual.cycle?.repeatTick ?? null) !== (fixture.cycle?.repeatTick ?? null))) {
        mismatch = "cycle interval changed";
      }
      if (mismatch) failures.push(`${fixture.id}: ${fixture.name}: ${mismatch}`);
    }
    assert.deepEqual(failures, [], failures.join("\n"));
  });
}
