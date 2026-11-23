// Import board data only. Stored solutions and solver metadata never enter the
// public world or the benchmark observation surface.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseIceLevel, slideIce, iceSolved } from "../ice-maze/v1/engine.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith("--")) || path.join(root, "../MazeBenchSite"));
const sourceFile = "games/ice_maze/level_list.json";
const bytes = await readFile(path.join(sourceRoot, sourceFile));
const source = JSON.parse(bytes);
if (!Array.isArray(source) || !source.length) throw new Error("Missing source Ice Maze levels.");
const levels = source.map((entry, index) => ({ id: index + 1, board: entry.annotated_board }));
for (const [index, entry] of levels.entries()) {
  const level = parseIceLevel(entry);
  let players = level.players;
  for (const direction of source[index].path || "") players = slideIce(level, players, direction).players;
  if (!iceSolved(level, players)) throw new Error(`Imported level ${entry.id} disagrees with its original rules/solution.`);
}
const sha = value => createHash("sha256").update(value).digest("hex");
const world = { schema_version: 1, id: "ice-maze", name: "Ice Maze", topology: "sequential", level_count: levels.length,
  rules: "All players slide together until walls, board edges, or another player stop them. Goals are slippery. Cover every goal simultaneously at rest.", levels };
const output = `${JSON.stringify(world, null, 2)}\n`;
const provenance = { repository: "https://github.com/mazebench-temp/MazeBenchSite", commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim(),
  source_file: sourceFile, source_sha256: sha(bytes), imported_sha256: sha(output), level_count: levels.length,
  validation: "Every board preserved in source order; all original solution replays passed. Solution paths and solver statistics omitted." };
const destination = path.join(root, "level-data/ice-maze/v1");
if (process.argv.includes("--check")) {
  if (await readFile(path.join(destination, "world.json"), "utf8") !== output) throw new Error("Imported Ice Maze boards drifted from the source.");
} else {
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "world.json"), output);
  await writeFile(path.join(destination, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
}
console.log(`Ice Maze: ${levels.length} boards and all original solution replays verified; no solutions imported.`);
