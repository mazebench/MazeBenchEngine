import { readCheckpointJson } from "./v1/checkpoint-json.mjs";
import { isIncremental } from "./storage/journal.mjs";
// Read-only dashboard measurements; never loaded by the agent or MCP.
import { closeSync, fstatSync } from "node:fs";
import { read } from "node:fs";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { safeOpenFile, safeReadFile } from "./v1/safe-files.mjs";
import path from "node:path";
import { findMuseSession, museRunHomes, museDetail, museTimestamp, museRecordId } from "./muse-telemetry.mjs";

const readAsync = promisify(read);
const activeStatuses = new Set(["running", "continuing"]);
const toolTypes = new Set(["mcp_tool_call", "command_execution", "web_search"]);
const time = event => Date.parse(event._received_at || event.timestamp);

export function createThinkingTimeline() {
  return { episodes: [], start: null, open: false, tools: new Set(), seen: new Set(), interruptions: 0, lastMessage: null };
}

function finish(timeline, end, nextTool) {
  if (timeline.start !== null && end >= timeline.start) {
    timeline.episodes.push({ number: timeline.episodes.length + 1, started_at: timeline.start,
      ended_at: end, duration_ms: end - timeline.start, next_tool: nextTool });
  }
  timeline.start = null;
  timeline.lastMessage = null;
}

function interrupt(timeline) {
  if (timeline.start !== null) timeline.interruptions += 1;
  timeline.start = null;
  timeline.lastMessage = null;
}

function begin(timeline, at) {
  interrupt(timeline);
  timeline.open = true;
  timeline.tools.clear();
  timeline.seen.clear();
  timeline.start = at;
}

function toolStart(timeline, id, name, at) {
  if (!id || timeline.seen.has(id)) return;
  timeline.seen.add(id);
  finish(timeline, at, name || "tool");
  timeline.tools.add(id);
}

function toolEnd(timeline, id, at) {
  if (!timeline.tools.delete(id)) return;
  if (!timeline.tools.size && timeline.open) timeline.start = at;
}

export function consumeThinkingEvent(timeline, event, provider = "codex") {
  const at = provider === "muse-code" ? museTimestamp(event) : time(event);
  if (!Number.isFinite(at)) return;
  if (provider === 'deepseek-harness') {
    if (event.type === 'session') { interrupt(timeline); timeline.open = false; timeline.tools.clear(); }
    if (event.type === 'status' && event.phase === 'turn_start') begin(timeline, at);
    if (event.type === 'tool_call') toolStart(timeline, event.callId, event.tool, at);
    if (event.type === 'tool_result') toolEnd(timeline, event.callId, at);
    if (event.type === 'text') timeline.lastMessage = at;
    if (event.type === 'status' && event.phase === 'turn_end') {
      if (event.reason?.kind === 'completed') finish(timeline, timeline.lastMessage ?? at, 'response finished');
      else interrupt(timeline);
      timeline.open = false;
    }
    if (event.type === 'error') { interrupt(timeline); timeline.open = false; }
    // final repeats the completed turn's text; it must not add an episode.
    if (event.type === 'final' && timeline.open) {
      finish(timeline, timeline.lastMessage ?? at, 'response finished'); timeline.open = false;
    }
    return;
  }
  if (provider === "muse-code") {
    const detail = museDetail(event), id = museRecordId(event);
    timeline.museSeen ||= new Set();
    if (!id || timeline.museSeen.has(id)) return;
    const kinds = ["provider_request_options_configured", "model_completed", "model_failure_terminal_intent", "session_end", "side_effect_intent", "completed", "failed"];
    if (!kinds.includes(detail.kind)) return;
    timeline.museSeen.add(id);
    if (detail.kind === "provider_request_options_configured") begin(timeline, at);
    if (detail.kind === "model_completed") {
      // Use Muse's per-request clock, excluding tool work and paused time.
      if (Number.isFinite(detail.duration_ms) && detail.duration_ms >= 0) {
        timeline.start = at - detail.duration_ms;
        finish(timeline, at, "response finished");
      } else finish(timeline, at, "response finished");
      timeline.open = false;
    }
    if (detail.kind === "side_effect_intent" && detail.operation?.startsWith("tool:")) timeline.tools.add(detail.task_id);
    if (["completed", "failed"].includes(detail.kind)) timeline.tools.delete(detail.task_id);
    if (["model_failure_terminal_intent", "session_end"].includes(detail.kind)) {
      interrupt(timeline); timeline.open = false;
    }
    return;
  }
  if (provider === "antigravity") {
    if (event.event === "init") begin(timeline, at);
    const step = event.step_update;
    const id = step ? `${step.conversation_id}:${step.step_index}` : null;
    if (step?.tool_name && step.state === "ACTIVE") toolStart(timeline, id, step.tool_info?.parameters?.ToolName || step.tool_name, at);
    if (step?.tool_name && ["DONE", "ERROR"].includes(step.state)) toolEnd(timeline, id, at);
    if (step?.text_delta) timeline.lastMessage = at;
    if (event.event === "result") {
      if (event.result?.status === "SUCCESS") finish(timeline, timeline.lastMessage ?? at, "response finished");
      else interrupt(timeline);
      timeline.open = false;
    }
    return;
  }
  if (["claude-code", "grok-build"].includes(provider)) {
    if (event.parent_tool_use_id) return;
    if (event.type === "system" && event.subtype === "init") begin(timeline, at);
    const inner = event.event;
    const block = inner?.content_block;
    if (event.type === "stream_event" && inner?.type === "content_block_start" && block?.type === "tool_use") {
      toolStart(timeline, block.id, block.name, at);
    }
    if (event.type === "assistant") {
      for (const content of event.message?.content || []) {
        if (content.type === "tool_use") toolStart(timeline, content.id, content.name, at);
        if (content.type === "text") timeline.lastMessage = at;
      }
    }
    if (event.type === "user") for (const content of event.message?.content || []) {
      if (content.type === "tool_result") toolEnd(timeline, content.tool_use_id, at);
    }
    if (event.type === "system" && event.subtype === "status" && event.status === "compacting") interrupt(timeline);
    if (event.type === "system" && event.subtype === "compact_boundary" && timeline.open && !timeline.tools.size) timeline.start = at;
    if (event.type === "result") {
      if (event.is_error) interrupt(timeline);
      else finish(timeline, timeline.lastMessage ?? at, "response finished");
      timeline.open = false;
    }
    if (event.type === "error") interrupt(timeline);
    return;
  }
  const type = event.type || event.msg?.type;
  const item = event.item || event.msg?.item || {};
  if (type === "turn.started") begin(timeline, at);
  if (type === "item.started" && toolTypes.has(item.type)) toolStart(timeline, item.id, item.tool || item.type, at);
  if (type === "item.completed" && toolTypes.has(item.type)) toolEnd(timeline, item.id, at);
  if (type === "item.completed" && item.type === "agent_message") timeline.lastMessage = at;
  if (type === "turn.completed") {
    finish(timeline, timeline.lastMessage ?? at, "response finished");
    timeline.open = false;
  }
  if (type === "error" || type === "turn.failed" || (type === "item.completed" && item.type === "error")) interrupt(timeline);
  if (type === "turn.failed") timeline.open = false;
}

export function gemTimeline(summary) {
  const actions = summary.actions || [];
  const first = actions[0];
  const initial = first && Number.isFinite(first.totalGems) && Number.isFinite(first.gemsCollected)
    ? Math.max(0, first.totalGems - first.gemsCollected) : actions.length ? null : summary.gems_collected ?? 0;
  const points = initial === null ? [] : [{ move: 0, gems: initial }];
  for (const action of actions) {
    if (!Number.isSafeInteger(action.index) || !Number.isFinite(action.totalGems)) continue;
    if (action.totalGems !== points.at(-1)?.gems) points.push({ move: action.index, gems: action.totalGems });
  }
  const last = points.at(-1);
  if (last && summary.action_count > last.move) points.push({ move: summary.action_count, gems: last.gems });
  return { available: points.length > 0, points, moves: summary.action_count || 0,
    collected: summary.gems_collected || 0, total: summary.gems_total || 0,
    // Ice Maze/Slotski report completion through their own objective counters.
    applicable: !summary.world || summary.world === "mazebench" };
}

function lastBefore(items, at, key) {
  let low = 0, high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle][key] <= at) low = middle + 1;
    else high = middle;
  }
  return items[low - 1];
}

export function weightedThinkingDuration(start, end, metadata) {
  const changes = (metadata.service_tier_history || []).map(entry => ({
    at: Date.parse(entry.at), tier: entry.service_tier === "fast" ? "fast" : "standard"
  })).filter(entry => Number.isFinite(entry.at)).sort((a, b) => a.at - b.at);
  let tier = changes.length ? changes[0].tier : metadata.service_tier === "fast" ? "fast" : "standard";
  let cursor = start, duration = 0;
  for (const change of changes) {
    if (change.at <= start) { tier = change.tier; continue; }
    if (change.at >= end) break;
    duration += (change.at - cursor) * (tier === "fast" ? 2 : 1);
    cursor = change.at; tier = change.tier;
  }
  duration += Math.max(0, end - cursor) * (tier === "fast" ? 2 : 1);
  return { weighted_duration_ms: duration, weight: tier === "fast" ? 2 : 1, service_tier: tier };
}

export function thinkingReport(timeline, { metadata, runnerActive, summary, activity = [], compactions = [], now = Date.now() }) {
  const actions = (summary.actions || []).map(action => ({ at: Date.parse(action.at), index: action.index, room: action.roomAfter }));
  const contexts = [...activity, ...(metadata.runtime_repairs || []).map(repair => ({
    at: Date.parse(repair.at), action_count: repair.action_count
  })).filter(repair => Number.isFinite(repair.at) && Number.isSafeInteger(repair.action_count))].sort((a, b) => a.at - b.at);
  const decorate = episode => {
    const action = lastBefore(actions, episode.started_at, "at");
    const tool = lastBefore(contexts, episode.started_at, "at");
    const count = tool?.action_count ?? action?.index ?? 0;
    return { ...episode, ...weightedThinkingDuration(episode.started_at, episode.ended_at, metadata),
      action_count: count, room: action?.index === count ? action.room : null,
      compaction: compactions.some(event => event.timestamp <= episode.ended_at && (event.ended_at ?? event.timestamp) >= episode.started_at) };
  };
  const episodes = timeline.episodes.map(decorate);
  const durations = episodes.filter(episode => !episode.compaction).map(episode => episode.duration_ms).sort((a, b) => a - b);
  const weighted = episodes.filter(episode => !episode.compaction).map(episode => episode.weighted_duration_ms).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const running = runnerActive && activeStatuses.has(metadata.status);
  const current = running && timeline.open && timeline.start !== null ? decorate({
    number: episodes.length + 1, started_at: timeline.start, ended_at: now,
    duration_ms: Math.max(0, now - timeline.start), next_tool: null
  }) : null;
  return { episodes, current, count: episodes.length, interrupted: timeline.interruptions,
    median_ms: durations.length ? (durations[middle] + durations[Math.floor((durations.length - 1) / 2)]) / 2 : null,
    longest_ms: durations.at(-1) ?? null,
    weighted_median_ms: weighted.length ? (weighted[middle] + weighted[Math.floor((weighted.length - 1) / 2)]) / 2 : null,
    weighted_longest_ms: weighted.at(-1) ?? null,
    phase: !running ? metadata.status : timeline.tools.size ? "tool execution" : current ? "thinking" : "waiting after interruption",
    measured_at: now };
}

export class RunTelemetry {
  constructor({ museHomes = museRunHomes() } = {}) { this.cache = new Map(); this.pending = new Map(); this.museHomes = museHomes; }

  async consumeFile(directory, file, entry, initial, consume) {
    let fd;
    try { fd = safeOpenFile(directory, file); }
    catch (error) { if (error.code === "ENOENT") return initial(); throw error; }
    try {
      const stat = fstatSync(fd);
      let cached = entry[file];
      if (!cached || cached.inode !== stat.ino || stat.size < cached.offset) {
        cached = entry[file] = { inode: stat.ino, offset: 0, partial: "", decoder: new StringDecoder("utf8"), value: initial() };
      }
      const buffer = Buffer.alloc(256 * 1024);
      while (cached.offset < stat.size) {
        const { bytesRead } = await readAsync(fd, buffer, 0, Math.min(buffer.length, stat.size - cached.offset), cached.offset);
        if (!bytesRead) break;
        cached.offset += bytesRead;
        const lines = (cached.partial + cached.decoder.write(buffer.subarray(0, bytesRead))).split("\n");
        cached.partial = lines.pop();
        for (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          consume(cached.value, event);
        }
      }
      return cached.value;
    } finally { closeSync(fd); }
  }

  async read(directory, options = {}) {
    // Serialize readers so concurrent tabs never double-count appended events.
    const prior = this.pending.get(directory) || Promise.resolve();
    const operation = prior.catch(() => {}).then(() => this.readTimeline(directory, options));
    this.pending.set(directory, operation);
    try { return await operation; }
    finally { if (this.pending.get(directory) === operation) this.pending.delete(directory); }
  }

  async readTimeline(directory, options) {
    const metadata = JSON.parse(safeReadFile(directory, "run.json"));
    let entry = this.cache.get(directory);
    if (!entry) {
      entry = {}; this.cache.set(directory, entry);
      if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
    }
    const file = metadata.provider === 'deepseek-harness' ? 'deepseek-events.jsonl' : metadata.provider === "antigravity" ? "antigravity-events.jsonl" : metadata.provider === "claude-code" ? "claude-events.jsonl" : metadata.provider === "grok-build" ? "grok-events.jsonl" : "agent-events.jsonl";
    const museFile = metadata.provider === "muse-code" ? await findMuseSession(metadata, this.museHomes) : null;
    const timeline = metadata.provider === "muse-code" && !museFile ? createThinkingTimeline() : await this.consumeFile(museFile ? path.dirname(museFile) : directory, museFile ? path.basename(museFile) : file, entry, createThinkingTimeline,
      (value, event) => consumeThinkingEvent(value, event, metadata.provider));
    const activity = await this.consumeFile(directory, "tool-activity.jsonl", entry, () => [], (value, event) => {
      const at = Date.parse(event.completed_at);
      if (Number.isFinite(at) && Number.isSafeInteger(event.action_count_after)) value.push({ at, action_count: event.action_count_after });
    });
    const fd = safeOpenFile(directory, isIncremental(directory) ? "checkpoint.json" : "summary.json");
    let stat;
    try { stat = fstatSync(fd); } finally { closeSync(fd); }
    const version = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (entry.summaryVersion !== version) {
      entry.summary = await readCheckpointJson(directory, "summary.json");
      entry.summaryVersion = version;
      entry.gems = gemTimeline(entry.summary);
    }
    return { thinking: thinkingReport(timeline, { ...options, metadata, summary: entry.summary, activity }),
      gems: { ...entry.gems, applicable: !metadata.world || metadata.world === "mazebench" }, status: metadata.status };
  }
}
