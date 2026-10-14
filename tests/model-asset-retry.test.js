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
    let threeModuleRetry = 0;
    const assetUrl = (url) => url;
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
      dispose() { rendererDisposed = true; modelAssetCache.forEach((entry) => entry.cancel?.()); },
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
  assert.deepEqual(urls, ["/vendor/GLTFLoader.js", "/vendor/retry-1/GLTFLoader.js"]);
  assert.equal(await load(), Loader);
  assert.equal(imports, 2);
});

test("failed GLTF imports use a bounded number of cache-busting URLs", async () => {
  const urls = [];
  const load = createLoader(async (url) => { urls.push(url); throw new Error("unavailable"); });
  for (let i = 0; i < 5; i += 1) await load();
  assert.equal(new Set(urls).size, 3);
  assert.equal(urls[4], "/vendor/retry-2/GLTFLoader.js");
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

test("a stalled fetch times out and cannot overwrite the successful retry", async () => {
  let resolveFirst;
  const good = new Uint8Array([1]).buffer;
  let requests = 0;
  let firstSignal;
  const runtime = createModels((_url, options) => {
    if (++requests === 1) {
      firstSignal = options.signal;
      return new Promise((resolve) => { resolveFirst = resolve; });
    }
    return Promise.resolve({ ok: true, arrayBuffer: async () => good });
  }, async () => ({ parts: [] }));
  const url = "/stalled.glb";
  runtime.requestModelAsset(url);
  await Promise.resolve();
  await runtime.retry(url); // deadline, not an automatic retry
  assert.equal(firstSignal.aborted, true);
  assert.equal(runtime.modelAssetCache.get(url).status, "failed");
  await runtime.retry(url);
  assert.equal(runtime.modelAssetCache.get(url).status, "ready");
  resolveFirst({ ok: true, arrayBuffer: async () => new Uint8Array([0]).buffer });
  await new Promise(setImmediate);
  assert.equal(runtime.app.modelTextCache.get(url), good);
  assert.equal(runtime.version(), 1);
});

test("a stalled parser times out; late geometry is disposed without replacing the retry", async () => {
  let resolveFirst;
  let parses = 0;
  let disposed = 0;
  const runtime = createModels(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    async () => ++parses === 1 ? new Promise((resolve) => { resolveFirst = resolve; }) : { parts: [] });
  const url = "/late-parse.glb";
  runtime.requestModelAsset(url);
  await new Promise(setImmediate);
  await runtime.retry(url);
  await runtime.retry(url);
  resolveFirst({ parts: [{ geometry: { dispose() { disposed += 1; } } }] });
  await new Promise(setImmediate);
  assert.equal(disposed, 1);
  assert.equal(runtime.modelAssetCache.get(url).status, "ready");
  assert.equal(runtime.version(), 1);
});

test("cached-byte parser rejection is a retryable failure, and disposal settles pending requests", async () => {
  const runtime = createModels(() => new Promise(() => {}), async () => { throw new Error("bad cached model"); });
  runtime.app.modelTextCache.set("/bad.glb", new ArrayBuffer(1));
  runtime.requestModelAsset("/bad.glb");
  await runtime.settle("/bad.glb");
  assert.equal(runtime.modelAssetCache.get("/bad.glb").status, "failed");
  runtime.requestModelAsset("/hanging.glb");
  const pending = runtime.modelAssetCache.get("/hanging.glb").promise;
  runtime.dispose();
  await pending;
});

test("Three.js bootstrap retries failed module URLs and stops after disposal", async () => {
  const importSource = section("    async function importThreeModule()", "    app.threeRendererReady =")
    .replace("import(url)", "importModule(url)");
  const urls = [];
  const module = {};
  const runtime = new Function("importModule", `
    let rendererDisposed = false, threeModuleRetry = 0;
    const assetUrl = (url) => url + '?v=123';
    const threeModuleUrl = '/vendor/three.module.js?v=123';
    ${importSource}
    return { load: importThreeModule, dispose() { rendererDisposed = true; } };
  `)(async (url) => { urls.push(url); if (urls.length === 1) throw new Error("offline"); return module; });
  assert.equal(await runtime.load(), module);
  assert.deepEqual(urls, ['/vendor/three.module.js?v=123', '/vendor/retry-1/three.module.js?v=123']);
  runtime.dispose();
  assert.equal(await runtime.load(), null);
  assert.equal(urls.length, 2);
});
