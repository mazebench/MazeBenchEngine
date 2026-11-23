import assert from 'node:assert/strict';
import test from 'node:test';
import { rotateVoxelsClockwise, rotateWorldClockwise } from '../../apps/web/app/worldBounds.mjs';
import { project, simulateFrames, simulateFinal, frameDifference } from './helpers/project-engine.mjs';
import { interlockedFixture } from './helpers/interlocked-fixtures.mjs';

function verify(start, expected, world, label) {
  for (let rotation = 0; rotation < 4; ++rotation) {
    const bounds = rotateWorldClockwise(world, rotation);
    const input = rotateVoxelsClockwise(start, world, rotation);
    const target = rotateVoxelsClockwise(expected, world, rotation);
    for (const [order, ordered] of [
      ['normal', input], ['reverse', input.toReversed()],
      ['interleaved', [...input.filter((_, i) => i % 2), ...input.filter((_, i) => !(i % 2))]],
    ]) {
      const context = `${label}, ${rotation * 90}°, ${order}`;
      const frames = simulateFrames(ordered, rotation, bounds);
      assert.equal(frames.length, 1, `${context}: exactly one tick, no false momentum`);
      assert.equal(frames.cycle, null, `${context}: no cycle`);
      assert.deepEqual(frameDifference(target, frames[0], bounds), { missing: [], unexpected: [] }, context);
      assert.deepEqual(frameDifference(target, simulateFinal(ordered, rotation, bounds), bounds),
        { missing: [], unexpected: [] }, `${context}: final API agrees`);
    }
  }
}

for (const remote of [null, 'up', 'right', 'down', 'left']) {
  for (const blocked of [false, true]) for (const passenger of [false, true]) {
    test(`interlocked tunnel: ramp=${remote}, obstruction=${blocked}, passenger=${passenger}`, () => {
      for (const ids of [[0, 1], [17, 39], [1007, 0]]) {
        const { world, start, expected } = interlockedFixture({ remote, blocked, passenger, ids });
        verify(start, expected, world, `IDs ${ids}`);
      }
    });
  }
}
for (const id of ['audit-oxo-interlocked-push', 'audit-oxo-no-ramps', 'audit-interlocked-remote-ramp']) {
  test(`real-room interlocked regression: ${id}`, () => {
    const fixture = project.tests.find(t => t.id === id);
    assert.ok(fixture, 'the visible regression fixture must remain registered');
    verify(fixture.start.voxels, fixture.expected.voxels, fixture.world, id);
  });
}
