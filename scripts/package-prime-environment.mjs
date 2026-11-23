#!/usr/bin/env node

// Package only the game's dependency closure. Never include the local agent
// launchers, credentials, benchmark records, editor, or solver wrappers.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "environments/mazebench/mazebench/runtime");
const check = process.argv.includes("--check");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const files = new Map();

async function add(relative) {
  if (files.has(relative)) return;
  if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("Asset outside repository.");
  const bytes = await readFile(path.join(root, relative));
  files.set(relative, bytes);
  if (!relative.endsWith(".mjs")) return;
  for (const match of bytes.toString("utf8").matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
    await add(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
  }
}

await add("benchmarking/v1/runtime.mjs");
await add("engine/v1/voxel_physics.wasm");
await add("engine/v1/upstream.json");
await add("LICENSE");
const levelRoot = "level-data/v2/main-world";
const world = JSON.parse(await readFile(path.join(root, levelRoot, "world.json"), "utf8"));
for (const name of ["world.json", ...Object.keys(world.rooms)]) await add(`${levelRoot}/${name}`);

const ordered = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, hash(bytes)]));
const snapshot = {
  schema_version: 1,
  source_repository: "https://github.com/mazebench/MazeBenchBenchmarking",
  // Per-file hashes identify the exact working-tree snapshot, including edits
  // not yet committed. The git revision is contextual provenance only.
  source_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  snapshot_sha256: hash(JSON.stringify(ordered)),
  files: ordered
};
files.set("snapshot.json", Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`));

if (check) {
  const actual = [];
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${name}/`);
      else actual.push(name);
    }
  }
  await walk(target);
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...files.keys()].sort())) throw new Error("Packaged file inventory differs; prepare the package again.");
  for (const [name, bytes] of files) {
    // A later commit alone does not invalidate a byte-identical snapshot.
    if (name === "snapshot.json") {
      const saved = JSON.parse(await readFile(path.join(target, name), "utf8"));
      if (saved.snapshot_sha256 !== snapshot.snapshot_sha256) throw new Error("Packaged snapshot is stale.");
    } else if (!(await readFile(path.join(target, name))).equals(bytes)) throw new Error(`Packaged asset is stale: ${name}`);
  }
} else {
  await rm(target, { recursive: true, force: true });
  for (const [name, bytes] of files) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await writeFile(path.join(target, name), bytes);
  }
}
console.log(`${check ? "Verified" : "Prepared"} ${files.size} files; snapshot ${snapshot.snapshot_sha256}`);
