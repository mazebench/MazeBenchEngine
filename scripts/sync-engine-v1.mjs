#!/usr/bin/env node
// v1 stays byte-identical for signed historical runs. Live builds use engine/src.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.slice(2).join(" ") !== "--check") {
  throw new Error("Cross-repository engine sync is retired. Run npm run build:physics and npm run build:solvers here. Use --check to verify the historical v1 snapshot.");
}
const manifest = JSON.parse(await readFile(path.join(root, "engine/v1/upstream.json"), "utf8"));
const hash = async file => createHash("sha256").update(await readFile(file)).digest("hex");
const core = path.join(root, "engine/v1/core");
async function walk(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), name + "/"));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}
const expected = manifest.files.map(file => file.path).sort();
if (JSON.stringify(await walk(core)) !== JSON.stringify(expected)) throw new Error("Historical engine file inventory changed.");
for (const file of manifest.files) {
  if (await hash(path.join(core, file.path)) !== file.sha256) throw new Error("Historical engine file changed: " + file.path);
}
if (await hash(path.join(root, "engine/v1/voxel_physics.wasm")) !== manifest.wasm.sha256) throw new Error("Historical engine WASM changed.");
const { ENGINE_SOURCE_COMMIT, ENGINE_WASM_SHA256 } = await import("../engine/v1/upstream.mjs");
if (ENGINE_SOURCE_COMMIT !== manifest.sourceCommit || ENGINE_WASM_SHA256 !== manifest.wasm.sha256) throw new Error("Historical provenance disagrees.");
console.log("Historical engine/v1 snapshot matches its recorded hashes; live builds use engine/src locally.");
