import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalProjectHandler } from "../scripts/lib/local-project-http.mjs";
import { readProjectBundle } from "../scripts/lib/project-store.mjs";

test("the mounted test lab loads and saves the repo store with revision protection", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "mazebench-lab-http-"));
  const handle = createLocalProjectHandler(directory);
  const server = createServer(async (request, response) => {
    if (!await handle(request, response)) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/api/local-project`;
  const project = { schemaVersion: 12, roles: [], blocks: [], tags: [], searches: [], tests: [] };
  const put = revision => fetch(url, { method: "PUT", headers: {
    "Content-Type": "application/json", ...(revision ? { "If-Match": revision } : {}),
  }, body: JSON.stringify(project) });
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(`${origin}/api/unrelated`)).status, 404);
  assert.equal((await put()).status, 428, "Unconditional writes cannot replace the library");
  const saved = await put("*");
  assert.equal(saved.status, 200);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), saved.headers.get("etag"));
  const loaded = await response.json();
  assert.deepEqual(loaded, await readProjectBundle(directory));
  assert.equal((await put('"outdated-revision"')).status, 409);
  assert.deepEqual(await readProjectBundle(directory), loaded, "A stale tab cannot overwrite tests");
  assert.equal((await put(response.headers.get("etag"))).status, 200);
  assert.equal((await fetch(url, { method: "DELETE" })).status, 405);
});
