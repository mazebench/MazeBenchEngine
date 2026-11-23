// Audit the current observation renderer, without redefining its symbols.
import { objectCatalog, makeLabRoom, makeGenericLabRoom } from './object-lab-catalog.mjs';
import { glyphCatalogForRoom, glyphForObject, renderAsciiFrameV2 as renderAsciiFrameV1 } from '../render-ascii/v2/ascii-scene.mjs';

export const bodyIdentity = object => Number.isInteger(object.groupId) ? object.groupId
  : Number.isInteger(object.genericId) ? object.genericId : 0;

export function inventoryGenericBodies(rooms, blocks) {
  const types = objectCatalog(blocks).filter(entry => entry.numbered).map(entry => {
    const usage = rooms.map(room => ({ room: room.position.join('×'),
      ids: [...new Set(room.objects.filter(object => object.blockId === entry.id).map(bodyIdentity))].sort((a, b) => a - b) }))
      .filter(room => room.ids.length);
    const ids = [...new Set(usage.flatMap(room => room.ids))].sort((a, b) => a - b);
    const highestId = ids.at(-1) ?? null;
    const mostBodies = Math.max(0, ...usage.map(room => room.ids.length));
    return { id: entry.id, name: entry.name, ids, highestId, mostBodies,
      highestIdRooms: usage.filter(room => room.ids.includes(highestId)).map(room => room.room),
      mostBodiesRooms: usage.filter(room => room.ids.length === mostBodies).map(room => room.room),
      rooms: usage.length };
  });
  return { roomCount: rooms.length, types };
}

export function genericSampleCount(entry, inventory) {
  return Math.max(20, Math.min(40, (inventory?.types.find(type => type.id === entry.id)?.highestId ?? -1) + 1));
}

export function symbolsInFrame(frame, id) {
  return [...new Set(frame.pixels.flat().filter(pixel => pixel.name === id && pixel.glyph.trim()).map(pixel => pixel.glyph))];
}

// Keeping one catalogue for all samples is important: isolated dynamic ID 6 and
// isolated ID 7 otherwise receive the same first Unicode pair by design.
export function auditSampleCatalog(blocks, inventory) {
  const objects = objectCatalog(blocks).filter(entry => entry.numbered).flatMap(entry =>
    makeGenericLabRoom(entry, { count: genericSampleCount(entry, inventory) }).objects.filter(object => object.blockId === entry.id));
  return glyphCatalogForRoom({ objects });
}

export async function auditObjectSymbols(blocks, { inventory, yieldProgress = async () => {} } = {}) {
  const entries = objectCatalog(blocks), catalog = auditSampleCatalog(blocks, inventory);
  const glyphOwners = new Map(), mismatches = new Map();
  let viewsChecked = 0;
  for (const entry of entries) {
    const count = entry.numbered ? genericSampleCount(entry, inventory) : 1;
    for (let id = 0; id < count; id++) {
      const owner = { key: `${entry.id}${entry.numbered ? `:${id}` : ''}`, id: entry.id,
        name: entry.name, bodyId: entry.numbered ? id : null, scenery: entry.group === 'Scenery' };
      for (const orientation of entry.orientations.length ? entry.orientations : [undefined]) {
        for (let state = 0; state < Math.max(1, entry.states.length); state++) {
          const room = makeLabRoom(entry, { orientation, state, bodyId: id });
          const object = room.objects.find(item => item.blockId === entry.id);
          for (let yaw = 0; yaw < 4; yaw++) for (let pitch = 0; pitch <= 4; pitch++) {
            const frame = await renderAsciiFrameV1(room, blocks, { yaw, pitch, catalog });
            const symbols = symbolsInFrame(frame, entry.id);
            viewsChecked++;
            for (const glyph of symbols) {
              if (!glyphOwners.has(glyph)) glyphOwners.set(glyph, new Map());
              glyphOwners.get(glyph).set(owner.key, owner);
            }
            const pair = glyphForObject(object, entry, yaw, catalog);
            if (pitch === 0 && symbols.length && !symbols.includes(pair.top)) {
              const key = `${entry.id}:${symbols.join('')}`;
              if (!mismatches.has(key)) mismatches.set(key, { id: entry.id, name: entry.name, actual: symbols, bodyIds: new Set() });
              mismatches.get(key).bodyIds.add(id);
            }
          }
        }
      }
    }
    await yieldProgress(entry.id);
  }
  const collisions = [...glyphOwners].filter(([, owners]) => owners.size > 1).map(([glyph, owners]) => {
    const values = [...owners.values()];
    return { glyph, codePoint: `U+${glyph.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
      kind: values.every(owner => owner.scenery) ? 'scenery' : values.some(owner => owner.scenery) ? 'mixed' : 'gameplay', owners: values };
  });
  return { objects: entries.length, viewsChecked, sampleCounts: Object.fromEntries(entries.filter(entry => entry.numbered)
    .map(entry => [entry.id, genericSampleCount(entry, inventory)])), collisions,
    topDownMismatches: [...mismatches.values()].map(item => ({ ...item, bodyIds: [...item.bodyIds] })),
    notes: [
      'Exact non-space characters are compared across all five camera pitches, four camera turns, mounts and states. Different states or directions of the same body are not counted as different objects.',
      'Scenery means the tree, shrub and bridge models; these are still solid gameplay obstacles.',
      'Dynamic symbols depend on the identities present in a room. Matching symbols in different rooms do not imply matching IDs.',
      'States of one object can share a character (for example, puncher resting/sprung); distinct object types and numbered bodies cannot. Slope directions have separate glyphs.',
      'The audit uses one combined sample catalogue. It does not prove uniqueness for every possible future room or every Unicode font.'
    ] };
}
