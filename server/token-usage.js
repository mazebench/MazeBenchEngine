const fs = require("fs");
const path = require("path");
const { actionsFromShellCommand, actionsFromToolCall } = require("../scripts/maze-agent-local");

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function jsonLines(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

function isMazeAction(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return /(?:codex-play|maze-agent-local)\.js[\s\S]{0,1800}?\baction\s+--state\b/i.test(text);
}

function mazeActionCount(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return actionsFromShellCommand(text).length || (isMazeAction(value) ? 1 : 0);
}

function mazeToolActionCount(name, input) {
  return actionsFromToolCall(name, input).length;
}

function withCompactionFlags(points) {
  return points.map((point, index) => {
    const previous = points[index - 1];
    const drop = previous && previous.context_tokens && point.context_tokens
      ? previous.context_tokens - point.context_tokens
      : 0;
    return {
      ...point,
      compacted: Boolean(previous && drop >= 4096 && point.context_tokens <= previous.context_tokens * 0.8)
    };
  });
}

function finishUsage({ provider, points, totals, currentContext, contextWindow, exact, note = "" }) {
  const marked = withCompactionFlags(points);
  const perActionTotal = marked.reduce((sum, point) => sum + number(point.total_tokens), 0);

  return {
    provider,
    available: marked.length > 0 || number(totals.total_tokens) > 0,
    exact,
    note,
    total_tokens: number(totals.total_tokens),
    input_tokens: number(totals.input_tokens),
    cached_input_tokens: number(totals.cached_input_tokens),
    output_tokens: number(totals.output_tokens),
    reasoning_tokens: number(totals.reasoning_tokens),
    current_context_tokens: number(currentContext) || null,
    context_window: number(contextWindow) || null,
    average_tokens_per_action: marked.length ? Math.round(perActionTotal / marked.length) : null,
    compactions: marked.filter((point) => point.compacted).length,
    actions: marked
  };
}

function codexUsageShape(usage = {}) {
  const input = number(usage.input_tokens);
  const output = number(usage.output_tokens);
  return {
    input_tokens: input,
    cached_input_tokens: number(usage.cached_input_tokens),
    output_tokens: output,
    reasoning_tokens: number(usage.reasoning_output_tokens),
    total_tokens: number(usage.total_tokens) || input + output
  };
}

function parseCodexSession(raw) {
  const points = [];
  let latest = null;
  let cumulative = {};
  let contextWindow = 0;

  for (const event of jsonLines(raw)) {
    if (event.type === "event_msg" && event.payload?.type === "token_count" && event.payload.info) {
      latest = codexUsageShape(event.payload.info.last_token_usage || {});
      cumulative = codexUsageShape(event.payload.info.total_token_usage || {});
      contextWindow = number(event.payload.info.model_context_window) || contextWindow;
      continue;
    }

    if (
      event.type === "response_item" &&
      ["custom_tool_call", "function_call", "mcp_tool_call"].includes(event.payload?.type) &&
      latest
    ) {
      const count =
        mazeToolActionCount(event.payload.name || event.payload.tool || event.payload.tool_name, event.payload.input || event.payload.arguments) ||
        mazeActionCount(event.payload.input || event.payload.arguments || event.payload.command);
      if (!count) continue;
      for (let index = 0; index < count; index += 1) {
        points.push({
          action: points.length + 1,
          total_tokens: Math.round(latest.total_tokens / count),
          input_tokens: Math.round(latest.input_tokens / count),
          cached_input_tokens: Math.round(latest.cached_input_tokens / count),
          output_tokens: Math.round(latest.output_tokens / count),
          reasoning_tokens: Math.round(latest.reasoning_tokens / count),
          context_tokens: latest.input_tokens
        });
      }
    }
  }

  return finishUsage({
    provider: "codex",
    points,
    totals: cumulative,
    currentContext: latest?.input_tokens,
    contextWindow,
    exact: true
  });
}

function parseCodexEvents(raw) {
  const points = [];
  let pendingActions = 0;
  let previous = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 };
  let totals = previous;

  for (const event of jsonLines(raw)) {
    const item = event.item || event.msg?.item;
    if ((event.type || event.msg?.type) === "item.completed") {
      const kind = item?.type || item?.item_type;
      const count = kind === "command_execution"
        ? mazeActionCount(item.command)
        : kind === "mcp_tool_call" && item.status !== "failed" && !item.error
          ? mazeToolActionCount(item.tool || item.name || item.tool_name, item.arguments || item.input)
          : 0;
      if (count) {
        pendingActions += count;
        continue;
      }
    }

    if ((event.type || event.msg?.type) !== "turn.completed" || !event.usage) continue;
    const current = codexUsageShape(event.usage);
    const delta = {
      input_tokens: Math.max(0, current.input_tokens - previous.input_tokens),
      cached_input_tokens: Math.max(0, current.cached_input_tokens - previous.cached_input_tokens),
      output_tokens: Math.max(0, current.output_tokens - previous.output_tokens),
      reasoning_tokens: Math.max(0, current.reasoning_tokens - previous.reasoning_tokens),
      total_tokens: Math.max(0, current.total_tokens - previous.total_tokens)
    };
    const count = Math.max(1, pendingActions);

    for (let index = 0; index < pendingActions; index += 1) {
      points.push({
        action: points.length + 1,
        total_tokens: Math.round(delta.total_tokens / count),
        input_tokens: Math.round(delta.input_tokens / count),
        cached_input_tokens: Math.round(delta.cached_input_tokens / count),
        output_tokens: Math.round(delta.output_tokens / count),
        reasoning_tokens: Math.round(delta.reasoning_tokens / count),
        context_tokens: null
      });
    }

    pendingActions = 0;
    previous = current;
    totals = current;
  }

  return finishUsage({
    provider: "codex",
    points,
    totals,
    currentContext: null,
    contextWindow: null,
    exact: false,
    note: "Per-action use is estimated from the CLI turn total; container context size is not exposed."
  });
}

function claudeUsageShape(usage = {}) {
  const uncached = number(usage.input_tokens);
  const cached = number(usage.cache_read_input_tokens) + number(usage.cache_creation_input_tokens);
  const output = number(usage.output_tokens);
  return {
    input_tokens: uncached + cached,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_tokens: number(usage.output_tokens_details?.thinking_tokens),
    total_tokens: uncached + cached + output
  };
}

function parseClaudeEvents(raw) {
  const points = [];
  const pending = new Map();
  const totals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 };
  let latest = null;
  let contextWindow = 0;
  let selectedModelWeight = -1;

  for (const event of jsonLines(raw)) {
    if (event.type === "stream_event" && event.event?.type === "message_delta" && event.event.usage) {
      latest = claudeUsageShape(event.event.usage);
      Object.keys(totals).forEach((key) => {
        totals[key] += latest[key];
      });
      continue;
    }

    if (event.type === "assistant" && Array.isArray(event.message?.content) && latest) {
      for (const block of event.message.content) {
        if (block?.type !== "tool_use" || !block.id) continue;
        const count = block.name === "Bash"
          ? mazeActionCount(block.input?.command)
          : mazeToolActionCount(block.name, block.input);
        if (count) pending.set(block.id, { count, usage: { ...latest } });
      }
    }

    if (event.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== "tool_result" || !pending.has(block.tool_use_id)) continue;
        const batch = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        if (block.is_error) continue;
        for (let index = 0; index < batch.count; index += 1) {
          points.push({
            action: points.length + 1,
            total_tokens: Math.round(batch.usage.total_tokens / batch.count),
            input_tokens: Math.round(batch.usage.input_tokens / batch.count),
            cached_input_tokens: Math.round(batch.usage.cached_input_tokens / batch.count),
            output_tokens: Math.round(batch.usage.output_tokens / batch.count),
            reasoning_tokens: Math.round(batch.usage.reasoning_tokens / batch.count),
            context_tokens: batch.usage.input_tokens
          });
        }
      }
    }

    if (event.type === "result" && event.modelUsage && typeof event.modelUsage === "object") {
      for (const stats of Object.values(event.modelUsage)) {
        const weight =
          number(stats?.inputTokens) +
          number(stats?.cacheReadInputTokens) +
          number(stats?.cacheCreationInputTokens) +
          number(stats?.outputTokens);
        if (weight > selectedModelWeight) {
          selectedModelWeight = weight;
          contextWindow = number(stats?.contextWindow) || contextWindow;
        }
      }
    }
  }

  return finishUsage({
    provider: "claude",
    points,
    totals,
    currentContext: latest?.input_tokens,
    contextWindow,
    exact: true
  });
}

function parsePrimeResults(raw) {
  const row = jsonLines(raw)[0] || {};
  const sampled = Array.isArray(row.nodes) ? row.nodes.filter((node) => node?.sampled && node.usage) : [];
  const points = sampled.map((node, index) => {
    const usage = node.usage || {};
    const input = number(usage.prompt_tokens) + number(usage.cached_input_tokens);
    const output = number(usage.completion_tokens);
    return {
      action: index + 1,
      total_tokens: input + output,
      input_tokens: input,
      cached_input_tokens: number(usage.cached_input_tokens),
      output_tokens: output,
      reasoning_tokens: number(usage.reasoning_tokens),
      context_tokens: input
    };
  });
  const totals = points.reduce(
    (sum, point) => {
      sum.input_tokens += point.input_tokens;
      sum.cached_input_tokens += point.cached_input_tokens;
      sum.output_tokens += point.output_tokens;
      sum.reasoning_tokens += point.reasoning_tokens;
      sum.total_tokens += point.total_tokens;
      return sum;
    },
    { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 }
  );

  return finishUsage({
    provider: "prime",
    points,
    totals,
    currentContext: points.at(-1)?.context_tokens,
    contextWindow: null,
    exact: true
  });
}

function parsePrimeLiveUsage(raw) {
  const byTurn = new Map();
  for (const record of jsonLines(raw)) {
    const turn = Math.max(1, Math.floor(number(record.turn)) || byTurn.size + 1);
    const input = number(record.input_tokens) || number(record.prompt_tokens) + number(record.cached_input_tokens);
    const output = number(record.completion_tokens);
    byTurn.set(turn, {
      action: turn,
      total_tokens: number(record.total_tokens) || input + output,
      input_tokens: input,
      cached_input_tokens: number(record.cached_input_tokens),
      output_tokens: output,
      reasoning_tokens: number(record.reasoning_tokens),
      context_tokens: input
    });
  }

  const points = [...byTurn.values()].sort((left, right) => left.action - right.action);
  const totals = points.reduce(
    (sum, point) => {
      sum.input_tokens += point.input_tokens;
      sum.cached_input_tokens += point.cached_input_tokens;
      sum.output_tokens += point.output_tokens;
      sum.reasoning_tokens += point.reasoning_tokens;
      sum.total_tokens += point.total_tokens;
      return sum;
    },
    { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 }
  );

  return finishUsage({
    provider: "prime",
    points,
    totals,
    currentContext: points.at(-1)?.context_tokens,
    contextWindow: null,
    exact: true
  });
}

function findFile(directory, predicate, depth = 0) {
  if (!directory || depth > 8 || !fs.existsSync(directory)) return "";

  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (_error) {
    return "";
  }

  for (const entry of entries) {
    if (entry.isFile() && predicate(entry.name)) return path.join(directory, entry.name);
  }

  for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
    if (!entry.isDirectory()) continue;
    const found = findFile(path.join(directory, entry.name), predicate, depth + 1);
    if (found) return found;
  }

  return "";
}

function findCodexSessionFile(codexHome, conversationId) {
  if (!conversationId) return "";
  return findFile(
    path.join(codexHome || "", "sessions"),
    (name) => name.endsWith(".jsonl") && name.includes(conversationId)
  );
}

function findClaudeSessionFile(claudeHome, conversationId) {
  if (!conversationId) return "";
  return findFile(
    path.join(claudeHome || "", "projects"),
    (name) => name === `${conversationId}.jsonl`
  );
}

function findPrimeResultsFile(runDir) {
  return findFile(path.join(runDir, "eval-output"), (name) => name === "results.jsonl", 0);
}

module.exports = {
  findClaudeSessionFile,
  findCodexSessionFile,
  findPrimeResultsFile,
  parseClaudeEvents,
  parseCodexEvents,
  parseCodexSession,
  parsePrimeLiveUsage,
  parsePrimeResults
};
