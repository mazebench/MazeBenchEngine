// Bounded subscription-backed smoke test; never uses the production records root.
import "../benchmarking/codex-releases.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { BenchmarkSupervisor } from "../benchmarking/v1/supervisor.mjs";
import { readJson } from "../benchmarking/providers/claude-runner.mjs";

const root = path.resolve(import.meta.dirname, "..");
const model = process.argv[2] || "gpt-6.1-sol";
const supervisor = new BenchmarkSupervisor(root, {
  recordsRoot: path.join(os.homedir(), "records/mazebench-validation/codex-" + Date.now())
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ids = [];
console.log("Validation records: " + supervisor.recordsRoot);
try {
  const pair = await supervisor.launchPair({ model, effort: "max", action_limit: 2 });
  ids.push(...pair.runs.map(run => run.id));
  console.log(JSON.stringify({ pair_id: pair.pair_id, runs: ids }));
  const deadline = Date.now() + 240000;
  while (supervisor.active.size && Date.now() < deadline) await sleep(500);
  assert.equal(supervisor.active.size, 0, "Live smoke test timed out");
  for (const id of ids) {
    const directory = supervisor.runDirectory(id);
    const metadata = await readJson(path.join(directory, "run.json"));
    const summary = await readJson(path.join(directory, "summary.json"));
    console.log(JSON.stringify({ id, model: metadata.model, effort: metadata.effort,
      tools: metadata.tools_enabled, status: metadata.status, actions: summary.action_count,
      session: metadata.codex_thread_id, error: metadata.error }));
    assert.equal(metadata.status, "completed", metadata.error || "Run did not complete");
    assert.equal(summary.action_count, 2);
    assert.equal(summary.game_status, "action-limit");
    assert.equal(metadata.model, model);
    assert.equal(metadata.effort, "max");
    assert(metadata.codex_thread_id);
    await supervisor.verifyRunCapabilityBoundary(metadata, directory);
  }
} finally {
  // launchPair also stops its first child if preparing the second child fails.
  for (const id of supervisor.active.keys()) await supervisor.stop(id);
  const deadline = Date.now() + 15000;
  while (supervisor.active.size && Date.now() < deadline) await sleep(250);
  for (const control of supervisor.active.values()) control.child?.kill("SIGKILL");
}
