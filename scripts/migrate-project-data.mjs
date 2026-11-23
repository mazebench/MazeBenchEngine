import assert from "node:assert/strict";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  readProjectDirectory,
  writeProjectDirectory,
} from "./lib/project-store.mjs";

const projectDirectory = fileURLToPath(new URL("../project-data", import.meta.url));
const legacyPath = fileURLToPath(new URL(
  "../project-data/voxelbench-project.json", import.meta.url));

function canonicalVoxel(voxel) {
  return JSON.stringify([
    voxel.x, voxel.y, voxel.z, voxel.blockId,
    voxel.genericId, voxel.groupId, voxel.instanceId, voxel.orientation,
    voxel.mechanismDepth, voxel.stateId, voxel.variantId,
  ]);
}

function canonicalProject(project) {
  return {
    ...project,
    schemaVersion: Math.max(12, Number(project.schemaVersion) || 0),
    tests: project.tests.map((test) => ({
      ...test,
      start: { voxels: test.start.voxels.map(canonicalVoxel).sort() },
      intermediate: (test.intermediate ?? []).map((frame) => ({
        voxels: frame.voxels.map(canonicalVoxel).sort(),
      })),
      expected: { voxels: test.expected.voxels.map(canonicalVoxel).sort() },
    })),
  };
}

const legacyText = await readFile(legacyPath, "utf8");
const legacy = JSON.parse(legacyText);
const result = await writeProjectDirectory(projectDirectory, legacy);
const restored = await readProjectDirectory(projectDirectory);
assert.deepEqual(canonicalProject(restored), canonicalProject(legacy));

const manifestBytes = (await stat(`${projectDirectory}/project.json`)).size;
const compactTestBytes = (await Promise.all(
  (await readdir(`${projectDirectory}/tests`))
    .filter((file) => file.endsWith(".json"))
    .map((file) => stat(`${projectDirectory}/tests/${file}`).then((entry) => entry.size)),
)).reduce((sum, bytes) => sum + bytes, 0);

await unlink(legacyPath);
console.log(JSON.stringify({
  ...result,
  legacyBytes: Buffer.byteLength(legacyText),
  compactBytes: manifestBytes + compactTestBytes,
  verified: true,
}));
