// Operator-only migration for Grok 1.0.40 interrupted-session recovery.
// Only the reviewed Grok policy/runner hash change is admitted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { grokRuntimeHashes, verifyGrokIntegrity } from "../benchmarking/grok/policy.mjs";
import { readJournal } from "../benchmarking/storage/journal.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value)}\n`;

async function atomic(file, value) {
  const temporary = `${file}.${process.pid}.grok-resume-tmp`;
  await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

export async function upgradeGrokResumeFork({ projectRoot, directory }) {
  const runFile = path.join(directory, "run.json");
  const manifestFile = path.join(directory, "integrity.json");
  const violationFile = path.join(directory, "integrity-violation.json");
  const originalRun = await readFile(runFile);
  const originalManifest = await readFile(manifestFile);
  const metadata = JSON.parse(originalRun);
  const manifest = JSON.parse(originalManifest);
  const violation = existsSync(violationFile) ? JSON.parse(await readFile(violationFile)) : null;

  assert.equal(metadata.provider, "grok-build");
  assert(["failed", "paused", "stopped"].includes(metadata.status), "The run must be inactive.");
  assert.equal(digest(originalManifest), metadata.integrity?.manifest_sha256);
  if (violation) assert([
    "Unexpected Grok tool catalog: .",
    "Grok provider runtime changed; start a new run.",
    "Grok model routing changed: expected grok-4.7, received grok-4.6.",
    "Grok emitted unexpected event type system."
  ].includes(violation.error), "Refusing to clear an unrelated integrity violation.");

  const current = await grokRuntimeHashes(projectRoot);
  const summary = await readJournal(directory, "summary");
  const changed = Object.keys(current).filter(file => current[file] !== manifest.configuration.grok_runtime?.[file]).sort();
  assert(changed.length > 0 && changed.every(file => ["benchmarking/grok/policy.mjs", "benchmarking/grok/runner.mjs", "benchmarking/grok/supervisor.mjs"].includes(file)));
  assert.deepEqual(Object.keys(current), Object.keys(manifest.configuration.grok_runtime));

  const at = new Date().toISOString();
  const backupDirectory = path.join(
    os.homedir(), ".mazebench", "operator-backups",
    `${metadata.id}-grok-resume-${at.replace(/[:.]/g, "-")}`
  );
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    copyFile(runFile, path.join(backupDirectory, "run.json")),
    copyFile(manifestFile, path.join(backupDirectory, "integrity.json")),
    ...(violation ? [copyFile(violationFile, path.join(backupDirectory, "integrity-violation.json"))] : [])
  ]);

  manifest.configuration.grok_runtime = current;
  const encodedManifest = encode(manifest);
  metadata.integrity = {
    ...metadata.integrity,
    manifest_sha256: digest(encodedManifest),
    asset_count: Object.keys(manifest.files).length
  };
  metadata.runtime_repairs = [...(metadata.runtime_repairs || []), {
    kind: "grok-interrupted-session-fork",
    at,
    action_count: summary.action_count,
    reason: "Grok 1.0.40 advertises an empty tool catalog when directly reopening an interrupted session. Fork the preserved conversation so the exact MCP gateway allowlist is rebuilt."
  }];

  try {
    await atomic(manifestFile, encodedManifest);
    await atomic(runFile, encode(metadata));
    if (violation) await rename(violationFile, path.join(backupDirectory, "cleared-integrity-violation.json"));
    await verifyGrokIntegrity(projectRoot, directory, metadata);
    return {
      id: metadata.id,
      action_count: summary.action_count,
      action_limit: metadata.action_limit,
      session_id: metadata.grok_session_id,
      updated_files: changed,
      manifest_sha256: metadata.integrity.manifest_sha256,
      backup: backupDirectory,
      cleared_violation: violation?.error || null
    };
  } catch (error) {
    await atomic(manifestFile, originalManifest);
    await atomic(runFile, originalRun);
    if (violation && !existsSync(violationFile)) await copyFile(path.join(backupDirectory, "integrity-violation.json"), violationFile);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const id = process.argv[2];
  assert(/^run-[A-Za-z0-9-]+$/.test(id || ""), "Pass a valid run ID.");
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const directory = path.join(os.homedir(), "records", "mazebench-benchmark", id);
  console.log(JSON.stringify(await upgradeGrokResumeFork({ projectRoot, directory }), null, 2));
}
