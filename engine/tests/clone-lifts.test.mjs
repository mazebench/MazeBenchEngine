import assert from 'node:assert/strict';
import test from 'node:test';
import {rotateVoxelsClockwise,rotateWorldClockwise} from '../../apps/web/app/worldBounds.mjs';
import {simulateFrames,simulateFinal,frameDifference} from './helpers/project-engine.mjs';
import {cloneLiftFixtures} from './helpers/clone-lift-fixtures.mjs';

for (const fixture of cloneLiftFixtures) {
  test(fixture.name,()=>{
    for (let rotation=0;rotation<4;rotation++) for (const remoteRamp of [false,true]) {
      const world=rotateWorldClockwise(fixture.world,rotation);
      const terrain=remoteRamp?[{blockId:'ice-slope',x:5,y:0,z:0,orientation:'up'}]:[];
      const expected=fixture.frames.map(frame=>rotateVoxelsClockwise([...frame,...terrain],fixture.world,rotation));
      for (const order of ['normal','reversed','interleaved']) {
        let start=rotateVoxelsClockwise([...fixture.start,...terrain],fixture.world,rotation);
        if(order==='reversed')start.reverse();
        if(order==='interleaved')start=[...start.filter((_,i)=>i%2),...start.filter((_,i)=>!(i%2))];
        const context=`${rotation*90}°, remote ramp=${remoteRamp}, ${order}`;
        const direction=((fixture.direction??0)+rotation)%4;
        const actual=simulateFrames(start,direction,world);
        assert.equal(actual.cycle,null,context);
        assert.equal(actual.length,expected.length,context);
        expected.forEach((frame,tick)=>assert.deepEqual(frameDifference(frame,actual[tick],world),
          {missing:[],unexpected:[]},`${context}, tick ${tick+1}`));
        assert.deepEqual(frameDifference(expected.at(-1),simulateFinal(start,direction,world),world),
          {missing:[],unexpected:[]},`${context}, final-state API`);
      }
    }
  });
}
