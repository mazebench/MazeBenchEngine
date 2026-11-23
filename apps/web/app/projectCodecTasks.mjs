import { cellCoordinateKey, cellObjectSemanticKey } from "./cellObjects.mjs";
import { decodeProjectPayload, encodeProjectBundle } from "./projectFormat.mjs";
import { applyWorldToTest } from "./worldBounds.mjs";

function sortedFrame(frame) {
  return { voxels: [...frame.voxels].sort((a, b) =>
    cellCoordinateKey(a).localeCompare(cellCoordinateKey(b)) ||
    cellObjectSemanticKey(a).localeCompare(cellObjectSemanticKey(b)) ||
    String(a.instanceId ?? "").localeCompare(String(b.instanceId ?? ""))) };
}

// Keep the existing on-disk format and canonical ordering. Only the thread
// doing the cropping, frame deltas, and JSON work changes.
export function processProjectCodecTask(operation, value) {
  if (operation === "decode") return decodeProjectPayload(JSON.parse(value));
  if (operation !== "encode") throw new Error(`Unknown project operation: ${operation}`);
  const tests = value.tests.map((test) => {
    const bounded = applyWorldToTest({ ...test, input: "up" }, test.world);
    return {
      ...bounded,
      start: sortedFrame(bounded.start),
      intermediate: bounded.intermediate.map(sortedFrame),
      expected: sortedFrame(bounded.expected),
    };
  });
  return JSON.stringify(encodeProjectBundle({ ...value, tests }));
}

// The browser sends only changed test objects after the first save. Rebuild
// each requested snapshot by its explicit order, including deletions/reorders.
export function createProjectCodecTaskProcessor() {
  let savedTests = new Map();
  return (operation, value) => {
    if (operation !== "encode-incremental") return processProjectCodecTask(operation, value);
    const { project, changedTests, testOrder } = value;
    const updated = new Map(savedTests);
    for (const test of changedTests) updated.set(test.id, test);
    const tests = testOrder.map((id) => {
      if (!updated.has(id)) throw new Error(`Missing project test: ${id}`);
      return updated.get(id);
    });
    savedTests = new Map(tests.map((test) => [test.id, test]));
    return processProjectCodecTask("encode", { ...project, tests });
  };
}
