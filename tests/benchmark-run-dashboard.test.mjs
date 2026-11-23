import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunDashboard } from "../benchmarking/run-dashboard.mjs";
import { ReportReader } from "../benchmarking/report-reader.mjs";
import { createJournal } from "../benchmarking/storage/journal.mjs";

async function fixture(t, { incremental = true, provider = "codex", policy, session } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maze-dashboard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "sandbox-state"));
  await mkdir(path.join(directory, "display-history"));
  await mkdir(path.join(directory, "workspace"));
  await writeFile(path.join(directory, "sandbox-state/integrity-key"), randomBytes(32));
  const metadata = { id: "fixture", provider, model: "fixture-model", world: "main-world", status: "paused", tools_enabled: true,
    created_at: "2026-10-03T00:00:00Z", paused_at: "2026-10-03T00:01:00Z", integrity: { version: 4 },
    capability_policy: policy || { version: 4, model_catalog: { tool_mode: "direct", javascript_host: "disabled" } }, ...session };
  await writeFile(path.join(directory, "run.json"), JSON.stringify(metadata));
  const actions = [
    { index: 1, action: "up", novel: true, traversedPositions: [{ worldX: 1, worldY: 0 }, { worldX: 1, worldY: 1 }] },
    { index: 2, action: "right", novel: false, traversedPositions: [{ worldX: 1, worldY: 1 }] }
  ];
  const summary = { action_count: 2, room: "HxI", game_status: "running", gems_collected: 3, gems_total: 100, novel_rate: .5,
    actions, novelty: [true, true, false], positions: [{ worldX: 0, worldY: 0 }, { worldX: 1, worldY: 1 }, { worldX: 2, worldY: 1 }] };
  const display = { room: "HxI", observation_revision: 2, level: "P.", colored_level: [[{ text: "P.", color: "#ffffff" }]] };
  const state = { actionCount: 2, actions };
  const writer = incremental ? await createJournal(directory, state, summary, display) : null;
  if (!incremental) {
    await writeFile(path.join(directory, "summary.json"), JSON.stringify(summary));
    await writeFile(path.join(directory, "display.json"), JSON.stringify(display));
  }
  await writeFile(path.join(directory, "display-history/move_1.json"), JSON.stringify({ ...display, observation_revision: 1 }));
  const supervisor = { active: new Map(), runDirectory: () => directory, displayFrame: () => { throw Error("Unexpected history backfill"); } };
  return { directory, supervisor, metadata, summary, display, state, writer };
}

test("overview reads current signed board and scores without returning histories or runtime policy", async t => {
  for (const incremental of [true, false]) {
    const f = await fixture(t, { incremental }), dashboard = new RunDashboard();
    const run = await dashboard.overview(f.supervisor, "fixture");
    assert.equal(run.action_count, 2);
    assert.equal(run.gems_collected, 3);
    assert.deepEqual(run.display, f.display);
    assert.equal(run.capability_boundary_verified, true);
    assert.equal(run.runner_active, false);
    for (const key of ["actions", "positions", "novelty", "capability_policy", "integrity"]) assert.equal(key in run, false);
    f.metadata.status = "running";
    await writeFile(path.join(f.directory, "run.json"), JSON.stringify(f.metadata));
    assert.equal((await dashboard.overview(f.supervisor, "fixture")).status, "interrupted");
    f.supervisor.active.set("fixture", {});
    assert.equal((await dashboard.overview(f.supervisor, "fixture")).status, "running");
  }
});

test("overview preserves provider-specific resume eligibility and integrity violations", async t => {
  for (const [provider, name, session] of [["claude-code", "claude-mcp-only-v1", "claude_session_id"], ["grok-build", "grok-build-mcp-only-v1", "grok_session_id"], ["antigravity", "antigravity-mcp-only-v1", "antigravity_session_id"]]) {
    const f = await fixture(t, { provider, policy: { name }, session: { [session]: "session" } });
    f.metadata.status = "failed";
    await writeFile(path.join(f.directory, "run.json"), JSON.stringify(f.metadata));
    const dashboard = new RunDashboard();
    const run = await dashboard.overview(f.supervisor, "fixture");
    assert.equal(run.capability_boundary_verified, true);
    assert.equal(run.compaction_recoverable, true);
    await writeFile(path.join(f.directory, "integrity-violation.json"), "{}");
    const invalid = await dashboard.overview(f.supervisor, "fixture");
    assert.equal(invalid.capability_boundary_verified, false);
    assert.equal(invalid.compaction_recoverable, false);
  }
});

test("saved replay frames bypass history reconstruction and still enforce committed bounds", async t => {
  const f = await fixture(t), dashboard = new RunDashboard();
  assert.equal((await dashboard.frame(f.supervisor, "fixture", "1")).observation_revision, 1);
  await assert.rejects(() => dashboard.frame(f.supervisor, "fixture", "3"), /outside/);
  await assert.rejects(() => dashboard.frame(f.supervisor, "fixture", "../run"), /Invalid/);
  await writeFile(path.join(f.directory, "summary.json"), "{}");
  await assert.rejects(() => dashboard.frame(f.supervisor, "fixture", "1"), /verification failed/);
});

test("activity returns recent messages and workspace files without action history", async t => {
  const f = await fixture(t), dashboard = new RunDashboard();
  await writeFile(path.join(f.directory, "agent-events.jsonl"), Array.from({ length: 100 }, (_, i) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `message ${i}` } })).join("\n") + "\n");
  await writeFile(path.join(f.directory, "last-message.txt"), "Finished.\n");
  await writeFile(path.join(f.directory, "workspace/notes.txt"), "hello");
  const value = await dashboard.activity(f.supervisor, "fixture");
  assert.equal(value.feed.length, 60);
  assert.equal(value.feed[0].text, "message 40");
  assert.equal(value.final_message, "Finished.");
  assert.deepEqual(value.workspace_files, [{ path: "notes.txt", bytes: 5 }]);
  assert.equal("actions" in value, false);
});

test("background analysis preserves every visit and novelty value, updates after commits, and coalesces requests", async t => {
  const f = await fixture(t), reader = new ReportReader();
  t.after(() => reader.close());
  const first = reader.read(f.directory, "analysis"), second = reader.read(f.directory, "analysis");
  assert.equal(first, second);
  const result = await first;
  assert.deepEqual(result.novelty, f.summary.novelty);
  assert.equal(result.heatmap.total, 6);
  assert.equal(result.heatmap.points.find(p => p.worldX === 1 && p.worldY === 1).count, 3);
  assert.deepEqual(result.heatmap.current, { worldX: 2, worldY: 1 });
  assert.equal(result.heatmap.trackedActions, 2);
  f.state.actionCount++; f.summary.action_count++;
  f.summary.novelty.push(true);
  await f.writer.commit(f.state, f.summary, f.display);
  assert.equal((await reader.read(f.directory, "analysis")).action_count, 3);
  await assert.rejects(reader.read(f.directory, "unknown"), /Unknown report/);
  assert.equal((await reader.read(f.directory, "analysis")).action_count, 3);
  await writeFile(path.join(f.directory, "summary.json"), "{}");
  await assert.rejects(reader.read(f.directory, "analysis"), /verification failed/);
});
