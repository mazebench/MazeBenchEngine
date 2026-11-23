import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';
import {decodeVoxelRoom} from '../render/v1/voxel-world-v2.mjs';
import {ConnectedWorldSessionV1} from '../play/v1/connected-world-session.mjs';

const blocks = [
  {id: 'floor', roleId: 'floor', visual: {kind: 'floor'}},
  {id: 'wall', roleId: 'solid', visual: {kind: 'cube'}},
  {id: 'ramp', roleId: 'ice', visual: {kind: 'slope'}},
  {id: 'player', roleId: 'player', visual: {kind: 'cube'}},
  {id: 'clone', roleId: 'clone', visual: {kind: 'cube'}},
  {id: 't4', roleId: 'solid', visual: {kind: 'model', height: 3}}
];
const directions = ['up', 'right', 'down', 'left'];
const dx = [0, 1, 0, -1], dy = [-1, 0, 1, 0];
const pxp = decodeVoxelRoom(JSON.parse(await readFile(
  new URL('./fixtures/pxp-clone-return.json', import.meta.url), 'utf8')));
const dxp = JSON.parse(await readFile(
  new URL('./fixtures/dxp-clone-ledge.json', import.meta.url), 'utf8'));

for (const binary of ['engine/v1/voxel_physics.wasm', 'world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm', 'solutions/v1/solutions-solver.wasm']) {
  test(`${binary}: PxP Down then Up returns ID 1 while the wrapping clone stays blocked`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
    for (const throughWorld of [false, true]) for (let rotation = 0; rotation < 4; rotation++) {
      for (const reversed of [false, true]) {
        const objects = pxp.objects.map(object => ({...object}));
        for (const object of objects) for (let turn = 0; turn < rotation; turn++) {
          [object.x, object.y] = [15 - object.y, object.x];
        }
        if (reversed) objects.reverse();
        const room = {width: 16, height: 16, objects, fileName: 'pxp.json', columnIndex: 15, rowIndex: 15};
        const connected = new ConnectedWorldSessionV1(engine, blocks, [room]);
        let state = engine.createState(room);
        for (let command = 0; command < 2; command++) {
          const direction = directions[(rotation + (command === 0 ? 2 : 0)) % 4];
          const result = throughWorld ? await connected.simulateCommand(state, room, direction)
            : await engine.simulateCommand(state, direction, blocks);
          const context = `${direction}, world=${throughWorld}, reversed=${reversed}`;
          const expected = objects.map(object => command === 0 &&
            (object.blockId === 'player' || object.blockId === 'clone' && object.genericId === 1)
            ? {...object, x: object.x - dx[rotation], y: object.y - dy[rotation]} : object);
          assert.equal(result.cycle, null, context);
          assert.equal(result.frames.length, 1, context);
          assert.deepEqual((result.frames[0].state ?? result.frames[0]).objects, expected, context);
          assert.deepEqual(result.final.objects, expected, context);
          state = result.final;
        }
      }
    }
  });

  test(`${binary}: a blocked wrapping actor does not cancel free actors in its failed proposal`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
    for (const playerBody of [false, true]) for (const chain of [false, true]) {
      for (const remoteRamp of [false, true]) for (const relabel of [false, true]) {
        const blockedId = relabel ? 71 : 29;
        const blockedRole = playerBody ? 'player' : 'clone';
        const objects = [
          {x: 2, y: 1, z: 0, blockId: blockedRole, genericId: blockedId, groupId: blockedId},
          {x: 2, y: 5, z: 0, blockId: blockedRole, genericId: blockedId, groupId: blockedId},
          {x: 2, y: 3, z: 0, blockId: 'clone', genericId: relabel ? 29 : 71, groupId: relabel ? 29 : 71}
        ];
        if (!playerBody) objects.push({x: 0, y: 3, z: 0, blockId: 'player'});
        if (chain) objects.push({x: 2, y: 2, z: 0, blockId: 'clone', genericId: 81, groupId: 81});
        objects.push({x: 2, y: 0, z: 0, blockId: 'wall'}, {x: 2, y: 6, z: 0, blockId: 'wall'});
        if (remoteRamp) objects.push({x: 7, y: 0, z: 0, blockId: 'ramp', orientation: 'up'});
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) objects.push({x, y, z: 0, blockId: 'floor'});
        const room = {width: 8, height: 8, objects};
        const down = await engine.simulateCommand(room, 'down', blocks);
        const expected = objects.map(object => ['player', 'clone'].includes(object.blockId) &&
          !(object.blockId === blockedRole && object.genericId === blockedId) ? {...object, y: object.y + 1} : object);
        assert.equal(down.cycle, null);
        assert.equal(down.frames.length, 1);
        assert.deepEqual(down.final.objects, expected);
        const up = await engine.simulateCommand(down.final, 'up', blocks);
        assert.equal(up.cycle, null);
        assert.equal(up.frames.length, 1);
        assert.deepEqual(up.final.objects, objects);
      }
    }
  });

  test(`${binary}: DxP Left climbs over stationary clones without shoving one off a ledge`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
    for (const throughWorld of [false, true]) for (const reversed of [false, true]) {
      const objects = structuredClone(dxp.room.objects);
      if (reversed) objects.reverse();
      const room = {...dxp.room, objects, fileName: 'dxp.json', columnIndex: 3, rowIndex: 15};
      const connected = new ConnectedWorldSessionV1(engine, dxp.blocks, [room]);
      const result = throughWorld ? await connected.simulateCommand(engine.createState(room), room, 'left')
        : await engine.simulateCommand(room, 'left', dxp.blocks);
      const context = `world=${throughWorld}, reversed=${reversed}`;
      assert.equal(result.cycle, null, context);
      assert.equal(result.frames.length, dxp.playerFrames.length, context);
      result.frames.forEach((frame, tick) => {
        const expected = objects.map(object => object.blockId === 'player'
          ? {...object, ...dxp.playerFrames[tick]} : object);
        assert.deepEqual((frame.state ?? frame).objects, expected, `${context}, tick=${tick + 1}`);
      });
      assert.deepEqual(result.final.objects, (result.frames.at(-1).state ?? result.frames.at(-1)).objects, context);
    }
  });
}
