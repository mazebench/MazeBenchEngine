import assert from "node:assert/strict";
import test from "node:test";
import { readRunStream } from "../benchmarking/ui/run-loading.mjs";

test("progress events survive arbitrary network chunks and split Unicode", async () => {
  const events = [{ type: "start", total: 1, loaded: 0 },
    { type: "record", total: 1, loaded: 1, run: { model: "Fixture · vision" } },
    { type: "done", total: 1, loaded: 1 }];
  const bytes = new TextEncoder().encode(events.map(e => JSON.stringify(e)).join("\n"));
  const received = [];
  await readRunStream(new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } })), event => received.push(event));
  assert.deepEqual(received, events);
});

test("a truncated or failed stream cannot be treated as completed progress", async () => {
  await assert.rejects(readRunStream(new Response('{"type":"start","total":2,"loaded":0}\n'), () => {}), /interrupted/);
  await assert.rejects(readRunStream(new Response('{"type":"error","error":"Fixture failed"}\n'), () => {}), /Fixture failed/);
});
