import assert from "node:assert/strict";
import test from "node:test";
import { auditContradictions, describeTest, immutableTestFingerprint } from "../../scripts/lib/test-audit.mjs";

const frame = (x) => ({ voxels: [{ x, y: 1, z: 1, blockId: "player" }] });
const fixture = () => ({ id: "a", name: "Untitled test", description: "", input: "up", folderId: "movement", world: { width: 4, height: 4, floorLayer: 0 }, start: frame(0), intermediate: [], expected: frame(1) });
const project = (tests) => ({ blocks: [{ id: "player", name: "Player", roleId: "player" }], roles: [{ id: "player" }], tags: [{ id: "movement", name: "Movement" }], tests });

test("audit detects contradictory tick counts, states and cycles including hidden cases", () => {
  for (const patch of [{ expected: frame(2) }, { intermediate: [frame(1)] }, { cycle: { startTick: 0, repeatTick: 1 } }]) {
    const result = auditContradictions(project([fixture(), { ...fixture(), ...patch, id: "b", hidden: true }]));
    assert.equal(result.contradictions.length, 1);
    assert.equal(result.contradictions[0][1].hidden, true);
    assert.equal(result.duplicates.length, 0);
  }
});

test("audit distinguishes duplicate expectations from genuinely different starts", () => {
  assert.equal(auditContradictions(project([fixture(), { ...fixture(), id: "b" }])).duplicates.length, 1);
  assert.deepEqual(auditContradictions(project([fixture(), { ...fixture(), id: "b", start: frame(2) }])), { contradictions: [], duplicates: [] });
});

test("documentation describes authored ticks without changing test geometry", () => {
  const original = fixture();
  const snapshot = structuredClone(original);
  const result = describeTest(original, project([original]));
  assert.match(result.description, /exactly 1 tick after Start/);
  assert.match(result.description, /Tick 1: Player moves 1 east/);
  assert.deepEqual(original, snapshot);
  assert.equal(immutableTestFingerprint(original), immutableTestFingerprint({ ...original, name: result.generatedTitle, description: result.description }));
  assert.notEqual(immutableTestFingerprint(original), immutableTestFingerprint({ ...original, expected: frame(2) }));
});
