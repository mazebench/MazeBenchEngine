import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { readFile, readdir } from "node:fs/promises";
import { BenchmarkSupervisor } from "../benchmarking/antigravity/supervisor.mjs";
import { ANTIGRAVITY_MODELS } from "../benchmarking/antigravity/status.mjs";
import { readJson } from "../benchmarking/providers/claude-runner.mjs";
import { verifyIntegrity } from "../benchmarking/antigravity/policy.mjs";
const root = path.resolve(import.meta.dirname, "..");
const supervisor = new BenchmarkSupervisor(root, {
  recordsRoot: path.join(os.homedir(), "records/mazebench-validation/antigravity-" + Date.now()),
  // Operator-only certification fixture; normal launches still use readiness.
  antigravityStatus: async () => ({ launch_ready: true, models: ANTIGRAVITY_MODELS })
});
console.log("Validation records: " + supervisor.recordsRoot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const runs = [];
async function until(predicate, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(250); }
  throw new Error("Timed out: " + label);
}
try {
  for (const tools_enabled of [false, true]) {
    const run = await supervisor.launch({ provider: "antigravity", model: "gemini-3.8-flash-high", tools_enabled, action_limit: null });
    runs.push(run.id); console.log(JSON.stringify({ launched: run.id, tools_enabled }));
  }
  await Promise.all(runs.map(async id => {
    const directory = supervisor.runDirectory(id);
    const summary = () => readJson(path.join(directory, "summary.json"));
    await until(async () => (await summary()).action_count >= 1, "first action");
    await supervisor.pause(id);
    await until(() => !supervisor.active.has(id), "pause completes");
    let metadata = await readJson(path.join(directory, "run.json"));
    assert.equal(metadata.status, "paused");
    const originalSession = metadata.antigravity_session_id;
    const paused = (await summary()).action_count;
    await sleep(750);
    assert.equal((await summary()).action_count, paused, "No writes after pause");
    await supervisor.resume(id);
    await until(async () => (await summary()).action_count > paused, "gameplay after resume");
    await supervisor.stop(id);
    await until(() => !supervisor.active.has(id), "stop completes");
    metadata = await readJson(path.join(directory, "run.json"));
    assert.equal(metadata.status, "stopped");
    assert.equal(metadata.antigravity_session_id, originalSession);
    const stopped = (await summary()).action_count;
    await supervisor.resume(id);
    await until(async () => (await summary()).action_count > stopped, "gameplay after stopped-run resume");
    await supervisor.stop(id);
    await until(() => !supervisor.active.has(id), "final stop");
    console.log(JSON.stringify({ id, pauseResumeStopResume: "passed", originalSession }));
  }));
  for (const id of runs) {
    const directory = supervisor.runDirectory(id), metadata = await readJson(path.join(directory, "run.json"));
    const summary = await readJson(path.join(directory, "summary.json"));
    console.log(JSON.stringify({ id, status: metadata.status, actions: summary.action_count, error: metadata.error, session: metadata.antigravity_session_id }));
    assert.equal(metadata.status, "stopped");
    assert(summary.action_count >= 3);
    await verifyIntegrity(root, directory, metadata);
    const events = (await readFile(path.join(directory, "antigravity-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert(events.some(event => event.event === "init" && event.init.model === metadata.model));
    if (metadata.tools_enabled) console.log(JSON.stringify({ id, workspace: await readdir(path.join(directory, "workspace")).catch(() => []) }));
  }
} finally {
  for (const id of runs) if (supervisor.active.has(id)) await supervisor.stop(id);
  const deadline = Date.now() + 20000;
  while (supervisor.active.size && Date.now() < deadline) await sleep(250);
}
