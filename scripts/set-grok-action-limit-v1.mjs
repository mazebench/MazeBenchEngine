// Operator-only action-budget change for a paused Grok Build run. The game,
// transcript, model session, scores, and move history are preserved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { verifyGrokIntegrity } from "../benchmarking/grok/policy.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value)}\n`;

async function atomic(file, value) {
  const temporary = `${file}.${process.pid}.action-limit-tmp`;
  await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

export async function setGrokActionLimit({ projectRoot, directory, actionLimit = null }) {
  const runFile = path.join(directory, "run.json");
  const manifestFile = path.join(directory, "integrity.json");
  const checkpointFile = path.join(directory, "checkpoint.json");
  const originalRun = await readFile(runFile);
  const originalManifest = await readFile(manifestFile);
  const originalCheckpoint = await readFile(checkpointFile);
  const metadata = JSON.parse(originalRun);
  const manifest = JSON.parse(originalManifest);

  assert.equal(metadata.provider, "grok-build", "This operator tool accepts only Grok Build runs.");
  assert(["paused", "stopped"].includes(metadata.status), "Pause the run before changing its action limit.");
  assert(!existsSync(path.join(directory, "integrity-violation.json")), "Cannot modify an invalidated run.");
  assert.equal(digest(originalManifest), metadata.integrity?.manifest_sha256, "The original manifest changed.");
  assert.notEqual(metadata.action_limit, actionLimit, "The requested action limit is already active.");
  await verifyGrokIntegrity(projectRoot, directory, metadata);
  verifyCheckpoint(directory);

  const runtime = await BenchmarkGameRuntime.open(projectRoot, directory);
  assert.equal(runtime.internal.actionLimit, metadata.action_limit, "Saved engine limit does not match run metadata.");
  const before = {
    action_limit: metadata.action_limit,
    action_count: runtime.internal.actionCount,
    manifest_sha256: metadata.integrity.manifest_sha256,
    checkpoint_sha256: digest(originalCheckpoint)
  };
  const at = new Date().toISOString();
  const backupDirectory = path.join(
    os.homedir(), ".mazebench", "operator-backups",
    `${metadata.id}-action-limit-${at.replace(/[:.]/g, "-")}`
  );
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    copyFile(runFile, path.join(backupDirectory, "run.json")),
    copyFile(manifestFile, path.join(backupDirectory, "integrity.json")),
    copyFile(checkpointFile, path.join(backupDirectory, "checkpoint.json"))
  ]);

  try {
    runtime.internal.actionLimit = actionLimit;
    runtime.internal.updatedAt = at;
    await runtime.persist();

    manifest.configuration.action_limit = actionLimit;
    const encodedManifest = encode(manifest);
    metadata.action_limit = actionLimit;
    metadata.updated_at = at;
    metadata.integrity = {
      ...metadata.integrity,
      manifest_sha256: digest(encodedManifest),
      asset_count: Object.keys(manifest.files).length
    };
    metadata.operator_changes = [...(metadata.operator_changes || []), {
      kind: "action-limit",
      at,
      action_count: before.action_count,
      from: before.action_limit,
      to: actionLimit,
      reason: "Operator requested an unlimited run while preserving the active Grok session."
    }];

    await atomic(manifestFile, encodedManifest);
    await atomic(runFile, encode(metadata));
    await verifyGrokIntegrity(projectRoot, directory, metadata);
    verifyCheckpoint(directory);
    const reopened = await BenchmarkGameRuntime.open(projectRoot, directory);
    assert.equal(reopened.internal.actionLimit, actionLimit);
    assert.equal(reopened.internal.actionCount, before.action_count);

    const audit = {
      schema_version: 1,
      run_id: metadata.id,
      changed_at: at,
      action_count: before.action_count,
      from: before.action_limit,
      to: actionLimit,
      session_id: metadata.grok_session_id,
      original_manifest_sha256: before.manifest_sha256,
      updated_manifest_sha256: metadata.integrity.manifest_sha256,
      original_checkpoint_sha256: before.checkpoint_sha256,
      updated_checkpoint_sha256: digest(await readFile(checkpointFile)),
      backup: backupDirectory,
      preserved: ["game state", "scores", "move history", "transcript", "Grok session"]
    };
    await atomic(path.join(directory, `operator-action-limit-${at.replace(/[:.]/g, "-")}.json`), encode(audit));
    return audit;
  } catch (error) {
    await atomic(manifestFile, originalManifest);
    await atomic(runFile, originalRun);
    await atomic(checkpointFile, originalCheckpoint);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const id = process.argv[2];
  assert(/^run-[A-Za-z0-9-]+$/.test(id || ""), "Pass a valid run ID.");
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const directory = path.join(os.homedir(), "records", "mazebench-benchmark", id);
  console.log(JSON.stringify(await setGrokActionLimit({ projectRoot, directory, actionLimit: null }), null, 2));
}
