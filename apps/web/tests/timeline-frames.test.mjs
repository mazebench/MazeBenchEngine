import assert from "node:assert/strict";
import test from "node:test";
import {
  insertIntermediateFrame,
  intermediateInsertionIndex,
  offsetTimelineSelection,
  previousExpectedFrame,
} from "../app/timelineFrames.mjs";

const frame = (id) => ({ voxels: [{ x: id, y: 0, z: 0, blockId: "floor" }] });
const timeline = {
  start: frame(0),
  intermediate: [frame(1), frame(2)],
  expected: frame(3),
};

test("new ticks are inserted after the selected frame or before Expected", () => {
  assert.equal(intermediateInsertionIndex("start", null, 2), 0);
  assert.equal(intermediateInsertionIndex("expected", 0, 2), 1);
  assert.equal(intermediateInsertionIndex("expected", null, 2), 2);
});

test("adding a tick copies the selected frame without aliasing its voxels", () => {
  const { insertionIndex, test: inserted } = insertIntermediateFrame(
    timeline,
    "expected",
    0,
  );
  assert.equal(insertionIndex, 1);
  assert.deepEqual(inserted.intermediate.map((item) => item.voxels[0].x), [1, 1, 2]);
  assert.notEqual(inserted.intermediate[0], inserted.intermediate[1]);
  assert.notEqual(inserted.intermediate[0].voxels[0], inserted.intermediate[1].voxels[0]);
});

test("copy previous resolves Start, prior ticks, and the frame before Expected", () => {
  assert.equal(previousExpectedFrame(timeline, "expected", 0), timeline.start);
  assert.equal(previousExpectedFrame(timeline, "expected", 1), timeline.intermediate[0]);
  assert.equal(previousExpectedFrame(timeline, "expected", null), timeline.intermediate[1]);
  assert.equal(previousExpectedFrame(timeline, "start", null), null);
});

test("Shift arrows walk through Start, every tick, and Expected", () => {
  assert.deepEqual(offsetTimelineSelection("start", null, 2, 1), {
    frameKind: "expected",
    intermediateIndex: 0,
  });
  assert.deepEqual(offsetTimelineSelection("expected", 0, 2, 1), {
    frameKind: "expected",
    intermediateIndex: 1,
  });
  assert.deepEqual(offsetTimelineSelection("expected", 1, 2, 1), {
    frameKind: "expected",
    intermediateIndex: null,
  });
  assert.deepEqual(offsetTimelineSelection("expected", null, 2, -1), {
    frameKind: "expected",
    intermediateIndex: 1,
  });
  assert.deepEqual(offsetTimelineSelection("start", null, 2, -1), {
    frameKind: "start",
    intermediateIndex: null,
  });
});
