// Offline real-CLI certification. No real credentials, billable model calls,
// host data, or game records are used. A loopback Gemini endpoint captures the
// ACTUAL effective tools; Antigravity's init.tools is only its global registry.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectInstallation, agentDefinition, settings, argumentsFor, environment, TRANSPORT_TOOLS, toolNames } from "../benchmarking/antigravity/policy.mjs";
const installation = inspectInstallation();
assert.equal(installation.tested, true, "Unreviewed CLI version");
const root = await mkdtemp(path.join(os.tmpdir(), "mazebench-agy-capabilities-"));
console.log("Offline evidence: " + root);
const fixture = path.join(root, "mcp.mjs");
await writeFile(fixture, [
  'import readline from "node:readline";',
  'import {appendFileSync} from "node:fs";',
  'import {boundToolResult,readResponsePage} from ' + JSON.stringify(new URL('../benchmarking/antigravity/response-pages.mjs', import.meta.url).href) + ';',
  'const names=JSON.parse(process.env.FIXTURE_TOOLS);',
  'for await(const line of readline.createInterface({input:process.stdin})){',
  'const r=JSON.parse(line); if(r.id===undefined)continue; let result,error;',
  'if(r.method==="initialize")result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"mazebench",version:"1"}};',
  'else if(r.method==="tools/list")result={tools:names.map(name=>({name,description:"Fixture "+name,inputSchema:{type:"object",properties:{},additionalProperties:false}}))};',
  'else if(r.method==="tools/call" && r.params.name==="maze_observe" && r.params.arguments?.record)result=readResponsePage(process.env.FIXTURE_DIR,r.params.arguments.record);',
  'else if(r.method==="tools/call" && names.includes(r.params.name)){appendFileSync(process.env.FIXTURE_AUDIT,JSON.stringify(r.params)+"\\n");result=boundToolResult(process.env.FIXTURE_DIR,{content:[{type:"text",text:"FIXTURE_OK_"+r.params.name+(r.params.name==="maze_observe"?"\\n"+"abcdefghij ".repeat(3000)+"\\nEND_OF_LARGE_OBSERVATION":"")}]});}',
  'else if(r.method==="resources/list")result={resources:[]};',
  'else if(r.method==="resources/templates/list")result={resourceTemplates:[]};',
  'else error={code:-32602,message:"NOT_AVAILABLE"};',
  'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,...(error?{error}:{result})})+"\\n");}',
].join("\n"), { mode: 0o600 });
for (const effort of ["low", "medium", "high"]) for (const toolsEnabled of [false, true]) {
  const directory = path.join(root, effort + "-" + toolsEnabled);
  const home = path.join(directory, "home"), cwd = path.join(directory, "cwd"), audit = path.join(directory, "calls.jsonl");
  await mkdir(path.join(home, ".gemini/antigravity-cli"), { recursive: true });
  await mkdir(path.join(cwd, ".agents/agents/mazebench"), { recursive: true });
  await mkdir(path.join(home, ".gemini/config/rules"), { recursive: true });
  await writeFile(path.join(home, ".gemini/antigravity-cli/settings.json"), JSON.stringify({ ...settings(toolsEnabled), modelProvider: "gemini" }));
  await writeFile(path.join(home, ".gemini/GEMINI.md"), "PERSONAL_INSTRUCTION_SENTINEL");
  await writeFile(path.join(home, ".gemini/config/rules/private.md"), "PERSONAL_INSTRUCTION_SENTINEL");
  await writeFile(path.join(cwd, "AGENTS.md"), "PERSONAL_INSTRUCTION_SENTINEL");
  await writeFile(path.join(directory, "outside.txt"), "PRIVATE_CONTENT_SENTINEL");
  await writeFile(path.join(cwd, ".agents/agents/mazebench/agent.md"), agentDefinition({
    command: process.execPath, args: [fixture], toolsEnabled, env: { FIXTURE_TOOLS: JSON.stringify(toolNames(toolsEnabled)), FIXTURE_AUDIT: audit, FIXTURE_DIR: directory }
  }));
  const model = "gemini-3.8-flash-" + effort, requests = [], events = [];
  const meta = { toolSummary: "Capability test", toolAction: "Testing capability" };
  const call = (name, args) => ({ name, args: { ...args, ...meta } });
  const native = ["run_command", "write_to_file", "view_file", "execute_browser_javascript", "notebook_execution", "invoke_subagent"];
  const attempts = [
    call("manage_task", { Action: "list" }),
    call("read_resource", { Uri: "file://" + path.join(directory, "outside.txt") }),
    call("read_resource", { ServerName: "mazebench", Uri: "file://" + path.join(directory, "outside.txt") }),
    call("run_command", { CommandLine: "touch " + path.join(directory, "escaped"), Cwd: directory, Blocking: true }),
    call("write_to_file", { TargetFile: path.join(directory, "escaped-write"), CodeContent: "escaped", Overwrite: true }),
    call("view_file", { AbsolutePath: path.join(directory, "outside.txt") }),
    call("execute_browser_javascript", { JavaScriptCode: "1+1" }),
    call("notebook_execution", { Code: "print(1)" }),
    call("invoke_subagent", { AgentName: "self", Task: "Reply OK" }),
    call("call_mcp_tool", { ServerName: "personal", ToolName: "maze_observe", Arguments: {} }),
    ...toolNames(toolsEnabled).map(name => call("call_mcp_tool", { ServerName: "mazebench", ToolName: name, Arguments: {} })),
    ...(!toolsEnabled ? [call("call_mcp_tool", { ServerName: "mazebench", ToolName: "python_exec", Arguments: {} })] : [])
  ];
  let phase = "new", step = 0;
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    let body = {}; try { body = JSON.parse(text); } catch {}
    requests.push({ phase, url: req.url, body });
    const last = body.contents?.flatMap(content => content.parts || []).filter(part => part.functionResponse).at(-1)?.functionResponse?.response?.output || "";
    const page = /Continue by calling maze_observe with record="(response_pages\/[^"]+)"/.exec(last)?.[1];
    const next = !body.tools ? null : page ? call("call_mcp_tool", { ServerName: "mazebench", ToolName: "maze_observe", Arguments: { record: page } }) : attempts[step++];
    const result = { candidates: [{ content: { role: "model", parts: next ? [{ functionCall: next }] : [{ text: "FIXTURE_COMPLETE" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 } };
    res.setHeader("content-type", "text/event-stream");
    res.end("data: " + JSON.stringify(result) + "\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  async function run(conversationId) {
    const child = spawn(installation.executable, argumentsFor({ model, prompt: conversationId ? "CONTINUATION_SENTINEL" : "ORIGINAL_TURN_SENTINEL", conversationId, logFile: path.join(directory, phase + ".log") }), {
      cwd, env: { ...environment(home), GEMINI_API_KEY: "offline-fixture-not-a-key", GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:" + server.address().port },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
    try {
      const code = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
      assert.equal(code, 0, stderr);
      const batch = stdout.trim().split("\n").map(JSON.parse); events.push(...batch);
      assert.equal(batch.at(-1).result.status, "SUCCESS");
      return batch[0].conversation_id;
    } finally { clearTimeout(timeout); }
  }
  try {
    const conversationId = await run();
    phase = "resume"; step = 0;
    assert.equal(await run(conversationId), conversationId);
    await writeFile(path.join(directory, "requests.json"), JSON.stringify(requests, null, 2));
    await writeFile(path.join(directory, "events.jsonl"), events.map(event => JSON.stringify(event)).join("\n"));
    const main = requests.filter(entry => entry.body.tools);
    assert(main.length > 10);
    for (const request of main) {
      assert(request.url.includes("/models/gemini-3.8-flash:"));
      const names = request.body.tools.flatMap(tool => tool.functionDeclarations.map(fn => fn.name)).sort();
      assert.deepEqual(names, TRANSPORT_TOOLS);
      assert(!JSON.stringify(request.body).includes("PERSONAL_INSTRUCTION_SENTINEL"));
      assert(!JSON.stringify(request.body).includes("PRIVATE_CONTENT_SENTINEL"));
      assert(!/output was large|output was truncated/.test(JSON.stringify(request.body)), "The agent must receive inline pages, never a host-file redirect");
      if (request.phase === "resume") assert(JSON.stringify(request.body.contents).includes("ORIGINAL_TURN_SENTINEL"));
    }
    for (const name of native) {
      const outputs = events.filter(event => event.step_update?.tool_name === name && event.step_update?.state === "ERROR");
      assert(outputs.length >= 2, "Native tool not rejected on new + resume: " + name);
      assert(outputs.every(event => event.step_update.tool_info.error.message.includes("unknown tool")));
    }
    for (const file of ["escaped", "escaped-write"]) await assert.rejects(access(path.join(directory, file)));
    const calls = (await readFile(audit, "utf8")).trim().split("\n").map(JSON.parse);
    assert(JSON.stringify(main.at(-1)).includes("END_OF_LARGE_OBSERVATION"));
    assert.deepEqual([...new Set(calls.map(entry => entry.name))].sort(), toolNames(toolsEnabled).sort());
    assert.equal(calls.length, toolNames(toolsEnabled).length * 2);
    console.log(JSON.stringify({ model, toolsEnabled, newAndResume: "passed", effectiveTools: TRANSPORT_TOOLS, thinking: main[0].body.generationConfig.thinkingConfig }));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
console.log("Antigravity real-CLI capability checks passed.");
