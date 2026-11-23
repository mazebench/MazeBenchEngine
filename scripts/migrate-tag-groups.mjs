import {
  ensureDefaultSubtags,
  flattenSubtags,
  normalizeTestTagPlacement,
} from "../apps/web/app/testTags.mjs";
import {
  readProjectDirectory,
  writeProjectDirectory,
} from "./lib/project-store.mjs";

const projectDirectory = new URL("../project-data/", import.meta.url);
const project = await readProjectDirectory(projectDirectory);
const tags = ensureDefaultSubtags(flattenSubtags(project.tags ?? project.folders ?? []))
  .map((tag) => ({ ...tag, locked: false }));
const tests = project.tests.map((test) => {
  const placement = normalizeTestTagPlacement({
    directTagIds: test.tagIds ?? [test.folderId],
    preferredTagId: test.folderId,
  }, tags);
  return {
    ...test,
    folderId: placement.groupTagId,
    tagIds: placement.tagIds,
  };
});
const result = await writeProjectDirectory(projectDirectory, {
  ...project,
  schemaVersion: 15,
  tags,
  tests,
});
console.log(JSON.stringify({ ...result, groups: tags.filter((tag) => !tag.parentId).length }));
