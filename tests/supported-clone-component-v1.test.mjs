import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';
import {ConnectedWorldSessionV1} from '../play/v1/connected-world-session.mjs';
import {supportedCloneComponentFixtures} from '../engine/v1/core/tests/helpers/supported-clone-component-fixtures.mjs';

const blocks = [
  {id:'floor',roleId:'floor',visual:{kind:'floor'}},
  {id:'wall',roleId:'solid',visual:{kind:'cube'}},
  {id:'ice-slope',roleId:'ice',visual:{kind:'slope'}},
  {id:'player',roleId:'player',visual:{kind:'cube'}},
  {id:'clone',roleId:'clone',visual:{kind:'cube'}}
];
const directions = ['up','right','down','left'];
const canonical = objects => objects.map(object => JSON.stringify([
  object.blockId,object.x,object.y,object.z,object.genericId??-1
])).sort();

for (const binary of ['engine/v1/voxel_physics.wasm','world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm','solutions/v1/solutions-solver.wasm']) {
  test(`${binary}: touching actor components retain their carrier support`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`,import.meta.url)));
    for (const fixture of supportedCloneComponentFixtures) {
      for (let rotation=0; rotation<4; rotation++) for (const remoteRamp of [false,true]) {
        const terrain = remoteRamp ? [{blockId:'ice-slope',x:5,y:0,z:1,orientation:directions[rotation]}] : [];
        const transform = objects => [...objects,...terrain].map(object => {
          const next = {...object,z:object.z-Number(object.blockId!=='floor')};
          for (let turn=0; turn<rotation; turn++) [next.x,next.y]=[5-next.y,next.x];
          return next;
        });
        for (const reversed of [false,true]) for (const throughWorld of [false,true]) {
          const objects = transform(fixture.start);
          if (reversed) objects.reverse();
          const room = {width:6,height:6,objects,fileName:'supported-clone.json',columnIndex:0,rowIndex:0};
          const connected = new ConnectedWorldSessionV1(engine,blocks,[room]);
          const direction = directions[(3+rotation)%4];
          const result = throughWorld
            ? await connected.simulateCommand(engine.createState(room),room,direction)
            : await engine.simulateCommand(room,direction,blocks);
          const context = `${fixture.name}, ${rotation*90}°, ramp=${remoteRamp}, reversed=${reversed}, connected=${throughWorld}`;
          assert.equal(result.cycle,null,context);
          assert.equal(result.frames.length,1,context);
          const expected = canonical(transform(fixture.expected));
          assert.deepEqual(canonical((result.frames[0].state??result.frames[0]).objects),expected,`${context}, animation`);
          assert.deepEqual(canonical(result.final.objects),expected,`${context}, final state`);
        }
      }
    }
  });

  test(`${binary}: captured PxP clone 1 moves on both Left commands`, async () => {
    const fixture = JSON.parse(await readFile(new URL(
      '../engine/v1/core/tests/fixtures/pxp-supported-clone-component.json',import.meta.url),'utf8'));
    const {exports:engine} = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`,import.meta.url)));
    for (const reversed of [false,true]) {
      const voxels = fixture.voxels.map(voxel=>[...voxel]);
      if (reversed) voxels.reverse();
      const buffer = new Int32Array(engine.memory.buffer,engine.voxel_buffer(),voxels.length*5);
      buffer.set(voxels.flat());
      for (let left=1; left<=2; left++) {
        engine.reset_command();
        assert.equal(engine.step_command_tick(voxels.length,16,16,3),0);
        assert.equal(engine.command_tick(),1);
        voxels.forEach((voxel,index)=>{
          if ((voxel[3]===fixture.cloneRole && voxel[4]===1) || voxel[3]===fixture.playerRole) {
            assert.deepEqual(Array.from(buffer.slice(index*5,index*5+3)),
              [voxel[0]-left,voxel[1],voxel[2]],`Left ${left}, voxel ${index}, reversed=${reversed}`);
          }
        });
      }
    }
  });
}
