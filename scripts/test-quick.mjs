import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Keep slow browser/vision integrations available separately; npm test still
// runs the complete suite, including every file excluded from this quick loop.
const integrations = new Set(["vision-mode.test.mjs", "vision-wire.test.mjs", "ice-maze.test.mjs"]);
const files = ["apps/web/tests", "engine/tests", "tests"].flatMap(directory =>
  readdirSync(directory).filter(name => name.endsWith(".test.mjs") && !(directory === "tests" && integrations.has(name)))
    .sort().map(name => `${directory}/${name}`));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
