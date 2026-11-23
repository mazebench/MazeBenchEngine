// Evaluator-private transport to the existing game runtime. This is not an
// agent harness or an MCP implementation; Verifiers owns both of those.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { BenchmarkGameRuntime, expandBenchmarkSequence } from "./runtime/benchmarking/v1/runtime.mjs";
import { createRunIntegrity } from "./runtime/benchmarking/v1/integrity.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime");
const snapshot = JSON.parse(await readFile(path.join(root, "snapshot.json"), "utf8"));
let directory;
let game;

function evaluatorState() {
  if (!game) return null;
  const { positions, novelty, actions, ...summary } = game.summary({ compact: true });
  return {
    summary,
    actions: game.internal.actions.map(({ action }) => action),
    snapshot_sha256: snapshot.snapshot_sha256,
    invalid: Boolean(game.persistenceError)
  };
}

async function dispatch(request) {
  const args = request.args || {};
  if (request.method === "initialize") {
    if (game) throw new Error("Game already initialized.");
    directory = await mkdtemp(path.join(os.tmpdir(), "mazebench-vf-"));
    await createRunIntegrity(root, directory, { provider: "verifiers", storage_format: "incremental-v1" });
    game = await BenchmarkGameRuntime.create(root, directory, {
      startRoom: args.start_room, actionLimit: args.max_actions, incremental: true
    });
    return game.renderObservation();
  }
  if (!game) throw new Error("Game is not initialized.");
  if (request.method === "observe") {
    if (args.record) return { read_only: true, ...await game.readRecord(args.record), records: game.recordIndex() };
    return game.renderObservation();
  }
  if (request.method === "action") return game.apply(args.action);
  if (request.method === "sequence") {
    const actions = expandBenchmarkSequence(args.actions ?? args.sequence);
    if (!actions.length || actions.length > 1000) throw new Error("A sequence must contain 1 to 1000 actions.");
    return game.applySequence(actions);
  }
  throw new Error("Unknown game operation.");
}

try {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let response;
    try {
      const request = JSON.parse(line);
      response = { ok: true, result: await dispatch(request) };
    } catch (error) {
      response = { ok: false, error: String(error.message).replaceAll(root, "[game]").replaceAll(directory || root, "[run]") };
    }
    process.stdout.write(`${JSON.stringify({ ...response, state: evaluatorState() })}\n`);
  }
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
