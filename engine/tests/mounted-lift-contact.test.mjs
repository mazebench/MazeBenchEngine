import assert from 'node:assert/strict';
import test from 'node:test';
import { rotateVoxelsClockwise } from '../../apps/web/app/worldBounds.mjs';
import { project, simulateFrames, simulateFinal, frameDifference } from './helpers/project-engine.mjs';

for (const [id, description] of [
  ['regression-mxa-mounted-lift-contact', 'MxA second Up transmits the carrier push through its raised mounted lift'],
  ['regression-mxa-lowered-fixture-overlap', 'MxA third Up pushes a box whose collapsed lifts overlap the moving carrier'],
]) {
  test(description, () => {
    const fixture = project.tests.find(value => value.id === id);
    assert.ok(fixture);
    for (let rotation = 0; rotation < 4; ++rotation) {
      for (const remoteRamp of [false, true]) {
        const keep = voxel => remoteRamp || voxel.blockId !== 'ice-slope';
        const expected = rotateVoxelsClockwise(fixture.expected.voxels.filter(keep), fixture.world, rotation);
        for (const order of ['original', 'reversed', 'interleaved']) {
          let start = rotateVoxelsClockwise(fixture.start.voxels.filter(keep), fixture.world, rotation);
          if (order === 'reversed') start.reverse();
          if (order === 'interleaved') start = [
            ...start.filter((_, index) => index % 2),
            ...start.filter((_, index) => !(index % 2)),
          ];
          const context = `${rotation * 90}°, remote ramp ${remoteRamp}, ${order}`;
          const frames = simulateFrames(start, rotation, fixture.world);
          assert.equal(frames.cycle, null, context);
          assert.equal(frames.length, 1, `${context}: one push tick`);
          assert.deepEqual(frameDifference(expected, frames[0], fixture.world),
            { missing: [], unexpected: [] }, `${context}: animated API`);
          assert.deepEqual(frameDifference(expected, simulateFinal(start, rotation, fixture.world), fixture.world),
            { missing: [], unexpected: [] }, `${context}: search/final-state API`);
        }
      }
    }
  });
}
