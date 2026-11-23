import { anyPrompt, primePrompt } from "./all-code/policy.mjs";
import { codingMode } from "./coding-mode.mjs";
import { codePrompt } from "./code/prompt.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildBenchmarkPrompt } from "./v1/supervisor.mjs";
import { slotskiPrompt } from "./slotski/action-policy.mjs";

// Keep this read-only adapter outside the frozen run runtimes. Main World and
// Slotski expose builders; the other launchers still compose their text inline.
// Preserve those launchers so viewing prompts cannot invalidate saved runs.
export async function previewBenchmarkPrompt(root, spec = {}) {
  const world = spec.world || "main-world";
  const mode = spec.observation_mode || "ascii";
  const provider = spec.provider || "codex";
  if (!["main-world", "ice-maze", "slotski"].includes(world)) throw new Error("Unknown benchmark world.");
  if (!["ascii", "vision"].includes(mode)) throw new Error("Unknown observation mode.");
  if (!["codex", "claude-code", "grok-build", "antigravity", "muse-code", "kimi-code", "prime-agent", "deepseek-harness"].includes(provider)) throw new Error("Unknown agent provider.");
  if (provider === 'deepseek-harness' && codingMode(spec) === 'any') throw new Error('DeepSeek Harness supports Coding off or Python only.');
  if (mode === "vision" && world !== "main-world") throw new Error("Vision observations are available for Main World only.");
  if (!["codex", "claude-code"].includes(provider) && (world !== "main-world" || mode !== "ascii")) {
    throw new Error("This agent supports Main World with ASCII observations only.");
  }
  const toolsEnabled = codingMode(spec) !== "off";
  const sequences = spec.sequence_enabled !== false && spec.sequence_enabled !== "false";
  const actionLimit = spec.action_limit === null || String(spec.action_limit).toLowerCase() === "unlimited"
    ? null : Math.max(1, Math.min(1_000_000, Math.floor(Number(spec.action_limit) || 100)));
  const options = { toolsEnabled, actionLimit, startRoom: "HxI", sequenceEnabled: sequences };
  const folder = world === "slotski" ? "slotski" : world === "ice-maze" ? "worlds" : mode === "vision" ? "vision" : "v1";
  if (codingMode(spec) === "any") {
    let prompt;
    if (["codex", "claude-code"].includes(provider)) ({ prompt } = await codePrompt(root, spec, options));
    else {
      const base = await readFile(path.join(root, "benchmarking/v1/EVAL-PROMPT.md"), "utf8");
      prompt = (provider === "prime-agent" ? primePrompt : anyPrompt)(base, options);
    }
    return { prompt, world, observation_mode: mode, provider, coding_mode: "any", tools_enabled: true, action_limit: actionLimit };
  }
  const source = `benchmarking/${folder}/EVAL-PROMPT.md`;
  const base = await readFile(path.join(root, source), "utf8");
  let prompt;
  if (provider === "prime-agent" && toolsEnabled) {
    prompt = base + "\n\nUse your native Prime Agent Python workspace. Discover the MCP server named maze; it provides observe, action, and sequence. Call observe first. Game state lives behind these tools, not in your workspace. You may use Python to plan and call those tools. Other network access is disabled. Continue until all gems are collected or the action limit is reached.\n" +
      (actionLimit === null ? "There is no game action limit." : `The game action limit is ${actionLimit}.`);
  } else if (mode === "vision") {
    prompt = base + `\nAction budget: ${actionLimit ?? "unlimited"} accepted actions.\n` + (toolsEnabled
      ? "Python is enabled through python_exec only. Save relative .py files in isolated /workspace. No network, subprocesses, host files, repository, records, private state or prior runs are accessible. Transfer observations into code yourself.\n"
      : "Python is disabled. There are no code executors or writable files.\n") + "Call maze_observe now.";
  } else if (world === "ice-maze" || world === "slotski") {
    // Ice Maze uses the same suffix as Slotski with sequences enabled.
    prompt = slotskiPrompt(base, { ...options, sequenceEnabled: world === "ice-maze" || sequences });
  } else {
    prompt = buildBenchmarkPrompt(base, options);
  }
  return { prompt, world, observation_mode: mode, provider, tools_enabled: toolsEnabled, action_limit: actionLimit };
}
