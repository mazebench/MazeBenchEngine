// Operator-only repair for the requested September 21 Grok code run. These
// exact source transitions were reviewed; no other asset drift is admitted.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertRunConfiguration, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { readCheckpointJson } from "../benchmarking/v1/checkpoint-json.mjs";
import { digest, verifyGrokIntegrity } from "../benchmarking/grok/policy.mjs";

const changes = [
  ["files", "benchmarking/v1/codex-installation.mjs", "c6cd70187cf7bf2d72cba9e1806b7c7996bcf91eb32c19d9afa5341c447924f2", "9c62c7546c0c88fc1505259f1e80646cee28acb7770ba17e48743b084e34f428"],
  ["files", "benchmarking/v1/runtime.mjs", "cca05ef626880f907ca23ef7b23640fcc5fb0c21d99109c643d7f0208459bf65", "4df6576d0a4f3af3a16d86b3232c9eca4effe79ebd52ba3a1a0779901705b181"],
  ["files", "benchmarking/v1/supervisor.mjs", "d4c1ffdddf85053c15096f3114d31e133522af89c9b4bed02ab4474774074966", "4923d9662fefa513d6b65033dbbb4fffcf17ad6620b35138c23c99993eb02774"],
  ["grok_runtime", "benchmarking/grok/policy.mjs", "a78fe6d20bd6088299d87e5a23746ec70ad0ab109cf732c671e08e9ade4740b0", "d1ec8c05ae7d35a95b710617b055cf7addd36131ad6f9ba8c8a2634952128197"]
];

async function atomic(file, bytes) {
  const temporary = `${file}.${process.pid}.resume-repair-tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

export async function repairGrokSeptemberResume({ projectRoot, directory, backupDirectory, assertInactive }) {
  assert.equal(typeof assertInactive, "function");
  await assertInactive();
  const originalRun = await readFile(path.join(directory, "run.json"));
  const originalManifest = await readFile(path.join(directory, "integrity.json"));
  const checkpoint = await readFile(path.join(directory, "checkpoint.json"));
  const metadata = JSON.parse(originalRun), manifest = JSON.parse(originalManifest);
  assert.equal(metadata.id, "run-2026-09-21T18-02-58-432Z-ddbd31");
  assert.equal(metadata.provider, "grok-build");
  assert.equal(metadata.model, "grok-4.7");
  assert.equal(metadata.tools_enabled, true);
  assert.equal(metadata.action_limit, null);
  assert(["failed", "paused", "stopped"].includes(metadata.status));
  assert(!existsSync(path.join(directory, "integrity-violation.json")));
  assert.equal(digest(originalManifest), metadata.integrity.manifest_sha256);
  assertRunConfiguration(metadata, manifest);
  verifyCheckpoint(directory);
  const before = await readCheckpointJson(directory);
  assert.equal(before.actionCount, 1422);
  for (const [group, file, oldHash, newHash] of changes) {
    const hashes = group === "files" ? manifest.files : manifest.configuration[group];
    assert.equal(hashes[file], oldHash, `Unexpected original file: ${file}`);
    assert.equal(digest(await readFile(path.join(projectRoot, file))), newHash, `Unexpected replacement: ${file}`);
    hashes[file] = newHash;
  }
  const encoded = JSON.stringify(manifest) + "\n";
  metadata.integrity = { ...metadata.integrity, manifest_sha256: digest(encoded) };
  metadata.runtime_repairs = [...(metadata.runtime_repairs || []), {
    kind: "operator-grok-resume-runtime-update", at: new Date().toISOString(), action_count: before.actionCount,
    reason: "Resume the requested Grok code run on the reviewed current runtime: permanent collected gems, Codex-only compaction compatibility, and verified CLI version lists. Keep Grok 1.0.40, model, tools, prompt, conversation and checkpoint unchanged.",
    files: Object.fromEntries(changes.map(([,file,before,after]) => [file,{before,after}])),
    original_manifest_sha256: digest(originalManifest), updated_manifest_sha256: digest(encoded),
    checkpoint_sha256: digest(checkpoint), session_id: metadata.grok_session_id, backup: backupDirectory
  }];
  const staging = await mkdtemp(path.join(os.tmpdir(), "mazebench-grok-resume-"));
  try {
    const candidate = path.join(staging, "run");
    await cp(directory, candidate, { recursive: true });
    await writeFile(path.join(candidate, "integrity.json"), encoded);
    // This rejects all drift outside the four exact transitions, including
    // executable, tools, prompt, engine, world and authenticated journal changes.
    await verifyGrokIntegrity(projectRoot, candidate, metadata);
    assert.deepEqual(await readCheckpointJson(candidate), before);
    await assertInactive();
    assert((await readFile(path.join(directory, "run.json"))).equals(originalRun));
    assert((await readFile(path.join(directory, "checkpoint.json"))).equals(checkpoint));
    await mkdir(backupDirectory, { mode: 0o700 });
    await cp(directory, backupDirectory, { recursive: true, force: false });
    try {
      await atomic(path.join(directory, "integrity.json"), encoded);
      await atomic(path.join(directory, "run.json"), JSON.stringify(metadata) + "\n");
      await verifyGrokIntegrity(projectRoot, directory, metadata);
      assert((await readFile(path.join(directory, "checkpoint.json"))).equals(checkpoint));
      assert.deepEqual(await readCheckpointJson(directory), before);
    } catch (error) {
      await atomic(path.join(directory, "integrity.json"), originalManifest);
      await atomic(path.join(directory, "run.json"), originalRun);
      throw error;
    }
    return { id: metadata.id, action_count: before.actionCount, game_unchanged: true, session_id: metadata.grok_session_id, backup: backupDirectory };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
