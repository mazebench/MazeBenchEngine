import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWorldToTest,
  cropVoxelsToWorld,
  isVoxelInsideWorld,
  parseWorldDimensionDraft,
  rotateVoxelsClockwise,
  rotateWorldClockwise,
} from "../app/worldBounds.mjs";

test("dimension drafts are unrestricted until explicitly validated for save", () => {
  assert.equal(parseWorldDimensionDraft("12"), 12);
  assert.equal(parseWorldDimensionDraft(" 7 "), 7);
  assert.equal(parseWorldDimensionDraft(""), null);
  assert.equal(parseWorldDimensionDraft("anything"), null);
  assert.equal(parseWorldDimensionDraft("12.5"), null);
  assert.equal(parseWorldDimensionDraft("2"), null);
  assert.equal(parseWorldDimensionDraft("33"), null);
});

test("each test owns a world shared by its Start and Expected frames", () => {
  const first = {
    id: "small-room",
    start: { voxels: [{ x: 1, y: 1, z: 0 }, { x: 4, y: 1, z: 0 }] },
    intermediate: [{ voxels: [{ x: 1, y: 1, z: 0 }, { x: 5, y: 1, z: 0 }] }],
    expected: { voxels: [{ x: 2, y: 1, z: 0 }, { x: 4, y: 1, z: 0 }] },
  };
  const second = {
    id: "large-room",
    world: { width: 8, height: 7, floorLayer: 0 },
    start: { voxels: [{ x: 7, y: 6, z: 0 }] },
    expected: { voxels: [{ x: 7, y: 6, z: 0 }] },
  };

  const resizedFirst = applyWorldToTest(first, { width: 3, height: 2 });

  assert.deepEqual(resizedFirst.world, { width: 3, height: 2, floorLayer: 0 });
  assert.deepEqual(resizedFirst.start.voxels, [{ x: 1, y: 1, z: 0 }]);
  assert.deepEqual(resizedFirst.intermediate[0].voxels, [{ x: 1, y: 1, z: 0 }]);
  assert.deepEqual(resizedFirst.expected.voxels, [{ x: 2, y: 1, z: 0 }]);
  assert.deepEqual(second.world, { width: 8, height: 7, floorLayer: 0 });
  assert.equal(second.start.voxels.length, 1);
});

test("shrinking a room removes stale horizontal voxels but keeps every vertical layer", () => {
  const world = { width: 3, height: 2 };
  const inside = [
    { x: 0, y: 0, z: 0, blockId: "floor" },
    { x: 2, y: 1, z: -12, blockId: "crate" },
    { x: 1, y: 0, z: 300, blockId: "wall" },
  ];
  const stale = Array.from({ length: 269 }, (_, index) => ({
    x: 3 + index,
    y: index % 2,
    z: index - 134,
    blockId: "floor",
  }));

  const cropped = cropVoxelsToWorld([...inside, ...stale], world);

  assert.deepEqual(cropped, inside);
  assert.equal(stale.some((voxel) => isVoxelInsideWorld(voxel, world)), false);
});

test("negative horizontal coordinates are outside the room", () => {
  const world = { width: 8, height: 7 };
  assert.equal(isVoxelInsideWorld({ x: -1, y: 0 }, world), false);
  assert.equal(isVoxelInsideWorld({ x: 0, y: -1 }, world), false);
});

test("clockwise level rotations also rotate rectangular room bounds", () => {
  const world = { width: 3, height: 2 };
  const northEdge = [{ x: 0, y: 0, z: -4, blockId: "player", genericId: 712 }];

  assert.deepEqual(rotateWorldClockwise(world, 1), { width: 2, height: 3 });
  assert.deepEqual(rotateVoxelsClockwise(northEdge, world, 1), [
    { x: 1, y: 0, z: -4, blockId: "player", genericId: 712 },
  ]);
  assert.deepEqual(rotateVoxelsClockwise(northEdge, world, 2), [
    { x: 2, y: 1, z: -4, blockId: "player", genericId: 712 },
  ]);
  assert.deepEqual(rotateVoxelsClockwise(northEdge, world, 3), [
    { x: 0, y: 2, z: -4, blockId: "player", genericId: 712 },
  ]);
});

test("clockwise level rotations keep a slope's visual direction attached to the room", () => {
  const world = { width: 4, height: 3 };
  const slope = [{
    x: 1,
    y: 0,
    z: 0,
    blockId: "ice-slope",
    orientation: "up",
    variantId: 0,
  }];

  assert.deepEqual(rotateVoxelsClockwise(slope, world, 1), [{
    x: 2,
    y: 1,
    z: 0,
    blockId: "ice-slope",
    orientation: "right",
    variantId: 1,
  }]);
  assert.deepEqual(rotateVoxelsClockwise(slope, world, 2)[0], {
    x: 2,
    y: 2,
    z: 0,
    blockId: "ice-slope",
    orientation: "down",
    variantId: 2,
  });
  assert.deepEqual(rotateVoxelsClockwise(slope, world, 3)[0], {
    x: 0,
    y: 2,
    z: 0,
    blockId: "ice-slope",
    orientation: "left",
    variantId: 3,
  });
});

test("generic box and clone slopes rotate without losing their group identity", () => {
  const world = { width: 4, height: 3 };
  const slopes = [
    { x: 0, y: 1, z: 2, blockId: "blue-box-slope", orientation: "up", variantId: 0, genericId: 12, groupId: 12 },
    { x: 2, y: 1, z: -1, blockId: "yellow-clone-slope", orientation: "left", variantId: 3, genericId: 7, groupId: 7 },
  ];

  assert.deepEqual(rotateVoxelsClockwise(slopes, world, 1), [
    { x: 1, y: 0, z: 2, blockId: "blue-box-slope", orientation: "right", variantId: 1, genericId: 12, groupId: 12 },
    { x: 1, y: 2, z: -1, blockId: "yellow-clone-slope", orientation: "up", variantId: 0, genericId: 7, groupId: 7 },
  ]);
});

test("clockwise level rotations rotate wall-facing lifts but keep top lifts upward", () => {
  const world = { width: 4, height: 3 };
  const lifts = [
    { x: 1, y: 0, z: 2, blockId: "player-lift", orientation: "north", variantId: 1, genericId: 3, groupId: 3 },
    { x: 2, y: 1, z: 4, blockId: "player-lift", orientation: "top", variantId: 0, genericId: 0, groupId: 0 },
  ];

  assert.deepEqual(rotateVoxelsClockwise(lifts, world, 1), [
    { x: 2, y: 1, z: 2, blockId: "player-lift", orientation: "east", variantId: 2, genericId: 5, groupId: 5 },
    { x: 1, y: 2, z: 4, blockId: "player-lift", orientation: "top", variantId: 0, genericId: 0, groupId: 0 },
  ]);
});

test("clockwise level rotations rotate side buttons and preserve top and bottom mountings", () => {
  const world = { width: 4, height: 3 };
  const buttons = [
    { x: 1, y: 0, z: 2, blockId: "orange-button", orientation: "north", variantId: 1, stateId: 0 },
    { x: 2, y: 1, z: 4, blockId: "orange-button", orientation: "top", variantId: 0, stateId: 0 },
    { x: 0, y: 2, z: -1, blockId: "orange-button", orientation: "bottom", variantId: 5, stateId: 0 },
    { x: 3, y: 2, z: 3, blockId: "orange-button", orientation: "west", variantId: 4, stateId: 0 },
  ];

  assert.deepEqual(rotateVoxelsClockwise(buttons, world, 1), [
    { x: 2, y: 1, z: 2, blockId: "orange-button", orientation: "east", variantId: 2, stateId: 0 },
    { x: 1, y: 2, z: 4, blockId: "orange-button", orientation: "top", variantId: 0, stateId: 0 },
    { x: 0, y: 0, z: -1, blockId: "orange-button", orientation: "bottom", variantId: 5, stateId: 0 },
    { x: 0, y: 3, z: 3, blockId: "orange-button", orientation: "north", variantId: 1, stateId: 0 },
  ]);
});

test("clockwise level rotations rotate punch directions", () => {
  const world = { width: 4, height: 3 };
  const puncher = [{
    x: 1,
    y: 0,
    z: 2,
    blockId: "puncher",
    orientation: "up",
    variantId: 0,
  }];

  assert.deepEqual(rotateVoxelsClockwise(puncher, world, 1), [{
    x: 2,
    y: 1,
    z: 2,
    blockId: "puncher",
    orientation: "right",
    variantId: 1,
  }]);
});
