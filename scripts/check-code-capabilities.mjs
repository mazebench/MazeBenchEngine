// Actual provider clients with local, unauthenticated model fixtures only.
import "../benchmarking/codex-releases.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverCodexCapabilityPolicy, writeDirectToolModelCatalog } from "../benchmarking/v1/supervisor.mjs";
import { inspectClaude, claudeEnvironment, digest, CLAUDE_POLICY, providerRuntimeHashes } from "../benchmarking/providers/claude-policy.mjs";
import { createRunIntegrity } from "../benchmarking/v1/integrity.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { CODE_POLICY, codeRuntimeHashes, codeTools, buildCodeCodexArguments, buildCodeClaudeArguments, codeCodexBoundaryViolation, createCodeClaudeValidator } from "../benchmarking/code/policy.mjs";
import { inspectCodeSandbox } from "../benchmarking/code/sandbox.mjs";

const root = path.resolve(import.meta.dirname, ".."), temporary = await mkdtemp(path.join(os.tmpdir(), "mazebench-code-wire-"));
const codexHome = path.join(temporary, "codex-home"), claudeHome = path.join(temporary, "claude-home");
await mkdir(codexHome); await mkdir(claudeHome);
const sandbox = await inspectCodeSandbox();
assert(sandbox.available, sandbox.error);
let requests = [], nextCode = false, compactProbe = false, requestNumber = 0;
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString(), payload = body ? JSON.parse(body) : {};
  if (request.url.includes("count_tokens")) { response.end('{"input_tokens":20}'); return; }
  requests.push(payload);
  let events;
  if (request.url.startsWith("/v1/messages")) {
    const block = nextCode ? { type: "tool_use", id: "code_fixture", name: "mcp__mazebench__code_exec", input: { command: "node -e 'console.log(42)'" } }
      : { type: "text", text: "Validation complete." };
    nextCode = false;
    const message = { id: `msg_${++requestNumber}`, type: "message", role: "assistant", model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: compactProbe ? 5000 : 20, output_tokens: 0 } };
    events = [{ type: "message_start", message },
      { type: "content_block_start", index: 0, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }, { type: "message_stop" }];
  } else if (request.url === "/v1/responses") {
    const compaction = (payload.input || []).some(item => item.type === "compaction_trigger");
    const message = compaction ? { id: "cmp_fixture", type: "compaction", encrypted_content: "offline-compaction-fixture" }
      : { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Validation complete." }] };
    events = [{ type: "response.created", response: { id: "resp_fixture", object: "response", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: message }, { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { id: "resp_fixture", object: "response", status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  } else { response.writeHead(404); response.end("{}"); return; }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

async function fixture(provider, model, policy) {
  const directory = path.join(temporary, model);
  await mkdir(path.join(directory, "agent-cwd"), { recursive: true });
  const prompt = "Reply validation complete.";
  const capability = provider === "codex" ? { ...policy, code_execution: "code_exec-only", model_catalog: await writeDirectToolModelCatalog(directory, model) } : null;
  const configuration = { provider, world: "main-world", observation_mode: "ascii", coding_mode: "any", code_policy: CODE_POLICY,
    code_runtime: await codeRuntimeHashes(root), code_sandbox: sandbox, model, effort: model === "gpt-6.1-sol" ? "max" : "low", tools_enabled: true,
    sequence_enabled: true, service_tier: null, action_limit: 2, start_room: "HxI", effective_prompt_sha256: digest(prompt),
    ...(capability ? { codex_policy: capability } : { claude_policy: CLAUDE_POLICY, claude_version: policy.version, claude_executable: policy.executable,
      claude_sha256: digest(await readFile(policy.executable)), provider_runtime: await providerRuntimeHashes(root) }) };
  const metadata = { ...configuration, capability_policy: capability || { version: 4, name: CLAUDE_POLICY }, integrity: await createRunIntegrity(root, directory, configuration) };
  await writeFile(path.join(directory, "run.json"), JSON.stringify(metadata));
  await writeFile(path.join(directory, "prompt.md"), prompt);
  await BenchmarkGameRuntime.create(root, directory, { actionLimit: 2 });
  return { projectRoot: root, runDirectory: directory, agentDirectory: path.join(directory, "agent-cwd"), model, effort: configuration.effort, prompt,
    toolsEnabled: true, sequenceEnabled: true, modelCatalogPath: path.join(directory, "sandbox-state/direct-model-catalog.json"),
    disabledFeatures: policy.disabled_features, enabledFeatures: policy.enabled_features };
}
async function run(binary, args, options, env) {
  requests = [];
  const child = spawn(binary, args, { cwd: options.agentDirectory, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
  try {
    const code = await new Promise((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
    assert.equal(code, 0, stderr + stdout.slice(-4000));
    assert(requests.length, "No model request reached the local fixture.");
    return stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } finally { clearTimeout(timer); }
}
const names = groups => groups.flatMap(group => group.type === "namespace" ? group.tools.map(tool => `${group.name}.${tool.name}`) : [group.name || group.type]).sort();
try {
  const policy = discoverCodexCapabilityPolicy(process.env.MAZEBENCH_CODEX_BIN || "codex");
  for (const model of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra"]) {
    const options = await fixture("codex", model, policy);
    let thread;
    for (const compact of [false, false, true]) {
      const args = buildCodeCodexArguments({ ...options, resumeThreadId: thread }).map(arg => arg === 'model_provider="openai"' ? 'model_provider="boundary_test"' : arg);
      args.splice(args.length - 1, 0, "-c", `model_providers.boundary_test={name="OpenAI",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false}`);
      if (compact) args.splice(args.length - 1, 0, "-c", "model_auto_compact_token_limit=1");
      const events = await run(policy.codex_executable, args, options, { HOME: os.homedir(), CODEX_HOME: codexHome, PATH: process.env.PATH, CODEX_CODE_MODE_HOST_PATH: path.join(temporary, "disabled-host") });
      const received = events.find(event => event.type === "thread.started")?.thread_id;
      if (thread) assert.equal(received, thread); thread = received; assert(thread);
      for (const event of events) assert.equal(codeCodexBoundaryViolation(event), null);
      assert.equal(requests.length, compact ? 2 : 1);
      for (const payload of requests) {
        assert.equal(payload.model, model); assert.equal(payload.reasoning?.effort, options.effort);
        const groups = [...(payload.tools || []), ...(payload.input || []).filter(item => item.type === "additional_tools").flatMap(item => item.tools || [])];
        assert.deepEqual(names(groups), ["functions.list_mcp_resource_templates", "functions.list_mcp_resources", "functions.read_mcp_resource", ...codeTools().map(name => "mcp__mazebench." + name)].sort());
      }
    }
    console.log(`${model}: Any language new/resume/compaction catalog PASS`);
  }
  const claude = inspectClaude(process.env.MAZEBENCH_CLAUDE_BIN || "claude");
  const options = await fixture("claude-code", "claude-sonnet-5-5", claude);
  let session;
  for (const compact of [false, false, true]) {
    nextCode = true; compactProbe = compact;
    const args = buildCodeClaudeArguments({ ...options, resumeSessionId: session });
    if (compact) args.splice(args.indexOf("--"), 0, "--autocompact", "100k");
    const events = await run(claude.executable, args, options, { ...claudeEnvironment(), HOME: claudeHome, CLAUDE_CONFIG_DIR: path.join(claudeHome, ".claude"),
      ANTHROPIC_API_KEY: "offline-fixture-not-a-credential", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ...(compact ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "1" } : {}) });
    const validator = createCodeClaudeValidator({ model: options.model });
    for (const event of events) assert.equal(validator(event), null);
    const received = events.find(event => event.type === "system" && event.subtype === "init")?.session_id;
    if (session) assert.equal(received, session); session = received; assert(session);
    for (const payload of requests) {
      assert.equal(payload.model, options.model);
      if (payload.tools?.length) assert.deepEqual(payload.tools.map(tool => tool.name).sort(), codeTools().map(name => "mcp__mazebench__" + name).sort());
    }
    const returned = requests.flatMap(payload => payload.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === "tool_result" && block.tool_use_id === "code_fixture");
    const texts = returned.flatMap(block => typeof block.content === "string" ? [block.content] : (block.content || []).map(item => item.text).filter(Boolean));
    const values = texts.flatMap(text => { try { return [JSON.parse(text)]; } catch { return []; } });
    assert(values.some(value => value.exit_code === 0 && value.stdout === "42\n"), "Code result did not reach the model fixture: " + JSON.stringify(returned).slice(0, 4000));
    if (compact) assert(events.some(event => event.type === "system" && event.subtype === "compact_boundary"));
  }
  console.log(`Claude ${claude.version}: Any language new/resume/compaction and real Node execution PASS`);
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
