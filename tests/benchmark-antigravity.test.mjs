import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, chmod, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { antigravityInstallationStatus, ANTIGRAVITY_MODELS } from "../benchmarking/antigravity/status.mjs";
import { BenchmarkSupervisor } from "../benchmarking/antigravity/supervisor.mjs";
import { agentDefinition, settings, argumentsFor, boundaryValidator, environment, VERIFIED_VERSIONS } from "../benchmarking/antigravity/policy.mjs";
import { createAntigravityTimeline, consumeAntigravityEvent, antigravityTelemetry } from "../benchmarking/antigravity-telemetry.mjs";
import { createThinkingTimeline, consumeThinkingEvent } from "../benchmarking/run-telemetry.mjs";
import { boundToolResult, readResponsePage } from "../benchmarking/antigravity/response-pages.mjs";

const installation = () => ({ executable: "/fixture/agy", version: "1.2.13" });
test("large observations remain lossless, bounded and readable only through safe content-addressed pages", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "maze-pages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const text = "board\n" + "🙂abc\n".repeat(3000) + "final-state";
  let result = boundToolResult(directory, { content: [{ type: "text", text }], structuredContent: { same: text } });
  let rebuilt = "", firstRecord;
  while (true) {
    const page = result.content[0].text;
    assert(Buffer.byteLength(page) < 2800); assert.equal(result.structuredContent, undefined);
    rebuilt += page.slice(page.indexOf("\n---\n") + 5);
    const next = /record="([^"]+)"/.exec(page)?.[1];
    if (!next) break;
    firstRecord ||= next; result = readResponsePage(directory, next);
  }
  assert.equal(rebuilt, text);
  for (const record of ["/etc/passwd", "response_pages/../../secret", firstRecord.replace("/1.txt", "/999999.txt")]) assert.throws(() => readResponsePage(directory, record));
  const sha = firstRecord.split("/")[1], file = path.join(directory, "response-pages", sha + ".txt");
  await chmod(file, 0o600); await writeFile(file, "tampered");
  assert.throws(() => readResponsePage(directory, firstRecord), /integrity/);
  await rm(file); await symlink("/etc/passwd", file);
  assert.throws(() => readResponsePage(directory, firstRecord));
});
test("Gemini telemetry deduplicates resumed steps and never invents API prices", () => {
  const timeline = createAntigravityTimeline();
  const event = { _received_at: "2026-09-29T00:00:00Z", step_update: { conversation_id: "session", step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 100, cache_read_tokens: 50, output_tokens: 20 } } };
  consumeAntigravityEvent(timeline, event); consumeAntigravityEvent(timeline, event);
  consumeAntigravityEvent(timeline, { event: "result", result: { usage: { total_tokens: 999 } } });
  const result = antigravityTelemetry(timeline);
  assert.equal(result.total_tokens, 120); assert.equal(result.samples.length, 1);
  assert.equal(result.api_estimate.usd, null); assert.equal(result.context_window, null);
  const thinking = createThinkingTimeline();
  consumeThinkingEvent(thinking, { event: "init", _received_at: "2026-09-29T00:00:00Z" }, "antigravity");
  consumeThinkingEvent(thinking, { event: "step_update", _received_at: "2026-09-29T00:00:03Z", step_update: { conversation_id: "session", step_index: 2, tool_name: "call_mcp_tool", state: "ACTIVE", tool_info: { parameters: { ToolName: "maze_action" } } } }, "antigravity");
  assert.equal(thinking.episodes[0].duration_ms, 3000); assert.equal(thinking.episodes[0].next_tool, "maze_action");
});
const fake = async (_, args, options) => {
  assert.equal(options.killSignal, "SIGKILL");
  assert.equal(options.env.GEMINI_API_KEY, undefined);
  assert.equal(options.env.GOOGLE_GEMINI_BASE_URL, undefined);
  return { stdout: args[0] === "models" ? "gemini-3.8-flash-medium\tGemini 3.8 Flash\ngemini-3.7-flash-high\tOlder Flash\n" : "Gemini Models\tWeekly Limit Remaining\t100%\n" };
};
test("Antigravity readiness verifies isolated authentication, reviewed version and exact model IDs", async () => {
  const status = await antigravityInstallationStatus("agy", fake, installation, () => true);
  assert.equal(status.tested, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.launch_ready, process.platform === "darwin");
  assert.deepEqual(status.models.map(model => model.id), ["gemini-3.8-flash-medium"]);
  assert.equal((await antigravityInstallationStatus("agy", fake, installation, () => false)).authenticated, false);
});
test("Antigravity fails closed on unknown versions, unavailable inventory or failed login", async () => {
  const unknown = await antigravityInstallationStatus("agy", fake, () => ({ executable: "agy", version: "9.9.9" }), () => true);
  assert.equal(unknown.tested, false); assert.equal(unknown.launch_ready, false);
  const offline = await antigravityInstallationStatus("agy", async () => { throw new Error("offline"); }, installation, () => true);
  assert.deepEqual(offline.models, []); assert.equal(offline.authenticated, false); assert.equal(offline.launch_ready, false);
});
test("Argon is listed only when the authenticated Google inventory offers its exact preset", async () => {
  const run = async (_, args) => ({stdout: args[0] === 'models'
    ? 'gemini-4-argon-high\tGemini 4 Argon (High)\ngemini-4-argon-unknown\tUnknown\n'
    : 'Gemini Models\tWeekly Limit Remaining\t100%\n'});
  const status = await antigravityInstallationStatus('agy',run,()=>({executable:'agy',version:'1.3.5'}),()=>true);
  assert.deepEqual(status.models.map(model=>model.id),['gemini-4-argon-high']);
  assert.equal(status.tested,true);
  assert(argumentsFor({model:'gemini-4-argon-high',prompt:'play',logFile:'/log'}).includes('gemini-4-argon-high'));
  assert.throws(()=>argumentsFor({model:'gemini-4-argon-max',prompt:'play',logFile:'/log'}));
});
test("Antigravity specs preserve exact preset, unlimited moves and Python condition", async () => {
  const supervisor = new BenchmarkSupervisor(process.cwd());
  const spec = await supervisor.validateSpec({ provider: "antigravity", model: "gemini-3.8-flash-high", effort: "high", tools_enabled: false, action_limit: null });
  assert.equal(spec.model, "gemini-3.8-flash-high"); assert.equal(spec.effort, "high");
  assert.equal(spec.actionLimit, null); assert.equal(spec.toolsEnabled, false);
  for (const bad of [{ model: "gemini-3.7-flash-high" }, { effort: "max" }, { observation_mode: "vision" }, { world: "slotski" }]) {
    await assert.rejects(supervisor.validateSpec({ provider: "antigravity", ...bad }));
  }
  const unavailable = new BenchmarkSupervisor(process.cwd(), { antigravityBin: "/nonexistent/agy", antigravityStatus: async () => ({ launch_ready: true, models: ANTIGRAVITY_MODELS }) });
  await assert.rejects(unavailable.launch({ provider: "antigravity" }));
  assert.equal(unavailable.active.size, 0);
});
test("Antigravity has no native tools or customization inheritance, and only exact MCP permissions", () => {
  for (const toolsEnabled of [false, true]) {
    const text = agentDefinition({ command: "/node", args: ["/fixture/mcp.mjs"], toolsEnabled });
    for (const setting of ["tools: []", "inheritMcp: false", "inheritCustomizations: false", "excludeDefaultComponents: true", "skills: []", "plugins: []", "subagent: false"]) assert(text.includes(setting));
    assert.deepEqual(settings(toolsEnabled).permissions.allow, ["mcp(mazebench/maze_observe)", "mcp(mazebench/maze_action)", "mcp(mazebench/maze_sequence)", ...(toolsEnabled ? ["mcp(mazebench/python_exec)"] : [])]);
    assert(settings(toolsEnabled).permissions.deny.includes("command(*)"));
    assert.equal(environment("/private/home").HOME, "/private/home");
    assert.equal(environment("/private/home").GEMINI_API_KEY, undefined);
    const args = argumentsFor({ model: "gemini-3.8-flash-high", prompt: "play", logFile: "/log", conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
    assert(args.includes("--disable-slash-commands")); assert(!args.includes("--dangerously-skip-permissions"));
    assert(args.includes("--conversation")); assert.equal(VERIFIED_VERSIONS.has("1.2.12"), false);
  }
});
test("Antigravity event boundary rejects wrong model, built-ins, other servers and Python when off", () => {
  const init = { event: "init", conversation_id: "a", init: { agent: "mazebench", model: "gemini-3.8-flash-high", cwd: process.cwd(), permission_mode: "request-review", tools: ["run_command"] } };
  const validator = () => boundaryValidator({ model: init.init.model, cwd: process.cwd(), toolsEnabled: false });
  assert(validator()({ ...init, init: { ...init.init, model: "gemini-3.7-flash-high" } }));
  assert(validator()({ ...init, init: { ...init.init, agent: "default" } }));
  const validate = validator(); assert.equal(validate(init), null);
  for (const [name, parameters] of [["run_command", {}], ["execute_browser_javascript", {}], ["call_mcp_tool", { ServerName: "mazebench", ToolName: "python_exec" }], ["call_mcp_tool", { ServerName: "personal", ToolName: "maze_observe" }], ["manage_task", { Action: "send_input", Input: "code" }], ["read_resource", { Uri: "file:///secret" }]]) {
    assert(validate({ event: "step_update", step_update: { tool_name: name, tool_info: { parameters } } }));
  }
  assert.equal(validate({ event: "step_update", step_update: { tool_name: "call_mcp_tool", tool_info: { parameters: { ServerName: "mazebench", ToolName: "maze_observe", Arguments: {} } } } }), null);
});
