import assert from "node:assert/strict";
import test from "node:test";
import { rotateVoxelsClockwise, rotateWorldClockwise } from "../../apps/web/app/worldBounds.mjs";
import { simulateFrames, simulateFinal, frameDifference } from "./helpers/project-engine.mjs";

const world = { width: 8, height: 8, floorLayer: 0 };
const cube = (blockId, x, y, z, genericId) => ({ blockId, x, y, z, ...(genericId === undefined ? {} : { genericId }) });
const box = (x, y, z, id) => cube("weightless-pushbox-1826", x, y, z, id);

for (const actor of ["player", "box"]) {
  for (const scenario of ["single", "remote obstruction", "chain", "blocked chain"]) {
    test(`crest momentum: ${actor} meets ${scenario}`, () => {
      const chain = scenario.includes("chain");
      const blocked = scenario === "remote obstruction" || scenario === "blocked chain";
      const wide = scenario === "remote obstruction";
      const terrain = Array.from({ length: 64 }, (_, i) => cube("floor", i % 8, Math.floor(i / 8), 0));
      for (let x = 2; x <= 3; ++x) {
        for (let y = 0; y <= 2; ++y) {
          for (let z = 1; z <= 2; ++z) terrain.push(cube("wall", x, y, z));
        }
      }
      terrain.push(
        { ...cube("ice-slope", 2, 4, 1), orientation: "up" },
        cube("ice-9679", 2, 3, 1),
        { ...cube("ice-slope", 2, 3, 2), orientation: "up" },
      );
      if (blocked) terrain.push(cube("wall", wide ? 3 : 2, chain ? 0 : 1, 3));
      const frame = (tick, y, z, push = false) => [
        ...terrain,
        ...(actor === "box" ? [cube("player", 2, tick ? 5 : 6, 1), box(2, y, z, 9)] : [cube("player", 2, y, z)]),
        box(2, 2 - Number(push), 3, 17),
        ...(wide ? [box(3, 2 - Number(push), 3, 17)] : []),
        ...(chain ? [box(2, 1 - Number(push), 3, 23)] : []),
      ];
      const start = frame(0, 5, 1);
      const expected = [frame(1, 4, 2), frame(2, 3, 3)];
      if (blocked) {
        expected.push(frame(3, 4, 2));
        if (actor === "player") expected.push(frame(4, 5, 1));
      } else expected.push(frame(3, 2, 3, true));

      for (let rotation = 0; rotation < 4; ++rotation) {
        const bounds = rotateWorldClockwise(world, rotation);
        const rotated = start => rotateVoxelsClockwise(start, world, rotation);
        for (const reverse of [false, true]) {
          const input = rotated(start);
          if (reverse) input.reverse();
          const actual = simulateFrames(input, rotation, bounds);
          const context = `${rotation * 90}°, ${reverse ? "reversed" : "normal"} storage`;
          assert.equal(actual.length, expected.length, `${context}: exact tick count`);
          assert.equal(actual.cycle, null, `${context}: no cycle`);
          for (let tick = 0; tick < expected.length; ++tick) {
            assert.deepEqual(frameDifference(rotated(expected[tick]), actual[tick], bounds),
              { missing: [], unexpected: [] }, `${context}: tick ${tick + 1}`);
          }
          assert.deepEqual(frameDifference(rotated(expected.at(-1)), simulateFinal(input, rotation, bounds), bounds),
            { missing: [], unexpected: [] }, `${context}: final-state API`);
        }
      }
    });
  }
}
