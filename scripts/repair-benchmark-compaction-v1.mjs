// Operator-only, explicitly requested repair for the September 4 compaction
// transport bug. Not exposed to MCP or HTTP. Never reseal arbitrary changes.
import "../benchmarking/codex-releases.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRunIntegrity, verifyCheckpoint, assertRunConfiguration, CAPABILITY_POLICY_VERSION } from "../benchmarking/v1/integrity.mjs";
import { safeReadFile } from "../benchmarking/v1/safe-files.mjs";
import { discoverCodexCapabilityPolicy, verifyDirectToolModelCatalog, isRecoverableCompactionError } from "../benchmarking/v1/supervisor.mjs";

export const COMPACTION_REPAIR_FILES = {
  "benchmarking/v1/supervisor.mjs": {
    before: "5d70851b17ec110b00580244da16a64b28005802ba4ee314cfa5218a1a5209db",
    after: "b41402c47d8a59a05e813df563d821711ad2ff7162c32724eeb4d141d590582c"
  },
  "benchmarking/v1/run.mjs": {
    before: "322740e7490fa671ca81ffdc44266f29d534c11e8a603c46cf04de2f28d3bdee",
    after: "08b8857a222e63bc23b0cbf9b0f57825b1ea2da33001d85eef62a1a4e7b45872"
  }
};
const sha256 = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;

async function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.repair-tmp`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

export async function repairCompactionRun(projectRoot, runDirectory) {
  const originalRun = safeReadFile(runDirectory, "run.json");
  const originalManifest = safeReadFile(runDirectory, "integrity.json");
  const metadata = JSON.parse(originalRun);
  const manifest = JSON.parse(originalManifest);
  assert.equal(metadata.status, "failed", "Only an inactive failed run can be repaired.");
  assert(isRecoverableCompactionError(metadata.error), "This failure is not the known compaction transport bug.");
  assert(!existsSync(path.join(runDirectory, "integrity-violation.json")), "Integrity-invalidated runs cannot be repaired.");
  assert.equal(metadata.capability_policy?.version, CAPABILITY_POLICY_VERSION);
  assert.equal(metadata.integrity?.manifest_sha256, sha256(originalManifest), "Original manifest was altered.");
  assert.equal(sha256(safeReadFile(runDirectory, "prompt.md")), metadata.effective_prompt_sha256, "Original prompt was altered.");
  assertRunConfiguration(metadata, manifest);
  verifyCheckpoint(runDirectory);
  const policy = discoverCodexCapabilityPolicy();
  assert.equal(policy.codex_sha256, metadata.capability_policy.codex_sha256, "Codex binary changed.");
  await verifyDirectToolModelCatalog(runDirectory, metadata.model, metadata.capability_policy.model_catalog);
  for (const [file, hashes] of Object.entries(COMPACTION_REPAIR_FILES)) {
    assert.equal(manifest.files[file], hashes.before, `Unexpected original runtime: ${file}`);
    assert.equal(sha256(await readFile(path.join(projectRoot, file))), hashes.after, `Unexpected repaired runtime: ${file}`);
    manifest.files[file] = hashes.after;
  }
  const newManifest = encode(manifest);
  const integrity = { ...metadata.integrity, manifest_sha256: sha256(newManifest) };
  // Verify the complete inventory and every other asset BEFORE touching the run.
  const staging = await mkdtemp(path.join(os.tmpdir(), "mazebench-repair-check-"));
  try {
    await writeFile(path.join(staging, "integrity.json"), newManifest, { mode: 0o600 });
    await verifyRunIntegrity(projectRoot, staging, integrity);
  } finally { await rm(staging, { recursive: true, force: true }); }
  const summary = JSON.parse(safeReadFile(runDirectory, "summary.json"));
  assert(!["won", "action-limit"].includes(summary.game_status), "Run is already finished.");
  const repair = {
    at: new Date().toISOString(), reason: "Restore remote compaction v2; enable resume after the legacy compaction endpoint returned 404.",
    files: COMPACTION_REPAIR_FILES,
    original_manifest_sha256: metadata.integrity.manifest_sha256,
    repaired_manifest_sha256: integrity.manifest_sha256,
    action_count: summary.action_count, codex_thread_id: metadata.codex_thread_id,
    game_state_sha256: sha256(safeReadFile(runDirectory, "game-state.json", null)),
    summary_sha256: sha256(safeReadFile(runDirectory, "summary.json", null)),
    previous_error: metadata.error
  };
  const backup = path.join(runDirectory, "repairs", "remote-compaction-v2");
  await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
  await mkdir(backup, { mode: 0o700 });
  await writeFile(path.join(backup, "run.before.json"), originalRun, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(backup, "integrity.before.json"), originalManifest, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(backup, "repair.json"), encode(repair), { flag: "wx", mode: 0o600 });
  metadata.integrity = integrity;
  metadata.capability_policy.disabled_features = policy.disabled_features;
  metadata.capability_policy.enabled_features = policy.enabled_features;
  metadata.runtime_repairs = [...(metadata.runtime_repairs || []), repair];
  await atomicWrite(path.join(runDirectory, "integrity.json"), newManifest);
  await atomicWrite(path.join(runDirectory, "run.json"), encode(metadata));
  await verifyRunIntegrity(projectRoot, runDirectory, integrity);
  verifyCheckpoint(runDirectory);
  return { id: metadata.id, action_count: summary.action_count, codex_thread_id: metadata.codex_thread_id, backup };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.argv[2];
  if (!/^run-[0-9TZ-]+-[a-f0-9]{6}$/.test(id || "")) throw new Error("Usage: node scripts/repair-benchmark-compaction-v1.mjs <run-id>");
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const recordsRoot = path.resolve(process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records", "mazebench-benchmark"));
  console.log(JSON.stringify(await repairCompactionRun(projectRoot, path.join(recordsRoot, id)), null, 2));
}
