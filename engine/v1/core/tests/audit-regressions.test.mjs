import assert from "node:assert/strict";
import test from "node:test";
import { auditRegressions } from "../../scripts/lib/audit-regressions.mjs";
import { rotateVoxelsClockwise, rotateWorldClockwise } from "../../apps/web/app/worldBounds.mjs";
import { simulateFrames, frameDifference } from "./helpers/project-engine.mjs";

for (const fixture of auditRegressions()) {
  test(`independent geometry: ${fixture.name}`, () => {
    for (let rotation = 0; rotation < 4; ++rotation) {
      const world = rotateWorldClockwise(fixture.world, rotation);
      const actual = simulateFrames(rotateVoxelsClockwise(fixture.start.voxels, fixture.world, rotation), rotation, world);
      const expected = [...fixture.intermediate, fixture.expected];
      assert.equal(actual.length, expected.length, `${rotation * 90}° tick count`);
      for (let tick = 0; tick < expected.length; ++tick) {
        const difference = frameDifference(rotateVoxelsClockwise(expected[tick].voxels, fixture.world, rotation), actual[tick], world);
        assert.deepEqual(difference, { missing: [], unexpected: [] }, `${rotation * 90}° tick ${tick + 1}`);
      }
    }
  });
}
