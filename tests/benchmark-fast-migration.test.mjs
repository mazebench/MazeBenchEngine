import assert from "node:assert/strict";
import test from "node:test";
import { planFastSelection, SUPERVISOR_FIX, PAIR_PLAN } from "../scripts/prepare-sol-pair-fast-v1.mjs";

function fixture(expected) {
  const config = { model: "gpt-6.1-sol", effort: "max", action_limit: null, tools_enabled: expected.tools, service_tier: null };
  return { metadata: { ...config, id: expected.id, status: "paused", error: null, codex_thread_id: expected.thread,
    integrity: { manifest_sha256: expected.manifest }, capability_policy: { disabled_features: ["fast_mode", "shell_tool", "code_mode"], enabled_features: [] },
    service_tier_history: [{ at: "before", service_tier: "standard" }] },
  manifest: { configuration: config, files: { [SUPERVISOR_FIX.file]: SUPERVISOR_FIX.before, "engine.wasm": "unchanged" } },
  current: { [SUPERVISOR_FIX.file]: SUPERVISOR_FIX.after, "engine.wasm": "unchanged" } };
}

test("exact Fast selection preserves both conditions, original inputs and non-speed configuration", () => {
  for (const expected of PAIR_PLAN) {
    const f = fixture(expected), before = structuredClone(f);
    const next = planFastSelection(f.metadata, f.manifest, f.current, expected, "now");
    assert.deepEqual(f, before);
    assert.deepEqual(next.manifest.configuration, { ...f.manifest.configuration, service_tier: "fast" });
    assert.deepEqual(next.metadata.capability_policy, { disabled_features: ["shell_tool", "code_mode"], enabled_features: ["fast_mode"] });
    assert.equal(next.metadata.codex_thread_id, expected.thread);
    assert.equal(next.metadata.service_tier_history.at(-1).action_count, expected.actions);
    assert.deepEqual(next.metadata.service_tier_history[0], f.metadata.service_tier_history[0]);
  }
});

test("Fast selection rejects active runs, changed model/tool/history identity, and any unrelated asset drift", () => {
  const expected = PAIR_PLAN[0];
  for (const mutate of [
    f => { f.metadata.status = "running"; },
    f => { f.metadata.codex_thread_id = "replacement"; },
    f => { f.metadata.model = "gpt-6-astra"; },
    f => { f.metadata.effort = "high"; },
    f => { f.metadata.tools_enabled = true; },
    f => { f.metadata.action_limit = 100; },
    f => { f.metadata.integrity.manifest_sha256 = "unknown"; },
    f => { f.current["engine.wasm"] = "changed"; },
    f => { f.current[SUPERVISOR_FIX.file] = "unreviewed"; },
    f => { f.current.extra = "new-asset"; }
  ]) {
    const f = fixture(expected); mutate(f);
    assert.throws(() => planFastSelection(f.metadata, f.manifest, f.current, expected, "now"));
  }
});
