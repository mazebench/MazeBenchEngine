export const COMPACT_BUNDLE_FORMAT = "voxelbench-compact-bundle-v1";
export const COMPACT_TEST_FORMAT = "voxelbench-compact-test-v1";
export const SPLIT_PROJECT_FORMAT = "voxelbench-split-project-v1";

const OPTIONAL_VOXEL_PROPERTIES = [
  "genericId",
  "groupId",
  "instanceId",
  "mechanismDepth",
  "orientation",
  "stateId",
  "variantId",
];

function voxelDescriptor(voxel) {
  const descriptor = { blockId: String(voxel.blockId) };
  for (const property of OPTIONAL_VOXEL_PROPERTIES) {
    if (voxel[property] !== undefined) descriptor[property] = voxel[property];
  }
  return descriptor;
}

function descriptorKey(descriptor) {
  return JSON.stringify([
    descriptor.blockId,
    ...OPTIONAL_VOXEL_PROPERTIES.map((property) =>
      Object.hasOwn(descriptor, property) ? [1, descriptor[property]] : [0]),
  ]);
}

function tupleKey(tuple) {
  return `${tuple[0]},${tuple[1]},${tuple[2]},${tuple[3]}`;
}

function encodeFrame(frame, palette, paletteIndices) {
  return frame.voxels.map((voxel) => {
    const descriptor = voxelDescriptor(voxel);
    const key = descriptorKey(descriptor);
    let paletteIndex = paletteIndices.get(key);
    if (paletteIndex === undefined) {
      paletteIndex = palette.length;
      paletteIndices.set(key, paletteIndex);
      palette.push(descriptor);
    }
    return [voxel.x, voxel.y, voxel.z, paletteIndex];
  });
}

function tupleCounts(tuples) {
  const counts = new Map();
  for (const tuple of tuples) {
    const key = tupleKey(tuple);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function frameDelta(previous, next) {
  const previousCounts = tupleCounts(previous);
  const nextCounts = tupleCounts(next);
  const removed = [];
  const added = [];
  const remainingNext = new Map(nextCounts);
  for (const tuple of previous) {
    const key = tupleKey(tuple);
    const count = remainingNext.get(key) ?? 0;
    if (count > 0) remainingNext.set(key, count - 1);
    else removed.push(tuple);
  }
  const remainingPrevious = new Map(previousCounts);
  for (const tuple of next) {
    const key = tupleKey(tuple);
    const count = remainingPrevious.get(key) ?? 0;
    if (count > 0) remainingPrevious.set(key, count - 1);
    else added.push(tuple);
  }
  return [removed, added];
}

function copyIfPresent(target, source, property) {
  if (source[property] !== undefined) target[property] = source[property];
}

function decodeTuple(tuple, palette) {
  const descriptor = palette[tuple[3]];
  if (!descriptor || typeof descriptor.blockId !== "string") {
    throw new Error(`Invalid compact voxel palette index ${tuple[3]}`);
  }
  const voxel = {
    x: tuple[0],
    y: tuple[1],
    z: tuple[2],
    blockId: descriptor.blockId,
  };
  for (const property of OPTIONAL_VOXEL_PROPERTIES) {
    copyIfPresent(voxel, descriptor, property);
  }
  return voxel;
}

function semanticVoxelKey(voxel) {
  const groupId = Number.isInteger(voxel.groupId)
    ? voxel.groupId
    : Number.isInteger(voxel.genericId)
      ? voxel.genericId
      : -1;
  return [
    `${voxel.x},${voxel.y},${voxel.z}`,
    voxel.blockId,
    groupId,
    Number.isInteger(voxel.variantId) ? voxel.variantId : 0,
    Number.isInteger(voxel.stateId) ? voxel.stateId : 0,
    Number.isInteger(voxel.mechanismDepth) ? voxel.mechanismDepth : -1,
    String(voxel.orientation ?? "none"),
    String(voxel.instanceId ?? ""),
  ].join(":");
}

function sortVoxels(voxels) {
  return [...voxels].sort((left, right) =>
    semanticVoxelKey(left).localeCompare(semanticVoxelKey(right)));
}

function applyDelta(previous, removed, added, palette) {
  const removeCounts = tupleCounts(removed);
  const retained = [];
  for (const tuple of previous) {
    const key = tupleKey(tuple);
    const count = removeCounts.get(key) ?? 0;
    if (count > 0) removeCounts.set(key, count - 1);
    else retained.push(tuple);
  }
  for (const count of removeCounts.values()) {
    if (count !== 0) throw new Error("Compact frame removes a voxel that is not present");
  }
  return [...retained, ...added].sort((left, right) => {
    const leftVoxel = decodeTuple(left, palette);
    const rightVoxel = decodeTuple(right, palette);
    return semanticVoxelKey(leftVoxel).localeCompare(semanticVoxelKey(rightVoxel));
  });
}

export function encodeCompactTest(test) {
  const palette = [];
  const paletteIndices = new Map();
  const sourceFrames = [test.start, ...(test.intermediate ?? []), test.expected];
  const tupleFrames = sourceFrames.map((frame) =>
    encodeFrame(frame, palette, paletteIndices));
  const frames = [["f", tupleFrames[0]]];
  for (let index = 1; index < tupleFrames.length; ++index) {
    const [removed, added] = frameDelta(tupleFrames[index - 1], tupleFrames[index]);
    frames.push(removed.length + added.length < tupleFrames[index].length
      ? ["d", removed, added]
      : ["f", tupleFrames[index]]);
  }

  const compact = {
    storageFormat: COMPACT_TEST_FORMAT,
    id: test.id,
    name: test.name,
    description: test.description ?? "",
    groupTagId: test.folderId,
    tagIds: Array.isArray(test.tagIds) && test.tagIds.length
      ? [...test.tagIds]
      : [test.folderId],
    locked: Boolean(test.locked),
    input: test.input,
    world: [test.world.width, test.world.height],
    palette,
    frames,
  };
  if (test.hidden) compact.hidden = true;
  if (test.cycle) compact.cycle = { ...test.cycle };
  return compact;
}

export function decodeCompactTest(compact) {
  if (!compact || compact.storageFormat !== COMPACT_TEST_FORMAT ||
      !Array.isArray(compact.palette) || !Array.isArray(compact.frames) ||
      compact.frames.length < 2) {
    throw new Error("Invalid compact VoxelBench test");
  }
  const tupleFrames = [];
  for (const encoded of compact.frames) {
    if (!Array.isArray(encoded)) throw new Error("Invalid compact frame");
    if (encoded[0] === "f" && Array.isArray(encoded[1])) {
      tupleFrames.push(encoded[1]);
      continue;
    }
    if (encoded[0] === "d" && tupleFrames.length &&
        Array.isArray(encoded[1]) && Array.isArray(encoded[2])) {
      tupleFrames.push(applyDelta(
        tupleFrames.at(-1), encoded[1], encoded[2], compact.palette));
      continue;
    }
    throw new Error("Invalid compact frame encoding");
  }
  const decodedFrames = tupleFrames.map((tuples) => ({
    voxels: sortVoxels(tuples.map((tuple) => decodeTuple(tuple, compact.palette))),
  }));
  const test = {
    description: compact.description ?? "",
    folderId: compact.groupTagId ?? compact.primaryTagId ?? compact.folderId,
    tagIds: Array.isArray(compact.tagIds) ? [...compact.tagIds] : undefined,
    id: compact.id,
    hidden: Boolean(compact.hidden),
    locked: Boolean(compact.locked),
    name: compact.name,
    input: compact.input,
    intermediate: decodedFrames.slice(1, -1),
    start: decodedFrames[0],
    expected: decodedFrames.at(-1),
    world: {
      width: compact.world[0],
      height: compact.world[1],
      floorLayer: 0,
    },
  };
  if (compact.cycle) test.cycle = { ...compact.cycle };
  return test;
}

export function encodeProjectBundle(project) {
  const tags = project.tags ?? project.folders ?? [];
  return {
    schemaVersion: Math.max(15, Number(project.schemaVersion) || 0),
    storageFormat: COMPACT_BUNDLE_FORMAT,
    coordinateSystem: project.coordinateSystem,
    roles: project.roles,
    blocks: project.blocks,
    tags,
    searches: project.searches ?? [],
    tests: project.tests.map(encodeCompactTest),
  };
}

export function decodeProjectPayload(project) {
  if (!project || project.storageFormat !== COMPACT_BUNDLE_FORMAT) return project;
  const tags = project.tags ?? project.folders ?? [];
  return {
    schemaVersion: project.schemaVersion,
    coordinateSystem: project.coordinateSystem,
    roles: project.roles,
    blocks: project.blocks,
    tags,
    // Compatibility alias for older callers while the persisted vocabulary is tags.
    folders: tags,
    searches: project.searches ?? [],
    tests: project.tests.map(decodeCompactTest),
  };
}
