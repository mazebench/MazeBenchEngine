const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../public/play-render-three.js"), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing renderer section: ${start}`);
  return source.slice(from, to);
}

// Exercise the browser renderer's real closure functions with controlled
// network and time, without exposing test-only methods on the public API.
function createLoader(importModule) {
  const loaderSource = section("    function ensureGltfLoaderClass()", "    async function parseModelAsset(")
    .replace("import(loaderUrl)", "importModule(loaderUrl)");
  return new Function("importModule", `
    let GLTFLoaderClass = null, gltfLoaderClassPromise = null;
    let gltfLoaderImportFailures = 0;
    const gltfLoaderModuleUrl = "/vendor/GLTFLoader.js";
    ${loaderSource}
    return ensureGltfLoaderClass;
  `)(importModule);
}

function createModels(fetch, parseModelAsset) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const window = {
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame() {}
  };
  const runtime = new Function("fetch", "parseModelAsset", "performance", "window", `
    const THREE = {};
    let rendererDisposed = false;
    let GLTFLoaderClass = null, gltfLoaderClassPromise = null;
    const app = { modelTextCache: new Map() };
    const modelAssetCache = new Map(), modelAssetRetryTimers = new Map();
    const failedModelAssetUrls = new Set();
    let modelAssetsVersion = 0;
    const invalidateSceneCache = () => {};
    ${section("    const MODEL_RETRY_DELAY_MS", "    function weightlessGroupLabel(")}
    ${section("    function resetFailedModelAssets(", "    function waitForModelRetry(")}
    return { requestModelAsset, resetFailedModelAssets, app, modelAssetCache,
      version: () => modelAssetsVersion };
  `)(fetch, parseModelAsset, { now: () => now }, window);
  return {
    ...runtime,
    timers,
    async settle(url) { await runtime.modelAssetCache.get(url)?.promise; },
    async retry(url) {
      assert.ok(timers.size > 0, "Expected a scheduled asset retry");
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      now = timer.at;
      timer.fn();
      await runtime.modelAssetCache.get(url)?.promise;
    }
  };
}

test("a failed GLTF module import is retried and concurrent requests stay deduplicated", async () => {
  let imports = 0;
  const urls = [];
  class Loader {}
  const load = createLoader(async (url) => {
    urls.push(url);
    if (++imports === 1) throw new Error("temporary network failure");
    return { GLTFLoader: Loader };
  });
  assert.deepEqual(await Promise.all([load(), load()]), [null, null]);
  assert.equal(imports, 1);
  assert.deepEqual(await Promise.all([load(), load()]), [Loader, Loader]);
  assert.equal(imports, 2);
  assert.deepEqual(urls, ["/vendor/GLTFLoader.js", "/vendor/GLTFLoader.js?retry=1"]);
  assert.equal(await load(), Loader);
  assert.equal(imports, 2);
});

test("failed GLTF imports use a bounded number of cache-busting URLs", async () => {
  const urls = [];
  const load = createLoader(async (url) => { urls.push(url); throw new Error("unavailable"); });
  for (let i = 0; i < 5; i += 1) await load();
  assert.equal(new Set(urls).size, 3);
  assert.equal(urls[4], "/vendor/GLTFLoader.js?retry=2");
});

test("invalid model bytes are discarded and replaced without another player action", async () => {
  const bad = new Uint8Array([0]).buffer;
  const good = new Uint8Array([1]).buffer;
  const model = { parts: [] };
  let fetches = 0;
  const cacheModes = [];
  const runtime = createModels(
    async (_url, options) => {
      cacheModes.push(options.cache);
      return { ok: true, arrayBuffer: async () => ++fetches === 1 ? bad : good };
    },
    async (_url, data) => data === good ? model : null
  );
  const url = "/tree.glb";
  runtime.requestModelAsset(url);
  await runtime.settle(url);
  assert.equal(runtime.modelAssetCache.get(url).status, "failed");
  assert.equal(runtime.app.modelTextCache.has(url), false);
  await runtime.retry(url);
  assert.equal(fetches, 2);
  assert.deepEqual(cacheModes, ["default", "reload"]);
  assert.equal(runtime.requestModelAsset(url), model);
  assert.equal(runtime.version(), 1, "A recovered model invalidates room geometry signatures");
  assert.equal(runtime.timers.size, 0);
});

test("terminal HTTP failures stop automatic retries after three attempts", async () => {
  let fetches = 0;
  const runtime = createModels(async () => { fetches += 1; return { ok: false }; }, async () => null);
  const url = "/missing.glb";
  runtime.requestModelAsset(url);
  await runtime.settle(url);
  await runtime.retry(url);
  await runtime.retry(url);
  assert.equal(fetches, 3);
  assert.equal(runtime.modelAssetCache.get(url).status, "failed");
  assert.equal(runtime.timers.size, 0);
});

test("strict model retries cancel pending automatic retries", async () => {
  const runtime = createModels(async () => ({ ok: false }), async () => null);
  const url = "/missing.glb";
  runtime.requestModelAsset(url);
  await runtime.settle(url);
  assert.equal(runtime.timers.size, 1);
  runtime.resetFailedModelAssets([url]);
  assert.equal(runtime.timers.size, 0);
  assert.equal(runtime.modelAssetCache.has(url), false);
});
