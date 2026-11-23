import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { decodeVoxelRoom } from '../render/v1/voxel-world-v2.mjs';
import { glyphCatalogForRoom, glyphForObject, renderAsciiFrameV2 } from '../render-ascii/v2/ascii-scene.mjs';
import { renderAsciiFrameV1 } from '../render-ascii/v1/ascii-scene.mjs';
import { TERRAIN_GLYPHS, createDynamicGlyphCatalog } from '../render-ascii/v2/glyph-contract.mjs';

const root = new URL('../level-data/v2/main-world/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('world.json', root), 'utf8'));
const blocks = new Map(manifest.blocks.map(block => [block.id, block]));

test('every authored room has disjoint symbols across types and numbered bodies at every yaw', async () => {
  for (const [file, position] of Object.entries(manifest.rooms)) {
    const room = decodeVoxelRoom(JSON.parse(await readFile(new URL(file, root), 'utf8'))), catalog = glyphCatalogForRoom(room);
    for (let yaw = 0; yaw < 4; yaw++) {
      const owners = new Map();
      for (const object of room.objects) {
        const block = blocks.get(object.blockId), numbered = ['clone', 'weightless-pushable'].includes(block.roleId);
        const identity = `${object.blockId}:${numbered ? object.groupId ?? object.genericId ?? 0 : ''}`;
        for (const glyph of Object.values(glyphForObject(object, block, yaw, catalog))) {
          if (!glyph.trim()) continue;
          if (owners.has(glyph)) assert.equal(owners.get(glyph), identity, `${position.join('×')}: ${glyph} shared by ${identity} and ${owners.get(glyph)}`);
          owners.set(glyph, identity);
        }
      }
    }
  }
});

test('26 box top faces match their allocated glyphs and old observations stay unchanged', async () => {
  const room = { width: 26, height: 1, objects: Array.from({ length: 26 }, (_, id) => ({ blockId: 'weightless-box', x: id, y: 0, z: 0, genericId: id })) };
  const frame = await renderAsciiFrameV2(room, manifest.blocks, { pitch: 0 });
  assert.equal(new Set(frame.pixels.flat().map(pixel => pixel.glyph)).size, 26);
  assert.equal(frame.pixels[0][5 * 4].glyph, 'Ν');
  assert.equal((await renderAsciiFrameV1(room, manifest.blocks, { pitch: 0 })).pixels[0][5 * 4].glyph, ';');
  assert.equal(TERRAIN_GLYPHS.exit.top, 'E');
  assert.equal(TERRAIN_GLYPHS.exit.side, 'e');
});

test('missing or exhausted allocations fail instead of reusing a fallback glyph', () => {
  assert.throws(() => glyphForObject({ blockId: 'clone-slope', genericId: 10 }, blocks.get('clone-slope')), /Missing unique ASCII/);
  assert.throws(() => createDynamicGlyphCatalog({ cloneIdentities: Array.from({ length: 1000 }, (_, id) => `id${id}`) }), /exceeding/);
});
