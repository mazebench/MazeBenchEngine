import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';
import {ConnectedWorldSessionV1} from '../play/v1/connected-world-session.mjs';

const blocks = [
  {id:'floor',roleId:'floor',visual:{kind:'floor'}},
  {id:'wall',roleId:'solid',visual:{kind:'cube'}},
  {id:'player',roleId:'player',visual:{kind:'cube'}},
  {id:'puncher',roleId:'puncher',visual:{kind:'puncher'}},
  {id:'lift',roleId:'player-lift',visual:{kind:'lift'}}
];
const directions = ['up','right','down','left'];

for (const binary of ['engine/v1/voxel_physics.wasm', 'world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm', 'solutions/v1/solutions-solver.wasm']) {
  test(`${binary}: punched player crosses raised and lowered lifts without toggling them`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`,import.meta.url)));
    for (let rotation = 0; rotation < 4; rotation++) {
      const rotate = object => {
        const result = {...object};
        for (let turn = 0; turn < rotation; turn++) [result.x,result.y] = [5-result.y,result.x];
        return result;
      };
      for (const reversed of [false,true]) for (const throughWorld of [false,true]) {
        const objects = [
          {x:1,y:4,z:1,blockId:'player'},
          {x:1,y:3,z:1,blockId:'puncher',orientation:directions[(1+rotation)%4]},
          {x:2,y:3,z:0,blockId:'lift',orientation:'top',stateId:1},
          {x:3,y:3,z:1,blockId:'lift',orientation:'top',stateId:0},
          {x:0,y:3,z:1,blockId:'wall'},
          {x:5,y:3,z:1,blockId:'wall'},
          {x:1,y:4,z:0,blockId:'wall'},
          ...[0,1,3,4,5].map(x=>({x,y:3,z:0,blockId:'wall'})),
          ...Array.from({length:36},(_,i)=>({x:i%6,y:Math.floor(i/6),z:0,blockId:'floor'}))
        ].map(rotate);
        if (reversed) objects.reverse();
        const room = {width:6,height:6,objects,fileName:'punch-lifts.json',columnIndex:0,rowIndex:0};
        const connected = new ConnectedWorldSessionV1(engine,blocks,[room]);
        const result = throughWorld
          ? await connected.simulateCommand(engine.createState(room),room,directions[rotation])
          : await engine.simulateCommand(room,directions[rotation],blocks);
        const context = `${rotation*90}°, reversed=${reversed}, connected=${throughWorld}`;
        assert.equal(result.cycle,null,context);
        assert.equal(result.frames.length,4,context);
        result.frames.forEach((frame,index)=>{
          const state = frame.state ?? frame;
          const player = state.objects.find(object=>object.blockId==='player');
          const expected = rotate({x:index+1,y:3,z:1});
          assert.deepEqual({x:player.x,y:player.y,z:player.z},expected,`${context}, tick ${index+1}`);
          const lifts = state.objects.filter(object=>object.blockId==='lift');
          assert.deepEqual(lifts.map(lift=>lift.stateId),reversed?[0,1]:[1,0],context);
          for (const lift of lifts) {
            const original = objects.find(object=>object.blockId==='lift'&&object.stateId===lift.stateId);
            assert.deepEqual([lift.x,lift.y,lift.z],[original.x,original.y,original.z],context);
          }
          assert.equal(state.objects.find(object=>object.blockId==='puncher').stateId,index===1?1:0,context);
        });
        assert.deepEqual(result.final.objects,(result.frames.at(-1).state??result.frames.at(-1)).objects,context);
      }
    }
  });
}
