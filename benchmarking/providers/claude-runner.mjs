import { readCheckpointJson } from "../v1/checkpoint-json.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { buildClaudeArguments, createClaudeBoundaryValidator, claudeEnvironment } from "./claude-policy.mjs";

export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
export const readJson = async file => await readCheckpointJson(path.dirname(file), path.basename(file));

export function runClaudeTurn({ projectRoot, directory, metadata, frozen, prompt, control, onSession, environment }) {
  return new Promise((resolve, reject) => {
    const turnId = randomUUID();
    const args = buildClaudeArguments({ projectRoot, runDirectory: directory, model: metadata.model,
      effort: metadata.effort, toolsEnabled: metadata.tools_enabled, prompt,
      resumeSessionId: metadata.claude_session_id, sessionId: metadata.claude_session_id ? null : randomUUID() });
    const child = spawn(frozen.claude_executable, args, {
      cwd: path.join(directory, "agent-cwd"), env: environment || claudeEnvironment(), stdio: ["ignore", "pipe", "pipe"]
    });
    control.child = child;
    const raw = createWriteStream(path.join(directory, "claude-events.jsonl"), { flags: "a", mode: 0o600 });
    const feed = createWriteStream(path.join(directory, "agent-events.jsonl"), { flags: "a", mode: 0o600 });
    const errors = createWriteStream(path.join(directory, "agent-stderr.log"), { flags: "a", mode: 0o600 });
    let buffer = "", stderr = "", sessionId = metadata.claude_session_id, boundaryError = null, result = null, initialized = false;
    let persistence = Promise.resolve();
    const seen = new Set();
    const validateBoundary = createClaudeBoundaryValidator({ model: metadata.model, toolsEnabled: metadata.tools_enabled });
    const invalidate = message => {
      boundaryError ||= message;
      writeFileSync(path.join(directory, "integrity-violation.json"), JSON.stringify({ error: boundaryError, at: new Date().toISOString() }), { mode: 0o600 });
      child.kill("SIGKILL");
    };
    const monitor = setInterval(() => {
      if (existsSync(path.join(directory, "integrity-violation.json"))) {
        boundaryError ||= "Run invalidated by an integrity violation.";
        child.kill("SIGKILL");
      }
    }, 500);
    function receive(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { invalidate("Claude emitted an unrecognized event stream."); return; }
      event._received_at = new Date().toISOString();
      event._turn_id = turnId;
      raw.write(`${JSON.stringify(event)}\n`);
      const violation = validateBoundary(event);
      if (violation) { invalidate(violation); return; }
      if (event.type === "system" && event.subtype === "init") {
        initialized = true;
        if (!/^[a-f0-9-]{36}$/.test(event.session_id || "") || (sessionId && sessionId !== event.session_id)) { invalidate("Claude session identity changed."); return; }
        sessionId = event.session_id;
        control.threadId = sessionId;
        persistence = persistence.then(() => onSession(sessionId));
      }
      if (event.type === "assistant") {
        if (!initialized) { invalidate("Claude responded before validating its tool catalog."); return; }
        for (const [index, block] of (event.message?.content || []).entries()) {
          const key = `${event.message.id}:${index}:${JSON.stringify(block)}`;
          if (seen.has(key)) continue; seen.add(key);
          let item;
          if (block.type === "text") item = { type: "agent_message", text: block.text };
          if (block.type === "thinking") item = { type: "reasoning", text: block.thinking };
          if (block.type === "tool_use") item = { type: "mcp_tool_call", server: "mazebench", tool: block.name.replace(/^mcp__mazebench__/, ""), arguments: block.input, status: "requested" };
          if (item) feed.write(`${JSON.stringify({ type: "item.completed", item, _received_at: event._received_at })}\n`);
        }
      }
      if (event.type === "result") {
        result = event;
        if (typeof event.result === "string") persistence = persistence.then(() => writeFile(path.join(directory, "last-message.txt"), event.result, "utf8"));
      }
    }
    child.stdout.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/); buffer = lines.pop(); lines.forEach(receive);
      if (buffer.length > 8 * 1024 * 1024) invalidate("Claude event exceeded the stream limit.");
    });
    child.stderr.on("data", chunk => { errors.write(chunk); stderr = (stderr + chunk.toString()).slice(-8000); });
    child.on("error", error => { clearInterval(monitor); raw.end(); feed.end(); errors.end(); control.child = null; reject(error); });
    child.on("close", async (code, signal) => {
      clearInterval(monitor);
      if (buffer.trim()) receive(buffer);
      await Promise.all([raw, feed, errors].map(stream => new Promise(done => stream.end(done))));
      control.child = null;
      try { await persistence; }
      catch (error) { reject(error); return; }
      resolve({ code: code ?? 1, signal, sessionId, boundaryError, result,
        error: result?.is_error ? (result.errors || [result.result || result.subtype]).join("\n") : !initialized ? "Claude did not initialize its restricted tool catalog." : !result && !control.pauseRequested && !control.stopRequested ? "Claude exited without a completion event." : stderr.trim() });
    });
  });
}
