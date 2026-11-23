import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeVoxelRoom, V2_BLOCK_CATALOG } from "../render/v1/voxel-world-v2.mjs";
import { attachedNumberFaces, numberFaceCovered, numberFaceDirection } from "../ui/numbered-face-visibility.mjs";

const definitions = new Map(V2_BLOCK_CATALOG.map(block => [block.id, block]));
const faces = ["top", "bottom", "north", "east", "south", "west"];
function worldFor(objects) {
  return {
    roomWidth: 16, roomHeight: 16, blockDefinitions: definitions,
    rooms: [{ columnIndex: 1, rowIndex: 1, objects }]
  };
}
const record = { x: 20, z: 21, object: { x: 4, y: 5, z: 2 } };

test("attachments hide only the numbered face they are mounted on in all six directions", () => {
  for (const [face, dx, dy, dz] of [
    ["top", 0, 0, 1], ["bottom", 0, 0, -1],
    ["north", 0, -1, 0], ["east", 1, 0, 0],
    ["south", 0, 1, 0], ["west", -1, 0, 0]
  ]) {
    for (const blockId of face === "bottom" ? ["orange-button"] : ["lift", "orange-button"]) {
      const covered = attachedNumberFaces(worldFor([
        { x: 4 + dx, y: 5 + dy, z: 2 + dz, blockId, orientation: face }
      ]));
      assert.deepEqual(faces.filter(candidate => numberFaceCovered(covered, record, candidate)), [face]);
    }
  }
});

test("wrong-facing, hidden, removed and truncated fixtures do not suppress numbers", () => {
  const fixture = { x: 4, y: 4, z: 2, blockId: "lift", orientation: "north" };
  assert(numberFaceCovered(attachedNumberFaces(worldFor([fixture])), record, "north"));
  for (const objects of [[], [{ ...fixture, engineHidden: true }], [{ ...fixture, orientation: "south" }]]) {
    assert(!numberFaceCovered(attachedNumberFaces(worldFor(objects)), record, "north"));
  }
  assert(!numberFaceCovered(attachedNumberFaces(worldFor([fixture]), 2), record, "north"));
  assert(numberFaceCovered(attachedNumberFaces(worldFor([fixture]), 3), record, "north"));
});

test("gates and oriented punchers also cover the corresponding support label", () => {
  const fixtures = [
    { x: 4, y: 5, z: 3, blockId: "gate" },
    { x: 5, y: 5, z: 2, blockId: "puncher", orientation: "right" }
  ];
  const covered = attachedNumberFaces(worldFor(fixtures));
  assert.deepEqual(faces.filter(face => numberFaceCovered(covered, record, face)), ["top", "east"]);
});

test("A×L hides the two lift-covered top numbers while preserving exposed faces", async () => {
  const room = decodeVoxelRoom(JSON.parse(await readFile(
    new URL("../level-data/v2/main-world/tkt3t1umof.json", import.meta.url), "utf8"
  )));
  const world = worldFor(room.objects);
  const covered = attachedNumberFaces(world);
  for (const [x, y, z] of [[2, 5, 0], [4, 5, 1]]) {
    const label = { x: x + 16, z: y + 16, object: { x, y, z } };
    assert.deepEqual(faces.filter(face => numberFaceCovered(covered, label, face)), ["top"]);
  }
  const uncovered = { x: 28, z: 20, object: { x: 12, y: 4, z: 1 } };
  assert(faces.every(face => !numberFaceCovered(covered, uncovered, face)));
});

test("label planes map to world faces independently of camera yaw, including sloped tops", () => {
  const vectors = [
    [{ x: 0, y: 1, z: 0 }, "top"], [{ x: 0, y: -1, z: 0 }, "bottom"],
    [{ x: 0, y: 0, z: -1 }, "north"], [{ x: 1, y: 0, z: 0 }, "east"],
    [{ x: 0, y: 0, z: 1 }, "south"], [{ x: -1, y: 0, z: 0 }, "west"],
    [{ x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 }, "top"]
  ];
  for (const [normal, face] of vectors) assert.equal(numberFaceDirection(normal), face);
});
