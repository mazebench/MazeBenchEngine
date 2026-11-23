import assert from 'node:assert/strict';
import test from 'node:test';
import { project, simulateFrames, frameDifference } from './helpers/project-engine.mjs';
import { rotateVoxelsClockwise } from '../../apps/web/app/worldBounds.mjs';

// A sealed, unoccupied ramp cannot influence physics on the other side of a
// wall. Exercise both dispatch paths with repeatable ordinary 3D arrangements.
const world = { width: 8, height: 8, floorLayer: 0 };
function makeScene(seed) {
  let state = seed;
  const next = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const voxels = [];
  for (let x = 0; x < 8; ++x) for (let y = 0; y < 8; ++y) {
    voxels.push({ x, y, z: 0, blockId: 'floor' });
    if (x === 6 || y === 6) for (let z = 1; z <= 5; ++z) voxels.push({ x, y, z, blockId: 'wall' });
  }
  voxels.push({ x: 3, y: 4, z: 1, blockId: 'player' });
  for (let x = 1; x < 6; ++x) for (let y = 1; y < 6; ++y) {
    if (x === 3 && y === 4) continue;
    const kind = next(6);
    if (kind > 3) continue;
    const blockId = ['wall', 'crate', 'weightless-pushbox-1826', 'clone'][kind];
    const height = kind >= 2 ? 1 + next(3) : 1;
    for (let z = 1; z <= height; ++z) voxels.push({ x, y, z, blockId, ...(kind >= 2 ? { genericId: x * 8 + y } : {}) });
  }
  return voxels;
}

for (const id of ['test-656', 'test-657']) {
  test(`remote ramps preserve mounted lowered lift pushes: ${id}`, () => {
    const authored = project.tests.find(value => value.id === id);
    assert.ok(authored, `missing authored lift fixture ${id}`);
    for (let rotation = 0; rotation < 4; ++rotation) {
      for (const reversed of [false, true]) {
        const start = rotateVoxelsClockwise(authored.start.voxels,
          authored.world, rotation);
        const ramp = rotateVoxelsClockwise([
          { x: 5, y: 5, z: 1, blockId: 'ice-slope', orientation: 'up' }
        ], authored.world, rotation);
        if (reversed) start.reverse();
        const baseline = simulateFrames(start, rotation, authored.world);
        const withRamp = simulateFrames([...start, ...ramp], rotation, authored.world);
        const context = `${id}, rotation ${rotation}, reversed ${reversed}`;
        assert.equal(withRamp.length, baseline.length, `${context}: tick count`);
        assert.deepEqual(withRamp.cycle, baseline.cycle, `${context}: cycle`);
        baseline.forEach((frame, index) => {
          assert.deepEqual(frameDifference(frame,
            withRamp[index].filter(voxel => voxel.blockId !== 'ice-slope'),
            authored.world), { missing: [], unexpected: [] },
          `${context}: tick ${index + 1}`);
        });
      }
    }
  });
}
for (let batch = 0; batch < 8; ++batch) {
  test(`remote terrain invariance: deterministic batch ${batch + 1}`, () => {
    for (let offset = 0; offset < 32; ++offset) {
      const seed = 0x0a0b0000 + batch * 32 + offset;
      let baseline = makeScene(seed);
      let rampScene = [...baseline, { x: 7, y: 7, z: 1, blockId: 'ice-slope', orientation: ['up', 'right', 'down', 'left'][seed % 4] }];
      for (let command = 0; command < 4; ++command) {
        const direction = (seed + command) % 4;
        const normal = simulateFrames(baseline, direction, world);
        const withRamp = simulateFrames(rampScene, direction, world);
        const context = `seed ${seed}, command ${command}, direction ${direction}`;
        assert.equal(withRamp.length, normal.length, `${context}: exact tick count`);
        assert.deepEqual(withRamp.cycle, normal.cycle, `${context}: cycle`);
        for (let tick = 0; tick < normal.length; ++tick) {
          assert.deepEqual(frameDifference(normal[tick], withRamp[tick].filter(v => v.blockId !== 'ice-slope'), world),
            { missing: [], unexpected: [] }, `${context}: tick ${tick + 1}`);
        }
        baseline = normal.at(-1) ?? baseline;
        rampScene = withRamp.at(-1) ?? rampScene;
      }
    }
  });
}
