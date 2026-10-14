const fs = require("fs");
const path = require("path");

const VENDOR_FILES = {
  "three.module.js": "three/build/three.module.js",
  "three.core.js": "three/build/three.core.js",
  "GLTFLoader.js": "three/examples/jsm/loaders/GLTFLoader.js",
  "BufferGeometryUtils.js": "three/examples/jsm/utils/BufferGeometryUtils.js",
  "SkeletonUtils.js": "three/examples/jsm/utils/SkeletonUtils.js"
};

// Failed ES-module dependencies remain cached by the browser for the document.
// Each retry needs a fresh *whole graph*, not merely a fresh entry-point URL.
// Hosts publish these static local modules with the same CSP as the originals.
function createVendorRecoveryAssets(rootDir) {
  const assets = new Map();
  for (const [name, relative] of Object.entries(VENDOR_FILES)) {
    const installed = path.join(rootDir, "node_modules", relative);
    const source = fs.readFileSync(fs.existsSync(installed) ? installed : path.join(rootDir, "vendor", name), "utf8")
      .replace(/(\bfrom\s*['"])three(['"])/g, "$1./three.module.js$2")
      .replace(/(\bfrom\s*['"])\.\.\/utils\/(BufferGeometryUtils|SkeletonUtils)\.js(['"])/g, "$1./$2.js$3");
    for (let retry = 1; retry <= 2; retry += 1) {
      assets.set(`/vendor/retry-${retry}/${name}`, source);
    }
  }
  return assets;
}

module.exports = { createVendorRecoveryAssets };
