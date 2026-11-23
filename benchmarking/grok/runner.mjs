import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildGrokArguments, createGrokBoundaryValidator, grokEnvironment, verifyStoredGrokToolCatalog } from "./policy.mjs";

export function runGrokTurn({ directory, metadata, frozen, prompt, control, onSession, environment }) {
  return new Promise((resolve, reject) => {
    const turnId = randomUUID();
    const cwd = path.join(directory, "agent-cwd");
    const resuming = Boolean(metadata.grok_session_id);
    if (resuming) verifyStoredGrokToolCatalog(frozen.grok_home, cwd, metadata.grok_session_id);
    const args = buildGrokArguments({
      model: metadata.model,
      effort: metadata.effort,
      toolsEnabled: metadata.tools_enabled,
      prompt,
      resumeSessionId: metadata.grok_session_id,
      sessionId: randomUUID()
    });
    const child = spawn(frozen.grok_executable, args, {
      cwd, env: environment || grokEnvironment(frozen.grok_home), stdio: ["ignore", "pipe", "pipe"]
    });
    control.child = child;
    const raw = createWriteStream(path.join(directory, "grok-events.jsonl"), { flags: "a", mode: 0o600 });
    const feed = createWriteStream(path.join(directory, "agent-events.jsonl"), { flags: "a", mode: 0o600 });
    const errors = createWriteStream(path.join(directory, "agent-stderr.log"), { flags: "a", mode: 0o600 });
    let buffer = "", stderr = "", sessionId = metadata.grok_session_id, boundaryError = null, result = null, initialized = false, reportedError = null;
    let persistence = Promise.resolve();
    const seen = new Set();
    const validateBoundary = createGrokBoundaryValidator({ model: metadata.model, toolsEnabled: metadata.tools_enabled, cwd, resuming });
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
      try { event = JSON.parse(line); } catch { invalidate("Grok emitted an unrecognized event stream."); return; }
      event._received_at = new Date().toISOString();
      event._turn_id = turnId;
      raw.write(`${JSON.stringify(event)}\n`);
      const violation = validateBoundary(event);
      if (violation) { invalidate(violation); return; }
      if (event.type === "system" && event.subtype === "init") {
        initialized = true;
        sessionId = event.session_id;
        control.threadId = sessionId;
        persistence = persistence.then(() => onSession(sessionId));
      }
      if (event.type === "assistant") {
        for (const [index, block] of (event.message?.content || []).entries()) {
          const key = `${event.message.id}:${index}:${JSON.stringify(block)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          let item;
          if (block.type === "text") item = { type: "agent_message", text: block.text };
          if (block.type === "thinking") item = { type: "reasoning", text: block.thinking };
          if (block.type === "tool_use" && block.name === "use_tool") item = {
            type: "mcp_tool_call", server: "mazebench",
            tool: String(block.input?.tool_name || "").replace(/^mazebench__/, ""),
            arguments: block.input?.tool_input || {}, status: "requested"
          };
          if (item) feed.write(`${JSON.stringify({ type: "item.completed", item, _received_at: event._received_at })}\n`);
        }
      }
      if (event.type === "result") {
        result = event;
        if (typeof event.result === "string") persistence = persistence.then(() => writeFile(path.join(directory, "last-message.txt"), event.result, "utf8"));
      }
      if (event.type === "error") reportedError = String(event.message || "Grok Build reported an error.");
    }
    child.stdout.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/); buffer = lines.pop(); lines.forEach(receive);
      if (buffer.length > 8 * 1024 * 1024) invalidate("Grok event exceeded the stream limit.");
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
      resolve({
        code: code ?? 1, signal, sessionId, boundaryError, result, usage: result?.usage,
        error: reportedError || (result?.is_error ? result.result || result.subtype : !initialized ? "Grok did not initialize its restricted tool catalog." : !result && !control.pauseRequested && !control.stopRequested ? "Grok exited without a completion event." : stderr.trim())
      });
    });
  });
}
