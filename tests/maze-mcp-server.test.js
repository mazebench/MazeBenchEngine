const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-mcp-test-"));
let httpChild = null;

try {
  const seededFramePath = path.join(runDir, "frames", "frame-000.png");
  fs.mkdirSync(path.dirname(seededFramePath), { recursive: true });
  fs.writeFileSync(seededFramePath, Buffer.from("89504e470d0a1a0a", "hex"));
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "maze_clone", arguments: { worker_id: "scout" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "maze_action", arguments: { clone_id: "scout", action: "up" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "maze_action", arguments: { action: "right" } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "maze_action", arguments: { action: "down" } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "maze_action", arguments: { clone_id: "scout", action: "go to level 1 1" } } },
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "maze_clone", arguments: { worker_id: "scout-branch", source_clone_id: "scout", label: "nested search" } } },
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "maze_action", arguments: { clone_id: "scout-branch", action: "left" } } }
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
      MAZEBENCH_ALLOW_LEAD_CLONES: "1",
      MAZEBENCH_MOVE_BUDGET: "1"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert(responses.find((response) => response.id === 2)?.result?.structuredContent?.current_room);
  assert(responses.find((response) => response.id === 10)?.result?.tools?.some((tool) => tool.name === "maze_clone"));
  assert.equal(responses.find((response) => response.id === 3)?.result?.structuredContent?.id, "scout");

  const primary = JSON.parse(fs.readFileSync(path.join(runDir, "session.json"), "utf8"));
  const worker = JSON.parse(fs.readFileSync(path.join(runDir, "swarm", "scout", "session.json"), "utf8"));
  assert.equal(primary.actions.length, 1, "the lead gets exactly its configured action budget");
  assert.equal(worker.actions.length, 1, "worker clone should keep its own action history");
  const workerMetadata = JSON.parse(fs.readFileSync(path.join(runDir, "swarm", "scout", "worker.json"), "utf8"));
  assert.equal(workerMetadata.fork_action_count, 0);
  assert.equal(workerMetadata.owner_kind, "tool");
  const nestedMetadata = JSON.parse(fs.readFileSync(path.join(runDir, "swarm", "scout-branch", "worker.json"), "utf8"));
  const nestedSession = JSON.parse(fs.readFileSync(path.join(runDir, "swarm", "scout-branch", "session.json"), "utf8"));
  const nestedTelemetry = JSON.parse(fs.readFileSync(path.join(runDir, "swarm", "scout-branch", "telemetry.json"), "utf8"));
  assert.equal(nestedMetadata.parent_instance_id, "scout");
  assert.equal(nestedMetadata.fork_action_count, 1);
  assert.equal(nestedSession.actions.length, 2);
  assert.equal(nestedTelemetry.actions_applied, 1);
  assert.equal(nestedTelemetry.own_action_count, 1);
  assert(fs.existsSync(path.join(runDir, "swarm", "scout", "frames", "frame-000.png")));
  assert(fs.existsSync(path.join(runDir, "swarm", "scout-branch", "frames", "frame-000.png")));
  assert.equal(responses.find((response) => response.id === 6)?.result?.isError, true, "the MCP boundary enforces the lead budget");
  const invalidAction = responses.find((response) => response.id === 7)?.result?.content?.[0]?.text || "";
  assert(!invalidAction.includes(rootDir));
  assert(!invalidAction.includes("\n"), "provider errors should not expose runtime stack traces");
  assert(fs.statSync(path.join(runDir, "swarm-workspaces", "scout")).isDirectory());
  const activity = fs.readFileSync(path.join(runDir, "tool-activity.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(activity.some((entry) => entry.tool === "maze_action" && entry.clone_id === "scout"));
  assert(activity.some((entry) => entry.status === "running"));
  const instanceEvents = fs.readFileSync(path.join(runDir, "maze-instance-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(instanceEvents.some((entry) => entry.type === "instance.created" && entry.instance_id === "scout-branch"));
  assert(instanceEvents.some((entry) => entry.type === "instance.action" && entry.instance_id === "scout-branch" && entry.applied));

  const framePath = seededFramePath;
  const imageProbe = spawnSync(
    process.execPath,
    [
      "-e",
      `process.env.MAZEBENCH_RUN_DIR=${JSON.stringify(runDir)};` +
        `const {toolContent}=require(${JSON.stringify(path.join(rootDir, "scripts", "maze-mcp-server.js"))});` +
        `process.stdout.write(JSON.stringify(toolContent({ok:true,session:"/trusted/session.json",workspace:"/trusted/work",frame_image:${JSON.stringify(framePath)}})));`
    ],
    { cwd: rootDir, encoding: "utf8" }
  );
  assert.equal(imageProbe.status, 0, imageProbe.stderr);
  const imageResult = JSON.parse(imageProbe.stdout);
  assert.equal(imageResult.structuredContent.frame_image, "attached:image/png");
  assert.equal(imageResult.structuredContent.session, undefined);
  assert.equal(imageResult.structuredContent.workspace, undefined);
  assert.equal(imageResult.content[1].type, "image");
  assert.equal(imageResult.content[1].mimeType, "image/png");

  const httpDir = path.join(runDir, "http");
  const portFile = path.join(httpDir, "mcp-http.json");
  fs.mkdirSync(httpDir, { recursive: true });
  httpChild = spawn(
    process.execPath,
    [path.join(rootDir, "scripts", "maze-mcp-server.js"), "--http", "--port-file", portFile],
    {
      cwd: rootDir,
      stdio: "ignore",
      env: {
        ...process.env,
        MAZEBENCH_REPO_ROOT: rootDir,
        MAZEBENCH_RUN_DIR: httpDir,
        MAZEBENCH_SESSION_FILE: path.join(httpDir, "session.json"),
        MAZEBENCH_MCP_HTTP_TOKEN: "test-token"
      }
    }
  );
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(portFile) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert(fs.existsSync(portFile), "HTTP MCP server should publish its port");
  const { port } = JSON.parse(fs.readFileSync(portFile, "utf8"));
  const httpProbe = spawnSync(
    "curl",
    [
      "-fsS",
      "-H", "content-type: application/json",
      "-X", "POST",
      "--data", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      `http://127.0.0.1:${port}/test-token/worker`
    ],
    { encoding: "utf8" }
  );
  assert.equal(httpProbe.status, 0, httpProbe.stderr);
  const httpResponse = JSON.parse(httpProbe.stdout);
  assert(!httpResponse.result.tools.some((tool) => tool.name === "maze_start"));
  const leadProbe = spawnSync(
    "curl",
    [
      "-fsS",
      "-H", "content-type: application/json",
      "-X", "POST",
      "--data", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      `http://127.0.0.1:${port}/test-token/lead`
    ],
    { encoding: "utf8" }
  );
  assert.equal(leadProbe.status, 0, leadProbe.stderr);
  const leadResponse = JSON.parse(leadProbe.stdout);
  assert(!leadResponse.result.tools.some((tool) => tool.name === "maze_clone"));
  for (const request of [
    { id: 3, name: "maze_start", arguments: {}, endpoint: "lead" },
    { id: 4, name: "maze_clone", arguments: { worker_id: "http-scout" }, endpoint: "worker" }
  ]) {
    const call = spawnSync(
      "curl",
      [
        "-fsS",
        "-H", "content-type: application/json",
        "-X", "POST",
        "--data", JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          method: "tools/call",
          params: { name: request.name, arguments: request.arguments }
        }),
        `http://127.0.0.1:${port}/test-token/${request.endpoint}`
      ],
      { encoding: "utf8" }
    );
    assert.equal(call.status, 0, call.stderr);
  }
  const httpWorkerMetadata = JSON.parse(
    fs.readFileSync(path.join(httpDir, "swarm", "http-scout", "worker.json"), "utf8")
  );
  assert.equal(httpWorkerMetadata.owner_kind, "subagent");
} finally {
  if (httpChild) httpChild.kill("SIGTERM");
  fs.rmSync(runDir, { recursive: true, force: true });
}

console.log("maze MCP server tests passed");
