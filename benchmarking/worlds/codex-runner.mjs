import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicJson, readJson } from "../providers/claude-runner.mjs";
import { eventBoundaryViolation } from "../v1/supervisor.mjs";
import { buildIceCodexArguments } from "./policy.mjs";
const now = () => new Date().toISOString();
function hardenedCodexEnvironment(runDirectory) {
  return {
    HOME: os.homedir(),
    PATH: process.env.PATH || "/usr/bin:/bin",
    TMPDIR: os.tmpdir(),
    LANG: "en_US.UTF-8",
    // Do not inherit endpoint overrides, hooks, plugin settings, API keys or
    // desktop control sockets. Authentication comes from Codex's auth store.
    // Even if a future Codex release ignores the feature override, there is no
    // executable host to run. In-process fallback is disabled separately.
    CODEX_CODE_MODE_HOST_PATH: path.join(runDirectory, "sandbox-state", "code-mode-host-disabled")
  };
}

export async function runIceCodexTurn({ metadata, directory, agentDirectory, prompt, resumeThreadId, control }) {
    const { capabilityPolicy, modelCatalog } = await this.verifyRunCapabilityBoundary(metadata, directory);
    return new Promise((resolve, reject) => {
      const args = buildIceCodexArguments({
        projectRoot: this.projectRoot,
        runDirectory: directory,
        agentDirectory,
        model: metadata.model,
        effort: metadata.effort,
        toolsEnabled: metadata.tools_enabled,
        disabledFeatures: capabilityPolicy.disabled_features,
        modelCatalogPath: modelCatalog.path,
        prompt,
        resumeThreadId
      });
      const child = spawn(capabilityPolicy.codex_executable, args, {
        cwd: agentDirectory,
        env: hardenedCodexEnvironment(directory),
        stdio: ["ignore", "pipe", "pipe"]
      });
      control.child = child;
      const eventStream = createWriteStream(path.join(directory, "agent-events.jsonl"), { flags: "a" });
      const stderrStream = createWriteStream(path.join(directory, "agent-stderr.log"), { flags: "a" });
      let stdoutBuffer = "";
      let stderrTail = "";
      let threadId = resumeThreadId || null;
      let persistedThreadId = resumeThreadId || null;
      let threadPersistence = Promise.resolve();
      let usage = null;
      let reportedError = "";
      let boundaryError = null;
      const integrityMonitor = setInterval(() => {
        const file = path.join(directory, "integrity-violation.json");
        if (!existsSync(file)) return;
        try { boundaryError = `Run invalidated: ${JSON.parse(readFileSync(file, "utf8")).error}`; }
        catch { boundaryError = "Run invalidated by an integrity violation."; }
        child.kill("SIGKILL");
      }, 500);

      const captureThreadId = (candidate) => {
        if (!candidate) return;
        if (threadId && threadId !== candidate) { boundaryError = "Codex session identity changed."; child.kill("SIGKILL"); return; }
        threadId = candidate;
        control.threadId = candidate;
        if (candidate === persistedThreadId) return;
        persistedThreadId = candidate;
        threadPersistence = threadPersistence.then(async () => {
          const current = await readJson(path.join(directory, "run.json"), metadata);
          if (current.codex_thread_id === candidate) return;
          current.codex_thread_id = candidate;
          current.updated_at = now();
          await atomicJson(path.join(directory, "run.json"), current);
        });
      };

      const receiveLine = (line) => {
        const source = line.trim();
        if (!source) return;
        let event;
        try {
          event = JSON.parse(source);
        } catch {
          boundaryError = "Codex emitted an unrecognized event stream."; child.kill("SIGKILL"); return;
        }
        event._received_at = now();
        eventStream.write(`${JSON.stringify(event)}\n`);
        const violation = eventBoundaryViolation(event, { toolsEnabled: metadata.tools_enabled });
        if (violation) { boundaryError = violation; child.kill("SIGKILL"); }
        if (event.type === "turn.failed") reportedError = String(event.error?.message || "");
        if (event.type === "error" && !/^Reconnecting/i.test(String(event.message || ""))) reportedError = String(event.message || "");
        if (event.type === "thread.started") captureThreadId(event.thread_id || event.threadId);
        if (event.msg?.type === "thread.started") captureThreadId(event.msg.thread_id || event.msg.threadId);
        if (event.type === "turn.completed" && event.usage) usage = event.usage;
        if (event.msg?.type === "turn.completed" && event.msg.usage) usage = event.msg.usage;
      };

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        lines.forEach(receiveLine);
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stderrStream.write(text);
        stderrTail = `${stderrTail}${text}`.slice(-8_000);
      });
      child.on("error", (error) => {
        clearInterval(integrityMonitor);
        eventStream.end();
        stderrStream.end();
        reject(error);
      });
      child.on("close", async (code, signal) => {
        clearInterval(integrityMonitor);
        if (stdoutBuffer.trim()) receiveLine(stdoutBuffer);
        eventStream.end();
        stderrStream.end();
        control.child = null;
        await threadPersistence.catch(error => { boundaryError = error.message; });
        if (boundaryError) writeFileSync(path.join(directory, "integrity-violation.json"), JSON.stringify({ error: boundaryError }), { mode: 0o600 });
        resolve({ code: code ?? (signal ? 1 : 0), signal, threadId, usage, boundaryError, reportedError, stderrTail: stderrTail.trim() });
      });
    });
  }

