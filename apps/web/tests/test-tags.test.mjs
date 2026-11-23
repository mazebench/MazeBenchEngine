import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalTagCombination,
  combinationViewIncludesTest,
  defaultSubtagId,
  directSubtagViewIncludesTest,
  directTagsIncludeTag,
  ensureDefaultSubtags,
  flattenSubtags,
  normalizeTestTagPlacement,
  rootTagId,
  tagCombinationKey,
  testUsesTag,
} from "../app/testTags.mjs";

const tagList = [
  { id: "physics", name: "Physics" },
  { default: true, id: "physics-default", name: "Default", parentId: "physics" },
  { id: "ice", name: "Ice", parentId: "physics" },
  { id: "slopes", name: "Slopes", parentId: "physics" },
  { id: "orange", name: "Orange" },
  { default: true, id: "orange-default", name: "Default", parentId: "orange" },
];
const tags = new Map([
  ["physics", tagList[0]],
  ["physics-default", tagList[1]],
  ["ice", tagList[2]],
  ["slopes", tagList[3]],
  ["orange", tagList[4]],
  ["orange-default", tagList[5]],
]);

test("a direct subtag assignment belongs to itself and its parent group", () => {
  assert.equal(directTagsIncludeTag(["slopes"], "slopes", tags), true);
  assert.equal(directTagsIncludeTag(["slopes"], "ice", tags), false);
  assert.equal(directTagsIncludeTag(["slopes"], "physics", tags), true);
  assert.equal(directTagsIncludeTag(["slopes"], "orange", tags), false);
});

test("multiple direct tags independently contribute inherited membership", () => {
  assert.equal(directTagsIncludeTag(["slopes", "orange"], "physics", tags), true);
  assert.equal(directTagsIncludeTag(["slopes", "orange"], "orange", tags), true);
});

test("legacy sub-subtags are promoted directly under their root group", () => {
  const flattened = flattenSubtags([
    { id: "physics", name: "Physics" },
    { id: "ice", name: "Ice", parentId: "physics" },
    { id: "slopes", name: "Slopes", parentId: "ice" },
  ]);
  assert.equal(flattened.find((tag) => tag.id === "slopes")?.parentId, "physics");
  assert.deepEqual(flattenSubtags(flattened), flattened);
});

test("multi-subtag cases only appear in their exact derived combination", () => {
  const order = new Map(tagList.map((tag, index) => [tag.id, index]));
  assert.equal(directSubtagViewIncludesTest(["ice"], "ice"), true);
  assert.equal(directSubtagViewIncludesTest(["ice", "slopes"], "ice"), false);
  assert.deepEqual(canonicalTagCombination(["slopes", "ice", "slopes"], order), ["ice", "slopes"]);
  assert.equal(combinationViewIncludesTest(["slopes", "ice"], ["ice", "slopes"], order), true);
  assert.equal(combinationViewIncludesTest(["ice", "slopes"], ["ice"], order), false);
  assert.equal(tagCombinationKey(["slopes", "ice"], order), tagCombinationKey(["ice", "slopes"], order));
});

test("combination cases keep every constituent subtag non-empty for deletion", () => {
  const combinationCase = { folderId: "physics", tagIds: ["ice", "slopes"] };
  assert.equal(testUsesTag(combinationCase, tagList[0]), true);
  assert.equal(testUsesTag(combinationCase, tagList[2]), true);
  assert.equal(testUsesTag(combinationCase, tagList[3]), true);
  assert.equal(testUsesTag(combinationCase, tagList[4]), false);
  assert.equal(testUsesTag({ folderId: "physics", tagIds: ["ice"] }, tagList[3]), false);
});

test("tag placement keeps only subtags from one parent group", () => {
  assert.deepEqual(normalizeTestTagPlacement({
    preferredTagId: "physics",
    directTagIds: ["slopes", "orange-default"],
  }, tagList), {
    groupTagId: "physics",
    tagIds: ["slopes"],
  });
});

test("root-only placement migrates into the group's Default subtag", () => {
  assert.deepEqual(normalizeTestTagPlacement({
    preferredTagId: "physics",
    directTagIds: ["physics"],
  }, tagList), {
    groupTagId: "physics",
    tagIds: ["physics-default"],
  });
  assert.equal(defaultSubtagId("physics", tagList), "physics-default");
  assert.equal(rootTagId("slopes", tags), "physics");
});

test("Default is removed when a real subtag is present", () => {
  assert.deepEqual(normalizeTestTagPlacement({
    preferredTagId: "physics",
    directTagIds: ["physics-default", "ice"],
  }, tagList).tagIds, ["ice"]);
});

test("every parent group receives exactly one stable Default subtag", () => {
  const seeded = ensureDefaultSubtags([
    { id: "one", name: "One" },
    { id: "two", name: "Two" },
    { id: "two-default", name: "Default", parentId: "two" },
  ]);
  assert.equal(defaultSubtagId("one", seeded), "one-default");
  assert.equal(defaultSubtagId("two", seeded), "two-default");
  assert.equal(seeded.filter((tag) => tag.default).length, 2);
  assert.deepEqual(ensureDefaultSubtags(seeded), seeded);
});
