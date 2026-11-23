import test from "node:test";
import assert from "node:assert/strict";
import { rollingNovelty } from "../benchmarking/ui/novelty-series.mjs";

test("a run with non-novel first moves still begins at its novel initial state", () => {
  assert.deepEqual(rollingNovelty([true, false, false, true], 100), [1, 1 / 2, 1 / 3, 1 / 2]);
});

test("early windows use only recorded states, with no zero-filled prehistory", () => {
  for (const window of [10, 100, 1000]) {
    assert.deepEqual(rollingNovelty([true, true, true], window), [1, 1, 1]);
  }
});

test("the initial state leaves the rolling window and real repeated states count as zero", () => {
  assert.deepEqual(rollingNovelty([true, false, false, false, true], 3), [1, 1 / 2, 1 / 3, 0, 1 / 3]);
  assert.deepEqual(rollingNovelty([true, false, true], 1), [1, 0, 1]);
});

test("an unstarted run has one 100% point; absent data is not invented", () => {
  assert.deepEqual(rollingNovelty([true], 100), [1]);
  assert.deepEqual(rollingNovelty([], 100), []);
});
