// Operator-only migration for the audited transport-notice classification fix.
// Not exposed to the agent MCP or HTTP. Only this exact source hash transition
// is permitted; state, scores, capabilities and prompts are never resealed.
import "../benchmarking/codex-releases.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRunIntegrity, verifyCheckpoint, assertRunConfiguration } from "../benchmarking/v1/integrity.mjs";
import { safeReadFile } from "../benchmarking/v1/safe-files.mjs";
import { discoverCodexCapabilityPolicy, verifyDirectToolModelCatalog, eventBoundaryViolation, isCodexTransportNotice } from "../benchmarking/v1/supervisor.mjs";
import { verifyClaudeIntegrity } from "../benchmarking/providers/claude-policy.mjs";
import { verifyIceIntegrity } from "../benchmarking/worlds/policy.mjs";

export const TRANSPORT_REPAIR_FILE = "benchmarking/v1/supervisor.mjs";
export const TRANSPORT_REPAIR_HASHES = {
  before: "99f4b7ec32a0e53a9b650f8365ee7d8a5850e48cd4a84dffd454d6ac64d74be3",
  after: "b41402c47d8a59a05e813df563d821711ad2ff7162c32724eeb4d141d590582c"
};
const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
async function atomic(file, value) {
  const temp = `${file}.${process.pid}.repair-tmp`;
  await writeFile(temp, value, { flag: "wx", mode: 0o600 }); await rename(temp, file);
}

export async function repairTransportRun(root, directory) {
  const originalRun = safeReadFile(directory, "run.json"), originalManifest = safeReadFile(directory, "integrity.json");
  const metadata = JSON.parse(originalRun), manifest = JSON.parse(originalManifest);
  assert(["paused", "stopped", "failed"].includes(metadata.status), "Pause active runs before applying the transport fix.");
  assert(!existsSync(path.join(directory, "integrity-violation.json")), "Integrity-invalidated runs cannot be repaired.");
  const failed = metadata.status === "failed";
  if (failed) {
    assert((metadata.provider || "codex") === "codex" && metadata.error === "Capability boundary violation: unexpected error. Run invalidated.", "Unrelated failures cannot be repaired.");
    const events = safeReadFile(directory, "agent-events.jsonl").trim().split(/\r?\n/).map(JSON.parse);
    assert(isCodexTransportNotice(events.at(-1)), "The failure was not the known transport notice.");
    for (const event of events) assert.equal(eventBoundaryViolation(event, { toolsEnabled: metadata.tools_enabled }), null, "Actual forbidden capability found in the event history.");
  }
  assert.equal(metadata.integrity?.manifest_sha256, digest(originalManifest), "Original manifest changed.");
  assertRunConfiguration(metadata, manifest);
  assert.equal(digest(safeReadFile(directory, "prompt.md")), metadata.effective_prompt_sha256, "Original prompt changed.");
  verifyCheckpoint(directory);
  const summary = JSON.parse(safeReadFile(directory, "summary.json"));
  assert(!["won", "action-limit"].includes(summary.game_status), "Completed games need no runtime migration.");
  assert.equal(manifest.files[TRANSPORT_REPAIR_FILE], TRANSPORT_REPAIR_HASHES.before, "Unexpected original runtime.");
  assert.equal(digest(await readFile(path.join(root, TRANSPORT_REPAIR_FILE))), TRANSPORT_REPAIR_HASHES.after, "Unexpected repaired runtime.");
  manifest.files[TRANSPORT_REPAIR_FILE] = TRANSPORT_REPAIR_HASHES.after;
  const encoded = encode(manifest), integrity = { ...metadata.integrity, manifest_sha256: digest(encoded) };
  // Verify all frozen files and provider/world checks against a private staging
  // checkpoint before writing even metadata in the original run.
  const staging = await mkdtemp(path.join(os.tmpdir(), "mazebench-transport-audit-"));
  try {
    await mkdir(path.join(staging, "sandbox-state"), { mode: 0o700 });
    for (const file of ["prompt.md", "game-state.json", "summary.json", "checkpoint.json", "sandbox-state/integrity-key"])
      await writeFile(path.join(staging, file), safeReadFile(directory, file, null), { mode: 0o600 });
    await writeFile(path.join(staging, "integrity.json"), encoded, { mode: 0o600 });
    await verifyRunIntegrity(root, staging, integrity);
    if ((metadata.provider || "codex") === "codex") {
      const policy = discoverCodexCapabilityPolicy();
      assert.equal(policy.codex_sha256, metadata.capability_policy.codex_sha256, "Codex binary changed.");
      const catalogFile = "sandbox-state/direct-model-catalog.json";
      await writeFile(path.join(staging, catalogFile), safeReadFile(directory, catalogFile, null), { mode: 0o600 });
      await verifyDirectToolModelCatalog(staging, metadata.model, metadata.capability_policy.model_catalog);
    } else {
      assert.equal(metadata.provider, "claude-code", "Unknown provider.");
      await verifyClaudeIntegrity(root, staging, { ...metadata, integrity });
    }
    if (metadata.world === "ice-maze") await verifyIceIntegrity(root, staging, { ...metadata, integrity });
    verifyCheckpoint(staging);
  } finally { await rm(staging, { recursive: true, force: true }); }
  const repair = { at: new Date().toISOString(), reason: "Allow the passive Codex WebSocket-to-HTTPS fallback notice without granting tools.",
    files: { [TRANSPORT_REPAIR_FILE]: TRANSPORT_REPAIR_HASHES }, previous_error: metadata.error || null,
    original_manifest_sha256: metadata.integrity.manifest_sha256, repaired_manifest_sha256: integrity.manifest_sha256,
    action_count: summary.action_count, codex_thread_id: metadata.codex_thread_id || null, claude_session_id: metadata.claude_session_id || null,
    game_state_sha256: digest(safeReadFile(directory, "game-state.json", null)), summary_sha256: digest(safeReadFile(directory, "summary.json", null)) };
  const backup = path.join(directory, "repairs", "transport-notice-v1");
  await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 }); await mkdir(backup, { mode: 0o700 });
  for (const [name, value] of [["run.before.json", originalRun], ["integrity.before.json", originalManifest], ["repair.json", encode(repair)]])
    await writeFile(path.join(backup, name), value, { flag: "wx", mode: 0o600 });
  metadata.integrity = integrity;
  metadata.runtime_repairs = [...(metadata.runtime_repairs || []), repair];
  if (failed) { metadata.status = "paused"; metadata.paused_at = repair.at; metadata.updated_at = repair.at; }
  await atomic(path.join(directory, "integrity.json"), encoded);
  await atomic(path.join(directory, "run.json"), encode(metadata));
  await verifyRunIntegrity(root, directory, integrity); verifyCheckpoint(directory);
  return { id: metadata.id, status: metadata.status, action_count: summary.action_count, backup };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.argv[2];
  if (!/^run-[0-9TZ-]+-[a-f0-9]{6}$/.test(id || "")) throw new Error("Usage: node scripts/repair-benchmark-transport-v1.mjs <run-id>");
  const root = path.resolve(import.meta.dirname, ".."), records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records/mazebench-benchmark");
  console.log(JSON.stringify(await repairTransportRun(root, path.join(records, id)), null, 2));
}
