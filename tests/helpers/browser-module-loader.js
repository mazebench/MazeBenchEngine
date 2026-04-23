const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT_DIR = path.resolve(__dirname, "..", "..");

function projectPath(relativePath) {
  return path.join(ROOT_DIR, relativePath);
}

function loadBrowserScript(relativePath) {
  const absolutePath = projectPath(relativePath);
  const source = fs.readFileSync(absolutePath, "utf8");

  vm.runInThisContext(source, {
    filename: absolutePath,
    displayErrors: true
  });
}

module.exports = {
  loadBrowserScript,
  projectPath,
  ROOT_DIR
};
