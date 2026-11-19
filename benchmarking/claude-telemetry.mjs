import { estimateRequests } from "./token-pricing.mjs";
// Read-only display adapter for Claude Code's stream-json protocol.
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
const keys = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"];
const empty = () => Object.fromEntries(keys.map(key => [key, 0]));
function usage(value = {}) {
  const cached = number(value.cache_read_input_tokens), writes = number(value.cache_creation_input_tokens);
  return { input_tokens: number(value.input_tokens) + cached + writes, cached_input_tokens: cached,
    cache_write_input_tokens: writes, cache_write_long_input_tokens: number(value.cache_creation?.ephemeral_1h_input_tokens), output_tokens: number(value.output_tokens) };
}
export const createClaudeTimeline = () => ({ requests: new Map(), turns: new Map(), active: new Map(), firstTurnBySession: new Map(), samples: [], compactions: [], context_window: null });

export function consumeClaudeEvent(timeline, event) {
  const timestamp = Date.parse(event._received_at);
  if (!Number.isFinite(timestamp)) return;
  const turn = event._turn_id || event.session_id;
  if (turn && !timeline.firstTurnBySession.has(event.session_id)) timeline.firstTurnBySession.set(event.session_id, turn);
  const requestId = id => `${turn}:${id}`;
  const inner = event.type === "stream_event" ? event.event : null;
  if (inner?.type === "message_start") {
    const message = inner.message;
    timeline.active.set(turn, requestId(message.id));
    timeline.requests.set(requestId(message.id), { response_id: requestId(message.id), turn, timestamp, reported_model: message.model, service_tier: message.usage?.speed, usage: usage(message.usage) });
  } else if (inner?.type === "message_delta") {
    const record = timeline.requests.get(timeline.active.get(turn));
    if (record && Number.isFinite(inner.usage?.output_tokens)) record.usage.output_tokens = inner.usage.output_tokens;
  } else if (event.type === "assistant" && event.message?.id && !timeline.requests.has(requestId(event.message.id))) {
    timeline.requests.set(requestId(event.message.id), { response_id: requestId(event.message.id), turn, timestamp, reported_model: event.message.model, service_tier: event.message.usage?.speed, usage: usage(event.message.usage) });
  } else if (event.type === "system" && event.subtype === "compact_boundary") {
    timeline.compactions.push({ timestamp, before_tokens: event.compact_metadata?.pre_tokens ?? timeline.samples.at(-1)?.tokens ?? null, after_tokens: null });
  } else if (event.type === "result") {
    const models = Object.values(event.modelUsage || {});
    if (models[0]?.contextWindow) timeline.context_window = models[0].contextWindow;
    // Some error results have no usage block. Retain the requests we observed.
    if (!event.usage || !["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
      .some(key => Number.isFinite(event.usage[key]))) return;
    const billed = usage(event.usage);
    const cost = Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : null;
    // Claude Code can report session-wide dollars (and modelUsage) alongside
    // this invocation's token counts, even when a resume spent zero tokens.
    const sessionCost = cost > 0 && (timeline.firstTurnBySession.get(event.session_id) !== turn ||
      billed.input_tokens + billed.output_tokens === 0 ||
      models.reduce((n, m) => n + number(m.outputTokens), 0) > billed.output_tokens ||
      models.reduce((n, m) => n + number(m.inputTokens) + number(m.cacheReadInputTokens) + number(m.cacheCreationInputTokens), 0) > billed.input_tokens);
    timeline.turns.set(turn, {usage:billed, timestamp, cost, sessionCost, service_tier:event.usage?.speed});
  }
  const record = timeline.requests.get(timeline.active.get(turn)) || [...timeline.requests.values()].at(-1);
  if (record && (inner?.type === "message_stop" || event.type === "assistant")) {
    const tokens = record.usage.input_tokens + record.usage.output_tokens;
    if (timeline.samples.at(-1)?.response_id === record.response_id) timeline.samples.pop();
    timeline.samples.push({ timestamp, tokens, response_id: record.response_id });
    const compact = timeline.compactions.at(-1);
    if (compact && compact.after_tokens === null && timestamp > compact.timestamp) compact.after_tokens = tokens;
    if (timeline.samples.length > 5000) timeline.samples = timeline.samples.filter((_, index) => index % 2 === 0 || index === timeline.samples.length - 1);
  }
}

// Use disjoint categories when reconciling a completed turn. The input counter
// includes cache reads and writes, and the write counter includes one-hour writes.
function billingBuckets(u) {
  const long = u.cache_write_long_input_tokens;
  return {input:u.input_tokens - u.cached_input_tokens - u.cache_write_input_tokens,
    read:u.cached_input_tokens, short:u.cache_write_input_tokens - long, long, output:u.output_tokens};
}

function fromBuckets({input, read, short, long, output}) {
  return {input_tokens:input + read + short + long, cached_input_tokens:read,
    cache_write_input_tokens:short + long, cache_write_long_input_tokens:long, output_tokens:output};
}

export function claudeRateRecords(timeline, model) {
  const remaining = new Map();
  for (const [turn, result] of timeline.turns) remaining.set(turn, billingBuckets(result.usage));
  const records = [];
  for (const request of timeline.requests.values()) {
    const balance = remaining.get(request.turn);
    let billed = request.usage;
    if (balance) {
      const buckets = billingBuckets(billed);
      for (const key of Object.keys(buckets)) {
        buckets[key] = Math.min(buckets[key], balance[key]);
        balance[key] -= buckets[key];
      }
      billed = fromBuckets(buckets);
    }
    const actualModel = model?.startsWith('claude-') && request.reported_model?.startsWith('claude-') ? request.reported_model : model;
    records.push({...request, model:actualModel, usage:billed});
  }
  for (const [turn, balance] of remaining) {
    const billed = fromBuckets(balance);
    if (billed.input_tokens || billed.output_tokens || !records.length) {
      const result = timeline.turns.get(turn);
      records.push({timestamp:result.timestamp, service_tier:result.service_tier, usage:billed, usage_adjustment:true});
    }
  }
  return records.sort((a,b) => a.timestamp - b.timestamp);
}

export function claudeTelemetry(timeline, model, { trustReportedCost = true } = {}) {
  const totals = empty();
  for (const { usage } of timeline.turns.values()) for (const key of keys) totals[key] += usage[key];
  for (const record of timeline.requests.values()) if (!timeline.turns.has(record.turn)) for (const key of keys) totals[key] += record.usage[key];
  totals.total_tokens = totals.input_tokens + totals.output_tokens;
  const complete = [...timeline.turns.values()];
  const latest = timeline.samples.at(-1);
  return { available: Boolean(latest), totals: timeline.requests.size || timeline.turns.size ? totals : null,
    total_tokens: totals.total_tokens, current_tokens: latest?.tokens ?? null, updated_at: latest?.timestamp ?? null,
    context_window: timeline.context_window, compaction_threshold: null,
    samples: timeline.samples, compactions: timeline.compactions,
    api_estimate: (() => {
      if (!trustReportedCost || complete.some(turn => turn.sessionCost)) {
        const estimate = estimateRequests(claudeRateRecords(timeline, model), model);
        return {...estimate, request_count:timeline.requests.size, billing_source:'provider-token-rates'};
      }
      // Completed-turn totals/costs include hidden compaction requests. Keep them
      // authoritative and add only requests from turns still in progress.
      const active = [...timeline.requests.values()].filter(r => !timeline.turns.has(r.turn));
      const estimate = estimateRequests(active, model);
      if (complete.length && complete.every(t => t.cost !== null) && (!active.length || estimate.usd !== null)) {
        estimate.usd = complete.reduce((sum, t) => sum + t.cost, 0) + (estimate.usd || 0);
        estimate.basis = "Reported API-equivalent costs for completed turns plus estimated active responses. Cached input is counted once. This is not a subscription charge.";
      } else if (complete.length) {
        estimate.usd = null;
        estimate.basis += " Completed-turn cost was not reported.";
      }
      estimate.request_count = timeline.requests.size;
      return estimate;
    })(),
    reason: "Waiting for Claude Code token telemetry." };
}
