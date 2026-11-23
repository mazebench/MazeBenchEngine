// Operator-only recovery for a Grok Build session that the 1.0.40 CLI can no
// longer restore as Grok 4.7. Game state and every benchmark artifact remain.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyGrokIntegrity } from "../benchmarking/grok/policy.mjs";
import { readJournal } from "../benchmarking/storage/journal.mjs";

const encode = value => `${JSON.stringify(value)}\n`;
async function atomic(file, value) {
  const temporary = `${file}.${process.pid}.session-recovery-tmp`;
  await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

export async function recoverGrokSession({ projectRoot, directory }) {
  const runFile = path.join(directory, "run.json");
  const violationFile = path.join(directory, "integrity-violation.json");
  const originalRun = await readFile(runFile);
  const metadata = JSON.parse(originalRun);
  assert.equal(metadata.provider, "grok-build");
  assert(["failed", "paused", "stopped"].includes(metadata.status), "The run must be inactive.");
  assert(metadata.grok_session_id || metadata.grok_session_history?.length, "There is no Grok session history to preserve.");
  await verifyGrokIntegrity(projectRoot, directory, metadata);
  const summary = await readJournal(directory, "summary");
  const at = new Date().toISOString();
  const backupDirectory = path.join(
    os.homedir(), ".mazebench", "operator-backups",
    `${metadata.id}-fresh-grok-session-${at.replace(/[:.]/g, "-")}`
  );
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await copyFile(runFile, path.join(backupDirectory, "run.json"));
  if (existsSync(violationFile)) await copyFile(violationFile, path.join(backupDirectory, "integrity-violation.json"));

  const priorSession = metadata.grok_session_id;
  if (priorSession) metadata.grok_session_history = [...(metadata.grok_session_history || []), {
      session_id: priorSession,
      ended_at: at,
      action_count: summary.action_count,
      reason: "Grok Build 1.0.40 could not restore the interrupted Grok 4.7 session without changing model or losing its advertised tool catalog."
    }];
  metadata.grok_session_id = null;
  metadata.grok_session_recovery = "fresh";
  metadata.error = null;
  metadata.updated_at = at;

  try {
    await atomic(runFile, encode(metadata));
    if (existsSync(violationFile)) await rename(violationFile, path.join(backupDirectory, "cleared-integrity-violation.json"));
    await verifyGrokIntegrity(projectRoot, directory, metadata);
    return {
      id: metadata.id,
      action_count: summary.action_count,
      action_limit: metadata.action_limit,
      preserved_session_id: priorSession,
      recovery: "fresh-grok-4.7-session",
      backup: backupDirectory
    };
  } catch (error) {
    await atomic(runFile, originalRun);
    if (!existsSync(violationFile) && existsSync(path.join(backupDirectory, "integrity-violation.json"))) {
      await copyFile(path.join(backupDirectory, "integrity-violation.json"), violationFile);
    }
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const id = process.argv[2];
  assert(/^run-[A-Za-z0-9-]+$/.test(id || ""), "Pass a valid run ID.");
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const directory = path.join(os.homedir(), "records", "mazebench-benchmark", id);
  console.log(JSON.stringify(await recoverGrokSession({ projectRoot, directory }), null, 2));
}
