import assert from "node:assert/strict";
import test from "node:test";
import { perspectiveNearForDistance } from "../public/mazebench-runtime/joined-voxel-surface.mjs";

const depth = (z, near, far) => far / (far - near) - far * near / ((far - near) * z);

test("lowered plates retain distinct depth values at every distant zoom", () => {
  // A 24-bit depth buffer must distinguish a gate 0.012 cells above its support.
  for (const distance of [80, 100, 250, 500, 800, 1000]) {
    const near = perspectiveNearForDistance(distance);
    const separation = depth(distance, near, 1600) - depth(distance - 0.012, near, 1600);
    assert(separation * 2 ** 24 > 5, `insufficient plate precision at ${distance}`);
    assert(near < distance / 32, "near clipping stays close to the eye");
  }
  const oldSeparation = depth(1000, 0.05, 1600) - depth(999.988, 0.05, 1600);
  assert(oldSeparation * 2 ** 24 < 1, "regression fixture must fail with the old fixed near plane");
});

test("close editing keeps its original clipping distance in either renderer's scale", () => {
  for (const distance of [0, 7, 16, 40, 64]) {
    assert.equal(perspectiveNearForDistance(distance), 0.05);
    assert.equal(perspectiveNearForDistance(distance * 64, 64, 4.8), 4.8);
  }
  for (const distance of [100, 500, 1000]) {
    assert.equal(perspectiveNearForDistance(distance * 64, 64, 4.8) / 64,
      perspectiveNearForDistance(distance));
  }
});
