// Read the private native trace without modifying the running harness or record.
import path from 'node:path';
import os from 'node:os';
import { sessionLocation } from './kimi/session.mjs';
import { estimateRequests } from './token-pricing.mjs';
export const kimiRunHomes = () => path.join(os.homedir(), '.mazebench/kimi-runs');
export function findKimiSession(metadata, directory, homes = kimiRunHomes()) {
  if (!/^run-[\w.-]+$/.test(metadata.id || '')) return null;
  try {
    const location = sessionLocation(path.join(homes, metadata.id), directory);
    if (metadata.kimi_session_id && location?.id !== metadata.kimi_session_id) return null;
    return location?.wire || null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export const createKimiTimeline = () => ({ requests: new Map(), samples: [], compactions: [], ordinal: 0 });
export function consumeKimiEvent(timeline, event) {
  if (event.agentId !== 'main' || !Number.isFinite(event.time)) return;
  if (event.type === 'usage.record') {
    const u = event.usage || {};
    if (![u.inputOther, u.inputCacheRead, u.inputCacheCreation, u.output].every(n => Number.isFinite(n) && n >= 0)) return;
    // usage.record is the authoritative accounting event. step.end and message
    // snapshots repeat it; never add those. Incremental file offsets dedup polls.
    timeline.requests.set(++timeline.ordinal, { timestamp: event.time, usage: {
      input_tokens: u.inputOther + u.inputCacheRead + u.inputCacheCreation,
      cached_input_tokens: u.inputCacheRead, cache_write_input_tokens: u.inputCacheCreation, output_tokens: u.output } });
  } else if (event.type === 'token_counting.measured' && Number.isFinite(event.tokens)) {
    timeline.samples.push({ timestamp: event.time, tokens: event.tokens });
    if (timeline.samples.length > 5000) timeline.samples = timeline.samples.filter((_, i, a) => i % 2 === 0 || i === a.length - 1);
  }
}
export function kimiTelemetry(timeline, metadata) {
  const totals = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 };
  for (const { usage } of timeline.requests.values()) for (const key of Object.keys(totals)) totals[key] += usage[key];
  totals.total_tokens = totals.input_tokens + totals.output_tokens;
  const latest = timeline.samples.at(-1);
  return { available: Boolean(latest), totals: timeline.requests.size ? totals : metadata.usage || null,
    current_tokens: latest?.tokens ?? null, updated_at: latest?.timestamp ?? null,
    context_window: null, compaction_threshold: null, samples: timeline.samples, compactions: timeline.compactions,
    api_estimate: estimateRequests(timeline.requests.values(), metadata.model),
    reason: 'Live Kimi session usage. Context updates after each model response; automatic compaction threshold is not reported.' };
}
