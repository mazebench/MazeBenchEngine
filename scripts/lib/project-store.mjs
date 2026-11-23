import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPACT_BUNDLE_FORMAT,
  COMPACT_TEST_FORMAT,
  SPLIT_PROJECT_FORMAT,
  decodeCompactTest,
  decodeProjectPayload,
  encodeCompactTest,
} from "../../apps/web/app/projectFormat.mjs";

const MANIFEST_NAME = "project.json";
const TEST_DIRECTORY_NAME = "tests";

function directoryPath(projectDirectory) {
  return projectDirectory instanceof URL
    ? fileURLToPath(projectDirectory)
    : projectDirectory;
}

function safeTestFileName(id, used) {
  const original = String(id);
  let stem = original.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!stem) stem = "test";
  let candidate = `${stem}.json`;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${stem}-${suffix++}.json`;
  used.add(candidate);
  return candidate;
}

async function writeIfChanged(path, contents) {
  try {
    if (await readFile(path, "utf8") === contents) return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
  return true;
}

function assertProject(project) {
  const tags = project?.tags ?? project?.folders;
  if (!project || typeof project !== "object" ||
      !Number.isInteger(project.schemaVersion) ||
      !Array.isArray(project.roles) || !Array.isArray(project.blocks) ||
      !Array.isArray(tags) || !Array.isArray(project.tests)) {
    throw new Error("Invalid VoxelBench project data");
  }
}

export async function readProjectBundle(projectDirectory) {
  projectDirectory = directoryPath(projectDirectory);
  const manifestPath = join(projectDirectory, MANIFEST_NAME);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const legacy = JSON.parse(await readFile(
      join(projectDirectory, "voxelbench-project.json"), "utf8"));
    assertProject(legacy);
    return {
      ...legacy,
      schemaVersion: Math.max(12, Number(legacy.schemaVersion) || 0),
      storageFormat: COMPACT_BUNDLE_FORMAT,
      tests: legacy.tests.map(encodeCompactTest),
    };
  }
  if (manifest.storageFormat !== SPLIT_PROJECT_FORMAT ||
      !Array.isArray(manifest.tests)) {
    throw new Error("Invalid split VoxelBench project manifest");
  }
  const tests = await Promise.all(manifest.tests.map(async (entry) => {
    const fileName = basename(String(entry.file));
    const compact = JSON.parse(await readFile(
      join(projectDirectory, TEST_DIRECTORY_NAME, fileName), "utf8"));
    if (compact.storageFormat !== COMPACT_TEST_FORMAT || compact.id !== entry.id) {
      throw new Error(`Test index mismatch for ${entry.id}`);
    }
    return compact;
  }));
  return {
    ...manifest,
    storageFormat: COMPACT_BUNDLE_FORMAT,
    tests,
  };
}

export async function readProjectDirectory(projectDirectory) {
  return decodeProjectPayload(await readProjectBundle(projectDirectory));
}

export async function writeProjectDirectory(projectDirectory, payload) {
  projectDirectory = directoryPath(projectDirectory);
  const project = decodeProjectPayload(payload);
  assertProject(project);
  const testDirectory = join(projectDirectory, TEST_DIRECTORY_NAME);
  await mkdir(testDirectory, { recursive: true });

  const usedFiles = new Set();
  const index = [];
  let changedTests = 0;
  for (const test of project.tests) {
    const file = safeTestFileName(test.id, usedFiles);
    const compact = encodeCompactTest(test);
    const changed = await writeIfChanged(
      join(testDirectory, file), `${JSON.stringify(compact)}\n`);
    if (changed) ++changedTests;
    index.push({
      id: test.id,
      name: test.name,
      groupTagId: test.folderId,
      tagIds: test.tagIds ?? [test.folderId],
      file,
    });
  }

  const manifest = {
    schemaVersion: Math.max(15, Number(project.schemaVersion) || 0),
    storageFormat: SPLIT_PROJECT_FORMAT,
    coordinateSystem: project.coordinateSystem,
    roles: project.roles,
    blocks: project.blocks,
    tags: project.tags ?? project.folders,
    searches: project.searches ?? [],
    tests: index,
  };
  await writeIfChanged(
    join(projectDirectory, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);

  const staleFiles = (await readdir(testDirectory)).filter((file) =>
    file.endsWith(".json") && !usedFiles.has(file));
  for (const file of staleFiles) await unlink(join(testDirectory, file));
  return {
    changedTests,
    staleTestsRemoved: staleFiles.length,
    tests: project.tests.length,
  };
}
