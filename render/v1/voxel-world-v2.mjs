// Palette-compressed explicit 3D object storage, adapted from
// MazeBenchEngineUnitTest's voxelbench-compact-test-v1 project format.

export const V2_WORLD_FORMAT = "mazebench-voxel-world-v2";
export const V2_ROOM_FORMAT = "mazebench-voxel-room-v2";
export const V2_SCHEMA_VERSION = 2;

export const V2_COORDINATE_SYSTEM = Object.freeze({
  horizontalAxes: ["x", "y"],
  verticalAxis: "z",
  floorLayer: 0,
  floorIsSurface: true
});

const MODEL = (fileName, modelType, height = 1) => ({
  kind: "model",
  height,
  modelType,
  modelUrl: `../../../render/v1/assets_3d/${fileName}`
});

export const V2_BLOCK_CATALOG = Object.freeze([
  { id: "floor", name: "Floor", color: "#d6bd94", roleId: "floor", occupancy: "solid", category: "terrain", visual: { kind: "floor" } },
  { id: "ice-floor", name: "Ice", color: "#a9d6f4", roleId: "ice", occupancy: "solid", category: "terrain", visual: { kind: "floor" } },
  { id: "exit", name: "Exit", color: "#d6bd94", roleId: "exit", occupancy: "sensor", category: "terrain", visual: { kind: "exit" } },
  { id: "wall", name: "Wall", color: "#23262c", roleId: "solid", occupancy: "solid", category: "terrain", visual: { kind: "cube" } },
  { id: "ice-block", name: "Ice Block", color: "#a9d6f4", roleId: "ice", occupancy: "solid", category: "terrain", visual: { kind: "cube" } },
  { id: "ice-slope", name: "Ice Slope", color: "#a9d6f4", roleId: "ice", occupancy: "solid", category: "terrain", visual: { kind: "slope" } },
  { id: "wall-slope", name: "Black Ice Slope", color: "#23262c", roleId: "ice", occupancy: "solid", category: "terrain", visual: { kind: "slope" } },
  { id: "orange-slope", name: "Orange Ice Slope", color: "#b85f16", roleId: "orange-wall", occupancy: "solid", category: "terrain", visual: { kind: "slope" } },
  { id: "player", name: "Player", color: "#5aa95c", roleId: "player", occupancy: "solid", category: "actor", visual: { kind: "cube" } },
  { id: "clone", name: "Clone", color: "#b59a2a", roleId: "clone", occupancy: "solid", category: "actor", visual: { kind: "cube" } },
  { id: "gem", name: "Gem", color: "#6cd7ff", roleId: "goal", occupancy: "sensor", category: "actor", visual: MODEL("gem.glb", "gem") },
  { id: "gate", name: "Player Gate", color: "#c75652", roleId: "player-gate", occupancy: "sensor", category: "terrain", visual: { kind: "gate" } },
  { id: "lift", name: "Player Lift", color: "#8a63d2", roleId: "player-lift", occupancy: "sensor", category: "terrain", visual: { kind: "lift" } },
  { id: "orange-wall", name: "Orange Wall", color: "#b85f16", roleId: "orange-wall", occupancy: "sensor", category: "terrain", visual: { kind: "cube" } },
  { id: "orange-button", name: "Orange Button", color: "#f59e0b", roleId: "orange-button", occupancy: "sensor", category: "actor", visual: { kind: "button" } },
  { id: "puncher", name: "Puncher", color: "#ef4444", roleId: "puncher", occupancy: "sensor", category: "actor", visual: { kind: "puncher" } },
  { id: "crate", name: "Box", color: "#2a2d33", roleId: "pushable", occupancy: "solid", category: "actor", visual: { kind: "cube" } },
  { id: "floating-floor", name: "Floating Floor", color: "#d6bd94", roleId: "floating-floor", occupancy: "solid", category: "actor", visual: { kind: "platform" } },
  { id: "weightless-box", name: "Weightless Box", color: "#315991", roleId: "weightless-pushable", occupancy: "solid", category: "actor", visual: { kind: "cube" } },
  { id: "weightless-slope", name: "Box Ice Slope", color: "#315991", roleId: "weightless-pushable", occupancy: "solid", category: "actor", visual: { kind: "slope" } },
  { id: "clone-slope", name: "Clone Ice Slope", color: "#b59a2a", roleId: "clone", occupancy: "solid", category: "actor", visual: { kind: "slope" } },
  { id: "t1", name: "Tree 1", color: "#2f7d3f", roleId: "solid", occupancy: "solid", category: "terrain", visual: MODEL("t1.glb", "tree", 3) },
  { id: "t2", name: "Tree 2", color: "#2f7d3f", roleId: "solid", occupancy: "solid", category: "terrain", visual: MODEL("t2.glb", "tree", 3) },
  { id: "t3", name: "Tree 3", color: "#2f7d3f", roleId: "solid", occupancy: "solid", category: "terrain", visual: MODEL("t3.glb", "tree", 3) },
  { id: "t4", name: "Tree 4", color: "#2f7d3f", roleId: "solid", occupancy: "solid", category: "terrain", visual: MODEL("t4.glb", "tree", 3) },
  { id: "st1", name: "Small Tree 1", color: "#2f7d3f", roleId: "solid", occupancy: "solid", category: "terrain", visual: MODEL("st1.glb", "tree", 3) },
  { id: "st3", name: "Small Tree 3", color: "#2f7d3f", roleId: "solid", occupancy: "solid", category: "terrain", visual: MODEL("st3.glb", "tree", 3) },
  { id: "st4", name: "Small Tree 4", color: "#2f7d3f", roleId: "solid", occupancy: "solid", category: "terrain", visual: MODEL("st4.glb", "tree", 3) },
  { id: "sh", name: "Shrub", color: "#476b35", roleId: "solid", occupancy: "solid", category: "terrain", visual: MODEL("sh.glb", "shrub") },
  { id: "b1", name: "Bridge 1", color: "#5b2f14", roleId: "solid", occupancy: "solid", category: "terrain", visual: MODEL("b1.glb", "block_asset") },
  { id: "b2", name: "Bridge 2", color: "#5b2f14", roleId: "solid", occupancy: "solid", category: "terrain", visual: MODEL("b2.glb", "block_asset") },
  { id: "b3", name: "Bridge 3", color: "#5b2f14", roleId: "solid", occupancy: "solid", category: "terrain", visual: MODEL("b3.glb", "block_asset") },
  { id: "b4", name: "Bridge 4", color: "#5b2f14", roleId: "solid", occupancy: "solid", category: "terrain", visual: MODEL("b4.glb", "block_asset") }
]);

const OPTIONAL_OBJECT_PROPERTIES = [
  "genericId",
  "groupId",
  "instanceId",
  "mechanismDepth",
  "orientation",
  "stateId",
  "variantId"
];

function objectDescriptor(object) {
  const descriptor = { blockId: String(object.blockId) };
  OPTIONAL_OBJECT_PROPERTIES.forEach((property) => {
    if (object[property] !== undefined) descriptor[property] = object[property];
  });
  return descriptor;
}

function descriptorKey(descriptor) {
  return JSON.stringify([
    descriptor.blockId,
    ...OPTIONAL_OBJECT_PROPERTIES.map((property) =>
      Object.hasOwn(descriptor, property) ? [1, descriptor[property]] : [0])
  ]);
}

function objectSortKey(object) {
  return [
    object.y,
    object.x,
    object.z,
    object.blockId,
    object.groupId ?? object.genericId ?? -1,
    object.orientation ?? "none",
    object.stateId ?? 0,
    object.variantId ?? 0,
    object.mechanismDepth ?? -1,
    object.instanceId ?? ""
  ].join(":");
}

export function sortVoxelObjects(objects) {
  return [...objects].sort((left, right) => objectSortKey(left).localeCompare(objectSortKey(right)));
}

export function encodeVoxelRoom(room) {
  const width = Number(room.width || room.world?.[0]);
  const height = Number(room.height || room.world?.[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Voxel rooms need positive integer dimensions.");
  }
  const palette = [];
  const paletteIndices = new Map();
  const voxels = sortVoxelObjects(room.objects || []).map((object) => {
    if (![object.x, object.y, object.z].every(Number.isInteger)) {
      throw new Error("Voxel coordinates must be integers.");
    }
    if (object.x < 0 || object.y < 0 || object.x >= width || object.y >= height) {
      throw new Error(`Voxel coordinate ${object.x},${object.y},${object.z} is outside the room.`);
    }
    const descriptor = objectDescriptor(object);
    const key = descriptorKey(descriptor);
    let paletteIndex = paletteIndices.get(key);
    if (paletteIndex === undefined) {
      paletteIndex = palette.length;
      paletteIndices.set(key, paletteIndex);
      palette.push(descriptor);
    }
    return [object.x, object.y, object.z, paletteIndex];
  });
  return {
    storageFormat: V2_ROOM_FORMAT,
    world: [width, height],
    palette,
    voxels
  };
}

export function decodeVoxelRoom(payload) {
  if (!payload || payload.storageFormat !== V2_ROOM_FORMAT ||
      !Array.isArray(payload.world) || payload.world.length !== 2 ||
      !Array.isArray(payload.palette) || !Array.isArray(payload.voxels)) {
    throw new Error("Invalid MazeBench voxel room v2.");
  }
  const width = Number(payload.world[0]);
  const height = Number(payload.world[1]);
  const objects = payload.voxels.map((tuple) => {
    if (!Array.isArray(tuple) || tuple.length !== 4 ||
        ![tuple[0], tuple[1], tuple[2], tuple[3]].every(Number.isInteger)) {
      throw new Error("Invalid voxel tuple.");
    }
    const descriptor = payload.palette[tuple[3]];
    if (!descriptor || typeof descriptor.blockId !== "string") {
      throw new Error(`Invalid voxel palette index ${tuple[3]}.`);
    }
    const object = { x: tuple[0], y: tuple[1], z: tuple[2], blockId: descriptor.blockId };
    OPTIONAL_OBJECT_PROPERTIES.forEach((property) => {
      if (descriptor[property] !== undefined) object[property] = descriptor[property];
    });
    return object;
  });
  encodeVoxelRoom({ width, height, objects });
  return { width, height, objects: sortVoxelObjects(objects) };
}

async function loadInBatches(entries, load, onProgress) {
  let next = 0;
  let complete = 0;
  const results = new Array(entries.length);
  async function worker() {
    while (next < entries.length) {
      const index = next++;
      results[index] = await load(entries[index]);
      complete += 1;
      onProgress?.(complete, entries.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(16, entries.length) }, worker));
  return results;
}

export async function loadMainWorldV2(onProgress) {
  const manifestUrl = new URL("../../level-data/v2/main-world/world.json", import.meta.url);
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error("Could not load the v2 main-world manifest.");
  const manifest = await response.json();
  if (manifest.storageFormat !== V2_WORLD_FORMAT || !manifest.rooms) {
    throw new Error("Invalid MazeBench voxel world v2 manifest.");
  }
  const entries = Object.entries(manifest.rooms);
  const columns = [...new Set(entries.map(([, position]) => position[0]))].sort();
  const rows = [...new Set(entries.map(([, position]) => position[1]))].sort();
  const columnIndexes = new Map(columns.map((value, index) => [value, index]));
  const rowIndexes = new Map(rows.map((value, index) => [value, index]));
  const blocks = (manifest.blocks || []).map((block) => ({
    ...block,
    visual: {
      ...block.visual,
      ...(block.visual?.modelUrl
        ? { modelUrl: new URL(block.visual.modelUrl, manifestUrl).href }
        : {})
    }
  }));
  const rooms = await loadInBatches(entries, async ([fileName, position]) => {
    const roomResponse = await fetch(new URL(fileName, manifestUrl));
    if (!roomResponse.ok) throw new Error(`Could not load v2 room ${fileName}.`);
    const room = decodeVoxelRoom(await roomResponse.json());
    return {
      ...room,
      fileName,
      legacyFileName: `${fileName.replace(/\.json$/i, "")}.txt`,
      position,
      columnIndex: columnIndexes.get(position[0]),
      rowIndex: rowIndexes.get(position[1])
    };
  }, onProgress);
  if (!rooms.length) throw new Error("The v2 main world is empty.");
  const roomWidth = rooms[0].width;
  const roomHeight = rooms[0].height;
  if (rooms.some((room) => room.width !== roomWidth || room.height !== roomHeight)) {
    throw new Error("V2 main-world rooms have inconsistent dimensions.");
  }
  return {
    storageFormat: V2_WORLD_FORMAT,
    schemaVersion: manifest.schemaVersion,
    coordinateSystem: manifest.coordinateSystem,
    columns,
    rows,
    roomWidth,
    roomHeight,
    rooms,
    blocks,
    blockDefinitions: new Map(blocks.map((block) => [block.id, block]))
  };
}
