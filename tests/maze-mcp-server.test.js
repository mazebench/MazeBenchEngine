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
  const firstObservation = responses.find((response) => response.id === 2)?.result?.structuredContent;
  assert.deepEqual(Object.keys(firstObservation || {}), ["level"]);
  assert.match(firstObservation.level, /P|p/);
  assert.equal(Object.prototype.hasOwnProperty.call(firstObservation, "player"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(firstObservation, "scorecard"), false);
  const listedTools = responses.find((response) => response.id === 10)?.result?.tools || [];
  assert(listedTools.some((tool) => tool.name === "maze_clone"));
  assert.equal(listedTools.some((tool) => /scorecard/i.test(tool.name)), false);
  assert.equal(responses.find((response) => response.id === 3)?.result?.structuredContent?.id, "scout");

  const primary = JSON.parse(fs.readFileSync(path.join(runDir, "session.json"), "utf8"));
  const worker = JSON.parse(fs.readFileSync(path.join(runDir, "swarm", "scout", "session.json"), "utf8"));
  assert.equal(primary.actions.length, 1, "the lead gets exactly its configured action budget");
  assert.equal(primary.maxActions, 1, "the helper cap must match the selected finite budget");
  assert.equal(Number.isFinite(Date.parse(primary.actions[0].timestamp)), true, "maze actions retain their exact timestamp");
  assert.equal(worker.actions.length, 1, "worker clone should keep its own action history");
  assert.equal(worker.maxActions, null, "independent worker exploration must not inherit the primary cap");
  const workerMetadata = JSON.parse(fs.readFileSync(path.join(runDir, "swarm", "scout", "worker.json"), "utf8"));
  assert.equal(workerMetadata.fork_action_count, 0);
  assert.equal(workerMetadata.owner_kind, "tool");
  const nestedMetadata = JSON.parse(fs.readFileSync(path.join(runDir, "swarm", "scout-branch", "worker.json"), "utf8"));
  const nestedSession = JSON.parse(fs.readFileSync(path.join(runDir, "swarm", "scout-branch", "session.json"), "utf8"));
  const nestedTelemetry = JSON.parse(fs.readFileSync(path.join(runDir, "swarm", "scout-branch", "telemetry.json"), "utf8"));
  assert.equal(nestedMetadata.parent_instance_id, "scout");
  assert.equal(nestedMetadata.fork_action_count, 1);
  assert.equal(nestedSession.actions.length, 2);
  assert.equal(nestedSession.maxActions, null);
  assert.equal(nestedTelemetry.actions_applied, 1);
  assert.equal(nestedTelemetry.own_action_count, 1);
  assert(fs.existsSync(path.join(runDir, "initial-status.json")));
  assert(fs.existsSync(path.join(runDir, "swarm", "scout", "initial-status.json")));
  assert(fs.existsSync(path.join(runDir, "swarm", "scout-branch", "initial-status.json")));
  assert(fs.existsSync(path.join(runDir, "swarm", "scout", "frames", "frame-000.png")));
  assert(fs.existsSync(path.join(runDir, "swarm", "scout-branch", "frames", "frame-000.png")));
  assert.equal(fs.existsSync(path.join(runDir, "current-render-state.json")), false);
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

  const restrictedDir = path.join(runDir, "restricted");
  fs.mkdirSync(restrictedDir, { recursive: true });
  const restrictedRequests = [
    { jsonrpc: "2.0", id: 90, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 91, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 92, method: "tools/call", params: { name: "game_start", arguments: {} } },
    { jsonrpc: "2.0", id: 93, method: "tools/call", params: { name: "game_observe", arguments: { clone_id: "scout" } } },
    { jsonrpc: "2.0", id: 94, method: "tools/call", params: { name: "maze_workers", arguments: {} } },
    { jsonrpc: "2.0", id: 95, method: "tools/call", params: { name: "game_action", arguments: { action: "right", clone_id: "scout" } } },
    { jsonrpc: "2.0", id: 96, method: "tools/call", params: { name: "game_scorecard", arguments: {} } }
  ];
  const restrictedResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${restrictedRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: restrictedDir,
      MAZEBENCH_SESSION_FILE: path.join(restrictedDir, "session.json"),
      MAZEBENCH_RESTRICTED_MODE: "1",
      MAZEBENCH_MOVE_BUDGET: "1"
    }
  });
  assert.equal(restrictedResult.status, 0, restrictedResult.stderr);
  const restrictedResponses = restrictedResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(restrictedResponses.find((response) => response.id === 90)?.result?.serverInfo?.name, "game");
  const restrictedTools = restrictedResponses.find((response) => response.id === 91)?.result?.tools || [];
  assert.deepEqual(
    restrictedTools.map((tool) => tool.name),
    ["game_start", "game_observe", "game_action"]
  );
  assert.doesNotMatch(JSON.stringify(restrictedTools), /MazeBench|clone_id|worker/i);
  const restrictedObservation = restrictedResponses.find((response) => response.id === 92)?.result?.structuredContent;
  assert.deepEqual(Object.keys(restrictedObservation || {}), ["level"]);
  assert.match(restrictedObservation.level, /P|p/);
  for (const id of [93, 94, 95, 96]) {
    assert(restrictedResponses.find((response) => response.id === id)?.error, `restricted request ${id} must fail closed`);
  }

  const noQuitDir = path.join(runDir, "no-quit");
  fs.mkdirSync(noQuitDir, { recursive: true });
  const noQuitRequests = [
    { jsonrpc: "2.0", id: 20, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 21, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    { jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "maze_action", arguments: { action: "quit" } } },
    { jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "maze_observe", arguments: {} } }
  ];
  const noQuitResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${noQuitRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: noQuitDir,
      MAZEBENCH_SESSION_FILE: path.join(noQuitDir, "session.json"),
      MAZEBENCH_SWARM_DIR: path.join(noQuitDir, "swarm"),
      MAZEBENCH_ALLOW_QUIT: "0",
      MAZEBENCH_MOVE_BUDGET: "5"
    }
  });
  assert.equal(noQuitResult.status, 0, noQuitResult.stderr);
  const noQuitResponses = noQuitResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const noQuitActionTool = noQuitResponses
    .find((response) => response.id === 21)?.result?.tools
    ?.find((tool) => tool.name === "maze_action");
  assert.doesNotMatch(noQuitActionTool?.inputSchema?.properties?.action?.description || "", /quit/i);
  assert.equal(noQuitResponses.find((response) => response.id === 23)?.result?.isError, true);
  assert.doesNotMatch(
    JSON.stringify(noQuitResponses.find((response) => response.id === 22)?.result?.structuredContent?.allowed_commands || []),
    /quit/i
  );
  assert.doesNotMatch(
    JSON.stringify(noQuitResponses.find((response) => response.id === 24)?.result?.structuredContent?.allowed_commands || []),
    /quit/i
  );
  const noQuitSession = JSON.parse(fs.readFileSync(path.join(noQuitDir, "session.json"), "utf8"));
  assert.equal(noQuitSession.allowQuit, false, "the policy must persist inside the maze session");
  assert.equal(noQuitSession.actions.length, 0, "a blocked quit must not consume an action");
  assert.equal(Boolean(noQuitSession.lastStatus?.quit), false, "a blocked quit must not mark the maze terminal");
  const directQuit = spawnSync(
    process.execPath,
    [path.join(rootDir, "scripts", "codex-play.js"), "action", "--state", path.join(noQuitDir, "session.json"), "quit"],
    { cwd: rootDir, encoding: "utf8" }
  );
  assert.notEqual(directQuit.status, 0, "the lower-level helper must not bypass the no-quit policy");
  assert.match(directQuit.stderr, /Quit is disabled by the user/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(noQuitDir, "session.json"), "utf8")).actions.length,
    0,
    "a direct blocked quit must also consume no action"
  );

  const jsonDir = path.join(runDir, "json-mode");
  fs.mkdirSync(jsonDir, { recursive: true });
  const jsonRequests = [
    { jsonrpc: "2.0", id: 25, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 26, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    { jsonrpc: "2.0", id: 27, method: "tools/call", params: { name: "maze_observe", arguments: {} } }
  ];
  const jsonResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${jsonRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: jsonDir,
      MAZEBENCH_SESSION_FILE: path.join(jsonDir, "session.json"),
      MAZEBENCH_MODE: "json",
      MAZEBENCH_OMNISCIENT: "1",
      MAZEBENCH_HIDE_NAMES: "1",
      MAZEBENCH_HIDE_NAMES_SEED: "mcp-repeatable-seed"
    }
  });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const jsonResponses = jsonResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const jsonStatus = jsonResponses.find((response) => response.id === 27)?.result?.structuredContent;
  assert.equal(jsonStatus.observation_mode, "json");
  assert.equal(jsonStatus.level, undefined);
  assert.equal(jsonStatus.json_observation.omniscient, true);
  assert.equal(jsonStatus.json_observation.hide_names, true);
  assert.equal(jsonStatus.json_observation.objects.player.length > 0, true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(jsonDir, "session.json"), "utf8")).hideNamesSeed,
    "mcp-repeatable-seed"
  );

  const unlimitedDir = path.join(runDir, "unlimited");
  fs.mkdirSync(unlimitedDir, { recursive: true });
  const unlimitedRequests = [
    { jsonrpc: "2.0", id: 31, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    ...Array.from({ length: 3 }, (_, index) => ({
      jsonrpc: "2.0",
      id: 33 + index,
      method: "tools/call",
      params: { name: "maze_action", arguments: { action: index % 2 ? "left" : "right" } }
    }))
  ];
  const unlimitedResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${unlimitedRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: unlimitedDir,
      MAZEBENCH_SESSION_FILE: path.join(unlimitedDir, "session.json"),
      MAZEBENCH_MOVE_BUDGET: "unlimited",
      MAZEBENCH_ALLOW_QUIT: "0"
    }
  });
  assert.equal(unlimitedResult.status, 0, unlimitedResult.stderr);
  const unlimitedResponses = unlimitedResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert(unlimitedResponses.filter((response) => response.id >= 33).every((response) => !response.result?.isError));
  const unlimitedSession = JSON.parse(fs.readFileSync(path.join(unlimitedDir, "session.json"), "utf8"));
  assert.equal(unlimitedSession.actions.length, 3, "unlimited mode must not enforce a hidden segment budget");
  assert.equal(unlimitedSession.maxActions, null, "unlimited mode must not persist a hidden helper cap");

  const largeBudgetDir = path.join(runDir, "large-budget");
  fs.mkdirSync(largeBudgetDir, { recursive: true });
  const largeBudgetRequests = [
    { jsonrpc: "2.0", id: 37, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 38, method: "tools/call", params: { name: "maze_start", arguments: {} } }
  ];
  const largeBudgetResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${largeBudgetRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: largeBudgetDir,
      MAZEBENCH_SESSION_FILE: path.join(largeBudgetDir, "session.json"),
      MAZEBENCH_MOVE_BUDGET: "125"
    }
  });
  assert.equal(largeBudgetResult.status, 0, largeBudgetResult.stderr);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(largeBudgetDir, "session.json"), "utf8")).maxActions,
    125,
    "finite selections above the old default must persist their exact cap"
  );

  const coldPauseDir = path.join(runDir, "cold-pause");
  fs.mkdirSync(coldPauseDir, { recursive: true });
  fs.writeFileSync(
    path.join(coldPauseDir, "pause-request.json"),
    JSON.stringify({ requested_at: "2026-07-10T00:00:00.000Z", requested_after_turn: 0 })
  );
  const coldPauseRequests = [
    { jsonrpc: "2.0", id: 41, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "maze_start", arguments: {} } },
    { jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "maze_action", arguments: { action: "right" } } },
    { jsonrpc: "2.0", id: 44, method: "tools/call", params: { name: "maze_action", arguments: { action: "left" } } }
  ];
  const coldPauseResult = spawnSync(process.execPath, [path.join(rootDir, "scripts", "maze-mcp-server.js")], {
    cwd: rootDir,
    encoding: "utf8",
    input: `${coldPauseRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      MAZEBENCH_REPO_ROOT: rootDir,
      MAZEBENCH_RUN_DIR: coldPauseDir,
      MAZEBENCH_SESSION_FILE: path.join(coldPauseDir, "session.json"),
      MAZEBENCH_MOVE_BUDGET: "unlimited",
      MAZEBENCH_ALLOW_QUIT: "0"
    }
  });
  assert.equal(coldPauseResult.status, 0, coldPauseResult.stderr);
  const coldPauseResponses = coldPauseResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(coldPauseResponses.find((response) => response.id === 43)?.result?.structuredContent?.user_pause_requested, true);
  assert.equal(coldPauseResponses.find((response) => response.id === 44)?.result?.isError, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(coldPauseDir, "session.json"), "utf8")).actions.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(coldPauseDir, "pause-boundary.json"), "utf8")).completed_turn, 1);

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
