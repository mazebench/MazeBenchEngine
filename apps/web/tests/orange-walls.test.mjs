import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeOrangeWallFrame,
  orangeWallDepthFromMechanismValue,
  orangeWallDepthForState,
  orangeWallEngineAnchorZ,
  orangeWallFrameFromEngine,
  orangeWallIsDedicatedFace,
  orangeWallIsHiddenVolume,
  orangeWallMechanismValue,
  orangeWallPhysicalState,
  orangeWallVisualFrame,
} from "../app/orangeWalls.mjs";

const definitions = new Map([
  ["floor", { id: "floor", occupancy: "solid", visual: { kind: "cube" } }],
  ["orange-wall", {
    id: "orange-wall",
    occupancy: "inactive",
    roleId: "orange-wall",
    visual: { kind: "orange-wall", orangeForm: "visible" },
  }],
  ["orange-wall-hidden", {
    id: "orange-wall-hidden",
    occupancy: "inactive",
    roleId: "orange-wall",
    visual: { kind: "orange-wall", orangeForm: "hidden" },
  }],
  ["orange-wall-slope", {
    id: "orange-wall-slope",
    occupancy: "inactive",
    roleId: "orange-wall",
    visual: { kind: "slope", orangeForm: "visible" },
  }],
  ["orange-wall-slope-hidden", {
    id: "orange-wall-slope-hidden",
    occupancy: "inactive",
    roleId: "orange-wall",
    visual: { kind: "slope", orangeForm: "hidden" },
  }],
]);

test("all Orange Walls use the same nonnegative mechanism depth", () => {
  const wall = {
    x: 1, y: 1, z: 1, blockId: "orange-wall", stateId: 0, mechanismDepth: 7,
  };
  assert.equal(orangeWallMechanismValue(wall, definitions), 7);
  assert.equal(orangeWallDepthFromMechanismValue(-9), 7);
  assert.equal(orangeWallPhysicalState(wall, [wall], definitions).stateId, 1);
});

test("invisible wall state preserves hidden volumes and ABI anchors", () => {
  const floor = { x: 2, y: 3, z: 0, blockId: "floor" };
  const cube = { x: 2, y: 3, z: 4, blockId: "orange-wall", mechanismDepth: 2, stateId: 1 };
  const surface = { ...cube, z: 1, mechanismDepth: 4, stateId: 0 };
  const buried = { ...cube, z: -1, mechanismDepth: 5, stateId: 2 };

  assert.equal(orangeWallIsDedicatedFace(cube, definitions), false);
  assert.equal(orangeWallIsDedicatedFace(surface, definitions), true);
  assert.equal(orangeWallIsHiddenVolume(buried, definitions), true);
  assert.equal(orangeWallEngineAnchorZ(surface, definitions), 4);
  assert.equal(orangeWallEngineAnchorZ(buried, definitions), 4);
  assert.equal(surface.blockId, cube.blockId);
  assert.equal(buried.blockId, cube.blockId);
  assert.deepEqual(orangeWallPhysicalState(cube, [floor, cube], definitions), {
    mechanismDepth: 2,
    physicalZ: 2,
    stateId: 1,
    supportZ: 0,
  });
});

test("legacy depth-in-state frames migrate without moving their authored cells", () => {
  const floor = { x: 1, y: 1, z: 0, blockId: "floor" };
  const legacy = { x: 1, y: 1, z: 3, blockId: "orange-wall", stateId: 3 };
  const normalized = normalizeOrangeWallFrame({ voxels: [floor, legacy] }, definitions);
  assert.deepEqual(normalized.voxels[1], {
    ...legacy,
    mechanismDepth: 3,
    stateId: 1,
  });
});

test("surface-depth helper remains available for old imported frames", () => {
  const floor = { x: 5, y: 4, z: 0, blockId: "floor" };
  const wall = { x: 5, y: 4, z: 5, blockId: "orange-wall" };
  assert.equal(orangeWallDepthForState(wall, [floor], definitions, 0), 5);
  assert.equal(orangeWallDepthForState(wall, [floor], definitions, 1), 0);
  assert.equal(orangeWallDepthForState(wall, [], definitions, 0), null);
});

test("engine frames always return the one canonical Orange Wall ID", () => {
  const floor = { x: 1, y: 1, z: 0, blockId: "floor" };
  const engineWall = {
    x: 1, y: 1, z: 3, blockId: "orange-wall", stateId: 1, mechanismDepth: 2,
  };
  assert.deepEqual(
    orangeWallFrameFromEngine({ voxels: [floor, engineWall] }, definitions).voxels[1],
    { ...engineWall, z: 1 },
  );
});

test("engine frames select the invisible wall form below solid support", () => {
  const floor = { x: 1, y: 1, z: 0, blockId: "floor" };
  const engineWall = {
    x: 1, y: 1, z: 3, blockId: "orange-wall", stateId: 1, mechanismDepth: 5,
  };
  assert.deepEqual(
    orangeWallFrameFromEngine({ voxels: [floor, engineWall] }, definitions).voxels[1],
    { ...engineWall, blockId: "orange-wall-hidden", stateId: 2, z: -2 },
  );
});

test("visual comparison migrates retired face records to visible cubes", () => {
  const first = {
    x: 1, y: 1, z: 1, blockId: "orange-wall", stateId: 0, mechanismDepth: 1,
  };
  const second = {
    x: 1, y: 1, z: 1, blockId: "orange-wall", stateId: 1, mechanismDepth: 1,
  };
  assert.deepEqual(
    orangeWallVisualFrame({ voxels: [first, second] }, definitions).voxels,
    [{ ...first, stateId: 1 }, second],
  );
});

test("orange slopes retain their shape and direction through hidden and visible engine frames", () => {
  const floor = { x: 1, y: 1, z: 0, blockId: "floor" };
  const slope = {
    x: 1, y: 1, z: 1, blockId: "orange-wall-slope",
    orientation: "right", variantId: 1, stateId: 1, mechanismDepth: 2,
  };
  const hidden = orangeWallFrameFromEngine({ voxels: [floor, slope] }, definitions).voxels[1];
  assert.deepEqual(hidden, {
    ...slope, blockId: "orange-wall-slope-hidden", stateId: 2, z: -1,
  });
  assert.deepEqual(
    orangeWallFrameFromEngine({ voxels: [floor, { ...hidden, z: 1, mechanismDepth: 0 }] }, definitions).voxels[1],
    { ...slope, mechanismDepth: 0 },
  );
  assert.deepEqual(
    normalizeOrangeWallFrame({ voxels: [{ ...slope, stateId: 4, mechanismDepth: undefined }] }, definitions).voxels[0],
    { ...slope, stateId: 1, mechanismDepth: 4 },
  );
});
