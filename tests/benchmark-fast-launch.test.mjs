import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BenchmarkSupervisor } from "../benchmarking/v1/supervisor.mjs";
import { assertRunConfiguration, verifyCheckpoint, verifyRunIntegrity } from "../benchmarking/v1/integrity.mjs";

test("MazeBench launches freeze the requested speed before dispatch, with Python on or off", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const recordsRoot = await mkdtemp(path.join(os.tmpdir(), "mazebench-fast-launch-"));
  const supervisor = new BenchmarkSupervisor(root, { recordsRoot });
  supervisor.models = async () => ({ default_model: "gpt-6-astra", models: [{ id: "gpt-6-astra", efforts: ["max"], default_effort: "max" }] });
  supervisor.codexCapabilityPolicy = () => ({ version: 4, name: "os-isolated-v4", disabled_features: [] });
  const dispatches = [];
  supervisor.runLoop = async (id, directory) => {
    dispatches.push({ id, directory });
    supervisor.active.delete(id);
  };
  try {
    for (const tools_enabled of [false, true]) for (const service_tier of ["standard", "fast"]) {
      const run = await supervisor.launch({ model: "gpt-6-astra", effort: "max", tools_enabled, service_tier, action_limit: null });
      const directory = supervisor.runDirectory(run.id);
      const metadata = JSON.parse(await readFile(path.join(directory, "run.json")));
      const manifest = await verifyRunIntegrity(root, directory, metadata.integrity);
      assertRunConfiguration(metadata, manifest);
      verifyCheckpoint(directory);
      assert.equal(metadata.service_tier, service_tier === "fast" ? "fast" : null);
      assert.equal(metadata.service_tier_history[0].service_tier, service_tier);
      assert.equal(metadata.service_tier_history[0].at, metadata.created_at);
      assert.equal(metadata.tools_enabled, tools_enabled);
      assert.equal(metadata.action_limit, null);
      assert.equal(run.action_count, 0);
      assert.equal(dispatches.at(-1).id, run.id);
      if (tools_enabled) assert.equal(metadata.isolation.verified, true);
      assert.throws(() => assertRunConfiguration({ ...metadata, service_tier: service_tier === "fast" ? null : "fast" }, manifest), /service_tier/);
    }
    assert.equal((await supervisor.validateSpec({})).serviceTier, null);
    await assert.rejects(() => supervisor.validateSpec({ service_tier: "unreviewed" }), /Unsupported benchmark service tier/);
  } finally {
    await rm(recordsRoot, { recursive: true, force: true });
  }
});
