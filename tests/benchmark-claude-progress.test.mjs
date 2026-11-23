import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeTools, createClaudeBoundaryValidator } from "../benchmarking/providers/claude-policy.mjs";
import { runClaudeTurn } from "../benchmarking/providers/claude-runner.mjs";

const model = "claude-fable-5-1", session = "9e0d401c-3460-4544-893f-ce79921e0476";
const parent = "toolu_01DKGGKe1ZGgx8C5Nf1dD3MC";
const init = toolsEnabled => ({ type: "system", subtype: "init", session_id: session, model, permissionMode: "dontAsk",
  tools: claudeTools(toolsEnabled), mcp_servers: [{ name: "mazebench", status: "connected" }] });
const call = (name = "mcp__mazebench__maze_sequence") => ({ type: "assistant", session_id: session, parent_tool_use_id: null,
  message: { id: "message-1", model, content: [{ type: "tool_use", id: parent, name, input: { actions: ["right"] } }] } });
const heartbeat = { type: "tool_progress", tool_use_id: `${parent}-heartbeat-0`, tool_name: "mcp__mazebench__maze_sequence",
  parent_tool_use_id: parent, elapsed_time_seconds: 30, heartbeat: true, session_id: session, uuid: "progress-1" };

test("Claude heartbeats require a validated pending tool in the same session and permitted mode", () => {
  for (const toolsEnabled of [false, true]) {
    const validate = createClaudeBoundaryValidator({ model, toolsEnabled });
    assert(validate(heartbeat));
    assert.equal(validate(init(toolsEnabled)), null);
    assert(validate(heartbeat));
    assert.equal(validate(call()), null);
    assert.equal(validate(heartbeat), null);
    for (const altered of [
      { tool_name: "Agent" }, { tool_name: "mcp__other__maze_sequence" }, { parent_tool_use_id: "unknown" },
      { session_id: "another-session" }, { heartbeat: false }, { elapsed_time_seconds: -1 },
      { elapsed_time_seconds: "30" }, { tool_use_id: parent }, { tool_use_id: `${parent}-heartbeat-evil` },
      { command: "cat secrets" }, { type: "assistant", message: {} }, { type: "stream_event", event: {} }
    ]) assert(validate({ ...heartbeat, ...altered }), JSON.stringify(altered));
    assert.equal(validate({ type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: parent }] } }), null);
    assert(validate(heartbeat));
    assert.equal(validate(call()), null);
    assert.equal(validate(init(toolsEnabled)), null);
    assert(validate(heartbeat));
    const python = createClaudeBoundaryValidator({ model, toolsEnabled });
    assert.equal(python(init(toolsEnabled)), null);
    const result = python(call("mcp__mazebench__python_exec"));
    if (toolsEnabled) {
      assert.equal(result, null);
      assert.equal(python({ ...heartbeat, tool_name: "mcp__mazebench__python_exec" }), null);
    } else {
      assert(result);
      assert(python({ ...heartbeat, tool_name: "mcp__mazebench__python_exec" }));
    }
  }
});

test("the actual Claude stream runner accepts root-tool heartbeats and kills forged progress", async () => {
  for (const forged of [false, true]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "claude-progress-test-"));
    try {
      await mkdir(path.join(directory, "agent-cwd"));
      const binary = path.join(directory, "fake-claude.mjs");
      const events = [init(false), call(), { ...heartbeat, ...(forged ? { tool_name: "Agent" } : {}) },
        { type: "result", subtype: "success", is_error: false, session_id: session, result: "fixture", modelUsage: { [model]: {} } }];
      await writeFile(binary, `#!${process.execPath}\nfor (const event of ${JSON.stringify(events)}) { console.log(JSON.stringify(event)); await new Promise(r => setTimeout(r, 50)); }\n`, { mode: 0o700 });
      const result = await runClaudeTurn({ projectRoot: process.cwd(), directory,
        metadata: { model, effort: "low", tools_enabled: false, claude_session_id: session },
        frozen: { claude_executable: binary }, prompt: "Fixture", control: { stopRequested: false, pauseRequested: false },
        onSession: async () => {},
      });
      if (forged) {
        assert.match(result.boundaryError, /unverified tool progress/);
        assert.notEqual(result.code, 0);
        assert.match(await readFile(path.join(directory, "integrity-violation.json"), "utf8"), /unverified tool progress/);
      } else {
        assert.equal(result.boundaryError, null);
        assert.equal(result.code, 0);
        assert.equal(result.sessionId, session);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
