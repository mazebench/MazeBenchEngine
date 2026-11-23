import assert from "node:assert/strict";
import test from "node:test";
import { assertCapacityRecovery, CAPACITY_ERROR } from "../scripts/recover-codex-capacity-v1.mjs";

function fixture() {
  const metadata = { id: "run-test", status: "failed", error: CAPACITY_ERROR, codex_thread_id: "original", tools_enabled: true };
  return { metadata, report: { ...metadata, runner_active: false, action_count: 8379 },
    summary: { action_count: 8379, game_status: "playing" },
    events: [{ type: "thread.started", thread_id: "original" }, { type: "turn.failed", error: { message: CAPACITY_ERROR } }] };
}
const check = f => assertCapacityRecovery(f.metadata, f.report, f.summary, f.events);

test("capacity recovery admits only the stopped original conversation", () => {
  const f = fixture(); const before = structuredClone(f);
  check(f); assert.deepEqual(f, before);
});

test("capacity recovery rejects quota, active/paused runs, changed history and forbidden tools", () => {
  const cases = [
    f => { f.metadata.error = "Usage limit reached"; },
    f => { f.metadata.status = "paused"; },
    f => { f.report.runner_active = true; },
    f => { f.report.codex_thread_id = "replacement"; },
    f => { f.report.action_count++; },
    f => { f.summary.game_status = "won"; },
    f => { f.events[0].thread_id = "replacement"; },
    f => { f.events.at(-1).error.message = "billing limit"; },
    f => { f.events.unshift({ type: "item.completed", item: { type: "command_execution" } }); },
    f => { f.metadata.tools_enabled = false; f.events.unshift({ type: "item.completed", item: { type: "mcp_tool_call", server: "mazebench", tool: "python_exec" } }); }
  ];
  for (const mutate of cases) { const f = fixture(); mutate(f); assert.throws(() => check(f)); }
});
