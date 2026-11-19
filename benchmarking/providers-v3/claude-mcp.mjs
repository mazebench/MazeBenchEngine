// Trusted serial gate around the shared MazeBench MCP. The original game and
// Python executor remain identical across providers; new provider code is also
// frozen and verified before every request, including discovery.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { safeReadFile } from "../v1/safe-files.mjs";
import { verifyClaudeIntegrity } from "./claude-policy.mjs";

const root = process.env.MAZEBENCH_PROJECT_ROOT;
const directory = process.env.MAZEBENCH_RUN_DIRECTORY;
if (!root || !directory) throw new Error("Missing benchmark paths.");
const metadata = JSON.parse(safeReadFile(directory, "run.json"));
await verifyClaudeIntegrity(root, directory, metadata);
const child = spawn(process.execPath, [path.join(root, "benchmarking/v1/mcp-server.mjs")], {
  env: { PATH: "/usr/bin:/bin", MAZEBENCH_PROJECT_ROOT: root, MAZEBENCH_RUN_DIRECTORY: directory,
    MAZEBENCH_PYTHON_ENABLED: metadata.tools_enabled ? "1" : "0", MAZEBENCH_CAPABILITY_POLICY: "os-isolated-v4" },
  stdio: ["pipe", "pipe", "inherit"]
});
let pending = null;
readline.createInterface({ input: child.stdout }).on("line", line => {
  try {
    const response = JSON.parse(line);
    // Claude rejects top-level oneOf schemas. The shared MCP still enforces
    // exactly one of sequence/actions on every call; only discovery differs.
    for (const tool of response.result?.tools || []) delete tool.inputSchema.oneOf;
    process.stdout.write(`${JSON.stringify(response)}\n`);
    if (pending && response.id === pending.id) { pending.resolve(); pending = null; }
  } catch { child.kill("SIGKILL"); }
});
let queue = Promise.resolve();
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  queue = queue.then(async () => {
    const request = JSON.parse(line);
    await verifyClaudeIntegrity(root, directory, metadata);
    const response = request.id === undefined ? Promise.resolve() : new Promise(resolve => { pending = { id: request.id, resolve }; });
    child.stdin.write(`${line}\n`);
    await response;
  }).catch(error => {
    writeFileSync(path.join(directory, "integrity-violation.json"), JSON.stringify({ error: error.message }), { mode: 0o600 });
    child.kill("SIGKILL");
    process.exitCode = 1;
    lines.close();
    process.stdin.destroy();
  });
});
lines.on("close", () => { void queue.finally(() => child.stdin.end()); });
child.on("exit", code => { pending?.resolve(); process.exit(code || 0); });
child.on("error", error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
process.on("SIGTERM", () => { child.kill("SIGTERM"); process.exit(); });
process.on("SIGINT", () => { child.kill("SIGINT"); process.exit(); });
