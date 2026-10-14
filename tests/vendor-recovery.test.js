const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { createVendorRecoveryAssets } = require("../server/vendor-assets");

test("each static fallback vendor graph is complete and isolated from failed original modules", () => {
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
