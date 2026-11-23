import { boundToolResult, readResponsePage } from "../antigravity-code-v3/response-pages.mjs";
// A serial, attested gate around the unchanged signed game MCP servers.
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { safeReadFile } from "../v1/safe-files.mjs";
import { readCheckpointJson } from "../v1/checkpoint-json.mjs";
import { verifyCodeIntegrity, codeTools } from "./policy.mjs";
import { runSandboxedCode } from "../code/sandbox.mjs";

const root = process.env.MAZEBENCH_PROJECT_ROOT, directory = process.env.MAZEBENCH_RUN_DIRECTORY;
if (!root || !directory) throw new Error("Missing benchmark paths.");
let metadata = JSON.parse(safeReadFile(directory, "run.json"));
await verifyCodeIntegrity(root, directory, metadata);
const folder = metadata.world === "slotski" ? "slotski" : metadata.world === "ice-maze" ? "worlds" : "v1";
const child = spawn(process.execPath, [path.join(root, `benchmarking/${folder}/mcp-server.mjs`)], {
  env: { PATH: "/usr/bin:/bin", MAZEBENCH_PROJECT_ROOT: root, MAZEBENCH_RUN_DIRECTORY: directory,
    MAZEBENCH_PYTHON_ENABLED: "1", MAZEBENCH_CAPABILITY_POLICY: "os-isolated-v4" },
  stdio: ["pipe", "pipe", "inherit"]
});
export const codeTool = {
  name: "code_exec",
  description: "Run a shell command in an isolated persistent /workspace with Python, Node.js, C/C++, Rust, Go, Java, Ruby, Perl and Lua. Optional source files are saved first. Compile/run any installed language. No network, host files, credentials, repository, benchmark records, private state or game-tool access. Only /workspace persists; all processes are stopped after each call. Call game tools directly outside code.",
  inputSchema: { type: "object", properties: {
    command: { type: "string", minLength: 1, maxLength: 256_000 },
    files: { type: "array", maxItems: 50, items: { type: "object", properties: {
      path: { type: "string", minLength: 1, maxLength: 240 }, content: { type: "string", maxLength: 256_000 }
    }, required: ["path", "content"], additionalProperties: false } },
    timeout_seconds: { type: "integer", minimum: 1, maximum: 60, default: 10 }
  }, required: ["command"], additionalProperties: false }
};
const send = value => {
  if (metadata.provider === "antigravity" && value.result?.content) value.result = boundToolResult(directory, value.result);
  process.stdout.write(JSON.stringify(value) + "\n");
};
const safeError = error => String(error.message || error).split("\n")[0].replaceAll(root, "[benchmark runtime]").replaceAll(directory, "[run]");
const result = (id, value, isError = false) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError } });
let pending = null;
readline.createInterface({ input: child.stdout }).on("line", line => {
  try {
    const response = JSON.parse(line);
    if (response.result?.tools) {
      response.result.tools = response.result.tools.filter(tool => codeTools({ sequenceEnabled: metadata.sequence_enabled }).includes(tool.name));
      response.result.tools.push(codeTool);
      if (metadata.provider === "claude-code") for (const tool of response.result.tools) delete tool.inputSchema.oneOf;
    }
    send(response);
    if (pending && response.id === pending.id) { pending.resolve(); pending = null; }
  } catch (error) { invalidate(error); }
});
function invalidate(error) {
  writeFileSync(path.join(directory, "integrity-violation.json"), JSON.stringify({ error: safeError(error) }), { mode: 0o600 });
  child.kill("SIGKILL");
  process.exitCode = 1;
  pending?.reject(error); pending = null;
  lines.close(); process.stdin.destroy();
}
async function executeCode(request) {
  const input = request.params.arguments;
  const before = (await readCheckpointJson(directory, "summary.json")).action_count;
  const activity = { id: randomUUID(), at: new Date().toISOString(), tool: "code_exec", status: "running", action_count_before: before,
    code_sha256: createHash("sha256").update(JSON.stringify(input ?? {})).digest("hex") };
  const record = value => appendFileSync(path.join(directory, "tool-activity.jsonl"), JSON.stringify(value) + "\n");
  record(activity);
  try {
    const value = await runSandboxedCode(input, { runDirectory: directory, sandbox: metadata.code_sandbox });
    record({ ...activity, status: "completed", completed_at: new Date().toISOString(), action_count_after: before, result: value });
    result(request.id, value);
  } catch (error) {
    record({ ...activity, status: "failed", completed_at: new Date().toISOString(), error: safeError(error), action_count_after: before });
    result(request.id, { error: safeError(error) }, true);
  }
}
let queue = Promise.resolve();
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  queue = queue.then(async () => {
    const request = JSON.parse(line);
    metadata = JSON.parse(safeReadFile(directory, "run.json"));
    await verifyCodeIntegrity(root, directory, metadata);
    // Native MCP clients probe resources even when only tools are advertised.
    // Keep these protocol probes harmless without exposing any file or record.
    if (request.method === "resources/list") { send({ jsonrpc: "2.0", id: request.id, result: { resources: [] } }); return; }
    if (request.method === "resources/templates/list") { send({ jsonrpc: "2.0", id: request.id, result: { resourceTemplates: [] } }); return; }
    if (request.method === "resources/read") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "This server exposes no resources. Use maze_observe for allowlisted records." } });
      return;
    }
    if (!["initialize", "notifications/initialized", "notifications/cancelled", "ping", "tools/list", "tools/call"].includes(request.method)) throw new Error("Unsupported MCP operation.");
    if (request.method === "tools/call") {
      if (!codeTools({ sequenceEnabled: metadata.sequence_enabled }).includes(request.params?.name)) {
        result(request.id, { error: "Tool is unavailable in this coding condition." }, true); return;
      }
      if (request.params.name === "code_exec") return executeCode(request);
      if (metadata.provider === "antigravity" && request.params.name === "maze_observe" && String(request.params.arguments?.record || "").startsWith("response_pages/")) {
        try {
          if (Object.keys(request.params.arguments).some(key => key !== "record")) throw new Error("Unsupported response-page argument.");
          send({ jsonrpc: "2.0", id: request.id, result: readResponsePage(directory, request.params.arguments.record) });
        } catch (error) { result(request.id, { error: safeError(error) }, true); }
        return;
      }
    }
    const response = request.id === undefined ? Promise.resolve() : new Promise((resolve, reject) => { pending = { id: request.id, resolve, reject }; });
    child.stdin.write(line + "\n"); await response;
  }).catch(invalidate);
});
lines.on("close", () => { void queue.finally(() => child.stdin.end()); });
child.on("exit", code => { pending?.reject(new Error("Game MCP exited.")); process.exit(code || 0); });
child.on("error", error => { process.stderr.write(safeError(error) + "\n"); process.exit(1); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  // Finish the current bounded code call and its container cleanup before exit.
  lines.close(); process.stdin.destroy();
  void queue.finally(() => { child.kill(signal); process.exit(); });
});
