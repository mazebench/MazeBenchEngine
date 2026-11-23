import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { COMPACTION_REPAIR_FILES } from "../scripts/repair-benchmark-compaction-v1.mjs";

// Historical operator migrations deliberately authorize exact source hashes.
// Give their tests a private asset tree with those frozen historical files,
// so a later supervisor edit never expands the production migration allowlist.
export async function historicalRepairFixture(projectRoot) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mazebench-historical-runtime-"));
  try {
    for (const relative of ["benchmarking/storage", "benchmarking/v1", "benchmarking/providers", "benchmarking/worlds", "engine/v1", "play/v1", "render/v1", "render-ascii/v1", "level-data/v2/main-world", "level-data/ice-maze/v1", "ice-maze/v1"])
      await cp(path.join(projectRoot, relative), path.join(root, relative), { recursive: true });
    for (const [relative, hashes] of Object.entries(COMPACTION_REPAIR_FILES)) {
      const bytes = await readFile(new URL(`./fixtures/transport-repair-${path.basename(relative)}.txt`, import.meta.url));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), hashes.after);
      await writeFile(path.join(root, relative), bytes);
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
