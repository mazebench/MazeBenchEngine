import assert from "node:assert/strict";
import test from "node:test";
import { rotateVoxelsClockwise, rotateWorldClockwise } from "../../apps/web/app/worldBounds.mjs";
import { simulateFrames, simulateFinal, frameDifference } from "./helpers/project-engine.mjs";

const world = { width: 6, height: 6, floorLayer: 0 };
const box = (x, y, z, genericId) => ({ x, y, z, genericId, blockId: "weightless-pushbox-1826" });

for (const remoteSlope of [false, true]) {
  for (const losesSupport of [false, true]) {
    for (const stacked of [false, true]) {
      test(`blocked passenger: remote ramp=${remoteSlope}, loses support=${losesSupport}, stack=${stacked}`, () => {
        const terrain = Array.from({ length: 36 }, (_, i) => ({ x: i % 6, y: Math.floor(i / 6), z: 0,
          ...(remoteSlope && i === 35 ? { blockId: "ice-slope", orientation: "up" } : { blockId: "floor" }) }));
        const riderY = losesSupport ? 3 : 2;
        terrain.push({ x: 2, y: riderY - 1, z: 4, blockId: "wall" });
        const carrier = [];
        for (let x = 1; x <= 2; ++x) {
          for (let y = 2; y <= 3; ++y) {
            for (let z = 1; z <= 3; ++z) carrier.push(box(x, y, z, 17));
          }
        }
        const player = { x: 2, y: 4, z: 1, blockId: "player" };
        const passengers = [box(2, riderY, 4, 39)];
        if (stacked) passengers.push(box(2, riderY, 5, 63));
        const start = [...terrain, player, ...carrier, ...passengers];
        const expected = Array.from({ length: losesSupport ? 3 : 1 }, (_, tick) => [
          ...terrain, { ...player, y: 3 }, ...carrier.map(v => ({ ...v, y: v.y - 1 })),
          ...passengers.map(v => ({ ...v, z: v.z - tick })),
        ]);
        for (let rotation = 0; rotation < 4; ++rotation) {
          const bounds = rotateWorldClockwise(world, rotation);
          for (const order of ["normal", "reverse", "interleaved"]) {
            let input = rotateVoxelsClockwise(start, world, rotation);
            if (order === "reverse") input.reverse();
            if (order === "interleaved") input = [...input.filter((_, i) => i % 2), ...input.filter((_, i) => !(i % 2))];
            const context = `${rotation * 90}°, ${order}`;
            const frames = simulateFrames(input, rotation, bounds);
            assert.equal(frames.length, expected.length, `${context}: exact fall timing`);
            for (const [index, frame] of expected.entries()) {
              assert.deepEqual(frameDifference(rotateVoxelsClockwise(frame, world, rotation), frames[index], bounds),
                { missing: [], unexpected: [] }, `${context}: tick ${index + 1}`);
            }
            assert.deepEqual(frameDifference(rotateVoxelsClockwise(expected.at(-1), world, rotation),
              simulateFinal(input, rotation, bounds), bounds), { missing: [], unexpected: [] }, `${context}: final-state API`);
          }
        }
      });
    }
  }
}

for (const remoteSlope of [false, true]) {
  for (const sharesPlayer of [false, true]) {
    for (const startsOnIce of [false, true]) {
      test(`stack carry: remote ramp=${remoteSlope}, player foothold=${sharesPlayer}, initial Ice=${startsOnIce}`, () => {
        const terrain = Array.from({ length: 36 }, (_, i) => ({ x: i % 6, y: Math.floor(i / 6), z: 0,
          ...(remoteSlope && i === 35 ? { blockId: "ice-slope", orientation: "up" } : { blockId: "floor" }) }));
        const dynamic = [{ x: 0, y: 5, z: 2, blockId: "player" }];
        for (let x = 0; x < 2; ++x) {
          for (let y = 1; y <= 4; ++y) {
            terrain.push({ x, y, z: 1, blockId: startsOnIce && y >= 2 ? "ice-9679" : "wall" });
            if (y < 2) continue;
            // A hole under the upper slab exposes the difference between
            // riding a carrier and acquiring independent slide momentum.
            if (x !== 0 || y !== 3) dynamic.push(box(x, y, 2, 17));
            dynamic.push(box(x, y, 3, 39));
          }
        }
        terrain.push({ x: 0, y: 5, z: 1, blockId: "wall" });
        if (sharesPlayer) dynamic.push(box(0, 5, 3, 39));
        const start = [...terrain, ...dynamic];
        const expected = [...terrain, ...dynamic.map(v => ({ ...v, y: v.y - 1 }))];
        for (let rotation = 0; rotation < 4; ++rotation) {
          const bounds = rotateWorldClockwise(world, rotation);
          const reference = rotateVoxelsClockwise(expected, world, rotation);
          for (const order of ["normal", "reverse", "interleaved"]) {
            let input = rotateVoxelsClockwise(start, world, rotation);
            if (order === "reverse") input.reverse();
            if (order === "interleaved") input = [...input.filter((_, i) => i % 2), ...input.filter((_, i) => !(i % 2))];
            const context = `${rotation * 90}°, ${order}`;
            const frames = simulateFrames(input, rotation, bounds);
            assert.equal(frames.length, 1, `${context}: no missing or extra carry tick`);
            assert.deepEqual(frameDifference(reference, frames[0], bounds), { missing: [], unexpected: [] }, context);
            assert.deepEqual(frameDifference(reference, simulateFinal(input, rotation, bounds), bounds),
              { missing: [], unexpected: [] }, `${context}: final-state API`);
          }
        }
      });
    }
  }
}
