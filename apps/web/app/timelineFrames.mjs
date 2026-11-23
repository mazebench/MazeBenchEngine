import { adjustCycleForInsertedTick } from "./cycleExpectation.mjs";

export function intermediateInsertionIndex(frameKind, intermediateIndex, length) {
  if (Number.isInteger(intermediateIndex)) {
    return Math.min(length, Math.max(0, intermediateIndex + 1));
  }
  return frameKind === "start" ? 0 : length;
}

export function insertIntermediateFrame(test, frameKind, intermediateIndex) {
  const insertionIndex = intermediateInsertionIndex(
    frameKind,
    intermediateIndex,
    test.intermediate.length,
  );
  const source = Number.isInteger(intermediateIndex)
    ? test.intermediate[intermediateIndex]
    : frameKind === "start"
      ? test.start
      : test.intermediate.at(-1) ?? test.start;
  const intermediate = [...test.intermediate];
  intermediate.splice(insertionIndex, 0, {
    voxels: source.voxels.map((voxel) => ({ ...voxel })),
  });
  const insertedTick = insertionIndex + 1;
  return {
    insertionIndex,
    test: adjustCycleForInsertedTick({ ...test, intermediate }, insertedTick),
  };
}

export function previousExpectedFrame(test, frameKind, intermediateIndex) {
  if (Number.isInteger(intermediateIndex)) {
    return intermediateIndex === 0
      ? test.start
      : test.intermediate[intermediateIndex - 1];
  }
  if (frameKind === "expected") return test.intermediate.at(-1) ?? test.start;
  return null;
}

export function offsetTimelineSelection(
  frameKind,
  intermediateIndex,
  intermediateCount,
  offset,
) {
  const currentIndex = Number.isInteger(intermediateIndex)
    ? intermediateIndex + 1
    : frameKind === "start"
      ? 0
      : intermediateCount + 1;
  const nextIndex = Math.max(0, Math.min(intermediateCount + 1, currentIndex + offset));
  if (nextIndex === 0) return { frameKind: "start", intermediateIndex: null };
  if (nextIndex === intermediateCount + 1) {
    return { frameKind: "expected", intermediateIndex: null };
  }
  return { frameKind: "expected", intermediateIndex: nextIndex - 1 };
}
