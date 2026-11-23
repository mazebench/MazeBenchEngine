import assert from "node:assert/strict";
import test from "node:test";

import {
  GATE_GENERIC_MAX,
  LIFT_GENERIC_MAX,
  PUNCHER_GENERIC_MAX,
  gateIsRaised,
  liftGenericId,
  liftIsRaised,
  liftOrientationFromPaintFace,
  liftOrientationIndex,
  liftOrientationFromGenericId,
  normalizeLiftOrientation,
  normalizeSlopeDirection,
  offsetSlopeDirection,
  puncherDirectionFromPaintFace,
  puncherDirectionFromMechanismId,
  puncherIsSprung,
  puncherIsSprungMechanismId,
  puncherMechanismId,
  rotateLiftMetadata,
  rotatePuncherMetadata,
  rotateSlopeMetadata,
  slopeDirectionIndex,
} from "../app/visualVariants.mjs";

test("red gates expose exactly one lowered and one raised editor state", () => {
  assert.equal(GATE_GENERIC_MAX, 1);
  assert.equal(gateIsRaised(0), false);
  assert.equal(gateIsRaised(1), true);
  assert.equal(gateIsRaised(200), true);
});

test("punchers point outward from one of four painted side faces", () => {
  assert.equal(puncherDirectionFromPaintFace({ dx: 1, dy: 0 }), "right");
  assert.equal(puncherDirectionFromPaintFace({ dx: -1, dy: 0 }), "left");
  assert.equal(puncherDirectionFromPaintFace({ dx: 0, dy: 1 }), "down");
  assert.equal(puncherDirectionFromPaintFace({ dx: 0, dy: -1 }), "up");
  assert.equal(puncherDirectionFromPaintFace({ face: "top", dx: 0, dy: 0 }), null);
  assert.equal(puncherDirectionFromPaintFace({ face: "bottom-face" }), null);
});

test("punchers expose exactly one unsprung and one sprung editor state", () => {
  assert.equal(PUNCHER_GENERIC_MAX, 1);
  assert.equal(puncherIsSprung(0), false);
  assert.equal(puncherIsSprung(1), true);
  assert.equal(puncherIsSprung(200), true);
});

test("puncher ABI metadata combines direction with binary visual state", () => {
  assert.equal(puncherMechanismId("up", false), 0);
  assert.equal(puncherMechanismId("right", true), 3);
  assert.equal(puncherMechanismId("down", false), 4);
  assert.equal(puncherMechanismId("left", true), 7);
  assert.equal(puncherDirectionFromMechanismId(5), "down");
  assert.equal(puncherDirectionFromMechanismId(7), "left");
  assert.equal(puncherIsSprungMechanismId(6), false);
  assert.equal(puncherIsSprungMechanismId(7), true);
});

test("puncher rotation keeps its visual direction attached to the room", () => {
  assert.deepEqual(
    rotatePuncherMetadata({ blockId: "puncher", orientation: "up", variantId: 0 }, 3),
    { blockId: "puncher", orientation: "left", variantId: 3 },
  );
});

test("ice slopes have four stable authored directions", () => {
  assert.equal(normalizeSlopeDirection("north"), "up");
  assert.equal(normalizeSlopeDirection(undefined, 1), "right");
  assert.equal(slopeDirectionIndex("south"), 2);
  assert.equal(offsetSlopeDirection("left", 1), "up");
});

test("slope rotation updates both orientation and numbered visual variant", () => {
  assert.deepEqual(
    rotateSlopeMetadata({ blockId: "slope", orientation: "left", variantId: 3 }, 2),
    { blockId: "slope", orientation: "right", variantId: 1 },
  );
  assert.deepEqual(
    rotateSlopeMetadata({ blockId: "ordinary-cube", orientation: "none", variantId: 7 }, 1),
    { blockId: "ordinary-cube", orientation: "none", variantId: 7 },
  );
});

test("player lifts support top plus four wall-facing variants but not downward", () => {
  assert.equal(normalizeLiftOrientation("upward"), "top");
  assert.equal(normalizeLiftOrientation("front"), "north");
  assert.equal(normalizeLiftOrientation("right"), "east");
  assert.equal(normalizeLiftOrientation("back"), "south");
  assert.equal(normalizeLiftOrientation("left"), "west");
  assert.equal(normalizeLiftOrientation("down", 0), "top");
  assert.equal(liftOrientationIndex("west"), 4);
  assert.equal(LIFT_GENERIC_MAX, 9);
  assert.deepEqual(
    Array.from({ length: 10 }, (_, id) => [
      id,
      liftOrientationFromGenericId(id),
      liftIsRaised(id),
    ]),
    [
      [0, "top", false], [1, "top", true],
      [2, "north", false], [3, "north", true],
      [4, "east", false], [5, "east", true],
      [6, "south", false], [7, "south", true],
      [8, "west", false], [9, "west", true],
    ],
  );
  assert.equal(liftGenericId("east", true), 5);
});

test("lift rotations preserve top mounting and rotate wall mountings", () => {
  assert.deepEqual(
    rotateLiftMetadata({ blockId: "player-lift", orientation: "top", variantId: 0, genericId: 1, groupId: 1 }, 3),
    { blockId: "player-lift", orientation: "top", variantId: 0, genericId: 1, groupId: 1 },
  );
  assert.deepEqual(
    rotateLiftMetadata({ blockId: "player-lift", orientation: "north", variantId: 1, genericId: 2, groupId: 2 }, 1),
    { blockId: "player-lift", orientation: "east", variantId: 2, genericId: 4, groupId: 4 },
  );
  assert.deepEqual(
    rotateLiftMetadata({ blockId: "player-lift", orientation: "west", variantId: 4, genericId: 9, groupId: 9 }, 2),
    { blockId: "player-lift", orientation: "east", variantId: 2, genericId: 5, groupId: 5 },
  );
});

test("lift paint faces choose the stored orientation while state stays binary", () => {
  assert.equal(liftOrientationFromPaintFace({ face: "top", dx: 0, dy: 0 }), "top");
  assert.equal(liftOrientationFromPaintFace({ dx: 0, dy: -1 }), "north");
  assert.equal(liftOrientationFromPaintFace({ dx: 1, dy: 0 }), "east");
  assert.equal(liftOrientationFromPaintFace({ dx: 0, dy: 1 }), "south");
  assert.equal(liftOrientationFromPaintFace({ dx: -1, dy: 0 }), "west");
  assert.equal(liftOrientationFromPaintFace({ face: "bottom-face" }), null);
  assert.equal(liftGenericId(liftOrientationFromPaintFace({ dx: -1 }), false), 8);
  assert.equal(liftGenericId(liftOrientationFromPaintFace({ dx: -1 }), true), 9);
});
