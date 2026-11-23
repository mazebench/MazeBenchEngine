import assert from "node:assert/strict";
import test from "node:test";

import { renderAsciiFrameV1 } from "../render-ascii/v1/ascii-scene.mjs";
import { V2_BLOCK_CATALOG } from "../render/v1/voxel-world-v2.mjs";

const definitions = new Map(V2_BLOCK_CATALOG.map((block) => [block.id, block]));

function pixelsNamed(frame, name) {
  return frame.pixels.flat().filter((pixel) => pixel.name === name);
}

function topRoomWith(...objects) {
  return {
    width: 1,
    height: 1,
    objects: [
      { x: 0, y: 0, z: 0, blockId: "floor" },
      { x: 0, y: 0, z: 0, blockId: "orange-button", orientation: "top" },
      ...objects.map((object) => ({ x: 0, y: 0, z: 0, ...object }))
    ]
  };
}

test("an exposed orange button is a centered light-orange 2x2 face", async () => {
  const frame = await renderAsciiFrameV1(topRoomWith(), definitions, { pitch: 0 });
  assert.deepEqual(frame.rows, ["AAAA", "A88A", "A88A", "AAAA"]);
  assert.equal(pixelsNamed(frame, "orange-button").length, 4);
  assert.deepEqual(
    [...new Set(pixelsNamed(frame, "orange-button").map((pixel) => pixel.color))],
    ["#ffb347"]
  );
  assert.equal(pixelsNamed(frame, "floor").length, 12);
});

test("every full occupant hides a button at the same voxel", async () => {
  const occupants = [
    { blockId: "player" },
    { blockId: "clone", genericId: 0, groupId: 0 },
    { blockId: "crate" },
    { blockId: "weightless-box", genericId: 0, groupId: 0 },
    { blockId: "weightless-slope", genericId: 0, groupId: 0, orientation: "up" }
  ];
  for (const occupant of occupants) {
    const frame = await renderAsciiFrameV1(topRoomWith(occupant), definitions, { pitch: 0 });
    assert.equal(pixelsNamed(frame, "orange-button").length, 0, occupant.blockId);
    assert.equal(pixelsNamed(frame, occupant.blockId).length, 16, occupant.blockId);
  }
});

test("pitched ASCII keeps floor and ice visible beneath full occupants", async () => {
  const cases = [
    ["floor", "player", "aaaa"],
    ["ice-floor", "crate", "iiii"],
    ["floor", "wall", "aaaa"],
    ["ice-floor", "weightless-box", "iiii"]
  ];
  for (const [surface, occupant, exposedSide] of cases) {
    const frame = await renderAsciiFrameV1({
      width: 1,
      height: 1,
      objects: [
        { x: 0, y: 0, z: 0, blockId: surface },
        { x: 0, y: 0, z: 0, blockId: occupant }
      ]
    }, definitions, { pitch: 1 });
    assert.equal(frame.rows.at(-1), exposedSide, `${surface} under ${occupant}`);
    assert.equal(pixelsNamed(frame, surface).length, 4, `${surface} under ${occupant}`);
    assert.equal(pixelsNamed(frame, occupant).length, 16, occupant);
  }
});

test("a non-collecting solid wins over both a gem and a face fixture", async () => {
  const frame = await renderAsciiFrameV1(topRoomWith(
    { blockId: "gem" },
    { blockId: "crate" }
  ), definitions, { pitch: 0 });
  assert.equal(pixelsNamed(frame, "crate").length, 16);
  assert.equal(pixelsNamed(frame, "gem").length, 0);
  assert.equal(pixelsNamed(frame, "orange-button").length, 0);
});

test("buttons sharing a voxel remain independent fixtures on different faces", async () => {
  const room = {
    width: 2,
    height: 1,
    objects: [
      { x: 0, y: 0, z: 0, blockId: "wall" },
      { x: 1, y: 0, z: 0, blockId: "orange-button", orientation: "top" },
      { x: 1, y: 0, z: 0, blockId: "orange-button", orientation: "east" }
    ]
  };
  const top = await renderAsciiFrameV1(room, definitions, { pitch: 0, yaw: 0 });
  assert.equal(pixelsNamed(top, "orange-button").length, 4);

  const side = await renderAsciiFrameV1(room, definitions, { pitch: 4, yaw: 1 });
  assert.deepEqual(side.rows, ["wwww", "w88w", "w88w", "wwww"]);
  assert.equal(pixelsNamed(side, "orange-button").length, 4);
  assert.equal(pixelsNamed(side, "wall").length, 12);
});

test("covered side buttons disappear instead of drawing over the occupant", async () => {
  const room = {
    width: 2,
    height: 1,
    objects: [
      { x: 0, y: 0, z: 0, blockId: "wall" },
      { x: 1, y: 0, z: 0, blockId: "orange-button", orientation: "east" },
      { x: 1, y: 0, z: 0, blockId: "crate" }
    ]
  };
  const frame = await renderAsciiFrameV1(room, definitions, { pitch: 4, yaw: 1 });
  assert.equal(pixelsNamed(frame, "orange-button").length, 0);
  assert.equal(pixelsNamed(frame, "crate").length > 0, true);
});

test("buried and explicitly invisible orange walls expose the floor", async () => {
  const room = {
    width: 3,
    height: 1,
    objects: [
      { x: 0, y: 0, z: 0, blockId: "floor" },
      { x: 0, y: 0, z: -1, blockId: "orange-wall", mechanismDepth: 1 },
      { x: 1, y: 0, z: 0, blockId: "floor" },
      { x: 1, y: 0, z: 0, blockId: "orange-wall", mechanismDepth: 0 },
      { x: 2, y: 0, z: 0, blockId: "floor" },
      { x: 2, y: 0, z: 0, blockId: "orange-wall", stateId: 2 }
    ]
  };
  const frame = await renderAsciiFrameV1(room, definitions, { pitch: 0 });
  assert.deepEqual(frame.cells[0].map((cell) => cell.name), ["floor", "orange-wall", "floor"]);
  assert.equal(pixelsNamed(frame, "floor").length, 32);
  assert.equal(pixelsNamed(frame, "orange-wall").length, 16);
});

test("lowered lifts render as their mounted face and yield to occupants", async () => {
  const topFixture = await renderAsciiFrameV1({
    width: 1,
    height: 1,
    objects: [
      { x: 0, y: 0, z: 0, blockId: "floor" },
      { x: 0, y: 0, z: 0, blockId: "lift", orientation: "top", stateId: 0 },
      { x: 0, y: 0, z: 0, blockId: "orange-button", orientation: "top" }
    ]
  }, definitions, { pitch: 0 });
  assert.equal(pixelsNamed(topFixture, "lift").length, 12);
  assert.equal(pixelsNamed(topFixture, "orange-button").length, 4);

  const sideFixture = await renderAsciiFrameV1({
    width: 2,
    height: 1,
    objects: [
      { x: 0, y: 0, z: 0, blockId: "wall" },
      { x: 1, y: 0, z: 0, blockId: "lift", orientation: "east", stateId: 0 }
    ]
  }, definitions, { pitch: 4, yaw: 1 });
  assert.equal(pixelsNamed(sideFixture, "lift").length, 16);

  const covered = await renderAsciiFrameV1({
    width: 1,
    height: 1,
    objects: [
      { x: 0, y: 0, z: 0, blockId: "lift", orientation: "top", stateId: 0 },
      { x: 0, y: 0, z: 0, blockId: "player" }
    ]
  }, definitions, { pitch: 0 });
  assert.equal(pixelsNamed(covered, "lift").length, 0);
  assert.equal(pixelsNamed(covered, "player").length, 16);
});
