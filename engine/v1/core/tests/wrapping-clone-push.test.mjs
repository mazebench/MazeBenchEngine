import assert from 'node:assert/strict';
import test from 'node:test';
import {rotateVoxelsClockwise,rotateWorldClockwise} from '../../apps/web/app/worldBounds.mjs';
import {simulateFrames,simulateFinal,frameDifference} from './helpers/project-engine.mjs';
import {wrappingClonePushFixtures} from './helpers/wrapping-clone-push-fixtures.mjs';

for (const fixture of wrappingClonePushFixtures) {
  test(fixture.name, () => {
    for (let rotation=0; rotation<4; rotation++) for (const remoteRamp of [false,true]) {
      const terrain = remoteRamp ? [{blockId:'ice-slope',x:0,y:5,z:1,orientation:'up'}] : [];
      const world = rotateWorldClockwise(fixture.world,rotation);
      for (const relabel of [false,true]) {
        const transform = objects => rotateVoxelsClockwise([...objects,...terrain],fixture.world,rotation)
          .map(object => relabel && object.blockId==='clone'
            ? {...object,genericId:101-object.genericId} : object);
        const expected = transform(fixture.expected);
        for (const order of ['normal','reversed','interleaved']) {
          let start = transform(fixture.start);
          if (order==='reversed') start.reverse();
          if (order==='interleaved') start=[...start.filter((_,i)=>i%2),...start.filter((_,i)=>!(i%2))];
          const context=`${rotation*90}°, remote ramp=${remoteRamp}, relabel=${relabel}, ${order}`;
          const frames=simulateFrames(start,rotation,world);
          assert.equal(frames.cycle,null,context);
          assert.equal(frames.length,1,context);
          assert.deepEqual(frameDifference(expected,frames[0],world),{missing:[],unexpected:[]},context);
          assert.deepEqual(frameDifference(expected,simulateFinal(start,rotation,world),world),
            {missing:[],unexpected:[]},`${context}, final-state API`);
        }
      }
    }
  });
}
