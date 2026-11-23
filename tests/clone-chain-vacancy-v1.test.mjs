import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';
import {ConnectedWorldSessionV1} from '../play/v1/connected-world-session.mjs';
import {cloneChainVacancyFixtures} from '../engine/v1/core/tests/helpers/clone-chain-vacancy-fixtures.mjs';

const blocks = [
  {id:'floor',roleId:'floor',visual:{kind:'floor'}},
  {id:'wall',roleId:'solid',visual:{kind:'cube'}},
  {id:'ice-slope',roleId:'ice',visual:{kind:'slope'}},
  {id:'player',roleId:'player',visual:{kind:'cube'}},
  {id:'clone',roleId:'clone',visual:{kind:'cube'}},
  {id:'crate',roleId:'pushable',visual:{kind:'cube'}}
];
const directions = ['up','right','down','left'];
const canonical = objects => objects.map(object => JSON.stringify([
  object.blockId,object.x,object.y,object.z,object.genericId??-1
])).sort();

for (const binary of ['engine/v1/voxel_physics.wasm','world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm','solutions/v1/solutions-solver.wasm']) {
  test(`${binary}: blocked leading clones do not let followers overlap the player`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`,import.meta.url)));
    for (const fixture of cloneChainVacancyFixtures) {
      for (let rotation=0; rotation<4; rotation++) for (const remoteRamp of [false,true]) {
        const transform = objects => [...objects,...(remoteRamp?
          [{blockId:'ice-slope',x:7,y:7,z:1,orientation:directions[rotation]}]:[])].map(object => {
          const next = {...object,z:object.z-Number(object.blockId!=='floor')};
          for (let turn=0; turn<rotation; turn++) [next.x,next.y]=[7-next.y,next.x];
          return next;
        });
        for (const reversed of [false,true]) for (const throughWorld of [false,true]) {
          const objects = transform(fixture.start);
          if (reversed) objects.reverse();
          const room = {width:8,height:8,objects,fileName:'actor-chain.json',columnIndex:0,rowIndex:0};
          const connected = new ConnectedWorldSessionV1(engine,blocks,[room]);
          const result = throughWorld
            ? await connected.simulateCommand(engine.createState(room),room,directions[rotation])
            : await engine.simulateCommand(room,directions[rotation],blocks);
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
}
