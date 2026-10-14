const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../public/play-core.js'), 'utf8');
const assetSource = source.slice(source.indexOf('    const imageLoads ='), source.indexOf('    function collectTerrainAssetUrls('));

function createAssets(engineVersion) {
  const images = [];
  const timers = new Map();
  const invalidations = [];
  const modelRequests = [];
  const app = {
    state: { engineVersion }, imageCache: new Map(), modelTextCache: new Map(),
    threeRenderer: {
      invalidateSceneCache: (options) => invalidations.push(options),
      preloadModelAssets: async (urls) => { modelRequests.push(urls); }
    }
  };
  class Image { constructor() { images.push(this); } }
  const window = {
    setTimeout(fn) { const id = {}; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }, requestAnimationFrame() {}
  };
  const functions = new Function('app', 'Image', 'window', 'fetch', `
    const registerImageUrl = () => {}, registerModelUrl = () => {};
    ${assetSource}
    return { preloadImageUrl, preloadModelUrl };
  `)(app, Image, window, () => { throw new Error('GLB preloading must use the shared renderer'); });
  return { ...functions, app, images, timers, invalidations, modelRequests };
}

for (const version of ['v1', 'v1.1']) {
  test(`${version}: failed images retry, share in-flight work and invalidate cached room assets`, async () => {
    const runtime = createAssets(version);
    const first = runtime.preloadImageUrl('/arrow.png?v=1');
    assert.equal(runtime.preloadImageUrl('/arrow.png?v=1'), first);
    runtime.images[0].onerror();
    await Promise.resolve();
    assert.equal(runtime.images[1].src, '/arrow.png?v=1&retry=1');
    runtime.images[1].onload();
    await first;
    assert.equal(runtime.app.imageCache.get('/arrow.png?v=1'), runtime.images[1]);
    assert.deepEqual(runtime.invalidations, [{ assets: true }]);
    assert.equal(runtime.timers.size, 0);
    await runtime.preloadImageUrl('/arrow.png?v=1');
    assert.equal(runtime.images.length, 2);
  });

  test(`${version}: stalled images settle after three attempts and may recover on the next room load`, async () => {
    const runtime = createAssets(version);
    const pending = runtime.preloadImageUrl('/missing.png');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      runtime.timers.values().next().value();
      await Promise.resolve();
    }
    await pending;
    assert.equal(runtime.app.imageCache.has('/missing.png'), false);
    assert.equal(runtime.images.length, 3);
    const retry = runtime.preloadImageUrl('/missing.png');
    runtime.images[3].onload();
    await retry;
    assert.equal(runtime.app.imageCache.get('/missing.png'), runtime.images[3]);
  });

  test(`${version}: GLB preloading has a single authoritative loader`, async () => {
    const runtime = createAssets(version);
    await runtime.preloadModelUrl('/gem.glb?v=1');
    assert.deepEqual(runtime.modelRequests, [['/gem.glb?v=1']]);
  });
}
