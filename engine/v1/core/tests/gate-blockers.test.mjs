import assert from "node:assert/strict";
import test from "node:test";
import { rotateVoxelsClockwise, rotateWorldClockwise } from "../../apps/web/app/worldBounds.mjs";
import { simulateFrames, simulateFinal, frameDifference } from "./helpers/project-engine.mjs";

const world = { width: 6, height: 6, floorLayer: 0 };
for (const blockId of ["crate", "weightless-pushbox-1826", "floating-floor"]) {
  test(`${blockId} keeps an occupied gate lowered without an extra tick`, () => {
    const terrain = Array.from({ length: 6 }, (_, y) => ({ x: 2, y, z: 0, blockId: "floor" }));
    const player = { x: 2, y: 4, z: 1, blockId: "player" };
    const body = { x: 2, y: 3, z: 1, blockId,
      ...(blockId === "weightless-pushbox-1826" ? { genericId: 47 } : {}) };
    const gate = { x: 2, y: 2, z: 1, blockId: "player-gate", genericId: 0 };
    const initial = [...terrain, player, body, gate];
    for (let rotation = 0; rotation < 4; ++rotation) {
      const bounds = rotateWorldClockwise(world, rotation);
      for (const order of ["normal", "reverse", "interleaved"]) {
        let start = initial;
        for (let command = 1; command <= 3; ++command) {
          // Enter the occupied plate, push the body off it while the player
          // overlaps it, then leave it. Only the last command raises the gate.
          const movement = [...terrain, { ...player, y: 4 - command },
            { ...body, y: 3 - command }, gate];
          const expected = command === 3
            ? [movement, movement.map(v => v.blockId === "player-gate" ? { ...v, genericId: 1 } : v)]
            : [movement];
          let input = rotateVoxelsClockwise(start, world, rotation);
          if (order === "reverse") input.reverse();
          if (order === "interleaved") input = [...input.filter((_, i) => i % 2), ...input.filter((_, i) => !(i % 2))];
          const context = `${rotation * 90}°, ${order}, command ${command}`;
          const actual = simulateFrames(input, rotation, bounds);
          assert.equal(actual.length, expected.length, `${context}: exact gate timing`);
          for (const [tick, frame] of expected.entries()) {
            assert.deepEqual(frameDifference(rotateVoxelsClockwise(frame, world, rotation), actual[tick], bounds),
              { missing: [], unexpected: [] }, `${context}: tick ${tick + 1}`);
          }
          assert.deepEqual(frameDifference(rotateVoxelsClockwise(expected.at(-1), world, rotation),
            simulateFinal(input, rotation, bounds), bounds), { missing: [], unexpected: [] }, `${context}: final API`);
          start = expected.at(-1);
        }
      }
    }
  });
}
