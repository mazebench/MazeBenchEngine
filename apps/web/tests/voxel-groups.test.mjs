import assert from "node:assert/strict";
import test from "node:test";

import {
  moveVoxelGroup,
  removeSelectedVoxels,
  selectConnectedVoxelGroup,
  toggleVoxelGroupSelection,
} from "../app/voxelGroups.mjs";
import { cellObjectSelectionKey } from "../app/cellObjects.mjs";

const voxel = (x, y, z, blockId = "crate", genericId) =>
  genericId === undefined
    ? { x, y, z, blockId }
    : { x, y, z, blockId, genericId };

const selectionKeys = (voxels) => voxels.map(cellObjectSelectionKey);
const definitions = new Map([
  ["crate", { roleId: "pushable", occupancy: "solid" }],
  ["ice", { roleId: "ice", occupancy: "solid", visual: { kind: "cube" } }],
  ["ice-slope", { roleId: "ice", occupancy: "solid", visual: { kind: "slope" } }],
  ["blue-box", { roleId: "weightless-pushable", occupancy: "solid", visual: { kind: "cube" } }],
  ["blue-box-slope", { roleId: "weightless-pushable", occupancy: "solid", visual: { kind: "slope" } }],
  ["clone", { roleId: "clone", occupancy: "solid", visual: { kind: "cube" } }],
  ["clone-slope", { roleId: "clone", occupancy: "solid", visual: { kind: "slope" } }],
  ["lift", { roleId: "player-lift", occupancy: "sensor", visual: { kind: "lift" } }],
  ["orange-wall", {
    roleId: "orange-wall",
    occupancy: "inactive",
    visual: { kind: "orange-wall" },
  }],
  ["button", { roleId: "orange-button", occupancy: "sensor" }],
]);

test("selects only the six-neighbor component of the same exact type", () => {
  const voxels = [
    voxel(1, 1, 0, "generic", 4),
    voxel(2, 1, 0, "generic", 4),
    voxel(2, 1, 1, "generic", 4),
    voxel(3, 2, 1, "generic", 4), // diagonal
    voxel(2, 2, 1, "generic", 5), // touching, different generic ID
    voxel(1, 2, 0, "crate"), // touching, different block
  ];

  assert.deepEqual(
    new Set(selectConnectedVoxelGroup(voxels, { x: 1, y: 1, z: 0 })),
    new Set(selectionKeys(voxels.slice(0, 3))),
  );
});

test("connected selection separates authored state and variant values", () => {
  const first = { ...voxel(1, 1, 0, "switch"), stateId: 0, variantId: 2 };
  const same = { ...voxel(2, 1, 0, "switch"), stateId: 0, variantId: 2 };
  const otherState = { ...voxel(3, 1, 0, "switch"), stateId: 1, variantId: 2 };
  const otherVariant = { ...voxel(1, 2, 0, "switch"), stateId: 0, variantId: 3 };

  assert.deepEqual(
    new Set(selectConnectedVoxelGroup([first, same, otherState, otherVariant], first)),
    new Set(selectionKeys([first, same])),
  );
});

test("same-ID box cubes and directional slopes form one connected rigid selection", () => {
  const cube = { ...voxel(1, 1, 1, "blue-box", 7), groupId: 7, instanceId: "box-cube" };
  const slope = {
    ...voxel(2, 1, 1, "blue-box-slope", 7),
    groupId: 7,
    instanceId: "box-slope",
    orientation: "left",
    variantId: 3,
  };
  const otherId = { ...voxel(3, 1, 1, "blue-box", 8), groupId: 8, instanceId: "other-box" };

  assert.deepEqual(
    new Set(selectConnectedVoxelGroup([cube, slope, otherId], cube, new Set(), definitions)),
    new Set(["instance:box-cube", "instance:box-slope"]),
  );
});

test("same-ID clone cubes and slopes form one group without joining box IDs", () => {
  const clone = { ...voxel(1, 1, 1, "clone", 2), groupId: 2, instanceId: "clone-cube" };
  const slope = { ...voxel(1, 1, 2, "clone-slope", 2), groupId: 2, instanceId: "clone-slope" };
  const box = { ...voxel(2, 1, 1, "blue-box", 2), groupId: 2, instanceId: "box-same-id" };

  assert.deepEqual(
    new Set(selectConnectedVoxelGroup([clone, slope, box], slope, new Set(), definitions)),
    new Set(["instance:clone-cube", "instance:clone-slope"]),
  );
});

test("touching Ice cubes and directional slopes form one connected terrain selection", () => {
  const cube = { ...voxel(1, 1, 0, "ice"), instanceId: "ice-cube" };
  const slope = {
    ...voxel(2, 1, 0, "ice-slope"),
    instanceId: "ice-slope",
    orientation: "right",
    variantId: 1,
  };
  const upperCube = { ...voxel(2, 1, 1, "ice"), instanceId: "upper-ice" };
  const disconnected = { ...voxel(5, 5, 0, "ice"), instanceId: "far-ice" };

  assert.deepEqual(
    new Set(selectConnectedVoxelGroup(
      [cube, slope, upperCube, disconnected],
      slope,
      new Set(),
      definitions,
    )),
    new Set(["instance:ice-cube", "instance:ice-slope", "instance:upper-ice"]),
  );
});

test("touching purple lifts always remain independent selections", () => {
  const first = {
    ...voxel(1, 1, 1, "lift", 1),
    groupId: 1,
    instanceId: "lift-a",
    orientation: "top",
  };
  const beside = {
    ...voxel(2, 1, 1, "lift", 1),
    groupId: 1,
    instanceId: "lift-b",
    orientation: "top",
  };
  const above = {
    ...voxel(1, 1, 2, "lift", 1),
    groupId: 1,
    instanceId: "lift-c",
    orientation: "top",
  };

  assert.deepEqual(
    selectConnectedVoxelGroup(
      [first, beside, above],
      first,
      new Set(),
      definitions,
    ),
    ["instance:lift-a"],
  );
});

test("an exact pick key selects a shareable custom object over its solid cell mate", () => {
  const player = { ...voxel(1, 1, 1, "player"), instanceId: "player-a" };
  const button = { ...voxel(1, 1, 1, "button"), instanceId: "button-a" };
  assert.deepEqual(
    selectConnectedVoxelGroup(
      [player, button],
      { x: 1, y: 1, z: -20, selectionKey: "instance:button-a" },
      new Set(["button"]),
    ),
    ["instance:button-a"],
  );
});

test("a coordinate tap prefers a body over a coincident Orange Wall", () => {
  const panel = { ...voxel(1, 1, 1, "orange-wall"), stateId: 0, instanceId: "panel-a" };
  const crate = { ...voxel(1, 1, 1, "crate"), instanceId: "crate-a" };
  assert.deepEqual(
    selectConnectedVoxelGroup(
      [panel, crate],
      { x: 1, y: 1, z: 1 },
      new Set(),
      definitions,
    ),
    ["instance:crate-a"],
  );
});

test("clicking an already selected group deselects only that group", () => {
  assert.deepEqual(
    toggleVoxelGroupSelection(
      ["1,1,0", "1,1,1", "5,5,0"],
      ["1,1,0", "1,1,1"],
      false,
    ),
    { deselected: true, keys: ["5,5,0"] },
  );

  assert.deepEqual(
    toggleVoxelGroupSelection(["5,5,0"], ["1,1,0", "1,1,1"], true),
    { deselected: false, keys: ["5,5,0", "1,1,0", "1,1,1"] },
  );
});

test("deletes every selected voxel while preserving unselected groups", () => {
  const result = removeSelectedVoxels(
    [voxel(1, 1, 0), voxel(1, 1, 1), voxel(4, 4, 0, "wall")],
    selectionKeys([voxel(1, 1, 0), voxel(1, 1, 1)]),
  );

  assert.equal(result.removedCount, 2);
  assert.deepEqual(result.voxels, [voxel(4, 4, 0, "wall")]);
});

test("moves a selected 3D component one horizontal cell", () => {
  const result = moveVoxelGroup(
    [voxel(1, 1, 0), voxel(1, 1, 1), voxel(4, 4, 0, "wall")],
    selectionKeys([voxel(1, 1, 0), voxel(1, 1, 1)]),
    1,
    0,
    { width: 6, height: 6 },
  );

  assert.equal(result.moved, true);
  assert.deepEqual(new Set(result.selectedKeys), new Set(selectionKeys([
    voxel(2, 1, 0), voxel(2, 1, 1),
  ])));
  assert.deepEqual(result.voxels, [voxel(2, 1, 0), voxel(2, 1, 1), voxel(4, 4, 0, "wall")]);
});

test("moves multiple disconnected selected groups together", () => {
  const result = moveVoxelGroup(
    [voxel(1, 1, 0, "crate"), voxel(3, 3, 0, "generic", 9), voxel(5, 5, 0, "wall")],
    selectionKeys([voxel(1, 1, 0, "crate"), voxel(3, 3, 0, "generic", 9)]),
    1,
    0,
    { width: 7, height: 7 },
  );

  assert.equal(result.moved, true);
  assert.deepEqual(new Set(result.selectedKeys), new Set(selectionKeys([
    voxel(2, 1, 0, "crate"), voxel(4, 3, 0, "generic", 9),
  ])));
  assert.deepEqual(result.voxels, [
    voxel(2, 1, 0, "crate"),
    voxel(4, 3, 0, "generic", 9),
    voxel(5, 5, 0, "wall"),
  ]);
});

test("raises and lowers a selected group on unbounded Z", () => {
  const raised = moveVoxelGroup(
    [voxel(2, 2, 0), voxel(2, 2, 1), voxel(4, 4, 0, "wall")],
    selectionKeys([voxel(2, 2, 0), voxel(2, 2, 1)]),
    0,
    0,
    { width: 6, height: 6 },
    1,
  );
  assert.equal(raised.moved, true);
  assert.deepEqual(new Set(raised.selectedKeys), new Set(selectionKeys([
    voxel(2, 2, 1), voxel(2, 2, 2),
  ])));

  const lowered = moveVoxelGroup(
    [voxel(2, 2, 0)],
    selectionKeys([voxel(2, 2, 0)]),
    0,
    0,
    { width: 6, height: 6 },
    -1,
  );
  assert.equal(lowered.moved, true);
  assert.deepEqual(lowered.selectedKeys, selectionKeys([voxel(2, 2, -1)]));
});

test("vertical group movement is blocked by an unselected cube", () => {
  const result = moveVoxelGroup(
    [voxel(2, 2, 0), voxel(2, 2, 1, "wall")],
    selectionKeys([voxel(2, 2, 0)]),
    0,
    0,
    { width: 6, height: 6 },
    1,
  );

  assert.equal(result.moved, false);
});

test("does not move a group beyond the room edge", () => {
  const voxels = [voxel(0, 1, 0), voxel(0, 1, 1)];
  const result = moveVoxelGroup(voxels, selectionKeys(voxels), -1, 0, { width: 6, height: 6 });

  assert.equal(result.moved, false);
  assert.deepEqual(result.voxels, voxels);
});

test("does not move a group into an unselected voxel", () => {
  const voxels = [voxel(1, 1, 0), voxel(2, 1, 0, "wall")];
  const result = moveVoxelGroup(voxels, selectionKeys([voxels[0]]), 1, 0, { width: 6, height: 6 });

  assert.equal(result.moved, false);
  assert.deepEqual(result.voxels, voxels);
});

test("moves a solid body onto a sensor without deleting either occupant", () => {
  const body = { ...voxel(1, 1, 1, "crate"), instanceId: "body" };
  const sensor = { ...voxel(2, 1, 1, "goal"), instanceId: "sensor" };
  const result = moveVoxelGroup(
    [body, sensor],
    [cellObjectSelectionKey(body)],
    1,
    0,
    { width: 6, height: 6 },
    0,
    new Set(["goal"]),
  );

  assert.equal(result.moved, true);
  assert.deepEqual(result.voxels, [{ ...body, x: 2 }, sensor]);
});

test("moves a body onto the one shareable Orange Wall at every state", () => {
  const crate = { ...voxel(1, 1, 1, "crate"), instanceId: "crate-a" };
  const lowered = {
    ...voxel(2, 1, 1, "orange-wall"),
    instanceId: "panel-a",
    mechanismDepth: 1,
    stateId: 0,
  };
  const allowed = moveVoxelGroup(
    [crate, lowered],
    ["instance:crate-a"],
    1,
    0,
    { width: 4, height: 3 },
    0,
    new Set(),
    definitions,
  );
  assert.equal(allowed.moved, true);
  assert.deepEqual(
    allowed.voxels.map(({ x, y, z, blockId, stateId }) => ({ x, y, z, blockId, stateId })),
    [
      { x: 2, y: 1, z: 1, blockId: "crate", stateId: undefined },
      { x: 2, y: 1, z: 1, blockId: "orange-wall", stateId: 0 },
    ],
  );

  const raised = {
    ...lowered,
    blockId: "orange-wall",
    mechanismDepth: 0,
    stateId: 1,
  };
  const raisedResult = moveVoxelGroup(
    [crate, raised],
    ["instance:crate-a"],
    1,
    0,
    { width: 4, height: 3 },
    0,
    new Set(),
    definitions,
  );
  assert.equal(raisedResult.moved, true);
});

test("moves Orange Wall metadata through occupied cells", () => {
  const wall = { ...voxel(2, 1, -2, "crate"), instanceId: "wall-a" };
  const hidden = {
    ...voxel(1, 1, -2, "orange-wall"),
    instanceId: "hidden-a",
    mechanismDepth: 4,
    stateId: 2,
  };
  const result = moveVoxelGroup(
    [wall, hidden],
    ["instance:hidden-a"],
    1,
    0,
    { width: 4, height: 3 },
    0,
    new Set(),
    definitions,
  );
  assert.equal(result.moved, true);
  assert.deepEqual(result.voxels.map(({ x, y, z, blockId }) => ({ x, y, z, blockId })), [
    { x: 2, y: 1, z: -2, blockId: "crate" },
    { x: 2, y: 1, z: -2, blockId: "orange-wall" },
  ]);
});
