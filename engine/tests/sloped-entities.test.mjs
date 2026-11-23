import assert from 'node:assert/strict';
import test from 'node:test';
import { rotateVoxelsClockwise, rotateWorldClockwise } from '../../apps/web/app/worldBounds.mjs';
import { blocksById, simulateFrames, simulateFinal, frameDifference } from './helpers/project-engine.mjs';
import { slopedEntityFixture, rampEntityFixture, rigidSlopeScenarios, rampEntityScenarios } from './helpers/sloped-entity-fixtures.mjs';

function verify(fixture) {
  const {world,start,expected} = fixture;
  for (const voxel of [start, ...expected].flat()) assert.ok(blocksById.has(voxel.blockId), `Unknown fixture block: ${voxel.blockId}`);
  for (let rotation=0;rotation<4;++rotation) {
    const bounds=rotateWorldClockwise(world,rotation);
    const rotate=frame=>rotateVoxelsClockwise(frame,world,rotation);
    for (const order of ['forward','reverse','interleaved']) {
      let input=rotate(start);
      if(order==='reverse')input.reverse();
      if(order==='interleaved')input=[...input.filter((_,i)=>i%2),...input.filter((_,i)=>!(i%2))];
      const context=`${fixture.family}/${fixture.scenario}, ${rotation*90}°, ${order}`;
      const actual=simulateFrames(input,rotation,bounds);
      assert.equal(actual.length,expected.length,`${context}: tick count`);
      assert.equal(actual.cycle,null,`${context}: no cycle`);
      for(let tick=0;tick<expected.length;++tick) assert.deepEqual(frameDifference(rotate(expected[tick]),actual[tick],bounds),{missing:[],unexpected:[]},`${context}: tick ${tick+1}`);
      assert.deepEqual(frameDifference(rotate(expected.at(-1)),simulateFinal(input,rotation,bounds),bounds),{missing:[],unexpected:[]},`${context}: final API`);
    }
  }
}
for(const family of ['box','clone']) {
  for(const scenario of rigidSlopeScenarios) test(`${family} slope body: ${scenario}`,()=>{
    for(const orientation of ['up','right','down','left']) for(const id of [0,1007]) verify(slopedEntityFixture(family,scenario,{orientation,id}));
  });
  for(const scenario of rampEntityScenarios) test(`${family} ramp contact: ${scenario}`,()=>{
    for(const id of [0,1007]) verify(rampEntityFixture(family,scenario,{id}));
  });
}
