import assert from "node:assert/strict";
import test from "node:test";
import { ImportEstimate } from "../replays/v1/progress.mjs";

test("import ETA measures observed work, formats minutes:seconds and accounts for stalls", () => {
  const estimate = new ImportEstimate();
  estimate.update(0, 100, "Preparing replay", 0);
  assert.equal(estimate.label(0), "Estimating time…");
  estimate.update(10, 100, "Preparing replay", 10000);
  assert.equal(estimate.label(10000), "~1:30 remaining in this step");
  assert.equal(estimate.label(20000), "~3:00 remaining in this step", "a stall must not keep counting down to zero");
  estimate.update(99, 100, "Preparing replay", 21000);
  assert.equal(estimate.label(21000), "~0:01 remaining in this step");
  estimate.update(100, 100, "Preparing replay", 22000);
  assert.equal(estimate.label(22000), "Finishing…");
  estimate.update(1, 1, "Ready", 23000);
  assert.equal(estimate.label(23000), "0:00 remaining");
});

test("import ETA resets for new stages, changed totals, repeated passes and cancelled imports", () => {
  const estimate = new ImportEstimate();
  estimate.update(0, 100, "Reading saved routes", 0);
  estimate.update(50, 100, "Reading saved routes", 1000);
  assert.equal(estimate.label(1000), "~0:01 remaining in this step");
  estimate.update(0, 100, "Reading saved routes", 2000);
  assert.equal(estimate.label(2000), "Estimating time…");
  estimate.update(20, 100, "Reading saved routes", 3000);
  assert.equal(estimate.label(3000), "~0:04 remaining in this step");
  estimate.update(20, 200, "Reading saved routes", 4000);
  assert.equal(estimate.label(4000), "Estimating time…");
  estimate.update(20, 200, "Drawing world", 5000);
  assert.equal(estimate.label(5000), "Estimating time…");
  estimate.update(40, 200, "Drawing world", 6000);
  assert.equal(estimate.label(6000), "~0:08 remaining in this step");
  estimate.reset();
  assert.equal(estimate.label(7000), "Estimating time…");
});

test("world preload slices estimate only the remaining work in their own stage", () => {
  const estimate = new ImportEstimate();
  // The page may have preloaded half the rooms before the import begins.
  estimate.update(25, 100, "Loading rooms", 0);
  estimate.update(40, 100, "Loading rooms", 3000);
  assert.equal(estimate.label(3000), "~0:02 remaining in this step");
  estimate.update(50, 100, "Loading rooms", 5000);
  assert.equal(estimate.label(5000), "Finishing…");
  estimate.update(50, 100, "Loading models", 5000);
  estimate.update(55, 100, "Loading models", 6000);
  assert.equal(estimate.label(6000), "~0:02 remaining in this step");
  estimate.update(65, 100, "Loading models", 8000);
  assert.equal(estimate.label(8000), "Finishing…");
});
