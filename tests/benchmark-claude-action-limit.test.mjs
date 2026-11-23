import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeClaudeActionLimit } from "../scripts/remove-claude-action-limit-v1.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { createRunIntegrity, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { digest, providerRuntimeHashes, verifyClaudeIntegrity } from "../benchmarking/providers/claude-policy.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("remove an incremental Claude limit without changing its game, session, prompt or frozen assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-budget-"));
  const directory = path.join(root, "run"), backupDirectory = path.join(root, "backup");
  try {
    await mkdir(directory, { mode: 0o700 });
    const binary = path.join(root, "binary");
    await writeFile(binary, "test binary");
    const prompt = "Original 100-action prompt";
    const configuration = { storage_format: "incremental-v1", provider: "claude-code", claude_policy: "claude-mcp-only-v1",
      claude_version: "2.1.284", claude_executable: binary, claude_sha256: digest("test binary"),
      provider_runtime: await providerRuntimeHashes(projectRoot), model: "claude-sonnet-5-5", effort: "max",
      tools_enabled: false, action_limit: 100, start_room: "HxI", effective_prompt_sha256: digest(prompt) };
    const metadata = { ...configuration, id: "test-run", status: "paused", claude_session_id: "preserved-session",
      integrity: await createRunIntegrity(projectRoot, directory, configuration) };
    await writeFile(path.join(directory, "run.json"), JSON.stringify(metadata));
    await writeFile(path.join(directory, "prompt.md"), prompt);
    const runtime = await BenchmarkGameRuntime.create(projectRoot, directory, { incremental: true, actionLimit: 100 });
    for (let i = 0; i < 100; i++) await runtime.apply("camera left");
    assert.equal(runtime.status(), "action-limit");
    const before = structuredClone(runtime.internal);
    const originalManifest = JSON.parse(await readFile(path.join(directory, "integrity.json")));
    const options = { projectRoot, directory, backupDirectory, assertInactive: async () => {} };
    await assert.rejects(() => removeClaudeActionLimit({ ...options, assertInactive: async () => { throw new Error("still active"); } }), /still active/);
    const result = await removeClaudeActionLimit(options);
    assert.equal(result.action_count, 100);
    const reopened = await BenchmarkGameRuntime.open(projectRoot, directory);
    assert.deepEqual(reopened.internal, { ...before, actionLimit: null, updatedAt: reopened.internal.updatedAt });
    const updated = JSON.parse(await readFile(path.join(directory, "run.json")));
    assert.equal(updated.claude_session_id, metadata.claude_session_id);
    assert.equal(await readFile(path.join(directory, "prompt.md"), "utf8"), prompt);
    const manifest = JSON.parse(await readFile(path.join(directory, "integrity.json")));
    assert.deepEqual(manifest, { ...originalManifest, configuration: { ...originalManifest.configuration, action_limit: null } });
    await verifyClaudeIntegrity(projectRoot, directory, updated);
    verifyCheckpoint(backupDirectory);
    const backup = await BenchmarkGameRuntime.open(projectRoot, backupDirectory);
    assert.deepEqual(backup.internal, before);
    await reopened.apply("camera right");
    assert.equal(reopened.internal.actionCount, 101);
    assert.equal(reopened.status(), "playing");
  } finally { await rm(root, { recursive: true, force: true }); }
});
