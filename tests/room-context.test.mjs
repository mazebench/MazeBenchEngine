import assert from "node:assert/strict";
import test from "node:test";

import { renderMaterial } from "../render/v1/polycube-mesh.mjs";
import {
  roomContextWorld,
  roomObjectInContext
} from "../render/v1/room-context.mjs";
import { collectVoxelSceneV2 } from "../render/v1/voxel-scene-v2.mjs";
import { V2_WORLD_FORMAT } from "../render/v1/voxel-world-v2.mjs";

const blocks = [
  { id: "floor", color: "#d6bd94", roleId: "floor", visual: { kind: "floor" } },
  { id: "player", color: "#5aa95c", roleId: "player", visual: { kind: "cube" } }
];

function makeRoom(columnIndex, rowIndex) {
  return {
    fileName: `${columnIndex}-${rowIndex}.json`,
    position: [String(columnIndex), String(rowIndex)],
    columnIndex,
    rowIndex,
    width: 2,
    height: 2,
    objects: [{ x: 0, y: 0, z: 0, blockId: "floor" }]
  };
}

function makeWorld() {
  const rooms = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) rooms.push(makeRoom(column, row));
  }
  return {
    storageFormat: V2_WORLD_FORMAT,
    columns: ["0", "1", "2"],
    rows: ["0", "1", "2"],
    roomWidth: 2,
    roomHeight: 2,
    rooms,
    blocks,
    blockDefinitions: new Map(blocks.map((block) => [block.id, block]))
  };
}

test("3D room context centers the active room and dims its eight neighbors", () => {
  const world = makeWorld();
  const activeRoom = world.rooms.find((room) => room.columnIndex === 1 && room.rowIndex === 1);
  const renderedRoom = {
    ...activeRoom,
    objects: [...activeRoom.objects, { x: 1, y: 1, z: 0, blockId: "player" }]
  };
  const context = roomContextWorld(world, activeRoom, renderedRoom);

  assert.equal(context.columns.length, 3);
  assert.equal(context.rows.length, 3);
  assert.equal(context.rooms.length, 9);
  const active = context.rooms.find((room) => room.fileName === activeRoom.fileName);
  assert.deepEqual(
    { columnIndex: active.columnIndex, rowIndex: active.rowIndex, renderDimmed: active.renderDimmed },
    { columnIndex: 1, rowIndex: 1, renderDimmed: false }
  );
  assert.equal(active.objects.some((object) => object.blockId === "player"), true);
  assert.equal(context.rooms.filter((room) => room.renderDimmed).length, 8);
  assert.deepEqual(
    roomObjectInContext(context, { x: 1, y: 0, z: 2, blockId: "player" }),
    { x: 3, y: 2, z: 2, blockId: "player" }
  );

  const scene = collectVoxelSceneV2({ world: context, cellTops: new Map() });
  assert.equal(scene.pickRecords.every((record) => !record.room.renderDimmed), true);
  assert.equal([...scene.floorGroups.values()].some((group) => group.dimmed), true);
  assert.equal([...scene.floorGroups.values()].some((group) => !group.dimmed), true);

  world.rooms.forEach((room) => room.objects.push({ x: 1, y: 1, z: 0, blockId: "player" }));
  const playContext = roomContextWorld(world, activeRoom, renderedRoom, {
    omitDimmedRoleIds: ["player"]
  });
  assert.equal(playContext.rooms.find((room) => !room.renderDimmed).objects.some((object) =>
    object.blockId === "player"), true);
  assert.equal(playContext.rooms.filter((room) => room.renderDimmed).every((room) =>
    room.objects.every((object) => object.blockId !== "player")), true);
});

test("world-edge rooms remain centered without inventing neighboring rooms", () => {
  const world = makeWorld();
  const activeRoom = world.rooms[0];
  const context = roomContextWorld(world, activeRoom);

  assert.equal(context.rooms.length, 4);
  assert.deepEqual(
    context.rooms.map(({ columnIndex, rowIndex }) => [columnIndex, rowIndex]).sort(),
    [[1, 1], [1, 2], [2, 1], [2, 2]]
  );
  assert.equal(context.rooms.find((room) => !room.renderDimmed).fileName, activeRoom.fileName);
});

test("neighbor materials are darker while active-room materials keep their color", () => {
  const active = renderMaterial("#d6bd94");
  const neighbor = renderMaterial("#d6bd94", true);

  assert.equal(active.color.getHexString(), "d6bd94");
  assert.ok(neighbor.color.r < active.color.r);
  assert.ok(neighbor.color.g < active.color.g);
  assert.ok(neighbor.color.b < active.color.b);
});
