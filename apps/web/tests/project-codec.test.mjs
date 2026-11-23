import assert from "node:assert/strict";
import test from "node:test";
import { createProjectCodecTaskProcessor, processProjectCodecTask } from "../app/projectCodecTasks.mjs";
import { decodeProjectPayload, encodeProjectBundle } from "../app/projectFormat.mjs";
import { cellCoordinateKey, cellObjectSemanticKey } from "../app/cellObjects.mjs";
import { applyWorldToTest } from "../app/worldBounds.mjs";

const voxels = [
  { x: 1, y: 2, z: -3, blockId: "slope", orientation: "left", variantId: 0, stateId: null, instanceId: "a" },
  { x: 1, y: 2, z: -3, blockId: "lift", genericId: 0 },
  { x: 2, y: 1, z: 8, blockId: "box", genericId: 7, groupId: 7 },
  { x: 2, y: 1, z: 8, blockId: "box", genericId: 7, groupId: 7 },
  { x: 10, y: 1, z: 0, blockId: "outside" },
];
const project = {
  schemaVersion: 15,
  coordinateSystem: { horizontalAxes: ["x", "y"], verticalAxis: "z", floorLayer: 0 },
  blocks: [{ id: "box", roleId: "pushable", visual: { kind: "cube" } }],
  roles: [{ id: "pushable", generic: true }], tags: [{ id: "tag", name: "Tag" }],
  searches: [{ id: "search", start: { voxels } }],
  tests: [{ id: "example", name: "Example", description: "metadata", folderId: "tag", tagIds: ["tag"],
    input: "up", locked: true, hidden: true, world: { width: 5, height: 4, floorLayer: 0 },
    cycle: { startTick: 1, repeatTick: 2 }, start: { voxels },
    intermediate: [{ voxels: voxels.slice(1) }], expected: { voxels: voxels.slice(2) } }],
};

// Independent baseline reproduces the original editor save path, including
// ordering, bounds, overlapping records, and timeline metadata.
function legacySave(value) {
  const sorted = frame => ({ voxels: [...frame.voxels].sort((a, b) =>
    cellCoordinateKey(a).localeCompare(cellCoordinateKey(b)) ||
    cellObjectSemanticKey(a).localeCompare(cellObjectSemanticKey(b)) ||
    String(a.instanceId ?? "").localeCompare(String(b.instanceId ?? ""))) });
  const tests = value.tests.map(original => {
    const bounded = applyWorldToTest({ ...original, input: "up" }, original.world);
    return { ...bounded, start: sorted(bounded.start), intermediate: bounded.intermediate.map(sorted), expected: sorted(bounded.expected) };
  });
  return JSON.stringify(encodeProjectBundle({ ...value, tests }));
}

test("background project codec preserves the editor's exact saved bytes", () => {
  const original = structuredClone(project);
  const encoded = processProjectCodecTask("encode", project);
  assert.equal(encoded, legacySave(project));
  assert.deepEqual(project, original, "Saving must not mutate the editor snapshot");
  const decoded = processProjectCodecTask("decode", encoded);
  assert.deepEqual(decoded, decodeProjectPayload(JSON.parse(encoded)));
  assert.equal(decoded.tests[0].start.voxels.length, 4);
  assert.equal(decoded.tests[0].start.voxels.filter(voxel => voxel.z < 0).length, 2);
  assert.deepEqual(decoded.tests[0].cycle, project.tests[0].cycle);
  assert.deepEqual(decoded.searches, project.searches);
});

test("codec rejects corrupt input and unknown operations instead of producing a save", () => {
  assert.throws(() => processProjectCodecTask("decode", "not JSON"));
  assert.throws(() => processProjectCodecTask("encode", { tests: [null] }));
  assert.throws(() => processProjectCodecTask("invalid", project), /Unknown project operation/);
});

test("incremental saves preserve unchanged tests, ordering, deletions, and later revisions", () => {
  const processTask = createProjectCodecTaskProcessor();
  const { tests: [first], ...metadata } = project;
  const second = { ...first, id: "second", name: "Second" };
  const encode = (changedTests, testOrder, meta = metadata) => processTask("encode-incremental", { project: meta, changedTests, testOrder });
  assert.equal(encode([first, second], [first.id, second.id]), legacySave({ ...metadata, tests: [first, second] }));
  const changed = { ...first, description: "Edited", expected: { voxels: voxels.slice(0, 2) } };
  assert.equal(encode([changed], [second.id, first.id]), legacySave({ ...metadata, tests: [second, changed] }));
  assert.equal(encode([], [first.id]), legacySave({ ...metadata, tests: [changed] }));
  const updatedMetadata = { ...metadata, searches: [] };
  assert.equal(encode([], [first.id], updatedMetadata), legacySave({ ...updatedMetadata, tests: [changed] }));
  assert.throws(() => encode([], [second.id]), /Missing project test/);
  assert.equal(encode([second], [first.id, second.id]), legacySave({ ...metadata, tests: [changed, second] }));
});
