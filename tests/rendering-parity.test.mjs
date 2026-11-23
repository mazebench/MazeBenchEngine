import assert from "node:assert/strict";
import test from "node:test";
import * as canonical from "../apps/web/public/mazebench-runtime/joined-voxel-surface.mjs";
import * as browser from "../ui/joined-voxel-surface.mjs";

test("test-lab and world rendering share the exact module implementations", () => {
  assert.deepEqual(Object.keys(browser), Object.keys(canonical));
  for (const key of Object.keys(canonical)) assert.equal(browser[key], canonical[key], key);
});
