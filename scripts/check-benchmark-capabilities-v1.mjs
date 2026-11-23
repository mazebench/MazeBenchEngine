// Offline wire-level regression: inspect the tools emitted by the real Codex
// binary, not just our launch flags. No credentials or paid model calls are used.
import "../benchmarking/codex-releases.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexArguments, buildInterviewArguments, discoverCodexCapabilityPolicy, writeDirectToolModelCatalog } from "../benchmarking/v1/supervisor.mjs";
import { createRunIntegrity } from "../benchmarking/v1/integrity.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "mazebench-capabilities-"));
const home = path.join(temporary, "codex-home");
await mkdir(home);
const policy = discoverCodexCapabilityPolicy(process.env.MAZEBENCH_CODEX_BIN || "codex");
let requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const groups = [...(payload.tools || []), ...(payload.input || []).filter(item => item.type === "additional_tools").flatMap(item => item.tools || [])];
  const compaction = (payload.input || []).some(item => item.type === "compaction_trigger");
  requests.push({ model: payload.model, effort: payload.reasoning?.effort, groups, compaction, url: request.url });
  if (request.url.endsWith("/compact")) {
    response.writeHead(404);
    response.end('{"detail":"Not Found"}');
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const message = compaction
    ? { id: "cmp_validation", type: "compaction", encrypted_content: "offline-compaction-fixture" }
    : { id: "msg_validation", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Validation complete." }] };
  const events = [
    { type: "response.created", response: { id: "resp_validation", object: "response", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: message },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id: "resp_validation", object: "response", status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
  ];
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

async function run(args, directory, { compact = false } = {}) {
  requests = [];
  // The production builder asserts OpenAI. Replace it ONLY in this offline
  // test process, with an unauthenticated loopback provider and isolated home.
  args = args.map(arg => arg === 'model_provider="openai"' ? 'model_provider="boundary_test"' : arg);
  // Codex selects the OpenAI compaction protocol by provider name. Keep this
  // protocol identity while all requests and credentials remain local fixtures.
  args.splice(args.length - 1, 0, "-c", `model_providers.boundary_test={name="OpenAI",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false}`);
  if (compact) args.splice(args.length - 1, 0, "-c", "model_auto_compact_token_limit=1");
  const child = spawn(policy.codex_executable, args, {
    cwd: path.join(directory, "agent-cwd"),
    env: { HOME: os.homedir(), CODEX_HOME: home, PATH: process.env.PATH, CODEX_CODE_MODE_HOST_PATH: path.join(temporary, "disabled-host") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const code = await new Promise((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, compact ? 2 : 1, `Unexpected local model requests: ${JSON.stringify(requests.map(r => ({ url: r.url, compaction: r.compaction })))} ${stderr}`);
    assert(requests.every(request => request.url === "/v1/responses"));
    assert.equal(requests[0].compaction, compact);
    const events = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    return { request: requests.at(-1), compaction: compact ? requests[0] : null, thread: events.find(event => event.type === "thread.started")?.thread_id };
  } finally { clearTimeout(timeout); }
}

function toolNames(groups) {
  return groups.flatMap(group => group.type === "namespace"
    ? group.tools.map(tool => `${group.name}.${tool.name}`)
    : [group.name || group.type]).sort();
}

try {
  for (const model of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra"]) {
    for (const toolsEnabled of [false, true]) {
      const directory = path.join(temporary, `${model}-${toolsEnabled ? "on" : "off"}`);
      await mkdir(path.join(directory, "agent-cwd"), { recursive: true });
      const effort = model === "gpt-6.1-sol" ? "max" : "low";
      const configuration = { model, effort, tools_enabled: toolsEnabled, action_limit: 1, start_room: "HxI", effective_prompt_sha256: "offline-validation" };
      const integrity = await createRunIntegrity(projectRoot, directory, configuration);
      await writeFile(path.join(directory, "run.json"), JSON.stringify({ ...configuration, integrity }));
      await BenchmarkGameRuntime.create(projectRoot, directory, { actionLimit: 1 });
      await writeDirectToolModelCatalog(directory, model);
      const options = { projectRoot, runDirectory: directory, agentDirectory: path.join(directory, "agent-cwd"), modelCatalogPath: path.join(directory, "sandbox-state/direct-model-catalog.json"), model, effort, toolsEnabled, disabledFeatures: policy.disabled_features, enabledFeatures: policy.enabled_features, prompt: "Reply validation complete." };
      const expected = [
        // The CLI always advertises these helpers when an MCP is configured.
        // MazeBench returns empty lists and rejects every resource URI.
        "functions.list_mcp_resource_templates", "functions.list_mcp_resources", "functions.read_mcp_resource",
        "mcp__mazebench.maze_action", "mcp__mazebench.maze_observe", "mcp__mazebench.maze_sequence",
        ...(toolsEnabled ? ["mcp__mazebench.python_exec"] : [])
      ].sort();
      const initial = await run(buildCodexArguments(options), directory);
      assert.equal(initial.request.model, model);
      assert.equal(initial.request.effort, effort);
      assert.deepEqual(toolNames(initial.request.groups), expected);
      const resumed = await run(buildCodexArguments({ ...options, resumeThreadId: initial.thread }), directory);
      assert.equal(resumed.thread, initial.thread);
      assert.equal(resumed.request.model, model);
      assert.equal(resumed.request.effort, effort);
      assert.deepEqual(toolNames(resumed.request.groups), expected);
      const interview = await run(buildInterviewArguments({ ...options, parentThreadId: initial.thread, outputFile: path.join(directory, "interview.txt"), question: "Describe the validation." }), directory);
      assert.notEqual(interview.thread, initial.thread);
      assert.deepEqual(toolNames(interview.request.groups), []);
      const followup = await run(buildInterviewArguments({ ...options, forkThreadId: interview.thread, outputFile: path.join(directory, "interview.txt"), question: "Continue the interview." }), directory);
      assert.equal(followup.thread, interview.thread);
      assert.deepEqual(toolNames(followup.request.groups), []);
      const compactedRun = await run(buildCodexArguments({ ...options, resumeThreadId: initial.thread }), directory, { compact: true });
      assert.equal(compactedRun.thread, initial.thread);
      assert.equal(compactedRun.compaction.model, model);
      assert.deepEqual(toolNames(compactedRun.compaction.groups), expected);
      assert.deepEqual(toolNames(compactedRun.request.groups), expected);
      const compactedInterview = await run(buildInterviewArguments({ ...options, forkThreadId: interview.thread, outputFile: path.join(directory, "interview.txt"), question: "Continue the interview." }), directory, { compact: true });
      assert.equal(compactedInterview.thread, interview.thread);
      assert.deepEqual(toolNames(compactedInterview.compaction.groups), []);
      assert.deepEqual(toolNames(compactedInterview.request.groups), []);
      console.log(`${model} Python ${toolsEnabled ? "on" : "off"}: new, resume, interview fork/follow-up, benchmark/interview compaction PASS`);
    }
  }
  console.log(`${policy.codex_version}: exact model/tool routing verified offline.`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
