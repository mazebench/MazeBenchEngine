import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readProjectDirectory,
  readProjectBundle,
  writeProjectDirectory,
} from "../../../scripts/lib/project-store.mjs";
import { projectRevision, saveProjectRevision } from "../../../scripts/lib/project-revision.mjs";

function makeTest(id, blockId) {
  return {
    id,
    name: id,
    description: "",
    folderId: "folder",
    tagIds: ["folder-default"],
    hidden: false,
    locked: false,
    input: "up",
    world: { width: 16, height: 16, floorLayer: 0 },
    start: { voxels: [{ x: 1, y: 1, z: 0, blockId }] },
    intermediate: [],
    expected: { voxels: [{ x: 1, y: 2, z: 0, blockId }] },
  };
}

function makeProject(tests) {
  return {
    schemaVersion: 12,
    coordinateSystem: { floorLayer: 0 },
    roles: [],
    blocks: [],
    tags: [
      { id: "folder", name: "Folder" },
      { default: true, id: "folder-default", name: "Default", parentId: "folder" },
    ],
    searches: [],
    tests,
  };
}

test("split project store writes one compact file per test and removes stale files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voxelbench-project-store-"));
  try {
    const original = makeProject([
      makeTest("same/id", "player"),
      makeTest("same id", "box"),
    ]);
    const first = await writeProjectDirectory(directory, original);
    assert.equal(first.tests, 2);

    const manifest = JSON.parse(await readFile(join(directory, "project.json"), "utf8"));
    assert.equal(manifest.storageFormat, "voxelbench-split-project-v1");
    assert.equal(manifest.schemaVersion, 15);
    assert.deepEqual(manifest.tags, original.tags);
    assert.equal(Object.hasOwn(manifest, "folders"), false);
    assert.equal(Object.hasOwn(manifest.tests[0], "folderId"), false);
    assert.equal(manifest.tests[0].groupTagId, "folder");
    assert.equal(manifest.tests.length, 2);
    assert.notEqual(manifest.tests[0].file, manifest.tests[1].file);
    assert.equal((await readdir(join(directory, "tests"))).length, 2);

    const restored = await readProjectDirectory(new URL(`file://${directory}/`));
    assert.equal(restored.schemaVersion, 15);
    assert.deepEqual(restored.tags, original.tags);
    assert.deepEqual(restored.folders, original.tags);
    assert.deepEqual(restored.tests, original.tests);

    const reduced = makeProject([original.tests[1]]);
    const second = await writeProjectDirectory(directory, reduced);
    assert.equal(second.staleTestsRemoved, 1);
    assert.equal((await readdir(join(directory, "tests"))).length, 1);
    const restoredReduced = await readProjectDirectory(directory);
    assert.deepEqual(restoredReduced.tags, reduced.tags);
    assert.deepEqual(restoredReduced.tests, reduced.tests);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("revision saves reject stale tabs without removing newly authored tests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voxelbench-project-revision-"));
  try {
    const original = makeProject([makeTest("first", "player")]);
    await writeProjectDirectory(directory, original);
    const revision = projectRevision(await readProjectBundle(directory));
    const noRevision = await saveProjectRevision(directory, original);
    assert.equal(noRevision.status, 428);
    assert.equal(noRevision.saved, false);

    const newer = makeProject([...original.tests, makeTest("newly-authored", "box")]);
    await writeProjectDirectory(directory, newer);
    const stale = await saveProjectRevision(directory, original, revision);
    assert.equal(stale.status, 409);
    assert.equal(stale.saved, false);
    assert.deepEqual((await readProjectDirectory(directory)).tests, newer.tests);

    const currentRevision = projectRevision(await readProjectBundle(directory));
    newer.tests[0].description = "Fresh edit after loading the latest version";
    const accepted = await saveProjectRevision(directory, newer, currentRevision);
    assert.equal(accepted.saved, true);
    assert.equal(accepted.status, 200);
    assert.notEqual(accepted.revision, currentRevision);
    assert.equal(accepted.revision, projectRevision(await readProjectBundle(directory)));
    assert.deepEqual((await readProjectDirectory(directory)).tests, newer.tests);

    // Even metadata-only edits must invalidate a second tab's old revision.
    assert.equal((await saveProjectRevision(directory, original, currentRevision)).saved, false);
    assert.equal((await readProjectDirectory(directory)).tests.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a new project requires an explicit empty-project revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voxelbench-project-new-"));
  try {
    const original = makeProject([makeTest("first", "player")]);
    assert.equal((await saveProjectRevision(directory, original)).status, 428);
    const saved = await saveProjectRevision(directory, original, "*");
    assert.equal(saved.saved, true);
    assert.equal((await saveProjectRevision(directory, original, "*")).status, 409);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
