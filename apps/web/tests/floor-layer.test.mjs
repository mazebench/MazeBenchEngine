import assert from "node:assert/strict";
import test from "node:test";

import { enforceFloorLayer, selectionContainsFloor } from "../app/floorLayer.mjs";
import { cellObjectSelectionKey } from "../app/cellObjects.mjs";

test("floor tiles are retained only on Row 0", () => {
  const voxels = [
    { x: 0, y: 0, z: 0, blockId: "floor" },
    { x: 0, y: 0, z: 1, blockId: "floor" },
    { x: 1, y: 0, z: 4, blockId: "wall" },
  ];
  assert.deepEqual(enforceFloorLayer(voxels, new Set(["floor"])), [
    voxels[0],
    voxels[2],
  ]);
});

test("vertical group movement can identify selected floor tiles", () => {
  const voxels = [
    { x: 2, y: 3, z: 0, blockId: "floor" },
    { x: 2, y: 3, z: 1, blockId: "crate" },
  ];
  assert.equal(selectionContainsFloor(
    voxels,
    voxels.map(cellObjectSelectionKey),
    new Set(["floor"]),
  ), true);
  assert.equal(selectionContainsFloor(
    voxels,
    [cellObjectSelectionKey(voxels[1])],
    new Set(["floor"]),
  ), false);
});
