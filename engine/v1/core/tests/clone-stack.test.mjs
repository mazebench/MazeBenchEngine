import assert from 'node:assert/strict';
import test from 'node:test';
import {rotateVoxelsClockwise, rotateWorldClockwise} from '../../apps/web/app/worldBounds.mjs';
import {project, simulateFrames, simulateFinal, frameDifference} from './helpers/project-engine.mjs';

for (const id of ['test-665', 'test-666', 'test-678', 'test-679', 'test-680', 'test-681', 'test-682', 'test-683', 'test-684', 'test-685', 'test-686', 'test-688', 'test-689', 'test-690']) {
  test(`${id}: clone support and carrying are independent of storage and group IDs`, () => {
    const fixture = project.tests.find(t=>t.id===id);
    assert(fixture, `Missing authored regression ${id}`);
    for (const relabel of [false,true]) for (let rotation=0; rotation<4; ++rotation) {
      const world = rotateWorldClockwise(fixture.world,rotation);
      const transform = frame => rotateVoxelsClockwise(frame.voxels,fixture.world,rotation).map(v=>
        relabel && v.blockId==='clone' ? {...v,genericId:71-v.genericId*17,groupId:71-v.genericId*17} : v);
      const original = transform(fixture.start);
      const expected = [...fixture.intermediate,fixture.expected].map(transform);
      for (const order of ['authored','reversed','interleaved']) {
        const start = order==='reversed' ? [...original].reverse() : order==='interleaved'
          ? [...original.filter((_,i)=>i%2),...original.filter((_,i)=>!(i%2))] : original;
        const context = `${rotation*90}°, ${order}, relabel=${relabel}`;
        const frames = simulateFrames(start,rotation,world);
        assert.equal(frames.cycle,null,context);
        assert.equal(frames.length,expected.length,context);
        for (const [i,frame] of expected.entries()) assert.deepEqual(
          frameDifference(frame,frames[i],world),{missing:[],unexpected:[]},`${context}, tick ${i+1}`);
        assert.deepEqual(frameDifference(expected.at(-1),simulateFinal(start,rotation,world),world),
          {missing:[],unexpected:[]},`${context}, final-state API`);
      }
    }
  });
}

test('a clone may use player cargo that stays behind against terrain', () => {
  const fixture = project.tests.find(t => t.id === 'test-679');
  const boxId = fixture.start.voxels.find(v => v.genericId === 0 && v.blockId !== 'clone').blockId;
  const wall = fixture.start.voxels.find(v => v.blockId === 'wall');
  const start = [...fixture.start.voxels, {...wall, x: 3, y: 2, z: 2, instanceId: 'cargo-blocker'}];
  const expected = [1, 2].map(tick => start.map(v => v.blockId === 'player'
    ? {...v, y: 2} : v.blockId === 'clone' ? {...v, y: 3, z: 4 - tick}
      : v.blockId === boxId ? {...v, z: 3 - tick} : v));
  for (let rotation = 0; rotation < 4; rotation++) for (const reversed of [false, true]) {
    const world = rotateWorldClockwise(fixture.world, rotation);
    let rotated = rotateVoxelsClockwise(start, fixture.world, rotation);
    if (reversed) rotated.reverse();
    const frames = simulateFrames(rotated, rotation, world);
    assert.equal(frames.cycle, null);
    assert.equal(frames.length, 2);
    expected.forEach((frame, tick) => assert.deepEqual(
      frameDifference(rotateVoxelsClockwise(frame, fixture.world, rotation), frames[tick], world),
      {missing: [], unexpected: []}, `rotation=${rotation}, reversed=${reversed}, tick=${tick + 1}`));
  }
});

for (const id of ['test-685', 'test-686']) {
  test(`${id}: Down then Up returns free clones beside a blocked wrapping body`, () => {
    const fixture = project.tests.find(t => t.id === id);
    for (let rotation = 0; rotation < 4; rotation++) for (const reversed of [false, true]) {
      const world = rotateWorldClockwise(fixture.world, rotation);
      const beforeDown = fixture.start.voxels.map(v =>
        v.blockId === 'player' || v.blockId === 'clone' && v.genericId === 1 ? {...v, y: v.y - 1} : v);
      let start = rotateVoxelsClockwise(beforeDown, fixture.world, rotation);
      if (reversed) start.reverse();
      const down = simulateFrames(start, (rotation + 2) % 4, world);
      assert.equal(down.cycle, null);
      assert.equal(down.length, 1);
      assert.deepEqual(frameDifference(rotateVoxelsClockwise(fixture.start.voxels, fixture.world, rotation), down[0], world),
        {missing: [], unexpected: []}, 'Down creates the touching state');
      const up = simulateFrames(down.at(-1), rotation, world);
      assert.equal(up.cycle, null);
      assert.equal(up.length, 1);
      assert.deepEqual(frameDifference(start, up[0], world), {missing: [], unexpected: []},
        'Up must return the free actors without moving the blocked wrapper');
      assert.deepEqual(frameDifference(start, simulateFinal(down.at(-1), rotation, world), world),
        {missing: [], unexpected: []}, 'search successor must agree with tick playback');
    }
  });
}
