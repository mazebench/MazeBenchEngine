import { eventBoundaryViolation } from "../v1/supervisor.mjs";
import { claudeBoundaryViolation, claudeTools } from "../providers/claude-policy.mjs";

// Missing on older runs means the original, batched condition.
export function sequenceEnabled(value = true) {
  if (typeof value !== "boolean") throw new Error("sequence_enabled must be a boolean.");
  return value;
}

export function slotskiTools({ toolsEnabled = false, sequenceEnabled: sequences = true } = {}) {
  return ["maze_observe", "maze_action", ...(sequenceEnabled(sequences) ? ["maze_sequence"] : []), ...(toolsEnabled ? ["python_exec"] : [])];
}

export function slotskiPrompt(base, { actionLimit, toolsEnabled, sequenceEnabled: sequences = true }) {
  sequenceEnabled(sequences);
  if (!sequences) {
    base = base.replace(/^Use maze_sequence for multiple moves:.*$/m,
      "This run permits one action per tool call. Use maze_action for exactly one one-cell move, undo, or reset, then inspect its result before choosing the next action. Repeats and multi-move requests are rejected.")
      .replace("maze_observe, maze_action, maze_sequence, and python_exec", "maze_observe, maze_action, and python_exec")
      .replace("Only maze_action and maze_sequence can change the game.", "Only maze_action can change the game.");
  }
  return `${base}\nAction budget: ${actionLimit ?? "unlimited"} accepted actions.\n${toolsEnabled
    ? "Python is enabled through python_exec only. Save programs as relative .py files in isolated /workspace. No network, subprocesses, repository, host, credentials, results, prior-run or record access is available to Python. Transfer observed board data explicitly. No other code executor is permitted."
    : `Python is disabled. No code executors, writable files, shell, JavaScript, web, apps, connectors or subagents are available. Use only direct ${sequences ? "maze_observe, maze_action and maze_sequence" : "maze_observe and maze_action"} calls.`}\nCall maze_observe now.`;
}

export function slotskiCodexBoundaryViolation(event, options = {}) {
  const item = event.item || event.msg?.item || {};
  if (options.sequenceEnabled === false && (item.tool || item.name || item.tool_name) === "maze_sequence")
    return "Action sequences are disabled for this run.";
  return eventBoundaryViolation(event, options);
}

export function slotskiClaudeBoundaryViolation(event, options = {}) {
  if (options.sequenceEnabled !== false) return claudeBoundaryViolation(event, options);
  const forbidden = "mcp__mazebench__maze_sequence";
  if (event.event?.content_block?.name === forbidden ||
      event.message?.content?.some(block => block.type === "tool_use" && block.name === forbidden))
    return "Action sequences are disabled for this run.";
  if (event.type === "system" && event.subtype === "init") {
    const expected = slotskiTools(options).map(name => `mcp__mazebench__${name}`).sort();
    if (JSON.stringify([...(event.tools || [])].sort()) !== JSON.stringify(expected))
      return "Unexpected Claude single-action tool catalog.";
    // The shared validator expects the legacy catalog. After validating the
    // narrower catalog exactly, retain all its other provider/sandbox checks.
    return claudeBoundaryViolation({ ...event, tools: claudeTools(options.toolsEnabled) }, options);
  }
  return claudeBoundaryViolation(event, options);
}
