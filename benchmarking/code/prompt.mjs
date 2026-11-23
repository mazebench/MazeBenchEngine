import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildBenchmarkPrompt } from "../v1/supervisor.mjs";
import { slotskiPrompt } from "../slotski/action-policy.mjs";
import { supportsAnyLanguage } from "../coding-mode.mjs";

export const CODE_INSTRUCTIONS = `ANY-LANGUAGE WORKSPACE: code_exec is the only code executor. It accepts a command (a shell program), optional files [{path, content}], and timeout_seconds (1–60). Sources and generated files persist in /workspace. Use any language supported by the pinned toolchain, including Python, JavaScript (Node), C, C++, Rust, Go, Java, Ruby, Perl, and Lua. You may compile programs and launch subprocesses inside this sandbox. Commands start with a clean environment; no background process survives a tool call. There is no network or package downloading. Only the workspace is writable persistently; /tmp is temporary. The repository, host files, credentials, benchmark records, private game state, other runs, and game tools are inaccessible from code. Transfer observations explicitly into source or data files. Tool calls have a 60-second maximum, 1 GiB memory, two CPUs, 64 processes, 32 MiB per file, and 256 KB combined output. Read records and make game moves only through direct maze_observe, maze_action, and (when available) maze_sequence calls. Native agent shell/file/web tools and subagents remain unavailable.`;
export async function codePrompt(root, spec, options) {
  if (!supportsAnyLanguage(spec)) throw new Error("Any language currently supports Codex and Claude Code with ASCII observations.");
  const world = spec.world || "main-world";
  const folder = world === "slotski" ? "slotski" : world === "ice-maze" ? "worlds" : "v1";
  let base = await readFile(path.join(root, `benchmarking/${folder}/EVAL-PROMPT.md`), "utf8");
  // Preserve the exact game rules; replace only the old execution instructions.
  base = base.replace(/Tool Use\n[\s\S]*$/, "Tool Use\nUse the workspace described by the benchmark harness to model observations and plan moves.");
  base = base.replaceAll("python_exec", "code_exec").replace(/Python, if enabled,[\s\S]*?direct game-tool calls only\./, "Code may use only board data you explicitly provide; it cannot call game tools.");
  const built = world === "main-world" ? buildBenchmarkPrompt(base, { ...options, toolsEnabled: true })
    : slotskiPrompt(base, { ...options, toolsEnabled: true, sequenceEnabled: world !== "slotski" || options.sequenceEnabled !== false });
  const prompt = built.replace(/PYTHON WORKSPACE:[^\n]*/, CODE_INSTRUCTIONS)
    .replace(/Python is enabled through python_exec only\.[^\n]*/, CODE_INSTRUCTIONS);
  if (prompt.includes("python_exec") || prompt.includes("Python is disabled")) throw new Error("Conflicting code instructions in prompt.");
  return { base, prompt };
}
