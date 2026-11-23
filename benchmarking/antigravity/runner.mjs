import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { argumentsFor, boundaryValidator, environment } from "./policy.mjs";

export function runAntigravityTurn({ directory, metadata, frozen, prompt, control, onSession }) {
  return new Promise((resolve, reject) => {
    const turnId = randomUUID(), cwd = path.join(directory, "agent-cwd");
    const child = spawn(frozen.antigravity_executable, argumentsFor({
      model: metadata.model, prompt, conversationId: metadata.antigravity_session_id,
      // Provider logs can include auth diagnostics, so keep them out of records.
      logFile: path.join(frozen.antigravity_home, "runner.log")
    }), { cwd, env: environment(frozen.antigravity_home), stdio: ["ignore", "pipe", "pipe"] });
    control.child = child;
    const raw = createWriteStream(path.join(directory, "antigravity-events.jsonl"), { flags: "a", mode: 0o600 });
    const feed = createWriteStream(path.join(directory, "agent-events.jsonl"), { flags: "a", mode: 0o600 });
    const errors = createWriteStream(path.join(directory, "agent-stderr.log"), { flags: "a", mode: 0o600 });
    const validate = boundaryValidator({ model: metadata.model, cwd, conversationId: metadata.antigravity_session_id, toolsEnabled: metadata.tools_enabled });
    let buffer = "", stderr = "", sessionId = metadata.antigravity_session_id, boundaryError = null, result = null, initialized = false, persistence = Promise.resolve();
    let lastActivity = Date.now(), killTimer = null;
    const seen = new Set();
    const invalidate = message => {
      boundaryError ||= message;
      writeFileSync(path.join(directory, "integrity-violation.json"), JSON.stringify({ error: boundaryError, at: new Date().toISOString() }), { mode: 0o600 });
      child.kill("SIGKILL");
    };
    const monitor = setInterval(() => {
      if (existsSync(path.join(directory, "integrity-violation.json"))) invalidate("Run invalidated by an integrity violation.");
      if ((control.pauseRequested || control.stopRequested) && !killTimer) killTimer = setTimeout(() => child.kill("SIGKILL"), 10000);
      if (Date.now() - lastActivity > 15 * 60 * 1000 && !killTimer) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 10000);
      }
    }, 500);
    function receive(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { invalidate("Antigravity emitted an invalid event stream."); return; }
      lastActivity = Date.now();
      event._received_at = new Date().toISOString();
      event._turn_id = turnId;
      raw.write(JSON.stringify(event) + "\n");
      let violation;
      try { violation = validate(event); } catch (error) { violation = error.message; }
      if (violation) { invalidate(violation); return; }
      if (event.event === "init") {
        initialized = true;
        sessionId = event.conversation_id;
        control.threadId = sessionId;
        persistence = persistence.then(() => onSession(sessionId));
      }
      const step = event.step_update;
      if (step) {
        let item;
        if (step.text_delta) item = { type: "agent_message", text: step.text_delta };
        if (step.tool_name === "call_mcp_tool" && !seen.has(step.step_index)) {
          seen.add(step.step_index);
          const args = step.tool_info.parameters;
          item = { type: "mcp_tool_call", server: args.ServerName, tool: args.ToolName, arguments: args.Arguments, status: "requested" };
        }
        if (item) feed.write(JSON.stringify({ type: "item.completed", item, _received_at: event._received_at }) + "\n");
      }
      if (event.event === "result") {
        result = event.result;
        if (typeof result?.response === "string") persistence = persistence.then(() => writeFile(path.join(directory, "last-message.txt"), result.response, { mode: 0o600 }));
      }
    }
    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/); buffer = lines.pop(); lines.forEach(receive);
      if (buffer.length > 8 * 1024 * 1024) invalidate("Antigravity event exceeded the stream limit.");
    });
    child.stderr.on("data", chunk => { errors.write(chunk); stderr = (stderr + chunk.toString()).slice(-8000); });
    child.on("error", error => { clearInterval(monitor); clearTimeout(killTimer); raw.end(); feed.end(); errors.end(); control.child = null; reject(error); });
    child.on("close", async (code, signal) => {
      clearInterval(monitor); clearTimeout(killTimer);
      if (buffer.trim()) receive(buffer);
      await Promise.all([raw, feed, errors].map(stream => new Promise(done => stream.end(done))));
      control.child = null;
      try { await persistence; } catch (error) { reject(error); return; }
      resolve({ code: code ?? 1, signal, sessionId, boundaryError, result, usage: result?.usage,
        error: !initialized ? "Antigravity did not initialize the restricted agent." :
          result?.status !== "SUCCESS" ? result?.error?.message || result?.response || stderr.trim() || "Antigravity exited without a completion event." : null });
    });
  });
}
