const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-mcp-test-"));

try {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "maze_clone", arguments: { worker_id: "scout" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "maze_action", arguments: { clone_id: "scout", action: "up" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "maze_action", arguments: { action: "right" } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "maze_action", arguments: { action: "down" } } }
  ];
  const result = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: runDir,
      MAZEBENCH_SESSION_FILE: path.join(runDir, "session.json"),
      MAZEBENCH_SWARM_DIR: path.join(runDir, "swarm"),
      MAZEBENCH_MOVE_BUDGET: "1"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert(responses.find((response) => response.id === 2)?.result?.structuredContent?.current_room);
  assert.equal(responses.find((response) => response.id === 3)?.result?.structuredContent?.id, "scout");

  const primary = JSON.parse(fs.readFileSync(path.join(runDir, "session.json"), "utf8"));
  const worker = JSON.parse(fs.readFileSync(path.join(runDir, "swarm", "scout", "session.json"), "utf8"));
  assert.equal(primary.actions.length, 1, "the lead gets exactly its configured action budget");
  assert.equal(worker.actions.length, 1, "worker clone should keep its own action history");
  assert.equal(responses.find((response) => response.id === 6)?.result?.isError, true, "the MCP boundary enforces the lead budget");
  assert(fs.statSync(path.join(runDir, "swarm", "scout", "workspace")).isDirectory());
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}

console.log("maze MCP server tests passed");
