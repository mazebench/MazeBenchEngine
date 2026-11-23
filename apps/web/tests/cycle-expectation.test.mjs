import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustCycleForDeletedTick,
  adjustCycleForInsertedTick,
  clearCycleExpectation,
  compareCycleExpectation,
  markCycleRepeat,
  markCycleStart,
  normalizeCycleExpectation,
  tickIsInCycle,
} from "../app/cycleExpectation.mjs";

const frames = (count) => Array.from({ length: count }, () => ({ voxels: [] }));

test("cycle comparison accepts absent or identical metadata", () => {
  const cycle = { startTick: 2, repeatTick: 4, onCycle: "rollback-command" };
  assert.equal(compareCycleExpectation(undefined, null), null);
  assert.equal(compareCycleExpectation(cycle, { ...cycle }), null);
});

test("matching voxel frames do not hide missing or unexpected cycles", () => {
  const cycle = { startTick: 2, repeatTick: 4, onCycle: "rollback-command" };
  assert.match(compareCycleExpectation(cycle, null), /Engine cycle: none/);
  assert.match(compareCycleExpectation(null, cycle), /Expected cycle: none/);
});

test("cycle comparison rejects different periods and rollback policies", () => {
  const cycle = { startTick: 2, repeatTick: 4, onCycle: "rollback-command" };
  for (const changed of [{ startTick: 1 }, { repeatTick: 5 }, { onCycle: "stop" }]) {
    assert.notEqual(compareCycleExpectation(cycle, { ...cycle, ...changed }), null);
  }
});

test("a cycle records its first state, repeated state, period, and rollback policy", () => {
  const source = { intermediate: frames(12) };
  const withStart = markCycleStart(source, 6);
  const marked = markCycleRepeat(withStart, 12);
  assert.deepEqual(marked.cycle, {
    startTick: 6,
    repeatTick: 12,
    onCycle: "rollback-command",
  });
  assert.equal(marked.cycle.repeatTick - marked.cycle.startTick, 6);
  assert.equal(tickIsInCycle(marked.cycle, 5), false);
  assert.equal(tickIsInCycle(marked.cycle, 6), true);
  assert.equal(tickIsInCycle(marked.cycle, 12), true);
});

test("invalid imported cycle markers are rejected", () => {
  assert.equal(normalizeCycleExpectation({ startTick: 4, repeatTick: 4 }, 10), null);
  assert.equal(normalizeCycleExpectation({ startTick: 4, repeatTick: 11 }, 10), null);
  assert.deepEqual(normalizeCycleExpectation({ startTick: 0, repeatTick: 8 }, 8), {
    startTick: 0,
    repeatTick: 8,
    onCycle: "rollback-command",
  });
});

test("timeline edits preserve only cycle markers that remain semantically valid", () => {
  const source = {
    intermediate: frames(12),
    cycle: { startTick: 6, repeatTick: 12, onCycle: "rollback-command" },
  };
  assert.deepEqual(adjustCycleForInsertedTick(source, 2).cycle, {
    startTick: 7,
    repeatTick: 13,
    onCycle: "rollback-command",
  });
  assert.equal(adjustCycleForInsertedTick(source, 8).cycle, undefined);
  assert.equal(adjustCycleForDeletedTick(source, 10).cycle, undefined);
  assert.equal(clearCycleExpectation(source).cycle, undefined);
});
