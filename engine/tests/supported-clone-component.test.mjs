import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {rotateVoxelsClockwise} from '../../apps/web/app/worldBounds.mjs';
import {engine,simulateFrames,simulateFinal,frameDifference} from './helpers/project-engine.mjs';
import {supportedCloneComponentFixtures} from './helpers/supported-clone-component-fixtures.mjs';

for (const fixture of supportedCloneComponentFixtures) test(`supported actor component: ${fixture.name}`,()=>{
  for (let rotation=0;rotation<4;rotation++) for (const remoteRamp of [false,true]) {
    const transform=objects=>rotateVoxelsClockwise([...objects,...(remoteRamp?
      [{blockId:'ice-slope',x:5,y:0,z:1,orientation:'up'}]:[])],fixture.world,rotation);
    for (const reversed of [false,true]) {
      const input=transform(fixture.start);if(reversed)input.reverse();
      const expected=transform(fixture.expected),direction=(3+rotation)%4;
      const context=`${rotation*90}°, ramp=${remoteRamp}, reversed=${reversed}`;
      const frames=simulateFrames(input,direction,fixture.world);
      assert.equal(frames.cycle,null,context);assert.equal(frames.length,1,context);
      assert.deepEqual(frameDifference(expected,frames[0],fixture.world),{missing:[],unexpected:[]},context);
      assert.deepEqual(frameDifference(expected,simulateFinal(input,direction,fixture.world),fixture.world),
        {missing:[],unexpected:[]},`${context}, search successor`);
    }
  }
});

test('PxP saved run 160: clone 1 moves on both Left commands after Right ×7',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/pxp-supported-clone-component.json',import.meta.url),'utf8'));
  for (const reversed of [false,true]) {
    const voxels=fixture.voxels.map(v=>[...v]);if(reversed)voxels.reverse();
    const buffer=new Int32Array(engine.memory.buffer,engine.voxel_buffer(),voxels.length*5);
    buffer.set(voxels.flat());
    for (let left=1;left<=2;left++) {
      engine.reset_command();
      assert.equal(engine.step_command_tick(voxels.length,16,16,3),0);
      assert.equal(engine.command_tick(),1);
      voxels.forEach((v,i)=>{
        if(v[3]===fixture.cloneRole&&v[4]===1||v[3]===fixture.playerRole)
          assert.deepEqual(Array.from(buffer.slice(i*5,i*5+3)),[v[0]-left,v[1],v[2]],`Left ${left}, voxel ${i}`);
      });
    }
  }
});
