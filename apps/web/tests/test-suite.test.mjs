import assert from "node:assert/strict";
import test from "node:test";

import { deleteTestCase, runnableTestCases, summarizeTestResults } from "../app/testSuite.mjs";
import { testUsesTag } from "../app/testTags.mjs";

const tests = [
  { folderId: "movement", id: "wall" },
  { folderId: "push", id: "push-one" },
  { folderId: "push", id: "push-two" },
  { folderId: "ice", id: "slide" },
];

test("deleting the active test selects the next test in its folder", () => {
  assert.deepEqual(deleteTestCase(tests, "push-one", "push-one"), {
    activeId: "push-two",
    removed: tests[1],
    tests: [tests[0], tests[2], tests[3]],
  });
});

test("deleting another test preserves the active test", () => {
  assert.equal(deleteTestCase(tests, "wall", "slide").activeId, "slide");
});

test("the final test cannot be deleted", () => {
  const finalTest = [{ folderId: "movement", id: "wall" }];
  assert.deepEqual(deleteTestCase(finalTest, "wall", "wall"), {
    activeId: "wall",
    removed: null,
    tests: finalTest,
  });
});

test("hidden cases are retained in the project but excluded from physics runs", () => {
  const cases = [
    { id: "implemented", hidden: false },
    { id: "future", hidden: true },
    { id: "legacy-without-flag" },
  ];
  assert.deepEqual(
    runnableTestCases(cases).map((item) => item.id),
    ["implemented", "legacy-without-flag"],
  );
  assert.equal(cases.length, 3);
});

test("group status is green only when every active case has passed", () => {
  const cases = [{ id: "a" }, { id: "b" }];
  assert.equal(summarizeTestResults(cases, {}).state, "pending");
  assert.equal(summarizeTestResults(cases, { a: { pass: true } }).state, "pending");
  assert.deepEqual(summarizeTestResults(cases, { a: { pass: true }, b: { pass: true } }), {
    state: "pass", active: 2, passed: 2, failed: 0, pending: 0, hidden: 0,
  });
});

test("one failure makes the group red even if other cases have not run", () => {
  assert.deepEqual(summarizeTestResults([{ id: "a" }, { id: "b" }], { a: { pass: false } }), {
    state: "fail", active: 2, passed: 0, failed: 1, pending: 1, hidden: 0,
  });
});

test("hidden failures neither turn groups red nor prevent a green badge", () => {
  const cases = [{ id: "a" }, { id: "b", hidden: true }];
  const result = summarizeTestResults(cases, { a: { pass: true }, b: { pass: false } });
  assert.equal(result.state, "pass");
  assert.equal(result.active, 1);
  assert.equal(result.hidden, 1);
});

test("empty and all-hidden groups remain neutral", () => {
  assert.equal(summarizeTestResults([], {}).state, "empty");
  assert.equal(summarizeTestResults([{ id: "a", hidden: true }], { a: { pass: false } }).state, "empty");
});

test("deleted and invalidated results cannot produce stale green group badges", () => {
  assert.equal(summarizeTestResults([{ id: "new" }], { old: { pass: true } }).state, "pending");
  assert.equal(summarizeTestResults([{ id: "edited" }], {}).state, "pending");
  assert.equal(summarizeTestResults([{ id: "a" }], { a: { pass: true }, deleted: { pass: false } }).state, "pass");
});

test("combined-subtag failures propagate to both subtags and their parent only", () => {
  const cases = [
    { id: "a", folderId: "physics", tagIds: ["ice"] },
    { id: "b", folderId: "physics", tagIds: ["ice", "boxes"] },
    { id: "c", folderId: "other", tagIds: ["other-default"] },
  ];
  const results = { a: { pass: true }, b: { pass: false }, c: { pass: true } };
  const groups = [
    { id: "physics" },
    { id: "ice", parentId: "physics" },
    { id: "boxes", parentId: "physics" },
    { id: "other" },
  ];
  assert.deepEqual(groups.map(group => summarizeTestResults(cases.filter(t => testUsesTag(t, group)), results).state), ["fail", "fail", "fail", "pass"]);
});
