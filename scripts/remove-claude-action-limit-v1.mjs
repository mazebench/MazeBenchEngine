// Operator-only change. Preserve the complete authenticated journal and session;
// never refresh runtime hashes or rewrite the original benchmark prompt.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { digest, verifyClaudeIntegrity } from "../benchmarking/providers/claude-policy.mjs";

const encode = value => `${JSON.stringify(value)}\n`;
async function atomic(file, bytes) {
  const temporary = `${file}.${process.pid}.action-limit-tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

export async function removeClaudeActionLimit({ projectRoot, directory, backupDirectory, assertInactive }) {
  assert.equal(typeof assertInactive, "function", "An operator liveness check is required.");
  await assertInactive();
  const runFile = path.join(directory, "run.json"), manifestFile = path.join(directory, "integrity.json");
  const originalRun = await readFile(runFile), originalManifest = await readFile(manifestFile);
  const metadata = JSON.parse(originalRun), manifest = JSON.parse(originalManifest);
  assert.equal(metadata.provider, "claude-code");
  assert.equal(metadata.storage_format, "incremental-v1");
  assert(["paused", "stopped"].includes(metadata.status), "Pause the run first.");
  assert(metadata.claude_session_id, "Keep the existing Claude session.");
  assert.equal(metadata.action_limit, 100, "This repair only removes the accidental 100-action limit.");
  assert(!existsSync(path.join(directory, "integrity-violation.json")), "Cannot modify an invalidated run.");
  await verifyClaudeIntegrity(projectRoot, directory, metadata);
  const runtime = await BenchmarkGameRuntime.open(projectRoot, directory);
  assert.equal(runtime.internal.actionLimit, 100);
  const before = structuredClone(runtime.internal);
  const at = new Date().toISOString();
  // The backup includes every journal generation, checkpoint, frame, and key.
  await mkdir(backupDirectory, { mode: 0o700 });
  await cp(directory, backupDirectory, { recursive: true, force: false });
  await assertInactive();
  assert((await readFile(runFile)).equals(originalRun), "Run changed during preparation.");
  try {
    runtime.internal.actionLimit = null;
    runtime.internal.updatedAt = at;
    await runtime.persist();
    manifest.configuration.action_limit = null;
    const encodedManifest = encode(manifest);
    metadata.action_limit = null;
    metadata.updated_at = at;
    metadata.integrity = { ...metadata.integrity, manifest_sha256: digest(encodedManifest) };
    const audit = {
      kind: "action-limit", at, action_count: before.actionCount, from: 100, to: null,
      reason: "Operator requested unlimited moves for the existing Sonnet 5.5 pair.",
      session_id: metadata.claude_session_id, backup: backupDirectory,
      original_manifest_sha256: digest(originalManifest), updated_manifest_sha256: digest(encodedManifest)
    };
    metadata.operator_changes = [...(metadata.operator_changes || []), audit];
    await atomic(manifestFile, encodedManifest);
    await atomic(runFile, encode(metadata));
    await verifyClaudeIntegrity(projectRoot, directory, metadata);
    const reopened = await BenchmarkGameRuntime.open(projectRoot, directory);
    assert.deepEqual(reopened.internal, { ...before, actionLimit: null, updatedAt: at });
    await atomic(path.join(directory, `operator-action-limit-${at.replace(/[:.]/g, "-")}.json`), encode(audit));
    return { id: metadata.id, action_limit: null, action_count: before.actionCount, session_id: metadata.claude_session_id, backup: backupDirectory };
  } catch (error) {
    // Restore the original committed head; any appended suffix remains uncommitted.
    await cp(backupDirectory, directory, { recursive: true, force: true });
    await verifyClaudeIntegrity(projectRoot, directory, JSON.parse(originalRun));
    throw error;
  }
}
