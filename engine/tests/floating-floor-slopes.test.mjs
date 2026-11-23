import assert from "node:assert/strict";
import test from "node:test";
import { rotateVoxelsClockwise, rotateWorldClockwise } from "../../apps/web/app/worldBounds.mjs";
import { simulateFrames, simulateFinal, frameDifference } from "./helpers/project-engine.mjs";

const world = { width: 6, height: 6, floorLayer: 0 };
const cube = (blockId, y, z) => ({ blockId, x: 2, y, z });
for (const scenario of ["supported crest", "unsupported crest", "blocked crest", "two floors", "downhill"]) {
  test(`Floating Floor ramp contact: ${scenario}`, () => {
    const downhill = scenario === "downhill";
    const pushes = scenario === "supported crest" || downhill;
    const terrain = Array.from({ length: 6 }, (_, y) => cube("floor", y, 0));
    terrain.push(
      { ...cube("ice-slope", 4, 1), orientation: downhill ? "down" : "up" },
      cube("wall", downhill ? 5 : 3, 1),
    );
    if (!downhill && scenario !== "unsupported crest") terrain.push(cube("wall", 2, 1));
    if (scenario === "blocked crest") terrain.push(cube("wall", 2, 2));
    const other = scenario === "two floors" ? [cube("floating-floor", 2, 2), cube("wall", 1, 1)] : [];
    const frame = (y, z, moved = false) => [
      ...terrain, ...other, cube("player", y, z),
      cube("floating-floor", moved ? 2 : 3, downhill ? 1 : 2),
    ];
    const initial = frame(5, downhill ? 2 : 1);
    const expected = [frame(4, 2), frame(pushes ? 3 : 5, downhill || !pushes ? 1 : 2, pushes)];
    for (let rotation = 0; rotation < 4; ++rotation) {
      const bounds = rotateWorldClockwise(world, rotation);
      const rotated = voxels => rotateVoxelsClockwise(voxels, world, rotation);
      for (const order of ["normal", "reverse", "interleaved"]) {
        let input = rotated(initial);
        if (order === "reverse") input.reverse();
        if (order === "interleaved") input = [...input.filter((_, i) => i % 2), ...input.filter((_, i) => !(i % 2))];
        const context = `${rotation * 90}°, ${order}`;
        const actual = simulateFrames(input, rotation, bounds);
        assert.equal(actual.length, expected.length, `${context}: exact tick count`);
        assert.equal(actual.cycle, null, `${context}: no cycle`);
        for (const [tick, frame] of expected.entries()) {
          assert.deepEqual(frameDifference(rotated(frame), actual[tick], bounds),
            { missing: [], unexpected: [] }, `${context}: tick ${tick + 1}`);
        }
        assert.deepEqual(frameDifference(rotated(expected.at(-1)), simulateFinal(input, rotation, bounds), bounds),
          { missing: [], unexpected: [] }, `${context}: final API`);
      }
    }
  });
}
