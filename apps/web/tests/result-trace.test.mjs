import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldShowResultComparison,
  traceFrameLabel,
} from "../app/resultTrace.mjs";

test("successful engine results never open the comparison panel", () => {
  assert.equal(shouldShowResultComparison({ pass: true }), false);
  assert.equal(shouldShowResultComparison(undefined), false);
  assert.equal(shouldShowResultComparison({ pass: false }), true);
});

test("trace frames distinguish authored ticks, the final frame, and extra engine ticks", () => {
  assert.equal(traceFrameLabel(0, 4), "Start");
  assert.equal(traceFrameLabel(1, 4), "Tick 1");
  assert.equal(traceFrameLabel(3, 4), "Final · tick 3");
  assert.equal(traceFrameLabel(4, 4), "Extra engine tick 4");
});
