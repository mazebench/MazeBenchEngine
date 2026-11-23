import assert from 'node:assert/strict';
import test from 'node:test';
import { rotateVoxelsClockwise, rotateWorldClockwise } from '../../apps/web/app/worldBounds.mjs';
import { simulateFrames, simulateFinal, frameDifference } from './helpers/project-engine.mjs';
import { cloneVacancyFixture } from './helpers/clone-vacancy-fixtures.mjs';

for (const obstacle of ['wall', 'two-crates', 'two-floors', 'clear', 'ramp', 'ramp-ceiling']) {
  for (const remote of [false, true]) {
    test(`clone vacancy: ${obstacle}, distant ramp=${remote}`, () => {
      const { world, start, expected } = cloneVacancyFixture({ obstacle, remote });
      for (let rotation = 0; rotation < 4; ++rotation) {
        const bounds = rotateWorldClockwise(world, rotation);
        for (const reverse of [false, true]) {
          const input = rotateVoxelsClockwise(start, world, rotation);
          if (reverse) input.reverse();
          const context = `${rotation * 90}°, reverse=${reverse}`;
          const frames = simulateFrames(input, rotation, bounds);
          assert.equal(frames.length, expected.length, context);
          for (let tick = 0; tick < expected.length; ++tick) assert.deepEqual(
            frameDifference(rotateVoxelsClockwise(expected[tick], world, rotation), frames[tick], bounds),
            { missing: [], unexpected: [] }, `${context}, tick ${tick + 1}`);
          assert.deepEqual(frameDifference(rotateVoxelsClockwise(expected.at(-1), world, rotation),
            simulateFinal(input, rotation, bounds), bounds), { missing: [], unexpected: [] }, `${context}, final API`);
        }
      }
    });
  }
}
