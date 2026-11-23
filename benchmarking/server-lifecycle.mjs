// HTTP-owner recovery stays outside the frozen benchmark runtime inventories.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { atomicJson } from "./providers/claude-runner.mjs";

const transientStatuses = new Set(["queued", "running", "continuing", "pausing"]);
const execute = promisify(execFile);

async function processListing() {
  const { stdout } = await execute("ps", ["-axo", "pid=,command="], { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export function withRunnerLiveness(BaseSupervisor) {
  return class extends BaseSupervisor {
    async get(id, options) {
      const run = await super.get(id, options);
      if (!run.runner_active && transientStatuses.has(run.status)) {
        return { ...run, recorded_status: run.status, status: "interrupted" };
      }
      return run;
    }

    async resume(id) {
      const directory = this.runDirectory(id);
      const metadataPath = path.join(directory, "run.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      if (!this.active.has(id) && transientStatuses.has(metadata.status)) {
        // A previous HTTP owner may have left a child alive. Never launch a
        // second writer against that child's checkpoint or conversation.
        const identifiers = [metadata.id, metadata.codex_thread_id, metadata.claude_session_id, metadata.grok_session_id, metadata.antigravity_session_id, metadata.muse_session_id, metadata.kimi_session_id]
          .filter(value => typeof value === "string" && value.length > 0);
        const processes = await this.runnerProcessListing();
        if (processes.split("\n").some(line => identifiers.some(value => line.includes(value)))) {
          throw new Error("A process from this run's previous server is still alive. Recover its owner before resuming.");
        }
        await this.verifyRunCapabilityBoundary(metadata, directory);
        const at = new Date().toISOString();
        metadata.recoveries = [...(metadata.recoveries || []), {
          at, reason: "supervisor-interruption", previous_status: metadata.status
        }];
        metadata.status = "stopped";
        metadata.stopped_at = at;
        metadata.updated_at = at;
        await atomicJson(metadataPath, metadata);
      }
      return super.resume(id);
    }

    runnerProcessListing() {
      return processListing();
    }
  };
}
