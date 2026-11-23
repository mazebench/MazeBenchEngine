import assert from 'node:assert/strict';
import test from 'node:test';
import { rotateVoxelsClockwise } from '../../apps/web/app/worldBounds.mjs';
import { project, simulateFrames, simulateFinal, frameDifference } from './helpers/project-engine.mjs';

const fixture = project.tests.find(value => value.id === 'regression-jxa-isolated-push');

test('JxA second Down leaves the blocked remote ramp assembly stationary', () => {
  assert.ok(fixture);
  for (let rotation = 0; rotation < 4; ++rotation) {
    for (const order of ['original', 'reversed', 'interleaved']) {
      let start = rotateVoxelsClockwise(fixture.start.voxels, fixture.world, rotation);
      if (order === 'reversed') start.reverse();
      if (order === 'interleaved') start = [
        ...start.filter((_, index) => index % 2),
        ...start.filter((_, index) => !(index % 2)),
      ];
      const expected = rotateVoxelsClockwise(fixture.expected.voxels, fixture.world, rotation);
      const context = `${rotation * 90}°, ${order}`;
      const frames = simulateFrames(start, rotation, fixture.world);
      assert.equal(frames.cycle, null, context);
      assert.equal(frames.length, 1, `${context}: one deliberate push tick`);
      assert.deepEqual(frameDifference(expected, frames[0], fixture.world),
        { missing: [], unexpected: [] }, `${context}: animated tick`);
      assert.deepEqual(frameDifference(expected, simulateFinal(start, rotation, fixture.world), fixture.world),
        { missing: [], unexpected: [] }, `${context}: final-state API`);
    }
  }
});
