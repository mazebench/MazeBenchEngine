const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const output = execFileSync(
  "uv",
  [
    "run",
    "--project",
    path.join(__dirname, "..", "environments", "mazebench"),
    "python",
    path.join(__dirname, "..", "scripts", "maze-verify-prime-resume.py"),
    "--self-test"
  ],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
);
assert.match(output, /deterministic replay ready/);
console.log("prime resume environment tests passed");
