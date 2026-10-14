const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { createVendorRecoveryAssets, createVendorRecoveryAssetLoader } = require("../server/vendor-assets");
const root = path.join(__dirname, "..");

test("each installed static fallback vendor graph is complete and isolated from failed original modules", {
  skip: !fs.existsSync(path.join(root, "node_modules/three/build/three.module.js"))
}, () => {
  const assets = createVendorRecoveryAssets(path.join(__dirname, ".."));
  assert.equal(assets.size, 10);
  for (const [url, source] of assets) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const imports = [...code.matchAll(/^(?:import|export)\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(specifier.startsWith("./"), `${url}: nonlocal import ${specifier}`);
      const resolved = new URL(specifier, `https://example.test${url}`).pathname;
      assert.ok(assets.has(resolved), `${url}: missing dependency ${specifier}`);
      assert.equal(resolved.split('/')[2], url.split('/')[2]);
    }
  }
  assert.deepEqual(assets, createVendorRecoveryAssets(path.join(__dirname, "..")), "build output is deterministic");
});

test("dependency-free source and packaged servers load without reading browser vendor files", () => {
  for (const server of ["server/app.js", "environments/mazebench/mazebench/runtime/server/app.js"]) {
    const script = `
      const fs = require('node:fs');
      const exists = fs.existsSync, read = fs.readFileSync;
      const vendor = (p) => /[\\\\/]node_modules[\\\\/]|[\\\\/]vendor[\\\\/]/.test(String(p));
      fs.existsSync = (p) => vendor(p) ? false : exists(p);
      fs.readFileSync = (p, ...args) => {
        if (vendor(p)) throw new Error('Unexpected eager vendor read: ' + p);
        return read(p, ...args);
      };
      require(${JSON.stringify(path.join(root, server))});
    `;
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20000 });
    assert.equal(result.status, 0, `${server}: ${result.stderr}`);
  }
});

test("lazy loader handles missing dependencies and discovers packaged vendor files when requested", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-vendor-test-"));
  try {
    const load = createVendorRecoveryAssetLoader(dir);
    assert.equal(load("/api/play/maze/level_HxI"), null);
    assert.equal(load("/vendor/retry-1/unknown.js"), null);
    assert.equal(load("/vendor/retry-1/three.module.js"), null);
    fs.mkdirSync(path.join(dir, "vendor"));
    for (const [name, source] of Object.entries({
      "three.core.js": "export const value = 1;",
      "three.module.js": "export { value } from './three.core.js';",
      "GLTFLoader.js": "import { value } from 'three';\nimport { utility } from '../utils/BufferGeometryUtils.js';",
      "BufferGeometryUtils.js": "import { value } from 'three';\nexport const utility = value;",
      "SkeletonUtils.js": "import { value } from 'three';"
    })) fs.writeFileSync(path.join(dir, "vendor", name), source);
    assert.match(load("/vendor/retry-1/GLTFLoader.js"), /from '.\/three.module.js'/);
    assert.match(load("/vendor/retry-2/GLTFLoader.js"), /from '.\/BufferGeometryUtils.js'/);
    assert.equal(createVendorRecoveryAssets(dir).size, 10, "static build uses the same packaged source fallback");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
