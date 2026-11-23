// Read-only HTTP views. Keep dashboard changes outside frozen agent assets.
import { existsSync } from "node:fs";
import path from "node:path";
import { readRunVersion } from "./run-version.mjs";
import { RunLibrary } from "./run-library.mjs";
import { readCheckpointJson } from "./v1/checkpoint-json.mjs";
import { safeReadFile } from "./v1/safe-files.mjs";
import { CAPABILITY_POLICY_VERSION } from "./v1/integrity.mjs";
import { publicRunError, isRecoverableCompactionError } from "./v1/supervisor.mjs";
import { workspaceInventory } from "./v1/python-sandbox.mjs";
import { readJsonLinesTail } from "./storage/tail-jsonl.mjs";
import { CLAUDE_POLICY } from "./providers/claude-policy.mjs";
import { GROK_POLICY } from "./grok/policy.mjs";
import { POLICY as ANTIGRAVITY_POLICY } from "./antigravity/policy.mjs";

import { POLICY as PRIME_POLICY } from "./prime/policy.mjs";
import { rateLimitDetails } from "./run-errors.mjs";
import { POLICY as MUSE_POLICY } from "./muse/policy.mjs";

const fields = ["id", "pair_id", "provider", "world", "model", "observation_mode", "effort", "tools_enabled", "coding_mode", "harness", "code_policy", "sequence_enabled", "service_tier", "action_limit", "start_room", "created_at", "updated_at", "completed_at", "paused_at", "stopped_at", "status", "continuation_count", "world_updates", "world_revision", "isolation", "usage"];
const optional = async (directory, file, fallback) => readCheckpointJson(directory, file).catch(error => { if (error.code === "ENOENT") return fallback; throw error; });

export class RunDashboard {
  constructor(library = new RunLibrary()) { this.library = library; }

  async overview(supervisor, id) {
    const directory = supervisor.runDirectory(id);
    const [metadata, snapshot] = await Promise.all([readCheckpointJson(directory, "run.json"), this.library.snapshot(directory)]);
    const run = { ...Object.fromEntries(fields.filter(key => Object.hasOwn(metadata, key)).map(key => [key, metadata[key]])),
      ...snapshot.summary, id: metadata.id, status: metadata.status,
      history_epoch: snapshot.history_epoch || metadata.integrity?.manifest_sha256 || metadata.created_at,
      runner_active: supervisor.active.has(id), error: metadata.error ? publicRunError(metadata.error) : null,
      display: snapshot.display ?? await optional(directory, "display.json", null) };
    run.benchmark_version = readRunVersion(directory, metadata, snapshot.summary);
    const rateLimit = metadata.status === "failed" ? rateLimitDetails(metadata.error) : null;
    if (rateLimit) run.rate_limit = rateLimit;
    const policy = metadata.capability_policy;
    run.capability_boundary_verified = policy?.version === CAPABILITY_POLICY_VERSION && policy?.model_catalog?.tool_mode === "direct" && policy?.model_catalog?.javascript_host === "disabled" && metadata.integrity?.version === CAPABILITY_POLICY_VERSION;
    run.compaction_recoverable = metadata.status === "failed" && isRecoverableCompactionError(metadata.error);
    const providerPolicies = { "claude-code": [CLAUDE_POLICY, "claude_session_id"], "grok-build": [GROK_POLICY, "grok_session_id"], antigravity: [ANTIGRAVITY_POLICY, "antigravity_session_id"], "muse-code": [MUSE_POLICY, "muse_session_id"] };
    if (providerPolicies[metadata.provider]) {
      const [name, session] = providerPolicies[metadata.provider];
      run.capability_boundary_verified = policy?.name === name && metadata.integrity?.version === CAPABILITY_POLICY_VERSION && !existsSync(path.join(directory, "integrity-violation.json"));
      run.compaction_recoverable = metadata.status === "failed" && run.capability_boundary_verified && Boolean(metadata[session]);
    }
    if (metadata.provider === "prime-agent") {
      run.capability_boundary_verified = policy?.name === PRIME_POLICY && metadata.integrity?.version === CAPABILITY_POLICY_VERSION && !existsSync(path.join(directory, "integrity-violation.json"));
      run.compaction_recoverable = false;
    }
    if (!run.runner_active && ["queued", "running", "continuing", "pausing"].includes(run.status)) {
      run.recorded_status = run.status; run.status = "interrupted";
    }
    return run;
  }

  async activity(supervisor, id) {
    const directory = supervisor.runDirectory(id);
    const metadata = await readCheckpointJson(directory, "run.json");
    const events = await readJsonLinesTail(path.join(directory, "agent-events.jsonl"), 800);
    const feed = events.flatMap(event => {
      if ((event.type || event.msg?.type) !== "item.completed") return [];
      const item = event.item || event.msg?.item || {}, type = item.type || item.item_type;
      const at = event._received_at || event.timestamp || null;
      if (["reasoning", "agent_message"].includes(type)) {
        const text = String(item.text || "").trim(); return text ? [{ type, text, at }] : [];
      }
      if (type === "mcp_tool_call") return [{ type: "tool", tool: item.tool || item.name || item.tool_name || "mcp", arguments: item.arguments || item.input || {}, status: item.status || (item.error ? "failed" : "completed"), at }];
      return [];
    }).slice(-60);
    let finalMessage = "";
    try { finalMessage = safeReadFile(directory, "last-message.txt").trim(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { feed, final_message: finalMessage, workspace_files: metadata.tools_enabled ? workspaceInventory(path.join(directory, "workspace")) : [] };
  }

  async frame(supervisor, id, indexText) {
    if (!/^(0|[1-9]\d*)$/.test(String(indexText))) throw new Error("Invalid display frame index.");
    const directory = supervisor.runDirectory(id), index = Number(indexText);
    const snapshot = await this.library.snapshot(directory);
    if (!Number.isSafeInteger(index) || index > (snapshot.summary.action_count || 0)) throw new Error("Display frame is outside the recorded move history.");
    const frame = await optional(directory, `display-history/move_${index}.json`, null);
    // Preserve the existing legacy backfill path only when no saved frame exists.
    return frame ? { ...frame, source_record: `records/move_history/move_${index}.txt` } : supervisor.displayFrame(id, index);
  }
}
