const path = require("node:path");

function jsonLines(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return { line, value: JSON.parse(line) };
      } catch (_error) {
        return { line, value: null };
      }
    });
}

function isMazeTool(name, tool) {
  return new RegExp(`(?:^|__)maze_${tool}$`).test(String(name || ""));
}

function isPrimaryInvocation(invocation) {
  return !invocation?.arguments?.clone_id;
}

function codexCallSucceeded(payload) {
  if (payload?.result?.Err !== undefined) return false;
  if (payload?.result?.Ok?.isError === true) return false;
  return true;
}

function codexTranscriptPrefix(text, requestedTurn, newConversationId) {
  const entries = jsonLines(text);
  const turn = Math.max(0, Math.floor(Number(requestedTurn) || 0));
  const boundaries = new Map();
  let completedActions = 0;
  let pendingBoundary = null;

  for (let index = 0; index < entries.length; index += 1) {
    const record = entries[index].value;
    const payload = record?.payload || {};
    const invocation = payload.invocation || {};

    if (
      record?.type === "event_msg" &&
      payload.type === "mcp_tool_call_end" &&
      isPrimaryInvocation(invocation) &&
      codexCallSucceeded(payload)
    ) {
      if (isMazeTool(invocation.tool, "action")) {
        completedActions += 1;
        pendingBoundary = completedActions;
      } else if (
        completedActions === 0 &&
        (isMazeTool(invocation.tool, "start") || isMazeTool(invocation.tool, "observe"))
      ) {
        pendingBoundary = 0;
      }
    }

    // Codex persists the provider-visible tool output immediately after its
    // internal mcp_tool_call_end event. The output, rather than the telemetry
    // event alone, is the context boundary that a resumed model must see.
    if (
      pendingBoundary !== null &&
      record?.type === "response_item" &&
      payload.type === "custom_tool_call_output"
    ) {
      boundaries.set(pendingBoundary, index);
      pendingBoundary = null;
      if (completedActions >= turn && boundaries.has(turn)) break;
    }
  }

  const boundary = boundaries.get(turn);
  if (boundary === undefined) {
    throw new Error(
      turn === 0
        ? "The Codex transcript has no saved initial maze checkpoint."
        : `The Codex transcript has no completed provider checkpoint for action ${turn}.`
    );
  }

  const prefix = entries.slice(0, boundary + 1).map((entry) => entry.value || entry.line);
  const meta = prefix.find((entry) => entry && typeof entry === "object" && entry.type === "session_meta");
  if (!meta?.payload) throw new Error("The Codex transcript is missing its session metadata.");
  meta.payload.id = newConversationId;
  meta.payload.session_id = newConversationId;

  return `${prefix.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n")}\n`;
}

function claudeTranscriptPrefix(text, requestedTurn) {
  const entries = jsonLines(text);
  const turn = Math.max(0, Math.floor(Number(requestedTurn) || 0));
  const pending = new Map();
  const boundaries = new Map();
  let completedActions = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const record = entries[index].value;
    const blocks = Array.isArray(record?.message?.content) ? record.message.content : [];

    for (const block of blocks) {
      if (block?.type === "tool_use") {
        let kind = "";
        if (isMazeTool(block.name, "action") && !block.input?.clone_id) kind = "action";
        else if (isMazeTool(block.name, "start") || isMazeTool(block.name, "observe")) kind = "initial";
        if (kind && block.id) pending.set(block.id, kind);
        continue;
      }

      if (block?.type !== "tool_result" || !pending.has(block.tool_use_id)) continue;
      const kind = pending.get(block.tool_use_id);
      pending.delete(block.tool_use_id);
      if (block.is_error) continue;

      if (kind === "action") {
        completedActions += 1;
        boundaries.set(completedActions, index);
      } else if (completedActions === 0) {
        boundaries.set(0, index);
      }
    }

    if (completedActions >= turn && boundaries.has(turn)) break;
  }

  const boundary = boundaries.get(turn);
  if (boundary === undefined) {
    throw new Error(
      turn === 0
        ? "The Claude transcript has no saved initial maze checkpoint."
        : `The Claude transcript has no completed provider checkpoint for action ${turn}.`
    );
  }

  return `${entries.slice(0, boundary + 1).map((entry) => entry.line).join("\n")}\n`;
}

function eventTool(event) {
  const item = event?.item || event?.msg?.item || {};
  return {
    kind: item.type || item.item_type,
    name: item.tool || item.name || item.tool_name,
    input: item.arguments || item.input || {},
    succeeded: item.status !== "failed" && !item.error
  };
}

function providerEventPrefix(text, provider, requestedTurn, oldConversationId, newConversationId) {
  const entries = jsonLines(text);
  const turn = Math.max(0, Math.floor(Number(requestedTurn) || 0));
  const pending = new Map();
  let completedActions = 0;
  let boundary = -1;

  for (let index = 0; index < entries.length; index += 1) {
    const event = entries[index].value;
    if (!event) continue;

    if (provider === "codex") {
      if ((event.type || event.msg?.type) !== "item.completed") continue;
      const tool = eventTool(event);
      if (tool.kind !== "mcp_tool_call" || tool.input?.clone_id || !tool.succeeded) continue;
      if (isMazeTool(tool.name, "action")) completedActions += 1;
      else if (completedActions !== 0 || (!isMazeTool(tool.name, "start") && !isMazeTool(tool.name, "observe"))) continue;
      if (completedActions === turn) boundary = index;
    } else if (provider === "claude") {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const block of blocks) {
        if (block?.type === "tool_use") {
          let kind = "";
          if (isMazeTool(block.name, "action") && !block.input?.clone_id) kind = "action";
          else if (isMazeTool(block.name, "start") || isMazeTool(block.name, "observe")) kind = "initial";
          if (kind && block.id) pending.set(block.id, kind);
        } else if (block?.type === "tool_result" && pending.has(block.tool_use_id)) {
          const kind = pending.get(block.tool_use_id);
          pending.delete(block.tool_use_id);
          if (block.is_error) continue;
          if (kind === "action") completedActions += 1;
          else if (completedActions !== 0) continue;
          if (completedActions === turn) boundary = index;
        }
      }
    }

    if (boundary >= 0 && completedActions >= turn) break;
  }

  if (boundary < 0) return "";
  const prefix = entries.slice(0, boundary + 1).map((entry) => entry.line).join("\n");
  const rewritten = oldConversationId && newConversationId
    ? prefix.split(oldConversationId).join(newConversationId)
    : prefix;
  return `${rewritten}\n`;
}

function toolActivityPrefix(text, requestedTurn) {
  const entries = jsonLines(text);
  const turn = Math.max(0, Math.floor(Number(requestedTurn) || 0));
  let boundary = -1;

  for (let index = 0; index < entries.length; index += 1) {
    const event = entries[index].value || {};
    if (event.clone_id) continue;
    if (
      event.status === "completed" &&
      ["maze_start", "maze_observe"].includes(event.tool) &&
      turn === 0 &&
      Number(event.moves_after || 0) === 0
    ) {
      boundary = index;
    }
    if (
      event.status === "completed" &&
      event.tool === "maze_action" &&
      Number(event.moves_after) === turn &&
      Number(event.moves_after) > Number(event.moves_before)
    ) {
      boundary = index;
      break;
    }
  }

  return boundary < 0 ? "" : `${entries.slice(0, boundary + 1).map((entry) => entry.line).join("\n")}\n`;
}

function claudeProjectKey(cwd) {
  return String(path.resolve(cwd)).replace(/[^a-zA-Z0-9_-]/g, "-");
}

module.exports = {
  claudeProjectKey,
  claudeTranscriptPrefix,
  codexTranscriptPrefix,
  providerEventPrefix,
  toolActivityPrefix
};
