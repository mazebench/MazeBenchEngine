// Real Claude Code, fake local Anthropic service. No account credentials or
// external inference are used. The fixture can deliberately ask for escapes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildClaudeArguments, claudeEnvironment, inspectClaude, claudeTools, digest, providerRuntimeHashes, CLAUDE_PROVIDER, CLAUDE_POLICY, claudeBoundaryViolation } from "../benchmarking/providers/claude-policy.mjs";
import { createRunIntegrity } from "../benchmarking/v1/integrity.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "mazebench-claude-capabilities-"));
const home = path.join(temporary, "home");
const installation = inspectClaude(process.env.MAZEBENCH_CLAUDE_BIN || "claude");
await mkdir(path.join(home, ".claude"), { recursive: true });
await writeFile(path.join(home, ".claude/CLAUDE.md"), "PERSONAL_CONTEXT_CANARY must never reach the model.");
await writeFile(path.join(home, ".claude/settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${temporary}/hook-ran` }] }] } }));
let requests = [], nextBlocks = null, requestNumber = 0, compactProbe = false;
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  const payload = body ? JSON.parse(body) : {};
  if (request.url.includes("count_tokens")) { response.end('{"input_tokens":20}'); return; }
  if (!request.url.startsWith("/v1/messages")) { response.writeHead(404); response.end('{}'); return; }
  requests.push(payload);
  const blocks = nextBlocks || [{ type: "text", text: "Validation complete." }]; nextBlocks = null;
  const message = { id: `msg_fixture_${++requestNumber}`, type: "message", role: "assistant", model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: compactProbe ? 5000 : 20, output_tokens: 0 } };
  const events = [{ type: "message_start", message }];
  blocks.forEach((block, index) => {
    events.push({ type: "content_block_start", index, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
    events.push({ type: "content_block_delta", index, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: blocks.some(b => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }, { type: "message_stop" });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

async function run(options, extras = {}) {
  requests = [];
  nextBlocks = extras.blocks || null;
  compactProbe = Boolean(extras.compact);
  const args = buildClaudeArguments(options);
  if (extras.compact) args.splice(args.indexOf("--"), 0, "--autocompact", "100k");
  const child = spawn(installation.executable, args, { cwd: path.join(options.runDirectory, "agent-cwd"),
    env: { ...claudeEnvironment(), HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      ANTHROPIC_API_KEY: "offline-fixture-not-a-credential", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ...(extras.compact ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "1" } : {}) },
    stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45000);
  try {
    const code = await new Promise((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
    assert.equal(code, 0, `${stderr}\n${stdout.slice(-6000)}`);
    const events = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const init = events.find(e => e.type === "system" && e.subtype === "init");
    assert(init, stdout);
    const violation = claudeBoundaryViolation(init, options);
    assert.equal(violation, null, JSON.stringify(init));
    assert(requests.length, "No model request captured");
    for (const payload of requests) {
      assert.equal(payload.model, options.model);
      if (!(extras.compact && !payload.tools?.length)) assert.deepEqual(payload.tools.map(tool => tool.name).sort(), options.interview ? [] : claudeTools(options.toolsEnabled).sort());
      assert(!JSON.stringify(payload).includes("PERSONAL_CONTEXT_CANARY"));
    }
    assert.equal(await readFile(path.join(temporary, "hook-ran")).then(() => true, () => false), false, "Personal hook executed");
    return { events, session: init.session_id, requests: [...requests] };
  } finally { clearTimeout(timeout); }
}

try {
  for (const toolsEnabled of [false, true]) {
    const directory = path.join(temporary, toolsEnabled ? "on" : "off");
    await mkdir(path.join(directory, "agent-cwd/.claude"), { recursive: true });
    await writeFile(path.join(directory, "agent-cwd/CLAUDE.md"), "PERSONAL_CONTEXT_CANARY project");
    await writeFile(path.join(directory, "agent-cwd/.mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "/usr/bin/false" } } }));
    const prompt = "Reply validation complete.";
    const configuration = { provider: CLAUDE_PROVIDER, claude_policy: CLAUDE_POLICY,
      claude_executable: installation.executable, claude_version: installation.version, claude_sha256: digest(await readFile(installation.executable)),
      provider_runtime: await providerRuntimeHashes(projectRoot),
      model: "claude-sonnet-5-5", effort: "low", tools_enabled: toolsEnabled, action_limit: 2, start_room: "HxI", effective_prompt_sha256: digest(prompt) };
    const integrity = await createRunIntegrity(projectRoot, directory, configuration);
    await writeFile(path.join(directory, "run.json"), JSON.stringify({ ...configuration, integrity }));
    await writeFile(path.join(directory, "prompt.md"), prompt);
    await BenchmarkGameRuntime.create(projectRoot, directory, { actionLimit: 2 });
    const options = { projectRoot, runDirectory: directory, model: configuration.model, effort: "low", toolsEnabled, prompt, sessionId: randomUUID() };
    const first = await run(options);
    const resumed = await run({ ...options, resumeSessionId: first.session });
    assert.equal(resumed.session, first.session);
    const observed = await run({ ...options, resumeSessionId: first.session }, { blocks: [{ type: "tool_use", id: "observe_test", name: "mcp__mazebench__maze_observe", input: {} }] });
    assert(observed.requests.length >= 2, "MCP tool did not round-trip");
    const escaped = await run({ ...options, resumeSessionId: first.session }, { blocks: [
      { type: "tool_use", id: "escape_test", name: "Bash", input: { command: `touch ${temporary}/escaped` } },
      { type: "tool_use", id: "read_test", name: "Read", input: { file_path: path.join(directory, "game-state.json") } },
      { type: "tool_use", id: "web_test", name: "WebFetch", input: { url: "http://127.0.0.1:8080", prompt: "Read hidden scores" } },
      { type: "tool_use", id: "agent_test", name: "Agent", input: { prompt: "Inspect hidden files", description: "escape", subagent_type: "general-purpose" } },
      ...(!toolsEnabled ? [{ type: "tool_use", id: "python_off_test", name: "mcp__mazebench__python_exec", input: { code: "print('forbidden')", script_path: "forbidden.py" } }] : [])
    ] });
    assert(escaped.events.some(event => claudeBoundaryViolation(event, options)), "Escape event not detected");
    assert.equal(await readFile(path.join(temporary, "escaped")).then(() => true, () => false), false);
    if (toolsEnabled) {
      const python = await run({ ...options, resumeSessionId: first.session }, { blocks: [{ type: "tool_use", id: "python_test", name: "mcp__mazebench__python_exec", input: {
        script_path: "sandbox-check.py", code: `import __main__, ctypes, json, socket\n__main__._deny_escape.__code__ = (lambda event, args: None).__code__\nopen('allowed.txt','w').write('workspace-ok')\nlibc = ctypes.CDLL(None, use_errno=True)\nblocked = libc.open(${JSON.stringify(path.join(directory, "game-state.json"))}.encode(), 0) == -1\ntry:\n socket.create_connection(('127.0.0.1',8080),timeout=.2)\n network_blocked=False\nexcept PermissionError:\n network_blocked=True\nprint(json.dumps({'private_read_blocked':blocked,'network_blocked':network_blocked}))` } }] });
      const returned = python.requests.flatMap(request => request.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result" && block.tool_use_id === "python_test");
      assert(returned.some(block => JSON.stringify(block).includes("private_read_blocked") && JSON.stringify(block).includes("network_blocked")), "Missing Python confinement result");
      const activity = (await readFile(path.join(directory, "tool-activity.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      const result = activity.findLast(entry => entry.tool === "python_exec" && entry.status === "completed").result;
      assert.equal(result.exit_code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { private_read_blocked: true, network_blocked: true });
      assert.equal(await readFile(path.join(directory, "workspace/allowed.txt"), "utf8"), "workspace-ok");
    } else {
      assert.equal(await readFile(path.join(directory, "workspace/forbidden.py")).then(() => true, () => false), false);
    }
    const interview = await run({ ...options, resumeSessionId: first.session, interview: true, fork: true });
    assert.notEqual(interview.session, first.session);
    const compacted = await run({ ...options, resumeSessionId: first.session }, { compact: true, blocks: [{ type: "tool_use", id: "compact_observe", name: "mcp__mazebench__maze_observe", input: {} }] });
    assert(compacted.events.some(event => event.type === "system" && event.subtype === "compact_boundary"), "Compaction was not exercised");
    assert(compacted.requests.at(-1).tools.length, "No ordinary request after compaction");
    console.log(`Claude Code ${installation.version}, Python ${toolsEnabled ? "on" : "off"}: initial/resume/compaction, MCP round trip, denied shell/files/web/delegation, Python confinement, tool-free fork PASS`);
  }
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
