"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const python = process.env.PYTHON || "python3";
const testPath = path.join(__dirname, "prime-verifiers-auto-quit.test.py");
const result = spawnSync(python, [testPath], {
  cwd: path.join(__dirname, ".."),
  encoding: "utf8"
});

assert.equal(
  result.status,
  0,
  [result.stdout, result.stderr].filter(Boolean).join("\n")
);

console.log("Prime Verifiers auto-quit tests passed");
