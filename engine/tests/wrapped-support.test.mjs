import assert from "node:assert/strict";
import test from "node:test";
import { rotateVoxelsClockwise, rotateWorldClockwise } from "../../apps/web/app/worldBounds.mjs";
import { simulateFrames, simulateFinal, frameDifference } from "./helpers/project-engine.mjs";

const world = { width: 6, height: 6, floorLayer: 0 };
const box = (x, y, z, genericId) => ({ x, y, z, genericId, blockId: "weightless-pushbox-1826" });

for (const remoteSlope of [false, true]) {
  for (const scenario of ["wrapped support", "stationary support", "blocked front", "blocked support"]) {
    test(`player rides a wrapping push chain: ${scenario}, remote slope=${remoteSlope}`, () => {
      const terrain = Array.from({ length: 36 }, (_, i) => ({
        x: i % 6, y: Math.floor(i / 6), z: 0,
        ...(remoteSlope && i === 35
          ? { blockId: "ice-slope", orientation: "up" }
          : { blockId: "floor" }),
      }));
      const bodies = [box(1, 2, 1, 17), box(1, 3, 1, 17), box(1, 4, 1, 17),
        box(2, 2, 1, 17), box(2, 2, 2, 17), box(2, 3, 1, 53)];
      if (scenario !== "stationary support") bodies.push(box(2, 4, 1, 17));
      if (scenario === "blocked front") terrain.push({ x: 2, y: 1, z: 2, blockId: "wall" });
      if (scenario === "blocked support") {
        bodies.push(box(3, 3, 1, 53));
        terrain.push({ x: 3, y: 2, z: 1, blockId: "wall" });
      }
      const actors = [{ x: 2, y: 3, z: 2, blockId: "player" }, ...bodies];
      const start = [...terrain, ...actors];
      const expected = [...terrain, ...actors.map(v => ({
        ...v, y: v.y - Number(scenario === "wrapped support"),
      }))];
      for (let rotation = 0; rotation < 4; ++rotation) {
        const bounds = rotateWorldClockwise(world, rotation);
        const reference = rotateVoxelsClockwise(expected, world, rotation);
        for (const order of ["normal", "reversed", "interleaved"]) {
          let input = rotateVoxelsClockwise(start, world, rotation);
          if (order === "reversed") input.reverse();
          if (order === "interleaved") input = [...input.filter((_, i) => i % 2), ...input.filter((_, i) => !(i % 2))];
          const context = `${rotation * 90}°, ${order}`;
          const frames = simulateFrames(input, rotation, bounds);
          assert.equal(frames.length, 1, `${context}: one simultaneous tick`);
          assert.equal(frames.cycle, null);
          assert.deepEqual(frameDifference(reference, frames[0], bounds),
            { missing: [], unexpected: [] }, `${context}: tick`);
          assert.deepEqual(frameDifference(reference, simulateFinal(input, rotation, bounds), bounds),
            { missing: [], unexpected: [] }, `${context}: final-state API`);
        }
      }
    });
  }
}
