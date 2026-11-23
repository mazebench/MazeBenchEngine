import assert from "node:assert/strict";
import test from "node:test";
import { roomBorderEdges } from "../ui/room-border-edges.mjs";
import { V2_BLOCK_CATALOG, V2_WORLD_FORMAT } from "../render/v1/voxel-world-v2.mjs";

const definitions = new Map(V2_BLOCK_CATALOG.map(block => [block.id, block]));
function fixture(left, right) {
  const rooms = [left, right].map((objects, columnIndex) => ({ fileName: `${columnIndex}`, columnIndex, rowIndex: 0, objects }));
  return { storageFormat: V2_WORLD_FORMAT, columns: [0,1], rows: [0], roomWidth: 1, roomHeight: 1, blockDefinitions: definitions, rooms, contextRooms: rooms };
}
const cell = (blockId, extra = {}) => ({ blockId, x: 0, y: 0, z: 0, ...extra });
const lines = border => Array.from({ length: border.positions.length / 6 }, (_, i) => border.positions.slice(i * 6, i * 6 + 6));
const topSeam = line => line[1] === 1 && line[4] === 1;

test("matching room walls have no seam outline, with cached border geometry", () => {
  const world = fixture([cell("wall")], [cell("wall")]);
  const a = roomBorderEdges(world, world.rooms[0])[0];
  assert.equal(a.positions.length, 0, "the shared face and its coplanar perimeter disappear");
  assert.equal(roomBorderEdges(world, world.rooms[0])[0].positions, a.positions);
  world.contextRooms[1] = { ...world.rooms[1], objects: [] };
  assert(roomBorderEdges(world, world.rooms[0])[0].positions.length > 0, "editing the neighbor invalidates its seam");
});

test("room-border joins retain material boundaries and real corners", () => {
  const different = fixture([cell("wall")], [cell("ice-block")]);
  assert(lines(roomBorderEdges(different, different.rooms[0])[0]).some(topSeam));
  const step = fixture([cell("wall")], [cell("wall"), cell("wall", { z: 1 })]);
  assert(lines(roomBorderEdges(step, step.rooms[0])[0]).some(topSeam));
  assert.equal(roomBorderEdges(step, step.rooms[0], { maxHeight: 1 })[0].positions.length, 0, "Truncate removes the former step seam");
});

test("matching sloped surfaces join across room borders; distinct bodies do not", () => {
  const ramps = fixture([cell("ice-slope", { orientation: "up" })], [cell("ice-slope", { orientation: "up" })]);
  assert.equal(roomBorderEdges(ramps, ramps.rooms[0])[0].positions.length, 0);
  const bodies = fixture([cell("weightless-box", { groupId: 1 })], [cell("weightless-box", { groupId: 1 })]);
  assert(roomBorderEdges(bodies, bodies.rooms[0])[0].positions.length > 0);
});

test("a separately animated player never leaves its outline in the stationary room seam", () => {
  const world = fixture([cell("floor"), cell("player")], [cell("floor")]);
  assert(lines(roomBorderEdges(world, world.rooms[0])[0]).some(topSeam));
  const scenery = roomBorderEdges(world, world.rooms[0], { excludePlayer: true })[0];
  assert(!lines(scenery).some(line => line[1] > 0 || line[4] > 0));
  assert.equal(roomBorderEdges(world, world.rooms[0], { excludePlayer: true })[0].positions, scenery.positions);
  assert(lines(roomBorderEdges(world, world.rooms[0])[0]).some(topSeam), "editor variants retain ordinary body edges");
});
