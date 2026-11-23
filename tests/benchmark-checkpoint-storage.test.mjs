import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCheckpointJson, writeCheckpointJson } from "../benchmarking/v1/checkpoint-json.mjs";
import { createRunIntegrity, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("large histories round trip without serializing or parsing an aggregate string", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maze-chunked-json-"));
  try {
    const value = { version: 1, history: Array.from({ length: 1500 }, (_, i) => ({ i, text: "🧊\n".repeat(500) })), actions: [], state: { x: 3 }, optional: undefined };
    const stringify = JSON.stringify, parse = JSON.parse;
    const expected = parse(stringify(value));
    // Simulate a much smaller V8 limit, exercising both sides of the boundary.
    t.mock.method(JSON, "stringify", (...args) => {
      const result = stringify(...args);
      if (result?.length > 16 * 1024) throw new RangeError("Invalid string length");
      return result;
    });
    t.mock.method(JSON, "parse", text => {
      if (text.length > 16 * 1024) throw new RangeError("Cannot create a string longer than limit");
      return parse(text);
    });
    await writeCheckpointJson(path.join(directory, "game-state.json"), value);
    assert.deepEqual(await readCheckpointJson(directory), expected);
    assert.deepEqual(parse(await readFile(path.join(directory, "game-state.json"), "utf8")), expected);
  } finally { t.mock.restoreAll(); await rm(directory, { recursive: true, force: true }); }
});

test("checkpoint reader accepts legacy JSON and rejects truncated, malformed and linked files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maze-json-reader-"));
  const file = path.join(directory, "game-state.json");
  try {
    for (const indent of [undefined, 2]) {
      await writeFile(file, JSON.stringify({ version: 1, history: [] }, null, indent));
      assert.deepEqual(await readCheckpointJson(directory), { version: 1, history: [] });
    }
    for (const text of ['{\t\n"history":[\n{}\n', '{\t\n"history":[\n{},\n]\n}\n', '{\t\n"a":1\n"b":2\n}\n', '{\t\n"a":1,\n"a":2\n}\n', '{\t\n}\n{}\n']) {
      await writeFile(file, text);
      await assert.rejects(() => readCheckpointJson(directory));
    }
    await writeFile(path.join(directory, "other.json"), "{}");
    await rm(file); await symlink(path.join(directory, "other.json"), file);
    await assert.rejects(() => readCheckpointJson(directory));
    await rm(file); await link(path.join(directory, "other.json"), file);
    await assert.rejects(() => readCheckpointJson(directory), /without links/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed save preparation preserves the signed checkpoint and rejects unsaved in-memory actions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maze-save-failure-"));
  try {
    await createRunIntegrity(root, directory, { model: "test", tools_enabled: false });
    const runtime = await BenchmarkGameRuntime.create(root, directory, { actionLimit: 20 });
    await runtime.apply("up");
    verifyCheckpoint(directory);
    const files = ["game-state.json", "summary.json", "checkpoint.json", "display.json", "records/current_state.json", "records/moves.txt"];
    const before = await Promise.all(files.map(file => readFile(path.join(directory, file))));
    // Fail late in preparation, after the new board has already been staged.
    const summary = runtime.summary.bind(runtime);
    runtime.summary = () => ({ ...summary(), toJSON: undefined, failing: { toJSON() { throw new RangeError("Invalid string length"); } } });
    await assert.rejects(() => runtime.apply("camera left"), /Benchmark save failed/);
    for (const [index, file] of files.entries()) assert.deepEqual(await readFile(path.join(directory, file)), before[index]);
    verifyCheckpoint(directory);
    await assert.rejects(() => runtime.apply("up"), /Benchmark save failed/);
    await assert.rejects(() => runtime.renderObservation(), /Benchmark save failed/);
    await assert.rejects(() => runtime.readRecord("current_state.json"), /Benchmark save failed/);
    assert(!(await readdir(directory)).some(file => file.startsWith(".checkpoint-")));
    const reopened = await BenchmarkGameRuntime.open(root, directory);
    assert.equal(reopened.internal.actionCount, 1);
    await reopened.apply("down"); verifyCheckpoint(directory);
    assert.equal(reopened.internal.actionCount, 2);
    // Streaming authentication must be byte-for-byte compatible with old HMACs.
    const expected = createHmac("sha256", await readFile(path.join(directory, "sandbox-state/integrity-key")))
      .update(await readFile(path.join(directory, "game-state.json"))).update("\nSUMMARY\n")
      .update(await readFile(path.join(directory, "summary.json"))).digest("hex");
    assert.equal(JSON.parse(await readFile(path.join(directory, "checkpoint.json"))).hmac, expected);
    await writeFile(path.join(directory, "summary.json"), '{"gems_collected":100}');
    assert.throws(() => verifyCheckpoint(directory), /modified outside the engine/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
