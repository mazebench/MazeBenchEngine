const assert = require("assert");
const {
  parseClaudeEvents,
  parseCodexEvents,
  parseCodexSession,
  parsePrimeLiveUsage,
  parsePrimeResults
} = require("../server/token-usage");
const {
  actionsFromShellCommand,
  actionsFromToolCall,
  distillClaudeEvents,
  resultsFromOutput
} = require("../scripts/maze-agent-local");

const lines = (...events) => events.map((event) => JSON.stringify(event)).join("\n");
const codexCall = (verb) => ({
  type: "response_item",
  payload: { type: "custom_tool_call", input: `node scripts/codex-play.js ${verb} --state run/session.json up` }
});

{
  const usage = parseCodexSession(
    lines(
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 10 }, last_token_usage: { input_tokens: 100, output_tokens: 10 }, model_context_window: 1000 } } },
      codexCall("action"),
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 150, output_tokens: 20 }, last_token_usage: { input_tokens: 50, output_tokens: 10 }, model_context_window: 1000 } } },
      codexCall("action")
    )
  );
  assert.equal(usage.total_tokens, 170);
  assert.equal(usage.actions.length, 2);
  assert.equal(usage.actions[1].context_tokens, 50);
  assert.equal(usage.context_window, 1000);
}

{
  const action = { type: "item.completed", item: { type: "command_execution", command: "node scripts/codex-play.js action --state session.json up" } };
  const usage = parseCodexEvents(
    lines(
      action,
      { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } },
      action,
      { type: "turn.completed", usage: { input_tokens: 260, output_tokens: 40 } }
    )
  );
  assert.equal(usage.total_tokens, 300, "Codex JSON turn totals are cumulative, not additive");
  assert.deepEqual(usage.actions.map((point) => point.total_tokens), [120, 180]);
  assert.equal(usage.exact, false);
}

{
  assert.deepEqual(actionsFromToolCall("mcp__mazebench__maze_action", { action: "left" }), ["left"]);
  assert.deepEqual(
    actionsFromToolCall("mcp__mazebench__maze_action", { action: "right", clone_id: "scout" }),
    [],
    "worker-clone moves do not belong to the lead token chart"
  );

  const command = [
    'node scripts/codex-play.js action --state "session.json" up',
    'node scripts/codex-play.js action --state "session.json" "rotate camera left"',
    'node scripts/codex-play.js action --state "session.json" right'
  ].join(" && ");
  assert.deepEqual(actionsFromShellCommand(command), ["up", "rotate camera left", "right"]);

  const output = `${JSON.stringify({ moved: true, gem_count: 1, current_room: "level_AxI" })}\n${JSON.stringify({ moved: false, gem_count: 1, current_room: "level_AxI" })}`;
  assert.deepEqual(resultsFromOutput(output).map((result) => result.moved), [true, false]);

  const distilled = distillClaudeEvents(
    lines(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Follow the corridor." } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "batch-1", name: "Bash", input: { command } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "batch-1", content: output }] } }
    )
  );
  assert.deepEqual(distilled.entries.map((entry) => entry.action), ["up", "rotate camera left"]);
  assert.deepEqual(distilled.entries.map((entry) => entry.move), [1, 2]);
  assert(distilled.entries.every((entry) => entry.reasoning === "Follow the corridor."));

  const mcpDistilled = distillClaudeEvents(
    lines(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Take the open lane." } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "mcp-1", name: "mcp__mazebench__maze_action", input: { action: "up" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "mcp-1", content: JSON.stringify({ moved: true, gem_count: 2, current_room: "level_HxI" }) }] } }
    )
  );
  assert.deepEqual(mcpDistilled.entries.map((entry) => entry.action), ["up"]);
  assert.equal(mcpDistilled.entries[0].reasoning, "Take the open lane.");
}

{
  const usage = parseClaudeEvents(
    lines(
      { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 5 } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "a1", name: "Bash", input: { command: "node scripts/codex-play.js action --state session.json up" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "{}" }] } },
      { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 10, cache_creation_input_tokens: 110, output_tokens: 7 } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "a2", name: "Bash", input: { command: "node scripts/codex-play.js action --state session.json left" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a2", content: "{}" }] } },
      { type: "result", modelUsage: { "claude-test": { inputTokens: 30, outputTokens: 12, cacheReadInputTokens: 80, cacheCreationInputTokens: 110, contextWindow: 200000 } } }
    )
  );
  assert.equal(usage.total_tokens, 232);
  assert.deepEqual(usage.actions.map((point) => point.context_tokens), [100, 120]);
  assert.equal(usage.context_window, 200000);
}

{
  const command = [
    "node scripts/codex-play.js action --state session.json up",
    "node scripts/codex-play.js action --state session.json left"
  ].join(" && ");
  const usage = parseClaudeEvents(
    lines(
      { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 100, output_tokens: 20 } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "batch", name: "Bash", input: { command } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "batch", content: "{}" }] } }
    )
  );
  assert.equal(usage.actions.length, 2);
  assert.deepEqual(usage.actions.map((point) => point.context_tokens), [100, 100]);
  assert.deepEqual(usage.actions.map((point) => point.total_tokens), [60, 60]);
}

{
  const usage = parseClaudeEvents(
    lines(
      { type: "stream_event", event: { type: "message_delta", usage: { input_tokens: 50, output_tokens: 10 } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "ok", name: "mcp__mazebench__maze_action", input: { action: "right" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ok", content: "{}" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "over", name: "mcp__mazebench__maze_action", input: { action: "down" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "over", content: "budget exhausted", is_error: true }] } }
    )
  );
  assert.equal(usage.actions.length, 1, "failed MCP actions are not charted as completed maze moves");
}

{
  const usage = parsePrimeLiveUsage(
    lines(
      { turn: 1, prompt_tokens: 100, cached_input_tokens: 20, completion_tokens: 8, reasoning_tokens: 5, input_tokens: 120, total_tokens: 128 },
      { turn: 2, prompt_tokens: 40, cached_input_tokens: 100, completion_tokens: 10, reasoning_tokens: 7, input_tokens: 140, total_tokens: 150 }
    )
  );
  assert.equal(usage.total_tokens, 278);
  assert.deepEqual(usage.actions.map((point) => point.context_tokens), [120, 140]);
  assert.equal(usage.reasoning_tokens, 12);
}

{
  const usage = parsePrimeResults(
    lines({
      nodes: [
        { sampled: true, usage: { prompt_tokens: 100, cached_input_tokens: 20, completion_tokens: 8, reasoning_tokens: 5 } },
        { sampled: true, usage: { prompt_tokens: 40, cached_input_tokens: 100, completion_tokens: 10, reasoning_tokens: 7 } }
      ]
    })
  );
  assert.equal(usage.total_tokens, 278);
  assert.deepEqual(usage.actions.map((point) => point.context_tokens), [120, 140]);
  assert.equal(usage.reasoning_tokens, 12);
}

console.log("token usage tests passed");
