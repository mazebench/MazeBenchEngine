// Serial, integrity-checking gate around the shared MazeBench MCP. Antigravity sees
// only this server; its generic call_mcp_tool gateway is validated by
// the runner before any result can count toward a benchmark.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { safeReadFile } from "../v1/safe-files.mjs";
import { verifyIntegrity as verifyAntigravityIntegrity } from "./policy.mjs";
import { boundToolResult, readResponsePage } from "./response-pages.mjs";

const root = process.env.MAZEBENCH_PROJECT_ROOT;
const directory = process.env.MAZEBENCH_RUN_DIRECTORY;
if (!root || !directory) throw new Error("Missing benchmark paths.");
const metadata = JSON.parse(safeReadFile(directory, "run.json"));
await verifyAntigravityIntegrity(root, directory, metadata);
const child = spawn(process.execPath, [path.join(root, "benchmarking/v1/mcp-server.mjs")], {
  env: {
    PATH: "/usr/bin:/bin",
    MAZEBENCH_PROJECT_ROOT: root,
    MAZEBENCH_RUN_DIRECTORY: directory,
    MAZEBENCH_PYTHON_ENABLED: metadata.tools_enabled ? "1" : "0",
    MAZEBENCH_CAPABILITY_POLICY: "os-isolated-v4"
  },
  stdio: ["pipe", "pipe", "inherit"]
});
let pending = null;
readline.createInterface({ input: child.stdout }).on("line", line => {
  try {
    const response = JSON.parse(line);
    if (response.result?.content) response.result = boundToolResult(directory, response.result);
    process.stdout.write(`${JSON.stringify(response)}\n`);
    if (pending && response.id === pending.id) { pending.resolve(); pending = null; }
  } catch { child.kill("SIGKILL"); }
});
let queue = Promise.resolve();
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  queue = queue.then(async () => {
    const request = JSON.parse(line);
    await verifyAntigravityIntegrity(root, directory, metadata);
    if (request.method === "tools/call" && request.params?.name === "maze_observe" && String(request.params.arguments?.record || "").startsWith("response_pages/")) {
      let result;
      try {
        if (Object.keys(request.params.arguments).some(key => key !== "record")) throw new Error("Unsupported response-page argument.");
        result = readResponsePage(directory, request.params.arguments.record);
      } catch (error) { result = { isError: true, content: [{ type: "text", text: error.code === "ENOENT" ? "Unknown response page." : error.message }] }; }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      return;
    }
    const response = request.id === undefined ? Promise.resolve() : new Promise(resolve => { pending = { id: request.id, resolve }; });
    child.stdin.write(`${line}\n`);
    await response;
  }).catch(error => {
    writeFileSync(path.join(directory, "integrity-violation.json"), JSON.stringify({ error: error.message, at: new Date().toISOString() }), { mode: 0o600 });
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
