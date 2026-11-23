import { readFile } from 'node:fs/promises';
import { decodeVoxelRoom } from '../render/v1/voxel-world-v2.mjs';
import { auditObjectSymbols, inventoryGenericBodies } from '../ui/object-lab-audit.mjs';

const root = new URL('../level-data/v2/main-world/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('world.json', root), 'utf8'));
const rooms = await Promise.all(Object.entries(manifest.rooms).map(async ([fileName, position]) => ({
  ...decodeVoxelRoom(JSON.parse(await readFile(new URL(fileName, root), 'utf8'))), position
})));
const inventory = inventoryGenericBodies(rooms, manifest.blocks);
const audit = await auditObjectSymbols(manifest.blocks, { inventory });
console.log(JSON.stringify({ inventory, ...audit }, null, 2));
