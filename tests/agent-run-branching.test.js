const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  claudeProjectKey,
  claudeTranscriptPrefix,
  codexTranscriptPrefix,
  providerEventPrefix,
  toolActivityPrefix
} = require("../server/run-branch");
const { branchLaunchParams } = require("../server/agent-runs");

const oldCodexId = "00000000-0000-4000-8000-000000000001";
const newCodexId = "00000000-0000-4000-8000-000000000002";
const codexRecord = (type, payload) => JSON.stringify({ type, payload });
const codexTranscript = [
  codexRecord("session_meta", { id: oldCodexId, session_id: oldCodexId }),
  codexRecord("event_msg", {
    type: "mcp_tool_call_end",
    invocation: { tool: "mcp__mazebench__maze_start", arguments: {} },
    result: { Ok: { isError: false } }
  }),
  codexRecord("response_item", { type: "custom_tool_call_output", output: "initial" }),
  codexRecord("event_msg", {
    type: "mcp_tool_call_end",
    invocation: { tool: "mcp__mazebench__maze_action", arguments: { action: "up" } },
    result: { Ok: { isError: false } }
  }),
  codexRecord("response_item", { type: "custom_tool_call_output", output: "one" }),
  codexRecord("event_msg", {
    type: "mcp_tool_call_end",
    invocation: { tool: "mcp__mazebench__maze_action", arguments: { action: "invalid" } },
    result: { Ok: { isError: true } }
  }),
  codexRecord("response_item", { type: "custom_tool_call_output", output: "failed" }),
  codexRecord("event_msg", {
    type: "mcp_tool_call_end",
    invocation: { tool: "mcp__mazebench__maze_action", arguments: { action: "right" } },
    result: { Ok: { isError: false } }
  }),
  codexRecord("response_item", { type: "custom_tool_call_output", output: "two" }),
  codexRecord("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "future" }] })
].join("\n") + "\n";

const codexAtOne = codexTranscriptPrefix(codexTranscript, 1, newCodexId);
assert.match(codexAtOne, /"output":"one"/);
assert.doesNotMatch(codexAtOne, /"output":"failed"/);
assert.doesNotMatch(codexAtOne, /future/);
const rewrittenMeta = JSON.parse(codexAtOne.split("\n")[0]);
assert.equal(rewrittenMeta.payload.id, newCodexId);
assert.equal(rewrittenMeta.payload.session_id, newCodexId);

const codexAtTwo = codexTranscriptPrefix(codexTranscript, 2, newCodexId);
assert.match(codexAtTwo, /"output":"failed"/);
assert.match(codexAtTwo, /"output":"two"/);
assert.doesNotMatch(codexAtTwo, /future/);

const claudeMessage = (type, uuid, parentUuid, content) => JSON.stringify({
  type,
  uuid,
  parentUuid,
  sessionId: "00000000-0000-4000-8000-000000000003",
  message: { role: type === "assistant" ? "assistant" : "user", content }
});
const claudeTranscript = [
  claudeMessage("assistant", "a0", null, [{ type: "tool_use", id: "start", name: "mcp__mazebench__maze_start", input: {} }]),
  claudeMessage("user", "u0", "a0", [{ type: "tool_result", tool_use_id: "start", content: "initial" }]),
  claudeMessage("assistant", "a1", "u0", [{ type: "tool_use", id: "move1", name: "mcp__mazebench__maze_action", input: { action: "up" } }]),
  claudeMessage("user", "u1", "a1", [{ type: "tool_result", tool_use_id: "move1", content: "one" }]),
  claudeMessage("assistant", "af", "u1", [{ type: "tool_use", id: "failed", name: "mcp__mazebench__maze_action", input: { action: "invalid" } }]),
  claudeMessage("user", "uf", "af", [{ type: "tool_result", tool_use_id: "failed", content: "bad", is_error: true }]),
  claudeMessage("assistant", "a2", "uf", [{ type: "tool_use", id: "move2", name: "mcp__mazebench__maze_action", input: { action: "right" } }]),
  claudeMessage("user", "u2", "a2", [{ type: "tool_result", tool_use_id: "move2", content: "two" }]),
  claudeMessage("assistant", "future", "u2", [{ type: "text", text: "future" }])
].join("\n") + "\n";

const claudeAtOne = claudeTranscriptPrefix(claudeTranscript, 1);
assert.match(claudeAtOne, /"uuid":"u1"/);
assert.doesNotMatch(claudeAtOne, /"uuid":"af"/);
const claudeAtTwo = claudeTranscriptPrefix(claudeTranscript, 2);
assert.match(claudeAtTwo, /"uuid":"uf"/);
assert.match(claudeAtTwo, /"uuid":"u2"/);
assert.doesNotMatch(claudeAtTwo, /"uuid":"future"/);

const codexEvents = [
  { type: "thread.started", thread_id: oldCodexId },
  { type: "item.completed", item: { type: "mcp_tool_call", tool: "mcp__mazebench__maze_start", arguments: {}, status: "completed" } },
  { type: "item.completed", item: { type: "mcp_tool_call", tool: "mcp__mazebench__maze_action", arguments: { action: "up" }, status: "completed" } },
  { type: "item.completed", item: { type: "mcp_tool_call", tool: "mcp__mazebench__maze_action", arguments: { action: "invalid" }, status: "failed" } },
  { type: "item.completed", item: { type: "mcp_tool_call", tool: "mcp__mazebench__maze_action", arguments: { action: "right" }, status: "completed" } }
].map(JSON.stringify).join("\n") + "\n";
const eventPrefix = providerEventPrefix(codexEvents, "codex", 1, oldCodexId, newCodexId);
assert.match(eventPrefix, new RegExp(newCodexId));
assert.match(eventPrefix, /"action":"up"/);
assert.doesNotMatch(eventPrefix, /invalid|right/);

const activity = [
  { tool: "maze_start", status: "completed", moves_before: 0, moves_after: 0 },
  { tool: "maze_action", status: "completed", moves_before: 0, moves_after: 1 },
  { tool: "maze_action", status: "completed", moves_before: 1, moves_after: 2 }
].map(JSON.stringify).join("\n") + "\n";
assert.equal(toolActivityPrefix(activity, 1).trim().split("\n").length, 2);
assert.equal(claudeProjectKey("/app/workspace"), "-app-workspace");

const inheritedUnlimited = branchLaunchParams(
  { unlimited: true, segment_move_budget: null },
  { model: "codex", mode: "json", reasoning: "low", unlimited: true, moves: 50 },
  "source-unlimited",
  42
);
assert.equal(inheritedUnlimited.unlimited, true);
assert.equal(inheritedUnlimited.model, "codex");
assert.equal(inheritedUnlimited.mode, "json");
assert.equal(inheritedUnlimited.reasoning, "low");
assert.equal(inheritedUnlimited.branch_of, "source-unlimited");
assert.equal(inheritedUnlimited.branch_turn, 42);

const inheritedFinite = branchLaunchParams(
  { unlimited: false, segment_move_budget: 12, moves: 90 },
  { model: "claude", mode: "text", unlimited: false, moves: 35 },
  "source-finite",
  9
);
assert.equal(inheritedFinite.unlimited, false);
assert.equal(inheritedFinite.moves, 35);
assert.equal(inheritedFinite.model, "claude");

const root = path.join(__dirname, "..");
const router = fs.readFileSync(path.join(root, "server", "router.js"), "utf8");
const runPage = fs.readFileSync(path.join(root, "public", "agent-run.js"), "utf8");
assert.match(router, /segments\[4\] === "branch"/);
assert.match(router, /branchRun\(runId, payload\?\.turn\)/);
assert.doesNotMatch(router, /branchRun\(runId, payload\?\.turn, payload\?\.moves\)/);
assert.match(runPage, /Branch from action/);
assert.doesNotMatch(runPage, /Branch from action \$\{turn\}\. How many more moves/);
assert.match(runPage, /body: JSON\.stringify\(\{ turn \}\)/);
assert.match(runPage, /\["Branch point", `Action \$\{run\.branch_turn\}`\]/);
assert.match(runPage, /data-replay-action="\$\{action\}"/);

console.log("agent-run-branching: OK — branches inherit source configuration and start without a budget prompt.");
