import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';
import {ConnectedWorldSessionV1} from '../play/v1/connected-world-session.mjs';
import {cloneLiftFixtures} from '../engine/v1/core/tests/helpers/clone-lift-fixtures.mjs';

const blocks = [
  {id:'floor',roleId:'floor',visual:{kind:'floor'}},
  {id:'ice-9679',roleId:'ice',visual:{kind:'floor'}},
  {id:'wall',roleId:'solid',visual:{kind:'cube'}},
  {id:'player',roleId:'player',visual:{kind:'cube'}},
  {id:'clone',roleId:'clone',visual:{kind:'cube'}},
  {id:'player-lift',roleId:'player-lift',visual:{kind:'lift'}},
  {id:'puncher',roleId:'puncher',visual:{kind:'puncher'}}
];
const directions = ['up','right','down','left'];
const visualObjects = objects => objects.map(object => ({...object,
  z:object.z-(['floor','ice-9679'].includes(object.blockId)?0:1)}));
const canonical = objects => objects.map(object => JSON.stringify([
  object.blockId,object.x,object.y,object.z,object.genericId??-1
])).sort();

for (const binary of ['engine/v1/voxel_physics.wasm','world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm','solutions/v1/solutions-solver.wasm']) {
  test(`${binary}: clone lift activation matches canonical animation frames`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`,import.meta.url)));
    for (const fixture of cloneLiftFixtures) {
      for (const reversed of [false,true]) for (const throughWorld of [false,true]) {
        const objects = visualObjects(fixture.start);
        if (reversed) objects.reverse();
        const room = {width:6,height:6,objects,fileName:'clone-lifts.json',columnIndex:0,rowIndex:0};
        const connected = new ConnectedWorldSessionV1(engine,blocks,[room]);
        const direction = directions[fixture.direction??0];
        const result = throughWorld
          ? await connected.simulateCommand(engine.createState(room),room,direction)
          : await engine.simulateCommand(room,direction,blocks);
        const context = `${fixture.name}, reversed=${reversed}, connected=${throughWorld}`;
        assert.equal(result.cycle,null,context);
        assert.equal(result.frames.length,fixture.frames.length,context);
        result.frames.forEach((frame,index) => assert.deepEqual(
          canonical((frame.state??frame).objects),canonical(visualObjects(fixture.frames[index])),
          `${context}, tick ${index+1}`));
        assert.deepEqual(canonical(result.final.objects),
          canonical(visualObjects(fixture.frames.at(-1))),`${context}, final state`);
      }
    }
  });
}
