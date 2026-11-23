import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withRunnerLiveness } from "../benchmarking/server-lifecycle.mjs";
import { resumeExclusively } from "../benchmarking/storage/resume-lock.mjs";

async function fixture(t, status = "continuing") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mazebench-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metadata = { id: "run-fixture", status, codex_thread_id: "session-fixture", model: "test-model" };
  await writeFile(path.join(directory, "run.json"), JSON.stringify(metadata));
  await writeFile(path.join(directory, "checkpoint.json"), "untouched checkpoint");
  class FakeSupervisor {
    active = new Map();
    calls = 0;
    checks = 0;
    runDirectory() { return directory; }
    async get() {
      return { ...JSON.parse(await readFile(path.join(directory, "run.json"), "utf8")), runner_active: this.active.has(metadata.id) };
    }
    async verifyRunCapabilityBoundary() { this.checks += 1; }
    async resume(id) {
      const run = await this.get(id);
      assert.equal(run.status, "stopped");
      this.calls += 1;
      this.active.set(id, {});
      return { ...run, status: "continuing", runner_active: true };
    }
  }
  const supervisor = new (withRunnerLiveness(FakeSupervisor))();
  supervisor.runnerProcessListing = async () => "123 unrelated-process";
  return { supervisor, directory, metadata };
}

test("inactive execution labels become interrupted without changing saved metadata", async t => {
  for (const status of ["queued", "running", "continuing", "pausing", "paused", "stopped", "failed", "completed"]) {
    const { supervisor, metadata, directory } = await fixture(t, status);
    const result = await supervisor.get(metadata.id);
    assert.equal(result.status, ["queued", "running", "continuing", "pausing"].includes(status) ? "interrupted" : status);
    assert.equal(JSON.parse(await readFile(path.join(directory, "run.json"), "utf8")).status, status);
    supervisor.active.set(metadata.id, {});
    assert.equal((await supervisor.get(metadata.id)).status, status);
  }
});

test("interrupted recovery resumes once and preserves the game checkpoint and configuration", async t => {
  const { supervisor, metadata, directory } = await fixture(t);
  const first = resumeExclusively(supervisor, metadata.id);
  await assert.rejects(resumeExclusively(supervisor, metadata.id), /already resuming/);
  assert.equal((await first).runner_active, true);
  assert.equal(supervisor.calls, 1);
  assert.equal(supervisor.checks, 1);
  const saved = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8"));
  assert.equal(saved.model, metadata.model);
  assert.equal(saved.codex_thread_id, metadata.codex_thread_id);
  assert.equal(saved.recoveries.at(-1).previous_status, "continuing");
  assert.equal(await readFile(path.join(directory, "checkpoint.json"), "utf8"), "untouched checkpoint");
});

test("a surviving process or failed integrity check blocks recovery without changing metadata", async t => {
  for (const failure of ["run-id", "session-id", "integrity", "process-inspection"]) {
    const { supervisor, metadata, directory } = await fixture(t);
    const before = await readFile(path.join(directory, "run.json"), "utf8");
    if (failure === "run-id") supervisor.runnerProcessListing = async () => `123 node mcp ${metadata.id}`;
    if (failure === "session-id") supervisor.runnerProcessListing = async () => `123 codex exec resume ${metadata.codex_thread_id}`;
    if (failure === "integrity") supervisor.verifyRunCapabilityBoundary = async () => { throw new Error("Runtime changed"); };
    if (failure === "process-inspection") supervisor.runnerProcessListing = async () => { throw new Error("Cannot inspect processes"); };
    await assert.rejects(resumeExclusively(supervisor, metadata.id));
    assert.equal(supervisor.calls, 0);
    assert.equal(await readFile(path.join(directory, "run.json"), "utf8"), before);
  }
});
