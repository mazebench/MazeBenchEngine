import assert from 'node:assert/strict';
import test from 'node:test';
import {rotateVoxelsClockwise, rotateWorldClockwise} from '../../apps/web/app/worldBounds.mjs';
import {simulateFrames, simulateFinal, frameDifference} from './helpers/project-engine.mjs';

const world = {width:6, height:6, floorLayer:0};
for (const startMode of ['fresh', 'sprung', 'previous blocked punch']) {
  for (const remoteSlope of [false, true]) {
    for (const direction of [0, 1, 3]) {
      test(`resting puncher contact allows the input first: direction=${direction}, remote ramp=${remoteSlope}, start=${startMode}`, () => {
        const terrain = Array.from({length:36}, (_, i) => ({x:i%6, y:Math.floor(i/6), z:0,
          ...(remoteSlope && i===35 ? {blockId:'ice-slope',orientation:'up'} : {blockId:'floor'})}));
        const box = {x:2,y:1,z:1,blockId:'weightless-pushbox-1826',genericId:17};
        const player = {x:2,y:2,z:1,blockId:'player'};
        const puncher = {x:2,y:2,z:1,blockId:'puncher',genericId:0,orientation:'down'};
        const fixed = [...terrain,
          {x:2,y:3,z:1,blockId:'weightless-pushbox-1826',genericId:53},
          {x:2,y:4,z:1,blockId:'wall'}];
        const start = [...fixed,box,
          {...player, ...(startMode==='previous blocked punch' ? {x:3} : {})},
          {...puncher,genericId:startMode==='sprung'?1:0}];
        const expected = direction===0 ? [
          [...fixed,{...box,y:0},{...player,y:1},{...puncher,y:1}],
          [...fixed,{...box,y:0},player,{...puncher,y:1,genericId:1}],
          [...fixed,{...box,y:0},player,{...puncher,y:1}],
        ] : [[...fixed,box,{...player,x:direction===1?3:1},puncher]];
        for (let rotation=0;rotation<4;rotation++) {
          const bounds=rotateWorldClockwise(world,rotation),inputDirection=(direction+rotation)%4;
          const reference=expected.map(frame=>rotateVoxelsClockwise(frame,world,rotation));
          for (const order of ['normal','reversed','interleaved']) {
            let input=rotateVoxelsClockwise(start,world,rotation);
            if(order==='reversed')input.reverse();
            if(order==='interleaved')input=[...input.filter((_,i)=>i%2),...input.filter((_,i)=>!(i%2))];
            const context=`${rotation*90}°, ${order}`;
            if(startMode==='previous blocked punch') {
              const approach=simulateFrames(input,(3+rotation)%4,bounds);
              assert.equal(approach.cycle,null,context);
              input=approach.at(-1);
              assert.deepEqual(frameDifference(rotateVoxelsClockwise(
                [...fixed,box,player,{...puncher,genericId:1}],world,rotation),input,bounds),
                {missing:[],unexpected:[]},`${context}: previous punch was blocked`);
            }
            const actual=simulateFrames(input,inputDirection,bounds);
            assert.equal(actual.length,reference.length,context);
            assert.equal(actual.cycle,null,context);
            for(const [i,frame]of reference.entries())assert.deepEqual(frameDifference(frame,actual[i],bounds),
              {missing:[],unexpected:[]},`${context}: tick ${i+1}`);
            assert.deepEqual(frameDifference(reference.at(-1),simulateFinal(input,inputDirection,bounds),bounds),
              {missing:[],unexpected:[]},`${context}: final-state API`);
          }
        }
      });
    }
  }
}
