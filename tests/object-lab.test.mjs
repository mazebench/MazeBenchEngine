import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { objectCatalog, makeLabRoom, makeGenericLabRoom } from '../ui/object-lab-catalog.mjs';
import { auditObjectSymbols, inventoryGenericBodies } from '../ui/object-lab-audit.mjs';
import { instantiateMazeBenchEngineV1 } from '../engine/v1/engine.mjs';
import { renderAsciiFrameV2 as renderAsciiFrameV1 } from '../render-ascii/v2/ascii-scene.mjs';

const { blocks } = JSON.parse(await readFile(new URL('../level-data/v2/main-world/world.json', import.meta.url), 'utf8'));
const entries = objectCatalog(blocks);
const engine = await instantiateMazeBenchEngineV1(await readFile(new URL('../engine/v1/voxel_physics.wasm', import.meta.url)));
const named = (room, id) => room.objects.find(object => object.blockId === id);
const approach = room => {
  const player = named(room, 'player');
  return player.x < 3 ? 'right' : player.x > 3 ? 'left' : player.y > 3 ? 'up' : 'down';
};
const symbols = (frame, id) => [...new Set(frame.pixels.flat().filter(pixel => pixel.name === id).map(pixel => pixel.glyph))];

test('every authored object and lab rotation/state can render through the benchmark text renderer', async () => {
  assert.equal(entries.length, blocks.length - 1);
  assert.ok(!entries.some(entry => entry.id === 'exit'));
  for (const entry of entries) for (const orientation of entry.orientations.length ? entry.orientations : [undefined]) {
    for (let state = 0; state < Math.max(1, entry.states.length); state++) {
      const room = makeLabRoom(entry, { orientation, state });
      for (const yaw of [0, 1, 2, 3]) for (const pitch of [0, 2, 4]) {
        const frame = await renderAsciiFrameV1(room, blocks, { yaw, pitch });
        assert.ok(frame.width > 0, `${entry.id}, ${orientation}, state ${state}, yaw ${yaw}, pitch ${pitch}`);
        assert.ok(frame.pixels.flat().every(pixel => typeof pixel.glyph === 'string'));
      }
    }
  }
});

test('all six playable button mounts lower and release the orange wall', async () => {
  const entry = entries.find(item => item.id === 'orange-button');
  const reverse = { up: 'down', down: 'up', left: 'right', right: 'left' };
  for (const orientation of entry.orientations) {
    const room = makeLabRoom(entry, { orientation, play: true });
    const direction = approach(room);
    const pressed = await engine.simulateCommand(room, direction, blocks);
    assert.equal(named(pressed.final, 'orange-wall').mechanismDepth, 1, orientation);
    const observation = await renderAsciiFrameV1(engine.roomFromState(pressed.final, room), blocks, { pitch: 0 });
    assert.deepEqual(symbols(observation, 'orange-wall'), [], orientation);
    const released = await engine.simulateCommand(pressed.final, reverse[direction], blocks);
    assert.equal(named(released.final, 'orange-wall').mechanismDepth, 0, orientation);
    assert.equal(named(released.final, 'orange-wall').z, 0, orientation);
  }
});

test('each playable lift mount actuates and each puncher direction launches its rider', async () => {
  for (const id of ['lift', 'puncher']) {
    const entry = entries.find(item => item.id === id);
    for (const orientation of entry.orientations) {
      const room = makeLabRoom(entry, { orientation, play: true });
      const result = await engine.simulateCommand(room, approach(room), blocks);
      assert.ok(result.frames.some(frame => named(frame, id).stateId === 1), `${id} ${orientation}`);
      const player = named(result.final, 'player');
      assert.ok(player.x !== 3 || player.y !== 3 || player.z === 1, `${id} ${orientation}`);
    }
  }
});

test('body identity and slope direction use the real Unicode catalogue', async () => {
  for (const id of ['clone-slope', 'weightless-slope']) {
    const entry = entries.find(item => item.id === id);
    const variants = [];
    for (const orientation of entry.orientations) {
      const frame = await renderAsciiFrameV1(makeLabRoom(entry, { orientation, bodyId: 17 }), blocks, { pitch: 2 });
      variants.push(symbols(frame, id).join(''));
    }
    assert.equal(new Set(variants).size, 4, id);
  }
});

test('raised lifts have a usable approach and lower in all five mounting directions', async () => {
  const entry = entries.find(item => item.id === 'lift');
  for (const orientation of entry.orientations) {
    const room = makeLabRoom(entry, { orientation, state: 1, play: true });
    const result = await engine.simulateCommand(room, approach(room), blocks);
    assert.equal(named(result.final, 'lift').stateId, 0, orientation);
    const player = named(result.final, 'player');
    assert.deepEqual([player.x, player.y, player.z], [3, 3, 0], orientation);
  }
});

test('numbered lab rooms retain 20 separate body IDs through engine readback', () => {
  for (const entry of entries.filter(item => item.numbered)) {
    const room = makeGenericLabRoom(entry);
    const restored = engine.roomFromState(engine.createState(room), room);
    const bodies = restored.objects.filter(object => object.blockId === entry.id);
    assert.equal(bodies.length, 20, entry.id);
    assert.deepEqual(bodies.map(object => object.groupId).sort((a, b) => a - b), Array.from({ length: 20 }, (_, id) => id));
    assert.equal(new Set(bodies.map(object => `${object.x},${object.y},${object.z}`)).size, 20);
  }
});

test('world inventory counts bodies rather than voxels and distinguishes highest ID from count', () => {
  const inventory = inventoryGenericBodies([
    { position: ['A', 'B'], objects: [
      { blockId: 'weightless-box', genericId: 0 },
      { blockId: 'weightless-box', genericId: 0 },
      { blockId: 'weightless-box', genericId: 25 },
      { blockId: 'clone', genericId: 9, groupId: 2 }
    ] },
    { position: ['C', 'D'], objects: [0, 1, 2].map(genericId => ({ blockId: 'weightless-box', genericId })) }
  ], blocks);
  const boxes = inventory.types.find(type => type.id === 'weightless-box');
  assert.equal(boxes.highestId, 25);
  assert.deepEqual(boxes.highestIdRooms, ['A×B']);
  assert.equal(boxes.mostBodies, 3);
  assert.deepEqual(boxes.mostBodiesRooms, ['C×D']);
  assert.equal(inventory.types.find(type => type.id === 'clone').highestId, 2);
  assert.equal(inventory.types.find(type => type.id === 'clone-slope').highestId, null);
});

test('canonical symbol review has no collisions or incorrect top faces', async () => {
  const audit = await auditObjectSymbols(blocks);
  assert.equal(audit.objects, entries.length);
  assert.ok(audit.viewsChecked > 5000);
  assert.deepEqual(audit.collisions, []);
  assert.deepEqual(audit.topDownMismatches, []);
});
