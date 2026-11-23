// Deterministic one-way migration. V1 text files stay untouched as the
// compatibility archive; v2 rooms become palette-compressed 3D objects.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { legacyCellsToVoxelObjects } from "../render/v1/v1-to-v2.mjs";
import { parseLevelText } from "../render/v1/world-renderer.mjs";
import {
  encodeVoxelRoom,
  V2_BLOCK_CATALOG,
  V2_COORDINATE_SYSTEM,
  V2_SCHEMA_VERSION,
  V2_WORLD_FORMAT
} from "../render/v1/voxel-world-v2.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v1Root = path.join(repositoryRoot, "level-data", "v1", "main-world");
const v2Root = path.join(repositoryRoot, "level-data", "v2", "main-world");
const v1Manifest = JSON.parse(await readFile(path.join(v1Root, "world_map.json"), "utf8"));
const rooms = {};

await mkdir(v2Root, { recursive: true });
for (const [v1FileName, position] of Object.entries(v1Manifest.levels || {})) {
  const source = await readFile(path.join(v1Root, v1FileName), "utf8");
  const cells = parseLevelText(source);
  if (cells.length !== 16 || cells.some((row) => row.length !== 16)) {
    throw new Error(`${v1FileName} is not a 16 by 16 room.`);
  }
  const v2FileName = v1FileName.replace(/\.txt$/i, ".json");
  const payload = encodeVoxelRoom({
    width: 16,
    height: 16,
    objects: legacyCellsToVoxelObjects(cells)
  });
  await writeFile(path.join(v2Root, v2FileName), `${JSON.stringify(payload)}\n`, "utf8");
  rooms[v2FileName] = position;
}

const manifest = {
  storageFormat: V2_WORLD_FORMAT,
  schemaVersion: V2_SCHEMA_VERSION,
  coordinateSystem: V2_COORDINATE_SYSTEM,
  blocks: V2_BLOCK_CATALOG,
  rooms
};
await writeFile(path.join(v2Root, "world.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Migrated ${Object.keys(rooms).length} v1 rooms into ${v2Root}.`);
