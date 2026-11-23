import { estimateRequests } from "./token-pricing.mjs";
// Read-only dashboard adapter; never loaded by Muse or its frozen MCP runtime.
import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safeDirectory } from "./v1/safe-files.mjs";

export const museRunHomes = () => path.join(os.homedir(), ".mazebench/muse-runs");
export async function findMuseSession(metadata, homes = museRunHomes()) {
  if (!/^run-[\w.-]+$/.test(metadata.id || "") || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(metadata.muse_session_id || "")) return null;
  const created = Date.parse(metadata.created_at);
  if (!Number.isFinite(created)) return null;
  for (const delta of [0, -1, 1]) {
    // Muse uses the local creation date, which may differ from the run's UTC date.
    const date = new Date(created + delta * 86400000).toISOString().slice(0, 10).replaceAll("-", "/");
    const relative = `${metadata.id}/.local/share/muse/sessions/${date}/${metadata.muse_session_id}`;
    try {
      await lstat(path.join(homes, relative));
      return path.join(safeDirectory(homes, relative), "session.jsonl");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return null;
}

export const museDetail = event => event.payload?.event || event.payload || {};
export const museTimestamp = event => Number.isFinite(event.recorded_at)
  ? event.recorded_at / 1000 : Date.parse(event._received_at || event.timestamp);
export const museRecordId = event => event.payload?.source_run_record_id || event.id;
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = value => finite(value) ? value : 0;
const usageKeys = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
export const createMuseTimeline = () => ({ requests: new Map(), seen: new Set(), samples: [], compactions: [], compaction_threshold: null });

function recordUsage(timeline, id, usage, timestamp) {
  if (!id || !finite(usage?.input_tokens) || !finite(usage?.output_tokens)) return false;
  // Muse input already includes cached tokens; reasoning is part of output.
  timeline.requests.set(id, { timestamp, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
    cached_input_tokens: count(usage.cache_read_tokens ?? usage.cached_tokens),
    cache_write_input_tokens: count(usage.cache_write_tokens), reasoning_output_tokens: count(usage.reasoning_tokens) });
  return true;
}

export function consumeMuseEvent(timeline, event) {
  const timestamp = museTimestamp(event), id = museRecordId(event), detail = museDetail(event);
  if (!Number.isFinite(timestamp) || !id || timeline.seen.has(id)) return;
  if (detail.kind === "model_completed") {
    if (!recordUsage(timeline, id, detail.usage, timestamp)) return;
    timeline.seen.add(id);
    timeline.samples.push({ timestamp, tokens: detail.usage.input_tokens + detail.usage.output_tokens });
    const compact = timeline.compactions.at(-1);
    if (compact && compact.after_tokens === null && timestamp >= compact.timestamp) compact.after_tokens = detail.usage.input_tokens;
    if (timeline.samples.length > 5000) timeline.samples = timeline.samples.filter((_, i, values) => i % 2 === 0 || i === values.length - 1);
  } else if (detail.kind === "context_compaction_candidate") {
    if (finite(detail.strategy?.soft_threshold_tokens)) timeline.compaction_threshold = detail.strategy.soft_threshold_tokens;
  } else if (detail.kind === "context_compaction_installed") {
    timeline.seen.add(id);
    recordUsage(timeline, id, detail.summarizer_usage, timestamp);
    timeline.compactions.push({ timestamp, before_tokens: finite(detail.budget_before?.estimated_prompt_tokens)
      ? detail.budget_before.estimated_prompt_tokens : timeline.samples.at(-1)?.tokens ?? null,
      // budget_after is a heuristic estimate. Wait for actual provider usage.
      after_tokens: null });
  }
}

export function museTelemetry(timeline, model) {
  const totals = Object.fromEntries(usageKeys.map(key => [key, 0]));
  for (const usage of timeline.requests.values()) for (const key of usageKeys) totals[key] += usage[key];
  totals.total_tokens = totals.input_tokens + totals.output_tokens;
  const latest = timeline.samples.at(-1);
  return { available: Boolean(latest), totals: timeline.requests.size ? totals : null,
    total_tokens: timeline.requests.size ? totals.total_tokens : null,
    current_tokens: latest?.tokens ?? null, updated_at: latest?.timestamp ?? null,
    context_window: null, compaction_threshold: timeline.compaction_threshold,
    samples: timeline.samples, compactions: timeline.compactions,
    api_estimate: { ...estimateRequests(timeline.requests.values(), model),
      coverage: "Reported main responses and compaction; background reminder usage is excluded." },
    reason: "Waiting for Muse session token telemetry." };
}
