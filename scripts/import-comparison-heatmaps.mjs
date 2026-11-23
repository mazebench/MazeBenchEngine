// node scripts/import-comparison-heatmaps.mjs [http://localhost:3000/] [--from-repo /path/to/old/repo]
// Copies every historical run variant, including unstarred runs. File imports
// read snapshots without starting the old server or any benchmark agents.
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { importLeaderboardHeatmap } from "../benchmarking/ui/heatmap-import.mjs";
import { readLegacyHeatmap } from "../benchmarking/legacy-heatmap-import.mjs";

const args = process.argv.slice(2), fromRepo = args.indexOf('--from-repo');
if (fromRepo >= 0 && !args[fromRepo + 1]) throw new Error('--from-repo requires the old repository path.');
const sourceDirectory = fromRepo >= 0 ? path.resolve(args[fromRepo + 1], 'outputs/maze-local/site') : null;
const origin = new URL(args.find(value => /^https?:\/\//.test(value)) || "http://localhost:3000/").origin;
const sourceKey = createHash("sha256").update(origin).digest("hex").slice(0, 12);
const directory = new URL("../benchmarking/imports/", import.meta.url);
const importedAt = new Date().toISOString();
async function get(path) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
async function save(name, value) {
  const file = new URL(name, directory), temp = new URL(`${name}.${process.pid}.tmp`, directory);
  await writeFile(temp, `${JSON.stringify(value)}\n`);
  await rename(temp, file);
}
const summaries = [];
if (sourceDirectory) {
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T[\w-]+$/.test(entry.name)) summaries.push({ id: entry.name });
  }
} else for (let page = 1; ; page++) {
  const value = await get(`/api/agent/runs?page_size=100&sort=newest&page=${page}`);
  if (!Array.isArray(value.runs)) throw new Error("Source did not return a run list.");
  summaries.push(...value.runs);
  if (page >= (value.pages || 1)) break;
}
await mkdir(directory, { recursive: true });
let previous = { runs: [] };
try { previous = JSON.parse(await readFile(new URL("index.json", directory), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const imported = new Map(previous.runs.map(run => [run.id, run]));
let count = 0;
// Keep source work bounded; older reports can reconstruct missing positions.
for (let offset = 0; offset < summaries.length; offset += 3) {
  const batch = await Promise.allSettled(summaries.slice(offset, offset + 3).map(async summary => {
    const options = { origin, importedAt, sourceKey };
    let result;
    if (sourceDirectory) {
      let previousReport;
      try { previousReport = JSON.parse(await readFile(new URL(`import-${sourceKey}-${encodeURIComponent(summary.id)}.json`, directory), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      result = await readLegacyHeatmap(path.join(sourceDirectory, summary.id), options, previousReport);
    } else {
      const payload = await get(`/api/leaderboard/runs/${encodeURIComponent(summary.id)}`);
      result = importLeaderboardHeatmap(payload, options);
    }
    const { metadata, report } = result;
    await save(`${metadata.id}.json`, report);
    imported.set(metadata.id, metadata);
    count++;
    console.log(`${metadata.source.run_id} ${metadata.model}: ${report.heatmap.points.length} tiles, ${report.heatmap.total} visits`);
  }));
  for (const result of batch) if (result.status === "rejected") console.error(`Skipped: ${result.reason.message}`);
}
await save("index.json", { version: 1, runs: [...imported.values()] });
console.log(`Imported ${count}/${summaries.length} heatmaps into ${fileURLToPath(directory)}`);
if (count < summaries.length) process.exitCode = 1;
