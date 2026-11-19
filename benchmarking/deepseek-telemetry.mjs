// Read-only native session telemetry. Headless stdout omits context/compaction
// events; the durable session is authoritative when it is still available.
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeDirectory, safeReadFile } from './v1/safe-files.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const deepseekRunHomes = () => path.join(os.homedir(), '.mazebench/deepseek-runs');

export async function findDeepSeekSession(metadata, directory, homes = deepseekRunHomes()) {
  if (!/^run-[\w-]+$/.test(metadata.id || '') || !/^session-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(metadata.deepseek_session_id || '')) return null;
  let home = path.join(homes, metadata.id);
  try {
    const frozen = JSON.parse(safeReadFile(directory, 'integrity.json')).configuration;
    if (frozen?.deepseek_home) home = frozen.deepseek_home;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    await lstat(path.join(home, 'sessions'));
    const sessions = safeDirectory(safeDirectory(path.dirname(home), path.basename(home)), 'sessions');
    const cwd = await realpath(path.join(directory, 'agent-cwd'));
    for (const entry of await readdir(sessions, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const relative = `${entry.name}/${metadata.deepseek_session_id}`;
      try { await lstat(path.join(sessions, relative)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const file = path.join(safeDirectory(sessions, relative), 'session.v4.jsonl');
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!handle) continue;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid DeepSeek session file.');
        const buffer = Buffer.alloc(16384), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const first = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
        let header;
        try { header = JSON.parse(first); } catch { continue; }
        if (header.type === 'session' && header.version === 4 && header.id === metadata.deepseek_session_id && header.cwd === cwd && !header.delegationDepth) return file;
      } finally { await handle.close(); }
    }
    return null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export const createDeepSeekTimeline = () => ({ samples: [], compactions: [], context_window: null,
  usage_records: new Map(), pendingCompactions: new Map(), lastSeq: -1 });

function usageRecord(usage, timestamp) {
  if (!finite(usage?.inputTokens) || !finite(usage?.outputTokens)) return null;
  const cached = finite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0;
  const writes = finite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0;
  return { timestamp, input_tokens: usage.inputTokens + cached + writes,
    cached_input_tokens: cached, cache_write_input_tokens: writes, output_tokens: usage.outputTokens };
}

function sample(timeline, usage) {
  const tokens = usage.input_tokens + usage.output_tokens, timestamp = usage.timestamp;
  timeline.samples.push({ timestamp, tokens });
  // Only a subsequent model response can establish occupancy after compaction.
  // The summarizer's own usage and shadowedTokenCount are not retained context.
  const compact = timeline.compactions.at(-1);
  if (compact && compact.after_tokens === null && timestamp >= compact.ended_at) compact.after_tokens = tokens;
  if (timeline.samples.length > 5000) {
    const values = timeline.samples, reduced = [values[0]];
    for (let i = 1; i < values.length - 1; i += 4) {
      const group = values.slice(i, Math.min(i + 4, values.length - 1));
      reduced.push(...[...new Set([group.reduce((a, b) => a.tokens < b.tokens ? a : b), group.reduce((a, b) => a.tokens > b.tokens ? a : b)])].sort((a, b) => a.timestamp - b.timestamp));
    }
    reduced.push(values.at(-1)); timeline.samples = reduced;
  }
}

export function consumeDeepSeekEvent(timeline, event) {
  if (!Number.isSafeInteger(event.seq) || event.seq <= timeline.lastSeq || !finite(event.time)) return;
  timeline.lastSeq = event.seq;
  const data = event.data || {}, timestamp = event.time;
  if (event.type === 'request/context' && finite(data.contextWindow) && data.contextWindow > 0) timeline.context_window = data.contextWindow;
  if (event.type === 'assistant/message' || event.type === 'compaction/summary') {
    const usage = usageRecord(data.usage, timestamp);
    if (usage) {
      const id = event.type === 'compaction/summary' ? `compaction:${event.seq}` : `message:${data.message?.id ?? event.seq}`;
      const duplicate = timeline.usage_records.has(id);
      timeline.usage_records.set(id, usage);
      if (event.type === 'assistant/message' && !duplicate) sample(timeline, usage);
    }
  }
  if (event.type === 'compaction/start' && data.compactionId) timeline.pendingCompactions.set(data.compactionId,
    { timestamp, before_tokens: timeline.samples.at(-1)?.tokens ?? null, after_tokens: null });
  if (event.type === 'compaction/end') {
    const compact = timeline.pendingCompactions.get(data.compactionId);
    if (compact && !data.error) timeline.compactions.push({ ...compact, ended_at: timestamp });
    timeline.pendingCompactions.delete(data.compactionId);
  }
}

export function consumeDeepSeekHeadlessEvent(timeline, event) {
  if (event.type !== 'status' || event.phase !== 'step_end') return;
  const usage = usageRecord(event.usage, Date.parse(event._received_at));
  if (!usage || !finite(usage.timestamp)) return;
  const id = `${event._turn_id}:${event.turn}:${event.step}`;
  if (timeline.usage_records.has(id)) return;
  timeline.usage_records.set(id, usage); sample(timeline, usage);
}

export function deepseekTelemetry(timeline, billing, native) {
  const latest = timeline.samples.at(-1);
  return { available: Boolean(latest), ...billing, total_tokens: billing.totals?.total_tokens ?? null,
    current_tokens: latest?.tokens ?? null, updated_at: latest?.timestamp ?? null,
    context_window: timeline.context_window, compaction_threshold: null,
    samples: timeline.samples, compactions: timeline.compactions,
    compactions_available: native, telemetry_source: native ? 'deepseek-session-v4' : 'deepseek-headless',
    context_basis: 'Last response input (including cached tokens) plus output; not cumulative usage or the harness pressure estimate.',
    reason: native ? 'The session records context capacity and completed compactions; its automatic compaction trigger is not recorded.'
      : 'Native session unavailable. Per-step context usage is shown; context capacity, compaction trigger and compaction history are not recorded in headless output.' };
}
