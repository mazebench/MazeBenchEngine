import assert from 'node:assert/strict';
import test from 'node:test';
import {rotateVoxelsClockwise} from '../../apps/web/app/worldBounds.mjs';
import {project, simulateFrames, simulateFinal, frameDifference} from './helpers/project-engine.mjs';

test('AxP Right then Up walks across group 3 without dragging the supporting polycube', () => {
  const fixture = project.tests.find(t => t.id === 'regression-axp-walk-on-polycube');
  assert.ok(fixture);
  const afterRight = fixture.start.voxels;
  // The first command pushes the rear side of group 3 by exactly one cell.
  // Reconstruct the preceding authored state independently of the engine.
  const beforeRight = afterRight.map(o => o.genericId === 3 || o.blockId === 'player'
    ? {...o, x: o.x - 1} : o);
  for (let rotation = 0; rotation < 4; ++rotation) {
    const rotate = voxels => rotateVoxelsClockwise(voxels, fixture.world, rotation);
    for (const order of ['forward', 'reverse', 'interleaved']) {
      let input = rotate(beforeRight);
      if (order === 'reverse') input.reverse();
      if (order === 'interleaved') input = [...input.filter((_, i) => i % 2), ...input.filter((_, i) => !(i % 2))];
      const context = `${rotation * 90}°, ${order}`;
      const pushed = simulateFrames(input, (1 + rotation) % 4, fixture.world);
      assert.equal(pushed.length, 1, `${context}: one Right push tick`);
      assert.deepEqual(frameDifference(rotate(afterRight), pushed[0], fixture.world),
        {missing: [], unexpected: []}, `${context}: Right setup`);
      const walked = simulateFrames(pushed[0], rotation, fixture.world);
      assert.equal(walked.length, 1, `${context}: one Up walking tick`);
      assert.equal(walked.cycle, null);
      assert.deepEqual(frameDifference(rotate(fixture.expected.voxels), walked[0], fixture.world),
        {missing: [], unexpected: []}, `${context}: only the player walks`);
      assert.deepEqual(frameDifference(rotate(fixture.expected.voxels),
        simulateFinal(pushed[0], rotation, fixture.world), fixture.world),
      {missing: [], unexpected: []}, `${context}: final-state search API`);
    }
  }
});
