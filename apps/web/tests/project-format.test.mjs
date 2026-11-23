import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACT_BUNDLE_FORMAT,
  decodeProjectPayload,
  encodeProjectBundle,
} from "../app/projectFormat.mjs";

function canonicalVoxel(voxel) {
  return JSON.stringify([
    voxel.x, voxel.y, voxel.z, voxel.blockId,
    Object.hasOwn(voxel, "genericId") ? [1, voxel.genericId] : [0],
    Object.hasOwn(voxel, "groupId") ? [1, voxel.groupId] : [0],
    Object.hasOwn(voxel, "instanceId") ? [1, voxel.instanceId] : [0],
    Object.hasOwn(voxel, "mechanismDepth") ? [1, voxel.mechanismDepth] : [0],
    Object.hasOwn(voxel, "orientation") ? [1, voxel.orientation] : [0],
    Object.hasOwn(voxel, "stateId") ? [1, voxel.stateId] : [0],
    Object.hasOwn(voxel, "variantId") ? [1, voxel.variantId] : [0],
  ]);
}

function canonicalFrame(frame) {
  return frame.voxels.map(canonicalVoxel).sort();
}

function canonicalTest(value) {
  return {
    ...value,
    start: canonicalFrame(value.start),
    intermediate: value.intermediate.map(canonicalFrame),
    expected: canonicalFrame(value.expected),
  };
}

const overlapping = [
  { x: 3, y: 4, z: 1, blockId: "player" },
  { x: 3, y: 4, z: 1, blockId: "gem", stateId: 0 },
  { x: 3, y: 5, z: 4, blockId: "orange-wall", stateId: 0, mechanismDepth: 4 },
  { x: 4, y: 4, z: 1, blockId: "generic", genericId: 7, groupId: 7 },
  { x: 4, y: 4, z: 1, blockId: "generic", genericId: 7, groupId: 7 },
  {
    x: 5,
    y: 4,
    z: -2,
    blockId: "slope",
    instanceId: "slope-a",
    orientation: "left",
    stateId: null,
    variantId: 3,
  },
];

const project = {
  schemaVersion: 11,
  coordinateSystem: { floorLayer: 0 },
  roles: [{ id: "solid", name: "Solid" }],
  blocks: [{ id: "player", name: "Player", roleId: "solid" }],
  folders: [
    { id: "folder-a", name: "Folder A" },
    { id: "folder-b", name: "Nested Folder", parentId: "folder-a" },
  ],
  searches: [{ id: "search-a", name: "Search A" }],
  tests: [{
    id: "test / unusual id",
    name: "Overlap and phases",
    description: "Preserves overlaps, duplicates, negative rows, and optional fields.",
    folderId: "folder-a",
    tagIds: ["folder-b"],
    hidden: true,
    locked: true,
    input: "up",
    world: { width: 16, height: 12, floorLayer: 0 },
    start: { voxels: overlapping },
    intermediate: [
      { voxels: overlapping.map((voxel) => ({ ...voxel })) },
      { voxels: overlapping.slice(0, -1) },
    ],
    expected: {
      voxels: [
        ...overlapping.slice(0, -2),
        { x: 5, y: 5, z: -3, blockId: "slope", orientation: "down", variantId: 2 },
      ],
    },
    cycle: { startTick: 1, repeatTick: 3 },
  }],
};

test("compact project format losslessly round-trips frame content", () => {
  const compact = encodeProjectBundle(project);
  assert.equal(compact.storageFormat, COMPACT_BUNDLE_FORMAT);
  assert.equal(compact.tests[0].groupTagId, "folder-a");
  assert.equal(Object.hasOwn(compact.tests[0], "folderId"), false);
  assert.equal(Object.hasOwn(compact.tests[0], "primaryTagId"), false);
  const restored = decodeProjectPayload(JSON.parse(JSON.stringify(compact)));

  assert.equal(restored.schemaVersion, 15);
  assert.deepEqual(restored.coordinateSystem, project.coordinateSystem);
  assert.deepEqual(restored.roles, project.roles);
  assert.deepEqual(restored.blocks, project.blocks);
  assert.deepEqual(restored.folders, project.folders);
  assert.deepEqual(restored.tags, project.folders);
  assert.deepEqual(restored.searches, project.searches);
  assert.deepEqual(canonicalTest(restored.tests[0]), canonicalTest(project.tests[0]));
});

test("compact project format is materially smaller for repeated frames", () => {
  const repeated = {
    ...project,
    tests: Array.from({ length: 20 }, (_, index) => ({
      ...project.tests[0],
      id: `test-${index}`,
      intermediate: Array.from({ length: 10 }, () => ({
        voxels: overlapping.map((voxel) => ({ ...voxel })),
      })),
    })),
  };
  const legacyBytes = Buffer.byteLength(JSON.stringify(repeated));
  const compactBytes = Buffer.byteLength(JSON.stringify(encodeProjectBundle(repeated)));
  assert.ok(compactBytes < legacyBytes / 2, `${compactBytes} should be < ${legacyBytes / 2}`);
});
