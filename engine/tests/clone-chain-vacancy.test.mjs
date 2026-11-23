import assert from 'node:assert/strict';
import test from 'node:test';
import {rotateVoxelsClockwise} from '../../apps/web/app/worldBounds.mjs';
import {simulateFrames,simulateFinal,frameDifference} from './helpers/project-engine.mjs';
import {cloneChainVacancyFixtures} from './helpers/clone-chain-vacancy-fixtures.mjs';

for (const fixture of cloneChainVacancyFixtures) {
  test(`clone/player chain vacancy: ${fixture.name}`, () => {
    for (let rotation=0; rotation<4; rotation++) for (const remoteRamp of [false,true]) {
      for (const relabel of [false,true]) for (const order of ['authored','reversed','interleaved']) {
        const transform = objects => rotateVoxelsClockwise([
          ...objects,...(remoteRamp?[{blockId:'ice-slope',x:7,y:7,z:1,orientation:'up'}]:[])
        ],fixture.world,rotation).map(object => relabel && object.blockId==='clone' ? {
          ...object,genericId:(object.genericId & (1<<30)) | (113-(object.genericId & ~(1<<30)))
        } : object);
        let input = transform(fixture.start);
        if (order==='reversed') input.reverse();
        if (order==='interleaved') input = [...input.filter((_,i)=>i%2),...input.filter((_,i)=>!(i%2))];
        const expected = transform(fixture.expected);
        const context = `${rotation*90}°, ramp=${remoteRamp}, relabel=${relabel}, ${order}`;
        const frames = simulateFrames(input,rotation,fixture.world);
        assert.equal(frames.cycle,null,context);
        assert.equal(frames.length,1,context);
        assert.deepEqual(frameDifference(expected,frames[0],fixture.world),{missing:[],unexpected:[]},`${context}, animation`);
        assert.deepEqual(frameDifference(expected,simulateFinal(input,rotation,fixture.world),fixture.world),
          {missing:[],unexpected:[]},`${context}, search successor`);
      }
    }
  });
}
