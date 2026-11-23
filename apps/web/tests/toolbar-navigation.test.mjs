import assert from "node:assert/strict";
import test from "node:test";

import {
  genericToolbarLabel,
  MAX_GENERIC_OBJECT_ID,
  offsetGenericObjectId,
  offsetToolbarIndex,
} from "../app/toolbarNavigation.mjs";

test("left and right wrap through toolbar slots", () => {
  assert.equal(offsetToolbarIndex(0, 5, 1), 1);
  assert.equal(offsetToolbarIndex(4, 5, 1), 0);
  assert.equal(offsetToolbarIndex(0, 5, -1), 4);
  assert.equal(offsetToolbarIndex(3, 5, -1), 2);
});

test("left and right adjust generic IDs without leaving their valid range", () => {
  assert.equal(offsetGenericObjectId(8, -1), 7);
  assert.equal(offsetGenericObjectId(8, 1), 9);
  assert.equal(offsetGenericObjectId(0, -1), null);
  assert.equal(offsetGenericObjectId(MAX_GENERIC_OBJECT_ID, 1), MAX_GENERIC_OBJECT_ID);
  assert.equal(offsetGenericObjectId(0, 1, 1), 1);
  assert.equal(offsetGenericObjectId(1, 1, 1), 1);
});

test("only the active generic toolbar tile shows its chosen number", () => {
  assert.equal(genericToolbarLabel("weightless", "weightless", 27, false), "27");
  assert.equal(genericToolbarLabel("weightless", "crate", 27, false), "N");
  assert.equal(genericToolbarLabel("weightless", "weightless", 27, true), "N");
});
