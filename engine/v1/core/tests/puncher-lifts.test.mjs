import assert from 'node:assert/strict';
import test from 'node:test';
import {rotateVoxelsClockwise, rotateWorldClockwise} from '../../apps/web/app/worldBounds.mjs';
import {project, simulateFrames, simulateFinal, frameDifference} from './helpers/project-engine.mjs';

const fixture = project.tests.find(value => value.id === 'test-687');
assert.ok(fixture, 'the authored puncher/lift regression must exist');

test('punch momentum crosses raised and lowered lifts without actuating either', () => {
  for (let rotation = 0; rotation < 4; rotation++) {
    const world = rotateWorldClockwise(fixture.world, rotation);
    for (const remoteRamp of [false, true]) {
      const terrain = remoteRamp ? [{x:5,y:0,z:0,blockId:'ice-slope',orientation:'up'}] : [];
      const expected = [...fixture.intermediate, fixture.expected].map(frame =>
        rotateVoxelsClockwise([...frame.voxels, ...terrain], fixture.world, rotation));
      for (const order of ['original', 'reversed', 'interleaved']) {
        let start = rotateVoxelsClockwise([...fixture.start.voxels, ...terrain], fixture.world, rotation);
        if (order === 'reversed') start.reverse();
        if (order === 'interleaved') start = [
          ...start.filter((_, index) => index % 2),
          ...start.filter((_, index) => !(index % 2))
        ];
        const context = `${rotation * 90}°, remote ramp=${remoteRamp}, ${order}`;
        const frames = simulateFrames(start, rotation, world);
        assert.equal(frames.cycle, null, context);
        assert.equal(frames.length, expected.length, context);
        expected.forEach((frame, tick) => assert.deepEqual(
          frameDifference(frame, frames[tick], world), {missing:[],unexpected:[]},
          `${context}, tick ${tick + 1}`));
        assert.deepEqual(frameDifference(expected.at(-1), simulateFinal(start, rotation, world), world),
          {missing:[],unexpected:[]}, `${context}, final-state API`);
      }
    }
  }
});
